/**
 * LEVEL 4: STREAM-SAFE PROXY ROUTER (routes/proxyRouter.js)
 * 
 * Enforces strict req.pause() Stream Safety before executing database transactions.
 * Enforces ACS-1 ingress staging semaphore (activeBufferingStreams <= INGRESS_SEMAPHORE_MAX),
 * upload inactivity & duration deadlines, TTL re-anchoring at req.on('end'), and isolated
 * Channel B `/ai/encode-vibe` PoNR 2-Anlas settlement.
 * Orchestrates payload WAF buffering, upstream piping, and asynchronous security auditing.
 * Relational Normalization: Deducts allowances, charges Anlas, and evaluates bans against canonical user_id.
 */

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { get, run } = require('../database');
const { loadConfig } = require('../config');

const router = express.Router();

const VIBE_ENCODE_ANLAS_COST = 2;

// Atomic Ingress Staging Concurrency Counter (bounds concurrent 50MB upload buffers)
let activeBufferingStreams = 0;

// Per-principal serialization gate for Channel B vibe spend-check + slot reservation
const userVibeAuthLocks = new Map();

router.getActiveBufferingStreams = () => activeBufferingStreams;

function getConfig() {
  return loadConfig(process.env);
}

/**
 * Serializes asynchronous `/ai/encode-vibe` balance evaluation + Channel B hold placement
 * per canonical user_id so concurrent requests cannot interleave between SQLite balance reads
 * and synchronous in-memory hold placement.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {Function} fn - Asynchronous critical-section callback.
 * @returns {Promise<*>} Result of critical-section execution.
 */
async function withUserVibeAuthLock(userId, fn) {
  const previous = userVibeAuthLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  userVibeAuthLocks.set(userId, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (userVibeAuthLocks.get(userId) === tail) {
      userVibeAuthLocks.delete(userId);
    }
  }
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
  const isTextGen = pathPart === 'ai/generate-stream' || pathPart === 'oa/v1/completions';
  const isVibeEncode = pathPart === 'ai/encode-vibe';
  const genModelHeader = req.headers['x-gen-model'];

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

    if (isImageGen && genModelHeader === 'V5' && req.telemetry) {
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
    queueManager.ping(browserId);

    // Ingress Validation for Image Generation
    if (isImageGen) {
      // Reject missing model headers to prevent accidental bans on outdated clients
      if (!genModelHeader) {
        console.warn(`[GuildWeave Gatekeeper] Rejected image gen request from browser "${browserId}" due to missing model validation header (outdated script).`);
        return sendEarlyError(426, {
          statusCode: 426,
          error: 'SCRIPT_UPDATE_REQUIRED',
          message: 'Your GuildWeave Tampermonkey userscript is outdated. Please update to the latest version to proceed.'
        });
      }

      // Resolve any Channel A task owned by this authenticated client prior to gated exits so early drops never strand locks
      const requestId = req.headers['x-request-id'];
      activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;

      // Reject unverified X-Base-Paid=true bypass claims prior to Commit 8 Anlas ledger integration
      if (req.headers['x-base-paid'] === 'true') {
        console.warn(`[GuildWeave Gatekeeper] Rejected premature X-Base-Paid=true claim from browser "${browserId}".`);
        return sendEarlyError(400, {
          statusCode: 400,
          error: 'BASE_PAID_UNSUPPORTED',
          message: 'Anlas base-paid parametric bypasses are not active on this gateway version.'
        });
      }

      // V5 Capacity Safeguard & Operational Circuit Breaker
      if (genModelHeader === 'V5') {
        if (!req.telemetry) {
          console.error(`[GuildWeave Gatekeeper] Critical: Telemetry context missing on V5 execution. Failing closed.`);
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
          // If telemetry has never been fetched and fails, fail closed
          if (req.telemetry.lastFetched === 0) {
            activeTask = requestId ? queueManager.getProcessingTask(requestId, browserId) : null;
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

        if (req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
          console.warn(`[GuildWeave Gatekeeper] V5 generation blocked for browser "${browserId}": Master Opus subscription is inactive.`);
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'MASTER_SUBSCRIPTION_INACTIVE',
            message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
          });
        }

        if (req.telemetry.isHardLocked) {
          console.warn(`[GuildWeave Gatekeeper] V5 generation blocked by circuit breaker for browser "${browserId}". Projected V5 Capacity: ${req.telemetry.percent.toFixed(2)}%`);
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'V5_BATTERY_CRITICAL',
            message: `V5 generation is temporarily locked by the cluster circuit breaker (${req.telemetry.percent.toFixed(2)}% <= ${config.V5_CIRCUIT_BREAKER_PERCENT}%). Try again after battery recharge, or switch to a non-V5 model.`
          });
        }
      } else if (req.telemetry && req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
        console.warn(`[GuildWeave Gatekeeper] Legacy generation blocked for browser "${browserId}": Master Opus subscription is inactive.`);
        return sendEarlyError(503, {
          statusCode: 503,
          error: 'MASTER_SUBSCRIPTION_INACTIVE',
          message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
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
      const width = parseInt(req.headers['x-gen-width'], 10) || 0;
      const height = parseInt(req.headers['x-gen-height'], 10) || 0;
      const steps = parseInt(req.headers['x-gen-steps'], 10) || 0;
      const samples = parseInt(req.headers['x-gen-samples'], 10) || 1;
      const preciseRefs = parseInt(req.headers['x-precise-refs'], 10) || 0;
      
      const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
      const totalPixels = width * height;
      const violations = [];

      if (totalPixels > config.FIREWALL_MAX_PIXELS) {
        violations.push(`Resolution of ${width}x${height} (${totalPixels}px) exceeds the maximum limit of ${config.FIREWALL_MAX_PIXELS.toLocaleString('en-US')}px (1MP)`);
      }
      if (steps > config.FIREWALL_MAX_STEPS) {
        violations.push(`Steps count of ${steps} exceeds the maximum limit of ${config.FIREWALL_MAX_STEPS} steps`);
      }
      if (samples !== config.FIREWALL_MAX_SAMPLES) {
        violations.push(`Samples count of ${samples} exceeds the maximum limit of ${config.FIREWALL_MAX_SAMPLES} sample (single-image generation only)`);
      }
      if (preciseRefs > tierConfig.preciseLimit) {
        violations.push(`Precise references count of ${preciseRefs} exceeds your max limit of ${tierConfig.preciseLimit}`);
      }

      if (violations.length > 0) {
        const combinedMessage = `\n\nAnlas Protection Limit Violations:\n` + violations.map(v => `• ${v}`).join('\n');
        return sendEarlyError(400, { statusCode: 400, message: combinedMessage, violations });
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
        if (req.telemetry.lastFetched === 0) {
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_FETCH_FAILED',
            message: 'Unable to verify master account capacity with upstream.'
          });
        }
      }

      if (isConnectionAborted()) return;

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
    if (!configRecord || !configRecord.value) {
      return sendEarlyError(503, { error: 'System unconfigured: No master token pushed.' });
    }
    const masterToken = configRecord.value;

    // Channel B Slot & Vibe Anlas Hold Reservation (serialized per user_id; zero awaits between balance check and acquireTextSlot)
    if (isVibeEncode) {
      let earlyRejection = null;

      await withUserVibeAuthLock(device.user_id, async () => {
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

    // 2. INGRESS STAGING SEMAPHORE & UPLOAD DEADLINES (excludes bodyless GET/HEAD reads)
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

    req.on('end', () => {
      requestEnded = true;
      clearUploadTimers();
      releaseBufferingSlot();

      if (req.destroyed || payloadExceededLimit || uploadTimedOut || isConnectionAborted()) {
        bodyChunks.length = 0;
        return;
      }

      const payloadBuffer = Buffer.concat(bodyChunks, accumulatedBytes);
      bodyChunks.length = 0;

      // Re-verify lock ownership post-buffering and re-anchor Channel A GPU TTL clock
      if (isImageGen && activeTask) {
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

      // Extract model identifier synchronously so upstreamRes PoNR dispatch weighting avoids waiting on setImmediate
      const extractedModel = (isImageGen && genModelHeader === 'V5')
        ? (auditEngine.extractParametersFromRawBody(payloadBuffer, req.headers['content-type'])?.model || null)
        : null;

      // Asynchronous Audit & Session Tracking
      setImmediate(async () => {
        try {
          await run('UPDATE devices SET total_requests = total_requests + 1, last_active_at = ? WHERE browser_id = ?', [Date.now(), browserId]);
          if (isImageGen && deviceSecret !== config.ADMIN_SECRET_KEY) {
            const auditResult = await auditEngine.runBackgroundAudit(browserId, payloadBuffer, genModelHeader === 'V5', req.headers['content-type']);
            if (auditResult && auditResult.banned) {
              queueManager.evict({ user_id: auditResult.userId });
            }
          }
        } catch (err) {
          console.error('[GuildWeave Audit] Background async process exception:', err);
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

      headers['content-length'] = payloadBuffer.length;

      console.log(`[GuildWeave Telemetry] Forwarding piped request upstream to NovelAI: ${upstreamUrl} (Body: ${payloadBuffer.length} bytes)`);

      const transport = upstreamUrl.startsWith('https:') ? https : http;

      upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, async (upstreamRes) => {
        console.log(`[GuildWeave Telemetry] Received upstream headers. Status: ${upstreamRes.statusCode}`);

        // Active Cleanup Invariant: Attach error/aborted/close listeners immediately before any async await
        upstreamRes.on('error', (err) => {
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
          console.warn('[GuildWeave Telemetry] Upstream response stream aborted by server');
          executeCleanup();
          res.destroy();
        });

        upstreamRes.on('close', () => {
          if (!upstreamRes.complete) {
            console.warn('[GuildWeave Telemetry] Upstream response socket closed prematurely before completion');
            executeCleanup();
            res.destroy();
          }
        });

        // Channel B `/ai/encode-vibe` Point of No Return (PoNR) Settlement
        if (isVibeEncode) {
          const vibeLock = textGenLockId ? queueManager.getTextLock(textGenLockId) : null;
          if (upstreamRes.statusCode === 200) {
            upstreamRes.pause();
            try {
              await auditEngine.commitAnlasDebit(device.user_id, VIBE_ENCODE_ANLAS_COST, browserId);
              console.log(`[GuildWeave Audit Ledger] Committed PoNR ${VIBE_ENCODE_ANLAS_COST} Anlas debit for vibe encode (User: "${device.user_id}").`);
            } catch (debitErr) {
              console.error('[GuildWeave Audit] Failed to commit vibe encode Anlas debit:', debitErr);
            } finally {
              if (vibeLock) {
                vibeLock.held_cost = 0;
              }
            }

            if (res.destroyed || res.writableEnded || res.headersSent) {
              try { upstreamRes.destroy(); } catch (_) {}
              executeCleanup();
              return;
            }
          } else if (vibeLock) {
            // Pre-PoNR failure: release 2-Anlas hold immediately with zero charge
            vibeLock.held_cost = 0;
          }
        }

        const tierConfig = config.TIER_CONFIGS[device.priority_tier];
        if (upstreamRes.statusCode === 200 && isImageGen) {
          if (genModelHeader === 'V5' && req.telemetry && typeof req.telemetry.recordDispatch === 'function') {
            req.telemetry.recordDispatch(extractedModel, false);
          }

          if (tierConfig && tierConfig.maxAllowance !== Infinity) {
            setImmediate(async () => {
              try {
                // Deduct allowance from canonical user_id (affects all user devices synchronously)
                const remaining = await auditEngine.getOrUpdateAllowance(device.user_id, device.priority_tier, true);
                console.log(`[GuildWeave Audit Ledger] Deducted 1 token for User "${device.user_id}" (${device.priority_tier}). Remaining balance: ${remaining}`);
              } catch (err) {
                console.error('[GuildWeave Audit] Failed to deduct metered token:', err);
              }
            });
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

      upstreamReq.write(payloadBuffer);
      upstreamReq.end();
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