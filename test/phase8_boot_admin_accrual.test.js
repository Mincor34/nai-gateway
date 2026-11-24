/**
 * PHASE 8 BOOT & ADMIN ACCRUAL VERIFICATION HARNESS (test/phase8_boot_admin_accrual.test.js)
 *
 * Exhaustively tests server-side V5/Anlas allotment across boot and administrative mutations:
 * 1. Happy Path: Cold/Warm Boot V5 Seeding over Pre-Existing Migrated Databases (`server.js`):
 *    - Seeds a legacy Phase 7 SQLite database containing approved Normal, High, Metered,
 *      unapproved Normal, and banned Normal users lacking ACS-1 columns.
 *    - Migrates via `initDatabase()` and boots `server.js` against `16.0%` active Opus telemetry.
 *    - Asserts WITHOUT any guest polling `/auth/status` or `/queue/join`:
 *      * Approved Normal & High principals immediately receive Day 1 V5 NCP shares proportional
 *        to their tier weights (`3:2`) and stamp `v5_last_accrual_epoch > 0`.
 *      * Metered principals stay at `0` NCP with `v5_last_accrual_epoch === null` (no 24h upgrade lock).
 *      * Unapproved and banned principals stay at `0` NCP with `v5_last_accrual_epoch === null`.
 *      * `GET /admin/devices` immediately surfaces the seeded V5 reserve balances.
 * 2. Hell Path: Cold-Boot Token Recovery, Inactive Subscription Guard & `v5.0.0` Client Blocking:
 *    - Verifies `v5.0.0` clients hitting `/auth/status` receive `426 SCRIPT_UPDATE_REQUIRED`
 *      before `queueManager.ping()` or accrual, remaining offline (`is_online: false`) at `0` NCP.
 *    - Verifies cold-to-warm `POST /admin/update-token` runs `seedApprovedUserV5Ledgers()` once
 *      telemetry becomes active, whereas subsequent `syncTelemetry()` ticks do not double-seed.
 *    - Verifies `active: false` telemetry leaves unseeded approved users at `0` NCP.
 * 3. Happy & Hell Paths: Immediate Ledger Sync on `POST /admin/approve`, `/admin/link` & `/admin/sync-tier`:
 *    - Approving a newly registered device (`High`) immediately grants `1000` Monthly Anlas and
 *      Day 1 V5 NCP without waiting for client polling, and avoids double-granting when the
 *      client subsequently polls `/auth/status`.
 *    - Linking a pending device (`POST /admin/link`) immediately seeds `500` Anlas and V5 NCP.
 *    - Upgrading a `Metered` user (`POST /admin/sync-tier` -> `Normal`) immediately grants V5 NCP
 *      and cycle Anlas; downgrading a mid-cycle bloated `High` user (`virtual_anlas_balance = 333`,
 *      `last_anlas_reset_epoch = activeCycleEpoch`) to `Metered` immediately clamps V5 NCP down to `0`
 *      while preserving mid-cycle Anlas (`333`).
 *    - Approving a banned user or a pruned orphan (`0` devices) grants `0` Anlas and `0` NCP.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_boot_admin_accrual.db');
const TEST_PORT = 19800;
const MOCK_UPSTREAM_PORT = 19801;

process.env.ADMIN_SECRET_KEY = 'boot_accrual_admin_key';
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.MINIMUM_USERSCRIPT_VERSION = '6.0.0';
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

let mockSubActive = true;
let mockSubPercent = 16.0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/user/subscription') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tier: mockSubActive ? 3 : 0,
      active: mockSubActive,
      expiresAt: Math.floor(Date.now() / 1000) + (20 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 5085, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: mockSubPercent, timeUntilNextPercent: 7200, isNegative: false }
    }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

async function sendHttp(endpoint, method = 'GET', headers = {}, body = undefined) {
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
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${endpoint}`, fetchOptions);
  const ct = res.headers.get('content-type') || '';
  return {
    status: res.status,
    data: ct.includes('application/json') ? await res.json() : await res.text()
  };
}

test('Phase 8 Boot & Admin Accrual: Immediate V5 Reserve Seeding & Admin Mutation Ledger Sync', async (t) => {
  // 1. Pre-populate a legacy pre-ACS-1 Phase 7 database before initDatabase & server.js boot
  await new Promise((resolve, reject) => {
    const legacyDb = new sqlite3.Database(SANDBOX_DB_FILE, (err) => {
      if (err) return reject(err);
      legacyDb.serialize(() => {
        legacyDb.run(`CREATE TABLE devices (
          browser_id TEXT PRIMARY KEY,
          user_id TEXT,
          device_secret TEXT NOT NULL,
          label TEXT,
          priority_tier TEXT NOT NULL DEFAULT 'Normal',
          approved INTEGER NOT NULL DEFAULT 0,
          banned INTEGER NOT NULL DEFAULT 0,
          total_requests INTEGER NOT NULL DEFAULT 0,
          last_active_at INTEGER,
          discord_id TEXT,
          discord_username TEXT,
          anlas_consumed INTEGER NOT NULL DEFAULT 0,
          metered_allowance INTEGER DEFAULT 100,
          last_allowance_update_at INTEGER
        )`);
        legacyDb.run(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        legacyDb.run(`INSERT INTO config (key, value) VALUES ('master_token', 'boot_accrual_master_token')`);

        const lastAct = Date.now() - 3600000;
        legacyDb.run(
          `INSERT INTO devices (browser_id, user_id, discord_id, discord_username, device_secret, label, priority_tier, approved, banned, last_active_at)
           VALUES ('dev_norm', 'u_norm', 'u_norm', 'NormalUser', 'sec_norm', 'Veu', 'Normal', 1, 0, ?)`,
          [lastAct]
        );
        legacyDb.run(
          `INSERT INTO devices (browser_id, user_id, discord_id, discord_username, device_secret, label, priority_tier, approved, banned, last_active_at)
           VALUES ('dev_high', 'u_high', 'u_high', 'HighUser', 'sec_high', 'Desk', 'High', 1, 0, ?)`,
          [lastAct]
        );
        legacyDb.run(
          `INSERT INTO devices (browser_id, user_id, discord_id, discord_username, device_secret, label, priority_tier, approved, banned, last_active_at)
           VALUES ('dev_met', 'u_metered', 'u_metered', 'MeteredUser', 'sec_met', 'Tab', 'Metered', 1, 0, ?)`,
          [lastAct]
        );
        legacyDb.run(
          `INSERT INTO devices (browser_id, user_id, discord_id, discord_username, device_secret, label, priority_tier, approved, banned, last_active_at)
           VALUES ('dev_unapp', 'u_unapp', 'u_unapp', 'UnappUser', 'sec_unapp', 'Pending', 'Normal', 0, 0, ?)`,
          [lastAct]
        );
        legacyDb.run(
          `INSERT INTO devices (browser_id, user_id, discord_id, discord_username, device_secret, label, priority_tier, approved, banned, last_active_at)
           VALUES ('dev_ban', 'u_banned', 'u_banned', 'BannedUser', 'sec_ban', 'Banned', 'Normal', 1, 1, ?)`,
          [lastAct]
        );

        legacyDb.close(e => (e ? reject(e) : resolve()));
      });
    });
  });

  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;

  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 30));
  }

  const adminHeaders = { 'Authorization': 'Bearer boot_accrual_admin_key' };

  t.after(async () => {
    delete process.env.MINIMUM_USERSCRIPT_VERSION;
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await new Promise(r => mockUpstream.close(r));
    await dbModule.closeDatabase();
    cleanupFiles();
  });

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: WARM BOOT SEEDING OVER LEGACY MIGRATED DATABASE
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Boot seeds Day 1 V5 reserve for approved non-Metered users without requiring client poll', async () => {
    // Expected weights at boot: u_norm (2) + u_high (3) + u_metered (0) + implicit Admin (4) = 9
    // C_base from timeUntilNextPercent=7200: (86400 / 7200) * 17.28 = 207.36 -> nominalDailyNcp = floor(207.36 * 18) = 3732
    // u_norm share = floor(3732 * (2 / 9)) = 829 NCP; u_high share = floor(3732 * (3 / 9)) = 1244 NCP
    const normRow = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_norm'");
    const highRow = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_high'");
    const metRow = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_metered'");
    const unappRow = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_unapp'");
    const banRow = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_banned'");

    assert.strictEqual(normRow.v5_banked_balance, 829, 'Approved Normal user must immediately receive Day 1 V5 reserve on boot');
    assert.ok(normRow.v5_last_accrual_epoch > 0, 'Boot seeding must stamp v5_last_accrual_epoch so offline banking begins');

    assert.strictEqual(highRow.v5_banked_balance, 1244, 'Approved High user must immediately receive proportional Day 1 V5 reserve');
    assert.ok(highRow.v5_last_accrual_epoch > 0);

    assert.strictEqual(metRow.v5_banked_balance, 0, 'Metered user must receive 0 V5 reserve');
    assert.strictEqual(metRow.v5_last_accrual_epoch, null, 'Metered user must not stamp 24h accrual cooldown');

    assert.strictEqual(unappRow.v5_banked_balance, 0, 'Unapproved user must remain at 0 V5 reserve');
    assert.strictEqual(unappRow.v5_last_accrual_epoch, null);

    assert.strictEqual(banRow.v5_banked_balance, 0, 'Banned user must remain at 0 V5 reserve');
    assert.strictEqual(banRow.v5_last_accrual_epoch, null);

    // Confirm GET /admin/devices immediately surfaces the seeded balances
    const devRes = await sendHttp('/admin/devices', 'GET', adminHeaders);
    assert.strictEqual(devRes.status, 200);
    const normGroup = devRes.data.find(g => g.user_id === 'u_norm');
    assert.strictEqual(normGroup.v5_banked_balance, 829);
    assert.strictEqual(normGroup.v5_available_balance, 829);
  });

  // ---------------------------------------------------------------------------
  // 2. HELL PATH: v5.0.0 BLOCKING, TOKEN-PUSH SEEDING & INACTIVE-SUB GUARD
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: v5.0.0 client blocked before ping/accrual; cold-boot token push seeds approved users while inactive sub skips', async () => {
    // 1. Simulate a newly approved Normal user inserted directly with NULL v5_last_accrual_epoch
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_late_v5', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('b_late_v5', 'u_late_v5', 'sec_late_v5', 1)");

    // Legacy v5.0.0 client polls /auth/status -> rejected 426 BEFORE ping() or accrual
    const v5Poll = await sendHttp('/auth/status?browser_id=b_late_v5', 'GET', {
      'Authorization': 'Bearer sec_late_v5',
      'X-Script-Version': '5.0.0'
    });
    assert.strictEqual(v5Poll.status, 426);
    assert.strictEqual(v5Poll.data.error, 'SCRIPT_UPDATE_REQUIRED');
    assert.strictEqual(queueManager.isDeviceOnline('b_late_v5'), false, '426 must not mark v5.0.0 client online');
    const beforePush = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_late_v5'");
    assert.strictEqual(beforePush.v5_banked_balance, 0);
    assert.strictEqual(beforePush.v5_last_accrual_epoch, null);

    // 2. Inactive subscription during token push must NOT mint V5 credits
    mockSubActive = false;
    serverModule.resetTelemetryState({ lastFetchedAt: 0 });
    const inactivePush = await sendHttp('/admin/update-token', 'POST', adminHeaders, {
      master_token: 'inactive_sub_tok'
    });
    assert.strictEqual(inactivePush.status, 200);
    const afterInactivePush = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_late_v5'");
    assert.strictEqual(afterInactivePush.v5_banked_balance, 0, 'Inactive Opus subscription must not seed V5 credits');
    assert.strictEqual(afterInactivePush.v5_last_accrual_epoch, null);

    // 3. Pushing active Opus token immediately triggers cold-to-warm seeding for u_late_v5
    mockSubActive = true;
    const activePush = await sendHttp('/admin/update-token', 'POST', adminHeaders, {
      master_token: 'active_opus_tok'
    });
    assert.strictEqual(activePush.status, 200);
    const afterActivePush = await dbModule.get("SELECT v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_late_v5'");
    assert.ok(afterActivePush.v5_banked_balance > 0, 'Active token recovery must seed pending approved users immediately');
    assert.ok(afterActivePush.v5_last_accrual_epoch > 0);

    // Subsequent warm heartbeat syncTelemetry() must NOT double-seed
    const balBeforeSecondSync = afterActivePush.v5_banked_balance;
    await serverModule.syncTelemetry({ rescheduleHeartbeat: false });
    const afterSecondSync = await dbModule.get("SELECT v5_banked_balance FROM users WHERE user_id = 'u_late_v5'");
    assert.strictEqual(afterSecondSync.v5_banked_balance, balBeforeSecondSync, 'Warm sync must not double-seed V5 credits');
  });

  // ---------------------------------------------------------------------------
  // 3. HAPPY & HELL PATHS: /admin/approve, /admin/link & /admin/sync-tier
  // ---------------------------------------------------------------------------
  await t.test('Admin Mutations: /approve, /link & /sync-tier immediately seed/clamp ledgers while isolating banned/orphans', async () => {
    // 1. Register + POST /admin/approve (High) -> immediately gets 1000 Anlas and Day 1 V5 NCP BEFORE polling /auth/status
    await sendHttp('/auth/register', 'POST', {}, {
      browser_id: 'b_app_now',
      device_secret: 'sec_app_now',
      label: 'ImmediateApprove'
    });

    const appRes = await sendHttp('/admin/approve', 'POST', adminHeaders, {
      browser_id: 'b_app_now',
      priority_tier: 'High'
    });
    assert.strictEqual(appRes.status, 200);

    const appUser = await dbModule.get(
      "SELECT virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'b_app_now'"
    );
    assert.strictEqual(appUser.virtual_anlas_balance, 1000, 'POST /admin/approve must immediately grant High monthly Anlas');
    assert.ok(appUser.last_anlas_reset_epoch > 0);
    assert.ok(appUser.v5_banked_balance > 0, 'POST /admin/approve must immediately grant Day 1 V5 NCP');
    assert.ok(appUser.v5_last_accrual_epoch > 0);

    // First client poll on v6.0.0 must NOT double-grant V5 NCP or reset Anlas
    const clientPoll = await sendHttp('/auth/status?browser_id=b_app_now', 'GET', {
      'Authorization': 'Bearer sec_app_now',
      'X-Script-Version': '6.0.0'
    });
    assert.strictEqual(clientPoll.status, 200);
    assert.strictEqual(clientPoll.data.anlas.available_balance, 1000);
    assert.strictEqual(clientPoll.data.v5.banked_ncp, appUser.v5_banked_balance);

    // 2. Register + POST /admin/link -> immediately seeds 500 Anlas and Day 1 V5 NCP
    await sendHttp('/auth/register', 'POST', {}, {
      browser_id: 'b_link_now',
      device_secret: 'sec_link_now',
      label: 'ImmediateLink'
    });
    const linkRes = await sendHttp('/admin/link', 'POST', adminHeaders, {
      browser_id: 'b_link_now',
      discord_id: 'discord_linked_now',
      discord_username: 'LinkedNow',
      priority_tier: 'Normal'
    });
    assert.strictEqual(linkRes.status, 200);

    const linkedUser = await dbModule.get(
      "SELECT virtual_anlas_balance, v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'discord_linked_now'"
    );
    assert.strictEqual(linkedUser.virtual_anlas_balance, 500);
    assert.ok(linkedUser.v5_banked_balance > 0);
    assert.ok(linkedUser.v5_last_accrual_epoch > 0);

    // 3. POST /admin/sync-tier upgrade (Metered -> Normal) immediately grants V5 NCP & Anlas
    const upgRes = await sendHttp('/admin/sync-tier', 'POST', adminHeaders, {
      discord_id: 'u_metered',
      priority_tier: 'Normal'
    });
    assert.strictEqual(upgRes.status, 200);
    const upgradedUser = await dbModule.get(
      "SELECT virtual_anlas_balance, v5_banked_balance, v5_last_accrual_epoch FROM users WHERE user_id = 'u_metered'"
    );
    assert.strictEqual(upgradedUser.virtual_anlas_balance, 500, 'Upgrading Metered -> Normal must seed initial monthly Anlas');
    assert.ok(upgradedUser.v5_banked_balance > 0, 'Upgrading Metered -> Normal must immediately grant Day 1 V5 NCP');
    assert.ok(upgradedUser.v5_last_accrual_epoch > 0);

    // 4. Mid-cycle downgrade (High user who already initialized Cycle 1 -> spent to 333 Anlas, bloated 5000 NCP)
    //    must immediately clamp V5 NCP down to 0 while leaving mid-cycle Anlas (333) untouched
    const highPoll = await sendHttp('/auth/status?browser_id=dev_high', 'GET', {
      'Authorization': 'Bearer sec_high',
      'X-Script-Version': '6.0.0'
    });
    assert.strictEqual(highPoll.status, 200);
    assert.strictEqual(highPoll.data.anlas.virtual_balance, 1000);

    await dbModule.run("UPDATE users SET v5_banked_balance = 5000, virtual_anlas_balance = 333 WHERE user_id = 'u_high'");
    const downRes = await sendHttp('/admin/sync-tier', 'POST', adminHeaders, {
      discord_id: 'u_high',
      priority_tier: 'Metered'
    });
    assert.strictEqual(downRes.status, 200);
    const downgradedUser = await dbModule.get(
      "SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = 'u_high'"
    );
    assert.strictEqual(downgradedUser.v5_banked_balance, 0, 'Downgrading to Metered must clamp V5 reserve to 0 immediately');
    assert.strictEqual(downgradedUser.virtual_anlas_balance, 333, 'Mid-cycle tier change must not re-grant or erase Anlas');

    // 5. Hell Path: Approving banned user or pruned orphan with 0 devices grants 0 Anlas & 0 V5 NCP
    await sendHttp('/admin/approve', 'POST', adminHeaders, {
      user_id: 'u_banned',
      priority_tier: 'High'
    });
    const bannedAfter = await dbModule.get("SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = 'u_banned'");
    assert.strictEqual(bannedAfter.virtual_anlas_balance, 0);
    assert.strictEqual(bannedAfter.v5_banked_balance, 0);

    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('b_orphan_none', 'Normal', 0)");
    await sendHttp('/admin/approve', 'POST', adminHeaders, {
      user_id: 'b_orphan_none',
      priority_tier: 'High'
    });
    const orphanAfter = await dbModule.get("SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = 'b_orphan_none'");
    assert.strictEqual(orphanAfter.virtual_anlas_balance, 0, 'Orphan principal with 0 approved devices must not receive Anlas');
    assert.strictEqual(orphanAfter.v5_banked_balance, 0, 'Orphan principal with 0 approved devices must not receive V5 NCP');
  });
});