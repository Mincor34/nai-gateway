/**
 * PRIVILEGED NETWORK TRANSPORT & STREAM PARSING ENGINE (src/userscripts/shared/network.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. CSP Sandbox Breakout: Outbound requests targeting the external VPS gateway must execute
 *    via Tampermonkey's privileged `GM_xmlhttpRequest` context. Native page `window.fetch()` 
 *    is blocked by NovelAI's production `Content-Security-Policy` (`connect-src`) headers.
 * 2. Transparent Version Reporting: Dynamically injects `x-script-version` from extension
 *    manifest metadata into outbound headers, allowing the gateway to enforce version gating (HTTP 426).
 * 3. Robust Stream Demuxing: Implements streaming decoders and HTTP header token extractors
 *    resilient against malformed status lines, chunked framing, and browser-masked zero statuses.
 * 4. Absolute Operational Telemetry: Never swallow network request lifecycles.
 */

'use strict';

/**
 * Executes a network call within Tampermonkey's privileged background context.
 * Bypasses page-level CORS boundaries and Content-Security-Policy connect-src directives.
 *
 * @param {object} details - GM_xmlhttpRequest configuration dictionary.
 * @returns {Promise<object>} Resolves with the raw response context.
 */
export function backgroundRequest(details) {
    const headers = details.headers || {};
    // Dynamically inject script version metadata from Tampermonkey manifest to enforce version validation on VPS
    headers["x-script-version"] = GM_info.script.version;

    console.log(`[Nai-Gateway Network] Dispatching request to ${details.url}...`);

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            ...details,
            headers,
            onload: (r) => {
                console.log(`[Nai-Gateway Network] Received response status ${r.status} from ${details.url}`);
                resolve(r);
            },
            onerror: (e) => {
                console.error(`[Nai-Gateway Network] Request error to ${details.url}`, e);
                reject(e);
            }
        });
    });
}

/**
 * Parses raw HTTP response header strings into a standard fetch-compliant Headers instance.
 * Validates header names against RFC 7230 token specifications to prevent prototype pollution.
 *
 * @param {string|null} headerStr - Raw CRLF-delimited header response string.
 * @returns {Headers} Normalized standard Headers collection.
 */
export function parseResponseHeaders(headerStr) {
    const headers = new Headers();
    if (!headerStr) return headers;

    const lines = headerStr.split(/[\r\n]+/);
    lines.forEach(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        const colonIndex = trimmedLine.indexOf(':');
        if (colonIndex === -1) return; // Skip status lines (HTTP/1.1 200 OK)

        const name = trimmedLine.slice(0, colonIndex).trim();
        const value = trimmedLine.slice(colonIndex + 1).trim();

        if (name) {
            // Validate token format against RFC 7230 to prevent corrupt header injections
            if (/^[a-zA-Z0-9!#$%&'*+-.^_`|~]+$/.test(name)) {
                try {
                    headers.append(name, value);
                } catch (e) {
                    console.error(`[Nai-Gateway Network] Failed to append header "${name}":`, e);
                }
            } else {
                console.warn(`[Nai-Gateway Network] Dropping invalid header token: "${name}"`);
            }
        }
    });
    return headers;
}

/**
 * Normalizes HTTP status codes across asynchronous extension events.
 * In modern Chromium and Tampermonkey stream implementations, `responseDetails.status`
 * is frequently masked as `0` during early lifecycle hooks (`onloadstart`).
 * This extractor parses the raw HTTP status line directly from headers when masked.
 *
 * @param {object} responseDetails - Tampermonkey response payload.
 * @returns {number} Extracted HTTP status code, or 0 if headers have not yet arrived.
 */
export function extractStatusCode(responseDetails) {
    if (responseDetails.status && responseDetails.status !== 0) {
        return responseDetails.status;
    }
    if (responseDetails.responseHeaders) {
        // Regex extracts status code from raw header line: "HTTP/1.1 200 OK"
        const match = responseDetails.responseHeaders.match(/^HTTP\/[0-9.]+\s+(\d+)/i);
        if (match) {
            return parseInt(match[1], 10);
        }
    }
    return 0; // Status not yet resolved; defer execution
}

/**
 * Asynchronously exhausts a ReadableStream and decodes it into a UTF-8 string.
 * Used to extract structured error payloads returned from the gateway on upstream rejections.
 *
 * @param {ReadableStream} stream - Target browser stream instance.
 * @returns {Promise<string>} Accumulated UTF-8 text payload.
 */
export async function readStreamAsString(stream) {
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode(); // Flush trailing multi-byte sequence buffer
    return result;
}