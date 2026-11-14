/**
 * PHASE 8 COMMIT 3 VERIFICATION HARNESS (test/phase8_commit3_queue_holds.test.js)
 *
 * Exhaustively tests:
 * 1. Architectural Level 3 Isolation Invariant:
 *    - Evaluates queueManager.js module dependency isolation via Node's Module._load interception
 *      (zero database.js or auditEngine.js imports), restoring require.cache cleanly.
 * 2. Happy Path: Structured Channel B Text Locks & Cross-Channel Hold Aggregation:
 *    - acquireTextSlot records { timestamp, user_id, held_cost } in activeTextLocks.
 *    - getHeldAnlasForUser aggregates active holds across both Channel A tasks and Channel B text locks.
 *    - releaseTextSlot zeroes held_cost and frees the slot immediately.
 * 3. Happy Path: TTL Clock Re-Anchoring (reanchorProcessingTimestamp):
 *    - Simulates 50s client upload latency while holding Channel A processing status.
 *    - Invokes reanchorProcessingTimestamp(req_id) to reset started_processing_at.
 *    - Verifies task survives sweep() at original + 85s (only 35s post-reanchor), while un-reanchored
 *      tasks exceeding 75s are properly swept.
 *    - Rejects re-anchoring on pending, unknown, null, empty, or whitespace req_ids and sanitizes negative/NaN timestamps.
 * 4. Hell Path: Lock and Hold Leak Watchdog:
 *    - Client Abort / Completion (`complete`): Destroys socket and expunges Channel A Anlas + NCP holds.
 *    - Concurrency Collision (`join`): Destroys prior socket and expunges prior holds before registering replacement.
 *    - Admin Eviction (`evict`): Purges both Channel A tasks and Channel B text locks + holds synchronously
 *      across discord_id, user_id, unlinked browser_id Channel B locks, empty invocations, and promotes next user cleanly.
 *    - Cross-Browser Tampering Guard: Mismatched browser_id on setTaskHold / clearTaskHold returns false without mutating holds.
 *    - Scavenger Sweep Timeout (>12s poll inactivity): Drops pending task and expunges surplus/personal NCP holds.
 *    - Scavenger Sweep Timeout (>75s processing): Destroys hung Channel A socket, deletes zombie Channel B lock,
 *      and expunges all holds across both channels synchronously.
 * 5. Hell Path: Surplus Stacking Denial (Bucket 2 24h Overwrite Invariant):
 *    - Executes multiple simulated 24-hour sweeps while projected tank is at 80%.
 *    - Verifies surplus pool in RAM is overwritten to 4665 NCP rather than stacking unboundedly.
 *    - Verifies epoch 0 initialization does not double-accrue within 24 hours.
 *    - Verifies multi-day offline jumps (e.g. 72h elapsed) overwrite once without multiplying.
 *    - Verifies partial spend (deductSurplusPool) followed by 24h sweep overwrites back to 4665 NCP.
 *    - Verifies tank <= 50% clears surplus pool to 0 NCP.
 *    - Verifies getAvailableSurplusNcp accounts for active Channel A surplus holds without mutating pool.
 *    - Verifies SQLite TEXT hydration ('1200', '1762500000000') preserves 24h accrual cooldown across restarts
 *      and handles null lastAccrualEpoch.
 * 6. Hell Path: Fail-Closed Financial Validation, Poison Telemetry, Clock Sync & Hook Failures:
 *    - Rejects duplicate req_id, whitespace-only identifiers, and non-string user_id/discord_id in join(), poll(), complete(), and acquireTextSlot().
 *    - Throws explicit errors (fail-closed) on null/non-object holds, boolean, float, array, negative, NaN, Infinity, or unattributed holds.
 *    - Throws explicit errors on corrupt persisted surplus values in hydrateSurplusPool().
 *    - Rejects out-of-bounds V5_SURPLUS_THRESHOLD_PERCENT (< 0 or > 100), falling back to 50.0.
 *    - Guarantees null, empty string, booleans, arrays, NaN, Infinity, out-of-range (<0 or >100),
 *      and throwing telemetry callbacks fail closed (including explicit batteryPercent: null overrides) and do NOT overwrite or wipe the surplus pool.
 *    - Guarantees sync throws and async rejections in onSurplusAccrual do not crash sweep().
 *    - Guarantees partial/undefined config objects enforce MAX_CONCURRENT_TEXT_GENS defaults.
 *    - Guarantees forward-simulated join/poll/acquireTextSlot/sweep clocks keep buckets, pending tasks, and Channel B locks synchronized.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const { createQueueCoordinator } = require('../queueManager');
const { DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('../config');

function createTestCoordinator(overrides = {}) {
  const customConfig = {
    TIER_CONFIGS: DEFAULT_TIER_CONFIGS,
    ...OPERATIONAL_DEFAULTS,
    ...overrides
  };
  return createQueueCoordinator(customConfig);
}

function createMockUpstreamRequest() {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    }
  };
}

test("Phase 8 Commit 3: Structured Text Locks, Dynamic Holds, Re-Anchoring & Surplus Pool", async (t) => {

  // ---------------------------------------------------------------------------
  // 1. ARCHITECTURAL LEVEL 3 ISOLATION CHECK
  // ---------------------------------------------------------------------------
  await t.test("Architecture Invariant: queueManager.js imports Level 1 (config.js) only", () => {
    const qmPath = path.resolve(__dirname, '..', 'queueManager.js');
    const previousCacheEntry = require.cache[qmPath];
    const loadedDeps = [];
    const originalLoad = Module._load;

    delete require.cache[qmPath];
    Module._load = function(request, parent, isMain) {
      if (parent && parent.filename === qmPath) {
        loadedDeps.push(request);
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      require('../queueManager');
    } finally {
      Module._load = originalLoad;
      if (previousCacheEntry) {
        require.cache[qmPath] = previousCacheEntry;
      } else {
        delete require.cache[qmPath];
      }
    }

    assert.deepStrictEqual(
      loadedDeps,
      ['./config'],
      "Level 3 Isolation Invariant: queueManager.js must require './config' exclusively (zero database/auditEngine coupling)"
    );
  });

  // ---------------------------------------------------------------------------
  // 2. HAPPY PATH: STRUCTURED CHANNEL B LOCKS & CROSS-CHANNEL HOLD AGGREGATION
  // ---------------------------------------------------------------------------
  await t.test("Happy Path: Structured Channel B locks record user_id/held_cost and aggregate cross-channel holds", () => {
    const qm = createTestCoordinator();
    const userId = 'discord_alice_101';

    // 1. Acquire Channel B vibe extraction lock with 2 Anlas hold
    const acquired1 = qm.acquireTextSlot('vibe_req_1', userId, 2);
    assert.strictEqual(acquired1, true, "Must acquire Channel B slot");

    const lock1 = qm.getTextLock('vibe_req_1');
    assert.ok(lock1, "Lock record must exist");
    assert.strictEqual(lock1.user_id, userId);
    assert.strictEqual(lock1.held_cost, 2);
    assert.ok(typeof lock1.timestamp === 'number' && lock1.timestamp > 0);

    // 2. Standard 3-arg and legacy 1-arg signature compatibility
    const acquired2 = qm.acquireTextSlot('vibe_req_2', userId, 4);
    const acquired3 = qm.acquireTextSlot('text_req_3'); // legacy 1-arg call
    assert.strictEqual(acquired2, true);
    assert.strictEqual(acquired3, true);
    assert.strictEqual(qm.getActiveTextGenerations(), 3);

    // 4th slot must be denied (MAX_CONCURRENT_TEXT_GENS = 3)
    assert.strictEqual(qm.acquireTextSlot('vibe_req_4', userId, 2), false);

    // 3. Acquire Channel A task with 34 Anlas hold & 18 personal NCP hold
    const taskA = qm.join({
      browser_id: 'alice_browser',
      req_id: 'img_req_1',
      priority_tier: 'Normal',
      user_id: userId,
      held_cost: 34,
      held_ncp: 18,
      held_ncp_source: 'personal'
    });
    assert.strictEqual(taskA.held_cost, 34);
    assert.strictEqual(taskA.held_ncp, 18);
    assert.strictEqual(taskA.held_ncp_source, 'personal');

    // Cross-channel Anlas aggregation: 34 (Channel A) + 2 + 4 (Channel B) = 40
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 40, "Must aggregate holds across both Channel A and Channel B");
    assert.strictEqual(qm.getHeldNcpForUser(userId, 'personal'), 18);
    assert.strictEqual(qm.getHeldNcpForUser(userId, 'surplus'), 0);

    // 4. Release Channel B lock and verify hold drops immediately
    assert.strictEqual(qm.releaseTextSlot('vibe_req_1'), true);
    assert.strictEqual(lock1.held_cost, 0, "Released lock record must zero held_cost defensively");
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 38);

    // Clean up remaining locks
    qm.releaseTextSlot('vibe_req_2');
    qm.releaseTextSlot('text_req_3');
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 34);

    // 5. Dynamic hold mutation & clear helpers
    assert.strictEqual(qm.setTaskHold('img_req_1', 'alice_browser', { held_cost: 60 }), true);
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 60);

    assert.strictEqual(qm.clearTaskHold('img_req_1', 'alice_browser'), true);
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 0);
    assert.strictEqual(qm.getHeldNcpForUser(userId), 0);
  });

  // ---------------------------------------------------------------------------
  // 3. HAPPY PATH: TTL CLOCK RE-ANCHORING (reanchorProcessingTimestamp)
  // ---------------------------------------------------------------------------
  await t.test("Happy Path: reanchorProcessingTimestamp resets execution window post-buffering", () => {
    const qm = createTestCoordinator({
      QUEUE_POLL_TIMEOUT_MS: 12000,
      QUEUE_PROCESSING_TIMEOUT_MS: 75000
    });

    const t0 = Date.now();
    const task1 = qm.join({ browser_id: 'b1', req_id: 'r_reanchor', priority_tier: 'Normal', held_cost: 20, now: t0 });
    const task2 = qm.join({ browser_id: 'b2', req_id: 'r_pending', priority_tier: 'Normal', now: t0 });

    assert.strictEqual(task1.status, 'processing');
    assert.strictEqual(task2.status, 'pending');

    // Pending, unknown, or invalid req_id cannot be re-anchored
    assert.strictEqual(qm.reanchorProcessingTimestamp('r_pending', t0 + 50000), false);
    assert.strictEqual(qm.reanchorProcessingTimestamp('non_existent', t0 + 50000), false);
    assert.strictEqual(qm.reanchorProcessingTimestamp(null, t0 + 50000), false);
    assert.strictEqual(qm.reanchorProcessingTimestamp('', t0 + 50000), false);
    assert.strictEqual(qm.reanchorProcessingTimestamp('   ', t0 + 50000), false);
    assert.strictEqual(task2.started_processing_at, null);

    // Re-anchor task1 right as 50s upload finishes at t0 + 50,000ms
    const reanchored = qm.reanchorProcessingTimestamp('r_reanchor', t0 + 50000);
    assert.strictEqual(reanchored, true);
    assert.strictEqual(task1.started_processing_at, t0 + 50000);

    // Run sweep at t0 + 85,000ms (85s since original queue promotion, but only 35s since re-anchor)
    qm.poll('r_pending', 'b2', t0 + 84000);
    qm.sweep({ now: t0 + 85000 });

    assert.ok(qm.getProcessingTask('r_reanchor', 'b1'), "Re-anchored task must survive original 75s mark during GPU inference");

    // Negative / NaN timestamps passed to reanchor must fall back to valid epoch without corrupting clock
    const fallbackBefore = Date.now();
    assert.strictEqual(qm.reanchorProcessingTimestamp('r_reanchor', -5000), true);
    assert.ok(task1.started_processing_at >= fallbackBefore);

    // Re-anchor back to t0 + 50,000 and sweep at t0 + 126,000ms (76s post-reanchor > 75s limit) -> swept
    qm.reanchorProcessingTimestamp('r_reanchor', t0 + 50000);
    qm.poll('r_pending', 'b2', t0 + 125000);
    qm.sweep({ now: t0 + 126000 });

    assert.strictEqual(qm.getProcessingTask('r_reanchor', 'b1'), null, "Re-anchored task exceeding 75s post-reanchor must be evicted");
    assert.strictEqual(qm.getHeldAnlasForUser('b1'), 0, "Evicted task holds must be cleared");
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: LOCK AND HOLD LEAK WATCHDOG
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Lock and Hold Leak Watchdog expunges holds across aborts, collisions, evictions, and sweeps", () => {
    const qm = createTestCoordinator({
      QUEUE_POLL_TIMEOUT_MS: 12000,
      QUEUE_PROCESSING_TIMEOUT_MS: 75000
    });

    // Subtest A: Client completion/abort via complete()
    const tComplete = qm.join({
      browser_id: 'b_complete',
      req_id: 'r_complete',
      user_id: 'u_complete',
      held_cost: 34,
      held_ncp: 18,
      held_ncp_source: 'personal'
    });
    const sockComplete = createMockUpstreamRequest();
    qm.attachUpstreamRequest('r_complete', sockComplete);

    // Cross-browser authorization tampering guard on setTaskHold / clearTaskHold
    assert.strictEqual(qm.setTaskHold('r_complete', 'attacker_browser', { held_cost: 0 }), false);
    assert.strictEqual(qm.clearTaskHold('r_complete', 'attacker_browser'), false);
    assert.strictEqual(qm.clearTaskHold('r_complete', '   '), false);
    assert.strictEqual(qm.getHeldAnlasForUser('u_complete'), 34, "Cross-browser tampering must leave victim holds untouched");
    assert.strictEqual(qm.getHeldNcpForUser('u_complete'), 18);

    assert.strictEqual(qm.complete('r_complete', 'b_complete'), true);
    assert.strictEqual(sockComplete.destroyed, true);
    assert.strictEqual(tComplete.held_cost, 0);
    assert.strictEqual(tComplete.held_ncp, 0);
    assert.strictEqual(tComplete.held_ncp_source, null);
    assert.strictEqual(qm.getHeldAnlasForUser('u_complete'), 0);
    assert.strictEqual(qm.getHeldNcpForUser('u_complete'), 0);

    // Subtest B: Concurrency collision eviction inside join()
    const tFirst = qm.join({
      browser_id: 'b_collide',
      req_id: 'r_collide_1',
      user_id: 'u_collide',
      held_cost: 20,
      held_ncp: 10,
      held_ncp_source: 'surplus'
    });
    const sockCollide = createMockUpstreamRequest();
    qm.attachUpstreamRequest('r_collide_1', sockCollide);

    const tSecond = qm.join({
      browser_id: 'b_collide',
      req_id: 'r_collide_2',
      user_id: 'u_collide',
      held_cost: 5,
      held_ncp: 18,
      held_ncp_source: 'personal'
    });

    assert.strictEqual(sockCollide.destroyed, true, "Colliding task upstream socket must be destroyed");
    assert.strictEqual(tFirst.held_cost, 0, "Prior colliding task holds must be zeroed");
    assert.strictEqual(tFirst.held_ncp, 0);
    assert.strictEqual(tFirst.held_ncp_source, null);
    assert.strictEqual(qm.getHeldAnlasForUser('u_collide'), 5, "Only active replacement task hold must remain");
    assert.strictEqual(qm.getHeldSurplusNcp(), 0, "Evicted surplus hold must be cleared");
    assert.strictEqual(tSecond.status, 'processing');
    qm.complete('r_collide_2', 'b_collide');

    // Subtest C: Admin eviction purges BOTH Channel A tasks and Channel B text locks + holds
    const tBad = qm.join({
      browser_id: 'b_bad',
      req_id: 'r_bad',
      discord_id: 'discord_bad',
      user_id: 'discord_bad',
      held_cost: 60,
      held_ncp: 18,
      held_ncp_source: 'surplus'
    });
    const sockBad = createMockUpstreamRequest();
    qm.attachUpstreamRequest('r_bad', sockBad);

    const tInnocent = qm.join({
      browser_id: 'b_innocent',
      req_id: 'r_innocent',
      user_id: 'discord_innocent',
      held_cost: 12,
      held_ncp: 10,
      held_ncp_source: 'personal'
    });

    assert.strictEqual(qm.acquireTextSlot('vibe_bad_1', 'discord_bad', 2), true);
    assert.strictEqual(qm.acquireTextSlot('vibe_innocent_1', 'discord_innocent', 2), true);
    assert.strictEqual(qm.getHeldAnlasForUser('discord_bad'), 62);
    assert.strictEqual(qm.getHeldSurplusNcp(), 18);

    // Calling evict() with no arguments must safely return 0 without throwing
    assert.strictEqual(qm.evict(), 0);

    const evicted = qm.evict({ discord_id: 'discord_bad' });
    assert.strictEqual(evicted, 2, "Eviction must purge 1 Channel A task + 1 Channel B lock");
    assert.strictEqual(sockBad.destroyed, true);
    assert.strictEqual(tBad.held_cost, 0);
    assert.strictEqual(tBad.held_ncp, 0);
    assert.strictEqual(qm.getHeldAnlasForUser('discord_bad'), 0, "All Anlas holds for evicted user must be 0");
    assert.strictEqual(qm.getHeldNcpForUser('discord_bad'), 0, "All NCP holds for evicted user must be 0");
    assert.strictEqual(qm.getHeldSurplusNcp(), 0, "Surplus NCP hold for evicted user must be 0");
    assert.strictEqual(qm.getTextLock('vibe_bad_1'), null, "Channel B lock must be purged");

    // Innocent user stays intact and is promoted
    assert.strictEqual(tInnocent.status, 'processing');
    assert.strictEqual(qm.getHeldAnlasForUser('discord_innocent'), 14);
    assert.strictEqual(qm.getHeldNcpForUser('discord_innocent'), 10);

    // Direct user_id eviction across standalone Channel B lock + Channel A task
    assert.strictEqual(qm.evict({ user_id: 'discord_innocent' }), 2);
    assert.strictEqual(qm.getHeldAnlasForUser('discord_innocent'), 0);
    assert.strictEqual(qm.getHeldNcpForUser('discord_innocent'), 0);
    assert.strictEqual(qm.getTextLock('vibe_innocent_1'), null);

    // Standalone Channel B eviction by browser_id for unlinked device (user_id === browser_id)
    assert.strictEqual(qm.acquireTextSlot('vibe_unlinked_1', 'b_unlinked_solo', 2), true);
    assert.strictEqual(qm.evict({ browser_id: 'b_unlinked_solo' }), 1);
    assert.strictEqual(qm.getTextLock('vibe_unlinked_1'), null);
    assert.strictEqual(qm.getHeldAnlasForUser('b_unlinked_solo'), 0);

    // Subtest D: Scavenger GC sweep timeouts (>12s poll inactivity & >75s processing & >75s text lock)
    const now = Date.now();
    qm.join({
      browser_id: 'b_hung',
      req_id: 'r_hung',
      user_id: 'u_hung',
      held_cost: 40,
      held_ncp: 18,
      held_ncp_source: 'personal',
      now: now - 76000
    });
    const sockHung = createMockUpstreamRequest();
    qm.attachUpstreamRequest('r_hung', sockHung);

    qm.join({
      browser_id: 'b_dropped',
      req_id: 'r_dropped',
      user_id: 'u_dropped',
      held_cost: 15,
      held_ncp: 10,
      held_ncp_source: 'surplus',
      now: now - 13000
    });

    const tFreshPending = qm.join({
      browser_id: 'b_fresh',
      req_id: 'r_fresh',
      user_id: 'u_fresh',
      held_cost: 5,
      held_ncp: 18,
      held_ncp_source: 'personal',
      now: now - 1000
    });

    assert.strictEqual(qm.acquireTextSlot('vibe_zombie', 'u_zombie', 2, now - 76000), true);

    const changed = qm.sweep({ now });
    assert.strictEqual(changed, true);

    assert.strictEqual(sockHung.destroyed, true, "Hung Channel A socket must be destroyed by GC sweep");
    assert.strictEqual(qm.getHeldAnlasForUser('u_hung'), 0, "Hung processing task Anlas hold must be expunged");
    assert.strictEqual(qm.getHeldNcpForUser('u_hung'), 0, "Hung processing task NCP hold must be expunged");

    assert.strictEqual(qm.getHeldAnlasForUser('u_dropped'), 0, "Dropped pending task Anlas hold must be expunged");
    assert.strictEqual(qm.getHeldNcpForUser('u_dropped'), 0, "Dropped pending task NCP hold must be expunged");
    assert.strictEqual(qm.getHeldSurplusNcp(), 0, "Dropped pending surplus hold must be expunged");

    assert.strictEqual(qm.getTextLock('vibe_zombie'), null, "Zombie Channel B lock must be purged by GC sweep");
    assert.strictEqual(qm.getHeldAnlasForUser('u_zombie'), 0, "Zombie Channel B Anlas hold must be expunged");

    // Fresh pending task must be promoted and keep its valid holds
    assert.strictEqual(tFreshPending.status, 'processing');
    assert.strictEqual(qm.getHeldAnlasForUser('u_fresh'), 5);
    assert.strictEqual(qm.getHeldNcpForUser('u_fresh'), 18);
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: SURPLUS STACKING DENIAL (BUCKET 2 24H OVERWRITE INVARIANT)
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Surplus Stacking Denial overwrites Bucket 2 pool in RAM every 24h without stacking", () => {
    const qm = createTestCoordinator();
    const DAY_MS = 86400000;
    const baseEpoch = Date.now();

    // Formula verification at 80% battery:
    // floor(((80 - 50) * 17.28 * 18) / 2) = floor(4665.6) = 4665 NCP
    const EXPECTED_80_PCT_SURPLUS = 4665;

    let simulatedBattery = 80;
    const persistenceEvents = [];

    qm.setTelemetryProvider(() => simulatedBattery);
    qm.setOnSurplusAccrual((pool, epoch) => {
      persistenceEvents.push({ pool, epoch });
    });

    // 1. Initial 24h sweep at t0 -> initializes surplus pool to 4665 NCP
    const changed1 = qm.sweep({ now: baseEpoch });
    assert.strictEqual(changed1, true);
    assert.deepStrictEqual(qm.getSurplusPool(), {
      pool: EXPECTED_80_PCT_SURPLUS,
      lastAccrual: baseEpoch
    });
    assert.strictEqual(persistenceEvents.length, 1);

    // 2. Sweep 12 hours later -> must NOT trigger accrual (< 24h)
    const midDayEpoch = baseEpoch + (DAY_MS / 2);
    const changed12h = qm.sweep({ now: midDayEpoch });
    assert.strictEqual(changed12h, false);
    assert.strictEqual(qm.getSurplusPool().pool, EXPECTED_80_PCT_SURPLUS);
    assert.strictEqual(persistenceEvents.length, 1);

    // 3. Simulate partial spend of 1000 NCP and an active in-memory surplus hold of 18 NCP at midDayEpoch
    assert.strictEqual(qm.deductSurplusPool(1000), 3665);
    const surplusTask = qm.join({
      browser_id: 'b_surplus_user',
      req_id: 'r_surplus_1',
      user_id: 'u_surplus_user',
      held_ncp: 18,
      held_ncp_source: 'surplus',
      now: midDayEpoch
    });
    assert.strictEqual(qm.getAvailableSurplusNcp(), 3647, "Available surplus must deduct active surplus holds");

    // 4. Simulate 4 consecutive 24-hour sweeps while tank sits at 80%
    for (let day = 1; day <= 4; day++) {
      const sweepEpoch = baseEpoch + (day * DAY_MS);
      surplusTask.started_processing_at = sweepEpoch - 1000;
      const changed = qm.sweep({ now: sweepEpoch });
      assert.strictEqual(changed, true, `Day ${day} 24h sweep must evaluate surplus`);
      assert.strictEqual(
        qm.getSurplusPool().pool,
        EXPECTED_80_PCT_SURPLUS,
        `Day ${day}: Pool MUST be overwritten to ${EXPECTED_80_PCT_SURPLUS} NCP (no stacking across cycles)`
      );
      assert.strictEqual(qm.getSurplusPool().lastAccrual, sweepEpoch);
    }

    // 5. Simulate multi-day jump (e.g. 72 hours elapsed in a single sweep while tank at 80%)
    const jumpEpoch = baseEpoch + (7 * DAY_MS);
    qm.sweep({ now: jumpEpoch });
    assert.strictEqual(
      qm.getSurplusPool().pool,
      EXPECTED_80_PCT_SURPLUS,
      "Multi-day offline gap must overwrite once without multiplying by elapsed days"
    );
    // Stale task from Day 4 was also swept after 72h inactivity, releasing its 18 NCP surplus hold
    assert.strictEqual(qm.getHeldSurplusNcp(), 0);

    // 6. Tank drops to 50.0% boundary while an active task holds 18 surplus NCP -> pool clears to 0, available floors at 0
    qm.join({
      browser_id: 'b_surplus_floor',
      req_id: 'r_surplus_floor',
      user_id: 'u_surplus_floor',
      held_ncp: 18,
      held_ncp_source: 'surplus',
      now: jumpEpoch + DAY_MS - 1000
    });
    simulatedBattery = 50.0;
    qm.sweep({ now: jumpEpoch + DAY_MS });
    assert.strictEqual(qm.getSurplusPool().pool, 0, "Tank at 50% threshold must clear surplus pool to 0");
    assert.strictEqual(qm.getAvailableSurplusNcp(), 0, "Available surplus must never underflow below 0");
    assert.strictEqual(qm.deductSurplusPool(18), 0, "deductSurplusPool must never underflow below 0");

    // 7. Tank drops below threshold (40%) -> pool remains 0 NCP
    simulatedBattery = 40.0;
    qm.sweep({ now: jumpEpoch + (2 * DAY_MS) });
    assert.strictEqual(qm.getSurplusPool().pool, 0, "Tank below 50% threshold must keep surplus pool at 0");

    // 8. SQLite TEXT hydration (config.value is TEXT in SQLite) preserves 24h cooldown across restarts
    qm.reset();
    qm.hydrateSurplusPool('1200', String(baseEpoch));
    assert.deepStrictEqual(qm.getSurplusPool(), { pool: 1200, lastAccrual: baseEpoch });
    qm.setTelemetryProvider(() => 80);
    // Only 1 hour since hydrated accrual -> must not overwrite
    qm.sweep({ now: baseEpoch + 3600000 });
    assert.strictEqual(qm.getSurplusPool().pool, 1200, "SQLite TEXT timestamp hydration must prevent premature overwrite");
    // 24 hours since hydrated accrual -> must overwrite to 4665
    qm.sweep({ now: baseEpoch + DAY_MS });
    assert.strictEqual(qm.getSurplusPool().pool, EXPECTED_80_PCT_SURPLUS);

    // Epoch '0' string sentinel and null lastAccrualEpoch represent uninitialized -> accrue immediately
    qm.reset();
    qm.hydrateSurplusPool('0', '0');
    assert.deepStrictEqual(qm.getSurplusPool(), { pool: 0, lastAccrual: 0 });
    qm.setTelemetryProvider(() => 80);
    assert.strictEqual(qm.sweep({ now: 0 }), true);
    assert.strictEqual(qm.getSurplusPool().pool, EXPECTED_80_PCT_SURPLUS);
    assert.strictEqual(qm.sweep({ now: 3600000 }), false, "Sweep 1h after epoch 0 must NOT re-accrue");
    assert.strictEqual(qm.sweep({ now: DAY_MS }), true, "Sweep 24h after epoch 0 must accrue");

    qm.reset();
    qm.hydrateSurplusPool(500, null);
    assert.deepStrictEqual(qm.getSurplusPool(), { pool: 500, lastAccrual: 0 });
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: FAIL-CLOSED VALIDATION, TELEMETRY ANOMALIES, CLOCK SYNC & HOOKS
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Fails closed on poison holds, corrupt hydration, bad telemetry, and clock skew", () => {
    // 1. Partial/undefined config object must still enforce MAX_CONCURRENT_TEXT_GENS default (3)
    const partialQm = createQueueCoordinator({
      QUEUE_POLL_TIMEOUT_MS: 5000,
      MAX_CONCURRENT_TEXT_GENS: undefined
    });
    assert.strictEqual(partialQm.acquireTextSlot('c1', 'u1', 2), true);
    assert.strictEqual(partialQm.acquireTextSlot('c2', 'u2', 2), true);
    assert.strictEqual(partialQm.acquireTextSlot('c3', 'u3', 2), true);
    assert.strictEqual(partialQm.acquireTextSlot('c4', 'u4', 2), false, "Partial config must enforce default Channel B cap");

    // Duplicate req_id, blank req_id, and invalid user_id in Channel B must fail closed
    partialQm.releaseTextSlot('c3');
    assert.strictEqual(partialQm.acquireTextSlot('c1', 'attacker', 0), false, "Channel B duplicate req_id must be rejected");
    assert.strictEqual(partialQm.acquireTextSlot('   ', 'u_blank', 2), false, "Channel B whitespace req_id must be rejected");
    assert.throws(() => partialQm.acquireTextSlot('c_bad_user', '   ', 2), /user_id must be a non-empty string/);
    assert.throws(() => partialQm.acquireTextSlot('c_bad_user', 123, 2), /user_id must be a non-empty string/);

    // Corrupt held_cost in acquireTextSlot must throw (fail-closed) without allocating slot
    for (const badHold of [NaN, Infinity, -2, 1.5, true, '2', [], {}]) {
      assert.throws(() => partialQm.acquireTextSlot('c_bad_hold', 'u_bad', badHold), /held_cost must be a non-negative safe integer/);
    }
    assert.strictEqual(partialQm.getTextLock('c_bad_hold'), null);

    // 2. Duplicate req_id, whitespace identifiers, and non-string/blank user_id/discord_id in join/poll/complete must fail closed
    const qm = createTestCoordinator();
    assert.throws(() => qm.join({ browser_id: '   ', req_id: 'r_ws' }), /browser_id is mandatory/);
    assert.throws(() => qm.join({ browser_id: 'b_ws', req_id: '   ' }), /req_id is mandatory/);
    assert.throws(() => qm.poll('r_ws', '   '), /browser_id is mandatory/);
    assert.throws(() => qm.complete('r_ws', '   '), /browser_id is mandatory/);
    assert.strictEqual(qm.poll('   ', 'b_ws'), null);
    assert.strictEqual(qm.complete('   ', 'b_ws'), false);
    assert.throws(() => qm.join({ browser_id: 'b_bad_u', req_id: 'r_bad_u1', user_id: 123 }), /user_id must be a non-empty string/);
    assert.throws(() => qm.join({ browser_id: 'b_bad_u', req_id: 'r_bad_u2', user_id: '   ' }), /user_id must be a non-empty string/);
    assert.throws(() => qm.join({ browser_id: 'b_bad_d', req_id: 'r_bad_d1', discord_id: 123 }), /discord_id must be a non-empty string/);
    assert.throws(() => qm.join({ browser_id: 'b_bad_d', req_id: 'r_bad_d2', discord_id: '   ' }), /discord_id must be a non-empty string/);

    qm.join({ browser_id: 'b_legit', req_id: 'shared_req_id', user_id: 'u_legit', held_cost: 10 });
    assert.throws(() => {
      qm.join({ browser_id: 'b_attacker', req_id: 'shared_req_id', user_id: 'u_attacker', held_cost: 99 });
    }, /Overlapping req_id/);
    assert.strictEqual(qm.getQueueLength(), 1);
    assert.strictEqual(qm.getHeldAnlasForUser('u_legit'), 10);

    // 3. Forward-simulated clock in join(), poll(), acquireTextSlot(), and sweep() keeps tasks, buckets, and Channel B locks alive
    const futureNow = Date.now() + (2 * 3600000); // +2 hours ahead of Date.now()
    qm.join({ browser_id: 'b_clock', req_id: 'r_clock', user_id: 'u_clock', priority_tier: 'Normal', now: futureNow });
    qm.join({ browser_id: 'b_clock_wait', req_id: 'r_clock_wait', user_id: 'u_clock_wait', priority_tier: 'Normal', now: futureNow });
    assert.strictEqual(qm.acquireTextSlot('t_clock', 'u_clock', 2, futureNow), true);
    const bucketBefore = qm.principalBuckets.get('u_clock');
    assert.ok(bucketBefore, "Token bucket must exist");
    const tokensAfterJoin = bucketBefore.tokens;
    assert.strictEqual(bucketBefore.lastTx, futureNow, "Bucket timestamp must match simulated join clock");
    const pollWait = qm.poll('r_clock_wait', 'b_clock_wait', futureNow + 10000);
    assert.strictEqual(pollWait.status, 'waiting');
    qm.sweep({ now: futureNow + 15000 });
    assert.strictEqual(qm.principalBuckets.get('u_clock'), bucketBefore, "Sweep at futureNow must NOT drop newly created bucket");
    assert.strictEqual(qm.principalBuckets.get('u_clock').tokens, tokensAfterJoin);
    assert.ok(qm.getTextLock('t_clock'), "Sweep at futureNow must NOT falsely expire Channel B lock created at futureNow");
    assert.ok(qm.poll('r_clock_wait', 'b_clock_wait', futureNow + 15000), "Pending task polled at futureNow + 10s must survive sweep at +15s");

    // 4. Fail-closed validation on poison holds & unattributed NCP in join(), setTaskHold(), deductSurplusPool(), hydrateSurplusPool()
    for (const badHold of [NaN, Infinity, -50, 0.5, true, '10', [18], {}]) {
      assert.throws(() => qm.join({
        browser_id: 'b_poison',
        req_id: 'r_poison',
        user_id: 'u_poison',
        held_cost: badHold
      }), /held_cost must be a non-negative safe integer/);

      assert.throws(() => qm.join({
        browser_id: 'b_poison',
        req_id: 'r_poison',
        user_id: 'u_poison',
        held_ncp: badHold,
        held_ncp_source: 'personal'
      }), /held_ncp must be a non-negative safe integer/);

      assert.throws(() => qm.deductSurplusPool(badHold), /ncp must be a non-negative safe integer/);
    }

    assert.throws(() => qm.join({
      browser_id: 'b_orphan',
      req_id: 'r_orphan',
      user_id: 'u_orphan',
      held_ncp: 18,
      held_ncp_source: 'invalid_bucket'
    }), /held_ncp_source/);

    assert.throws(() => qm.join({
      browser_id: 'b_orphan',
      req_id: 'r_orphan',
      user_id: 'u_orphan',
      held_ncp: 18
    }), /held_ncp_source .* required/);

    assert.throws(() => qm.join({
      browser_id: 'b_orphan',
      req_id: 'r_orphan',
      user_id: 'u_orphan',
      held_ncp: 0,
      held_ncp_source: 'personal'
    }), /held_ncp_source must be null when held_ncp is 0/);

    const mutTask = qm.join({ browser_id: 'b_mut', req_id: 'r_mut', user_id: 'u_mut' });
    assert.throws(() => qm.setTaskHold('r_mut', 'b_mut', null), /holds must be a plain object/);
    assert.throws(() => qm.setTaskHold('r_mut', 'b_mut', []), /holds must be a plain object/);
    assert.throws(() => qm.setTaskHold('r_mut', 'b_mut', 'bad'), /holds must be a plain object/);
    assert.throws(() => qm.setTaskHold('r_mut', 'b_mut', { held_ncp: 18 }), /held_ncp_source .* required/);
    assert.throws(() => qm.setTaskHold('r_mut', 'b_mut', { held_ncp: 10, held_ncp_source: 'bad' }), /held_ncp_source/);
    assert.strictEqual(qm.getHeldNcpForUser('u_mut'), 0);

    qm.setTaskHold('r_mut', 'b_mut', { held_ncp: 18, held_ncp_source: 'surplus' });
    assert.strictEqual(qm.getHeldNcpForUser('u_mut', 'surplus'), 18);
    assert.throws(
      () => qm.setTaskHold('r_mut', 'b_mut', { held_ncp: 0, held_ncp_source: 'personal' }),
      /held_ncp_source must be null/
    );
    assert.strictEqual(qm.setTaskHold('r_mut', 'b_mut', { held_ncp: 0 }), true);
    assert.strictEqual(mutTask.held_ncp_source, null);
    assert.strictEqual(qm.getHeldNcpForUser('u_mut'), 0);

    // Corrupt persisted surplus strings and non-primitives must throw on hydration
    assert.throws(() => qm.hydrateSurplusPool('0x10', '0'), /v5_surplus_pool/);
    assert.throws(() => qm.hydrateSurplusPool(true, '0'), /v5_surplus_pool/);
    assert.throws(() => qm.hydrateSurplusPool({}, '0'), /v5_surplus_pool/);
    assert.throws(() => qm.hydrateSurplusPool('100', 'not_an_epoch'), /v5_surplus_last_accrual/);
    assert.throws(() => qm.hydrateSurplusPool('100', -5), /v5_surplus_last_accrual/);

    // Out-of-bounds V5_SURPLUS_THRESHOLD_PERCENT (< 0 or > 100) must fall back to 50.0 (no phantom surplus at 0%)
    const negThreshQm = createTestCoordinator({ V5_SURPLUS_THRESHOLD_PERCENT: -10 });
    negThreshQm.setTelemetryProvider(() => 0);
    negThreshQm.sweep({ now: Date.now() });
    assert.strictEqual(negThreshQm.getSurplusPool().pool, 0, "Negative threshold must fall back to 50% and mint 0 NCP at 0% battery");

    const highThreshQm = createTestCoordinator({ V5_SURPLUS_THRESHOLD_PERCENT: 150 });
    highThreshQm.setTelemetryProvider(() => 80);
    highThreshQm.sweep({ now: Date.now() });
    assert.strictEqual(highThreshQm.getSurplusPool().pool, 4665, "Threshold > 100 must fall back to 50% and evaluate 80% battery normally");

    // 5. Poison & out-of-range (>100 / <0) telemetry must fail closed without altering surplus pool
    qm.reset();

    const DAY_MS = 86400000;
    const t0 = Date.now();
    qm.hydrateSurplusPool('4665', String(t0));

    for (const badTelemetry of [null, undefined, '', '   ', '80', false, true, [80], {}, NaN, Infinity, -Infinity, -1, 100.1, 150]) {
      qm.setTelemetryProvider(() => badTelemetry);
      const mutated = qm.sweep({ now: t0 + DAY_MS });
      assert.strictEqual(mutated, false);
      assert.strictEqual(
        qm.getSurplusPool().pool,
        4665,
        `Poison telemetry (${String(badTelemetry)}) must NOT wipe or inflate surplus pool`
      );
      assert.strictEqual(qm.getSurplusPool().lastAccrual, t0);
    }

    qm.setTelemetryProvider(() => { throw new Error('Telemetry offline'); });
    assert.strictEqual(qm.sweep({ now: t0 + DAY_MS }), false);
    assert.strictEqual(qm.getSurplusPool().pool, 4665);
    assert.strictEqual(qm.getSurplusPool().lastAccrual, t0);

    // Invalid explicit batteryPercent override (including null) must abort evaluation rather than falling back to provider
    qm.setTelemetryProvider(() => 80);
    assert.strictEqual(qm.sweep({ now: t0 + DAY_MS, batteryPercent: null }), false);
    assert.strictEqual(qm.sweep({ now: t0 + DAY_MS, batteryPercent: NaN }), false);
    assert.strictEqual(qm.sweep({ now: t0 + DAY_MS, batteryPercent: false }), false);
    assert.strictEqual(qm.sweep({ now: t0 + DAY_MS, batteryPercent: 150 }), false);
    assert.strictEqual(qm.evaluateSurplusPool(t0 + DAY_MS, null), false);
    assert.strictEqual(qm.getSurplusPool().lastAccrual, t0);

    // 6. Persistence hook throws (sync and async) must not crash sweep() or block RAM state progression
    qm.setOnSurplusAccrual(() => { throw new Error('SQLITE_BUSY'); });
    assert.doesNotThrow(() => qm.sweep({ now: t0 + DAY_MS }));
    assert.strictEqual(qm.getSurplusPool().pool, 4665);
    assert.strictEqual(qm.getSurplusPool().lastAccrual, t0 + DAY_MS);

    qm.setOnSurplusAccrual(() => Promise.reject(new Error('Async DB write failed')));
    assert.doesNotThrow(() => qm.sweep({ now: t0 + (2 * DAY_MS) }));
    assert.strictEqual(qm.getSurplusPool().lastAccrual, t0 + (2 * DAY_MS));
  });
});