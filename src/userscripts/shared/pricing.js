/**
 * CLIENT-SIDE ANLAS PRICING & POLICY ENGINE (src/userscripts/shared/pricing.js)
 *
 * Pure browser-compatible ES module mirroring Level 2 `auditEngine.js` pricing formulas
 * (Module 643656 / Module 875333 parity: V5 1.5x multiplier, Medium un-ceiled / 1.75 formula,
 * `usageNegative` Opus lightweight bonus guard, `/ai/upscale` 1..4 Anlas binary-header bucket
 * pricing, 3MP/50-step hard limits, and segregated Character Reference vs. Vibe Transfer accounting)
 * and Commit 6/8 policy gates.
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

export const UPSCALE_COST_BUCKETS = [
  [1048576, 1],
  [1747627, 2],
  [2446678, 3],
  [3145728, 4]
];

const UPSCALE_FAST_BYTES = 65536;
const UPSCALE_JPEG_MAX_BYTES = 2097152;
const BASE64_FAST_CHARS = 87384;
const BASE64_JPEG_MAX_CHARS = 2796200;

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
 * Extracts intrinsic pixel dimensions from a leading Uint8Array slice of PNG, JPEG,
 * WebP, GIF, or BMP binary data in pure browser JS (zero Buffer dependency).
 *
 * @param {Uint8Array} bytes - Binary header slice.
 * @returns {{ width: number, height: number, format: string }|null} Intrinsic dimensions or null.
 */
export function extractImageDimensionsFromBytes(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length < 10) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. PNG (89 50 4E 47 0D 0A 1A 0A + IHDR)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
    bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A &&
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  ) {
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return (width > 0 && height > 0) ? { width, height, format: 'png' } : null;
  }

  // 2. WebP (RIFF....WEBP + VP8 / VP8L / VP8X)
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (tag === 'VP8 ') {
      if ((bytes[20] & 1) === 0 && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
        const width = view.getUint16(26, true) & 0x3FFF;
        const height = view.getUint16(28, true) & 0x3FFF;
        return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
      }
      return null;
    }
    if (tag === 'VP8L') {
      if (bytes[20] === 0x2F) {
        const bits = view.getUint32(21, true);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
      }
      return null;
    }
    if (tag === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return (width > 0 && height > 0) ? { width, height, format: 'webp' } : null;
    }
    return null;
  }

  // 3. JPEG (FF D8 ... SOF0..SOF15)
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let pos = 2;
    while (pos + 1 < bytes.length) {
      if (bytes[pos] !== 0xFF) {
        pos++;
        continue;
      }
      while (pos + 1 < bytes.length && bytes[pos + 1] === 0xFF) {
        pos++;
      }
      if (pos + 1 >= bytes.length) break;
      const marker = bytes[pos + 1];
      pos += 2;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
        continue;
      }
      if (marker === 0xD9 || marker === 0xDA) break;
      if (pos + 2 > bytes.length) break;
      const segLen = view.getUint16(pos, false);
      if (segLen < 2 || pos + segLen > bytes.length) break;
      const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
                    (marker >= 0xC5 && marker <= 0xC7) ||
                    (marker >= 0xC9 && marker <= 0xCB) ||
                    (marker >= 0xCD && marker <= 0xCF);
      if (isSof && segLen >= 7 && pos + 7 <= bytes.length) {
        const height = view.getUint16(pos + 3, false);
        const width = view.getUint16(pos + 5, false);
        return (width > 0 && height > 0) ? { width, height, format: 'jpeg' } : null;
      }
      pos += segLen;
    }
    return null;
  }

  // 4. GIF (GIF87a / GIF89a)
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return (width > 0 && height > 0) ? { width, height, format: 'gif' } : null;
  }

  // 5. BMP (BM + BITMAPCOREHEADER / BITMAPINFOHEADER)
  if (bytes.length >= 22 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) {
      const width = view.getUint16(18, true);
      const height = view.getUint16(20, true);
      return (width > 0 && height > 0) ? { width, height, format: 'bmp' } : null;
    }
    if (bytes.length >= 26) {
      const width = view.getInt32(18, true);
      const height = Math.abs(view.getInt32(22, true));
      return (width > 0 && height > 0) ? { width, height, format: 'bmp' } : null;
    }
  }

  return null;
}

/**
 * Decodes a Base64 (or data URI) image prefix into binary bytes in pure browser JS,
 * stripping internal whitespace, aligning to 4-char boundaries, and expanding the
 * scan budget up to ~2MB when JPEG EXIF metadata pushes SOF0..SOF15 past 64KB.
 *
 * @param {string} rawImageStr - Base64 payload or data URI.
 * @returns {{ width: number, height: number, format: string }|null}
 */
function extractDimensionsFromBase64Browser(rawImageStr) {
  if (typeof rawImageStr !== 'string' || typeof atob !== 'function') return null;
  const trimmed = rawImageStr.trim();
  const commaIdx = trimmed.startsWith('data:image/') ? trimmed.indexOf(',') : -1;
  const cleanB64 = (commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed).replace(/\s+/g, '');
  if (cleanB64.length === 0) return null;

  const decodeSlice = (len) => {
    const aligned = len - (len % 4);
    if (aligned <= 0) return null;
    const binStr = atob(cleanB64.slice(0, aligned));
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return extractImageDimensionsFromBytes(bytes);
  };

  const fastLen = Math.min(cleanB64.length, BASE64_FAST_CHARS);
  const fastDims = decodeSlice(fastLen);
  if (fastDims) return fastDims;

  if (cleanB64.startsWith('/9j/') && cleanB64.length > BASE64_FAST_CHARS) {
    return decodeSlice(Math.min(cleanB64.length, BASE64_JPEG_MAX_CHARS));
  }

  return null;
}

/**
 * Extracts image dimensions from an `/ai/upscale` outgoing request body
 * (`FormData` with binary `image` Blob/Uint8Array/string, or JSON `{ image: base64 }`).
 * Automatically expands JPEG header scans past 64KB up to 2MB when EXIF metadata precedes SOF.
 *
 * @param {FormData|string|Blob|Uint8Array|ArrayBuffer|object|null} body - Outgoing request payload.
 * @returns {Promise<{ width: number, height: number, format: string }|null>}
 */
export async function extractUpscaleBodyParams(body) {
  if (!body) return null;

  try {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const imgPart = body.get('image');
      if (!imgPart) return null;
      if (typeof Blob !== 'undefined' && imgPart instanceof Blob) {
        const headerSlice = typeof imgPart.slice === 'function' ? imgPart.slice(0, UPSCALE_FAST_BYTES) : imgPart;
        const fastBytes = new Uint8Array(await headerSlice.arrayBuffer());
        const fastDims = extractImageDimensionsFromBytes(fastBytes);
        if (fastDims) return fastDims;

        if (
          fastBytes.length >= 2 &&
          fastBytes[0] === 0xFF && fastBytes[1] === 0xD8 &&
          typeof imgPart.slice === 'function' &&
          (imgPart.size || 0) > UPSCALE_FAST_BYTES
        ) {
          const jpegSlice = imgPart.slice(0, Math.min(imgPart.size, UPSCALE_JPEG_MAX_BYTES));
          const jpegBytes = new Uint8Array(await jpegSlice.arrayBuffer());
          return extractImageDimensionsFromBytes(jpegBytes);
        }
        return null;
      }
      if (imgPart instanceof Uint8Array) {
        const fastDims = extractImageDimensionsFromBytes(imgPart.subarray(0, UPSCALE_FAST_BYTES));
        if (fastDims) return fastDims;
        if (imgPart.length > UPSCALE_FAST_BYTES && imgPart[0] === 0xFF && imgPart[1] === 0xD8) {
          return extractImageDimensionsFromBytes(imgPart.subarray(0, UPSCALE_JPEG_MAX_BYTES));
        }
        return null;
      }
      if (typeof ArrayBuffer !== 'undefined' && imgPart instanceof ArrayBuffer) {
        const fullView = new Uint8Array(imgPart);
        const fastDims = extractImageDimensionsFromBytes(fullView.subarray(0, UPSCALE_FAST_BYTES));
        if (fastDims) return fastDims;
        if (fullView.length > UPSCALE_FAST_BYTES && fullView[0] === 0xFF && fullView[1] === 0xD8) {
          return extractImageDimensionsFromBytes(fullView.subarray(0, UPSCALE_JPEG_MAX_BYTES));
        }
        return null;
      }
      if (typeof imgPart === 'string') {
        return extractDimensionsFromBase64Browser(imgPart);
      }
      return null;
    }

    let parsedJson = null;
    if (typeof body === 'string') {
      parsedJson = JSON.parse(body);
    } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
      parsedJson = JSON.parse(await body.text());
    } else if (body instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else if (typeof body === 'object' && !Array.isArray(body)) {
      parsedJson = body;
    }

    if (parsedJson && typeof parsedJson.image === 'string') {
      return extractDimensionsFromBase64Browser(parsedJson.image);
    }
  } catch (_) {}

  return null;
}

/**
 * Computes the `/ai/upscale` Anlas cost using NovelAI Module 643656's pixel-area
 * bucket table (`1..4` Anlas up to `3,145,728 px`, no Opus discount).
 *
 * @param {number} width - Source image width in pixels.
 * @param {number} height - Source image height in pixels.
 * @returns {number} Integer Anlas cost (`1..4`).
 * @throws {Error} If dimensions are invalid or exceed 3MP (`3,145,728 px`).
 */
export function calculateUpscaleAnlasCost(width, height) {
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
 * Evaluates pre-flight policy for `/ai/upscale` requests.
 * Checks image pixel ceiling, negative Anlas debt lockout, virtual Anlas balance,
 * and active master Opus subscription—exempting V5 NCP and V5 5.5% battery gates.
 *
 * @param {{ width: number, height: number }|null} upscaleDims - Parsed image dimensions.
 * @param {object} [state={}] - Client policy state.
 * @returns {{ok: boolean, status?: number, error?: string, message?: string, cost: number}}
 */
export function evaluateUpscalePolicy(upscaleDims, state = {}) {
  if (!upscaleDims || !upscaleDims.width || !upscaleDims.height) {
    return {
      ok: false,
      status: 400,
      error: 'INVALID_UPSCALE_PAYLOAD',
      message: 'Unable to read source image dimensions for upscale billing.',
      cost: 0
    };
  }

  let cost;
  try {
    cost = calculateUpscaleAnlasCost(upscaleDims.width, upscaleDims.height);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: 'PARAMETRIC_LIMIT_EXCEEDED',
      message: err.message,
      cost: 0
    };
  }

  if (state.isInDebt) {
    return {
      ok: false,
      status: 403,
      error: 'DEBT_LOCKED',
      message: `Anlas Overdrawn: ${state.virtualBalance} (Paid Features Paused). Upscaling requires restoring your Anlas balance.`,
      cost
    };
  }

  if (typeof state.availableAnlas === 'number' && Number.isFinite(state.availableAnlas) && cost > state.availableAnlas) {
    return {
      ok: false,
      status: 403,
      error: 'INSUFFICIENT_ANLAS',
      message: `Insufficient monthly Anlas (${state.availableAnlas} available, ${cost} required to upscale).`,
      cost
    };
  }

  if (state.subscriptionActive === false && typeof state.lastFetchedAt === 'number' && state.lastFetchedAt > 0) {
    return {
      ok: false,
      status: 503,
      error: 'MASTER_SUBSCRIPTION_INACTIVE',
      message: 'Master NovelAI Opus subscription is inactive or expired. Upscaling temporarily unavailable.',
      cost
    };
  }

  return { ok: true, cost };
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
 * - Debt lockout (`DEBT_LOCKED`) on Anlas-consuming requests while permitting standard generations
 * - Explicit monthly Anlas usage toggle check (`BYPASS_DISABLED`) when exceeding 1MP, 1 sample, or 28 steps
 * - Available monthly Anlas balance check
 * - Master subscription active check, 5.5% V5 circuit breaker (exempting `masterTokenExpired`
 *   so guests recover immediately once admin pushes a fresh token), and V5 compute allowance check
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

  // V5 High deadband guard (steps 24-28 at <=1MP, 1 sample)
  if (isV5 && !isV5Medium && area <= FIREWALL_MAX_PIXELS && nSamples === FIREWALL_MAX_SAMPLES && steps >= 24 && steps <= 28) {
    return {
      ok: false,
      status: 400,
      error: 'PARAMETRIC_LIMIT_EXCEEDED',
      message: 'V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24–28 are blocked to protect shared V5 limits—use ≤23 steps or switch to Medium.',
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
      message: `Anlas Overdrawn: ${state.virtualBalance} (Paid Features Paused). Anlas-consuming generations are locked until balance restoration. Standard generations remain operational.`,
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
      message: `Anlas Specs Locked: Enable 'Use Monthly Anlas' in the GuildWeave bar or settings to generate >1MP sizes, batches (>1), or >28 steps (Estimated cost: ${totalAnlas} Anlas).`,
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
      message: `Insufficient monthly Anlas (${state.availableAnlas} available, ${totalAnlas} required).`,
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
        message: 'V5 Shared Pool Recharging: Shared capacity is below 5.5%. Switch to a legacy model or enable monthly Anlas for higher specs.',
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
        const highAvail = Math.floor(state.v5AvailableNcp / V5_HIGH_NCP_COST);
        const medAvail = Math.floor(state.v5AvailableNcp / V5_MEDIUM_NCP_COST);
        return {
          ok: false,
          status: 429,
          error: 'V5_CAPACITY_DEPLETED',
          message: `V5 Allowance Exhausted: You currently have ${highAvail} High / ${medAvail} Medium V5 generations remaining. Switch to a legacy model or wait for the next daily refill.`,
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