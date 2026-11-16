/**
 * PHASE 8 COMMIT 8 VERIFICATION HARNESS (test/phase8_commit8_ponr_settlement.test.js)
 *
 * Exhaustively tests:
 * 1. Happy Path: Anlas Base-Paid PoNR Settlement & V5 Battery Immunity:
 *    - `1536x2048` V5 High (`X-Base-Paid: true`, `X-Declared-Anlas: 60`, `X-Scraped-Anlas: 60`)
 *      holds `60` Anlas pre-dispatch, re-anchors `started_processing_at`, commits `60` Anlas debit
 *      (`virtual_anlas_balance`, `subscription_period_anlas`, `anlas_consumed`, device sync) on `200 OK`,
 *      clears holds, and leaves `v5_banked_balance` + `dispatchesHigh` completely untouched even
 *      while the 5.5% V5 circuit breaker is active.
 *    - V5 Medium Anlas-paid (`1536x2048, 1 sample` -> `34` Anlas; `1024x1024, 2 samples` -> `12` Anlas)
 *      enforces exact `step_factor` (`1 / 1.06521739`) PoNR settlement with zero V5 bank deduction.
 * 2. Happy Path: Free V5 Bucket 1 / Bucket 2 PoNR & Orthogonal Addon Accounting:
 *    - Bucket 1 (`personal`) deducts `18` NCP (High) / `10` NCP (Medium) and increments
 *      `v5_daily_consumed` + `subscription_period_v5` strictly on `HTTP 200 OK`.
 *    - Bucket 2 (`surplus`) deducts `18` NCP from RAM `v5SurplusPool`, persists `v5_surplus_pool`
 *      to SQLite `config`, and increments daily/period counters without deducting `v5_banked_balance`.
 *    - Free-base V5 High with `1` character reference (`X-Base-Paid: false`, `X-Declared-Anlas: 5`)
 *      commits BOTH `5` Anlas AND `18` V5 NCP + `dispatchesHigh += 1` (addons do not exempt V5 battery).
 *    - No double-counting of `anlas_consumed` from legacy `runBackgroundAudit`.
 * 3. Hell Path: Synchronous Stage 5 Parameter Forgery Ban & Queue Eviction:
 *    - `X-Gen-Width: 1024` vs `2048` in body -> immediate `403 PARAMETER_FORGERY`, `0` upstream hits,
 *      permanent ban committed across `users`, `devices`, and `banned_discords` (`ban_notified = 0`),
 *      and active Channel A + Channel B locks evicted immediately.
 *    - `X-Gen-Model: V5-medium` vs `nai-diffusion-5-full` OR legacy `nai-diffusion-4-5-full` in body
 *      -> immediate `403 PARAMETER_FORGERY`, permanent ban, `0` upstream hits.
 *    - `X-Gen-Model: V5` vs legacy `nai-diffusion-4-5-full` (`steps: 50`) OR omitted `model: null` in body
 *      -> immediate `403 PARAMETER_FORGERY`, permanent ban, `0` upstream hits.
 *    - Multipart `X-Gen-Model: legacy` vs `nai-diffusion-5-full` in body preceded by binary image
 *      -> immediate `403 PARAMETER_FORGERY`, permanent ban, `0` upstream hits.
 * 4. Hell Path: Pre-PoNR Failure vs. Post-PoNR Sunk Cost:
 *    - Pre-PoNR upstream `HTTP 500` and pre-header socket sever (`502`) release Anlas + V5 NCP holds
 *      with `0` debit and `0` `dispatchesHigh` increment.
 *    - Post-PoNR mid-stream socket sever *after* `HTTP 200 OK` headers preserves BOTH Anlas and
 *      V5 NCP SQLite debits as sunk costs while freeing holds and queue slots cleanly.
 * 5. Hell Path: Spend Cap, Debt Lockout, Forged Bypass, Deadband, Effort Escalation & Cross-Channel Races:
 *    - `C_auth > X-Declared-Anlas` (`60 > 10`) -> `400 SPEND_CAP_EXCEEDED`, `0` upstream hits, `0` debit.
 *    - Stealth character ref (`X-Declared-Anlas: 0`) -> `400 SPEND_CAP_EXCEEDED`, `0` upstream hits.
 *    - Forged `X-Base-Paid: true` on `1024x1024, 23 steps, 1 sample` (even at `<= 5.5%` battery)
 *      -> `400 PARAMETRIC_LIMIT_EXCEEDED`, `0` upstream hits.
 *    - Omitting `X-Gen-*` headers to sneak `nai-diffusion-5-full` `25` steps (deadband) or `>1MP`
 *      past Stage 1 is caught at Stage 6 (`400 PARAMETRIC_LIMIT_EXCEEDED`), `0` upstream hits.
 *    - Effort escalation (`Medium 10 NCP` at `/queue/join` -> `High 18 NCP` at `/proxy`) upgrades or
 *      rejects (`429 V5_CAPACITY_DEPLETED`) when only `10` NCP remain.
 *    - Negative Anlas debt (`-20`): free V5/Opus succeeds (`200`), any Anlas-consuming request fails `403 DEBT_LOCKED`.
 *    - Cross-channel race between `/proxy/image/*` (`60` Anlas) and `/ai/encode-vibe` (`2` Anlas) on
 *      a `60`-Anlas balance admits strictly 1 and rejects 1 (`403 INSUFFICIENT_ANLAS`), never overdrafting.
 *    - Stage 9 commit-boundary TOCTOU race (including hostile post-200 client socket abort mid-`commitAnlasDebit`)
 *      serializes via `withUserAnlasAuthLock`, rejecting concurrent `/ai/encode-vibe` with `403 INSUFFICIENT_ANLAS`
 *      (`virtual_anlas_balance === 0`, never `-2`).
 *    - Bucket 1 personal NCP commit-boundary race (multi-device `/queue/join` replacing a task mid-`commitAnlasDebit`
 *      before `commitV5Debit` runs) is rejected at Stage 7 (`429 V5_CAPACITY_DEPLETED`) with `v5_banked_balance === 0`.
 * 6. Hell Path: Operational Canary Drift Logging:
 *    - `X-Scraped-Anlas: 999` differing from `C_auth = 60` emits `[GuildWeave Telemetry Canary]`
 *      warning and completes `200 OK` with `60` Anlas debited (zero ban, zero rejection).
 * 7. Hell Path: Master Solvency, Inactive Subscription, Stage 1 Malformed Headers & Bodies:
 *    - `masterAnlas < C_auth` (`5 < 60`) -> `503 MASTER_ANLAS_DEPLETED`, `0` upstream hits.
 *    - `subscriptionActive === false` -> `503 MASTER_SUBSCRIPTION_INACTIVE`, `0` upstream hits.
 *    - Malformed `X-Declared-Anlas` / `X-Base-Paid` / `X-Gen-Model` / `X-Gen-Width` -> `400 INVALID_HEADERS`
 *      at Stage 1 without banning user or buffering payload.
 *    - Malformed/unparseable image body -> `400 MALFORMED_PAYLOAD`, `0` upstream hits.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit8.db');
const TEST_PORT = 18000;
const MOCK_UPSTREAM_PORT = 18001;

process.env.ADMIN_SECRET_KEY = 'commit8_admin_secret_key';
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

let upstreamSubscriptionPayload = {
  tier: 3,
  active: true,
  expiresAt: DEFAULT_SUB_EXPIRES,
  trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
  isGracePeriod: false,
  usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
};

let imageUpstreamMode = 'ok'; // 'ok' | 'delay_ok' | '500' | 'pre_sever' | 'post_sever' | 'chunked_hold'
let imageUpstreamDelayMs = 0;
let imageUpstreamHits = 0;
let vibeUpstreamHits = 0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/user/subscription') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(upstreamSubscriptionPayload));
  }

  req.on('data', () => {});
  req.on('end', () => {
    if (parsedUrl.pathname === '/ai/encode-vibe') {
      vibeUpstreamHits += 1;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from('VIBE_OK'));
      }, 120);
      return;
    }

    imageUpstreamHits += 1;

    if (imageUpstreamMode === 'pre_sever') {
      res.socket.write('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n');
      res.socket.destroy();
      return;
    }

    if (imageUpstreamMode === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upstream generation failed' }));
    }

    if (imageUpstreamMode === 'post_sever') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.from('PARTIAL_IMAGE_BYTES_'));
      setTimeout(() => {
        try { res.socket.destroy(); } catch (_) {}
      }, 40);
      return;
    }

    if (imageUpstreamMode === 'chunked_hold') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.from('CHUNK_1_'));
      setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.end(Buffer.from('CHUNK_2'));
        }
      }, 120);
      return;
    }

    const sendOk = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    if (imageUpstreamMode === 'delay_ok' && imageUpstreamDelayMs > 0) {
      setTimeout(sendOk, imageUpstreamDelayMs);
    } else {
      sendOk();
    }
  });
});

function sendRawRequest({ method = 'POST', path: reqPath, headers = {}, body = undefined }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: reqPath,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let parsed = text;
        try {
          if ((res.headers['content-type'] || '').includes('application/json')) {
            parsed = JSON.parse(text);
          }
        } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, data: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

test('Phase 8 Commit 8: Pre-Upstream Validation, Anti-Spoofing & PoNR Settlement', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  const now = Date.now();
  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit8_master_token')");

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch, anlas_consumed)
     VALUES ('u_paid', 'Normal', 0, 500, ?, 100, ?, 0)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned, anlas_consumed) VALUES ('dev_paid', 'u_paid', 'sec_paid', 'Normal', 1, 0, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_race60', 'Normal', 0, 60, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_race60', 'u_race60', 'sec_race60', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_commit_race60', 'Normal', 0, 60, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_commit_race60', 'u_commit_race60', 'sec_commit_race60', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_abort_race60', 'Normal', 0, 60, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_abort_race60', 'u_abort_race60', 'sec_abort_race60', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_ncp_race18', 'Normal', 0, 50, ?, 18, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_ncp_race_1', 'u_ncp_race18', 'sec_ncp_r1', 'Normal', 1, 0)"
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_ncp_race_2', 'u_ncp_race18', 'sec_ncp_r2', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_debt8', 'Normal', 0, -20, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_debt8', 'u_debt8', 'sec_debt8', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_forger', 'Normal', 0, 500, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, discord_id, priority_tier, approved, banned) VALUES ('dev_forger', 'u_forger', 'sec_forger', 'u_forger', 'Normal', 1, 0)"
  );

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
  await dbModule.run('UPDATE users SET last_anlas_reset_epoch = ?', [bootSnap.activeCycleEpoch]);

  t.after(async () => {
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await new Promise(r => mockUpstream.close(r));
    await dbModule.closeDatabase();
    cleanupFiles();
  });

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: BASE-PAID ANLAS PoNR SETTLEMENT & V5 BATTERY IMMUNITY
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Base-paid V5 High & Medium commit exact PoNR Anlas, re-anchor TTL, and spare V5 battery', async () => {
    queueManager.reset();
    imageUpstreamHits = 0;
    imageUpstreamMode = 'delay_ok';
    imageUpstreamDelayMs = 120;

    // Drive V5 battery down to 5.5% circuit breaker to prove verified X-Base-Paid bypasses breaker
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 5.5, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // 1. V5 High 1536x2048 (C_auth = 60 Anlas)
    const joinRes = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_paid_high_1',
        model: 'nai-diffusion-5-full',
        width: 1536,
        height: 2048,
        n_samples: 1,
        steps: 28,
        is_base_paid: true,
        declared_anlas: 60
      })
    });
    assert.strictEqual(joinRes.status, 200);
    const task1 = queueManager.getProcessingTask('req_paid_high_1', 'dev_paid');
    const initialStartedAt = task1.started_processing_at;

    await new Promise(r => setTimeout(r, 40));

    const proxyPromise1 = sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_paid_high_1',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '60',
        'X-Scraped-Anlas': '60',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      })
    });

    // Mid-flight inspection while upstream holds 120ms: verify held_cost = 60 and started_processing_at re-anchored
    await new Promise(r => setTimeout(r, 45));
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_paid'), 60, 'Mid-flight Channel A hold must equal C_auth (60)');
    assert.ok(task1.started_processing_at > initialStartedAt, 'started_processing_at must re-anchor post-buffer');

    const res1 = await proxyPromise1;
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_paid'), 0, 'Hold must clear post-PoNR');

    let userRow = await dbModule.get('SELECT virtual_anlas_balance, subscription_period_anlas, anlas_consumed, v5_banked_balance, v5_daily_consumed, subscription_period_v5 FROM users WHERE user_id = ?', ['u_paid']);
    let devRow = await dbModule.get('SELECT virtual_anlas_balance, anlas_consumed FROM devices WHERE browser_id = ?', ['dev_paid']);
    assert.strictEqual(userRow.virtual_anlas_balance, 440);
    assert.strictEqual(userRow.subscription_period_anlas, 60);
    assert.strictEqual(userRow.anlas_consumed, 60);
    assert.strictEqual(devRow.virtual_anlas_balance, 440);
    assert.strictEqual(devRow.anlas_consumed, 60);
    assert.strictEqual(userRow.v5_banked_balance, 100, 'Base-paid V5 High must NOT deduct V5 banked NCP');
    assert.strictEqual(userRow.v5_daily_consumed, 0);
    assert.strictEqual(userRow.subscription_period_v5, 0);
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesHigh, 0, 'Base-paid V5 High must NOT increment battery dispatch counter');

    // 2. V5 Medium Anlas-paid: 1536x2048, 1 sample -> 34 Anlas; 1024x1024, 2 samples -> 12 Anlas
    imageUpstreamMode = 'ok';
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_paid_med_res', user_id: 'u_paid', priority_tier: 'Normal' });
    const resMedHighRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_paid_med_res',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '14',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5-medium',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '34',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full-medium',
        parameters: { width: 1536, height: 2048, steps: 14, n_samples: 1 }
      })
    });
    assert.strictEqual(resMedHighRes.status, 200);

    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_paid_med_2samp', user_id: 'u_paid', priority_tier: 'Normal' });
    const resMed2Samp = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_paid_med_2samp',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '14',
        'X-Gen-Samples': '2',
        'X-Gen-Model': 'V5-medium',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '12',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full-medium',
        parameters: { width: 1024, height: 1024, steps: 14, n_samples: 2 }
      })
    });
    assert.strictEqual(resMed2Samp.status, 200);

    userRow = await dbModule.get('SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(userRow.virtual_anlas_balance, 440 - 34 - 12, 'V5 Medium PoNR must bill 34 + 12 = 46 Anlas');
    assert.strictEqual(userRow.v5_banked_balance, 100, 'Base-paid V5 Medium must NOT deduct V5 banked NCP');
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesMedium, 0);
    assert.strictEqual(imageUpstreamHits, 3);
  });

  // ---------------------------------------------------------------------------
  // 2. HAPPY PATH: V5 BUCKET 1 / BUCKET 2 PoNR & ORTHOGONAL ADDON ACCOUNTING
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Commits V5 Bucket 1, Bucket 2 surplus persistence & orthogonal addon Anlas without double-counting', async () => {
    queueManager.reset();
    imageUpstreamMode = 'ok';

    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // 1. Baseline free V5 High + 1 character reference (addon = 5 Anlas) -> must charge BOTH 5 Anlas AND 18 personal NCP
    const balBeforeAddon = (await dbModule.get('SELECT virtual_anlas_balance, anlas_consumed FROM users WHERE user_id = ?', ['u_paid']));
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_v5_addon_1',
        model: 'nai-diffusion-5-full',
        width: 1024,
        height: 1024,
        n_samples: 1,
        steps: 23,
        is_base_paid: false,
        declared_anlas: 5
      })
    });
    const addonRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_v5_addon_1',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Precise-Refs': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'false',
        'X-Declared-Anlas': '5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, reference_image_multiple: ['ref1'] }
      })
    });
    assert.strictEqual(addonRes.status, 200);
    await new Promise(r => setTimeout(r, 30));

    let userAfterAddon = await dbModule.get('SELECT virtual_anlas_balance, anlas_consumed, v5_banked_balance, v5_daily_consumed, subscription_period_v5 FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(userAfterAddon.virtual_anlas_balance, balBeforeAddon.virtual_anlas_balance - 5);
    assert.strictEqual(userAfterAddon.anlas_consumed, balBeforeAddon.anlas_consumed + 5, 'Must commit 5 Anlas exactly once (zero runBackgroundAudit double-count)');
    assert.strictEqual(userAfterAddon.v5_banked_balance, 82, 'Addon Anlas must NOT exempt V5 personal NCP debit (100 - 18 = 82)');
    assert.strictEqual(userAfterAddon.v5_daily_consumed, 1);
    assert.strictEqual(userAfterAddon.subscription_period_v5, 1);
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesHigh, 1);

    // 2. Bucket 2 Surplus PoNR deduction & SQLite persistence
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_paid'", [Date.now()]);
    queueManager.hydrateSurplusPool('100', String(Date.now()));

    const joinSurplus = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_v5_surplus_1',
        model: 'nai-diffusion-5-full-medium',
        width: 1024,
        height: 1024,
        n_samples: 1,
        steps: 14,
        is_base_paid: false
      })
    });
    assert.strictEqual(joinSurplus.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_paid', 'surplus'), 10);

    const surplusRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_v5_surplus_1',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '14',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5-medium',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full-medium',
        parameters: { width: 1024, height: 1024, steps: 14, n_samples: 1 }
      })
    });
    assert.strictEqual(surplusRes.status, 200);
    assert.strictEqual(queueManager.getSurplusPool().pool, 90, 'Surplus RAM pool must deduct 10 NCP');
    const dbSurplusRow = await dbModule.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");
    assert.strictEqual(dbSurplusRow.value, '90', 'Surplus deduction must persist to SQLite config');

    const userAfterSurplus = await dbModule.get('SELECT v5_banked_balance, v5_daily_consumed, subscription_period_v5 FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(userAfterSurplus.v5_banked_balance, 0);
    assert.strictEqual(userAfterSurplus.v5_daily_consumed, 2);
    assert.strictEqual(userAfterSurplus.subscription_period_v5, 2);
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesMedium, 1);

    // Restore u_paid bank for subsequent tests
    await dbModule.run("UPDATE users SET v5_banked_balance = 100 WHERE user_id = 'u_paid'");
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: PARAMETER FORGERY BAN & ACTIVE EVICTION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Header/body parameter forgery triggers immediate 403, permanent SQLite ban & queue eviction', async () => {
    queueManager.reset();
    imageUpstreamMode = 'ok';
    const hitsBefore = imageUpstreamHits;

    // Give u_forger an active Channel B lock too, to confirm cross-channel eviction on ban
    assert.strictEqual(queueManager.acquireTextSlot('forger_text_lock', 'u_forger', 0), true);

    // Subtest A: Claim X-Gen-Width: 1024 in header while embedding 2048 in body
    queueManager.join({ browser_id: 'dev_forger', req_id: 'req_forge_width', user_id: 'u_forger', discord_id: 'u_forger', priority_tier: 'Normal' });
    const forgeWidthRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_forger',
        'X-Browser-Id': 'dev_forger',
        'X-Request-Id': 'req_forge_width',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-4-5-full',
        parameters: { width: 2048, height: 1024, steps: 28, n_samples: 1 }
      })
    });

    assert.strictEqual(forgeWidthRes.status, 403);
    assert.strictEqual(forgeWidthRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore, 'Forged payload must NEVER touch upstream');
    assert.strictEqual(queueManager.getQueueLength(), 0, 'Banned user Channel A task must be evicted');
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0, 'Banned user Channel B lock must be evicted');

    const bannedUser = await dbModule.get('SELECT banned, ban_reason, ban_notified FROM users WHERE user_id = ?', ['u_forger']);
    const bannedDev = await dbModule.get('SELECT banned FROM devices WHERE browser_id = ?', ['dev_forger']);
    const bannedDisc = await dbModule.get('SELECT is_notified FROM banned_discords WHERE discord_id = ?', ['u_forger']);
    assert.strictEqual(bannedUser.banned, 1);
    assert.strictEqual(bannedUser.ban_notified, 0);
    assert.match(bannedUser.ban_reason, /x-gen-width/i);
    assert.strictEqual(bannedDev.banned, 1);
    assert.strictEqual(bannedDisc.is_notified, 0);

    // Subtest B: Claim X-Gen-Model: V5-medium while embedding nai-diffusion-5-full (High)
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_forger_med', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_forger_med', 'u_forger_med', 'sec_fmed', 'Normal', 1, 0)");
    queueManager.join({ browser_id: 'dev_forger_med', req_id: 'req_forge_med', user_id: 'u_forger_med', priority_tier: 'Normal' });

    const forgeMedRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_fmed',
        'X-Browser-Id': 'dev_forger_med',
        'X-Request-Id': 'req_forge_med',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '25',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5-medium',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 25, n_samples: 1 }
      })
    });
    assert.strictEqual(forgeMedRes.status, 403);
    assert.strictEqual(forgeMedRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_forger_med'")).banned, 1);

    // Subtest C: Claim X-Gen-Model: V5-medium while embedding legacy model (nai-diffusion-4-5-full, 50 steps)
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_forger_med_leg', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_forger_med_leg', 'u_forger_med_leg', 'sec_fmedleg', 'Normal', 1, 0)");
    queueManager.join({ browser_id: 'dev_forger_med_leg', req_id: 'req_forge_med_leg', user_id: 'u_forger_med_leg', priority_tier: 'Normal' });

    const forgeMedLegRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_fmedleg',
        'X-Browser-Id': 'dev_forger_med_leg',
        'X-Request-Id': 'req_forge_med_leg',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '50',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5-medium',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-4-5-full',
        parameters: { width: 1024, height: 1024, steps: 50, n_samples: 1 }
      })
    });
    assert.strictEqual(forgeMedLegRes.status, 403);
    assert.strictEqual(forgeMedLegRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_forger_med_leg'")).banned, 1);

    // Subtest D: Claim X-Gen-Model: V5 while embedding legacy model (nai-diffusion-4-5-full, 50 steps)
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_forger_v5_leg', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_forger_v5_leg', 'u_forger_v5_leg', 'sec_fv5leg', 'Normal', 1, 0)");
    queueManager.join({ browser_id: 'dev_forger_v5_leg', req_id: 'req_forge_v5_leg', user_id: 'u_forger_v5_leg', priority_tier: 'Normal' });

    const forgeV5LegRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_fv5leg',
        'X-Browser-Id': 'dev_forger_v5_leg',
        'X-Request-Id': 'req_forge_v5_leg',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '50',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-4-5-full',
        parameters: { width: 1024, height: 1024, steps: 50, n_samples: 1 }
      })
    });
    assert.strictEqual(forgeV5LegRes.status, 403);
    assert.strictEqual(forgeV5LegRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_forger_v5_leg'")).banned, 1);

    // Subtest E: Claim X-Gen-Model: V5 while omitting model field from body (null-model V5 deadband/NCP bypass)
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_forger_v5_null', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_forger_v5_null', 'u_forger_v5_null', 'sec_fv5null', 'Normal', 1, 0)");
    queueManager.join({ browser_id: 'dev_forger_v5_null', req_id: 'req_forge_v5_null', user_id: 'u_forger_v5_null', priority_tier: 'Normal' });

    const forgeV5NullRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_fv5null',
        'X-Browser-Id': 'dev_forger_v5_null',
        'X-Request-Id': 'req_forge_v5_null',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '25',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parameters: { width: 1024, height: 1024, steps: 25, n_samples: 1 }
      })
    });
    assert.strictEqual(forgeV5NullRes.status, 403);
    assert.strictEqual(forgeV5NullRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_forger_v5_null'")).banned, 1);

    // Subtest F: Multipart binary image preceding name="request" claiming X-Gen-Model: legacy for V5 body
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_forger_mp', 'Normal', 0)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_forger_mp', 'u_forger_mp', 'sec_fmp', 'Normal', 1, 0)");
    queueManager.join({ browser_id: 'dev_forger_mp', req_id: 'req_forge_mp', user_id: 'u_forger_mp', priority_tier: 'Normal' });

    const boundary = 'forge_multipart_boundary';
    const mpBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="img.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.alloc(4096, 0xAB),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const forgeMpRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_fmp',
        'X-Browser-Id': 'dev_forger_mp',
        'X-Request-Id': 'req_forge_mp',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: mpBody
    });
    assert.strictEqual(forgeMpRes.status, 403);
    assert.strictEqual(forgeMpRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(imageUpstreamHits, hitsBefore);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_forger_mp'")).banned, 1);
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: PRE-PoNR FAILURE VS. POST-PoNR SUNK COST
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Pre-PoNR failures charge 0 Anlas/NCP; Post-PoNR mid-stream drop commits sunk costs', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const startUser = await dbModule.get('SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?', ['u_paid']);
    const startDispatchesHigh = serverModule.getTelemetrySnapshot().dispatchesHigh;

    // 1. Pre-PoNR upstream HTTP 500 on Anlas + V5 High request (1 ref = 5 Anlas, 18 NCP)
    imageUpstreamMode = '500';
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_ponr_500',
        model: 'nai-diffusion-5-full',
        width: 1024,
        height: 1024,
        n_samples: 1,
        steps: 23,
        is_base_paid: false,
        declared_anlas: 5
      })
    });
    const res500 = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_ponr_500',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Precise-Refs': '1',
        'X-Gen-Model': 'V5',
        'X-Declared-Anlas': '5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, reference_image_multiple: ['ref1'] }
      })
    });
    assert.strictEqual(res500.status, 500);
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_paid'), 0);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_paid'), 0);
    let midUser = await dbModule.get('SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(midUser.virtual_anlas_balance, startUser.virtual_anlas_balance);
    assert.strictEqual(midUser.v5_banked_balance, startUser.v5_banked_balance);
    assert.strictEqual(serverModule.getTelemetrySnapshot().dispatchesHigh, startDispatchesHigh);

    // 2. Pre-PoNR upstream socket sever before headers finish -> 502, 0 Anlas, 0 NCP
    imageUpstreamMode = 'pre_sever';
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_ponr_pre_sever', user_id: 'u_paid', priority_tier: 'Normal' });
    const resPreSever = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_ponr_pre_sever',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '60',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      })
    });
    assert.strictEqual(resPreSever.status, 502);
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_paid'), 0);
    midUser = await dbModule.get('SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(midUser.virtual_anlas_balance, startUser.virtual_anlas_balance);

    // 3. Post-PoNR mid-stream socket drop *after* HTTP 200 OK headers -> sunk cost committed
    imageUpstreamMode = 'post_sever';
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_ponr_post_sever',
        model: 'nai-diffusion-5-full',
        width: 1024,
        height: 1024,
        n_samples: 1,
        steps: 23,
        is_base_paid: false,
        declared_anlas: 5
      })
    });

    await assert.rejects(
      () => sendRawRequest({
        path: '/proxy/image/ai/generate-image',
        headers: {
          'Authorization': 'Bearer sec_paid',
          'X-Browser-Id': 'dev_paid',
          'X-Request-Id': 'req_ponr_post_sever',
          'X-Gen-Width': '1024',
          'X-Gen-Height': '1024',
          'X-Gen-Steps': '23',
          'X-Gen-Samples': '1',
          'X-Precise-Refs': '1',
          'X-Gen-Model': 'V5',
          'X-Declared-Anlas': '5',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, reference_image_multiple: ['ref1'] }
        })
      }),
      /.+/
    );

    await new Promise(r => setTimeout(r, 40));
    const afterPostSever = await dbModule.get('SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?', ['u_paid']);
    assert.strictEqual(afterPostSever.virtual_anlas_balance, startUser.virtual_anlas_balance - 5, 'Post-PoNR Anlas debit must stand as sunk cost');
    assert.strictEqual(afterPostSever.v5_banked_balance, startUser.v5_banked_balance - 18, 'Post-PoNR V5 NCP debit must stand as sunk cost');
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_paid'), 0);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_paid'), 0);
    assert.strictEqual(queueManager.getQueueLength(), 0);
    imageUpstreamMode = 'ok';
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: SPEND CAP, DEBT LOCKOUT, DEADBAND, EFFORT ESCALATION & CROSS-CHANNEL RACES
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces spend cap, debt lockout, deadband, effort escalation & cross-channel double-spend locks', async () => {
    queueManager.reset();
    imageUpstreamMode = 'ok';
    const hitsBefore = imageUpstreamHits;

    // 1. C_auth > X-Declared-Anlas (60 > 10) -> 400 SPEND_CAP_EXCEEDED
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_cap_1', user_id: 'u_paid', priority_tier: 'Normal' });
    const capRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_cap_1',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '10',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      })
    });
    assert.strictEqual(capRes.status, 400);
    assert.strictEqual(capRes.data.error, 'SPEND_CAP_EXCEEDED');

    // 2. Stealth addon (1 ref = 5 Anlas) with X-Declared-Anlas: 0 -> 400 SPEND_CAP_EXCEEDED
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_stealth_ref', user_id: 'u_paid', priority_tier: 'Normal' });
    const stealthRefRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_stealth_ref',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Precise-Refs': '1',
        'X-Gen-Model': 'V5',
        'X-Declared-Anlas': '0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, reference_image_multiple: ['ref1'] }
      })
    });
    assert.strictEqual(stealthRefRes.status, 400);
    assert.strictEqual(stealthRefRes.data.error, 'SPEND_CAP_EXCEEDED');

    // 3. Omitting X-Gen-* headers to sneak V5 High deadband (25 steps) or >1MP past Stage 1 -> caught at Stage 6
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_omit_deadband', user_id: 'u_paid', priority_tier: 'Normal' });
    const omitDeadbandRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_omit_deadband',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 25, n_samples: 1 }
      })
    });
    assert.strictEqual(omitDeadbandRes.status, 400);
    assert.strictEqual(omitDeadbandRes.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');
    assert.strictEqual(imageUpstreamHits, hitsBefore);

    // 4. Effort escalation (/queue/join claims Medium 10 NCP, /proxy sends High 18 NCP) when only 10 NCP available -> 429 V5_CAPACITY_DEPLETED
    await dbModule.run("UPDATE users SET v5_banked_balance = 10, v5_last_accrual_epoch = ? WHERE user_id = 'u_paid'", [Date.now()]);
    queueManager.hydrateSurplusPool('0', String(Date.now()));
    const escJoin = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_paid', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser_id: 'dev_paid',
        req_id: 'req_esc_1',
        model: 'nai-diffusion-5-full-medium',
        width: 1024,
        height: 1024,
        n_samples: 1,
        steps: 14,
        is_base_paid: false
      })
    });
    assert.strictEqual(escJoin.status, 200);
    const escProxy = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_esc_1',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 }
      })
    });
    assert.strictEqual(escProxy.status, 429);
    assert.strictEqual(escProxy.data.error, 'V5_CAPACITY_DEPLETED');
    await dbModule.run("UPDATE users SET v5_banked_balance = 100 WHERE user_id = 'u_paid'");

    // 5. Debt Lockout: u_debt8 (-20) passes free V5 High (23 steps) but fails 403 DEBT_LOCKED on Anlas bypass
    queueManager.join({ browser_id: 'dev_debt8', req_id: 'req_debt_paid_proxy', user_id: 'u_debt8', priority_tier: 'Normal' });
    const debtPaidProxy = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_debt8',
        'X-Browser-Id': 'dev_debt8',
        'X-Request-Id': 'req_debt_paid_proxy',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '60',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      })
    });
    assert.strictEqual(debtPaidProxy.status, 403);
    assert.strictEqual(debtPaidProxy.data.error, 'DEBT_LOCKED');

    queueManager.join({ browser_id: 'dev_debt8', req_id: 'req_debt_free_proxy', user_id: 'u_debt8', priority_tier: 'Normal', held_ncp: 18, held_ncp_source: 'personal' });
    const debtFreeProxy = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_debt8',
        'X-Browser-Id': 'dev_debt8',
        'X-Request-Id': 'req_debt_free_proxy',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 }
      })
    });
    assert.strictEqual(debtFreeProxy.status, 200);

    // 6. Pre-dispatch cross-channel double-spend race on u_race60 (60 Anlas balance):
    //    Image request (60 Anlas) and vibe encode (2 Anlas) race simultaneously; balance must stay >= 0.
    imageUpstreamMode = 'delay_ok';
    imageUpstreamDelayMs = 120;
    queueManager.join({ browser_id: 'dev_race60', req_id: 'req_race_img60', user_id: 'u_race60', priority_tier: 'Normal' });

    const [raceImg, raceVibe] = await Promise.all([
      sendRawRequest({
        path: '/proxy/image/ai/generate-image',
        headers: {
          'Authorization': 'Bearer sec_race60',
          'X-Browser-Id': 'dev_race60',
          'X-Request-Id': 'req_race_img60',
          'X-Gen-Width': '1536',
          'X-Gen-Height': '2048',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'V5',
          'X-Base-Paid': 'true',
          'X-Declared-Anlas': '60',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      }),
      sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_race60',
          'X-Browser-Id': 'dev_race60',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'race_vibe_img' })
      })
    ]);

    const raceStatuses = [raceImg.status, raceVibe.status].sort((a, b) => a - b);
    assert.deepStrictEqual(raceStatuses, [200, 403], 'Concurrent 60-Anlas image + 2-Anlas vibe race must admit strictly 1 and reject 1 with 403');
    const race60After = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_race60']);
    assert.ok(race60After.virtual_anlas_balance >= 0, 'Cross-channel race must never overdraft virtual_anlas_balance below 0');

    // 7. Stage 9 PoNR commit-boundary TOCTOU race on u_commit_race60 (60 Anlas balance):
    //    Pause commitAnlasDebit for 80ms during image 200 OK settlement and fire /ai/encode-vibe
    //    mid-commit. held_cost MUST stay 60 until SQLite settles, rejecting vibe with 403.
    imageUpstreamMode = 'ok';
    const originalCommit = auditEngine.commitAnlasDebit;
    let commitStarted = false;
    auditEngine.commitAnlasDebit = async function(userId, amount, bId) {
      if (userId === 'u_commit_race60' && amount === 60 && !commitStarted) {
        commitStarted = true;
        await new Promise(r => setTimeout(r, 80));
      }
      return originalCommit.apply(this, arguments);
    };

    try {
      queueManager.join({ browser_id: 'dev_commit_race60', req_id: 'req_commit_race_img', user_id: 'u_commit_race60', priority_tier: 'Normal' });

      const imgCommitPromise = sendRawRequest({
        path: '/proxy/image/ai/generate-image',
        headers: {
          'Authorization': 'Bearer sec_commit_race60',
          'X-Browser-Id': 'dev_commit_race60',
          'X-Request-Id': 'req_commit_race_img',
          'X-Gen-Width': '1536',
          'X-Gen-Height': '2048',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'V5',
          'X-Base-Paid': 'true',
          'X-Declared-Anlas': '60',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      });

      while (!commitStarted) {
        await new Promise(r => setTimeout(r, 5));
      }

      const midCommitVibeRes = await sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_commit_race60',
          'X-Browser-Id': 'dev_commit_race60',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'mid_commit_vibe' })
      });

      const imgCommitRes = await imgCommitPromise;
      assert.strictEqual(imgCommitRes.status, 200);
      assert.strictEqual(midCommitVibeRes.status, 403, 'Concurrent /ai/encode-vibe during Stage 9 commit must be rejected 403');
      assert.strictEqual(midCommitVibeRes.data.error, 'INSUFFICIENT_ANLAS');

      const commitRaceAfter = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_commit_race60']);
      assert.strictEqual(commitRaceAfter.virtual_anlas_balance, 0, 'Stage 9 commit boundary must never allow negative overdraft');
    } finally {
      auditEngine.commitAnlasDebit = originalCommit;
    }

    // 8. Hostile post-200 client socket abort mid-commitAnlasDebit on u_abort_race60 (60 Anlas):
    //    Client drops socket while commitAnlasDebit is paused 80ms -> executeCleanup() removes task
    //    from queueManager.queue, yet withUserAnlasAuthLock must block concurrent /ai/encode-vibe
    //    until SQLite settles to 0, preventing a -2 overdraft.
    imageUpstreamMode = 'ok';
    const origCommitAbort = auditEngine.commitAnlasDebit;
    let abortCommitStarted = false;
    auditEngine.commitAnlasDebit = async function(userId, amount, bId) {
      if (userId === 'u_abort_race60' && amount === 60 && !abortCommitStarted) {
        abortCommitStarted = true;
        await new Promise(r => setTimeout(r, 80));
      }
      return origCommitAbort.apply(this, arguments);
    };

    try {
      queueManager.join({ browser_id: 'dev_abort_race60', req_id: 'req_abort_race_img', user_id: 'u_abort_race60', priority_tier: 'Normal' });

      const abortReq = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/proxy/image/ai/generate-image',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer sec_abort_race60',
          'X-Browser-Id': 'dev_abort_race60',
          'X-Request-Id': 'req_abort_race_img',
          'X-Gen-Width': '1536',
          'X-Gen-Height': '2048',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'V5',
          'X-Base-Paid': 'true',
          'X-Declared-Anlas': '60',
          'Content-Type': 'application/json'
        }
      });
      abortReq.on('error', () => {});
      abortReq.write(JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      }));
      abortReq.end();

      while (!abortCommitStarted) {
        await new Promise(r => setTimeout(r, 5));
      }

      // Immediately sever client TCP socket while commitAnlasDebit is still awaiting SQLite
      abortReq.destroy();
      await new Promise(r => setTimeout(r, 15));

      const postAbortVibeRes = await sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_abort_race60',
          'X-Browser-Id': 'dev_abort_race60',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'post_abort_vibe' })
      });

      assert.strictEqual(postAbortVibeRes.status, 403, 'Concurrent /ai/encode-vibe after post-200 client abort must be rejected 403');
      assert.strictEqual(postAbortVibeRes.data.error, 'INSUFFICIENT_ANLAS');

      const abortRaceAfter = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_abort_race60']);
      assert.strictEqual(abortRaceAfter.virtual_anlas_balance, 0, 'Post-200 client abort mid-commit must never allow negative overdraft');
    } finally {
      auditEngine.commitAnlasDebit = origCommitAbort;
    }

    // 9. Bucket 1 personal V5 NCP commit-boundary TOCTOU race on u_ncp_race18 (50 Anlas, 18 personal NCP):
    //    dev_ncp_race_1 settles 5 Anlas + 18 personal NCP and pauses inside commitAnlasDebit.
    //    dev_ncp_race_2 calls /queue/join (queues behind commitAnlasDebit, sees 18 NCP before commitV5Debit runs,
    //    evicts dev_ncp_race_1, and acquires held_ncp: 18 personal), then hits /proxy/image/*.
    //    Stage 7 MUST re-verify personal NCP via evaluateV5Accrual (behind commitV5Debit) and reject 429.
    queueManager.reset();
    queueManager.hydrateSurplusPool('0', String(Date.now()));
    imageUpstreamMode = 'ok';
    const origCommitNcpRace = auditEngine.commitAnlasDebit;
    let ncpRaceCommitStarted = false;
    auditEngine.commitAnlasDebit = async function(userId, amount, bId) {
      if (userId === 'u_ncp_race18' && amount === 5 && !ncpRaceCommitStarted) {
        ncpRaceCommitStarted = true;
        await new Promise(r => setTimeout(r, 80));
      }
      return origCommitNcpRace.apply(this, arguments);
    };

    try {
      const joinNcp1 = await sendRawRequest({
        path: '/queue/join',
        headers: { 'Authorization': 'Bearer sec_ncp_r1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          browser_id: 'dev_ncp_race_1',
          req_id: 'req_ncp_r1',
          model: 'nai-diffusion-5-full',
          width: 1024,
          height: 1024,
          n_samples: 1,
          steps: 23,
          is_base_paid: false,
          declared_anlas: 5
        })
      });
      assert.strictEqual(joinNcp1.status, 200);

      const proxyNcp1Promise = sendRawRequest({
        path: '/proxy/image/ai/generate-image',
        headers: {
          'Authorization': 'Bearer sec_ncp_r1',
          'X-Browser-Id': 'dev_ncp_race_1',
          'X-Request-Id': 'req_ncp_r1',
          'X-Gen-Width': '1024',
          'X-Gen-Height': '1024',
          'X-Gen-Steps': '23',
          'X-Gen-Samples': '1',
          'X-Precise-Refs': '1',
          'X-Gen-Model': 'V5',
          'X-Declared-Anlas': '5',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, reference_image_multiple: ['ref1'] }
        })
      });

      while (!ncpRaceCommitStarted) {
        await new Promise(r => setTimeout(r, 5));
      }

      // dev_ncp_race_2 joins while dev_ncp_race_1 is inside commitAnlasDebit (prior to commitV5Debit)
      const joinNcp2 = await sendRawRequest({
        path: '/queue/join',
        headers: { 'Authorization': 'Bearer sec_ncp_r2', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          browser_id: 'dev_ncp_race_2',
          req_id: 'req_ncp_r2',
          model: 'nai-diffusion-5-full',
          width: 1024,
          height: 1024,
          n_samples: 1,
          steps: 23,
          is_base_paid: false
        })
      });

      // If joinNcp2 evicts dev_ncp_race_1 prior to commitV5Debit completing, upstreamReq.destroy()
      // severs dev_ncp_race_1's response socket cleanly; PoNR debit still completes in background.
      const ncp1Outcome = await proxyNcp1Promise.catch(err => ({ status: 'evicted_reset', error: err.message }));
      assert.ok(
        ncp1Outcome.status === 200 || ncp1Outcome.status === 'evicted_reset',
        `Expected 200 or evicted socket reset for dev_ncp_race_1, got ${ncp1Outcome.status}`
      );

      if (joinNcp2.status === 200) {
        const proxyNcp2 = await sendRawRequest({
          path: '/proxy/image/ai/generate-image',
          headers: {
            'Authorization': 'Bearer sec_ncp_r2',
            'X-Browser-Id': 'dev_ncp_race_2',
            'X-Request-Id': 'req_ncp_r2',
            'X-Gen-Width': '1024',
            'X-Gen-Height': '1024',
            'X-Gen-Steps': '23',
            'X-Gen-Samples': '1',
            'X-Gen-Model': 'V5',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'nai-diffusion-5-full',
            parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 }
          })
        });
        assert.strictEqual(proxyNcp2.status, 429, 'Stage 7 must reject stale personal NCP pre-hold after commitV5Debit settles');
        assert.strictEqual(proxyNcp2.data.error, 'V5_CAPACITY_DEPLETED');
      } else {
        assert.strictEqual(joinNcp2.status, 429);
      }

      const ncpRaceUserAfter = await dbModule.get('SELECT v5_banked_balance, v5_daily_consumed FROM users WHERE user_id = ?', ['u_ncp_race18']);
      assert.strictEqual(ncpRaceUserAfter.v5_banked_balance, 0);
      assert.strictEqual(ncpRaceUserAfter.v5_daily_consumed, 1, 'Exactly 1 V5 generation may settle on 18 NCP balance');
    } finally {
      auditEngine.commitAnlasDebit = origCommitNcpRace;
    }
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: CANARY DRIFT LOGGING (NO BAN)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Canary drift between C_auth and X-Scraped-Anlas logs warning without banning user', async () => {
    queueManager.reset();
    imageUpstreamMode = 'ok';
    let capturedWarnings = '';
    const originalWarn = console.warn;
    console.warn = (...args) => {
      capturedWarnings += args.join(' ') + '\n';
      originalWarn.apply(console, args);
    };

    try {
      const beforeBal = (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_paid'])).virtual_anlas_balance;
      queueManager.join({ browser_id: 'dev_paid', req_id: 'req_canary_drift', user_id: 'u_paid', priority_tier: 'Normal' });

      const driftRes = await sendRawRequest({
        path: '/proxy/image/ai/generate-image',
        headers: {
          'Authorization': 'Bearer sec_paid',
          'X-Browser-Id': 'dev_paid',
          'X-Request-Id': 'req_canary_drift',
          'X-Gen-Width': '1536',
          'X-Gen-Height': '2048',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'V5',
          'X-Base-Paid': 'true',
          'X-Declared-Anlas': '60',
          'X-Scraped-Anlas': '999',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      });

      assert.strictEqual(driftRes.status, 200);
      assert.match(capturedWarnings, /\[GuildWeave Telemetry Canary\] Formula drift detected: Upstream UI reported 999, server calculated 60/);

      const afterRow = await dbModule.get('SELECT virtual_anlas_balance, banned FROM users WHERE user_id = ?', ['u_paid']);
      assert.strictEqual(afterRow.banned, 0, 'Canary drift must NEVER ban user');
      assert.strictEqual(afterRow.virtual_anlas_balance, beforeBal - 60, 'Server authoritative C_auth (60) must be billed');
    } finally {
      console.warn = originalWarn;
    }
  });

  // ---------------------------------------------------------------------------
  // 7. HELL PATH: MASTER SOLVENCY, INACTIVE SUBSCRIPTION, MALFORMED HEADERS & PAYLOADS
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces master Anlas solvency, inactive subscription, malformed headers & malformed bodies', async () => {
    queueManager.reset();
    const hitsBefore = imageUpstreamHits;

    // 1. Master Anlas Depleted (5 < 60) -> 503 MASTER_ANLAS_DEPLETED
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 5, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_master_low', user_id: 'u_paid', priority_tier: 'Normal' });
    const masterLowRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_master_low',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'X-Base-Paid': 'true',
        'X-Declared-Anlas': '60',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-5-full',
        parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
      })
    });
    assert.strictEqual(masterLowRes.status, 503);
    assert.strictEqual(masterLowRes.data.error, 'MASTER_ANLAS_DEPLETED');

    // 2. Inactive subscription -> 503 MASTER_SUBSCRIPTION_INACTIVE
    serverModule.applyUsageTelemetry({
      tier: 0,
      active: false,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_sub_inactive', user_id: 'u_paid', priority_tier: 'Normal' });
    const subInactiveRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_sub_inactive',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nai-diffusion-4-5-full',
        parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 }
      })
    });
    assert.strictEqual(subInactiveRes.status, 503);
    assert.strictEqual(subInactiveRes.data.error, 'MASTER_SUBSCRIPTION_INACTIVE');

    // Restore healthy telemetry
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // 3. Malformed X-Declared-Anlas / X-Gen-Width -> 400 INVALID_HEADERS at Stage 1 (zero ban, zero buffer)
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_bad_hdr', user_id: 'u_paid', priority_tier: 'Normal' });
    const badHdrRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_bad_hdr',
        'X-Gen-Model': 'V5',
        'X-Declared-Anlas': '-50',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })
    });
    assert.strictEqual(badHdrRes.status, 400);
    assert.strictEqual(badHdrRes.data.error, 'INVALID_HEADERS');

    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_bad_width_hdr', user_id: 'u_paid', priority_tier: 'Normal' });
    const badWidthHdrRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_bad_width_hdr',
        'X-Gen-Model': 'V5',
        'X-Gen-Width': 'NaN',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })
    });
    assert.strictEqual(badWidthHdrRes.status, 400);
    assert.strictEqual(badWidthHdrRes.data.error, 'INVALID_HEADERS');
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_paid'")).banned, 0, 'Malformed routing header must fail 400 at Stage 1 without banning user');

    // 4. Malformed unparseable JSON body -> 400 MALFORMED_PAYLOAD
    queueManager.join({ browser_id: 'dev_paid', req_id: 'req_bad_body', user_id: 'u_paid', priority_tier: 'Normal' });
    const badBodyRes = await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_paid',
        'X-Browser-Id': 'dev_paid',
        'X-Request-Id': 'req_bad_body',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      },
      body: 'not_valid_json_payload'
    });
    assert.strictEqual(badBodyRes.status, 400);
    assert.strictEqual(badBodyRes.data.error, 'MALFORMED_PAYLOAD');

    assert.strictEqual(imageUpstreamHits, hitsBefore, 'None of the invalid/blocked requests may reach upstream');
    assert.strictEqual(queueManager.getQueueLength(), 0);
  });
});