/**
 * LEVEL 4: AUTHENTICATION ROUTER (routes/authRouter.js)
 * Manages device registration, nicknames, client authorization queries, dual-ledger status
 * serialization, cycle-segregated period usage telemetry, physical master-tank solvency
 * bounds on reported V5 availability, and in-band diagnostic intent signaling.
 * Rejects HTML/control-character payloads in device labels to prevent stored XSS in Admin UI.
 * Masks uninitialized or 401-invalidated telemetry to prevent phantom capacity exposure.
 * Relational Normalization: Integrates canonical users and physical devices tables.
 */

'use strict';

const express = require('express');
const { run, get, all } = require('../database');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

const MAX_LABEL_LENGTH = 64;
const UNSAFE_LABEL_REGEX = /[<>]|[\x00-\x1F\x7F]/;
const V5_HIGH_IMAGES_PER_PERCENT = 17.28;
const V5_HIGH_NCP_COST = 18;

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
 * Validates that a device label is a non-empty string devoid of HTML tags or control bytes.
 *
 * @param {*} label - Candidate device label.
 * @returns {string|null} Trimmed safe label or null if invalid.
 */
function sanitizeDeviceLabel(label) {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) return null;
  if (UNSAFE_LABEL_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolves the cluster operational state label from master battery telemetry and surplus pool.
 * - 'token_expired': upstream NovelAI rejected master_token with 401
 * - 'telemetry_offline': cold boot or cleared telemetry awaiting valid upstream sync
 * - 'frozen': subscription inactive or <= V5_CIRCUIT_BREAKER_PERCENT (5.5%)
 * - 'throttled': master capacity <= 15%
 * - 'surplus_active': master capacity > V5_SURPLUS_THRESHOLD_PERCENT (50%) or Bucket 2 pool > 0
 * - 'reserve_mode': 15% < master capacity <= 50% with 0 surplus pool
 *
 * @param {object} telemetrySnap - Resolved telemetry projection snapshot.
 * @param {number} availableSurplusNcp - Spendable Bucket 2 surplus NCP.
 * @param {object} config - Validated configuration manifest.
 * @returns {'token_expired'|'telemetry_offline'|'frozen'|'throttled'|'surplus_active'|'reserve_mode'}
 */
function deriveClusterState(telemetrySnap, availableSurplusNcp, config) {
  if (telemetrySnap.masterTokenExpired) {
    return 'token_expired';
  }
  if (telemetrySnap.lastFetched === 0) {
    return 'telemetry_offline';
  }
  if (!telemetrySnap.subscriptionActive || telemetrySnap.isHardLocked) {
    return 'frozen';
  }
  if (telemetrySnap.percent <= 15) {
    return 'throttled';
  }
  if (telemetrySnap.percent > config.V5_SURPLUS_THRESHOLD_PERCENT || availableSurplusNcp > 0) {
    return 'surplus_active';
  }
  return 'reserve_mode';
}

/**
 * Computes milliseconds remaining until the next whole integer percent of V5 battery
 * replenishment based on continuous projection and active replenishment period.
 *
 * @param {object} telemetrySnap - Resolved telemetry projection snapshot.
 * @returns {number|null} Milliseconds until next percent, 0 if tank is full, or null if cold-boot/expired.
 */
function computeNextPercentEtaMs(telemetrySnap) {
  if (!telemetrySnap || telemetrySnap.lastFetched === 0 || telemetrySnap.masterTokenExpired) {
    return null;
  }
  if (telemetrySnap.rawProjected >= 100) {
    return 0;
  }
  const periodSec = telemetrySnap.activePeriodSeconds;
  if (typeof periodSec !== 'number' || !Number.isFinite(periodSec) || periodSec <= 0) {
    return null;
  }
  const fractional = telemetrySnap.rawProjected - Math.floor(telemetrySnap.rawProjected);
  const remainingPct = 1 - fractional;
  return Math.max(0, Math.round(remainingPct * periodSec * 1000));
}

router.post('/register', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Bad parameters' });

  const { browser_id, device_secret, label } = body;
  if (
    typeof browser_id !== 'string' || browser_id.trim().length === 0 ||
    typeof device_secret !== 'string' || device_secret.trim().length === 0
  ) {
    return res.status(400).json({ error: 'Bad parameters' });
  }

  const cleanBrowserId = browser_id.trim();
  if (cleanBrowserId.toLowerCase() === 'admin') {
    return res.status(400).json({ error: 'Reserved identifier.' });
  }

  let cleanLabel = 'Guest Instance';
  if (label !== undefined && label !== null) {
    const validatedLabel = sanitizeDeviceLabel(label);
    if (!validatedLabel) {
      return res.status(400).json({ error: 'Bad parameters' });
    }
    cleanLabel = validatedLabel;
  }
  
  try {
    // Prevent registering a new unapproved device directly against an existing non-browser canonical principal
    if (!cleanBrowserId.startsWith('b_')) {
      const existingDevice = await get('SELECT browser_id FROM devices WHERE browser_id = ?', [cleanBrowserId]);
      if (!existingDevice) {
        const existingUser = await get('SELECT user_id FROM users WHERE user_id = ?', [cleanBrowserId]);
        if (existingUser) {
          return res.status(409).json({ error: 'Identifier conflicts with an existing principal.' });
        }
      }
    }

    const now = Date.now();
    // 1. Ensure canonical unlinked user principal exists
    await run(
      `INSERT OR IGNORE INTO users (
        user_id, priority_tier, banned, anlas_consumed, metered_allowance, last_allowance_update_at
      ) VALUES (?, 'Normal', 0, 0, 100, ?)`,
      [cleanBrowserId, now]
    );

    // 2. Register hardware device pointing to initial self user_id
    await run(
      `INSERT OR IGNORE INTO devices (
        browser_id, user_id, device_secret, label, approved, total_requests, last_active_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [cleanBrowserId, cleanBrowserId, device_secret, cleanLabel, now]
    );

    res.json({ success: true });
  } catch (err) { 
    console.error('[GuildWeave Telemetry] Registration exception:', err);
    res.status(500).json({ error: err.message }); 
  }
});

router.post('/update-label', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  const device_secret = extractBearerToken(req.headers['authorization']);

  if (!body) return res.status(400).json({ error: 'Missing parameters' });
  const { browser_id, label } = body;

  const cleanLabel = sanitizeDeviceLabel(label);
  if (typeof browser_id !== 'string' || browser_id.trim().length === 0 || !cleanLabel) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  try {
    // Unapproved devices must be permitted to modify their nicknames during onboarding
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: false });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: 'Unauthorized nickname change' });
    }

    await run('UPDATE devices SET label = ? WHERE browser_id = ?', [cleanLabel, browser_id]);
    console.log(`[GuildWeave Telemetry] Device "${browser_id}" updated nickname: "${cleanLabel}"`);
    res.json({ success: true });
  } catch (err) { 
    console.error('[GuildWeave Telemetry] Update label exception:', err);
    res.status(500).json({ error: err.message }); 
  }
});

/**
 * In-band Client Diagnostic Debug Intent Registration.
 * Allows an authenticated guest to actively declare diagnostic consent directly over the API.
 */
router.post('/debug-intent', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id, enabled } = body;
  const device_secret = extractBearerToken(req.headers['authorization']);

  if (!browser_id || typeof browser_id !== 'string' || browser_id.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid browser_id parameter.' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  try {
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: false });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const intentState = enabled;
    queueManager.setDebugIntent(browser_id, intentState);
    console.log(`[GuildWeave Telemetry] Device "${browser_id}" registered diagnostic debug intent: ${intentState}`);

    const debugInfo = queueManager.getDebugTargetInfo(browser_id);

    res.json({
      success: true,
      browser_id,
      debug_intent: intentState,
      is_authorized: debugInfo.is_authorized,
      expires_in_ms: debugInfo.expires_in_ms
    });
  } catch (err) {
    console.error('[GuildWeave Telemetry] Debug intent registration exception:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  const config = getConfig();
  const { browser_id } = req.query;
  const device_secret = extractBearerToken(req.headers['authorization']);

  if (typeof browser_id !== 'string' || browser_id.trim().length === 0 || !device_secret) {
    return res.status(401).json({ error: 'Unauthenticated status query' });
  }

  try {
    // Check credentials without rejecting unapproved devices since they must poll for approval
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: false });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const device = auth.device;
    queueManager.ping(browser_id);
    const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
    const now = Date.now();

    // Onboarding Reset Gating & Cold-Boot Debt Guard:
    // 1. Gate evaluateAnlasReset() strictly behind device.approved === 1 so unapproved onboarding polls
    //    never stamp last_anlas_reset_epoch or lock in a pre-approval Normal quota before tier assignment.
    // 2. Skip evaluateAnlasReset() when telemetry is still cold-boot (lastFetched === 0 && activeCycleEpoch === null).
    if (device.approved === 1) {
      const skipColdBootReset = Boolean(
        req.telemetry &&
        req.telemetry.lastFetched === 0 &&
        req.telemetry.activeCycleEpoch === null
      );

      if (!skipColdBootReset) {
        await auditEngine.evaluateAnlasReset(device.user_id, {
          now,
          activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
          isGracePeriod: req.telemetry?.isGracePeriod ?? false,
          subscriptionActive: req.telemetry?.subscriptionActive ?? true
        });
      }
    }

    // Forward live req.telemetry.nominalDailyCompute into lazy V5 accrual prior to reading balances
    const v5Accrual = await auditEngine.evaluateV5Accrual(device.user_id, {
      now,
      nominalDailyCompute: req.telemetry?.nominalDailyCompute ?? null
    });

    // Inject cross-channel scalar Anlas hold from Level 3 QueueCoordinator into Level 2 evaluator
    const heldAnlas = queueManager.getHeldAnlasForUser(device.user_id);
    const balanceInfo = await auditEngine.calculateAvailableBalance(device.user_id, heldAnlas);

    const userRow = (device.user_id && device.user_id !== 'admin')
      ? await get(
        `SELECT anlas_consumed, virtual_anlas_balance, last_anlas_reset_epoch,
                v5_banked_balance, v5_last_accrual_epoch, v5_daily_consumed,
                subscription_period_anlas, subscription_period_v5, subscription_period_start_epoch
         FROM users WHERE user_id = ?`,
        [device.user_id]
      )
      : null;

    // Resolve cycle-segregated period telemetry from `period_usage`, falling back safely to
    // `users.subscription_period_*` only when the user row matches the active cycle epoch
    // (prevents inactive users' stale Cycle 1 totals from bleeding into Cycle 2).
    const activeCycleEpoch = (req.telemetry && typeof req.telemetry.activeCycleEpoch === 'number' && req.telemetry.activeCycleEpoch > 0)
      ? req.telemetry.activeCycleEpoch
      : 0;
    const periodRow = await get(
      `SELECT anlas_consumed, v5_high_gens, v5_medium_gens, legacy_image_gens,
              vibe_encodes, upscale_gens, text_gens
       FROM period_usage
       WHERE cycle_epoch = ? AND user_id = ?`,
      [activeCycleEpoch, device.user_id]
    );

    let allowanceInfo = null;
    if (tierConfig && tierConfig.maxAllowance !== Infinity) {
      // Evaluate allowance against canonical user_id (shared pool across all user devices)
      const allowance = await auditEngine.getOrUpdateAllowance(device.user_id, device.priority_tier, false);
      const nextRefillAt = await auditEngine.getNextRefillTime(device.user_id, device.priority_tier);
      allowanceInfo = {
        allowance,
        max: tierConfig.maxAllowance,
        next_refill_in: nextRefillAt ? Math.max(0, nextRefillAt - Date.now()) : 0
      };
    }

    let linkedDevices = [];
    if (device.user_id && device.user_id !== 'admin') {
      const devices = await all(
        'SELECT browser_id, label FROM devices WHERE user_id = ? AND approved = 1', 
        [device.user_id]
      );
      linkedDevices = devices.map(d => ({ id: d.browser_id, label: d.label }));
    }

    const debugInfo = queueManager.getDebugTargetInfo(browser_id);

    // Derive Anlas ledger view
    const isAnlasUnlimited = tierConfig.monthlyAnlas === Infinity || device.user_id === 'admin';
    const virtualBalance = isAnlasUnlimited
      ? null
      : (balanceInfo ? balanceInfo.virtual_balance : Math.trunc(userRow?.virtual_anlas_balance || 0));
    const availableBalance = isAnlasUnlimited
      ? null
      : (balanceInfo ? balanceInfo.available_balance : ((virtualBalance || 0) - heldAnlas));
    const isInDebt = isAnlasUnlimited
      ? false
      : (balanceInfo ? balanceInfo.is_in_debt : ((virtualBalance || 0) < 0));
    const lifetimeAnlasConsumed = userRow?.anlas_consumed ?? device.anlas_consumed ?? 0;

    const userRowMatchesActiveCycle = Boolean(
      userRow && (
        activeCycleEpoch === 0 ||
        userRow.subscription_period_start_epoch === activeCycleEpoch
      )
    );
    const periodV5High = periodRow ? (periodRow.v5_high_gens || 0) : 0;
    const periodV5Med = periodRow ? (periodRow.v5_medium_gens || 0) : 0;
    const periodV5FromArchive = periodV5High + periodV5Med;
    const userPeriodAnlas = userRowMatchesActiveCycle ? (userRow.subscription_period_anlas ?? 0) : 0;
    const userPeriodV5 = userRowMatchesActiveCycle ? (userRow.subscription_period_v5 ?? 0) : 0;

    const subPeriodAnlas = periodRow
      ? Math.max(periodRow.anlas_consumed || 0, userPeriodAnlas)
      : userPeriodAnlas;
    const subPeriodV5 = periodRow
      ? Math.max(periodV5FromArchive, userPeriodV5)
      : userPeriodV5;
    const subPeriodStart = activeCycleEpoch > 0
      ? activeCycleEpoch
      : (userRow?.subscription_period_start_epoch ?? null);

    // Derive Master Telemetry & Physical Solvency Ceiling
    const telemetrySnap = (req.telemetry && typeof req.telemetry.getProjectionSnapshot === 'function')
      ? req.telemetry.getProjectionSnapshot(now)
      : {
        percent: req.telemetry?.percent ?? 100,
        rawProjected: req.telemetry?.rawPercent ?? (req.telemetry?.percent ?? 100),
        isNegative: req.telemetry?.isNegative ?? false,
        lastFetched: req.telemetry?.lastFetched ?? 0,
        isHardLocked: req.telemetry?.isHardLocked ?? false,
        masterTokenExpired: req.telemetry?.masterTokenExpired ?? false,
        nominalDailyCompute: req.telemetry?.nominalDailyCompute ?? config.NOMINAL_DAILY_V5_COMPUTE,
        timeUntilNextPercent: req.telemetry?.timeUntilNextPercent ?? null,
        activePeriodSeconds: req.telemetry?.activePeriodSeconds ?? ((86400 * V5_HIGH_IMAGES_PER_PERCENT) / config.NOMINAL_DAILY_V5_COMPUTE),
        subscriptionActive: req.telemetry?.subscriptionActive ?? true,
        isGracePeriod: req.telemetry?.isGracePeriod ?? false,
        masterExpiresAt: req.telemetry?.masterExpiresAt ?? null,
        activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null
      };

    const spendableMasterNcp = (telemetrySnap.lastFetched > 0 && !telemetrySnap.masterTokenExpired)
      ? ((telemetrySnap.isHardLocked || !telemetrySnap.subscriptionActive)
        ? 0
        : Math.floor(Math.max(0, telemetrySnap.rawProjected - config.V5_CIRCUIT_BREAKER_PERCENT) * V5_HIGH_IMAGES_PER_PERCENT * V5_HIGH_NCP_COST))
      : null;

    // Derive V5 Dual-Bucket NCP view, capping effective available credits to physical master headroom
    const isV5Unlimited = device.user_id === 'admin';
    const heldPersonalNcp = queueManager.getHeldNcpForUser(device.user_id, 'personal');
    const heldSurplusUserNcp = queueManager.getHeldNcpForUser(device.user_id, 'surplus');
    const rawV5Banked = v5Accrual
      ? v5Accrual.v5_banked_balance
      : Math.max(0, Math.trunc(userRow?.v5_banked_balance || 0));
    const v5BankedNcp = (isV5Unlimited || !Number.isFinite(rawV5Banked)) ? null : rawV5Banked;
    const uncappedAvailableNcp = v5BankedNcp === null ? null : Math.max(0, v5BankedNcp - heldPersonalNcp);
    const v5AvailableNcp = uncappedAvailableNcp === null
      ? null
      : (spendableMasterNcp !== null ? Math.min(uncappedAvailableNcp, spendableMasterNcp) : uncappedAvailableNcp);
    const v5DailyShareNcp = (v5Accrual && Number.isFinite(v5Accrual.daily_share_ncp)) ? v5Accrual.daily_share_ncp : null;
    const v5MaxBankNcp = (v5Accrual && Number.isFinite(v5Accrual.max_bank_ncp)) ? v5Accrual.max_bank_ncp : null;

    const surplusState = queueManager.getSurplusPool();
    const surplusHeldTotal = queueManager.getHeldSurplusNcp();
    const rawSurplusAvailableNcp = queueManager.getAvailableSurplusNcp();
    const surplusAvailableNcp = spendableMasterNcp !== null
      ? Math.min(rawSurplusAvailableNcp, spendableMasterNcp)
      : rawSurplusAvailableNcp;

    const isColdOrExpired = telemetrySnap.lastFetched === 0;
    const nextPercentEtaMs = computeNextPercentEtaMs(telemetrySnap);
    const clusterState = deriveClusterState(telemetrySnap, surplusAvailableNcp, config);

    res.json({ 
      approved: !!device.approved, 
      tier: device.priority_tier,
      anlas_consumed: lifetimeAnlasConsumed,
      precise_limit: tierConfig?.preciseLimit === Infinity ? "Unlimited" : (tierConfig?.preciseLimit ?? 0),
      session: allowanceInfo,
      linked_devices: linkedDevices,
      master_v5_percent: isColdOrExpired ? null : telemetrySnap.percent,
      debug_intent: debugInfo.has_intent,
      debug_authorized: debugInfo.is_authorized,
      debug_expires_in_ms: debugInfo.expires_in_ms,
      anlas: {
        virtual_balance: virtualBalance,
        available_balance: availableBalance,
        held: heldAnlas,
        monthly_quota: isAnlasUnlimited ? null : tierConfig.monthlyAnlas,
        is_unlimited: isAnlasUnlimited,
        is_in_debt: isInDebt,
        zero_rollover: true,
        last_reset_epoch: userRow?.last_anlas_reset_epoch ?? null,
        subscription_period_consumed: subPeriodAnlas,
        lifetime_consumed: lifetimeAnlasConsumed
      },
      v5: {
        banked_ncp: v5BankedNcp,
        available_ncp: v5AvailableNcp,
        spendable_master_ncp: spendableMasterNcp,
        held_ncp: heldPersonalNcp + heldSurplusUserNcp,
        held_personal_ncp: heldPersonalNcp,
        held_surplus_ncp: heldSurplusUserNcp,
        is_unlimited: isV5Unlimited,
        daily_share_ncp: v5DailyShareNcp,
        max_bank_ncp: v5MaxBankNcp,
        daily_consumed: v5Accrual ? v5Accrual.v5_daily_consumed : (userRow?.v5_daily_consumed ?? 0),
        last_accrual_epoch: v5Accrual ? v5Accrual.v5_last_accrual_epoch : (userRow?.v5_last_accrual_epoch ?? null),
        subscription_period_consumed: subPeriodV5,
        surplus_pool_ncp: surplusState.pool,
        surplus_available_ncp: surplusAvailableNcp,
        surplus_held_ncp: surplusHeldTotal,
        surplus_eligible: Boolean(tierConfig?.v5SurplusEligible),
        surplus_last_accrual_epoch: surplusState.lastAccrual
      },
      telemetry: {
        master_v5_percent: isColdOrExpired ? null : telemetrySnap.percent,
        master_v5_raw_percent: isColdOrExpired ? null : telemetrySnap.rawProjected,
        master_v5_is_negative: isColdOrExpired ? false : telemetrySnap.isNegative,
        is_hard_locked: telemetrySnap.isHardLocked,
        master_token_expired: Boolean(telemetrySnap.masterTokenExpired),
        cluster_state: clusterState,
        time_until_next_percent: isColdOrExpired ? null : telemetrySnap.timeUntilNextPercent,
        next_percent_eta_ms: nextPercentEtaMs,
        active_period_seconds: telemetrySnap.activePeriodSeconds,
        nominal_daily_compute: telemetrySnap.nominalDailyCompute,
        last_fetched_at: telemetrySnap.lastFetched,
        subscription_active: telemetrySnap.masterTokenExpired ? false : (isColdOrExpired ? null : telemetrySnap.subscriptionActive),
        is_grace_period: isColdOrExpired ? false : telemetrySnap.isGracePeriod,
        master_expires_at: telemetrySnap.masterExpiresAt,
        active_cycle_epoch: telemetrySnap.activeCycleEpoch
      },
      subscription_period: {
        anlas_consumed: subPeriodAnlas,
        v5_consumed: subPeriodV5,
        v5_high_gens: periodV5High,
        v5_medium_gens: periodV5Med,
        legacy_image_gens: periodRow ? (periodRow.legacy_image_gens || 0) : 0,
        vibe_encodes: periodRow ? (periodRow.vibe_encodes || 0) : 0,
        upscale_gens: periodRow ? (periodRow.upscale_gens || 0) : 0,
        text_gens: periodRow ? (periodRow.text_gens || 0) : 0,
        start_epoch: subPeriodStart
      }
    });
  } catch (err) { 
    console.error('[GuildWeave Telemetry] Authentication verification query failure:', err);
    res.status(500).json({ error: err.message }); 
  }
});

module.exports = router;