/**
 * PHASE 8 VERSION GATEKEEPER VERIFICATION HARNESS (test/phase8_version_gatekeeper.test.js)
 *
 * Exhaustively tests MINIMUM_USERSCRIPT_VERSION enforcement across Config, AuditEngine,
 * and every Gateway HTTP router:
 * 1. Config SemVer Schema Validation:
 *    - Defaults fail-closed to '6.0.0'.
 *    - Accepts valid SemVer 2.0.0 strings including pre-release and build metadata.
 *    - Rejects empty, whitespace, missing-patch ('6.0'), v-prefixed ('v6.0.0'), leading-zero
 *      ('06.0.0'), trailing-junk ('6.0.0abc'), non-string, and unsafe-integer versions.
 * 2. SemVer 2.0.0 Precedence Logic (`parseSemVer` & `compareSemVer`):
 *    - Defeats string lexicographical traps: '10.0.0' > '6.0.0', '6.10.0' > '6.2.0'.
 *    - Enforces SemVer §11 pre-release precedence ('6.0.0-rc.1' < '6.0.0', '6.0.1-alpha.1' > '6.0.0',
 *      '6.1.0-beta.10' > '6.1.0-beta.2', '6.1.0-1' < '6.1.0-alpha', ignores '+build').
 * 3. Critical `v5.0.0` Ban Trap Extermination:
 *    - Reproduces the exact v5.0.0 incompatibility vector (V5 Medium absent steps with X-Gen-Steps: 28,
 *      plus reference_image_multiple counted in X-Precise-Refs: 2).
 *    - Verifies BOTH /queue/join and direct /proxy/image/* reject with HTTP 426 SCRIPT_UPDATE_REQUIRED,
 *      with ZERO permanent bans (users.banned === 0, devices.banned === 0, banned_discords empty),
 *      ZERO upstream hits, ZERO queue leaks, and immediate recovery once X-Script-Version >= 6.0.0.
 * 4. Missing, Empty, Whitespace, Malformed & Duplicate `X-Script-Version` Across All Userscript Routes:
 *    - Rejects (without banning, pinging, registering, or deducting Anlas/NCP/allowance) across:
 *      /auth/register, /auth/status, /auth/update-label, /auth/debug-intent,
 *      /queue/join, /queue/status, /queue/complete,
 *      /proxy/image/ai/generate-image, /proxy/image/ai/upscale, /proxy/image/ai/encode-vibe,
 *      /proxy/text/ai/generate-stream, /proxy/image/user/subscription.
 *    - Releases any pre-existing Channel A activeTask lock cleanly when /proxy/image/* rejects 426.
 * 5. Security Precedence (Auth / Ban / Whitelist MUST NOT be masked by 426):
 *    - Unauthenticated /auth/status?browser_id=ping (Step 1 Setup check) returns 401.
 *    - Banned user sending 5.0.0 or missing header gets 403, not 426.
 *    - Unapproved user sending 5.0.0 or missing header on /queue/join or /proxy/* gets 401, not 426.
 *    - SSRF subdomain or non-whitelisted path missing header gets 403, not 426.
 *    - Valid 6.0.0 client missing X-Gen-Model still receives 426 SCRIPT_UPDATE_REQUIRED.
 * 6. Admin / Discord Bot Plane Separation (`routes/adminRouter.js`):
 *    - External Discord bot / CLI requests to /admin/* omitting X-Script-Version succeed (200 OK).
 *    - Outdated nai-admin.user.js sending X-Script-Version: 5.0.0 or malformed header to /admin/*
 *      receives 426 SCRIPT_UPDATE_REQUIRED.
 *    - Valid nai-admin.user.js sending X-Script-Version: 6.0.0 succeeds (200 OK).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_version_gate.db');
const TEST_PORT = 19700;
const MOCK_UPSTREAM_PORT = 19701;

process.env.ADMIN_SECRET_KEY = 'version_gate_admin_key';
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

let upstreamHits = 0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/user/subscription') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tier: 3,
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + (20 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }));
  }
  upstreamHits += 1;
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

async function sendHttp(endpoint, method = 'GET', headers = {}, body = undefined) {
  const fetchOptions = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
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

test('Phase 8 Version Gatekeeper: SemVer Validation & Non-Punitive 426 Enforcement', async (t) => {
  const { loadConfig, parseSemVer, compareSemVer } = require('../config');

  // ---------------------------------------------------------------------------
  // 1. CONFIG & SEMVER UNIT INVARIANTS
  // ---------------------------------------------------------------------------
  await t.test('Config & SemVer: Validates MINIMUM_USERSCRIPT_VERSION and SemVer 2.0.0 precedence', () => {
    const defaultCfg = loadConfig({ ADMIN_SECRET_KEY: 'k' });
    assert.strictEqual(defaultCfg.MINIMUM_USERSCRIPT_VERSION, '6.0.0', 'Default must fail-closed at 6.0.0');

    const preCfg = loadConfig({ ADMIN_SECRET_KEY: 'k', MINIMUM_USERSCRIPT_VERSION: ' 6.1.0-beta.2+exp.sha ' });
    assert.strictEqual(preCfg.MINIMUM_USERSCRIPT_VERSION, '6.1.0-beta.2+exp.sha');

    for (const badVer of ['', '   ', '6', '6.0', 'v6.0.0', '06.0.0', '6.0.0abc', '6.0.0-01', '99999999999999999999.0.0', 600, null]) {
      assert.throws(
        () => loadConfig({ ADMIN_SECRET_KEY: 'k', MINIMUM_USERSCRIPT_VERSION: badVer }),
        /MINIMUM_USERSCRIPT_VERSION/,
        `Must reject invalid MINIMUM_USERSCRIPT_VERSION: ${String(badVer)}`
      );
    }

    assert.strictEqual(parseSemVer('v6.0.0'), null);
    assert.strictEqual(parseSemVer('6.0'), null);
    assert.strictEqual(parseSemVer('5.0.0, 6.0.0'), null);

    // Defeats string comparison bugs ("10.0.0" < "6.0.0" and "6.10.0" < "6.2.0")
    assert.strictEqual(compareSemVer('10.0.0', '6.0.0'), 1);
    assert.strictEqual(compareSemVer('6.10.0', '6.2.0'), 1);
    assert.strictEqual(compareSemVer('5.99.99', '6.0.0'), -1);
    assert.strictEqual(compareSemVer('6.0.0+build.99', '6.0.0'), 0);
    assert.strictEqual(compareSemVer('6.0.0-rc.1', '6.0.0'), -1);
    assert.strictEqual(compareSemVer('6.0.1-alpha.1', '6.0.0'), 1);
    assert.strictEqual(compareSemVer('6.1.0-beta.10', '6.1.0-beta.2'), 1);
    assert.strictEqual(compareSemVer('6.1.0-1', '6.1.0-alpha'), -1);
  });

  // ---------------------------------------------------------------------------
  // 2. BOOT SERVER & SEED PRINCIPALS
  // ---------------------------------------------------------------------------
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));
  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'vg_master_token')");
  const now = Date.now();

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_v5_guest', 'Normal', 0, 500, ?, 180, ?)`,
    [now, now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_v5_guest', 'u_v5_guest', 'u_v5_guest', 'sec_v5_guest', 'OldBrowser', 'Normal', 1, 0)"
  );

  await dbModule.run(
    "INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_vg_banned', 'Normal', 1)"
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_vg_banned', 'u_vg_banned', 'sec_vg_banned', 'Normal', 1, 1)"
  );

  await dbModule.run(
    "INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_vg_unapp', 'Normal', 0)"
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_vg_unapp', 'u_vg_unapp', 'sec_vg_unapp', 'Normal', 0, 0)"
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

  const snap = serverModule.getTelemetrySnapshot();
  await dbModule.run('UPDATE users SET last_anlas_reset_epoch = ?', [snap.activeCycleEpoch || now]);

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
  // 3. CRITICAL v5.0.0 BAN TRAP EXTERMINATION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: v5.0.0 client triggering Stage 5 mismatch vector receives 426 without ban, then recovers on 6.0.0', async () => {
    queueManager.reset();
    upstreamHits = 0;

    // A. v5.0.0 hits /queue/join first -> 426 SCRIPT_UPDATE_REQUIRED, not queued, not banned
    const joinOld = await sendHttp('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_v5_guest',
      'X-Script-Version': '5.0.0'
    }, {
      browser_id: 'dev_v5_guest',
      tab_id: 'tab_old',
      req_id: 'req_v5_old_1'
    });
    assert.strictEqual(joinOld.status, 426);
    assert.strictEqual(joinOld.data.error, 'SCRIPT_UPDATE_REQUIRED');
    assert.strictEqual(joinOld.data.min_version, '6.0.0');
    assert.strictEqual(queueManager.getQueueLength(), 0);

    // B. v5.0.0 hits /proxy/image/ai/generate-image directly with a pre-existing Channel A task
    //    and exact v5.0.0 Stage 5 ban-trap headers (X-Gen-Steps: 28 on Medium absent steps + X-Precise-Refs: 2 on Vibe Transfer)
    queueManager.join({ browser_id: 'dev_v5_guest', req_id: 'req_v5_trap_direct', user_id: 'u_v5_guest', priority_tier: 'Normal' });
    const proxyOld = await sendHttp('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_v5_guest',
      'X-Browser-Id': 'dev_v5_guest',
      'X-Request-Id': 'req_v5_trap_direct',
      'X-Script-Version': '5.0.0',
      'X-Gen-Model': 'V5',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Precise-Refs': '2'
    }, {
      model: 'nai-diffusion-5-full-medium',
      parameters: { width: 1024, height: 1024, n_samples: 1, reference_image_multiple: ['v1', 'v2'] }
    });

    assert.strictEqual(proxyOld.status, 426, 'v5.0.0 Stage 5 ban-trap payload must be rejected with 426, not 403 ban');
    assert.strictEqual(proxyOld.data.error, 'SCRIPT_UPDATE_REQUIRED');
    assert.strictEqual(upstreamHits, 0);
    assert.strictEqual(queueManager.getQueueLength(), 0, 'Pre-existing Channel A lock must release cleanly on 426');

    const userAfter = await dbModule.get("SELECT banned, virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = 'u_v5_guest'");
    const devAfter = await dbModule.get("SELECT banned FROM devices WHERE browser_id = 'dev_v5_guest'");
    const discBan = await dbModule.get("SELECT 1 FROM banned_discords WHERE discord_id = 'u_v5_guest'");
    assert.strictEqual(userAfter.banned, 0, 'Outdated client must NOT be banned');
    assert.strictEqual(devAfter.banned, 0);
    assert.strictEqual(discBan, undefined);
    assert.strictEqual(userAfter.virtual_anlas_balance, 500);
    assert.strictEqual(userAfter.v5_banked_balance, 180);

    // C. Client upgrades to 6.0.0 -> immediately succeeds 200 OK
    const joinNew = await sendHttp('/queue/join', 'POST', {
      'Authorization': 'Bearer sec_v5_guest',
      'X-Script-Version': '6.0.0'
    }, {
      browser_id: 'dev_v5_guest',
      tab_id: 'tab_new',
      req_id: 'req_v6_ok_1',
      model: 'nai-diffusion-5-full-medium',
      steps: 14,
      width: 1024,
      height: 1024,
      n_samples: 1,
      is_base_paid: false,
      is_v5: true
    });
    assert.strictEqual(joinNew.status, 200);

    const proxyNew = await sendHttp('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_v5_guest',
      'X-Browser-Id': 'dev_v5_guest',
      'X-Request-Id': 'req_v6_ok_1',
      'X-Script-Version': '6.0.0',
      'X-Gen-Model': 'V5-medium',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '14',
      'X-Gen-Samples': '1',
      'X-Precise-Refs': '0'
    }, {
      model: 'nai-diffusion-5-full-medium',
      parameters: { width: 1024, height: 1024, n_samples: 1 }
    });
    assert.strictEqual(proxyNew.status, 200);
    assert.strictEqual(upstreamHits, 1);

    // Numeric major >= 10 (defeats string comparison '10.0.0' < '6.0.0') and build metadata succeed
    for (const validVer of ['6.0.1', '6.10.0+meta', '10.0.0']) {
      const okStatus = await sendHttp('/auth/status?browser_id=dev_v5_guest', 'GET', {
        'Authorization': 'Bearer sec_v5_guest',
        'X-Script-Version': validVer
      });
      assert.strictEqual(okStatus.status, 200, `Version ${validVer} must pass >= 6.0.0`);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. MISSING, MALFORMED, DUPLICATE & PRERELEASE HEADERS ACROSS ALL USERSCRIPT ROUTES
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Missing, blank, malformed, duplicate & prerelease versions rejected with 426 across /auth, /queue, /proxy', async () => {
    queueManager.reset();
    upstreamHits = 0;

    // Ensure duplicate header spoofing ("5.0.0, 6.0.0") & malformed formats fail closed
    const badHeaders = [
      {},
      { 'X-Script-Version': '' },
      { 'X-Script-Version': '   ' },
      { 'X-Script-Version': 'v6.0.0' },
      { 'X-Script-Version': '6.0' },
      { 'X-Script-Version': '6.0.0-rc.1' },
      { 'X-Script-Version': '5.9.9' },
      { 'X-Script-Version': '5.0.0, 6.0.0' }
    ];

    for (const verHdr of badHeaders) {
      // /auth/register
      const regRes = await sendHttp('/auth/register', 'POST', verHdr, {
        browser_id: 'b_vg_never_created',
        device_secret: 'sec_vg_never',
        label: 'OldReg'
      });
      assert.strictEqual(regRes.status, 426);
      assert.strictEqual(regRes.data.error, 'SCRIPT_UPDATE_REQUIRED');
      assert.strictEqual(await dbModule.get("SELECT browser_id FROM devices WHERE browser_id = 'b_vg_never_created'"), undefined);

      // /auth/status
      const stRes = await sendHttp('/auth/status?browser_id=dev_v5_guest', 'GET', {
        'Authorization': 'Bearer sec_v5_guest',
        ...verHdr
      });
      assert.strictEqual(stRes.status, 426);
      assert.strictEqual(queueManager.isDeviceOnline('dev_v5_guest'), false, '426 must not mark device online');

      // /auth/update-label
      const lblRes = await sendHttp('/auth/update-label', 'POST', {
        'Authorization': 'Bearer sec_v5_guest',
        ...verHdr
      }, { browser_id: 'dev_v5_guest', label: 'TamperLabel' });
      assert.strictEqual(lblRes.status, 426);
      assert.strictEqual((await dbModule.get("SELECT label FROM devices WHERE browser_id = 'dev_v5_guest'")).label, 'OldBrowser');

      // /auth/debug-intent
      const dbgRes = await sendHttp('/auth/debug-intent', 'POST', {
        'Authorization': 'Bearer sec_v5_guest',
        ...verHdr
      }, { browser_id: 'dev_v5_guest', enabled: true });
      assert.strictEqual(dbgRes.status, 426);
      assert.strictEqual(queueManager.hasDebugIntent('dev_v5_guest'), false);

      // /queue/join, /queue/status, /queue/complete
      assert.strictEqual((await sendHttp('/queue/join', 'POST', { 'Authorization': 'Bearer sec_v5_guest', ...verHdr }, { browser_id: 'dev_v5_guest', req_id: 'r_vg_q' })).status, 426);
      assert.strictEqual((await sendHttp('/queue/status?req_id=r_vg_q&browser_id=dev_v5_guest', 'GET', { 'Authorization': 'Bearer sec_v5_guest', ...verHdr })).status, 426);
      assert.strictEqual((await sendHttp('/queue/complete', 'POST', { 'Authorization': 'Bearer sec_v5_guest', ...verHdr }, { req_id: 'r_vg_q', browser_id: 'dev_v5_guest' })).status, 426);

      // /proxy/* endpoints: image, upscale, encode-vibe, text, user/subscription
      for (const [ep, method, body] of [
        ['/proxy/image/ai/generate-image', 'POST', { parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } }],
        ['/proxy/image/ai/upscale', 'POST', { image: 'abc' }],
        ['/proxy/image/ai/encode-vibe', 'POST', { image: 'abc' }],
        ['/proxy/text/ai/generate-stream', 'POST', { prompt: 'hi' }],
        ['/proxy/image/user/subscription', 'GET', undefined]
      ]) {
        const prxRes = await sendHttp(ep, method, {
          'Authorization': 'Bearer sec_v5_guest',
          'X-Browser-Id': 'dev_v5_guest',
          ...verHdr
        }, body);
        assert.strictEqual(prxRes.status, 426, `${ep} with ${JSON.stringify(verHdr)} must return 426`);
        assert.strictEqual(prxRes.data.error, 'SCRIPT_UPDATE_REQUIRED');
      }
    }

    assert.strictEqual(upstreamHits, 0);
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_v5_guest'")).banned, 0);
  });

  // ---------------------------------------------------------------------------
  // 5. SECURITY PRECEDENCE & ADMIN / DISCORD BOT SEPARATION
  // ---------------------------------------------------------------------------
  await t.test('Security Precedence & Admin/Bot Plane: Auth/Bans/SSRF precede 426; Discord bot omits header; outdated Admin UI rejected', async () => {
    // 1. Setup Wizard Step 1 connectivity ping (no Authorization, no version) -> 401
    assert.strictEqual((await sendHttp('/auth/status?browser_id=ping', 'GET', {})).status, 401);

    // 2. Banned client sending 5.0.0 or no version -> 403 (never masked as 426)
    assert.strictEqual(
      (await sendHttp('/queue/join', 'POST', { 'Authorization': 'Bearer sec_vg_banned', 'X-Script-Version': '5.0.0' }, { browser_id: 'dev_vg_banned', req_id: 'r_ban_1' })).status,
      403
    );
    assert.strictEqual(
      (await sendHttp('/proxy/image/ai/generate-image', 'POST', { 'Authorization': 'Bearer sec_vg_banned', 'X-Browser-Id': 'dev_vg_banned' }, {})).status,
      403
    );

    // 3. Unapproved client sending 5.0.0 on /queue/join or /proxy/* -> 401 (never 426)
    assert.strictEqual(
      (await sendHttp('/queue/join', 'POST', { 'Authorization': 'Bearer sec_vg_unapp', 'X-Script-Version': '5.0.0' }, { browser_id: 'dev_vg_unapp', req_id: 'r_unapp_1' })).status,
      401
    );
    assert.strictEqual(
      (await sendHttp('/proxy/image/ai/generate-image', 'POST', { 'Authorization': 'Bearer sec_vg_unapp', 'X-Browser-Id': 'dev_vg_unapp' }, {})).status,
      401
    );

    // 4. SSRF subdomain / non-whitelisted path missing version header -> 403 (never 426)
    assert.strictEqual(
      (await sendHttp('/proxy/evil/ai/generate-image', 'POST', { 'Authorization': 'Bearer sec_v5_guest', 'X-Browser-Id': 'dev_v5_guest' }, {})).status,
      403
    );
    assert.strictEqual(
      (await sendHttp('/proxy/image/admin/secret', 'POST', { 'Authorization': 'Bearer sec_v5_guest', 'X-Browser-Id': 'dev_v5_guest' }, {})).status,
      403
    );

    // 5. Valid 6.0.0 client missing X-Gen-Model still gets 426 SCRIPT_UPDATE_REQUIRED
    const missingGenModelRes = await sendHttp('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer sec_v5_guest',
      'X-Browser-Id': 'dev_v5_guest',
      'X-Script-Version': '6.0.0'
    }, {});
    assert.strictEqual(missingGenModelRes.status, 426);
    assert.strictEqual(missingGenModelRes.data.error, 'SCRIPT_UPDATE_REQUIRED');

    // 6. Discord bot calls to /admin/* omitting X-Script-Version succeed (200 OK)
    const botDevicesRes = await sendHttp('/admin/devices', 'GET', { 'Authorization': 'Bearer version_gate_admin_key' });
    assert.strictEqual(botDevicesRes.status, 200);
    const botStatsRes = await sendHttp('/admin/global-stats', 'GET', { 'Authorization': 'Bearer version_gate_admin_key' });
    assert.strictEqual(botStatsRes.status, 200);
    const botBansRes = await sendHttp('/admin/unnotified-bans', 'GET', { 'Authorization': 'Bearer version_gate_admin_key' });
    assert.strictEqual(botBansRes.status, 200);

    // 7. Outdated Admin UserScript sending X-Script-Version: 5.0.0 or malformed header to /admin/* gets 426
    const oldAdminUi = await sendHttp('/admin/devices', 'GET', {
      'Authorization': 'Bearer version_gate_admin_key',
      'X-Script-Version': '5.0.0'
    });
    assert.strictEqual(oldAdminUi.status, 426);
    assert.strictEqual(oldAdminUi.data.error, 'SCRIPT_UPDATE_REQUIRED');

    const badAdminUi = await sendHttp('/admin/devices', 'GET', {
      'Authorization': 'Bearer version_gate_admin_key',
      'X-Script-Version': ''
    });
    assert.strictEqual(badAdminUi.status, 426);

    // 8. Admin UserScript sending 6.0.0 to /admin/* succeeds, while old Admin UserScript on /proxy/* gets 426
    assert.strictEqual(
      (await sendHttp('/admin/devices', 'GET', { 'Authorization': 'Bearer version_gate_admin_key', 'X-Script-Version': '6.0.0' })).status,
      200
    );
    assert.strictEqual(
      (await sendHttp('/proxy/image/user/subscription', 'GET', { 'Authorization': 'Bearer version_gate_admin_key', 'X-Browser-Id': 'b_admin_vg', 'X-Script-Version': '5.0.0' })).status,
      426
    );
  });
});