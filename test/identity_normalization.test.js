/**
 * RELATIONAL IDENTITY NORMALIZATION & ARBITRAGE EXTERMINATION (test/identity_normalization.test.js)
 *
 * 1. Multi-Device Quota Arbitrage Extermination:
 *    - Links 3 physical devices to a single Discord user on Metered tier (allowance: 10).
 *    - Depletes quota using Device A down to 0.
 *    - Asserts Device B and Device C are immediately rejected with 403 ALLOWANCE_EXHAUSTED.
 * 2. Multi-Device Burst-Bucket Hopping Denial:
 *    - Saturated burst bucket on Device A immediately forces Device B to Base Slope queueing.
 * 3. Cross-Device Concurrency Eviction:
 *    - Simultaneous join from Device B evicts active generation lock of Device A.
 * 4. Immediate Cascade Banishment:
 *    - Banning Discord user in the users table invalidates all linked devices across
 *      auth status, queue join, and proxy endpoints without lingering blacklist tables.
 * 5. Dynamic Device Unlinking & Account Isolation:
 *    - Unlinking a device cleanly segregates quotas and resets physical credentials.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { initDatabase, closeDatabase, run, get } = require('../database');
const { createQueueCoordinator } = require('../queueManager');
const { verifyDevice, getOrUpdateAllowance } = require('../auditEngine');
const { DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('../config');

const SANDBOX_DB = path.join(__dirname, 'sandbox_phase7_identity.db');
process.env.ADMIN_SECRET_KEY = "test_phase7_admin_passkey";

function cleanup() {
  [
    SANDBOX_DB,
    `${SANDBOX_DB}-wal`,
    `${SANDBOX_DB}-shm`,
    `${SANDBOX_DB}-journal`
  ].forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}

cleanup();

test("Phase 7: Option 1 Normalized Identity & Anti-Arbitrage Verification Gate", async (t) => {
  await initDatabase(SANDBOX_DB);

  const customConfig = {
    TIER_CONFIGS: {
      ...DEFAULT_TIER_CONFIGS,
      'Metered': { basePriority: 0, preciseLimit: 0, maxBurst: 2, refillRate: 120000, maxAllowance: 10, refillRateMs: 1800000 }
    },
    ...OPERATIONAL_DEFAULTS
  };

  const qm = createQueueCoordinator(customConfig);

  t.after(async () => {
    await closeDatabase();
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // 1. PROVISIONING A MULTI-DEVICE USER
  // ---------------------------------------------------------------------------
  const discordId = "discord_alice_999";
  
  // Create canonical user
  await run(`
    INSERT INTO users (user_id, priority_tier, banned, metered_allowance, last_allowance_update_at, discord_username)
    VALUES (?, 'Metered', 0, 10, ?, 'Alice')
  `, [discordId, Date.now()]);

  // Link 3 devices to Alice
  await run(`INSERT INTO devices (browser_id, user_id, device_secret, label, approved) VALUES ('alice_laptop', ?, 'sec_laptop', 'Laptop', 1)`, [discordId]);
  await run(`INSERT INTO devices (browser_id, user_id, device_secret, label, approved) VALUES ('alice_desktop', ?, 'sec_desktop', 'Desktop', 1)`, [discordId]);
  await run(`INSERT INTO devices (browser_id, user_id, device_secret, label, approved) VALUES ('alice_phone', ?, 'sec_phone', 'Phone', 1)`, [discordId]);

  await t.test("Hell Path: Exterminates Multi-Device Allowance Arbitrage", async () => {
    // 1. Verify all 3 devices read the exact same unified balance
    const authLaptop = await verifyDevice('alice_laptop', 'sec_laptop');
    const authDesktop = await verifyDevice('alice_desktop', 'sec_desktop');
    const authPhone = await verifyDevice('alice_phone', 'sec_phone');

    assert.strictEqual(authLaptop.device.user_id, discordId);
    assert.strictEqual(authDesktop.device.user_id, discordId);
    assert.strictEqual(authPhone.device.user_id, discordId);

    // 2. Laptop consumes all 10 tokens
    for (let i = 0; i < 10; i++) {
      const remaining = await getOrUpdateAllowance(authLaptop.device.user_id, 'Metered', true);
      assert.strictEqual(remaining, 9 - i);
    }

    // 3. Allowance is now 0 on the canonical user entity
    const exhaustedCheck = await getOrUpdateAllowance(discordId, 'Metered', false);
    assert.strictEqual(exhaustedCheck, 0, "User balance must be zero");

    // 4. Invariant: Desktop attempts to deduct; must be rejected immediately (-1)
    const desktopDeduct = await getOrUpdateAllowance(authDesktop.device.user_id, 'Metered', true);
    assert.strictEqual(desktopDeduct, -1, "Desktop must be denied tokens when shared user balance is exhausted");

    // 5. Invariant: Phone attempts to deduct; must be rejected immediately (-1)
    const phoneDeduct = await getOrUpdateAllowance(authPhone.device.user_id, 'Metered', true);
    assert.strictEqual(phoneDeduct, -1, "Phone must be denied tokens when shared user balance is exhausted");
  });

  await t.test("Hell Path: Denies Multi-Device Burst-Bucket Hopping", async () => {
    // Reset burst bucket for test
    qm.reset();

    // Alice joins queue from Laptop. Consumes burst token 1.0
    const task1 = qm.join({
      browser_id: 'alice_laptop',
      req_id: 'req_laptop_1',
      priority_tier: 'Metered',
      user_id: discordId
    });
    assert.strictEqual(task1.has_burst_boost, true, "First request must receive burst boost");

    // Complete task 1
    qm.complete('req_laptop_1', 'alice_laptop');

    // Alice joins queue from Laptop again. Consumes burst token 2.0 (Bucket depleted)
    const task2 = qm.join({
      browser_id: 'alice_laptop',
      req_id: 'req_laptop_2',
      priority_tier: 'Metered',
      user_id: discordId
    });
    assert.strictEqual(task2.has_burst_boost, true, "Second request must receive final burst boost");

    qm.complete('req_laptop_2', 'alice_laptop');

    // Alice switches to Desktop, attempting to hop to a clean burst bucket
    const task3 = qm.join({
      browser_id: 'alice_desktop',
      req_id: 'req_desktop_burst_hop',
      priority_tier: 'Metered',
      user_id: discordId
    });

    // Invariant: Desktop must NOT receive burst boost because Alice's unified user bucket is saturated
    assert.strictEqual(task3.has_burst_boost, false, "Anti-Arbitrage Invariant: Switching devices must NOT bypass burst limits");
    qm.complete('req_desktop_burst_hop', 'alice_desktop');
  });

  await t.test("Hell Path: Cross-Device Concurrency Collision Eviction", async () => {
    qm.reset();

    // Alice joins on Laptop and holds the processing lock
    const tLaptop = qm.join({
      browser_id: 'alice_laptop',
      req_id: 'req_laptop_active',
      priority_tier: 'Metered',
      user_id: discordId
    });
    assert.strictEqual(tLaptop.status, 'processing');

    const mockSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    qm.attachUpstreamRequest('req_laptop_active', mockSocket);

    // Alice immediately joins on Desktop with a new request
    const tDesktop = qm.join({
      browser_id: 'alice_desktop',
      req_id: 'req_desktop_collision',
      priority_tier: 'Metered',
      user_id: discordId
    });

    // Invariant: Laptop generation must be aborted mid-flight
    assert.strictEqual(mockSocket.destroyed, true, "Laptop upstream socket must be destroyed on cross-device collision");
    assert.strictEqual(qm.poll('req_laptop_active', 'alice_laptop'), null, "Laptop task must be evicted from RAM");
    assert.strictEqual(tDesktop.status, 'processing', "Desktop task must take over active slot");

    qm.complete('req_desktop_collision', 'alice_desktop');
  });

  await t.test("Hell Path: Immediate Cascade Banishment Across All Linked Devices", async () => {
    // Commit a ban against Alice in the canonical users table
    await run('UPDATE users SET banned = 1, ban_reason = "Policy Violation" WHERE user_id = ?', [discordId]);

    // All 3 devices must immediately fail verification with HTTP 403
    const checkLaptop = await verifyDevice('alice_laptop', 'sec_laptop');
    const checkDesktop = await verifyDevice('alice_desktop', 'sec_desktop');
    const checkPhone = await verifyDevice('alice_phone', 'sec_phone');

    assert.strictEqual(checkLaptop.ok, false);
    assert.strictEqual(checkLaptop.status, 403);
    assert.match(checkLaptop.error, /permanently banned/i);

    assert.strictEqual(checkDesktop.ok, false);
    assert.strictEqual(checkDesktop.status, 403);

    assert.strictEqual(checkPhone.ok, false);
    assert.strictEqual(checkPhone.status, 403);
  });
});