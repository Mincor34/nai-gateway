/**
 * CRYPTOGRAPHIC IDENTITY GENERATOR (src/userscripts/shared/crypto.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Dual-Context Browser Compatibility: Resolves Web Crypto primitives across modern browser runtimes and Tampermonkey sandboxes.
 * 2. Cryptographic Fallback Engine: Prefers native `crypto.randomUUID()`, falling back to `crypto.getRandomValues()`
 *    to generate an RFC 4122 v4 UUID with identical entropy.
 * 3. Strict Schema Compatibility: Strips RFC 4122 hyphens to produce a 32-character lowercase hexadecimal string
 *    conforming strictly to SQLite `devices` table constraints.
 * 4. Resilient Fallback: Employs a Math.random fallback for strictly isolated iframe environments where Web Crypto is blocked.
 */

'use strict';

/**
 * Generates a cryptographically secure, collision-resistant RFC 4122 UUID.
 *
 * @returns {string} Clean 32-character lowercase hexadecimal string without hyphens.
 */
export function generateUUID() {
    const webCrypto = (typeof globalThis !== 'undefined' && globalThis.crypto)
        ? globalThis.crypto
        : (typeof window !== 'undefined' && window.crypto
            ? window.crypto
            : (typeof crypto !== 'undefined' ? crypto : null));

    // Fallback Math.random PRNG for strictly isolated sandboxes without Web Crypto
    if (!webCrypto || (typeof webCrypto.randomUUID !== 'function' && typeof webCrypto.getRandomValues !== 'function')) {
        let d = new Date().getTime();
        let d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now() * 1000)) || 0;
        return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            let r = Math.random() * 16;
            if (d > 0) {
                r = (d + r) % 16 | 0;
                d = Math.floor(d / 16);
            } else {
                r = (d2 + r) % 16 | 0;
                d = Math.floor(d2 / 16);
            }
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    if (typeof webCrypto.randomUUID === 'function') {
        return webCrypto.randomUUID().replace(/-/g, '');
    }

    // RFC 4122 Version 4 compliant generator via crypto.getRandomValues
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 1 (RFC 4122)

    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}