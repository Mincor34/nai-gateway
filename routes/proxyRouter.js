/**
 * LEVEL 4: STREAM-SAFE PROXY ROUTER (routes/proxyRouter.js)
 * 
 * Enforces strict req.pause() Stream Safety before executing database transactions.
 * Enforces ACS-1 ingress staging semaphore (activeBufferingStreams <= INGRESS_SEMAPHORE_MAX),
 * upload inactivity & duration deadlines, TTL re-anchoring at req.on('end'), synchronous
 * Stage 5 anti-spoofing parameter reconciliation, Stage 6 V5 model-aware deadband firewall,
 * Stage 7 authoritative cost calculation (`C_auth`, including Module 643656 V5 1.5x,
 * Medium / 1.75, `usageNegative` Opus lightweight bonus guard, and `/ai/upscale` 1..4 Anlas
 * binary-header dimension pricing) + in-memory holds + V5 NCP verification, and Stage 9
 * Point-of-No-Return (PoNR) SQLite + `period_usage` settlement strictly on upstream HTTP 200 OK
 * via serialized Bucket 2 persistence (`req.telemetry.persistSurplusPool`).
 * Sanitizes `/user/subscription` responses via an explicit allow-list (supporting compressed
 * upstream responses via zlib) for non-Admin principals so master Anlas balances and payment
 * processor metadata never leak to guest browsers, evaluating billing-cycle Anlas resets
 * cleanly on cold page load and replacing `trainingStepsLeft` with live `availableAnlas`.
 * Converts upstream NovelAI 401 responses into 503 MASTER_TOKEN_EXPIRED and shields
 * cooldown windows so expired master credentials never report false TELEMETRY_FETCH_FAILED
 * errors, never forward dead credentials upstream, and never wipe guest device approvals.
 * Relational Normalization: Deducts allowances, charges Anlas/NCP, and evaluates bans against canonical user_id.
 */

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { get, run } = require('../database');
const { loadConfig } = require('../config');

const router = express.Router();

const VIBE_ENCODE_ANLAS_COST = 2;
const UPSCALE_MIN_ANLAS_COST = 1;
const BASE_PAID_MIN_ANLAS = 2;
const V5_HIGH_NCP_COST = 18;
const V5_MEDIUM_NCP_COST = 10;
const MAX_SUBSCRIPTION_RESPONSE_BYTES = 1048576; // 1MB sanity ceiling for /user/subscription rewrite

// Atomic Ingress Staging Concurrency Counter (bounds concurrent 50MB upload buffers)
let activeBufferingStreams = 0;

// Unified per-principal serialization gate for cross-channel Anlas balance checks, holds & PoNR commits
const userAnlasAuthLocks = new Map();

router.getActiveBufferingStreams = () => activeBufferingStreams;

function getConfig() {
  return loadConfig(process.env);
}

/**
 * Serializes asynchronous Anlas balance evaluation, in-memory hold placement, and PoNR
 * SQLite debit + hold release per canonical user_id across both Channel A image/upscale
 * requests and Channel B vibe encodes, preventing concurrent requests from interleaving across
 * SQLite writes and RAM hold teardown (including post-200 client socket aborts).
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {Function} fn - Asynchronous critical-section callback.
 * @returns {Promise<*>} Result of critical-section execution.
 */
async function withUserAnlasAuthLock(userId, fn) {
  const previous = userAnlasAuthLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  userAnlasAuthLocks.set(userId, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (userAnlasAuthLocks.get(userId) === tail) {
      userAnlasAuthLocks.delete(userId);
    }
  }
}

/**
 * Strictly parses an optional non-negative safe integer HTTP header.
 *
 * @param {*} raw - Raw header value.
 * @param {number} [defaultValue=0] - Fallback when header is omitted.
 * @returns {{ok: boolean, provided: boolean, value: number}}
 */
function parseStrictNonNegativeIntHeader(raw, defaultValue = 0) {
  if (raw === undefined) {
    return { ok: true, provided: false, value: defaultValue };
  }
  if (typeof raw !== 'string') {
    return { ok: false, provided: true, value: 0 };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, provided: true, value: 0 };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, provided: true, value: 0 };
  }
  return { ok: true, provided: true, value: parsed };
}

/**
 * Strictly parses an optional boolean ('true' | 'false') HTTP header.
 *
 * @param {*} raw - Raw header value.
 * @returns {{ok: boolean, provided: boolean, value: boolean}}
 */
function parseBooleanHeader(raw) {
  if (raw === undefined) {
    return { ok: true, provided: false, value: false };
  }
  if (typeof raw !== 'string') {
    return { ok: false, provided: true, value: false };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return { ok: true, provided: true, value: true };
  if (normalized === 'false') return { ok: true, provided: true, value: false };
  return { ok: false, provided: true, value: false };
}

/**
 * Parses the operational `X-Scraped-Anlas` telemetry canary header without failing
 * or penalizing the request on missing or malformed UI scrapes.
 *
 * @param {*} raw - Raw header value.
 * @returns {number|null} Parsed integer canary or null.
 */
function parseScrapedCanaryHeader(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Decodes compressed upstream JSON payloads (`gzip`, `deflate`, `br`) safely while bounding
 * decompressed heap expansion.
 *
 * @param {Buffer} rawBuf - Raw upstream body bytes.
 * @param {string|undefined} contentEncodingHeader - Upstream `content-encoding` header.
 * @returns {Buffer} Uncompressed UTF-8 JSON buffer.
 */
function decompressSubscriptionBuffer(rawBuf, contentEncodingHeader) {
  const enc = typeof contentEncodingHeader === 'string'
    ? contentEncodingHeader.trim().toLowerCase()
    : '';
  const maxOutputLength = MAX_SUBSCRIPTION_RESPONSE_BYTES * 4;

  if (enc === 'gzip' || enc === 'x-gzip') {
    return zlib.gunzipSync(rawBuf, { maxOutputLength });
  }
  if (enc === 'deflate') {
    return zlib.inflateSync(rawBuf, { maxOutputLength });
  }
  if (enc === 'br') {
    return zlib.brotliDecompressSync(rawBuf, { maxOutputLength });
  }
  return rawBuf;
}

router.all('/:subdomain/{*splat}', async (req, res) => {
  // 1. STREAM INVARIANT: Immediately pause socket reading to prevent OS buffer truncation during async blocking
  req.pause();

  const config = getConfig();
  const { subdomain } = req.params;
  const pathPart = Array.isArray(req.params.splat) ? req.params.splat.join('/') : (req.params.splat || '');

  let isStreamResumed = false;
  const safeResume = () => {
    if (!isStreamResumed) {
      isStreamResumed = true;
      try { req.resume(); } catch (_) {}
    }
  };

  let bufferingSlotAcquired = false;
  const acquireBufferingSlot = () => {
    if (bufferingSlotAcquired) return true;
    if (activeBufferingStreams >= config.INGRESS_SEMAPHORE_MAX) {
      return false;
    }
    activeBufferingStreams += 1;
    bufferingSlotAcquired = true;
    return true;
  };
  const releaseBufferingSlot = () => {
    if (!bufferingSlotAcquired) return;
    bufferingSlotAcquired = false;
    activeBufferingStreams = Math.max(0, activeBufferingStreams - 1);
  };

  let inactivityTimer = null;
  let ceilingTimer = null;
  const clearUploadTimers = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (ceilingTimer) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
  };

  let activeTask = null;
  let upstreamReq = null;
  let cleanupExecuted = false;
  let isTextGenClaimed = false;
  let textGenLockId = null;

  const isImageGen = pathPart === 'ai/generate-image' || pathPart === 'ai/generate-image-stream';
  const isUpscale = pathPart === 'ai/upscale';
  const isTextGen = pathPart === 'ai/generate-stream' || pathPart === 'oa/v1/completions';
  const isVibeEncode = pathPart === 'ai/encode-vibe';
  const isUserSubscription = pathPart.replace(/^\/+/, '') === 'user/subscription';

  const rawGenModelHeader = req.headers['x-gen-model'];
  const normalizedHeaderModel = typeof rawGenModelHeader === 'string' ? rawGenModelHeader.trim().toLowerCase() : '';
  const isV5Header = normalizedHeaderModel === 'v5' || normalizedHeaderModel === 'v5-medium';
  const isV5MediumHeader = normalizedHeaderModel === 'v5-medium';
  let effectiveIsV5 = isV5Header;

  const isConnectionAborted = () => cleanupExecuted || res.destroyed || res.writableEnded;

  const executeCleanup = () => {
    if (cleanupExecuted) return;
    cleanupExecuted = true;

    clearUploadTimers();
    releaseBufferingSlot();

    if (upstreamReq) {
      try { upstreamReq.destroy(); } catch (_) {}
    }

    if (isTextGenClaimed && textGenLockId) {
      queueManager.releaseTextSlot(textGenLockId);
    }

    if (activeTask) {
      queueManager.complete(activeTask.req_id, browserId);
      console.log(`[GuildWeave Telemetry] Stream cleaned up. Slot released for request: "${activeTask.req_id}"`);
    }

    if (isImageGen && effectiveIsV5 && req.telemetry) {
      req.telemetry.triggerSync();
    }
  };

  const destroyInboundAfterFlush = () => {
    req.pause();
    if (res.writableFinished) {
      try { req.destroy(); } catch (_) {}
      return;
    }
    res.once('finish', () => {
      try { req.destroy(); } catch (_) {}
    });
    const fallbackDestroy = setTimeout(() => {
      try { req.destroy(); } catch (_) {}
    }, 250);
    if (fallbackDestroy.unref) fallbackDestroy.unref();
  };

  const sendEarlyError = (status, payload) => {
    // Ingress Failure Invariant: For early ingress drops, release locks/timers immediately,
    // flush the HTTP rejection cleanly, and destroy the inbound socket.
    executeCleanup();
    if (!res.headersSent) {
      res.setHeader('Connection', 'close');
      res.status(status).json(payload);
    }
    destroyInboundAfterFlush();
  };

  const browserId = req.headers['x-browser-id'];
  const clientAuth = req.headers['authorization'];

  // SSRF Protection Rule: Reject arbitrary target routing
  if (!config.SUBDOMAIN_WHITELIST.includes(subdomain)) {
    console.warn(`[GuildWeave SSRF Warning] Target subdomain rejected: "${subdomain}"`);
    return sendEarlyError(403, { error: 'SSRF Shield: Unauthorized subdomain destination.' });
  }

  // Privilege Escalation Prevention Rule: Ensure requested endpoint is strictly whitelisted
  if (!config.PROXY_PATH_WHITELIST.has(pathPart)) {
    console.warn(`[GuildWeave Security Warning] Target path non-whitelisted: "${pathPart}"`);
    return sendEarlyError(403, { error: 'Access Denied: Path not whitelisted for proxying.' });
  }

  if (!browserId || !clientAuth || !clientAuth.startsWith('Bearer ')) {
    return sendEarlyError(401, { error: 'Missing routing authorization context.' });
  }
  const deviceSecret = clientAuth.split(' ')[1];

  res.on('close', executeCleanup);
  res.on('finish', executeCleanup);

  try {
    // Authoritative Centralized Verification Gate: Resolves canonical user identity
    const auth = await auditEngine.verifyDevice(browserId, deviceSecret, { requireApproval: true });
    if (isConnectionAborted()) return;
    if (!auth.ok) {
      return sendEarlyError(auth.status, { error: auth.error });
    }
    const device = auth.device;
    const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
    queueManager.ping(browserId);

    const requestId = req.headers['x-request-id'];
    let isBasePaidHeader = false;
    let declaredAnlas = 0;
    let declaredAnlasProvided = false;
    let scrapedAnlas = null;

    // Stage 1: Ingress Validation for Image Generation
    if (isImageGen) {
      // Reject missing model headers to prevent accidental bans on outdated clients
      if (!rawGenModelHeader) {
        console.warn(`[GuildWeave Gatekeeper] Rejected image gen request from browser "${browserId}" due to missing model validation header (outdated script).`);
        return sendEarlyError(426, {
          statusCode: 426,
          error: 'SCRIPT_UPDATE_REQUIRED',
          message: 'Your GuildWeave Tampermonkey userscript is outdated. Please update to the latest version to proceed.'
        });
      }

      if (normalizedHeaderModel !== 'v5' && normalizedHeaderModel !== 'v5-medium' && normalizedHeaderModel !== 'legacy') {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'Invalid X-Gen-Model routing header.'
        });
      }

      // Resolve any Channel A task owned by this authenticated client prior to gated exits so early drops never strand locks
      activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;

      const basePaidParsed = parseBooleanHeader(req.headers['x-base-paid']);
      if (!basePaidParsed.ok) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'X-Base-Paid header must be "true" or "false".'
        });
      }
      isBasePaidHeader = basePaidParsed.value;

      const declaredAnlasParsed = parseStrictNonNegativeIntHeader(req.headers['x-declared-anlas'], 0);
      if (!declaredAnlasParsed.ok) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'X-Declared-Anlas header must be a non-negative integer.'
        });
      }
      declaredAnlas = declaredAnlasParsed.value;
      declaredAnlasProvided = declaredAnlasParsed.provided;
      scrapedAnlas = parseScrapedCanaryHeader(req.headers['x-scraped-anlas']);

      const widthHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-width'], 0);
      const heightHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-height'], 0);
      const stepsHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-steps'], 0);
      const samplesHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-samples'], 1);
      const refsHeader = parseStrictNonNegativeIntHeader(req.headers['x-precise-refs'], 0);

      if (!widthHeader.ok || !heightHeader.ok || !stepsHeader.ok || !samplesHeader.ok || !refsHeader.ok) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'Generation parameter routing headers must be non-negative integers.'
        });
      }

      const width = widthHeader.value;
      const height = heightHeader.value;
      const steps = stepsHeader.value;
      const samples = samplesHeader.value;
      const preciseRefs = refsHeader.value;
      const totalPixels = width * height;

      // Reject forged X-Base-Paid=true on explicitly declared free Opus geometry pre-buffer
      const hasExplicitHeaderGeometry = widthHeader.provided && width > 0 && heightHeader.provided && height > 0;
      if (
        isBasePaidHeader &&
        hasExplicitHeaderGeometry &&
        totalPixels <= config.FIREWALL_MAX_PIXELS &&
        samples === config.FIREWALL_MAX_SAMPLES &&
        (isV5MediumHeader || !stepsHeader.provided || steps <= config.FIREWALL_MAX_STEPS)
      ) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'PARAMETRIC_LIMIT_EXCEEDED',
          message: 'Baseline <=1MP, 1-sample parameters are not eligible for X-Base-Paid exemption.'
        });
      }

      const requestsAnlasBypass = isBasePaidHeader || declaredAnlas > 0;

      // Ensure fresh subscription telemetry for V5 or Anlas-consuming requests
      if (isV5Header || requestsAnlasBypass) {
        if (!req.telemetry) {
          console.error(`[GuildWeave Gatekeeper] Critical: Telemetry context missing on gated execution. Failing closed.`);
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_UNAVAILABLE',
            message: 'Master subscription telemetry service is unavailable.'
          });
        }

        try {
          await req.telemetry.ensureFresh();
        } catch (telemetryErr) {
          if (isConnectionAborted()) return;
          console.error(`[GuildWeave Gatekeeper] On-demand telemetry sync failed:`, telemetryErr.message);
          activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;
          if (req.telemetry.masterTokenExpired) {
            return sendEarlyError(503, {
              statusCode: 503,
              error: 'MASTER_TOKEN_EXPIRED',
              message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
            });
          }
          if (req.telemetry.lastFetched === 0) {
            return sendEarlyError(503, {
              statusCode: 503,
              error: 'TELEMETRY_FETCH_FAILED',
              message: 'Unable to verify master account capacity with upstream.'
            });
          }
        }

        if (isConnectionAborted()) return;

        // Re-verify Channel A lock ownership after async telemetry I/O so an evicted task cannot race upstream
        activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;

        if (req.telemetry.masterTokenExpired) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'MASTER_TOKEN_EXPIRED',
            message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
          });
        }

        if (req.telemetry.lastFetched === 0) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_UNAVAILABLE',
            message: 'Master subscription telemetry has not been initialized.'
          });
        }
      }

      // Master Token Expiry Gate (shields legacy free requests from hitting upstream with revoked credentials)
      if (req.telemetry && req.telemetry.masterTokenExpired) {
        console.warn(`[GuildWeave Gatekeeper] Generation blocked for browser "${browserId}": Master token expired upstream.`);
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_TOKEN_EXPIRED',
          message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
        });
      }

      // Master Opus Subscription Active Gate (applies to all image generations once telemetry is initialized)
      if (req.telemetry && req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
        console.warn(`[GuildWeave Gatekeeper] Generation blocked for browser "${browserId}": Master Opus subscription is inactive.`);
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_SUBSCRIPTION_INACTIVE',
          message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
        });
      }

      // V5 Operational Circuit Breaker (non-base-paid V5 blocked at <=5.5%)
      if (isV5Header && !isBasePaidHeader && req.telemetry && req.telemetry.isHardLocked) {
        console.warn(`[GuildWeave Gatekeeper] V5 generation blocked by circuit breaker for browser "${browserId}". Projected V5 Capacity: ${req.telemetry.percent.toFixed(2)}%`);
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'V5_BATTERY_CRITICAL',
          message: `Shared V5 capacity is recharging (${req.telemetry.percent.toFixed(2)}% <= ${config.V5_CIRCUIT_BREAKER_PERCENT}%). Switch to a legacy model or enable monthly Anlas.`
        });
      }

      // Validate active Channel A queue lock
      if (!requestId) return sendEarlyError(400, { error: 'Missing request ID.' });

      if (!activeTask) {
        return sendEarlyError(403, {
          statusCode: 403,
          message: 'Anlas Protection: Transaction queue verification lock required.'
        });
      }

      // Soft Header Parametric Firewall verification (Fast ingress drop without persistent ban)
      const violations = [];

      if (!isBasePaidHeader) {
        if (totalPixels > config.FIREWALL_MAX_PIXELS) {
          violations.push(`Resolution of ${width}x${height} (${totalPixels}px) exceeds the maximum limit of ${config.FIREWALL_MAX_PIXELS.toLocaleString('en-US')}px (1MP)`);
        }
        if (!isV5Header && steps > config.FIREWALL_MAX_STEPS) {
          violations.push(`Steps count of ${steps} exceeds the maximum limit of ${config.FIREWALL_MAX_STEPS} steps`);
        }
        if (samples !== config.FIREWALL_MAX_SAMPLES) {
          violations.push(`Samples count of ${samples} exceeds the maximum limit of ${config.FIREWALL_MAX_SAMPLES} sample (single-image generation only)`);
        }
      }
      if (preciseRefs > tierConfig.preciseLimit) {
        violations.push(`Precise references count of ${preciseRefs} exceeds your max limit of ${tierConfig.preciseLimit}`);
      }

      if (violations.length > 0) {
        const combinedMessage = `\n\nAnlas Protection Limit Violations:\n` + violations.map(v => `• ${v}`).join('\n');
        return sendEarlyError(400, { statusCode: 400, message: combinedMessage, violations });
      }

      // Pre-Buffer Anlas Master Solvency, Billing-Cycle Reset & Spend Fast-Fail Gate
      if (requestsAnlasBypass) {
        const requiredFloor = isBasePaidHeader ? Math.max(declaredAnlas, BASE_PAID_MIN_ANLAS) : declaredAnlas;
        if (
          req.telemetry.masterAnlas !== null &&
          req.telemetry.masterAnlas !== undefined &&
          req.telemetry.masterAnlas < requiredFloor
        ) {
          console.warn(
            `[GuildWeave Gatekeeper] Anlas bypass blocked for browser "${browserId}": Master Anlas (${req.telemetry.masterAnlas}) < required (${requiredFloor}).`
          );
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'MASTER_ANLAS_DEPLETED',
            message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for this generation (${requiredFloor} Anlas required).`
          });
        }

        const skipColdBootReset = Boolean(
          req.telemetry &&
          req.telemetry.lastFetched === 0 &&
          req.telemetry.activeCycleEpoch === null
        );
        if (!skipColdBootReset) {
          await auditEngine.evaluateAnlasReset(device.user_id, {
            now: Date.now(),
            activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
            isGracePeriod: req.telemetry?.isGracePeriod ?? false,
            subscriptionActive: req.telemetry?.subscriptionActive ?? true
          });
          if (isConnectionAborted()) return;
        }

        const netHeldAnlas = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
        const preBufferAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
          declaredAnlas,
          isBasePaid: isBasePaidHeader,
          heldAnlas: netHeldAnlas
        });
        if (isConnectionAborted()) return;

        // Re-verify Channel A lock after async DB calls
        activeTask = queueManager.getProcessingTask(requestId, browserId);
        if (!activeTask) {
          return sendEarlyError(403, {
            statusCode: 403,
            message: 'Anlas Protection: Transaction queue verification lock lost.'
          });
        }

        if (!preBufferAuth.ok) {
          return sendEarlyError(preBufferAuth.status, {
            statusCode: preBufferAuth.status,
            error: preBufferAuth.error,
            message: preBufferAuth.message
          });
        }
      }
    } else if (isUpscale) {
      // Stage 1: Channel A Upscale Gate (Anlas-billed, exempt from V5 battery/NCP limits)
      activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;

      const declaredAnlasParsed = parseStrictNonNegativeIntHeader(req.headers['x-declared-anlas'], UPSCALE_MIN_ANLAS_COST);
      if (!declaredAnlasParsed.ok) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'X-Declared-Anlas header must be a non-negative integer.'
        });
      }
      declaredAnlas = declaredAnlasParsed.value;
      declaredAnlasProvided = declaredAnlasParsed.provided;

      const widthHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-width'], 0);
      const heightHeader = parseStrictNonNegativeIntHeader(req.headers['x-gen-height'], 0);
      if (!widthHeader.ok || !heightHeader.ok) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'INVALID_HEADERS',
          message: 'Upscale dimension headers must be non-negative integers.'
        });
      }

      if (declaredAnlasParsed.provided && declaredAnlas < UPSCALE_MIN_ANLAS_COST) {
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'SPEND_CAP_EXCEEDED',
          message: `X-Declared-Anlas for upscaling must be at least ${UPSCALE_MIN_ANLAS_COST}.`
        });
      }
      if (widthHeader.provided && heightHeader.provided) {
        try {
          auditEngine.calculateUpscaleAnlasCost(widthHeader.value, heightHeader.value);
        } catch (hdrCostErr) {
          return sendEarlyError(400, {
            statusCode: 400,
            error: 'PARAMETRIC_LIMIT_EXCEEDED',
            message: hdrCostErr.message
          });
        }
      }

      if (!req.telemetry) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry service is unavailable.'
        });
      }

      try {
        await req.telemetry.ensureFresh();
      } catch (telemetryErr) {
        if (isConnectionAborted()) return;
        activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;
        if (req.telemetry.masterTokenExpired) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'MASTER_TOKEN_EXPIRED',
            message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
          });
        }
        if (req.telemetry.lastFetched === 0) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_FETCH_FAILED',
            message: 'Unable to verify master account capacity with upstream.'
          });
        }
      }

      if (isConnectionAborted()) return;
      activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;

      if (req.telemetry.masterTokenExpired) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_TOKEN_EXPIRED',
          message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
        });
      }
      if (req.telemetry.lastFetched === 0) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry has not been initialized.'
        });
      }
      if (req.telemetry.subscriptionActive === false) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_SUBSCRIPTION_INACTIVE',
          message: 'Master NovelAI Opus subscription is inactive or expired. Upscaling temporarily unavailable.'
        });
      }

      if (!requestId) return sendEarlyError(400, { error: 'Missing request ID.' });
      if (!activeTask) {
        return sendEarlyError(403, {
          statusCode: 403,
          message: 'Anlas Protection: Transaction queue verification lock required.'
        });
      }

      const requiredFloor = Math.max(declaredAnlas, UPSCALE_MIN_ANLAS_COST);
      if (
        req.telemetry.masterAnlas !== null &&
        req.telemetry.masterAnlas !== undefined &&
        req.telemetry.masterAnlas < requiredFloor
      ) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_ANLAS_DEPLETED',
          message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for upscaling (${requiredFloor} Anlas required).`
        });
      }

      const skipColdBootReset = Boolean(
        req.telemetry &&
        req.telemetry.lastFetched === 0 &&
        req.telemetry.activeCycleEpoch === null
      );
      if (!skipColdBootReset) {
        await auditEngine.evaluateAnlasReset(device.user_id, {
          now: Date.now(),
          activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
          isGracePeriod: req.telemetry?.isGracePeriod ?? false,
          subscriptionActive: req.telemetry?.subscriptionActive ?? true
        });
        if (isConnectionAborted()) return;
      }

      const netHeldAnlas = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
      const preBufferAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
        declaredAnlas: requiredFloor,
        requiredAnlas: requiredFloor,
        isBasePaid: false,
        heldAnlas: netHeldAnlas
      });
      if (isConnectionAborted()) return;

      activeTask = queueManager.getProcessingTask(requestId, browserId);
      if (!activeTask) {
        return sendEarlyError(403, {
          statusCode: 403,
          message: 'Anlas Protection: Transaction queue verification lock lost.'
        });
      }

      if (!preBufferAuth.ok) {
        return sendEarlyError(preBufferAuth.status, {
          statusCode: preBufferAuth.status,
          error: preBufferAuth.error,
          message: preBufferAuth.message
        });
      }
    } else if (isVibeEncode) {
      // Channel B Vibe Encoding Gate: Master Solvency + Billing-Cycle Reset + Debt/Balance Check
      if (!req.telemetry) {
        console.error('[GuildWeave Gatekeeper] Critical: Telemetry context missing on /ai/encode-vibe. Failing closed.');
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry service is unavailable.'
        });
      }

      try {
        await req.telemetry.ensureFresh();
      } catch (telemetryErr) {
        if (isConnectionAborted()) return;
        console.error('[GuildWeave Gatekeeper] On-demand telemetry sync failed on /ai/encode-vibe:', telemetryErr.message);
        if (req.telemetry.masterTokenExpired) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'MASTER_TOKEN_EXPIRED',
            message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
          });
        }
        if (req.telemetry.lastFetched === 0) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_FETCH_FAILED',
            message: 'Unable to verify master account capacity with upstream.'
          });
        }
      }

      if (isConnectionAborted()) return;

      if (req.telemetry.masterTokenExpired) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_TOKEN_EXPIRED',
          message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
        });
      }

      if (req.telemetry.lastFetched === 0) {
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry has not been initialized.'
        });
      }

      if (req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
        console.warn(`[GuildWeave Gatekeeper] Vibe encoding blocked for browser "${browserId}": Master Opus subscription is inactive.`);
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_SUBSCRIPTION_INACTIVE',
          message: 'Master NovelAI Opus subscription is inactive or expired. Vibe encoding temporarily unavailable.'
        });
      }

      if (
        req.telemetry.masterAnlas !== null &&
        req.telemetry.masterAnlas !== undefined &&
        req.telemetry.masterAnlas < VIBE_ENCODE_ANLAS_COST
      ) {
        console.warn(
          `[GuildWeave Gatekeeper] Vibe encoding blocked for browser "${browserId}": Master Anlas (${req.telemetry.masterAnlas}) < ${VIBE_ENCODE_ANLAS_COST}.`
        );
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_ANLAS_DEPLETED',
          message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for vibe encoding (${VIBE_ENCODE_ANLAS_COST} Anlas required).`
        });
      }

      const skipColdBootReset = Boolean(
        req.telemetry &&
        req.telemetry.lastFetched === 0 &&
        req.telemetry.activeCycleEpoch === null
      );

      if (!skipColdBootReset) {
        await auditEngine.evaluateAnlasReset(device.user_id, {
          now: Date.now(),
          activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
          isGracePeriod: req.telemetry?.isGracePeriod ?? false,
          subscriptionActive: req.telemetry?.subscriptionActive ?? true
        });
        if (isConnectionAborted()) return;
      }
    }

    // Retrieve master NovelAI session credential before acquiring synchronous locks/semaphores
    const configRecord = await get('SELECT value FROM config WHERE key = ?', ['master_token']);
    if (isConnectionAborted()) return;
    const masterToken = (configRecord && configRecord.value)
      ? String(configRecord.value).trim().replace(/^Bearer(?:\s+|$)/i, '').trim()
      : '';
    if (!masterToken) {
      return sendEarlyError(503, { error: 'System unconfigured: No master token pushed.' });
    }

    // Channel B Slot & Vibe Anlas Hold Reservation (serialized per user_id; zero awaits between balance check and acquireTextSlot)
    if (isVibeEncode) {
      let earlyRejection = null;

      await withUserAnlasAuthLock(device.user_id, async () => {
        if (isConnectionAborted()) return;

        const heldAnlas = queueManager.getHeldAnlasForUser(device.user_id);
        const spendAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
          declaredAnlas: VIBE_ENCODE_ANLAS_COST,
          requiredAnlas: VIBE_ENCODE_ANLAS_COST,
          isBasePaid: false,
          heldAnlas
        });
        if (isConnectionAborted()) return;

        if (!spendAuth.ok) {
          earlyRejection = {
            status: spendAuth.status,
            payload: {
              statusCode: spendAuth.status,
              error: spendAuth.error,
              message: spendAuth.message
            }
          };
          return;
        }

        // Synchronous TOCTOU re-check after await authorizeAnlasSpend before placing hold
        if (spendAuth.virtual_balance !== Infinity) {
          const latestHeld = queueManager.getHeldAnlasForUser(device.user_id);
          if ((spendAuth.virtual_balance - latestHeld) < VIBE_ENCODE_ANLAS_COST) {
            earlyRejection = {
              status: 403,
              payload: {
                statusCode: 403,
                error: 'INSUFFICIENT_ANLAS',
                message: `Insufficient virtual Anlas balance (${spendAuth.virtual_balance - latestHeld} available after concurrent holds, ${VIBE_ENCODE_ANLAS_COST} required).`
              }
            };
            return;
          }
        }

        const candidateLockId = crypto.randomUUID();
        if (!queueManager.acquireTextSlot(candidateLockId, device.user_id, VIBE_ENCODE_ANLAS_COST)) {
          earlyRejection = {
            status: 429,
            payload: {
              statusCode: 429,
              error: 'CHANNEL_B_SATURATED',
              message: 'Text and vibe processing pipelines saturated. Retry request.'
            }
          };
          return;
        }

        textGenLockId = candidateLockId;
        isTextGenClaimed = true;
      });

      if (isConnectionAborted()) return;
      if (earlyRejection) {
        return sendEarlyError(earlyRejection.status, earlyRejection.payload);
      }
    } else if (isTextGen) {
      // Channel B Fast-Track Concurrency Limit Execution
      textGenLockId = crypto.randomUUID();
      if (!queueManager.acquireTextSlot(textGenLockId, device.user_id, 0)) {
        return sendEarlyError(429, { error: 'Text processing pipelines saturated. Retry request.' });
      }
      isTextGenClaimed = true;
    }

    // Stage 2 & 3: Ingress Staging Semaphore & Upload Deadlines (excludes bodyless GET/HEAD reads)
    const contentLengthHeader = req.headers['content-length'];
    const isBodylessMethod = (req.method === 'GET' || req.method === 'HEAD') &&
      (contentLengthHeader === undefined || contentLengthHeader === '0') &&
      req.headers['transfer-encoding'] === undefined;

    if (!isBodylessMethod && !acquireBufferingSlot()) {
      console.warn(`[GuildWeave Staging] Upload pipeline saturated (${activeBufferingStreams}/${config.INGRESS_SEMAPHORE_MAX}). Rejecting "${browserId}".`);
      return sendEarlyError(429, {
        statusCode: 429,
        error: 'UPLOAD_PIPELINE_SATURATED',
        message: 'Ingress upload staging pipeline saturated. Please retry shortly.'
      });
    }

    const bodyChunks = [];
    let accumulatedBytes = 0;
    let payloadExceededLimit = false;
    let requestEnded = false;
    let uploadTimedOut = false;

    const abortStalledUpload = (reasonCode, message) => {
      if (requestEnded || uploadTimedOut || payloadExceededLimit) return;
      uploadTimedOut = true;
      bodyChunks.length = 0;
      console.warn(`[GuildWeave Staging] ${reasonCode} for browser "${browserId}": ${message}`);
      sendEarlyError(408, {
        statusCode: 408,
        error: reasonCode,
        message
      });
    };

    const resetInactivityTimer = () => {
      if (isBodylessMethod || requestEnded || uploadTimedOut || payloadExceededLimit) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        abortStalledUpload(
          'UPLOAD_INACTIVITY_TIMEOUT',
          `Client upload stalled without incoming chunks for ${config.UPLOAD_INACTIVITY_TIMEOUT_MS}ms.`
        );
      }, config.UPLOAD_INACTIVITY_TIMEOUT_MS);
      if (inactivityTimer.unref) inactivityTimer.unref();
    };

    if (!isBodylessMethod) {
      resetInactivityTimer();
      ceilingTimer = setTimeout(() => {
        abortStalledUpload(
          'UPLOAD_DURATION_EXCEEDED',
          `Client upload exceeded maximum duration ceiling of ${config.UPLOAD_DURATION_CEILING_MS}ms.`
        );
      }, config.UPLOAD_DURATION_CEILING_MS);
      if (ceilingTimer.unref) ceilingTimer.unref();
    }

    req.on('data', chunk => {
      if (payloadExceededLimit || uploadTimedOut) return;
      resetInactivityTimer();
      accumulatedBytes += chunk.length;

      // Ingress Ceiling Invariant: Send HTTP 413, release locks & staging slot synchronously, and terminate
      if (accumulatedBytes > config.MAX_PAYLOAD_SIZE_BYTES) {
        payloadExceededLimit = true;
        bodyChunks.length = 0;
        req.pause();
        console.warn(`[GuildWeave Security] Payload constraint violation. Terminating stream from browser "${browserId}".`);
        executeCleanup();
        if (!res.headersSent) {
          res.setHeader('Connection', 'close');
          res.status(413).json({
            statusCode: 413,
            error: 'PAYLOAD_TOO_LARGE',
            message: `Payload exceeded maximum architectural boundary of ${config.MAX_PAYLOAD_SIZE_BYTES} bytes.`
          });
        }
        destroyInboundAfterFlush();
        return;
      }
      bodyChunks.push(chunk);
    });
    
    safeResume();

    req.on('close', () => {
      if (!requestEnded) {
        bodyChunks.length = 0;
        executeCleanup();
      }
    });

    req.on('error', (reqErr) => {
      console.error('[GuildWeave Proxy] Client request socket stream error:', reqErr);
      bodyChunks.length = 0;
      executeCleanup();
      if (!res.headersSent) {
        res.status(400).json({ error: 'Client request stream terminated abnormally.' });
      } else {
        res.destroy(reqErr);
      }
    });

    req.on('end', async () => {
      requestEnded = true;
      clearUploadTimers();
      releaseBufferingSlot();

      if (req.destroyed || payloadExceededLimit || uploadTimedOut || isConnectionAborted()) {
        bodyChunks.length = 0;
        return;
      }

      const payloadBuffer = Buffer.concat(bodyChunks, accumulatedBytes);
      bodyChunks.length = 0;

      try {
        let extractedParams = null;
        let bodyIsV5 = false;
        let bodyIsV5Medium = false;
        let isVerifiedBasePaid = false;
        let cAuth = 0;
        let reqNcp = 0;

        if (isImageGen && activeTask) {
          // Re-verify lock ownership post-buffering before Stage 4-7 validation
          const currentTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
          if (!currentTask) {
            activeTask = null;
            executeCleanup();
            if (!res.headersSent) {
              return res.status(403).json({
                statusCode: 403,
                message: 'Anlas Protection: Transaction queue verification lock lost during upload.'
              });
            }
            return;
          }
          activeTask = currentTask;

          // Stage 4: Dual-Mode Zero-Copy Buffer Extraction
          extractedParams = auditEngine.extractParametersFromRawBody(payloadBuffer, req.headers['content-type']);
          if (!extractedParams) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'MALFORMED_PAYLOAD',
                message: 'Unable to extract generation parameters from request body.'
              });
            }
            return;
          }

          if (
            extractedParams.width === null || extractedParams.height === null ||
            extractedParams.width <= 0 || extractedParams.height <= 0 ||
            (extractedParams.steps !== null && extractedParams.steps <= 0) ||
            (extractedParams.n_samples !== null && extractedParams.n_samples <= 0)
          ) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'INVALID_PARAMETERS',
                message: 'Generation parameters contain missing or non-positive dimensions, steps, or sample counts.'
              });
            }
            return;
          }

          bodyIsV5 = auditEngine.isV5ModelFamily(extractedParams.model);
          bodyIsV5Medium = auditEngine.isV5MediumModel(extractedParams.model);
          effectiveIsV5 = bodyIsV5 || isV5Header;

          const bodySteps = extractedParams.steps !== null
            ? extractedParams.steps
            : (bodyIsV5Medium ? 14 : 28);
          const bodySamples = extractedParams.n_samples !== null ? extractedParams.n_samples : 1;
          const bodyRefs = extractedParams.precise_ref_count || 0;
          const actualPixels = extractedParams.width * extractedParams.height;

          // Stage 5: Synchronous Anti-Spoofing Parameter Forgery Reconciliation
          let forgeryReason = null;

          if (normalizedHeaderModel === 'legacy' && bodyIsV5) {
            forgeryReason = `Firewall Bypass Violation: Client generated with V5 model ("${extractedParams.model}") but suppressed X-Gen-Model header.`;
          } else if (normalizedHeaderModel === 'v5-medium' && !bodyIsV5Medium) {
            forgeryReason = `Firewall Bypass Violation: Client declared X-Gen-Model: V5-medium but embedded non-Medium model ("${extractedParams.model}").`;
          } else if (normalizedHeaderModel === 'v5' && !bodyIsV5) {
            forgeryReason = `Firewall Bypass Violation: Client declared X-Gen-Model: V5 but embedded missing or non-V5 model ("${extractedParams.model}").`;
          } else {
            const headerChecks = [
              { name: 'x-gen-width', actual: extractedParams.width },
              { name: 'x-gen-height', actual: extractedParams.height },
              { name: 'x-gen-steps', actual: bodySteps },
              { name: 'x-gen-samples', actual: bodySamples },
              { name: 'x-precise-refs', actual: bodyRefs }
            ];

            for (const chk of headerChecks) {
              const rawHeaderVal = req.headers[chk.name];
              if (rawHeaderVal !== undefined) {
                const parsedHeader = parseStrictNonNegativeIntHeader(rawHeaderVal, 0);
                if (!parsedHeader.ok || parsedHeader.value !== chk.actual) {
                  forgeryReason = `Firewall Bypass Violation: Header ${chk.name} (${rawHeaderVal}) mismatched extracted body parameter (${chk.actual}).`;
                  break;
                }
              }
            }
          }

          if (forgeryReason) {
            console.warn(`\x1b[31m[GuildWeave SECURITY AUDIT] !!! HOSTILE PARAMETER FORGERY DETECTED !!!\x1b[0m`);
            console.warn(`[GuildWeave Security Audit] Device: "${browserId}", User: "${device.user_id}", Reason: ${forgeryReason}`);

            if (deviceSecret !== config.ADMIN_SECRET_KEY) {
              await auditEngine.commitSecurityBan({
                browserId,
                userId: device.user_id,
                discordId: device.discord_id || null,
                reason: forgeryReason
              });
            }

            queueManager.evict({
              user_id: device.user_id,
              discord_id: device.discord_id || null,
              browser_id: browserId
            });
            executeCleanup();

            if (!res.headersSent && !res.destroyed) {
              return res.status(403).json({
                statusCode: 403,
                error: 'PARAMETER_FORGERY',
                message: 'Access Denied: Hostile parameter spoofing detected. Account permanently banned.'
              });
            }
            return;
          }

          // Stage 6: Model-Aware Deadband Firewall & Real Base-Paid Verification
          const exceedsBaseLimits =
            (actualPixels > config.FIREWALL_MAX_PIXELS) ||
            (bodySamples !== config.FIREWALL_MAX_SAMPLES) ||
            (!bodyIsV5Medium && bodySteps > config.FIREWALL_MAX_STEPS);

          if (isBasePaidHeader && !exceedsBaseLimits) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'PARAMETRIC_LIMIT_EXCEEDED',
                message: 'Baseline <=1MP, 1-sample parameters are not eligible for X-Base-Paid exemption.'
              });
            }
            return;
          }

          isVerifiedBasePaid = isBasePaidHeader && exceedsBaseLimits;

          if (!isVerifiedBasePaid) {
            if (actualPixels > config.FIREWALL_MAX_PIXELS) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(400).json({
                  statusCode: 400,
                  error: 'PARAMETRIC_LIMIT_EXCEEDED',
                  message: `Resolution of ${extractedParams.width}x${extractedParams.height} (${actualPixels}px) exceeds the <=1MP limit without Anlas enabled.`
                });
              }
              return;
            }
            if (bodySamples !== config.FIREWALL_MAX_SAMPLES) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(400).json({
                  statusCode: 400,
                  error: 'PARAMETRIC_LIMIT_EXCEEDED',
                  message: `Samples count of ${bodySamples} exceeds the 1-sample limit without Anlas enabled.`
                });
              }
              return;
            }
            if (!bodyIsV5Medium) {
              if (bodyIsV5 && bodySteps >= 24 && bodySteps <= 28) {
                executeCleanup();
                if (!res.headersSent) {
                  return res.status(400).json({
                    statusCode: 400,
                    error: 'PARAMETRIC_LIMIT_EXCEEDED',
                    message: 'V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24-28 are blocked to protect shared V5 limits—use <=23 steps or switch to Medium.'
                  });
                }
                return;
              }
              if (bodySteps > config.FIREWALL_MAX_STEPS) {
                executeCleanup();
                if (!res.headersSent) {
                  return res.status(400).json({
                    statusCode: 400,
                    error: 'PARAMETRIC_LIMIT_EXCEEDED',
                    message: `Steps count of ${bodySteps} exceeds the maximum limit of ${config.FIREWALL_MAX_STEPS} steps without Anlas enabled.`
                  });
                }
                return;
              }
            }
          }

          if (bodyRefs > tierConfig.preciseLimit) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'PARAMETRIC_LIMIT_EXCEEDED',
                message: `Character references count of ${bodyRefs} exceeds your max limit of ${tierConfig.preciseLimit}.`
              });
            }
            return;
          }

          // Stage 7: Authoritative Cost Calculation (C_auth), Canary Drift, Hold Placement & V5 NCP Check
          let costDetails;
          try {
            const isV5UsageNegative = Boolean(bodyIsV5 && req.telemetry && req.telemetry.isNegative);
            costDetails = auditEngine.calculateAnlasCostDetails(extractedParams, {
              isOpus: true,
              usageNegative: isV5UsageNegative
            });
          } catch (costErr) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'PARAMETRIC_LIMIT_EXCEEDED',
                message: costErr.message
              });
            }
            return;
          }
          cAuth = costDetails.total;

          if (scrapedAnlas !== null && Math.abs(cAuth - scrapedAnlas) > 0) {
            console.warn(
              `[GuildWeave Telemetry Canary] Formula drift detected: Upstream UI reported ${scrapedAnlas}, server calculated ${cAuth}. Check upstream specification.`
            );
          }

          // Ensure telemetry initialized if body turned out to require V5 or Anlas despite omitted headers
          if ((bodyIsV5 || cAuth > 0) && req.telemetry && req.telemetry.lastFetched === 0) {
            try {
              await req.telemetry.ensureFresh();
            } catch (telemetryErr) {
              if (isConnectionAborted()) return;
              if (req.telemetry.masterTokenExpired) {
                executeCleanup();
                if (!res.headersSent) {
                  return res.status(503).json({
                    statusCode: 503,
                    error: 'MASTER_TOKEN_EXPIRED',
                    message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
                  });
                }
                return;
              }
              if (req.telemetry.lastFetched === 0) {
                executeCleanup();
                if (!res.headersSent) {
                  return res.status(503).json({
                    statusCode: 503,
                    error: 'TELEMETRY_FETCH_FAILED',
                    message: 'Unable to verify master account capacity with upstream.'
                  });
                }
                return;
              }
            }
            if (isConnectionAborted()) return;
            if (req.telemetry.masterTokenExpired) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(503).json({
                  statusCode: 503,
                  error: 'MASTER_TOKEN_EXPIRED',
                  message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
                });
              }
              return;
            }
            if (req.telemetry.lastFetched === 0) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(503).json({
                  statusCode: 503,
                  error: 'TELEMETRY_UNAVAILABLE',
                  message: 'Master subscription telemetry has not been initialized.'
                });
              }
              return;
            }
          }

          if (req.telemetry && req.telemetry.masterTokenExpired) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(503).json({
                statusCode: 503,
                error: 'MASTER_TOKEN_EXPIRED',
                message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
              });
            }
            return;
          }

          if (req.telemetry && req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(503).json({
                statusCode: 503,
                error: 'MASTER_SUBSCRIPTION_INACTIVE',
                message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
              });
            }
            return;
          }

          if (bodyIsV5 && !isVerifiedBasePaid && req.telemetry && req.telemetry.isHardLocked) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(503).json({
                statusCode: 503,
                error: 'V5_BATTERY_CRITICAL',
                message: `Shared V5 capacity is recharging (${req.telemetry.percent.toFixed(2)}% <= ${config.V5_CIRCUIT_BREAKER_PERCENT}%).`
              });
            }
            return;
          }

          // Authoritative Anlas Authorization & Cross-Channel Hold Placement
          if (cAuth > 0 || isVerifiedBasePaid || declaredAnlas > 0) {
            if (
              req.telemetry &&
              req.telemetry.masterAnlas !== null &&
              req.telemetry.masterAnlas !== undefined &&
              req.telemetry.masterAnlas < cAuth
            ) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(503).json({
                  statusCode: 503,
                  error: 'MASTER_ANLAS_DEPLETED',
                  message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for this generation (${cAuth} Anlas required).`
                });
              }
              return;
            }

            const skipColdBootReset = Boolean(
              req.telemetry &&
              req.telemetry.lastFetched === 0 &&
              req.telemetry.activeCycleEpoch === null
            );
            if (!skipColdBootReset) {
              await auditEngine.evaluateAnlasReset(device.user_id, {
                now: Date.now(),
                activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
                isGracePeriod: req.telemetry?.isGracePeriod ?? false,
                subscriptionActive: req.telemetry?.subscriptionActive ?? true
              });
              if (isConnectionAborted()) return;
            }

            let anlasRejection = null;
            await withUserAnlasAuthLock(device.user_id, async () => {
              if (isConnectionAborted()) return;

              const verifiedTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
              if (!verifiedTask) {
                activeTask = null;
                anlasRejection = {
                  status: 403,
                  payload: { statusCode: 403, message: 'Anlas Protection: Transaction queue verification lock lost.' }
                };
                return;
              }
              activeTask = verifiedTask;

              const heldOtherAnlas = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
              const spendAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
                declaredAnlas,
                requiredAnlas: cAuth,
                isBasePaid: isVerifiedBasePaid,
                heldAnlas: heldOtherAnlas
              });
              if (isConnectionAborted()) return;

              const postAuthTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
              if (!postAuthTask) {
                activeTask = null;
                anlasRejection = {
                  status: 403,
                  payload: { statusCode: 403, message: 'Anlas Protection: Transaction queue verification lock lost.' }
                };
                return;
              }
              activeTask = postAuthTask;

              if (!spendAuth.ok) {
                anlasRejection = {
                  status: spendAuth.status,
                  payload: {
                    statusCode: spendAuth.status,
                    error: spendAuth.error,
                    message: spendAuth.message
                  }
                };
                return;
              }

              // Synchronous TOCTOU re-check before placing Channel A hold
              if (spendAuth.virtual_balance !== Infinity) {
                const latestOtherHeld = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
                if ((spendAuth.virtual_balance - latestOtherHeld) < cAuth) {
                  anlasRejection = {
                    status: 403,
                    payload: {
                      statusCode: 403,
                      error: 'INSUFFICIENT_ANLAS',
                      message: `Insufficient virtual Anlas balance (${spendAuth.virtual_balance - latestOtherHeld} available after concurrent holds, ${cAuth} required).`
                    }
                  };
                  return;
                }
              }

              queueManager.setTaskHold(activeTask.req_id, browserId, { held_cost: cAuth });
            });

            if (isConnectionAborted()) return;
            if (anlasRejection) {
              executeCleanup();
              if (!res.headersSent) {
                return res.status(anlasRejection.status).json(anlasRejection.payload);
              }
              return;
            }
          }

          // Authoritative V5 NCP Verification & Fallback Hold Upgrade (prevents /queue/join effort spoofing
          // and closes personal NCP commit-boundary races via evaluateV5Accrual userMutationLocks serialization)
          if (bodyIsV5 && !isVerifiedBasePaid) {
            reqNcp = bodyIsV5Medium ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST;

            if (device.user_id !== 'admin') {
              // Surplus holds are authoritative in RAM via synchronous deductSurplusPool() at PoNR.
              // Personal holds MUST always re-verify against SQLite via evaluateV5Accrual() so a
              // tab-refresh replacing an in-flight PoNR task mid-commit cannot spend stale NCP.
              const hasSufficientSurplusPreHold =
                activeTask.held_ncp >= reqNcp &&
                activeTask.held_ncp_source === 'surplus';

              if (!hasSufficientSurplusPreHold) {
                const accrual = await auditEngine.evaluateV5Accrual(device.user_id, {
                  now: Date.now(),
                  nominalDailyCompute: req.telemetry?.nominalDailyCompute ?? null
                });
                if (isConnectionAborted()) return;

                const postAccrualTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
                if (!postAccrualTask) {
                  activeTask = null;
                  executeCleanup();
                  if (!res.headersSent) {
                    return res.status(403).json({
                      statusCode: 403,
                      message: 'Anlas Protection: Transaction queue verification lock lost.'
                    });
                  }
                  return;
                }
                activeTask = postAccrualTask;

                const personalBanked = accrual ? accrual.v5_banked_balance : 0;
                if (personalBanked !== Infinity) {
                  const existingPersonalHold = activeTask.held_ncp_source === 'personal' ? (activeTask.held_ncp || 0) : 0;
                  const existingSurplusHold = activeTask.held_ncp_source === 'surplus' ? (activeTask.held_ncp || 0) : 0;

                  const otherPersonalHeld = Math.max(0, queueManager.getHeldNcpForUser(device.user_id, 'personal') - existingPersonalHold);
                  const availablePersonal = Math.max(0, personalBanked - otherPersonalHeld);

                  if (availablePersonal >= reqNcp) {
                    queueManager.setTaskHold(activeTask.req_id, browserId, {
                      held_ncp: reqNcp,
                      held_ncp_source: 'personal'
                    });
                  } else {
                    const isSurplusEligible = Boolean(tierConfig && tierConfig.v5SurplusEligible);
                    const otherSurplusHeld = Math.max(0, queueManager.getHeldSurplusNcp() - existingSurplusHold);
                    const availableSurplus = Math.max(0, queueManager.getSurplusPool().pool - otherSurplusHeld);

                    if (isSurplusEligible && availableSurplus >= reqNcp) {
                      queueManager.setTaskHold(activeTask.req_id, browserId, {
                        held_ncp: reqNcp,
                        held_ncp_source: 'surplus'
                      });
                    } else {
                      executeCleanup();
                      if (!res.headersSent) {
                        return res.status(429).json({
                          statusCode: 429,
                          error: 'V5_CAPACITY_DEPLETED',
                          message: `Insufficient V5 compute capacity (${availablePersonal} personal NCP, ${isSurplusEligible ? availableSurplus : 0} eligible surplus NCP available; ${reqNcp} NCP required).`
                        });
                      }
                      return;
                    }
                  }
                }
              }
            }
          }

          // Final synchronous lock ownership verification and GPU TTL clock re-anchoring
          const finalTaskCheck = queueManager.getProcessingTask(activeTask.req_id, browserId);
          if (!finalTaskCheck) {
            activeTask = null;
            executeCleanup();
            if (!res.headersSent) {
              return res.status(403).json({
                statusCode: 403,
                message: 'Anlas Protection: Transaction queue verification lock lost prior to dispatch.'
              });
            }
            return;
          }
          activeTask = finalTaskCheck;
          queueManager.reanchorProcessingTimestamp(activeTask.req_id);
        } else if (isUpscale && activeTask) {
          // Stage 4-7 for Channel A /ai/upscale (Binary Image Header Dimension Extraction + Anti-Spoofing + 1..4 Anlas)
          const currentTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
          if (!currentTask) {
            activeTask = null;
            executeCleanup();
            if (!res.headersSent) {
              return res.status(403).json({
                statusCode: 403,
                message: 'Anlas Protection: Transaction queue verification lock lost during upload.'
              });
            }
            return;
          }
          activeTask = currentTask;

          const upscaleInfo = auditEngine.extractUpscaleParametersFromRawBody(payloadBuffer, req.headers['content-type']);
          if (!upscaleInfo) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'INVALID_UPSCALE_PAYLOAD',
                message: 'Upscale payload must contain a valid binary PNG, JPEG, WebP, GIF, or BMP image.'
              });
            }
            return;
          }

          // Stage 5: Anti-Spoofing Dimension Reconciliation against Binary Image Header
          let upscaleForgeryReason = null;
          if (upscaleInfo.jsonWidth !== null && upscaleInfo.jsonWidth !== upscaleInfo.width) {
            upscaleForgeryReason = `Upscale Bypass Violation: JSON width (${upscaleInfo.jsonWidth}) mismatched binary image width (${upscaleInfo.width}).`;
          } else if (upscaleInfo.jsonHeight !== null && upscaleInfo.jsonHeight !== upscaleInfo.height) {
            upscaleForgeryReason = `Upscale Bypass Violation: JSON height (${upscaleInfo.jsonHeight}) mismatched binary image height (${upscaleInfo.height}).`;
          } else {
            for (const chk of [
              { name: 'x-gen-width', actual: upscaleInfo.width },
              { name: 'x-gen-height', actual: upscaleInfo.height }
            ]) {
              const rawHeaderVal = req.headers[chk.name];
              if (rawHeaderVal !== undefined) {
                const parsedHeader = parseStrictNonNegativeIntHeader(rawHeaderVal, 0);
                if (!parsedHeader.ok || parsedHeader.value !== chk.actual) {
                  upscaleForgeryReason = `Upscale Bypass Violation: Header ${chk.name} (${rawHeaderVal}) mismatched binary image dimension (${chk.actual}).`;
                  break;
                }
              }
            }
          }

          if (upscaleForgeryReason) {
            console.warn(`\x1b[31m[GuildWeave SECURITY AUDIT] !!! UPSCALE DIMENSION FORGERY DETECTED !!!\x1b[0m`);
            if (deviceSecret !== config.ADMIN_SECRET_KEY) {
              await auditEngine.commitSecurityBan({
                browserId,
                userId: device.user_id,
                discordId: device.discord_id || null,
                reason: upscaleForgeryReason
              });
            }
            queueManager.evict({
              user_id: device.user_id,
              discord_id: device.discord_id || null,
              browser_id: browserId
            });
            executeCleanup();
            if (!res.headersSent && !res.destroyed) {
              return res.status(403).json({
                statusCode: 403,
                error: 'PARAMETER_FORGERY',
                message: 'Access Denied: Hostile upscale dimension spoofing detected. Account permanently banned.'
              });
            }
            return;
          }

          try {
            cAuth = auditEngine.calculateUpscaleAnlasCost(upscaleInfo.width, upscaleInfo.height);
          } catch (upscaleCostErr) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'PARAMETRIC_LIMIT_EXCEEDED',
                message: upscaleCostErr.message
              });
            }
            return;
          }

          if (
            req.telemetry &&
            req.telemetry.masterAnlas !== null &&
            req.telemetry.masterAnlas !== undefined &&
            req.telemetry.masterAnlas < cAuth
          ) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(503).json({
                statusCode: 503,
                error: 'MASTER_ANLAS_DEPLETED',
                message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for upscaling (${cAuth} Anlas required).`
              });
            }
            return;
          }

          let upscaleRejection = null;
          await withUserAnlasAuthLock(device.user_id, async () => {
            if (isConnectionAborted()) return;

            const verifiedTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
            if (!verifiedTask) {
              activeTask = null;
              upscaleRejection = {
                status: 403,
                payload: { statusCode: 403, message: 'Anlas Protection: Transaction queue verification lock lost.' }
              };
              return;
            }
            activeTask = verifiedTask;

            const heldOtherAnlas = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
            const effectiveDeclared = declaredAnlasProvided ? declaredAnlas : cAuth;
            const spendAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
              declaredAnlas: effectiveDeclared,
              requiredAnlas: cAuth,
              isBasePaid: false,
              heldAnlas: heldOtherAnlas
            });
            if (isConnectionAborted()) return;

            const postAuthTask = queueManager.getProcessingTask(activeTask.req_id, browserId);
            if (!postAuthTask) {
              activeTask = null;
              upscaleRejection = {
                status: 403,
                payload: { statusCode: 403, message: 'Anlas Protection: Transaction queue verification lock lost.' }
              };
              return;
            }
            activeTask = postAuthTask;

            if (!spendAuth.ok) {
              upscaleRejection = {
                status: spendAuth.status,
                payload: {
                  statusCode: spendAuth.status,
                  error: spendAuth.error,
                  message: spendAuth.message
                }
              };
              return;
            }

            if (spendAuth.virtual_balance !== Infinity) {
              const latestOtherHeld = Math.max(0, queueManager.getHeldAnlasForUser(device.user_id) - (activeTask.held_cost || 0));
              if ((spendAuth.virtual_balance - latestOtherHeld) < cAuth) {
                upscaleRejection = {
                  status: 403,
                  payload: {
                    statusCode: 403,
                    error: 'INSUFFICIENT_ANLAS',
                    message: `Insufficient virtual Anlas balance (${spendAuth.virtual_balance - latestOtherHeld} available after concurrent holds, ${cAuth} required).`
                  }
                };
                return;
              }
            }

            queueManager.setTaskHold(activeTask.req_id, browserId, { held_cost: cAuth });
          });

          if (isConnectionAborted()) return;
          if (upscaleRejection) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(upscaleRejection.status).json(upscaleRejection.payload);
            }
            return;
          }

          const finalTaskCheck = queueManager.getProcessingTask(activeTask.req_id, browserId);
          if (!finalTaskCheck) {
            activeTask = null;
            executeCleanup();
            if (!res.headersSent) {
              return res.status(403).json({
                statusCode: 403,
                message: 'Anlas Protection: Transaction queue verification lock lost prior to dispatch.'
              });
            }
            return;
          }
          activeTask = finalTaskCheck;
          queueManager.reanchorProcessingTimestamp(activeTask.req_id);
        } else if (isVibeEncode) {
          const currentVibeLock = textGenLockId ? queueManager.getTextLock(textGenLockId) : null;
          if (!currentVibeLock) {
            isTextGenClaimed = false;
            executeCleanup();
            if (!res.headersSent) {
              return res.status(403).json({
                statusCode: 403,
                error: 'CHANNEL_B_LOCK_LOST',
                message: 'Vibe encoding reservation lock was lost during upload.'
              });
            }
            return;
          }

          // Dedicated image-presence validator (bypasses generation parameter extraction completely)
          const vibeValidation = auditEngine.validateVibeEncodePayload(payloadBuffer, req.headers['content-type']);
          if (!vibeValidation.ok) {
            executeCleanup();
            if (!res.headersSent) {
              return res.status(400).json({
                statusCode: 400,
                error: 'INVALID_VIBE_PAYLOAD',
                message: vibeValidation.reason
              });
            }
            return;
          }
        }

        // Asynchronous Session Request Count Update (PoNR handles Anlas/NCP/ban governance synchronously)
        setImmediate(async () => {
          try {
            await run('UPDATE devices SET total_requests = total_requests + 1, last_active_at = ? WHERE browser_id = ?', [Date.now(), browserId]);
          } catch (err) {
            console.error('[GuildWeave Audit] Background device telemetry update exception:', err);
          }
        });

        // Bilateral Mutual-Consent Diagnostic Telemetry Logging Gate
        // Strictly enforces simultaneous dual-key condition: Client Active Consent AND Administrator Active Authorization.
        const isClientConsenting = req.headers['x-debug-mode'] === 'true';
        const isAdminAuthorized = (device.priority_tier === 'Admin') || queueManager.isDebugEnabled(browserId);

        if (isClientConsenting && isAdminAuthorized) {
          console.log(`\n--- [GuildWeave Debug Telemetry] Untruncated Structured Payload (Client: "${browserId}") ---`);
          console.log(auditEngine.formatPayloadForLogging(payloadBuffer, req.headers['content-type']));
          console.log("------------------------------------------------------------------------------------\n");
        }

        const queryString = req.url.split('?')[1] || '';
        const baseUrl = config.UPSTREAM_BASE_URL_TEMPLATE.replace('{subdomain}', subdomain);
        const cleanPath = pathPart.replace(/^\/+/, '');
        const upstreamUrl = `${baseUrl}/${cleanPath}${queryString ? '?' + queryString : ''}`;

        const headers = { ...req.headers };
        const parsedUpstream = new URL(upstreamUrl);
        headers['host'] = parsedUpstream.host;
        headers['authorization'] = `Bearer ${masterToken}`;

        // WAF Shield: Strip length and metadata markers to recalculate Content-Length cleanly
        const stripHeaders = [
          'x-browser-id', 'x-request-id', 'x-gen-width', 'x-gen-height', 'x-gen-steps', 'x-gen-samples', 'x-debug-mode', 'x-script-version',
          'x-gen-model', 'x-precise-refs', 'x-base-paid', 'x-declared-anlas', 'x-scraped-anlas', 'connection', 'content-length', 'transfer-encoding'
        ];
        stripHeaders.forEach(h => delete headers[h]);

        if (isUserSubscription) {
          // Request uncompressed UTF-8 JSON from NovelAI; gzip/br/deflate still supported defensively on decode
          headers['accept-encoding'] = 'identity';
        }

        const isBodylessUpstream = (req.method === 'GET' || req.method === 'HEAD') && payloadBuffer.length === 0;
        if (!isBodylessUpstream) {
          headers['content-length'] = payloadBuffer.length;
        }

        console.log(`[GuildWeave Telemetry] Forwarding piped request upstream to NovelAI: ${upstreamUrl} (Method: ${req.method}, Body: ${payloadBuffer.length} bytes)`);

        const transport = upstreamUrl.startsWith('https:') ? https : http;

        upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, async (upstreamRes) => {
          console.log(`[GuildWeave Telemetry] Received upstream headers. Status: ${upstreamRes.statusCode}`);

          // Master Token Expiry Shield: NEVER pipe an upstream NovelAI 401 to the client as 401.
          // Client credentials already passed verifyDevice(); upstream 401 means the server's
          // master_token is expired/revoked and would falsely trigger client revocation loops.
          if (upstreamRes.statusCode === 401) {
            console.error(`[GuildWeave Master Auth] Upstream NovelAI rejected master_token with HTTP 401 on "${cleanPath}". Push a fresh token.`);
            if (isVibeEncode) {
              const vibeLock = textGenLockId ? queueManager.getTextLock(textGenLockId) : null;
              if (vibeLock) vibeLock.held_cost = 0;
            } else if ((isImageGen || isUpscale) && activeTask) {
              queueManager.clearTaskHold(activeTask.req_id, browserId);
            }
            if (req.telemetry && typeof req.telemetry.invalidate === 'function') {
              req.telemetry.invalidate();
            }
            upstreamRes.on('error', () => {});
            upstreamRes.resume();
            if (!res.headersSent) {
              res.status(503).json({
                statusCode: 503,
                error: 'MASTER_TOKEN_EXPIRED',
                message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
              });
            }
            executeCleanup();
            return;
          }

          let subOversized = false;

          // Active Cleanup Invariant: Attach error/aborted/close listeners immediately before any async await
          upstreamRes.on('error', (err) => {
            if (subOversized) return;
            console.error('[GuildWeave Telemetry] Upstream response stream error occurred:', err);
            executeCleanup();
            if (!res.headersSent) {
              res.status(502).json({ 
                error: 'Upstream dynamic pipe disconnected',
                reason: err.message,
                code: err.code
              });
            } else {
              res.destroy(err);
            }
          });

          upstreamRes.on('aborted', () => {
            if (subOversized) return;
            console.warn('[GuildWeave Telemetry] Upstream response stream aborted by server');
            executeCleanup();
            res.destroy();
          });

          upstreamRes.on('close', () => {
            if (subOversized) return;
            if (!upstreamRes.complete) {
              console.warn('[GuildWeave Telemetry] Upstream response socket closed prematurely before completion');
              executeCleanup();
              res.destroy();
            }
          });

          // Split-Token Isolation: Buffer and allow-list `/user/subscription` for non-Admin clients
          // so master account Anlas, paymentProcessorData, and unexpected billing keys never leak to
          // guest browsers and NovelAI's native Anlas bar displays the guest's live virtual Anlas balance.
          if (isUserSubscription && upstreamRes.statusCode === 200) {
            const subChunks = [];
            let subBytes = 0;

            upstreamRes.on('data', (chunk) => {
              if (subOversized) return;
              subBytes += chunk.length;
              if (subBytes > MAX_SUBSCRIPTION_RESPONSE_BYTES) {
                subOversized = true;
                subChunks.length = 0;
                if (!res.headersSent) {
                  res.status(502).json({ error: 'Upstream subscription payload exceeded size ceiling.' });
                }
                try { upstreamRes.destroy(); } catch (_) {}
                executeCleanup();
                return;
              }
              subChunks.push(chunk);
            });

            upstreamRes.on('end', async () => {
              if (subOversized || isConnectionAborted() || res.headersSent) return;
              try {
                const rawSubBuf = decompressSubscriptionBuffer(
                  Buffer.concat(subChunks, subBytes),
                  upstreamRes.headers['content-encoding']
                );
                const subPayload = JSON.parse(rawSubBuf.toString('utf8'));
                let responsePayload = subPayload;

                if (deviceSecret !== config.ADMIN_SECRET_KEY) {
                  const skipColdBootReset = Boolean(
                    req.telemetry &&
                    req.telemetry.lastFetched === 0 &&
                    req.telemetry.activeCycleEpoch === null
                  );
                  if (!skipColdBootReset) {
                    await auditEngine.evaluateAnlasReset(device.user_id, {
                      now: Date.now(),
                      activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
                      isGracePeriod: req.telemetry?.isGracePeriod ?? false,
                      subscriptionActive: req.telemetry?.subscriptionActive ?? true
                    });
                    if (isConnectionAborted() || res.headersSent) return;
                  }

                  const heldAnlas = queueManager.getHeldAnlasForUser(device.user_id);
                  const balInfo = await auditEngine.calculateAvailableBalance(device.user_id, heldAnlas);
                  if (isConnectionAborted() || res.headersSent) return;

                  const isUnlimited = !balInfo || balInfo.available_balance === Infinity;
                  const displayAnlas = isUnlimited ? 9999 : Math.max(0, Math.trunc(balInfo.available_balance));

                  responsePayload = {
                    tier: 3,
                    active: true,
                    paymentProcessor: null,
                    paymentProcessorData: null,
                    expiresAt: 2524608000,
                    isGracePeriod: false,
                    isPaypal: false,
                    accountType: 0,
                    perks: {
                      ...(subPayload.perks && typeof subPayload.perks === 'object' ? subPayload.perks : {}),
                      maxPriorityActions: 0,
                      startPriority: 0,
                      contextTokens: 8192,
                      unlimitedMaxPriority: true,
                      moduleTrainingSteps: 0
                    },
                    trainingStepsLeft: {
                      fixedTrainingStepsLeft: displayAnlas,
                      purchasedTrainingSteps: isUnlimited ? 9999 : 0
                    },
                    ...(subPayload.usage && typeof subPayload.usage === 'object' ? { usage: subPayload.usage } : {})
                  };
                }

                const outBuf = Buffer.from(JSON.stringify(responsePayload), 'utf8');
                const outHeaders = { ...upstreamRes.headers };
                delete outHeaders['content-encoding'];
                delete outHeaders['transfer-encoding'];
                outHeaders['content-type'] = 'application/json; charset=utf-8';
                outHeaders['content-length'] = String(outBuf.length);

                res.writeHead(200, outHeaders);
                res.end(outBuf);
              } catch (subErr) {
                console.error('[GuildWeave Telemetry] Failed to sanitize /user/subscription response:', subErr.message);
                executeCleanup();
                if (!res.headersSent) {
                  res.status(502).json({ error: 'Invalid upstream subscription payload.' });
                }
              }
            });
            return;
          }

          const activeCycleEpoch = (req.telemetry && typeof req.telemetry.activeCycleEpoch === 'number' && req.telemetry.activeCycleEpoch > 0)
            ? req.telemetry.activeCycleEpoch
            : 0;

          // Stage 9: Point of No Return (PoNR) Settlement
          // All Anlas SQLite debits + hold-clear execute under withUserAnlasAuthLock so
          // post-200 client socket aborts cannot drop RAM holds while SQLite is mid-commit.
          if (isVibeEncode) {
            const vibeLock = textGenLockId ? queueManager.getTextLock(textGenLockId) : null;
            if (upstreamRes.statusCode === 200) {
              upstreamRes.pause();
              await withUserAnlasAuthLock(device.user_id, async () => {
                try {
                  await auditEngine.commitAnlasDebit(device.user_id, VIBE_ENCODE_ANLAS_COST, browserId);
                  await auditEngine.recordPeriodUsage(activeCycleEpoch, device.user_id, {
                    anlasConsumed: VIBE_ENCODE_ANLAS_COST,
                    vibeEncodes: 1
                  });
                  console.log(`[GuildWeave Audit Ledger] Committed PoNR ${VIBE_ENCODE_ANLAS_COST} Anlas debit for vibe encode (User: "${device.user_id}").`);
                } catch (debitErr) {
                  console.error('[GuildWeave Audit] Failed to commit vibe encode Anlas debit:', debitErr);
                } finally {
                  if (vibeLock) {
                    vibeLock.held_cost = 0;
                  }
                }
              });

              if (isConnectionAborted() || res.headersSent) {
                try { upstreamRes.destroy(); } catch (_) {}
                executeCleanup();
                return;
              }
            } else if (vibeLock) {
              // Pre-PoNR failure: release 2-Anlas hold immediately with zero charge
              vibeLock.held_cost = 0;
            }
          } else if (isUpscale) {
            if (upstreamRes.statusCode === 200) {
              const settledAnlas = cAuth;
              upstreamRes.pause();
              await withUserAnlasAuthLock(device.user_id, async () => {
                try {
                  await auditEngine.commitAnlasDebit(device.user_id, settledAnlas, browserId);
                  await auditEngine.recordPeriodUsage(activeCycleEpoch, device.user_id, {
                    anlasConsumed: settledAnlas,
                    upscaleGens: 1
                  });
                  console.log(`[GuildWeave Audit Ledger] Committed PoNR ${settledAnlas} Anlas debit for upscale (User: "${device.user_id}").`);
                } catch (upscaleCommitErr) {
                  console.error('[GuildWeave Audit] Failed to commit upscale PoNR settlement:', upscaleCommitErr);
                } finally {
                  if (activeTask) {
                    queueManager.clearTaskHold(activeTask.req_id, browserId);
                  }
                }
              });

              if (isConnectionAborted() || res.headersSent) {
                try { upstreamRes.destroy(); } catch (_) {}
                executeCleanup();
                return;
              }
            } else if (activeTask) {
              queueManager.clearTaskHold(activeTask.req_id, browserId);
            }
          } else if (isTextGen) {
            if (upstreamRes.statusCode === 200) {
              upstreamRes.pause();
              try {
                await auditEngine.recordPeriodUsage(activeCycleEpoch, device.user_id, { textGens: 1 });
              } catch (textPeriodErr) {
                console.error('[GuildWeave Audit] Failed to record text generation period telemetry:', textPeriodErr);
              }
              if (isConnectionAborted() || res.headersSent) {
                try { upstreamRes.destroy(); } catch (_) {}
                executeCleanup();
                return;
              }
            }
          } else if (isImageGen) {
            if (upstreamRes.statusCode === 200) {
              const settledAnlas = cAuth;
              const settledNcp = (bodyIsV5 && !isVerifiedBasePaid && device.user_id !== 'admin') ? reqNcp : 0;
              const settledNcpSource = (settledNcp > 0 && activeTask) ? activeTask.held_ncp_source : null;
              const shouldDeductAllowance = Boolean(tierConfig && tierConfig.maxAllowance !== Infinity);
              const v5HighDelta = (bodyIsV5 && !bodyIsV5Medium) ? 1 : 0;
              const v5MedDelta = bodyIsV5Medium ? 1 : 0;
              const legacyImgDelta = !bodyIsV5 ? 1 : 0;

              // Synchronous RAM settlement at PoNR:
              // Clear surplus NCP hold in the same tick as deductSurplusPool() to avoid double-deduction,
              // while retaining held_cost and personal held_ncp until SQLite commits finish under lock.
              if (settledNcp > 0 && settledNcpSource === 'surplus') {
                queueManager.deductSurplusPool(settledNcp);
                if (activeTask) {
                  queueManager.setTaskHold(activeTask.req_id, browserId, { held_ncp: 0 });
                }
              }
              if (bodyIsV5 && req.telemetry && typeof req.telemetry.recordDispatch === 'function') {
                req.telemetry.recordDispatch(extractedParams ? extractedParams.model : null, isVerifiedBasePaid);
              }

              upstreamRes.pause();

              const runPoNRCommits = async () => {
                try {
                  if (settledAnlas > 0) {
                    await auditEngine.commitAnlasDebit(device.user_id, settledAnlas, browserId);
                    console.log(`[GuildWeave Audit Ledger] Committed PoNR ${settledAnlas} Anlas debit (User: "${device.user_id}").`);
                  }
                  if (settledNcp > 0) {
                    if (settledNcpSource === 'personal') {
                      await auditEngine.commitV5Debit(device.user_id, settledNcp);
                      console.log(`[GuildWeave Audit Ledger] Committed PoNR ${settledNcp} personal V5 NCP debit (User: "${device.user_id}").`);
                    } else if (settledNcpSource === 'surplus') {
                      await auditEngine.recordSurplusV5Usage(device.user_id);
                      const latestSurplusPool = queueManager.getSurplusPool().pool;
                      if (req.telemetry && typeof req.telemetry.persistSurplusPool === 'function') {
                        await req.telemetry.persistSurplusPool(latestSurplusPool);
                      } else {
                        await run(
                          "INSERT OR REPLACE INTO config (key, value) VALUES ('v5_surplus_pool', ?)",
                          [String(latestSurplusPool)]
                        );
                      }
                      console.log(`[GuildWeave Audit Ledger] Committed PoNR ${settledNcp} surplus V5 NCP deduction (User: "${device.user_id}", Pool Remaining: ${latestSurplusPool}).`);
                    }
                  }
                  if (shouldDeductAllowance) {
                    const remaining = await auditEngine.getOrUpdateAllowance(device.user_id, device.priority_tier, true);
                    console.log(`[GuildWeave Audit Ledger] Deducted 1 token for User "${device.user_id}" (${device.priority_tier}). Remaining balance: ${remaining}`);
                  }
                  await auditEngine.recordPeriodUsage(activeCycleEpoch, device.user_id, {
                    anlasConsumed: settledAnlas,
                    v5HighGens: v5HighDelta,
                    v5MediumGens: v5MedDelta,
                    legacyImageGens: legacyImgDelta
                  });
                } catch (commitErr) {
                  console.error('[GuildWeave Audit] Failed to commit PoNR settlement:', commitErr);
                } finally {
                  if (activeTask) {
                    queueManager.clearTaskHold(activeTask.req_id, browserId);
                  }
                }
              };

              if (settledAnlas > 0) {
                await withUserAnlasAuthLock(device.user_id, runPoNRCommits);
              } else {
                await runPoNRCommits();
              }

              if (isConnectionAborted() || res.headersSent) {
                try { upstreamRes.destroy(); } catch (_) {}
                executeCleanup();
                return;
              }
            } else if (activeTask) {
              // Pre-PoNR failure (non-200): release holds immediately with 0 debit
              queueManager.clearTaskHold(activeTask.req_id, browserId);
            }
          }

          req.socket.setNoDelay(true);

          if (cleanPath === 'ai/generate-image-stream' || cleanPath === 'ai/generate-stream' || cleanPath === 'oa/v1/completions') {
            upstreamRes.headers['x-accel-buffering'] = 'no';
            upstreamRes.headers['cache-control'] = 'no-cache, no-transform';
          }

          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        });

        upstreamReq.on('error', (err) => {
          console.error('[GuildWeave Telemetry] Upstream connection socket exception occurred:', err);
          if ((isImageGen || isUpscale) && activeTask) {
            queueManager.clearTaskHold(activeTask.req_id, browserId);
          }
          executeCleanup();
          if (!res.headersSent) {
            res.status(502).json({ 
              error: 'Upstream dynamic pipe disconnected',
              reason: err.message,
              code: err.code
            });
          } else {
            // Mid-Stream Invariant: Violently destroy response stream so client socket is never left hanging
            res.destroy(err);
          }
        });

        upstreamReq.setNoDelay(true);
        if (activeTask) {
          queueManager.attachUpstreamRequest(activeTask.req_id, upstreamReq);
        }

        if (payloadBuffer.length > 0) {
          upstreamReq.write(payloadBuffer);
        }
        upstreamReq.end();
      } catch (endErr) {
        console.error('[GuildWeave Telemetry] Fatal exception inside req.end settlement pipeline:', endErr);
        executeCleanup();
        if (!res.headersSent && !res.destroyed) {
          res.status(500).json({ error: 'Proxy processing failure.' });
        }
      }
    });

  } catch (err) {
    console.error('[GuildWeave Telemetry] Fatal exception thrown inside proxy router context:', err);
    executeCleanup();
    if (!res.headersSent) {
      sendEarlyError(500, { error: 'Proxy execution failure.' });
    }
  }
});

module.exports = router;