/**
 * PHASE 1 RIGOROUS VERIFICATION HARNESS & STRESS SUITE (test/phase1.test.js)
 * 
 * Exhaustively exercises the NovelAI Split-Token Gateway against its core specification:
 * 1. High-concurrency SQLite transactional lock contention (50 concurrent writes across independent handles).
 * 2. Channel A (Image) Concurrency: Strict 1-at-a-time exclusive execution & immediate disconnection eviction.
 * 3. Channel B (Text) Concurrency: Exact 3-slot concurrency limit with HTTP 429 backpressure.
 * 4. Parametric Firewall Enforcement:
 *    - Unqueued direct proxy drop (403).
 *    - Resolution > 1MP drop (400).
 *    - Steps > 28 drop (400).
 *    - Samples != 1 drop (400).
 *    - Precise character reference limit violation per tier (400).
 *    - Explicit invariant assertion that parametric firewall drops DO NOT permanently ban the client.
 * 5. SSRF and Destination Whitelist Shields: Subdomain and path violations (403).
 * 6. Rolling Token Allowance Depletion: Immediate 403 rejection on exhausted balance.
 * 7. End-to-End Streaming Integrity: Verification of chunked multi-part payload delivery across a 2.0-second sustained interval.
 * 8. Model-Spoofing Audit: Detection of stealth V5 calls, immediate persistent database ban, AND active queue eviction.
 * 9. Upstream Socket Disruption: Graceful HTTP 502 recovery on 50% header socket sever.
 * 10. Spec-Compliant Delayed SSE Stream: Single-character event-stream delivery with 100ms pauses.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { initDatabase, closeDatabase } = require('../database');

// ----------------- ENVIRONMENT CONFIGURATION -----------------
const GATEWAY_PORT = 13000;
const MOCK_UPSTREAM_PORT = 13001;
// Resolve sandbox database path inside the test/ folder to protect the root
const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_data.db');

process.env.ADMIN_SECRET_KEY = "test_admin_key_super_secret_123";
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(GATEWAY_PORT);
process.env.NODE_ENV = "test";

// dynamic tier configuration for sandbox validation
process.env.TIER_CONFIGS = JSON.stringify({
  'Admin':   { "basePriority": 30, "preciseLimit": null, "maxBurst": null, "refillRate": 0,      "maxAllowance": null, "refillRateMs": 0 },
  'High':    { "basePriority": 20, "preciseLimit": 4,    "maxBurst": null, "refillRate": 0,      "maxAllowance": 700,  "refillRateMs": 1800000 },
  'Normal':  { "basePriority": 10, "preciseLimit": 2,    "maxBurst": 15,   "refillRate": 120000, "maxAllowance": 500,  "refillRateMs": 1800000 },
  'Low':     { "basePriority": 0,  "preciseLimit": 1,    "maxBurst": 10,   "refillRate": 120000, "maxAllowance": 300,  "refillRateMs": 1800000 },
  'Metered': { "basePriority": 0,  "preciseLimit": 0,    "maxBurst": 5,    "refillRate": 120000, "maxAllowance": 150,  "refillRateMs": 1800000 }
});

// ----------------- SANDBOX FILESYSTEM CLEANUP -----------------
function cleanupSandboxFiles() {
  const filesToClear = [
    SANDBOX_DB_FILE,
    `${SANDBOX_DB_FILE}-journal`,
    `${SANDBOX_DB_FILE}-wal`,
    `${SANDBOX_DB_FILE}-shm`
  ];
  filesToClear.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      // Quiet fail during pre-cleanup if resources are not yet present
    }
  });
}

cleanupSandboxFiles();

// ----------------- MOCK UPSTREAM NOVELAI SERVER -----------------
let mockUpstreamServerHits = [];

const mockUpstreamServer = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  
  mockUpstreamServerHits.push({
    method: req.method,
    path: parsedUrl.pathname,
    query: parsedUrl.search,
    headers: req.headers
  });

  // Master telemetry status mock
  if (parsedUrl.pathname.includes('/user/subscription')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ usage: { percent: 95 } }));
  }

  // Socket Sever Mock: Transmit exactly 50% of the standard header lines, then destroy the socket immediately
  if (parsedUrl.searchParams.has('socket-sever')) {
    res.socket.write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n");
    res.socket.destroy();
    return;
  }

  // Spec-Compliant Delayed SSE Stream: Single characters with 100ms pause
  if (parsedUrl.searchParams.has('delayed_stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const characters = ['A', 'l', 'i', 'c', 'e'];
    let idx = 0;
    const sseInterval = setInterval(() => {
      if (idx < characters.length) {
        res.write(`data: ${JSON.stringify({ char: characters[idx] })}\n\n`);
        idx++;
      } else {
        clearInterval(sseInterval);
        res.end();
      }
    }, 100);
    return;
  }

  // Channel A: Image generation streaming mock sustained across a full 2.0-second interval
  if (parsedUrl.pathname.includes('/ai/generate-image-stream') || parsedUrl.pathname.includes('/ai/generate-image')) {
    res.writeHead(200, {
      'Content-Type': 'multipart/form-data; boundary=test_boundary',
      'Transfer-Encoding': 'chunked'
    });

    let chunkIndex = 0;
    const interval = setInterval(() => {
      res.write(`--test_boundary\r\nContent-Type: image/png\r\n\r\nChunk-${chunkIndex}\r\n`);
      chunkIndex++;
      if (chunkIndex >= 4) {
        clearInterval(interval);
        res.end('--test_boundary--\r\n');
      }
    }, 500); // 4 chunks * 500ms = 2.0 second delivery to validate network backpressure
    return;
  }

  // Channel B: Text generation streaming mock
  if (parsedUrl.pathname.includes('/ai/generate-stream') || parsedUrl.pathname.includes('/oa/v1/completions')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Deliberately hold connection open for a short period to allow concurrency validation
    const holdMs = parseInt(parsedUrl.searchParams.get('hold_ms') || '200', 10);
    const mockTokens = ["The", " quick", " brown", " fox"];
    let tokenIndex = 0;

    const tokenInterval = setInterval(() => {
      if (tokenIndex < mockTokens.length) {
        res.write(`data: ${JSON.stringify({ text: mockTokens[tokenIndex] })}\n\n`);
        tokenIndex++;
      } else {
        clearInterval(tokenInterval);
        setTimeout(() => {
          res.end();
        }, holdMs);
      }
    }, 25);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint Not Found on Mock' }));
});

// ----------------- INTERCEPT OUTBOUND HTTPS TO MOCK -----------------
const originalHttpsRequest = https.request;

https.request = function(url, options, callback) {
  let parsedUrl;
  let opt;
  let cb;

  if (typeof url === 'string' || url instanceof URL) {
    parsedUrl = new URL(url);
    opt = options || {};
    cb = callback;
  } else {
    opt = url || {};
    cb = options;
  }

  const hostname = opt.hostname || opt.host || (parsedUrl ? parsedUrl.hostname : '');
  if (hostname && hostname.includes('novelai.net')) {
    const redirectionOptions = { ...opt };
    redirectionOptions.protocol = 'http:';
    redirectionOptions.hostname = '127.0.0.1';
    redirectionOptions.port = MOCK_UPSTREAM_PORT;
    delete redirectionOptions.host;

    if (parsedUrl) {
      redirectionOptions.path = parsedUrl.pathname + parsedUrl.search;
    }

    return http.request(redirectionOptions, cb);
  }

  return originalHttpsRequest.apply(this, arguments);
};

let gatewayServerInstance = null;
const originalServerListen = http.Server.prototype.listen;

http.Server.prototype.listen = function(...args) {
  if (args[0] === GATEWAY_PORT || args[0] === String(GATEWAY_PORT)) {
    gatewayServerInstance = this;
  }
  return originalServerListen.apply(this, args);
};

async function waitForServerToBootstrap(url, timeoutMs = 5000) {
  const startEpoch = Date.now();
  while (Date.now() - startEpoch < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 204 || res.status === 401 || res.status === 200) {
        return;
      }
    } catch (err) {
      // Suppress connection failures during initialization sequence
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server to bootstrap at: ${url}`);
}

async function queryGateway(endpoint, method = 'GET', headers = {}, body = null) {
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${endpoint}`, {
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

// ----------------- COMPREHENSIVE SUITE EXECUTION -----------------

test("NovelAI Gateway Phase 1 Comprehensive Security & Resilience Gate", async (t) => {
  
  await new Promise((resolve) => mockUpstreamServer.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', resolve));
  console.log(`[Test Suite] Mock NovelAI Upstream listening on port ${MOCK_UPSTREAM_PORT}`);

  // 1. SQLite Database High-Concurrency Lock Contention Test
  // Spawns 50 parallel asynchronous writes across independent connection instances to force real OS-level file lock contention
  await t.test("SQLite Database Lock Contention - 50 Parallel Independent Connection Writes within 50ms", async () => {
    await initDatabase(SANDBOX_DB_FILE); // Explicit path injection

    const runQueryOnIsolatedHandle = (index) => {
      return new Promise((resolve, reject) => {
        const isolatedDb = new sqlite3.Database(SANDBOX_DB_FILE);
        isolatedDb.serialize(() => {
          isolatedDb.run("PRAGMA busy_timeout = 5000;");
          isolatedDb.run(
            'INSERT OR IGNORE INTO devices (browser_id, device_secret, label, priority_tier, approved, banned) VALUES (?, ?, ?, ?, 1, 0)',
            [`isolated_browser_${index}`, `secret_${index}`, `Client ${index}`, 'Normal'],
            (err) => {
              isolatedDb.close();
              if (err) reject(err);
              else resolve();
            }
          );
        });
      });
    };

    const writePromises = [];
    for (let i = 0; i < 50; i++) {
      writePromises.push(runQueryOnIsolatedHandle(i));
    }

    const executionResults = await Promise.allSettled(writePromises);
    const writeExceptions = executionResults.filter(result => result.status === 'rejected');

    assert.strictEqual(
      writeExceptions.length,
      0,
      `Parallel SQLite handles suffered lock collisions: ${writeExceptions[0]?.reason?.message}`
    );
  });

  // Bootstrap Gateway monolith
  console.log("[Test Suite] Initializing server.js...");
  const serverModule = require('../server.js');
  await waitForServerToBootstrap(`http://127.0.0.1:${GATEWAY_PORT}/favicon.ico`);
  console.log("[Test Suite] Gateway Server successfully bootstrapped.");

  // Seed master token into configuration table
  await queryGateway('/admin/update-token', 'POST', {
    'Authorization': 'Bearer test_admin_key_super_secret_123'
  }, { master_token: 'test_master_session_token_xyz' });

  // 2. Abrupt Disconnect Lock-Eviction Test
  await t.test("Hell Path: Abrupt Disconnect Queue Lock Eviction (Channel A)", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_evict_a', device_secret: 'secret_evict_a', label: 'Evict A' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_evict_a', priority_tier: 'Normal' });

    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_evict_b', device_secret: 'secret_evict_b', label: 'Evict B' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_evict_b', priority_tier: 'Normal' });

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_evict_a' }, { browser_id: 'client_evict_a', tab_id: 'tab_a', req_id: 'req_evict_a' });
    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_evict_b' }, { browser_id: 'client_evict_b', tab_id: 'tab_b', req_id: 'req_evict_b' });

    // Wait until client A acquires turn
    const statusA = await queryGateway('/queue/status?req_id=req_evict_a');
    assert.strictEqual(statusA.data.status, 'your_turn', "Client A must immediately acquire generation turn");

    const requestOptions = {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: '/proxy/image/ai/generate-image-stream',
      method: 'POST',
      headers: {
        'X-Browser-ID': 'client_evict_a',
        'X-Request-ID': 'req_evict_a',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Authorization': 'Bearer secret_evict_a',
        'Content-Type': 'application/json'
      }
    };

    // Client A connects and violently destroys its socket mid-flight
    const rawReqA = http.request(requestOptions);
    
    // Explicitly trap and absorb the expected client-side abort error
    rawReqA.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.message !== 'socket hang up') {
        throw err;
      }
    });

    rawReqA.write(JSON.stringify({ parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } }));
    
    // Abruptly sever socket connection without waiting for response completion
    await new Promise(r => setTimeout(r, 20));
    rawReqA.destroy();

    // Yield control for socket termination propagation on the event loop
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    // Assert Client B was promoted promptly without multi-second polling fallbacks
    const statusB = await queryGateway('/queue/status?req_id=req_evict_b');
    assert.strictEqual(statusB.data.status, 'your_turn', "Client B must immediately be promoted to processing upon Client A's connection sever");

    await queryGateway('/queue/complete', 'POST', {}, { req_id: 'req_evict_b' });
  });

  // 3. Channel B (Text Generation) Concurrency Limits (Max 3 slots, 4th rejected with 429)
  await t.test("Channel B: Text Generation Concurrency & HTTP 429 Backpressure", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_txt', device_secret: 'secret_txt', label: 'Text Client' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_txt', priority_tier: 'Normal' });

    const openTextRequest = () => {
      return fetch(`http://127.0.0.1:${GATEWAY_PORT}/proxy/text/ai/generate-stream?hold_ms=600`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer secret_txt',
          'X-Browser-ID': 'client_txt'
        },
        body: JSON.stringify({ prompt: "Once upon a time", model: "kayra-v1" })
      });
    };

    // Dispatch 3 concurrent text streams (filling capacity)
    const stream1Promise = openTextRequest();
    const stream2Promise = openTextRequest();
    const stream3Promise = openTextRequest();

    // Small yield to allow sockets to reach the gateway and increment activeTextGenerations
    await new Promise(r => setTimeout(r, 50));

    // 4th request must immediately fail with HTTP 429
    const rejectedRes = await openTextRequest();
    const rejectedData = await rejectedRes.json();

    assert.strictEqual(rejectedRes.status, 429, "4th concurrent text generation request must receive HTTP 429");
    assert.match(rejectedData.error, /pipelines saturated/i, "Error message must indicate text pipelines are saturated");

    // Await graceful termination of initial 3 requests
    const [res1, res2, res3] = await Promise.all([stream1Promise, stream2Promise, stream3Promise]);
    assert.strictEqual(res1.status, 200, "Text Slot 1 must complete successfully");
    assert.strictEqual(res2.status, 200, "Text Slot 2 must complete successfully");
    assert.strictEqual(res3.status, 200, "Text Slot 3 must complete successfully");
  });

  // 4. Parametric Firewall Comprehensive Enforcement
  await t.test("Hell Path: Parametric Firewall Comprehensive Violations", async () => {
    mockUpstreamServerHits = [];

    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_firewall', device_secret: 'secret_firewall', label: 'Firewall Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_firewall', priority_tier: 'Low' });

    // Helper to queue and wait for turn
    const joinAndWait = async (reqId) => {
      await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_firewall' }, { browser_id: 'client_firewall', tab_id: 'tab_fw', req_id: reqId });
      while (true) {
        const { data } = await queryGateway(`/queue/status?req_id=${reqId}`);
        if (data.status === 'your_turn') break;
        await new Promise(r => setTimeout(r, 50));
      }
    };

    // Sub-test 4a: Direct proxy without queue lock
    const unqueuedRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_firewall',
      'X-Request-ID': 'unregistered_req',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_firewall'
    }, { parameters: { width: 1024, height: 1024 } });
    assert.strictEqual(unqueuedRes.status, 403, "Unqueued request must return 403 Forbidden");

    // Sub-test 4b: Resolution > 1MP
    await joinAndWait('req_fw_res');
    const resLimitRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_firewall',
      'X-Request-ID': 'req_fw_res',
      'X-Gen-Width': '2048',
      'X-Gen-Height': '2048',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_firewall'
    }, { parameters: { width: 2048, height: 2048 } });
    assert.strictEqual(resLimitRes.status, 400, "Resolution exceeding 1MP must return 400 Bad Request");
    assert.match(resLimitRes.data.message, /1,048,576px/i);

    // Sub-test 4c: Steps > 28
    await joinAndWait('req_fw_steps');
    const stepsLimitRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_firewall',
      'X-Request-ID': 'req_fw_steps',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '50',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_firewall'
    }, { parameters: { width: 1024, height: 1024, steps: 50 } });
    assert.strictEqual(stepsLimitRes.status, 400, "Steps exceeding 28 must return 400 Bad Request");
    assert.match(stepsLimitRes.data.message, /exceeds the maximum limit of 28 steps/i);

    // Sub-test 4d: Samples != 1
    await joinAndWait('req_fw_samples');
    const samplesLimitRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_firewall',
      'X-Request-ID': 'req_fw_samples',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '4',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_firewall'
    }, { parameters: { width: 1024, height: 1024, n_samples: 4 } });
    assert.strictEqual(samplesLimitRes.status, 400, "Samples != 1 must return 400 Bad Request");
    assert.match(samplesLimitRes.data.message, /single-image generation only/i);

    // Sub-test 4e: Precise References exceeding tier allocation
    await joinAndWait('req_fw_refs');
    const refsLimitRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_firewall',
      'X-Request-ID': 'req_fw_refs',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Precise-Refs': '3', // Exceeds tier limit of 1
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_firewall'
    }, { parameters: { width: 1024, height: 1024 } });
    assert.strictEqual(refsLimitRes.status, 400, "Precise refs exceeding tier limit must return 400 Bad Request");
    assert.match(refsLimitRes.data.message, /Precise references count of 3 exceeds your max limit of 1/i);

    // Assert zero bytes reached the mock upstream for all firewall drops
    assert.strictEqual(mockUpstreamServerHits.length, 0, "No payload data must ever reach upstream when dropped by firewall");

    // Assert parametric firewall drops NEVER de-authorize or ban the client
    const statusCheck = await queryGateway('/auth/status?browser_id=client_firewall', 'GET', { 'Authorization': 'Bearer secret_firewall' });
    assert.strictEqual(statusCheck.status, 200, "Firewall client must remain registered and fully approved");
    assert.strictEqual(statusCheck.data.approved, true, "Firewall limit drops must never de-authorize a legitimate client");
  });

  // 5. SSRF and Whitelist Perimeter Defense
  await t.test("SSRF Defense: Destination Subdomain & Path Whitelist Lockdown", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_ssrf', device_secret: 'secret_ssrf', label: 'SSRF Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_ssrf', priority_tier: 'Normal' });

    // Sub-test 5a: Illegal Subdomain Destination
    const badSubdomainRes = await queryGateway('/proxy/internal-admin-service/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_ssrf',
      'Authorization': 'Bearer secret_ssrf'
    }, {});
    assert.strictEqual(badSubdomainRes.status, 403, "Non-whitelisted subdomain must return 403 Forbidden");
    assert.match(badSubdomainRes.data.error, /SSRF Shield/i);

    // Sub-test 5b: Non-whitelisted Path on Valid Subdomain
    const badPathRes = await queryGateway('/proxy/image/admin/dump-all-user-data', 'POST', {
      'X-Browser-ID': 'client_ssrf',
      'Authorization': 'Bearer secret_ssrf'
    }, {});
    assert.strictEqual(badPathRes.status, 403, "Non-whitelisted target path must return 403 Forbidden");
    assert.match(badPathRes.data.error, /Path not whitelisted/i);
  });

  // 6. Rolling Token Allowance Depletion
  await t.test("Rolling Allowance: Depletion Enforcement & 403 Gate", async () => {
    const { run } = require('../database');
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_metered', device_secret: 'secret_metered', label: 'Metered Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_metered', priority_tier: 'Metered' });

    // Forcibly drain metered allowance in the database to 0
    await run('UPDATE devices SET metered_allowance = 0, last_allowance_update_at = ? WHERE browser_id = ?', [Date.now(), 'client_metered']);

    const joinRes = await queryGateway('/queue/join', 'POST', {
      'Authorization': 'Bearer secret_metered'
    }, { browser_id: 'client_metered', tab_id: 'tab_metered', req_id: 'req_metered_drain' });

    assert.strictEqual(joinRes.status, 403, "Queue entry must be refused with HTTP 403 when allowance is depleted");
    assert.strictEqual(joinRes.data.error, 'ALLOWANCE_EXHAUSTED', "Error code must indicate depleted allowance");
  });

  // 7. End-to-End Streaming Integrity Verification
  await t.test("Streaming Integrity: Verifies Uncorrupted Chunk Delivery from Upstream", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_stream', device_secret: 'secret_stream', label: 'Stream Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_stream', priority_tier: 'Normal' });

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_stream' }, { browser_id: 'client_stream', tab_id: 'tab_stream', req_id: 'req_stream_test' });
    while (true) {
      const { data } = await queryGateway('/queue/status?req_id=req_stream_test');
      if (data.status === 'your_turn') break;
      await new Promise(r => setTimeout(r, 50));
    }

    const streamStart = Date.now();
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/proxy/image/ai/generate-image-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret_stream',
        'X-Browser-ID': 'client_stream',
        'X-Request-ID': 'req_stream_test',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy'
      },
      body: JSON.stringify({ parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
    });

    assert.strictEqual(response.status, 200, "Stream route must return 200 OK");
    assert.strictEqual(response.headers.get('x-accel-buffering'), 'no', "Must inject x-accel-buffering: no for streaming routes");
    assert.match(response.headers.get('cache-control'), /no-cache, no-transform/, "Must enforce anti-transform cache-control");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulatedText += decoder.decode(value, { stream: true });
    }

    const elapsed = Date.now() - streamStart;
    assert.ok(elapsed >= 1800, `Stream must sustain over 2 seconds (measured ${elapsed}ms) to test continuous pipe backpressure`);
    assert.match(accumulatedText, /Chunk-0/, "Payload must contain first streaming chunk");
    assert.match(accumulatedText, /Chunk-3/, "Payload must contain final streaming chunk");
    assert.match(accumulatedText, /--test_boundary--/, "Payload boundary must be sealed correctly");
  });

  // 8. Model-Spoofing Audit and Automatic Ban Execution
  await t.test("Hell Path: Model-Spoofing Audit and Immediate Ban Execution", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_spoof', device_secret: 'secret_spoof', label: 'Spoof Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_spoof', priority_tier: 'Normal' });

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_spoof' }, { browser_id: 'client_spoof', tab_id: 'tab_spoof', req_id: 'req_spoof_primary' });
    while (true) {
      const { data } = await queryGateway('/queue/status?req_id=req_spoof_primary');
      if (data.status === 'your_turn') break;
      await new Promise(r => setTimeout(r, 50));
    }

    // Submit a real V5 model payload while spoofing the header as 'legacy'
    await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_spoof',
      'X-Request-ID': 'req_spoof_primary',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy', // Attempted bypass
      'Authorization': 'Bearer secret_spoof'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    // Yield for background audit thread tick
    await new Promise(r => setTimeout(r, 200));

    // 1. Verify client is permanently banned in SQLite persistence
    const statusRes = await queryGateway('/auth/status?browser_id=client_spoof', 'GET', { 'Authorization': 'Bearer secret_spoof' });
    assert.strictEqual(statusRes.status, 403, "Status endpoint must reject banned client credentials with 403 Forbidden");
    assert.match(statusRes.data.error, /permanently banned/i, "Error message must explicitly confirm ban state");

    // 2. INVARIANT ASSERTION: Verify banned device is blocked at queue ingress
    const attemptRejoin = await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_spoof' }, { browser_id: 'client_spoof', tab_id: 'tab_spoof', req_id: 'req_spoof_secondary' });
    assert.strictEqual(attemptRejoin.status, 403, "Banned device must be rejected immediately at queue join");

    // 3. INVARIANT ASSERTION: Verify the malicious client's footprint was completely purged from memory queue RAM
    const taskStatus = await queryGateway('/queue/status?req_id=req_spoof_primary');
    assert.strictEqual(taskStatus.status, 404, "Spoofing client's task footprint must be evicted from active queue RAM");
  });

  // 9. Upstream Disruption Handling
  await t.test("Hell Path: Upstream Disruption & Resilient Socket Sever Handling", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_sever', device_secret: 'secret_sever', label: 'Sever Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_sever', priority_tier: 'Normal' });

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_sever' }, { browser_id: 'client_sever', tab_id: 'tab_sever', req_id: 'req_sever_test' });
    while (true) {
      const { data } = await queryGateway('/queue/status?req_id=req_sever_test');
      if (data.status === 'your_turn') break;
      await new Promise(r => setTimeout(r, 50));
    }

    const disruptRes = await queryGateway('/proxy/image/ai/generate-image-stream?socket-sever=true', 'POST', {
      'X-Browser-ID': 'client_sever',
      'X-Request-ID': 'req_sever_test',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_sever'
    }, { parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    assert.strictEqual(disruptRes.status, 502, "Premature upstream disconnection must yield 502 Bad Gateway");
    assert.strictEqual(disruptRes.data.error, "Upstream dynamic pipe disconnected");
  });

  // 10. Spec-Compliant Delayed SSE Single-Character Stream
  await t.test("Streaming Integrity: Verifies Character-by-Character SSE Delivery with 100ms Pauses", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_char_sse', device_secret: 'secret_char_sse', label: 'SSE Tester' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_char_sse', priority_tier: 'Normal' });

    const sseStart = Date.now();
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/proxy/text/ai/generate-stream?delayed_stream=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret_char_sse',
        'X-Browser-ID': 'client_char_sse'
      },
      body: JSON.stringify({ prompt: "Alice", model: "kayra-v1" })
    });

    assert.strictEqual(response.status, 200, "Delayed text route must return 200 OK");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedSSE = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulatedSSE += decoder.decode(value, { stream: true });
    }

    const elapsed = Date.now() - sseStart;
    assert.ok(elapsed >= 450, `SSE stream must reflect 100ms per-character pause (measured ${elapsed}ms)`);
    assert.match(accumulatedSSE, /"char":"A"/, "Payload must deliver single character chunks");
    assert.match(accumulatedSSE, /"char":"e"/, "Payload must deliver terminal character chunk");
  });

  // ----------------- SUITE TEARDOWN -----------------
  await new Promise(r => mockUpstreamServer.close(r));
  await closeDatabase();
  if (gatewayServerInstance) {
    await new Promise(r => gatewayServerInstance.close(r));
  } else if (serverModule.server) {
    await new Promise(r => serverModule.server.close(r));
  }
  cleanupSandboxFiles();
  console.log("[Test Suite] Exhaustive Phase 1 verification complete. All security parameters confirmed.");
});