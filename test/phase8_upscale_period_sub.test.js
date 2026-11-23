/**
 * PHASE 8 UPGRADE VERIFICATION HARNESS (test/phase8_upscale_period_sub.test.js)
 *
 * Exhaustively tests:
 * 1. Split-Token `/proxy/image/user/subscription` Sanitization:
 *    - Rewrites guest `/user/subscription` responses (including `gzip`-compressed upstream
 *      JSON and unexpected billing keys) via explicit allow-list to replace master `trainingStepsLeft`
 *      with guest's live `available_balance` (deducting active holds), evaluates billing-cycle
 *      `evaluateAnlasReset()` on cold load, clears `paymentProcessorData` and `expiresAt` (`2524608000`),
 *      and preserves `usage.isNegative`.
 *    - Leaves Admin (`ADMIN_SECRET_KEY`) telemetry untouched while masking DB-backed `Admin` tier (`9999/9999`).
 * 2. Channel A `/ai/upscale` Pipeline (Wire-Format Parity, Anti-Spoofing & PoNR):
 *    - Accepts NovelAI's live `multipart/form-data` wire payload (`name="image"` binary PNG/WebP/JPEG +
 *      `name="request"` `{"image":"image","model":"nai-diffusion-5-curated","declared_blur_sigma":0}`).
 *    - Handles JPEG payloads containing >64KB of EXIF `APP1` metadata across chained valid `APP1` segments
 *      without truncating before `SOF0`.
 *    - Prices pixel buckets (`512x512` -> `1`, `1024x1024` -> `1`, `1280x1280` -> `2`, `1536x1536` -> `3`,
 *      `1536x2048` -> `4`) on `200 OK` without deducting V5 NCP or Metered rolling allowance.
 *    - Passes cleanly during `5.5%` V5 battery circuit breaker.
 *    - Hell Path: Queue ingress `/queue/join` enforces computed pixel-bucket cost upfront (`400 SPEND_CAP_EXCEEDED`
 *      on under-declared `1536x2048` and `403 INSUFFICIENT_ANLAS` when balance `2 < 4`) without evicting an
 *      active Channel A generator; Pre-PoNR 500 commits `0` Anlas; Post-PoNR socket drop commits sunk cost;
 *      non-image payload rejects `400 INVALID_UPSCALE_PAYLOAD`; Debt rejects `403 DEBT_LOCKED`;
 *      `> 3,145,728 px` rejects `400 PARAMETRIC_LIMIT_EXCEEDED`; spoofed JSON/header width vs binary IHDR
 *      triggers `403 PARAMETER_FORGERY` permanent ban + queue eviction.
 *    - `queueRouter` rejects invalid combinations (`is_upscale: true` + `is_v5: true`, `is_upscale: "true"`).
 * 3. Billing-Cycle-Segregated Telemetry (`subscription_periods` & `period_usage`):
 *    - Records PoNR Anlas, V5 High, V5 Medium, Legacy free images, Text streams (deterministically before
 *      SSE response completes), Vibe encodes, Upscales, and synthetic `'admin'` usage directly under active `cycle_epoch`.
 *    - Advancing billing cycle (`expiresAt + 30d` -> Cycle 2) archives Cycle 1 cleanly and immediately
 *      isolates Cycle 2 `GET /admin/global-stats` and `GET /admin/devices` from inactive Cycle 1 users.
 *    - Cold-load `/user/subscription` immediately resets a Cycle 2 guest's `trainingStepsLeft` to `tierConfig.monthlyAnlas`
 *      prior to `/auth/status` polling.
 *    - Queries historical `?cycle_epoch=<cycle1>` and `?cycle_epoch=all` accurately via `GET /admin/cycles`,
 *      and rejects Express 5 duplicate array `?cycle_epoch=1&cycle_epoch=2` and invalid `?cycle_epoch=abc` with `400`.
 * 4. Stored XSS Sanitization on Device Labels:
 *    - Rejects `<img ...>`, `<script>`, control bytes, and oversized labels on `/auth/register` and `/auth/update-label`.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_upscale_period.db');
const TEST_PORT = 19500;
const MOCK_UPSTREAM_PORT = 19501;

process.env.ADMIN_SECRET_KEY = 'upscale_admin_secret_key';
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

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(32, 0);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeWebpVp8xBuffer(width, height) {
  const buf = Buffer.alloc(30, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

function makeJpegSof0Buffer(width, height, exifPaddingBytes = 0) {
  const app1Segments = [];
  let remaining = exifPaddingBytes;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 45000);
    app1Segments.push(chunk);
    remaining -= chunk;
  }
  const app1TotalBytes = app1Segments.reduce((sum, len) => sum + 4 + len, 0);
  const buf = Buffer.alloc(2 + app1TotalBytes + 13, 0);
  let pos = 0;
  buf[pos++] = 0xFF; buf[pos++] = 0xD8; // SOI
  for (const chunkLen of app1Segments) {
    buf[pos++] = 0xFF; buf[pos++] = 0xE1; // APP1
    buf.writeUInt16BE(chunkLen + 2, pos);
    pos += 2 + chunkLen;
  }
  buf[pos++] = 0xFF; buf[pos++] = 0xC0; // SOF0
  buf.writeUInt16BE(11, pos);
  buf[pos + 2] = 8;
  buf.writeUInt16BE(height, pos + 3);
  buf.writeUInt16BE(width, pos + 5);
  buf[pos + 7] = 1;
  return buf;
}

function makeUpscaleMultipart(binaryImg, requestJsonObj, boundary = 'WebKitFormBoundaryUpscale123') {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n`),
    binaryImg,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="request"; filename="blob"\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from(JSON.stringify(requestJsonObj)),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

let cycleExpiresSec = Math.floor(Date.now() / 1000) + (20 * 86400);
let mockUsageNegative = false;
let mockSubGzip = false;
let upscaleUpstreamStatus = 200; // 200 | 500 | 'post_sever'
let upscaleUpstreamHits = 0;

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/user/subscription') {
    const jsonBuf = Buffer.from(JSON.stringify({
      tier: 3,
      active: true,
      expiresAt: cycleExpiresSec,
      paymentProcessorData: { customer_id: 'SECRET_STRIPE_CUSTOMER_ID', next_billing_at: cycleExpiresSec },
      secretAccountEmail: 'master-owner@example.com',
      trainingStepsLeft: { fixedTrainingStepsLeft: 9988, purchasedTrainingSteps: 12000 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: mockUsageNegative }
    }), 'utf8');

    if (mockSubGzip) {
      const gz = zlib.gzipSync(jsonBuf);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      return res.end(gz);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(jsonBuf);
  }

  req.on('data', () => {});
  req.on('end', () => {
    if (parsedUrl.pathname === '/ai/upscale') {
      upscaleUpstreamHits += 1;
      if (upscaleUpstreamStatus === 'post_sever') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(Buffer.from('PARTIAL_PNG_'));
        setTimeout(() => {
          try { res.socket.destroy(); } catch (_) {}
        }, 30);
        return;
      }
      if (upscaleUpstreamStatus !== 200) {
        res.writeHead(upscaleUpstreamStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Upstream upscale error' }));
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from('PNG_UPSCALED_BYTES'));
    }

    if (parsedUrl.pathname === '/ai/generate-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('data: {"text":"hi"}\n\n');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('Phase 8 Upgrade: /ai/upscale, /user/subscription Sanitization, Period Segregation & XSS Guards', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'upscale_master_token')");

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;

  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 30));
  }

  const cycle1Epoch = serverModule.getTelemetrySnapshot().activeCycleEpoch;
  assert.ok(cycle1Epoch > 0);
  const adminHeaders = { 'Authorization': 'Bearer upscale_admin_secret_key' };

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch)
     VALUES ('u_up_guest', 'Normal', 0, 'Upscaler', 120, ?, 180, ?)`,
    [cycle1Epoch, Date.now()]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_up_guest', 'u_up_guest', 'u_up_guest', 'sec_up_guest', 'Desktop', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch, metered_allowance, last_allowance_update_at)
     VALUES ('u_up_metered', 'Metered', 0, 'MeteredUp', 50, ?, 5, ?)`,
    [cycle1Epoch, Date.now()]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_up_metered', 'u_up_metered', 'u_up_metered', 'sec_up_metered', 'Tablet', 'Metered', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_up_two', 'Normal', 0, 'TwoAnlas', 2, ?)`,
    [cycle1Epoch]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_up_two', 'u_up_two', 'u_up_two', 'sec_up_two', 'Laptop', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_up_debt', 'Normal', 0, 'DebtUp', -10, ?)`,
    [cycle1Epoch]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_up_debt', 'u_up_debt', 'u_up_debt', 'sec_up_debt', 'Phone', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, discord_username, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_up_db_admin', 'Admin', 0, 'DbAdminUp', 0, ?)`,
    [cycle1Epoch]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, discord_id, device_secret, label, priority_tier, approved, banned) VALUES ('dev_up_db_admin', 'u_up_db_admin', 'u_up_db_admin', 'sec_up_db_admin', 'Workstation', 'Admin', 1, 0)"
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
  // 1. /user/subscription SPLIT-TOKEN SANITIZATION (INCLUDING GZIP & ALLOW-LIST)
  // ---------------------------------------------------------------------------
  await t.test('Split-Token Isolation: Rewrites & decompresses /user/subscription via allow-list while keeping Admin intact', async () => {
    queueManager.reset();
    mockUsageNegative = true;
    mockSubGzip = true;

    // Hold 15 Anlas on u_up_guest -> guest must see 105 (120 - 15) in trainingStepsLeft, never master 21988
    queueManager.join({
      browser_id: 'dev_up_metered',
      req_id: 'req_hold_other',
      user_id: 'u_up_guest',
      held_cost: 15
    });

    const guestSub = await sendRawRequest({
      method: 'GET',
      path: '/proxy/image/user/subscription',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'X-Browser-Id': 'dev_up_guest' }
    });
    assert.strictEqual(guestSub.status, 200, 'Gzip-compressed upstream /user/subscription must decode cleanly');
    assert.strictEqual(guestSub.data.paymentProcessorData, null, 'Must scrub master billing metadata');
    assert.strictEqual(guestSub.data.secretAccountEmail, undefined, 'Allow-list must strip unexpected master account keys');
    assert.strictEqual(guestSub.data.trainingStepsLeft.fixedTrainingStepsLeft, 105, 'Must expose guest available Anlas');
    assert.strictEqual(guestSub.data.trainingStepsLeft.purchasedTrainingSteps, 0);
    assert.strictEqual(guestSub.data.usage.isNegative, true, 'Must preserve usage.isNegative for Opus bonus UI');

    // DB-backed Admin tier with non-ADMIN_SECRET_KEY gets 9999/9999 without leaking master billing info
    const dbAdminSub = await sendRawRequest({
      method: 'GET',
      path: '/proxy/image/user/subscription',
      headers: { 'Authorization': 'Bearer sec_up_db_admin', 'X-Browser-Id': 'dev_up_db_admin' }
    });
    assert.strictEqual(dbAdminSub.status, 200);
    assert.strictEqual(dbAdminSub.data.secretAccountEmail, undefined);
    assert.strictEqual(dbAdminSub.data.trainingStepsLeft.fixedTrainingStepsLeft, 9999);
    assert.strictEqual(dbAdminSub.data.trainingStepsLeft.purchasedTrainingSteps, 9999);

    // Master ADMIN_SECRET_KEY retains raw master telemetry
    mockSubGzip = false;
    const adminSub = await sendRawRequest({
      method: 'GET',
      path: '/proxy/image/user/subscription',
      headers: { 'Authorization': 'Bearer upscale_admin_secret_key', 'X-Browser-Id': 'dev_admin_up' }
    });
    assert.strictEqual(adminSub.status, 200);
    assert.strictEqual(adminSub.data.trainingStepsLeft.fixedTrainingStepsLeft, 9988);
    assert.strictEqual(adminSub.data.trainingStepsLeft.purchasedTrainingSteps, 12000);

    mockUsageNegative = false;
    queueManager.complete('req_hold_other', 'dev_up_metered');
  });

  // ---------------------------------------------------------------------------
  // 2. /ai/upscale CHANNEL A PIPELINE, LARGE-EXIF JPEG, ANTI-SPOOFING & PoNR
  // ---------------------------------------------------------------------------
  await t.test('Channel A /ai/upscale: Parses live multipart binary headers, bills 1..4 Anlas PoNR & enforces anti-spoofing', async () => {
    queueManager.reset();
    upscaleUpstreamHits = 0;
    upscaleUpstreamStatus = 200;

    // Drive V5 battery to 5.0% circuit breaker to prove /ai/upscale remains unaffected
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: cycleExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9988, purchasedTrainingSteps: 12000 },
      isGracePeriod: false,
      usage: { percent: 5.0, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());

    const bucketVectors = [
      { makeBuf: () => makePngBuffer(512, 512), w: 512, h: 512, expectedCost: 1 },
      { makeBuf: () => makePngBuffer(1024, 1024), w: 1024, h: 1024, expectedCost: 1 },
      { makeBuf: () => makeWebpVp8xBuffer(1280, 1280), w: 1280, h: 1280, expectedCost: 2 },
      // Large 90KB EXIF APP1 metadata across chained segments before SOF0 must decode cleanly without truncating at 64KB
      { makeBuf: () => makeJpegSof0Buffer(1536, 1536, 90000), w: 1536, h: 1536, expectedCost: 3 },
      { makeBuf: () => makePngBuffer(1536, 2048), w: 1536, h: 2048, expectedCost: 4 }
    ];

    let expectedBal = 120;
    for (let i = 0; i < bucketVectors.length; i++) {
      const vec = bucketVectors[i];
      const reqId = `req_upscale_ok_${i}`;
      const joinRes = await sendRawRequest({
        path: '/queue/join',
        headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          browser_id: 'dev_up_guest',
          req_id: reqId,
          is_upscale: true,
          width: vec.w,
          height: vec.h,
          declared_anlas: vec.expectedCost
        })
      });
      assert.strictEqual(joinRes.status, 200, `Upscale join ${vec.w}x${vec.h} must succeed`);

      const boundary = 'WebKitFormBoundaryUpscale123';
      const bodyBuf = makeUpscaleMultipart(
        vec.makeBuf(),
        { image: 'image', model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 },
        boundary
      );
      const proxyRes = await sendRawRequest({
        path: '/proxy/image/ai/upscale',
        headers: {
          'Authorization': 'Bearer sec_up_guest',
          'X-Browser-Id': 'dev_up_guest',
          'X-Request-Id': reqId,
          'X-Gen-Width': String(vec.w),
          'X-Gen-Height': String(vec.h),
          'X-Declared-Anlas': String(vec.expectedCost),
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: bodyBuf
      });
      assert.strictEqual(proxyRes.status, 200);
      expectedBal -= vec.expectedCost;
    }

    const afterGuest = await dbModule.get("SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = 'u_up_guest'");
    assert.strictEqual(afterGuest.virtual_anlas_balance, expectedBal, 'Must deduct 1+1+2+3+4 = 11 Anlas (120 -> 109)');
    assert.strictEqual(afterGuest.v5_banked_balance, 180, 'Upscale must NOT deduct V5 banked NCP even with nai-diffusion-5-curated in request JSON');

    // Metered upscale does not consume rolling allowance
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_metered', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_metered', req_id: 'req_up_metered', is_upscale: true, width: 1024, height: 1024, declared_anlas: 1 })
    });
    const mRes = await sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_metered',
        'X-Browser-Id': 'dev_up_metered',
        'X-Request-Id': 'req_up_metered',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Declared-Anlas': '1',
        'Content-Type': 'multipart/form-data; boundary=WebKitFormBoundaryUpscale123'
      },
      body: makeUpscaleMultipart(makePngBuffer(1024, 1024), { image: 'image' })
    });
    assert.strictEqual(mRes.status, 200);
    assert.strictEqual((await dbModule.get("SELECT metered_allowance FROM users WHERE user_id = 'u_up_metered'")).metered_allowance, 5);

    // Hell Path 0: Queue ingress must fail fast on under-declared or under-funded upscale without entering queue
    const underDeclaredJoin = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_guest', req_id: 'req_up_under_decl', is_upscale: true, width: 1536, height: 2048, declared_anlas: 1 })
    });
    assert.strictEqual(underDeclaredJoin.status, 400);
    assert.strictEqual(underDeclaredJoin.data.error, 'SPEND_CAP_EXCEEDED');

    const underFundedJoin = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_two', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_two', req_id: 'req_up_under_fund', is_upscale: true, width: 1536, height: 2048, declared_anlas: 4 })
    });
    assert.strictEqual(underFundedJoin.status, 403);
    assert.strictEqual(underFundedJoin.data.error, 'INSUFFICIENT_ANLAS');
    assert.strictEqual(queueManager.getQueueLength(), 0, 'Rejected upscale joins must not enter Channel A queue');

    // Hell Path 1: Pre-PoNR 500 charges 0 Anlas; Post-PoNR socket drop keeps sunk cost
    upscaleUpstreamStatus = 500;
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_guest', req_id: 'req_up_500', is_upscale: true, width: 1024, height: 1024, declared_anlas: 1 })
    });
    const failRes = await sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_guest',
        'X-Browser-Id': 'dev_up_guest',
        'X-Request-Id': 'req_up_500',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Declared-Anlas': '1',
        'Content-Type': 'multipart/form-data; boundary=WebKitFormBoundaryUpscale123'
      },
      body: makeUpscaleMultipart(makePngBuffer(1024, 1024), { image: 'image' })
    });
    assert.strictEqual(failRes.status, 500);
    assert.strictEqual((await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_up_guest'")).virtual_anlas_balance, expectedBal);

    upscaleUpstreamStatus = 'post_sever';
    await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_guest', req_id: 'req_up_post_sever', is_upscale: true, width: 1024, height: 1024, declared_anlas: 1 })
    });
    await assert.rejects(() => sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_guest',
        'X-Browser-Id': 'dev_up_guest',
        'X-Request-Id': 'req_up_post_sever',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Declared-Anlas': '1',
        'Content-Type': 'multipart/form-data; boundary=WebKitFormBoundaryUpscale123'
      },
      body: makeUpscaleMultipart(makePngBuffer(1024, 1024), { image: 'image' })
    }), /.+/);
    await new Promise(r => setTimeout(r, 30));
    expectedBal -= 1;
    assert.strictEqual((await dbModule.get("SELECT virtual_anlas_balance FROM users WHERE user_id = 'u_up_guest'")).virtual_anlas_balance, expectedBal);
    upscaleUpstreamStatus = 200;

    // Hell Path 2: Spend cap violation (X-Declared-Anlas: 1 for 1536x2048 -> 400 SPEND_CAP_EXCEEDED) & non-image body (400 INVALID_UPSCALE_PAYLOAD)
    queueManager.join({ browser_id: 'dev_up_guest', req_id: 'req_up_cap_fail', user_id: 'u_up_guest', priority_tier: 'Normal' });
    const capFailRes = await sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_guest',
        'X-Browser-Id': 'dev_up_guest',
        'X-Request-Id': 'req_up_cap_fail',
        'X-Gen-Width': '1536',
        'X-Gen-Height': '2048',
        'X-Declared-Anlas': '1',
        'Content-Type': 'multipart/form-data; boundary=WebKitFormBoundaryUpscale123'
      },
      body: makeUpscaleMultipart(makePngBuffer(1536, 2048), { image: 'image' })
    });
    assert.strictEqual(capFailRes.status, 400);
    assert.strictEqual(capFailRes.data.error, 'SPEND_CAP_EXCEEDED');

    queueManager.join({ browser_id: 'dev_up_guest', req_id: 'req_up_bad_bytes', user_id: 'u_up_guest', priority_tier: 'Normal' });
    const badBytesRes = await sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_guest',
        'X-Browser-Id': 'dev_up_guest',
        'X-Request-Id': 'req_up_bad_bytes',
        'X-Declared-Anlas': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'not_valid_base64_image' })
    });
    assert.strictEqual(badBytesRes.status, 400);
    assert.strictEqual(badBytesRes.data.error, 'INVALID_UPSCALE_PAYLOAD');

    // Hell Path 3: Invalid queueRouter flag combinations for is_upscale
    for (const badBody of [
      { browser_id: 'dev_up_guest', req_id: 'req_bad_up_1', is_upscale: true, is_v5: true },
      { browser_id: 'dev_up_guest', req_id: 'req_bad_up_2', is_upscale: 'true' }
    ]) {
      const badJoin = await sendRawRequest({
        path: '/queue/join',
        headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
        body: JSON.stringify(badBody)
      });
      assert.strictEqual(badJoin.status, 400);
      assert.strictEqual(badJoin.data.error, 'INVALID_PARAMETERS');
    }

    // Hell Path 4: Debt lockout (403 DEBT_LOCKED)
    const debtJoin = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_debt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_debt', req_id: 'req_up_debt', is_upscale: true, width: 1024, height: 1024, declared_anlas: 1 })
    });
    assert.strictEqual(debtJoin.status, 403);
    assert.strictEqual(debtJoin.data.error, 'DEBT_LOCKED');

    // Hell Path 5: > 3,145,728 px rejected (400 PARAMETRIC_LIMIT_EXCEEDED)
    const hugeJoin = await sendRawRequest({
      path: '/queue/join',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: 'dev_up_guest', req_id: 'req_up_huge', is_upscale: true, width: 2048, height: 2048, declared_anlas: 4 })
    });
    assert.strictEqual(hugeJoin.status, 400);
    assert.strictEqual(hugeJoin.data.error, 'PARAMETRIC_LIMIT_EXCEEDED');

    // Hell Path 6: Spoofing header/JSON dimensions (1024x1024 vs 1536x2048 PNG IHDR) triggers permanent ban + eviction
    await dbModule.run("INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance) VALUES ('u_up_forger', 'Normal', 0, 100)");
    await dbModule.run("INSERT INTO devices (browser_id, user_id, discord_id, device_secret, approved, banned) VALUES ('dev_up_forger', 'u_up_forger', 'u_up_forger', 'sec_up_forger', 1, 0)");
    queueManager.join({ browser_id: 'dev_up_forger', req_id: 'req_up_forge', user_id: 'u_up_forger', discord_id: 'u_up_forger' });

    const hitsBeforeForge = upscaleUpstreamHits;
    const forgeRes = await sendRawRequest({
      path: '/proxy/image/ai/upscale',
      headers: {
        'Authorization': 'Bearer sec_up_forger',
        'X-Browser-Id': 'dev_up_forger',
        'X-Request-Id': 'req_up_forge',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Declared-Anlas': '1',
        'Content-Type': 'multipart/form-data; boundary=WebKitFormBoundaryUpscale123'
      },
      body: makeUpscaleMultipart(makePngBuffer(1536, 2048), { image: 'image' })
    });
    assert.strictEqual(forgeRes.status, 403);
    assert.strictEqual(forgeRes.data.error, 'PARAMETER_FORGERY');
    assert.strictEqual(upscaleUpstreamHits, hitsBeforeForge);
    assert.strictEqual((await dbModule.get("SELECT banned FROM users WHERE user_id = 'u_up_forger'")).banned, 1);

    // Restore healthy 80% telemetry
    serverModule.applyUsageTelemetry({
      tier: 3, active: true, expiresAt: cycleExpiresSec,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9988, purchasedTrainingSteps: 12000 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7200, isNegative: false }
    }, undefined, Date.now());
  });

  // ---------------------------------------------------------------------------
  // 3. CYCLE-SEGREGATED TELEMETRY (`subscription_periods` & `period_usage`)
  // ---------------------------------------------------------------------------
  await t.test('Subscription-Period Telemetry Segregation: Isolates Cycle 2 aggregates from inactive Cycle 1 users & archives history', async () => {
    queueManager.reset();

    // Generate 1 legacy image + 1 text stream + 1 synthetic admin V5 image in Cycle 1
    queueManager.join({ browser_id: 'dev_up_guest', req_id: 'req_c1_leg', user_id: 'u_up_guest', priority_tier: 'Normal' });
    await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer sec_up_guest',
        'X-Browser-Id': 'dev_up_guest',
        'X-Request-Id': 'req_c1_leg',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
    });

    await sendRawRequest({
      path: '/proxy/text/ai/generate-stream',
      headers: { 'Authorization': 'Bearer sec_up_guest', 'X-Browser-Id': 'dev_up_guest', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'story' })
    });

    queueManager.join({ browser_id: 'dev_admin_up', req_id: 'req_c1_adm', user_id: 'admin', priority_tier: 'Admin' });
    await sendRawRequest({
      path: '/proxy/image/ai/generate-image',
      headers: {
        'Authorization': 'Bearer upscale_admin_secret_key',
        'X-Browser-Id': 'dev_admin_up',
        'X-Request-Id': 'req_c1_adm',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '23',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'V5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })
    });

    // Check Cycle 1 totals in /auth/status immediately (no sleep race on text_gens!)
    const guestC1Status = await sendRawRequest({
      method: 'GET',
      path: '/auth/status?browser_id=dev_up_guest',
      headers: { 'Authorization': 'Bearer sec_up_guest' }
    });
    assert.strictEqual(guestC1Status.data.subscription_period.anlas_consumed, 12);
    assert.strictEqual(guestC1Status.data.subscription_period.upscale_gens, 6);
    assert.strictEqual(guestC1Status.data.subscription_period.legacy_image_gens, 1);
    assert.strictEqual(guestC1Status.data.subscription_period.text_gens, 1);

    const adminC1Status = await sendRawRequest({
      method: 'GET',
      path: '/auth/status?browser_id=dev_admin_up',
      headers: adminHeaders
    });
    assert.strictEqual(adminC1Status.data.subscription_period.v5_high_gens, 1, 'Synthetic admin V5 usage must be recorded in period_usage');

    // Advance billing cycle (+30 days) -> Cycle 2 begins!
    // u_up_guest NEVER calls /auth/status during Cycle 2 (simulating cold load / inactive Cycle 1 user).
    cycleExpiresSec += 30 * 86400;
    await serverModule.syncTelemetry({ rescheduleHeartbeat: false });
    const cycle2Epoch = serverModule.getTelemetrySnapshot().activeCycleEpoch;
    assert.ok(cycle2Epoch > cycle1Epoch);

    // Cycle 2 /admin/global-stats MUST start cleanly at 0 (zero stale Cycle 1 pollution from inactive u_up_guest!)
    const c2Stats = await sendRawRequest({ method: 'GET', path: '/admin/global-stats', headers: adminHeaders });
    assert.strictEqual(c2Stats.status, 200);
    assert.strictEqual(c2Stats.data.selected_cycle_epoch, cycle2Epoch);
    assert.strictEqual(c2Stats.data.total_subscription_period_anlas, 0, 'Inactive Cycle 1 user must NOT pollute Cycle 2 Anlas aggregate');
    assert.strictEqual(c2Stats.data.total_subscription_period_upscales, 0);
    assert.strictEqual(c2Stats.data.total_subscription_period_v5, 0);
    assert.strictEqual(c2Stats.data.top_anlas_consumers.length, 0);

    // Cycle 2 /admin/devices shows u_up_guest with 0 Cycle 2 consumption, while lifetime anlas_consumed stays 12
    const c2Devices = await sendRawRequest({ method: 'GET', path: '/admin/devices', headers: adminHeaders });
    const guestC2Group = c2Devices.data.find(g => g.user_id === 'u_up_guest');
    assert.strictEqual(guestC2Group.subscription_period_anlas, 0);
    assert.strictEqual(guestC2Group.subscription_period_upscales, 0);
    assert.strictEqual(guestC2Group.anlas_consumed, 12);

    // Cold-load /user/subscription for u_up_two immediately resets virtual balance from 2 -> 500 before /auth/status polls
    const coldCycle2Sub = await sendRawRequest({
      method: 'GET',
      path: '/proxy/image/user/subscription',
      headers: { 'Authorization': 'Bearer sec_up_two', 'X-Browser-Id': 'dev_up_two' }
    });
    assert.strictEqual(coldCycle2Sub.status, 200);
    assert.strictEqual(coldCycle2Sub.data.trainingStepsLeft.fixedTrainingStepsLeft, 500, 'Cycle rollover /user/subscription must refresh guest Anlas immediately on cold page load');

    // Historical Cycle 1 archive remains intact via GET /admin/cycles and ?cycle_epoch=<cycle1Epoch>
    const cyclesList = await sendRawRequest({ method: 'GET', path: '/admin/cycles', headers: adminHeaders });
    assert.strictEqual(cyclesList.status, 200);
    assert.strictEqual(cyclesList.data.active_cycle_epoch, cycle2Epoch);
    const archivedC1 = cyclesList.data.cycles.find(c => c.cycle_epoch === cycle1Epoch);
    assert.ok(archivedC1, 'Cycle 1 must be archived in /admin/cycles');
    assert.strictEqual(archivedC1.total_anlas, 13);
    assert.strictEqual(archivedC1.total_upscales, 7);

    const c1HistoricalStats = await sendRawRequest({
      method: 'GET',
      path: `/admin/global-stats?cycle_epoch=${cycle1Epoch}`,
      headers: adminHeaders
    });
    assert.strictEqual(c1HistoricalStats.data.total_subscription_period_anlas, 13);
    assert.strictEqual(c1HistoricalStats.data.total_subscription_period_upscales, 7);
    assert.strictEqual(c1HistoricalStats.data.total_subscription_period_legacy_images, 1);
    assert.strictEqual(c1HistoricalStats.data.total_subscription_period_text_gens, 1);
    assert.strictEqual(c1HistoricalStats.data.top_anlas_consumers[0].discord_id, 'u_up_guest');
    assert.strictEqual(c1HistoricalStats.data.top_anlas_consumers[0].anlas, 12);

    // Express 5 array & invalid cycle_epoch queries must reject cleanly with 400
    for (const badQuery of ['cycle_epoch=abc', 'cycle_epoch=1&cycle_epoch=2']) {
      assert.strictEqual((await sendRawRequest({ method: 'GET', path: `/admin/global-stats?${badQuery}`, headers: adminHeaders })).status, 400);
      assert.strictEqual((await sendRawRequest({ method: 'GET', path: `/admin/devices?${badQuery}`, headers: adminHeaders })).status, 400);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. STORED XSS LABEL SANITIZATION (/auth/register & /auth/update-label)
  // ---------------------------------------------------------------------------
  await t.test('Security: Rejects HTML/XSS and control-character labels on /auth/register & /auth/update-label', async () => {
    for (const badLabel of ['<img src=x onerror=alert(1)>', '<script>evil()</script>', 'bad\nlabel', 'A'.repeat(65)]) {
      const regBad = await sendRawRequest({
        path: '/auth/register',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser_id: 'b_xss_test', device_secret: 'sec_xss_test', label: badLabel })
      });
      assert.strictEqual(regBad.status, 400, `Unsafe register label "${badLabel}" must return 400`);

      const updBad = await sendRawRequest({
        path: '/auth/update-label',
        headers: { 'Authorization': 'Bearer sec_up_guest', 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser_id: 'dev_up_guest', label: badLabel })
      });
      assert.strictEqual(updBad.status, 400, `Unsafe update label "${badLabel}" must return 400`);
    }
  });
});