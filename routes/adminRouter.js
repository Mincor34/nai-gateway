/**
 * LEVEL 4: ADMINISTRATIVE ROUTER (routes/adminRouter.js)
 * Isolates all privileged control panel, Discord bot, and management interactions.
 * Relational Normalization: Operates on canonical users as parents and devices as children.
 */

'use strict';

const express = require('express');
const { run, get, all } = require('../database');
const queueManager = require('../queueManager');
const { getOrUpdateAllowance } = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

function getConfig() {
  return loadConfig(process.env);
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

router.get('/devices', async (req, res) => {
  const config = getConfig();
  try { 
    const users = await all('SELECT * FROM users');
    const devices = await all('SELECT * FROM devices');
    
    const groups = {};
    for (const u of users) {
      const isLinked = !u.user_id.startsWith('b_');
      let meteredAllowance = null;
      const tierConfig = config.TIER_CONFIGS[u.priority_tier];
      if (tierConfig && tierConfig.maxAllowance !== Infinity) {
        meteredAllowance = await getOrUpdateAllowance(u.user_id, u.priority_tier, false);
      }

      groups[u.user_id] = {
        discord_id: isLinked ? u.user_id : null,
        discord_username: u.discord_username || (isLinked ? `User (${u.user_id.substring(0, 6)})` : "Unlinked Device"),
        priority_tier: u.priority_tier,
        approved: 0,
        banned: u.banned,
        anlas_consumed: u.anlas_consumed,
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
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    const devices = await all(
      `SELECT d.browser_id, d.label, d.approved, u.banned, u.priority_tier, u.anlas_consumed, d.total_requests, d.last_active_at 
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
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    await run('UPDATE users SET ban_notified = 1 WHERE user_id = ?', [discord_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/approve', async (req, res) => {
  const { browser_id, discord_id, priority_tier } = req.body;
  const targetTier = priority_tier || 'Normal';
  try {
    if (discord_id) {
      await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [targetTier, discord_id]);
      await run('UPDATE devices SET approved = 1 WHERE user_id = ?', [discord_id]);
      console.log(`[VPS Telemetry Admin] Approved Discord Account: "${discord_id}". Priority: "${targetTier}"`);
    } else if (browser_id) {
      const dev = await get('SELECT user_id FROM devices WHERE browser_id = ?', [browser_id]);
      if (dev) {
        await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [targetTier, dev.user_id]);
      }
      await run('UPDATE devices SET approved = 1 WHERE browser_id = ?', [browser_id]);
      console.log(`[VPS Telemetry Admin] Approved Unlinked Browser: "${browser_id}". Priority: "${targetTier}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke', async (req, res) => {
  const { browser_id, discord_id } = req.body;
  try {
    if (discord_id) {
      await run('UPDATE devices SET approved = 0 WHERE user_id = ?', [discord_id]);
      console.log(`[VPS Telemetry Admin] Revoked access for Discord Account: "${discord_id}"`);
    } else if (browser_id) {
      await run('UPDATE devices SET approved = 0 WHERE browser_id = ?', [browser_id]);
      console.log(`[VPS Telemetry Admin] Revoked access for Unlinked Browser: "${browser_id}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ban', async (req, res) => {
  const { discord_id, browser_id, reason } = req.body;
  try {
    const banReason = reason || "Banned via Admin Console";
    let targetUserId = discord_id;

    if (!targetUserId && browser_id) {
      const dev = await get('SELECT user_id FROM devices WHERE browser_id = ?', [browser_id]);
      if (dev) targetUserId = dev.user_id;
    }

    if (targetUserId) {
      await run('UPDATE users SET banned = 1, ban_reason = ?, ban_notified = 0 WHERE user_id = ?', [banReason, targetUserId]);
      console.log(`[VPS Telemetry Admin] Banned Canonical User: "${targetUserId}"`);
      queueManager.evict({ user_id: targetUserId });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unban', async (req, res) => {
  const { discord_id, browser_id } = req.body;
  try {
    let targetUserId = discord_id;
    if (!targetUserId && browser_id) {
      const dev = await get('SELECT user_id FROM devices WHERE browser_id = ?', [browser_id]);
      if (dev) targetUserId = dev.user_id;
    }

    if (targetUserId) {
      await run('UPDATE users SET banned = 0, ban_reason = NULL, ban_notified = 0 WHERE user_id = ?', [targetUserId]);
      console.log(`[VPS Telemetry Admin] Unbanned Canonical User: "${targetUserId}"`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prune-device', async (req, res) => {
  const { browser_id } = req.body;
  try {
    await run('DELETE FROM devices WHERE browser_id = ?', [browser_id]);
    console.log(`[VPS Telemetry Admin] Pruned individual browser registration: "${browser_id}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/update-token', async (req, res) => {
  try {
    await run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['master_token', req.body.master_token]);
    console.log('[VPS Admin] Pushed fresh master Opus session token to configuration schema.');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/link', async (req, res) => {
  const config = getConfig();
  const { browser_id, discord_id, discord_username, priority_tier } = req.body;
  if (!browser_id || !discord_id || !priority_tier) return res.status(400).json({ error: "Missing required linking parameters." });

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
      console.log(`[VPS Admin API] Automatically de-authorized oldest linked browser ID: ${oldestDevice} for user ${discord_id}`);
    }

    // 5. Transfer hardware device pointer to canonical Discord user_id
    await run('UPDATE devices SET user_id = ?, approved = 1 WHERE browser_id = ?', [discord_id, browser_id]);
    
    // Clean up abandoned unlinked user record if it exists
    if (device.user_id !== discord_id && device.user_id.startsWith('b_')) {
      await run('DELETE FROM users WHERE user_id = ?', [device.user_id]);
    }

    console.log(`[VPS Admin API] Linked Discord ID ${discord_id} to browser ${browser_id} (${priority_tier})`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sync-usernames', async (req, res) => {
  const { mappings } = req.body;
  if (!mappings || !Array.isArray(mappings)) {
    return res.status(400).json({ error: "Missing or invalid mappings payload array." });
  }

  try {
    for (const m of mappings) {
      await run('UPDATE users SET discord_username = ? WHERE user_id = ?', [m.discord_username, m.discord_id]);
    }
    console.log(`[VPS Admin] Successfully batch synced usernames for ${mappings.length} Discord accounts.`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [VPS Admin] CRITICAL USERNAME SYNC FAILURE:\n', err);
    res.status(500).json({ error: `VPS_SQLITE_EXEC_ERROR: ${err.message}\nStack: ${err.stack}` });
  }
});

router.post('/sync-tier', async (req, res) => {
  const { discord_id, priority_tier } = req.body;
  if (!discord_id || !priority_tier) return res.status(400).json({ error: "Missing sync parameters." });

  try {
    const user = await get('SELECT banned FROM users WHERE user_id = ?', [discord_id]);
    if (user && user.banned === 1) return res.status(403).json({ error: "This Discord account is blacklisted." });

    await run('UPDATE users SET priority_tier = ? WHERE user_id = ?', [priority_tier, discord_id]);
    console.log(`[VPS Admin API] Updated tier for canonical user ${discord_id} to ${priority_tier}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke-discord', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter." });

  try {
    await run('UPDATE devices SET approved = 0 WHERE user_id = ?', [discord_id]);
    console.log(`[VPS Admin API] Deauthorized all devices registered to Discord ID ${discord_id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/global-stats', async (req, res) => {
  try {
    const devicesCount = await get('SELECT COUNT(*) as count FROM devices');
    const linkedUsersCount = await get("SELECT COUNT(*) as count FROM users WHERE user_id NOT LIKE 'b_%'");
    const totalAnlas = await get('SELECT SUM(anlas_consumed) as sum FROM users');
    const totalRequests = await get('SELECT SUM(total_requests) as sum FROM devices');
    
    const topAnlas = await all("SELECT user_id as discord_id, discord_username, anlas_consumed as anlas FROM users WHERE user_id NOT LIKE 'b_%' ORDER BY anlas DESC LIMIT 5");
    const topRequests = await all("SELECT d.user_id as discord_id, u.discord_username, SUM(d.total_requests) as reqs FROM devices d JOIN users u ON d.user_id = u.user_id WHERE d.user_id NOT LIKE 'b_%' GROUP BY d.user_id ORDER BY reqs DESC LIMIT 5");
    
    const bannedCount = await get('SELECT COUNT(*) as count FROM users WHERE banned = 1');
    const bannedList = await all('SELECT user_id as discord_id, ban_reason as reason FROM users WHERE banned = 1');

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

/**
 * Ephemeral Diagnostic Inspection Authorization Endpoints.
 * Enables the administrator to arm or disarm an ephemeral capture window (default: 10 minutes).
 */
router.post('/debug-target', (req, res) => {
  const { browser_id, enable, ttl_ms } = req.body;
  if (!browser_id || typeof browser_id !== 'string') {
    return res.status(400).json({ error: "Missing or invalid 'browser_id' string parameter." });
  }

  if (enable) {
    const duration = (typeof ttl_ms === 'number' && Number.isFinite(ttl_ms) && ttl_ms > 0) ? ttl_ms : 600000;
    queueManager.setDebugTarget(browser_id, duration);
    console.log(`[VPS Admin Telemetry] Armed temporary diagnostic debug logging for browser: "${browser_id}" (TTL: ${duration}ms)`);
  } else {
    queueManager.removeDebugTarget(browser_id);
    console.log(`[VPS Admin Telemetry] Disarmed diagnostic debug logging for browser: "${browser_id}"`);
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