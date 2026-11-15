/**
 * LEVEL 2: SECURITY AUDIT & ACCOUNTING ENGINE (auditEngine.js)
 * 
 * Strict unidirectional constraints:
 * - Imports Level 0 (database.js) and Level 1 (config.js).
 * - Blind to HTTP transport (Express), socket streams, and queue RAM states.
 * - Handles parameter parsing, security auditing, Anlas tracking, authoritative principal authentication,
 *   and ACS-1 dual-ledger balance derivation, debt lockouts, and temporal accruals.
 * - Relational Normalization: Evaluates quotas, allowances, Anlas deductions, and bans strictly
 *   against the canonical user_id (Security Principal), eliminating multi-device quota inflation.
 * - ACS-1 Domain Engine: Authoritative NovelAI Anlas formula, bounded zero-copy binary multipart parser,
 *   and integer-only NCP/Anlas financial ledger mutations.
 */

'use strict';

const { get, all, run } = require('./database');
const { loadConfig } = require('./config');

// NovelAI Pricing Formula Constants (from anlas-calculation.md)
const ANLAS_ALPHA = 2.951823174884865e-6;
const ANLAS_BETA = 5.753298233447344e-7;
const ANLAS_MAX_PER_IMAGE_CAP = 140;
const ANLAS_MIN_PER_IMAGE_FLOOR = 2;

// ACS-1 Ledger Temporal & Compute Constants
const DAY_MS = 86400000;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const V5_HIGH_NCP_COST = 18;
const V5_DAILY_COMPUTE_MIN = 100.0;
const V5_DAILY_COMPUTE_MAX = 300.0;

// Maximum permissible byte ceiling for the extracted JSON metadata slice (~20MB).
// Accommodates up to 12 full-resolution Base64 reference images while bounding
// metadata string and JSON parse heap allocations per request.
const MAX_JSON_PART_BYTES = 20971520;

// Static Module-Scoped Binary Needles & Part Header Inspection Patterns
const NEEDLE_CRLF_CRLF = Buffer.from('\r\n\r\n');
const NEEDLE_LF_LF = Buffer.from('\n\n');
const PART_NAME_REQUEST_REGEX = /name\s*=\s*["']?request["']?\s*(?:;|\r|\n|$)/i;
const PART_NAME_IMAGE_REGEX = /name\s*=\s*["']?image["']?\s*(?:;|\r|\n|$)/i;
const PART_NAME_MASK_REGEX = /name\s*=\s*["']?mask["']?\s*(?:;|\r|\n|$)/i;

// Whitelist of user prompt keys that must never be subjected to Base64 truncation heuristics
const TELEMETRY_PROMPT_KEYS = Object.freeze(new Set(['prompt', 'input', 'uc', 'negative_prompt', 'negativeprompt']));

// Per-principal async serialization registry to eliminate TOCTOU accrual/reset races
const userMutationLocks = new Map();

/**
 * Evaluates the runtime system configuration dynamically.
 *
 * @returns {object} Validated, immutable configuration manifest.
 */
function getConfig() {
  return loadConfig(process.env);
}

/**
 * Serializes asynchronous ledger mutations per canonical user_id without opening
 * competing raw SQLite transactions on the shared connection handle.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {Function} fn - Asynchronous critical-section callback.
 * @returns {Promise<*>} Result of critical-section execution.
 */
async function withUserLock(userId, fn) {
  const previous = userMutationLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  userMutationLocks.set(userId, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (userMutationLocks.get(userId) === tail) {
      userMutationLocks.delete(userId);
    }
  }
}

/**
 * Validates that an identifier is a non-empty, non-whitespace string (fail-closed).
 *
 * @param {*} value - Identifier candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {string} Validated identifier string.
 * @throws {Error} If value is not a non-empty string.
 */
function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[Audit Error] ${fieldName} must be a non-empty string.`);
  }
  return value;
}

/**
 * Validates that a discrete financial or compute quantity is a non-negative safe integer (fail-closed).
 * Rejects booleans, floats, NaN, Infinity, negative numbers, arrays, objects, and strings.
 *
 * @param {*} value - Numeric candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {number} Validated non-negative safe integer.
 * @throws {Error} If value violates integer boundaries.
 */
function assertNonNegativeSafeInt(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`[Audit Error] ${fieldName} must be a non-negative safe integer.`);
  }
  return value;
}

/**
 * Validates a non-negative finite epoch timestamp in milliseconds (fail-closed).
 *
 * @param {*} value - Epoch timestamp candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {number} Validated epoch timestamp.
 * @throws {Error} If value is not a finite non-negative number.
 */
function assertValidTimestamp(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`[Audit Error] ${fieldName} must be a finite non-negative number.`);
  }
  return value;
}

/**
 * Evaluates whether a given model identifier belongs to the V5 architecture family.
 * Strictly distinguishes V5 models from V4.5 variants (including 4-5, 4_5, 4.5) and matches
 * both suffixed ('nai-diffusion-5-full') and bare ('nai-diffusion-5', 'v5') identifiers.
 *
 * @param {string|null|undefined} model - Target model identifier string.
 * @returns {boolean} True if the model represents a NovelAI V5 variant.
 */
function isV5ModelFamily(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (/4[-_.]5/i.test(trimmed)) return false;
  return /(?:^|[-_])v?5(?:[-_]|$)/i.test(trimmed);
}

/**
 * Evaluates whether a model identifier represents the V5 Medium Effort variant.
 * Strictly composes isV5ModelFamily to eliminate disjoint domain assertions.
 *
 * @param {string|null|undefined} model - Target model identifier string.
 * @returns {boolean} True if the model is V5 Medium.
 */
function isV5MediumModel(model) {
  if (!isV5ModelFamily(model)) return false;
  return /medium/i.test(model.trim());
}

/**
 * Authoritative Device Authentication & Identity Gatekeeper.
 * Centralizes credential validation, administrative bypass, and hierarchical ban enforcement.
 * Resolves physical hardware credentials to canonical Security Principals in the users table.
 * 
 * @param {string} browserId - Unique device browser footprint.
 * @param {string} deviceSecret - Secret passkey or admin secret.
 * @param {object} [options={}] - Validation policies.
 * @param {boolean} [options.requireApproval=true] - Whether unapproved devices should be rejected.
 * @returns {Promise<{ok: boolean, status?: number, error?: string, device?: object}>} Validation result.
 */
async function verifyDevice(browserId, deviceSecret, { requireApproval = true } = {}) {
  if (!browserId || !deviceSecret) {
    return { ok: false, status: 401, error: 'Missing routing authorization context.' };
  }

  const config = getConfig();
  let device;

  if (deviceSecret === config.ADMIN_SECRET_KEY) {
    device = { 
      browser_id: browserId,
      user_id: 'admin',
      label: 'Admin Terminal',
      approved: 1, 
      banned: 0, 
      priority_tier: 'Admin', 
      discord_id: 'admin',
      discord_username: 'Administrator',
      anlas_consumed: 0,
      metered_allowance: Infinity,
      virtual_anlas_balance: Infinity,
      v5_banked_balance: Infinity,
      v5_daily_consumed: 0,
      subscription_period_anlas: 0,
      subscription_period_v5: 0
    };
  } else {
    device = await get(
      `SELECT 
        d.browser_id, d.device_secret, d.label, d.approved, d.total_requests, d.last_active_at,
        d.discord_id as legacy_discord_id, d.priority_tier as legacy_tier, d.banned as legacy_banned,
        d.user_id as d_user_id,
        u.priority_tier as u_tier, u.banned as u_banned, u.ban_reason, u.anlas_consumed as u_anlas,
        u.metered_allowance as u_allowance, u.last_allowance_update_at as u_update_at, u.discord_username as u_username,
        u.virtual_anlas_balance as u_virtual_anlas, u.last_anlas_reset_epoch as u_last_anlas_reset,
        u.v5_banked_balance as u_v5_banked, u.v5_last_accrual_epoch as u_v5_last_accrual,
        u.v5_daily_consumed as u_v5_daily_consumed,
        u.subscription_period_anlas as u_sub_anlas, u.subscription_period_v5 as u_sub_v5,
        u.subscription_period_start_epoch as u_sub_start
      FROM devices d
      LEFT JOIN users u ON u.user_id = COALESCE(d.user_id, d.discord_id, d.browser_id)
      WHERE d.browser_id = ? AND d.device_secret = ?`,
      [browserId, deviceSecret]
    );

    if (device) {
      device.user_id = device.d_user_id || device.legacy_discord_id || device.browser_id;
      device.priority_tier = device.u_tier || device.legacy_tier || 'Normal';
      device.banned = (device.u_banned === 1 || device.legacy_banned === 1) ? 1 : 0;
      device.discord_id = device.legacy_discord_id || (device.user_id && !device.user_id.startsWith('b_') ? device.user_id : null);
      device.anlas_consumed = device.u_anlas !== undefined && device.u_anlas !== null ? device.u_anlas : (device.anlas_consumed || 0);
      device.metered_allowance = device.u_allowance !== undefined && device.u_allowance !== null ? device.u_allowance : (device.metered_allowance || 100);
      device.last_allowance_update_at = device.u_update_at || device.last_allowance_update_at || Date.now();
      device.discord_username = device.u_username || device.discord_username || null;

      const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
      const rawVirtualAnlas = device.u_virtual_anlas !== undefined && device.u_virtual_anlas !== null ? device.u_virtual_anlas : 0;
      device.virtual_anlas_balance = tierConfig.monthlyAnlas === Infinity ? Infinity : rawVirtualAnlas;
      device.last_anlas_reset_epoch = device.u_last_anlas_reset ?? null;
      device.v5_banked_balance = device.u_v5_banked !== undefined && device.u_v5_banked !== null ? device.u_v5_banked : 0;
      device.v5_last_accrual_epoch = device.u_v5_last_accrual ?? null;
      device.v5_daily_consumed = device.u_v5_daily_consumed !== undefined && device.u_v5_daily_consumed !== null ? device.u_v5_daily_consumed : 0;
      device.subscription_period_anlas = device.u_sub_anlas !== undefined && device.u_sub_anlas !== null ? device.u_sub_anlas : 0;
      device.subscription_period_v5 = device.u_sub_v5 !== undefined && device.u_sub_v5 !== null ? device.u_sub_v5 : 0;
      device.subscription_period_start_epoch = device.u_sub_start ?? null;
    }
  }

  if (!device) {
    return { ok: false, status: 401, error: 'Access Denied: Device credentials rejected.' };
  }

  // Check Discord blacklist table for legacy backwards compatibility
  if (device.discord_id && device.discord_id !== 'admin') {
    const isBannedUser = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [device.discord_id]);
    if (isBannedUser) {
      if (device.banned !== 1) {
        await run('UPDATE users SET banned = 1 WHERE user_id = ?', [device.discord_id]);
        await run('UPDATE devices SET banned = 1 WHERE discord_id = ? OR user_id = ?', [device.discord_id, device.discord_id]);
      }
      return { ok: false, status: 403, error: 'Access Denied: Your Discord identity is permanently banned.' };
    }
  }

  if (device.banned === 1) {
    return { ok: false, status: 403, error: 'Access Denied: Your device/profile has been permanently banned.' };
  }

  if (requireApproval && device.approved !== 1) {
    return { ok: false, status: 401, error: 'Access Denied: Device pending registration approval.' };
  }

  return { ok: true, device };
}

/**
 * Strictly parses integer parameters, truncating finite floats to preserve magnitudes.
 * Clamps astronomical numbers to Number.MAX_SAFE_INTEGER to prevent audit evasion bypasses,
 * while rejecting non-primitives, booleans, and non-numeric strings with symmetric boundaries.
 *
 * @param {*} val - Input candidate.
 * @param {number|null} [fallback=null] - Default if unparseable.
 * @returns {number|null} Evaluated safe integer.
 */
function parseOptionalInt(val, fallback = null) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return fallback;
    const truncated = Math.trunc(val);
    if (truncated > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    if (truncated < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
    return truncated;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) return fallback;
      if (parsed > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
      if (parsed < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
      return parsed;
    }
  }
  return fallback;
}

/**
 * Strictly parses float parameters, rejecting arrays, objects, booleans, and non-numeric strings.
 *
 * @param {*} val - Input candidate.
 * @param {number|null} [fallback=null] - Default if unparseable.
 * @returns {number|null} Evaluated finite float.
 */
function parseOptionalFloat(val, fallback = null) {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : fallback;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : fallback;
    }
  }
  return fallback;
}

/**
 * Evaluates the authoritative Anlas cost breakdown for generation parameters.
 * Implements exact reverse-engineered NovelAI billing calculations including V5 Medium 14-step factor.
 * Immunized against NaN leakage, string poisoning, boolean coercion, and unbounded floats.
 *
 * @param {object} params - Extracted payload parameters.
 * @param {object} [options={}] - Calculation context.
 * @param {boolean} [options.isOpus=true] - Whether the generating account holds Opus tier perks.
 * @returns {object} Detailed breakdown of integer Anlas costs.
 * @throws {Error} If per-image cost exceeds NovelAI's maximum 140 Anlas ceiling.
 */
function calculateAnlasCostDetails(params, { isOpus = true } = {}) {
  if (!params || typeof params !== 'object') {
    return {
      total: 0,
      base: 0,
      per_image: 0,
      billable_samples: 0,
      character_reference_anlas: 0,
      vibe_encoding_anlas: 0,
      vibe_reference_anlas: 0
    };
  }

  const parsedWidth = parseOptionalInt(params.width, 1024);
  const width = parsedWidth > 0 ? parsedWidth : 1024;

  const parsedHeight = parseOptionalInt(params.height, 1024);
  const height = parsedHeight > 0 ? parsedHeight : 1024;
  const area = width * height;

  const model = typeof params.model === 'string' ? params.model.trim() : '';
  const isV5Medium = isV5MediumModel(model);
  const isV5 = isV5ModelFamily(model);

  // NovelAI upstream: Medium always runs at 14 steps with step_factor = 1 / 1.06521739
  const stepFactor = isV5Medium ? (1 / 1.06521739) : 1.0;
  const parsedSteps = parseOptionalInt(params.steps, 28);
  const rawSteps = isV5Medium ? 14 : (parsedSteps > 0 ? parsedSteps : 28);
  const effectiveSteps = rawSteps * stepFactor;

  const baseCalculated = Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * effectiveSteps);

  // SMEA Multipliers
  let multiplier = 1.0;
  const sm = params.sm === true || params.sm === 'true' || params.sm === 1;
  const smDyn = params.sm_dyn === true || params.sm_dyn === 'true' || params.sm_dyn === 1;

  if (sm && smDyn) {
    multiplier = 1.4;
  } else if (sm) {
    multiplier = 1.2;
  }
  const w = baseCalculated * multiplier;

  // Img2Img and Inpaint Strength Factors: strictly bounded to [0.0, 1.0]
  // Invariant: If a mask is present, inpaintImg2ImgStrength is checked exclusively.
  // It must never fall back to strength when a mask is present.
  let strengthFactor = 1.0;
  const hasMask = Boolean(params.has_mask || params.mask);
  const hasImage = Boolean(params.has_image || params.image);

  if (hasMask) {
    if (params.inpaintImg2ImgStrength !== undefined && params.inpaintImg2ImgStrength !== null) {
      const s = parseOptionalFloat(params.inpaintImg2ImgStrength);
      if (s !== null) strengthFactor = Math.max(0.0, Math.min(1.0, s));
    }
  } else if (hasImage) {
    if (params.strength !== undefined && params.strength !== null) {
      const s = parseOptionalFloat(params.strength);
      if (s !== null) strengthFactor = Math.max(0.0, Math.min(1.0, s));
    }
  }

  // Minimum floor of 2 Anlas per billable image
  const perImageAnlas = Math.max(Math.ceil(w * strengthFactor), ANLAS_MIN_PER_IMAGE_FLOOR);

  if (perImageAnlas > ANLAS_MAX_PER_IMAGE_CAP) {
    throw new Error(`Per-image cost of ${perImageAnlas} Anlas exceeds maximum cap of ${ANLAS_MAX_PER_IMAGE_CAP} Anlas.`);
  }

  const parsedSamples = parseOptionalInt(params.n_samples, 1);
  const nSamples = parsedSamples > 0 ? parsedSamples : 1;
  let billableSamples = nSamples;

  // Opus Lightweight Bonus:
  // If account is Opus, dimensions <= 1MP (1048576), and effective steps <= 28, 1 sample is free
  if (isOpus && area <= 1048576 && effectiveSteps <= 28) {
    billableSamples = Math.max(0, nSamples - 1);
  }

  const baseAnlas = perImageAnlas * billableSamples;

  // Character / Precise Reference Surcharge: 5 Anlas per reference per requested sample
  let rawRefs = params.precise_ref_count ?? params.precise_refs ?? params.character_reference_count ?? params.reference_count;
  
  if (rawRefs === undefined || rawRefs === null) {
    const cachedCount = Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0;
    const directCount = Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0;
    const multiCount = Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0;
    const arrayTotal = cachedCount + directCount + multiCount;
    if (arrayTotal > 0) rawRefs = arrayTotal;
  }

  const parsedRefs = parseOptionalInt(rawRefs, 0);
  const preciseRefs = parsedRefs > 0 ? parsedRefs : 0;
  const characterReferenceAnlas = 5 * preciseRefs * nSamples;

  // Vibe Transfer Surcharges (Exclusively for V4 / V4.5 models; V5 does not support Vibe)
  let vibeEncodingAnlas = 0;
  let vibeReferenceAnlas = 0;

  if (!isV5) {
    let rawUncached = params.uncached_vibe_count;
    let rawVibeRefs = params.vibe_reference_count;

    if (rawVibeRefs === undefined || rawVibeRefs === null) {
      if (Array.isArray(params.vibe_images)) rawVibeRefs = params.vibe_images.length;
      else if (Array.isArray(params.vibes)) rawVibeRefs = params.vibes.length;
    }

    const uncachedVibes = Math.max(0, parseOptionalInt(rawUncached, 0));
    const vibeRefs = Math.max(0, parseOptionalInt(rawVibeRefs, 0));

    vibeEncodingAnlas = uncachedVibes * 2;
    vibeReferenceAnlas = Math.max(0, vibeRefs - 4) * 2;
  }

  const totalAnlas = baseAnlas + characterReferenceAnlas + vibeEncodingAnlas + vibeReferenceAnlas;

  return {
    total: totalAnlas,
    base: baseAnlas,
    per_image: perImageAnlas,
    billable_samples: billableSamples,
    character_reference_anlas: characterReferenceAnlas,
    vibe_encoding_anlas: vibeEncodingAnlas,
    vibe_reference_anlas: vibeReferenceAnlas
  };
}

/**
 * Computes authoritative total integer Anlas cost for a given request.
 *
 * @param {object} params - Extracted payload parameters.
 * @param {object} [options={}] - Calculation context.
 * @returns {number} Integer Anlas cost.
 */
function calculateAnlasCost(params, options = {}) {
  const details = calculateAnlasCostDetails(params, options);
  return details.total;
}

/**
 * Pure read-only balance evaluator (Command Query Separation).
 * Computes dynamic available Anlas balance by deducting caller-supplied active cross-channel
 * reservation holds (heldAnlas = sum of Channel A + Channel B holds from Level 3) against the
 * user's persisted SQLite virtual Anlas balance. Preserves negative overdraft debt balances.
 *
 * Strict Level 2 isolation: accepts heldAnlas as an explicit scalar parameter from Level 4
 * rather than importing Level 3 queue state.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {number} [heldAnlas=0] - Non-negative integer sum of active Anlas reservation holds.
 * @returns {Promise<{user_id: string, priority_tier: string, virtual_balance: number, held_anlas: number, available_balance: number, is_in_debt: boolean}|null>}
 * @throws {Error} If userId is invalid or heldAnlas is not a non-negative safe integer.
 */
async function calculateAvailableBalance(userId, heldAnlas = 0) {
  assertNonEmptyString(userId, 'userId');
  const validatedHeld = assertNonNegativeSafeInt(heldAnlas, 'heldAnlas');

  if (userId === 'admin') {
    return {
      user_id: 'admin',
      priority_tier: 'Admin',
      virtual_balance: Infinity,
      held_anlas: 0,
      available_balance: Infinity,
      is_in_debt: false
    };
  }

  const user = await get(
    'SELECT user_id, priority_tier, virtual_anlas_balance FROM users WHERE user_id = ?',
    [userId]
  );
  if (!user) return null;

  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[user.priority_tier] || config.TIER_CONFIGS['Normal'];

  if (tierConfig.monthlyAnlas === Infinity) {
    return {
      user_id: user.user_id,
      priority_tier: user.priority_tier,
      virtual_balance: Infinity,
      held_anlas: validatedHeld,
      available_balance: Infinity,
      is_in_debt: false
    };
  }

  const virtualBalance = Math.trunc(user.virtual_anlas_balance || 0);
  const availableBalance = virtualBalance - validatedHeld;

  return {
    user_id: user.user_id,
    priority_tier: user.priority_tier,
    virtual_balance: virtualBalance,
    held_anlas: validatedHeld,
    available_balance: availableBalance,
    is_in_debt: virtualBalance < 0
  };
}

/**
 * Enforces the rolling 30-day virtual Anlas reset with strict zero rollover.
 * Offsets fresh tier allocation by any existing negative overdraft debt, resets
 * subscription-period usage counters (including for Infinity-quota principals), and prevents
 * multi-month accumulation after extended inactivity. Freezes banned accounts without mutating
 * balances or period epochs.
 * Note: Level 4 onboarding callers (/auth/status) must only invoke resets on approved devices.
 * Serialized per canonical user_id against TOCTOU races.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {number} [now=Date.now()] - Epoch timestamp in ms.
 * @returns {Promise<{user_id: string, virtual_balance: number, previous_balance: number, reset_applied: boolean, last_anlas_reset_epoch: number|null}|null>}
 * @throws {Error} If userId or now fails validation.
 */
async function evaluateAnlasReset(userId, now = Date.now()) {
  assertNonEmptyString(userId, 'userId');
  const safeNow = assertValidTimestamp(now, 'now');

  if (userId === 'admin') {
    return {
      user_id: 'admin',
      virtual_balance: Infinity,
      previous_balance: Infinity,
      reset_applied: false,
      last_anlas_reset_epoch: null
    };
  }

  return withUserLock(userId, async () => {
    const user = await get(
      'SELECT user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, subscription_period_start_epoch FROM users WHERE user_id = ?',
      [userId]
    );
    if (!user) return null;

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[user.priority_tier] || config.TIER_CONFIGS['Normal'];
    const isUnlimited = tierConfig.monthlyAnlas === Infinity;
    const currentBalance = isUnlimited ? Infinity : Math.trunc(user.virtual_anlas_balance || 0);
    const lastReset = user.last_anlas_reset_epoch;

    if (user.banned === 1) {
      return {
        user_id: user.user_id,
        virtual_balance: currentBalance,
        previous_balance: currentBalance,
        reset_applied: false,
        last_anlas_reset_epoch: lastReset ?? null
      };
    }

    const isInitialReset = (lastReset === null || lastReset === undefined);
    const elapsed = isInitialReset ? THIRTY_DAYS_MS : (safeNow - lastReset);

    if (!isInitialReset && elapsed < THIRTY_DAYS_MS) {
      return {
        user_id: user.user_id,
        virtual_balance: currentBalance,
        previous_balance: currentBalance,
        reset_applied: false,
        last_anlas_reset_epoch: lastReset
      };
    }

    if (isUnlimited) {
      await run(
        `UPDATE users
         SET last_anlas_reset_epoch = ?,
             subscription_period_anlas = 0,
             subscription_period_v5 = 0,
             subscription_period_start_epoch = ?
         WHERE user_id = ?`,
        [safeNow, safeNow, user.user_id]
      );

      return {
        user_id: user.user_id,
        virtual_balance: Infinity,
        previous_balance: Infinity,
        reset_applied: true,
        last_anlas_reset_epoch: safeNow
      };
    }

    // Strict zero-rollover allocation: positive unused balance is discarded; negative debt offsets fresh quota.
    // Inactive users spanning >1 month receive exactly 1x monthlyAnlas (zero multi-month stacking).
    const debtOffset = currentBalance < 0 ? currentBalance : 0;
    const newBalance = Math.trunc(tierConfig.monthlyAnlas) + debtOffset;

    await run(
      `UPDATE users
       SET virtual_anlas_balance = ?,
           last_anlas_reset_epoch = ?,
           subscription_period_anlas = 0,
           subscription_period_v5 = 0,
           subscription_period_start_epoch = ?
       WHERE user_id = ?`,
      [newBalance, safeNow, safeNow, user.user_id]
    );

    return {
      user_id: user.user_id,
      virtual_balance: newBalance,
      previous_balance: currentBalance,
      reset_applied: true,
      last_anlas_reset_epoch: safeNow
    };
  });
}

/**
 * Lazily accrues daily V5 Normalized Compute Points (NCP) for Bucket 1 (Personal Rollover Bank).
 * Evaluates proportional cluster weights strictly across distinct, unbanned, approved canonical
 * users (1 weight per user_id regardless of linked device count), caps balances at
 * tierConfig.v5MaxBankDays, resets v5_daily_consumed on day rollovers, and preserves strict
 * integer balances in SQLite. Always reports accurate active daily_share_ncp, max_bank_ncp,
 * and total_cluster_weight even when the 24-hour accrual boundary has not yet elapsed.
 * Leaves unapproved or banned principals unmutated, and avoids stamping v5_last_accrual_epoch
 * on zero-weight principals with zero balance so tier upgrades take effect without a 24h wait.
 * Serialized per canonical user_id against TOCTOU races.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {object} [options={}] - Accrual evaluation overrides.
 * @param {number} [options.now=Date.now()] - Epoch timestamp in ms.
 * @param {number|null} [options.nominalDailyCompute=null] - Optional validated C_base High-equivalent image rate.
 * @returns {Promise<{user_id: string, v5_banked_balance: number, v5_daily_consumed: number, accrual_applied: boolean, daily_share_ncp: number, max_bank_ncp: number, total_cluster_weight: number, v5_last_accrual_epoch: number|null}|null>}
 * @throws {Error} If userId, options, or now fails validation.
 */
async function evaluateV5Accrual(userId, options = {}) {
  assertNonEmptyString(userId, 'userId');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('[Audit Error] options must be a plain object.');
  }

  const { now = Date.now(), nominalDailyCompute = null } = options;
  const safeNow = assertValidTimestamp(now, 'now');

  if (nominalDailyCompute !== null) {
    if (typeof nominalDailyCompute !== 'number' || !Number.isFinite(nominalDailyCompute) || nominalDailyCompute <= 0) {
      throw new Error('[Audit Error] nominalDailyCompute must be a positive finite number or null.');
    }
  }

  if (userId === 'admin') {
    return {
      user_id: 'admin',
      v5_banked_balance: Infinity,
      v5_daily_consumed: 0,
      accrual_applied: false,
      daily_share_ncp: Infinity,
      max_bank_ncp: Infinity,
      total_cluster_weight: 0,
      v5_last_accrual_epoch: null
    };
  }

  return withUserLock(userId, async () => {
    const user = await get(
      'SELECT user_id, priority_tier, banned, v5_banked_balance, v5_last_accrual_epoch, v5_daily_consumed FROM users WHERE user_id = ?',
      [userId]
    );
    if (!user) return null;

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[user.priority_tier] || config.TIER_CONFIGS['Normal'];
    const currentBanked = Math.max(0, Math.trunc(user.v5_banked_balance || 0));
    const currentDailyConsumed = Math.max(0, Math.trunc(user.v5_daily_consumed || 0));
    const lastAccrual = user.v5_last_accrual_epoch;

    // Determine nominal daily cluster compute in integer NCP
    const cBase = nominalDailyCompute !== null
      ? Math.max(V5_DAILY_COMPUTE_MIN, Math.min(V5_DAILY_COMPUTE_MAX, nominalDailyCompute))
      : config.NOMINAL_DAILY_V5_COMPUTE;
    const nominalDailyNcp = Math.floor(cBase * V5_HIGH_NCP_COST);

    // Aggregate W_all across distinct canonical users who are unbanned and hold >=1 approved device
    const approvedUsers = await all(
      `SELECT u.user_id, u.priority_tier
       FROM users u
       WHERE u.banned = 0
         AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.user_id AND d.approved = 1)`
    );

    let totalWeight = 0;
    let isTargetApproved = false;
    for (const row of approvedUsers) {
      const rowTier = config.TIER_CONFIGS[row.priority_tier] || config.TIER_CONFIGS['Normal'];
      const w = Number.isInteger(rowTier.v5Weight) && rowTier.v5Weight > 0 ? rowTier.v5Weight : 0;
      totalWeight += w;
      if (row.user_id === user.user_id) {
        isTargetApproved = true;
      }
    }

    // Preserve existing bank and epoch untouched when principal is banned or has zero approved devices
    if (user.banned === 1 || !isTargetApproved) {
      return {
        user_id: user.user_id,
        v5_banked_balance: currentBanked,
        v5_daily_consumed: currentDailyConsumed,
        accrual_applied: false,
        daily_share_ncp: 0,
        max_bank_ncp: 0,
        total_cluster_weight: totalWeight,
        v5_last_accrual_epoch: lastAccrual ?? null
      };
    }

    const userWeight = (Number.isInteger(tierConfig.v5Weight) && tierConfig.v5Weight > 0)
      ? tierConfig.v5Weight
      : 0;
    const maxBankDays = tierConfig.v5MaxBankDays ?? 0;

    let dailyShareNcp = 0;
    if (userWeight > 0 && totalWeight > 0) {
      dailyShareNcp = Math.floor(nominalDailyNcp * (userWeight / totalWeight));
    }

    const maxBankNcp = maxBankDays === Infinity
      ? Infinity
      : dailyShareNcp * Math.max(0, Math.trunc(maxBankDays));

    // Avoid locking zero-weight principals (e.g. Metered) into a 24h cooldown unless downgrading existing state
    if (userWeight === 0 && maxBankNcp === 0 && currentBanked === 0 && currentDailyConsumed === 0) {
      return {
        user_id: user.user_id,
        v5_banked_balance: 0,
        v5_daily_consumed: 0,
        accrual_applied: false,
        daily_share_ncp: 0,
        max_bank_ncp: 0,
        total_cluster_weight: totalWeight,
        v5_last_accrual_epoch: lastAccrual ?? null
      };
    }

    const isInitialAccrual = (lastAccrual === null || lastAccrual === undefined);
    if (!isInitialAccrual && (safeNow - lastAccrual < DAY_MS)) {
      return {
        user_id: user.user_id,
        v5_banked_balance: currentBanked,
        v5_daily_consumed: currentDailyConsumed,
        accrual_applied: false,
        daily_share_ncp: dailyShareNcp,
        max_bank_ncp: maxBankNcp,
        total_cluster_weight: totalWeight,
        v5_last_accrual_epoch: lastAccrual
      };
    }

    const wholeDays = isInitialAccrual ? 1 : Math.floor((safeNow - lastAccrual) / DAY_MS);
    const nextAccrualEpoch = isInitialAccrual ? safeNow : (lastAccrual + (wholeDays * DAY_MS));

    const accruedNcp = dailyShareNcp * wholeDays;
    const uncappedBalance = currentBanked + accruedNcp;
    const newBanked = maxBankNcp === Infinity
      ? Math.min(Number.MAX_SAFE_INTEGER, uncappedBalance)
      : Math.min(maxBankNcp, uncappedBalance);

    await run(
      `UPDATE users
       SET v5_banked_balance = ?,
           v5_last_accrual_epoch = ?,
           v5_daily_consumed = 0
       WHERE user_id = ?`,
      [newBanked, nextAccrualEpoch, user.user_id]
    );

    return {
      user_id: user.user_id,
      v5_banked_balance: newBanked,
      v5_daily_consumed: 0,
      accrual_applied: true,
      daily_share_ncp: dailyShareNcp,
      max_bank_ncp: maxBankNcp,
      total_cluster_weight: totalWeight,
      v5_last_accrual_epoch: nextAccrualEpoch
    };
  });
}

/**
 * Authorizes an Anlas spending operation against debt lockouts, spend caps, and
 * cross-channel available balance (deducting active heldAnlas passed from Level 4).
 * Enforces HTTP 403 DEBT_LOCKED whenever an account in negative Anlas debt attempts
 * any Anlas-consuming bypass or addon request, while keeping 0-Anlas free Opus requests open.
 * Fails closed on contradictory X-Base-Paid=true payloads declaring <2 Anlas so 0-balance
 * clients cannot enter the 50MB staging semaphore on forged base-paid headers.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {object} [options={}] - Spend authorization context.
 * @param {number} [options.declaredAnlas=0] - Client X-Declared-Anlas ceiling.
 * @param {number|null} [options.requiredAnlas=null] - Server authoritative C_auth cost (if post-buffer).
 * @param {boolean} [options.isBasePaid=false] - Whether X-Base-Paid is asserted.
 * @param {number} [options.heldAnlas=0] - Active cross-channel Anlas holds for this user.
 * @returns {Promise<{ok: boolean, status?: number, error?: string, message?: string, virtual_balance?: number, available_balance?: number, held_anlas?: number, debt_free_bypass?: boolean}>}
 * @throws {Error} If parameters fail fail-closed integer/boolean validation.
 */
async function authorizeAnlasSpend(userId, options = {}) {
  assertNonEmptyString(userId, 'userId');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('[Audit Error] options must be a plain object.');
  }

  const {
    declaredAnlas = 0,
    requiredAnlas = null,
    isBasePaid = false,
    heldAnlas = 0
  } = options;

  const validatedDeclared = assertNonNegativeSafeInt(declaredAnlas, 'declaredAnlas');
  const validatedHeld = assertNonNegativeSafeInt(heldAnlas, 'heldAnlas');
  const validatedRequired = requiredAnlas !== null
    ? assertNonNegativeSafeInt(requiredAnlas, 'requiredAnlas')
    : null;

  if (typeof isBasePaid !== 'boolean') {
    throw new Error('[Audit Error] isBasePaid must be a boolean.');
  }

  const balanceInfo = await calculateAvailableBalance(userId, validatedHeld);
  if (!balanceInfo) {
    return {
      ok: false,
      status: 401,
      error: 'USER_NOT_FOUND',
      message: 'Access Denied: Canonical user ledger record not found.'
    };
  }

  if (balanceInfo.virtual_balance === Infinity) {
    return {
      ok: true,
      virtual_balance: Infinity,
      available_balance: Infinity,
      held_anlas: validatedHeld
    };
  }

  const requestsAnlas = validatedDeclared > 0 || isBasePaid || (validatedRequired !== null && validatedRequired > 0);

  // Rule 1: Debt Lockout Enforcement (Active debt locks all bypass/addon Anlas usage)
  if (balanceInfo.is_in_debt) {
    if (requestsAnlas) {
      return {
        ok: false,
        status: 403,
        error: 'DEBT_LOCKED',
        message: `Access Denied: Account holds an Anlas debt (${balanceInfo.virtual_balance} Anlas). Anlas-consuming generations are locked until balance restoration. Free Opus generations remain operational.`,
        virtual_balance: balanceInfo.virtual_balance,
        available_balance: balanceInfo.available_balance,
        held_anlas: validatedHeld
      };
    }
    return {
      ok: true,
      virtual_balance: balanceInfo.virtual_balance,
      available_balance: balanceInfo.available_balance,
      held_anlas: validatedHeld,
      debt_free_bypass: true
    };
  }

  // Rule 2: Zero-cost free Opus request in good standing
  const effectiveCost = validatedRequired !== null ? validatedRequired : validatedDeclared;
  if (effectiveCost === 0 && !isBasePaid) {
    return {
      ok: true,
      virtual_balance: balanceInfo.virtual_balance,
      available_balance: balanceInfo.available_balance,
      held_anlas: validatedHeld
    };
  }

  // Rule 2b: Base-paid generation minimum floor invariant (>= 2 Anlas)
  // Prevents X-Base-Paid=true + X-Declared-Anlas=0 from passing Stage 1 with 0 available balance.
  const minimumExpectedCost = isBasePaid ? Math.max(effectiveCost, ANLAS_MIN_PER_IMAGE_FLOOR) : effectiveCost;

  // Rule 3: Cross-channel available balance sufficiency
  if (minimumExpectedCost > balanceInfo.available_balance) {
    return {
      ok: false,
      status: 403,
      error: 'INSUFFICIENT_ANLAS',
      message: `Insufficient virtual Anlas balance (${balanceInfo.available_balance} available after ${validatedHeld} held, ${minimumExpectedCost} required).`,
      virtual_balance: balanceInfo.virtual_balance,
      available_balance: balanceInfo.available_balance,
      held_anlas: validatedHeld
    };
  }

  // Rule 4: Declared spend ceiling enforcement (minimum 2 Anlas when X-Base-Paid=true, and C_auth <= X-Declared-Anlas)
  if (isBasePaid && validatedDeclared < ANLAS_MIN_PER_IMAGE_FLOOR) {
    return {
      ok: false,
      status: 400,
      error: 'SPEND_CAP_EXCEEDED',
      message: `X-Base-Paid=true requires X-Declared-Anlas >= ${ANLAS_MIN_PER_IMAGE_FLOOR} (received ${validatedDeclared}).`,
      virtual_balance: balanceInfo.virtual_balance,
      available_balance: balanceInfo.available_balance,
      held_anlas: validatedHeld
    };
  }

  if (validatedRequired !== null && validatedRequired > validatedDeclared) {
    return {
      ok: false,
      status: 400,
      error: 'SPEND_CAP_EXCEEDED',
      message: `Authoritative cost (${validatedRequired} Anlas) exceeds X-Declared-Anlas spend cap (${validatedDeclared} Anlas).`,
      virtual_balance: balanceInfo.virtual_balance,
      available_balance: balanceInfo.available_balance,
      held_anlas: validatedHeld
    };
  }

  return {
    ok: true,
    virtual_balance: balanceInfo.virtual_balance,
    available_balance: balanceInfo.available_balance,
    held_anlas: validatedHeld
  };
}

/**
 * Commits an authoritative Point-of-No-Return (PoNR) virtual Anlas debit to SQLite.
 * Preserves negative overdraft integer balances if concurrent or manual adjustments drive
 * finite-quota accounts below zero, exempts Infinity-quota tiers from accumulating phantom
 * debt while still recording subscription-period and lifetime Anlas metrics, and mirrors
 * lifetime consumption onto the originating device record.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {number} amount - Non-negative integer Anlas to debit.
 * @param {string|null} [browserId=null] - Optional originating hardware footprint for device metrics.
 * @returns {Promise<{committed: boolean, virtual_balance: number}>}
 * @throws {Error} If identifiers or amount fail validation.
 */
async function commitAnlasDebit(userId, amount, browserId = null) {
  assertNonEmptyString(userId, 'userId');
  const validatedAmount = assertNonNegativeSafeInt(amount, 'amount');
  if (browserId !== null) {
    assertNonEmptyString(browserId, 'browserId');
  }

  if (userId === 'admin') {
    return { committed: false, virtual_balance: Infinity };
  }

  if (validatedAmount === 0) {
    const row = await get('SELECT priority_tier, virtual_anlas_balance FROM users WHERE user_id = ?', [userId]);
    if (!row) {
      return { committed: false, virtual_balance: 0 };
    }
    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[row.priority_tier] || config.TIER_CONFIGS['Normal'];
    return {
      committed: false,
      virtual_balance: tierConfig.monthlyAnlas === Infinity ? Infinity : Math.trunc(row.virtual_anlas_balance || 0)
    };
  }

  return withUserLock(userId, async () => {
    const userRow = await get('SELECT priority_tier FROM users WHERE user_id = ?', [userId]);
    if (!userRow) {
      return { committed: false, virtual_balance: 0 };
    }

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[userRow.priority_tier] || config.TIER_CONFIGS['Normal'];
    const isUnlimitedAnlas = tierConfig.monthlyAnlas === Infinity;

    await run(
      `UPDATE users
       SET virtual_anlas_balance = CASE WHEN ? THEN virtual_anlas_balance ELSE virtual_anlas_balance - ? END,
           subscription_period_anlas = subscription_period_anlas + ?,
           anlas_consumed = anlas_consumed + ?
       WHERE user_id = ?`,
      [isUnlimitedAnlas ? 1 : 0, validatedAmount, validatedAmount, validatedAmount, userId]
    );

    if (browserId) {
      await run(
        'UPDATE devices SET anlas_consumed = anlas_consumed + ? WHERE browser_id = ?',
        [validatedAmount, browserId]
      );
    }

    if (isUnlimitedAnlas) {
      return { committed: true, virtual_balance: Infinity };
    }

    const updated = await get('SELECT virtual_anlas_balance FROM users WHERE user_id = ?', [userId]);
    return {
      committed: true,
      virtual_balance: updated ? Math.trunc(updated.virtual_anlas_balance || 0) : 0
    };
  });
}

/**
 * Commits an authoritative Point-of-No-Return (PoNR) V5 personal bank NCP deduction to SQLite.
 * Treats zero-cost debits as a read-only no-op consistent with commitAnlasDebit, clamps
 * remaining v5_banked_balance via MAX(0, ...), and increments daily and subscription-period
 * V5 generation counters.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {number} ncpCost - Non-negative integer NCP to deduct (18 High, 10 Medium).
 * @returns {Promise<{committed: boolean, v5_banked_balance: number}>}
 * @throws {Error} If userId or ncpCost fails validation.
 */
async function commitV5Debit(userId, ncpCost) {
  assertNonEmptyString(userId, 'userId');
  const validatedNcp = assertNonNegativeSafeInt(ncpCost, 'ncpCost');

  if (userId === 'admin') {
    return { committed: false, v5_banked_balance: Infinity };
  }

  if (validatedNcp === 0) {
    const row = await get('SELECT v5_banked_balance FROM users WHERE user_id = ?', [userId]);
    return {
      committed: false,
      v5_banked_balance: row ? Math.max(0, Math.trunc(row.v5_banked_balance || 0)) : 0
    };
  }

  return withUserLock(userId, async () => {
    const result = await run(
      `UPDATE users
       SET v5_banked_balance = MAX(0, v5_banked_balance - ?),
           v5_daily_consumed = v5_daily_consumed + 1,
           subscription_period_v5 = subscription_period_v5 + 1
       WHERE user_id = ?`,
      [validatedNcp, userId]
    );

    if (!result || result.changes === 0) {
      return { committed: false, v5_banked_balance: 0 };
    }

    const updated = await get('SELECT v5_banked_balance FROM users WHERE user_id = ?', [userId]);
    return {
      committed: true,
      v5_banked_balance: updated ? Math.max(0, Math.trunc(updated.v5_banked_balance || 0)) : 0
    };
  });
}

/**
 * Records a Point-of-No-Return (PoNR) Bucket 2 (Cluster Surplus) V5 generation
 * against the user's daily and subscription-period V5 counters without deducting personal bank NCP.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @returns {Promise<void>}
 * @throws {Error} If userId is invalid.
 */
async function recordSurplusV5Usage(userId) {
  assertNonEmptyString(userId, 'userId');
  if (userId === 'admin') return;

  await withUserLock(userId, async () => {
    await run(
      `UPDATE users
       SET v5_daily_consumed = v5_daily_consumed + 1,
           subscription_period_v5 = subscription_period_v5 + 1
       WHERE user_id = ?`,
      [userId]
    );
  });
}

/**
 * Internal zero-copy binary parser.
 * Traverses boundary frames in multipart streams without scanning arbitrary binary data.
 * Collects a structural manifest of parts (detecting binary image and mask presence)
 * while safely extracting and validating the JSON request slice.
 *
 * @param {Buffer} buffer - Outbound raw client payload buffer.
 * @param {string|null} [contentType=null] - Optional Content-Type header string.
 * @returns {{ json: object|null, has_image: boolean, has_mask: boolean }|null} Parsed descriptor or null.
 */
function extractDescriptorFromBuffer(buffer, contentType = null) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  let boundary = null;

  if (typeof contentType === 'string') {
    const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    if (match) {
      boundary = (match[1] || match[2]).trim();
    }
  }

  // Fallback boundary extraction from raw buffer prefix
  if (!boundary) {
    let offset = 0;
    while (offset < buffer.length && (buffer[offset] === 0x20 || buffer[offset] === 0x0A || buffer[offset] === 0x0D || buffer[offset] === 0x09)) {
      offset++;
    }
    if (offset + 2 < buffer.length && buffer[offset] === 0x2D && buffer[offset + 1] === 0x2D) {
      let lineEnd = -1;
      for (let i = offset + 2; i < Math.min(buffer.length, offset + 512); i++) {
        if (buffer[i] === 0x0A) {
          lineEnd = (i > offset + 2 && buffer[i - 1] === 0x0D) ? i - 1 : i;
          break;
        }
      }
      if (lineEnd !== -1) {
        boundary = buffer.subarray(offset + 2, lineEnd).toString('utf8').trim();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Multipart/FormData Extraction via Linear Boundary Traversal
  // ---------------------------------------------------------------------------
  if (boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    let partSearchOffset = 0;
    let extractedJson = null;
    let hasImage = false;
    let hasMask = false;

    while (partSearchOffset < buffer.length) {
      const boundaryIdx = buffer.indexOf(delimiter, partSearchOffset);
      if (boundaryIdx === -1) break;

      // RFC 2046 Line-Start Invariant: boundary delimiter must be at index 0 or preceded by LF (0x0A)
      if (boundaryIdx > 0 && buffer[boundaryIdx - 1] !== 0x0A) {
        partSearchOffset = boundaryIdx + 1;
        continue;
      }

      let cursor = boundaryIdx + delimiter.length;

      // Check for terminal close-delimiter '--'
      let isClosing = false;
      if (cursor + 1 < buffer.length && buffer[cursor] === 0x2D && buffer[cursor + 1] === 0x2D) {
        isClosing = true;
        cursor += 2;
      }

      // RFC 2046 Transport Padding: skip linear whitespace (0x20, 0x09)
      while (cursor < buffer.length && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) {
        cursor++;
      }

      // Skip trailing line break
      if (cursor < buffer.length && buffer[cursor] === 0x0D) cursor++;
      if (cursor < buffer.length && buffer[cursor] === 0x0A) cursor++;

      if (isClosing) {
        break; // Reached terminal boundary
      }

      const partHeaderStart = cursor;
      const maxHeaderScan = Math.min(buffer.length, partHeaderStart + 4096);
      const headerWindow = buffer.subarray(partHeaderStart, maxHeaderScan);

      let headerEnd = -1;
      let headerDelimLen = 0;

      const crlfEnd = headerWindow.indexOf(NEEDLE_CRLF_CRLF);
      const lfEnd = headerWindow.indexOf(NEEDLE_LF_LF);

      if (crlfEnd !== -1 && lfEnd !== -1) {
        if (crlfEnd <= lfEnd) {
          headerEnd = partHeaderStart + crlfEnd;
          headerDelimLen = 4;
        } else {
          headerEnd = partHeaderStart + lfEnd;
          headerDelimLen = 2;
        }
      } else if (crlfEnd !== -1) {
        headerEnd = partHeaderStart + crlfEnd;
        headerDelimLen = 4;
      } else if (lfEnd !== -1) {
        headerEnd = partHeaderStart + lfEnd;
        headerDelimLen = 2;
      }

      if (headerEnd === -1) {
        partSearchOffset = boundaryIdx + delimiter.length;
        continue;
      }

      const partHeaderSlice = buffer.subarray(partHeaderStart, headerEnd);
      const partHeaderText = partHeaderSlice.toString('utf8');

      // Detect binary image and mask parts from headers without buffering their bodies
      if (PART_NAME_IMAGE_REGEX.test(partHeaderText)) {
        hasImage = true;
      } else if (PART_NAME_MASK_REGEX.test(partHeaderText)) {
        hasMask = true;
      } else if (!extractedJson && PART_NAME_REQUEST_REGEX.test(partHeaderText)) {
        const jsonStart = headerEnd + headerDelimLen;
        let searchBoundaryFrom = jsonStart;

        while (searchBoundaryFrom < buffer.length) {
          const nextBoundaryIdx = buffer.indexOf(delimiter, searchBoundaryFrom);
          if (nextBoundaryIdx === -1) break;

          // Line-Start Invariant on closing boundary
          if (nextBoundaryIdx > 0 && buffer[nextBoundaryIdx - 1] !== 0x0A) {
            searchBoundaryFrom = nextBoundaryIdx + 1;
            continue;
          }

          let jsonEnd = nextBoundaryIdx;

          // Strip preceding line breaks
          if (jsonEnd > jsonStart && buffer[jsonEnd - 1] === 0x0A) {
            jsonEnd--;
            if (jsonEnd > jsonStart && buffer[jsonEnd - 1] === 0x0D) {
              jsonEnd--;
            }
          }

          const sliceLength = jsonEnd - jsonStart;
          if (sliceLength > MAX_JSON_PART_BYTES) {
            break; // Exceeds permissible metadata allocation ceiling
          }

          if (sliceLength > 0) {
            // Pre-allocation Syntax Guard: scan backward to verify terminal non-whitespace byte is 0x7D ('}')
            let lastByteIdx = jsonEnd - 1;
            while (lastByteIdx >= jsonStart) {
              const b = buffer[lastByteIdx];
              if (b !== 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) {
                break;
              }
              lastByteIdx--;
            }

            if (lastByteIdx >= jsonStart && buffer[lastByteIdx] === 0x7D) {
              const jsonSlice = buffer.subarray(jsonStart, jsonEnd);
              try {
                const parsed = JSON.parse(jsonSlice.toString('utf8').trim());
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  extractedJson = parsed;
                  // Invariant: Advance search pointer directly to the terminating boundary of the request part.
                  // Prevents the outer scanner from regressing backwards and re-scanning JSON contents.
                  partSearchOffset = nextBoundaryIdx;
                  break;
                }
              } catch (_) {
                // Continue scanning in case of false boundary match inside string
              }
            }
          }

          searchBoundaryFrom = nextBoundaryIdx + delimiter.length;
        }
      }

      // If the part was not advanced by request extraction, advance past this part's opening delimiter
      if (partSearchOffset <= boundaryIdx) {
        partSearchOffset = boundaryIdx + delimiter.length;
      }
    }

    if (extractedJson) {
      return { json: extractedJson, has_image: hasImage, has_mask: hasMask };
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Direct application/json Extraction
  // ---------------------------------------------------------------------------
  const scanLimit = Math.min(buffer.length, 4096);
  let startIdx = -1;
  for (let i = 0; i < scanLimit; i++) {
    const b = buffer[i];
    if (b !== 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) {
      if (b === 0x7B) { // '{'
        startIdx = i;
      }
      break;
    }
  }

  if (startIdx !== -1) {
    let endIdx = buffer.length - 1;
    while (endIdx >= startIdx) {
      const b = buffer[endIdx];
      if (b !== 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) {
        break;
      }
      endIdx--;
    }

    const jsonLength = endIdx - startIdx + 1;

    // Heap Defense: Enforce metadata boundary ceiling on direct JSON parsing
    if (jsonLength > 0 && jsonLength <= MAX_JSON_PART_BYTES && buffer[endIdx] === 0x7D) { // '}'
      try {
        const jsonSlice = buffer.subarray(startIdx, endIdx + 1);
        const parsed = JSON.parse(jsonSlice.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const hasImage = Boolean(parsed.image || parsed.parameters?.image);
          const hasMask = Boolean(parsed.mask || parsed.parameters?.mask);
          return { json: parsed, has_image: hasImage, has_mask: hasMask };
        }
      } catch (_) {
        return null;
      }
    }
  }

  return null;
}

/**
 * Format-agnostic parameter extractor.
 * Safely parses JSON blocks or multipart streams, identifying character references.
 * Hardened against malformed JSON, truncated boundaries, and ReDoS injections.
 *
 * @param {Buffer} buffer - Outbound raw client payload buffer.
 * @param {string|null} [contentType=null] - Optional Content-Type header string.
 * @returns {object|null} Structured parameters or null on parsing failure.
 */
function extractParametersFromRawBody(buffer, contentType = null) {
  try {
    const descriptor = extractDescriptorFromBuffer(buffer, contentType);
    if (!descriptor || !descriptor.json) return null;

    const parsed = descriptor.json;
    const params = (parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters))
      ? parsed.parameters
      : parsed;

    const preciseRefs = 
      (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) +
      (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0) +
      (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0);

    const rawWidth = params.width ?? parsed.width;
    const rawHeight = params.height ?? parsed.height;
    const rawSteps = params.steps ?? parsed.steps;
    const rawSamples = params.n_samples ?? parsed.n_samples;

    const parsedWidth = parseOptionalInt(rawWidth);
    const parsedHeight = parseOptionalInt(rawHeight);
    const parsedSteps = parseOptionalInt(rawSteps);
    const parsedSamples = parseOptionalInt(rawSamples);
    const parsedModel = typeof parsed.model === 'string' ? parsed.model : (typeof params.model === 'string' ? params.model : null);

    const parsedStrength = parseOptionalFloat(params.strength ?? parsed.strength);
    const parsedInpaintStrength = parseOptionalFloat(params.inpaintImg2ImgStrength ?? parsed.inpaintImg2ImgStrength);

    const hasImage = descriptor.has_image || Boolean(params.image || parsed.image);
    const hasMask = descriptor.has_mask || Boolean(params.mask || parsed.mask);

    const parsedUncached = parseOptionalInt(params.uncached_vibe_count ?? parsed.uncached_vibe_count, 0);
    const uncachedVibes = parsedUncached > 0 ? parsedUncached : 0;

    let rawVibeRefs = params.vibe_reference_count ?? parsed.vibe_reference_count;
    if (rawVibeRefs === undefined || rawVibeRefs === null) {
      if (Array.isArray(params.vibe_images)) rawVibeRefs = params.vibe_images.length;
      else if (Array.isArray(params.vibes)) rawVibeRefs = params.vibes.length;
    }
    const parsedVibeRefs = parseOptionalInt(rawVibeRefs, 0);
    const vibeRefs = parsedVibeRefs > 0 ? parsedVibeRefs : 0;

    // Strict Nullish Coalescing: Child parameter strictly overrides parent parameter
    const rawSm = params.sm ?? parsed.sm;
    const rawSmDyn = params.sm_dyn ?? parsed.sm_dyn;
    const sm = rawSm === true || rawSm === 'true' || rawSm === 1;
    const smDyn = rawSmDyn === true || rawSmDyn === 'true' || rawSmDyn === 1;

    return {
      width: parsedWidth,
      height: parsedHeight,
      steps: parsedSteps,
      n_samples: parsedSamples,
      precise_ref_count: preciseRefs,
      model: parsedModel,
      sm,
      sm_dyn: smDyn,
      strength: parsedStrength !== null ? Math.max(0.0, Math.min(1.0, parsedStrength)) : null,
      inpaintImg2ImgStrength: parsedInpaintStrength !== null ? Math.max(0.0, Math.min(1.0, parsedInpaintStrength)) : null,
      has_image: hasImage,
      has_mask: hasMask,
      uncached_vibe_count: uncachedVibes,
      vibe_reference_count: vibeRefs
    };
  } catch (err) {
    console.error('[VPS Audit] Error extracting parameters from raw body:', err.message);
  }
  return null;
}

/**
 * Recursively inspects a JSON payload and replaces massive Base64 strings
 * with compact metadata placeholders to prevent log bloat.
 * Whitelists prompt keys to prevent destructive corruption of tag-based prompts.
 *
 * @param {*} obj - Target payload object.
 * @param {string} [parentKey=''] - Immediate parent property name.
 * @returns {*} Sanitized object copy.
 */
function sanitizeObjectForLogging(obj, parentKey = '') {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForLogging(item, parentKey));
  }

  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, val] of Object.entries(obj)) {
      cleaned[key] = sanitizeObjectForLogging(val, key);
    }
    return cleaned;
  }

  if (typeof obj === 'string') {
    const lowerKey = parentKey.toLowerCase();
    const isPromptKey = TELEMETRY_PROMPT_KEYS.has(lowerKey) || lowerKey.includes('prompt');

    // Whitelist Invariant: Prompt prose keys are never subjected to Base64 truncation
    if (isPromptKey) {
      return obj;
    }

    const isImageKey = lowerKey.includes('image') || lowerKey.includes('mask') || lowerKey.includes('vibe') || lowerKey.includes('ref');
    
    // Explicit Base64 Data URI Truncation
    if (obj.startsWith('data:image/') && obj.length > 500) {
      const mimeType = obj.split(';')[0];
      return `[Truncated ${mimeType}, Length: ${obj.length} chars]`;
    }

    // Raw Base64 string truncation under image/mask context or pure binary base64 strings without spaces
    if (obj.length > 500 && (isImageKey || (!obj.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(obj.substring(0, 100))))) {
      return `[Truncated Base64/Binary, Length: ${obj.length} chars]`;
    }
  }

  return obj;
}

/**
 * Formats JSON and Multipart/FormData payloads into a structured string for telemetry.
 * Preserves full prompt and parameter fields while safely truncating binary image data.
 *
 * @param {Buffer} buffer - Raw request body buffer.
 * @param {string|null} [contentType=null] - Optional Content-Type header string.
 * @returns {string} Formatted log output.
 */
function formatPayloadForLogging(buffer, contentType = null) {
  try {
    if (!buffer || buffer.length === 0) return "{ empty payload }";

    const descriptor = extractDescriptorFromBuffer(buffer, contentType);
    if (descriptor && descriptor.json) {
      return JSON.stringify(sanitizeObjectForLogging(descriptor.json), null, 2);
    }

    if (buffer.length >= 2 && buffer[0] === 0x2D && buffer[1] === 0x2D) {
      return `[Multipart Payload, Length: ${buffer.length} bytes]`;
    }

    const previewLen = Math.min(buffer.length, 1000);
    const previewStr = buffer.subarray(0, previewLen).toString('utf8');
    return previewStr + (buffer.length > 1000 ? `... [Truncated raw data, Total: ${buffer.length} bytes]` : '');
  } catch (err) {
    return `[Logger Error] Parsing failure: ${err.message}. Raw payload size: ${buffer.length} bytes.`;
  }
}

/**
 * Executes deep background auditing on transmitted payload buffers.
 * Detects model spoofing bypass attempts and hard-limit violations.
 * Updates both the canonical user record and device records for zero-regression reporting.
 * Bypasses step-count validation strictly on V5 Medium models conforming to ACS-1 specifications.
 * 
 * @param {string} browserId - Unique device key.
 * @param {Buffer} payloadBuffer - Accumulated outbound parameters buffer.
 * @param {boolean} clientReportedV5 - Model validation flag received in header.
 * @param {string|null} [contentType=null] - Outbound Content-Type header string.
 * @returns {Promise<object>} Audit report containing ban status and eviction targets.
 */
async function runBackgroundAudit(browserId, payloadBuffer, clientReportedV5, contentType = null) {
  const actualParams = extractParametersFromRawBody(payloadBuffer, contentType);
  if (!actualParams) return { banned: false, discordId: null, userId: null, browserId };

  const { width, height, steps, n_samples, precise_ref_count, model } = actualParams;
  
  const actualPixels = (width && height) ? (width * height) : 0;
  const actualSteps = steps || 0;
  const actualSamples = n_samples || 1;
  const actualRefs = precise_ref_count || 0;

  const device = await get(
    `SELECT d.user_id, d.discord_id, d.priority_tier as legacy_tier, u.priority_tier as u_tier 
     FROM devices d 
     LEFT JOIN users u ON u.user_id = COALESCE(d.user_id, d.discord_id, d.browser_id) 
     WHERE d.browser_id = ?`, 
    [browserId]
  );
  if (!device) return { banned: false, discordId: null, userId: null, browserId };

  const targetUserId = device.user_id || device.discord_id || browserId;
  const effectiveTier = device.u_tier || device.legacy_tier || 'Normal';

  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[effectiveTier] || config.TIER_CONFIGS['Normal'];
  
  // ACS-1 Invariant: V5 Medium Effort silently ignores step counts upstream. Step count firewall bypasses Medium.
  const isV5Medium = isV5MediumModel(model);
  const stepViolation = !isV5Medium && (actualSteps > config.FIREWALL_MAX_STEPS);

  // Header Spoofing Detection
  const isViolation = (actualPixels > config.FIREWALL_MAX_PIXELS) || 
                      stepViolation || 
                      (actualSamples !== config.FIREWALL_MAX_SAMPLES) || 
                      (actualRefs > tierConfig.preciseLimit);

  // V5 model string matching bypass verification
  const isV5Model = isV5ModelFamily(model);
  const bypassViolation = isV5Model && !clientReportedV5;

  // Normalized Ledger execution: update canonical user and device rows
  const anlasSpent = actualRefs * 5;
  if (anlasSpent > 0) {
    await run('UPDATE users SET anlas_consumed = anlas_consumed + ? WHERE user_id = ?', [anlasSpent, targetUserId]);
    await run('UPDATE devices SET anlas_consumed = anlas_consumed + ? WHERE browser_id = ?', [anlasSpent, browserId]);
    console.log(`[VPS Audit Ledger] Deducted ${anlasSpent} Anlas on user profile ${targetUserId} (refs used: ${actualRefs})`);
  }

  // Punitive execution on hostile mismatch
  if (isViolation || bypassViolation) {
    console.warn(`\x1b[31m[VPS SECURITY AUDIT] !!! HOSTILE PAYLOAD SPOOFING DETECTED !!!\x1b[0m`);
    console.warn(`[VPS Security Audit] Device: "${browserId}", User: "${targetUserId}", Tier: "${effectiveTier}"`);
    
    try {
      const banReason = bypassViolation 
        ? `Firewall Bypass Violation: Client generated with V5 model ("${model}") but suppressed X-Gen-Model header.`
        : `Firewall Bypass Violation: Client spoofed headers to bypass ingress limits. Actual Body Payload: Pixels=${actualPixels}, Steps=${actualSteps}, Refs=${actualRefs}`;

      // Update users table, devices table, and legacy banned_discords table
      await run('UPDATE users SET banned = 1, ban_reason = ?, ban_notified = 0 WHERE user_id = ?', [banReason, targetUserId]);
      await run('UPDATE devices SET banned = 1 WHERE browser_id = ? OR discord_id = ? OR user_id = ?', [browserId, targetUserId, targetUserId]);

      if (device.discord_id) {
        await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)', [
          device.discord_id, Date.now(), banReason
        ]);
      }
      
      console.log(`[VPS Security Audit] Success. Database ban committed for "${targetUserId}".`);
      return {
        banned: true,
        reason: banReason,
        discordId: device.discord_id || null,
        userId: targetUserId,
        browserId
      };
    } catch (dbErr) {
      console.error('[VPS Security Audit] Failed to execute database ban:', dbErr.message);
    }
  }

  return { banned: false, discordId: device.discord_id || null, userId: targetUserId, browserId };
}

/**
 * Lazy-refills and updates the database-backed tier token bucket.
 * Operates authoritatively on the canonical user_id while synchronizing across linked devices.
 * Accounts for elapsed time while preserving fractional timing remainder.
 *
 * @param {string} id - Either a canonical user_id or a physical browser_id.
 * @param {string} tier - Allocation tier mapping.
 * @param {boolean} [deduct=false] - True if 1 token should be consumed atomically.
 * @returns {Promise<number>} Evaluated current metered token balance.
 */
async function getOrUpdateAllowance(id, tier, deduct = false) {
  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[tier];
  if (!tierConfig) return 0;

  if (tierConfig.maxAllowance === Infinity) {
    return Infinity;
  }

  // Resolve canonical user_id
  let canonicalId = id;
  let row = await get('SELECT metered_allowance, last_allowance_update_at FROM users WHERE user_id = ?', [canonicalId]);

  if (!row) {
    const devRow = await get('SELECT user_id, discord_id, metered_allowance, last_allowance_update_at FROM devices WHERE browser_id = ?', [id]);
    if (devRow) {
      canonicalId = devRow.user_id || devRow.discord_id || id;
      row = await get('SELECT metered_allowance, last_allowance_update_at FROM users WHERE user_id = ?', [canonicalId]);
      if (!row) {
        row = { metered_allowance: devRow.metered_allowance, last_allowance_update_at: devRow.last_allowance_update_at };
      }
    }
  }

  if (!row) return 0;

  let allowance = row.metered_allowance;
  let lastUpdate = row.last_allowance_update_at;
  const now = Date.now();

  const maxAllowance = tierConfig.maxAllowance;
  const refillRate = tierConfig.refillRateMs;

  if (allowance === null || lastUpdate === null) {
    allowance = maxAllowance;
    lastUpdate = now;
  } else {
    const elapsed = Math.max(0, now - lastUpdate);
    const gained = refillRate > 0 ? Math.floor(elapsed / refillRate) : 0;

    if (gained > 0) {
      allowance = Math.min(maxAllowance, allowance + gained);
      lastUpdate = lastUpdate + (gained * refillRate);
    }
  }

  if (deduct) {
    if (allowance >= 1) {
      allowance -= 1;
    } else {
      return -1;
    }
  }

  // Synchronize across both canonical user and all matching device records
  await run(
    'UPDATE users SET metered_allowance = ?, last_allowance_update_at = ? WHERE user_id = ?',
    [allowance, lastUpdate, canonicalId]
  );
  await run(
    'UPDATE devices SET metered_allowance = ?, last_allowance_update_at = ? WHERE browser_id = ? OR user_id = ? OR discord_id = ?',
    [allowance, lastUpdate, id, canonicalId, canonicalId]
  );

  return allowance;
}

/**
 * Calculates the exact millisecond epoch for the user's next rolling allowance refill.
 *
 * @param {string} id - Either a canonical user_id or a physical browser_id.
 * @param {string} tier - Allocation tier mapping.
 * @returns {Promise<number|null>} Refill epoch or null if already capped.
 */
async function getNextRefillTime(id, tier) {
  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[tier];
  if (!tierConfig || tierConfig.maxAllowance === Infinity) return null;

  let row = await get('SELECT metered_allowance, last_allowance_update_at FROM users WHERE user_id = ?', [id]);
  if (!row) {
    row = await get('SELECT metered_allowance, last_allowance_update_at FROM devices WHERE browser_id = ?', [id]);
  }
  if (!row || row.metered_allowance === null || row.last_allowance_update_at === null) return null;
  if (row.metered_allowance >= tierConfig.maxAllowance) return null;
  return row.last_allowance_update_at + tierConfig.refillRateMs;
}

module.exports = {
  verifyDevice,
  isV5ModelFamily,
  isV5MediumModel,
  calculateAnlasCost,
  calculateAnlasCostDetails,
  calculateAvailableBalance,
  evaluateAnlasReset,
  evaluateV5Accrual,
  authorizeAnlasSpend,
  commitAnlasDebit,
  commitV5Debit,
  recordSurplusV5Usage,
  extractParametersFromRawBody,
  sanitizeObjectForLogging,
  formatPayloadForLogging,
  runBackgroundAudit,
  getOrUpdateAllowance,
  getNextRefillTime,
  MAX_JSON_PART_BYTES,
  TELEMETRY_PROMPT_KEYS,
  DAY_MS,
  THIRTY_DAYS_MS
};