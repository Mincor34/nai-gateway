// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Guest)
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  FIFO queue coordination, metadata spoofing, and background stream proxy pipeline
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *.duckdns.org
// @updateURL    https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
// @downloadURL  https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
// ==/UserScript==

/**
 * CLIENT RUNTIME (nai-guest.user.js)
 *
 * Implements client-side metadata spoofing (Opus subscription mapping) and 
 * redirects generation operations to the VPS coordinate gateway.
 *
 * Process Flow:
 * 1. Generates unique identities and stores them in sandbox memory.
 * 2. Authenticates queries using bearer token parameters.
 * 3. Hijacks unsafeWindow.fetch calls to mock tier-specific capabilities.
 * 4. Extends image request lifecycles to complete validation queue phases 
 *    before passing raw data streams up to the secure VPS.
 */

(function() {
    'use strict';

    console.log("Nai-Guest: Script injected successfully at document-start.");

    // Retrieve host from browser storage; prompt on first run to avoid hardcoding targets
    let VPS_HOST = GM_getValue("vps_host", "");
    if (!VPS_HOST) {
        const inputHost = prompt("Nai-Guest: Enter your VPS Gateway URL (e.g., https://your-domain.duckdns.org):");
        if (inputHost) {
            let sanitized = inputHost.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(sanitized)) {
                sanitized = "https://" + sanitized;
            }
            GM_setValue("vps_host", sanitized);
            VPS_HOST = sanitized;
            alert(`VPS Host saved: ${VPS_HOST}. Reloading page.`);
            window.location.reload();
        } else {
            console.error("Nai-Guest: Missing VPS Gateway target URL. Interception halted.");
            return;
        }
    }

    // Dynamic configuration modifier key listener (Ctrl + Shift + H) to update VPS target
    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "H") {
            const currentHost = GM_getValue("vps_host", "");
            const newHost = prompt("Enter new VPS Gateway URL (e.g., https://your-domain.duckdns.org):", currentHost);
            if (newHost !== null) {
                let sanitized = newHost.trim().replace(/\/+$/, "");
                if (sanitized && !/^https?:\/\//i.test(sanitized)) {
                    sanitized = "https://" + sanitized;
                }
                GM_setValue("vps_host", sanitized);
                alert("VPS Gateway URL updated. Page reloading.");
                window.location.reload();
            }
        }
    });

    function generateUUID() {
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

    let browserId = GM_getValue("browser_id");
    let deviceSecret = GM_getValue("device_secret");
    let approved = GM_getValue("approved", false);

    try {
        if (!browserId || !deviceSecret) {
            browserId = 'b_' + generateUUID();
            deviceSecret = 's_' + generateUUID();
            GM_setValue("browser_id", browserId);
            GM_setValue("device_secret", deviceSecret);
            GM_setValue("approved", false);
            approved = false;
            console.log("Nai-Guest: Initialized clean device identity credentials.");
        }
        console.log(`Nai-Guest: ID = ${browserId}, Approved = ${approved}`);
    } catch (err) {
        console.error("Nai-Guest: Storage initialization crash:", err);
    }

    function backgroundRequest(details) {
        console.log(`Nai-Guest: Dispatching request to ${details.url}...`);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                onload: (r) => {
                    console.log(`Nai-Guest: Received response status ${r.status} from ${details.url}`);
                    resolve(r);
                },
                onerror: (e) => {
                    console.error(`Nai-Guest: Request error to ${details.url}`, e);
                    reject(e);
                }
            });
        });
    }

    // High-frequency UI enforcement loop (forces UI overlay to stay mounted and visible)
    let overlayMessage = "This device is currently awaiting administrator verification. Give the Device ID below to the coordinator.";
    let enforcementInterval = null;

    function startUIEnforcement() {
        if (enforcementInterval) return;
        console.log("Nai-Guest: Starting high-frequency UI enforcement loop...");
        enforcementInterval = setInterval(() => {
            if (!document.body) return; // Wait for body to be constructed

            let overlay = document.getElementById("vps-approval-overlay");
            if (!overlay) {
                console.log("Nai-Guest: UI overlay was missing or deleted by React. Re-injecting...");
                overlay = document.createElement("div");
                overlay.id = "vps-approval-overlay";
                overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:#121212 !important; color:#fff !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:sans-serif !important;";
                document.body.appendChild(overlay);
            }

            // Ensure the content matches the active message
            const expectedHTML = `
                <div style="background:#252525 !important; padding:35px !important; border-radius:6px !important; text-align:center !important; border:1px solid #333 !important; box-shadow:0 8px 30px rgba(0,0,0,0.6) !important; max-width:400px !important; color:#fff !important; font-family:sans-serif !important;">
                    <h3 style="margin:0 0 10px 0 !important; color:#00bc8c !important; letter-spacing:1px !important;">GATEWAY VERIFICATION</h3>
                    <p style="margin:0 0 20px 0 !important; color:#bbb !important; font-size:14px !important; line-height:1.5 !important;">${overlayMessage}</p>
                    <div style="font-size:11px !important; color:#777 !important; background:#111 !important; padding:12px !important; border-radius:4px !important; word-break:break-all !important; font-family:monospace !important;">
                        DEVICE ID: <span style="color:#f0ad4e !important; font-weight:bold !important;">${browserId}</span>
                    </div>
                </div>
            `;

            if (overlay.innerHTML !== expectedHTML) {
                overlay.innerHTML = expectedHTML;
            }
        }, 50);
    }

    if (!approved) {
        console.log("Nai-Guest: Device is unapproved. Bootstrapping gateway routes...");

        // Quietly register device with backend
        backgroundRequest({
            method: "POST",
            url: `${VPS_HOST}/auth/register`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: "Guest Client Node" })
        }).catch(err => console.error("Nai-Guest: Registration post failed:", err));

        const checkAuth = async () => {
            try {
                const res = await backgroundRequest({
                    method: "GET",
                    url: `${VPS_HOST}/auth/status?browser_id=${browserId}`,
                    headers: { "Authorization": `Bearer ${deviceSecret}` }
                });
                if (res.status === 200) {
                    const data = JSON.parse(res.responseText);
                    console.log("Nai-Guest: Current status check results:", data);
                    if (data.approved) {
                        console.log("Nai-Guest: Credentials verified! Reloading page contexts...");
                        GM_setValue("approved", true);
                        window.location.reload();
                    } else {
                        overlayMessage = "This device is currently awaiting administrator verification. Give the Device ID below to the coordinator.";
                        startUIEnforcement();
                    }
                }
            } catch (err) {
                console.error("Nai-Guest: Connection check execution crash:", err);
                overlayMessage = "Lost gateway routing connection. Re-attempting handshake...";
                startUIEnforcement();
            }
        };

        checkAuth();
        setInterval(checkAuth, 10000);
        return; // Halt loading sequence
    }

    // ----------------- STANDARD INTERCEPTION CODE (Below Approved Checks) -----------------
    console.log("Nai-Guest: Client approved. Interception hooks active.");

    function parseResponseHeaders(headerStr) {
        const headers = new Headers();
        if (!headerStr) return headers;

        const lines = headerStr.split(/[\r\n]+/);
        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return;

            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) return; // Ignore status lines

            const name = trimmedLine.slice(0, colonIndex).trim();
            const value = trimmedLine.slice(colonIndex + 1).trim();

            if (name) {
                if (/^[a-zA-Z0-9!#$%&'*+-.^_`|~]+$/.test(name)) {
                    try {
                        headers.append(name, value);
                    } catch (e) {
                        console.error(`Nai-Guest: Failed to append header "${name}":`, e);
                    }
                } else {
                    console.warn(`Nai-Guest: Dropping invalid header name token: "${name}"`);
                }
            }
        });
        return headers;
    }

    function extractStatusCode(responseDetails) {
        if (responseDetails.status && responseDetails.status !== 0) {
            return responseDetails.status;
        }
        if (responseDetails.responseHeaders) {
            const match = responseDetails.responseHeaders.match(/^HTTP\/[0-9.]+\s+(\d+)/i);
            if (match) {
                return parseInt(match[1], 10);
            }
        }
        return 0; // Return 0 to indicate status code could not be resolved yet
    }

    async function readStreamAsString(stream) {
        if (!stream) return "";
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let result = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
        }
        result += decoder.decode(); // Flush stream buffer
        return result;
    }

    async function tryResolveProxyResponse(responseDetails, resolveObj) {
        const status = extractStatusCode(responseDetails);
        if (status === 0) {
            return false; // Status code not yet populated; defer resolution
        }

        if (status === 200) {
            if (!responseDetails.response) {
                console.error("[Nai-Guest] Telemetry: Success code detected, but readable response stream was empty.");
                return false; // Wait for response body context to bind
            }
            console.log("[Nai-Guest] Telemetry: Stream successfully acquired. Piping stream response directly to web page fetch promise.");
            resolveObj(new Response(responseDetails.response, {
                status: status,
                headers: parseResponseHeaders(responseDetails.responseHeaders)
            }));
            return true;
        } else {
            console.error(`[Nai-Guest] Telemetry: Proxy returned exception status code: ${status}`);

            let errorText = "";
            try {
                if (responseDetails.response) {
                    if (typeof responseDetails.response.getReader === 'function') {
                        errorText = await readStreamAsString(responseDetails.response);
                    } else if (typeof responseDetails.response === 'string') {
                        errorText = responseDetails.response;
                    }
                }
            } catch (e) {
                console.error("[Nai-Guest] Error: Failed to extract string from raw exception stream:", e);
            }

            console.log(`[Nai-Guest] Telemetry: Received raw error text: "${errorText}"`);

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

    async function extractImageParams(body) {
        if (!body) return null;
        try {
            let payload = null;
            if (body instanceof FormData) {
                const requestBlob = body.get("request");
                if (!requestBlob) return null;
                const text = typeof requestBlob.text === 'function'
                    ? await requestBlob.text()
                    : requestBlob;
                payload = JSON.parse(text);
            } else if (typeof body === 'string') {
                payload = JSON.parse(body);
            }

            if (payload && payload.parameters) {
                return {
                    width: parseInt(payload.parameters.width, 10) || 1024,
                    height: parseInt(payload.parameters.height, 10) || 1024,
                    steps: parseInt(payload.parameters.steps, 10) || 28,
                    n_samples: parseInt(payload.parameters.n_samples, 10) || 1
                };
            }
        } catch (e) {
            console.error("Nai-Guest: Parameter extraction failed:", e);
        }
        return null;
    }

    function showQueueStatusBanner(text) {
        let banner = document.getElementById("vps-queue-banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "vps-queue-banner";
            banner.style = "position:fixed;bottom:25px;right:25px;background:#1b1b1b;color:#00bc8c;padding:12px 20px;border:1px solid #00bc8c;border-radius:4px;z-index:99998;font-family:sans-serif;font-size:13px;box-shadow:0 4px 15px rgba(0,0,0,0.4);display:flex;align-items:center;gap:10px;";
            document.documentElement.appendChild(banner);
        }
        banner.innerHTML = `<div style="width:8px;height:8px;background:#00bc8c;border-radius:50%;animation:vpsPulse 1s infinite alternate;"></div><span>${text}</span>
        <style>@keyframes vpsPulse { 0% { opacity:0.3; } 100% { opacity:1; } }</style>`;
    }

    function hideQueueStatusBanner() {
        const banner = document.getElementById("vps-queue-banner");
        if (banner) banner.remove();
    }

    async function handleGenerationIntercept(url, config) {
        const req_id = 'req_' + generateUUID();
        const tab_id = sessionStorage.getItem("vps_tab_id") || (() => {
            const tid = 't_' + generateUUID();
            sessionStorage.setItem("vps_tab_id", tid);
            return tid;
        })();

        const originalBody = config.body;
        let imgParams = { width: 1024, height: 1024, steps: 28, n_samples: 1 };

        const extracted = await extractImageParams(originalBody);
        if (extracted) imgParams = extracted;

        try {
            const joinRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/queue/join`,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${deviceSecret}`
                },
                data: JSON.stringify({ browser_id: browserId, tab_id, req_id })
            });
            if (joinRes.status !== 200) throw new Error("Join rejection");
        } catch (e) {
            return new Response(JSON.stringify({ statusCode: 502, message: "Queue allocation failure" }), { status: 502 });
        }

        let turnAcquired = false;
        showQueueStatusBanner("Acquiring channel slot...");

        while (!turnAcquired) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const statusRes = await backgroundRequest({
                    method: "GET",
                    url: `${VPS_HOST}/queue/status?req_id=${req_id}`
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
                    url: `${VPS_HOST}/queue/complete`,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ req_id })
                });
                return new Response(JSON.stringify({ statusCode: 502, message: "Queue processing aborted" }), { status: 502 });
            }
        }

        const originalUrlObj = new URL(url);
        const proxyUrl = `${VPS_HOST}/proxy/image${originalUrlObj.pathname}${originalUrlObj.search}`;

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

        updatedHeaders.set("x-browser-id", browserId);
        updatedHeaders.set("x-request-id", req_id);
        updatedHeaders.set("x-gen-width", imgParams.width.toString());
        updatedHeaders.set("x-gen-height", imgParams.height.toString());
        updatedHeaders.set("x-gen-steps", imgParams.steps.toString());
        updatedHeaders.set("x-gen-samples", imgParams.n_samples.toString());
        updatedHeaders.set("authorization", `Bearer ${deviceSecret}`);

        updatedHeaders.delete("host");
        updatedHeaders.delete("content-length"); // Prevent boundary mismatches from desynchronizing streams

        if (originalBody instanceof FormData) {
            updatedHeaders.delete("content-type");
        }

        let hasResolved = false;
        console.log(`[Nai-Guest] Intercepting fetch targeting VPS rewrite URL: ${proxyUrl}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: config.method || "POST",
                url: proxyUrl,
                headers: Object.fromEntries(updatedHeaders.entries()),
                data: originalBody,
                responseType: "stream",
                onloadstart: async function(responseDetails) {
                    console.log(`[Nai-Guest] Telemetry: onloadstart fired. RawStatus: ${responseDetails.status}, ExtractedStatus: ${extractStatusCode(responseDetails)}, HasResponse: ${!!responseDetails.response}`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve)) {
                        hasResolved = true;
                    }
                },
                onload: async function(responseDetails) {
                    console.log(`[Nai-Guest] Telemetry: onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve)) {
                        hasResolved = true;
                    }
                },
                onerror: (err) => {
                    console.error("[Nai-Guest] Telemetry: Fatal network transport crash during GM_xmlhttpRequest transmission.", err);

                    backgroundRequest({
                        method: "POST",
                        url: `${VPS_HOST}/queue/complete`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ req_id })
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
     * Intercepts and routes text generation requests directly to the VPS 
     * bypassing the heavy FIFO image generation channel lock (Channel B).
     */
    async function handleTextGenerationIntercept(url, config) {
        const originalUrlObj = new URL(url);
        const proxyUrl = `${VPS_HOST}/proxy/text${originalUrlObj.pathname}${originalUrlObj.search}`;
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

        updatedHeaders.set("x-browser-id", browserId);
        updatedHeaders.set("authorization", `Bearer ${deviceSecret}`);

        updatedHeaders.delete("host");
        updatedHeaders.delete("content-length"); // Prevent stream desynchronization

        let hasResolved = false;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: config.method || "POST",
                url: proxyUrl,
                headers: Object.fromEntries(updatedHeaders.entries()),
                data: config.body,
                responseType: "stream",
                onloadstart: async function(responseDetails) {
                    console.log(`[Nai-Guest] Telemetry (Text): onloadstart fired. Status: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve)) {
                        hasResolved = true;
                    }
                },
                onerror: (err) => {
                    if (!hasResolved) {
                        hasResolved = true;
                        reject(err);
                    }
                }
            });
        });
    }

    // Capture and hook unsafeWindow fetch pipelines
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const url = args[0];
        const config = args[1] || {};
        const urlString = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');

        if (urlString) {
            // Spoof personal metadata retrieval endpoints to display Opus eligibility status
            if (urlString.includes('/user/data')) {
                const response = await originalFetch(...args);
                if (response.ok) {
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
                    "eligible_for_text_gens": true,
                    "eligible_for_image_gens": true,
                    "trial_activated": true
                };
                return new Response(JSON.stringify(mockTrial), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Generation Interceptions
            if (urlString.includes('/ai/generate-image')) {
                return handleGenerationIntercept(urlString, config);
            }

            if (urlString.includes('/ai/generate-stream')) {
                return handleTextGenerationIntercept(urlString, config);
            }
        }

        return originalFetch(...args);
    };
})();