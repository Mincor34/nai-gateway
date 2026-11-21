/**
 * CLIENT-SIDE ANLAS PRICING & POLICY ENGINE (src/userscripts/shared/pricing.js)
 *
 * Pure browser-compatible ES module mirroring Level 2 `auditEngine.js` pricing formulas
 * (Module 643656 / Module 875333 parity: V5 1.5x multiplier, Medium un-ceiled / 1.75 formula,
 * `usageNegative` Opus lightweight bonus guard, 3MP/50-step hard limits, and segregated
 * Character Reference vs. Vibe Transfer accounting) and Commit 6/8 policy gates.
 * Zero Node.js host dependencies (`Buffer`, `process`, `require` strictly absent).
 */

'use strict';

export const ANLAS_ALPHA = 2.951823174884865e-6;
export const ANLAS_BETA = 5.753298233447344e-7;
export const V5_MEDIUM_REF_STEPS = 23;
export const V5_MEDIUM_DIVISOR = 1.75;
export const V5_COST_MULTIPLIER = 1.5;
export const ANLAS_MAX_PER_IMAGE_CAP = 140;
export const ANLAS_MIN_PER_IMAGE_FLOOR = 2;
export const MAX_NOVELAI_PIXELS = 3145728;
export const MAX_NOVELAI_STEPS = 50;
export const V5_HIGH_NCP_COST = 18;
export const V5_MEDIUM_NCP_COST = 10;
export const FIREWALL_MAX_PIXELS = 1048576;
export const FIREWALL_MAX_STEPS = 28;
export const FIREWALL_MAX_SAMPLES = 1;

/**
 * Evaluates whether a given model identifier belongs to the V5 architecture family.
 * Strictly distinguishes V5 models from `.5` legacy variants (1.5, 3-5, 4-5, 4_5, 4.5).
 *
 * @param {string|null|undefined} model - Target model identifier string.
 * @returns {boolean} True if the model represents a NovelAI V5 variant.
 */
export function isV5ModelFamily(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (/\d[-_.]5/i.test(trimmed)) return false;
  return /(?:^|[-_])v?5(?:[-_]|$)/i.test(trimmed);
}

/**
 * Evaluates whether a model identifier represents the V5 Medium Effort variant.
 *
 * @param {string|null|undefined} model - Target model identifier string.
 * @returns {boolean} True if the model is V5 Medium.
 */
export function isV5MediumModel(model) {
  if (!isV5ModelFamily(model)) return false;
  return /medium/i.test(model.trim());
}

/**
 * Strictly parses an optional safe integer, truncating finite floats without array/boolean coercion.
 *
 * @param {*} val - Candidate input.
 * @param {number|null} [fallback=null] - Fallback if invalid.
 * @returns {number|null} Evaluated safe integer.
 */
function parseStrictInt(val, fallback = null) {
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
 * Strictly parses an optional finite float without array/boolean coercion.
 *
 * @param {*} val - Candidate input.
 * @param {number|null} [fallback=null] - Fallback if invalid.
 * @returns {number|null} Evaluated finite float.
 */
function parseStrictFloat(val, fallback = null) {
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
 * Computes the authoritative client-side Anlas cost breakdown mirroring `auditEngine.js`
 * and NovelAI Module 643656 / Module 875333 (`docs/anlas-calculation.md`).
 * - V5 Medium: un-ceiled `(ANLAS_ALPHA * area + ANLAS_BETA * area * 23) / 1.75`
 * - Other models: `Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * steps)`
 * - SMEA multiplier followed by `1.5x` V5 multiplier across all V5 models
 * - Opus lightweight bonus disabled for V5 when `usageNegative === true`
 * - Enforces 140 Anlas/image cap, 3MP area cap, and 50-step cap (non-Medium)
 *
 * @param {object|null} params - Extracted payload parameters.
 * @param {object} [options={}] - Calculation context.
 * @param {boolean} [options.isOpus=true] - Whether Opus lightweight bonus applies.
 * @param {boolean} [options.usageNegative=false] - Whether the master V5 tank is negative.
 * @returns {{total: number, base: number, per_image: number, billable_samples: number, character_reference_anlas: number, vibe_encoding_anlas: number, vibe_reference_anlas: number, exceeds_cap: boolean, cap_reason: string|null}}
 */
export function calculateAnlasCostDetails(params, { isOpus = true, usageNegative = false } = {}) {
  if (!params || typeof params !== 'object') {
    return {
      total: 0,
      base: 0,
      per_image: 0,
      billable_samples: 0,
      character_reference_anlas: 0,
      vibe_encoding_anlas: 0,
      vibe_reference_anlas: 0,
      exceeds_cap: false,
      cap_reason: null
    };
  }

  const parsedWidth = parseStrictInt(params.width, 1024);
  const width = parsedWidth > 0 ? parsedWidth : 1024;

  const parsedHeight = parseStrictInt(params.height, 1024);
  const height = parsedHeight > 0 ? parsedHeight : 1024;
  const area = width * height;

  const model = typeof params.model === 'string' ? params.model.trim() : '';
  const isV5Medium = isV5MediumModel(model);
  const isV5 = isV5ModelFamily(model);

  const parsedSteps = parseStrictInt(params.steps, 28);
  const rawSteps = parsedSteps > 0 ? parsedSteps : 28;

  const baseCalculated = isV5Medium
    ? ((ANLAS_ALPHA * area + ANLAS_BETA * area * V5_MEDIUM_REF_STEPS) / V5_MEDIUM_DIVISOR)
    : Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * rawSteps);

  let multiplier = 1.0;
  const sm = params.sm === true || params.sm === 'true' || params.sm === 1;
  const smDyn = params.sm_dyn === true || params.sm_dyn === 'true' || params.sm_dyn === 1;

  if (sm && smDyn) {
    multiplier = 1.4;
  } else if (sm) {
    multiplier = 1.2;
  }
  let w = baseCalculated * multiplier;

  if (isV5) {
    w *= V5_COST_MULTIPLIER;
  }

  let strengthFactor = 1.0;
  const hasMask = Boolean(params.has_mask || params.mask);
  const hasImage = Boolean(params.has_image || params.image);

  if (hasMask) {
    if (params.inpaintImg2ImgStrength !== undefined && params.inpaintImg2ImgStrength !== null) {
      const s = parseStrictFloat(params.inpaintImg2ImgStrength);
      if (s !== null) strengthFactor = Math.max(0.0, Math.min(1.0, s));
    }
  } else if (hasImage) {
    if (params.strength !== undefined && params.strength !== null) {
      const s = parseStrictFloat(params.strength);
      if (s !== null) strengthFactor = Math.max(0.0, Math.min(1.0, s));
    }
  }

  const perImageAnlas = Math.max(Math.ceil(w * strengthFactor), ANLAS_MIN_PER_IMAGE_FLOOR);
  let capReason = null;
  if (perImageAnlas > ANLAS_MAX_PER_IMAGE_CAP) {
    capReason = `Per-image cost of ${perImageAnlas} Anlas exceeds maximum cap of ${ANLAS_MAX_PER_IMAGE_CAP} Anlas.`;
  } else if (area > MAX_NOVELAI_PIXELS) {
    capReason = `Image resolution area of ${area}px (${width}x${height}) exceeds maximum NovelAI cap of ${MAX_NOVELAI_PIXELS}px.`;
  } else if (!isV5Medium && rawSteps > MAX_NOVELAI_STEPS) {
    capReason = `Step count of ${rawSteps} exceeds maximum NovelAI cap of ${MAX_NOVELAI_STEPS} steps.`;
  }
  const exceedsCap = capReason !== null;

  const parsedSamples = parseStrictInt(params.n_samples, 1);
  const nSamples = parsedSamples > 0 ? parsedSamples : 1;
  let billableSamples = nSamples;

  const withinOpusSteps = isV5Medium || rawSteps <= FIREWALL_MAX_STEPS;
  const opusUsageExhausted = isV5 && Boolean(usageNegative);
  if (isOpus && !opusUsageExhausted && area <= FIREWALL_MAX_PIXELS && withinOpusSteps) {
    billableSamples = Math.max(0, nSamples - 1);
  }

  const baseAnlas = perImageAnlas * billableSamples;

  let rawRefs = params.precise_refs ?? params.precise_ref_count ?? params.character_reference_count ?? params.reference_count;
  if (rawRefs === undefined || rawRefs === null) {
    const cachedCount = Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0;
    const directCount = Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0;
    const totalArr = cachedCount + directCount;
    if (totalArr > 0) rawRefs = totalArr;
  }

  const parsedRefs = parseStrictInt(rawRefs, 0);
  const preciseRefs = parsedRefs > 0 ? parsedRefs : 0;
  const characterReferenceAnlas = 5 * preciseRefs * nSamples;

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

    const uncachedVibes = Math.max(0, parseStrictInt(rawUncached, 0));
    const vibeRefs = Math.max(0, parseStrictInt(rawVibeRefs, 0));

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
    vibe_reference_anlas: vibeReferenceAnlas,
    exceeds_cap: exceedsCap,
    cap_reason: capReason
  };
}

/**
 * Computes total integer Anlas cost for a parameter descriptor.
 *
 * @param {object|null} params - Extracted generation parameters.
 * @param {object} [options={}] - Calculation context.
 * @returns {number} Total integer Anlas cost.
 * @throws {Error} If per-image cost, area, or step count exceeds NovelAI limits.
 */
export function calculateAnlasCost(params, options = {}) {
  const details = calculateAnlasCostDetails(params, options);
  if (details.exceeds_cap) {
    throw new Error(details.cap_reason || `Per-image cost of ${details.per_image} Anlas exceeds maximum cap of ${ANLAS_MAX_PER_IMAGE_CAP} Anlas.`);
  }
  return details.total;
}

/**
 * Evaluates client-side pre-flight policy before dispatching `/queue/join`.
 * Enforces:
 * - Per-image 140 Anlas cap, 3MP area cap, and non-Medium 50-step cap
 * - V5 High 24-28 step battery deadband block (Medium bypasses deadband)
 * - Debt lockout (`DEBT_LOCKED`) on Anlas-consuming requests while permitting free Opus
 * - Explicit Anlas Bypass toggle check (`BYPASS_DISABLED`) when exceeding 1MP, 1 sample, or 28 steps
 * - Available virtual Anlas balance check
 * - Master subscription active check, 5.5% V5 circuit breaker (exempting `masterTokenExpired`
 *   so guests recover immediately once admin pushes a fresh token), and V5 NCP depletion check
 *
 * @param {object} imgParams - Extracted generation parameters.
 * @param {object} [state={}] - Current client policy/telemetry state from `/auth/status` & local settings.
 * @returns {{ok: boolean, status?: number, error?: string, message?: string, isV5: boolean, isV5Medium: boolean, isBasePaid: boolean, reqNcp: number, costDetails: object}}
 */
export function evaluateGenerationPolicy(imgParams, state = {}) {
  const safeParams = imgParams && typeof imgParams === 'object' ? imgParams : {};
  const width = parseStrictInt(safeParams.width, 1024) || 1024;
  const height = parseStrictInt(safeParams.height, 1024) || 1024;
  const area = width * height;
  const nSamples = parseStrictInt(safeParams.n_samples, 1) || 1;
  const model = typeof safeParams.model === 'string' ? safeParams.model.trim() : '';

  const isV5 = isV5ModelFamily(model);
  const isV5Medium = isV5MediumModel(model);
  const steps = parseStrictInt(safeParams.steps, isV5Medium ? 14 : 28) || (isV5Medium ? 14 : 28);

  const costDetails = calculateAnlasCostDetails(safeParams, {
    isOpus: true,
    usageNegative: isV5 && Boolean(state.masterV5IsNegative)
  });
  const exceedsBaseLimits = (area > FIREWALL_MAX_PIXELS) || (nSamples !== FIREWALL_MAX_SAMPLES) || (!isV5Medium && steps > FIREWALL_MAX_STEPS);
  const isBasePaid = exceedsBaseLimits;
  const reqNcp = (isV5 && !isBasePaid) ? (isV5Medium ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST) : 0;

  if (costDetails.exceeds_cap) {
    return {
      ok: false,
      status: 400,
      error: 'PARAMETRIC_LIMIT_EXCEEDED',
      message: costDetails.cap_reason || `Per-image cost of ${costDetails.per_image} Anlas exceeds maximum cap of ${ANLAS_MAX_PER_IMAGE_CAP} Anlas.`,
      isV5,
      isV5Medium,
      isBasePaid,
      reqNcp,
      costDetails
    };
  }

  // V5 High free-tier deadband guard (steps 24-28 at <=1MP, 1 sample)
  if (isV5 && !isV5Medium && area <= FIREWALL_MAX_PIXELS && nSamples === FIREWALL_MAX_SAMPLES && steps >= 24 && steps <= 28) {
    return {
      ok: false,
      status: 400,
      error: 'PARAMETRIC_LIMIT_EXCEEDED',
      message: 'Steps 24-28 on V5 Full (High) are prohibited (battery deadband). Use ≤23 for free tier, switch to Medium effort, or enable Anlas bypass with >28 steps.',
      isV5,
      isV5Medium,
      isBasePaid: false,
      reqNcp,
      costDetails
    };
  }

  const totalAnlas = costDetails.total;
  const requiresAnlas = isBasePaid || totalAnlas > 0;
  const isInDebt = Boolean(state.isInDebt);
  const bypassEnabled = Boolean(state.bypassEnabled) && !isInDebt;

  if (isInDebt && requiresAnlas) {
    return {
      ok: false,
      status: 403,
      error: 'DEBT_LOCKED',
      message: `Anlas Balance: ${state.virtualBalance} (Bypass Locked). Anlas-consuming generations are locked until balance restoration. Free Opus generations remain operational.`,
      isV5,
      isV5Medium,
      isBasePaid,
      reqNcp,
      costDetails
    };
  }

  if (exceedsBaseLimits && !bypassEnabled) {
    return {
      ok: false,
      status: 400,
      error: 'BYPASS_DISABLED',
      message: `Anlas Bypass is disabled. Enable 'Anlas Bypass' in GuildWeave HUD/Settings to generate above 1MP, >1 sample, or >28 steps (Estimated cost: ${totalAnlas} Anlas).`,
      isV5,
      isV5Medium,
      isBasePaid,
      reqNcp,
      costDetails
    };
  }

  if (requiresAnlas && typeof state.availableAnlas === 'number' && Number.isFinite(state.availableAnlas) && totalAnlas > state.availableAnlas) {
    return {
      ok: false,
      status: 403,
      error: 'INSUFFICIENT_ANLAS',
      message: `Insufficient virtual Anlas balance (${state.availableAnlas} available, ${totalAnlas} required).`,
      isV5,
      isV5Medium,
      isBasePaid,
      reqNcp,
      costDetails
    };
  }

  if (state.subscriptionActive === false && typeof state.lastFetchedAt === 'number' && state.lastFetchedAt > 0) {
    return {
      ok: false,
      status: 503,
      error: 'MASTER_SUBSCRIPTION_INACTIVE',
      message: 'Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.',
      isV5,
      isV5Medium,
      isBasePaid,
      reqNcp,
      costDetails
    };
  }

  if (isV5 && !isBasePaid) {
    if (state.isHardLocked && !state.masterTokenExpired && state.clusterState !== 'token_expired') {
      return {
        ok: false,
        status: 503,
        error: 'V5_BATTERY_CRITICAL',
        message: 'Battery Recharging: Master V5 capacity is at or below the 5.5% safety floor. Switch to a non-V5 model or use Anlas Bypass (>1MP / >1 sample / >28 steps).',
        isV5,
        isV5Medium,
        isBasePaid,
        reqNcp,
        costDetails
      };
    }

    if (typeof state.v5AvailableNcp === 'number' && Number.isFinite(state.v5AvailableNcp)) {
      const personalOk = state.v5AvailableNcp >= reqNcp;
      const surplusAvailable = typeof state.v5SurplusAvailableNcp === 'number' ? state.v5SurplusAvailableNcp : 0;
      const surplusOk = Boolean(state.v5SurplusEligible) && surplusAvailable >= reqNcp;

      if (!personalOk && !surplusOk) {
        return {
          ok: false,
          status: 429,
          error: 'V5_CAPACITY_DEPLETED',
          message: `V5 Quota Depleted: Insufficient V5 compute capacity (${state.v5AvailableNcp} personal NCP, ${state.v5SurplusEligible ? surplusAvailable : 0} surplus NCP available; ${reqNcp} NCP required).`,
          isV5,
          isV5Medium,
          isBasePaid,
          reqNcp,
          costDetails
        };
      }
    }
  }

  return {
    ok: true,
    isV5,
    isV5Medium,
    isBasePaid,
    reqNcp,
    costDetails
  };
}