/**
 * AUTHORITATIVE FETCH INTERCEPTOR & STREAM PROXY PIPELINE (src/userscripts/shared/interceptor.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Execution Sandbox Breakout: Overrides `unsafeWindow.fetch` at `document-start` with a fallback
 *    to `window.fetch` to ensure portability across browser sandbox configurations.
 * 2. Split-Token Local Spoofing: Intercepts `/user/data` and `/ai/trial-status`. Preserves the user's
 *    native keystore (E2EE keys) and account preferences while injecting Opus tier (tier 3) and
 *    live virtual `availableAnlas` (falling back to 9999/9999 prior to first telemetry sync).
 * 3. Pre-Flight Policy & Pricing Parity: Computes local Anlas costs (`pricing.js`, implementing
 *    Module 643656 V5 1.5x, Medium un-ceiled `/ 1.75` at 23 reference steps, `usageNegative`
 *    guards, and `/ai/upscale` 1..4 Anlas pixel buckets), blocks V5 High 24-28 deadband steps
 *    client-side, enforces Anlas toggle and negative-debt lockouts, scrapes UI cost into
 *    `X-Scraped-Anlas` with canary drift alerts, and sends complete Commit 6 `/queue/join` +
 *    Commit 8 Stage 5 `/proxy/image/*` headers.
 * 4. Channel A Upscale Pipeline: Routes `/ai/upscale` through Channel A single-concurrency locking
 *    to match NovelAI's GPU lock, extracting binary image dimensions directly from `FormData`
 *    without relying on missing JSON width/height fields or trusting client headers.
 * 5. Stage 5 Header Parity Invariant: Never alters outbound generation `body`; forwards exact `steps`
 *    from the request body in `X-Gen-Steps` (defaulting to 14 for Medium or 28 otherwise only when
 *    absent) and transmits `X-Gen-Model` as `V5-medium`, `V5`, or `legacy`.
 * 6. Method & Counter Isolation: Preserves `GET` semantics on `/user/subscription` when `config.method`
 *    is omitted, increments `count_text_gens` strictly on actual text generations, and triggers HUD
 *    telemetry refreshes on Anlas-consuming `/ai/encode-vibe`, `/ai/upscale`, and image generations.
 * 7. WAF Request Smuggling Shield: Deletes `Content-Length`, `Content-Type` (for FormData), and `Host`.
 * 8. Dual-Timing Stream Coordination & Strict Lock Teardown: Resolves on `onloadstart` for HTTP 200
 *    streams, propagates structured server error messages (`400`, `403`, `429`, `503`), surfaces HUD
 *    alerts + refreshes telemetry on proxy rejections, and triggers `/queue/complete` on client aborts.
 */

'use strict';

import { generateUUID } from './crypto.js';
import { extractImageParams } from './params.js';
import {
  isV5ModelFamily,
  isV5MediumModel,
  evaluateGenerationPolicy,
  extractUpscaleBodyParams,
  evaluateUpscalePolicy
} from './pricing.js';
import { backgroundRequest, parseResponseHeaders, extractStatusCode, readStreamAsString } from './network.js';
import {
  showQueueStatusBanner,
  hideQueueStatusBanner,
  scrapeDisplayedAnlasCost,
  getClientPolicyState,
  setClientPolicyState,
  refreshDualLedgerHud,
  setHudAlert
} from './ui.js';

let envConfig = {
    browserId: '',
    deviceSecret: '',
    VPS_HOST: '',
    logPrefix: 'GuildWeave',
    onRevoked: () => {},
    onTelemetryRefresh: () => {}
};

/**
 * Initializes the unified fetch hijacking layer with runtime identity parameters.
 *
 * @param {object} config - Runtime context options.
 * @param {string} config.browserId - Hardware footprint UUID.
 * @param {string} config.deviceSecret - Secret authentication passkey.
 * @param {string} config.VPS_HOST - Target gateway base URL.
 * @param {string} [config.logPrefix='GuildWeave'] - Diagnostic logging prefix string.
 * @param {Function} [config.onRevoked] - Callback invoked upon HTTP 401 unauthorization signatures.
 * @param {Function} [config.onTelemetryRefresh] - Callback invoked post-settlement to refresh HUD telemetry.
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
 * @param {boolean} [countAsTextGen=false] - Whether to increment local `count_text_gens` counter.
 * @param {boolean} [refreshTelemetry=isImageGen] - Whether to refresh HUD telemetry on 200 OK.
 * @returns {Promise<boolean>} True if stream resolution was completed.
 */
async function tryResolveProxyResponse(responseDetails, resolveObj, isImageGen, countAsTextGen = false, refreshTelemetry = isImageGen) {
    const status = extractStatusCode(responseDetails);
    if (status === 0) {
        return false; // Status code not yet populated; defer resolution
    }

    if (status === 200) {
        if (!responseDetails.response) {
            console.error("[GuildWeave] Telemetry: Success code detected, but readable response stream was empty.");
            return false;
        }
        console.log("[GuildWeave] Telemetry: Stream successfully acquired. Piping stream response directly to fetch promise.");
        
        if (isImageGen) {
            GM_setValue("count_image_gens", GM_getValue("count_image_gens", 0) + 1);
        } else if (countAsTextGen) {
            GM_setValue("count_text_gens", GM_getValue("count_text_gens", 0) + 1);
        }

        if ((isImageGen || refreshTelemetry) && typeof envConfig.onTelemetryRefresh === 'function') {
            setTimeout(() => {
                try { envConfig.onTelemetryRefresh(); } catch (_) {}
            }, 0);
        }

        resolveObj(new Response(responseDetails.response, {
            status: status,
            headers: parseResponseHeaders(responseDetails.responseHeaders)
        }));
        return true;
    } else {
        if (responseDetails.readyState !== 4 && responseDetails.readyState !== undefined) {
            return false;
        }

        console.error("[GuildWeave] Telemetry: Proxy returned exception status code:", status);

        if (status === 401) {
            console.warn("[GuildWeave] Revocation signature caught. Restoring setup lock.");
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
            if (!errorText && responseDetails.responseText) {
                errorText = responseDetails.responseText;
            }
        } catch (e) {
            console.error("[GuildWeave] Error: Failed to extract string from raw exception stream:", e);
        }

        console.log(`[GuildWeave] Telemetry: Received raw error text: "${errorText}"`);

        let parsedError = null;
        try {
            if (errorText) parsedError = JSON.parse(errorText);
        } catch (e) {}

        if (parsedError && parsedError.error === 'DEBT_LOCKED') {
            GM_setValue("anlas_bypass_enabled", false);
            setClientPolicyState({ isInDebt: true, bypassEnabled: false });
            refreshDualLedgerHud();
            setHudAlert(parsedError.message || 'Anlas overdrawn. Paid features paused until balance is restored.', 'error');
        } else if (parsedError && (parsedError.message || parsedError.error) && (status === 400 || status === 403 || status === 429 || status === 503)) {
            setHudAlert(parsedError.message || parsedError.error, (status === 403 || status === 503) ? 'error' : 'warning');
        }

        if (typeof envConfig.onTelemetryRefresh === 'function' && (status === 403 || status === 429 || status === 503)) {
            setTimeout(() => {
                try { envConfig.onTelemetryRefresh(); } catch (_) {}
            }, 0);
        }

        const responseBody = parsedError && (parsedError.statusCode || parsedError.message || parsedError.error)
            ? JSON.stringify({
                statusCode: parsedError.statusCode || status,
                error: parsedError.error,
                message: parsedError.message || parsedError.error || errorText || "GuildWeave processing error"
              })
            : JSON.stringify({
                statusCode: status,
                message: errorText || "GuildWeave processing error"
              });

        resolveObj(new Response(responseBody, {
            status: status,
            headers: parseResponseHeaders(responseDetails.responseHeaders)
        }));
        return true;
    }
}

/**
 * Shared Channel A queue-join + polling + GM_xmlhttpRequest dispatch helper
 * used by both image generation and image upscaling.
 *
 * @param {object} opts - Dispatch options.
 * @returns {Promise<Response>} Wrapped fetch response.
 */
async function dispatchThroughChannelA({
  url,
  config,
  req_id,
  joinPayload,
  proxyHeaders,
  isImageGen,
  refreshTelemetry
}) {
    try {
        const joinRes = await backgroundRequest({
            method: "POST",
            url: `${envConfig.VPS_HOST}/queue/join`,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${envConfig.deviceSecret}`
            },
            data: JSON.stringify(joinPayload)
        });

        if (joinRes.status === 401) {
            console.warn(`[${envConfig.logPrefix}] Server returned 401 on queue join. Restoring setup lock.`);
            GM_setValue("approved", false);
            if (typeof envConfig.onRevoked === 'function') {
                envConfig.onRevoked();
            }
            return new Response(JSON.stringify({ statusCode: 401, message: "Device revoked." }), { status: 401 });
        }

        if (joinRes.status !== 200) {
            let errorDetails = {};
            try {
                errorDetails = JSON.parse(joinRes.responseText || '{}');
            } catch (e) {
                console.error(`[${envConfig.logPrefix}]: Failed to parse error response text safely`, e);
            }

            hideQueueStatusBanner();

            if (errorDetails.error === 'ALLOWANCE_EXHAUSTED') {
                const msg = "Allowance Exhausted: You have run out of image tokens. Allowance refills at a rate of 1 image per 30 minutes (max 100).";
                setHudAlert(msg, 'error');
                return new Response(JSON.stringify({
                    statusCode: 403,
                    error: 'ALLOWANCE_EXHAUSTED',
                    message: msg
                }), { status: 403 });
            }

            if (errorDetails.error === 'DEBT_LOCKED') {
                GM_setValue("anlas_bypass_enabled", false);
                setClientPolicyState({ isInDebt: true, bypassEnabled: false });
                refreshDualLedgerHud();
            }

            if (typeof envConfig.onTelemetryRefresh === 'function' && (joinRes.status === 403 || joinRes.status === 429 || joinRes.status === 503)) {
                setTimeout(() => {
                    try { envConfig.onTelemetryRefresh(); } catch (_) {}
                }, 0);
            }

            if (joinRes.status === 400 || joinRes.status === 403 || joinRes.status === 429 || joinRes.status === 503) {
                const msg = errorDetails.message || errorDetails.error || "Queue admission rejected.";
                setHudAlert(msg, joinRes.status === 403 || joinRes.status === 503 ? 'error' : 'warning');
                return new Response(JSON.stringify({
                    statusCode: joinRes.status,
                    error: errorDetails.error,
                    message: msg
                }), {
                    status: joinRes.status,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            throw new Error("Join rejection");
        }
    } catch (e) {
        return new Response(JSON.stringify({ statusCode: 502, message: "Queue allocation failure" }), { status: 502 });
    }

    let turnAcquired = false;
    showQueueStatusBanner("Acquiring channel slot...");

    while (!turnAcquired) {
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

    for (const [k, v] of Object.entries(proxyHeaders)) {
        if (v !== undefined && v !== null) {
            updatedHeaders.set(k.toLowerCase(), String(v));
        }
    }

    updatedHeaders.set("x-browser-id", envConfig.browserId);
    updatedHeaders.set("x-request-id", req_id);
    updatedHeaders.set("authorization", `Bearer ${envConfig.deviceSecret}`);
    updatedHeaders.set("x-script-version", GM_info.script.version);
    if (GM_getValue("debug_mode", false)) {
        updatedHeaders.set("x-debug-mode", "true");
        console.log(`[GuildWeave Debug Mode] Outbound payload details:`, config.body);
    }

    updatedHeaders.delete("host");
    updatedHeaders.delete("content-length");

    if (typeof FormData !== 'undefined' && config.body instanceof FormData) {
        updatedHeaders.delete("content-type");
    }

    let hasResolved = false;
    console.log(`[${envConfig.logPrefix}] Intercepting fetch targeting GuildWeave rewrite URL: ${proxyUrl}`);

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: config.method || "POST",
            url: proxyUrl,
            headers: Object.fromEntries(updatedHeaders.entries()),
            data: config.body,
            responseType: "stream",
            onloadstart: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry: onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, isImageGen, false, refreshTelemetry)) {
                    hasResolved = true;
                }
            },
            onreadystatechange: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry: onreadystatechange fired. ReadyState: ${responseDetails.readyState}, ExtractedStatus: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (responseDetails.readyState >= 2) {
                    if (await tryResolveProxyResponse(responseDetails, resolve, isImageGen, false, refreshTelemetry)) {
                        hasResolved = true;
                    }
                }
            },
            onload: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry: onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, isImageGen, false, refreshTelemetry)) {
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
}

/**
 * Handles Channel A image generation lifecycle.
 * Evaluates local pricing/policy directly against NovelAI's native payload, scrapes DOM cost canary,
 * executes FIFO queue registration with full Commit 6 metadata, polls status, and forwards via stream
 * proxy with Stage 5/8 headers.
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
    let imgParams = {
        width: 1024,
        height: 1024,
        steps: 28,
        has_explicit_steps: false,
        n_samples: 1,
        precise_refs: 0,
        model: "",
        sm: false,
        sm_dyn: false,
        strength: null,
        inpaintImg2ImgStrength: null,
        has_image: false,
        has_mask: false,
        uncached_vibe_count: 0,
        vibe_reference_count: 0
    };

    const extracted = await extractImageParams(originalBody);
    if (extracted) imgParams = extracted;

    let currentState = getClientPolicyState();
    if (imgParams.model) {
        currentState = setClientPolicyState({ activeModel: imgParams.model });
        refreshDualLedgerHud();
    }

    const policy = evaluateGenerationPolicy(imgParams, currentState);
    const scrapedAnlas = scrapeDisplayedAnlasCost();

    if (scrapedAnlas !== null && scrapedAnlas !== policy.costDetails.total) {
        console.warn(`[GuildWeave Canary] Displayed UI cost (${scrapedAnlas}) differs from local estimate (${policy.costDetails.total}).`);
        setHudAlert('Displayed cost may differ from estimate.', 'warning');
    } else if (policy.ok) {
        setHudAlert('', 'info');
    }

    if (!policy.ok) {
        hideQueueStatusBanner();
        setHudAlert(policy.message, policy.status === 403 ? 'error' : 'warning');
        return new Response(JSON.stringify({
            statusCode: policy.status,
            error: policy.error,
            message: policy.message
        }), {
            status: policy.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const isV5Medium = isV5MediumModel(imgParams.model);
    const isV5 = isV5ModelFamily(imgParams.model);

    const joinPayload = {
        browser_id: envConfig.browserId,
        tab_id,
        req_id,
        ...(imgParams.model ? { model: imgParams.model } : {}),
        steps: imgParams.steps,
        width: imgParams.width,
        height: imgParams.height,
        n_samples: imgParams.n_samples,
        is_base_paid: policy.isBasePaid,
        is_v5: policy.isV5,
        declared_anlas: policy.costDetails.total
    };

    const proxyHeaders = {
        'x-gen-width': imgParams.width.toString(),
        'x-gen-height': imgParams.height.toString(),
        // Stage 5 Invariant: forward exact body steps (14 default for Medium / 28 default otherwise when absent)
        'x-gen-steps': imgParams.steps.toString(),
        'x-gen-samples': imgParams.n_samples.toString(),
        'x-precise-refs': imgParams.precise_refs.toString(),
        'x-gen-model': isV5Medium ? 'V5-medium' : (isV5 ? 'V5' : 'legacy'),
        'x-base-paid': policy.isBasePaid ? 'true' : 'false',
        'x-declared-anlas': policy.costDetails.total.toString(),
        ...(scrapedAnlas !== null ? { 'x-scraped-anlas': scrapedAnlas.toString() } : {})
    };

    return dispatchThroughChannelA({
        url,
        config,
        req_id,
        joinPayload,
        proxyHeaders,
        isImageGen: true,
        refreshTelemetry: true
    });
}

/**
 * Handles Channel A image upscaling (`/ai/upscale`).
 * Reads intrinsic PNG/JPEG/WebP dimensions directly from the binary `FormData` part,
 * enforces client Anlas/debt checks, serializes through Channel A queue to prevent upstream
 * concurrency collisions, and forwards with PoNR Anlas headers.
 *
 * @param {string} url - Target upscale URL.
 * @param {object} config - Native fetch request options.
 * @returns {Promise<Response>} Wrapped fetch response delivering upscaled image stream.
 */
async function handleUpscaleIntercept(url, config) {
    const req_id = 'req_' + generateUUID();
    const tab_id = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem("vps_tab_id")) || (() => {
        const tid = 't_' + generateUUID();
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem("vps_tab_id", tid);
        }
        return tid;
    })();

    const dims = await extractUpscaleBodyParams(config.body);
    const currentState = getClientPolicyState();
    const policy = evaluateUpscalePolicy(dims, currentState);

    if (!policy.ok) {
        hideQueueStatusBanner();
        setHudAlert(policy.message, policy.status === 403 ? 'error' : 'warning');
        return new Response(JSON.stringify({
            statusCode: policy.status,
            error: policy.error,
            message: policy.message
        }), {
            status: policy.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const joinPayload = {
        browser_id: envConfig.browserId,
        tab_id,
        req_id,
        is_upscale: true,
        width: dims.width,
        height: dims.height,
        declared_anlas: policy.cost
    };

    const proxyHeaders = {
        'x-gen-width': dims.width.toString(),
        'x-gen-height': dims.height.toString(),
        'x-declared-anlas': policy.cost.toString()
    };

    return dispatchThroughChannelA({
        url,
        config,
        req_id,
        joinPayload,
        proxyHeaders,
        isImageGen: false,
        refreshTelemetry: true
    });
}

/**
 * Handles Channel B fast-track streaming text generation, vibe transfer encoding,
 * and subscription telemetry passthrough requests without acquiring Channel A exclusive locks.
 *
 * @param {string} url - Target endpoint URL.
 * @param {object} config - Native fetch options.
 * @param {string} [defaultMethod="POST"] - Default HTTP method when `config.method` is omitted.
 * @param {object} [options={}] - Counter and HUD telemetry refresh flags.
 * @param {boolean} [options.countAsTextGen=true] - Increment `count_text_gens` on 200 OK.
 * @param {boolean} [options.refreshTelemetry=false] - Refresh HUD telemetry on 200 OK.
 * @returns {Promise<Response>} Wrapped fetch response delivering stream bytes.
 */
async function handleTextGenerationIntercept(url, config, defaultMethod = "POST", options = {}) {
    const { countAsTextGen = true, refreshTelemetry = false } = options;
    const requestMethod = config.method || defaultMethod;

    const originalUrlObj = new URL(url);
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
    updatedHeaders.set("x-script-version", GM_info.script.version);
    if (GM_getValue("debug_mode", false)) {
        updatedHeaders.set("x-debug-mode", "true");
        console.log(`[GuildWeave Debug Mode] Outbound text/telemetry payload:`, config.body);
    }

    updatedHeaders.delete("host");
    updatedHeaders.delete("content-length");

    if (typeof FormData !== 'undefined' && config.body instanceof FormData) {
        updatedHeaders.delete("content-type");
    }

    let hasResolved = false;

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: requestMethod,
            url: proxyUrl,
            headers: Object.fromEntries(updatedHeaders.entries()),
            data: config.body,
            responseType: "stream",
            onloadstart: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, false, countAsTextGen, refreshTelemetry)) {
                    hasResolved = true;
                }
            },
            onreadystatechange: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onreadystatechange fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                if (hasResolved) return;
                if (responseDetails.readyState >= 2) {
                    if (await tryResolveProxyResponse(responseDetails, resolve, false, countAsTextGen, refreshTelemetry)) {
                        hasResolved = true;
                    }
                }
            },
            onload: async function(responseDetails) {
                console.log(`[${envConfig.logPrefix}] Telemetry (Text): onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                if (hasResolved) return;
                if (await tryResolveProxyResponse(responseDetails, resolve, false, countAsTextGen, refreshTelemetry)) {
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
        console.error("[GuildWeave] Fatal: Target window fetch interface is unavailable.");
        return;
    }

    const originalFetch = targetWindow.fetch;
    targetWindow.fetch = async function(...args) {
        const url = args[0];
        const config = args[1] || {};
        const urlString = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');

        if (urlString) {
            if (urlString.includes('/user/data')) {
                const response = await originalFetch(...args);
                if (response && response.ok) {
                    const cloned = response.clone();
                    try {
                        const data = await cloned.json();
                        const policyState = getClientPolicyState();
                        const hasKnownFiniteAnlas = typeof policyState.availableAnlas === 'number' &&
                            Number.isFinite(policyState.availableAnlas) &&
                            !policyState.isUnlimitedAnlas;
                        const fixedAnlas = hasKnownFiniteAnlas ? Math.max(0, Math.trunc(policyState.availableAnlas)) : 9999;
                        const purchasedAnlas = hasKnownFiniteAnlas ? 0 : 9999;

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
                                fixedTrainingStepsLeft: fixedAnlas,
                                purchasedTrainingSteps: purchasedAnlas
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

            if (urlString.includes('/user/subscription')) {
                return handleTextGenerationIntercept(urlString, config, "GET", {
                    countAsTextGen: false,
                    refreshTelemetry: false
                });
            }

            if (urlString.includes('/ai/generate-image') && !urlString.includes('/suggest-tags')) {
                return handleGenerationIntercept(urlString, config);
            }

            if (urlString.includes('/ai/upscale')) {
                return handleUpscaleIntercept(urlString, config);
            }

            if (urlString.includes('/ai/generate-stream') || urlString.includes('/oa/v1/completions')) {
                return handleTextGenerationIntercept(urlString, config, "POST", {
                    countAsTextGen: true,
                    refreshTelemetry: false
                });
            }

            if (urlString.includes('/ai/encode-vibe')) {
                return handleTextGenerationIntercept(urlString, config, "POST", {
                    countAsTextGen: false,
                    refreshTelemetry: true
                });
            }
        }

        return originalFetch(...args);
    };
}