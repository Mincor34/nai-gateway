/**
 * LEVEL 4: QUEUE ROUTER (routes/queueRouter.js)
 * Coordinates single-concurrency Channel A locks and FIFO queue positions.
 */

'use strict';

const express = require('express');
const queueManager = require('../queueManager');
const auditEngine = require('../auditEngine');
const { loadConfig } = require('../config');

const router = express.Router();

function getConfig() {
  return loadConfig(process.env);
}

router.post('/join', async (req, res) => {
  const config = getConfig();
  const { browser_id, tab_id, req_id } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  queueManager.ping(browser_id);

  try {
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: true });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const device = auth.device;

    const tierConfig = config.TIER_CONFIGS[device.priority_tier];
    if (tierConfig && tierConfig.maxAllowance !== Infinity) {
      const allowance = await auditEngine.getOrUpdateAllowance(browser_id, device.priority_tier, false);
      if (allowance < 1) {
        console.warn(`[VPS Session Guard] User ${browser_id} allowance depleted.`);
        return res.status(403).json({ statusCode: 403, error: 'ALLOWANCE_EXHAUSTED' });
      }
      console.log(`[VPS Session Check] Browser ${browser_id} verified with ${allowance} remaining tokens.`);
    }

    queueManager.join({
      browser_id,
      tab_id,
      req_id,
      priority_tier: device.priority_tier,
      discord_id: device.discord_id
    });

    res.json({ success: true });
  } catch (err) { 
    console.error('[VPS Telemetry] Queue join process exception:', err);
    res.status(500).json({ error: err.message }); 
  }
});

router.get('/status', async (req, res) => {
  const { req_id, browser_id } = req.query;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!req_id || !browser_id || !device_secret) {
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
  const { req_id, browser_id } = req.body;
  const authHeader = req.headers['authorization'];
  const device_secret = authHeader?.split(' ')[1];

  if (!req_id || !browser_id || !device_secret) {
    return res.status(400).json({ error: 'Missing parameters or authorization context' });
  }

  try {
    const auth = await auditEngine.verifyDevice(browser_id, device_secret, { requireApproval: true });
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    queueManager.complete(req_id, browser_id);
    console.log(`[VPS Telemetry] Received verified completion bounds. Dropping request: "${req_id}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;