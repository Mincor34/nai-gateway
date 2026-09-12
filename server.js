/**
 * LEVEL 5: SERVICE ORCHESTRATOR & BOOTSTRAPPER (server.js)
 *
 * Implements:
 * - Unidirectional architecture routing
 * - Global IP hashing middleware
 * - Stream-safe unparsed /proxy mount
 * - Post-stream standard body-parsers for /auth, /queue, /admin
 * - Resilient warm-boot telemetry harvester with shared Promise deduplication
 * - Active telemetry heartbeat loop to eliminate stale-state client drops
 */

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { initDatabase, get } = require('./database');
const queueManager = require('./queueManager');

// Route Controllers (Level 4)
const proxyRouter = require('./routes/proxyRouter');
const authRouter = require('./routes/authRouter');
const queueRouter = require('./routes/queueRouter');
const adminRouter = require('./routes/adminRouter');

const app = express();

// IP Telemetry Cryptographic Salt
const IP_SALT = crypto.randomBytes(16).toString('hex');

// V5 Master Account Telemetry Registry
let master_v5_percent = 100;
let last_fetched_at = 0;
let is_hard_locked = false;
let activeFetchPromise = null;

/**
 * Asynchronously synchronizes master account subscription telemetry.
 * Leverages shared Promise resolution to prevent cache stampedes.
 *
 * @returns {Promise<void>} Resolves when telemetry is synchronized.
 */
function syncTelemetry() {
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async () => {
    try {
      const config = loadConfig(process.env);
      const configRecord = await get('SELECT value FROM config WHERE key = ?', ['master_token']);
      if (!configRecord || !configRecord.value) {
        console.warn("[VPS Harvester] Telemetry sync skipped: No master_token configured in database yet.");
        return;
      }
      const masterToken = configRecord.value;

      console.log("[VPS Harvester] Fetching master subscription telemetry...");

      await new Promise((resolve, reject) => {
        const baseUrl = config.UPSTREAM_BASE_URL_TEMPLATE.replace('{subdomain}', 'image');
        const telemetryUrl = `${baseUrl}/user/subscription`;
        const parsedUrl = new URL(telemetryUrl);

        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${masterToken}`,
            'User-Agent': 'nai-gateway-v5-harvester/1.0'
          },
          timeout: config.TELEMETRY_FETCH_TIMEOUT_MS
        };

        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const req = transport.request(options, (res) => {
          let rawData = '';
          res.on('data', chunk => rawData += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const payload = JSON.parse(rawData);
                const percent = payload.usage?.percent;
                if (typeof percent === 'number') {
                  master_v5_percent = percent;
                  last_fetched_at = Date.now();
                  is_hard_locked = (percent < 10);
                  console.log(`[VPS Harvester] Telemetry sync successful. Capacity: ${master_v5_percent}%, Locked: ${is_hard_locked}`);
                  resolve();
                } else {
                  reject(new Error("Malformed subscription response payload: usage.percent missing."));
                }
              } else {
                reject(new Error(`Upstream returned error status code: ${res.statusCode}`));
              }
            } catch (parseErr) {
              reject(parseErr);
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Upstream fetch timed out after ${config.TELEMETRY_FETCH_TIMEOUT_MS}ms.`));
        });

        req.end();
      });
    } catch (err) {
      console.error("[VPS Harvester] Exception in telemetry harvester sync:", err.message);
      throw err; // Propagate exception to boot sequence for explicit error logging
    } finally {
      activeFetchPromise = null;
    }
  })();

  return activeFetchPromise;
}

// Global Telemetry Attachment Middleware
app.use((req, res, next) => {
  req.telemetry = {
    get percent() { return master_v5_percent; },
    get lastFetched() { return last_fetched_at; },
    get isHardLocked() { return is_hard_locked; },
    triggerSync: () => {
      const config = loadConfig(process.env);
      const now = Date.now();
      if (!activeFetchPromise && (now - last_fetched_at > config.TELEMETRY_COOLDOWN_MS)) {
        setImmediate(() => {
          syncTelemetry().catch(err => console.error("[VPS Telemetry] Out-of-band sync failed:", err.message));
        });
      }
    },
    ensureFresh: async () => {
      const config = loadConfig(process.env);
      const now = Date.now();
      if (last_fetched_at === 0 || (now - last_fetched_at > config.TELEMETRY_STALE_MS)) {
        await syncTelemetry();
      }
    }
  };
  next();
});

// Central Request Logger
app.use((req, res, next) => {
  if (req.url === '/favicon.ico') return res.status(204).end();
  const timestamp = new Date().toISOString();
  const rawIp = req.headers['x-real-ip'] || req.ip || 'unknown'; 
  const maskedIp = (rawIp === 'unknown' || rawIp === '127.0.0.1' || rawIp === '::1')
    ? 'local/unknown'
    : crypto.createHash('sha256').update(rawIp + IP_SALT).digest('hex').substring(0, 12);
  console.log(`[VPS Telemetry] ${timestamp} | ${req.method} ${req.url} | Client: ${maskedIp}`);
  next();
});

// ----------------- ROUTE CONTROLLER MOUNTING -----------------

// 1. Mount Stream-Safe Proxy Router WITHOUT global body-parsers
app.use('/proxy', proxyRouter);

// 2. Mount standard body parsers strictly AFTER stream-sensitive proxy boundaries
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Mount remaining service routers
app.use('/auth', authRouter);
app.use('/queue', queueRouter);
app.use('/admin', adminRouter);

// Start Queue Scavenger GC cycle
queueManager.startGc();

let serverInstance = null;
let heartbeatInterval = null;

// Bootstrap Sequence Guard
const bootConfig = loadConfig(process.env);

initDatabase(bootConfig.DATABASE_PATH)
  .then(async () => {
    try {
      console.log("[VPS Boot] Executing warm boot subscription sync...");
      await syncTelemetry();
    } catch (warmBootErr) {
      console.warn("[VPS Boot] Warm boot telemetry pull failed. Initializing with default metrics:", warmBootErr.message);
    }

    // Active Telemetry Heartbeat: Refresh every 10 minutes to eliminate stale client drops
    const heartbeatMs = Math.min(600000, Math.floor(bootConfig.TELEMETRY_STALE_MS / 2));
    heartbeatInterval = setInterval(() => {
      syncTelemetry().catch(err => console.warn("[VPS Harvester] Heartbeat refresh failed:", err.message));
    }, heartbeatMs);

    if (heartbeatInterval.unref) {
      heartbeatInterval.unref();
    }
    
    serverInstance = app.listen(bootConfig.PORT, '127.0.0.1', () => {
      console.log(`Gateway coordinator running on port ${bootConfig.PORT}`);
    });
  })
  .catch((err) => {
    console.error("[VPS Critical] Database initialization failed. Terminating engine process.", err);
    process.exit(1);
  });

module.exports = {
  app,
  get server() {
    return serverInstance;
  },
  get gcInterval() {
    return queueManager.gcInterval;
  },
  get heartbeatInterval() {
    return heartbeatInterval;
  },
  queueManager,
  syncTelemetry
};