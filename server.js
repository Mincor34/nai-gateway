/**
 * LEVEL 5: SERVICE ORCHESTRATOR & BOOTSTRAPPER (server.js)
 *
 * Implements:
 * - Unidirectional architecture routing
 * - Global IP hashing middleware
 * - Stream-safe unparsed /proxy mount
 * - Post-stream standard body-parsers for /auth, /queue, /admin
 * - Resilient warm-boot telemetry harvester with shared Promise deduplication
 * - ACS-1 dynamic timeUntilNextPercent normalization, weighted V5 dispatch projection,
 *   adaptive polling escalation (10m -> 2m -> 60s floor), and 5.5% circuit breaker
 * - Cold-to-warm V5 personal reserve seeding (`seedApprovedUserV5Ledgers`) for pre-existing
 *   approved principals so offline users do not lose multi-day rollover days post-deploy
 * - Authoritative master subscription billing-cycle tracking (active, tier, expiresAt,
 *   isGracePeriod, trainingStepsLeft) with SQLite config + `subscription_periods` persistence
 * - Explicit master_token_expired clearing of stale cached capacity on upstream 401
 * - Bucket 2 surplus pool hydration, clamped [0, 100] telemetry injection, and unified
 *   retry-safe SQLite persistence across 24h sweeps and PoNR deductions
 */

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const database = require('./database');
const queueManager = require('./queueManager');
const {
  isV5ModelFamily,
  isV5MediumModel,
  recordSubscriptionPeriod,
  evaluateV5Accrual
} = require('./auditEngine');

// Route Controllers (Level 4)
const proxyRouter = require('./routes/proxyRouter');
const authRouter = require('./routes/authRouter');
const queueRouter = require('./routes/queueRouter');
const adminRouter = require('./routes/adminRouter');

const app = express();

// IP Telemetry Cryptographic Salt
const IP_SALT = crypto.randomBytes(16).toString('hex');

// ACS-1 Telemetry Projection & Polling Constants
const SECONDS_PER_DAY = 86400;
const MIN_CYCLE_ADVANCE_SEC = 15 * SECONDS_PER_DAY;
const OPUS_MIN_TIER = 3;
const V5_HIGH_IMAGES_PER_PERCENT = 17.28;
const V5_MEDIUM_DISPATCH_WEIGHT = 0.557;
const TELEMETRY_PERIOD_MIN_SEC = 1800;
const TELEMETRY_PERIOD_MAX_SEC = 10000;
const C_BASE_MIN = 100.0;
const C_BASE_MAX = 300.0;
const POLL_HIGH_BATTERY_MS = 600000; // 10 minutes (> 30%)
const POLL_MID_BATTERY_MS = 120000;  // 2 minutes (15% - 30%)
const POLL_LOW_BATTERY_MS = 60000;   // 60 seconds floor (<= 15%)
const SURPLUS_PERSIST_MAX_RETRIES = 3;
const CYCLE_PERSIST_MAX_RETRIES = 3;

const bootConfig = loadConfig(process.env);

function getRuntimeConfig() {
  return loadConfig(process.env);
}

/**
 * Resolves clamped nominal daily compute and its corresponding seconds-per-percent period.
 *
 * @param {object} [config=getRuntimeConfig()] - Validated configuration manifest.
 * @returns {{cBase: number, periodSeconds: number}} Clamped fallback nominal compute and period.
 */
function getFallbackNominalMetrics(config = getRuntimeConfig()) {
  const cBase = Math.max(C_BASE_MIN, Math.min(C_BASE_MAX, config.NOMINAL_DAILY_V5_COMPUTE));
  return {
    cBase,
    periodSeconds: (SECONDS_PER_DAY * V5_HIGH_IMAGES_PER_PERCENT) / cBase
  };
}

/**
 * Parses persisted non-negative integers from SQLite config rows safely.
 *
 * @param {*} raw - Stored value candidate.
 * @returns {number} Parsed non-negative safe integer, or 0 if absent/invalid.
 */
function parsePersistedConfigInt(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && Number.isSafeInteger(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

const initialNominal = getFallbackNominalMetrics(bootConfig);

// V5 Master Account Telemetry & Subscription Lifecycle Registry
let master_v5_percent = 100;
let master_v5_is_negative = false;
let last_fetched_at = 0;
let last_network_attempt_at = 0;
let active_period_seconds = initialNominal.periodSeconds;
let nominal_daily_v5_compute = initialNominal.cBase;
let raw_time_until_next_percent = null;
let dispatches_high_since_sync = 0;
let dispatches_medium_since_sync = 0;

let master_subscription_active = true;
let master_is_grace_period = false;
let master_expires_at = null;
let master_anlas_total = null;
let master_token_expired = false;
let master_last_paid_expires_at = 0;
let master_anlas_cycle_epoch = 0;

let activeFetchPromise = null;
let pendingSurplusPersist = null;
let surplusPersistSeq = 0;
let surplusPersistChain = Promise.resolve(true);

let pendingCyclePersist = null;
let cyclePersistSeq = 0;
let cyclePersistChain = Promise.resolve(true);

let serverInstance = null;
let heartbeatInterval = null;
let isShuttingDown = false;

/**
 * Clears stale cached battery/Anlas/grace/expiration readings and marks the master
 * session credential as expired when upstream NovelAI rejects with HTTP 401.
 * Preserves billing-cycle anchor markers (`master_last_paid_expires_at` / `master_anlas_cycle_epoch`).
 */
function clearTelemetryToExpired() {
  last_fetched_at = 0;
  master_token_expired = true;
  master_v5_percent = 0;
  master_v5_is_negative = false;
  master_is_grace_period = false;
  master_expires_at = null;
  raw_time_until_next_percent = null;
  dispatches_high_since_sync = 0;
  dispatches_medium_since_sync = 0;
  master_anlas_total = null;
}

/**
 * Normalizes NovelAI's `timeUntilNextPercent` metric into seconds, validates sanity bounds
 * [1800, 10000], derives clamped C_base in [100.0, 300.0], and falls back strictly to
 * clamped config.NOMINAL_DAILY_V5_COMPUTE when missing or out of bounds.
 *
 * @param {*} rawTimeUntilNextPercent - Upstream timeUntilNextPercent value (seconds or ms).
 * @param {object} [config=getRuntimeConfig()] - Validated configuration manifest.
 * @returns {{valid: boolean, normalizedPeriod: number|null, cBase: number, activePeriodSeconds: number}}
 */
function normalizeTelemetryPeriod(rawTimeUntilNextPercent, config = getRuntimeConfig()) {
  const fallback = getFallbackNominalMetrics(config);

  if (typeof rawTimeUntilNextPercent !== 'number' || !Number.isFinite(rawTimeUntilNextPercent) || rawTimeUntilNextPercent <= 0) {
    return {
      valid: false,
      normalizedPeriod: null,
      cBase: fallback.cBase,
      activePeriodSeconds: fallback.periodSeconds
    };
  }

  const normalized = rawTimeUntilNextPercent > TELEMETRY_PERIOD_MAX_SEC
    ? Math.floor(rawTimeUntilNextPercent / 1000)
    : rawTimeUntilNextPercent;

  if (!Number.isFinite(normalized) || normalized < TELEMETRY_PERIOD_MIN_SEC || normalized > TELEMETRY_PERIOD_MAX_SEC) {
    return {
      valid: false,
      normalizedPeriod: null,
      cBase: fallback.cBase,
      activePeriodSeconds: fallback.periodSeconds
    };
  }

  const rawCBase = (SECONDS_PER_DAY / normalized) * V5_HIGH_IMAGES_PER_PERCENT;
  const cBase = Math.max(C_BASE_MIN, Math.min(C_BASE_MAX, rawCBase));

  return {
    valid: true,
    normalizedPeriod: normalized,
    cBase,
    activePeriodSeconds: normalized
  };
}

/**
 * Computes continuous master V5 battery capacity projection using elapsed seconds,
 * active replenishment velocity, and cost-weighted local dispatch counts.
 *
 * @param {object} params - Projection state inputs.
 * @param {number} params.lastPercent - Signed last telemetry percent from upstream.
 * @param {number} params.lastFetchedAt - Epoch ms of last successful upstream sync.
 * @param {number} params.activePeriodSeconds - Seconds per 1% replenishment.
 * @param {number} params.dispatchesHigh - V5 High dispatches since last sync.
 * @param {number} params.dispatchesMedium - V5 Medium dispatches since last sync.
 * @param {number} [params.now=Date.now()] - Current epoch ms.
 * @returns {{rawProjected: number, clampedProjected: number, weightedDispatches: number, refillVelocity: number, elapsedSeconds: number}}
 */
function computeProjectedCapacity({
  lastPercent,
  lastFetchedAt,
  activePeriodSeconds,
  dispatchesHigh,
  dispatchesMedium,
  now = Date.now()
}) {
  const rawLastPercent = (typeof lastPercent === 'number' && Number.isFinite(lastPercent)) ? lastPercent : 100;
  const safeLastPercent = rawLastPercent === 0 ? 0 : rawLastPercent;
  const safeNow = (typeof now === 'number' && Number.isFinite(now) && now >= 0) ? now : Date.now();
  const elapsedSeconds = (typeof lastFetchedAt === 'number' && Number.isFinite(lastFetchedAt) && lastFetchedAt > 0)
    ? Math.max(0, (safeNow - lastFetchedAt) / 1000)
    : 0;

  const fallbackPeriod = getFallbackNominalMetrics().periodSeconds;
  const safePeriod = (typeof activePeriodSeconds === 'number' && Number.isFinite(activePeriodSeconds) && activePeriodSeconds > 0)
    ? activePeriodSeconds
    : fallbackPeriod;
  const refillVelocity = 1 / safePeriod;

  const safeHigh = (typeof dispatchesHigh === 'number' && Number.isFinite(dispatchesHigh) && dispatchesHigh > 0) ? dispatchesHigh : 0;
  const safeMedium = (typeof dispatchesMedium === 'number' && Number.isFinite(dispatchesMedium) && dispatchesMedium > 0) ? dispatchesMedium : 0;
  const weightedDispatches = safeHigh + (V5_MEDIUM_DISPATCH_WEIGHT * safeMedium);

  const rawMin = Math.min(
    100,
    safeLastPercent + (elapsedSeconds * refillVelocity) - (weightedDispatches / V5_HIGH_IMAGES_PER_PERCENT)
  );
  const rawProjected = rawMin === 0 ? 0 : rawMin;
  const clampedProjected = Math.max(0, Math.min(100, rawProjected));

  return {
    rawProjected,
    clampedProjected,
    weightedDispatches,
    refillVelocity,
    elapsedSeconds
  };
}

/**
 * Evaluates adaptive telemetry polling interval bounded to a strict 60-second minimum floor.
 * - > 30%: 10 minutes (600,000 ms)
 * - 15% - 30%: 2 minutes (120,000 ms)
 * - <= 15%: 60 seconds (60,000 ms)
 *
 * @param {number} projectedPercent - Current projected battery percentage.
 * @param {object} [config=getRuntimeConfig()] - Validated configuration manifest.
 * @returns {number} Polling interval in milliseconds.
 */
function getPollingIntervalMs(projectedPercent, config = getRuntimeConfig()) {
  const configuredCooldown = (typeof config.TELEMETRY_COOLDOWN_MS === 'number' && Number.isFinite(config.TELEMETRY_COOLDOWN_MS))
    ? config.TELEMETRY_COOLDOWN_MS
    : POLL_LOW_BATTERY_MS;
  const floorMs = Math.max(POLL_LOW_BATTERY_MS, configuredCooldown);

  if (typeof projectedPercent !== 'number' || !Number.isFinite(projectedPercent)) {
    return floorMs;
  }
  if (projectedPercent > 30) {
    return Math.max(floorMs, POLL_HIGH_BATTERY_MS);
  }
  if (projectedPercent > 15) {
    return Math.max(floorMs, POLL_MID_BATTERY_MS);
  }
  return floorMs;
}

/**
 * Returns a deterministic snapshot of the active in-memory telemetry projection
 * and master subscription billing-cycle state.
 * Latches the circuit breaker for at least one 60s polling window whenever upstream
 * confirms master capacity <= V5_CIRCUIT_BREAKER_PERCENT, preventing sub-second
 * continuous refill interpolation from flapping an exact-boundary 5.5% tank open.
 * Preserves continuous background refill projection across inactive subscription states
 * while holding `isHardLocked: true` until an active Opus subscription resumes.
 *
 * @param {number} [now=Date.now()] - Epoch timestamp in ms.
 * @returns {object} Telemetry snapshot.
 */
function getTelemetrySnapshot(now = Date.now()) {
  const config = getRuntimeConfig();
  const projection = computeProjectedCapacity({
    lastPercent: master_v5_percent,
    lastFetchedAt: last_fetched_at,
    activePeriodSeconds: active_period_seconds,
    dispatchesHigh: dispatches_high_since_sync,
    dispatchesMedium: dispatches_medium_since_sync,
    now
  });

  const isLatchedWithinPollWindow =
    master_v5_percent <= config.V5_CIRCUIT_BREAKER_PERCENT &&
    projection.elapsedSeconds < (POLL_LOW_BATTERY_MS / 1000);
  const isHardLocked =
    !master_subscription_active ||
    master_token_expired ||
    projection.rawProjected <= config.V5_CIRCUIT_BREAKER_PERCENT ||
    isLatchedWithinPollWindow;
  const pollingIntervalMs = getPollingIntervalMs(projection.clampedProjected, config);

  return {
    percent: projection.clampedProjected,
    rawProjected: projection.rawProjected,
    lastAnchorPercent: master_v5_percent,
    isNegative: master_v5_is_negative || projection.rawProjected < 0,
    lastFetched: last_fetched_at,
    lastNetworkAttempt: last_network_attempt_at,
    isHardLocked,
    masterTokenExpired: master_token_expired,
    nominalDailyCompute: nominal_daily_v5_compute,
    timeUntilNextPercent: raw_time_until_next_percent,
    activePeriodSeconds: active_period_seconds,
    dispatchesHigh: dispatches_high_since_sync,
    dispatchesMedium: dispatches_medium_since_sync,
    weightedDispatches: projection.weightedDispatches,
    pollingIntervalMs,
    subscriptionActive: master_subscription_active,
    isGracePeriod: master_is_grace_period,
    masterExpiresAt: master_expires_at,
    masterLastPaidExpiresAt: master_last_paid_expires_at,
    activeCycleEpoch: master_anlas_cycle_epoch > 0 ? master_anlas_cycle_epoch : null,
    masterAnlas: master_anlas_total
  };
}

/**
 * Hydrates persisted master subscription billing-cycle markers from SQLite config.
 *
 * @param {number|string} lastPaidExpiresAtSec - Persisted Unix seconds of last non-grace paid expiration.
 * @param {number|string} cycleEpochMs - Persisted millisecond epoch of active billing cycle.
 */
function hydrateSubscriptionState(lastPaidExpiresAtSec, cycleEpochMs) {
  master_last_paid_expires_at = parsePersistedConfigInt(lastPaidExpiresAtSec);
  master_anlas_cycle_epoch = parsePersistedConfigInt(cycleEpochMs);
}

/**
 * Atomically persists master billing-cycle state (`master_last_paid_expires_at`,
 * `master_anlas_cycle_epoch`, and `subscription_periods` archive row) to SQLite
 * with serialized retry resilience.
 *
 * @param {number} lastPaidExpiresAtSec - Unix seconds of last paid non-grace expiration.
 * @param {number} cycleEpochMs - Millisecond epoch of active billing cycle.
 * @returns {Promise<boolean>} True if persisted or superseded; false on unrecovered error.
 */
function persistSubscriptionCycleState(lastPaidExpiresAtSec, cycleEpochMs) {
  const mySeq = ++cyclePersistSeq;
  pendingCyclePersist = { expiresAt: lastPaidExpiresAtSec, cycleEpoch: cycleEpochMs, seq: mySeq };

  const executeWrite = async () => {
    for (let attempt = 1; attempt <= CYCLE_PERSIST_MAX_RETRIES; attempt++) {
      if (isShuttingDown) {
        return false;
      }
      if (cyclePersistSeq > mySeq) {
        return true;
      }
      try {
        await database.run(
          "INSERT OR REPLACE INTO config (key, value) VALUES ('master_last_paid_expires_at', ?), ('master_anlas_cycle_epoch', ?)",
          [String(lastPaidExpiresAtSec), String(cycleEpochMs)]
        );
        if (cycleEpochMs > 0) {
          await recordSubscriptionPeriod(
            cycleEpochMs,
            lastPaidExpiresAtSec > 0 ? lastPaidExpiresAtSec : null,
            cycleEpochMs
          );
        }
        if (pendingCyclePersist && pendingCyclePersist.seq === mySeq) {
          pendingCyclePersist = null;
        }
        return true;
      } catch (err) {
        if (
          attempt === CYCLE_PERSIST_MAX_RETRIES ||
          isShuttingDown ||
          cyclePersistSeq > mySeq ||
          (err && typeof err.message === 'string' && err.message.includes('Database has not been initialized'))
        ) {
          if (cyclePersistSeq > mySeq) {
            return true;
          }
          console.error(`[GuildWeave Subscription] Failed to persist billing cycle state:`, err.message);
          return false;
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 50 * attempt);
          if (timer.unref) timer.unref();
        });
      }
    }
    return false;
  };

  cyclePersistChain = cyclePersistChain.catch(() => false).then(executeWrite);
  return cyclePersistChain;
}

/**
 * Waits for any in-flight billing-cycle persistence chain to settle and retries
 * only if a previous attempt failed and left `pendingCyclePersist` populated.
 *
 * @returns {Promise<void>}
 */
async function flushPendingCyclePersist() {
  await cyclePersistChain.catch(() => false);
  if (!pendingCyclePersist) return;
  const { expiresAt, cycleEpoch } = pendingCyclePersist;
  await persistSubscriptionCycleState(expiresAt, cycleEpoch);
}

/**
 * Applies a validated `/user/subscription` payload to the RAM telemetry registry,
 * normalizing `timeUntilNextPercent`, handling `isNegative` overdrafts with symmetric
 * [-100, 100] sanity bounds, tracking `active`/`tier`/`isGracePeriod`/`trainingStepsLeft`,
 * gracefully accepting omitted/null `usage` strictly when `active === false || tier < 3`
 * (non-Opus/expired accounts may omit V5 usage telemetry), advancing
 * `master_anlas_cycle_epoch` exclusively and monotonically on genuine non-grace renewals,
 * clearing `master_token_expired`, and resetting local V5 dispatch counters.
 *
 * @param {object} payload - Parsed JSON response from `/user/subscription`.
 * @param {object} [config=getRuntimeConfig()] - Validated configuration manifest.
 * @param {number} [now=Date.now()] - Epoch timestamp in ms.
 * @returns {object} Updated telemetry snapshot.
 * @throws {Error} If payload is non-object or active-Opus `usage.percent` is missing, non-numeric, non-finite, or outside [-100, 100].
 */
function applyUsageTelemetry(payload, config = getRuntimeConfig(), now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Malformed subscription response payload: usage.percent missing or invalid.');
  }

  // Evaluate subscription status (gracefully defaulting to active when minimal usage-only mocks omit metadata)
  const hasSubMetadata = (typeof payload.active === 'boolean') || (typeof payload.tier === 'number');
  let nextSubActive = true;
  if (hasSubMetadata) {
    const activeOk = payload.active === undefined ? true : (payload.active === true);
    const tierOk = payload.tier === undefined
      ? true
      : (typeof payload.tier === 'number' && Number.isFinite(payload.tier) && payload.tier >= OPUS_MIN_TIER);
    nextSubActive = activeOk && tierOk;
  }

  const usage = (payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage))
    ? payload.usage
    : null;
  const rawPercent = usage ? usage.percent : undefined;
  const hasValidPercent = typeof rawPercent === 'number' && Number.isFinite(rawPercent) && rawPercent >= -100 && rawPercent <= 100;

  let isNegative = false;
  let signedPercent = 0;
  let periodEval;

  if (hasValidPercent) {
    isNegative = usage.isNegative === true;
    signedPercent = rawPercent === 0
      ? 0
      : (isNegative ? -Math.abs(rawPercent) : rawPercent);
    periodEval = normalizeTelemetryPeriod(usage.timeUntilNextPercent, config);
  } else if (!nextSubActive && (rawPercent === undefined || rawPercent === null)) {
    // Non-Opus / expired subscriptions may omit V5 battery `usage` telemetry upstream.
    periodEval = normalizeTelemetryPeriod(null, config);
  } else {
    throw new Error('Malformed subscription response payload: usage.percent missing or invalid.');
  }

  const safeNow = (typeof now === 'number' && Number.isFinite(now) && now >= 0) ? now : Date.now();
  const cycleStampMs = safeNow > 0 ? safeNow : Date.now();

  const nextGracePeriod = payload.isGracePeriod === true;

  const rawExpiresCandidate = (typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) && payload.expiresAt > 0)
    ? payload.expiresAt
    : payload.paymentProcessorData?.next_billing_at;
  let nextExpiresAt = null;
  if (typeof rawExpiresCandidate === 'number' && Number.isFinite(rawExpiresCandidate) && rawExpiresCandidate > 0) {
    nextExpiresAt = rawExpiresCandidate > 1e12
      ? Math.floor(rawExpiresCandidate / 1000)
      : Math.floor(rawExpiresCandidate);
  }

  let nextMasterAnlas = null;
  if (payload.trainingStepsLeft && typeof payload.trainingStepsLeft === 'object' && !Array.isArray(payload.trainingStepsLeft)) {
    const fixed = (typeof payload.trainingStepsLeft.fixedTrainingStepsLeft === 'number' && Number.isFinite(payload.trainingStepsLeft.fixedTrainingStepsLeft))
      ? Math.max(0, Math.trunc(payload.trainingStepsLeft.fixedTrainingStepsLeft))
      : 0;
    const purchased = (typeof payload.trainingStepsLeft.purchasedTrainingSteps === 'number' && Number.isFinite(payload.trainingStepsLeft.purchasedTrainingSteps))
      ? Math.max(0, Math.trunc(payload.trainingStepsLeft.purchasedTrainingSteps))
      : 0;
    nextMasterAnlas = fixed + purchased;
  }

  master_v5_percent = signedPercent;
  master_v5_is_negative = isNegative || signedPercent < 0;
  master_token_expired = false;
  last_fetched_at = safeNow;
  active_period_seconds = periodEval.activePeriodSeconds;
  nominal_daily_v5_compute = periodEval.cBase;
  raw_time_until_next_percent = periodEval.normalizedPeriod;
  dispatches_high_since_sync = 0;
  dispatches_medium_since_sync = 0;

  master_subscription_active = nextSubActive;
  master_is_grace_period = nextGracePeriod;
  master_expires_at = nextExpiresAt;
  master_anlas_total = nextMasterAnlas;

  // Advance authoritative Anlas billing cycle exclusively when paid, >=Opus, non-grace expiration advances >=15 days
  if (nextExpiresAt !== null && nextSubActive && !nextGracePeriod) {
    let cycleChanged = false;
    if (master_last_paid_expires_at === 0) {
      master_last_paid_expires_at = nextExpiresAt;
      if (master_anlas_cycle_epoch === 0) {
        master_anlas_cycle_epoch = cycleStampMs;
      }
      cycleChanged = true;
    } else if ((nextExpiresAt - master_last_paid_expires_at) >= MIN_CYCLE_ADVANCE_SEC) {
      master_last_paid_expires_at = nextExpiresAt;
      master_anlas_cycle_epoch = Math.max(master_anlas_cycle_epoch + 1, cycleStampMs);
      cycleChanged = true;
      console.log(`[GuildWeave Subscription] Verified Opus billing cycle renewal. New expiresAt: ${nextExpiresAt}, CycleEpoch: ${master_anlas_cycle_epoch}`);
    } else if ((master_last_paid_expires_at - nextExpiresAt) >= MIN_CYCLE_ADVANCE_SEC) {
      // Token swapped to a different account with an earlier expiration: re-anchor baseline without resetting user quotas
      master_last_paid_expires_at = nextExpiresAt;
      cycleChanged = true;
      console.log(`[GuildWeave Subscription] Re-anchored master expiresAt baseline to ${nextExpiresAt} without triggering mid-cycle reset.`);
    }

    if (cycleChanged) {
      persistSubscriptionCycleState(master_last_paid_expires_at, master_anlas_cycle_epoch);
    }
  }

  return getTelemetrySnapshot(last_fetched_at);
}

/**
 * Records a Point-of-No-Return (PoNR) V5 generation dispatch for weighted RAM projection.
 * Exempts Anlas base-paid generations (`isBasePaid = true`) and non-V5 models.
 *
 * @param {string|null|undefined} model - Extracted model identifier.
 * @param {boolean} [isBasePaid=false] - Whether base generation cost was paid with Anlas.
 * @returns {boolean} True if dispatch was recorded against V5 battery projection.
 */
function recordV5Dispatch(model, isBasePaid = false) {
  if (isBasePaid === true) {
    return false;
  }

  if (typeof model === 'string' && model.trim().length > 0 && !isV5ModelFamily(model)) {
    return false;
  }

  if (isV5MediumModel(model)) {
    dispatches_medium_since_sync += 1;
  } else {
    dispatches_high_since_sync += 1;
  }
  return true;
}

/**
 * Resets in-memory telemetry projection and subscription state to boot defaults (for deterministic tests).
 * Supersedes any in-flight persistence retries via monotonic sequence increment.
 *
 * @param {object} [overrides={}] - Optional seed fields for test setup.
 */
function resetTelemetryState(overrides = {}) {
  const config = getRuntimeConfig();
  const fallback = getFallbackNominalMetrics(config);
  master_v5_percent = (typeof overrides.percent === 'number' && Number.isFinite(overrides.percent))
    ? (overrides.percent === 0 ? 0 : overrides.percent)
    : 100;
  master_v5_is_negative = overrides.isNegative !== undefined ? Boolean(overrides.isNegative) : (master_v5_percent < 0);
  master_token_expired = Boolean(overrides.masterTokenExpired);
  last_fetched_at = (typeof overrides.lastFetchedAt === 'number' && Number.isFinite(overrides.lastFetchedAt))
    ? overrides.lastFetchedAt
    : 0;
  last_network_attempt_at = (typeof overrides.lastNetworkAttemptAt === 'number' && Number.isFinite(overrides.lastNetworkAttemptAt))
    ? overrides.lastNetworkAttemptAt
    : 0;
  nominal_daily_v5_compute = (typeof overrides.nominalDailyCompute === 'number' && Number.isFinite(overrides.nominalDailyCompute))
    ? Math.max(C_BASE_MIN, Math.min(C_BASE_MAX, overrides.nominalDailyCompute))
    : fallback.cBase;
  active_period_seconds = (typeof overrides.activePeriodSeconds === 'number' && Number.isFinite(overrides.activePeriodSeconds) && overrides.activePeriodSeconds > 0)
    ? overrides.activePeriodSeconds
    : (SECONDS_PER_DAY * V5_HIGH_IMAGES_PER_PERCENT) / nominal_daily_v5_compute;
  raw_time_until_next_percent = overrides.timeUntilNextPercent !== undefined ? overrides.timeUntilNextPercent : null;
  dispatches_high_since_sync = overrides.dispatchesHigh !== undefined ? overrides.dispatchesHigh : 0;
  dispatches_medium_since_sync = overrides.dispatchesMedium !== undefined ? overrides.dispatchesMedium : 0;

  master_subscription_active = overrides.subscriptionActive !== undefined ? Boolean(overrides.subscriptionActive) : true;
  master_is_grace_period = overrides.isGracePeriod !== undefined ? Boolean(overrides.isGracePeriod) : false;
  master_expires_at = (typeof overrides.expiresAt === 'number' && Number.isFinite(overrides.expiresAt) && overrides.expiresAt > 0)
    ? Math.floor(overrides.expiresAt)
    : null;
  master_anlas_total = (typeof overrides.masterAnlas === 'number' && Number.isFinite(overrides.masterAnlas) && overrides.masterAnlas >= 0)
    ? Math.trunc(overrides.masterAnlas)
    : null;
  master_last_paid_expires_at = (typeof overrides.lastPaidExpiresAt === 'number' && Number.isFinite(overrides.lastPaidExpiresAt) && overrides.lastPaidExpiresAt >= 0)
    ? Math.floor(overrides.lastPaidExpiresAt)
    : 0;
  master_anlas_cycle_epoch = (typeof overrides.activeCycleEpoch === 'number' && Number.isFinite(overrides.activeCycleEpoch) && overrides.activeCycleEpoch >= 0)
    ? Math.floor(overrides.activeCycleEpoch)
    : 0;

  pendingSurplusPersist = null;
  surplusPersistSeq += 1;
  pendingCyclePersist = null;
  cyclePersistSeq += 1;
}

/**
 * Atomically persists Bucket 2 Cluster Surplus Pool state to SQLite `config` table
 * using a serialized single-statement upsert with bounded retry resilience against
 * transient `SQLITE_BUSY` / lock contention. Superseded or shutdown writes abort
 * cleanly without overwriting newer state.
 *
 * @param {number} poolNcp - Surplus pool value in NCP.
 * @param {number} accrualEpoch - Evaluation epoch timestamp in ms.
 * @returns {Promise<boolean>} True if persisted to SQLite; false if deferred to pendingSurplusPersist.
 */
function persistSurplusState(poolNcp, accrualEpoch) {
  const mySeq = ++surplusPersistSeq;
  pendingSurplusPersist = { pool: poolNcp, lastAccrual: accrualEpoch, seq: mySeq };

  const executeWrite = async () => {
    for (let attempt = 1; attempt <= SURPLUS_PERSIST_MAX_RETRIES; attempt++) {
      if (isShuttingDown) {
        return false;
      }
      if (surplusPersistSeq > mySeq) {
        return true; // Superseded by a newer write request or state reset
      }
      try {
        await database.run(
          "INSERT OR REPLACE INTO config (key, value) VALUES ('v5_surplus_pool', ?), ('v5_surplus_last_accrual', ?)",
          [String(poolNcp), String(accrualEpoch)]
        );
        if (pendingSurplusPersist && pendingSurplusPersist.seq === mySeq) {
          pendingSurplusPersist = null;
        }
        return true;
      } catch (err) {
        if (
          attempt === SURPLUS_PERSIST_MAX_RETRIES ||
          isShuttingDown ||
          surplusPersistSeq > mySeq ||
          (err && typeof err.message === 'string' && err.message.includes('Database has not been initialized'))
        ) {
          if (surplusPersistSeq > mySeq) {
            return true;
          }
          console.error(`[GuildWeave Surplus] Failed to persist Bucket 2 surplus state after ${attempt} attempts:`, err.message);
          return false;
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 50 * attempt);
          if (timer.unref) timer.unref();
        });
      }
    }
    return false;
  };

  surplusPersistChain = surplusPersistChain.catch(() => false).then(executeWrite);
  return surplusPersistChain;
}

/**
 * Serializes PoNR Bucket 2 surplus pool deductions onto the exact `surplusPersistSeq` /
 * `surplusPersistChain` pipeline used by 24h `sweep()` accruals, preventing sleeping
 * retry timers from overwriting post-deduction pool balances in SQLite.
 *
 * @param {number} poolNcp - Updated surplus pool value in NCP.
 * @returns {Promise<boolean>} True if persisted or superseded; false on unrecovered error.
 */
function persistSurplusPool(poolNcp) {
  const currentAccrual = queueManager.getSurplusPool().lastAccrual;
  if (currentAccrual > 0) {
    return persistSurplusState(poolNcp, currentAccrual);
  }

  const mySeq = ++surplusPersistSeq;
  pendingSurplusPersist = { pool: poolNcp, lastAccrual: null, seq: mySeq };

  const executeWrite = async () => {
    for (let attempt = 1; attempt <= SURPLUS_PERSIST_MAX_RETRIES; attempt++) {
      if (isShuttingDown) {
        return false;
      }
      if (surplusPersistSeq > mySeq) {
        return true;
      }
      try {
        await database.run(
          "INSERT OR REPLACE INTO config (key, value) VALUES ('v5_surplus_pool', ?)",
          [String(poolNcp)]
        );
        if (pendingSurplusPersist && pendingSurplusPersist.seq === mySeq) {
          pendingSurplusPersist = null;
        }
        return true;
      } catch (err) {
        if (
          attempt === SURPLUS_PERSIST_MAX_RETRIES ||
          isShuttingDown ||
          surplusPersistSeq > mySeq ||
          (err && typeof err.message === 'string' && err.message.includes('Database has not been initialized'))
        ) {
          if (surplusPersistSeq > mySeq) {
            return true;
          }
          console.error(`[GuildWeave Surplus] Failed to persist Bucket 2 PoNR pool after ${attempt} attempts:`, err.message);
          return false;
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 50 * attempt);
          if (timer.unref) timer.unref();
        });
      }
    }
    return false;
  };

  surplusPersistChain = surplusPersistChain.catch(() => false).then(executeWrite);
  return surplusPersistChain;
}

/**
 * Attempts to flush any deferred Bucket 2 surplus persistence write.
 *
 * @returns {Promise<void>}
 */
async function flushPendingSurplusPersist() {
  await surplusPersistChain.catch(() => false);
  if (!pendingSurplusPersist) return;
  const { pool, lastAccrual } = pendingSurplusPersist;
  if (lastAccrual !== null && lastAccrual > 0) {
    await persistSurplusState(pool, lastAccrual);
  } else {
    await persistSurplusPool(pool);
  }
}

/**
 * Seeds initial V5 personal reserve banks (`v5_last_accrual_epoch IS NULL`) for
 * pre-existing approved, unbanned principals upon cold-to-warm Opus telemetry sync
 * (boot or token refresh). Ensures migrated users receive Day 1 V5 capacity and
 * accrue multi-day rollover banks while offline rather than losing days prior to login.
 * Skips zero-weight tiers (e.g. Metered) unless stale positive balances require clamping.
 *
 * @returns {Promise<number>} Count of principals seeded.
 */
async function seedApprovedUserV5Ledgers() {
  if (isShuttingDown || !master_subscription_active || master_token_expired || last_fetched_at === 0) {
    return 0;
  }

  const config = getRuntimeConfig();
  const approvedUsers = await database.all(
    `SELECT u.user_id, u.priority_tier, u.v5_last_accrual_epoch, u.v5_banked_balance
     FROM users u
     WHERE u.banned = 0
       AND u.v5_last_accrual_epoch IS NULL
       AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.user_id AND d.approved = 1)`
  );

  const now = Date.now();
  let seeded = 0;

  for (const row of approvedUsers) {
    if (isShuttingDown) break;
    const tierConfig = config.TIER_CONFIGS[row.priority_tier] || config.TIER_CONFIGS['Normal'];
    const hasWeight = Number.isInteger(tierConfig.v5Weight) && tierConfig.v5Weight > 0;
    if (!hasWeight && (row.v5_banked_balance || 0) <= 0) {
      continue;
    }

    const res = await evaluateV5Accrual(row.user_id, {
      now,
      nominalDailyCompute: nominal_daily_v5_compute
    });
    if (res && res.accrual_applied) {
      seeded += 1;
    }
  }

  if (seeded > 0) {
    console.log(`[GuildWeave Boot] Seeded initial V5 reserve allotments for ${seeded} approved principal(s).`);
  }
  return seeded;
}

/**
 * Schedules the next adaptive telemetry heartbeat using projected capacity:
 * 10m (>30%) -> 2m (15%-30%) -> 60s floor (<=15%).
 * Also flushes any deferred SQLite Bucket 2 surplus or billing-cycle persistence writes.
 */
function scheduleNextHeartbeat() {
  if (isShuttingDown) return;
  if (heartbeatInterval) {
    clearTimeout(heartbeatInterval);
    heartbeatInterval = null;
  }

  const config = getRuntimeConfig();
  const snapshot = getTelemetrySnapshot();
  const delayMs = getPollingIntervalMs(snapshot.percent, config);

  heartbeatInterval = setTimeout(async () => {
    try {
      await flushPendingSurplusPersist();
      await flushPendingCyclePersist();
      await syncTelemetry({ rescheduleHeartbeat: false });
    } catch (err) {
      console.warn("[GuildWeave Harvester] Heartbeat refresh failed:", err.message);
    } finally {
      scheduleNextHeartbeat();
    }
  }, delayMs);

  if (heartbeatInterval.unref) {
    heartbeatInterval.unref();
  }
}

/**
 * Asynchronously synchronizes master account subscription telemetry.
 * Leverages shared Promise resolution to prevent cache stampedes.
 * Clears stale cached telemetry and flags `master_token_expired` immediately if upstream
 * rejects with HTTP 401 so expired credentials never report phantom capacity or admit V5 tasks.
 * Triggers initial V5 reserve seeding when telemetry transitions from uninitialized to active.
 *
 * @param {object} [options={}] - Execution options.
 * @param {boolean} [options.rescheduleHeartbeat=true] - Whether to reschedule adaptive heartbeat on completion.
 * @returns {Promise<void>} Resolves when telemetry is synchronized and cycle state settled.
 */
function syncTelemetry({ rescheduleHeartbeat = true } = {}) {
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async () => {
    try {
      const config = getRuntimeConfig();
      const configRecord = await database.get('SELECT value FROM config WHERE key = ?', ['master_token']);
      const masterToken = (configRecord && configRecord.value)
        ? String(configRecord.value).trim().replace(/^Bearer(?:\s+|$)/i, '').trim()
        : '';
      if (!masterToken) {
        console.warn("[GuildWeave Harvester] Telemetry sync skipped: No master_token configured in database yet.");
        return;
      }
      last_network_attempt_at = Date.now();

      console.log("[GuildWeave Harvester] Fetching master subscription telemetry...");

      await new Promise((resolve, reject) => {
        const baseUrl = config.UPSTREAM_BASE_URL_TEMPLATE.replace('{subdomain}', 'image');
        const telemetryUrl = `${baseUrl}/user/subscription`;
        const parsedUrl = new URL(telemetryUrl);

        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${masterToken}`,
            'User-Agent': 'guildweave-v5-harvester/1.0'
          },
          timeout: config.TELEMETRY_FETCH_TIMEOUT_MS
        };

        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const req = transport.request(options, (res) => {
          let rawData = '';
          res.on('data', chunk => rawData += chunk);
          res.on('end', async () => {
            try {
              if (res.statusCode === 200) {
                const payload = JSON.parse(rawData);
                const wasUninitialized = last_fetched_at === 0;
                const snapshot = applyUsageTelemetry(payload, config, Date.now());
                await cyclePersistChain.catch(() => false);
                if (wasUninitialized && snapshot.subscriptionActive && !isShuttingDown) {
                  await seedApprovedUserV5Ledgers();
                }
                console.log(
                  `[GuildWeave Harvester] Telemetry sync successful. Capacity: ${snapshot.rawProjected.toFixed(2)}% (clamped: ${snapshot.percent.toFixed(2)}%), C_base: ${snapshot.nominalDailyCompute.toFixed(2)}, Active: ${snapshot.subscriptionActive}, Grace: ${snapshot.isGracePeriod}, NextPoll: ${Math.round(snapshot.pollingIntervalMs / 1000)}s, Locked: ${snapshot.isHardLocked}`
                );
                if (rescheduleHeartbeat && serverInstance && !isShuttingDown) {
                  scheduleNextHeartbeat();
                }
                resolve();
              } else {
                if (res.statusCode === 401) {
                  clearTelemetryToExpired();
                }
                reject(new Error(`Upstream returned error status code: ${res.statusCode}`));
              }
            } catch (parseErr) {
              reject(parseErr);
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Upstream fetch timed out after ${config.TELEMETRY_FETCH_TIMEOUT_MS}ms.`));
        });

        req.end();
      });
    } catch (err) {
      console.error("[GuildWeave Harvester] Exception in telemetry harvester sync:", err.message);
      throw err; // Propagate exception to boot sequence for explicit error logging
    } finally {
      activeFetchPromise = null;
    }
  })();

  return activeFetchPromise;
}

// Wire Level 3 QueueCoordinator telemetry provider with strict [0, 100] clamping.
// Returns null until initial telemetry fetch completes so Bucket 2 never mints phantom surplus on cold boot,
// and returns 0 when subscription is inactive so unspendable surplus cannot accrue while unsubscribed.
queueManager.setTelemetryProvider(() => {
  if (last_fetched_at === 0) {
    return null;
  }
  if (!master_subscription_active) {
    return 0;
  }
  return getTelemetrySnapshot().percent;
});

// Global Telemetry Attachment Middleware
app.use((req, res, next) => {
  req.telemetry = {
    get percent() { return getTelemetrySnapshot().percent; },
    get rawPercent() { return getTelemetrySnapshot().rawProjected; },
    get isNegative() { return getTelemetrySnapshot().isNegative; },
    get lastFetched() { return last_fetched_at; },
    get isHardLocked() { return getTelemetrySnapshot().isHardLocked; },
    get masterTokenExpired() { return master_token_expired; },
    get nominalDailyCompute() { return nominal_daily_v5_compute; },
    get timeUntilNextPercent() { return raw_time_until_next_percent; },
    get activePeriodSeconds() { return active_period_seconds; },
    get pollingIntervalMs() { return getTelemetrySnapshot().pollingIntervalMs; },
    get dispatchesHigh() { return dispatches_high_since_sync; },
    get dispatchesMedium() { return dispatches_medium_since_sync; },
    get subscriptionActive() { return master_subscription_active; },
    get isGracePeriod() { return master_is_grace_period; },
    get masterExpiresAt() { return master_expires_at; },
    get masterLastPaidExpiresAt() { return master_last_paid_expires_at; },
    get activeCycleEpoch() { return master_anlas_cycle_epoch > 0 ? master_anlas_cycle_epoch : null; },
    get masterAnlas() { return master_anlas_total; },
    getProjectionSnapshot: (now = Date.now()) => getTelemetrySnapshot(now),
    recordDispatch: (model, isBasePaid = false) => recordV5Dispatch(model, isBasePaid),
    persistSurplusPool: (poolNcp) => persistSurplusPool(poolNcp),
    triggerSync: () => {
      const config = getRuntimeConfig();
      const now = Date.now();
      const snapshot = getTelemetrySnapshot(now);
      const cooldownMs = getPollingIntervalMs(snapshot.percent, config);
      const lastAttemptOrSync = Math.max(last_fetched_at, last_network_attempt_at);
      if (!activeFetchPromise && (now - lastAttemptOrSync >= cooldownMs)) {
        setImmediate(() => {
          syncTelemetry().catch(err => console.error("[GuildWeave Telemetry] Out-of-band sync failed:", err.message));
        });
      }
    },
    invalidate: () => {
      clearTelemetryToExpired();
      last_network_attempt_at = Date.now();
    },
    refresh: async () => {
      if (activeFetchPromise) {
        try { await activeFetchPromise; } catch (_) {}
      }
      last_fetched_at = 0;
      last_network_attempt_at = 0;
      master_token_expired = false;
      await syncTelemetry();
    },
    ensureFresh: async () => {
      const config = getRuntimeConfig();
      const now = Date.now();
      if (last_fetched_at === 0 || (now - last_fetched_at > config.TELEMETRY_STALE_MS)) {
        const cooldownFloorMs = Math.max(
          POLL_LOW_BATTERY_MS,
          Number.isFinite(config.TELEMETRY_COOLDOWN_MS) ? config.TELEMETRY_COOLDOWN_MS : POLL_LOW_BATTERY_MS
        );
        if (last_network_attempt_at > 0 && (now - last_network_attempt_at < cooldownFloorMs) && !activeFetchPromise) {
          throw new Error('Telemetry sync suppressed during upstream rate-limit cooldown.');
        }
        await syncTelemetry();
      }
    }
  };
  next();
});

// Central Request Logger
app.use((req, res, next) => {
  if (req.url === '/favicon.ico') return res.status(204).end();
  const timestamp = new Date().toISOString();
  const rawIp = req.headers['x-real-ip'] || req.ip || 'unknown'; 
  const maskedIp = (rawIp === 'unknown' || rawIp === '127.0.0.1' || rawIp === '::1')
    ? 'local/unknown'
    : crypto.createHash('sha256').update(rawIp + IP_SALT).digest('hex').substring(0, 12);
  console.log(`[GuildWeave Telemetry] ${timestamp} | ${req.method} ${req.url} | Client: ${maskedIp}`);
  next();
});

// ----------------- ROUTE CONTROLLER MOUNTING -----------------

// 1. Mount Stream-Safe Proxy Router WITHOUT global body-parsers
app.use('/proxy', proxyRouter);

// 2. Mount standard body parsers strictly AFTER stream-sensitive proxy boundaries
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Mount remaining service routers
app.use('/auth', authRouter);
app.use('/queue', queueRouter);
app.use('/admin', adminRouter);

database.initDatabase(bootConfig.DATABASE_PATH)
  .then(async () => {
    // Hydrate Bucket 2 Cluster Surplus Pool from SQLite config before starting GC or HTTP server
    try {
      const poolRow = await database.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");
      const accrualRow = await database.get("SELECT value FROM config WHERE key = 'v5_surplus_last_accrual'");
      queueManager.hydrateSurplusPool(poolRow ? poolRow.value : '0', accrualRow ? accrualRow.value : '0');
    } catch (hydrateErr) {
      console.warn("[GuildWeave Boot] Bucket 2 surplus pool hydration failed. Falling back to 0:", hydrateErr.message);
      queueManager.hydrateSurplusPool('0', '0');
    }

    // Hydrate Master Billing Cycle markers from SQLite config before warm-boot sync
    try {
      const expiresRow = await database.get("SELECT value FROM config WHERE key = 'master_last_paid_expires_at'");
      const cycleRow = await database.get("SELECT value FROM config WHERE key = 'master_anlas_cycle_epoch'");
      hydrateSubscriptionState(expiresRow ? expiresRow.value : '0', cycleRow ? cycleRow.value : '0');
      if (master_anlas_cycle_epoch > 0) {
        await recordSubscriptionPeriod(
          master_anlas_cycle_epoch,
          master_last_paid_expires_at > 0 ? master_last_paid_expires_at : null,
          master_anlas_cycle_epoch
        );
      }
    } catch (cycleHydrateErr) {
      console.warn("[GuildWeave Boot] Billing cycle hydration failed. Falling back to 0:", cycleHydrateErr.message);
      hydrateSubscriptionState('0', '0');
    }

    queueManager.setOnSurplusAccrual((newPoolNcp, accrualEpoch) => {
      return persistSurplusState(newPoolNcp, accrualEpoch);
    });

    try {
      console.log("[GuildWeave Boot] Executing warm boot subscription sync...");
      await syncTelemetry({ rescheduleHeartbeat: false });
    } catch (warmBootErr) {
      console.warn("[GuildWeave Boot] Warm boot telemetry pull failed. Initializing with default metrics:", warmBootErr.message);
    }

    // Start Queue Scavenger GC cycle strictly after DB hydration
    queueManager.startGc();

    // Active Adaptive Telemetry Heartbeat (10m -> 2m -> 60s floor)
    scheduleNextHeartbeat();
    
    serverInstance = app.listen(bootConfig.PORT, '127.0.0.1', () => {
      console.log(`GuildWeave coordinator running on port ${bootConfig.PORT}`);
    });

    serverInstance.on('close', () => {
      isShuttingDown = true;
      if (heartbeatInterval) {
        clearTimeout(heartbeatInterval);
        heartbeatInterval = null;
      }
      queueManager.stopGc();
    });
  })
  .catch((err) => {
    console.error("[GuildWeave Critical] Database initialization failed. Terminating engine process.", err);
    process.exit(1);
  });

module.exports = {
  app,
  get server() {
    return serverInstance;
  },
  get gcInterval() {
    return queueManager.gcInterval;
  },
  get heartbeatInterval() {
    return heartbeatInterval;
  },
  queueManager,
  syncTelemetry,
  seedApprovedUserV5Ledgers,
  normalizeTelemetryPeriod,
  computeProjectedCapacity,
  getPollingIntervalMs,
  getTelemetrySnapshot,
  applyUsageTelemetry,
  recordV5Dispatch,
  resetTelemetryState,
  hydrateSubscriptionState,
  persistSubscriptionCycleState,
  flushPendingCyclePersist,
  persistSurplusState,
  persistSurplusPool,
  flushPendingSurplusPersist
};