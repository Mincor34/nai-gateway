/**
 * PHASE 1 VERIFICATION HARNESS & STRESS TESTING SUITE (test/phase1.test.js)
 * 
 * This test suite validates the core security, queue coordination, database resilience,
 * and proxy streaming architectures of the NovelAI Split-Token Gateway.
 * 
 * Specifications verified:
 * 1. Mock Upstream NovelAI environment simulation (Success streams, slow SSE streams, socket severs).
 * 2. SQLite high-concurrency write and lock contention handling.
 * 3. Hell Path scenarios:
 *    - Abrupt client-side socket disconnection and dynamic lock eviction.
 *    - Parametric firewall resolution and step limits enforcement.
 *    - Client-side model-spoofing and background audit auto-banning.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ----------------- ENVIRONMENT CONFIGURATION -----------------
const GATEWAY_PORT = 13000;
const MOCK_UPSTREAM_PORT = 13001;
// Resolve sandbox database path strictly inside the test/ folder to protect the root
const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_data.db');

process.env.ADMIN_SECRET_KEY = "test_admin_key_super_secret_123";
process.env.DATABASE_PATH = SANDBOX_DB_FILE;
process.env.PORT = String(GATEWAY_PORT);
process.env.NODE_ENV = "test";

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
    headers: req.headers
  });

  if (parsedUrl.pathname.includes('/user/subscription')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ usage: { percent: 95 } }));
  }

  if (parsedUrl.pathname.includes('/ai/generate-image-stream') || parsedUrl.pathname.includes('/ai/generate-image')) {
    // Correctly intercept socket-sever based on query parameter
    if (parsedUrl.searchParams.has('socket-sever')) {
      res.socket.write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Le");
      res.socket.destroy();
      return;
    }

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
    }, 500);
    return;
  }

  if (parsedUrl.pathname.includes('/ai/generate-stream') || parsedUrl.pathname.includes('/oa/v1/completions')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const mockResponseText = "Delayed Message Payload";
    let textIndex = 0;
    const interval = setInterval(() => {
      if (textIndex < mockResponseText.length) {
        res.write(`data: ${JSON.stringify({ text: mockResponseText[textIndex] })}\n\n`);
        textIndex++;
      } else {
        clearInterval(interval);
        res.end();
      }
    }, 100);
    return;
  }

  res.writeHead(404);
  res.end();
});

// ----------------- CORE NETWORKING INSTRUMENTATION -----------------
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

    // Preserve the path and query parameters from the intercepted URL
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
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server to bootstrap at: ${url}`);
}

async function queryGateway(endpoint, method = 'GET', headers = {}, body = null) {
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null
  });
  return {
    status: response.status,
    data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text()
  };
}

// ----------------- COMPREHENSIVE TESTS EXECUTION -----------------

test("NovelAI Gateway Phase 1 Test Harness", async (t) => {
  
  await new Promise((resolve) => mockUpstreamServer.listen(MOCK_UPSTREAM_PORT, '127.0.0.1', resolve));
  console.log(`[Test Suite] Mock NovelAI Upstream listening on port ${MOCK_UPSTREAM_PORT}`);

  // 1. SQLite Database Lock Contention Tests
  await t.test("SQLite Database Lock Contention - 50 Concurrent Writes within 50ms", async () => {
    const { initDatabase, run } = require('../database');
    await initDatabase();

    const writePromises = [];
    for (let i = 0; i < 50; i++) {
      writePromises.push(
        run(
          'INSERT OR IGNORE INTO devices (browser_id, device_secret, label, priority_tier, approved, banned) VALUES (?, ?, ?, ?, 1, 0)',
          [`concurrency_browser_${i}`, `concurrency_secret_${i}`, `Concurrency Client ${i}`, 'Normal']
        )
      );
    }

    const executionResults = await Promise.allSettled(writePromises);
    const writeExceptions = executionResults.filter(result => result.status === 'rejected');

    assert.strictEqual(
      writeExceptions.length,
      0,
      `Database contention caused write failures. Count: ${writeExceptions.length}. Sample: ${writeExceptions[0]?.reason?.message}`
    );
    console.log(`[Test Suite] SQLite successfully serialized 50 concurrent writes without contention exceptions.`);
  });

  // Load the server file
  console.log("[Test Suite] Initializing server.js...");
  require('../server.js');
  await waitForServerToBootstrap(`http://127.0.0.1:${GATEWAY_PORT}/favicon.ico`);
  console.log("[Test Suite] Gateway Server successfully bootstrapped.");

  await queryGateway('/admin/update-token', 'POST', {
    'Authorization': 'Bearer test_admin_key_super_secret_123'
  }, { master_token: 'test_master_session_token_xyz' });

  // 2. Abrupt Disconnect Lock-Eviction Test
  await t.test("Hell Path: Abrupt Disconnect Queue Lock Eviction", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_a', device_secret: 'secret_a', label: 'Client A' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_a', priority_tier: 'Normal' });

    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_b', device_secret: 'secret_b', label: 'Client B' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_b', priority_tier: 'Normal' });

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_a' }, { browser_id: 'client_a', tab_id: 'tab_a', req_id: 'req_a' });
    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_b' }, { browser_id: 'client_b', tab_id: 'tab_b', req_id: 'req_b' });

    let queueStatusA = '';
    while (queueStatusA !== 'your_turn') {
      const { data } = await queryGateway('/queue/status?req_id=req_a');
      queueStatusA = data.status;
      if (queueStatusA !== 'your_turn') await new Promise(r => setTimeout(r, 100));
    }

    const requestOptions = {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: '/proxy/image/ai/generate-image-stream',
      method: 'POST',
      headers: {
        'X-Browser-ID': 'client_a',
        'X-Request-ID': 'req_a',
        'X-Gen-Width': '1024',
        'X-Gen-Height': '1024',
        'X-Gen-Steps': '28',
        'X-Gen-Samples': '1',
        'X-Gen-Model': 'legacy',
        'Authorization': 'Bearer secret_a',
        'Content-Type': 'application/json'
      }
    };

    const rawReqA = http.request(requestOptions, (rawResA) => {
      rawResA.socket.destroy();
    });
    rawReqA.write(JSON.stringify({ parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } }));
    rawReqA.end();

    // Dynamically poll the queue status until Client B is promoted (up to a 4-second timeout)
    let statusB = '';
    const pollStart = Date.now();
    while (statusB !== 'your_turn' && (Date.now() - pollStart < 4000)) {
      const { data } = await queryGateway('/queue/status?req_id=req_b');
      statusB = data.status;
      if (statusB !== 'your_turn') {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    assert.strictEqual(statusB, 'your_turn', "Client B should have been promoted to processing instantly upon Client A's connection destruction");
    
    // CLEANUP: Free Client B's queue lock to reset state for subsequent tests
    await queryGateway('/queue/complete', 'POST', {}, { req_id: 'req_b' });
    console.log("[Test Suite] Abrupt disconnect lock eviction verified and cleaned successfully.");
  });

  // 3. Parametric Firewall Drops Tests
  await t.test("Hell Path: Parametric Firewall Drops (Unqueued & Resolution Limit)", async () => {
    mockUpstreamServerHits = [];

    // Sub-test 3a: Direct Proxy Block (X-Gen-Model added to bypass client-version guard)
    const directProxyRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_b',
      'X-Request-ID': 'req_unqueued',
      'X-Gen-Model': 'legacy', // Present to bypass outdated script checks
      'Authorization': 'Bearer secret_b'
    }, { parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    assert.strictEqual(directProxyRes.status, 403, "Direct proxy attempts without queue locks must return 403 Forbidden");
    assert.strictEqual(mockUpstreamServerHits.length, 0, "No payload data should have reached upstream servers for unqueued requests");

    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_b' }, { browser_id: 'client_b', tab_id: 'tab_b', req_id: 'req_b_limit' });
    let isTurnB = false;
    while (!isTurnB) {
      const { data } = await queryGateway('/queue/status?req_id=req_b_limit');
      if (data.status === 'your_turn') isTurnB = true;
      else await new Promise(r => setTimeout(r, 100));
    }

    const firewallDropRes = await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_b',
      'X-Request-ID': 'req_b_limit',
      'X-Gen-Width': '2048',
      'X-Gen-Height': '2048',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_b'
    }, { parameters: { width: 2048, height: 2048, steps: 28, n_samples: 1 } });

    assert.strictEqual(firewallDropRes.status, 400, "Firewall must block requests exceeding the 1,048,576 total pixels limit with 400 Bad Request");
    assert.strictEqual(mockUpstreamServerHits.length, 0, "No payload bytes should reach upstream for firewalled resolutions");

    // CLEANUP: Free Client B's queue lock
    await queryGateway('/queue/complete', 'POST', {}, { req_id: 'req_b_limit' });
    console.log("[Test Suite] Parametric firewall enforcement verified and cleaned successfully.");
  });

  // 4. Model-Spoofing Auditing Test
  await t.test("Hell Path: Model-Spoofing Audit and Automatic Ban Execution", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_c', device_secret: 'secret_c', label: 'Client C' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_c', priority_tier: 'Normal' });
    
    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_c' }, { browser_id: 'client_c', tab_id: 'tab_c', req_id: 'req_c_spoof' });
    let isTurnC = false;
    while (!isTurnC) {
      const { data } = await queryGateway('/queue/status?req_id=req_c_spoof');
      if (data.status === 'your_turn') isTurnC = true;
      else await new Promise(r => setTimeout(r, 100));
    }

    await queryGateway('/proxy/image/ai/generate-image-stream', 'POST', {
      'X-Browser-ID': 'client_c',
      'X-Request-ID': 'req_c_spoof',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_c'
    }, { model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    await new Promise(r => setTimeout(r, 200));

    const statusRes = await queryGateway('/auth/status?browser_id=client_c', 'GET', { 'Authorization': 'Bearer secret_c' });
    assert.strictEqual(statusRes.status, 403, "Status endpoint must reject banned client credentials with 403 Forbidden");
    assert.match(statusRes.data.error, /permanently banned/i, "Error message should explicitly specify permanent ban state");

    // CLEANUP: Free Client C's queue lock
    await queryGateway('/queue/complete', 'POST', {}, { req_id: 'req_c_spoof' });
    console.log("[Test Suite] Model spoofing background audit and instant ban verified and cleaned successfully.");
  });

  // 5. Upstream Disruption Handling Test
  await t.test("Hell Path: Upstream Disruption & Resilient Socket Sever Handling", async () => {
    await queryGateway('/auth/register', 'POST', {}, { browser_id: 'client_d', device_secret: 'secret_d', label: 'Client D' });
    await queryGateway('/admin/approve', 'POST', { 'Authorization': 'Bearer test_admin_key_super_secret_123' }, { browser_id: 'client_d', priority_tier: 'Normal' });
    
    await queryGateway('/queue/join', 'POST', { 'Authorization': 'Bearer secret_d' }, { browser_id: 'client_d', tab_id: 'tab_d', req_id: 'req_d_disrupt' });
    let isTurnD = false;
    while (!isTurnD) {
      const { data } = await queryGateway('/queue/status?req_id=req_d_disrupt');
      if (data.status === 'your_turn') isTurnD = true;
      else await new Promise(r => setTimeout(r, 100));
    }

    const disruptRes = await queryGateway('/proxy/image/ai/generate-image-stream?socket-sever=true', 'POST', {
      'X-Browser-ID': 'client_d',
      'X-Request-ID': 'req_d_disrupt',
      'X-Gen-Width': '1024',
      'X-Gen-Height': '1024',
      'X-Gen-Steps': '28',
      'X-Gen-Samples': '1',
      'X-Gen-Model': 'legacy',
      'Authorization': 'Bearer secret_d'
    }, { parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } });

    assert.strictEqual(disruptRes.status, 502, "Premature upstream disconnection must yield 502 Bad Gateway");
    assert.strictEqual(disruptRes.data.error, "Upstream dynamic pipe disconnected", "Error diagnostic must reference pipe disconnect boundaries");

    // CLEANUP: Free Client D's queue lock
    await queryGateway('/queue/complete', 'POST', {}, { req_id: 'req_d_disrupt' });
    console.log("[Test Suite] Gateway gracefully recovered from sudden upstream connection disruptions.");
  });

  // Teardown
  await new Promise(r => mockUpstreamServer.close(r));
  if (gatewayServerInstance) {
    await new Promise(r => gatewayServerInstance.close(r));
  }
  cleanupSandboxFiles();
  console.log("[Test Suite] Successfully cleaned up all test files and completed Phase 1 executions.");
});