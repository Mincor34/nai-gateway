/**
 * LEVEL 4: QUEUE ROUTER (routes/queueRouter.js)
 * Coordinates single-concurrency Channel A locks, FIFO queue positions, and ACS-1
 * pre-flight V5 compute gating / reservation holds, plus Anlas-billed `/ai/upscale`
 * concurrency admission.
 * Relational Normalization: Enforces concurrency, allowances, billing-cycle Anlas spend gates,
 * master solvency checks, expired-token shielding, and two-bucket V5 NCP reservations on canonical user_id.
 */

'use strict';

const express = require('express');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

const V5_HIGH_NCP_COST = 18;
const V5_MEDIUM_NCP_COST = 10;
const BASE_PAID_MIN_ANLAS = 2;
const UPSCALE_MIN_ANLAS = 1;

function getConfig() {
  return loadConfig(process.env);
}

/**
 * Extracts a trimmed Bearer token from an Authorization header safely.
 *
 * @param {string|undefined} authHeader - Raw HTTP Authorization header value.
 * @returns {string|null} Extracted token or null.
 */
function extractBearerToken(authHeader) {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Validates that a candidate is a positive safe integer (strict JSON number).
 *
 * @param {*} value - Input candidate.
 * @returns {number|null} Validated positive integer or null.
 */
function parsePositiveSafeInt(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

/**
 * Validates that a candidate is a non-negative safe integer (strict JSON number).
 *
 * @param {*} value - Input candidate.
 * @returns {number|null} Validated non-negative integer or null.
 */
function parseNonNegativeSafeInt(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

/**
 * Computes active Channel A holds belonging to the single existing task that
 * queueManager.join() will synchronously evict on 1-request-per-user collision,
 * preventing tab refreshes from deadlocking against a user's own replaced task.
 *
 * @param {object} qm - Active QueueCoordinator instance.
 * @param {string} browserId - Requesting browser footprint.
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {string|null} discordId - Linked Discord identifier if present.
 * @returns {{anlas: number, personalNcp: number, surplusNcp: number}}
 */
function getReplaceableTaskHolds(qm, browserId, userId, discordId) {
  if (!Array.isArray(qm.queue)) {
    return { anlas: 0, personalNcp: 0, surplusNcp: 0 };
  }

  const effectiveDiscordId = discordId || (userId && !String(userId).startsWith('b_') ? userId : null);
  const colliding = qm.queue.find(t => {
    if (effectiveDiscordId && effectiveDiscordId !== 'admin') {
      if (t.discord_id === effectiveDiscordId || t.user_id === effectiveDiscordId) return true;
    }
    if (userId && userId !== 'admin' && t.user_id === userId) return true;
    return t.browser_id === browserId;
  });

  if (!colliding) {
    return { anlas: 0, personalNcp: 0, surplusNcp: 0 };
  }

  const anlas = (Number.isFinite(colliding.held_cost) && colliding.held_cost > 0) ? colliding.held_cost : 0;
  const ncp = (Number.isFinite(colliding.held_ncp) && colliding.held_ncp > 0) ? colliding.held_ncp : 0;

  return {
    anlas,
    personalNcp: colliding.held_ncp_source === 'personal' ? ncp : 0,
    surplusNcp: colliding.held_ncp_source === 'surplus' ? ncp : 0
  };
}

router.post('/join', async (req, res) => {
  const config = getConfig();
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  if (!body) {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'Request body must be a JSON object.' });
  }

  const {
    browser_id,
    tab_id = null,
    req_id,
    model,
    steps,
    is_base_paid,
    is_v5,
    is_upscale,
    width,
    height,
    n_samples,
    declared_anlas
  } = body;

  if (typeof browser_id !== 'string' || browser_id.trim().length === 0 || typeof req_id !== 'string' || req_id.trim().length === 0) {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'browser_id and req_id must be non-empty strings.' });
  }

  if (tab_id !== null && typeof tab_id !== 'string') {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'tab_id must be a string or null.' });
  }

  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'model must be a non-empty string when provided.' });
    }
  }

  if (is_base_paid !== undefined && typeof is_base_paid !== 'boolean') {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'is_base_paid must be a boolean.' });
  }

  if (is_v5 !== undefined && typeof is_v5 !== 'boolean') {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'is_v5 must be a boolean.' });
  }

  if (is_upscale !== undefined && typeof is_upscale !== 'boolean') {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'is_upscale must be a boolean.' });
  }

  const isUpscale = is_upscale === true;

  if (isUpscale && (is_v5 === true || is_base_paid === true)) {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'is_upscale cannot be combined with is_v5 or is_base_paid.' });
  }

  let parsedSteps = null;
  if (steps !== undefined && steps !== null) {
    parsedSteps = parsePositiveSafeInt(steps);
    if (parsedSteps === null) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'steps must be a positive safe integer.' });
    }
  }

  let parsedWidth = null;
  if (width !== undefined && width !== null) {
    parsedWidth = parsePositiveSafeInt(width);
    if (parsedWidth === null) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'width must be a positive safe integer.' });
    }
  }

  let parsedHeight = null;
  if (height !== undefined && height !== null) {
    parsedHeight = parsePositiveSafeInt(height);
    if (parsedHeight === null) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'height must be a positive safe integer.' });
    }
  }

  if ((parsedWidth !== null) !== (parsedHeight !== null)) {
    return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'width and height must both be provided together.' });
  }

  let parsedSamples = null;
  if (n_samples !== undefined && n_samples !== null) {
    parsedSamples = parsePositiveSafeInt(n_samples);
    if (parsedSamples === null) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'n_samples must be a positive safe integer.' });
    }
  }

  let parsedDeclaredAnlas = null;
  if (declared_anlas !== undefined && declared_anlas !== null) {
    parsedDeclaredAnlas = parseNonNegativeSafeInt(declared_anlas);
    if (parsedDeclaredAnlas === null) {
      return res.status(400).json({ statusCode: 400, error: 'INVALID_PARAMETERS', message: 'declared_anlas must be a non-negative safe integer.' });
    }
  }

  const device_secret = extractBearerToken(req.headers['authorization']);
  const trimmedModel = typeof model === 'string' ? model.trim() : '';

  let isV5 = false;
  if (!isUpscale) {
    if (trimmedModel.length > 0) {
      const modelIsV5 = auditEngine.isV5ModelFamily(trimmedModel);
      if (is_v5 !== undefined && is_v5 !== modelIsV5) {
        return res.status(400).json({
          statusCode: 400,
          error: 'INVALID_PARAMETERS',
          message: `Conflicting model identifier ("${trimmedModel}") and is_v5 (${is_v5}) flag.`
        });
      }
      isV5 = modelIsV5;
    } else {
      isV5 = is_v5 === true;
    }
  }

  const isV5Medium = !isUpscale && trimmedModel.length > 0 && auditEngine.isV5MediumModel(trimmedModel);
  const isBasePaid = !isUpscale && is_base_paid === true;
  const requestsAnlasBypass = isUpscale || isBasePaid || (parsedDeclaredAnlas !== null && parsedDeclaredAnlas > 0);

  try {
    // Authenticate and enforce approval/ban status prior to evaluating business policy gates
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: true });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const device = auth.device;
    queueManager.ping(browser_id);

    let upscaleCost = null;
    if (isUpscale) {
      if (parsedWidth !== null && parsedHeight !== null) {
        try {
          upscaleCost = auditEngine.calculateUpscaleAnlasCost(parsedWidth, parsedHeight);
        } catch (upscaleErr) {
          return res.status(400).json({
            statusCode: 400,
            error: 'PARAMETRIC_LIMIT_EXCEEDED',
            message: upscaleErr.message
          });
        }
      }
    } else {
      // Reject impossible base-paid claims when supplied dimensions/samples/steps fall strictly inside free Opus bounds
      const hasExplicitDimensions = parsedWidth !== null && parsedHeight !== null;
      const effectivePixels = hasExplicitDimensions ? (parsedWidth * parsedHeight) : null;
      const effectiveSamples = parsedSamples !== null ? parsedSamples : 1;
      const isKnownFreeGeometry = hasExplicitDimensions &&
        effectivePixels <= config.FIREWALL_MAX_PIXELS &&
        effectiveSamples === config.FIREWALL_MAX_SAMPLES;

      if (isBasePaid && isKnownFreeGeometry) {
        const withinFreeSteps = isV5Medium || parsedSteps === null || parsedSteps <= config.FIREWALL_MAX_STEPS;
        if (withinFreeSteps) {
          return res.status(400).json({
            statusCode: 400,
            error: 'PARAMETRIC_LIMIT_EXCEEDED',
            message: 'Baseline <=1MP, 1-sample parameters are not eligible for X-Base-Paid exemption.'
          });
        }
      }

      // Model-Aware Parametric & Deadband Gate (V5 Medium bypasses step validation; 24-28 deadband applies strictly to V5 High)
      if (!isV5Medium && !isBasePaid && parsedSteps !== null) {
        if (isV5 && parsedSteps >= 24 && parsedSteps <= 28) {
          return res.status(400).json({
            statusCode: 400,
            error: 'PARAMETRIC_LIMIT_EXCEEDED',
            message: 'V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24-28 are blocked to protect shared V5 limits—use <=23 steps or switch to Medium.'
          });
        }
        if (parsedSteps > config.FIREWALL_MAX_STEPS) {
          return res.status(400).json({
            statusCode: 400,
            error: 'PARAMETRIC_LIMIT_EXCEEDED',
            message: `Steps count of ${parsedSteps} exceeds the maximum limit of ${config.FIREWALL_MAX_STEPS} steps without Anlas enabled.`
          });
        }
      }

      if (!isBasePaid && ((effectivePixels !== null && effectivePixels > config.FIREWALL_MAX_PIXELS) || effectiveSamples !== config.FIREWALL_MAX_SAMPLES)) {
        return res.status(400).json({
          statusCode: 400,
          error: 'PARAMETRIC_LIMIT_EXCEEDED',
          message: 'Parameters exceeding 1MP or 1 sample require Anlas usage enabled.'
        });
      }
    }

    // Ensure fresh subscription telemetry for any V5 or Anlas-consuming queue request
    if (isV5 || requestsAnlasBypass) {
      if (!req.telemetry) {
        console.error('[GuildWeave Gatekeeper] Critical: Telemetry context missing on gated queue join. Failing closed.');
        return res.status(503).json({
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry service is unavailable.'
        });
      }

      try {
        await req.telemetry.ensureFresh();
      } catch (telemetryErr) {
        console.error('[GuildWeave Gatekeeper] On-demand telemetry sync failed at queue join:', telemetryErr.message);
        if (req.telemetry.masterTokenExpired) {
          return res.status(503).json({
            statusCode: 503,
            error: 'MASTER_TOKEN_EXPIRED',
            message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
          });
        }
        if (req.telemetry.lastFetched === 0) {
          return res.status(503).json({
            statusCode: 503,
            error: 'TELEMETRY_FETCH_FAILED',
            message: 'Unable to verify master account capacity with upstream.'
          });
        }
      }

      if (req.telemetry.masterTokenExpired) {
        return res.status(503).json({
          statusCode: 503,
          error: 'MASTER_TOKEN_EXPIRED',
          message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
        });
      }

      // Fail closed if ensureFresh() resolved without populating telemetry (e.g., master_token unconfigured)
      if (req.telemetry.lastFetched === 0) {
        return res.status(503).json({
          statusCode: 503,
          error: 'TELEMETRY_UNAVAILABLE',
          message: 'Master subscription telemetry has not been initialized.'
        });
      }
    }

    // Master Token Expiry Gate (protects legacy free requests from entering queue with dead credentials)
    if (req.telemetry && req.telemetry.masterTokenExpired) {
      console.warn(`[GuildWeave Gatekeeper] Queue entry blocked for browser "${browser_id}": Master token expired upstream.`);
      return res.status(503).json({
        statusCode: 503,
        error: 'MASTER_TOKEN_EXPIRED',
        message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
      });
    }

    // Master Opus Subscription Active Gate (applies to V5, base-paid, upscale, and legacy requests once telemetry exists)
    if (req.telemetry && req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
      console.warn(`[GuildWeave Gatekeeper] Queue entry blocked for browser "${browser_id}": Master Opus subscription is inactive.`);
      return res.status(503).json({
        statusCode: 503,
        error: 'MASTER_SUBSCRIPTION_INACTIVE',
        message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
      });
    }

    const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
    if (!isUpscale && tierConfig && tierConfig.maxAllowance !== Infinity) {
      // Evaluate allowance against canonical user_id (shared pool across all user devices)
      const allowance = await auditEngine.getOrUpdateAllowance(device.user_id, device.priority_tier, false);
      if (allowance < 1) {
        console.warn(`[GuildWeave Session Guard] User "${device.user_id}" (Device: ${browser_id}) allowance depleted.`);
        return res.status(403).json({ statusCode: 403, error: 'ALLOWANCE_EXHAUSTED' });
      }
      console.log(`[GuildWeave Session Check] User "${device.user_id}" verified with ${allowance} remaining tokens.`);
    }

    // Pre-Flight Master Anlas Solvency, Billing-Cycle Reset, Spend & Debt Lockout Gate
    if (requestsAnlasBypass) {
      const effectiveDeclaredAnlas = parsedDeclaredAnlas !== null
        ? parsedDeclaredAnlas
        : (isUpscale ? (upscaleCost ?? UPSCALE_MIN_ANLAS) : (isBasePaid ? BASE_PAID_MIN_ANLAS : 0));
      const requiredAnlasFloor = isUpscale
        ? Math.max(upscaleCost ?? UPSCALE_MIN_ANLAS, UPSCALE_MIN_ANLAS)
        : (isBasePaid ? Math.max(effectiveDeclaredAnlas, BASE_PAID_MIN_ANLAS) : effectiveDeclaredAnlas);

      if (
        req.telemetry &&
        req.telemetry.masterAnlas !== null &&
        req.telemetry.masterAnlas !== undefined &&
        req.telemetry.masterAnlas < requiredAnlasFloor
      ) {
        console.warn(
          `[GuildWeave Gatekeeper] Anlas bypass blocked for browser "${browser_id}": Master Anlas (${req.telemetry.masterAnlas}) < required (${requiredAnlasFloor}).`
        );
        return res.status(503).json({
          statusCode: 503,
          error: 'MASTER_ANLAS_DEPLETED',
          message: `Master account Anlas balance (${req.telemetry.masterAnlas}) is insufficient for this request (${requiredAnlasFloor} Anlas required).`
        });
      }

      // Cold-Boot Debt Guard: skip 30-day fallback reset before first telemetry sync seeds activeCycleEpoch
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
      }

      const replaceableBeforeAnlas = getReplaceableTaskHolds(queueManager, browser_id, device.user_id, device.discord_id);
      const totalHeldAnlas = queueManager.getHeldAnlasForUser(device.user_id);
      const netHeldAnlas = Math.max(0, totalHeldAnlas - replaceableBeforeAnlas.anlas);

      const spendAuth = await auditEngine.authorizeAnlasSpend(device.user_id, {
        declaredAnlas: effectiveDeclaredAnlas,
        ...(isUpscale ? { requiredAnlas: requiredAnlasFloor } : {}),
        isBasePaid,
        heldAnlas: netHeldAnlas
      });

      if (!spendAuth.ok) {
        return res.status(spendAuth.status).json({
          statusCode: spendAuth.status,
          error: spendAuth.error,
          message: spendAuth.message
        });
      }
    }

    // V5 Lazy Accrual Gate (Bucket 1 Personal Rollover Bank)
    let personalBankedBalance = Infinity;
    let reqNcp = 0;

    if (isV5 && !isBasePaid && !isUpscale) {
      reqNcp = isV5Medium ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST;

      const accrual = await auditEngine.evaluateV5Accrual(device.user_id, {
        now: Date.now(),
        nominalDailyCompute: req.telemetry?.nominalDailyCompute ?? null
      });
      personalBankedBalance = accrual ? accrual.v5_banked_balance : 0;
    }

    // SYNCHRONOUS CRITICAL SECTION (zero awaits between balance check, hold assignment, and queueManager.join)
    if (Array.isArray(queueManager.queue) && queueManager.queue.some(t => t.req_id === req_id)) {
      return res.status(409).json({
        statusCode: 409,
        error: 'DUPLICATE_REQUEST_ID',
        message: `Overlapping req_id "${req_id}" detected in Channel A queue.`
      });
    }

    if (req.telemetry && req.telemetry.masterTokenExpired) {
      return res.status(503).json({
        statusCode: 503,
        error: 'MASTER_TOKEN_EXPIRED',
        message: 'Master NovelAI session token was rejected upstream (401). Ask the administrator to push a fresh token.'
      });
    }

    if (req.telemetry && req.telemetry.lastFetched > 0 && req.telemetry.subscriptionActive === false) {
      return res.status(503).json({
        statusCode: 503,
        error: 'MASTER_SUBSCRIPTION_INACTIVE',
        message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.'
      });
    }

    let heldNcp = 0;
    let heldNcpSource = null;

    if (isV5 && !isBasePaid && !isUpscale) {
      if (req.telemetry.isHardLocked) {
        console.warn(`[GuildWeave Gatekeeper] V5 queue entry blocked by circuit breaker for browser "${browser_id}". Projected V5 Capacity: ${req.telemetry.percent.toFixed(2)}%`);
        return res.status(503).json({
          statusCode: 503,
          error: 'V5_BATTERY_CRITICAL',
          message: `Shared V5 capacity is recharging (${req.telemetry.percent.toFixed(2)}% <= ${config.V5_CIRCUIT_BREAKER_PERCENT}%). Switch to a legacy model or enable monthly Anlas.`
        });
      }

      if (personalBankedBalance !== Infinity) {
        const replaceable = getReplaceableTaskHolds(queueManager, browser_id, device.user_id, device.discord_id);
        const heldPersonal = Math.max(0, queueManager.getHeldNcpForUser(device.user_id, 'personal') - replaceable.personalNcp);
        const availablePersonal = Math.max(0, personalBankedBalance - heldPersonal);

        if (availablePersonal >= reqNcp) {
          heldNcp = reqNcp;
          heldNcpSource = 'personal';
        } else {
          const isSurplusEligible = Boolean(tierConfig && tierConfig.v5SurplusEligible);
          const heldSurplusTotal = Math.max(0, queueManager.getHeldSurplusNcp() - replaceable.surplusNcp);
          const availableSurplus = Math.max(0, queueManager.getSurplusPool().pool - heldSurplusTotal);

          if (isSurplusEligible && availableSurplus >= reqNcp) {
            heldNcp = reqNcp;
            heldNcpSource = 'surplus';
          } else {
            return res.status(429).json({
              statusCode: 429,
              error: 'V5_CAPACITY_DEPLETED',
              message: `Insufficient V5 compute capacity (${availablePersonal} personal NCP, ${isSurplusEligible ? availableSurplus : 0} eligible surplus NCP available; ${reqNcp} NCP required).`
            });
          }
        }
      }
    }

    queueManager.join({
      browser_id,
      tab_id,
      req_id,
      priority_tier: device.priority_tier,
      discord_id: device.discord_id || null,
      user_id: device.user_id,
      held_cost: 0,
      held_ncp: heldNcp,
      held_ncp_source: heldNcpSource
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[GuildWeave Telemetry] Queue join process exception:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  const { req_id, browser_id } = req.query;
  const device_secret = extractBearerToken(req.headers['authorization']);

  if (
    typeof req_id !== 'string' || req_id.trim().length === 0 ||
    typeof browser_id !== 'string' || browser_id.trim().length === 0 ||
    !device_secret
  ) {
    return res.status(400).json({ error: 'Missing parameters or authorization context' });
  }

  try {
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: true });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const pollResult = queueManager.poll(req_id, browser_id);
    if (!pollResult) return res.status(404).json({ error: 'Task missing' });

    if (pollResult.status === 'your_turn') return res.json({ status: 'your_turn' });
    res.json({ status: 'waiting', position: pollResult.position });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/complete', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { req_id, browser_id } = body;
  const device_secret = extractBearerToken(req.headers['authorization']);

  if (
    typeof req_id !== 'string' || req_id.trim().length === 0 ||
    typeof browser_id !== 'string' || browser_id.trim().length === 0 ||
    !device_secret
  ) {
    return res.status(400).json({ error: 'Missing parameters or authorization context' });
  }

  try {
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: true });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    queueManager.complete(req_id, browser_id);
    console.log(`[GuildWeave Telemetry] Received verified completion bounds. Dropping request: "${req_id}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;