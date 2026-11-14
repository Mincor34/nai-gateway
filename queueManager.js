/**
 * QUEUE COORDINATOR & STATE ENGINE (queueManager.js)
 * Architecture Level 3: Imports Level 1 (config.js) only.
 *
 * DESIGN PRINCIPLES:
 * 1. Zero Event-Emitters: Eliminates non-deterministic microtask scheduling delays.
 *    All queue state transitions occur synchronously within a single event-loop tick.
 * 2. Strict Encapsulation: Protects Channel A (exclusive image queue), Channel B (shared
 *    text slots), burst token-buckets, session presence maps, active reservation holds,
 *    and diagnostic debug targets from ambient leakage.
 * 3. Immediate Socket Destruction: Abrupt disconnects, concurrency collisions, and GC
 *    sweeps immediately terminate upstream sockets via .destroy() to prevent ghost locks.
 * 4. Dual-Slope Priority Aging: Evaluates dynamic linear priority decay on-the-fly with
 *    step-function AUTO promotions at configured thresholds.
 * 5. Deterministic Eviction: Immediately purges all pending or processing tasks (and
 *    associated Channel A / Channel B reservation holds) matching a target browser footprint
 *    or canonical user identity upon policy or audit violations.
 * 6. Command Query Separation (CQS): Polling (read) operations compute theoretical 
 *    trajectories for telemetry. They NEVER mutate financial token states.
 * 7. Bilateral Ephemeral Diagnostics: Manages client-side debug intents and administrator
 *    inspection authorizations with deterministic millisecond TTL bounds swept automatically by the scavenger loop.
 * 8. Principal-Keyed Token Buckets: All burst token allocations and concurrency deduplications operate
 *    strictly on canonical user_id (Security Principal) while preserving deviceBuckets interface compatibility.
 * 9. ACS-1 Reservation Holds & Hydraulic Surplus Pool: Tracks cross-channel Anlas holds and V5 NCP
 *    reservations directly on task/lock records for synchronous teardown with fail-closed integer validation,
 *    and evaluates 24-hour Bucket 2 Cluster Surplus overwrite logic strictly in RAM.
 */

'use strict';

const { loadConfig, DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('./config');

const TWENTY_FOUR_HOURS_MS = 86400000;
const V5_HIGH_IMAGES_PER_PERCENT = 17.28;
const V5_HIGH_NCP_COST = 18;
const DAILY_SURPLUS_SMOOTHING_DIVISOR = 2;
const VALID_NCP_SOURCES = new Set(['personal', 'surplus']);

/**
 * Strictly validates discrete integer cost/compute quantities (fail-closed).
 * Rejects booleans, floats, NaN, Infinity, negative values, arrays, objects, and non-numbers.
 *
 * @param {*} value - Input candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {number} Validated non-negative safe integer.
 * @throws {Error} If value is not a valid non-negative safe integer.
 */
function assertNonNegativeSafeInt(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`[Queue Error] ${fieldName} must be a non-negative safe integer.`);
  }
  return value;
}

/**
 * Parses persisted SQLite config integers (stored as TEXT or INTEGER) strictly.
 * Accepts non-negative safe integers or canonical base-10 digit strings; rejects everything else.
 *
 * @param {*} value - Persisted value candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {number} Validated non-negative safe integer.
 * @throws {Error} If persisted representation is corrupt or non-integer.
 */
function parsePersistedNonNegativeInt(value, fieldName) {
  if (typeof value === 'number') {
    return assertNonNegativeSafeInt(value, fieldName);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  throw new Error(`[Queue Error] Persisted ${fieldName} must be a non-negative safe integer or decimal string.`);
}

/**
 * Validates V5 NCP reservation source identifiers (fail-closed).
 *
 * @param {*} source - Candidate source string or null.
 * @returns {'personal'|'surplus'|null} Validated source or null.
 * @throws {Error} If source is neither null nor a recognized bucket identifier.
 */
function assertValidNcpSource(source) {
  if (source === null) return null;
  if (typeof source === 'string' && VALID_NCP_SOURCES.has(source)) {
    return source;
  }
  throw new Error('[Queue Error] held_ncp_source must be "personal", "surplus", or null.');
}

/**
 * Validates a projected battery percentage strictly within [0, 100].
 * Out-of-bounds (< 0 or > 100), non-numeric, or non-finite values fail closed as null
 * so hallucinated telemetry cannot mint phantom surplus compute or clear the pool.
 *
 * @param {*} value - Input battery percentage candidate.
 * @returns {number|null} Validated percentage [0..100] or null if unavailable/invalid.
 */
function validateBatteryPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value;
}

/**
 * Resolves a finite non-negative epoch timestamp, defaulting to Date.now().
 *
 * @param {*} candidate - Input timestamp candidate.
 * @returns {number} Validated epoch timestamp in ms.
 */
function resolveTimestamp(candidate) {
  return (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0)
    ? candidate
    : Date.now();
}

/**
 * Validates that an identifier is a non-empty, non-whitespace string.
 *
 * @param {*} value - Identifier candidate.
 * @returns {boolean} True if valid non-blank string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

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
   * if booted in isolated test harnesses or given partial configuration objects.
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
      const merged = {
        TIER_CONFIGS: DEFAULT_TIER_CONFIGS,
        ...OPERATIONAL_DEFAULTS
      };
      for (const [key, val] of Object.entries(config)) {
        if (val !== undefined) {
          merged[key] = val;
        }
      }
      this.config = merged;
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
    this.activeTextLocks = new Map();  // req_id -> { timestamp, user_id, held_cost }
    this.debugTargets = new Map();     // browser_id -> expires_at
    this.debugIntents = new Map();     // browser_id -> timestamp
    this.v5SurplusPool = 0;            // RAM mirror of Cluster Surplus Pool (Bucket 2) in NCP
    this.v5SurplusLastAccrual = null;  // Epoch ms of last 24h Bucket 2 surplus evaluation (null = never accrued)
    this.telemetryProvider = null;     // Optional () => number callback injected by Level 5
    this.onSurplusAccrual = null;      // Optional (newPoolNcp, accrualEpoch) => void persistence hook
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
    if (!isNonEmptyString(browserId)) return;
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
    if (!isNonEmptyString(browserId)) return false;
    return this.debugIntents.has(browserId);
  }

  /**
   * Authorizes a device browser footprint for temporary verbose telemetry inspection.
   *
   * @param {string} browserId - Target device browser footprint.
   * @param {number} [ttlMs=600000] - Duration of authorized inspection in milliseconds (default: 10m).
   */
  setDebugTarget(browserId, ttlMs = 600000) {
    if (!isNonEmptyString(browserId)) return;
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
   * @param {number} [now=Date.now()] - Optional validated epoch timestamp for clock synchronization.
   * @returns {object|null} Evaluated bucket reference or null if tier is exempt.
   */
  getOrInitBucket(principalId, tier, now = Date.now()) {
    const tierConfig = this.tierConfigs[tier];
    if (!tierConfig || tierConfig.maxBurst === Infinity) return null;

    let bucket = this.deviceBuckets.get(principalId);
    const safeNow = resolveTimestamp(now);

    if (!bucket) {
      bucket = {
        tokens: tierConfig.maxBurst,
        lastTx: safeNow
      };
      this.deviceBuckets.set(principalId, bucket);
    } else {
      const elapsed = safeNow - bucket.lastTx;
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
   * @param {number} [now=Date.now()] - Optional validated epoch timestamp.
   */
  ping(browserId, now = Date.now()) {
    if (isNonEmptyString(browserId)) {
      this.activeSessions.set(browserId, resolveTimestamp(now));
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
   * Attempts to claim a non-blocking shared Channel B text/vibe slot.
   * Tracks allocation by request ID with principal identity and Anlas reservation hold
   * to prevent zombie lock leaks, cross-channel double-spends, and overlapping ID exploits.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @param {string|null} [user_id=null] - Canonical user_id holding the lock.
   * @param {number} [held_cost=0] - Non-negative integer Anlas reservation hold associated with this slot.
   * @param {number} [now=Date.now()] - Optional epoch timestamp for deterministic simulation.
   * @returns {boolean} True if slot allocated; false if pipelines are saturated or ID invalid/overlaps.
   * @throws {Error} If held_cost is not a non-negative safe integer or user_id is invalid.
   */
  acquireTextSlot(req_id, user_id = null, held_cost = 0, now = Date.now()) {
    if (!isNonEmptyString(req_id)) {
      return false;
    }
    const validatedCost = assertNonNegativeSafeInt(held_cost, 'held_cost');
    if (user_id !== null && !isNonEmptyString(user_id)) {
      throw new Error('[Queue Error] user_id must be a non-empty string or null.');
    }

    // protection against map key-collision concurrency bypasses
    if (this.activeTextLocks.has(req_id)) {
      console.warn(`[VPS Security] Channel B Concurrency Bypass Attempt: Overlapping lock ID detected ("${req_id}"). Rejecting.`);
      return false;
    }
    const maxConcurrent = Number.isFinite(this.config.MAX_CONCURRENT_TEXT_GENS)
      ? this.config.MAX_CONCURRENT_TEXT_GENS
      : OPERATIONAL_DEFAULTS.MAX_CONCURRENT_TEXT_GENS;
    if (this.activeTextLocks.size >= maxConcurrent) {
      return false;
    }

    this.activeTextLocks.set(req_id, {
      timestamp: resolveTimestamp(now),
      user_id: user_id || null,
      held_cost: validatedCost
    });
    return true;
  }

  /**
   * Releases a previously claimed Channel B slot and clears its reservation hold securely by ID.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @returns {boolean} True if slot was active and released; false otherwise.
   */
  releaseTextSlot(req_id) {
    const lock = this.activeTextLocks.get(req_id);
    if (lock && typeof lock === 'object') {
      lock.held_cost = 0;
    }
    return this.activeTextLocks.delete(req_id);
  }

  /**
   * Retrieves a structured Channel B lock record for inspection.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @returns {{timestamp: number, user_id: string|null, held_cost: number}|null} Lock record or null.
   */
  getTextLock(req_id) {
    return this.activeTextLocks.get(req_id) || null;
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
   * @param {number} [now=Date.now()] - Epoch timestamp.
   * @returns {boolean} True if state mutated (tokens deducted or boosts applied).
   */
  evaluatePriorities(now = Date.now()) {
    const safeNow = resolveTimestamp(now);
    let stateChanged = false;
    const pendingTasks = this.queue.filter(t => t.status === 'pending');

    pendingTasks.forEach(task => {
      const elapsedSeconds = Math.max(0, (safeNow - task.timestamp) / 1000);
      const targetPrincipal = task.user_id || task.discord_id || task.browser_id;

      // Dynamic Step-Function Jump (AUTO state promotion)
      if (!task.has_burst_boost && elapsedSeconds >= this.config.QUEUE_AUTO_BOOST_SECONDS) {
        const bucket = this.getOrInitBucket(targetPrincipal, task.priority_tier, safeNow);
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
   * Promotes the highest-priority pending task to 'processing' if the Channel A lock is idle.
   *
   * @param {number} [now=Date.now()] - Validated epoch timestamp.
   * @returns {object|null} The active or newly promoted processing task, or null if idle.
   */
  _promoteHeadTask(now = Date.now()) {
    const activeImageTask = this.queue.find(t => t.status === 'processing');
    if (activeImageTask) return activeImageTask;

    const pendingTasks = this.queue.filter(t => t.status === 'pending');
    if (pendingTasks.length === 0) return null;

    const nextTask = pendingTasks[0];
    nextTask.status = 'processing';
    nextTask.started_processing_at = resolveTimestamp(now);
    return nextTask;
  }

  /**
   * Evaluates dynamic priority aging decays and transitions the head of the queue.
   *
   * @param {number} [now=Date.now()] - Epoch timestamp.
   * @returns {object|null} The task promoted to 'processing', or null if queue is blocked/idle.
   */
  processQueue(now = Date.now()) {
    const safeNow = resolveTimestamp(now);
    this.evaluatePriorities(safeNow);
    return this._promoteHeadTask(safeNow);
  }

  /**
   * Places an authenticated client request into the Channel A generation queue.
   * Enforces 1-request-per-user limits on user_id / discord_id, rejects duplicate req_id collisions,
   * validates identity and reservation holds strictly (fail-closed), terminates prior upstream sockets,
   * and expunges prior in-memory reservation holds on collision.
   *
   * @param {object} taskOptions - Parameters defining the queue task.
   * @param {string} taskOptions.browser_id - Target browser footprint.
   * @param {string} taskOptions.req_id - Unique request tracking UUID.
   * @param {string} [taskOptions.tab_id] - Ephemeral tab tracking UUID.
   * @param {string} [taskOptions.priority_tier='Normal'] - Target priority tier.
   * @param {string|null} [taskOptions.discord_id=null] - Linked Discord identity.
   * @param {string|null} [taskOptions.user_id=null] - Canonical user identifier.
   * @param {number} [taskOptions.held_cost=0] - Active Anlas reservation hold bound to this task.
   * @param {number} [taskOptions.held_ncp=0] - Active V5 NCP reservation hold bound to this task.
   * @param {'personal'|'surplus'|null} [taskOptions.held_ncp_source=null] - V5 bucket funding this reservation.
   * @param {number} [taskOptions.now=Date.now()] - Optional epoch timestamp for deterministic simulation.
   * @returns {object} Registered task record in queue.
   * @throws {Error} If mandatory/identity arguments are invalid, req_id collides, or hold parameters are invalid.
   */
  join({
    browser_id,
    tab_id = null,
    req_id,
    priority_tier = 'Normal',
    discord_id = null,
    user_id = null,
    held_cost = 0,
    held_ncp = 0,
    held_ncp_source = null,
    now = Date.now()
  }) {
    if (!isNonEmptyString(browser_id)) {
      throw new Error("[Queue Error] browser_id is mandatory for queue registration.");
    }
    if (!isNonEmptyString(req_id)) {
      throw new Error("[Queue Error] req_id is mandatory for queue registration.");
    }
    if (user_id !== null && !isNonEmptyString(user_id)) {
      throw new Error('[Queue Error] user_id must be a non-empty string or null.');
    }
    if (discord_id !== null && !isNonEmptyString(discord_id)) {
      throw new Error('[Queue Error] discord_id must be a non-empty string or null.');
    }
    if (this.queue.some(t => t.req_id === req_id)) {
      throw new Error(`[Queue Error] Overlapping req_id "${req_id}" detected in Channel A queue.`);
    }

    const validatedCost = assertNonNegativeSafeInt(held_cost, 'held_cost');
    const validatedNcp = assertNonNegativeSafeInt(held_ncp, 'held_ncp');
    const validatedSource = assertValidNcpSource(held_ncp_source);

    if (validatedNcp > 0 && !validatedSource) {
      throw new Error('[Queue Error] held_ncp_source ("personal" or "surplus") is required when held_ncp > 0.');
    }
    if (validatedNcp === 0 && validatedSource !== null) {
      throw new Error('[Queue Error] held_ncp_source must be null when held_ncp is 0.');
    }

    const safeNow = resolveTimestamp(now);
    const effectiveDiscordId = discord_id || (user_id && !user_id.startsWith('b_') ? user_id : null);
    const principalId = user_id || discord_id || browser_id;
    this.ping(browser_id, safeNow);

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
      priorTask.held_cost = 0;
      priorTask.held_ncp = 0;
      priorTask.held_ncp_source = null;
      const evictedTarget = priorTask.user_id || priorTask.discord_id || priorTask.browser_id;
      this.queue.splice(existingIdx, 1);
      console.log(`[VPS Telemetry] Concurrency eviction: Terminated active lock for user/device: ${evictedTarget}`);
    }

    const tierConfig = this.tierConfigs[priority_tier] || this.tierConfigs['Normal'];
    let hasBurstBoost = false;

    if (tierConfig.maxBurst === Infinity) {
      hasBurstBoost = true;
    } else {
      const bucket = this.getOrInitBucket(principalId, priority_tier, safeNow);
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
      timestamp: safeNow,
      last_polled_at: safeNow,
      status: 'pending',
      started_processing_at: null,
      upstreamReq: null,
      has_burst_boost: hasBurstBoost,
      effective_priority: 0,
      held_cost: validatedCost,
      held_ncp: validatedNcp,
      held_ncp_source: validatedSource
    };

    this.queue.push(task);
    console.log(`[VPS Telemetry] Device "${browser_id}" (User: "${principalId}") joined queue. ReqId: "${req_id}". Tier: "${priority_tier}"`);
    this.processQueue(safeNow);
    return task;
  }

  /**
   * Re-anchors the execution TTL clock for an actively processing Channel A task.
   * Invoked at the exact millisecond client payload buffering completes and upstream
   * dispatch begins, granting NovelAI the full unpenalized 75s GPU processing window.
   *
   * @param {string} req_id - Target request UUID.
   * @param {number} [now=Date.now()] - Optional non-negative timestamp override for deterministic tests.
   * @returns {boolean} True if an active processing task was re-anchored; false otherwise.
   */
  reanchorProcessingTimestamp(req_id, now = Date.now()) {
    if (!isNonEmptyString(req_id)) return false;
    const task = this.queue.find(t => t.req_id === req_id && t.status === 'processing');
    if (!task) return false;
    task.started_processing_at = resolveTimestamp(now);
    return true;
  }

  /**
   * Updates in-memory reservation hold metadata on an existing Channel A task.
   * Enforces fail-closed validation and held_ncp / held_ncp_source consistency atomically.
   * Setting held_ncp to 0 without an explicit conflicting held_ncp_source clears held_ncp_source to null.
   *
   * @param {string} req_id - Target request UUID.
   * @param {string} browser_id - Hardware footprint enforcing boundary limits.
   * @param {object} [holds={}] - Hold fields to update.
   * @param {number} [holds.held_cost] - Updated Anlas reservation hold.
   * @param {number} [holds.held_ncp] - Updated V5 NCP reservation hold.
   * @param {'personal'|'surplus'|null} [holds.held_ncp_source] - Updated V5 NCP source.
   * @returns {boolean} True if task was found and updated; false otherwise.
   * @throws {Error} If holds is non-object, or any supplied hold value is invalid or violates held_ncp/source invariants.
   */
  setTaskHold(req_id, browser_id, holds = {}) {
    if (holds === null || typeof holds !== 'object' || Array.isArray(holds)) {
      throw new Error('[Queue Error] holds must be a plain object.');
    }
    if (!isNonEmptyString(req_id) || !isNonEmptyString(browser_id)) return false;
    const task = this.queue.find(t => t.req_id === req_id && t.browser_id === browser_id);
    if (!task) return false;

    const { held_cost, held_ncp, held_ncp_source } = holds;
    const nextCost = held_cost !== undefined ? assertNonNegativeSafeInt(held_cost, 'held_cost') : task.held_cost;
    const nextNcp = held_ncp !== undefined ? assertNonNegativeSafeInt(held_ncp, 'held_ncp') : task.held_ncp;
    let nextSource = held_ncp_source !== undefined ? assertValidNcpSource(held_ncp_source) : task.held_ncp_source;

    if (nextNcp === 0) {
      if (held_ncp_source !== undefined && nextSource !== null) {
        throw new Error('[Queue Error] held_ncp_source must be null when held_ncp is 0.');
      }
      nextSource = null;
    } else if (!nextSource) {
      throw new Error('[Queue Error] held_ncp_source ("personal" or "surplus") is required when held_ncp > 0.');
    }

    task.held_cost = nextCost;
    task.held_ncp = nextNcp;
    task.held_ncp_source = nextSource;

    return true;
  }

  /**
   * Clears all Anlas and V5 NCP reservation holds on an active Channel A task.
   *
   * @param {string} req_id - Target request UUID.
   * @param {string} browser_id - Hardware footprint enforcing boundary limits.
   * @returns {boolean} True if task was found and cleared; false otherwise.
   */
  clearTaskHold(req_id, browser_id) {
    if (!isNonEmptyString(req_id) || !isNonEmptyString(browser_id)) return false;
    const task = this.queue.find(t => t.req_id === req_id && t.browser_id === browser_id);
    if (!task) return false;

    task.held_cost = 0;
    task.held_ncp = 0;
    task.held_ncp_source = null;
    return true;
  }

  /**
   * Computes total active in-memory Anlas holds for a given canonical user across
   * both Channel A (queue tasks) and Channel B (activeTextLocks).
   *
   * @param {string} userId - Canonical user_id.
   * @returns {number} Sum of held Anlas across all active channels.
   */
  getHeldAnlasForUser(userId) {
    if (!isNonEmptyString(userId)) return 0;
    let total = 0;

    for (const task of this.queue) {
      if (task.user_id === userId && Number.isFinite(task.held_cost) && task.held_cost > 0) {
        total += task.held_cost;
      }
    }

    for (const lock of this.activeTextLocks.values()) {
      if (lock && lock.user_id === userId && Number.isFinite(lock.held_cost) && lock.held_cost > 0) {
        total += lock.held_cost;
      }
    }

    return total;
  }

  /**
   * Computes total active in-memory V5 NCP holds for a given canonical user.
   *
   * @param {string} userId - Canonical user_id.
   * @param {'personal'|'surplus'|null} [source=null] - Optional bucket filter.
   * @returns {number} Sum of held V5 NCP.
   */
  getHeldNcpForUser(userId, source = null) {
    if (!isNonEmptyString(userId)) return 0;
    let total = 0;

    for (const task of this.queue) {
      if (task.user_id === userId && Number.isFinite(task.held_ncp) && task.held_ncp > 0) {
        if (!source || task.held_ncp_source === source) {
          total += task.held_ncp;
        }
      }
    }

    return total;
  }

  /**
   * Computes total in-memory V5 NCP holds currently reserved against the Cluster Surplus Pool (Bucket 2).
   *
   * @returns {number} Total held surplus NCP across all queued/processing tasks.
   */
  getHeldSurplusNcp() {
    let total = 0;
    for (const task of this.queue) {
      if (task.held_ncp_source === 'surplus' && Number.isFinite(task.held_ncp) && task.held_ncp > 0) {
        total += task.held_ncp;
      }
    }
    return total;
  }

  /**
   * Queries the progress status of a queued request.
   * Utilizes the authoritatively sorted array from the 5s garbage collector sweep to deduce
   * positions natively. Does not mutate states or trigger synchronous block-loops.
   *
   * @param {string} req_id - Target request UUID.
   * @param {string} browser_id - Hardware footprint enforcing query boundaries.
   * @param {number} [now=Date.now()] - Optional validated epoch timestamp for deterministic simulation.
   * @returns {object|null} Evaluated polling status response, or null if missing/unauthorized.
   */
  poll(req_id, browser_id, now = Date.now()) {
    if (!isNonEmptyString(browser_id)) throw new Error("[Queue Error] browser_id is mandatory for polling.");
    if (!isNonEmptyString(req_id)) return null;

    const taskIndex = this.queue.findIndex(t => t.req_id === req_id && t.browser_id === browser_id);
    if (taskIndex === -1) return null;

    const task = this.queue[taskIndex];
    const safeNow = resolveTimestamp(now);
    task.last_polled_at = safeNow;
    this.ping(browser_id, safeNow);

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
   * Releases an active generation lock, clears its reservation holds, aborts any attached
   * upstream socket, and promotes the next task.
   * Explicitly bound to browser_id to prevent unauthorized lock eviction sweeps.
   *
   * @param {string} req_id - Unique request tracking UUID.
   * @param {string} browser_id - Hardware footprint enforcing boundary limits.
   * @returns {boolean} True if task was found and purged; false otherwise.
   */
  complete(req_id, browser_id) {
    if (!isNonEmptyString(browser_id)) throw new Error("[Queue Error] browser_id is mandatory for completion.");
    if (!isNonEmptyString(req_id)) return false;

    const idx = this.queue.findIndex(t => t.req_id === req_id && t.browser_id === browser_id);
    if (idx !== -1) {
      const task = this.queue[idx];
      if (task.upstreamReq) {
        try { task.upstreamReq.destroy(); } catch (_) {}
      }
      task.held_cost = 0;
      task.held_ncp = 0;
      task.held_ncp_source = null;
      this.queue.splice(idx, 1);
      console.log(`[VPS Telemetry] Task released from queue: "${req_id}"`);
      this.processQueue();
      return true;
    }
    return false;
  }

  /**
   * Authoritative eviction engine. Immediately finds all pending or active Channel A tasks
   * and Channel B locks matching a given browser footprint or Discord/user identity,
   * destroys active upstream sockets, expunges all reservation holds, and promotes the queue.
   * Note: Channel B locks carry canonical user_id only; callers evicting a user across channels
   * must pass user_id or discord_id when no Channel A task bridges browser_id to user_id.
   *
   * @param {object} [target={}] - Target identifiers.
   * @param {string} [target.browser_id] - Browser footprint to purge.
   * @param {string} [target.discord_id] - Discord identity to purge.
   * @param {string} [target.user_id] - Canonical user identity to purge.
   * @returns {number} Count of evicted tasks and locks.
   */
  evict({ browser_id = null, discord_id = null, user_id = null } = {}) {
    const targetUserId = user_id || discord_id;
    let evictedQueueCount = 0;
    let evictedTextCount = 0;
    const matchedTaskUserIds = new Set();

    this.queue = this.queue.filter(t => {
      const matchDiscord = discord_id && (t.discord_id === discord_id || t.user_id === discord_id);
      const matchUser = targetUserId && (t.user_id === targetUserId || t.discord_id === targetUserId);
      const matchBrowser = browser_id && t.browser_id === browser_id;

      if (matchDiscord || matchUser || matchBrowser) {
        if (t.upstreamReq) {
          try { t.upstreamReq.destroy(); } catch (_) {}
        }
        if (t.user_id) {
          matchedTaskUserIds.add(t.user_id);
        }
        t.held_cost = 0;
        t.held_ncp = 0;
        t.held_ncp_source = null;
        evictedQueueCount++;
        return false;
      }
      return true;
    });

    for (const [reqId, lock] of this.activeTextLocks.entries()) {
      const lockUser = lock && lock.user_id;
      if (
        lockUser &&
        (
          (targetUserId && lockUser === targetUserId) ||
          (discord_id && lockUser === discord_id) ||
          (browser_id && lockUser === browser_id) ||
          matchedTaskUserIds.has(lockUser)
        )
      ) {
        lock.held_cost = 0;
        this.activeTextLocks.delete(reqId);
        evictedTextCount++;
      }
    }

    const totalEvicted = evictedQueueCount + evictedTextCount;
    if (totalEvicted > 0) {
      console.warn(`[VPS Queue Evict] Purged ${evictedQueueCount} Channel A tasks and ${evictedTextCount} Channel B locks for Browser: "${browser_id}", Discord/User: "${targetUserId}"`);
    }
    if (evictedQueueCount > 0) {
      this.processQueue();
    }
    return totalEvicted;
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
   * Registers an external dynamic battery projection callback (Level 5 telemetry injection).
   *
   * @param {Function|null} providerFn - Callback returning current projected battery percentage [0..100].
   */
  setTelemetryProvider(providerFn) {
    this.telemetryProvider = typeof providerFn === 'function' ? providerFn : null;
  }

  /**
   * Resolves the current projected master battery percentage from the registered telemetry provider.
   * Fails closed (returns null) if no provider is registered, if the provider throws,
   * or if the returned percentage is outside [0, 100] or non-numeric.
   *
   * @returns {number|null} Validated battery percentage [0..100] or null if unavailable.
   */
  getProjectedBatteryPercent() {
    if (!this.telemetryProvider) {
      return null;
    }
    try {
      return validateBatteryPercent(this.telemetryProvider());
    } catch (err) {
      console.warn('[VPS Surplus] Telemetry provider exception:', err && err.message ? err.message : err);
      return null;
    }
  }

  /**
   * Hydrates the Bucket 2 Cluster Surplus Pool RAM mirror from persistent startup storage.
   * Accepts both numeric integers and SQLite TEXT decimal strings for pool and epoch.
   * Epoch 0 (the database schema default) represents "never accrued" (null internally).
   *
   * @param {number|string} poolNcp - Persisted surplus pool balance in NCP.
   * @param {number|string|null} lastAccrualEpoch - Persisted epoch ms of last 24h accrual.
   * @throws {Error} If persisted values are corrupt or non-integer.
   */
  hydrateSurplusPool(poolNcp, lastAccrualEpoch) {
    const parsedPool = parsePersistedNonNegativeInt(poolNcp, 'v5_surplus_pool');
    let parsedEpoch = null;
    if (lastAccrualEpoch !== null && lastAccrualEpoch !== undefined) {
      const epochInt = parsePersistedNonNegativeInt(lastAccrualEpoch, 'v5_surplus_last_accrual');
      parsedEpoch = epochInt > 0 ? epochInt : null;
    }
    this.v5SurplusPool = parsedPool;
    this.v5SurplusLastAccrual = parsedEpoch;
  }

  /**
   * Registers a callback invoked synchronously whenever sweep() executes a 24h Bucket 2 accrual.
   * Allows higher architectural layers to persist RAM pool updates without coupling Level 3 to SQLite.
   *
   * @param {Function|null} callback - Handler receiving (newPoolNcp, accrualEpoch).
   */
  setOnSurplusAccrual(callback) {
    this.onSurplusAccrual = typeof callback === 'function' ? callback : null;
  }

  /**
   * Retrieves the current Bucket 2 Cluster Surplus Pool RAM state.
   *
   * @returns {{pool: number, lastAccrual: number}} Current surplus NCP balance and last accrual epoch (0 if uninitialized).
   */
  getSurplusPool() {
    return {
      pool: this.v5SurplusPool,
      lastAccrual: this.v5SurplusLastAccrual !== null ? this.v5SurplusLastAccrual : 0
    };
  }

  /**
   * Computes remaining spendable Bucket 2 surplus NCP after deducting active in-memory holds.
   *
   * @returns {number} Spendable surplus NCP.
   */
  getAvailableSurplusNcp() {
    return Math.max(0, this.v5SurplusPool - this.getHeldSurplusNcp());
  }

  /**
   * Commits an integer NCP deduction against the RAM Cluster Surplus Pool mirror.
   *
   * @param {number} ncp - Non-negative integer NCP to deduct.
   * @returns {number} Updated surplus pool balance in NCP.
   * @throws {Error} If ncp is not a non-negative safe integer.
   */
  deductSurplusPool(ncp) {
    const safeNcp = assertNonNegativeSafeInt(ncp, 'ncp');
    this.v5SurplusPool = Math.max(0, this.v5SurplusPool - safeNcp);
    return this.v5SurplusPool;
  }

  /**
   * Evaluates synchronous 24-hour Bucket 2 (Cluster Surplus Pool) replacement logic in RAM.
   * Strictly overwrites (never accumulates) the pool with smoothed daily surplus compute
   * when projected master capacity exceeds V5_SURPLUS_THRESHOLD_PERCENT (50%), or clears
   * to 0 when at/below threshold.
   *
   * @param {number} now - Current epoch timestamp in ms.
   * @param {number|null|undefined} [batteryOverride=undefined] - Optional explicit battery percentage override [0..100].
   * @returns {boolean} True if 24-hour accrual boundary elapsed and pool was evaluated.
   */
  evaluateSurplusPool(now, batteryOverride = undefined) {
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
      return false;
    }

    const hasOverride = batteryOverride !== undefined;
    const batteryPct = hasOverride
      ? validateBatteryPercent(batteryOverride)
      : this.getProjectedBatteryPercent();

    if (batteryPct === null) {
      return false;
    }

    if (this.v5SurplusLastAccrual !== null && (now - this.v5SurplusLastAccrual < TWENTY_FOUR_HOURS_MS)) {
      return false;
    }

    const rawThreshold = this.config.V5_SURPLUS_THRESHOLD_PERCENT;
    const threshold = (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 100)
      ? rawThreshold
      : 50.0;

    let newPool = 0;
    if (batteryPct > threshold) {
      newPool = Math.floor(
        ((batteryPct - threshold) * V5_HIGH_IMAGES_PER_PERCENT * V5_HIGH_NCP_COST) / DAILY_SURPLUS_SMOOTHING_DIVISOR
      );
    }

    // Overwrite pool strictly (no additive stacking across cycles)
    this.v5SurplusPool = newPool;
    this.v5SurplusLastAccrual = now;

    if (this.onSurplusAccrual) {
      try {
        const maybePromise = this.onSurplusAccrual(newPool, now);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch((err) => {
            console.error('[VPS Surplus] Async persistence hook failed:', err && err.message ? err.message : err);
          });
        }
      } catch (err) {
        console.error('[VPS Surplus] Sync persistence hook failed:', err && err.message ? err.message : err);
      }
    }

    return true;
  }

  /**
   * Single-cycle scavenger sweeper. Purges hung processing locks (>75s), dropped pending clients (>12s),
   * purges zombie Channel B locks, expunges associated reservation holds, processes time-based priority
   * bucket allocations, evaluates 24-hour Bucket 2 Cluster Surplus replacement, and evicts stale map entries.
   *
   * @param {object} [options={}] - Optional sweep evaluation overrides (for deterministic simulation).
   * @param {number} [options.now] - Simulated epoch timestamp in ms.
   * @param {number|null} [options.batteryPercent] - Simulated master battery percentage [0..100].
   * @returns {boolean} True if queue, lock, priority, or surplus state changed during sweep.
   */
  sweep(options = {}) {
    const now = (options && typeof options.now === 'number' && Number.isFinite(options.now) && options.now >= 0)
      ? options.now
      : Date.now();
    const hasBatteryOverride = Boolean(
      options &&
      typeof options === 'object' &&
      Object.prototype.hasOwnProperty.call(options, 'batteryPercent') &&
      options.batteryPercent !== undefined
    );
    const batteryOverride = hasBatteryOverride ? options.batteryPercent : undefined;
    let queueChanged = false;
    let textLocksChanged = false;

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

    // 3. Channel B: Zombie Text Lock Watchdog (expunges stale locks and held_cost)
    for (const [reqId, lockRecord] of this.activeTextLocks.entries()) {
      const lockTimestamp = (typeof lockRecord === 'object' && lockRecord !== null) ? lockRecord.timestamp : lockRecord;
      if (now - lockTimestamp > this.config.QUEUE_PROCESSING_TIMEOUT_MS) {
        if (typeof lockRecord === 'object' && lockRecord !== null) {
          lockRecord.held_cost = 0;
        }
        this.activeTextLocks.delete(reqId);
        textLocksChanged = true;
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

    // 5. Queue state lifecycle bounds (expunges associated Channel A reservation holds)
    this.queue = this.queue.filter(t => {
      // Drop clients failing to poll within configured threshold
      if (t.status === 'pending' && (now - t.last_polled_at > this.config.QUEUE_POLL_TIMEOUT_MS)) {
        t.held_cost = 0;
        t.held_ncp = 0;
        t.held_ncp_source = null;
        queueChanged = true;
        console.warn(`[Nai-Gateway GC] Discarding inactive pending client: BrowserId: ${t.browser_id}`);
        return false;
      }
      // Forcefully drop processing connections stuck/hung for over spec-configured TTL
      if (t.status === 'processing' && (now - t.started_processing_at > this.config.QUEUE_PROCESSING_TIMEOUT_MS)) {
        if (t.upstreamReq) {
          try { t.upstreamReq.destroy(); } catch (_) {}
        }
        t.held_cost = 0;
        t.held_ncp = 0;
        t.held_ncp_source = null;
        queueChanged = true;
        console.warn(`[Nai-Gateway GC] Terminating hung generation lock. Extinguished active socket for: ${t.browser_id}`);
        return false;
      }
      return true;
    });

    // 6. Synchronous Bucket 2 (Cluster Surplus Pool) 24h replacement
    const surplusUpdated = this.evaluateSurplusPool(now, batteryOverride);

    const prioritiesChanged = this.evaluatePriorities(now);

    if (queueChanged || prioritiesChanged) {
      this._promoteHeadTask(now);
    }

    return queueChanged || textLocksChanged || prioritiesChanged || surplusUpdated;
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