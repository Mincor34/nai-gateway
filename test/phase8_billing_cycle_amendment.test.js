/**
 * PHASE 8 BILLING-CYCLE AMENDMENT VERIFICATION HARNESS (test/phase8_billing_cycle_amendment.test.js)
 *
 * Exhaustively tests:
 * 1. Database Config Seeding & Legacy Migration:
 *    - Verifies `master_last_paid_expires_at` and `master_anlas_cycle_epoch` seed as '0'
 *      on fresh initialization and survive migrations without clobbering existing config rows.
 * 2. Authoritative Subscription Telemetry Parsing & Persistence (`server.js`):
 *    - Captures `active`, `tier`, `expiresAt`, `paymentProcessorData.next_billing_at` (including `expiresAt: 0` fallback),
 *      `isGracePeriod`, and `trainingStepsLeft` (`fixedTrainingStepsLeft + purchasedTrainingSteps`).
 *    - Seeds and persists `master_last_paid_expires_at` + `master_anlas_cycle_epoch` in SQLite `config`
 *      before `syncTelemetry()` resolves.
 *    - Enforces strict monotonic `activeCycleEpoch` progression on renewal even within the same millisecond.
 *    - Re-hydrates billing cycle state across restarts via `hydrateSubscriptionState`.
 * 3. Hell Path: Non-Opus / Inactive `/user/subscription` With Null/Omitted `usage`, Background Refill & `401` Harvester Invalidation:
 *    - Verifies real NovelAI non-Opus payloads (`tier: 0`, `active: false`, `usage: null` or `{}`
 *      with `purchasedTrainingSteps: 2995`) update `lastFetched > 0`, set `subscriptionActive: false`,
 *      and surface `503 MASTER_SUBSCRIPTION_INACTIVE` instead of crashing `applyUsageTelemetry()`
 *      and stranding the gateway in `TELEMETRY_FETCH_FAILED`.
 *    - Verifies inactive subscriptions preserve background V5 refill projection while remaining
 *      hard-locked (`isHardLocked: true`) and resuming directly from upstream % on renewal without
 *      jumping to 100%, while forcing `queueManager.getProjectedBatteryPercent()` to `0` so stale
 *      `v5SurplusPool` clears rather than minting unspendable surplus while unsubscribed.
 *    - Verifies `syncTelemetry()` receiving HTTP `401` clears `last_fetched_at` to `0` so expired
 *      tokens cannot admit V5 queue entries against stale cached telemetry.
 *    - Verifies `active: true, tier: 3, usage: null` still fails closed.
 * 4. Hell Path: Grace-Period Freeze & Late Renewal Alignment (both HTTP `syncTelemetry()` and `applyUsageTelemetry`):
 *    - Entering `isGracePeriod: true` (even with a 3-day Chargebee `expiresAt` bump and 0 fixed Anlas)
 *      does NOT advance `activeCycleEpoch` and freezes `evaluateAnlasReset()`.
 *    - Paying late (flipping `isGracePeriod: false` and advancing `expiresAt` >= 15 days past
 *      last paid expiration) advances `activeCycleEpoch` strictly once, triggering 1x reset + debt offset.
 *    - Inactive users spanning multiple renewals receive exactly 1x `monthlyAnlas` (zero stacking).
 * 5. Hell Path: Account Swap Downward Re-Anchor:
 *    - Swapping to a master token whose `expiresAt` is >= 15 days earlier re-anchors
 *      `master_last_paid_expires_at` without triggering a spurious mid-cycle reset.
 * 6. Hell Path: Lapsed / Non-Opus Master Subscription Lockout (`503 MASTER_SUBSCRIPTION_INACTIVE`):
 *    - `active: false` or `tier < 3` freezes `evaluateAnlasReset()`, blocks both V5 and legacy
 *      image generations in `proxyRouter.js` with HTTP 503 `MASTER_SUBSCRIPTION_INACTIVE`,
 *      and automatically releases the rejecting client's Channel A lock without leaving ghost locks.
 * 7. Hell Path: Stale Channel A Lock Evicted During Slow `ensureFresh()` Async I/O:
 *    - Evicting a task while `req.telemetry.ensureFresh()` is awaiting `/user/subscription` forces
 *      post-await lock re-verification to reject with `403`, blocking concurrent upstream dispatch
 *      without disturbing the promoted replacement task.
 * 8. Hell Path: Fail-Closed Validation on `evaluateAnlasReset()`:
 *    - Rejects `activeCycleEpoch: 0`, negative numbers, `NaN`, non-boolean flags, and arrays.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_billing_cycle.db');
const LEGACY_MIGRATION_DB = path.join(__dirname, 'test_sandbox_phase8_billing_cycle_legacy.db');
const TEST_PORT = 15500;
const MOCK_UPSTREAM_PORT = 15501;

process.env.ADMIN_SECRET_KEY = 'billing_cycle_admin_key';
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.UPSTREAM_BASE_URL_TEMPLATE = `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`;

function cleanupFiles() {
  for (const base of [SANDBOX_DB_FILE, LEGACY_MIGRATION_DB]) {
    [
      base,
      `${base}-journal`,
      `${base}-wal`,
      `${base}-shm`
    ].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    });
  }
}

cleanupFiles();

const CYCLE_1_EXPIRES_SEC = 1796031198;
const DAY_SEC = 86400;

let mockSubStatus = 200;
let mockSubPayload = {
  tier: 3,
  active: true,
  expiresAt: CYCLE_1_EXPIRES_SEC,
  paymentProcessorData: { next_billing_at: CYCLE_1_EXPIRES_SEC },
  trainingStepsLeft: { fixedTrainingStepsLeft: 6381, purchasedTrainingSteps: 1 },
  isGracePeriod: false,
  usage: { percent: 80, timeUntilNextPercent: 7245, isNegative: false }
};

let mockSubDelayMs = 0;
let upstreamImageHits = 0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/user/subscription') {
    const respondSub = () => {
      res.writeHead(mockSubStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockSubPayload));
    };
    if (mockSubDelayMs > 0) {
      setTimeout(respondSub, mockSubDelayMs);
    } else {
      respondSub();
    }
    return;
  }
  upstreamImageHits += 1;
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

async function queryGateway(endpoint, method = 'GET', headers = {}, body = undefined) {
  const defaultHeaders = { 'Content-Type': 'application/json' };
  if (!endpoint.startsWith('/admin')) {
    defaultHeaders['X-Script-Version'] = '6.0.0';
  }
  const fetchOptions = {
    method,
    headers: { ...defaultHeaders, ...headers }
  };
  if (body !== undefined) {
    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`http://127.0.0.1:${TEST_PORT}${endpoint}`, fetchOptions);
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    data: contentType.includes('application/json') ? await response.json() : await response.text()
  };
}

test('Phase 8 Billing-Cycle Amendment: Authoritative Subscription & Grace-Period Governance', async (t) => {
  const dbModule = require('../database');

  // ---------------------------------------------------------------------------
  // 1. PRE-BOOT SCHEMA SEEDING & LEGACY MIGRATION VERIFICATION
  // ---------------------------------------------------------------------------
  await t.test('Database: Fresh init seeds billing-cycle config keys as "0" and legacy migration preserves existing config', async () => {
    // A. Legacy pre-amendment database migration
    await new Promise((resolve, reject) => {
      const legacy = new sqlite3.Database(LEGACY_MIGRATION_DB, (err) => {
        if (err) return reject(err);
        legacy.serialize(() => {
          legacy.run('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
          legacy.run("INSERT INTO config (key, value) VALUES ('master_token', 'legacy_tok')");
          legacy.run("INSERT INTO config (key, value) VALUES ('v5_surplus_pool', '900')");
          legacy.close(e => (e ? reject(e) : resolve()));
        });
      });
    });

    await dbModule.initDatabase(LEGACY_MIGRATION_DB);
    const migExpires = await dbModule.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
    const migCycle = await dbModule.get("SELECT value FROM config WHERE key = 'master_anlas_cycle_epoch'");
    const migToken = await dbModule.get("SELECT value FROM config WHERE key = 'master_token'");
    const migSurplus = await dbModule.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");

    assert.strictEqual(migExpires.value, '0');
    assert.strictEqual(migCycle.value, '0');
    assert.strictEqual(migToken.value, 'legacy_tok');
    assert.strictEqual(migSurplus.value, '900');
    await dbModule.closeDatabase();

    // B. Fresh initialization on primary sandbox DB
    await dbModule.initDatabase(SANDBOX_DB_FILE);
    const freshExpires = await dbModule.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
    const freshCycle = await dbModule.get("SELECT value FROM config WHERE key = 'master_anlas_cycle_epoch'");
    assert.strictEqual(freshExpires.value, '0', 'Fresh boot must seed master_last_paid_expires_at to "0"');
    assert.strictEqual(freshCycle.value, '0', 'Fresh boot must seed master_anlas_cycle_epoch to "0"');
  });

  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'cycle_master_token')");
  await dbModule.run("INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance) VALUES ('u_cycle_a', 'Normal', 0, 0)");
  await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_cycle_a', 'u_cycle_a', 'sec_cycle_a', 'Normal', 1, 0)");

  await dbModule.run("INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance) VALUES ('u_cycle_debt', 'Low', 0, -50)");
  await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_cycle_debt', 'u_cycle_debt', 'sec_cycle_debt', 'Low', 1, 0)");

  await dbModule.run("INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance) VALUES ('u_cycle_away', 'Normal', 0, 120)");

  const auditEngine = require('../auditEngine');
  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;

  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 30));
  }

  t.after(async () => {
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await new Promise(r => mockUpstream.close(r));
    await dbModule.closeDatabase();
    cleanupFiles();
  });

  await t.test('Happy Path: Cold boot seeds billing cycle from /user/subscription and persists to SQLite config', async () => {
    const snap = serverModule.getTelemetrySnapshot();
    assert.strictEqual(snap.subscriptionActive, true);
    assert.strictEqual(snap.isGracePeriod, false);
    assert.strictEqual(snap.masterExpiresAt, CYCLE_1_EXPIRES_SEC);
    assert.strictEqual(snap.masterLastPaidExpiresAt, CYCLE_1_EXPIRES_SEC);
    assert.strictEqual(snap.masterAnlas, 6382, 'Must sum fixedTrainingStepsLeft (6381) + purchasedTrainingSteps (1)');
    assert.ok(snap.activeCycleEpoch > 0, 'Must stamp positive activeCycleEpoch on initial paid seed');

    const persistedExpires = await dbModule.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
    const persistedEpoch = await dbModule.get("SELECT value FROM config WHERE key = 'master_anlas_cycle_epoch'");
    assert.strictEqual(persistedExpires.value, String(CYCLE_1_EXPIRES_SEC));
    assert.strictEqual(persistedEpoch.value, String(snap.activeCycleEpoch));

    // User A resets once for Cycle 1; User Debt offsets -50 against 200 -> 150
    const resetA = await auditEngine.evaluateAnlasReset('u_cycle_a', {
      now: Date.now(),
      activeCycleEpoch: snap.activeCycleEpoch,
      isGracePeriod: snap.isGracePeriod,
      subscriptionActive: snap.subscriptionActive
    });
    assert.strictEqual(resetA.reset_applied, true);
    assert.strictEqual(resetA.virtual_balance, 500);
    assert.strictEqual(resetA.last_anlas_reset_epoch, snap.activeCycleEpoch);

    const resetDebt = await auditEngine.evaluateAnlasReset('u_cycle_debt', {
      now: Date.now(),
      activeCycleEpoch: snap.activeCycleEpoch,
      isGracePeriod: snap.isGracePeriod,
      subscriptionActive: snap.subscriptionActive
    });
    assert.strictEqual(resetDebt.reset_applied, true);
    assert.strictEqual(resetDebt.virtual_balance, 150);

    // Repeating within same cycle is an idempotent no-op even 35 days later if renewal hasn't happened
    await dbModule.run("UPDATE users SET virtual_anlas_balance = 40 WHERE user_id = 'u_cycle_a'");
    const sameCycleLater = await auditEngine.evaluateAnlasReset('u_cycle_a', {
      now: Date.now() + (35 * 86400000),
      activeCycleEpoch: snap.activeCycleEpoch,
      isGracePeriod: false,
      subscriptionActive: true
    });
    assert.strictEqual(sameCycleLater.reset_applied, false, 'Must NOT trigger 30-day timer drift reset when activeCycleEpoch is unchanged');
    assert.strictEqual(sameCycleLater.virtual_balance, 40);
  });

  await t.test('Hell Path: Grace period via HTTP syncTelemetry() freezes cycle epoch and blocks premature resets', async () => {
    const cycle1Epoch = serverModule.getTelemetrySnapshot().activeCycleEpoch;

    // Simulate entering Chargebee grace period over HTTP syncTelemetry() with expiresAt: 0 fallback check
    mockSubPayload = {
      tier: 3,
      active: true,
      expiresAt: 0,
      paymentProcessorData: { next_billing_at: CYCLE_1_EXPIRES_SEC + (3 * DAY_SEC) },
      trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 1 },
      isGracePeriod: true,
      usage: { percent: 75, timeUntilNextPercent: 7245, isNegative: false }
    };

    await serverModule.syncTelemetry({ rescheduleHeartbeat: false });
    const graceSnap = serverModule.getTelemetrySnapshot();

    assert.strictEqual(graceSnap.subscriptionActive, true);
    assert.strictEqual(graceSnap.isGracePeriod, true);
    assert.strictEqual(graceSnap.masterAnlas, 1);
    assert.strictEqual(graceSnap.masterExpiresAt, CYCLE_1_EXPIRES_SEC + (3 * DAY_SEC), 'Must fall back to paymentProcessorData.next_billing_at when expiresAt is 0');
    assert.strictEqual(graceSnap.masterLastPaidExpiresAt, CYCLE_1_EXPIRES_SEC, 'Grace period must NOT advance master_last_paid_expires_at');
    assert.strictEqual(graceSnap.activeCycleEpoch, cycle1Epoch, 'Grace period must NOT advance activeCycleEpoch');

    // Even a previously un-reset user (u_cycle_away) must be frozen while in grace period
    const frozenReset = await auditEngine.evaluateAnlasReset('u_cycle_away', {
      now: cycle1Epoch + (31 * 86400000),
      activeCycleEpoch: graceSnap.activeCycleEpoch,
      isGracePeriod: graceSnap.isGracePeriod,
      subscriptionActive: graceSnap.subscriptionActive
    });
    assert.strictEqual(frozenReset.reset_applied, false, 'Grace period must freeze all Anlas resets');
    assert.strictEqual(frozenReset.virtual_balance, 120);
  });

  await t.test('Hell Path: Late renewal (+33 days) advances cycle monotonically via syncTelemetry() and avoids double-reset', async () => {
    const cycle1Epoch = serverModule.getTelemetrySnapshot().activeCycleEpoch;
    const cycle2ExpiresSec = CYCLE_1_EXPIRES_SEC + (33 * DAY_SEC);

    // First verify live HTTP syncTelemetry() guarantees SQLite persistence before resolving
    mockSubPayload = {
      tier: 3,
      active: true,
      expiresAt: cycle2ExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 1 },
      isGracePeriod: false,
      usage: { percent: 100, timeUntilNextPercent: 7245, isNegative: false }
    };

    await serverModule.syncTelemetry({ rescheduleHeartbeat: false });
    const httpCycle2Snap = serverModule.getTelemetrySnapshot();
    assert.strictEqual(httpCycle2Snap.isGracePeriod, false);
    assert.strictEqual(httpCycle2Snap.masterAnlas, 10001);
    assert.strictEqual(httpCycle2Snap.masterLastPaidExpiresAt, cycle2ExpiresSec);
    assert.ok(httpCycle2Snap.activeCycleEpoch > cycle1Epoch, 'Renewal must strictly advance activeCycleEpoch even within same ms');

    // Immediately verify SQLite without manual flushPendingCyclePersist()
    const savedExpires = await dbModule.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
    const savedEpoch = await dbModule.get("SELECT value FROM config WHERE key = 'master_anlas_cycle_epoch'");
    assert.strictEqual(savedExpires.value, String(cycle2ExpiresSec));
    assert.strictEqual(savedEpoch.value, String(httpCycle2Snap.activeCycleEpoch));

    // Confirm same-millisecond / backward clock skew monotonicity directly on applyUsageTelemetry
    const sameMsCycle3Snap = serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle2ExpiresSec + (30 * DAY_SEC),
      trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 1 },
      isGracePeriod: false,
      usage: { percent: 100, timeUntilNextPercent: 7245, isNegative: false }
    }, undefined, httpCycle2Snap.activeCycleEpoch - 5000);
    await serverModule.flushPendingCyclePersist();
    assert.strictEqual(
      sameMsCycle3Snap.activeCycleEpoch,
      httpCycle2Snap.activeCycleEpoch + 1,
      'Backward clock skew during renewal must preserve strict monotonic cycle epoch progression'
    );

    // Confirm hydration across simulated restart
    serverModule.resetTelemetryState();
    serverModule.hydrateSubscriptionState(String(cycle2ExpiresSec + (30 * DAY_SEC)), String(sameMsCycle3Snap.activeCycleEpoch));
    assert.strictEqual(serverModule.getTelemetrySnapshot().activeCycleEpoch, sameMsCycle3Snap.activeCycleEpoch);
    assert.strictEqual(serverModule.getTelemetrySnapshot().masterLastPaidExpiresAt, cycle2ExpiresSec + (30 * DAY_SEC));

    // User A resets to 500 (zero rollover from 40)
    const resetA2 = await auditEngine.evaluateAnlasReset('u_cycle_a', {
      now: sameMsCycle3Snap.activeCycleEpoch + 1000,
      activeCycleEpoch: sameMsCycle3Snap.activeCycleEpoch,
      isGracePeriod: false,
      subscriptionActive: true
    });
    assert.strictEqual(resetA2.reset_applied, true);
    assert.strictEqual(resetA2.virtual_balance, 500);

    // Advance straight to Cycle 5 without User Away resetting in Cycle 2..4 -> must grant exactly 1x 500
    const cycle5TimeMs = sameMsCycle3Snap.activeCycleEpoch + (62 * 86400000);
    const cycle5ExpiresSec = cycle2ExpiresSec + (92 * DAY_SEC);
    const cycle5Snap = serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle5ExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 1 },
      isGracePeriod: false,
      usage: { percent: 100, timeUntilNextPercent: 7245, isNegative: false }
    }, undefined, cycle5TimeMs);
    await serverModule.flushPendingCyclePersist();

    const persistedCycle5Expires = await dbModule.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
    assert.strictEqual(persistedCycle5Expires.value, String(cycle5ExpiresSec));

    const awayReset = await auditEngine.evaluateAnlasReset('u_cycle_away', {
      now: cycle5TimeMs + 1000,
      activeCycleEpoch: cycle5Snap.activeCycleEpoch,
      isGracePeriod: cycle5Snap.isGracePeriod,
      subscriptionActive: cycle5Snap.subscriptionActive
    });
    assert.strictEqual(awayReset.reset_applied, true);
    assert.strictEqual(awayReset.virtual_balance, 500, 'Multi-cycle absence must grant 1x quota without stacking');
  });

  await t.test('Hell Path: Downward expiresAt (master account swap) re-anchors baseline without mid-cycle reset', async () => {
    const beforeSwap = serverModule.getTelemetrySnapshot();
    const earlierExpires = beforeSwap.masterLastPaidExpiresAt - (20 * DAY_SEC);

    const afterSwap = serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: earlierExpires,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9500, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 90, timeUntilNextPercent: 7245, isNegative: false }
    }, undefined, beforeSwap.activeCycleEpoch + 60000);
    await serverModule.flushPendingCyclePersist();

    assert.strictEqual(afterSwap.masterLastPaidExpiresAt, earlierExpires, 'Baseline expiresAt must re-anchor downward on account swap');
    assert.strictEqual(afterSwap.activeCycleEpoch, beforeSwap.activeCycleEpoch, 'Downward swap must NOT reset user quotas mid-cycle');
  });

  await t.test('Hell Path: Non-Opus / inactive payload omitting `usage`, background refill, surplus clearing & 401 harvester invalidation', async () => {
    queueManager.reset();
    upstreamImageHits = 0;

    // Simulate cold boot receiving a real NovelAI non-Opus response (tier: 0, active: false, usage: null)
    serverModule.resetTelemetryState({ lastFetchedAt: 0, lastNetworkAttemptAt: 0 });
    mockSubPayload = {
      tier: 0,
      active: false,
      expiresAt: 0,
      trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 2995 },
      isGracePeriod: false,
      usage: null
    };

    const joinRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_cycle_a'
    }, {
      browser_id: 'dev_cycle_a',
      tab_id: 'tab_non_opus',
      req_id: 'req_non_opus_join',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      width: 1024,
      height: 1024,
      n_samples: 1,
      is_base_paid: false,
      is_v5: true
    });

    assert.strictEqual(joinRes.status, 503);
    assert.strictEqual(
      joinRes.data.error,
      'MASTER_SUBSCRIPTION_INACTIVE',
      'Non-Opus /user/subscription omitting usage must resolve to MASTER_SUBSCRIPTION_INACTIVE, not TELEMETRY_FETCH_FAILED'
    );
    const snapAfter = serverModule.getTelemetrySnapshot();
    assert.ok(snapAfter.lastFetched > 0, 'lastFetched must advance so subsequent polls do not re-hit cold boot');
    assert.strictEqual(snapAfter.subscriptionActive, false);
    assert.strictEqual(snapAfter.isHardLocked, true);
    assert.strictEqual(snapAfter.masterAnlas, 2995);

    // Expired Opus keeps refilling in background on upstream, stays hard-locked until renewal,
    // resumes at the real upstream % on renewal (no 100% reset), and clears stale Bucket 2 surplus while inactive.
    const sweepNow = Date.now();
    queueManager.hydrateSurplusPool('3500', String(sweepNow - 86400000));
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: false,
      expiresAt: CYCLE_1_EXPIRES_SEC,
      isGracePeriod: false,
      usage: { percent: 85, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, sweepNow);

    const inactivePlus1h = serverModule.getTelemetrySnapshot(sweepNow + 3600000);
    assert.ok(
      inactivePlus1h.percent > 85.4 && inactivePlus1h.percent < 85.6,
      `Inactive V5 bucket must continue refilling in background (expected ~85.5%, got ${inactivePlus1h.percent})`
    );
    assert.strictEqual(inactivePlus1h.isHardLocked, true, 'Inactive subscription must stay hard-locked regardless of refilled %');

    assert.strictEqual(queueManager.getProjectedBatteryPercent(), 0, 'Inactive subscription must force telemetryProvider to 0');
    queueManager.sweep({ now: sweepNow });
    assert.strictEqual(queueManager.getSurplusPool().pool, 0, 'Inactive subscription must clear stale Bucket 2 surplus pool');

    // Renewal resumes directly from wherever NovelAI's background bucket refilled to (e.g. 61.5%, not 100%)
    const renewedSnap = serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: CYCLE_1_EXPIRES_SEC + (30 * DAY_SEC),
      isGracePeriod: false,
      usage: { percent: 61.5, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, sweepNow + 7200000);
    assert.strictEqual(renewedSnap.subscriptionActive, true);
    assert.strictEqual(renewedSnap.percent, 61.5, 'Renewal must resume from upstream tank level without jumping to 100%');

    // Mid-session upstream HTTP 401 during syncTelemetry() must invalidate lastFetched to 0 so stale
    // battery capacity cannot admit V5 queue tasks after the token expires.
    assert.ok(serverModule.getTelemetrySnapshot().lastFetched > 0);
    try {
      mockSubStatus = 401;
      mockSubPayload = { statusCode: 401, message: 'Unauthorized' };
      await assert.rejects(() => serverModule.syncTelemetry({ rescheduleHeartbeat: false }), /401/);
      assert.strictEqual(serverModule.getTelemetrySnapshot().lastFetched, 0, 'syncTelemetry() 401 must clear lastFetched to 0');
      assert.strictEqual(queueManager.getProjectedBatteryPercent(), null);
    } finally {
      mockSubStatus = 200;
    }

    // Active Opus claiming usage: null must STILL fail closed
    assert.throws(
      () => serverModule.applyUsageTelemetry({ tier: 3, active: true, usage: null }),
      /usage\.percent missing or invalid/
    );
  });

  await t.test('Hell Path: Inactive or non-Opus subscription freezes resets, returns 503 MASTER_SUBSCRIPTION_INACTIVE, and releases Channel A lock', async () => {
    queueManager.reset();
    upstreamImageHits = 0;

    // Simulate expired/lapsed subscription (active: false, tier: 0) via HTTP syncTelemetry()
    mockSubPayload = {
      tier: 0,
      active: false,
      expiresAt: CYCLE_1_EXPIRES_SEC,
      trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 0, timeUntilNextPercent: 7245, isNegative: false }
    };

    await serverModule.syncTelemetry({ rescheduleHeartbeat: false });
    const lapsedSnap = serverModule.getTelemetrySnapshot();

    assert.strictEqual(lapsedSnap.subscriptionActive, false);

    // Reset frozen when subscriptionActive === false
    await dbModule.run("UPDATE users SET last_anlas_reset_epoch = NULL, virtual_anlas_balance = 10 WHERE user_id = 'u_cycle_away'");
    const lapsedReset = await auditEngine.evaluateAnlasReset('u_cycle_away', {
      now: Date.now(),
      activeCycleEpoch: lapsedSnap.activeCycleEpoch,
      isGracePeriod: lapsedSnap.isGracePeriod,
      subscriptionActive: lapsedSnap.subscriptionActive
    });
    assert.strictEqual(lapsedReset.reset_applied, false, 'Inactive subscription must freeze Anlas resets');
    assert.strictEqual(lapsedReset.virtual_balance, 10);

    // Proxy rejects both V5 and legacy image generation with 503 MASTER_SUBSCRIPTION_INACTIVE
    // and automatically cleans up the client's Channel A processing lock
    queueManager.join({ browser_id: 'dev_cycle_a', req_id: 'req_lapsed_v5', user_id: 'u_cycle_a', priority_tier: 'Normal' });
    const v5LapsedRes = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_cycle_a',
      'X-Browser-Id': 'dev_cycle_a',
      'X-Request-Id': 'req_lapsed_v5',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(v5LapsedRes.status, 503);
    assert.strictEqual(v5LapsedRes.data.error, 'MASTER_SUBSCRIPTION_INACTIVE');
    assert.strictEqual(queueManager.getProcessingTask('req_lapsed_v5', 'dev_cycle_a'), null, 'V5 503 must release Channel A lock automatically');

    queueManager.join({ browser_id: 'dev_cycle_a', req_id: 'req_lapsed_legacy', user_id: 'u_cycle_a', priority_tier: 'Normal' });
    const legacyLapsedRes = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_cycle_a',
      'X-Browser-Id': 'dev_cycle_a',
      'X-Request-Id': 'req_lapsed_legacy',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy'
    }, { model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    assert.strictEqual(legacyLapsedRes.status, 503);
    assert.strictEqual(legacyLapsedRes.data.error, 'MASTER_SUBSCRIPTION_INACTIVE');
    assert.strictEqual(queueManager.getProcessingTask('req_lapsed_legacy', 'dev_cycle_a'), null, 'Legacy 503 must release Channel A lock automatically');
    assert.strictEqual(upstreamImageHits, 0, 'Inactive master subscription must never forward image requests upstream');
  });

  await t.test('Hell Path: Task evicted during slow ensureFresh() network I/O is rejected with 403 and never races upstream', async () => {
    queueManager.reset();
    upstreamImageHits = 0;

    // Restore active Opus payload with a 150ms telemetry response delay and stale lastFetchedAt=0
    mockSubPayload = {
      tier: 3,
      active: true,
      expiresAt: CYCLE_1_EXPIRES_SEC,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 85, timeUntilNextPercent: 7245, isNegative: false }
    };
    mockSubDelayMs = 150;
    serverModule.resetTelemetryState({ lastFetchedAt: 0 });

    try {
      queueManager.join({ browser_id: 'dev_cycle_a', req_id: 'req_evicted_mid_sync', user_id: 'u_cycle_a', priority_tier: 'Normal' });
      queueManager.join({ browser_id: 'dev_cycle_debt', req_id: 'req_promoted_peer', user_id: 'u_cycle_debt', priority_tier: 'Low' });
      assert.ok(queueManager.getProcessingTask('req_evicted_mid_sync', 'dev_cycle_a'));

      const proxyPromise = queryGateway('/proxy/image/ai/generate-image', 'POST', {
        'Authorization': 'Bearer sec_cycle_a',
        'X-Browser-Id': 'dev_cycle_a',
        'X-Request-Id': 'req_evicted_mid_sync',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5'
      }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

      // Evict dev_cycle_a while ensureFresh() is mid-flight, promoting dev_cycle_debt to 'processing'
      await new Promise(r => setTimeout(r, 40));
      queueManager.evict({ browser_id: 'dev_cycle_a' });
      assert.ok(queueManager.getProcessingTask('req_promoted_peer', 'dev_cycle_debt'), 'Peer task must hold Channel A lock');

      const staleRes = await proxyPromise;
      assert.strictEqual(staleRes.status, 403, 'Task evicted during ensureFresh() await must be rejected with 403');
      assert.strictEqual(upstreamImageHits, 0, 'Evicted task must never dispatch upstream concurrently with promoted peer');
      assert.ok(queueManager.getProcessingTask('req_promoted_peer', 'dev_cycle_debt'), 'Promoted peer lock must remain intact');

      queueManager.complete('req_promoted_peer', 'dev_cycle_debt');
    } finally {
      mockSubDelayMs = 0;
    }
  });

  await t.test('Hell Path: evaluateAnlasReset fails closed on poison cycle options', async () => {
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', { activeCycleEpoch: 0 }),
      /positive timestamp or null/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', { activeCycleEpoch: -100 }),
      /finite non-negative number/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', { activeCycleEpoch: NaN }),
      /finite non-negative number/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', { isGracePeriod: 'true' }),
      /must be a boolean/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', { subscriptionActive: 1 }),
      /must be a boolean/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', []),
      /finite non-negative number or plain object/
    );
    await assert.rejects(
      () => auditEngine.evaluateAnlasReset('u_cycle_a', null),
      /finite non-negative number or plain object/
    );
  });
});