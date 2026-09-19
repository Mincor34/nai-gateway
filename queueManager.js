/**
 * QUEUE COORDINATOR & STATE ENGINE (queueManager.js)
 * Architecture Level 3: Imports Level 1 (config.js) only.
 *
 * DESIGN PRINCIPLES:
 * 1. Zero Event-Emitters: Eliminates non-deterministic microtask scheduling delays.
 *    All queue state transitions occur synchronously within a single event-loop tick.
 * 2. Strict Encapsulation: Protects Channel A (exclusive image queue), Channel B (shared
 *    text slots), burst token-buckets, session presence maps, and diagnostic debug targets from ambient leakage.
 * 3. Immediate Socket Destruction: Abrupt disconnects, concurrency collisions, and GC
 *    sweeps immediately terminate upstream sockets via .destroy() to prevent ghost locks.
 * 4. Dual-Slope Priority Aging: Evaluates dynamic linear priority decay on-the-fly with
 *    step-function AUTO promotions at configured thresholds.
 * 5. Deterministic Eviction: Immediately purges all pending or processing tasks matching
 *    a target browser footprint or canonical user identity upon policy or audit violations.
 * 6. Command Query Separation (CQS): Polling (read) operations compute theoretical 
 *    trajectories for telemetry. They NEVER mutate financial token states.
 * 7. Bilateral Ephemeral Diagnostics: Manages client-side debug intents and administrator
 *    inspection authorizations with deterministic millisecond TTL bounds swept automatically by the scavenger loop.
 * 8. Principal-Keyed Token Buckets: All burst token allocations and concurrency deduplications operate
 *    strictly on canonical user_id (Security Principal) while preserving deviceBuckets interface compatibility.
 */

'use strict';

const { loadConfig, DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('./config');

/**
 * Authoritative in-memory state coordinator for the NovelAI gateway.
 */
class QueueCoordinator {
  /**
   * Initializes state registries and operational boundaries.
   *
   * @param {object} [config] - Validated system configuration manifest.
   */
  constructor(config = null) {
    this.init(config);
    this.reset();
  }

  /**
   * Binds configuration parameters defensively, falling back to operational defaults
   * if booted in isolated test harnesses without environment variables.
   *
   * @param {object|null} config - Configuration manifest override.
   */
  init(config = null) {
    if (!config) {
      try {
        this.config = loadConfig(process.env);
      } catch (_) {
        this.config = {
          TIER_CONFIGS: DEFAULT_TIER_CONFIGS,
          ...OPERATIONAL_DEFAULTS
        };
      }
    } else {
      this.config = config;
    }

    this.tierConfigs = this.config.TIER_CONFIGS || DEFAULT_TIER_CONFIGS;
    this.gcInterval = null;
  }

  /**
   * Resets all RAM-bound states to pristine baselines.
   * Essential for deterministic unit and integration test teardowns.
   */
  reset() {
    this.queue = [];
    this.deviceBuckets = new Map();    // Stores burst buckets keyed by principal (user_id || browser_id)
    this.activeSessions = new Map();   // browser_id -> last_active_at
    this.activeTextLocks = new Map();  // req_id -> timestamp
    this.debugTargets = new Map();     // browser_id -> expires_at
    this.debugIntents = new Map();     // browser_id -> timestamp
  }

  /**
   * Exposes principalBuckets alias for architectural clarity without breaking deviceBuckets tests.
   */
  get principalBuckets() {
    return this.deviceBuckets;
  }

  /**
   * Registers or clears client-side diagnostic debug intent in RAM.
   *
   * @param {string} browserId - Target device browser footprint.
   * @param {boolean} [enabled=true] - Intent state.
   */
  setDebugIntent(browserId, enabled = true) {
    if (!browserId || typeof browserId !== 'string') return;
    if (enabled) {
      this.debugIntents.set(browserId, Date.now());
    } else {
      this.debugIntents.delete(browserId);
    }
  }

  /**
   * Checks whether a client has actively signaled diagnostic debug intent.
   *
   * @param {string} browserId - Target device browser footprint.
   * @returns {boolean} True if client has registered active intent.
   */
  hasDebugIntent(browserId) {
    if (!browserId || typeof browserId !== 'string') return false;
    return this.debugIntents.has(browserId);
  }

  /**
   * Authorizes a device browser footprint for temporary verbose telemetry inspection.
   *
   * @param {string} browserId - Target device browser footprint.
   * @param {number} [ttlMs=600000] - Duration of authorized inspection in milliseconds (default: 10m).
   */
  setDebugTarget(browserId, ttlMs = 600000) {
    if (!browserId || typeof browserId !== 'string') return;
    const boundedTtl = (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) ? ttlMs : 600000;
    this.debugTargets.set(browserId, Date.now() + boundedTtl);
  }

  /**
   * Revokes an active diagnostic debug inspection target immediately.
   *
   * @param {string} browserId - Target device browser footprint.
   * @returns {boolean} True if target was present and removed; false otherwise.
   */
  removeDebugTarget(browserId) {
    return this.debugTargets.delete(browserId);
  }

  /**
   * Evaluates whether a device is currently authorized by an administrator for diagnostic debug inspection.
   *
   * @param {string} browserId - Target device browser footprint.
   * @returns {boolean} True if authorized and TTL has not expired.
   */
  isDebugEnabled(browserId) {
    if (!browserId || !this.debugTargets.has(browserId)) return false;
    const expiresAt = this.debugTargets.get(browserId);
    if (Date.now() > expiresAt) {
      this.debugTargets.delete(browserId);
      return false;
    }
    return true;
  }

  /**
   * Retrieves comprehensive bilateral diagnostic status for a device.
   *
   * @param {string} browserId - Target device browser footprint.
   * @returns {{has_intent: boolean, is_authorized: boolean, expires_in_ms: number}}
   */
  getDebugTargetInfo(browserId) {
    const now = Date.now();
    const expiresAt = this.debugTargets.get(browserId) || 0;
    const isAuthorized = expiresAt > now;
    return {
      has_intent: this.hasDebugIntent(browserId),
      is_authorized: isAuthorized,
      expires_in_ms: isAuthorized ? (expiresAt - now) : 0
    };
  }

  /**
   * Exposes active authorized diagnostic debug targets.
   *
   * @returns {Array<{browser_id: string, expires_in_ms: number, has_intent: boolean}>} Active targets list.
   */
  getDebugTargets() {
    const now = Date.now();
    const active = [];
    for (const [browserId, expiresAt] of this.debugTargets.entries()) {
      if (expiresAt > now) {
        active.push({
          browser_id: browserId,
          expires_in_ms: expiresAt - now,
          has_intent: this.hasDebugIntent(browserId)
        });
      }
    }
    return active;
  }

  /**
   * Volatile dynamic token-bucket retriever implementing lazy math refills on-demand.
   * Keyed by canonical principalId to unify burst pools across devices.
   * Preserves fractional token accumulation drift and guards against division by zero.
   *
   * @param {string} principalId - Canonical user_id or browser footprint.
   * @param {string} tier - Allocation tier of the entity.
   * @returns {object|null} Evaluated bucket reference or null if tier is exempt.
   */
  getOrInitBucket(principalId, tier) {
    const tierConfig = this.tierConfigs[tier];
    if (!tierConfig || tierConfig.maxBurst === Infinity) return null;

    let bucket = this.deviceBuckets.get(principalId);
    const now = Date.now();

    if (!bucket) {
      bucket = {
        tokens: tierConfig.maxBurst,
        lastTx: now
      };
      this.deviceBuckets.set(principalId, bucket);
    } else {
      const elapsed = now - bucket.lastTx;
      if (tierConfig.refillRate > 0 && elapsed >= tierConfig.refillRate) {
        const gained = Math.floor(elapsed / tierConfig.refillRate);
        bucket.tokens = Math.min(tierConfig.maxBurst, bucket.tokens + gained);
        bucket.lastTx += gained * tierConfig.refillRate;
      }
    }

    return bucket;
  }

  /**
   * Records active presence timestamps for connected devices in RAM without disk I/O.
   *
   * @param {string} browserId - Unique device browser footprint.
   */
  ping(browserId) {
    if (browserId && typeof browserId === 'string') {
      this.activeSessions.set(browserId, Date.now());
    }
  }

  /**
   * Retrieves the latest active presence timestamp for a device.
   *
   * @param {string} browserId - Unique device browser footprint.
   * @returns {number} Timestamp epoch in milliseconds, or 0 if never seen.
   */
  getLastActive(browserId) {
    return this.activeSessions.get(browserId) || 0;
  }

  /**
   * Evaluates whether a device is actively online based on configured presence TTL.
   *
   * @param {string} browserId - Unique device browser footprint.
   * @param {number} [ttlMs] - Active presence threshold in milliseconds.
   * @returns {boolean} True if client pinged within the TTL threshold.
   */
  isDeviceOnline(browserId, ttlMs = this.config.ACTIVE_SESSION_TTL_MS) {
    const lastActive = this.getLastActive(browserId);
    return (Date.now() - lastActive) < ttlMs;
  }

  /**
   * Attempts to claim a non-blocking shared Channel B text-generation slot.
   * Tracks allocation by request ID to prevent zombie lock leaks and overlapping ID exploits.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @returns {boolean} True if slot allocated; false if pipelines are saturated or ID overlaps.
   */
  acquireTextSlot(req_id) {
    // protection against map key-collision concurrency bypasses
    if (this.activeTextLocks.has(req_id)) {
      console.warn(`[VPS Security] Channel B Concurrency Bypass Attempt: Overlapping lock ID detected ("${req_id}"). Rejecting.`);
      return false; 
    }
    if (this.activeTextLocks.size >= this.config.MAX_CONCURRENT_TEXT_GENS) {
      return false;
    }
    this.activeTextLocks.set(req_id, Date.now());
    return true;
  }

  /**
   * Releases a previously claimed Channel B text-generation slot securely by ID.
   *
   * @param {string} req_id - Unique request tracking UUID.
   */
  releaseTextSlot(req_id) {
    this.activeTextLocks.delete(req_id);
  }

  /**
   * Exposes active text generation count for telemetry and assertions.
   *
   * @returns {number} Active concurrent text generations.
   */
  getActiveTextGenerations() {
    return this.activeTextLocks.size;
  }

  /**
   * Evaluates dynamic priority aging decays and processes step-function transitions.
   * Centralized to enforce Command Query Separation (CQS) by preventing getters from mutating state.
   *
   * @param {number} now - Epoch timestamp
   * @returns {boolean} True if state mutated (tokens deducted or boosts applied)
   */
  evaluatePriorities(now = Date.now()) {
    let stateChanged = false;
    const pendingTasks = this.queue.filter(t => t.status === 'pending');

    pendingTasks.forEach(task => {
      const elapsedSeconds = (now - task.timestamp) / 1000;
      const targetPrincipal = task.user_id || task.discord_id || task.browser_id;

      // Dynamic Step-Function Jump (AUTO state promotion)
      if (!task.has_burst_boost && elapsedSeconds >= this.config.QUEUE_AUTO_BOOST_SECONDS) {
        const bucket = this.getOrInitBucket(targetPrincipal, task.priority_tier);
        if (bucket && bucket.tokens >= 1.0) {
          bucket.tokens -= 1.0;
          task.has_burst_boost = true;
          stateChanged = true;
          console.log(`[VPS Queue AUTO] Task "${task.req_id}" hit ${this.config.QUEUE_AUTO_BOOST_SECONDS}s threshold. Promoting User "${targetPrincipal}" to Fast Slope.`);
        }
      }

      let p = 0;
      if (task.has_burst_boost) {
        const base = (task.priority_tier === 'Admin') ? 30 : 20;
        p = base + Math.floor(elapsedSeconds / this.config.QUEUE_FAST_SLOPE_DIVISOR);
      } else {
        const tierConfig = this.tierConfigs[task.priority_tier] || this.tierConfigs['Normal'];
        p = tierConfig.basePriority + Math.floor(elapsedSeconds / this.config.QUEUE_BASE_SLOPE_DIVISOR);
      }

      task.effective_priority = p;
    });

    // Maintain authoritative sorting
    this.queue.sort((a, b) => {
      if (a.status === 'processing' && b.status !== 'processing') return -1;
      if (b.status === 'processing' && a.status !== 'processing') return 1;
      return b.effective_priority - a.effective_priority || a.timestamp - b.timestamp;
    });

    return stateChanged;
  }

  /**
   * Evaluates dynamic priority aging decays and transitions the head of the queue.
   *
   * @returns {object|null} The task promoted to 'processing', or null if queue is blocked/idle.
   */
  processQueue() {
    this.evaluatePriorities();

    const activeImageTask = this.queue.find(t => t.status === 'processing');
    if (activeImageTask) return activeImageTask;

    const pendingTasks = this.queue.filter(t => t.status === 'pending');
    if (pendingTasks.length === 0) return null;

    const nextTask = pendingTasks[0];
    nextTask.status = 'processing';
    nextTask.started_processing_at = Date.now();
    return nextTask;
  }

  /**
   * Places an authenticated client request into the Channel A generation queue.
   * Enforces 1-request-per-user limits on user_id / discord_id, terminating prior upstream sockets on collision.
   *
   * @param {object} taskOptions - Parameters defining the queue task.
   * @param {string} taskOptions.browser_id - Target browser footprint.
   * @param {string} taskOptions.req_id - Unique request tracking UUID.
   * @param {string} [taskOptions.tab_id] - Ephemeral tab tracking UUID.
   * @param {string} [taskOptions.priority_tier='Normal'] - Target priority tier.
   * @param {string|null} [taskOptions.discord_id=null] - Linked Discord identity.
   * @param {string|null} [taskOptions.user_id=null] - Canonical user identifier.
   * @returns {object} Registered task record in queue.
   * @throws {Error} If mandatory arguments are missing.
   */
  join({ browser_id, tab_id = null, req_id, priority_tier = 'Normal', discord_id = null, user_id = null }) {
    if (!browser_id || typeof browser_id !== 'string') {
      throw new Error("[Queue Error] browser_id is mandatory for queue registration.");
    }
    if (!req_id || typeof req_id !== 'string') {
      throw new Error("[Queue Error] req_id is mandatory for queue registration.");
    }

    const effectiveDiscordId = discord_id || (user_id && !user_id.startsWith('b_') ? user_id : null);
    const principalId = user_id || discord_id || browser_id;
    this.ping(browser_id);

    // 1-request-per-user limit: Check on canonical identity
    const existingIdx = this.queue.findIndex(t => {
      if (effectiveDiscordId && effectiveDiscordId !== 'admin') {
        if (t.discord_id === effectiveDiscordId || t.user_id === effectiveDiscordId) return true;
      }
      if (user_id && user_id !== 'admin' && t.user_id === user_id) return true;
      return t.browser_id === browser_id;
    });

    if (existingIdx !== -1) {
      const priorTask = this.queue[existingIdx];
      if (priorTask.upstreamReq) {
        try { priorTask.upstreamReq.destroy(); } catch (_) {}
      }
      const evictedTarget = priorTask.user_id || priorTask.discord_id || priorTask.browser_id;
      this.queue.splice(existingIdx, 1);
      console.log(`[VPS Telemetry] Concurrency eviction: Terminated active lock for user/device: ${evictedTarget}`);
    }

    const tierConfig = this.tierConfigs[priority_tier] || this.tierConfigs['Normal'];
    let hasBurstBoost = false;

    if (tierConfig.maxBurst === Infinity) {
      hasBurstBoost = true;
    } else {
      const bucket = this.getOrInitBucket(principalId, priority_tier);
      if (bucket && bucket.tokens >= 1.0) {
        bucket.tokens -= 1.0;
        hasBurstBoost = true;
        console.log(`[VPS Token Bucket] Allocated 1.0 token to Principal "${principalId}". Tokens remaining: ${bucket.tokens}`);
      } else {
        hasBurstBoost = false;
        console.log(`[VPS Token Bucket] Saturated bucket for Principal "${principalId}". Defaulting to Base Slope.`);
      }
    }

    const task = {
      browser_id,
      tab_id,
      req_id,
      user_id: principalId,
      discord_id: effectiveDiscordId,
      priority_tier,
      timestamp: Date.now(),
      last_polled_at: Date.now(),
      status: 'pending',
      started_processing_at: null,
      upstreamReq: null,
      has_burst_boost: hasBurstBoost,
      effective_priority: 0
    };

    this.queue.push(task);
    console.log(`[VPS Telemetry] Device "${browser_id}" (User: "${principalId}") joined queue. ReqId: "${req_id}". Tier: "${priority_tier}"`);
    this.processQueue();
    return task;
  }

  /**
   * Queries the progress status of a queued request.
   * Utilizes the authoritatively sorted array from the 5s garbage collector sweep to deduce
   * positions natively. Does not mutate states or trigger synchronous block-loops.
   *
   * @param {string} req_id - Target request UUID.
   * @param {string} browser_id - Hardware footprint enforcing query boundaries.
   * @returns {object|null} Evaluated polling status response, or null if missing/unauthorized.
   */
  poll(req_id, browser_id) {
    if (!browser_id) throw new Error("[Queue Error] browser_id is mandatory for polling.");

    const taskIndex = this.queue.findIndex(t => t.req_id === req_id && t.browser_id === browser_id);
    if (taskIndex === -1) return null;

    const task = this.queue[taskIndex];
    task.last_polled_at = Date.now();
    this.ping(browser_id);

    if (task.status === 'processing') {
      return { status: 'your_turn', task };
    }

    // Ockham's Razor: The queue is authoritatively sorted by the GC sweep every 5 seconds.
    // Index mapping natively provides the exact queue position without redundant CPU-blocking recalculations.
    const position = this.queue.filter(t => t.status === 'pending').findIndex(t => t.req_id === req_id) + 1;

    return {
      status: 'waiting',
      position,
      task
    };
  }

  /**
   * Releases an active generation lock, aborts any attached upstream socket, and promotes the next task.
   * Explicitly bound to browser_id to prevent unauthorized lock eviction sweeps.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @param {string} browser_id - Hardware footprint enforcing boundary limits.
   * @returns {boolean} True if task was found and purged; false otherwise.
   */
  complete(req_id, browser_id) {
    if (!browser_id) throw new Error("[Queue Error] browser_id is mandatory for completion.");
    
    const idx = this.queue.findIndex(t => t.req_id === req_id && t.browser_id === browser_id);
    if (idx !== -1) {
      const task = this.queue[idx];
      if (task.upstreamReq) {
        try { task.upstreamReq.destroy(); } catch (_) {}
      }
      this.queue.splice(idx, 1);
      console.log(`[VPS Telemetry] Task released from queue: "${req_id}"`);
      this.processQueue();
      return true;
    }
    return false;
  }

  /**
   * Authoritative eviction engine. Immediately finds all pending or active requests matching
   * a given browser footprint or Discord/user identity, destroys active upstream sockets, and promotes the queue.
   *
   * @param {object} target - Target identifiers.
   * @param {string} [target.browser_id] - Browser footprint to purge.
   * @param {string} [target.discord_id] - Discord identity to purge.
   * @param {string} [target.user_id] - Canonical user identity to purge.
   * @returns {number} Count of evicted tasks.
   */
  evict({ browser_id = null, discord_id = null, user_id = null }) {
    const targetUserId = user_id || discord_id;
    let evictedCount = 0;

    this.queue = this.queue.filter(t => {
      const matchDiscord = discord_id && (t.discord_id === discord_id || t.user_id === discord_id);
      const matchUser = targetUserId && (t.user_id === targetUserId || t.discord_id === targetUserId);
      const matchBrowser = browser_id && t.browser_id === browser_id;

      if (matchDiscord || matchUser || matchBrowser) {
        if (t.upstreamReq) {
          try { t.upstreamReq.destroy(); } catch (_) {}
        }
        evictedCount++;
        return false;
      }
      return true;
    });

    if (evictedCount > 0) {
      console.warn(`[VPS Queue Evict] Purged ${evictedCount} tasks for Browser: "${browser_id}", Discord/User: "${targetUserId}"`);
      this.processQueue();
    }
    return evictedCount;
  }

  /**
   * Retrieves an actively processing Channel A task if and only if credentials match.
   * Used as the authoritative gatekeeper in the proxy streaming pipeline.
   *
   * @param {string} req_id - Target request UUID.
   * @param {string} browser_id - Unique browser footprint.
   * @returns {object|null} Active task record or null if unverified.
   */
  getProcessingTask(req_id, browser_id) {
    return this.queue.find(t => t.req_id === req_id && t.browser_id === browser_id && t.status === 'processing') || null;
  }

  /**
   * Binds an active outbound upstream HTTP request to a processing queue task for lifecycle tracking.
   *
   * @param {string} req_id - Target request UUID.
   * @param {object} upstreamReq - Outbound Node.js ClientRequest handle.
   * @returns {boolean} True if task was found and socket bound; false if task does not exist.
   */
  attachUpstreamRequest(req_id, upstreamReq) {
    const task = this.queue.find(t => t.req_id === req_id);
    if (task) {
      task.upstreamReq = upstreamReq;
      return true;
    }
    return false;
  }

  /**
   * Single-cycle scavenger sweeper. Purges hung processing locks (>75s), dropped pending clients (>12s),
   * processes time-based priority bucket allocations, and evicts stale map entries to prevent OOM.
   *
   * @returns {boolean} True if queue state changed during sweep.
   */
  sweep() {
    const now = Date.now();
    let stateChanged = false;

    // 1. Evict stale presence maps to prevent catastrophic OOM leakage
    for (const [browserId, lastActive] of this.activeSessions.entries()) {
      if (now - lastActive > this.config.ACTIVE_SESSION_TTL_MS * 2) {
        this.activeSessions.delete(browserId);
      }
    }

    // 2. Evict dormant token buckets to prevent OOM (Buckets > 1hr old are fully refilled and safe to drop)
    for (const [principalId, bucket] of this.deviceBuckets.entries()) {
      if (now - bucket.lastTx > 3600000) {
        this.deviceBuckets.delete(principalId);
      }
    }
    
    // 3. Channel B: Zombie Text Lock Watchdog
    for (const [reqId, lockTimestamp] of this.activeTextLocks.entries()) {
      if (now - lockTimestamp > this.config.QUEUE_PROCESSING_TIMEOUT_MS) {
        this.activeTextLocks.delete(reqId);
        console.warn(`[Nai-Gateway GC] Purged zombie text generation lock. Freed Channel B slot for req: ${reqId}`);
      }
    }

    // 4. Ephemeral Diagnostic Debug Inspection Targets & Stale Intents Watchdog
    for (const [browserId, expiresAt] of this.debugTargets.entries()) {
      if (now > expiresAt) {
        this.debugTargets.delete(browserId);
        console.log(`[Nai-Gateway GC] Diagnostic debug authorization TTL expired for browser: "${browserId}". Revoked.`);
      }
    }

    for (const [browserId, timestamp] of this.debugIntents.entries()) {
      if (now - timestamp > 86400000) { // 24-hour retention ceiling for client debug intents
        this.debugIntents.delete(browserId);
      }
    }

    // 5. Queue state lifecycle bounds
    this.queue = this.queue.filter(t => {
      // Drop clients failing to poll within configured threshold
      if (t.status === 'pending' && (now - t.last_polled_at > this.config.QUEUE_POLL_TIMEOUT_MS)) {
        stateChanged = true;
        console.warn(`[Nai-Gateway GC] Discarding inactive pending client: BrowserId: ${t.browser_id}`);
        return false;
      }
      // Forcefully drop processing connections stuck/hung for over spec-configured TTL
      if (t.status === 'processing' && (now - t.started_processing_at > this.config.QUEUE_PROCESSING_TIMEOUT_MS)) {
        if (t.upstreamReq) {
          try { t.upstreamReq.destroy(); } catch (_) {}
        }
        stateChanged = true;
        console.warn(`[Nai-Gateway GC] Terminating hung generation lock. Extinguished active socket for: ${t.browser_id}`);
        return false;
      }
      return true;
    });

    const prioritiesChanged = this.evaluatePriorities(now);

    if (stateChanged || prioritiesChanged) {
      this.processQueue();
    }
    
    return stateChanged || prioritiesChanged;
  }

  /**
   * Starts the background scavenger sweeper interval.
   * Automatically unref's the interval so the process event loop terminates cleanly in tests.
   *
   * @param {number} [intervalMs] - Execution interval in milliseconds.
   */
  startGc(intervalMs = this.config.QUEUE_GC_INTERVAL_MS) {
    if (this.gcInterval) return;
    this.gcInterval = setInterval(() => {
      this.sweep();
    }, intervalMs);

    if (this.gcInterval.unref) {
      this.gcInterval.unref();
    }
  }

  /**
   * Stops the background scavenger sweeper interval.
   */
  stopGc() {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /**
   * Exposes total active queue length.
   *
   * @returns {number} Total tasks in queue.
   */
  getQueueLength() {
    return this.queue.length;
  }
}

// Canonical Singleton Instance initialized with system defaults
const queueManager = new QueueCoordinator();
queueManager.QueueCoordinator = QueueCoordinator;
queueManager.createQueueCoordinator = (cfg) => new QueueCoordinator(cfg);

module.exports = queueManager;