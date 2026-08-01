/**
 * COORDINATOR GATEWAY CORE (server.js)
 * A monolith to surpass Wailord's cock!
 *
 * Implements:
 * - Sequential Promise DB Startup Guard
 * - Preserved Fractional Token Accumulation (RAM-bound)
 * - Safe Boundary-Sliced Multipart JSON Parser for Background Post-Audits
 * - Dual-Rate Dynamic Queue Aging with 120s AUTO Promotion
 * - Explicit Session Authorization on Queue Entry
 * - Identity-Bound Concurrency Queue Management (Discord-ID Locked)
 * - Decoupled REST interfaces for Discord Bot integrations
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
  console.error("[VPS Critical] ADMIN_SECRET_KEY variable is unconfigured! Crashing boot sequence.");
  process.exit(1);
}

// Config metrics establishing system-wide rate bounds
const TIER_CONFIGS = {
  'Admin':   { basePriority: 30, slope: 'fast', maxBurst: Infinity,  refillRate: 0,      preciseLimit: Infinity },
  'High':    { basePriority: 20, slope: 'fast', maxBurst: Infinity,  refillRate: 0,      preciseLimit: 3 },
  'Normal':  { basePriority: 10, slope: 'base', maxBurst: 15,        refillRate: 120000, preciseLimit: 2 },
  'Low':     { basePriority: 0,  slope: 'base', maxBurst: 10,        refillRate: 120000, preciseLimit: 1 },
  'Metered': { basePriority: 0,  slope: 'base', maxBurst: 5,         refillRate: 120000, preciseLimit: 0 }
};

const PROXY_PATH_WHITELIST = new Set([
  'ai/generate-image',
  'ai/generate-image-stream',
  'ai/encode-vibe',      // Whitelisted path to support vibe transfer pre-processing via master token
  'ai/generate-stream',  // Legacy Text/story Generation API endpoint
  'oa/v1/completions'    // New OpenAI-compatible Text Generation API endpoint (GLM-4, Erato, Xialong, etc.)
]);

// Volatile token buckets and queues (RAM-bound to maximize throughput and avoid I/O bottlenecks)
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

// Stateful ephemeral in-memory RAM cache to track device online/offline status (no I/O strain)
const activeSessions = new Map(); // browserId -> lastActiveTimestamp

/**
 * Registers device pings in RAM to avoid database I/O bottlenecks.
 *
 * @param {string} browserId - Unique device browser footprint.
 */
function pingDevice(browserId) {
  if (browserId) {
    activeSessions.set(browserId, Date.now());
  }
}

/**
 * Computes a secure, salted SHA-256 hash of an IP address.
 * Takes the first 12 characters to keep terminal telemetry readable.
 *
 * @param {string} ip - Raw client IP.
 * @returns {string} Salted hash prefix.
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
 *
 * @param {string} browserId - Device footprint.
 * @param {string} tier - Allocation tier of the device.
 * @returns {object|null} Evaluated bucket reference.
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

// ----------------- SECURE PAYLOAD TELEMETRY UTILITIES -----------------

/**
 * Recursively inspects a JSON payload and replaces massive Base64 strings
 * with compact metadata placeholders to prevent terminal locking and log bloat.
 *
 * @param {*} obj - Target payload object.
 * @returns {*} Sanitized object copy.
 */
function sanitizeObjectForLogging(obj) {
  if (obj === null || obj === undefined) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForLogging(item));
  }
  
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, val] of Object.entries(obj)) {
      cleaned[key] = sanitizeObjectForLogging(val);
    }
    return cleaned;
  }
  
  if (typeof obj === 'string') {
    if (obj.length > 500) {
      const mimeType = obj.startsWith('data:') ? obj.split(';')[0] : 'Base64/Binary';
      return `[Truncated ${mimeType}, Length: ${obj.length} chars]`;
    }
  }
  
  return obj;
}

/**
 * Formats both raw JSON and Multipart/FormData payloads into a clean, readable, 
 * and untruncated structured string for secure VPS telemetry.
 *
 * @param {Buffer} buffer - Raw request body buffer.
 * @returns {string} Formatted log output.
 */
function formatPayloadForLogging(buffer) {
  try {
    if (!buffer || buffer.length === 0) return "{ empty payload }";

    const bodyStr = buffer.toString('utf8');

    if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // Starts with "--" boundary marker
      const firstLineEnd = bodyStr.indexOf('\n');
      const boundary = firstLineEnd !== -1 ? bodyStr.slice(0, firstLineEnd).trim() : '';
      const requestIndex = bodyStr.indexOf('name="request"');
      
      if (requestIndex !== -1 && boundary) {
        const startIdx = bodyStr.indexOf('{', requestIndex);
        if (startIdx !== -1) {
          const nextBoundary = bodyStr.indexOf(boundary, startIdx);
          const endIdx = nextBoundary !== -1 ? nextBoundary : bodyStr.length;

          let jsonCandidate = bodyStr.slice(startIdx, endIdx).trim();
          const lastBrace = jsonCandidate.lastIndexOf('}');
          if (lastBrace !== -1) {
            jsonCandidate = jsonCandidate.slice(0, lastBrace + 1);
          }
          
          const parsed = JSON.parse(jsonCandidate);
          return JSON.stringify(sanitizeObjectForLogging(parsed), null, 2);
        }
      }
      return `[Multipart Payload - Boundary: ${boundary}, Length: ${buffer.length} bytes]`;
    }

    if (bodyStr.trim().startsWith('{')) {
      const parsed = JSON.parse(bodyStr);
      return JSON.stringify(sanitizeObjectForLogging(parsed), null, 2);
    }

    return bodyStr.substring(0, 1000) + `... [Truncated raw data, Total: ${buffer.length} bytes]`;
  } catch (err) {
    return `[Logger Error] Parsing failure: ${err.message}. Raw payload size: ${buffer.length} bytes.`;
  }
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

  pingDevice(browserId);

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
      device = { approved: 1, banned: 0, priority_tier: 'Admin' };
    } else {
      device = await get(
        'SELECT approved, banned, priority_tier, discord_id FROM devices WHERE browser_id = ? AND device_secret = ?',
        [browserId, deviceSecret]
      );
    }

    if (!device) {
      console.warn(`[VPS Auth Warning] Rejected credentials for device: "${browserId}"`);
      return res.status(401).json({ error: 'Access Denied: Device credentials rejected.' });
    }

    // Flag-based ban safety checks
    if (device.banned === 1) {
      return res.status(403).json({ error: 'Access Denied: Your device/profile has been permanently banned.' });
    }

    if (device.discord_id) {
      const isBannedUser = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [device.discord_id]);
      if (isBannedUser) {
        await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [device.discord_id]);
        return res.status(403).json({ error: 'Access Denied: Your Discord identity is permanently banned.' });
      }
    }

    if (device.approved !== 1) {
      return res.status(401).json({ error: 'Access Denied: Device pending registration approval.' });
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
      const preciseRefs = parseInt(req.headers['x-precise-refs'], 10) || 0;

      const config = TIER_CONFIGS[device.priority_tier] || TIER_CONFIGS['Normal'];
      const totalPixels = width * height;
      const violations = [];

      if (totalPixels > 1048576) {
        violations.push(`Resolution of ${width}x${height} (${totalPixels}px) exceeds the maximum limit of 1,048,576px (1MP)`);
      }
      if (steps > 28) {
        violations.push(`Steps count of ${steps} exceeds the maximum limit of 28 steps`);
      }
      if (samples !== 1) {
        violations.push(`Samples count of ${samples} exceeds the maximum limit of 1 sample (single-image generation only)`);
      }
      if (preciseRefs > config.preciseLimit) {
        violations.push(`Precise references count of ${preciseRefs} exceeds your max limit of ${config.preciseLimit}`);
      }

      if (violations.length > 0) {
        const combinedMessage = `\n\nAnlas Protection Limit Violations:\n` + 
                                violations.map(v => `• ${v}`).join('\n');
                                
        return res.status(400).json({
          statusCode: 400,
          message: combinedMessage,
          violations: violations
        });
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

      // Asynchronously trigger parameter audit and track request stats in SQLite
      setImmediate(async () => {
        try {
          await run(
            'UPDATE devices SET total_requests = total_requests + 1, last_active_at = ? WHERE browser_id = ?',
            [Date.now(), browserId]
          );
          if (isImageGen && deviceSecret !== ADMIN_SECRET_KEY) {
            await runBackgroundAudit(browserId, payloadBuffer);
          }
        } catch (err) {
          console.error('[VPS Audit] Session tracking error:', err);
        }
      });

      // Uses the sanitizer to output the untruncated parameter schema
      // without flooding PM2 logs with binary image strings.
      if (req.headers['x-debug-mode'] === 'true') {
        console.log(`\n--- [VPS Debug Telemetry] Untruncated Structured Payload (Client: "${browserId}") ---`);
        console.log(formatPayloadForLogging(payloadBuffer));
        console.log("------------------------------------------------------------------------------------\n");
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
      'INSERT OR IGNORE INTO devices (browser_id, device_secret, label, priority_tier, approved, banned, anlas_consumed, total_requests, last_active_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)',
      [browser_id, device_secret, label || 'Guest Instance', 'Normal', Date.now()]
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

  pingDevice(browser_id);

  try {
    let row;
    if (device_secret === ADMIN_SECRET_KEY) {
      row = { approved: 1, banned: 0, priority_tier: 'Admin', anlas_consumed: 0, discord_id: 'admin' };
    } else {
      row = await get(
        'SELECT approved, banned, priority_tier, discord_id, anlas_consumed FROM devices WHERE browser_id = ? AND device_secret = ?', 
        [browser_id, device_secret]
      );
    }
    if (!row) return res.status(401).json({ error: 'Invalid device credentials' });
    if (row.banned === 1) return res.status(403).json({ error: 'Device is permanently banned.' });

    let sessionInfo = null;
    if (row.priority_tier === 'Metered') {
      const today = new Date().toISOString().split('T')[0];
      const session = await get(
        'SELECT session_count, last_session_at FROM device_sessions WHERE browser_id = ? AND session_date = ?',
        [browser_id, today]
      );
      const now = Date.now();
      const count = session ? session.session_count : 0;
      const lastSessionAt = session ? session.last_session_at : 0;
      const elapsed = now - lastSessionAt;
      const active = elapsed < 30 * 60 * 1000 && count > 0;
      sessionInfo = {
        count: count,
        remaining: 6 - count,
        active: active,
        time_remaining: active ? (30 * 60 * 1000 - elapsed) : 0
      };
    }

    // Retrieve other approved browser IDs registered under the same Discord user
    let linkedDevices = [];
    if (row.discord_id && row.discord_id !== 'admin') {
      const devices = await all('SELECT browser_id, label FROM devices WHERE discord_id = ? AND approved = 1', [row.discord_id]);
      linkedDevices = devices.map(d => ({ id: d.browser_id, label: d.label }));
    }

    res.json({ 
      approved: !!row.approved, 
      tier: row.priority_tier,
      anlas_consumed: row.anlas_consumed || 0,
      precise_limit: TIER_CONFIGS[row.priority_tier]?.preciseLimit ?? 0,
      session: sessionInfo,
      linked_devices: linkedDevices
    });
  } catch (err) {
    console.error('[VPS Telemetry] Authentication verification query failure:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Initiates an explicit temporal session for Metered tier users.
 */
app.post('/queue/start-session', async (req, res) => {
  const { browser_id } = req.body;
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authentication context.' });
  }
  const deviceSecret = authHeader.split(' ')[1];

  pingDevice(browser_id);

  try {
    const device = await get(
      'SELECT approved, banned, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ? AND approved = 1',
      [browser_id, deviceSecret]
    );

    if (!device) return res.status(401).json({ error: 'Device unapproved or credentials rejected.' });
    if (device.banned === 1) return res.status(403).json({ error: 'Your device is permanently banned.' });

    if (device.priority_tier !== 'Metered') {
      return res.status(400).json({ error: 'Only Metered accounts manage temporal sessions.' });
    }

    const today = new Date().toISOString().split('T')[0];
    const session = await get(
      'SELECT session_count, last_session_at FROM device_sessions WHERE browser_id = ? AND session_date = ?',
      [browser_id, today]
    );

    const now = Date.now();
    let currentCount = session ? session.session_count : 0;

    if (currentCount >= 6) {
      return res.status(403).json({
        statusCode: 403,
        error: 'DAILY_SESSIONS_EXHAUSTED'
      });
    }

    if (!session) {
      await run(
        'INSERT INTO device_sessions (browser_id, session_date, session_count, last_session_at) VALUES (?, ?, 1, ?)',
        [browser_id, today, now]
      );
      currentCount = 1;
    } else {
      await run(
        'UPDATE device_sessions SET session_count = session_count + 1, last_session_at = ? WHERE browser_id = ? AND session_date = ?',
        [now, browser_id, today]
      );
      currentCount += 1;
    }

    console.log(`[VPS Sessions] Metered browser ${browser_id} explicitly started session #${currentCount}`);
    res.json({
      success: true,
      session: {
        count: currentCount,
        remaining: 6 - currentCount,
        active: true,
        time_remaining: 30 * 60 * 1000
      }
    });
  } catch (err) {
    console.error('[VPS Sessions] Error starting session:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/queue/join', async (req, res) => {
  const { browser_id, tab_id, req_id } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  pingDevice(browser_id);

  try {
    let device;
    if (device_secret === ADMIN_SECRET_KEY) {
      device = { approved: 1, banned: 0, priority_tier: 'Admin', discord_id: 'admin' };
    } else {
      device = await get(
        'SELECT approved, banned, priority_tier, discord_id FROM devices WHERE browser_id = ? AND device_secret = ?',
        [browser_id, device_secret]
      );
    }
    if (!device) return res.status(401).json({ error: 'Unauthorized' });
    if (device.banned === 1) return res.status(403).json({ error: 'Access Denied: Banned device.' });
    if (device.approved !== 1) return res.status(401).json({ error: 'Access Denied: Unapproved.' });

    // Enforce sliding-window session controls exclusively for the Metered/lowest tier
    if (device.priority_tier === 'Metered') {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD (UTC aligned)
      const session = await get(
        'SELECT session_count, last_session_at FROM device_sessions WHERE browser_id = ? AND session_date = ?',
        [browser_id, today]
      );

      const now = Date.now();
      const SESSION_WINDOW_MS = 30 * 60 * 1000; // Hard 30 minutes allocation limit

      if (!session || (now - session.last_session_at > SESSION_WINDOW_MS)) {
        // No active session window found. Reject join with session_required status so client prompts user.
        const count = session ? session.session_count : 0;
        console.warn(`[VPS Session Guard] Metered user ${browser_id} lacks active session window. Refusing entry.`);
        return res.status(403).json({
          statusCode: 403,
          error: 'SESSION_REQUIRED',
          remaining: 6 - count
        });
      }
      
      const elapsed = now - session.last_session_at;
      const remainingMinutes = ((SESSION_WINDOW_MS - elapsed) / 1000 / 60).toFixed(1);
      console.log(`[VPS Session Check] Metered browser ${browser_id} within active window. ${remainingMinutes}m remaining.`);
    }

    // 1-request-per-user limit: Enforce queue concurrency check on discord_id, NOT browser_id
    const existingIdx = queue.findIndex(t => {
      if (device.discord_id && device.discord_id !== 'admin' && t.discord_id === device.discord_id) return true;
      return t.browser_id === browser_id;
    });

    if (existingIdx !== -1) {
      if (queue[existingIdx].upstreamReq) queue[existingIdx].upstreamReq.destroy();
      const evictedTarget = queue[existingIdx].discord_id || queue[existingIdx].browser_id;
      queue.splice(existingIdx, 1);
      console.log(`[VPS Telemetry] Concurrency eviction: Terminated active lock for user/device: ${evictedTarget}`);
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
      discord_id: device.discord_id, // Lock queue item directly to Discord identity
      priority_tier: device.priority_tier,
      timestamp: Date.now(),
      last_polled_at: Date.now(),
      status: 'pending',
      started_processing_at: null,
      upstreamReq: null,
      has_burst_boost: hasBurstBoost
    });

    console.log(`[VPS Telemetry] Device "${browser_id}" (User: "${device.discord_id}") joined queue. ReqId: "${req_id}". Tier: "${device.priority_tier}"`);
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
  pingDevice(task.browser_id);

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

// Revamped Admin Devices endpoint consolidating with online RAM metrics & metadata
app.get('/admin/devices', verifyAdmin, async (req, res) => {
  try { 
    const rows = await all('SELECT * FROM devices');
    const groups = {};
    for (const row of rows) {
      const key = row.discord_id || `unlinked:${row.browser_id}`;
      const lastActive = activeSessions.get(row.browser_id) || row.last_active_at || 0;
      const isOnline = (Date.now() - lastActive) < 30000; // 30 seconds threshold
      
      if (!groups[key]) {
        groups[key] = {
          discord_id: row.discord_id || null,
          discord_username: row.discord_username || (row.discord_id ? `User (${row.discord_id.substring(0, 6)})` : "Unlinked Device"),
          priority_tier: row.priority_tier,
          approved: row.approved,
          banned: row.banned,
          anlas_consumed: 0,
          total_requests: 0,
          last_active_at: 0,
          is_online: false,
          devices: []
        };
      }
      
      groups[key].devices.push({
        browser_id: row.browser_id,
        label: row.label,
        approved: row.approved,
        banned: row.banned,
        anlas_consumed: row.anlas_consumed,
        total_requests: row.total_requests || 0,
        last_active_at: lastActive,
        is_online: isOnline
      });
      
      groups[key].anlas_consumed += row.anlas_consumed;
      groups[key].total_requests += (row.total_requests || 0);
      if (lastActive > groups[key].last_active_at) {
        groups[key].last_active_at = lastActive;
      }
      if (isOnline) {
        groups[key].is_online = true;
      }
      if (row.banned === 1) {
        groups[key].banned = 1;
      }
    }
    res.json(Object.values(groups));
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

/**
 * Decoupled endpoint to query linked footprints for a specific Discord user over HTTPS.
 */
app.get('/admin/user-devices', verifyAdmin, async (req, res) => {
  const { discord_id } = req.query;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    const devices = await all('SELECT browser_id, label, approved, banned, priority_tier, anlas_consumed, total_requests, last_active_at FROM devices WHERE discord_id = ?', [discord_id]);
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Decoupled query to fetch unnotified bans from the gateway VPS over HTTPS.
 */
app.get('/admin/unnotified-bans', verifyAdmin, async (req, res) => {
  try {
    const bans = await all('SELECT discord_id, reason FROM banned_discords WHERE is_notified = 0');
    res.json(bans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Decoupled command to mark a Discord user ban as DM-notified over HTTPS.
 */
app.post('/admin/mark-ban-notified', verifyAdmin, async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    await run('UPDATE banned_discords SET is_notified = 1 WHERE discord_id = ?', [discord_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/approve', verifyAdmin, async (req, res) => {
  const { browser_id, discord_id, priority_tier } = req.body;
  try {
    if (discord_id) {
      await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE discord_id = ?', [priority_tier, discord_id]);
      console.log(`[VPS Telemetry Admin] Approved Discord Account: "${discord_id}". Priority: "${priority_tier}"`);
    } else {
      await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE browser_id = ?', [priority_tier, browser_id]);
      console.log(`[VPS Telemetry Admin] Approved Unlinked Browser: "${browser_id}". Priority: "${priority_tier}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/revoke', verifyAdmin, async (req, res) => {
  const { browser_id, discord_id } = req.body;
  try {
    if (discord_id) {
      await run('UPDATE devices SET approved = 0 WHERE discord_id = ?', [discord_id]);
      console.log(`[VPS Telemetry Admin] Revoked access for Discord Account: "${discord_id}"`);
    } else {
      await run('UPDATE devices SET approved = 0 WHERE browser_id = ?', [browser_id]);
      console.log(`[VPS Telemetry Admin] Revoked access for Unlinked Browser: "${browser_id}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Explicit Flag-based Ban API Endpoints
app.post('/admin/ban', verifyAdmin, async (req, res) => {
  const { discord_id, browser_id, reason } = req.body;
  try {
    const banReason = reason || "Banned via Admin Console";
    if (discord_id) {
      await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)', [
        discord_id,
        Date.now(),
        banReason
      ]);
      await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [discord_id]);
      console.log(`[VPS Telemetry Admin] Banned Discord Account: "${discord_id}"`);
      // Force-evict banned users from the running queue
      queue = queue.filter(t => {
        if (t.discord_id === discord_id) {
          if (t.upstreamReq) t.upstreamReq.destroy();
          return false;
        }
        return true;
      });
    } else if (browser_id) {
      await run('UPDATE devices SET banned = 1 WHERE browser_id = ?', [browser_id]);
      console.log(`[VPS Telemetry Admin] Banned Unlinked Browser: "${browser_id}"`);
      queue = queue.filter(t => {
        if (t.browser_id === browser_id) {
          if (t.upstreamReq) t.upstreamReq.destroy();
          return false;
        }
        return true;
      });
    }
    processQueue();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/unban', verifyAdmin, async (req, res) => {
  const { discord_id, browser_id } = req.body;
  try {
    if (discord_id) {
      await run('DELETE FROM banned_discords WHERE discord_id = ?', [discord_id]);
      await run('UPDATE devices SET banned = 0 WHERE discord_id = ?', [discord_id]);
    } else if (browser_id) {
      await run('UPDATE devices SET banned = 0 WHERE browser_id = ?', [browser_id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/prune-device', verifyAdmin, async (req, res) => {
  const { browser_id } = req.body;
  try {
    await run('DELETE FROM devices WHERE browser_id = ?', [browser_id]);
    console.log(`[VPS Telemetry Admin] Pruned individual browser registration: "${browser_id}"`);
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

/**
 * @api {post} /admin/link Link Hardware Footprint
 * @apiGroup Admin
 * @apiDescription Links a registered device's browser footprint directly to a verified Discord ID.
 * Implements an automatic blacklist, a maximum of 3 active linked devices, and oldest device pruning.
 */
app.post('/admin/link', verifyAdmin, async (req, res) => {
  const { browser_id, discord_id, discord_username, priority_tier } = req.body;
  if (!browser_id || !discord_id || !priority_tier) {
    return res.status(400).json({ error: "Missing required linking parameters." });
  }

  try {
    // Check if user has been placed in the persistent blacklist schema
    const isBanned = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [discord_id]);
    if (isBanned) {
      return res.status(403).json({ error: "This Discord account is permanently blacklisted." });
    }

    // Verify browser footprint exists on database
    const device = await get('SELECT 1 FROM devices WHERE browser_id = ?', [browser_id]);
    if (!device) {
      return res.status(404).json({ error: "Device ID not recognized. Open NovelAI to register the client." });
    }

    // Limit Check: A single Discord account can have a maximum of 3 linked approved devices.
    const existingLinks = await all(
      'SELECT browser_id FROM devices WHERE discord_id = ? AND approved = 1 ORDER BY ROWID ASC',
      [discord_id]
    );

    if (existingLinks.length >= 3) {
      const oldestDevice = existingLinks[0].browser_id;
      // Automatically prune the oldest linked device
      await run(
        'UPDATE devices SET approved = 0, discord_id = NULL, discord_username = NULL WHERE browser_id = ?',
        [oldestDevice]
      );
      console.log(`[VPS Admin API] Automatically pruned oldest linked browser ID: ${oldestDevice} for user ${discord_id}`);
    }

    // Atomically link discord context and approve device
    await run(
      'UPDATE devices SET approved = 1, banned = 0, priority_tier = ?, discord_id = ?, discord_username = ? WHERE browser_id = ?',
      [priority_tier, discord_id, discord_username || null, browser_id]
    );
    console.log(`[VPS Admin API] Linked Discord ID ${discord_id} to browser ${browser_id} (${priority_tier})`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @api {post} /admin/sync-usernames Batch Sync Discord Usernames
 * @apiGroup Admin
 * @apiDescription Restores and updates missing discord_username metadata on legacy database records.
 */
app.post('/admin/sync-usernames', verifyAdmin, async (req, res) => {
  const { mappings } = req.body;
  if (!mappings || !Array.isArray(mappings)) {
    return res.status(400).json({ error: "Missing or invalid mappings payload array." });
  }

  try {
    // Execute all updates inside sequential queries to maintain SQLite integrity
    const promises = mappings.map(m => 
      run(
        'UPDATE devices SET discord_username = ? WHERE discord_id = ? AND (discord_username IS NULL OR discord_username LIKE "User (%")',
        [m.discord_username, m.discord_id]
      )
    );
    await Promise.all(promises);
    
    console.log(`[VPS Admin] Successfully batch synced usernames for ${mappings.length} legacy Discord profiles.`);
    res.json({ success: true });
  } catch (err) {
    console.error('[VPS Admin] Failed to process batch username sync:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @api {post} /admin/sync-tier Synchronize Discord User Tiers
 * @apiGroup Admin
 * @apiDescription Updates priority tiers for all approved devices matched to a specific Discord identity.
 */
app.post('/admin/sync-tier', verifyAdmin, async (req, res) => {
  const { discord_id, priority_tier } = req.body;
  if (!discord_id || !priority_tier) {
    return res.status(400).json({ error: "Missing sync parameters." });
  }

  try {
    const isBanned = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [discord_id]);
    if (isBanned) {
      return res.status(403).json({ error: "This Discord account is blacklisted." });
    }

    await run(
      'UPDATE devices SET approved = 1, priority_tier = ? WHERE discord_id = ?',
      [priority_tier, discord_id]
    );
    console.log(`[VPS Admin API] Updated tiers for devices mapped to Discord ID ${discord_id} to ${priority_tier}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @api {post} /admin/revoke-discord Revoke Discord Devices
 * @apiGroup Admin
 * @apiDescription Instantly deauthorizes every active browser footprint associated with a Discord ID.
 */
app.post('/admin/revoke-discord', verifyAdmin, async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) {
    return res.status(400).json({ error: "Missing discord_id parameter." });
  }

  try {
    await run('UPDATE devices SET approved = 0, discord_id = NULL, discord_username = NULL WHERE discord_id = ?', [discord_id]);
    console.log(`[VPS Admin API] Deauthorized all devices registered to Discord ID ${discord_id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Global Metrics endpoint for Discord Bot
app.get('/admin/global-stats', verifyAdmin, async (req, res) => {
  try {
    const devicesCount = await get('SELECT COUNT(*) as count FROM devices');
    const linkedUsersCount = await get('SELECT COUNT(DISTINCT discord_id) as count FROM devices WHERE discord_id IS NOT NULL');
    const totalAnlas = await get('SELECT SUM(anlas_consumed) as sum FROM devices');
    const totalRequests = await get('SELECT SUM(total_requests) as sum FROM devices');
    
    const topAnlas = await all('SELECT discord_id, discord_username, SUM(anlas_consumed) as anlas FROM devices WHERE discord_id IS NOT NULL GROUP BY discord_id ORDER BY anlas DESC LIMIT 5');
    const topRequests = await all('SELECT discord_id, discord_username, SUM(total_requests) as reqs FROM devices WHERE discord_id IS NOT NULL GROUP BY discord_id ORDER BY reqs DESC LIMIT 5');
    
    const bannedCount = await get('SELECT COUNT(*) as count FROM banned_discords');
    const bannedList = await all('SELECT discord_id, reason FROM banned_discords');

    res.json({
      total_devices: devicesCount.count,
      linked_users: linkedUsersCount.count,
      total_anlas_consumed: totalAnlas.sum || 0,
      total_requests: totalRequests.sum || 0,
      top_anlas_consumers: topAnlas,
      top_request_makers: topRequests,
      banned_count: bannedCount.count,
      banned_list: bannedList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scavenger Loop (TTL Maintenance)
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
 * Format-agnostic parameter extractor.
 * Safely parses JSON blocks or Multi-part streams, identifying active Precise character references.
 *
 * @param {Buffer} buffer - Outbound raw client payload buffer.
 * @returns {object|null} Structured parameters or null on parsing failure.
 */
function extractParametersFromRawBody(buffer) {
  try {
    if (!buffer || buffer.length === 0) return null;

    const bodyStr = buffer.toString('utf8');
    const cleanedStr = bodyStr.replace(/"(?:data:image\/[^"]+|[A-Za-z0-9+/=]{1000,})"/g, '""');

    let parsed = null;

    // Multipart/FormData JSON Extraction
    if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // "--"
      const firstLineEnd = cleanedStr.indexOf('\n');
      const boundary = firstLineEnd !== -1 ? cleanedStr.slice(0, firstLineEnd).trim() : '';

      const requestIndex = cleanedStr.indexOf('name="request"');
      if (requestIndex !== -1 && boundary) {
        const startIdx = cleanedStr.indexOf('{', requestIndex);
        if (startIdx !== -1) {
          const nextBoundary = cleanedStr.indexOf(boundary, startIdx);
          const endIdx = nextBoundary !== -1 ? nextBoundary : cleanedStr.length;

          let jsonCandidate = cleanedStr.slice(startIdx, endIdx).trim();
          const lastBrace = jsonCandidate.lastIndexOf('}');
          if (lastBrace !== -1) {
            jsonCandidate = jsonCandidate.slice(0, lastBrace + 1);
          }
          parsed = JSON.parse(jsonCandidate);
        }
      }
    } else {
      // Direct JSON Payload Parsing
      if (cleanedStr.trim().startsWith('{')) {
        parsed = JSON.parse(cleanedStr);
      }
    }

    if (parsed) {
      const params = parsed.parameters || parsed || {};
      
      // Multi-schema safety fallback: scan legacy, current, and alternative reference schemas
      const preciseRefs = 
        (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) +
        (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0) +
        (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0);

      return {
        width: params.width || parsed.width || null,
        height: params.height || parsed.height || null,
        steps: params.steps || parsed.steps || null,
        n_samples: params.n_samples || parsed.n_samples || null,
        precise_ref_count: preciseRefs
      };
    }
  } catch (err) {
    console.error('[VPS Audit] Error extracting parameters:', err);
  }
  return null;
}

/**
 * Audit request parameters on a separate thread tick.
 * Executes immediate database deauthorization sweeps on resource limit violations.
 *
 * @param {string} browserId - Unique device key.
 * @param {Buffer} payloadBuffer - Outbound parameters buffer.
 */
async function runBackgroundAudit(browserId, payloadBuffer) {
  const actualParams = extractParametersFromRawBody(payloadBuffer);
  if (!actualParams) return;

  const { width, height, steps, n_samples, precise_ref_count } = actualParams;
  
  const actualPixels = (width && height) ? (width * height) : 0;
  const actualSteps = steps || 0;
  const actualSamples = n_samples || 1;
  const actualRefs = precise_ref_count || 0;

  // Enforce NovelAI Opus free generation parameters
  const maxPixels = 1048576; // 1 Megapixel (1024x1024)
  const maxSteps = 28;

  const device = await get('SELECT priority_tier, discord_id FROM devices WHERE browser_id = ?', [browserId]);
  if (!device) return;

  const config = TIER_CONFIGS[device.priority_tier] || TIER_CONFIGS['Normal'];
  
  const isViolation = (actualPixels > maxPixels) || 
                      (actualSteps > maxSteps) || 
                      (actualSamples !== 1) || 
                      (actualRefs > config.preciseLimit);

  // Accounting Ledger Integration: Tracks master Anlas consumption (5 per precise reference)
  const anlasSpent = actualRefs * 5;
  if (anlasSpent > 0) {
    await run('UPDATE devices SET anlas_consumed = anlas_consumed + ? WHERE browser_id = ?', [anlasSpent, browserId]);
    console.log(`[VPS Audit Ledger] Deducted ${anlasSpent} Anlas on user profile ${device.discord_id || browserId} (refs used: ${actualRefs})`);
  }

  if (isViolation) {
    console.warn(`\x1b[31m[VPS SECURITY AUDIT] !!! VIOLATION DETECTED !!!\x1b[0m`);
    console.warn(`[VPS Security Audit] Device: "${browserId}", Tier: "${device.priority_tier}"`);
    console.warn(`[VPS Security Audit] Params: ${width}x${height} (${actualPixels} px), Steps: ${actualSteps}, Refs: ${actualRefs} (Limit: ${config.preciseLimit})`);

    try {
      if (device.discord_id) {
        console.warn(`[VPS Security Audit] Revoking all devices linked to Discord ID: "${device.discord_id}"`);
        await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)', [
          device.discord_id,
          Date.now(),
          `Firewall Violation: Max Steps=${maxSteps}, Max Refs=${config.preciseLimit}. Attempted: Steps=${actualSteps}, Refs=${actualRefs} on device ${browserId}`
        ]);
        await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [device.discord_id]);
      } else {
        console.warn(`[VPS Security Audit] Revoking browser_id directly: "${browserId}"`);
        await run('UPDATE devices SET banned = 1 WHERE browser_id = ?', [browserId]);
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