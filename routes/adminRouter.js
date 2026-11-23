/**
 * LEVEL 4: ADMINISTRATIVE ROUTER (routes/adminRouter.js)
 * Isolates all privileged control panel, Discord bot, and management interactions.
 * Exposes dual-ledger Anlas/V5 NCP telemetry, Cluster Surplus state, billing-cycle-segregated
 * period usage & historical archives (`GET /admin/cycles`, `?cycle_epoch=` on `/devices` & `/global-stats`),
 * and atomic balance adjustment / debt reconciliation controls.
 * Supports canonical user_id, discord_id, and browser_id resolution across governance endpoints
 * (including pruned unlinked user records lacking active rows in devices).
 * Relational Normalization: Operates on canonical users as parents and devices as children.
 */

'use strict';

const express = require('express');
const { run, get, all } = require('../database');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

function getConfig() {
  return loadConfig(process.env);
}

/**
 * Validates an optional identifier parameter (must be undefined/null or a non-empty string).
 *
 * @param {*} value - Candidate identifier.
 * @returns {boolean} True if omitted/null or valid non-empty string.
 */
function isOptionalNonEmptyString(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolves the requested cycle_epoch query selector:
 * - `'all'` -> lifetime mode (`mode: 'all'`)
 * - positive/zero decimal integer -> specific billing cycle (`mode: 'cycle', cycleEpoch`)
 * - omitted -> active billing cycle from `req.telemetry.activeCycleEpoch` (or `0` fallback)
 *
 * @param {*} rawCycleParam - Express req.query.cycle_epoch candidate.
 * @param {number|null} activeCycleEpoch - Current active cycle epoch from telemetry.
 * @returns {{ok: boolean, mode?: 'cycle'|'all', cycleEpoch?: number, isActiveCycle?: boolean, error?: string}}
 */
function parseCycleFilterParam(rawCycleParam, activeCycleEpoch) {
  const effectiveActive = (typeof activeCycleEpoch === 'number' && Number.isInteger(activeCycleEpoch) && activeCycleEpoch > 0)
    ? activeCycleEpoch
    : 0;

  if (rawCycleParam === undefined || rawCycleParam === null || rawCycleParam === '') {
    return { ok: true, mode: 'cycle', cycleEpoch: effectiveActive, isActiveCycle: true };
  }
  if (typeof rawCycleParam !== 'string') {
    return { ok: false, error: 'cycle_epoch must be a non-negative integer or "all".' };
  }
  const trimmed = rawCycleParam.trim().toLowerCase();
  if (trimmed === 'all') {
    return { ok: true, mode: 'all', cycleEpoch: null, isActiveCycle: false };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: 'cycle_epoch must be a non-negative integer or "all".' };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, error: 'cycle_epoch exceeds safe integer bounds.' };
  }
  return {
    ok: true,
    mode: 'cycle',
    cycleEpoch: parsed,
    isActiveCycle: parsed === effectiveActive
  };
}

/**
 * Resolves a canonical user_id from explicit user_id/discord_id or hardware browser_id.
 *
 * @param {object} body - Request JSON body.
 * @returns {Promise<{ok: boolean, status?: number, error?: string, userId?: string}>}
 */
async function resolveTargetUserId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }

  const rawUser = (body.user_id !== undefined && body.user_id !== null) ? body.user_id : body.discord_id;
  if (rawUser !== undefined && rawUser !== null) {
    if (typeof rawUser !== 'string' || rawUser.trim().length === 0) {
      return { ok: false, status: 400, error: 'user_id / discord_id must be a non-empty string.' };
    }
    const trimmed = rawUser.trim();
    if (trimmed.toLowerCase() === 'admin') {
      return { ok: false, status: 400, error: 'Cannot adjust synthetic admin principal.' };
    }
    return { ok: true, userId: trimmed };
  }

  if (body.browser_id !== undefined && body.browser_id !== null) {
    if (typeof body.browser_id !== 'string' || body.browser_id.trim().length === 0) {
      return { ok: false, status: 400, error: 'browser_id must be a non-empty string.' };
    }
    const cleanBrowserId = body.browser_id.trim();
    const dev = await get('SELECT user_id, discord_id FROM devices WHERE browser_id = ?', [cleanBrowserId]);
    if (dev) {
      return { ok: true, userId: dev.user_id || dev.discord_id || cleanBrowserId };
    }
    const userRow = await get('SELECT user_id FROM users WHERE user_id = ?', [cleanBrowserId]);
    if (userRow) {
      return { ok: true, userId: userRow.user_id };
    }
    return { ok: false, status: 404, error: 'Target device not found.' };
  }

  return { ok: false, status: 400, error: 'Missing target identifier (user_id, discord_id, or browser_id).' };
}

// Strict Middleware for Administrative Endpoints
const verifyAdmin = (req, res, next) => {
  const config = getConfig();
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing admin credentials' });
  }
  if (authHeader.split(' ')[1] !== config.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  next();
};

router.use(verifyAdmin);

/**
 * Lists archived and active subscription billing periods for segregated telemetry inspection.
 */
router.get('/cycles', async (req, res) => {
  try {
    const activeEpoch = req.telemetry?.activeCycleEpoch ?? null;
    const rows = await all(
      `SELECT sp.cycle_epoch, sp.expires_at, sp.started_at,
              COALESCE(SUM(pu.anlas_consumed), 0) as total_anlas,
              COALESCE(SUM(pu.v5_high_gens + pu.v5_medium_gens), 0) as total_v5,
              COALESCE(SUM(pu.legacy_image_gens), 0) as total_legacy_images,
              COALESCE(SUM(pu.upscale_gens), 0) as total_upscales,
              COALESCE(SUM(pu.vibe_encodes), 0) as total_vibes,
              COALESCE(SUM(pu.text_gens), 0) as total_text_gens
       FROM subscription_periods sp
       LEFT JOIN period_usage pu ON pu.cycle_epoch = sp.cycle_epoch
       GROUP BY sp.cycle_epoch
       ORDER BY sp.cycle_epoch DESC`
    );

    const seenEpochs = new Set(rows.map(r => r.cycle_epoch));
    const distinctUsageEpochs = await all('SELECT DISTINCT cycle_epoch FROM period_usage ORDER BY cycle_epoch DESC');
    for (const row of distinctUsageEpochs) {
      if (!seenEpochs.has(row.cycle_epoch)) {
        const agg = await get(
          `SELECT COALESCE(SUM(anlas_consumed), 0) as total_anlas,
                  COALESCE(SUM(v5_high_gens + v5_medium_gens), 0) as total_v5,
                  COALESCE(SUM(legacy_image_gens), 0) as total_legacy_images,
                  COALESCE(SUM(upscale_gens), 0) as total_upscales,
                  COALESCE(SUM(vibe_encodes), 0) as total_vibes,
                  COALESCE(SUM(text_gens), 0) as total_text_gens
           FROM period_usage WHERE cycle_epoch = ?`,
          [row.cycle_epoch]
        );
        rows.push({
          cycle_epoch: row.cycle_epoch,
          expires_at: null,
          started_at: row.cycle_epoch,
          total_anlas: agg?.total_anlas || 0,
          total_v5: agg?.total_v5 || 0,
          total_legacy_images: agg?.total_legacy_images || 0,
          total_upscales: agg?.total_upscales || 0,
          total_vibes: agg?.total_vibes || 0,
          total_text_gens: agg?.total_text_gens || 0
        });
        seenEpochs.add(row.cycle_epoch);
      }
    }

    if (activeEpoch && !seenEpochs.has(activeEpoch)) {
      rows.unshift({
        cycle_epoch: activeEpoch,
        expires_at: req.telemetry?.masterExpiresAt ?? null,
        started_at: activeEpoch,
        total_anlas: 0,
        total_v5: 0,
        total_legacy_images: 0,
        total_upscales: 0,
        total_vibes: 0,
        total_text_gens: 0
      });
    }

    rows.sort((a, b) => b.cycle_epoch - a.cycle_epoch);

    res.json({
      active_cycle_epoch: activeEpoch,
      cycles: rows.map(r => ({
        ...r,
        is_active: activeEpoch !== null && r.cycle_epoch === activeEpoch
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/devices', async (req, res) => {
  const config = getConfig();
  const cycleFilter = parseCycleFilterParam(req.query?.cycle_epoch, req.telemetry?.activeCycleEpoch ?? null);
  if (!cycleFilter.ok) {
    return res.status(400).json({ error: cycleFilter.error });
  }

  try { 
    const users = await all('SELECT * FROM users');
    const devices = await all('SELECT * FROM devices');

    const periodMap = new Map();
    if (cycleFilter.mode === 'all') {
      const periodRows = await all(
        `SELECT user_id,
                SUM(anlas_consumed) as anlas_consumed,
                SUM(v5_high_gens) as v5_high_gens,
                SUM(v5_medium_gens) as v5_medium_gens,
                SUM(legacy_image_gens) as legacy_image_gens,
                SUM(vibe_encodes) as vibe_encodes,
                SUM(upscale_gens) as upscale_gens,
                SUM(text_gens) as text_gens
         FROM period_usage
         GROUP BY user_id`
      );
      for (const r of periodRows) periodMap.set(r.user_id, r);
    } else {
      const periodRows = await all(
        `SELECT user_id, anlas_consumed, v5_high_gens, v5_medium_gens,
                legacy_image_gens, vibe_encodes, upscale_gens, text_gens
         FROM period_usage
         WHERE cycle_epoch = ?`,
        [cycleFilter.cycleEpoch]
      );
      for (const r of periodRows) periodMap.set(r.user_id, r);
    }

    const groups = {};
    for (const u of users) {
      const isLinked = !u.user_id.startsWith('b_');
      let meteredAllowance = null;
      const tierConfig = config.TIER_CONFIGS[u.priority_tier] || config.TIER_CONFIGS['Normal'];
      if (tierConfig && tierConfig.maxAllowance !== Infinity) {
        meteredAllowance = await auditEngine.getOrUpdateAllowance(u.user_id, u.priority_tier, false);
      }

      const heldAnlas = queueManager.getHeldAnlasForUser(u.user_id);
      const balanceInfo = await auditEngine.calculateAvailableBalance(u.user_id, heldAnlas);
      const isAnlasUnlimited = tierConfig.monthlyAnlas === Infinity || u.user_id === 'admin';

      const heldPersonalNcp = queueManager.getHeldNcpForUser(u.user_id, 'personal');
      const heldSurplusNcp = queueManager.getHeldNcpForUser(u.user_id, 'surplus');
      const v5Banked = Math.max(0, Math.trunc(u.v5_banked_balance || 0));
      const v5Available = Math.max(0, v5Banked - heldPersonalNcp);

      const virtualAnlasBalance = isAnlasUnlimited
        ? null
        : (balanceInfo ? balanceInfo.virtual_balance : Math.trunc(u.virtual_anlas_balance || 0));
      const availableAnlasBalance = isAnlasUnlimited
        ? null
        : (balanceInfo ? balanceInfo.available_balance : ((virtualAnlasBalance || 0) - heldAnlas));
      const isInDebt = isAnlasUnlimited
        ? false
        : (balanceInfo ? balanceInfo.is_in_debt : ((virtualAnlasBalance || 0) < 0));

      const pRow = periodMap.get(u.user_id);
      const matchesSelectedEpoch = cycleFilter.isActiveCycle && (
        cycleFilter.cycleEpoch === 0 ||
        u.subscription_period_start_epoch === cycleFilter.cycleEpoch
      );
      const userPeriodAnlas = matchesSelectedEpoch ? (u.subscription_period_anlas || 0) : 0;
      const userPeriodV5 = matchesSelectedEpoch ? (u.subscription_period_v5 || 0) : 0;

      const pV5High = pRow ? (pRow.v5_high_gens || 0) : 0;
      const pV5Med = pRow ? (pRow.v5_medium_gens || 0) : 0;
      const pLegacy = pRow ? (pRow.legacy_image_gens || 0) : 0;
      const pVibe = pRow ? (pRow.vibe_encodes || 0) : 0;
      const pUpscale = pRow ? (pRow.upscale_gens || 0) : 0;
      const pText = pRow ? (pRow.text_gens || 0) : 0;

      const periodAnlas = pRow
        ? Math.max(pRow.anlas_consumed || 0, userPeriodAnlas)
        : userPeriodAnlas;
      const periodV5 = pRow
        ? Math.max(pV5High + pV5Med, userPeriodV5)
        : userPeriodV5;
      const periodRequests = periodV5 + pLegacy + pVibe + pUpscale + pText;

      groups[u.user_id] = {
        user_id: u.user_id,
        discord_id: isLinked ? u.user_id : null,
        discord_username: u.discord_username || (isLinked ? `User (${u.user_id.substring(0, 6)})` : "Unlinked Device"),
        priority_tier: u.priority_tier,
        approved: 0,
        banned: u.banned,
        anlas_consumed: u.anlas_consumed,
        virtual_anlas_balance: virtualAnlasBalance,
        available_anlas_balance: availableAnlasBalance,
        held_anlas: heldAnlas,
        anlas_unlimited: isAnlasUnlimited,
        is_in_debt: isInDebt,
        last_anlas_reset_epoch: u.last_anlas_reset_epoch ?? null,
        v5_banked_balance: v5Banked,
        v5_available_balance: v5Available,
        v5_held_ncp: heldPersonalNcp + heldSurplusNcp,
        v5_held_personal_ncp: heldPersonalNcp,
        v5_held_surplus_ncp: heldSurplusNcp,
        v5_daily_consumed: u.v5_daily_consumed || 0,
        v5_last_accrual_epoch: u.v5_last_accrual_epoch ?? null,
        subscription_period_anlas: periodAnlas,
        subscription_period_v5: periodV5,
        subscription_period_v5_high: pV5High,
        subscription_period_v5_medium: pV5Med,
        subscription_period_legacy_images: pLegacy,
        subscription_period_vibes: pVibe,
        subscription_period_upscales: pUpscale,
        subscription_period_text_gens: pText,
        subscription_period_requests: periodRequests,
        subscription_period_start_epoch: u.subscription_period_start_epoch ?? null,
        total_requests: 0,
        last_active_at: 0,
        is_online: false,
        has_debug_intent: false,
        has_debug_authorized: false,
        metered_allowance: meteredAllowance,
        devices: []
      };
    }

    for (const d of devices) {
      if (!groups[d.user_id]) continue;

      const lastActive = queueManager.getLastActive(d.browser_id) || d.last_active_at || 0;
      const isOnline = queueManager.isDeviceOnline(d.browser_id);
      const debugInfo = queueManager.getDebugTargetInfo(d.browser_id);

      groups[d.user_id].devices.push({
        browser_id: d.browser_id,
        label: d.label,
        approved: d.approved,
        banned: groups[d.user_id].banned,
        anlas_consumed: groups[d.user_id].anlas_consumed,
        virtual_anlas_balance: groups[d.user_id].virtual_anlas_balance,
        v5_banked_balance: groups[d.user_id].v5_banked_balance,
        total_requests: d.total_requests || 0,
        last_active_at: lastActive,
        is_online: isOnline,
        metered_allowance: groups[d.user_id].metered_allowance,
        debug_intent: debugInfo.has_intent,
        debug_authorized: debugInfo.is_authorized,
        debug_expires_in_ms: debugInfo.expires_in_ms
      });

      groups[d.user_id].total_requests += (d.total_requests || 0);
      if (d.approved === 1) groups[d.user_id].approved = 1;
      if (lastActive > groups[d.user_id].last_active_at) {
        groups[d.user_id].last_active_at = lastActive;
      }
      if (isOnline) groups[d.user_id].is_online = true;
      if (debugInfo.has_intent) groups[d.user_id].has_debug_intent = true;
      if (debugInfo.is_authorized) groups[d.user_id].has_debug_authorized = true;
    }

    res.json(Object.values(groups));
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.get('/user-devices', async (req, res) => {
  const { discord_id } = req.query;
  if (typeof discord_id !== 'string' || discord_id.trim().length === 0) {
    return res.status(400).json({ error: "Missing discord_id parameter" });
  }
  try {
    const devices = await all(
      `SELECT d.browser_id, d.label, d.approved, u.banned, u.priority_tier, u.anlas_consumed,
              u.virtual_anlas_balance, u.v5_banked_balance, u.v5_daily_consumed,
              u.subscription_period_anlas, u.subscription_period_v5,
              d.total_requests, d.last_active_at 
       FROM devices d 
       JOIN users u ON d.user_id = u.user_id 
       WHERE d.user_id = ?`, 
      [discord_id]
    );
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/unnotified-bans', async (req, res) => {
  try {
    const bans = await all('SELECT user_id AS discord_id, ban_reason AS reason FROM users WHERE banned = 1 AND ban_notified = 0');
    res.json(bans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mark-ban-notified', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { discord_id } = body;
  if (typeof discord_id !== 'string' || discord_id.trim().length === 0) {
    return res.status(400).json({ error: "Missing discord_id parameter" });
  }
  try {
    await run('UPDATE users SET ban_notified = 1 WHERE user_id = ?', [discord_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/approve', async (req, res) => {
  const config = getConfig();
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id, discord_id, user_id, priority_tier } = body;
  if (!isOptionalNonEmptyString(user_id) || !isOptionalNonEmptyString(discord_id) || !isOptionalNonEmptyString(browser_id)) {
    return res.status(400).json({ error: 'Invalid user_id, discord_id, or browser_id parameter.' });
  }
  const targetTier = (priority_tier === undefined || priority_tier === null || priority_tier === '')
    ? 'Normal'
    : priority_tier;
  if (typeof targetTier !== 'string' || !Object.prototype.hasOwnProperty.call(config.TIER_CONFIGS, targetTier)) {
    return res.status(400).json({ error: `Invalid priority_tier "${String(targetTier)}".` });
  }

  const canonicalUserId = (user_id && user_id.trim()) || (discord_id && discord_id.trim()) || null;
  const cleanBrowserId = browser_id ? browser_id.trim() : null;
  if (!canonicalUserId && !cleanBrowserId) {
    return res.status(400).json({ error: 'Missing target identifier (user_id, discord_id, or browser_id).' });
  }
  if (
    (canonicalUserId && canonicalUserId.toLowerCase() === 'admin') ||
    (cleanBrowserId && cleanBrowserId.toLowerCase() === 'admin')
  ) {
    return res.status(400).json({ error: 'Cannot approve synthetic admin principal.' });
  }

  try {
    if (canonicalUserId) {
      await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [targetTier, canonicalUserId]);
      await run('UPDATE devices SET approved = 1 WHERE user_id = ?', [canonicalUserId]);
      console.log(`[GuildWeave Admin] Approved Canonical Account: "${canonicalUserId}". Priority: "${targetTier}"`);
    } else if (cleanBrowserId) {
      const dev = await get('SELECT user_id FROM devices WHERE browser_id = ?', [cleanBrowserId]);
      if (dev) {
        await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [targetTier, dev.user_id]);
        await run('UPDATE devices SET approved = 1 WHERE browser_id = ?', [cleanBrowserId]);
        console.log(`[GuildWeave Admin] Approved Browser: "${cleanBrowserId}" (User: "${dev.user_id}"). Priority: "${targetTier}"`);
      } else {
        await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [targetTier, cleanBrowserId]);
        await run('UPDATE devices SET approved = 1 WHERE user_id = ? OR browser_id = ?', [cleanBrowserId, cleanBrowserId]);
        console.log(`[GuildWeave Admin] Updated tier for pruned unlinked user: "${cleanBrowserId}". Priority: "${targetTier}"`);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id, discord_id, user_id } = body;
  if (!isOptionalNonEmptyString(user_id) || !isOptionalNonEmptyString(discord_id) || !isOptionalNonEmptyString(browser_id)) {
    return res.status(400).json({ error: 'Invalid user_id, discord_id, or browser_id parameter.' });
  }

  const canonicalUserId = (user_id && user_id.trim()) || (discord_id && discord_id.trim()) || null;
  const cleanBrowserId = browser_id ? browser_id.trim() : null;
  if (!canonicalUserId && !cleanBrowserId) {
    return res.status(400).json({ error: 'Missing target identifier (user_id, discord_id, or browser_id).' });
  }
  if (
    (canonicalUserId && canonicalUserId.toLowerCase() === 'admin') ||
    (cleanBrowserId && cleanBrowserId.toLowerCase() === 'admin')
  ) {
    return res.status(400).json({ error: 'Cannot revoke synthetic admin principal.' });
  }

  try {
    if (canonicalUserId) {
      await run('UPDATE devices SET approved = 0 WHERE user_id = ?', [canonicalUserId]);
      console.log(`[GuildWeave Admin] Revoked access for Canonical Account: "${canonicalUserId}"`);
    } else if (cleanBrowserId) {
      await run('UPDATE devices SET approved = 0 WHERE browser_id = ? OR user_id = ?', [cleanBrowserId, cleanBrowserId]);
      console.log(`[GuildWeave Admin] Revoked access for Unlinked Browser: "${cleanBrowserId}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ban', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { discord_id, user_id, browser_id, reason } = body;
  if (!isOptionalNonEmptyString(user_id) || !isOptionalNonEmptyString(discord_id) || !isOptionalNonEmptyString(browser_id)) {
    return res.status(400).json({ error: 'Invalid user_id, discord_id, or browser_id parameter.' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string when provided.' });
  }
  const cleanBrowserId = browser_id ? browser_id.trim() : null;
  let targetUserId = (user_id && user_id.trim()) || (discord_id && discord_id.trim()) || null;
  if (!targetUserId && !cleanBrowserId) {
    return res.status(400).json({ error: 'Missing target identifier (user_id, discord_id, or browser_id).' });
  }
  if (
    (targetUserId && targetUserId.toLowerCase() === 'admin') ||
    (cleanBrowserId && cleanBrowserId.toLowerCase() === 'admin')
  ) {
    return res.status(400).json({ error: 'Cannot ban synthetic admin principal.' });
  }

  try {
    const banReason = reason || "Banned via Admin Console";

    if (!targetUserId && cleanBrowserId) {
      const dev = await get('SELECT user_id FROM devices WHERE browser_id = ?', [cleanBrowserId]);
      if (dev) {
        targetUserId = dev.user_id;
      } else {
        const userRow = await get('SELECT user_id FROM users WHERE user_id = ?', [cleanBrowserId]);
        if (userRow) targetUserId = userRow.user_id;
      }
    }

    if (targetUserId && targetUserId.toLowerCase() === 'admin') {
      return res.status(400).json({ error: 'Cannot ban synthetic admin principal.' });
    }

    if (targetUserId) {
      await run('UPDATE users SET banned = 1, ban_reason = ?, ban_notified = 0 WHERE user_id = ?', [banReason, targetUserId]);
      await run('UPDATE devices SET banned = 1 WHERE user_id = ? OR discord_id = ? OR browser_id = ?', [targetUserId, targetUserId, cleanBrowserId]);
      console.log(`[GuildWeave Admin] Banned Canonical User: "${targetUserId}"`);
      queueManager.evict({
        user_id: targetUserId,
        discord_id: discord_id ? discord_id.trim() : (!targetUserId.startsWith('b_') ? targetUserId : null),
        browser_id: cleanBrowserId
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unban', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { discord_id, user_id, browser_id } = body;
  if (!isOptionalNonEmptyString(user_id) || !isOptionalNonEmptyString(discord_id) || !isOptionalNonEmptyString(browser_id)) {
    return res.status(400).json({ error: 'Invalid user_id, discord_id, or browser_id parameter.' });
  }

  let targetUserId = (user_id && user_id.trim()) || (discord_id && discord_id.trim()) || null;
  let linkedDiscordId = discord_id ? discord_id.trim() : null;
  const cleanBrowserId = browser_id ? browser_id.trim() : null;
  if (!targetUserId && !cleanBrowserId) {
    return res.status(400).json({ error: 'Missing target identifier (user_id, discord_id, or browser_id).' });
  }
  if (
    (targetUserId && targetUserId.toLowerCase() === 'admin') ||
    (cleanBrowserId && cleanBrowserId.toLowerCase() === 'admin')
  ) {
    return res.status(400).json({ error: 'Cannot unban synthetic admin principal.' });
  }

  try {
    if (!targetUserId && cleanBrowserId) {
      const dev = await get('SELECT user_id, discord_id FROM devices WHERE browser_id = ?', [cleanBrowserId]);
      if (dev) {
        targetUserId = dev.user_id;
        linkedDiscordId = dev.discord_id || (dev.user_id && !dev.user_id.startsWith('b_') ? dev.user_id : null);
      } else {
        const userRow = await get('SELECT user_id FROM users WHERE user_id = ?', [cleanBrowserId]);
        if (userRow) {
          targetUserId = userRow.user_id;
          linkedDiscordId = !userRow.user_id.startsWith('b_') ? userRow.user_id : null;
        }
      }
    }

    if (targetUserId) {
      await run('UPDATE users SET banned = 0, ban_reason = NULL, ban_notified = 0 WHERE user_id = ?', [targetUserId]);
      await run('UPDATE devices SET banned = 0 WHERE user_id = ? OR discord_id = ? OR browser_id = ?', [targetUserId, targetUserId, cleanBrowserId]);
      if (linkedDiscordId) {
        await run('DELETE FROM banned_discords WHERE discord_id = ?', [linkedDiscordId]);
      }
      if (!targetUserId.startsWith('b_')) {
        await run('DELETE FROM banned_discords WHERE discord_id = ?', [targetUserId]);
      }
      console.log(`[GuildWeave Admin] Unbanned Canonical User: "${targetUserId}"`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual Balance Adjustment Endpoint.
 * Atomically modifies canonical `virtual_anlas_balance` and/or `v5_banked_balance` via Level 2
 * `withUserLock` serialization while preserving all active Channel A/B reservation holds.
 */
router.post('/adjust-balance', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  const target = await resolveTargetUserId(body);
  if (!target.ok) {
    return res.status(target.status).json({ error: target.error });
  }

  const {
    anlas_delta,
    virtual_anlas_balance,
    v5_ncp_delta,
    v5_banked_balance,
    reason
  } = body;

  const hasAnlasDelta = anlas_delta !== undefined;
  const hasAnlasSet = virtual_anlas_balance !== undefined;
  const hasV5Delta = v5_ncp_delta !== undefined;
  const hasV5Set = v5_banked_balance !== undefined;

  if (hasAnlasDelta && hasAnlasSet) {
    return res.status(400).json({ error: 'Cannot specify both anlas_delta and virtual_anlas_balance.' });
  }
  if (hasV5Delta && hasV5Set) {
    return res.status(400).json({ error: 'Cannot specify both v5_ncp_delta and v5_banked_balance.' });
  }
  if (!hasAnlasDelta && !hasAnlasSet && !hasV5Delta && !hasV5Set) {
    return res.status(400).json({ error: 'At least one adjustment (anlas_delta, virtual_anlas_balance, v5_ncp_delta, or v5_banked_balance) is required.' });
  }

  const isSafeInt = (v) => typeof v === 'number' && Number.isInteger(v) && Number.isSafeInteger(v);
  if (hasAnlasDelta && !isSafeInt(anlas_delta)) {
    return res.status(400).json({ error: 'anlas_delta must be a safe integer.' });
  }
  if (hasAnlasSet && !isSafeInt(virtual_anlas_balance)) {
    return res.status(400).json({ error: 'virtual_anlas_balance must be a safe integer.' });
  }
  if (hasV5Delta && !isSafeInt(v5_ncp_delta)) {
    return res.status(400).json({ error: 'v5_ncp_delta must be a safe integer.' });
  }
  if (hasV5Set && (!isSafeInt(v5_banked_balance) || v5_banked_balance < 0)) {
    return res.status(400).json({ error: 'v5_banked_balance must be a non-negative safe integer.' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string when provided.' });
  }

  try {
    const adjustment = await auditEngine.adjustUserBalances(target.userId, {
      ...(hasAnlasDelta ? { anlasDelta: anlas_delta } : {}),
      ...(hasAnlasSet ? { virtualAnlasBalance: virtual_anlas_balance } : {}),
      ...(hasV5Delta ? { v5NcpDelta: v5_ncp_delta } : {}),
      ...(hasV5Set ? { v5BankedBalance: v5_banked_balance } : {})
    });

    if (!adjustment) {
      return res.status(404).json({ error: 'Canonical user record not found.' });
    }

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[adjustment.priority_tier] || config.TIER_CONFIGS['Normal'];
    const isAnlasUnlimited = tierConfig.monthlyAnlas === Infinity;

    const heldAnlas = queueManager.getHeldAnlasForUser(target.userId);
    const balanceInfo = await auditEngine.calculateAvailableBalance(target.userId, heldAnlas);
    const heldPersonalNcp = queueManager.getHeldNcpForUser(target.userId, 'personal');
    const v5Available = Math.max(0, adjustment.v5_banked_balance - heldPersonalNcp);

    console.log(
      `[GuildWeave Admin] Adjusted balances for "${target.userId}"` +
      ` (Anlas: ${adjustment.previous_anlas_balance} -> ${adjustment.virtual_anlas_balance},` +
      ` V5 NCP: ${adjustment.previous_v5_balance} -> ${adjustment.v5_banked_balance})` +
      (reason ? ` | Reason: ${reason}` : '')
    );

    res.json({
      success: true,
      user_id: target.userId,
      previous_anlas_balance: isAnlasUnlimited ? null : adjustment.previous_anlas_balance,
      virtual_anlas_balance: isAnlasUnlimited ? null : (balanceInfo ? balanceInfo.virtual_balance : adjustment.virtual_anlas_balance),
      available_anlas_balance: isAnlasUnlimited ? null : (balanceInfo ? balanceInfo.available_balance : (adjustment.virtual_anlas_balance - heldAnlas)),
      held_anlas: heldAnlas,
      anlas_unlimited: isAnlasUnlimited,
      is_in_debt: isAnlasUnlimited ? false : (balanceInfo ? balanceInfo.is_in_debt : adjustment.is_in_debt),
      previous_v5_balance: adjustment.previous_v5_balance,
      v5_banked_balance: adjustment.v5_banked_balance,
      v5_available_balance: v5Available,
      v5_held_personal_ncp: heldPersonalNcp
    });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('[Audit Error]')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * Debt Reconciliation Endpoint.
 * Forgives negative Anlas overdraft debt to 0 (default) or credits a positive payment
 * toward the negative balance while never altering positive non-debt balances.
 */
router.post('/reconcile-debt', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  const target = await resolveTargetUserId(body);
  if (!target.ok) {
    return res.status(target.status).json({ error: target.error });
  }

  const { credit_amount = null, cap_at_zero = false, reason } = body;

  if (credit_amount !== null && credit_amount !== undefined) {
    if (typeof credit_amount !== 'number' || !Number.isInteger(credit_amount) || credit_amount <= 0 || !Number.isSafeInteger(credit_amount)) {
      return res.status(400).json({ error: 'credit_amount must be a positive safe integer or null.' });
    }
  }
  if (typeof cap_at_zero !== 'boolean') {
    return res.status(400).json({ error: 'cap_at_zero must be a boolean.' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string when provided.' });
  }

  try {
    const result = await auditEngine.reconcileUserDebt(target.userId, {
      creditAmount: credit_amount ?? null,
      capAtZero: cap_at_zero
    });

    if (!result) {
      return res.status(404).json({ error: 'Canonical user record not found.' });
    }

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[result.priority_tier] || config.TIER_CONFIGS['Normal'];
    const isAnlasUnlimited = tierConfig.monthlyAnlas === Infinity;

    const heldAnlas = queueManager.getHeldAnlasForUser(target.userId);
    const balanceInfo = await auditEngine.calculateAvailableBalance(target.userId, heldAnlas);

    if (result.reconciled) {
      console.log(
        `[GuildWeave Admin] Reconciled debt for "${target.userId}": ${result.previous_balance} -> ${result.virtual_balance}` +
        (reason ? ` | Reason: ${reason}` : '')
      );
    }

    res.json({
      success: true,
      user_id: target.userId,
      reconciled: result.reconciled,
      was_in_debt: result.was_in_debt,
      previous_balance: isAnlasUnlimited ? null : result.previous_balance,
      virtual_anlas_balance: isAnlasUnlimited ? null : (balanceInfo ? balanceInfo.virtual_balance : result.virtual_balance),
      available_anlas_balance: isAnlasUnlimited ? null : (balanceInfo ? balanceInfo.available_balance : (result.virtual_balance - heldAnlas)),
      held_anlas: heldAnlas,
      anlas_unlimited: isAnlasUnlimited,
      is_in_debt: isAnlasUnlimited ? false : (balanceInfo ? balanceInfo.is_in_debt : result.is_in_debt)
    });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('[Audit Error]')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/prune-device', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id } = body;
  if (typeof browser_id !== 'string' || browser_id.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or invalid browser_id parameter.' });
  }
  try {
    await run('DELETE FROM devices WHERE browser_id = ?', [browser_id]);
    console.log(`[GuildWeave Admin] Pruned individual browser registration: "${browser_id}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/update-token', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
  const rawMasterToken = body ? body.master_token : undefined;
  if (typeof rawMasterToken !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid master_token string.' });
  }
  const masterToken = rawMasterToken.trim().replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (masterToken.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid master_token string.' });
  }
  try {
    await run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['master_token', masterToken]);
    console.log('[GuildWeave Admin] Pushed fresh master Opus session token to configuration schema.');

    // Immediately re-sync master subscription telemetry so non-Opus/401 lockouts clear without restarting PM2
    if (req.telemetry && typeof req.telemetry.refresh === 'function') {
      try {
        await req.telemetry.refresh();
      } catch (syncErr) {
        console.warn('[GuildWeave Admin] Token saved, but immediate telemetry refresh failed:', syncErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/link', async (req, res) => {
  const config = getConfig();
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id, discord_id, discord_username, priority_tier } = body;
  if (typeof browser_id !== 'string' || !browser_id.trim() || typeof discord_id !== 'string' || !discord_id.trim() || !priority_tier) {
    return res.status(400).json({ error: "Missing required linking parameters." });
  }
  if (typeof priority_tier !== 'string' || !Object.prototype.hasOwnProperty.call(config.TIER_CONFIGS, priority_tier)) {
    return res.status(400).json({ error: `Invalid priority_tier "${String(priority_tier)}".` });
  }
  if (discord_username !== undefined && discord_username !== null && typeof discord_username !== 'string') {
    return res.status(400).json({ error: 'Invalid discord_username parameter.' });
  }

  try {
    // 1. Assert user ban state
    const existingUser = await get('SELECT banned FROM users WHERE user_id = ?', [discord_id]);
    if (existingUser && existingUser.banned === 1) {
      return res.status(403).json({ error: "This Discord account is permanently blacklisted." });
    }

    // 2. Assert device exists
    const device = await get('SELECT browser_id, user_id FROM devices WHERE browser_id = ?', [browser_id]);
    if (!device) return res.status(404).json({ error: "Device ID not recognized. Open NovelAI to register the client." });

    // 3. Guarantee canonical Discord user record exists
    await run(
      `INSERT INTO users (user_id, priority_tier, banned, discord_username, metered_allowance, last_allowance_update_at)
       VALUES (?, ?, 0, ?, 100, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         priority_tier = excluded.priority_tier,
         discord_username = COALESCE(excluded.discord_username, users.discord_username)`,
      [discord_id, priority_tier, discord_username || null, Date.now()]
    );

    // 4. Enforce MAX_LINKED_DEVICES_PER_USER
    const existingLinks = await all('SELECT browser_id FROM devices WHERE user_id = ? AND approved = 1 ORDER BY ROWID ASC', [discord_id]);
    if (existingLinks.length >= config.MAX_LINKED_DEVICES_PER_USER) {
      const oldestDevice = existingLinks[0].browser_id;
      await run('UPDATE devices SET approved = 0 WHERE browser_id = ?', [oldestDevice]);
      console.log(`[GuildWeave Admin API] Automatically de-authorized oldest linked browser ID: ${oldestDevice} for user ${discord_id}`);
    }

    // 5. Transfer hardware device pointer to canonical Discord user_id
    await run('UPDATE devices SET user_id = ?, approved = 1 WHERE browser_id = ?', [discord_id, browser_id]);
    
    // Clean up abandoned unlinked user record if it exists
    if (device.user_id && device.user_id !== discord_id && device.user_id.startsWith('b_')) {
      await run('DELETE FROM users WHERE user_id = ?', [device.user_id]);
    }

    console.log(`[GuildWeave Admin API] Linked Discord ID ${discord_id} to browser ${browser_id} (${priority_tier})`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sync-usernames', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { mappings } = body;
  if (!mappings || !Array.isArray(mappings)) {
    return res.status(400).json({ error: "Missing or invalid mappings payload array." });
  }
  for (const m of mappings) {
    if (
      !m || typeof m !== 'object' || Array.isArray(m) ||
      typeof m.discord_id !== 'string' || m.discord_id.trim().length === 0 ||
      typeof m.discord_username !== 'string'
    ) {
      return res.status(400).json({ error: "Each mapping entry must contain string discord_id and discord_username." });
    }
  }

  try {
    for (const m of mappings) {
      await run('UPDATE users SET discord_username = ? WHERE user_id = ?', [m.discord_username, m.discord_id]);
    }
    console.log(`[GuildWeave Admin] Successfully batch synced usernames for ${mappings.length} Discord accounts.`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [GuildWeave Admin] CRITICAL USERNAME SYNC FAILURE:\n', err);
    res.status(500).json({ error: `GUILDWEAVE_SQLITE_EXEC_ERROR: ${err.message}` });
  }
});

router.post('/sync-tier', async (req, res) => {
  const config = getConfig();
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { discord_id, priority_tier } = body;
  if (typeof discord_id !== 'string' || !discord_id.trim() || !priority_tier) {
    return res.status(400).json({ error: "Missing sync parameters." });
  }
  if (typeof priority_tier !== 'string' || !Object.prototype.hasOwnProperty.call(config.TIER_CONFIGS, priority_tier)) {
    return res.status(400).json({ error: `Invalid priority_tier "${String(priority_tier)}".` });
  }

  try {
    const user = await get('SELECT banned FROM users WHERE user_id = ?', [discord_id]);
    if (user && user.banned === 1) return res.status(403).json({ error: "This Discord account is blacklisted." });

    await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [priority_tier, discord_id]);
    console.log(`[GuildWeave Admin API] Updated tier for canonical user ${discord_id} to ${priority_tier}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke-discord', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { discord_id } = body;
  if (typeof discord_id !== 'string' || discord_id.trim().length === 0) {
    return res.status(400).json({ error: "Missing discord_id parameter." });
  }

  try {
    await run('UPDATE devices SET approved = 0 WHERE user_id = ?', [discord_id]);
    console.log(`[GuildWeave Admin API] Deauthorized all devices registered to Discord ID ${discord_id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/global-stats', async (req, res) => {
  const config = getConfig();
  const cycleFilter = parseCycleFilterParam(req.query?.cycle_epoch, req.telemetry?.activeCycleEpoch ?? null);
  if (!cycleFilter.ok) {
    return res.status(400).json({ error: cycleFilter.error });
  }

  try {
    const devicesCount = await get('SELECT COUNT(*) as count FROM devices');
    const linkedUsersCount = await get("SELECT COUNT(*) as count FROM users WHERE user_id NOT LIKE 'b_%'");
    const totalAnlas = await get('SELECT SUM(anlas_consumed) as sum FROM users');
    const totalRequests = await get('SELECT SUM(total_requests) as sum FROM devices');

    const allUsers = await all('SELECT user_id, discord_username, anlas_consumed, subscription_period_anlas, subscription_period_v5, subscription_period_start_epoch FROM users');
    const userNameMap = new Map(allUsers.map(u => [u.user_id, u.discord_username]));

    let periodAggregates = {
      period_anlas: 0,
      period_v5: 0,
      period_v5_high: 0,
      period_v5_medium: 0,
      period_legacy_images: 0,
      period_vibes: 0,
      period_upscales: 0,
      period_text_gens: 0
    };
    let topAnlas = [];
    let topRequests = [];

    if (cycleFilter.mode === 'all') {
      const archiveTotals = await get(
        `SELECT SUM(anlas_consumed) as anlas,
                SUM(v5_high_gens) as v5_high,
                SUM(v5_medium_gens) as v5_med,
                SUM(legacy_image_gens) as legacy_img,
                SUM(vibe_encodes) as vibes,
                SUM(upscale_gens) as upscales,
                SUM(text_gens) as text_gens
         FROM period_usage`
      );
      periodAggregates = {
        period_anlas: archiveTotals?.anlas ?? totalAnlas.sum ?? 0,
        period_v5: (archiveTotals?.v5_high || 0) + (archiveTotals?.v5_med || 0),
        period_v5_high: archiveTotals?.v5_high || 0,
        period_v5_medium: archiveTotals?.v5_med || 0,
        period_legacy_images: archiveTotals?.legacy_img || 0,
        period_vibes: archiveTotals?.vibes || 0,
        period_upscales: archiveTotals?.upscales || 0,
        period_text_gens: archiveTotals?.text_gens || 0
      };
      topAnlas = await all("SELECT user_id as discord_id, discord_username, anlas_consumed as anlas FROM users WHERE user_id NOT LIKE 'b_%' ORDER BY anlas DESC LIMIT 5");
      topRequests = await all("SELECT d.user_id as discord_id, u.discord_username, SUM(d.total_requests) as reqs FROM devices d JOIN users u ON d.user_id = u.user_id WHERE d.user_id NOT LIKE 'b_%' GROUP BY d.user_id ORDER BY reqs DESC LIMIT 5");
    } else {
      const periodRows = await all(
        `SELECT user_id, anlas_consumed, v5_high_gens, v5_medium_gens,
                legacy_image_gens, vibe_encodes, upscale_gens, text_gens
         FROM period_usage
         WHERE cycle_epoch = ?`,
        [cycleFilter.cycleEpoch]
      );
      const periodMap = new Map(periodRows.map(r => [r.user_id, r]));

      // Merge strictly active-epoch SQL rows when period_usage does not yet carry them
      // (preserves Commit 9 SQL-seeded invariants while excluding inactive stale Cycle 1 balances).
      const mergedEntries = [];
      const seen = new Set();

      for (const u of allUsers) {
        const pRow = periodMap.get(u.user_id);
        const matchesCycle = cycleFilter.isActiveCycle && (
          cycleFilter.cycleEpoch === 0 ||
          u.subscription_period_start_epoch === cycleFilter.cycleEpoch
        );
        const uAnlas = matchesCycle ? (u.subscription_period_anlas || 0) : 0;
        const uV5 = matchesCycle ? (u.subscription_period_v5 || 0) : 0;

        const v5High = pRow ? (pRow.v5_high_gens || 0) : 0;
        const v5Med = pRow ? (pRow.v5_medium_gens || 0) : 0;
        const legacyImg = pRow ? (pRow.legacy_image_gens || 0) : 0;
        const vibes = pRow ? (pRow.vibe_encodes || 0) : 0;
        const upscales = pRow ? (pRow.upscale_gens || 0) : 0;
        const textGens = pRow ? (pRow.text_gens || 0) : 0;

        const effAnlas = pRow ? Math.max(pRow.anlas_consumed || 0, uAnlas) : uAnlas;
        const effV5 = pRow ? Math.max(v5High + v5Med, uV5) : uV5;
        const effReqs = effV5 + legacyImg + vibes + upscales + textGens;

        periodAggregates.period_anlas += effAnlas;
        periodAggregates.period_v5 += effV5;
        periodAggregates.period_v5_high += v5High;
        periodAggregates.period_v5_medium += v5Med;
        periodAggregates.period_legacy_images += legacyImg;
        periodAggregates.period_vibes += vibes;
        periodAggregates.period_upscales += upscales;
        periodAggregates.period_text_gens += textGens;

        seen.add(u.user_id);
        if (!u.user_id.startsWith('b_') && (effAnlas > 0 || effReqs > 0)) {
          mergedEntries.push({
            discord_id: u.user_id,
            discord_username: u.discord_username,
            anlas: effAnlas,
            reqs: effReqs
          });
        }
      }

      for (const [uid, pRow] of periodMap.entries()) {
        if (seen.has(uid)) continue;
        const v5Count = (pRow.v5_high_gens || 0) + (pRow.v5_medium_gens || 0);
        const reqCount = v5Count + (pRow.legacy_image_gens || 0) + (pRow.vibe_encodes || 0) + (pRow.upscale_gens || 0) + (pRow.text_gens || 0);

        periodAggregates.period_anlas += (pRow.anlas_consumed || 0);
        periodAggregates.period_v5 += v5Count;
        periodAggregates.period_v5_high += (pRow.v5_high_gens || 0);
        periodAggregates.period_v5_medium += (pRow.v5_medium_gens || 0);
        periodAggregates.period_legacy_images += (pRow.legacy_image_gens || 0);
        periodAggregates.period_vibes += (pRow.vibe_encodes || 0);
        periodAggregates.period_upscales += (pRow.upscale_gens || 0);
        periodAggregates.period_text_gens += (pRow.text_gens || 0);

        if (!uid.startsWith('b_')) {
          mergedEntries.push({
            discord_id: uid,
            discord_username: userNameMap.get(uid) || (uid === 'admin' ? 'Administrator' : uid),
            anlas: pRow.anlas_consumed || 0,
            reqs: reqCount
          });
        }
      }

      topAnlas = mergedEntries
        .filter(e => e.anlas > 0)
        .sort((a, b) => b.anlas - a.anlas)
        .slice(0, 5)
        .map(({ discord_id, discord_username, anlas }) => ({ discord_id, discord_username, anlas }));

      topRequests = mergedEntries
        .filter(e => e.reqs > 0)
        .sort((a, b) => b.reqs - a.reqs)
        .slice(0, 5)
        .map(({ discord_id, discord_username, reqs }) => ({ discord_id, discord_username, reqs }));
    }

    const bannedCount = await get('SELECT COUNT(*) as count FROM users WHERE banned = 1');
    const bannedList = await all('SELECT user_id as discord_id, ban_reason as reason FROM users WHERE banned = 1');

    const ledgerAggregates = await get(
      `SELECT
         SUM(CASE WHEN virtual_anlas_balance > 0 THEN virtual_anlas_balance ELSE 0 END) as positive_virtual_anlas,
         SUM(CASE WHEN virtual_anlas_balance < 0 THEN virtual_anlas_balance ELSE 0 END) as total_anlas_debt,
         SUM(v5_banked_balance) as total_v5_banked,
         SUM(CASE WHEN virtual_anlas_balance < 0 THEN 1 ELSE 0 END) as in_debt_count
       FROM users`
    );

    const surplusState = queueManager.getSurplusPool();
    const surplusHeld = queueManager.getHeldSurplusNcp();
    const surplusAvailable = queueManager.getAvailableSurplusNcp();

    const telemetrySnap = (req.telemetry && typeof req.telemetry.getProjectionSnapshot === 'function')
      ? req.telemetry.getProjectionSnapshot(Date.now())
      : {
        percent: req.telemetry?.percent ?? 100,
        rawProjected: req.telemetry?.rawPercent ?? (req.telemetry?.percent ?? 100),
        isNegative: req.telemetry?.isNegative ?? false,
        lastFetched: req.telemetry?.lastFetched ?? 0,
        isHardLocked: req.telemetry?.isHardLocked ?? false,
        masterTokenExpired: req.telemetry?.masterTokenExpired ?? false,
        nominalDailyCompute: req.telemetry?.nominalDailyCompute ?? config.NOMINAL_DAILY_V5_COMPUTE,
        timeUntilNextPercent: req.telemetry?.timeUntilNextPercent ?? null,
        activePeriodSeconds: req.telemetry?.activePeriodSeconds ?? ((86400 * 17.28) / config.NOMINAL_DAILY_V5_COMPUTE),
        subscriptionActive: req.telemetry?.subscriptionActive ?? true,
        isGracePeriod: req.telemetry?.isGracePeriod ?? false,
        masterExpiresAt: req.telemetry?.masterExpiresAt ?? null,
        activeCycleEpoch: req.telemetry?.activeCycleEpoch ?? null,
        masterAnlas: req.telemetry?.masterAnlas ?? null
      };

    const isColdOrExpired = telemetrySnap.lastFetched === 0;

    res.json({
      selected_cycle_epoch: cycleFilter.mode === 'all' ? 'all' : cycleFilter.cycleEpoch,
      total_devices: devicesCount.count,
      linked_users: linkedUsersCount.count,
      total_anlas_consumed: totalAnlas.sum || 0,
      total_requests: totalRequests.sum || 0,
      top_anlas_consumers: topAnlas,
      top_request_makers: topRequests,
      banned_count: bannedCount.count,
      banned_list: bannedList,
      total_subscription_period_anlas: periodAggregates.period_anlas,
      total_subscription_period_v5: periodAggregates.period_v5,
      total_subscription_period_v5_high: periodAggregates.period_v5_high,
      total_subscription_period_v5_medium: periodAggregates.period_v5_medium,
      total_subscription_period_legacy_images: periodAggregates.period_legacy_images,
      total_subscription_period_vibes: periodAggregates.period_vibes,
      total_subscription_period_upscales: periodAggregates.period_upscales,
      total_subscription_period_text_gens: periodAggregates.period_text_gens,
      total_virtual_anlas_balance: ledgerAggregates?.positive_virtual_anlas || 0,
      total_anlas_debt: ledgerAggregates?.total_anlas_debt || 0,
      total_v5_banked_balance: ledgerAggregates?.total_v5_banked || 0,
      in_debt_users_count: ledgerAggregates?.in_debt_count || 0,
      v5_surplus_pool: surplusState.pool,
      v5_surplus_held: surplusHeld,
      v5_surplus_available: surplusAvailable,
      v5_surplus_last_accrual: surplusState.lastAccrual,
      telemetry: {
        master_v5_percent: isColdOrExpired ? null : telemetrySnap.percent,
        master_v5_raw_percent: isColdOrExpired ? null : telemetrySnap.rawProjected,
        master_v5_is_negative: isColdOrExpired ? false : telemetrySnap.isNegative,
        is_hard_locked: telemetrySnap.isHardLocked,
        master_token_expired: Boolean(telemetrySnap.masterTokenExpired),
        time_until_next_percent: isColdOrExpired ? null : telemetrySnap.timeUntilNextPercent,
        active_period_seconds: telemetrySnap.activePeriodSeconds,
        nominal_daily_compute: telemetrySnap.nominalDailyCompute,
        last_fetched_at: telemetrySnap.lastFetched,
        subscription_active: telemetrySnap.masterTokenExpired ? false : (isColdOrExpired ? null : telemetrySnap.subscriptionActive),
        is_grace_period: isColdOrExpired ? false : telemetrySnap.isGracePeriod,
        master_expires_at: telemetrySnap.masterExpiresAt,
        active_cycle_epoch: telemetrySnap.activeCycleEpoch,
        master_anlas: telemetrySnap.masterAnlas
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Ephemeral Diagnostic Inspection Authorization Endpoints.
 * Enables the administrator to arm or disarm an ephemeral capture window (default: 10 minutes).
 */
router.post('/debug-target', (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { browser_id, enable, ttl_ms } = body;
  if (!browser_id || typeof browser_id !== 'string' || browser_id.trim().length === 0) {
    return res.status(400).json({ error: "Missing or invalid 'browser_id' string parameter." });
  }

  if (enable) {
    const duration = (typeof ttl_ms === 'number' && Number.isFinite(ttl_ms) && ttl_ms > 0) ? ttl_ms : 600000;
    queueManager.setDebugTarget(browser_id, duration);
    console.log(`[GuildWeave Admin Telemetry] Armed temporary diagnostic debug logging for browser: "${browser_id}" (TTL: ${duration}ms)`);
  } else {
    queueManager.removeDebugTarget(browser_id);
    console.log(`[GuildWeave Admin Telemetry] Disarmed diagnostic debug logging for browser: "${browser_id}"`);
  }

  const info = queueManager.getDebugTargetInfo(browser_id);

  res.json({
    success: true,
    browser_id,
    is_debug_enabled: info.is_authorized,
    expires_in_ms: info.expires_in_ms,
    has_intent: info.has_intent,
    active_debug_targets: queueManager.getDebugTargets()
  });
});

router.get('/debug-targets', (req, res) => {
  res.json(queueManager.getDebugTargets());
});

module.exports = router;