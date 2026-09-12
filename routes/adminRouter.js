/**
 * LEVEL 4: ADMINISTRATIVE ROUTER (routes/adminRouter.js)
 * Isolates all privileged control panel, Discord bot, and management interactions.
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
    const rows = await all('SELECT * FROM devices');
    const groups = {};
    for (const row of rows) {
      const key = row.discord_id || `unlinked:${row.browser_id}`;
      const lastActive = queueManager.getLastActive(row.browser_id) || row.last_active_at || 0;
      const isOnline = queueManager.isDeviceOnline(row.browser_id);
      
      let meteredAllowance = null;
      const tierConfig = config.TIER_CONFIGS[row.priority_tier];
      if (tierConfig && tierConfig.maxAllowance !== Infinity) {
        meteredAllowance = await getOrUpdateAllowance(row.browser_id, row.priority_tier, false);
      }
      
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
        is_online: isOnline,
        metered_allowance: meteredAllowance
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

router.get('/user-devices', async (req, res) => {
  const { discord_id } = req.query;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    const devices = await all('SELECT browser_id, label, approved, banned, priority_tier, anlas_consumed, total_requests, last_active_at FROM devices WHERE discord_id = ?', [discord_id]);
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/unnotified-bans', async (req, res) => {
  try {
    const bans = await all('SELECT discord_id, reason FROM banned_discords WHERE is_notified = 0');
    res.json(bans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mark-ban-notified', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter" });
  try {
    await run('UPDATE banned_discords SET is_notified = 1 WHERE discord_id = ?', [discord_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/approve', async (req, res) => {
  const { browser_id, discord_id, priority_tier } = req.body;
  const targetTier = priority_tier || 'Normal'; // Enforce fallback to prevent SQLite NOT NULL constraints
  try {
    if (discord_id) {
      await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE discord_id = ?', [targetTier, discord_id]);
      console.log(`[VPS Telemetry Admin] Approved Discord Account: "${discord_id}". Priority: "${targetTier}"`);
    } else {
      await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE browser_id = ?', [targetTier, browser_id]);
      console.log(`[VPS Telemetry Admin] Approved Unlinked Browser: "${browser_id}". Priority: "${targetTier}"`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke', async (req, res) => {
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

router.post('/ban', async (req, res) => {
  const { discord_id, browser_id, reason } = req.body;
  try {
    const banReason = reason || "Banned via Admin Console";
    if (discord_id) {
      await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)', [
        discord_id, Date.now(), banReason
      ]);
      await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [discord_id]);
      console.log(`[VPS Telemetry Admin] Banned Discord Account: "${discord_id}"`);
      queueManager.evict({ discord_id });
    } else if (browser_id) {
      await run('UPDATE devices SET banned = 1 WHERE browser_id = ?', [browser_id]);
      console.log(`[VPS Telemetry Admin] Banned Unlinked Browser: "${browser_id}"`);
      queueManager.evict({ browser_id });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unban', async (req, res) => {
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
    const isBanned = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [discord_id]);
    if (isBanned) return res.status(403).json({ error: "This Discord account is permanently blacklisted." });

    const device = await get('SELECT 1 FROM devices WHERE browser_id = ?', [browser_id]);
    if (!device) return res.status(404).json({ error: "Device ID not recognized. Open NovelAI to register the client." });

    const existingLinks = await all('SELECT browser_id FROM devices WHERE discord_id = ? AND approved = 1 ORDER BY ROWID ASC', [discord_id]);
    if (existingLinks.length >= config.MAX_LINKED_DEVICES_PER_USER) {
      const oldestDevice = existingLinks[0].browser_id;
      await run('UPDATE devices SET approved = 0, discord_id = NULL, discord_username = NULL WHERE browser_id = ?', [oldestDevice]);
      console.log(`[VPS Admin API] Automatically pruned oldest linked browser ID: ${oldestDevice} for user ${discord_id}`);
    }

    await run('UPDATE devices SET approved = 1, banned = 0, priority_tier = ?, discord_id = ?, discord_username = ? WHERE browser_id = ?', 
      [priority_tier, discord_id, discord_username || null, browser_id]);
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
      await run('UPDATE devices SET discord_username = ? WHERE discord_id = ?', [m.discord_username, m.discord_id]);
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
    const isBanned = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [discord_id]);
    if (isBanned) return res.status(403).json({ error: "This Discord account is blacklisted." });

    await run('UPDATE devices SET approved = 1, priority_tier = ? WHERE discord_id = ?', [priority_tier, discord_id]);
    console.log(`[VPS Admin API] Updated tiers for devices mapped to Discord ID ${discord_id} to ${priority_tier}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/revoke-discord', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ error: "Missing discord_id parameter." });

  try {
    await run('UPDATE devices SET approved = 0, discord_id = NULL, discord_username = NULL WHERE discord_id = ?', [discord_id]);
    console.log(`[VPS Admin API] Deauthorized all devices registered to Discord ID ${discord_id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/global-stats', async (req, res) => {
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

module.exports = router;