/**
 * COORDINATOR GATEWAY CORE (server.js)
 *
 * This coordinator manages concurrent API executions targeting NovelAI. 
 * It decouples guest configurations using a Split-Token schema, enforcing 
 * strict rate limits, programmatic parameter firewalls, and priority queuing.
 *
 * =========================================================================
 * PRODUCTION VPS ARCHITECTURE & SSL REVERSE PROXY REFERENCE
 * =========================================================================
 * Running this application nakedly on an exposed port (e.g. 3000) over http is 
 * an absolute security failure. This coordinator MUST run behind a reverse proxy 
 * handling automated TLS termination (e.g. Let's Encrypt via Caddy or Nginx).
 *
 * Recommended Caddy Configuration File (/etc/caddy/Caddyfile):
 * -------------------------------------------------------------------------
 * <SUBDOMAIN>.duckdns.org {
 *     reverse_proxy localhost:3000 {
 *         header_up Host {upstream_host}
 *         header_up X-Real-IP {remote_host}
 *     }
 * }
 * -------------------------------------------------------------------------
 */

const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { run, get, all } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY; // Must be set in the VPS environment for admin endpoints to function

// Strict Resource Whitelist. Prevents arbitrary request manipulation and credentials harvesting.
const PROXY_PATH_WHITELIST = new Set([
  'ai/generate-image',
  'ai/generate-image-stream',
  'ai/generate-stream' // Text/story Generation API endpoint
]);

// In-Memory Queue State for Channel A (Exclusive Generation Slot)
let queue = [];

// Channel B Concurrency State (Shared Text Generation Slots)
let activeTextGenerations = 0;
const MAX_CONCURRENT_TEXT_GENS = 3; 

const TIER_PRIORITIES = { 'Low': 0, 'Normal': 10, 'High': 20, 'Admin': 30 };

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

// ----------------- CENTRAL TELEMETRY MIDDLEWARE -----------------
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  // Read Caddy's X-Real-IP first, falling back to local socket IP if absent
  const rawIp = req.headers['x-real-ip'] || req.ip || 'unknown'; 
  const maskedIp = hashIP(rawIp);
  
  console.log(`[VPS Telemetry] ${timestamp} | ${req.method} ${req.url} | Client: ${maskedIp}`);
  next();
});

/**
 * Dynamically updates effective queue priorities using dynamic linear aging decay 
 * and allocates the next active execution task slot.
 */
function processQueue() {
  const activeImageTask = queue.find(t => t.status === 'processing');
  if (activeImageTask) return; // Non-preemptive constraint: active slots cannot be aborted midway
  if (queue.length === 0) return;

  const now = Date.now();
  const pendingTasks = queue.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) return;

  // Compute aged priorities: 1 increment per 30 seconds wait ceiling
  pendingTasks.forEach(task => {
    const elapsedSeconds = (now - task.timestamp) / 1000;
    const baseVal = TIER_PRIORITIES[task.priority_tier] ?? 10;
    task.effective_priority = baseVal + Math.floor(elapsedSeconds / 30);
  });

  // Sort Descending by priority, using creation timestamp as structural FIFO tiebreaker
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
    const device = await get(
      'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ? AND approved = 1',
      [browserId, deviceSecret]
    );
    if (!device) {
      console.warn(`[VPS Auth Warning] Rejected credentials for device: "${browserId}"`);
      return res.status(401).json({ error: 'Access Denied: Device credentials rejected.' });
    }

    isImageGen = pathPart === 'ai/generate-image' || pathPart === 'ai/generate-image-stream';
    isTextGen = pathPart === 'ai/generate-stream';

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

      // Enforce Hard Parametric Firewall Restrictions (Max 1MP, 28 Steps, Single Sample)
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
      // Runs on a separate tick to maintain absolute zero latency on active generations.
      if (isImageGen) {
        setImmediate(() => {
          runBackgroundAudit(browserId, payloadBuffer);
        });
      }

      const headers = { ...req.headers };
      headers['host'] = `${subdomain}.novelai.net`;
      headers['authorization'] = `Bearer ${masterToken}`;

      // Remove client metadata and conflicting HTTP headers.
      // Strip 'content-length' and 'transfer-encoding' to re-calculate them dynamically.
      const stripHeaders = [
        'x-browser-id', 'x-request-id', 'x-gen-width', 'x-gen-height', 'x-gen-steps', 'x-gen-samples',
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
        if (pathPart === 'ai/generate-image-stream' || pathPart === 'ai/generate-stream') {
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

// ----------------- STANDARD API ENDPOINTS (MIDDLEWARE APPLIED) -----------------
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

// Hardened Identity Verification Endpoint. Protects database states from malicious scraping.
app.get('/auth/status', async (req, res) => {
  const { browser_id } = req.query;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!browser_id || !device_secret) {
    return res.status(401).json({ error: 'Unauthenticated status query' });
  }

  try {
    const row = await get(
      'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ?', 
      [browser_id, device_secret]
    );
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
    const device = await get(
      'SELECT approved, priority_tier FROM devices WHERE browser_id = ? AND device_secret = ? AND approved = 1',
      [browser_id, device_secret]
    );
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const existingIdx = queue.findIndex(t => t.browser_id === browser_id);
    if (existingIdx !== -1) {
      if (queue[existingIdx].upstreamReq) queue[existingIdx].upstreamReq.destroy();
      queue.splice(existingIdx, 1);
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
      upstreamReq: null
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
    const baseVal = TIER_PRIORITIES[t.priority_tier] ?? 10;
    t.effective_priority = baseVal + Math.floor((now - t.timestamp) / 30000);
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
    // Forcefully drop processing connections stuck/hung for over 75 seconds
    if (t.status === 'processing' && (now - t.started_processing_at > 75000)) {
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
 * Extract actual parameters from the raw request buffer.
 * Performs a fast, low-overhead string search to bypass large binary image payloads.
 */
function extractParametersFromRawBody(buffer) {
  try {
    const bodyStr = buffer.toString('utf8');

    // 1. Handle raw JSON payloads (Text-to-Image)
    if (bodyStr.trim().startsWith('{')) {
      const parsed = JSON.parse(bodyStr);
      if (parsed && parsed.parameters) {
        return {
          width: parsed.parameters.width || null,
          height: parsed.parameters.height || null,
          steps: parsed.parameters.steps || null,
          n_samples: parsed.parameters.n_samples || null
        };
      }
    }

    // 2. Handle Multipart/FormData payloads (Image-to-Image / Inpainting)
    const paramIndex = bodyStr.indexOf('"parameters"');
    if (paramIndex !== -1) {
      // Isolate a small 1000-character slice starting from the parameters configuration
      const chunk = bodyStr.slice(paramIndex, paramIndex + 1000);

      const widthMatch = chunk.match(/"width"\s*:\s*(\d+)/);
      const heightMatch = chunk.match(/"height"\s*:\s*(\d+)/);
      const stepsMatch = chunk.match(/"steps"\s*:\s*(\d+)/);
      const samplesMatch = chunk.match(/"n_samples"\s*:\s*(\d+)/);

      return {
        width: widthMatch ? parseInt(widthMatch[1], 10) : null,
        height: heightMatch ? parseInt(heightMatch[1], 10) : null,
        steps: stepsMatch ? parseInt(stepsMatch[1], 10) : null,
        n_samples: samplesMatch ? parseInt(samplesMatch[1], 10) : null
      };
    }
  } catch (err) {
    console.error('[VPS Audit] Error extracting parameters from raw buffer:', err);
  }
  return null;
}

/**
 * Audit the request parameters in a separate event loop tick.
 * Automatically revokes device approval if parameters exceed free limits.
 */
async function runBackgroundAudit(browserId, payloadBuffer) {
  const actualParams = extractParametersFromRawBody(payloadBuffer);
  if (!actualParams) return;

  const { width, height, steps, n_samples } = actualParams;
  
  const actualPixels = (width && height) ? (width * height) : 0;
  const actualSteps = steps || 0;
  const actualSamples = n_samples || 1;

  // Enforce the strict NovelAI Opus free generation parameters
  const maxPixels = 1048576; // 1 Megapixel (1024x1024)
  const maxSteps = 28;

  const isViolation = (actualPixels > maxPixels) || (actualSteps > maxSteps) || (actualSamples !== 1);

  if (isViolation) {
    console.warn(`\x1b[31m[VPS SECURITY AUDIT] !!! VIOLATION DETECTED !!!\x1b[0m`);
    console.warn(`[VPS Security Audit] Device: "${browserId}"`);
    console.warn(`[VPS Security Audit] Actual parameters: ${width}x${height} (${actualPixels} px), Steps: ${actualSteps}, Samples: ${actualSamples}`);
    console.warn(`[VPS Security Audit] Revoking device approval in SQLite database...`);

    try {
      // Revoke approval state
      await run('UPDATE devices SET approved = 0 WHERE browser_id = ?', [browserId]);
      console.log(`[VPS Security Audit] Success. Device "${browserId}" has been banned.`);
    } catch (dbErr) {
      console.error('[VPS Security Audit] Failed to execute database ban:', dbErr);
    }
  }
}

app.listen(PORT, '127.0.0.1', () => console.log(`Gateway coordinator running on port ${PORT}`));