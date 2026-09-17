/**
 * AUTHORITATIVE FETCH INTERCEPTOR & STREAM PROXY PIPELINE (src/userscripts/shared/interceptor.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Execution Sandbox Breakout: Overrides `unsafeWindow.fetch` at `document-start` with a fallback
 *    to `window.fetch` to ensure portability across browser sandbox configurations.
 * 2. Split-Token Local Spoofing: Intercepts `/user/data` and `/ai/trial-status`. Preserves the user's
 *    native keystore (E2EE keys) and account preferences while injecting an artificial Opus tier (tier 3)
 *    and 19,998 Anlas. This unlocks generation controls and eliminates client-side trial lockouts.
 * 3. WAF Request Smuggling Shield: Outbound proxy calls delete `Content-Length`, `Content-Type`
 *    (for FormData), and `Host` headers. This allows the browser background transport to append correct
 *    boundary metrics natively during transmission, preventing Cloudflare HTTP Request Smuggling drops.
 * 4. Dual-Timing Stream Coordination: Bypasses Tampermonkey stream exhaustion bugs by resolving
 *    piped `Response` instances inside `onloadstart` as soon as HTTP 200 headers arrive, streaming
 *    binary msgpack blocks directly to the React UI without memory buffering.
 * 5. Strict Lock Teardown: Aborted status queries transmit authoritative hardware footprints and
 *    authorization context to `/queue/complete`, preventing 75-second server-side ghost lock delays.
 * 6. Role-Agnostic Abstraction: Implements environment callbacks for 401 revocation handlers to prevent
 *    polluting shared layers with arbitrary role conditions.
 */

'use strict';

import { generateUUID } from './crypto.js';
import { extractImageParams } from './params.js';
import { backgroundRequest, parseResponseHeaders, extractStatusCode, readStreamAsString } from './network.js';
import { showQueueStatusBanner, hideQueueStatusBanner } from './ui.js';

let envConfig = {
    browserId: '',
    deviceSecret: '',
    VPS_HOST: '',
    logPrefix: 'Nai-Gateway',
    onRevoked: () => {}
};

/**
 * Initializes the unified fetch hijacking layer with runtime identity parameters.
 *
 * @param {object} config - Runtime context options.
 * @param {string} config.browserId - Hardware footprint UUID.
 * @param {string} config.deviceSecret - Secret authentication passkey.
 * @param {string} config.VPS_HOST - Target gateway base URL.
 * @param {string} [config.logPrefix='Nai-Gateway'] - Diagnostic logging prefix string.
 * @param {Function} [config.onRevoked] - Callback to execute upon HTTP 401 unauthorization signatures.
 */
export function initInterceptor(config) {
    envConfig = { ...envConfig, ...config };
    hijackFetch();
}

/**
 * Resolves or rejects an outgoing Tampermonkey GM_xmlhttpRequest stream back to a standard native fetch Response.
 * Resolves on `onloadstart` for HTTP 200 to enable direct live streaming to the page context.
 * Defers error evaluation to `readyState 4` to ensure error payload buffers are fully received.
 *
 * @param {object} responseDetails - Raw Tampermonkey response context.
 * @param {Function} resolveObj - Native fetch Promise resolver.
 * @param {boolean} isImageGen - Channel A image task flag.
 * @param {boolean} isTextGen - Channel B text task flag.
 * @returns {Promise<boolean>} True if stream resolution was completed.
 */
async function tryResolveProxyResponse(responseDetails, resolveObj, isImageGen, isTextGen) {
    const status = extractStatusCode(responseDetails);
    if (status === 0) {
        return false; // Status code not yet populated; defer resolution
    }

    if (status === 200) {
        if (!responseDetails.response) {
            console.error("[VPS Gateway] Telemetry: Success code detected, but readable response stream was empty.");
            return false; // Wait for response body context to bind
        }
        console.log("[VPS Gateway] Telemetry: Stream successfully acquired. Piping stream response directly to fetch promise.");
        
        // Increment telemetry variables on validation success
        if (isImageGen) {
            GM_setValue("count_image_gens", GM_getValue("count_image_gens", 0) + 1);
        } else if (isTextGen) {
            GM_setValue("count_text_gens", GM_getValue("count_text_gens", 0) + 1);
        }

        // Resolve immediately on stream header initiation to preserve live piping features.
        resolveObj(new Response(responseDetails.response, {
            status: status,
            headers: parseResponseHeaders(responseDetails.responseHeaders)
        }));
        return true;
    } else {
        // For error responses, defer resolution until the request has fully completed (readyState 4)
        // so we can read the fully buffered error body.
        if (responseDetails.readyState !== 4 && responseDetails.readyState !== undefined) {
            return false;
        }

        console.error("[VPS Gateway] Telemetry: Proxy returned exception status code:", status);

        // Self-Healing Hook for Admin/Guest
        if (status === 401) {
            console.warn("[VPS Gateway] Revocation signature caught. Restoring setup lock.");
            GM_setValue("approved", false);
            if (typeof envConfig.onRevoked === 'function') {
                envConfig.onRevoked();
            }
            return true;
        }

        let errorText = "";
        try {
            if (responseDetails.response) {
                if (typeof responseDetails.response.getReader === 'function') {
                    errorText = await readStreamAsString(responseDetails.response);
                } else if (typeof responseDetails.response === 'string') {
                    errorText = responseDetails.response;
                }
            }
            // Fallback to text representation if stream parsing yielded nothing
            if (!errorText && responseDetails.responseText) {
                errorText = responseDetails.responseText;
            }
        } catch (e) {
            console.error("[VPS Gateway] Error: Failed to extract string from raw exception stream:", e);
        }

        console.log(`[VPS Gateway] Telemetry: Received raw error text: "${errorText}"`);

        // Standardize raw anomalies into correct structured exception parameters for SPA parsing
        let parsedError = null;
        try {
            if (errorText) parsedError = JSON.parse(errorText);
        } catch (e) {}

        const responseBody = parsedError && (parsedError.statusCode || parsedError.message || parsedError.error)
            ? JSON.stringify({
                statusCode: parsedError.statusCode || status,
                message: parsedError.message || parsedError.error || errorText || "Gateway processing error"
              })
            : JSON.stringify({
                statusCode: status,
                message: errorText || "Gateway processing error"
              });

        resolveObj(new Response(responseBody, {
            status: status,
            headers: parseResponseHeaders(responseDetails.responseHeaders)
        }));
        return true;
    }
}

/**
 * Handles Channel A image generation lifecycle.
 * Manages FIFO queue registration, transient status polling, and stream proxy forwarding.
 *
 * @param {string} url - Target upstream destination URL.
 * @param {object} config - Native fetch request parameters.
 * @returns {Promise<Response>} Wrapped fetch response delivering stream bytes.
 */
async function handleGenerationIntercept(url, config) {
    const req_id = 'req_' + generateUUID();
    const tab_id = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem("vps_tab_id")) || (() => {
        const tid = 't_' + generateUUID();
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem("vps_tab_id", tid);
        }
        return tid;
    })();

    const originalBody = config.body;
    let imgParams = { width: 1024, height: 1024, steps: 28, n_samples: 1, precise_refs: 0, model: "" };

    const extracted = await extractImageParams(originalBody);
    if (extracted) imgParams = extracted;

    const executeQueueJoin = async () => {
        try {
            const joinRes = await backgroundRequest({
                method: "POST",
                url: `${envConfig.VPS_HOST}/queue/join`,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${envConfig.deviceSecret}`
                },
                data: JSON.stringify({ browser_id: envConfig.browserId, tab_id, req_id })
            });

            if (joinRes.status === 401) {
                console.warn(`[${envConfig.logPrefix}] Server returned 401 on queue join. Restoring setup lock.`);
                GM_setValue("approved", false);
                if (typeof envConfig.onRevoked === 'function') {
                    envConfig.onRevoked();
                }
                return new Response(JSON.stringify({ statusCode: 401, message: "Device revoked." }), { status: 401 });
            }

            if (joinRes.status === 403) {
                let errorDetails = {};
                try {
                    errorDetails = JSON.parse(joinRes.responseText);
                } catch (e) {
                    console.error(`[${envConfig.logPrefix}]: Failed to parse error response text safely`, e);
                }

                if (errorDetails.error === 'ALLOWANCE_EXHAUSTED') {
                    hideQueueStatusBanner();
                    return new Response(JSON.stringify({
                        statusCode: 403,
                        message: "Allowance Exhausted: You have run out of image tokens. Allowance refills at a rate of 1 image per 30 minutes (max 100)."
                    }), { status: 403 });
                }
            }

            if (joinRes.status !== 200) throw new Error("Join rejection");
        } catch (e) {
            return new Response(JSON.stringify({ statusCode: 502, message: "Queue allocation failure" }), { status: 502 });
        }

        let turnAcquired = false;
        showQueueStatusBanner("Acquiring channel slot...");

        while (!turnAcquired) {
            // Reduced to 1000ms to reduce dead-time gaps between generations
            await new Promise(r => setTimeout(r, 1000));
            try {
                const statusRes = await backgroundRequest({
                    method: "GET",
                    url: `${envConfig.VPS_HOST}/queue/status?req_id=${req_id}&browser_id=${envConfig.browserId}`,
                    headers: { "Authorization": `Bearer ${envConfig.deviceSecret}` }
                });
                if (statusRes.status === 200) {
                    const sData = JSON.parse(statusRes.responseText);
                    if (sData.status === 'your_turn') {
                        turnAcquired = true;
                        hideQueueStatusBanner();
                    } else if (sData.status === 'waiting') {
                        showQueueStatusBanner(`Queue Position: ${sData.position}`);
                    }
                } else {
                    throw new Error("Expired state");
                }
            } catch (e) {
                hideQueueStatusBanner();
                // Send fully-formed authorization and hardware context to prevent ghost locks on the VPS
                backgroundRequest({
                    method: "POST",
                    url: `${envConfig.VPS_HOST}/queue/complete`,
                    headers: { 
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${envConfig.deviceSecret}`
                    },
                    data: JSON.stringify({ req_id, browser_id: envConfig.browserId })
                });
                return new Response(JSON.stringify({ statusCode: 502, message: "Queue processing aborted" }), { status: 502 });
            }
        }

        const originalUrlObj = new URL(url);
        // Extract subdomain dynamically (e.g., 'image' or 'text' or 'api') to support flexible routing across multiple NovelAI subdomains.
        const subdomain = originalUrlObj.hostname.split('.')[0];
        const proxyUrl = `${envConfig.VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;

        const updatedHeaders = new Map();
        if (config.headers) {
            if (config.headers instanceof Headers) {
                for (let [k, v] of config.headers.entries()) {
                    updatedHeaders.set(k.toLowerCase(), v);
                }
            } else {
                Object.keys(config.headers).forEach(k => {
                    updatedHeaders.set(k.toLowerCase(), config.headers[k]);
                });
            }
        }

        // v5 Safeguard: Explicitly mark v5 generations to prevent legacy false-positive bans on VPS
        const isV5 = typeof imgParams.model === 'string' && /[-_]5[-_]/i.test(imgParams.model) && !imgParams.model.includes('4-5');

        updatedHeaders.set("x-browser-id", envConfig.browserId);
        updatedHeaders.set("x-request-id", req_id);
        updatedHeaders.set("x-gen-width", imgParams.width.toString());
        updatedHeaders.set("x-gen-height", imgParams.height.toString());
        updatedHeaders.set("x-gen-steps", imgParams.steps.toString());
        updatedHeaders.set("x-gen-samples", imgParams.n_samples.toString());
        updatedHeaders.set("x-precise-refs", imgParams.precise_refs.toString());
        
        // Enforce explicit model headers for all generations to prevent legacy false-positive bans
        if (isV5) {
            updatedHeaders.set("x-gen-model", "V5");
        } else {
            updatedHeaders.set("x-gen-model", "legacy");
        }

        updatedHeaders.set("authorization", `Bearer ${envConfig.deviceSecret}`);
        updatedHeaders.set("x-script-version", GM_info.script.version); // Dyn Version Injection
        if (GM_getValue("debug_mode", false)) {
            updatedHeaders.set("x-debug-mode", "true");
            console.log(`[VPS Debug Mode] Outbound image generation details:`, originalBody);
        }

        updatedHeaders.delete("host");
        updatedHeaders.delete("content-length"); // Prevent dynamic framing corruption upstream

        if (typeof FormData !== 'undefined' && originalBody instanceof FormData) {
            updatedHeaders.delete("content-type");
        }

        let hasResolved = false;
        console.log(`[${envConfig.logPrefix}] Intercepting fetch targeting VPS rewrite URL: ${proxyUrl}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: config.method || "POST",
                url: proxyUrl,
                headers: Object.fromEntries(updatedHeaders.entries()),
                data: originalBody,
                responseType: "stream",
                onloadstart: async function(responseDetails) {
                    console.log(`[${envConfig.logPrefix}] Telemetry: onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Resolve immediately on stream header initiation to preserve live piping features.
                    if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                        hasResolved = true;
                    }
                },
                onreadystatechange: async function(responseDetails) {
                    console.log(`[${envConfig.logPrefix}] Telemetry: onreadystatechange fired. ReadyState: ${responseDetails.readyState}, ExtractedStatus: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Fallback evaluation for legacy engines
                    if (responseDetails.readyState >= 2) {
                        if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                            hasResolved = true;
                        }
                    }
                },
                onload: async function(responseDetails) {
                    console.log(`[${envConfig.logPrefix}] Telemetry: onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                        hasResolved = true;
                    }
                },
                onerror: (err) => {
                    console.error(`[${envConfig.logPrefix}] Telemetry: Fatal network transport crash during GM_xmlhttpRequest transmission.`, err);

                    backgroundRequest({
                        method: "POST",
                        url: `${envConfig.VPS_HOST}/queue/complete`,
                        headers: { 
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${envConfig.deviceSecret}`
                        },
                        data: JSON.stringify({ req_id, browser_id: envConfig.browserId })
                    });

                    if (!hasResolved) {
                        hasResolved = true;
                        reject(err);
                    }
                }
            });
        });
    };

    // Leverage outer scoping references to handle clean recursion parameters
    let resolveOuter, rejectOuter;
    const outerPromise = new Promise((res, rej) => {
        resolveOuter = res;
        rejectOuter = rej;
    });

    executeQueueJoin().then(resolveOuter, rejectOuter);
    return outerPromise;
}

/**
 * Handles Channel B fast-track streaming text generation and vibe transfer requests.
 * Routes directly to the parallel shared lock queue without acquiring Channel A exclusive locks.
 *
 * @param {string} url - Target endpoint URL.
 * @param {object} config - Native fetch options.
 * @returns {Promise<Response>} Wrapped fetch response delivering stream bytes.
 */
async function handleTextGenerationIntercept(url, config) {
    const originalUrlObj = new URL(url);
    // Extract subdomain dynamically (e.g., 'image' or 'text' or 'api') to support flexible routing across multiple NovelAI subdomains.
    const subdomain = originalUrlObj.hostname.split('.')[0];
    const proxyUrl = `${envConfig.VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;
    const updatedHeaders = new Map();

    if (config.headers) {
        if (config.headers instanceof Headers) {
            for (let [k, v] of config.headers.entries()) {
                updatedHeaders.set(k.toLowerCase(), v);
            }
        } else {
            Object.keys(config.headers).forEach(k => {
                updatedHeaders.set(k.toLowerCase(), config.headers[k]);
            });
        }
    }

    updatedHeaders.set("x-browser-id", envConfig.browserId);
    updatedHeaders.set("authorization", `Bearer ${envConfig.deviceSecret}`);
    updatedHeaders.set("x-script-version", GM_info.script.version); // Dyn Version Injection
    if (GM_getValue("debug_mode", false)) {
        updatedHeaders.set("x-debug-mode", "true");
        console.log(`[VPS Debug Mode] Outbound text prompt payload:`, config.body);
    }

    updatedHeaders.delete("host");
    updatedHeaders.delete("content-length"); // Prevent stream desynchronization

    if (typeof FormData !== 'undefined' && config.body instanceof FormData) {
        updatedHeaders.delete("content-type");
    }

    let hasResolved = false;

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: config.method || "POST",
            url: proxyUrl,
            headers: Object.fromEntries(updatedHeaders.entries()),
            data: config.body,
            responseType: "stream",
            onloadstart: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                    hasResolved = true;
                }
            },
            onreadystatechange: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onreadystatechange fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (responseDetails.readyState >= 2) {
                    if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                        hasResolved = true;
                    }
                }
            },
            onload: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                    hasResolved = true;
                }
            },
            onerror: (err) => {
                console.error(`[${envConfig.logPrefix}] Telemetry (Text): Fatal network transport crash during GM_xmlhttpRequest transmission.`, err);
                if (!hasResolved) {
                    hasResolved = true;
                    reject(err);
                }
            }
        });
    });
}

/**
 * Captures and hooks page-level fetch pipelines.
 */
function hijackFetch() {
    const targetWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow)
        ? unsafeWindow
        : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));

    if (!targetWindow || typeof targetWindow.fetch !== 'function') {
        console.error("[Nai-Gateway] Fatal: Target window fetch interface is unavailable.");
        return;
    }

    const originalFetch = targetWindow.fetch;
    targetWindow.fetch = async function(...args) {
        const url = args[0];
        const config = args[1] || {};
        const urlString = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');

        if (urlString) {
            // Spoof personal metadata retrieval endpoints to display Opus eligibility status
            if (urlString.includes('/user/data')) {
                const response = await originalFetch(...args);
                if (response && response.ok) {
                    const cloned = response.clone();
                    try {
                        const data = await cloned.json();
                        data.subscription = {
                            tier: 3,
                            active: true,
                            paymentProcessor: null,
                            expiresAt: 2524608000,
                            perks: {
                                maxPriorityActions: 0,
                                startPriority: 0,
                                contextTokens: 8192,
                                unlimitedMaxPriority: true,
                                moduleTrainingSteps: 0
                            },
                            paymentProcessorData: null,
                            trainingStepsLeft: {
                                fixedTrainingStepsLeft: 9999,
                                purchasedTrainingSteps: 9999
                            },
                            accountType: 0,
                            isGracePeriod: false,
                            isPaypal: false
                        };
                        return new Response(JSON.stringify(data), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch (e) {
                        return response;
                    }
                }
                return response;
            }

            // Spoof Trial limitations to prevent local UI blockades
            if (urlString.includes('/ai/trial-status')) {
                const mockTrial = {
                    "used_text_actions": 0,
                    "remaining_text_actions": 50,
                    "used_image_actions": 0,
                    "remaining_image_actions": 50,
                    "eligible_for_text_gens": false,
                    "eligible_for_image_gens": false,
                    "trial_activated": true
                };
                return new Response(JSON.stringify(mockTrial), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Intercept subscription telemetry to return the master account's real metrics natively
            if (urlString.includes('/user/subscription')) {
                return handleTextGenerationIntercept(urlString, config);
            }

            // Generation Interceptions (Explicitly bypass tag suggestions autocomplete to keep autocomplete functional)
            if (urlString.includes('/ai/generate-image') && !urlString.includes('/suggest-tags')) {
                return handleGenerationIntercept(urlString, config);
            }

            // Route both legacy and new OpenAI-compatible text generation endpoints through secure fast-track text queue
            if (urlString.includes('/ai/generate-stream') || urlString.includes('/oa/v1/completions')) {
                return handleTextGenerationIntercept(urlString, config);
            }

            // Intercept vibe transfer pre-processing requests to swap with master token instantly
            if (urlString.includes('/ai/encode-vibe')) {
                return handleTextGenerationIntercept(urlString, config);
            }
        }

        return originalFetch(...args);
    };
}