/**
 * PARAMETRIC FIREWALL ANALYZER & ANLAS ACCOUNTING (src/userscripts/shared/params.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Pure Browser Type Discrimination: Validates FormData, strings, Blobs, Uint8Arrays, and ArrayBuffers.
 *    Strictly devoid of Node.js host dependencies.
 * 2. Character Reference & Vibe Demuxing: Segregates Character References
 *    (`director_reference_images_cached`, `director_reference_images`) from Vibe Transfer
 *    (`reference_image_multiple`, `vibe_images`, `vibes`), matching server-side
 *    `auditEngine.extractParametersFromRawBody` 1-to-1 to prevent Stage 5 mismatches,
 *    extracts SMEA (`sm`, `sm_dyn`), Img2Img/Inpaint strengths, FormData image/mask presence,
 *    and preserves exact body step integers for Stage 5 anti-spoofing reconciliation.
 * 3. Graceful Failure: Corrupted, non-UTF8, or truncated JSON streams return `null` without uncaught exceptions,
 *    but errors are explicitly logged.
 * 4. Single-Export Sandbox Compatibility: Exposes exclusively `extractImageParams` with zero external
 *    imports so isolated Phase 6 VM harness checks execute cleanly.
 */

'use strict';

/**
 * Safely extracts generation parameters, strengths, SMEA flags, vibe counts,
 * and character reference counts from outgoing request payloads.
 *
 * @param {FormData|string|Uint8Array|ArrayBuffer|Blob|object|null} body - Raw outgoing payload.
 * @returns {Promise<{width: number, height: number, steps: number, has_explicit_steps: boolean, n_samples: number, precise_refs: number, model: string, sm: boolean, sm_dyn: boolean, strength: number|null, inpaintImg2ImgStrength: number|null, has_image: boolean, has_mask: boolean, uncached_vibe_count: number, vibe_reference_count: number}|null>}
 */
export async function extractImageParams(body) {
    if (!body) return null;

    const parseOptionalIntLocal = (val, fallback = null) => {
        if (typeof val === 'number') {
            if (!Number.isFinite(val)) return fallback;
            const t = Math.trunc(val);
            if (t > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
            if (t < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
            return t;
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
    };

    const parseOptionalFloatLocal = (val) => {
        if (typeof val === 'number') {
            return Number.isFinite(val) ? val : null;
        }
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
                const num = Number(trimmed);
                return Number.isFinite(num) ? num : null;
            }
        }
        return null;
    };

    try {
        let payload = null;
        let formHasImage = false;
        let formHasMask = false;

        // Extract JSON structure from multipart FormData if encapsulated in a Blob
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            formHasImage = typeof body.has === 'function' ? body.has('image') : Boolean(body.get('image'));
            formHasMask = typeof body.has === 'function' ? body.has('mask') : Boolean(body.get('mask'));
            const requestBlob = body.get("request");
            if (!requestBlob) return null;
            const text = typeof requestBlob.text === 'function'
                ? await requestBlob.text()
                : String(requestBlob);
            payload = JSON.parse(text);
        } else if (typeof body === 'string') {
            payload = JSON.parse(body);
        } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
            const text = await body.text();
            payload = JSON.parse(text);
        } else if (body instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)) {
            const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            payload = JSON.parse(text);
        } else if (typeof body === 'object' && !Array.isArray(body)) {
            // Accept plain objects that contain explicit generation parameters
            if (body.parameters || body.width || body.model) {
                payload = body;
            }
        }

        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const params = (payload.parameters && typeof payload.parameters === 'object' && !Array.isArray(payload.parameters))
                ? payload.parameters
                : payload;

            const rawModel = typeof payload.model === 'string'
                ? payload.model.trim()
                : (typeof params.model === 'string' ? params.model.trim() : "");
            const isV5Medium = !/\d[-_.]5/i.test(rawModel) &&
                /(?:^|[-_])v?5(?:[-_]|$)/i.test(rawModel) &&
                /medium/i.test(rawModel);

            // Must match auditEngine.extractParametersFromRawBody 1-to-1 so X-Precise-Refs never diverges at Stage 5
            const preciseRefs =
                (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) +
                (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0);

            const parsedWidth = parseOptionalIntLocal(params.width ?? payload.width);
            const parsedHeight = parseOptionalIntLocal(params.height ?? payload.height);
            const parsedSteps = parseOptionalIntLocal(params.steps ?? payload.steps);
            const parsedSamples = parseOptionalIntLocal(params.n_samples ?? payload.n_samples);

            const parsedStrength = parseOptionalFloatLocal(params.strength ?? payload.strength);
            const parsedInpaintStrength = parseOptionalFloatLocal(params.inpaintImg2ImgStrength ?? payload.inpaintImg2ImgStrength);

            const hasImage = formHasImage || Boolean(params.image || payload.image);
            const hasMask = formHasMask || Boolean(params.mask || payload.mask);

            const parsedUncached = parseOptionalIntLocal(params.uncached_vibe_count ?? payload.uncached_vibe_count, 0);
            let rawVibeRefs = params.vibe_reference_count ?? payload.vibe_reference_count;
            if (rawVibeRefs === undefined || rawVibeRefs === null) {
                if (Array.isArray(params.reference_image_multiple) && params.reference_image_multiple.length > 0) {
                    rawVibeRefs = params.reference_image_multiple.length;
                } else if (Array.isArray(params.vibe_images)) {
                    rawVibeRefs = params.vibe_images.length;
                } else if (Array.isArray(params.vibes)) {
                    rawVibeRefs = params.vibes.length;
                }
            }
            const parsedVibeRefs = parseOptionalIntLocal(rawVibeRefs, 0);

            const rawSm = params.sm ?? payload.sm;
            const rawSmDyn = params.sm_dyn ?? payload.sm_dyn;

            // Stage 5 Invariant: preserve exact payload steps when present; default to 14 for Medium or 28 otherwise only when absent
            const resolvedSteps = (parsedSteps !== null && parsedSteps > 0)
                ? parsedSteps
                : (isV5Medium ? 14 : 28);

            return {
                width: (parsedWidth !== null && parsedWidth > 0) ? parsedWidth : 1024,
                height: (parsedHeight !== null && parsedHeight > 0) ? parsedHeight : 1024,
                steps: resolvedSteps,
                has_explicit_steps: parsedSteps !== null && parsedSteps > 0,
                n_samples: (parsedSamples !== null && parsedSamples > 0) ? parsedSamples : 1,
                precise_refs: preciseRefs,
                model: rawModel,
                sm: rawSm === true || rawSm === 'true' || rawSm === 1,
                sm_dyn: rawSmDyn === true || rawSmDyn === 'true' || rawSmDyn === 1,
                strength: parsedStrength !== null ? Math.max(0.0, Math.min(1.0, parsedStrength)) : null,
                inpaintImg2ImgStrength: parsedInpaintStrength !== null ? Math.max(0.0, Math.min(1.0, parsedInpaintStrength)) : null,
                has_image: hasImage,
                has_mask: hasMask,
                uncached_vibe_count: parsedUncached > 0 ? parsedUncached : 0,
                vibe_reference_count: parsedVibeRefs > 0 ? parsedVibeRefs : 0
            };
        }
    } catch (e) {
        console.error("[GuildWeave Security] Payload extraction constraint failure:", e);
    }
    return null;
}