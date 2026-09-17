/**
 * PARAMETRIC FIREWALL ANALYZER & ANLAS ACCOUNTING (src/userscripts/shared/params.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Pure Browser Type Discrimination: Validates FormData, strings, Blobs, Uint8Arrays, and ArrayBuffers.
 *    Strictly devoid of Node.js host dependencies (zero Buffer references).
 * 2. Character Reference Demuxing: Aggregates reference images across legacy and modern schemas
 *    (`director_reference_images_cached`, `director_reference_images`, `reference_image_multiple`)
 *    to track 5 Anlas/ref costs accurately.
 * 3. Graceful Failure: Corrupted, non-UTF8, or truncated JSON streams return `null` without uncaught exceptions,
 *    but errors are explicitly logged. You do not swallow failures.
 */

'use strict';

/**
 * Safely extracts generation parameters and character reference counts from outgoing request payloads.
 *
 * @param {FormData|string|Uint8Array|ArrayBuffer|Blob|object|null} body - Raw outgoing payload.
 * @returns {Promise<{width: number, height: number, steps: number, n_samples: number, precise_refs: number, model: string}|null>}
 */
export async function extractImageParams(body) {
    if (!body) return null;
    try {
        let payload = null;

        // Extract JSON structure from multipart FormData if encapsulated in a Blob
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
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

        if (payload && typeof payload === 'object') {
            const params = (payload.parameters && typeof payload.parameters === 'object')
                ? payload.parameters
                : payload;
            
            const preciseRefs = 
                (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) +
                (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0) +
                (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0);

            return {
                width: parseInt(params.width || payload.width, 10) || 1024,
                height: parseInt(params.height || payload.height, 10) || 1024,
                steps: parseInt(params.steps || payload.steps, 10) || 28,
                n_samples: parseInt(params.n_samples || payload.n_samples, 10) || 1,
                precise_refs: preciseRefs,
                model: payload.model || params.model || ""
            };
        }
    } catch (e) {
        console.error("[Nai-Gateway Security] Payload extraction constraint failure:", e);
    }
    return null;
}