/**
 * LEVEL 4: STREAM-SAFE PROXY ROUTER (routes/proxyRouter.js)
 * 
 * Enforces strict req.pause() Stream Safety before executing database transactions.
 * Orchestrates payload WAF buffering, upstream piping, and asynchronous security auditing.
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

function getConfig() {
  return loadConfig(process.env);
}

router.all('/:subdomain/{*splat}', async (req, res) => {
  // 1. STREAM INVARIANT: Immediately pause socket reading to prevent OS buffer truncation during async blocking
  req.pause();

  let isStreamResumed = false;
  const safeResume = () => {
    if (!isStreamResumed) {
      isStreamResumed = true;
      try { req.resume(); } catch (_) {}
    }
  };

  const sendEarlyError = (status, payload) => {
    // Ingress Failure Invariant: For early ingress drops, stop buffering immediately and reject
    if (!res.headersSent) {
      res.setHeader('Connection', 'close');
      res.status(status).json(payload);
    }
    // Immediately destroy the rejected stream to prevent DoS bandwidth consumption
    req.destroy();
  };

  const config = getConfig();
  const { subdomain } = req.params;
  const pathPart = Array.isArray(req.params.splat) ? req.params.splat.join('/') : (req.params.splat || '');

  // SSRF Protection Rule: Reject arbitrary target routing
  if (!config.SUBDOMAIN_WHITELIST.includes(subdomain)) {
    console.warn(`[VPS SSRF Warning] Target subdomain rejected: "${subdomain}"`);
    return sendEarlyError(403, { error: 'SSRF Shield: Unauthorized subdomain destination.' });
  }

  // Privilege Escalation Prevention Rule: Ensure requested endpoint is strictly whitelisted
  if (!config.PROXY_PATH_WHITELIST.has(pathPart)) {
    console.warn(`[VPS Security Warning] Target path non-whitelisted: "${pathPart}"`);
    return sendEarlyError(403, { error: 'Access Denied: Path not whitelisted for proxying.' });
  }

  const browserId = req.headers['x-browser-id'];
  const clientAuth = req.headers['authorization'];
  if (!browserId || !clientAuth || !clientAuth.startsWith('Bearer ')) {
    return sendEarlyError(401, { error: 'Missing routing authorization context.' });
  }
  const deviceSecret = clientAuth.split(' ')[1];

  queueManager.ping(browserId);

  let activeTask = null;
  let upstreamReq = null;
  let cleanupExecuted = false;
  let isTextGenClaimed = false;
  let textGenLockId = null;

  const isImageGen = pathPart === 'ai/generate-image' || pathPart === 'ai/generate-image-stream';
  const isTextGen = pathPart === 'ai/generate-stream' || pathPart === 'oa/v1/completions';
  const genModelHeader = req.headers['x-gen-model'];

  const executeCleanup = () => {
    if (cleanupExecuted) return;
    cleanupExecuted = true;

    if (upstreamReq) {
      try { upstreamReq.destroy(); } catch (_) {}
    }

    if (isTextGenClaimed && textGenLockId) {
      queueManager.releaseTextSlot(textGenLockId);
    }

    if (activeTask) {
      queueManager.complete(activeTask.req_id, browserId);
      console.log(`[VPS Telemetry] Stream cleaned up. Slot released for request: "${activeTask.req_id}"`);
    }

    if (isImageGen && genModelHeader === 'V5' && req.telemetry) {
      req.telemetry.triggerSync();
    }
  };

  res.on('close', executeCleanup);
  res.on('finish', executeCleanup);

  try {
    // Authoritative Centralized Verification Gate
    const auth = await auditEngine.verifyDevice(browserId, deviceSecret, { requireApproval: true });
    if (!auth.ok) {
      return sendEarlyError(auth.status, { error: auth.error });
    }
    const device = auth.device;

    // Ingress Validation for Image Generation
    if (isImageGen) {
      // Reject missing model headers to prevent accidental bans on outdated clients
      if (!genModelHeader) {
        console.warn(`[VPS Gatekeeper] Rejected image gen request from browser "${browserId}" due to missing model validation header (outdated script).`);
        return sendEarlyError(426, {
          statusCode: 426,
          error: 'SCRIPT_UPDATE_REQUIRED',
          message: 'Your NovelAI Gateway Tampermonkey userscript is outdated. Please update to the latest version to proceed.'
        });
      }

      // V5 Capacity Safeguard: Await fresh data rather than executing sacrificial client drops
      if (genModelHeader === 'V5') {
        if (!req.telemetry) {
          console.error(`[VPS Gatekeeper] Critical: Telemetry context missing on V5 execution. Failing closed.`);
          return sendEarlyError(503, {
            statusCode: 503,
            error: 'TELEMETRY_UNAVAILABLE',
            message: 'Master subscription telemetry service is unavailable.'
          });
        }

        try {
          await req.telemetry.ensureFresh();
        } catch (telemetryErr) {
          console.error(`[VPS Gatekeeper] On-demand telemetry sync failed:`, telemetryErr.message);
          // If telemetry has never been fetched and fails, fail closed
          if (req.telemetry.lastFetched === 0) {
            return sendEarlyError(503, {
              statusCode: 503,
              error: 'TELEMETRY_FETCH_FAILED',
              message: 'Unable to verify master account capacity with upstream.'
            });
          }
        }

        if (req.telemetry.isHardLocked) {
          console.warn(`[VPS Gatekeeper] V5 generation rejected for browser "${browserId}". Verified V5 Capacity: ${req.telemetry.percent}%`);
          return sendEarlyError(429, {
            statusCode: 429,
            error: 'V5_CAPACITY_DEPLETED',
            message: `v5 generation is temporarily disabled due to low master account capacity (${req.telemetry.percent}% < 10%). Try again in a few minutes, or switch to an older model.`
          });
        }
      }

      // Validate active Channel A queue lock
      const requestId = req.headers['x-request-id'];
      if (!requestId) return sendEarlyError(400, { error: 'Missing request ID.' });

      activeTask = queueManager.getProcessingTask(requestId, browserId);
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
    } else if (isTextGen) {
      // Channel B Fast-Track Concurrency Limit Execution
      textGenLockId = req.headers['x-request-id'] || crypto.randomUUID();
      if (!queueManager.acquireTextSlot(textGenLockId)) {
        return sendEarlyError(429, { error: 'Text processing pipelines saturated. Retry request.' });
      }
      isTextGenClaimed = true;
    }

    // Retrieve master NovelAI session credential
    const configRecord = await get('SELECT value FROM config WHERE key = ?', ['master_token']);
    if (!configRecord || !configRecord.value) {
      executeCleanup();
      return sendEarlyError(503, { error: 'System unconfigured: No master token pushed.' });
    }
    const masterToken = configRecord.value;

    // 2. STREAM INVARIANT: Verification complete. Safe to unpause socket and accumulate payload.
    const bodyChunks = [];
    let accumulatedBytes = 0;
    let payloadExceededLimit = false;

    req.on('data', chunk => {
      if (payloadExceededLimit) return;
      accumulatedBytes += chunk.length;

      // Ingress Ceiling Invariant: Send HTTP 413, release locks synchronously, and terminate
      if (accumulatedBytes > config.MAX_PAYLOAD_SIZE_BYTES) {
        payloadExceededLimit = true;
        req.pause();
        console.warn(`[VPS Security] Payload constraint violation. Terminating stream from browser "${browserId}".`);
        executeCleanup();
        if (!res.headersSent) {
          res.status(413).json({
            statusCode: 413,
            error: 'PAYLOAD_TOO_LARGE',
            message: `Payload exceeded maximum architectural boundary of ${config.MAX_PAYLOAD_SIZE_BYTES} bytes.`
          });
        }
        req.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });
    
    safeResume();

    req.on('error', (reqErr) => {
      console.error('[VPS Proxy] Client request socket stream error:', reqErr);
      executeCleanup();
      if (!res.headersSent) {
        res.status(400).json({ error: 'Client request stream terminated abnormally.' });
      } else {
        res.destroy(reqErr);
      }
    });

    req.on('end', () => {
      if (req.destroyed || payloadExceededLimit) return;

      const payloadBuffer = Buffer.concat(bodyChunks);

      // Asynchronous Audit & Session Tracking
      setImmediate(async () => {
        try {
          await run('UPDATE devices SET total_requests = total_requests + 1, last_active_at = ? WHERE browser_id = ?', [Date.now(), browserId]);
          if (isImageGen && deviceSecret !== config.ADMIN_SECRET_KEY) {
            const auditResult = await auditEngine.runBackgroundAudit(browserId, payloadBuffer, genModelHeader === 'V5');
            if (auditResult && auditResult.banned) {
              if (auditResult.discordId) {
                queueManager.evict({ discord_id: auditResult.discordId });
              } else {
                queueManager.evict({ browser_id: auditResult.browserId });
              }
            }
          }
        } catch (err) {
          console.error('[VPS Audit] Background async process exception:', err);
        }
      });

      // Untruncated Telemetry Logging in Debug Mode
      if (req.headers['x-debug-mode'] === 'true') {
        console.log(`\n--- [VPS Debug Telemetry] Untruncated Structured Payload (Client: "${browserId}") ---`);
        console.log(auditEngine.formatPayloadForLogging(payloadBuffer));
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
        'x-gen-model', 'x-precise-refs', 'connection', 'content-length', 'transfer-encoding'
      ];
      stripHeaders.forEach(h => delete headers[h]);

      headers['content-length'] = payloadBuffer.length;

      console.log(`[VPS Telemetry] Forwarding piped request upstream to NovelAI: ${upstreamUrl} (Body: ${payloadBuffer.length} bytes)`);

      const transport = upstreamUrl.startsWith('https:') ? https : http;

      upstreamReq = transport.request(upstreamUrl, { method: req.method, headers }, (upstreamRes) => {
        console.log(`[VPS Telemetry] Received upstream headers. Status: ${upstreamRes.statusCode}`);

        const tierConfig = config.TIER_CONFIGS[device.priority_tier];
        if (upstreamRes.statusCode === 200 && isImageGen && tierConfig && tierConfig.maxAllowance !== Infinity) {
          setImmediate(async () => {
            try {
              const remaining = await auditEngine.getOrUpdateAllowance(browserId, device.priority_tier, true);
              console.log(`[VPS Audit Ledger] Deducted 1 token for "${browserId}" (${device.priority_tier}). Remaining balance: ${remaining}`);
            } catch (err) {
              console.error('[VPS Audit] Failed to deduct metered token:', err);
            }
          });
        }

        req.socket.setNoDelay(true);

        if (cleanPath === 'ai/generate-image-stream' || cleanPath === 'ai/generate-stream' || cleanPath === 'oa/v1/completions') {
          upstreamRes.headers['x-accel-buffering'] = 'no';
          upstreamRes.headers['cache-control'] = 'no-cache, no-transform';
        }

        // Active Cleanup Invariant: Synchronously release queue locks immediately upon failure
        upstreamRes.on('error', (err) => {
          console.error('[VPS Telemetry] Upstream response stream error occurred:', err);
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
          console.warn('[VPS Telemetry] Upstream response stream aborted by server');
          executeCleanup();
          res.destroy();
        });

        upstreamRes.on('close', () => {
          if (!upstreamRes.complete) {
            console.warn('[VPS Telemetry] Upstream response socket closed prematurely before completion');
            executeCleanup();
            res.destroy();
          }
        });

        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', (err) => {
        console.error('[VPS Telemetry] Upstream connection socket exception occurred:', err);
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
    console.error('[VPS Telemetry] Fatal exception thrown inside proxy router context:', err);
    executeCleanup();
    if (!res.headersSent) {
      sendEarlyError(500, { error: 'Proxy execution failure.' });
    }
  }
});

module.exports = router;