/**
 * PHASE 8 COMMIT 9 VERIFICATION HARNESS (test/phase8_commit9_admin_auth.test.js)
 *
 * Exhaustively tests:
 * 1. Happy Path: `/auth/status` Dual-Ledger Metadata, Countdown Timers & Cluster State:
 *    - Serializes virtual Anlas balance, available balance (deducting cross-channel holds),
 *      monthly quota, debt state, zero_rollover, subscription-period usage, V5 banked NCP,
 *      available NCP, surplus pool availability, cluster_state (`surplus_active`, `reserve_mode`,
 *      `throttled`, `frozen`), time_until_next_percent, next_percent_eta_ms, and billing-cycle fields.
 *    - Forwards `req.telemetry.nominalDailyCompute` into lazy `evaluateV5Accrual()` on `/auth/status`.
 *    - Preserves all legacy `/auth/status` response fields (`approved`, `tier`, `anlas_consumed`,
 *      `precise_limit`, `session`, `linked_devices`, `master_v5_percent`, `debug_*`), Admin Infinity
 *      serialization, and Metered zero-surplus serialization.
 * 2. Happy Path: `/admin/devices` & `/admin/global-stats` Dual-Ledger Telemetry:
 *    - `/admin/devices` remains a JSON array of canonical user groups enriched with virtual Anlas,
 *      available Anlas, active holds, debt flags, V5 banked/available/held NCP, and period counters.
 *    - `/admin/global-stats` exposes aggregate balances, debt counts, Bucket 2 surplus pool state,
 *      and live master telemetry snapshot.
 * 3. Hell Path: Onboarding Reset Gating, Cold-Boot Debt Guard & Grace-Period Freeze on `/auth/status`:
 *    - Unapproved device polling `/auth/status` does NOT call `evaluateAnlasReset()` or stamp
 *      `last_anlas_reset_epoch` or lock in a pre-approval `Normal` quota.
 *    - Approving the device as `High` (`1000` monthlyAnlas) grants `1000` Anlas on its first post-approval poll.
 *    - Cold-boot (`lastFetched === 0 && activeCycleEpoch === null`) skips fallback reset on `/auth/status`,
 *      preserving pre-existing debt until first telemetry sync arrives.
 *    - `isGracePeriod: true` freezes Anlas resets on `/auth/status` even when `last_anlas_reset_epoch` is >30 days old.
 * 4. Hell Path: Admin Balance Injection Race (`POST /admin/adjust-balance`):
 *    - Client holds active Channel A (`held_cost = 40`, `held_ncp = 18`) and Channel B (`held_cost = 2`)
 *      reservations while admin fires concurrent/sequential `/admin/adjust-balance` requests.
 *    - Verifies active in-memory holds (`42` Anlas, `18` personal NCP) are never corrupted or dropped,
 *      SQLite triggers mirror updated balances to all linked devices, and `available_balance` reflects
 *      the exact delta across `/admin/devices`, `/auth/status`, and `authorizeAnlasSpend()`.
 *    - Verifies concurrent `commitAnlasDebit` + `POST /admin/adjust-balance` serialize cleanly via
 *      `withUserLock` without lost updates.
 *    - Verifies IEEE-754 `-0` normalization and unlimited-tier Anlas adjustment denial (`400`, zero phantom DB debt).
 * 5. Hell Path: Debt Reconciliation (`POST /admin/reconcile-debt`):
 *    - Partial paydown (`credit_amount: 50` on `-120` debt -> `-70`), `cap_at_zero: true` clamping excess
 *      credit at `0`, full forgiveness (`0`), clearing `DEBT_LOCKED` state, unlimited-tier immunity,
 *      and refusal to wipe/lower an already positive Anlas balance.
 * 6. Hell Path: Security Hardening, Input Validation, Auth Guards, Query Arrays & Unban Cleanup:
 *    - Rejects `POST /auth/register` claiming reserved `browser_id: 'admin'` (`400`) or hijacking
 *      an existing non-browser canonical principal (`409`), and trims whitespace-padded `b_` IDs cleanly.
 *    - Rejects non-boolean `enabled` (`"false"`) on `POST /auth/debug-intent` (`400`) and whitespace
 *      `browser_id` on `POST /admin/debug-target` (`400`).
 *    - Ensures invalid `device_secret` on `GET /auth/status` returns `401` without marking device online.
 *    - Rejects unauthenticated (`401`), wrong admin secret (`403`), synthetic `'admin'` adjustments (`400`),
 *      conflicting delta + absolute fields (`400`), safe-integer overflow (`400`), floats/booleans/strings (`400`),
 *      missing/non-string `master_token` (`400`), malformed `sync-usernames` (`400`), array-coerced
 *      `priority_tier`/`discord_id`/`browser_id` (`400`), unknown users (`404`), and Express 5 duplicate query arrays.
 *    - Resolves `{ user_id: null, discord_id: '...' }` via fallback `discord_id` without shadowing.
 *    - Verifies `POST /admin/unban` clears `banned_discords` alongside `users`/`devices` so users
 *      banned via `commitSecurityBan()` are not immediately re-banned by `verifyDevice()`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit9.db');
const TEST_PORT = 19000;
const MOCK_UPSTREAM_PORT = 19001;

process.env.ADMIN_SECRET_KEY = 'commit9_admin_secret_key';
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

const DEFAULT_SUB_EXPIRES = Math.floor(Date.now() / 1000) + (25 * 86400);

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/user/subscription') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

async function queryGateway(endpoint, method = 'GET', headers = {}, body = undefined) {
  const fetchOptions = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
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

test('Phase 8 Commit 9: Administrative Telemetry, Governance & Dual-Ledger Status Endpoints', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit9_master_token')");

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;
  const auditEngine = require('../auditEngine');

  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 30));
  }

  const bootSnap = serverModule.getTelemetrySnapshot();
  assert.ok(bootSnap.activeCycleEpoch > 0, 'Warm boot must seed activeCycleEpoch');

  const adminHeaders = { 'Authorization': 'Bearer commit9_admin_secret_key' };

  // Seed multi-device principal u_alice (Normal, 2 devices)
  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch, v5_daily_consumed, anlas_consumed, subscription_period_anlas, subscription_period_v5, subscription_period_start_epoch)
     VALUES ('u_alice', 'Normal', 0, 'Alice', 300, ?, 180, ?, 2, 75, 45, 5, ?)`,
    [bootSnap.activeCycleEpoch, Date.now(), bootSnap.activeCycleEpoch]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned, total_requests) VALUES ('dev_alice_1', 'u_alice', 'u_alice', 'sec_alice_1', 'Desktop', 'Normal', 1, 0, 10)"
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned, total_requests) VALUES ('dev_alice_2', 'u_alice', 'u_alice', 'sec_alice_2', 'Laptop', 'Normal', 1, 0, 4)"
  );

  // Seed indebted principal u_debt9
  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_debt9', 'Low', 0, 'Debtor', -120, ?, 50, ?)`,
    [bootSnap.activeCycleEpoch, Date.now()]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_debt9', 'u_debt9', 'u_debt9', 'sec_debt9', 'Phone', 'Low', 1, 0)"
  );

  // Seed Metered principal u_metered9
  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, metered_allowance, last_allowance_update_at)
     VALUES ('u_metered9', 'Metered', 0, 'MeteredUser', 0, ?, 0, 42, ?)`,
    [bootSnap.activeCycleEpoch, Date.now()]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_metered9', 'u_metered9', 'u_metered9', 'sec_metered9', 'Tablet', 'Metered', 1, 0)"
  );

  // Seed database-backed Admin-tier principal u_admin_db
  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_admin_db', 'Admin', 0, 'DbAdmin', 0, ?, 100, ?)`,
    [bootSnap.activeCycleEpoch, Date.now()]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_admin_db', 'u_admin_db', 'u_admin_db', 'sec_admin_db', 'Workstation', 'Admin', 1, 0)"
  );

  t.after(async () => {
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await new Promise(r => mockUpstream.close(r));
    await dbModule.closeDatabase();
    cleanupFiles();
  });

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: `/auth/status` DUAL-LEDGER TELEMETRY & `nominalDailyCompute`
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: /auth/status serializes dual-ledger metadata, holds, countdown timers, cluster states & nominalDailyCompute', async () => {
    queueManager.reset();
    const syncNow = Date.now();
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 5000, isNegative: false }
    }, undefined, syncNow);

    queueManager.hydrateSurplusPool('1500', String(syncNow));

    // Rewind u_alice's v5_last_accrual_epoch by 25h so /auth/status triggers lazy V5 accrual with forwarded C_base
    // Total cluster weight: u_alice (Normal=2) + u_debt9 (Low=1) + u_metered9 (Metered=0) + u_admin_db (Admin=4) = 7
    // Nominal Daily NCP = floor(298.5984 * 18) = 5374; u_alice share = floor(5374 * (2/7)) = 1535 NCP
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_alice'", [syncNow - (25 * 3600 * 1000)]);

    // Place cross-channel holds on u_alice: Channel A (20 Anlas, 18 personal NCP) + Channel B (2 Anlas)
    queueManager.join({
      browser_id: 'dev_alice_1',
      req_id: 'req_status_hold_1',
      user_id: 'u_alice',
      discord_id: 'u_alice',
      priority_tier: 'Normal',
      held_cost: 20,
      held_ncp: 18,
      held_ncp_source: 'personal'
    });
    assert.strictEqual(queueManager.acquireTextSlot('vibe_status_hold_1', 'u_alice', 2), true);

    const statusRes = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', {
      'Authorization': 'Bearer sec_alice_1'
    });
    assert.strictEqual(statusRes.status, 200);
    const d = statusRes.data;

    // Legacy compatibility fields
    assert.strictEqual(d.approved, true);
    assert.strictEqual(d.tier, 'Normal');
    assert.strictEqual(d.anlas_consumed, 75);
    assert.strictEqual(d.precise_limit, 2);
    assert.strictEqual(d.session, null);
    assert.strictEqual(d.linked_devices.length, 2);
    assert.ok(d.master_v5_percent >= 80);

    // Anlas ledger metadata
    assert.strictEqual(d.anlas.virtual_balance, 300);
    assert.strictEqual(d.anlas.held, 22);
    assert.strictEqual(d.anlas.available_balance, 278);
    assert.strictEqual(d.anlas.monthly_quota, 500);
    assert.strictEqual(d.anlas.is_unlimited, false);
    assert.strictEqual(d.anlas.is_in_debt, false);
    assert.strictEqual(d.anlas.zero_rollover, true);
    assert.strictEqual(d.anlas.subscription_period_consumed, 45);
    assert.strictEqual(d.anlas.lifetime_consumed, 75);

    // V5 dual-bucket NCP metadata (100 + 1535 = 1635 banked, 18 held -> 1617 available)
    assert.strictEqual(d.v5.daily_share_ncp, 1535, 'Must forward nominalDailyCompute from telemetry into evaluateV5Accrual');
    assert.strictEqual(d.v5.banked_ncp, 1635);
    assert.strictEqual(d.v5.held_personal_ncp, 18);
    assert.strictEqual(d.v5.available_ncp, 1617);
    assert.strictEqual(d.v5.max_bank_ncp, 1535 * 3);
    assert.strictEqual(d.v5.surplus_pool_ncp, 1500);
    assert.strictEqual(d.v5.surplus_available_ncp, 1500);
    assert.strictEqual(d.v5.surplus_eligible, true);
    assert.strictEqual(d.v5.subscription_period_consumed, 5);

    // Telemetry & Cluster state transitions
    assert.strictEqual(d.telemetry.time_until_next_percent, 5000);
    assert.strictEqual(d.telemetry.active_period_seconds, 5000);
    assert.ok(d.telemetry.next_percent_eta_ms > 0 && d.telemetry.next_percent_eta_ms <= 5000000);
    assert.strictEqual(d.telemetry.cluster_state, 'surplus_active');
    assert.strictEqual(d.telemetry.subscription_active, true);
    assert.strictEqual(d.telemetry.is_grace_period, false);
    assert.strictEqual(d.subscription_period.anlas_consumed, 45);
    assert.strictEqual(d.subscription_period.v5_consumed, 5);

    // Metered tier serialization (zero quota, zero V5 weight, surplus_eligible: false, session allowance present)
    const meteredRes = await queryGateway('/auth/status?browser_id=dev_metered9', 'GET', {
      'Authorization': 'Bearer sec_metered9'
    });
    assert.strictEqual(meteredRes.status, 200);
    assert.strictEqual(meteredRes.data.anlas.monthly_quota, 0);
    assert.strictEqual(meteredRes.data.v5.surplus_eligible, false);
    assert.strictEqual(meteredRes.data.v5.banked_ncp, 0);
    assert.strictEqual(meteredRes.data.v5.daily_share_ncp, 0);
    assert.strictEqual(meteredRes.data.session.allowance, 42);

    // Verify reserve_mode (30% battery, 0 surplus), throttled (10% battery), and frozen (5% battery)
    queueManager.hydrateSurplusPool('0', String(syncNow));
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES, isGracePeriod: false,
      usage: { percent: 30, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
    const reserveRes = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', { 'Authorization': 'Bearer sec_alice_1' });
    assert.strictEqual(reserveRes.data.telemetry.cluster_state, 'reserve_mode');

    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES, isGracePeriod: false,
      usage: { percent: 10, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
    const throttledRes = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', { 'Authorization': 'Bearer sec_alice_1' });
    assert.strictEqual(throttledRes.data.telemetry.cluster_state, 'throttled');

    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES, isGracePeriod: false,
      usage: { percent: 5.0, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
    const frozenRes = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', { 'Authorization': 'Bearer sec_alice_1' });
    assert.strictEqual(frozenRes.data.telemetry.cluster_state, 'frozen');

    // Synthetic Admin principal serializes Infinity safely as null with is_unlimited: true
    const adminStatusRes = await queryGateway('/auth/status?browser_id=admin_term_9', 'GET', adminHeaders);
    assert.strictEqual(adminStatusRes.status, 200);
    assert.strictEqual(adminStatusRes.data.precise_limit, 'Unlimited');
    assert.strictEqual(adminStatusRes.data.anlas.is_unlimited, true);
    assert.strictEqual(adminStatusRes.data.anlas.virtual_balance, null);
    assert.strictEqual(adminStatusRes.data.v5.is_unlimited, true);

    // Restore healthy 80% telemetry & release holds
    queueManager.complete('req_status_hold_1', 'dev_alice_1');
    queueManager.releaseTextSlot('vibe_status_hold_1');
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
  });

  // ---------------------------------------------------------------------------
  // 2. HAPPY PATH: `/admin/devices` & `/admin/global-stats` TELEMETRY
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: /admin/devices and /admin/global-stats expose dual-ledger balances & surplus pool', async () => {
    queueManager.reset();
    queueManager.hydrateSurplusPool('2000', String(Date.now()));
    queueManager.join({
      browser_id: 'dev_alice_1',
      req_id: 'req_adm_view_1',
      user_id: 'u_alice',
      discord_id: 'u_alice',
      priority_tier: 'Normal',
      held_cost: 15,
      held_ncp: 10,
      held_ncp_source: 'surplus'
    });

    const devRes = await queryGateway('/admin/devices', 'GET', adminHeaders);
    assert.strictEqual(devRes.status, 200);
    assert.strictEqual(Array.isArray(devRes.data), true, '/admin/devices MUST remain a JSON array');

    const aliceGroup = devRes.data.find(g => g.user_id === 'u_alice');
    assert.ok(aliceGroup);
    assert.strictEqual(aliceGroup.virtual_anlas_balance, 300);
    assert.strictEqual(aliceGroup.held_anlas, 15);
    assert.strictEqual(aliceGroup.available_anlas_balance, 285);
    assert.strictEqual(aliceGroup.is_in_debt, false);
    assert.strictEqual(aliceGroup.v5_banked_balance, 1635);
    assert.strictEqual(aliceGroup.v5_available_balance, 1635);
    assert.strictEqual(aliceGroup.v5_held_surplus_ncp, 10);
    assert.strictEqual(aliceGroup.subscription_period_anlas, 45);
    assert.strictEqual(aliceGroup.subscription_period_v5, 5);

    const debtGroup = devRes.data.find(g => g.user_id === 'u_debt9');
    assert.ok(debtGroup);
    assert.strictEqual(debtGroup.virtual_anlas_balance, -120);
    assert.strictEqual(debtGroup.is_in_debt, true);

    const statsRes = await queryGateway('/admin/global-stats', 'GET', adminHeaders);
    assert.strictEqual(statsRes.status, 200);
    assert.strictEqual(statsRes.data.v5_surplus_pool, 2000);
    assert.strictEqual(statsRes.data.v5_surplus_held, 10);
    assert.strictEqual(statsRes.data.v5_surplus_available, 1990);
    assert.strictEqual(statsRes.data.total_subscription_period_anlas, 45);
    assert.strictEqual(statsRes.data.total_subscription_period_v5, 5);
    assert.strictEqual(statsRes.data.total_virtual_anlas_balance, 300);
    assert.strictEqual(statsRes.data.total_anlas_debt, -120);
    assert.strictEqual(statsRes.data.in_debt_users_count, 1);
    assert.strictEqual(statsRes.data.telemetry.master_anlas, 9000);
    assert.strictEqual(statsRes.data.telemetry.subscription_active, true);

    queueManager.complete('req_adm_view_1', 'dev_alice_1');
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: ONBOARDING RESET GATING, COLD-BOOT GUARD & GRACE FREEZE
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: /auth/status gates resets behind approval, cold-boot telemetry & grace period', async () => {
    queueManager.reset();

    // 1. Register unapproved onboarding device (defaults to Normal in users table)
    const regRes = await queryGateway('/auth/register', 'POST', {}, {
      browser_id: 'b_onboard_test',
      device_secret: 'sec_onboard_test',
      label: 'Onboarding Guest'
    });
    assert.strictEqual(regRes.status, 200);

    // Poll /auth/status while unapproved -> must NOT stamp last_anlas_reset_epoch or lock Normal 500 quota
    const unappPoll = await queryGateway('/auth/status?browser_id=b_onboard_test', 'GET', {
      'Authorization': 'Bearer sec_onboard_test'
    });
    assert.strictEqual(unappPoll.status, 200);
    assert.strictEqual(unappPoll.data.approved, false);
    assert.strictEqual(unappPoll.data.anlas.last_reset_epoch, null, 'Unapproved onboarding poll must NOT stamp last_anlas_reset_epoch');
    assert.strictEqual(unappPoll.data.anlas.virtual_balance, 0, 'Unapproved device must NOT receive Normal quota prior to tier assignment');

    // Admin approves as High tier (1000 monthlyAnlas) -> first approved poll grants full 1000 Anlas
    const appRes = await queryGateway('/admin/approve', 'POST', adminHeaders, {
      browser_id: 'b_onboard_test',
      priority_tier: 'High'
    });
    assert.strictEqual(appRes.status, 200);

    const postAppPoll = await queryGateway('/auth/status?browser_id=b_onboard_test', 'GET', {
      'Authorization': 'Bearer sec_onboard_test'
    });
    assert.strictEqual(postAppPoll.status, 200);
    assert.strictEqual(postAppPoll.data.approved, true);
    assert.strictEqual(postAppPoll.data.tier, 'High');
    assert.strictEqual(postAppPoll.data.anlas.virtual_balance, 1000, 'Approved High user must receive 1000 Anlas instead of locked pre-approval 500');
    assert.ok(postAppPoll.data.anlas.last_reset_epoch > 0);

    // 2. Grace-period freeze on /auth/status: u_debt9 with expired 35-day epoch remains frozen while isGracePeriod === true
    const currentSnap = serverModule.getTelemetrySnapshot();
    await dbModule.run("UPDATE users SET last_anlas_reset_epoch = ? WHERE user_id = 'u_debt9'", [Date.now() - (35 * 86400000)]);
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES + (3 * 86400),
      isGracePeriod: true,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());

    const gracePoll = await queryGateway('/auth/status?browser_id=dev_debt9', 'GET', {
      'Authorization': 'Bearer sec_debt9'
    });
    assert.strictEqual(gracePoll.status, 200);
    assert.strictEqual(gracePoll.data.anlas.virtual_balance, -120, 'Grace period must freeze Anlas reset on /auth/status');
    assert.strictEqual(gracePoll.data.anlas.is_in_debt, true);
    assert.strictEqual(gracePoll.data.telemetry.is_grace_period, true);

    // 3. Cold-boot guard (lastFetched === 0 && activeCycleEpoch === null): must skip 30-day fallback reset
    serverModule.resetTelemetryState({ lastFetchedAt: 0, activeCycleEpoch: 0 });
    const coldBootPoll = await queryGateway('/auth/status?browser_id=dev_debt9', 'GET', {
      'Authorization': 'Bearer sec_debt9'
    });
    assert.strictEqual(coldBootPoll.status, 200);
    assert.strictEqual(coldBootPoll.data.anlas.virtual_balance, -120, 'Cold boot without cycle telemetry must skip 30-day fallback reset');
    assert.strictEqual(coldBootPoll.data.telemetry.last_fetched_at, 0);

    // Restore healthy telemetry & clean u_debt9 epoch
    serverModule.resetTelemetryState({
      lastPaidExpiresAt: currentSnap.masterLastPaidExpiresAt,
      activeCycleEpoch: currentSnap.activeCycleEpoch
    });
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
    await dbModule.run("UPDATE users SET last_anlas_reset_epoch = ? WHERE user_id = 'u_debt9'", [serverModule.getTelemetrySnapshot().activeCycleEpoch]);
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: ADMIN BALANCE INJECTION RACE (`POST /admin/adjust-balance`)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Admin Balance Injection Race preserves active holds, serializes PoNR, rejects Admin Anlas & normalizes -0', async () => {
    queueManager.reset();

    // Reset u_alice to known baseline: 100 virtual Anlas, 180 V5 NCP
    await dbModule.run("UPDATE users SET virtual_anlas_balance = 100, v5_banked_balance = 180 WHERE user_id = 'u_alice'");

    // Client holds active Channel A (40 Anlas, 18 personal NCP) + Channel B (2 Anlas) => 42 Anlas held, 18 personal NCP held
    const taskA = queueManager.join({
      browser_id: 'dev_alice_1',
      req_id: 'req_inj_race_1',
      user_id: 'u_alice',
      discord_id: 'u_alice',
      priority_tier: 'Normal',
      held_cost: 40,
      held_ncp: 18,
      held_ncp_source: 'personal'
    });
    assert.strictEqual(queueManager.acquireTextSlot('vibe_inj_race_1', 'u_alice', 2), true);

    // 1. Admin injects +150 Anlas and -80 V5 NCP while holds are active
    const adjRes = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
      discord_id: 'u_alice',
      anlas_delta: 150,
      v5_ncp_delta: -80,
      reason: 'Event bonus and V5 correction'
    });
    assert.strictEqual(adjRes.status, 200);
    assert.strictEqual(adjRes.data.previous_anlas_balance, 100);
    assert.strictEqual(adjRes.data.virtual_anlas_balance, 250);
    assert.strictEqual(adjRes.data.held_anlas, 42, 'Active cross-channel Anlas holds must remain untouched');
    assert.strictEqual(adjRes.data.available_anlas_balance, 208, 'Available Anlas must reflect 250 - 42 = 208');
    assert.strictEqual(adjRes.data.v5_banked_balance, 100);
    assert.strictEqual(adjRes.data.v5_held_personal_ncp, 18, 'Active V5 personal NCP hold must remain untouched');
    assert.strictEqual(adjRes.data.v5_available_balance, 82, 'Available V5 NCP must reflect 100 - 18 = 82');
    assert.strictEqual(taskA.held_cost, 40);
    assert.strictEqual(taskA.held_ncp, 18);

    // 2. Verify SQLite bidirectional trigger synced all linked devices of u_alice
    const dev1 = await dbModule.get("SELECT virtual_anlas_balance, v5_banked_balance FROM devices WHERE browser_id = 'dev_alice_1'");
    const dev2 = await dbModule.get("SELECT virtual_anlas_balance, v5_banked_balance FROM devices WHERE browser_id = 'dev_alice_2'");
    assert.strictEqual(dev1.virtual_anlas_balance, 250);
    assert.strictEqual(dev2.virtual_anlas_balance, 250, 'Linked peer device must reflect admin Anlas adjustment via SQLite trigger');
    assert.strictEqual(dev1.v5_banked_balance, 100);
    assert.strictEqual(dev2.v5_banked_balance, 100, 'Linked peer device must reflect admin V5 adjustment via SQLite trigger');

    // 3. Admin slashes -220 Anlas (virtual = 30, held = 42 => available = -12) while hold stays intact!
    const slashRes = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
      browser_id: 'dev_alice_2',
      anlas_delta: -220,
      reason: 'Dispute chargeback'
    });
    assert.strictEqual(slashRes.status, 200);
    assert.strictEqual(slashRes.data.virtual_anlas_balance, 30);
    assert.strictEqual(slashRes.data.held_anlas, 42);
    assert.strictEqual(slashRes.data.available_anlas_balance, -12);

    // Subsequent status & spend checks must observe -12 available immediately without releasing hold
    const statusMidHold = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', { 'Authorization': 'Bearer sec_alice_1' });
    assert.strictEqual(statusMidHold.data.anlas.virtual_balance, 30);
    assert.strictEqual(statusMidHold.data.anlas.held, 42);
    assert.strictEqual(statusMidHold.data.anlas.available_balance, -12);

    const spendCheck = await auditEngine.authorizeAnlasSpend('u_alice', {
      declaredAnlas: 2,
      heldAnlas: queueManager.getHeldAnlasForUser('u_alice')
    });
    assert.strictEqual(spendCheck.ok, false);
    assert.strictEqual(spendCheck.error, 'INSUFFICIENT_ANLAS');

    // 4. Concurrent PoNR commitAnlasDebit + admin /adjust-balance race via Promise.all
    //    (Starting from 30: commit 10 -> -10, admin +50 -> final must equal 70 with zero lost update)
    const [commitOut, adminConcurrentOut] = await Promise.all([
      auditEngine.commitAnlasDebit('u_alice', 10, 'dev_alice_1'),
      queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
        user_id: 'u_alice',
        anlas_delta: 50
      })
    ]);
    assert.strictEqual(commitOut.committed, true);
    assert.strictEqual(adminConcurrentOut.status, 200);
    const finalAliceRow = await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_alice'");
    assert.strictEqual(finalAliceRow.virtual_anlas_balance, 70, 'withUserLock must prevent lost updates between commitAnlasDebit and admin adjust');

    // 5. Releasing active holds restores full 70 available Anlas
    queueManager.complete('req_inj_race_1', 'dev_alice_1');
    queueManager.releaseTextSlot('vibe_inj_race_1');
    const postReleaseStatus = await queryGateway('/auth/status?browser_id=dev_alice_1', 'GET', { 'Authorization': 'Bearer sec_alice_1' });
    assert.strictEqual(postReleaseStatus.data.anlas.held, 0);
    assert.strictEqual(postReleaseStatus.data.anlas.available_balance, 70);

    // 6. IEEE-754 -0 normalization in direct auditEngine.adjustUserBalances calls
    const negZeroOut = await auditEngine.adjustUserBalances('u_alice', {
      virtualAnlasBalance: -0,
      v5BankedBalance: -0
    });
    assert.strictEqual(Object.is(negZeroOut.virtual_anlas_balance, 0), true, 'Must normalize -0 Anlas balance to +0');
    assert.strictEqual(Object.is(negZeroOut.v5_banked_balance, 0), true, 'Must normalize -0 V5 balance to +0');

    // Restore u_alice to 70 Anlas
    await auditEngine.adjustUserBalances('u_alice', { virtualAnlasBalance: 70 });

    // 7. Unlimited-tier database principal (u_admin_db): rejects virtual Anlas adjustment with 400 (no phantom DB debt),
    //    while permitting finite V5 NCP adjustment cleanly
    const adminDbAnlasRes = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
      user_id: 'u_admin_db',
      anlas_delta: -500
    });
    assert.strictEqual(adminDbAnlasRes.status, 400, 'Must reject virtual Anlas adjustment on unlimited-quota Admin tier');
    const adminDbRowAfterReject = await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_admin_db'");
    assert.strictEqual(adminDbRowAfterReject.virtual_anlas_balance, 0, 'Must never write phantom debt into SQLite for Admin tier');

    const adminDbV5Res = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
      user_id: 'u_admin_db',
      v5_ncp_delta: 50
    });
    assert.strictEqual(adminDbV5Res.status, 200, 'V5 NCP adjustment on Admin-tier principal must succeed');
    assert.strictEqual(adminDbV5Res.data.v5_banked_balance, 150);
    assert.strictEqual(adminDbV5Res.data.anlas_unlimited, true);
    assert.strictEqual(adminDbV5Res.data.virtual_anlas_balance, null);
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: DEBT RECONCILIATION (`POST /admin/reconcile-debt`)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Debt Reconciliation pays down/forgives debt, enforces cap_at_zero, clears DEBT_LOCKED & spares positive/unlimited', async () => {
    queueManager.reset();
    await dbModule.run("UPDATE users SET virtual_anlas_balance = -120 WHERE user_id = 'u_debt9'");

    // Verify u_debt9 is currently blocked by DEBT_LOCKED
    const lockedBefore = await auditEngine.authorizeAnlasSpend('u_debt9', { declaredAnlas: 5, heldAnlas: 0 });
    assert.strictEqual(lockedBefore.ok, false);
    assert.strictEqual(lockedBefore.error, 'DEBT_LOCKED');

    // 1. Partial paydown: credit 50 -> -70 (still in debt)
    const partialRes = await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, {
      discord_id: 'u_debt9',
      credit_amount: 50,
      reason: 'Partial payment'
    });
    assert.strictEqual(partialRes.status, 200);
    assert.strictEqual(partialRes.data.reconciled, true);
    assert.strictEqual(partialRes.data.was_in_debt, true);
    assert.strictEqual(partialRes.data.previous_balance, -120);
    assert.strictEqual(partialRes.data.virtual_anlas_balance, -70);
    assert.strictEqual(partialRes.data.is_in_debt, true);

    // 2. Excess credit with cap_at_zero: true clamps balance strictly at 0 (no positive surplus)
    const cappedRes = await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, {
      discord_id: 'u_debt9',
      credit_amount: 100,
      cap_at_zero: true,
      reason: 'Payoff capped at zero'
    });
    assert.strictEqual(cappedRes.status, 200);
    assert.strictEqual(cappedRes.data.reconciled, true);
    assert.strictEqual(cappedRes.data.previous_balance, -70);
    assert.strictEqual(cappedRes.data.virtual_anlas_balance, 0);
    assert.strictEqual(cappedRes.data.is_in_debt, false);

    // 3. Full debt forgiveness via browser_id -> 0 (clears DEBT_LOCKED)
    await dbModule.run("UPDATE users SET virtual_anlas_balance = -40 WHERE user_id = 'u_debt9'");
    const forgiveRes = await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, {
      browser_id: 'dev_debt9',
      reason: 'Full debt reconciliation'
    });
    assert.strictEqual(forgiveRes.status, 200);
    assert.strictEqual(forgiveRes.data.reconciled, true);
    assert.strictEqual(forgiveRes.data.previous_balance, -40);
    assert.strictEqual(forgiveRes.data.virtual_anlas_balance, 0);
    assert.strictEqual(forgiveRes.data.is_in_debt, false);

    // Synced to device table
    const debtDev = await dbModule.get("SELECT virtual_anlas_balance FROM devices WHERE browser_id = 'dev_debt9'");
    assert.strictEqual(debtDev.virtual_anlas_balance, 0);

    // 4. Refusal to wipe or lower an already positive Anlas balance
    await dbModule.run("UPDATE users SET virtual_anlas_balance = 250 WHERE user_id = 'u_debt9'");
    const noopRes = await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, {
      discord_id: 'u_debt9'
    });
    assert.strictEqual(noopRes.status, 200);
    assert.strictEqual(noopRes.data.reconciled, false);
    assert.strictEqual(noopRes.data.was_in_debt, false);
    assert.strictEqual(noopRes.data.virtual_anlas_balance, 250, 'Debt reconciliation must NEVER wipe a positive balance');

    // 5. Unlimited-tier database principal (u_admin_db) returns clean no-op without mutating SQLite
    const adminReconcileRes = await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, {
      user_id: 'u_admin_db'
    });
    assert.strictEqual(adminReconcileRes.status, 200);
    assert.strictEqual(adminReconcileRes.data.reconciled, false);
    assert.strictEqual(adminReconcileRes.data.anlas_unlimited, true);
    assert.strictEqual(adminReconcileRes.data.virtual_anlas_balance, null);
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: SECURITY, VALIDATION, AUTH GUARDS, QUERY ARRAYS & UNBAN CLEANUP
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces reserved IDs, hijack guards, presence auth, validation, query-array safety & unban cleanup', async () => {
    // 1. Reserved principal 'admin' cannot be claimed via /auth/register
    for (const reservedId of ['admin', 'ADMIN', '  admin  ']) {
      const regAdminRes = await queryGateway('/auth/register', 'POST', {}, {
        browser_id: reservedId,
        device_secret: 'attacker_secret',
        label: 'Impersonator'
      });
      assert.strictEqual(regAdminRes.status, 400, `Registering reserved ID "${reservedId}" must fail 400`);
    }

    // 1b. Canonical principal hijack via /auth/register against an existing non-b_ principal must return 409
    const hijackRes = await queryGateway('/auth/register', 'POST', {}, {
      browser_id: 'u_alice',
      device_secret: 'hijack_secret',
      label: 'Hijacker'
    });
    assert.strictEqual(hijackRes.status, 409, 'Registering an existing canonical principal ID must be rejected with 409');
    const hijackedDevice = await dbModule.get("SELECT browser_id FROM devices WHERE browser_id = 'u_alice'");
    assert.strictEqual(hijackedDevice, undefined, 'Hijacked device row must not exist');

    // 1c. Whitespace-padded b_ registration trims cleanly without storing padded browser_id
    const paddedRegRes = await queryGateway('/auth/register', 'POST', {}, {
      browser_id: '  b_padded_clean  ',
      device_secret: 'sec_padded_clean',
      label: 'Padded Guest'
    });
    assert.strictEqual(paddedRegRes.status, 200);
    assert.ok(await dbModule.get("SELECT browser_id FROM devices WHERE browser_id = 'b_padded_clean'"));
    assert.strictEqual(await dbModule.get("SELECT browser_id FROM devices WHERE browser_id = '  b_padded_clean  '"), undefined);

    // 1d. Pruned unlinked b_ device CAN cleanly re-register
    await queryGateway('/auth/register', 'POST', {}, {
      browser_id: 'b_pruned_rejoin',
      device_secret: 'sec_pruned_rejoin',
      label: 'Pruned Guest'
    });
    await queryGateway('/admin/prune-device', 'POST', adminHeaders, { browser_id: 'b_pruned_rejoin' });
    const reRegRes = await queryGateway('/auth/register', 'POST', {}, {
      browser_id: 'b_pruned_rejoin',
      device_secret: 'sec_pruned_rejoin',
      label: 'Rejoined Guest'
    });
    assert.strictEqual(reRegRes.status, 200, 'Pruned unlinked b_ device must be able to re-register');

    // 2. Unauthenticated /auth/status must NOT mark an offline device online
    queueManager.reset();
    assert.strictEqual(queueManager.isDeviceOnline('dev_alice_2'), false);
    const badAuthStatus = await queryGateway('/auth/status?browser_id=dev_alice_2', 'GET', {
      'Authorization': 'Bearer wrong_secret'
    });
    assert.strictEqual(badAuthStatus.status, 401);
    assert.strictEqual(queueManager.isDeviceOnline('dev_alice_2'), false, 'Failed auth must not mark device online');

    // 2b. POST /auth/debug-intent rejects non-boolean enabled ("false" must not coerce to true!)
    const stringBoolDebug = await queryGateway('/auth/debug-intent', 'POST', {
      'Authorization': 'Bearer sec_alice_1'
    }, { browser_id: 'dev_alice_1', enabled: 'false' });
    assert.strictEqual(stringBoolDebug.status, 400);
    assert.strictEqual(queueManager.hasDebugIntent('dev_alice_1'), false, 'String "false" must never arm debug intent');

    // 2c. POST /admin/debug-target rejects whitespace browser_id
    const wsDebugTarget = await queryGateway('/admin/debug-target', 'POST', adminHeaders, {
      browser_id: '   ',
      enable: true
    });
    assert.strictEqual(wsDebugTarget.status, 400);

    // 3. Auth guards on new admin endpoints
    assert.strictEqual((await queryGateway('/admin/adjust-balance', 'POST', {}, { user_id: 'u_alice', anlas_delta: 10 })).status, 401);
    assert.strictEqual((await queryGateway('/admin/adjust-balance', 'POST', { 'Authorization': 'Bearer wrong_key' }, { user_id: 'u_alice', anlas_delta: 10 })).status, 403);
    assert.strictEqual((await queryGateway('/admin/reconcile-debt', 'POST', {}, { user_id: 'u_debt9' })).status, 401);

    // 4. Null-shadow fallback: { user_id: null, discord_id: 'u_alice' } resolves to 'u_alice'
    const fallbackAdj = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, {
      user_id: null,
      discord_id: 'u_alice',
      anlas_delta: 0
    });
    assert.strictEqual(fallbackAdj.status, 200);
    assert.strictEqual(fallbackAdj.data.user_id, 'u_alice');

    // 5. Poison inputs, overflow & conflicting fields -> 400 / 404
    const badAdjustPayloads = [
      { user_id: 'admin', anlas_delta: 10 },
      { user_id: '  ADMIN  ', anlas_delta: 10 },
      { user_id: 'u_alice' },
      { user_id: 'u_alice', anlas_delta: 10, virtual_anlas_balance: 100 },
      { user_id: 'u_alice', v5_ncp_delta: 10, v5_banked_balance: 100 },
      { user_id: 'u_alice', anlas_delta: Number.MAX_SAFE_INTEGER },
      { user_id: 'u_alice', anlas_delta: 10.5 },
      { user_id: 'u_alice', anlas_delta: '10' },
      { user_id: 'u_alice', anlas_delta: true },
      { user_id: 'u_alice', v5_banked_balance: -5 }
    ];
    for (const p of badAdjustPayloads) {
      const r = await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, p);
      assert.strictEqual(r.status, 400, `Bad adjust payload ${JSON.stringify(p)} must return 400`);
    }

    assert.strictEqual(
      (await queryGateway('/admin/adjust-balance', 'POST', adminHeaders, { user_id: 'ghost_user_9', anlas_delta: 10 })).status,
      404
    );
    assert.strictEqual(
      (await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, { user_id: 'u_alice', credit_amount: 0 })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/reconcile-debt', 'POST', adminHeaders, { user_id: 'u_alice', credit_amount: -5 })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/approve', 'POST', adminHeaders, { browser_id: 'dev_alice_1', priority_tier: 'Mythic' })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/approve', 'POST', adminHeaders, { browser_id: 'dev_alice_1', priority_tier: ['Normal'] })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/approve', 'POST', adminHeaders, { browser_id: ['dev_alice_1'], priority_tier: 'Normal' })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/sync-tier', 'POST', adminHeaders, { discord_id: 'u_alice', priority_tier: ['High'] })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/update-token', 'POST', adminHeaders, { master_token: null })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/update-token', 'POST', adminHeaders, { master_token: '   ' })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/sync-usernames', 'POST', adminHeaders, { mappings: [null] })).status,
      400
    );
    assert.strictEqual(
      (await queryGateway('/admin/prune-device', 'POST', adminHeaders, { browser_id: ['dev_alice_1'] })).status,
      400
    );

    // 6. Express 5 query array safety on /auth/status and /admin/user-devices
    const statusArrRes = await queryGateway('/auth/status?browser_id=dev_alice_1&browser_id=dev_alice_2', 'GET', {
      'Authorization': 'Bearer sec_alice_1'
    });
    assert.strictEqual(statusArrRes.status, 401);

    const userDevArrRes = await queryGateway('/admin/user-devices?discord_id=a&discord_id=b', 'GET', adminHeaders);
    assert.strictEqual(userDevArrRes.status, 400);

    // 7. Unban consistency: security ban via commitSecurityBan inserts into banned_discords;
    //    POST /admin/unban must clear users, devices, AND banned_discords so verifyDevice passes!
    await auditEngine.commitSecurityBan({
      browserId: 'dev_debt9',
      userId: 'u_debt9',
      discordId: 'u_debt9',
      reason: 'Test ban cleanup'
    });
    const bannedStatus = await queryGateway('/auth/status?browser_id=dev_debt9', 'GET', { 'Authorization': 'Bearer sec_debt9' });
    assert.strictEqual(bannedStatus.status, 403);

    const unbanRes = await queryGateway('/admin/unban', 'POST', adminHeaders, { browser_id: 'dev_debt9' });
    assert.strictEqual(unbanRes.status, 200);

    const unbannedStatus = await queryGateway('/auth/status?browser_id=dev_debt9', 'GET', { 'Authorization': 'Bearer sec_debt9' });
    assert.strictEqual(unbannedStatus.status, 200, 'POST /admin/unban must clear banned_discords so user is not re-banned');
    assert.strictEqual(unbannedStatus.data.approved, true);
  });
});