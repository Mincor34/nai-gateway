/**
 * LEVEL 2: SECURITY AUDIT & ACCOUNTING ENGINE (auditEngine.js)
 * 
 * Strict unidirectional constraints:
 * - Imports Level 0 (database.js) and Level 1 (config.js).
 * - Blind to HTTP transport (Express), socket streams, and queue RAM states.
 * - Handles parameter parsing, security auditing, Anlas tracking, authoritative principal authentication,
 *   synchronous security ban commits, and ACS-1 dual-ledger balance derivation, debt lockouts,
 *   temporal accruals, serialized administrative balance/debt mutations, binary image dimension
 *   inspection for /ai/upscale, and cycle-segregated period usage recording.
 * - Relational Normalization: Evaluates quotas, allowances, Anlas deductions, and bans strictly
 *   against the canonical user_id (Security Principal), eliminating multi-device quota inflation.
 * - ACS-1 Domain Engine: Authoritative NovelAI Anlas formula (Module 643656 parity), bounded
 *   zero-copy binary multipart parser, isolated Channel B vibe payload validator,
 *   Channel A upscale binary-header verifier & bucket pricer, segregated Character Reference
 *   (director_reference_images*) vs. Vibe Transfer (reference_image_multiple) accounting,
 *   and integer-only NCP/Anlas ledger mutations.
 */

'use strict';

const { get, all, run } = require('./database');
const { loadConfig } = require('./config');

// NovelAI Pricing Formula Constants (Module 643656 / Module 875333 / anlas-calculation.md)
const ANLAS_ALPHA = 2.951823174884865e-6;
const ANLAS_BETA = 5.753298233447344e-7;
const V5_MEDIUM_REF_STEPS = 23;
const V5_MEDIUM_DIVISOR = 1.75;
const V5_COST_MULTIPLIER = 1.5;
const ANLAS_MAX_PER_IMAGE_CAP = 140;
const ANLAS_MIN_PER_IMAGE_FLOOR = 2;
const MAX_NOVELAI_PIXELS = 3145728;
const MAX_NOVELAI_STEPS = 50;

// NovelAI Upscale Pixel Buckets (Module 643656 export "M" / Q table)
const UPSCALE_COST_BUCKETS = Object.freeze([
  [1048576, 1],
  [1747627, 2],
  [2446678, 3],
  [3145728, 4]
]);

// Bounded Base64 prefix decode limits for JSON upscale payloads (~64KB fast path, ~2MB JPEG EXIF path)
const BASE64_FAST_SCAN_CHARS = 87384;
const BASE64_JPEG_SCAN_CHARS = 2796200;

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
const PART_CONTENT_TYPE_IMAGE_REGEX = /content-type\s*:\s*image\//i;

// Whitelist of user prompt keys that must never be subjected to Base64 truncation heuristics
const TELEMETRY_PROMPT_KEYS = Object.freeze(new Set(['prompt', 'input', 'uc', 'negative_prompt', 'negativeprompt']));

// Per-principal async serialization registry to eliminate TOCTOU accrual/reset/adjustment races
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
 * Normalizes IEEE-754 -0 to +0.
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
  return value === 0 ? 0 : value;
}

/**
 * Validates that a signed integer delta or balance is a safe integer (fail-closed).
 * Normalizes IEEE-754 -0 to +0.
 *
 * @param {*} value - Numeric candidate.
 * @param {string} fieldName - Parameter name for diagnostic errors.
 * @returns {number} Validated safe integer.
 * @throws {Error} If value is not a safe integer.
 */
function assertSignedSafeInt(value, fieldName) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new Error(`[Audit Error] ${fieldName} must be a safe integer.`);
  }
  return value === 0 ? 0 : value;
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
 * Strictly distinguishes V5 models from `.5` legacy variants (e.g., `1.5`, `3-5`, `4-5`, `4_5`, `4.5`)
 * and matches both suffixed ('nai-diffusion-5-full') and bare ('nai-diffusion-5', 'v5') identifiers.
 *
 * @param {string|null|undefined} model - Target model identifier string.
 * @returns {boolean} True if the model represents a NovelAI V5 variant.
 */
function isV5ModelFamily(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (/\d[-_.]5/i.test(trimmed)) return false;
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
 * Commits an authoritative permanent security ban across `users`, `devices`, and
 * `banned_discords` (staging an unnotified ban alert for the Discord governance bot).
 * Invoked synchronously by Level 4 Stage 5 anti-spoofing prior to upstream dispatch.
 *
 * @param {object} target - Ban target descriptor.
 * @param {string} target.browserId - Originating hardware browser footprint.
 * @param {string|null} [target.userId=null] - Canonical Security Principal identifier.
 * @param {string|null} [target.discordId=null] - Linked Discord identifier if present.
 * @param {string} target.reason - Explicit policy evasion diagnostic reason.
 * @returns {Promise<{banned: boolean, reason: string, userId: string, discordId: string|null, browserId: string}>}
 * @throws {Error} If browserId or reason is invalid.
 */
async function commitSecurityBan({ browserId, userId = null, discordId = null, reason }) {
  assertNonEmptyString(browserId, 'browserId');
  assertNonEmptyString(reason, 'reason');

  let targetUserId = (typeof userId === 'string' && userId.trim().length > 0) ? userId : null;
  let targetDiscordId = (typeof discordId === 'string' && discordId.trim().length > 0) ? discordId : null;

  if (!targetUserId || !targetDiscordId) {
    const dev = await get(
      'SELECT user_id, discord_id FROM devices WHERE browser_id = ?',
      [browserId]
    );
    if (dev) {
      if (!targetUserId) {
        targetUserId = dev.user_id || dev.discord_id || browserId;
      }
      if (!targetDiscordId) {
        targetDiscordId = dev.discord_id || null;
      }
    }
  }

  targetUserId = targetUserId || browserId;
  if (!targetDiscordId && targetUserId !== 'admin' && !targetUserId.startsWith('b_')) {
    targetDiscordId = targetUserId;
  }

  if (targetUserId !== 'admin') {
    await run(
      'UPDATE users SET banned = 1, ban_reason = ?, ban_notified = 0 WHERE user_id = ?',
      [reason, targetUserId]
    );
    await run(
      'UPDATE devices SET banned = 1 WHERE browser_id = ? OR discord_id = ? OR user_id = ?',
      [browserId, targetUserId, targetUserId]
    );
  }

  if (targetDiscordId && targetDiscordId !== 'admin') {
    await run(
      'INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)',
      [targetDiscordId, Date.now(), reason]
    );
  }

  return {
    banned: true,
    reason,
    userId: targetUserId,
    discordId: targetDiscordId || null,
    browserId
  };
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
 * Implements exact reverse-engineered NovelAI Module 643656 & Module 875333 billing calculations:
 * - V5 Medium (`nai-diffusion-5-full-medium` & inpainting): un-ceiled
 *   `(ANLAS_ALPHA * area + ANLAS_BETA * area * 23) / 1.75`
 * - All other V4/V4.5/V5/SDXL models: `Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * steps)`
 * - SMEA multiplier (`1.4` for `sm && sm_dyn`, `1.2` for `sm`, `1.0` otherwise)
 * - V5 architecture multiplier (`1.5x`) applied after SMEA across all V5 variants
 * - Strength scaling + `Math.ceil` + `2` Anlas per-image floor + `140` Anlas per-image cap
 * - Hard NovelAI structural limits: area <= 3,145,728 px (3MP) across all models and
 *   steps <= 50 on non-Medium models (closes `strength: 0` cap evasion)
 * - Opus lightweight bonus (`billable_samples = n_samples - 1`) disabled for V5 when `usageNegative === true`
 * - Character References (`director_reference_images*`) billed at 5 Anlas/ref/sample
 * - Vibe Transfer (`reference_image_multiple` on V3/V4/V4.5) billed at 2 Anlas per ref beyond 4
 *   (and 2 Anlas per uncached encode), disabled on V5
 * - Immunized against NaN leakage, string poisoning, boolean coercion, and unbounded floats.
 *
 * @param {object} params - Extracted payload parameters.
 * @param {object} [options={}] - Calculation context.
 * @param {boolean} [options.isOpus=true] - Whether the generating account holds Opus tier perks.
 * @param {boolean} [options.usageNegative=false] - Whether the master V5 tank is in negative overdraft.
 * @returns {object} Detailed breakdown of integer Anlas costs.
 * @throws {Error} If per-image cost exceeds 140 Anlas, resolution exceeds 3MP, or non-Medium steps exceed 50.
 */
function calculateAnlasCostDetails(params, { isOpus = true, usageNegative = false } = {}) {
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

  const parsedSteps = parseOptionalInt(params.steps, 28);
  const rawSteps = parsedSteps > 0 ? parsedSteps : 28;

  const baseCalculated = isV5Medium
    ? ((ANLAS_ALPHA * area + ANLAS_BETA * area * V5_MEDIUM_REF_STEPS) / V5_MEDIUM_DIVISOR)
    : Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * rawSteps);

  // SMEA Multipliers
  let multiplier = 1.0;
  const sm = params.sm === true || params.sm === 'true' || params.sm === 1;
  const smDyn = params.sm_dyn === true || params.sm_dyn === 'true' || params.sm_dyn === 1;

  if (sm && smDyn) {
    multiplier = 1.4;
  } else if (sm) {
    multiplier = 1.2;
  }
  let w = baseCalculated * multiplier;

  // V5 Model Group 1.5x Multiplier (applies across all V5 variants including Medium)
  if (isV5) {
    w *= V5_COST_MULTIPLIER;
  }

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

  if (area > MAX_NOVELAI_PIXELS) {
    throw new Error(`Image resolution area of ${area}px (${width}x${height}) exceeds maximum NovelAI cap of ${MAX_NOVELAI_PIXELS}px.`);
  }

  if (!isV5Medium && rawSteps > MAX_NOVELAI_STEPS) {
    throw new Error(`Step count of ${rawSteps} exceeds maximum NovelAI cap of ${MAX_NOVELAI_STEPS} steps.`);
  }

  const parsedSamples = parseOptionalInt(params.n_samples, 1);
  const nSamples = parsedSamples > 0 ? parsedSamples : 1;
  let billableSamples = nSamples;

  // Opus Lightweight Bonus:
  // If account is Opus, V5 tank is not negative, dimensions <= 1MP (1048576), and steps <= 28
  // (V5 Medium always runs at 14 steps upstream regardless of payload steps), 1 sample is free.
  const withinOpusSteps = isV5Medium || rawSteps <= 28;
  const opusUsageExhausted = isV5 && Boolean(usageNegative);
  if (isOpus && !opusUsageExhausted && area <= 1048576 && withinOpusSteps) {
    billableSamples = Math.max(0, nSamples - 1);
  }

  const baseAnlas = perImageAnlas * billableSamples;

  // Character / Precise Reference Surcharge: 5 Anlas per reference per requested sample
  // Strictly counts Character Reference arrays (director_reference_images*); never Vibe Transfer arrays.
  let rawRefs = params.precise_ref_count ?? params.precise_refs ?? params.character_reference_count ?? params.reference_count;

  if (rawRefs === undefined || rawRefs === null) {
    const cachedCount = Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0;
    const directCount = Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0;
    const arrayTotal = cachedCount + directCount;
    if (arrayTotal > 0) rawRefs = arrayTotal;
  }

  const parsedRefs = parseOptionalInt(rawRefs, 0);
  const preciseRefs = parsedRefs > 0 ? parsedRefs : 0;
  const characterReferenceAnlas = 5 * preciseRefs * nSamples;

  // Vibe Transfer Surcharges (Exclusively for V3 / V4 / V4.5 models; V5 does not support Vibe)
  let vibeEncodingAnlas = 0;
  let vibeReferenceAnlas = 0;

  if (!isV5) {
    let rawUncached = params.uncached_vibe_count;
    let rawVibeRefs = params.vibe_reference_count;

    if (rawVibeRefs === undefined || rawVibeRefs === null) {
      if (Array.isArray(params.reference_image_multiple) && params.reference_image_multiple.length > 0) {
        rawVibeRefs = params.reference_image_multiple.length;
      } else if (Array.isArray(params.vibe_images)) {
        rawVibeRefs = params.vibe_images.length;
      } else if (Array.isArray(params.vibes)) {
        rawVibeRefs = params.vibes.length;
      }
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
 * Computes the authoritative Anlas cost for `/ai/upscale` using NovelAI Module 643656's
 * pixel-area bucket table (`Q = [[1048576, 1], [1747627, 2], [2446678, 3], [3145728, 4]]`).
 * No Opus discount applies to upscaling.
 *
 * @param {number} width - Intrinsic image width in pixels.
 * @param {number} height - Intrinsic image height in pixels.
 * @returns {number} Integer Anlas cost (`1..4`).
 * @throws {Error} If dimensions are invalid or exceed 3MP (`3,145,728 px`).
 */
function calculateUpscaleAnlasCost(width, height) {
  if (
    typeof width !== 'number' || !Number.isInteger(width) || width <= 0 ||
    typeof height !== 'number' || !Number.isInteger(height) || height <= 0
  ) {
    throw new Error('Upscale image dimensions must be positive integers.');
  }
  const area = width * height;
  if (!Number.isSafeInteger(area) || area <= 0 || area > MAX_NOVELAI_PIXELS) {
    throw new Error(`Upscale image resolution area of ${area}px (${width}x${height}) exceeds maximum NovelAI cap of ${MAX_NOVELAI_PIXELS}px.`);
  }
  for (const [maxArea, cost] of UPSCALE_COST_BUCKETS) {
    if (area <= maxArea) {
      return cost;
    }
  }
  throw new Error(`Upscale image resolution area of ${area}px exceeds maximum NovelAI cap of ${MAX_NOVELAI_PIXELS}px.`);
}

/**
 * Extracts intrinsic pixel dimensions directly from raw PNG, JPEG, WebP, GIF, or BMP binary headers.
 * Bounded to a strict single-pass scan without allocating decoded bitmaps.
 *
 * @param {Buffer} buffer - Binary image buffer or header slice.
 * @returns {{ width: number, height: number, format: string }|null} Intrinsic dimensions or null if unrecognized.
 */
function extractImageDimensionsFromBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) {
    return null;
  }

  // 1. PNG (89 50 4E 47 0D 0A 1A 0A + IHDR)
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A &&
    buffer[12] === 0x49 && buffer[13] === 0x48 && buffer[14] === 0x44 && buffer[15] === 0x52
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return (width > 0 && height > 0) ? { width, height, format: 'png' } : null;
  }

  // 2. WebP (RIFF....WEBP + VP8 / VP8L / VP8X)
  if (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunkTag = buffer.subarray(12, 16).toString('ascii');
    if (chunkTag === 'VP8 ') {
      if ((buffer[20] & 1) === 0 && buffer[23] === 0x9D && buffer[24] === 0x01 && buffer[25] === 0x2A) {
        const width = buffer.readUInt16LE(26) & 0x3FFF;
        const height = buffer.readUInt16LE(28) & 0x3FFF;
        return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
      }
      return null;
    }
    if (chunkTag === 'VP8L') {
      if (buffer[20] === 0x2F) {
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
      }
      return null;
    }
    if (chunkTag === 'VP8X') {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
    }
    return null;
  }

  // 3. JPEG (FF D8 ... SOF0..SOF15)
  if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let pos = 2;
    while (pos + 1 < buffer.length) {
      if (buffer[pos] !== 0xFF) {
        pos++;
        continue;
      }
      while (pos + 1 < buffer.length && buffer[pos + 1] === 0xFF) {
        pos++;
      }
      if (pos + 1 >= buffer.length) break;
      const marker = buffer[pos + 1];
      pos += 2;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
        continue;
      }
      if (marker === 0xD9 || marker === 0xDA) {
        break;
      }
      if (pos + 2 > buffer.length) break;
      const segLen = buffer.readUInt16BE(pos);
      if (segLen < 2 || pos + segLen > buffer.length) break;
      const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
                    (marker >= 0xC5 && marker <= 0xC7) ||
                    (marker >= 0xC9 && marker <= 0xCB) ||
                    (marker >= 0xCD && marker <= 0xCF);
      if (isSof && segLen >= 7 && pos + 7 <= buffer.length) {
        const height = buffer.readUInt16BE(pos + 3);
        const width = buffer.readUInt16BE(pos + 5);
        return (width > 0 && height > 0) ? { width, height, format: 'jpeg' } : null;
      }
      pos += segLen;
    }
    return null;
  }

  // 4. GIF (GIF87a / GIF89a)
  if (
    buffer.length >= 10 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
     buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return (width > 0 && height > 0) ? { width, height, format: 'gif' } : null;
  }

  // 5. BMP (BM + BITMAPCOREHEADER / BITMAPINFOHEADER)
  if (buffer.length >= 22 && buffer[0] === 0x42 && buffer[1] === 0x4D) {
    const dibSize = buffer.readUInt32LE(14);
    if (dibSize === 12) {
      const width = buffer.readUInt16LE(18);
      const height = buffer.readUInt16LE(20);
      return (width > 0 && height > 0) ? { width, height, format: 'bmp' } : null;
    }
    if (buffer.length >= 26) {
      const width = buffer.readInt32LE(18);
      const height = Math.abs(buffer.readInt32LE(22));
      return (width > 0 && height > 0) ? { width, height, format: 'bmp' } : null;
    }
  }

  return null;
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
 * Enforces virtual Anlas cycle resets with strict zero rollover and debt offsetting.
 * Primary mode (billing-cycle driven): when `activeCycleEpoch` is supplied from upstream
 * `/user/subscription` telemetry, resets occur once per confirmed paid billing cycle
 * (`last_anlas_reset_epoch < activeCycleEpoch`) and freeze unconditionally while
 * `subscriptionActive === false` or `isGracePeriod === true`.
 * Fallback mode: when `activeCycleEpoch === null` (isolated unit tests or mock telemetry),
 * falls back to the 30-day (`THIRTY_DAYS_MS`) rolling epoch check.
 * Offsets fresh tier allocation by any existing negative overdraft debt, resets
 * subscription-period usage counters (including for Infinity-quota principals), and prevents
 * multi-month accumulation after extended inactivity. Freezes banned accounts without mutating
 * balances or period epochs.
 * Note: Level 4 onboarding callers (/auth/status) must only invoke resets on approved devices.
 * Serialized per canonical user_id against TOCTOU races.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {number|object} [optionsOrNow=Date.now()] - Epoch timestamp in ms (legacy) or cycle options object.
 * @param {number} [optionsOrNow.now=Date.now()] - Epoch timestamp in ms.
 * @param {number|null} [optionsOrNow.activeCycleEpoch=null] - Authoritative billing cycle epoch ms from telemetry.
 * @param {boolean} [optionsOrNow.isGracePeriod=false] - Whether master subscription is in Chargebee grace period.
 * @param {boolean} [optionsOrNow.subscriptionActive=true] - Whether master subscription is active and >= Opus tier.
 * @returns {Promise<{user_id: string, virtual_balance: number, previous_balance: number, reset_applied: boolean, last_anlas_reset_epoch: number|null}|null>}
 * @throws {Error} If userId or options fail validation.
 */
async function evaluateAnlasReset(userId, optionsOrNow = Date.now()) {
  assertNonEmptyString(userId, 'userId');

  let safeNow;
  let activeCycleEpoch = null;
  let isGracePeriod = false;
  let subscriptionActive = true;

  if (typeof optionsOrNow === 'number') {
    safeNow = assertValidTimestamp(optionsOrNow, 'now');
  } else if (optionsOrNow !== null && typeof optionsOrNow === 'object' && !Array.isArray(optionsOrNow)) {
    const {
      now = Date.now(),
      activeCycleEpoch: rawCycleEpoch = null,
      isGracePeriod: rawGrace = false,
      subscriptionActive: rawSubActive = true
    } = optionsOrNow;

    safeNow = assertValidTimestamp(now, 'now');
    if (rawCycleEpoch !== null) {
      activeCycleEpoch = assertValidTimestamp(rawCycleEpoch, 'activeCycleEpoch');
      if (activeCycleEpoch === 0) {
        throw new Error('[Audit Error] activeCycleEpoch must be a positive timestamp or null.');
      }
    }
    if (typeof rawGrace !== 'boolean') {
      throw new Error('[Audit Error] isGracePeriod must be a boolean.');
    }
    if (typeof rawSubActive !== 'boolean') {
      throw new Error('[Audit Error] subscriptionActive must be a boolean.');
    }
    isGracePeriod = rawGrace;
    subscriptionActive = rawSubActive;
  } else {
    throw new Error('[Audit Error] now or options must be a finite non-negative number or plain object.');
  }

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

    if (user.banned === 1 || !subscriptionActive || isGracePeriod) {
      return {
        user_id: user.user_id,
        virtual_balance: currentBalance,
        previous_balance: currentBalance,
        reset_applied: false,
        last_anlas_reset_epoch: lastReset ?? null
      };
    }

    const isInitialReset = (lastReset === null || lastReset === undefined);
    let shouldReset = false;
    let resetEpochToStamp = safeNow;

    if (activeCycleEpoch !== null) {
      shouldReset = isInitialReset || (lastReset < activeCycleEpoch);
      resetEpochToStamp = activeCycleEpoch;
    } else {
      const elapsed = isInitialReset ? THIRTY_DAYS_MS : (safeNow - lastReset);
      shouldReset = isInitialReset || (elapsed >= THIRTY_DAYS_MS);
      resetEpochToStamp = safeNow;
    }

    if (!shouldReset) {
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
        [resetEpochToStamp, resetEpochToStamp, user.user_id]
      );

      return {
        user_id: user.user_id,
        virtual_balance: Infinity,
        previous_balance: Infinity,
        reset_applied: true,
        last_anlas_reset_epoch: resetEpochToStamp
      };
    }

    // Strict zero-rollover allocation: positive unused balance is discarded; negative debt offsets fresh quota.
    // Inactive users spanning >1 cycle receive exactly 1x monthlyAnlas (zero multi-cycle stacking).
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
      [newBalance, resetEpochToStamp, resetEpochToStamp, user.user_id]
    );

    return {
      user_id: user.user_id,
      virtual_balance: newBalance,
      previous_balance: currentBalance,
      reset_applied: true,
      last_anlas_reset_epoch: resetEpochToStamp
    };
  });
}

/**
 * Lazily accrues daily V5 Normalized Compute Points (NCP) for Bucket 1 (Personal Rollover Bank).
 * Evaluates proportional cluster weights strictly across distinct, unbanned, approved canonical
 * users (1 weight per user_id regardless of linked device count), includes the cluster Admin
 * operator weight whenever no approved Admin-tier principal exists in SQLite (preventing a
 * single non-Admin guest from monopolizing 100% of daily master compute), clamps any bloated
 * balance down to tierConfig.v5MaxBankDays immediately even within a 24h window, resets
 * v5_daily_consumed on day rollovers, and preserves strict integer balances in SQLite.
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
    let hasApprovedAdmin = false;
    for (const row of approvedUsers) {
      const rowTier = config.TIER_CONFIGS[row.priority_tier] || config.TIER_CONFIGS['Normal'];
      const w = Number.isInteger(rowTier.v5Weight) && rowTier.v5Weight > 0 ? rowTier.v5Weight : 0;
      totalWeight += w;
      if (row.priority_tier === 'Admin') {
        hasApprovedAdmin = true;
      }
      if (row.user_id === user.user_id) {
        isTargetApproved = true;
      }
    }

    // Account for the cluster Admin operator (ADMIN_SECRET_KEY) when no approved Admin-tier
    // record exists in SQLite so a single non-Admin guest cannot absorb 100% of daily capacity.
    if (approvedUsers.length > 0 && !hasApprovedAdmin) {
      const adminTier = config.TIER_CONFIGS['Admin'];
      const adminWeight = (adminTier && Number.isInteger(adminTier.v5Weight) && adminTier.v5Weight > 0)
        ? adminTier.v5Weight
        : 0;
      totalWeight += adminWeight;
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

    // Clamp stale over-allocated balances immediately (e.g., tier downgrade or cluster weight increase)
    let effectiveBanked = currentBanked;
    if (maxBankNcp !== Infinity && currentBanked > maxBankNcp) {
      effectiveBanked = maxBankNcp;
      await run(
        'UPDATE users SET v5_banked_balance = ? WHERE user_id = ?',
        [effectiveBanked, user.user_id]
      );
    }

    // Avoid locking zero-weight principals (e.g. Metered) into a 24h cooldown unless downgrading existing state
    if (userWeight === 0 && maxBankNcp === 0 && effectiveBanked === 0 && currentDailyConsumed === 0) {
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
        v5_banked_balance: effectiveBanked,
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
    const uncappedBalance = effectiveBanked + accruedNcp;
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
 * Registers or updates a billing cycle archive record in `subscription_periods`.
 *
 * @param {number} cycleEpoch - Authoritative billing cycle epoch ms (> 0).
 * @param {number|null} [expiresAt=null] - Upstream Unix expiration timestamp in seconds.
 * @param {number} [startedAt=Date.now()] - Archive stamp timestamp in ms.
 * @returns {Promise<void>}
 */
async function recordSubscriptionPeriod(cycleEpoch, expiresAt = null, startedAt = Date.now()) {
  const safeEpoch = assertNonNegativeSafeInt(cycleEpoch, 'cycleEpoch');
  if (safeEpoch === 0) return;
  const safeStarted = assertValidTimestamp(startedAt, 'startedAt');
  const safeExpires = (expiresAt !== null && expiresAt !== undefined)
    ? assertNonNegativeSafeInt(expiresAt, 'expiresAt')
    : null;

  await run(
    `INSERT INTO subscription_periods (cycle_epoch, expires_at, started_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cycle_epoch) DO UPDATE SET
       expires_at = COALESCE(excluded.expires_at, subscription_periods.expires_at)`,
    [safeEpoch, safeExpires, safeStarted]
  );
}

/**
 * Atomically records PoNR generation and Anlas usage inside `period_usage` keyed by
 * `(cycle_epoch, user_id)`. Preserves historical cycles without overwriting and segregates
 * inactive accounts cleanly from subsequent cycles. Records synthetic `'admin'` usage
 * alongside linked and unlinked principals.
 *
 * @param {number|null} cycleEpoch - Active cycle epoch ms (falls back to 0 when unseeded).
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {object} [increments={}] - Non-negative integer deltas for each telemetry counter.
 * @returns {Promise<void>}
 */
async function recordPeriodUsage(cycleEpoch, userId, increments = {}) {
  assertNonEmptyString(userId, 'userId');
  if (increments === null || typeof increments !== 'object' || Array.isArray(increments)) {
    throw new Error('[Audit Error] increments must be a plain object.');
  }

  const safeEpoch = (cycleEpoch !== null && cycleEpoch !== undefined)
    ? assertNonNegativeSafeInt(cycleEpoch, 'cycleEpoch')
    : 0;

  const anlasConsumed = assertNonNegativeSafeInt(increments.anlasConsumed ?? 0, 'anlasConsumed');
  const v5HighGens = assertNonNegativeSafeInt(increments.v5HighGens ?? 0, 'v5HighGens');
  const v5MediumGens = assertNonNegativeSafeInt(increments.v5MediumGens ?? 0, 'v5MediumGens');
  const legacyImageGens = assertNonNegativeSafeInt(increments.legacyImageGens ?? 0, 'legacyImageGens');
  const vibeEncodes = assertNonNegativeSafeInt(increments.vibeEncodes ?? 0, 'vibeEncodes');
  const upscaleGens = assertNonNegativeSafeInt(increments.upscaleGens ?? 0, 'upscaleGens');
  const textGens = assertNonNegativeSafeInt(increments.textGens ?? 0, 'textGens');

  if (
    anlasConsumed === 0 &&
    v5HighGens === 0 &&
    v5MediumGens === 0 &&
    legacyImageGens === 0 &&
    vibeEncodes === 0 &&
    upscaleGens === 0 &&
    textGens === 0
  ) {
    return;
  }

  await run(
    `INSERT INTO period_usage (
       cycle_epoch, user_id, anlas_consumed, v5_high_gens, v5_medium_gens,
       legacy_image_gens, vibe_encodes, upscale_gens, text_gens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cycle_epoch, user_id) DO UPDATE SET
       anlas_consumed = period_usage.anlas_consumed + excluded.anlas_consumed,
       v5_high_gens = period_usage.v5_high_gens + excluded.v5_high_gens,
       v5_medium_gens = period_usage.v5_medium_gens + excluded.v5_medium_gens,
       legacy_image_gens = period_usage.legacy_image_gens + excluded.legacy_image_gens,
       vibe_encodes = period_usage.vibe_encodes + excluded.vibe_encodes,
       upscale_gens = period_usage.upscale_gens + excluded.upscale_gens,
       text_gens = period_usage.text_gens + excluded.text_gens`,
    [safeEpoch, userId, anlasConsumed, v5HighGens, v5MediumGens, legacyImageGens, vibeEncodes, upscaleGens, textGens]
  );
}

/**
 * Atomically adjusts a canonical principal's `virtual_anlas_balance` and/or `v5_banked_balance`
 * under the per-user serialization lock (`withUserLock`), preventing TOCTOU lost updates against
 * concurrent PoNR debits and lazy accruals. Rejects virtual Anlas adjustments on unlimited-quota
 * (`monthlyAnlas === Infinity`) tiers so hidden SQLite debt cannot accumulate behind masked UI views.
 * SQLite `trg_sync_users_update_balances` mirrors updated balances across all linked hardware devices automatically.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {object} [options={}] - Adjustment parameters.
 * @param {number} [options.anlasDelta] - Signed safe integer delta for virtual_anlas_balance.
 * @param {number} [options.virtualAnlasBalance] - Explicit signed safe integer balance override.
 * @param {number} [options.v5NcpDelta] - Signed safe integer delta for v5_banked_balance (clamped >= 0).
 * @param {number} [options.v5BankedBalance] - Explicit non-negative safe integer V5 balance override.
 * @returns {Promise<{user_id: string, priority_tier: string, previous_anlas_balance: number, virtual_anlas_balance: number, previous_v5_balance: number, v5_banked_balance: number, is_in_debt: boolean}|null>}
 * @throws {Error} If identifiers, tier eligibility, or numeric parameters violate fail-closed bounds.
 */
async function adjustUserBalances(userId, options = {}) {
  assertNonEmptyString(userId, 'userId');
  if (userId.trim().toLowerCase() === 'admin') {
    throw new Error('[Audit Error] Cannot adjust synthetic admin principal balances.');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('[Audit Error] options must be a plain object.');
  }

  const {
    anlasDelta,
    virtualAnlasBalance,
    v5NcpDelta,
    v5BankedBalance
  } = options;

  const hasAnlasDelta = anlasDelta !== undefined;
  const hasAnlasSet = virtualAnlasBalance !== undefined;
  const hasV5Delta = v5NcpDelta !== undefined;
  const hasV5Set = v5BankedBalance !== undefined;

  if (hasAnlasDelta && hasAnlasSet) {
    throw new Error('[Audit Error] Cannot specify both anlasDelta and virtualAnlasBalance.');
  }
  if (hasV5Delta && hasV5Set) {
    throw new Error('[Audit Error] Cannot specify both v5NcpDelta and v5BankedBalance.');
  }
  if (!hasAnlasDelta && !hasAnlasSet && !hasV5Delta && !hasV5Set) {
    throw new Error('[Audit Error] At least one balance adjustment field is required.');
  }

  const validatedAnlasDelta = hasAnlasDelta ? assertSignedSafeInt(anlasDelta, 'anlasDelta') : null;
  const validatedAnlasSet = hasAnlasSet ? assertSignedSafeInt(virtualAnlasBalance, 'virtualAnlasBalance') : null;
  const validatedV5Delta = hasV5Delta ? assertSignedSafeInt(v5NcpDelta, 'v5NcpDelta') : null;
  const validatedV5Set = hasV5Set ? assertNonNegativeSafeInt(v5BankedBalance, 'v5BankedBalance') : null;

  return withUserLock(userId, async () => {
    const user = await get(
      'SELECT user_id, priority_tier, virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?',
      [userId]
    );
    if (!user) return null;

    const config = getConfig();
    const tierConfig = config.TIER_CONFIGS[user.priority_tier] || config.TIER_CONFIGS['Normal'];
    if (tierConfig.monthlyAnlas === Infinity && (validatedAnlasDelta !== null || validatedAnlasSet !== null)) {
      throw new Error(`[Audit Error] Cannot adjust virtual Anlas for unlimited-quota tier "${user.priority_tier}".`);
    }

    const rawPrevAnlas = Math.trunc(user.virtual_anlas_balance || 0);
    const prevAnlas = rawPrevAnlas === 0 ? 0 : rawPrevAnlas;
    const prevV5 = Math.max(0, Math.trunc(user.v5_banked_balance || 0));

    let nextAnlas = prevAnlas;
    if (validatedAnlasDelta !== null) {
      nextAnlas = prevAnlas + validatedAnlasDelta;
      if (!Number.isSafeInteger(nextAnlas)) {
        throw new Error('[Audit Error] Resulting virtual_anlas_balance exceeds safe integer bounds.');
      }
    } else if (validatedAnlasSet !== null) {
      nextAnlas = validatedAnlasSet;
    }
    if (nextAnlas === 0) nextAnlas = 0;

    let nextV5 = prevV5;
    if (validatedV5Delta !== null) {
      const candidateV5 = prevV5 + validatedV5Delta;
      if (!Number.isSafeInteger(candidateV5)) {
        throw new Error('[Audit Error] Resulting v5_banked_balance exceeds safe integer bounds.');
      }
      nextV5 = Math.max(0, candidateV5);
    } else if (validatedV5Set !== null) {
      nextV5 = validatedV5Set;
    }
    if (nextV5 === 0) nextV5 = 0;

    await run(
      'UPDATE users SET virtual_anlas_balance = ?, v5_banked_balance = ? WHERE user_id = ?',
      [nextAnlas, nextV5, user.user_id]
    );

    return {
      user_id: user.user_id,
      priority_tier: user.priority_tier,
      previous_anlas_balance: prevAnlas,
      virtual_anlas_balance: nextAnlas,
      previous_v5_balance: prevV5,
      v5_banked_balance: nextV5,
      is_in_debt: nextAnlas < 0
    };
  });
}

/**
 * Reconciles an outstanding negative virtual Anlas debt for a canonical principal
 * under `withUserLock`. Supports full forgiveness (`creditAmount === null`, restoring
 * negative balance to `0`) or partial paydown (`creditAmount > 0`), while strictly
 * guaranteeing that unlimited-quota tiers and non-indebted accounts (`virtual_anlas_balance >= 0`)
 * are never modified or wiped.
 *
 * @param {string} userId - Canonical Security Principal identifier.
 * @param {object} [options={}] - Reconciliation options.
 * @param {number|null} [options.creditAmount=null] - Positive safe integer Anlas to credit toward debt, or null for full forgiveness to 0.
 * @param {boolean} [options.capAtZero=false] - Whether partial credit payments exceeding debt cap at 0.
 * @returns {Promise<{user_id: string, priority_tier: string, reconciled: boolean, was_in_debt: boolean, previous_balance: number, virtual_balance: number, is_in_debt: boolean}|null>}
 * @throws {Error} If parameters fail validation.
 */
async function reconcileUserDebt(userId, options = {}) {
  assertNonEmptyString(userId, 'userId');
  if (userId.trim().toLowerCase() === 'admin') {
    throw new Error('[Audit Error] Cannot reconcile synthetic admin principal.');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('[Audit Error] options must be a plain object.');
  }

  const { creditAmount = null, capAtZero = false } = options;

  let validatedCredit = null;
  if (creditAmount !== null && creditAmount !== undefined) {
    validatedCredit = assertNonNegativeSafeInt(creditAmount, 'creditAmount');
    if (validatedCredit === 0) {
      throw new Error('[Audit Error] creditAmount must be a positive safe integer or null.');
    }
  }
  if (typeof capAtZero !== 'boolean') {
    throw new Error('[Audit Error] capAtZero must be a boolean.');
  }

  return withUserLock(userId, async () => {
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
        reconciled: false,
        was_in_debt: false,
        previous_balance: 0,
        virtual_balance: 0,
        is_in_debt: false
      };
    }

    const rawCurrentBalance = Math.trunc(user.virtual_anlas_balance || 0);
    const currentBalance = rawCurrentBalance === 0 ? 0 : rawCurrentBalance;

    if (currentBalance >= 0) {
      return {
        user_id: user.user_id,
        priority_tier: user.priority_tier,
        reconciled: false,
        was_in_debt: false,
        previous_balance: currentBalance,
        virtual_balance: currentBalance,
        is_in_debt: false
      };
    }

    let nextBalance;
    if (validatedCredit !== null) {
      const summed = currentBalance + validatedCredit;
      if (!Number.isSafeInteger(summed)) {
        throw new Error('[Audit Error] Resulting virtual_anlas_balance exceeds safe integer bounds.');
      }
      nextBalance = capAtZero ? Math.min(0, summed) : summed;
    } else {
      nextBalance = 0;
    }
    if (nextBalance === 0) nextBalance = 0;

    await run(
      'UPDATE users SET virtual_anlas_balance = ? WHERE user_id = ?',
      [nextBalance, user.user_id]
    );

    return {
      user_id: user.user_id,
      priority_tier: user.priority_tier,
      reconciled: true,
      was_in_debt: true,
      previous_balance: currentBalance,
      virtual_balance: nextBalance,
      is_in_debt: nextBalance < 0
    };
  });
}

/**
 * Extracts an RFC 2046 multipart boundary from Content-Type or raw buffer prefix.
 *
 * @param {Buffer} buffer - Raw payload buffer.
 * @param {string|null} [contentType=null] - Inbound HTTP Content-Type header string.
 * @returns {string|null} Extracted boundary token or null.
 */
function extractMultipartBoundary(buffer, contentType = null) {
  if (typeof contentType === 'string') {
    const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    if (match) {
      const candidate = (match[1] || match[2]).trim();
      if (candidate.length > 0) return candidate;
    }
  }

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
      const extracted = buffer.subarray(offset + 2, lineEnd).toString('utf8').trim();
      if (extracted.length > 0) return extracted;
    }
  }

  return null;
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

  const boundary = extractMultipartBoundary(buffer, contentType);

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
 * Decodes a Base64 (or data URI) image prefix safely, expanding the scan budget up to ~2MB
 * for JPEGs carrying large EXIF/ICC/XMP metadata headers before SOF0..SOF15.
 *
 * @param {string} rawImageStr - Raw Base64 string or data URI.
 * @returns {{ width: number, height: number, format: string }|null}
 */
function extractDimensionsFromBase64Image(rawImageStr) {
  if (typeof rawImageStr !== 'string') return null;
  const trimmed = rawImageStr.trim();
  const commaIdx = trimmed.startsWith('data:image/') ? trimmed.indexOf(',') : -1;
  const cleanB64 = (commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed).replace(/\s+/g, '');
  if (cleanB64.length === 0) return null;

  const fastLen = Math.min(cleanB64.length, BASE64_FAST_SCAN_CHARS);
  const alignedFast = fastLen - (fastLen % 4);
  if (alignedFast > 0) {
    const dims = extractImageDimensionsFromBuffer(Buffer.from(cleanB64.slice(0, alignedFast), 'base64'));
    if (dims) return dims;
  }

  if (cleanB64.startsWith('/9j/') && cleanB64.length > BASE64_FAST_SCAN_CHARS) {
    const jpegLen = Math.min(cleanB64.length, BASE64_JPEG_SCAN_CHARS);
    const alignedJpeg = jpegLen - (jpegLen % 4);
    if (alignedJpeg > alignedFast) {
      return extractImageDimensionsFromBuffer(Buffer.from(cleanB64.slice(0, alignedJpeg), 'base64'));
    }
  }

  return null;
}

/**
 * Extracts authoritative intrinsic image dimensions and optional JSON metadata
 * from an `/ai/upscale` payload (supporting both NovelAI's live `multipart/form-data`
 * wire format `{ image: <binary>, request: <json> }` and direct JSON base64 payloads).
 * Zero-copy inspects binary image slices directly without truncating JPEGs carrying >64KB EXIF.
 *
 * @param {Buffer} buffer - Raw accumulated request buffer.
 * @param {string|null} [contentType=null] - Inbound HTTP Content-Type header string.
 * @returns {{ width: number, height: number, format: string, jsonWidth: number|null, jsonHeight: number|null, model: string|null, scale: number|null }|null}
 */
function extractUpscaleParametersFromRawBody(buffer, contentType = null) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const boundary = extractMultipartBoundary(buffer, contentType);

  if (boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    let partSearchOffset = 0;
    let imageDims = null;
    let requestJson = null;

    while (partSearchOffset < buffer.length) {
      const boundaryIdx = buffer.indexOf(delimiter, partSearchOffset);
      if (boundaryIdx === -1) break;

      if (boundaryIdx > 0 && buffer[boundaryIdx - 1] !== 0x0A) {
        partSearchOffset = boundaryIdx + 1;
        continue;
      }

      let cursor = boundaryIdx + delimiter.length;
      let isClosing = false;
      if (cursor + 1 < buffer.length && buffer[cursor] === 0x2D && buffer[cursor + 1] === 0x2D) {
        isClosing = true;
        cursor += 2;
      }

      while (cursor < buffer.length && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) {
        cursor++;
      }

      if (cursor < buffer.length && buffer[cursor] === 0x0D) cursor++;
      if (cursor < buffer.length && buffer[cursor] === 0x0A) cursor++;

      if (isClosing) break;

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

      const partHeaderText = buffer.subarray(partHeaderStart, headerEnd).toString('utf8');
      const bodyStart = headerEnd + headerDelimLen;

      if (!imageDims && (PART_NAME_IMAGE_REGEX.test(partHeaderText) || PART_CONTENT_TYPE_IMAGE_REGEX.test(partHeaderText))) {
        let searchBoundaryFrom = bodyStart;
        while (searchBoundaryFrom < buffer.length) {
          const nextBoundaryIdx = buffer.indexOf(delimiter, searchBoundaryFrom);
          if (nextBoundaryIdx === -1) break;

          if (nextBoundaryIdx > 0 && buffer[nextBoundaryIdx - 1] !== 0x0A) {
            searchBoundaryFrom = nextBoundaryIdx + 1;
            continue;
          }

          let bodyEnd = nextBoundaryIdx;
          if (bodyEnd > bodyStart && buffer[bodyEnd - 1] === 0x0A) {
            bodyEnd--;
            if (bodyEnd > bodyStart && buffer[bodyEnd - 1] === 0x0D) {
              bodyEnd--;
            }
          }

          if (bodyEnd > bodyStart) {
            // Zero-copy subarray scan preserves full JPEG EXIF/ICC headers without truncation
            imageDims = extractImageDimensionsFromBuffer(buffer.subarray(bodyStart, bodyEnd));
            partSearchOffset = nextBoundaryIdx;
          }
          break;
        }
      } else if (!requestJson && PART_NAME_REQUEST_REGEX.test(partHeaderText)) {
        let searchBoundaryFrom = bodyStart;
        while (searchBoundaryFrom < buffer.length) {
          const nextBoundaryIdx = buffer.indexOf(delimiter, searchBoundaryFrom);
          if (nextBoundaryIdx === -1) break;

          if (nextBoundaryIdx > 0 && buffer[nextBoundaryIdx - 1] !== 0x0A) {
            searchBoundaryFrom = nextBoundaryIdx + 1;
            continue;
          }

          let jsonEnd = nextBoundaryIdx;
          if (jsonEnd > bodyStart && buffer[jsonEnd - 1] === 0x0A) {
            jsonEnd--;
            if (jsonEnd > bodyStart && buffer[jsonEnd - 1] === 0x0D) {
              jsonEnd--;
            }
          }

          const sliceLen = jsonEnd - bodyStart;
          if (sliceLen > 0 && sliceLen <= MAX_JSON_PART_BYTES) {
            try {
              const parsed = JSON.parse(buffer.subarray(bodyStart, jsonEnd).toString('utf8').trim());
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                requestJson = parsed;
                partSearchOffset = nextBoundaryIdx;
                break;
              }
            } catch (_) {}
          }
          searchBoundaryFrom = nextBoundaryIdx + delimiter.length;
        }
      }

      if (partSearchOffset <= boundaryIdx) {
        partSearchOffset = boundaryIdx + delimiter.length;
      }
    }

    if (imageDims) {
      return {
        width: imageDims.width,
        height: imageDims.height,
        format: imageDims.format,
        jsonWidth: parseOptionalInt(requestJson?.width),
        jsonHeight: parseOptionalInt(requestJson?.height),
        model: typeof requestJson?.model === 'string' ? requestJson.model.trim() : null,
        scale: parseOptionalInt(requestJson?.scale)
      };
    }
    return null;
  }

  // Direct JSON payload fallback ({ image: "<base64|dataUri>", width?, height?, scale? })
  const descriptor = extractDescriptorFromBuffer(buffer, contentType);
  if (descriptor && descriptor.json && typeof descriptor.json.image === 'string') {
    const dims = extractDimensionsFromBase64Image(descriptor.json.image);
    if (dims) {
      return {
        width: dims.width,
        height: dims.height,
        format: dims.format,
        jsonWidth: parseOptionalInt(descriptor.json.width),
        jsonHeight: parseOptionalInt(descriptor.json.height),
        model: typeof descriptor.json.model === 'string' ? descriptor.json.model.trim() : null,
        scale: parseOptionalInt(descriptor.json.scale)
      };
    }
  }

  return null;
}

/**
 * Dedicated zero-copy payload validator for Channel B `/ai/encode-vibe` requests.
 * Completely bypasses generation parameter extraction (`name="request"`), verifying
 * non-empty image presence across:
 * - RFC 2046 multipart/form-data (`name="image"` or `Content-Type: image/*` part with >0 body bytes),
 * - JSON payloads (`{ image: "<non-empty base64 or data URI>" }`), or
 * - Raw binary image streams (PNG, JPEG, WebP, GIF, BMP magic bytes or `image/*` / `application/octet-stream`).
 *
 * @param {Buffer} buffer - Accumulated raw client request buffer.
 * @param {string|null} [contentType=null] - Inbound HTTP Content-Type header value.
 * @returns {{ok: boolean, format?: string, reason?: string}} Validation outcome.
 */
function validateVibeEncodePayload(buffer, contentType = null) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'Vibe encoding payload must not be empty.' };
  }

  // 1. Multipart/FormData branch: verify non-empty image part without expecting name="request"
  const boundary = extractMultipartBoundary(buffer, contentType);
  if (boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    let partSearchOffset = 0;

    while (partSearchOffset < buffer.length) {
      const boundaryIdx = buffer.indexOf(delimiter, partSearchOffset);
      if (boundaryIdx === -1) break;

      if (boundaryIdx > 0 && buffer[boundaryIdx - 1] !== 0x0A) {
        partSearchOffset = boundaryIdx + 1;
        continue;
      }

      let cursor = boundaryIdx + delimiter.length;
      let isClosing = false;
      if (cursor + 1 < buffer.length && buffer[cursor] === 0x2D && buffer[cursor + 1] === 0x2D) {
        isClosing = true;
        cursor += 2;
      }

      while (cursor < buffer.length && (buffer[cursor] === 0x20 || buffer[cursor] === 0x09)) {
        cursor++;
      }

      if (cursor < buffer.length && buffer[cursor] === 0x0D) cursor++;
      if (cursor < buffer.length && buffer[cursor] === 0x0A) cursor++;

      if (isClosing) {
        break;
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

      const partHeaderText = buffer.subarray(partHeaderStart, headerEnd).toString('utf8');
      if (PART_NAME_IMAGE_REGEX.test(partHeaderText) || PART_CONTENT_TYPE_IMAGE_REGEX.test(partHeaderText)) {
        const bodyStart = headerEnd + headerDelimLen;
        let searchBoundaryFrom = bodyStart;

        while (searchBoundaryFrom < buffer.length) {
          const nextBoundaryIdx = buffer.indexOf(delimiter, searchBoundaryFrom);
          if (nextBoundaryIdx === -1) break;

          if (nextBoundaryIdx > 0 && buffer[nextBoundaryIdx - 1] !== 0x0A) {
            searchBoundaryFrom = nextBoundaryIdx + 1;
            continue;
          }

          let bodyEnd = nextBoundaryIdx;
          if (bodyEnd > bodyStart && buffer[bodyEnd - 1] === 0x0A) {
            bodyEnd--;
            if (bodyEnd > bodyStart && buffer[bodyEnd - 1] === 0x0D) {
              bodyEnd--;
            }
          }

          if (bodyEnd > bodyStart) {
            return { ok: true, format: 'multipart' };
          }
          break;
        }
      }

      partSearchOffset = boundaryIdx + delimiter.length;
    }

    return { ok: false, reason: 'Multipart vibe encoding payload is missing a non-empty image part.' };
  }

  // 2. Direct JSON branch: require non-empty string image property
  const scanLimit = Math.min(buffer.length, 4096);
  let firstNonWsByte = -1;
  let startIdx = -1;
  for (let i = 0; i < scanLimit; i++) {
    const b = buffer[i];
    if (b !== 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) {
      firstNonWsByte = b;
      startIdx = i;
      break;
    }
  }

  if (firstNonWsByte === 0x7B) { // '{'
    let endIdx = buffer.length - 1;
    while (endIdx >= startIdx) {
      const b = buffer[endIdx];
      if (b !== 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09) {
        break;
      }
      endIdx--;
    }

    const jsonLength = endIdx - startIdx + 1;
    if (jsonLength > 0 && jsonLength <= MAX_JSON_PART_BYTES && buffer[endIdx] === 0x7D) {
      try {
        const parsed = JSON.parse(buffer.subarray(startIdx, endIdx + 1).toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (typeof parsed.image === 'string' && parsed.image.trim().length > 0) {
            return { ok: true, format: 'json' };
          }
          return { ok: false, reason: 'JSON vibe encoding payload must include a non-empty "image" field.' };
        }
      } catch (_) {
        return { ok: false, reason: 'Malformed JSON in vibe encoding payload.' };
      }
    }

    return { ok: false, reason: 'Malformed or oversized JSON in vibe encoding payload.' };
  }

  // 3. Raw binary image branch: match standard image magic bytes or explicit binary image MIME types
  const isPng = buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
  const isJpeg = buffer.length >= 3 &&
    buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const isWebp = buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const isGif = buffer.length >= 6 && (
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
  );
  const isBmp = buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D;

  if (isPng || isJpeg || isWebp || isGif || isBmp) {
    return { ok: true, format: 'binary' };
  }

  if (typeof contentType === 'string') {
    const normalizedType = contentType.trim().toLowerCase();
    if (normalizedType.startsWith('image/') || normalizedType.startsWith('application/octet-stream')) {
      return { ok: true, format: 'binary' };
    }
  }

  return { ok: false, reason: 'Vibe encoding payload must contain valid image binary data or a JSON "image" field.' };
}

/**
 * Format-agnostic parameter extractor.
 * Safely parses JSON blocks or multipart streams, segregating Character References
 * (`director_reference_images*`) from Vibe Transfer (`reference_image_multiple`).
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
      (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0);

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
      if (Array.isArray(params.reference_image_multiple) && params.reference_image_multiple.length > 0) {
        rawVibeRefs = params.reference_image_multiple.length;
      } else if (Array.isArray(params.vibe_images)) {
        rawVibeRefs = params.vibe_images.length;
      } else if (Array.isArray(params.vibes)) {
        rawVibeRefs = params.vibes.length;
      }
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
    console.error('[GuildWeave Audit] Error extracting parameters from raw body:', err.message);
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
 * Legacy background audit entrypoint retained exclusively for Phase 4 unit test compatibility.
 * Commit 8 `proxyRouter.js` supersedes this post-hoc check via synchronous Stage 5
 * `commitSecurityBan()` and Stage 9 PoNR `commitAnlasDebit()`, eliminating double-counting
 * and post-hoc false bans on valid `X-Base-Paid` bypass generations.
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
    console.log(`[GuildWeave Audit Ledger] Deducted ${anlasSpent} Anlas on user profile ${targetUserId} (refs used: ${actualRefs})`);
  }

  // Punitive execution on hostile mismatch
  if (isViolation || bypassViolation) {
    console.warn(`\x1b[31m[GuildWeave SECURITY AUDIT] !!! HOSTILE PAYLOAD SPOOFING DETECTED !!!\x1b[0m`);
    console.warn(`[GuildWeave Security Audit] Device: "${browserId}", User: "${targetUserId}", Tier: "${effectiveTier}"`);
    
    try {
      const banReason = bypassViolation 
        ? `Firewall Bypass Violation: Client generated with V5 model ("${model}") but suppressed X-Gen-Model header.`
        : `Firewall Bypass Violation: Client spoofed headers to bypass ingress limits. Actual Body Payload: Pixels=${actualPixels}, Steps=${actualSteps}, Refs=${actualRefs}`;

      const banResult = await commitSecurityBan({
        browserId,
        userId: targetUserId,
        discordId: device.discord_id || null,
        reason: banReason
      });
      
      console.log(`[GuildWeave Security Audit] Success. Database ban committed for "${targetUserId}".`);
      return banResult;
    } catch (dbErr) {
      console.error('[GuildWeave Security Audit] Failed to execute database ban:', dbErr.message);
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
  commitSecurityBan,
  isV5ModelFamily,
  isV5MediumModel,
  calculateAnlasCost,
  calculateAnlasCostDetails,
  calculateUpscaleAnlasCost,
  calculateAvailableBalance,
  evaluateAnlasReset,
  evaluateV5Accrual,
  authorizeAnlasSpend,
  commitAnlasDebit,
  commitV5Debit,
  recordSurplusV5Usage,
  recordSubscriptionPeriod,
  recordPeriodUsage,
  adjustUserBalances,
  reconcileUserDebt,
  extractImageDimensionsFromBuffer,
  extractUpscaleParametersFromRawBody,
  extractParametersFromRawBody,
  validateVibeEncodePayload,
  sanitizeObjectForLogging,
  formatPayloadForLogging,
  runBackgroundAudit,
  getOrUpdateAllowance,
  getNextRefillTime,
  MAX_JSON_PART_BYTES,
  MAX_NOVELAI_PIXELS,
  MAX_NOVELAI_STEPS,
  UPSCALE_COST_BUCKETS,
  TELEMETRY_PROMPT_KEYS,
  DAY_MS,
  THIRTY_DAYS_MS
};