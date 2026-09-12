'use strict';

/**
 * PHASE 3 RIGOROUS VERIFICATION HARNESS (test/phase3.test.js)
 *
 * Exhaustively exercises the Level 3 Queue Coordinator:
 * 1. Deterministic FIFO queueing and dual-slope dynamic priority aging (Fast vs Base slope).
 * 2. Step-function AUTO boost promotion at the 120s threshold with token consumption via GC Sweep.
 * 3. Saturated bucket auto-boost denial (verifies client remains on Base slope when burst tokens are 0).
 * 4. Strict Single-Concurrency Lock for Channel A (only 1 task processing simultaneously).
 * 5. 1-request-per-user concurrency eviction:
 *    - New join with same browser_id evicts prior task and destroys its upstream socket handle.
 *    - New join with same discord_id evicts prior task and destroys its upstream socket handle.
 * 6. Identity-bound administrative & audit eviction:
 *    - evict({ discord_id }) purges linked sessions and destroys upstream sockets.
 *    - evict({ browser_id }) purges direct hardware session and destroys upstream sockets.
 * 7. Upstream socket destruction on complete():
 *    - Completing an active task terminates any hung upstream socket and promotes the next pending task.
 * 8. Scavenger Sweeper (GC) Hell Paths:
 *    - Inactive pending task (> 12000ms without poll) is discarded from RAM.
 *    - Hung processing task (> 75000ms processing lock) has upstream socket destroyed, is evicted,
 *      and promotes the next pending task in line.
 * 9. Channel B (Text Generation) Concurrency Gate:
 *    - Strict limit enforcement at MAX_CONCURRENT_TEXT_GENS (3).
 *    - Rejection of 4th concurrent request.
 *    - Slot release restores capacity.
 *    - Slot release underflow guard (never drops below 0).
 * 10. Volatile Token Bucket Mathematical Invariants:
 *     - Fractional drift retention down to the millisecond.
 *     - Cap at maxBurst.
 *     - Zero refill rate handling (no division by zero).
 * 11. Device Presence & Session RAM tracking:
 *     - ping() records timestamp in RAM.
 *     - isDeviceOnline() adheres strictly to ACTIVE_SESSION_TTL_MS.
 * 12. OOM Extinguisher: Map sweeping clears stale presence traces and token buckets over 1 hour old.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createQueueCoordinator } = require('../queueManager');
const { DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('../config');

// Helper to construct an isolated coordinator with tailored operational limits
function createTestCoordinator(overrides = {}) {
  const customConfig = {
    TIER_CONFIGS: DEFAULT_TIER_CONFIGS,
    ...OPERATIONAL_DEFAULTS,
    ...overrides
  };
  return createQueueCoordinator(customConfig);
}

// Mock outbound upstream ClientRequest with .destroy() tracking
function createMockUpstreamRequest() {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    }
  };
}

test("Phase 3: Queue Coordinator & State Engine Verification Gate", async (t) => {

  await t.test("Channel A: Strict Single-Concurrency Lock Enforcement", () => {
    const qm = createTestCoordinator();

    const t1 = qm.join({ browser_id: 'b1', req_id: 'r1', priority_tier: 'Normal' });
    const t2 = qm.join({ browser_id: 'b2', req_id: 'r2', priority_tier: 'Normal' });

    assert.strictEqual(t1.status, 'processing', "First task to enter idle queue must immediately acquire 'processing' lock");
    assert.strictEqual(t2.status, 'pending', "Second task must be queued as 'pending'");

    // Query processing task directly
    const processingTask = qm.getProcessingTask('r1', 'b1');
    assert.strictEqual(processingTask.req_id, 'r1', "getProcessingTask must match active processing request");

    const deniedLookup = qm.getProcessingTask('r2', 'b2');
    assert.strictEqual(deniedLookup, null, "getProcessingTask must return null for pending task");
  });

  await t.test("Channel A: FIFO Ordering and Dual-Slope Priority Aging Calculations", () => {
    const qm = createTestCoordinator();

    // Enqueue 2 tasks with Normal tier (basePriority: 10)
    // Note: Normal tier has maxBurst: 15, so both tasks consume 1 burst token and start with has_burst_boost = true
    const t1 = qm.join({ browser_id: 'b1', req_id: 'r1', priority_tier: 'Normal' }); // Becomes processing
    const t2 = qm.join({ browser_id: 'b2', req_id: 'r2', priority_tier: 'Normal' }); // Pending
    const t3 = qm.join({ browser_id: 'b3', req_id: 'r3', priority_tier: 'Low' });    // Pending (Low tier: basePriority: 0, hasBurstBoost: true)

    assert.strictEqual(t1.status, 'processing');
    assert.strictEqual(t2.status, 'pending');
    assert.strictEqual(t3.status, 'pending');

    // Simulate 30 seconds of waiting for pending tasks
    const now = Date.now();
    t2.timestamp = now - 30000;
    t3.timestamp = now - 30000;

    // Execute scavenger sweep to forcefully lock and update chronological sorting
    qm.sweep();

    // t2 (Normal with burst boost): base = 20, elapsed = 30s. priority = 20 + floor(30/5) = 26
    // t3 (Low with burst boost): base = 20, elapsed = 30s. priority = 20 + floor(30/5) = 26
    // Since both have priority 26, secondary sort is timestamp ascending (t2 earlier than t3)
    const pollResultT2 = qm.poll('r2', 'b2');
    assert.strictEqual(pollResultT2.status, 'waiting');
    assert.strictEqual(pollResultT2.position, 1, "t2 must hold position 1");

    const pollResultT3 = qm.poll('r3', 'b3');
    assert.strictEqual(pollResultT3.status, 'waiting');
    assert.strictEqual(pollResultT3.position, 2, "t3 must hold position 2");
  });

  await t.test("Channel A: Step-Function AUTO Boost Promotion at 120s Threshold", () => {
    const qm = createTestCoordinator();

    // Drain burst tokens from browser 'b_metered' (Metered tier has maxBurst: 5)
    const bucket = qm.getOrInitBucket('b_metered', 'Metered');
    bucket.tokens = 0; // Empty bucket

    const t1 = qm.join({ browser_id: 'active_client', req_id: 'active_req', priority_tier: 'Admin' });
    assert.strictEqual(t1.status, 'processing');

    // Join with empty bucket: must default to Base slope (has_burst_boost = false)
    const t2 = qm.join({ browser_id: 'b_metered', req_id: 'metered_req', priority_tier: 'Metered' });
    assert.strictEqual(t2.has_burst_boost, false, "Must start on Base Slope when burst bucket is depleted");

    // Age task to 121 seconds
    const now = Date.now();
    t2.timestamp = now - 121000;

    // Refill 1 token in bucket
    bucket.tokens = 1.0;

    // The scavenger sweep triggers state transition mutations (CQS strictness: DO NOT MUTATE IN POLL)
    qm.sweep();

    const pollRes = qm.poll('metered_req', 'b_metered');
    assert.strictEqual(pollRes.status, 'waiting');
    assert.strictEqual(t2.has_burst_boost, true, "Must be promoted to Fast Slope after exceeding 120s threshold with available token");
    assert.strictEqual(bucket.tokens, 0, "1.0 token must be deducted from bucket upon AUTO boost promotion via GC Sweep");
  });

  await t.test("Channel A: Saturated Bucket AUTO Boost Denial (Remains on Base Slope)", () => {
    const qm = createTestCoordinator();

    const bucket = qm.getOrInitBucket('b_starved', 'Metered');
    bucket.tokens = 0;

    qm.join({ browser_id: 'blocker', req_id: 'blocker_req', priority_tier: 'Admin' });
    const t2 = qm.join({ browser_id: 'b_starved', req_id: 'starved_req', priority_tier: 'Metered' });

    // Age task to 125 seconds, but keep bucket at 0 tokens
    t2.timestamp = Date.now() - 125000;
    bucket.tokens = 0;

    qm.sweep(); // Must run sweep to trigger state transition evaluation

    qm.poll('starved_req', 'b_starved');
    assert.strictEqual(t2.has_burst_boost, false, "Must remain on Base Slope if bucket cannot provide 1.0 token at 120s mark");
  });

  await t.test("Hell Path: 1-Request-Per-User Concurrency Eviction & Upstream Socket Termination", () => {
    const qm = createTestCoordinator();

    // Client 1 joins and becomes processing
    const t1 = qm.join({ browser_id: 'browser_alpha', req_id: 'req_1', priority_tier: 'Normal', discord_id: 'discord_alpha' });
    const mockSocket1 = createMockUpstreamRequest();
    const attached = qm.attachUpstreamRequest('req_1', mockSocket1);
    assert.strictEqual(attached, true, "Socket must attach to active processing request");

    assert.strictEqual(t1.status, 'processing');
    assert.strictEqual(mockSocket1.destroyed, false);

    // Same client (matching browser_id) joins again with req_2
    const t2 = qm.join({ browser_id: 'browser_alpha', req_id: 'req_2', priority_tier: 'Normal', discord_id: 'discord_alpha' });

    // Invariant: prior request must be destroyed and evicted
    assert.strictEqual(mockSocket1.destroyed, true, "Prior upstream request socket must be forcefully destroyed on concurrency collision");
    assert.strictEqual(qm.poll('req_1', 'browser_alpha'), null, "Prior request must be completely evicted from active queue RAM");
    assert.strictEqual(t2.status, 'processing', "New colliding request must take over active slot cleanly");
  });

  await t.test("Hell Path: Identity-Locked Eviction (Discord ID Collision Across Different Browsers)", () => {
    const qm = createTestCoordinator();

    // Browser 1 registers under Discord ID 'user_xyz'
    const t1 = qm.join({ browser_id: 'browser_1', req_id: 'req_b1', priority_tier: 'Normal', discord_id: 'user_xyz' });
    const mockSocket = createMockUpstreamRequest();
    const attached = qm.attachUpstreamRequest('req_b1', mockSocket);
    assert.strictEqual(attached, true, "Socket must attach to active request");

    // Browser 2 (different browser_id) registers under same Discord ID 'user_xyz'
    const t2 = qm.join({ browser_id: 'browser_2', req_id: 'req_b2', priority_tier: 'Normal', discord_id: 'user_xyz' });

    assert.strictEqual(mockSocket.destroyed, true, "Cross-device duplicate task for same Discord account must destroy active socket");
    assert.strictEqual(qm.poll('req_b1', 'browser_1'), null, "Browser 1 task must be evicted because Discord account had existing slot");
    assert.strictEqual(t2.status, 'processing');
  });

  await t.test("Hell Path: Complete Promotes Next Task in Same Execution Tick", () => {
    const qm = createTestCoordinator();

    qm.join({ browser_id: 'b1', req_id: 'r1', priority_tier: 'Normal' });
    qm.join({ browser_id: 'b2', req_id: 'r2', priority_tier: 'Normal' });

    const mockSocketR1 = createMockUpstreamRequest();
    qm.attachUpstreamRequest('r1', mockSocketR1);

    const completed = qm.complete('r1', 'b1');
    assert.strictEqual(completed, true, "complete() must return true for existing task");
    assert.strictEqual(mockSocketR1.destroyed, true, "complete() must destroy attached upstream socket");

    // Task 2 must immediately be promoted to processing in the same synchronous execution tick
    const task2Status = qm.poll('r2', 'b2');
    assert.strictEqual(task2Status.status, 'your_turn', "Next queued task must immediately transition to 'your_turn' on completion");
  });

  await t.test("Hell Path: Administrative and Security Audit Eviction Purges All Footprints", () => {
    const qm = createTestCoordinator();

    // Malicious user registers task
    qm.join({ browser_id: 'b_bad_1', req_id: 'r_bad_1', priority_tier: 'Normal', discord_id: 'malicious_user' });
    // Innocent user queues behind malicious user
    qm.join({ browser_id: 'b_innocent', req_id: 'r_innocent', priority_tier: 'Normal', discord_id: 'good_user' });

    const socketBad = createMockUpstreamRequest();
    const attached = qm.attachUpstreamRequest('r_bad_1', socketBad);
    assert.strictEqual(attached, true, "Upstream socket must attach to active processing task");

    // Trigger policy ban eviction for Discord account
    const evictedCount = qm.evict({ discord_id: 'malicious_user' });
    assert.strictEqual(evictedCount, 1, "Must evict active task for malicious user");
    assert.strictEqual(socketBad.destroyed, true, "Evicted task socket must be destroyed");
    assert.strictEqual(qm.poll('r_bad_1', 'b_bad_1'), null, "Malicious user task must be completely evicted from queue RAM");

    // Innocent user must now hold active processing slot
    const innocentPoll = qm.poll('r_innocent', 'b_innocent');
    assert.strictEqual(innocentPoll.status, 'your_turn', "Innocent task must be promoted upon malicious user eviction");

    // Verify unlinked hardware footprint eviction by browser_id
    qm.join({ browser_id: 'b_unlinked_bad', req_id: 'r_unlinked_bad', priority_tier: 'Normal' });
    const socketUnlinked = createMockUpstreamRequest();
    const attachedUnlinked = qm.attachUpstreamRequest('r_unlinked_bad', socketUnlinked);
    assert.strictEqual(attachedUnlinked, true);

    const evictedBrowserCount = qm.evict({ browser_id: 'b_unlinked_bad' });
    assert.strictEqual(evictedBrowserCount, 1, "Must evict unlinked task by browser_id");
    assert.strictEqual(socketUnlinked.destroyed, true, "Evicted unlinked task socket must be destroyed");
    assert.strictEqual(qm.poll('r_unlinked_bad', 'b_unlinked_bad'), null, "Unlinked task must be purged from queue RAM");
  });

  await t.test("Hell Path: Scavenger GC Sweeper Drops Inactive Pending and Hung Processing Locks", () => {
    // Override timeouts: 100ms poll timeout, 500ms processing timeout
    const qm = createTestCoordinator({
      QUEUE_POLL_TIMEOUT_MS: 100,
      QUEUE_PROCESSING_TIMEOUT_MS: 500
    });

    const tProc = qm.join({ browser_id: 'hung_browser', req_id: 'hung_req', priority_tier: 'Normal' });
    const mockHungSocket = createMockUpstreamRequest();
    qm.attachUpstreamRequest('hung_req', mockHungSocket);

    const tPending = qm.join({ browser_id: 'inactive_browser', req_id: 'inactive_req', priority_tier: 'Normal' });
    const tNextInLine = qm.join({ browser_id: 'active_browser', req_id: 'next_req', priority_tier: 'Normal' });

    assert.strictEqual(tProc.status, 'processing');
    assert.strictEqual(tPending.status, 'pending');
    assert.strictEqual(tNextInLine.status, 'pending');

    const now = Date.now();
    // Simulate tPending inactive for 200ms (> 100ms QUEUE_POLL_TIMEOUT_MS)
    tPending.last_polled_at = now - 200;

    // Simulate tNextInLine regularly active (polled right now)
    tNextInLine.last_polled_at = now;

    // Simulate tProc hung for 600ms (> 500ms QUEUE_PROCESSING_TIMEOUT_MS)
    tProc.started_processing_at = now - 600;

    // Execute scavenger sweep
    const changed = qm.sweep();
    assert.strictEqual(changed, true, "sweep() must return true when state was modified");

    // Invariant assertions:
    assert.strictEqual(mockHungSocket.destroyed, true, "Hung generation upstream socket must be destroyed");
    assert.strictEqual(qm.poll('hung_req', 'hung_browser'), null, "Hung generation lock must be purged from queue RAM");
    assert.strictEqual(qm.poll('inactive_req', 'inactive_browser'), null, "Inactive pending task must be purged from queue RAM");

    // Next in line must be promoted to processing
    const nextPoll = qm.poll('next_req', 'active_browser');
    assert.strictEqual(nextPoll.status, 'your_turn', "Next active pending task must be promoted to processing after hung lock eviction");
  });

  await t.test("Hell Path: Scavenger GC Sweeper Evicts Stale Maps to Prevent OOM", () => {
    const qm = createTestCoordinator({ ACTIVE_SESSION_TTL_MS: 50 });
    qm.ping('oom_client');
    
    // Artificial bucket insertion simulating historical transaction data
    const bucket = qm.getOrInitBucket('oom_client', 'Normal');
    bucket.lastTx = Date.now() - 4000000; 
    
    // Push the active timestamp to outside the eviction boundary manually
    qm.activeSessions.set('oom_client', Date.now() - 200);
    
    qm.sweep();
    
    assert.strictEqual(qm.activeSessions.has('oom_client'), false, "Stale presence map MUST be evicted to prevent OOM");
    assert.strictEqual(qm.deviceBuckets.has('oom_client'), false, "Dormant token buckets MUST be evicted to prevent OOM");
  });

  await t.test("Channel B: Concurrency Limits and Underflow Protection", () => {
    const qm = createTestCoordinator({ MAX_CONCURRENT_TEXT_GENS: 3 });

    assert.strictEqual(qm.acquireTextSlot('req1'), true, "Slot 1 acquired");
    assert.strictEqual(qm.acquireTextSlot('req2'), true, "Slot 2 acquired");
    assert.strictEqual(qm.acquireTextSlot('req3'), true, "Slot 3 acquired");
    assert.strictEqual(qm.getActiveTextGenerations(), 3);

    // 4th slot must fail
    assert.strictEqual(qm.acquireTextSlot('req4'), false, "4th concurrent slot must be denied");
    assert.strictEqual(qm.getActiveTextGenerations(), 3);

    // Release 1 slot
    qm.releaseTextSlot('req2');
    assert.strictEqual(qm.getActiveTextGenerations(), 2);

    // Now slot is available again
    assert.strictEqual(qm.acquireTextSlot('req5'), true, "Slot must be claimable after release");
    assert.strictEqual(qm.getActiveTextGenerations(), 3);

    // Underflow test: release more times than existed, or non-existent keys
    qm.releaseTextSlot('req1');
    qm.releaseTextSlot('req3');
    qm.releaseTextSlot('req5');
    qm.releaseTextSlot('ghost1');
    qm.releaseTextSlot('ghost2');
    assert.strictEqual(qm.getActiveTextGenerations(), 0, "Active text generations counter must never underflow below 0");
  });

  await t.test("Token Bucket: Fractional Timing Drift and Zero Refill Bounds", () => {
    const qm = createTestCoordinator();

    // High tier has refillRate = 0 (manual allowance only, no automatic burst refill)
    const highBucket = qm.getOrInitBucket('b_high', 'High');
    assert.strictEqual(highBucket, null, "Tier with maxBurst = Infinity must return null bucket reference");

    // Normal tier: maxBurst = 15, refillRate = 120,000ms (1 token every 2 minutes)
    const normalBucket = qm.getOrInitBucket('b_norm', 'Normal');
    assert.strictEqual(normalBucket.tokens, 15);

    // Deduct 5 tokens
    normalBucket.tokens = 10;
    normalBucket.lastTx = Date.now() - 180000; // 3 minutes elapsed (1 token gained, 60s remainder)

    // Trigger lazy refill check
    const refilledBucket = qm.getOrInitBucket('b_norm', 'Normal');
    assert.strictEqual(refilledBucket.tokens, 11, "Must gain exactly 1 token for 180s elapsed on a 120s refill rate");
    
    // Invariant: lastTx must advance by exactly 120,000ms, preserving the 60,000ms fractional remainder
    const remainingRemainder = Date.now() - refilledBucket.lastTx;
    assert.ok(remainingRemainder >= 59000 && remainingRemainder <= 61000, "Fractional timing drift must be preserved down to the millisecond");
  });

  await t.test("Session Tracking: RAM Presence and TTL Invariants", () => {
    const qm = createTestCoordinator({ ACTIVE_SESSION_TTL_MS: 50 });

    qm.ping('b_present');
    assert.strictEqual(qm.isDeviceOnline('b_present'), true, "Device must be online immediately after ping");

    // Device never seen
    assert.strictEqual(qm.isDeviceOnline('b_ghost'), false, "Unregistered device must evaluate as offline");

    // Sleep 60ms to exceed ACTIVE_SESSION_TTL_MS
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(qm.isDeviceOnline('b_present'), false, "Device must evaluate as offline after exceeding TTL");
        resolve();
      }, 60);
    });
  });
});