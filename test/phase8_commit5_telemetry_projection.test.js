/**
 * PHASE 8 COMMIT 5 VERIFICATION HARNESS (test/phase8_commit5_telemetry_projection.test.js)
 *
 * Exhaustively exercises:
 * 1. Happy Path: Capacity Projection & Weighted Dispatch Tracking:
 *    - Evaluates continuous elapsed seconds refill velocity accurately without float/int overflow.
 *    - Tracks weighted dispatches: N_high + (0.557 * N_medium), draining Medium ~44.3% slower than High.
 *    - Normalizes `timeUntilNextPercent` seamlessly across seconds (7200) and milliseconds (7200000).
 *    - Clamps C_base strictly within [100.0, 300.0] across legal period bounds [1800, 10000].
 *    - Evaluates adaptive polling intervals: >30% -> 10m (600s), 15%-30% -> 2m (120s), <=15% -> 60s floor.
 * 2. Hell Path: Hallucinated Telemetry Injection, -0 Normalization & Guarded State Resets:
 *    - Rejects/normalizes timeUntilNextPercent: 0, -5000, 500, 15000, 99999999, null, NaN, '7200', {}
 *      back to config.NOMINAL_DAILY_V5_COMPUTE (190.0) and nominal refill velocity.
 *    - Rejects corrupt usage.percent (>100, <-100, NaN, null, string) without overwriting prior valid state.
 *    - Normalizes signed `-0` to `+0` across applyUsageTelemetry, resetTelemetryState, and computeProjectedCapacity.
 *    - Guards resetTelemetryState against NaN/Infinity/negative overrides.
 * 3. Hell Path: Negative Battery Clamping (`isNegative: true`) & Bucket 2 Surplus Clearing:
 *    - Verifies `{ percent: 4.5, isNegative: true }` resolves to rawProjected = -4.5% and trips circuit breaker.
 *    - Verifies `queueManager.getProjectedBatteryPercent()` receives clamped 0 (never negative/null),
 *      clearing stale Bucket 2 `v5SurplusPool` to 0 on 24h sweep instead of freezing stale compute.
 * 4. Hell Path: Edge Circuit Breaker Lockdown (`HTTP 503 V5_BATTERY_CRITICAL`) & Forged Bypass Rejection:
 *    - Drives projected capacity down to <= 5.5% via weighted local V5 dispatches across HTTP `/proxy/image/*`.
 *    - Asserts subsequent V5 requests immediately return `HTTP 503 V5_BATTERY_CRITICAL`
 *      with zero bytes hitting upstream NovelAI.
 *    - Asserts forged `X-Base-Paid: true` headers on free-limit payloads are rejected (`400 PARAMETRIC_LIMIT_EXCEEDED`)
 *      without bypassing the circuit breaker or reaching upstream.
 *    - Asserts legacy/V4 requests (`X-Gen-Model: legacy`) pass through untouched (`200 OK`).
 *    - Asserts `recordV5Dispatch(model, true)` unit contract exempts verified base-paid dispatches.
 * 5. Hell Path: Cloudflare 429 Cooldown Protection & Atomic Bucket 2 SQLite Persistence Resilience:
 *    - Verifies `triggerSync()` and `ensureFresh()` enforce >= 60s cooldown after upstream 429 failures.
 *    - Verifies `server.js` hydrates `v5_surplus_pool` on boot, writes pool & epoch atomically,
 *      supersedes same-millisecond concurrent writes deterministically, aborts sleeping retries on reset,
 *      and recovers from transient `SQLITE_BUSY` via deferred flush.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit5.db');
const TEST_PORT = 15000;
const MOCK_UPSTREAM_PORT = 15001;

process.env.ADMIN_SECRET_KEY = 'commit5_admin_secret_key';
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.UPSTREAM_BASE_URL_TEMPLATE = `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`;

function cleanupFiles() {
  [
    SANDBOX_DB_FILE,
    `${SANDBOX_DB_FILE}-journal`,
    `${SANDBOX_DB_FILE}-wal`,
    `${SANDBOX_DB_FILE}-shm`
  ].forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}

cleanupFiles();

let mockSubscriptionHandler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } }));
};

let subscriptionHits = 0;
let generationHits = 0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/user/subscription') {
    subscriptionHits += 1;
    return mockSubscriptionHandler(req, res);
  }

  generationHits += 1;
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

async function queryGateway(endpoint, method = 'GET', headers = {}, body = null) {
  const response = await fetch(`http://127.0.0.1:${TEST_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    data: contentType.includes('application/json') ? await response.json() : await response.text()
  };
}

test('Phase 8 Commit 5: Dynamic Telemetry Harvester, Projection & Circuit Breakers', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  // Seed pre-existing Bucket 2 surplus state to verify boot hydration from SQLite config
  const bootHydratedEpoch = Date.now() - 3600000;
  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit5_master_token')");
  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('v5_surplus_pool', '2400')");
  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('v5_surplus_last_accrual', ?)", [String(bootHydratedEpoch)]);

  await dbModule.run(
    "INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_commit5', 'Normal', 0)"
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_c5', 'u_commit5', 'sec_c5', 'Normal', 1, 0)"
  );

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;

  // Wait for HTTP listener bootstrap
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

  // ---------------------------------------------------------------------------
  // 1. BOOT HYDRATION & HAPPY PATH PROJECTION MATH
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Boot hydrates Bucket 2 surplus pool and tracks elapsed refill + 0.557x Medium dispatches', () => {
    const hydrated = queueManager.getSurplusPool();
    assert.strictEqual(hydrated.pool, 2400, 'Boot must hydrate v5_surplus_pool from SQLite config');
    assert.strictEqual(hydrated.lastAccrual, bootHydratedEpoch, 'Boot must hydrate v5_surplus_last_accrual');

    // Unit normalization: seconds vs milliseconds
    const secEval = serverModule.normalizeTelemetryPeriod(7200);
    assert.strictEqual(secEval.valid, true);
    assert.strictEqual(secEval.normalizedPeriod, 7200);
    assert.ok(Math.abs(secEval.cBase - 207.36) < 0.001, `Expected C_base 207.36, got ${secEval.cBase}`);

    const msEval = serverModule.normalizeTelemetryPeriod(7200000);
    assert.strictEqual(msEval.valid, true);
    assert.strictEqual(msEval.normalizedPeriod, 7200);
    assert.strictEqual(msEval.cBase, secEval.cBase);

    // Clamping upper bound (1800s -> raw 829.44 -> clamped 300.0)
    const fastEval = serverModule.normalizeTelemetryPeriod(1800);
    assert.strictEqual(fastEval.valid, true);
    assert.strictEqual(fastEval.cBase, 300.0);

    // Lower valid bound (10000s -> 149.2992 within [100.0, 300.0])
    const slowEval = serverModule.normalizeTelemetryPeriod(10000);
    assert.strictEqual(slowEval.valid, true);
    assert.ok(Math.abs(slowEval.cBase - 149.2992) < 0.001);

    // Continuous projection: 50% base, 3600s elapsed at 7200s/percent (+0.5%), 10 High + 10 Medium dispatches
    // Weighted dispatches = 10 + (0.557 * 10) = 15.57
    // Drain = 15.57 / 17.28 = 0.901041666...%
    // Expected = 50 + 0.5 - (15.57 / 17.28) = 49.5989583...%
    const t0 = 1763000000000;
    const proj = serverModule.computeProjectedCapacity({
      lastPercent: 50.0,
      lastFetchedAt: t0,
      activePeriodSeconds: 7200,
      dispatchesHigh: 10,
      dispatchesMedium: 10,
      now: t0 + 3600000
    });
    assert.strictEqual(proj.weightedDispatches, 15.57);
    assert.ok(Math.abs(proj.rawProjected - (50.5 - 15.57 / 17.28)) < 1e-6);
    assert.strictEqual(proj.clampedProjected, proj.rawProjected);

    // Upper cap at 100%
    const capped = serverModule.computeProjectedCapacity({
      lastPercent: 99.5,
      lastFetchedAt: t0,
      activePeriodSeconds: 7200,
      dispatchesHigh: 0,
      dispatchesMedium: 0,
      now: t0 + 7200000
    });
    assert.strictEqual(capped.rawProjected, 100);
    assert.strictEqual(capped.clampedProjected, 100);

    // Adaptive polling thresholds
    assert.strictEqual(serverModule.getPollingIntervalMs(30.1), 600000, '>30% must poll every 10m');
    assert.strictEqual(serverModule.getPollingIntervalMs(30.0), 120000, '30% must escalate to 2m');
    assert.strictEqual(serverModule.getPollingIntervalMs(15.1), 120000, '>15% must poll every 2m');
    assert.strictEqual(serverModule.getPollingIntervalMs(15.0), 60000, '<=15% must escalate to 60s');
    assert.strictEqual(serverModule.getPollingIntervalMs(2.0), 60000, 'Must enforce 60s minimum floor');
  });

  // ---------------------------------------------------------------------------
  // 2. HELL PATH: HALLUCINATED TELEMETRY, -0 NORMALIZATION & GUARDED RESET
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Hallucinated telemetry, IEEE-754 -0 leakage, and unguarded reset overrides fail safely', () => {
    const t0 = 1763000000000;

    // Seed clean baseline
    const clean = serverModule.applyUsageTelemetry(
      { usage: { percent: 75, timeUntilNextPercent: 7200, isNegative: false } },
      undefined,
      t0
    );
    assert.strictEqual(clean.lastAnchorPercent, 75);
    assert.ok(Math.abs(clean.nominalDailyCompute - 207.36) < 0.001);

    // Hallucinated timeUntilNextPercent values must fall back to NOMINAL_DAILY_V5_COMPUTE (190.0)
    const poisonedPeriods = [0, -5000, -1, 500, 1799, 10001, 15000, 99999999, null, undefined, NaN, Infinity, '7200', true, {}];
    for (const badPeriod of poisonedPeriods) {
      const snap = serverModule.applyUsageTelemetry(
        { usage: { percent: 80, timeUntilNextPercent: badPeriod, isNegative: false } },
        undefined,
        t0
      );
      assert.strictEqual(snap.nominalDailyCompute, 190.0, `Hallucinated period (${String(badPeriod)}) must fall back to 190.0`);
      assert.strictEqual(snap.timeUntilNextPercent, null);
    }

    // Corrupt usage.percent (including extreme negative hallucinations <-100) must throw and preserve prior valid state (80%)
    for (const badPercent of [null, undefined, NaN, Infinity, -Infinity, -101, -999999, 101, 999, '80', true, {}]) {
      assert.throws(
        () => serverModule.applyUsageTelemetry({ usage: { percent: badPercent } }, undefined, t0 + 1000),
        /usage\.percent missing or invalid/
      );
    }
    assert.strictEqual(serverModule.getTelemetrySnapshot(t0).lastAnchorPercent, 80, 'Corrupt percent must not overwrite valid telemetry');

    // IEEE-754 -0 normalization across applyUsageTelemetry, computeProjectedCapacity, and resetTelemetryState
    const negZeroSnap = serverModule.applyUsageTelemetry(
      { usage: { percent: 0, timeUntilNextPercent: 7200, isNegative: true } },
      undefined,
      t0
    );
    assert.strictEqual(Object.is(negZeroSnap.lastAnchorPercent, 0), true, 'applyUsageTelemetry must normalize { percent: 0, isNegative: true } to +0');
    assert.strictEqual(Object.is(negZeroSnap.rawProjected, 0), true, 'rawProjected must not leak -0');
    assert.strictEqual(negZeroSnap.isNegative, true);
    assert.strictEqual(negZeroSnap.isHardLocked, true);

    const directNegZeroProj = serverModule.computeProjectedCapacity({
      lastPercent: -0,
      lastFetchedAt: 0,
      activePeriodSeconds: 7200,
      dispatchesHigh: 0,
      dispatchesMedium: 0,
      now: t0
    });
    assert.strictEqual(Object.is(directNegZeroProj.rawProjected, 0), true, 'computeProjectedCapacity must normalize -0');

    // Guarded resetTelemetryState rejects non-finite or non-positive overrides
    serverModule.resetTelemetryState({
      percent: NaN,
      lastFetchedAt: Infinity,
      nominalDailyCompute: NaN,
      activePeriodSeconds: -10
    });
    const resetSnap = serverModule.getTelemetrySnapshot(t0);
    assert.strictEqual(resetSnap.lastAnchorPercent, 100);
    assert.strictEqual(resetSnap.lastFetched, 0);
    assert.strictEqual(resetSnap.nominalDailyCompute, 190.0);
    assert.ok(Number.isFinite(resetSnap.activePeriodSeconds) && resetSnap.activePeriodSeconds > 0);

    serverModule.resetTelemetryState({ percent: -0 });
    assert.strictEqual(Object.is(serverModule.getTelemetrySnapshot(t0).lastAnchorPercent, 0), true);
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: NEGATIVE BATTERY CLAMPING (isNegative) & SURPLUS CLEARING
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Negative battery (isNegative: true) trips breaker and clamps to 0 for Bucket 2 surplus', () => {
    const t0 = Date.now();
    queueManager.hydrateSurplusPool('3500', String(t0 - 86400000));

    // Upstream reports positive magnitude 4.5 with isNegative: true (real battery = -4.5%)
    const snap = serverModule.applyUsageTelemetry(
      { usage: { percent: 4.5, timeUntilNextPercent: 7858, isNegative: true } },
      undefined,
      t0
    );

    assert.strictEqual(snap.rawProjected, -4.5, 'Signed projection must preserve negative magnitude');
    assert.strictEqual(snap.isNegative, true);
    assert.strictEqual(snap.isHardLocked, true, 'Negative battery must trip 5.5% circuit breaker');
    assert.strictEqual(snap.percent, 0, 'Exposed clamped percent must clamp to [0, 100]');

    // Verify Level 3 QueueCoordinator receives 0 (not -4.5 -> null) and clears stale surplus pool
    const qmBattery = queueManager.getProjectedBatteryPercent();
    assert.strictEqual(qmBattery, 0, 'QueueCoordinator telemetryProvider must receive clamped 0 for negative tank');

    queueManager.sweep({ now: t0 });
    assert.strictEqual(queueManager.getSurplusPool().pool, 0, 'Clamped 0 battery must clear stale Bucket 2 surplus pool');
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: CIRCUIT BREAKER LOCKDOWN AT 5.5% & BYPASS SPOOFING DENIAL
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Weighted dispatches trip 5.5% circuit breaker, reject forged X-Base-Paid=true spoofs, and spare legacy', async () => {
    generationHits = 0;

    // Seed upstream at 5.60% (just above 5.5% breaker) and sync via HTTP mock
    mockSubscriptionHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage: { percent: 5.60, timeUntilNextPercent: 7858, isNegative: false } }));
    };
    serverModule.resetTelemetryState({ lastFetchedAt: 0 });
    await serverModule.syncTelemetry();

    // 1. Dispatch 1 V5 Medium image (weight 0.557 -> 0.557/17.28 = 0.03223% drain -> 5.567% > 5.5%)
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_med_1', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resMed1 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_med_1',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '14',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full-medium', parameters: { width: 1024, height: 1024, steps: 14, n_samples: 1 } });

    assert.strictEqual(resMed1.status, 200, 'First V5 Medium dispatch at 5.60% must succeed');
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesMedium, 1);
    assert.strictEqual(serverModule.getTelemetrySnapshot().isHardLocked, false);

    // 2. Dispatch 1 V5 High image (total weighted = 1.557 -> 1.557/17.28 = 0.0901% drain -> ~5.51% > 5.5%)
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_high_1', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resHigh1 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_high_1',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(resHigh1.status, 200, 'Second V5 High dispatch at ~5.56% must succeed');
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesHigh, 1);

    // 3. Dispatch 1 more V5 High image (total weighted = 2.557 -> 2.557/17.28 = 0.148% drain -> ~5.45% <= 5.5%)
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_high_2', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resHigh2 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_high_2',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(resHigh2.status, 200);
    assert.strictEqual(generationHits, 3);
    assert.strictEqual(serverModule.getTelemetrySnapshot().isHardLocked, true, 'Weighted dispatches must trip 5.5% circuit breaker');

    // 4. Subsequent V5 request MUST be rejected with HTTP 503 V5_BATTERY_CRITICAL
    const hitsBeforeBlocked = generationHits;
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_blocked_v5', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resBlocked = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_blocked_v5',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(resBlocked.status, 503, 'Locked V5 request must return HTTP 503');
    assert.strictEqual(resBlocked.data.error, 'V5_BATTERY_CRITICAL');
    assert.strictEqual(generationHits, hitsBeforeBlocked, 'Blocked V5 request must never touch upstream');
    queueManager.complete('req_blocked_v5', 'dev_c5');

    // 5. Boundary exact equality check: exactly 5.5% must ALSO trip 503 V5_BATTERY_CRITICAL
    serverModule.applyUsageTelemetry({ usage: { percent: 5.5, timeUntilNextPercent: 7858, isNegative: false } });
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_exact_55', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resExact55 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_exact_55',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '14',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full-medium', parameters: { width: 1024, height: 1024, steps: 14, n_samples: 1 } });
    assert.strictEqual(resExact55.status, 503);
    assert.strictEqual(resExact55.data.error, 'V5_BATTERY_CRITICAL');
    queueManager.complete('req_exact_55', 'dev_c5');

    // 6. Security Invariant: Forged X-Base-Paid=true header on free geometry must NEVER bypass circuit breaker
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_forged_base_paid', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resForgedBasePaid = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_forged_base_paid',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5',
      'X-Base-Paid': 'true'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });
    assert.strictEqual(resForgedBasePaid.status, 400, 'Forged X-Base-Paid=true bypass on free geometry must be rejected fail-closed');
    assert.strictEqual(resForgedBasePaid.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');
    assert.strictEqual(generationHits, hitsBeforeBlocked, 'Forged X-Base-Paid=true must never reach upstream');
    queueManager.complete('req_forged_base_paid', 'dev_c5');

    // 7. Legacy/V4 model must pass through untouched even while V5 circuit breaker is open
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_legacy_pass', user_id: 'u_commit5', priority_tier: 'Normal' });
    const resLegacy = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_legacy_pass',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy'
    }, { model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });
    assert.strictEqual(resLegacy.status, 200, 'Legacy/V4 model must bypass V5 circuit breaker');
    assert.strictEqual(generationHits, hitsBeforeBlocked + 1);

    // 8. Engine Contract: recordV5Dispatch(model, true) exempts verified base-paid dispatches & non-V5 models
    const highBefore = serverModule.getTelemetrySnapshot().dispatchesHigh;
    assert.strictEqual(serverModule.recordV5Dispatch('nai-diffusion-5-full', true), false);
    assert.strictEqual(serverModule.recordV5Dispatch('nai-diffusion-4-5-full', false), false);
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesHigh, highBefore);
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: CLOUDFLARE 429 COOLDOWN PROTECTION & ATOMIC SURPLUS PERSISTENCE
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces >=60s cooldown after 429 failures and recovers atomic SQLite Bucket 2 persistence', async () => {
    // 1. Reset telemetry and simulate upstream 429 Too Many Requests
    subscriptionHits = 0;
    mockSubscriptionHandler = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too Many Requests' }));
    };

    serverModule.resetTelemetryState({ lastFetchedAt: 0, lastNetworkAttemptAt: 0 });

    // First stale V5 request triggers syncTelemetry(), hits 429, and returns 503 TELEMETRY_FETCH_FAILED
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_429_1', user_id: 'u_commit5', priority_tier: 'Normal' });
    const first429 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_429_1',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(first429.status, 503);
    assert.strictEqual(first429.data.error, 'TELEMETRY_FETCH_FAILED');
    assert.strictEqual(subscriptionHits, 1);
    queueManager.complete('req_429_1', 'dev_c5');

    // Second immediate V5 request MUST be suppressed by 60s cooldown (zero additional upstream hits!)
    queueManager.join({ browser_id: 'dev_c5', req_id: 'req_429_2', user_id: 'u_commit5', priority_tier: 'Normal' });
    const second429 = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_c5',
      'X-Browser-Id': 'dev_c5',
      'X-Request-Id': 'req_429_2',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '23',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'V5'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } });

    assert.strictEqual(second429.status, 503);
    assert.strictEqual(subscriptionHits, 1, '60s cooldown floor must prevent Cloudflare 429 request stampedes');
    queueManager.complete('req_429_2', 'dev_c5');

    // 2. Atomic Bucket 2 SQLite persistence resilience: same-ms supersession, retry abort on reset, & deferred flush
    const originalRun = dbModule.run;
    let failWrites = true;
    let attemptedPools = [];
    dbModule.run = async function(sql, params) {
      if (
        typeof sql === 'string' &&
        sql.includes('v5_surplus_pool')
      ) {
        if (Array.isArray(params) && params.length > 0) {
          attemptedPools.push(params[0]);
        }
        if (failWrites) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
      }
      return originalRun.apply(this, arguments);
    };

    try {
      const sameEpoch = Date.now() + 86400000;

      // Queue two writes sharing the EXACT same millisecond epoch
      const olderWritePromise = serverModule.persistSurplusState(1111, sameEpoch);
      const newerWritePromise = serverModule.persistSurplusState(1999, sameEpoch);

      const [resOlder, resNewer] = await Promise.all([olderWritePromise, newerWritePromise]);
      assert.strictEqual(resOlder, true, 'Same-ms superseded older write must abort cleanly without touching DB');
      assert.strictEqual(resNewer, false, 'Transient DB failure must return false and retain latest write');
      assert.strictEqual(attemptedPools.includes('1111'), false, 'Superseded 1111 write must never execute against DB');

      // Recover DB and flush pending write
      failWrites = false;
      await serverModule.flushPendingSurplusPersist();

      const savedPool = await dbModule.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");
      const savedEpoch = await dbModule.get("SELECT value FROM config WHERE key = 'v5_surplus_last_accrual'");
      assert.strictEqual(savedPool.value, '1999', 'Deferred flush must persist latest Bucket 2 pool atomically');
      assert.strictEqual(savedEpoch.value, String(sameEpoch));

      // Verify sleeping retry aborts cleanly when resetTelemetryState supersedes it
      failWrites = true;
      attemptedPools = [];
      const sleepingRetry = serverModule.persistSurplusState(2222, sameEpoch + 1000);
      await new Promise(r => setTimeout(r, 10));
      serverModule.resetTelemetryState();
      failWrites = false;
      const resetAbortResult = await sleepingRetry;
      assert.strictEqual(resetAbortResult, true);

      const postResetPool = await dbModule.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");
      assert.strictEqual(postResetPool.value, '1999', 'Sleeping retry must abort on resetTelemetryState without overwriting SQLite');
    } finally {
      dbModule.run = originalRun;
    }
  });
});