/**
 * PHASE 8 COMMIT 6 VERIFICATION HARNESS (test/phase8_commit6_queue_gating.test.js)
 *
 * Exhaustively tests:
 * 1. Happy Path: Model-Aware NCP Reservation Holds & Legacy Compatibility:
 *    - V5 High (`nai-diffusion-5-full`, steps=23) accrues personal NCP and places 18 NCP personal hold.
 *    - V5 Medium (`nai-diffusion-5-full-medium`, steps=14) places 10 NCP personal hold.
 *    - Legacy `/queue/join` omitting `model` and `steps` succeeds with 0 NCP hold.
 *    - Bucket 2 Surplus Fallback: Personal bank < ReqNCP falls back to Bucket 2 (`surplus`) hold
 *      for surplus-eligible tiers.
 *    - Forwards dynamic `req.telemetry.nominalDailyCompute` (derived from `timeUntilNextPercent`)
 *      into `evaluateV5Accrual` instead of falling back to 190.0.
 *    - `is_base_paid: true` bypasses V5 battery circuit breaker and V5 NCP depletion when solvent.
 * 2. Hell Path: Deadband Exploitation & Cross-Model Un-Bypassed Parametric Rejection:
 *    - Free V5 High (`nai-diffusion-5-full`) with steps 24, 25, 28, or 29 rejected with
 *      `HTTP 400 PARAMETRIC_LIMIT_EXCEEDED` and zero queue insertion.
 *    - Forged `is_base_paid: true` on explicitly free parameters (`1024x1024, 1 sample, <=28 steps`
 *      or omitted `steps` on High, or `1024x1024, 1 sample, 50 steps` on Medium) rejected with `HTTP 400`.
 *    - `nai-diffusion-5-full-medium` at steps 24, 25, 28, and 50 bypasses deadband and succeeds
 *      with 10 NCP hold.
 *    - Non-V5 / V4.5 (`nai-diffusion-4-5-full`) free-base requests at 24..28 steps (with or without
 *      `declared_anlas > 0` addons) succeed with 0 NCP hold; un-bypassed (`is_base_paid: false`)
 *      requests exceeding `1MP`, `1 sample`, or `28 steps` on V4.5 or omitted-model payloads are
 *      rejected upfront with `HTTP 400 PARAMETRIC_LIMIT_EXCEEDED` without entering or disturbing
 *      the queue; V4.5 requests WITH `is_base_paid: true` pass cleanly.
 * 3. Hell Path: Queue Depletion Starvation, Concurrent Surplus Race & Tab Refresh:
 *    - Insufficient personal + surplus NCP rejects immediately with `HTTP 429 V5_CAPACITY_DEPLETED`
 *      without entering the queue or disturbing active tasks.
 *    - User with 10 personal NCP is rejected for V5 High (18 NCP) but succeeds for V5 Medium (10 NCP).
 *    - `Metered` tier (`v5SurplusEligible: false`) is rejected with `429 V5_CAPACITY_DEPLETED` even when
 *      Bucket 2 surplus pool holds 4000 NCP.
 *    - Cross-user Bucket 2 surplus contention (sequential AND concurrent `Promise.all` race across
 *      `evaluateV5Accrual` suspension): only 1 user claims an 18 NCP pool, the other receives `429`.
 *    - Tab-refresh self-replacement: User holding 18 personal (or surplus) NCP replaces own task
 *      without self-deadlocking (`held_ncp` stays 18, not 36).
 * 4. Hell Path: Circuit Breaker Lockdown (`503 V5_BATTERY_CRITICAL`) & Cold-Boot Fail-Closed:
 *    - Projected battery <= 5.5% (and negative battery) rejects non-base-paid V5 High and V5 Medium
 *      with `503 V5_BATTERY_CRITICAL` and zero queue insertion.
 *    - Legacy models (`nai-diffusion-4-5-full`) enter the queue untouched during V5 circuit breaker lockdown.
 *    - Uninitialized telemetry (`lastFetched === 0`) combined with upstream 500 or missing `master_token`
 *      fails closed with `503` on both free V5 and `is_base_paid: true` requests.
 * 5. Hell Path: Lazy Anlas Reset, Debt Lockout (`403 DEBT_LOCKED`) & Cross-Channel Hold Rejection:
 *    - Approved user with `NULL` or expired (>30 days) `last_anlas_reset_epoch` lazily receives tier
 *      monthly Anlas (offsetting prior debt) before `authorizeAnlasSpend` at `/queue/join`.
 *    - Account in active Anlas debt attempting `is_base_paid: true` rejected with `403 DEBT_LOCKED` at queue join.
 *    - Account in active Anlas debt retains access to free V5 (`steps: 23`, sufficient NCP) and legacy requests.
 *    - Account with 3 Anlas virtual balance and 2 Anlas held on Channel B (`acquireTextSlot`) is rejected
 *      for `is_base_paid: true` (`403 INSUFFICIENT_ANLAS`) at queue join.
 * 6. Hell Path: Billing-Cycle Amendment Integration (`queueRouter.js`):
 *    - Grace period (`isGracePeriod: true`) freezes Anlas resets at `/queue/join` even when
 *      `last_anlas_reset_epoch` is `NULL` or >30 days old (preserving `-100` debt -> `403 DEBT_LOCKED`).
 *    - Active cycle (`activeCycleEpoch` unchanged) prevents spurious 30-day timer reset even 35 days
 *      later; advancing `activeCycleEpoch` triggers 1x reset + debt offset cleanly.
 *    - Inactive/non-Opus master subscription rejects V5 free, V5 base-paid, and legacy requests at
 *      `/queue/join` with `503 MASTER_SUBSCRIPTION_INACTIVE` and zero queue insertion.
 *    - Depleted master Anlas (`masterAnlas < requiredAnlas`) rejects `is_base_paid: true` and addon
 *      `declared_anlas > 0` bypasses with `503 MASTER_ANLAS_DEPLETED`, while 0-Anlas free requests pass.
 * 7. Hell Path: Auth Precedence, Half-Specified Dimensions, Poison Inputs, Query Arrays & Duplicate `req_id`:
 *    - Unauthenticated, unapproved, and banned callers sending deadband steps receive `401`/`403`
 *      before parametric/deadband policy checks (`400`).
 *    - Rejects non-object body, half-specified dimensions (`width` without `height` or vice-versa),
 *      empty/whitespace `browser_id`, `req_id`, or `model`, poison `steps`/`is_base_paid`/`is_v5`/
 *      `declared_anlas` types, conflicting `model`/`is_v5`, and Express 5 array payloads in `/status`
 *      and `/complete` with `400`.
 *    - Rejects duplicate `req_id` with `409 DUPLICATE_REQUEST_ID` without corrupting existing task holds.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit6.db');
const TEST_PORT = 16000;
const MOCK_UPSTREAM_PORT = 16001;

process.env.ADMIN_SECRET_KEY = 'commit6_admin_secret_key';
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

let mockSubscriptionStatus = 200;
let mockSubscriptionBody = { usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } };

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/user/subscription') {
    res.writeHead(mockSubscriptionStatus, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(mockSubscriptionBody));
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

test('Phase 8 Commit 6: Queue Ingress Gating & Model-Aware Compute Reservation', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit6_master_token')");

  const now = Date.now();

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_a', 'Normal', 0, 500, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_a', 'u_a', 'sec_a', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_b', 'Normal', 0, 500, ?, 0, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_b', 'u_b', 'sec_b', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_metered', 'Metered', 0, 0, ?, 0, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_metered', 'u_metered', 'sec_metered', 'Metered', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_debt', 'Normal', 0, -25, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_debt', 'u_debt', 'sec_debt', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_low_anlas', 'Normal', 0, 3, ?, 0, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_low_anlas', 'u_low_anlas', 'sec_low_anlas', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_banned_c6', 'Normal', 1, 500, ?, 100, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_banned_c6', 'u_banned_c6', 'sec_banned_c6', 'Normal', 1, 1)"
  );

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

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: HIGH (18 NCP), MEDIUM (10 NCP), LEGACY, SURPLUS, & C_BASE FORWARDING
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Reserves 18 NCP for V5 High, 10 NCP for V5 Medium, and preserves legacy join', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });

    // 1. V5 High (steps=23) -> 18 NCP personal hold
    const highRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_v5_high_1',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false,
      is_v5: true
    });
    assert.strictEqual(highRes.status, 200);
    assert.strictEqual(highRes.data.success, true);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a', 'personal'), 18);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a', 'surplus'), 0);

    queueManager.complete('req_v5_high_1', 'dev_a');
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a'), 0);

    // 2. V5 Medium (steps=14) -> 10 NCP personal hold
    const medRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_v5_med_1',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      is_base_paid: false,
      is_v5: true
    });
    assert.strictEqual(medRes.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a', 'personal'), 10);
    queueManager.complete('req_v5_med_1', 'dev_a');

    // 3. Legacy join omitting model/steps/is_v5 -> 0 NCP hold
    const legacyRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_legacy_omitted'
    });
    assert.strictEqual(legacyRes.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a'), 0);
    queueManager.complete('req_legacy_omitted', 'dev_a');
  });

  await t.test('Happy Path: Forwards req.telemetry.nominalDailyCompute to evaluateV5Accrual', async () => {
    queueManager.reset();

    // Set timeUntilNextPercent = 5000s => raw C_base = (86400 / 5000) * 17.28 = 298.5984
    // u_a (2), u_b (2), u_debt (2), u_low_anlas (2), implicit Admin (4) => totalWeight = 12 (u_banned_c6 excluded)
    // Nominal Daily NCP = floor(298.5984 * 18) = 5374; share (2/12) = floor(5374 * (2/12)) = 895 NCP
    // (Whereas fallback 190.0 would yield floor(3420 * (2/12)) = 570 NCP)
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 5000, isNegative: false } });

    // Rewind u_b's v5_last_accrual_epoch by 25 hours so evaluateV5Accrual triggers on join
    const oldAccrual = Date.now() - (25 * 3600 * 1000);
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_b'", [oldAccrual]);

    const res = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_cbase_forward',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });

    assert.strictEqual(res.status, 200);
    const updatedB = await dbModule.get("SELECT v5_banked_balance FROM users WHERE user_id = 'u_b'");
    assert.strictEqual(
      updatedB.v5_banked_balance,
      895,
      'Must forward live telemetry nominalDailyCompute (895 NCP) instead of falling back to 190.0 (570 NCP)'
    );

    queueManager.complete('req_cbase_forward', 'dev_b');
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_b'", [Date.now()]);
  });

  // ---------------------------------------------------------------------------
  // 2. HELL PATH: DEADBAND EXPLOITATION & CROSS-MODEL PARAMETRIC GATE
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Deadband Exploitation Check rejects V5 High 24..28 & >28 free, allows V5 Medium', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });

    // V5 High free requests at 24, 25, 28, and 29 steps must all fail with 400 PARAMETRIC_LIMIT_EXCEEDED
    for (const badStep of [24, 25, 28, 29]) {
      const res = await queryGateway('/queue/join', 'POST', {
        'Authorization': 'Bearer sec_a'
      }, {
        browser_id: 'dev_a',
        tab_id: 'tab_a',
        req_id: `req_deadband_${badStep}`,
        model: 'nai-diffusion-5-full',
        steps: badStep,
        is_base_paid: false
      });

      assert.strictEqual(res.status, 400, `V5 High free step ${badStep} must return 400`);
      assert.strictEqual(res.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');
    }
    assert.strictEqual(queueManager.getQueueLength(), 0, 'Rejected deadband requests must never enter queue');

    // Forged is_base_paid: true on explicitly free parameters (including omitted steps) must be rejected
    const forgedHighFree = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_forged_bp_high',
      model: 'nai-diffusion-5-full',
      width: 1024,
      height: 1024,
      n_samples: 1,
      steps: 25,
      is_base_paid: true
    });
    assert.strictEqual(forgedHighFree.status, 400);
    assert.strictEqual(forgedHighFree.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');

    const forgedHighOmittedSteps = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_forged_bp_omitted_steps',
      model: 'nai-diffusion-5-full',
      width: 1024,
      height: 1024,
      n_samples: 1,
      is_base_paid: true
    });
    assert.strictEqual(forgedHighOmittedSteps.status, 400);
    assert.strictEqual(forgedHighOmittedSteps.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');

    const forgedMedFree = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_forged_bp_med',
      model: 'nai-diffusion-5-full-medium',
      width: 1024,
      height: 1024,
      n_samples: 1,
      steps: 50,
      is_base_paid: true
    });
    assert.strictEqual(forgedMedFree.status, 400);
    assert.strictEqual(forgedMedFree.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // V5 Medium with steps 24, 25, 28, and 50 must bypass deadband cleanly and reserve 10 NCP
    for (const medStep of [24, 25, 28, 50]) {
      const reqId = `req_med_bypass_${medStep}`;
      const res = await queryGateway('/queue/join', 'POST', {
        'Authorization': 'Bearer sec_a'
      }, {
        browser_id: 'dev_a',
        tab_id: 'tab_a',
        req_id: reqId,
        model: 'nai-diffusion-5-full-medium',
        steps: medStep,
        is_base_paid: false
      });

      assert.strictEqual(res.status, 200, `V5 Medium step ${medStep} must bypass deadband`);
      assert.strictEqual(queueManager.getHeldNcpForUser('u_a', 'personal'), 10);
      queueManager.complete(reqId, 'dev_a');
    }
  });

  await t.test('Hell Path: Non-V5 (V4.5) preserves 24..28 free steps & addons while blocking un-bypassed >1MP / >1 sample / >28 steps upfront', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // Keep an active task in Channel A to verify rejected non-V5 requests never enter or disturb queue
    const holderRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_v45_holder',
      model: 'nai-diffusion-4-5-full',
      width: 1024,
      height: 1024,
      n_samples: 1,
      steps: 28,
      is_base_paid: false,
      declared_anlas: 10
    });
    assert.strictEqual(holderRes.status, 200, 'V4.5 free-base 28 steps + addon declared_anlas must succeed');
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a'), 0);
    assert.strictEqual(queueManager.getQueueLength(), 1);

    // Un-bypassed (>1MP, >1 sample, >28 steps) on V4.5 AND omitted-model must fail fast at /queue/join
    const invalidNonV5Payloads = [
      { label: 'v45-oversize', body: { browser_id: 'dev_b', req_id: 'req_v45_oversize', model: 'nai-diffusion-4-5-full', width: 1536, height: 2048, n_samples: 1, steps: 28, is_base_paid: false } },
      { label: 'v45-multisample', body: { browser_id: 'dev_b', req_id: 'req_v45_multi', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, n_samples: 2, steps: 28, is_base_paid: false } },
      { label: 'v45-steps29', body: { browser_id: 'dev_b', req_id: 'req_v45_steps29', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, n_samples: 1, steps: 29, is_base_paid: false } },
      { label: 'omitted-oversize', body: { browser_id: 'dev_b', req_id: 'req_omit_oversize', width: 2048, height: 2048, n_samples: 1, is_base_paid: false } },
      { label: 'omitted-multisample', body: { browser_id: 'dev_b', req_id: 'req_omit_multi', n_samples: 2, is_base_paid: false } },
      { label: 'omitted-steps29', body: { browser_id: 'dev_b', req_id: 'req_omit_steps29', steps: 29, is_base_paid: false } }
    ];

    for (const tc of invalidNonV5Payloads) {
      const res = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_b' }, tc.body);
      assert.strictEqual(res.status, 400, `${tc.label} must return 400 upfront`);
      assert.strictEqual(res.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');
    }
    assert.strictEqual(queueManager.getQueueLength(), 1, 'Rejected non-V5 requests must not enter queue');
    assert.ok(queueManager.getProcessingTask('req_v45_holder', 'dev_a'), 'Existing active Channel A task must remain undisturbed');

    // Legitimate V4.5 WITH is_base_paid: true (>1MP, >1 sample, >28 steps) passes cleanly
    for (const [label, body] of [
      ['v45-paid-res', { browser_id: 'dev_b', req_id: 'req_v45_paid_res', model: 'nai-diffusion-4-5-full', width: 1536, height: 2048, n_samples: 1, steps: 28, is_base_paid: true, declared_anlas: 60 }],
      ['v45-paid-samples', { browser_id: 'dev_b', req_id: 'req_v45_paid_samp', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, n_samples: 2, steps: 28, is_base_paid: true, declared_anlas: 20 }],
      ['v45-paid-steps', { browser_id: 'dev_b', req_id: 'req_v45_paid_steps', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, n_samples: 1, steps: 29, is_base_paid: true, declared_anlas: 21 }]
    ]) {
      const res = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_b' }, body);
      assert.strictEqual(res.status, 200, `${label} with is_base_paid: true must succeed`);
      queueManager.complete(body.req_id, 'dev_b');
    }

    queueManager.complete('req_v45_holder', 'dev_a');
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: QUEUE DEPLETION STARVATION, CONCURRENT RACE & SURPLUS CONTENTION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Queue Depletion Starvation (429), Metered Denial, Concurrent Surplus Race & Tab Refresh', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });
    await dbModule.run("UPDATE users SET v5_banked_balance = 10, v5_last_accrual_epoch = ? WHERE user_id = 'u_b'", [Date.now()]);
    queueManager.hydrateSurplusPool('0', String(Date.now()));

    // 1. User B has 10 personal NCP & 0 surplus -> V5 High (18 NCP) must return 429 V5_CAPACITY_DEPLETED
    const depletedHigh = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_depleted_high',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(depletedHigh.status, 429);
    assert.strictEqual(depletedHigh.data.error, 'V5_CAPACITY_DEPLETED');
    assert.strictEqual(queueManager.getQueueLength(), 0, 'Depleted client must not enter queue');

    // 2. Same user B with 10 personal NCP succeeds on V5 Medium (10 NCP)
    const solventMed = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_solvent_med',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      is_base_paid: false
    });
    assert.strictEqual(solventMed.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_b', 'personal'), 10);
    queueManager.complete('req_solvent_med', 'dev_b');

    // 3. Hydrate surplus pool to 18 NCP:
    //    - Metered tier (v5SurplusEligible: false) MUST still get 429 V5_CAPACITY_DEPLETED
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_b'", [Date.now()]);
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_low_anlas'", [Date.now()]);
    queueManager.hydrateSurplusPool('18', String(Date.now()));

    const meteredDenial = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_metered'
    }, {
      browser_id: 'dev_metered',
      tab_id: 'tab_m',
      req_id: 'req_metered_surplus_deny',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      is_base_paid: false
    });
    assert.strictEqual(meteredDenial.status, 429);
    assert.strictEqual(meteredDenial.data.error, 'V5_CAPACITY_DEPLETED');

    // 4. Concurrent Bucket 2 surplus race (Promise.all across evaluateV5Accrual async boundary):
    //    Only ONE of two simultaneous requests can claim the 18 NCP surplus pool; the other receives 429
    const [raceB, raceLowAnlas] = await Promise.all([
      queryGateway('/queue/join', 'POST', {
        'Authorization': 'Bearer sec_b'
      }, {
        browser_id: 'dev_b',
        tab_id: 'tab_b',
        req_id: 'req_race_b',
        model: 'nai-diffusion-5-full',
        steps: 23,
        is_base_paid: false
      }),
      queryGateway('/queue/join', 'POST', {
        'Authorization': 'Bearer sec_low_anlas'
      }, {
        browser_id: 'dev_low_anlas',
        tab_id: 'tab_la',
        req_id: 'req_race_la',
        model: 'nai-diffusion-5-full',
        steps: 23,
        is_base_paid: false
      })
    ]);

    const raceStatuses = [raceB.status, raceLowAnlas.status].sort((a, b) => a - b);
    assert.deepStrictEqual(raceStatuses, [200, 429], 'Concurrent surplus race must admit exactly 1 request and reject 1 with 429');
    assert.strictEqual(queueManager.getHeldSurplusNcp(), 18);
    assert.strictEqual(queueManager.getAvailableSurplusNcp(), 0);
    assert.strictEqual(queueManager.getQueueLength(), 1);

    if (raceB.status === 200) {
      queueManager.complete('req_race_b', 'dev_b');
    } else {
      queueManager.complete('req_race_la', 'dev_low_anlas');
    }
    assert.strictEqual(queueManager.getAvailableSurplusNcp(), 18);

    // 5. Sequential cross-user Bucket 2 surplus contention & tab-refresh self-replacement
    const surplusClaimB = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_surplus_b_1',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(surplusClaimB.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_b', 'surplus'), 18);
    assert.strictEqual(queueManager.getAvailableSurplusNcp(), 0);

    const surplusContention = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_low_anlas'
    }, {
      browser_id: 'dev_low_anlas',
      tab_id: 'tab_la',
      req_id: 'req_surplus_blocked',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      is_base_paid: false
    });
    assert.strictEqual(surplusContention.status, 429);
    assert.strictEqual(surplusContention.data.error, 'V5_CAPACITY_DEPLETED');
    assert.strictEqual(queueManager.getQueueLength(), 1, 'Only User B task must remain in queue');

    // Tab-refresh self-replacement without self-deadlock on surplus (18 NCP held on req_surplus_b_1)
    const surplusRefreshB = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_surplus_b_2',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(surplusRefreshB.status, 200, 'Tab refresh must replace own task without self-deadlock on surplus');
    assert.strictEqual(queueManager.getQueueLength(), 1);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_b', 'surplus'), 18);

    queueManager.complete('req_surplus_b_2', 'dev_b');
    assert.strictEqual(queueManager.getAvailableSurplusNcp(), 18);

    const surplusAfterRelease = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_low_anlas'
    }, {
      browser_id: 'dev_low_anlas',
      tab_id: 'tab_la',
      req_id: 'req_surplus_acquired',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(surplusAfterRelease.status, 200);
    queueManager.complete('req_surplus_acquired', 'dev_low_anlas');

    // 6. Tab-refresh self-replacement without self-deadlock on exact-change personal bank (18 NCP)
    await dbModule.run("UPDATE users SET v5_banked_balance = 18, v5_last_accrual_epoch = ? WHERE user_id = 'u_b'", [Date.now()]);
    queueManager.hydrateSurplusPool('0', String(Date.now()));

    const exact1 = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_exact_personal_1',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(exact1.status, 200);

    const exact2 = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_b'
    }, {
      browser_id: 'dev_b',
      tab_id: 'tab_b',
      req_id: 'req_exact_personal_2',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(exact2.status, 200, 'Tab refresh with exact 18 personal NCP must replace own task cleanly');
    assert.strictEqual(queueManager.getHeldNcpForUser('u_b', 'personal'), 18);
    queueManager.complete('req_exact_personal_2', 'dev_b');
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: CIRCUIT BREAKER LOCKDOWN (503) & COLD-BOOT FAIL-CLOSED
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Circuit Breaker (<= 5.5%) blocks free V5 while allowing is_base_paid & legacy', async () => {
    queueManager.reset();
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_a'", [Date.now()]);

    // 1. Set battery to exact 5.5% threshold
    serverModule.applyUsageTelemetry({ usage: { percent: 5.5, timeUntilNextPercent: 7858, isNegative: false } });

    const blockedHigh = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cb_high',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(blockedHigh.status, 503);
    assert.strictEqual(blockedHigh.data.error, 'V5_BATTERY_CRITICAL');

    const blockedMed = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cb_med',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      is_base_paid: false
    });
    assert.strictEqual(blockedMed.status, 503);
    assert.strictEqual(blockedMed.data.error, 'V5_BATTERY_CRITICAL');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // 2. Legacy model passes untouched while V5 circuit breaker is open
    const legacyPass = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cb_legacy',
      model: 'nai-diffusion-4-5-full',
      steps: 28,
      is_base_paid: false
    });
    assert.strictEqual(legacyPass.status, 200);
    queueManager.complete('req_cb_legacy', 'dev_a');

    // 3. Base-paid V5 (solvent user) bypasses circuit breaker & V5 NCP depletion
    await dbModule.run("UPDATE users SET v5_banked_balance = 0, v5_last_accrual_epoch = ? WHERE user_id = 'u_a'", [Date.now()]);
    const basePaidPass = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cb_base_paid',
      model: 'nai-diffusion-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 29,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(basePaidPass.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a'), 0);
    queueManager.complete('req_cb_base_paid', 'dev_a');

    // 4. Cold-boot telemetry failure (lastFetched === 0 and upstream 500) fails closed (503)
    //    for both free V5 and Anlas-consuming base-paid requests
    mockSubscriptionStatus = 500;
    serverModule.resetTelemetryState({ lastFetchedAt: 0, lastNetworkAttemptAt: 0 });
    const coldBootFail = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cold_boot_fail',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(coldBootFail.status, 503);
    assert.strictEqual(coldBootFail.data.error, 'TELEMETRY_FETCH_FAILED');

    const coldBootPaidFail = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cold_boot_paid_fail',
      model: 'nai-diffusion-4-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 28,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(coldBootPaidFail.status, 503);
    assert.strictEqual(coldBootPaidFail.data.error, 'TELEMETRY_FETCH_FAILED');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // 5. Missing master_token on cold boot (ensureFresh resolves without throwing, lastFetched remains 0)
    //    must also fail closed with 503 TELEMETRY_UNAVAILABLE
    await dbModule.run("DELETE FROM config WHERE key = 'master_token'");
    try {
      serverModule.resetTelemetryState({ lastFetchedAt: 0, lastNetworkAttemptAt: 0 });
      const missingMasterRes = await queryGateway('/queue/join', 'POST', {
        'Authorization': 'Bearer sec_a'
      }, {
        browser_id: 'dev_a',
        tab_id: 'tab_a',
        req_id: 'req_missing_master_tok',
        model: 'nai-diffusion-5-full',
        steps: 23,
        is_base_paid: false
      });
      assert.strictEqual(missingMasterRes.status, 503);
      assert.strictEqual(missingMasterRes.data.error, 'TELEMETRY_UNAVAILABLE');
      assert.strictEqual(queueManager.getQueueLength(), 0);
    } finally {
      await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit6_master_token')");
    }

    // Restore healthy telemetry
    mockSubscriptionStatus = 200;
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: LAZY ANLAS RESET, DEBT LOCKOUT & CROSS-CHANNEL HOLD CHECK
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Lazy 30-day Anlas reset, debt lockout (403) & cross-channel Anlas holds at queue join', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_debt'", [Date.now()]);

    // 1. Approved user with NULL last_anlas_reset_epoch lazily receives monthlyAnlas prior to authorizeAnlasSpend
    await dbModule.run(
      `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch)
       VALUES ('u_lazy_reset', 'Normal', 0, 0, NULL)`
    );
    await dbModule.run(
      "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_lazy_reset', 'u_lazy_reset', 'sec_lazy_reset', 'Normal', 1, 0)"
    );

    const lazyInitRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_lazy_reset'
    }, {
      browser_id: 'dev_lazy_reset',
      tab_id: 'tab_lazy',
      req_id: 'req_lazy_init',
      model: 'nai-diffusion-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 28,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(lazyInitRes.status, 200, 'Approved user with NULL reset epoch must lazily receive monthlyAnlas before spend check');
    const lazyUserRow = await dbModule.get("SELECT virtual_anlas_balance, last_anlas_reset_epoch FROM users WHERE user_id = 'u_lazy_reset'");
    assert.strictEqual(lazyUserRow.virtual_anlas_balance, 500);
    assert.ok(lazyUserRow.last_anlas_reset_epoch > 0);
    queueManager.complete('req_lazy_init', 'dev_lazy_reset');

    // 2. Expired 30-day epoch with -100 debt resets lazily to 400 (500 - 100) and permits spend
    const expiredEpoch = Date.now() - (31 * 86400000);
    await dbModule.run(
      "UPDATE users SET virtual_anlas_balance = -100, last_anlas_reset_epoch = ? WHERE user_id = 'u_lazy_reset'",
      [expiredEpoch]
    );
    const lazyRecoveryRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_lazy_reset'
    }, {
      browser_id: 'dev_lazy_reset',
      tab_id: 'tab_lazy',
      req_id: 'req_lazy_recovery',
      model: 'nai-diffusion-5-full',
      steps: 29,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(lazyRecoveryRes.status, 200, '30-day reset must offset -100 debt to 400 before debt lockout check');
    const recoveredRow = await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_lazy_reset'");
    assert.strictEqual(recoveredRow.virtual_anlas_balance, 400);
    queueManager.complete('req_lazy_recovery', 'dev_lazy_reset');

    // 3. User in active Anlas debt attempting is_base_paid: true -> 403 DEBT_LOCKED
    const debtBlocked = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_debt'
    }, {
      browser_id: 'dev_debt',
      tab_id: 'tab_debt',
      req_id: 'req_debt_paid',
      model: 'nai-diffusion-5-full',
      steps: 29,
      is_base_paid: true
    });
    assert.strictEqual(debtBlocked.status, 403);
    assert.strictEqual(debtBlocked.data.error, 'DEBT_LOCKED');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // 4. User in active Anlas debt attempting free V5 High (steps: 23, sufficient V5 NCP) -> permitted (200)
    const debtFreeAllowed = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_debt'
    }, {
      browser_id: 'dev_debt',
      tab_id: 'tab_debt',
      req_id: 'req_debt_free_v5',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(debtFreeAllowed.status, 200);
    assert.strictEqual(queueManager.getHeldNcpForUser('u_debt', 'personal'), 18);
    queueManager.complete('req_debt_free_v5', 'dev_debt');

    // 5. Cross-channel hold: u_low_anlas has 3 Anlas balance, 2 Anlas held in Channel B -> 1 available < 2 min -> 403 INSUFFICIENT_ANLAS
    assert.strictEqual(queueManager.acquireTextSlot('vibe_lock_c6', 'u_low_anlas', 2), true);
    const crossChannelBlocked = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_low_anlas'
    }, {
      browser_id: 'dev_low_anlas',
      tab_id: 'tab_la',
      req_id: 'req_cross_channel_block',
      model: 'nai-diffusion-5-full',
      steps: 29,
      is_base_paid: true
    });
    assert.strictEqual(crossChannelBlocked.status, 403);
    assert.strictEqual(crossChannelBlocked.data.error, 'INSUFFICIENT_ANLAS');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    queueManager.releaseTextSlot('vibe_lock_c6');
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: BILLING-CYCLE AMENDMENT INTEGRATION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Billing-cycle context, grace freeze, MASTER_SUBSCRIPTION_INACTIVE & MASTER_ANLAS_DEPLETED', async () => {
    queueManager.reset();
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_a'", [Date.now()]);
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_debt'", [Date.now()]);

    const cycle1ExpiresSec = Math.floor(Date.now() / 1000) + (25 * 86400);
    const cycle1Epoch = Date.now() - (35 * 86400000); // >30 days ago, but same active billing cycle

    // 1. Grace period freezes Anlas reset even when last_anlas_reset_epoch is >30 days old
    serverModule.resetTelemetryState({ lastPaidExpiresAt: cycle1ExpiresSec, activeCycleEpoch: cycle1Epoch });
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle1ExpiresSec + (3 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: true,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    await dbModule.run(
      "UPDATE users SET virtual_anlas_balance = -100, last_anlas_reset_epoch = ? WHERE user_id = 'u_debt'",
      [cycle1Epoch - 86400000]
    );
    const graceFrozenDebt = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_debt'
    }, {
      browser_id: 'dev_debt',
      tab_id: 'tab_debt',
      req_id: 'req_grace_frozen',
      model: 'nai-diffusion-5-full',
      steps: 29,
      is_base_paid: true,
      declared_anlas: 20
    });
    assert.strictEqual(graceFrozenDebt.status, 403, 'Grace period must freeze 30-day fallback reset');
    assert.strictEqual(graceFrozenDebt.data.error, 'DEBT_LOCKED');

    // 2. Non-grace same cycle prevents spurious 30-day timer reset even 35 days after last reset
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle1ExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // Simulate user who already reset during cycle1Epoch (>30 days ago) and spent down to 10 Anlas
    await dbModule.run(
      "UPDATE users SET virtual_anlas_balance = 10, last_anlas_reset_epoch = ? WHERE user_id = 'u_a'",
      [cycle1Epoch]
    );
    const sameCycleNoReset = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_same_cycle_no_reset',
      model: 'nai-diffusion-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 28,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(sameCycleNoReset.status, 403, 'Same activeCycleEpoch must NOT trigger 30-day fallback reset');
    assert.strictEqual(sameCycleNoReset.data.error, 'INSUFFICIENT_ANLAS');

    // 3. Advancing billing cycle (+30 days expiresAt) unlocks 1x cycle reset for u_a and debt-offset for u_debt
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle1ExpiresSec + (30 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const renewedUserA = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_cycle2_user_a',
      model: 'nai-diffusion-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 28,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(renewedUserA.status, 200);
    queueManager.complete('req_cycle2_user_a', 'dev_a');

    const renewedDebt = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_debt'
    }, {
      browser_id: 'dev_debt',
      tab_id: 'tab_debt',
      req_id: 'req_cycle2_debt',
      model: 'nai-diffusion-5-full',
      steps: 29,
      is_base_paid: true,
      declared_anlas: 20
    });
    assert.strictEqual(renewedDebt.status, 200, 'Confirmed cycle renewal must offset -100 debt to 400');
    const debtRowAfter = await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_debt'");
    assert.strictEqual(debtRowAfter.virtual_anlas_balance, 400);
    queueManager.complete('req_cycle2_debt', 'dev_debt');

    // 4. Master Anlas Depleted (503 MASTER_ANLAS_DEPLETED) blocks Anlas bypasses while allowing free 0-Anlas requests
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle1ExpiresSec + (30 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 5, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const masterDepletedPaid = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_master_anlas_depleted',
      model: 'nai-diffusion-5-full',
      width: 1536,
      height: 2048,
      n_samples: 1,
      steps: 28,
      is_base_paid: true,
      declared_anlas: 60
    });
    assert.strictEqual(masterDepletedPaid.status, 503);
    assert.strictEqual(masterDepletedPaid.data.error, 'MASTER_ANLAS_DEPLETED');

    const masterDepletedAddon = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_master_anlas_addon',
      model: 'nai-diffusion-4-5-full',
      width: 1024,
      height: 1024,
      n_samples: 1,
      steps: 28,
      is_base_paid: false,
      declared_anlas: 10
    });
    assert.strictEqual(masterDepletedAddon.status, 503);
    assert.strictEqual(masterDepletedAddon.data.error, 'MASTER_ANLAS_DEPLETED');

    // Free 0-Anlas V5 request succeeds even with masterAnlas === 0
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: cycle1ExpiresSec + (30 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const masterZeroFreeAllowed = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, {
      browser_id: 'dev_a',
      tab_id: 'tab_a',
      req_id: 'req_master_zero_free',
      model: 'nai-diffusion-5-full',
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(masterZeroFreeAllowed.status, 200);
    queueManager.complete('req_master_zero_free', 'dev_a');

    // 5. Inactive Master Subscription (503 MASTER_SUBSCRIPTION_INACTIVE) blocks V5, base-paid, and legacy joins
    serverModule.applyUsageTelemetry({
      tier: 0,
      active: false,
      expiresAt: cycle1ExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    for (const [label, payload] of [
      ['v5-free', { browser_id: 'dev_a', req_id: 'req_inact_v5', model: 'nai-diffusion-5-full', steps: 23, is_base_paid: false }],
      ['v5-paid', { browser_id: 'dev_a', req_id: 'req_inact_paid', model: 'nai-diffusion-5-full', width: 1536, height: 2048, n_samples: 1, steps: 28, is_base_paid: true, declared_anlas: 60 }],
      ['legacy', { browser_id: 'dev_a', req_id: 'req_inact_leg', model: 'nai-diffusion-4-5-full', steps: 28, is_base_paid: false }]
    ]) {
      const inactiveRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, payload);
      assert.strictEqual(inactiveRes.status, 503, `Inactive subscription must reject ${label} with 503`);
      assert.strictEqual(inactiveRes.data.error, 'MASTER_SUBSCRIPTION_INACTIVE');
    }
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // Restore healthy telemetry and u_debt baseline
    await dbModule.run("UPDATE users SET virtual_anlas_balance = -25, last_anlas_reset_epoch = ? WHERE user_id = 'u_debt'", [Date.now()]);
    serverModule.resetTelemetryState();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });
  });

  // ---------------------------------------------------------------------------
  // 7. HELL PATH: AUTH PRECEDENCE, HALF-DIMENSIONS, POISON INPUTS, QUERY ARRAYS & DUPLICATE REQ_ID
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces auth before policy gates and rejects poison types, unpaired dimensions & duplicate req_id', async () => {
    queueManager.reset();
    serverModule.applyUsageTelemetry({ usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false } });
    await dbModule.run("UPDATE users SET v5_banked_balance = 100, v5_last_accrual_epoch = ? WHERE user_id = 'u_a'", [Date.now()]);

    // 0. Auth precedence: unauthenticated and banned callers sending deadband steps get 401/403 before 400
    const unauthDeadband = await queryGateway('/queue/join', 'POST', {}, {
      browser_id: 'dev_a',
      req_id: 'req_unauth_deadband',
      model: 'nai-diffusion-5-full',
      steps: 25
    });
    assert.strictEqual(unauthDeadband.status, 401, 'Unauthenticated caller must receive 401 before deadband 400');

    const bannedDeadband = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_banned_c6'
    }, {
      browser_id: 'dev_banned_c6',
      req_id: 'req_banned_deadband',
      model: 'nai-diffusion-5-full',
      steps: 25
    });
    assert.strictEqual(bannedDeadband.status, 403, 'Banned caller must receive 403 before deadband 400');

    // 1. Array / invalid body -> 400
    const arrayBodyRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, []);
    assert.strictEqual(arrayBodyRes.status, 400);

    // 2. Half-specified dimensions (width without height, or height without width) -> 400 INVALID_PARAMETERS
    const widthOnlyRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_width_only',
      model: 'nai-diffusion-5-full',
      width: 2048,
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(widthOnlyRes.status, 400);
    assert.strictEqual(widthOnlyRes.data.error, 'INVALID_PARAMETERS');

    const heightOnlyRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_height_only',
      model: 'nai-diffusion-5-full',
      height: 2048,
      steps: 23,
      is_base_paid: false
    });
    assert.strictEqual(heightOnlyRes.status, 400);
    assert.strictEqual(heightOnlyRes.data.error, 'INVALID_PARAMETERS');

    // 3. Whitespace browser_id / req_id / model -> 400
    const blankIdsRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: '   ',
      req_id: 'req_blank'
    });
    assert.strictEqual(blankIdsRes.status, 400);

    const blankModelRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_blank_model',
      model: '   '
    });
    assert.strictEqual(blankModelRes.status, 400);
    assert.strictEqual(blankModelRes.data.error, 'INVALID_PARAMETERS');

    // 4. Conflicting model & is_v5 flag -> 400
    const conflictRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_conflict',
      model: 'nai-diffusion-4-5-full',
      is_v5: true
    });
    assert.strictEqual(conflictRes.status, 400);
    assert.strictEqual(conflictRes.data.error, 'INVALID_PARAMETERS');

    // 5. Poison types (string steps, float steps, non-boolean flags, negative declared_anlas) -> 400
    const poisonPayloads = [
      { browser_id: 'dev_a', req_id: 'p1', model: 'nai-diffusion-5-full', steps: '23' },
      { browser_id: 'dev_a', req_id: 'p2', model: 'nai-diffusion-5-full', steps: 23.5 },
      { browser_id: 'dev_a', req_id: 'p3', model: 'nai-diffusion-5-full', steps: -1 },
      { browser_id: 'dev_a', req_id: 'p4', model: 'nai-diffusion-5-full', is_base_paid: 'true' },
      { browser_id: 'dev_a', req_id: 'p5', model: 'nai-diffusion-5-full', is_v5: 1 },
      { browser_id: 'dev_a', req_id: 'p6', model: 'nai-diffusion-5-full', declared_anlas: -10 }
    ];
    for (const payload of poisonPayloads) {
      const poisonRes = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, payload);
      assert.strictEqual(poisonRes.status, 400, `Poison payload ${payload.req_id} must return 400`);
    }

    // 6. Express 5 duplicate query-array parameters in /status and non-string fields in /complete -> 400 (never 500)
    const statusArrayRes = await queryGateway('/queue/status?req_id=a&req_id=b&browser_id=dev_a', 'GET', {
      'Authorization': 'Bearer sec_a'
    });
    assert.strictEqual(statusArrayRes.status, 400, 'Express 5 array req_id in /status must return 400, not 500');

    const completeArrayRes = await queryGateway('/queue/complete', 'POST', {
      'Authorization': 'Bearer sec_a'
    }, { req_id: ['a'], browser_id: 'dev_a' });
    assert.strictEqual(completeArrayRes.status, 400, 'Non-string req_id in /complete must return 400, not 500');

    // 7. Duplicate req_id -> 409 DUPLICATE_REQUEST_ID without disturbing existing task or holds
    const first = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_dup_target',
      model: 'nai-diffusion-5-full',
      steps: 23
    });
    assert.strictEqual(first.status, 200);

    const dup = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer sec_a' }, {
      browser_id: 'dev_a',
      req_id: 'req_dup_target',
      model: 'nai-diffusion-5-full',
      steps: 23
    });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.data.error, 'DUPLICATE_REQUEST_ID');
    assert.strictEqual(queueManager.getHeldNcpForUser('u_a', 'personal'), 18);

    queueManager.complete('req_dup_target', 'dev_a');
  });
});