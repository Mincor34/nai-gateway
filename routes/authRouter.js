/**
 * LEVEL 4: AUTHENTICATION ROUTER (routes/authRouter.js)
 * Manages device registration, nicknames, and client authorization queries.
 */

'use strict';

const express = require('express');
const { run, all } = require('../database');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

function getConfig() {
  return loadConfig(process.env);
}

router.post('/register', async (req, res) => {
  const { browser_id, device_secret, label } = req.body;
  if (!browser_id || !device_secret) return res.status(400).json({ error: 'Bad parameters' });
  try {
    await run(
      'INSERT OR IGNORE INTO devices (browser_id, device_secret, label, priority_tier, approved, banned, anlas_consumed, total_requests, last_active_at, metered_allowance, last_allowance_update_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 100, ?)',
      [browser_id, device_secret, label || 'Guest Instance', 'Normal', Date.now(), Date.now()]
    );
    res.json({ success: true });
  } catch (err) { 
    console.error('[VPS Telemetry] Registration exception:', err);
    res.status(500).json({ error: err.message }); 
  }
});

router.post('/update-label', async (req, res) => {
  const { browser_id, label } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!browser_id || !label) return res.status(400).json({ error: 'Missing parameters' });

  try {
    // Unapproved devices must be permitted to modify their nicknames during onboarding
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: false });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: 'Unauthorized nickname change' });
    }

    await run('UPDATE devices SET label = ? WHERE browser_id = ?', [label, browser_id]);
    console.log(`[VPS Telemetry] Device "${browser_id}" updated nickname: "${label}"`);
    res.json({ success: true });
  } catch (err) { 
    console.error('[VPS Telemetry] Update label exception:', err);
    res.status(500).json({ error: err.message }); 
  }
});

router.get('/status', async (req, res) => {
  const config = getConfig();
  const { browser_id } = req.query;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!browser_id || !device_secret) return res.status(401).json({ error: 'Unauthenticated status query' });

  queueManager.ping(browser_id);

  try {
    // Check credentials without rejecting unapproved devices since they must poll for approval
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: false });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const row = auth.device;

    let allowanceInfo = null;
    const tierConfig = config.TIER_CONFIGS[row.priority_tier];
    if (tierConfig && tierConfig.maxAllowance !== Infinity) {
      const allowance = await auditEngine.getOrUpdateAllowance(browser_id, row.priority_tier, false);
      const nextRefillAt = await auditEngine.getNextRefillTime(browser_id, row.priority_tier);
      allowanceInfo = {
        allowance,
        max: tierConfig.maxAllowance,
        next_refill_in: nextRefillAt ? Math.max(0, nextRefillAt - Date.now()) : 0
      };
    }

    let linkedDevices = [];
    if (row.discord_id && row.discord_id !== 'admin') {
      const devices = await all('SELECT browser_id, label FROM devices WHERE discord_id = ? AND approved = 1', [row.discord_id]);
      linkedDevices = devices.map(d => ({ id: d.browser_id, label: d.label }));
    }

    res.json({ 
      approved: !!row.approved, 
      tier: row.priority_tier,
      anlas_consumed: row.anlas_consumed || 0,
      precise_limit: config.TIER_CONFIGS[row.priority_tier]?.preciseLimit === Infinity ? "Unlimited" : (config.TIER_CONFIGS[row.priority_tier]?.preciseLimit ?? 0),
      session: allowanceInfo,
      linked_devices: linkedDevices,
      master_v5_percent: req.telemetry?.percent ?? 100
    });
  } catch (err) { 
    console.error('[VPS Telemetry] Authentication verification query failure:', err);
    res.status(500).json({ error: err.message }); 
  }
});

module.exports = router;