/**
 * COORDINATOR GATEWAY CORE (server.js)
 *
 * Implements:
 * - Sequential Promise DB Startup Guard
 * - Preserved Fractional Token Accumulation (RAM-bound)
 * - Safe Boundary-Sliced Multipart JSON Parser for Background Post-Audits
 * - Dual-Rate Dynamic Queue Aging with 120s AUTO Promotion
 */

const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { initDatabase, run, get, all } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY; // Must be set in the VPS environment for admin endpoints to function

// Critical Environment Validation: Enforces immediate crash-on-boot if admin credential context is absent.
if (!ADMIN_SECRET_KEY) {
  console.error("[VPS Critical] ADMIN_SECRET_KEY variable is unconfigured!");
  process.exit(1);
}

const TIER_CONFIGS = {
  'Admin':   { basePriority: 30, slope: 'fast', maxBurst: Infinity,  refillRate: 0,      preciseLimit: Infinity },
  'High':    { basePriority: 20, slope: 'fast', maxBurst: Infinity,  refillRate: 0,      preciseLimit: 3 },
  'Normal':  { basePriority: 10, slope: 'base', maxBurst: 15,        refillRate: 120000, preciseLimit: 2 },
  'Low B':   { basePriority: 0,  slope: 'base', maxBurst: 10,        refillRate: 120000, preciseLimit: 1 },
  'Low A':   { basePriority: 0,  slope: 'base', maxBurst: 5,         refillRate: 120000, preciseLimit: 0 }
};

const PROXY_PATH_WHITELIST = new Set([
  'ai/generate-image',
  'ai/generate-image-stream',
  'ai/encode-vibe',      // Whitelisted path to support vibe transfer pre-processing via master token
  'ai/generate-stream',  // Legacy Text/story Generation API endpoint
  'oa/v1/completions'    // New OpenAI-compatible Text Generation API endpoint (GLM-4, Erato, Xialong, etc.)
]);

const deviceBuckets = new Map();
// In-Memory Queue State for Channel A (Exclusive Generation Slot)
let queue = [];

// Channel B Concurrency State (Shared Text Generation Slots)
let activeTextGenerations = 0;
const MAX_CONCURRENT_TEXT_GENS = 3; 
// Cryptographic Salt for IP hashing.
// Regenerating this on startup ensures maximum privacy: hashes remain identical 
// during runtime (allowing you to track/rate-limit a session), but become 
// completely un-reconstructible if log files are ever leaked.
const IP_SALT = crypto.randomBytes(16).toString('hex');

/**
 * Computes a secure, salted SHA-256 hash of an IP address.
 * Takes the first 12 characters to keep terminal telemetry readable.
 */
function hashIP(ip) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return 'local/unknown';
  }
  return crypto.createHash('sha256').update(ip + IP_SALT).digest('hex').substring(0, 12);
}

/**
 * Volatile dynamic token-bucket retriever implementing lazy math refills on-demand.
 * Preserves fractional token accumulation drift.
 */
function getOrInitBucket(browserId, tier) {
  const config = TIER_CONFIGS[tier];
  if (!config || config.maxBurst === Infinity) return null;

  let bucket = deviceBuckets.get(browserId);
  const now = Date.now();
  if (!bucket) {
    bucket = {
      tokens: config.maxBurst,
      lastTx: now
    };
    deviceBuckets.set(browserId, bucket);
  } else {
    const elapsed = now - bucket.lastTx;
    if (elapsed >= config.refillRate) {
      const gained = Math.floor(elapsed / config.refillRate);
      bucket.tokens = Math.min(config.maxBurst, bucket.tokens + gained);
      bucket.lastTx += gained * config.refillRate; // Keeps exact fractional remainder alignment
    }
  }
  return bucket;
}

// ----------------- CENTRAL TELEMETRY MIDDLEWARE -----------------
app.use((req, res, next) => {
  if (req.url === '/favicon.ico') return res.status(204).end();
  const timestamp = new Date().toISOString();
  const rawIp = req.headers['x-real-ip'] || req.ip || 'unknown'; 
  const maskedIp = hashIP(rawIp);
  console.log(`[VPS Telemetry] ${timestamp} | ${req.method} ${req.url} | Client: ${maskedIp}`);
  next();
});

/**
 * Dynamically updates effective queue priorities using dynamic linear aging decay (Fast vs Base slopes).
 * Evaluates step-function promotions (AUTO) at 120s thresholds.
 */
function processQueue() {
  const activeImageTask = queue.find(t => t.status === 'processing');
  if (activeImageTask) return; 
  if (queue.length === 0) return;

  const now = Date.now();
  const pendingTasks = queue.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) return;

  pendingTasks.forEach(task => {
    const elapsedSeconds = (now - task.timestamp) / 1000;
    
    // Dynamic Step-Function Jump (AUTO state promotion) at 120s
    if (!task.has_burst_boost && elapsedSeconds >= 120) {
      const bucket = getOrInitBucket(task.browser_id, task.priority_tier);
      if (bucket && bucket.tokens >= 1.0) {
        bucket.tokens -= 1.0;
        task.has_burst_boost = true;
        console.log(`[VPS Queue AUTO] Task "${task.req_id}" hit 120s threshold. Promoting to Fast Slope.`);
      }
    }

    let p = 0;
    if (task.has_burst_boost) {
      const base = (task.priority_tier === 'Admin') ? 30 : 20;
      p = base + Math.floor(elapsedSeconds / 5);
    } else {
      const config = TIER_CONFIGS[task.priority_tier] || TIER_CONFIGS['Normal'];
      p = config.basePriority + Math.floor(elapsedSeconds / 15);
    }
    
    task.effective_priority = p;
  });

  pendingTasks.sort((a, b) => b.effective_priority - a.effective_priority || a.timestamp - b.timestamp);

  const nextTask = pendingTasks[0];
  nextTask.status = 'processing';
  nextTask.started_processing_at = Date.now();
}

// ----------------- SECURE SWAP PROXY HANDLER (NO BODY PARSERS PRE-MOUNTED) -----------------
// Declarative routing here prevents Express middleware from destroying boundary/binary formats.
app.all('/proxy/:subdomain/{*splat}', async (req, res) => {
  const { subdomain } = req.params;
  
  // Reconstruct the remaining path from the named wildcard array segments
  const pathPart = Array.isArray(req.params.splat) 
    ? req.params.splat.join('/') 
    : (req.params.splat || '');

  // SSRF Protection Rule: Reject arbitrary target routing
  const whitelist = ['api', 'image', 'text'];
  if (!whitelist.includes(subdomain)) {
    console.warn(`[VPS SSRF Warning] Target subdomain rejected: "${subdomain}"`);
    return res.status(403).json({ error: 'SSRF Shield: Unauthorized subdomain destination.' });
  }

  // Privilege Escalation Prevention Rule: Ensure the requested endpoint is strictly whitelisted
  if (!PROXY_PATH_WHITELIST.has(pathPart)) {
    console.warn(`[VPS Security Warning] Target path non-whitelisted: "${pathPart}"`);
    return res.status(403).json({ error: 'Access Denied: Path not whitelisted for proxying.' });
  }

  // Retrieve routing identification variables
  const browserId = req.headers['x-browser-id'];
  const clientAuth = req.headers['authorization'];
  if (!browserId || !clientAuth || !clientAuth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing routing authorization context.' });
  }
  const deviceSecret = clientAuth.split(' ')[1];

  // Declare variables in the parent scope to prevent resource leakage on aborted uploads
  let activeTask = null;
  let upstreamReq = null;
  let cleanupExecuted = false;
  let isTextGenClaimed = false;
  let isImageGen = false;
  let isTextGen = false;

  // Single-Path Resource Cleanup logic to mitigate duplicate execution and race conditions.
  // This function is declared early to safely teardown states even if client aborts during upload.
  const executeCleanup = () => {
    if (cleanupExecuted) return;
    cleanupExecuted = true;

    if (upstreamReq) {
      try { upstreamReq.destroy(); } catch (err) {}
    }

    if (isTextGen && isTextGenClaimed) {
      activeTextGenerations = Math.max(0, activeTextGenerations - 1);
    }

    if (activeTask) {
      const idx = queue.findIndex(t => t.req_id === activeTask.req_id);
      if (idx !== -1) {
        queue.splice(idx, 1);
        console.log(`[VPS Telemetry] Stream cleaned up. Slot released for request: "${activeTask.req_id}"`);
        processQueue();
      }
    }
  };

  // Bind cleanup immediately. If a client disconnects during the body upload stream,
  // this triggers and prevents permanent concurrency leaks.
  res.on('close', executeCleanup);
  res.on('finish', executeCleanup);

  try {
    // Validate guest authorization signature
    let device;
    if (deviceSecret === ADMIN_SECRET_KEY) {
      // Admin override: Bypasses the SQLite device validation table since they possess the master ADMIN_SECRET_KEY.
      device = { approved: 1, priority_tier: 'Admin' };
    } else {
      device = await get(
        'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ? AND approved = 1',
        [browserId, deviceSecret]
      );
    }

    if (!device) {
      console.warn(`[VPS Auth Warning] Rejected credentials for device: "${browserId}"`);
      return res.status(401).json({ error: 'Access Denied: Device credentials rejected.' });
    }

    isImageGen = pathPart === 'ai/generate-image' || pathPart === 'ai/generate-image-stream';
    isTextGen = pathPart === 'ai/generate-stream' || pathPart === 'oa/v1/completions';

    if (isImageGen) {
      // Validate active queue lock requirements for Channel A
      const requestId = req.headers['x-request-id'];
      if (!requestId) return res.status(400).json({ error: 'Missing request ID.' });

      activeTask = queue.find(t => t.req_id === requestId && t.browser_id === browserId && t.status === 'processing');
      if (!activeTask) {
        return res.status(403).json({
          statusCode: 403,
          message: 'Anlas Protection: Transaction queue verification lock required.'
        });
      }

      // Enforce Soft Parametric Firewall Restrictions (Max 1MP, 28 Steps, Single Sample)
      // Serving as a defensive, front-facing check before the background audit.
      const width = parseInt(req.headers['x-gen-width'], 10) || 0;
      const height = parseInt(req.headers['x-gen-height'], 10) || 0;
      const steps = parseInt(req.headers['x-gen-steps'], 10) || 0;
      const samples = parseInt(req.headers['x-gen-samples'], 10) || 1;

      if ((width * height) > 1048576) {
        return res.status(400).json({ statusCode: 400, message: 'Anlas Protection: Max 1MP resolution limits exceeded.' });
      }
      if (steps > 28) {
        return res.status(400).json({ statusCode: 400, message: 'Anlas Protection: Max 28 steps exceeded.' });
      }
      if (samples !== 1) {
        return res.status(400).json({ statusCode: 400, message: 'Anlas Protection: Single-image generation only.' });
      }
    } else if (isTextGen) {
      // Channel B Fast-Track Concurrency Limit Execution
      if (activeTextGenerations >= MAX_CONCURRENT_TEXT_GENS) {
        return res.status(429).json({ error: 'Text processing pipelines saturated. Retry request.' });
      }
      activeTextGenerations++;
      isTextGenClaimed = true; // Mark as successfully allocated
    }

    // Retrieve system session credential
    const configRecord = await get('SELECT value FROM config WHERE key = ?', ['master_token']);
    if (!configRecord || !configRecord.value) {
      executeCleanup();
      return res.status(503).json({ error: 'System unconfigured: No master token pushed.' });
    }
    const masterToken = configRecord.value;

    const queryString = req.url.split('?')[1] || '';
    const upstreamUrl = `https://${subdomain}.novelai.net/${pathPart}${queryString ? '?' + queryString : ''}`;

    // Accumulate the entire request body from the client into memory on the VPS.
    // This allows us to re-calculate the Content-Length cleanly before forwarding upstream.
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    
    req.on('end', () => {
      const payloadBuffer = Buffer.concat(bodyChunks);

      // Asynchronously trigger the background audit on the fully compiled body buffer.
      // Runs on a separate tick to maintain zero latency on active generations.
      // Admin is excluded from audits to prevent accidental bans.
      if (isImageGen && deviceSecret !== ADMIN_SECRET_KEY) {
        setImmediate(() => {
          runBackgroundAudit(browserId, payloadBuffer);
        });
      }

      // Handle Client Debug Flag: Dumps full payload metrics without exposing tokens.
      if (req.headers['x-debug-mode'] === 'true') {
        console.log(`\n--- [VPS Debug Telemetry] Payload from client: "${browserId}" ---`);
        console.log(payloadBuffer.toString('utf8').substring(0, 1500));
        console.log("-------------------------------------------------------------\n");
      }

      const headers = { ...req.headers };
      headers['host'] = `${subdomain}.novelai.net`;
      headers['authorization'] = `Bearer ${masterToken}`;

      // Remove client metadata and conflicting HTTP headers.
      // Strip 'content-length' and 'transfer-encoding' to re-calculate them dynamically.
      const stripHeaders = [
        'x-browser-id', 'x-request-id', 'x-gen-width', 'x-gen-height', 'x-gen-steps', 'x-gen-samples', 'x-debug-mode', 'x-script-version',
        'connection', 'content-length', 'transfer-encoding'
      ];
      stripHeaders.forEach(h => delete headers[h]);

      // Set the Content-Length to the exact, parsed byte size of our accumulated payload buffer.
      // This completely avoids sending both Content-Length and Transfer-Encoding: chunked,
      // which Cloudflare strictly flags and drops to protect against HTTP Request Smuggling attacks.
      headers['content-length'] = payloadBuffer.length;

      console.log(`[VPS Telemetry] Forwarding piped request upstream to NovelAI: ${upstreamUrl} (Body: ${payloadBuffer.length} bytes)`);

      upstreamReq = https.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
        console.log(`[VPS Telemetry] Received upstream headers. Status: ${upstreamRes.statusCode}`);
        
        // Disable Nagle's algorithm on response socket to flush streaming progress chunks instantly.
        // Prevents TCP stream chunk buffering delays over VPN connections.
        req.socket.setNoDelay(true);

        // Inject explicit anti-buffering headers for streaming routes.
        // This forces CDNs (like Cloudflare), reverse proxies (like Nginx/Caddy), 
        // and VPN nodes to immediately flush raw binary chunks to the client browser without delays.
        if (pathPart === 'ai/generate-image-stream' || pathPart === 'ai/generate-stream' || pathPart === 'oa/v1/completions') {
          upstreamRes.headers['x-accel-buffering'] = 'no';
          upstreamRes.headers['cache-control'] = 'no-cache, no-transform';
        }

        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', (err) => {
        console.error('[VPS Telemetry] Upstream connection socket exception occurred:', err);
        if (!res.headersSent) {
          res.status(502).json({ 
            error: 'Upstream dynamic pipe disconnected',
            reason: err.message,
            code: err.code
          });
        }
      });

      // Disable Nagle's algorithm on outbound request connection to minimize upstream latency
      upstreamReq.setNoDelay(true);
      if (activeTask) activeTask.upstreamReq = upstreamReq;

      // Transmit the accumulated body buffer directly and end the socket cleanly
      upstreamReq.write(payloadBuffer);
      upstreamReq.end();
    });

  } catch (err) {
    console.error('[VPS Telemetry] Fatal exception thrown inside proxy router context:', err);
    executeCleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy execution failure.' });
    }
  }
});

// ----------------- STANDARD API ENDPOINTS -----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const verifyAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing admin credentials' });
  }
  if (authHeader.split(' ')[1] !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  next();
};

app.post('/auth/register', async (req, res) => {
  const { browser_id, device_secret, label } = req.body;
  if (!browser_id || !device_secret) return res.status(400).json({ error: 'Bad parameters' });
  try {
    await run(
      'INSERT OR IGNORE INTO devices (browser_id, device_secret, label, priority_tier, approved) VALUES (?, ?, ?, ?, 0)',
      [browser_id, device_secret, label || 'Guest Instance', 'Normal']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[VPS Telemetry] Registration exception:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Hardened identity modifier.
 * Permits authorized devices or administrators to update their registered nicknames.
 */
app.post('/auth/update-label', async (req, res) => {
  const { browser_id, label } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!browser_id || !label) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    let device;
    if (device_secret === ADMIN_SECRET_KEY) {
      device = { approved: 1 };
    } else {
      device = await get(
        'SELECT approved FROM devices WHERE browser_id = ? AND device_secret = ?',
        [browser_id, device_secret]
      );
    }
    if (!device) return res.status(401).json({ error: 'Unauthorized nickname change' });

    await run('UPDATE devices SET label = ? WHERE browser_id = ?', [label, browser_id]);
    console.log(`[VPS Telemetry] Device "${browser_id}" updated nickname: "${label}"`);
    res.json({ success: true });
  } catch (err) {
    console.error('[VPS Telemetry] Update label exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// Hardened Identity Verification Endpoint. Protects database states from malicious scraping.
app.get('/auth/status', async (req, res) => {
  const { browser_id } = req.query;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!browser_id || !device_secret) {
    return res.status(401).json({ error: 'Unauthenticated status query' });
  }

  try {
    let row;
    if (device_secret === ADMIN_SECRET_KEY) {
      row = { approved: 1, priority_tier: 'Admin' };
    } else {
      row = await get(
        'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ?', 
        [browser_id, device_secret]
      );
    }
    if (!row) return res.status(401).json({ error: 'Invalid device credentials' });
    res.json({ approved: !!row.approved, tier: row.priority_tier });
  } catch (err) {
    console.error('[VPS Telemetry] Authentication verification query failure:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/queue/join', async (req, res) => {
  const { browser_id, tab_id, req_id } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  try {
    let device;
    if (device_secret === ADMIN_SECRET_KEY) {
      device = { approved: 1, priority_tier: 'Admin' };
    } else {
      device = await get(
        'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ? AND approved = 1',
        [browser_id, device_secret]
      );
    }
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const existingIdx = queue.findIndex(t => t.browser_id === browser_id);
    if (existingIdx !== -1) {
      if (queue[existingIdx].upstreamReq) queue[existingIdx].upstreamReq.destroy();
      queue.splice(existingIdx, 1);
      console.log(`[VPS Telemetry] Ghost session evicted for: ${browser_id}`);
    }

    let hasBurstBoost = false;
    const tierConfig = TIER_CONFIGS[device.priority_tier] || TIER_CONFIGS['Normal'];

    if (tierConfig.maxBurst === Infinity) {
      hasBurstBoost = true;
    } else {
      const bucket = getOrInitBucket(browser_id, device.priority_tier);
      if (bucket && bucket.tokens >= 1.0) {
        bucket.tokens -= 1.0; 
        hasBurstBoost = true;
        console.log(`[VPS Token Bucket] Allocated 1.0 token. Browser: ${browser_id}. Tokens remaining: ${bucket.tokens}`);
      } else {
        hasBurstBoost = false;
        console.log(`[VPS Token Bucket] Saturated bucket. Defaulting ${browser_id} to Base Slope.`);
      }
    }

    queue.push({
      browser_id,
      tab_id,
      req_id,
      priority_tier: device.priority_tier,
      timestamp: Date.now(),
      last_polled_at: Date.now(),
      status: 'pending',
      started_processing_at: null,
      upstreamReq: null,
      has_burst_boost: hasBurstBoost
    });

    console.log(`[VPS Telemetry] Device "${browser_id}" joined queue. ReqId: "${req_id}". Tier: "${device.priority_tier}"`);
    processQueue();
    res.json({ success: true });
  } catch (err) {
    console.error('[VPS Telemetry] Queue join process exception:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/queue/status', async (req, res) => {
  const { req_id } = req.query;
  const task = queue.find(t => t.req_id === req_id);
  if (!task) return res.status(404).json({ error: 'Task missing' });

  task.last_polled_at = Date.now();
  if (task.status === 'processing') return res.json({ status: 'your_turn' });

  const now = Date.now();
  const tempPending = queue.filter(t => t.status === 'pending');
  tempPending.forEach(t => {
    const elapsedSeconds = (now - t.timestamp) / 1000;
    
    if (!t.has_burst_boost && elapsedSeconds >= 120) {
      const bucket = getOrInitBucket(t.browser_id, t.priority_tier);
      if (bucket && bucket.tokens >= 1.0) {
        bucket.tokens -= 1.0;
        t.has_burst_boost = true;
      }
    }

    let p = 0;
    if (t.has_burst_boost) {
      const base = (t.priority_tier === 'Admin') ? 30 : 20;
      p = base + Math.floor(elapsedSeconds / 5);
    } else {
      const config = TIER_CONFIGS[t.priority_tier] || TIER_CONFIGS['Normal'];
      p = config.basePriority + Math.floor(elapsedSeconds / 15);
    }
    t.effective_priority = p;
  });

  tempPending.sort((a, b) => b.effective_priority - a.effective_priority || a.timestamp - b.timestamp);
  res.json({ status: 'waiting', position: tempPending.findIndex(t => t.req_id === req_id) + 1 });
});

app.post('/queue/complete', async (req, res) => {
  const { req_id } = req.body;
  const idx = queue.findIndex(t => t.req_id === req_id);
  if (idx !== -1) {
    if (queue[idx].upstreamReq) queue[idx].upstreamReq.destroy();
    queue.splice(idx, 1);
    console.log(`[VPS Telemetry] Received manual complete message. Dropping request: "${req_id}"`);
  }
  processQueue();
  res.json({ success: true });
});

// Admin Interfaces
app.get('/admin/devices', verifyAdmin, async (req, res) => {
  try { res.json(await all('SELECT * FROM devices')); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/approve', verifyAdmin, async (req, res) => {
  const { browser_id, priority_tier } = req.body;
  try {
    await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE browser_id = ?', [priority_tier, browser_id]);
    console.log(`[VPS Telemetry Admin] Approved client browser: "${browser_id}". Priority: "${priority_tier}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/revoke', verifyAdmin, async (req, res) => {
  try {
    // Retains hard DELETE schema to avoid control panel pollution
    await run('DELETE FROM devices WHERE browser_id = ?', [req.body.browser_id]);
    console.log(`[VPS Telemetry Admin] Revoked approval for browser: "${req.body.browser_id}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/update-token', verifyAdmin, async (req, res) => {
  try {
    await run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['master_token', req.body.master_token]);
    console.log('[VPS Admin] Pushed fresh master Opus session token to configuration schema.');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scavenger Loop (TTL Maintenance - Fixed O(N) Mutation Implementation)
setInterval(() => {
  const now = Date.now();
  let stateChanged = false;
  
  queue = queue.filter(t => {
    // Drop clients failing to poll within 12 seconds
    if (t.status === 'pending' && (now - t.last_polled_at > 12000)) {
      stateChanged = true;
      console.warn(`[Nai-Gateway GC] Discarding inactive pending client: BrowserId: ${t.browser_id}`);
      return false; 
    }
    // Forcefully drop processing connections stuck/hung for over 25 seconds
    if (t.status === 'processing' && (now - t.started_processing_at > 25000)) {
      if (t.upstreamReq) t.upstreamReq.destroy();
      stateChanged = true;
      console.warn(`[Nai-Gateway GC] Terminating hung generation lock. Extinguished active socket for: ${t.browser_id}`);
      return false;
    }
    return true;
  });

  if (stateChanged) {
    processQueue();
  }
}, 5000);

/**
 * Format-agnostic parameters extractor. 
 * Extracts the request form part from a multipart body using actual boundaries 
 * before converting binary segments to UTF-8. Operates at the raw string level.
 */
function extractParametersFromRawBody(buffer) {
  try {
    if (!buffer || buffer.length === 0) return null;

    // Clean out massive Base64 strings to make the payload safely-parsable
    const bodyStr = buffer.toString('utf8');
    const cleanedStr = bodyStr.replace(/"(?:data:image\/[^"]+|[A-Za-z0-9+/=]{1000,})"/g, '""');

    // Multipart/FormData JSON Extraction
    if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // "--"
      const firstLineEnd = cleanedStr.indexOf('\n');
      const boundary = firstLineEnd !== -1 ? cleanedStr.slice(0, firstLineEnd).trim() : '';

      const requestIndex = cleanedStr.indexOf('name="request"');
      if (requestIndex !== -1 && boundary) {
        const startIdx = cleanedStr.indexOf('{', requestIndex);
        if (startIdx !== -1) {
          // Robust exact boundary search (prevents prompt-injection dashes "--" from truncating JSON)
          const nextBoundary = cleanedStr.indexOf(boundary, startIdx);
          const endIdx = nextBoundary !== -1 ? nextBoundary : cleanedStr.length;

          let jsonCandidate = cleanedStr.slice(startIdx, endIdx).trim();
          const lastBrace = jsonCandidate.lastIndexOf('}');
          if (lastBrace !== -1) {
            jsonCandidate = jsonCandidate.slice(0, lastBrace + 1);
          }

          const parsed = JSON.parse(jsonCandidate);
          const params = parsed.parameters || {};
          const totalRefs = (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0) +
                            (Array.isArray(params.character_reference) ? params.character_reference.length : 0) +
                            (Array.isArray(params.vibe_transfer) ? params.vibe_transfer.length : 0);

          return {
            width: params.width || null,
            height: params.height || null,
            steps: params.steps || null,
            n_samples: params.n_samples || null,
            precise_ref_count: totalRefs
          };
        }
      }
    } else {
      // Direct JSON Payload Parsing
      if (cleanedStr.trim().startsWith('{')) {
        const parsed = JSON.parse(cleanedStr);
        const params = parsed.parameters || {};
        const totalRefs = (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0) +
                          (Array.isArray(params.character_reference) ? params.character_reference.length : 0) +
                          (Array.isArray(params.vibe_transfer) ? params.vibe_transfer.length : 0);

        return {
          width: params.width || parsed.width || null,
          height: params.height || parsed.height || null,
          steps: params.steps || parsed.steps || null,
          n_samples: params.n_samples || parsed.n_samples || null,
          precise_ref_count: totalRefs
        };
      }
    }
  } catch (err) {
    console.error('[VPS Audit] Error extracting parameters:', err);
  }
  return null;
}

/**
 * Audit request parameters in separate event tick.
 * Executes immediate database deauthorization sweeps on resource limit violations.
 */
async function runBackgroundAudit(browserId, payloadBuffer) {
  const actualParams = extractParametersFromRawBody(payloadBuffer);
  if (!actualParams) return;

  const { width, height, steps, n_samples, precise_ref_count } = actualParams;
  
  const actualPixels = (width && height) ? (width * height) : 0;
  const actualSteps = steps || 0;
  const actualSamples = n_samples || 1;
  const actualRefs = precise_ref_count || 0;

  // Enforce the strict NovelAI Opus free generation parameters
  const maxPixels = 1048576; // 1 Megapixel (1024x1024)
  const maxSteps = 28;

  const device = await get('SELECT priority_tier, discord_id FROM devices WHERE browser_id = ?', [browserId]);
  if (!device) return;

  const config = TIER_CONFIGS[device.priority_tier] || TIER_CONFIGS['Normal'];
  
  const isViolation = (actualPixels > maxPixels) || 
                      (actualSteps > maxSteps) || 
                      (actualSamples !== 1) || 
                      (actualRefs > config.preciseLimit);

  if (isViolation) {
    console.warn(`\x1b[31m[VPS SECURITY AUDIT] !!! VIOLATION DETECTED !!!\x1b[0m`);
    console.warn(`[VPS Security Audit] Device: "${browserId}", Tier: "${device.priority_tier}"`);
    console.warn(`[VPS Security Audit] Params: ${width}x${height} (${actualPixels} px), Steps: ${actualSteps}, Refs: ${actualRefs} (Limit: ${config.preciseLimit})`);

    try {
      if (device.discord_id) {
        console.warn(`[VPS Security Audit] Revoking all devices linked to Discord ID: "${device.discord_id}"`);
        await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason) VALUES (?, ?, ?)', [
          device.discord_id,
          Date.now(),
          `Firewall Violation: ${width}x${height}, steps: ${actualSteps}, refs: ${actualRefs} on device ${browserId}`
        ]);
        await run('UPDATE devices SET approved = 0 WHERE discord_id = ?', [device.discord_id]);
      } else {
        console.warn(`[VPS Security Audit] Revoking browser_id directly: "${browserId}"`);
        await run('UPDATE devices SET approved = 0 WHERE browser_id = ?', [browserId]);
      }
      console.log(`[VPS Security Audit] Success. Ban execution completed.`);
    } catch (dbErr) {
      console.error('[VPS Security Audit] Failed to execute database ban:', dbErr);
    }
  }
}

// Sequential Promise DB Bootstrapper
initDatabase()
  .then(() => {
    app.listen(PORT, '127.0.0.1', () => console.log(`Gateway coordinator running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("[VPS Critical] Database initialization failed. Terminating engine process.", err);
    process.exit(1);
  });