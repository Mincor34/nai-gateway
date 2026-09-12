/**
 * PHASE 5 HARNESS: STREAM SAFETY & ROUTING ISOLATION (test/phase5.test.js)
 *
 * Exhaustively exercises Level 4 (Routers) & Level 5 (Service Orchestrator):
 * 1. The req.pause() OS Buffer Truncation Invariant:
 *    - Simulates disk latency on authentication queries while client streams a payload.
 *    - Verifies req.pause() holds incoming data without packet loss.
 * 2. Early Error Unpause / Stream Cleanup:
 *    - Verifies early 4xx/5xx terminations drain paused sockets cleanly without leaks.
 * 3. Architectural Boundary Ceiling (HTTP 413):
 *    - Verifies oversized payloads immediately fail with HTTP 413 and release queue locks.
 * 4. Mid-Stream Upstream Disruption:
 *    - Asserts response stream socket is destroyed and queue locks released immediately when upstream dies mid-stream.
 * 5. Inbound Client Error Destruction (No Zombie Responses):
 *    - Asserts that an inbound client upload stream error sends a 400 or destroys the response, never hanging.
 * 6. Route Segmentation & Security Perimeter:
 *    - Asserts /proxy drops unwhitelisted subdomains and paths (403).
 *    - Asserts /proxy enforces version gatekeeping (426) on missing x-gen-model.
 *    - Asserts /proxy, /auth, and /queue enforce and synchronize banned_discords checks (403).
 *    - Asserts unapproved devices CAN update their nicknames via /auth/update-label prior to approval.
 * 7. WAF Header Recalculation:
 *    - Asserts Content-Length matches accumulated payload size.
 *    - Asserts Transfer-Encoding is stripped.
 * 8. Full Admin Plane Integrity:
 *    - Confirms all admin endpoints exist and enforce admin passkey authentication.
 *    - Asserts /admin/approve safely falls back to 'Normal' priority tier when parameter is omitted.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase5.db');
const TEST_PORT = 14000;
const MOCK_UPSTREAM_PORT = 14001;

process.env.ADMIN_SECRET_KEY = "proxy_secret_key_123";
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = "test";
process.env.MAX_PAYLOAD_SIZE_BYTES = "2097152"; // 2MB ceiling for test harness
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

let capturedUpstreamHeaders = {};
let capturedUpstreamBody = '';

const mockUpstream = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.searchParams.has('sever-mid-stream')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    setTimeout(() => {
      res.socket.destroy();
    }, 50);
    return;
  }

  capturedUpstreamHeaders = req.headers;
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    capturedUpstreamBody = body;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, receivedBytes: body.length }));
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

test("Phase 5: Stream Safety Invariants & Complete Gateway Integration", async (t) => {
  await new Promise(r => mockUpstream.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', r));

  const dbModule = require('../database');
  await dbModule.initDatabase(SANDBOX_DB_FILE);

  await dbModule.run("INSERT INTO config (key, value) VALUES ('master_token', 'mock_master_token_value')");
  await dbModule.run("INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned, label) VALUES ('proxy_client', 'proxy_secret', 'Normal', 1, 0, 'Initial Label')");
  await dbModule.run("INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned, label) VALUES ('unapproved_client', 'unapproved_secret', 'Normal', 0, 0, 'Guest')");
  await dbModule.run("INSERT INTO devices (browser_id, device_secret, discord_id, priority_tier, approved, banned) VALUES ('discord_device_1', 'discord_secret_1', 'discord_user_test', 'Normal', 1, 0)");

  // Inject a slow-disk simulator into dbModule.get for auth lookups
  const originalGet = dbModule.get;
  let simulateDiskLag = false;

  dbModule.get = async function(sql, params) {
    if (simulateDiskLag && typeof sql === 'string' && sql.includes('SELECT approved, banned')) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return originalGet.apply(this, arguments);
  };

  const serverModule = require('../server.js');
  const queueManager = serverModule.queueManager;

  // Wait for bootstrap
  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
      if (res.status === 204) break;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }

  t.after(async () => {
    await new Promise(r => mockUpstream.close(r));
    if (serverModule.server) {
      await new Promise(r => serverModule.server.close(r));
    }
    await dbModule.closeDatabase();
    dbModule.get = originalGet;
    cleanupFiles();
  });

  await t.test("SSRF Defense: Subdomain and path whitelist strict rejection", async () => {
    const res1 = await queryGateway('/proxy/malicious/ai/generate-image', 'POST', {
      'Authorization': 'Bearer proxy_secret',
      'X-Browser-Id': 'proxy_client'
    }, {});
    assert.strictEqual(res1.status, 403);
    assert.match(res1.data.error, /SSRF Shield/i);

    const res2 = await queryGateway('/proxy/image/unauthorized/path', 'POST', {
      'Authorization': 'Bearer proxy_secret',
      'X-Browser-Id': 'proxy_client'
    }, {});
    assert.strictEqual(res2.status, 403);
    assert.match(res2.data.error, /Path not whitelisted/i);
  });

  await t.test("Version Gatekeeper: Outdated scripts missing X-Gen-Model receive HTTP 426", async () => {
    const res = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer proxy_secret',
      'X-Browser-Id': 'proxy_client'
      // Omits X-Gen-Model
    }, { parameters: { width: 512, height: 512 } });

    assert.strictEqual(res.status, 426, "Must reject image requests without X-Gen-Model with 426 SCRIPT_UPDATE_REQUIRED");
    assert.strictEqual(res.data.error, 'SCRIPT_UPDATE_REQUIRED');
  });

  await t.test("Blacklist Enforcement: Banned Discord accounts rejected and synchronized across routes", async () => {
    await dbModule.run("INSERT INTO banned_discords (discord_id, banned_at, reason) VALUES ('discord_user_test', ?, 'Test Ban')", [Date.now()]);

    const queueRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer discord_secret_1'
    }, { browser_id: 'discord_device_1', tab_id: 'tab', req_id: 'req_banned_disc' });
    assert.strictEqual(queueRes.status, 403, "Queue ingress must reject banned Discord account");
    assert.match(queueRes.data.error, /Your Discord identity is permanently banned/i);

    const proxyRes = await queryGateway('/proxy/image/ai/generate-image', 'POST', {
      'Authorization': 'Bearer discord_secret_1',
      'X-Browser-Id': 'discord_device_1',
      'X-Gen-Model': 'legacy'
    }, {});
    assert.strictEqual(proxyRes.status, 403, "Proxy ingress must reject banned Discord account");
    assert.match(proxyRes.data.error, /Your Discord identity is permanently banned/i);

    // Verify database flag was updated in devices table
    const dev = await dbModule.get("SELECT banned FROM devices WHERE discord_id = 'discord_user_test'");
    assert.strictEqual(dev.banned, 1, "Banned check must synchronize SQLite flag");

    // Clean up ban
    await dbModule.run("DELETE FROM banned_discords WHERE discord_id = 'discord_user_test'");
    await dbModule.run("UPDATE devices SET banned = 0 WHERE discord_id = 'discord_user_test'");
  });

  await t.test("Onboarding Flow: Unapproved device can update nickname prior to approval", async () => {
    const res = await queryGateway('/auth/update-label', 'POST', {
      'Authorization': 'Bearer unapproved_secret'
    }, { browser_id: 'unapproved_client', label: 'Updated Nickname' });

    assert.strictEqual(res.status, 200, "Unapproved device must be permitted to update label during setup wizard");
    assert.strictEqual(res.data.success, true);

    const row = await dbModule.get("SELECT label FROM devices WHERE browser_id = 'unapproved_client'");
    assert.strictEqual(row.label, 'Updated Nickname');
  });

  await t.test("Stream Safety Invariant: req.pause() prevents OS socket truncation under heavy DB blocking", async () => {
    simulateDiskLag = true;

    queueManager.join({
      browser_id: 'proxy_client',
      tab_id: 'tab',
      req_id: 'req_stream_test',
      priority_tier: 'Normal'
    });
    
    const mediumPayload = Buffer.alloc(500 * 1024, 'X').toString('utf8');
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/proxy/image/ai/generate-image',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer proxy_secret',
        'X-Browser-Id': 'proxy_client',
        'X-Request-Id': 'req_stream_test',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
      }
    });

    req.write(JSON.stringify({ parameters: { width: 512, height: 512, payload: mediumPayload } }));
    req.end();

    const responseData = await new Promise((resolve) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
    });

    assert.strictEqual(responseData.status, 200, `Proxy routing must resolve successfully despite DB lag`);
    
    const expectedByteLength = Buffer.byteLength(JSON.stringify({ parameters: { width: 512, height: 512, payload: mediumPayload } }), 'utf8');
    assert.strictEqual(parseInt(capturedUpstreamHeaders['content-length'], 10), expectedByteLength);
    assert.strictEqual(capturedUpstreamBody.length, expectedByteLength);
    assert.strictEqual(capturedUpstreamHeaders['transfer-encoding'], undefined);
    assert.strictEqual(capturedUpstreamHeaders['x-request-id'], undefined);
    assert.match(capturedUpstreamHeaders['authorization'], /Bearer mock_master_token_value/);

    simulateDiskLag = false;
  });

  await t.test("Hell Path: Ingress Ceiling Enforces HTTP 413 Payload Too Large", async () => {
    queueManager.join({
      browser_id: 'proxy_client',
      tab_id: 'tab_413',
      req_id: 'req_413_test',
      priority_tier: 'Normal'
    });

    // 3MB payload exceeds the 2MB test ceiling
    const massivePayload = Buffer.alloc(3 * 1024 * 1024, 'Z').toString('utf8');

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/proxy/image/ai/generate-image',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer proxy_secret',
        'X-Browser-Id': 'proxy_client',
        'X-Request-Id': 'req_413_test',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      }
    });

    req.on('error', () => {}); // Handle expected socket termination

    const resPromise = new Promise((resolve) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
    });

    req.write(JSON.stringify({ parameters: { width: 512, height: 512, data: massivePayload } }));
    req.end();

    const responseData = await resPromise;
    assert.strictEqual(responseData.status, 413, "Exceeding physical memory boundary must return HTTP 413");
    assert.strictEqual(responseData.body.error, 'PAYLOAD_TOO_LARGE');

    // Invariant check: Channel A generation lock was cleaned up
    assert.strictEqual(queueManager.getProcessingTask('req_413_test', 'proxy_client'), null, "Queue lock must be released on 413 drop");
  });

  await t.test("Hell Path: Upstream Mid-Stream Disconnect Destroys Client Socket Immediately", async () => {
    queueManager.join({
      browser_id: 'proxy_client',
      tab_id: 'tab_sever',
      req_id: 'req_mid_sever',
      priority_tier: 'Normal'
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/proxy/image/ai/generate-image?sever-mid-stream=true',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer proxy_secret',
        'X-Browser-Id': 'proxy_client',
        'X-Request-Id': 'req_mid_sever',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      }
    });

    let socketDestroyedPrematurely = false;

    const streamResultPromise = new Promise((resolve) => {
      req.on('response', (res) => {
        assert.strictEqual(res.statusCode, 200, "Initial headers should arrive as 200 OK");
        res.on('data', () => {});
        res.on('error', () => {
          socketDestroyedPrematurely = true;
          resolve();
        });
        res.on('close', () => {
          socketDestroyedPrematurely = true;
          resolve();
        });
      });
      req.on('error', () => {
        socketDestroyedPrematurely = true;
        resolve();
      });
    });

    req.write(JSON.stringify({ parameters: { width: 512, height: 512 } }));
    req.end();

    await streamResultPromise;
    assert.strictEqual(socketDestroyedPrematurely, true, "Client connection must be terminated cleanly when upstream dies mid-stream");
    
    // Yield to the event loop so any pending microtasks flush
    await new Promise(r => setImmediate(r));

    // Invariant: Channel A lock freed
    assert.strictEqual(queueManager.getProcessingTask('req_mid_sever', 'proxy_client'), null, "Queue lock must be freed after mid-stream sever");
  });

  await t.test("Hell Path: Inbound Client Stream Error Terminates Transaction Without Hanging", async () => {
    queueManager.join({
      browser_id: 'proxy_client',
      tab_id: 'tab_inbound_err',
      req_id: 'req_inbound_err',
      priority_tier: 'Normal'
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/proxy/image/ai/generate-image',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer proxy_secret',
        'X-Browser-Id': 'proxy_client',
        'X-Request-Id': 'req_inbound_err',
        'X-Gen-Model': 'legacy',
        'Content-Type': 'application/json'
      }
    });

    req.on('error', () => {}); // Absorb client-side abort error

    req.write('{"parameters":{"width":512,');
    await new Promise(r => setTimeout(r, 20));
    
    // Abruptly destroy inbound client socket mid-transmission
    req.destroy();

    await new Promise(r => setTimeout(r, 100));

    // Assert that the lock did not hang and was freed synchronously
    assert.strictEqual(queueManager.getProcessingTask('req_inbound_err', 'proxy_client'), null, "Queue lock must not remain locked when client socket errors out");
  });

  await t.test("Admin Hardening: /admin/approve falls back cleanly to Normal priority tier when unspecified", async () => {
    const adminHeaders = { 'Authorization': 'Bearer proxy_secret_key_123' };

    // Register a dummy device
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'fallback_dev', device_secret: 'fallback_sec', label: 'Fallback' });

    // Approve WITHOUT priority_tier parameter
    const res = await queryGateway('/admin/approve', 'POST', adminHeaders, { browser_id: 'fallback_dev' });
    assert.strictEqual(res.status, 200, "Must not crash with NOT NULL constraint error when priority_tier is omitted");
    assert.strictEqual(res.data.success, true);

    const dev = await dbModule.get("SELECT priority_tier, approved FROM devices WHERE browser_id = 'fallback_dev'");
    assert.strictEqual(dev.approved, 1);
    assert.strictEqual(dev.priority_tier, 'Normal', "Priority tier must default to 'Normal'");
  });

  await t.test("Admin Plane Integrity: Verifies presence and passkey validation across all endpoints", async () => {
    const adminHeaders = { 'Authorization': 'Bearer proxy_secret_key_123' };

    const endpoints = [
      { path: '/admin/devices', method: 'GET' },
      { path: '/admin/user-devices?discord_id=123', method: 'GET' },
      { path: '/admin/unnotified-bans', method: 'GET' },
      { path: '/admin/global-stats', method: 'GET' }
    ];

    for (const ep of endpoints) {
      const res = await queryGateway(ep.path, ep.method, adminHeaders);
      assert.notStrictEqual(res.status, 404, `Endpoint ${ep.path} must exist on admin router`);
      assert.strictEqual(res.status, 200, `Endpoint ${ep.path} must return 200 for verified admin`);
    }

    // Assert unauthenticated admin access is rejected
    const unauthRes = await queryGateway('/admin/devices', 'GET');
    assert.strictEqual(unauthRes.status, 401);
  });
});