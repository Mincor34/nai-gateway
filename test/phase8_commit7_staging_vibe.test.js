/**
 * PHASE 8 COMMIT 7 VERIFICATION HARNESS (test/phase8_commit7_staging_vibe.test.js)
 *
 * Exhaustively tests:
 * 1. Happy Path: Channel B `/ai/encode-vibe` Pipeline & 2-Anlas PoNR Settlement:
 *    - Multipart (`name="image"`, no `name="request"`), JSON (`{ image }`), and raw PNG binary streams
 *      bypass generation parameter extraction, claim Channel B slots with 2-Anlas holds,
 *      forward master Authorization + recalculated Content-Length, commit 2 Anlas on HTTP 200 OK
 *      (updating virtual_anlas_balance, subscription_period_anlas, anlas_consumed, and linked devices),
 *      and clear in-memory holds immediately without blocking Channel A.
 * 2. Hell Path: Invalid / Empty / Non-Image Vibe Payloads (`400 INVALID_VIBE_PAYLOAD`):
 *    - Empty payload (`0` bytes), JSON missing `image` (`{"prompt":"x"}`), multipart missing
 *      non-empty `image` part, and plain arbitrary text return `400 INVALID_VIBE_PAYLOAD` with
 *      0 upstream hits, 0 Anlas charged, and Channel B slot/hold + staging semaphore released.
 * 3. Hell Path: Pre-PoNR vs. Post-PoNR Failure Accounting on `/ai/encode-vibe`:
 *    - Pre-PoNR upstream HTTP 500 and pre-header socket sever (`502`) release 2-Anlas hold with 0 debit.
 *    - Post-PoNR mid-stream socket sever *after* upstream HTTP 200 commits 2 Anlas as sunk cost
 *      while freeing the Channel B slot and hold.
 * 4. Hell Path: Slowloris Ingress Starvation, Staging Semaphore (`429`) & Upload Deadlines (`408`):
 *    - Two concurrent active uploads occupy `INGRESS_SEMAPHORE_MAX` (2); 3rd upload immediately fails
 *      with `429 UPLOAD_PIPELINE_SATURATED`, releases any claimed lock, and never touches upstream.
 *    - Bodyless `GET /proxy/image/user/subscription` (including explicit `Content-Length: 0`)
 *      bypasses upload semaphore cleanly even while both upload slots are saturated.
 *    - Stalled upload exceeding `UPLOAD_INACTIVITY_TIMEOUT_MS` receives `408 UPLOAD_INACTIVITY_TIMEOUT`,
 *      destroys socket, and releases staging slot + Channel B/A locks cleanly.
 *    - Continuous trickle upload beating inactivity timeout past `UPLOAD_DURATION_CEILING_MS` receives
 *      `408 UPLOAD_DURATION_EXCEEDED`, destroys socket, and releases staging slot + locks cleanly.
 * 5. Hell Path: Client Abort During Async `await` (`ensureFresh` / DB):
 *    - Aborting client sockets mid-`await` never leaks `activeBufferingStreams`, Channel B slots,
 *      or in-memory Anlas holds, leaving the staging semaphore un-wedged for subsequent requests.
 * 6. Hell Path: Cross-Channel Holds, Concurrent Double-Spend & Commit Races, Header Collisions, Debt Lockout & Master Solvency:
 *    - User with 3 Anlas balance and 2 Anlas Channel A hold (`available = 1`) rejected (`403 INSUFFICIENT_ANLAS`).
 *    - Two concurrent `/ai/encode-vibe` requests on a 2-Anlas account admit strictly 1 and reject 1 (`403`).
 *    - Concurrent `commitAnlasDebit` completion racing two incoming `/ai/encode-vibe` requests on a 4-Anlas
 *      account serializes via per-user auth gate without stale-balance double-spending (`virtual_balance >= 0`).
 *    - Client-supplied colliding or whitespace `X-Request-Id` headers on Channel B (`/ai/encode-vibe` and
 *      `/ai/generate-stream`) do not collide or trigger bogus `429 CHANNEL_B_SATURATED`.
 *    - User in negative debt (`-10`) rejected (`403 DEBT_LOCKED`).
 *    - Grace period freezes 30-day fallback reset (`403 DEBT_LOCKED`); inactive subscription (`503`)
 *      and depleted master Anlas (`masterAnlas = 1 < 2` -> `503 MASTER_ANLAS_DEPLETED`) fail closed.
 *    - Channel B 3-slot cap enforces `429 CHANNEL_B_SATURATED` across mixed text + vibe traffic.
 * 7. Hell Path: Channel A Upload Latency `reanchorProcessingTimestamp` & Mid-Upload Eviction Guard:
 *    - Multi-chunk Channel A upload advances `started_processing_at` at `req.on('end')`.
 *    - Evicting a Channel A task mid-upload causes `req.on('end')` to reject with `403` and 0 upstream hits.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit7.db');
const TEST_PORT = 17000;
const MOCK_UPSTREAM_PORT = 17001;

process.env.ADMIN_SECRET_KEY = 'commit7_admin_secret_key';
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

let vibeUpstreamMode = 'ok'; // 'ok' | 'delay_ok' | '500' | 'pre_sever' | 'post_sever'
let vibeUpstreamDelayMs = 0;
let subUpstreamDelayMs = 0;
let imageUpstreamDelayMs = 0;
let vibeUpstreamHits = 0;
let imageUpstreamHits = 0;
let lastUpstreamHeaders = null;
let lastUpstreamBody = Buffer.alloc(0);

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/user/subscription') {
    const sendSub = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(upstreamSubscriptionPayload));
    };
    if (subUpstreamDelayMs > 0) {
      setTimeout(sendSub, subUpstreamDelayMs);
    } else {
      sendSub();
    }
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    lastUpstreamHeaders = req.headers;
    lastUpstreamBody = Buffer.concat(chunks);

    if (parsedUrl.pathname === '/ai/encode-vibe') {
      vibeUpstreamHits += 1;

      if (vibeUpstreamMode === 'pre_sever') {
        res.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n');
        res.socket.destroy();
        return;
      }

      if (vibeUpstreamMode === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Upstream vibe error' }));
      }

      if (vibeUpstreamMode === 'post_sever') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write(Buffer.from('PARTIAL_VIBE_VECTOR_'));
        setTimeout(() => {
          try { res.socket.destroy(); } catch (_) {}
        }, 40);
        return;
      }

      const sendOk = () => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from('VIBE_VECTOR_OK'));
      };

      if (vibeUpstreamMode === 'delay_ok' && vibeUpstreamDelayMs > 0) {
        setTimeout(sendOk, vibeUpstreamDelayMs);
      } else {
        sendOk();
      }
      return;
    }

    if (parsedUrl.pathname === '/ai/generate-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => {
        res.end('data: {"text":"ok"}\n\n');
      }, 250);
      return;
    }

    imageUpstreamHits += 1;
    const finishImg = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    if (imageUpstreamDelayMs > 0) {
      setTimeout(finishImg, imageUpstreamDelayMs);
    } else {
      finishImg();
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

test('Phase 8 Commit 7: Ingress Staging Semaphore, Upload Deadlines & Channel B Vibe Pipeline', async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  const now = Date.now();
  await dbModule.run("INSERT OR REPLACE INTO config (key, value) VALUES ('master_token', 'commit7_master_token')");

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, anlas_consumed, subscription_period_anlas)
     VALUES ('u_vibe', 'Normal', 0, 100, ?, 0, 0)`,
    [now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned, anlas_consumed) VALUES ('dev_vibe', 'u_vibe', 'sec_vibe', 'Normal', 1, 0, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_exact2', 'Normal', 0, 2, ?)`,
    [now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_exact2', 'u_exact2', 'sec_exact2', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_exact4', 'Normal', 0, 4, ?)`,
    [now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_exact4', 'u_exact4', 'sec_exact4', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_three', 'Normal', 0, 3, ?)`,
    [now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_three', 'u_three', 'sec_three', 'Normal', 1, 0)"
  );

  await dbModule.run(
    `INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch)
     VALUES ('u_debt7', 'Normal', 0, -10, ?)`,
    [now]
  );
  await dbModule.run(
    "INSERT INTO devices (browser_id, user_id, device_secret, priority_tier, approved, banned) VALUES ('dev_debt7', 'u_debt7', 'sec_debt7', 'Normal', 1, 0)"
  );

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;
  const proxyRouter = require('../routes/proxyRouter');
  const auditEngine = require('../auditEngine');

  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 30));
  }

  // Anchor seeded users to the post-boot active billing cycle epoch so initial requests
  // evaluate exact seeded virtual balances instead of triggering a first-cycle reset.
  const bootSnap = serverModule.getTelemetrySnapshot();
  assert.ok(bootSnap.activeCycleEpoch > 0, 'Warm boot must seed activeCycleEpoch');
  await dbModule.run('UPDATE users SET last_anlas_reset_epoch = ?', [bootSnap.activeCycleEpoch]);

  t.after(async () => {
    delete process.env.UPLOAD_INACTIVITY_TIMEOUT_MS;
    delete process.env.UPLOAD_DURATION_CEILING_MS;
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await new Promise(r => mockUpstream.close(r));
    await dbModule.closeDatabase();
    cleanupFiles();
  });

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH: CHANNEL B `/ai/encode-vibe` ACROSS MULTIPART, JSON & BINARY
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Processes /ai/encode-vibe across multipart, JSON, and raw PNG, commits 2 Anlas PoNR, and frees Channel A', async () => {
    queueManager.reset();
    vibeUpstreamHits = 0;
    vibeUpstreamMode = 'delay_ok';
    vibeUpstreamDelayMs = 150;

    // Hold Channel A with another task to verify Channel B vibe encode runs completely unblocked
    queueManager.join({
      browser_id: 'dev_three',
      req_id: 'req_chan_a_busy',
      user_id: 'u_three',
      priority_tier: 'Normal'
    });

    // A. Multipart payload with name="image" and NO name="request" (with hold verification mid-flight)
    const boundary = 'vibe_multipart_777';
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="vibe.png"\r\nContent-Type: image/png\r\n\r\n`),
      pngHeader,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const reqPromise = sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: multipartBody
    });

    // Mid-flight inspection while upstream is sleeping 150ms
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(queueManager.getActiveTextGenerations(), 1, 'Vibe encode must occupy 1 Channel B slot');
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 2, 'In-memory 2 Anlas hold must be active mid-flight');

    const resMultipart = await reqPromise;
    assert.strictEqual(resMultipart.status, 200);
    assert.strictEqual(resMultipart.raw.toString('utf8'), 'VIBE_VECTOR_OK');
    assert.strictEqual(lastUpstreamHeaders['authorization'], 'Bearer commit7_master_token');
    assert.strictEqual(parseInt(lastUpstreamHeaders['content-length'], 10), multipartBody.length);
    assert.strictEqual(Buffer.compare(lastUpstreamBody, multipartBody), 0);

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0, 'Channel B slot must be released on completion');
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0, '2 Anlas hold must be cleared after PoNR commit');

    let userRow = await dbModule.get('SELECT virtual_anlas_balance, subscription_period_anlas, anlas_consumed FROM users WHERE user_id = ?', ['u_vibe']);
    let devRow = await dbModule.get('SELECT virtual_anlas_balance, anlas_consumed FROM devices WHERE browser_id = ?', ['dev_vibe']);
    assert.strictEqual(userRow.virtual_anlas_balance, 98, 'Multipart vibe encode must commit 2 Anlas debit on HTTP 200');
    assert.strictEqual(userRow.subscription_period_anlas, 2);
    assert.strictEqual(userRow.anlas_consumed, 2);
    assert.strictEqual(devRow.virtual_anlas_balance, 98);
    assert.strictEqual(devRow.anlas_consumed, 2);

    // B. JSON vibe payload ({ image, information_extracted, model })
    vibeUpstreamMode = 'ok';
    const jsonBody = Buffer.from(JSON.stringify({
      image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
      information_extracted: 1.0,
      model: 'nai-diffusion-4-5-full'
    }));
    const resJson = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: jsonBody
    });
    assert.strictEqual(resJson.status, 200);

    userRow = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe']);
    assert.strictEqual(userRow.virtual_anlas_balance, 96, 'JSON vibe encode must commit 2 Anlas debit');

    // C. Raw binary PNG payload with embedded deceptive generation parameters (schema collision check)
    const deceptiveRawPng = Buffer.concat([
      pngHeader,
      Buffer.from('name="request"\r\n\r\n{"model":"nai-diffusion-5-full","parameters":{"steps":999,"width":4096,"height":4096}}')
    ]);
    const resRawBinary = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/octet-stream'
      },
      body: deceptiveRawPng
    });
    assert.strictEqual(resRawBinary.status, 200, 'Raw binary vibe transfer must bypass generation parameter extraction');

    userRow = await dbModule.get('SELECT virtual_anlas_balance, banned FROM users WHERE user_id = ?', ['u_vibe']);
    assert.strictEqual(userRow.virtual_anlas_balance, 94);
    assert.strictEqual(userRow.banned, 0, 'Vibe payload must never trigger generation firewall bans');
    assert.strictEqual(vibeUpstreamHits, 3);
    assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0);

    queueManager.complete('req_chan_a_busy', 'dev_three');
  });

  // ---------------------------------------------------------------------------
  // 2. HELL PATH: INVALID VIBE PAYLOADS (`400 INVALID_VIBE_PAYLOAD`)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Invalid / empty / non-image vibe payloads fail with 400 and 0 Anlas debit', async () => {
    queueManager.reset();
    vibeUpstreamHits = 0;
    const beforeBal = (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance;

    // 1. Empty payload (0 bytes)
    const emptyRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/octet-stream'
      },
      body: Buffer.alloc(0)
    });
    assert.strictEqual(emptyRes.status, 400);
    assert.strictEqual(emptyRes.data.error, 'INVALID_VIBE_PAYLOAD');

    // 2. JSON without image field
    const jsonNoImgRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: 'missing image field' })
    });
    assert.strictEqual(jsonNoImgRes.status, 400);
    assert.strictEqual(jsonNoImgRes.data.error, 'INVALID_VIBE_PAYLOAD');

    // 3. Multipart missing non-empty image part (only has name="request" or empty name="image")
    const boundary = 'empty_vibe_part_boundary';
    const emptyPartMultipart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="empty.png"\r\nContent-Type: image/png\r\n\r\n\r\n--${boundary}--\r\n`
    );
    const multipartEmptyRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: emptyPartMultipart
    });
    assert.strictEqual(multipartEmptyRes.status, 400);
    assert.strictEqual(multipartEmptyRes.data.error, 'INVALID_VIBE_PAYLOAD');

    // 4. Plain non-image text
    const plainTextRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'text/plain'
      },
      body: 'not an image binary'
    });
    assert.strictEqual(plainTextRes.status, 400);
    assert.strictEqual(plainTextRes.data.error, 'INVALID_VIBE_PAYLOAD');

    const afterBal = (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance;
    assert.strictEqual(afterBal, beforeBal, 'Invalid vibe payloads must incur 0 Anlas debit');
    assert.strictEqual(vibeUpstreamHits, 0, 'Invalid vibe payloads must never reach upstream');
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0);
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0);
    assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0);
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: PRE-PoNR VS. POST-PoNR FAILURE ACCOUNTING ON `/ai/encode-vibe`
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Pre-PoNR failures release hold with 0 debit; Post-PoNR drops commit sunk cost', async () => {
    queueManager.reset();
    const startBal = (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance;
    const validBody = JSON.stringify({ image: 'base64_vibe_data_abc' });

    // 1. Pre-PoNR HTTP 500 from upstream -> 0 Anlas debit, hold released
    vibeUpstreamMode = '500';
    const err500Res = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: validBody
    });
    assert.strictEqual(err500Res.status, 500);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(
      (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance,
      startBal,
      'Upstream 500 must deduct 0 Anlas'
    );
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0);
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0);

    // 2. Pre-PoNR socket sever before headers finish -> 502, 0 Anlas debit, hold released
    vibeUpstreamMode = 'pre_sever';
    const severRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: validBody
    });
    assert.strictEqual(severRes.status, 502);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(
      (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance,
      startBal,
      'Pre-PoNR upstream socket sever must deduct 0 Anlas'
    );
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0);
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0);

    // 3. Post-PoNR mid-stream sever *after* HTTP 200 -> 2 Anlas debit stands as sunk cost
    vibeUpstreamMode = 'post_sever';
    await assert.rejects(
      () => sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'Content-Type': 'application/json'
        },
        body: validBody
      }),
      /.+/
    );
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(
      (await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_vibe'])).virtual_anlas_balance,
      startBal - 2,
      'Post-PoNR socket drop after HTTP 200 must keep 2 Anlas sunk-cost debit'
    );
    assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0);
    assert.strictEqual(queueManager.getActiveTextGenerations(), 0);

    vibeUpstreamMode = 'ok';
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: SLOWLORIS INGRESS STARVATION, SEMAPHORE (429) & UPLOAD DEADLINES (408)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces 2-slot staging semaphore (429), bodyless GET bypass, inactivity timeout (408) & duration ceiling (408)', async () => {
    queueManager.reset();
    vibeUpstreamHits = 0;
    vibeUpstreamMode = 'ok';

    // Keep inactivity timeout long during concurrent saturation subtest
    process.env.UPLOAD_INACTIVITY_TIMEOUT_MS = '3000';
    process.env.UPLOAD_DURATION_CEILING_MS = '5000';

    try {
      // Open 2 stalled uploads (transfer-encoding chunked without ending) to saturate INGRESS_SEMAPHORE_MAX = 2
      const stalledReq1 = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/proxy/image/ai/encode-vibe',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        }
      });
      stalledReq1.on('error', () => {});
      stalledReq1.write('{"image":');

      const stalledReq2 = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/proxy/text/ai/generate-stream',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer sec_three',
          'X-Browser-Id': 'dev_three',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        }
      });
      stalledReq2.on('error', () => {});
      stalledReq2.write('{"prompt":');

      await new Promise(r => setTimeout(r, 80));
      assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 2, 'Two concurrent stalled uploads must fill staging semaphore');

      // 3rd upload MUST be rejected immediately with 429 UPLOAD_PIPELINE_SATURATED and leave its lock unstranded
      const thirdRes = await sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact2',
          'X-Browser-Id': 'dev_exact2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'abc' })
      });
      assert.strictEqual(thirdRes.status, 429);
      assert.strictEqual(thirdRes.data.error, 'UPLOAD_PIPELINE_SATURATED');
      assert.strictEqual(queueManager.getHeldAnlasForUser('u_exact2'), 0, 'Rejected 429 upload must not strand 2 Anlas hold');
      assert.strictEqual(vibeUpstreamHits, 0);

      // Bodyless GET /user/subscription MUST still succeed even while upload semaphore is saturated
      const subGetRes = await sendRawRequest({
        method: 'GET',
        path: '/proxy/image/user/subscription',
        headers: {
          'Authorization': 'Bearer sec_exact2',
          'X-Browser-Id': 'dev_exact2'
        }
      });
      assert.strictEqual(subGetRes.status, 200, 'Bodyless GET telemetry must bypass upload staging semaphore');

      // Explicit Content-Length: 0 on GET must also bypass upload staging semaphore
      const subGetZeroLenRes = await sendRawRequest({
        method: 'GET',
        path: '/proxy/image/user/subscription',
        headers: {
          'Authorization': 'Bearer sec_exact2',
          'X-Browser-Id': 'dev_exact2',
          'Content-Length': '0'
        }
      });
      assert.strictEqual(subGetZeroLenRes.status, 200, 'Bodyless GET with Content-Length: 0 must bypass upload staging semaphore');

      // Tear down the 2 stalled uploads and confirm semaphore drains cleanly to 0
      stalledReq1.destroy();
      stalledReq2.destroy();
      await new Promise(r => setTimeout(r, 80));
      assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0);
      assert.strictEqual(queueManager.getActiveTextGenerations(), 0);
      assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0);

      // Subtest B: Upload Inactivity Timeout (250ms) destroys stalled upload and releases semaphore + locks
      process.env.UPLOAD_INACTIVITY_TIMEOUT_MS = '250';
      process.env.UPLOAD_DURATION_CEILING_MS = '2000';

      const inactivityOutcome = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/proxy/image/ai/encode-vibe',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer sec_vibe',
            'X-Browser-Id': 'dev_vibe',
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked'
          }
        }, (res) => {
          let raw = '';
          res.on('data', c => raw += c);
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
        });
        req.on('error', () => {});
        req.write('{"image":"partial');
        // Deliberately stall past 250ms without sending another chunk
      });

      assert.strictEqual(inactivityOutcome.status, 408);
      assert.strictEqual(inactivityOutcome.data.error, 'UPLOAD_INACTIVITY_TIMEOUT');
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0, 'Inactivity timeout must release staging semaphore');
      assert.strictEqual(queueManager.getActiveTextGenerations(), 0, 'Inactivity timeout must release Channel B slot');
      assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0, 'Inactivity timeout must clear 2 Anlas hold');

      // Subtest C: Upload Duration Ceiling (1000ms) kills continuous trickle upload beating 350ms inactivity timer
      process.env.UPLOAD_INACTIVITY_TIMEOUT_MS = '350';
      process.env.UPLOAD_DURATION_CEILING_MS = '1000';

      const ceilingOutcome = await new Promise((resolve) => {
        let settled = false;
        let trickleTimer = null;
        const req = http.request({
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/proxy/image/ai/encode-vibe',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer sec_vibe',
            'X-Browser-Id': 'dev_vibe',
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked'
          }
        }, (res) => {
          let raw = '';
          res.on('data', c => raw += c);
          res.on('end', () => {
            if (trickleTimer) clearInterval(trickleTimer);
            if (!settled) {
              settled = true;
              resolve({ status: res.statusCode, data: JSON.parse(raw) });
            }
          });
        });
        req.on('error', () => {
          if (trickleTimer) clearInterval(trickleTimer);
        });

        req.write('{"image":"');
        trickleTimer = setInterval(() => {
          if (req.destroyed || settled) {
            clearInterval(trickleTimer);
            return;
          }
          try { req.write('a'); } catch (_) {}
        }, 200);
      });

      assert.strictEqual(ceilingOutcome.status, 408);
      assert.strictEqual(ceilingOutcome.data.error, 'UPLOAD_DURATION_EXCEEDED');
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0, 'Duration ceiling must release staging semaphore');
      assert.strictEqual(queueManager.getActiveTextGenerations(), 0, 'Duration ceiling must release Channel B slot');
      assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0, 'Duration ceiling must clear 2 Anlas hold');
    } finally {
      delete process.env.UPLOAD_INACTIVITY_TIMEOUT_MS;
      delete process.env.UPLOAD_DURATION_CEILING_MS;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: CLIENT ABORT DURING ASYNC AWAIT (NO PERMANENT SEMAPHORE LEAK)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Client abort during ensureFresh() await never leaks activeBufferingStreams or Channel B holds', async () => {
    queueManager.reset();
    vibeUpstreamHits = 0;
    vibeUpstreamMode = 'ok';
    subUpstreamDelayMs = 200;

    const preservedSnap = serverModule.getTelemetrySnapshot();

    try {
      serverModule.resetTelemetryState({
        lastFetchedAt: 0,
        lastNetworkAttemptAt: 0,
        lastPaidExpiresAt: preservedSnap.masterLastPaidExpiresAt,
        activeCycleEpoch: preservedSnap.activeCycleEpoch
      });

      // Fire 3 sequential aborted requests during slow ensureFresh() (> INGRESS_SEMAPHORE_MAX = 2)
      // to verify activeBufferingStreams never wedges at 2.
      for (let i = 0; i < 3; i++) {
        const abortReq = http.request({
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/proxy/image/ai/encode-vibe',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer sec_vibe',
            'X-Browser-Id': 'dev_vibe',
            'Content-Type': 'application/json'
          }
        });
        abortReq.on('error', () => {});
        abortReq.write(JSON.stringify({ image: `abort_${i}` }));
        abortReq.end();

        await new Promise(r => setTimeout(r, 40));
        abortReq.destroy();

        // Wait for upstream telemetry sync to finish resolving the suspended await
        await new Promise(r => setTimeout(r, 220));
        serverModule.resetTelemetryState({
          lastFetchedAt: 0,
          lastNetworkAttemptAt: 0,
          lastPaidExpiresAt: preservedSnap.masterLastPaidExpiresAt,
          activeCycleEpoch: preservedSnap.activeCycleEpoch
        });
      }

      assert.strictEqual(
        proxyRouter.getActiveBufferingStreams(),
        0,
        'Aborted requests during async await must never leak activeBufferingStreams'
      );
      assert.strictEqual(queueManager.getActiveTextGenerations(), 0, 'Aborted requests must not leak Channel B slots');
      assert.strictEqual(queueManager.getHeldAnlasForUser('u_vibe'), 0, 'Aborted requests must not leak Anlas holds');

      // Prove staging semaphore remains operational for subsequent normal requests
      subUpstreamDelayMs = 0;
      const healthyRes = await sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'post_abort_ok' })
      });
      assert.strictEqual(healthyRes.status, 200, 'Staging semaphore must remain un-wedged after mid-await aborts');
      assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0);
    } finally {
      subUpstreamDelayMs = 0;
    }
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: CROSS-CHANNEL HOLDS, CONCURRENT DOUBLE-SPEND & COMMIT RACES, HEADER COLLISIONS, DEBT & SOLVENCY
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces cross-channel holds, concurrent double-spend & commit races, Channel B header isolation, debt lockout, grace freeze & master solvency', async () => {
    queueManager.reset();
    vibeUpstreamHits = 0;
    vibeUpstreamMode = 'delay_ok';
    vibeUpstreamDelayMs = 150;

    // Synchronize test principals to the active cycle epoch for isolated balance evaluation
    const currentCycleEpoch = serverModule.getTelemetrySnapshot().activeCycleEpoch;
    await dbModule.run(
      "UPDATE users SET last_anlas_reset_epoch = ? WHERE user_id IN ('u_vibe', 'u_exact2', 'u_exact4', 'u_three', 'u_debt7')",
      [currentCycleEpoch]
    );

    // 1. Cross-channel hold: u_three has 3 Anlas balance and 2 Anlas held on Channel A -> available = 1 < 2 -> 403 INSUFFICIENT_ANLAS
    queueManager.join({
      browser_id: 'dev_three',
      req_id: 'req_chan_a_hold2',
      user_id: 'u_three',
      priority_tier: 'Normal',
      held_cost: 2
    });
    const crossBlocked = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_three',
        'X-Browser-Id': 'dev_three',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'abc' })
    });
    assert.strictEqual(crossBlocked.status, 403);
    assert.strictEqual(crossBlocked.data.error, 'INSUFFICIENT_ANLAS');
    queueManager.complete('req_chan_a_hold2', 'dev_three');

    // 2. Concurrent double-spend race: u_exact2 has exactly 2 Anlas; fire 2 parallel /ai/encode-vibe requests
    const [race1, race2] = await Promise.all([
      sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact2',
          'X-Browser-Id': 'dev_exact2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'race1' })
      }),
      sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact2',
          'X-Browser-Id': 'dev_exact2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'race2' })
      })
    ]);

    const raceStatuses = [race1.status, race2.status].sort((a, b) => a - b);
    assert.deepStrictEqual(raceStatuses, [200, 403], 'Concurrent 2-Anlas vibe race must admit strictly 1 and reject 1 with 403');
    const exact2Row = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_exact2']);
    assert.strictEqual(exact2Row.virtual_anlas_balance, 0, 'Concurrent race must never overdraft balance below 0');

    // 2b. Concurrent commitAnlasDebit + multi-request /ai/encode-vibe race on u_exact4 (4 Anlas):
    //     Req 1 completes upstream HTTP 200 and pauses briefly inside commitAnlasDebit while Req 2 and Req 3
    //     race into authorizeAnlasSpend; per-user auth gate must prevent stale-balance double-spending.
    const originalCommit = auditEngine.commitAnlasDebit;
    let firstCommitStarted = false;
    auditEngine.commitAnlasDebit = async function(userId, amount, bId) {
      if (userId === 'u_exact4' && !firstCommitStarted) {
        firstCommitStarted = true;
        await new Promise(r => setTimeout(r, 80));
      }
      return originalCommit.apply(this, arguments);
    };

    try {
      vibeUpstreamMode = 'ok';
      const req1Promise = sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact4',
          'X-Browser-Id': 'dev_exact4',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'commit_race_1' })
      });

      // Wait until Req 1 hits delayed commitAnlasDebit (SQLite still at 4 while Req 1 clears hold at end)
      while (!firstCommitStarted) {
        await new Promise(r => setTimeout(r, 5));
      }

      // Fire Req 2 and Req 3 across the commit boundary
      const req2Promise = sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact4',
          'X-Browser-Id': 'dev_exact4',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'commit_race_2' })
      });
      await new Promise(r => setTimeout(r, 95));
      const req3Promise = sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_exact4',
          'X-Browser-Id': 'dev_exact4',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'commit_race_3' })
      });

      const [rExact1, rExact2, rExact3] = await Promise.all([req1Promise, req2Promise, req3Promise]);
      const exact4Statuses = [rExact1.status, rExact2.status, rExact3.status].sort((a, b) => a - b);
      assert.deepStrictEqual(exact4Statuses, [200, 200, 403], 'Only 2 of 3 requests may succeed on 4-Anlas balance across commit boundary');
      const exact4Row = await dbModule.get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', ['u_exact4']);
      assert.strictEqual(exact4Row.virtual_anlas_balance, 0, 'Commit-boundary race must never drive virtual_anlas_balance negative');
    } finally {
      auditEngine.commitAnlasDebit = originalCommit;
    }

    // 2c. Client-supplied whitespace or colliding X-Request-Id on Channel B must not cause bogus 429s
    vibeUpstreamMode = 'delay_ok';
    vibeUpstreamDelayMs = 150;
    const whitespaceReqIdVibe = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'X-Request-Id': '   ',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'ws_header_vibe' })
    });
    assert.strictEqual(whitespaceReqIdVibe.status, 200, 'Whitespace X-Request-Id must not poison Channel B slot key');

    const [dupHeaderText, dupHeaderVibe] = await Promise.all([
      sendRawRequest({
        path: '/proxy/text/ai/generate-stream',
        headers: {
          'Authorization': 'Bearer sec_three',
          'X-Browser-Id': 'dev_three',
          'X-Request-Id': 'colliding_channel_b_id',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: 'dup_header_text' })
      }),
      sendRawRequest({
        path: '/proxy/image/ai/encode-vibe',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'X-Request-Id': 'colliding_channel_b_id',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: 'dup_header_vibe' })
      })
    ]);
    assert.strictEqual(dupHeaderText.status, 200, 'Colliding client X-Request-Id must not block Channel B text');
    assert.strictEqual(dupHeaderVibe.status, 200, 'Colliding client X-Request-Id must not block Channel B vibe');
    vibeUpstreamMode = 'ok';

    // 3. Debt lockout: u_debt7 (-10 balance) -> 403 DEBT_LOCKED
    const debtRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_debt7',
        'X-Browser-Id': 'dev_debt7',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'debt_img' })
    });
    assert.strictEqual(debtRes.status, 403);
    assert.strictEqual(debtRes.data.error, 'DEBT_LOCKED');

    // 4. Grace period freezes 30-day fallback reset on /ai/encode-vibe
    const expiredEpoch = Date.now() - (35 * 86400000);
    await dbModule.run('UPDATE users SET last_anlas_reset_epoch = ? WHERE user_id = ?', [expiredEpoch, 'u_debt7']);
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES + (3 * 86400),
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: true,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const graceFrozenRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_debt7',
        'X-Browser-Id': 'dev_debt7',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'grace_img' })
    });
    assert.strictEqual(graceFrozenRes.status, 403, 'Grace period must freeze fallback reset on /ai/encode-vibe');
    assert.strictEqual(graceFrozenRes.data.error, 'DEBT_LOCKED');

    // 5. Master Anlas Depleted (< 2) -> 503 MASTER_ANLAS_DEPLETED
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 1, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const masterDepletedRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'master_low' })
    });
    assert.strictEqual(masterDepletedRes.status, 503);
    assert.strictEqual(masterDepletedRes.data.error, 'MASTER_ANLAS_DEPLETED');

    // 6. Inactive Master Subscription -> 503 MASTER_SUBSCRIPTION_INACTIVE
    serverModule.applyUsageTelemetry({
      tier: 0,
      active: false,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    const inactiveSubRes = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: {
        'Authorization': 'Bearer sec_vibe',
        'X-Browser-Id': 'dev_vibe',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: 'inactive_sub' })
    });
    assert.strictEqual(inactiveSubRes.status, 503);
    assert.strictEqual(inactiveSubRes.data.error, 'MASTER_SUBSCRIPTION_INACTIVE');

    // Restore healthy master telemetry
    serverModule.applyUsageTelemetry({
      tier: 3,
      active: true,
      expiresAt: DEFAULT_SUB_EXPIRES,
      trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 0 },
      isGracePeriod: false,
      usage: { percent: 80, timeUntilNextPercent: 7858, isNegative: false }
    }, undefined, Date.now());

    // 7. Mixed Channel B 3-slot saturation (2 text streams + 1 vibe encode -> 4th vibe encode gets 429)
    vibeUpstreamMode = 'delay_ok';
    vibeUpstreamDelayMs = 250;
    const pText1 = sendRawRequest({
      path: '/proxy/text/ai/generate-stream',
      headers: { 'Authorization': 'Bearer sec_three', 'X-Browser-Id': 'dev_three', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 't1' })
    });
    const pText2 = sendRawRequest({
      path: '/proxy/text/ai/generate-stream',
      headers: { 'Authorization': 'Bearer sec_three', 'X-Browser-Id': 'dev_three', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 't2' })
    });
    const pVibe3 = sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: { 'Authorization': 'Bearer sec_vibe', 'X-Browser-Id': 'dev_vibe', 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'v3' })
    });

    await new Promise(r => setTimeout(r, 60));
    const pVibe4 = await sendRawRequest({
      path: '/proxy/image/ai/encode-vibe',
      headers: { 'Authorization': 'Bearer sec_three', 'X-Browser-Id': 'dev_three', 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'v4' })
    });
    assert.strictEqual(pVibe4.status, 429);
    assert.strictEqual(pVibe4.data.error, 'CHANNEL_B_SATURATED');

    const [r1, r2, r3] = await Promise.all([pText1, pText2, pVibe3]);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 200);
    vibeUpstreamMode = 'ok';
  });

  // ---------------------------------------------------------------------------
  // 7. HELL PATH: CHANNEL A UPLOAD RE-ANCHOR & MID-UPLOAD EVICTION GUARD
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Re-anchors Channel A started_processing_at at req.on(end) and blocks tasks evicted mid-upload', async () => {
    queueManager.reset();
    imageUpstreamHits = 0;
    imageUpstreamDelayMs = 150;

    // 1. Multi-chunk Channel A upload advances started_processing_at at req.on('end')
    const task = queueManager.join({
      browser_id: 'dev_vibe',
      req_id: 'req_reanchor_c7',
      user_id: 'u_vibe',
      priority_tier: 'Normal'
    });
    const initialStartedAt = task.started_processing_at;

    await new Promise(r => setTimeout(r, 60));

    const chunkedImgPromise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/proxy/image/ai/generate-image',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'X-Request-Id': 'req_reanchor_c7',
          'X-Gen-Width': '1024',
          'X-Gen-Height': '1024',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'legacy',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.write('{"model":"nai-diffusion-4-5-full",');
      setTimeout(() => {
        req.write('"parameters":{"width":1024,"height":1024,"steps":28,"n_samples":1}}');
        req.end();
      }, 60);
    });

    // Mid-upstream inspection after upload completed (~120ms) and upstream is holding 150ms
    await new Promise(r => setTimeout(r, 150));
    assert.ok(
      task.started_processing_at > initialStartedAt,
      `Channel A started_processing_at (${task.started_processing_at}) must re-anchor past initial (${initialStartedAt}) at req.on('end')`
    );

    const imgRes = await chunkedImgPromise;
    assert.strictEqual(imgRes.status, 200);
    assert.strictEqual(imageUpstreamHits, 1);

    // 2. Evicting a Channel A task mid-upload causes req.on('end') to reject with 403 and 0 upstream hits
    imageUpstreamDelayMs = 0;
    queueManager.join({
      browser_id: 'dev_vibe',
      req_id: 'req_evict_mid_upload',
      user_id: 'u_vibe',
      priority_tier: 'Normal'
    });

    const evictedRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/proxy/image/ai/generate-image',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer sec_vibe',
          'X-Browser-Id': 'dev_vibe',
          'X-Request-Id': 'req_evict_mid_upload',
          'X-Gen-Width': '1024',
          'X-Gen-Height': '1024',
          'X-Gen-Steps': '28',
          'X-Gen-Samples': '1',
          'X-Gen-Model': 'legacy',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.write('{"model":"nai-diffusion-4-5-full",');
      setTimeout(() => {
        queueManager.evict({ user_id: 'u_vibe' });
        req.write('"parameters":{"width":1024,"height":1024,"steps":28,"n_samples":1}}');
        req.end();
      }, 50);
    });

    assert.strictEqual(evictedRes.status, 403);
    assert.strictEqual(imageUpstreamHits, 1, 'Evicted mid-upload task must never forward upstream');
    assert.strictEqual(proxyRouter.getActiveBufferingStreams(), 0);
  });
});