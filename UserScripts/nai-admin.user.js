// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Admin Panel)
// @namespace    http://tampermonkey.net/
// @version      4.3.0
// @description  Secure administration panel, telemetry dashboard, bilateral debug coordinator, and session token injector
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      duckdns.org
// @updateURL    https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-admin.user.js
// @downloadURL  https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-admin.user.js
// ==/UserScript==

"use strict";
(() => {
  // src/userscripts/shared/crypto.js
  function generateUUID() {
    const webCrypto = typeof globalThis !== "undefined" && globalThis.crypto ? globalThis.crypto : typeof window !== "undefined" && window.crypto ? window.crypto : typeof crypto !== "undefined" ? crypto : null;
    if (!webCrypto || typeof webCrypto.randomUUID !== "function" && typeof webCrypto.getRandomValues !== "function") {
      let d = (/* @__PURE__ */ new Date()).getTime();
      let d2 = typeof performance !== "undefined" && performance.now && performance.now() * 1e3 || 0;
      return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        let r = Math.random() * 16;
        if (d > 0) {
          r = (d + r) % 16 | 0;
          d = Math.floor(d / 16);
        } else {
          r = (d2 + r) % 16 | 0;
          d = Math.floor(d2 / 16);
        }
        return (c === "x" ? r : r & 3 | 8).toString(16);
      });
    }
    if (typeof webCrypto.randomUUID === "function") {
      return webCrypto.randomUUID().replace(/-/g, "");
    }
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // src/userscripts/shared/network.js
  function backgroundRequest(details) {
    const headers = details.headers || {};
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
  function parseResponseHeaders(headerStr) {
    const headers = new Headers();
    if (!headerStr)
      return headers;
    const lines = headerStr.split(/[\r\n]+/);
    lines.forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine)
        return;
      const colonIndex = trimmedLine.indexOf(":");
      if (colonIndex === -1)
        return;
      const name = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      if (name) {
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
    return 0;
  }
  async function readStreamAsString(stream) {
    if (!stream)
      return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  // src/userscripts/shared/ui.js
  function showQueueStatusBanner(text) {
    let banner = document.getElementById("vps-queue-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "vps-queue-banner";
      banner.style.cssText = "position:fixed;bottom:175px;right:15px;background:#1b1b1b;color:#00bc8c;padding:12px 20px;border:1px solid #00bc8c;border-radius:4px;z-index:99998;font-family:sans-serif;font-size:13px;box-shadow:0 4px 15px rgba(0,0,0,0.4);display:flex;align-items:center;gap:10px;";
      document.documentElement.appendChild(banner);
    }
    banner.innerHTML = `
        <div style="width:8px;height:8px;background:#00bc8c;border-radius:50%;animation:vpsPulse 1s infinite alternate;"></div>
        <span>${text}</span>
        <style>@keyframes vpsPulse { 0% { opacity:0.3; } 100% { opacity:1; } }</style>
    `;
  }
  function hideQueueStatusBanner() {
    const banner = document.getElementById("vps-queue-banner");
    if (banner)
      banner.remove();
  }
  function injectWarningBadge(message, bgColor) {
    if (document.getElementById("vps-debug-badge"))
      return;
    const badge = document.createElement("div");
    badge.id = "vps-debug-badge";
    badge.innerHTML = message;
    badge.style.cssText = `position:fixed; top:10px; left:50%; transform:translateX(-50%); background:${bgColor}; color:#fff; font-weight:bold; font-size:11px; padding:6px 12px; border-radius:4px; z-index:99999; box-shadow:0 2px 8px rgba(0,0,0,0.4); pointer-events:none; font-family:sans-serif;`;
    document.documentElement.appendChild(badge);
  }
  function removeWarningBadge() {
    const badge = document.getElementById("vps-debug-badge");
    if (badge)
      badge.remove();
  }

  // src/userscripts/shared/params.js
  async function extractImageParams(body) {
    if (!body)
      return null;
    try {
      let payload = null;
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const requestBlob = body.get("request");
        if (!requestBlob)
          return null;
        const text = typeof requestBlob.text === "function" ? await requestBlob.text() : String(requestBlob);
        payload = JSON.parse(text);
      } else if (typeof body === "string") {
        payload = JSON.parse(body);
      } else if (typeof Blob !== "undefined" && body instanceof Blob) {
        const text = await body.text();
        payload = JSON.parse(text);
      } else if (body instanceof Uint8Array || typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
        const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        payload = JSON.parse(text);
      } else if (typeof body === "object" && !Array.isArray(body)) {
        if (body.parameters || body.width || body.model) {
          payload = body;
        }
      }
      if (payload && typeof payload === "object") {
        const params = payload.parameters && typeof payload.parameters === "object" ? payload.parameters : payload;
        const preciseRefs = (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) + (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0) + (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0);
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

  // src/userscripts/shared/interceptor.js
  var envConfig = {
    browserId: "",
    deviceSecret: "",
    VPS_HOST: "",
    logPrefix: "Nai-Gateway",
    onRevoked: () => {
    }
  };
  function initInterceptor(config) {
    envConfig = { ...envConfig, ...config };
    hijackFetch();
  }
  async function tryResolveProxyResponse(responseDetails, resolveObj, isImageGen, isTextGen) {
    const status = extractStatusCode(responseDetails);
    if (status === 0) {
      return false;
    }
    if (status === 200) {
      if (!responseDetails.response) {
        console.error("[VPS Gateway] Telemetry: Success code detected, but readable response stream was empty.");
        return false;
      }
      console.log("[VPS Gateway] Telemetry: Stream successfully acquired. Piping stream response directly to fetch promise.");
      if (isImageGen) {
        GM_setValue("count_image_gens", GM_getValue("count_image_gens", 0) + 1);
      } else if (isTextGen) {
        GM_setValue("count_text_gens", GM_getValue("count_text_gens", 0) + 1);
      }
      resolveObj(new Response(responseDetails.response, {
        status,
        headers: parseResponseHeaders(responseDetails.responseHeaders)
      }));
      return true;
    } else {
      if (responseDetails.readyState !== 4 && responseDetails.readyState !== void 0) {
        return false;
      }
      console.error("[VPS Gateway] Telemetry: Proxy returned exception status code:", status);
      if (status === 401) {
        console.warn("[VPS Gateway] Revocation signature caught. Restoring setup lock.");
        GM_setValue("approved", false);
        if (typeof envConfig.onRevoked === "function") {
          envConfig.onRevoked();
        }
        return true;
      }
      let errorText = "";
      try {
        if (responseDetails.response) {
          if (typeof responseDetails.response.getReader === "function") {
            errorText = await readStreamAsString(responseDetails.response);
          } else if (typeof responseDetails.response === "string") {
            errorText = responseDetails.response;
          }
        }
        if (!errorText && responseDetails.responseText) {
          errorText = responseDetails.responseText;
        }
      } catch (e) {
        console.error("[VPS Gateway] Error: Failed to extract string from raw exception stream:", e);
      }
      console.log(`[VPS Gateway] Telemetry: Received raw error text: "${errorText}"`);
      let parsedError = null;
      try {
        if (errorText)
          parsedError = JSON.parse(errorText);
      } catch (e) {
      }
      const responseBody = parsedError && (parsedError.statusCode || parsedError.message || parsedError.error) ? JSON.stringify({
        statusCode: parsedError.statusCode || status,
        message: parsedError.message || parsedError.error || errorText || "Gateway processing error"
      }) : JSON.stringify({
        statusCode: status,
        message: errorText || "Gateway processing error"
      });
      resolveObj(new Response(responseBody, {
        status,
        headers: parseResponseHeaders(responseDetails.responseHeaders)
      }));
      return true;
    }
  }
  async function handleGenerationIntercept(url, config) {
    const req_id = "req_" + generateUUID();
    const tab_id = typeof sessionStorage !== "undefined" && sessionStorage.getItem("vps_tab_id") || (() => {
      const tid = "t_" + generateUUID();
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem("vps_tab_id", tid);
      }
      return tid;
    })();
    const originalBody = config.body;
    let imgParams = { width: 1024, height: 1024, steps: 28, n_samples: 1, precise_refs: 0, model: "" };
    const extracted = await extractImageParams(originalBody);
    if (extracted)
      imgParams = extracted;
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
          if (typeof envConfig.onRevoked === "function") {
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
          if (errorDetails.error === "ALLOWANCE_EXHAUSTED") {
            hideQueueStatusBanner();
            return new Response(JSON.stringify({
              statusCode: 403,
              message: "Allowance Exhausted: You have run out of image tokens. Allowance refills at a rate of 1 image per 30 minutes (max 100)."
            }), { status: 403 });
          }
        }
        if (joinRes.status !== 200)
          throw new Error("Join rejection");
      } catch (e) {
        return new Response(JSON.stringify({ statusCode: 502, message: "Queue allocation failure" }), { status: 502 });
      }
      let turnAcquired = false;
      showQueueStatusBanner("Acquiring channel slot...");
      while (!turnAcquired) {
        await new Promise((r) => setTimeout(r, 1e3));
        try {
          const statusRes = await backgroundRequest({
            method: "GET",
            url: `${envConfig.VPS_HOST}/queue/status?req_id=${req_id}&browser_id=${envConfig.browserId}`,
            headers: { "Authorization": `Bearer ${envConfig.deviceSecret}` }
          });
          if (statusRes.status === 200) {
            const sData = JSON.parse(statusRes.responseText);
            if (sData.status === "your_turn") {
              turnAcquired = true;
              hideQueueStatusBanner();
            } else if (sData.status === "waiting") {
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
      const subdomain = originalUrlObj.hostname.split(".")[0];
      const proxyUrl = `${envConfig.VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;
      const updatedHeaders = /* @__PURE__ */ new Map();
      if (config.headers) {
        if (config.headers instanceof Headers) {
          for (let [k, v] of config.headers.entries()) {
            updatedHeaders.set(k.toLowerCase(), v);
          }
        } else {
          Object.keys(config.headers).forEach((k) => {
            updatedHeaders.set(k.toLowerCase(), config.headers[k]);
          });
        }
      }
      const isV5 = typeof imgParams.model === "string" && /[-_]5[-_]/i.test(imgParams.model) && !imgParams.model.includes("4-5");
      updatedHeaders.set("x-browser-id", envConfig.browserId);
      updatedHeaders.set("x-request-id", req_id);
      updatedHeaders.set("x-gen-width", imgParams.width.toString());
      updatedHeaders.set("x-gen-height", imgParams.height.toString());
      updatedHeaders.set("x-gen-steps", imgParams.steps.toString());
      updatedHeaders.set("x-gen-samples", imgParams.n_samples.toString());
      updatedHeaders.set("x-precise-refs", imgParams.precise_refs.toString());
      if (isV5) {
        updatedHeaders.set("x-gen-model", "V5");
      } else {
        updatedHeaders.set("x-gen-model", "legacy");
      }
      updatedHeaders.set("authorization", `Bearer ${envConfig.deviceSecret}`);
      updatedHeaders.set("x-script-version", GM_info.script.version);
      if (GM_getValue("debug_mode", false)) {
        updatedHeaders.set("x-debug-mode", "true");
        console.log(`[VPS Debug Mode] Outbound image generation details:`, originalBody);
      }
      updatedHeaders.delete("host");
      updatedHeaders.delete("content-length");
      if (typeof FormData !== "undefined" && originalBody instanceof FormData) {
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
            if (hasResolved)
              return;
            if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
              hasResolved = true;
            }
          },
          onreadystatechange: async function(responseDetails) {
            console.log(`[${envConfig.logPrefix}] Telemetry: onreadystatechange fired. ReadyState: ${responseDetails.readyState}, ExtractedStatus: ${extractStatusCode(responseDetails)}`);
            if (hasResolved)
              return;
            if (responseDetails.readyState >= 2) {
              if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                hasResolved = true;
              }
            }
          },
          onload: async function(responseDetails) {
            console.log(`[${envConfig.logPrefix}] Telemetry: onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
            if (hasResolved)
              return;
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
    let resolveOuter, rejectOuter;
    const outerPromise = new Promise((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    executeQueueJoin().then(resolveOuter, rejectOuter);
    return outerPromise;
  }
  async function handleTextGenerationIntercept(url, config) {
    const originalUrlObj = new URL(url);
    const subdomain = originalUrlObj.hostname.split(".")[0];
    const proxyUrl = `${envConfig.VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;
    const updatedHeaders = /* @__PURE__ */ new Map();
    if (config.headers) {
      if (config.headers instanceof Headers) {
        for (let [k, v] of config.headers.entries()) {
          updatedHeaders.set(k.toLowerCase(), v);
        }
      } else {
        Object.keys(config.headers).forEach((k) => {
          updatedHeaders.set(k.toLowerCase(), config.headers[k]);
        });
      }
    }
    updatedHeaders.set("x-browser-id", envConfig.browserId);
    updatedHeaders.set("authorization", `Bearer ${envConfig.deviceSecret}`);
    updatedHeaders.set("x-script-version", GM_info.script.version);
    if (GM_getValue("debug_mode", false)) {
      updatedHeaders.set("x-debug-mode", "true");
      console.log(`[VPS Debug Mode] Outbound text prompt payload:`, config.body);
    }
    updatedHeaders.delete("host");
    updatedHeaders.delete("content-length");
    if (typeof FormData !== "undefined" && config.body instanceof FormData) {
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
          if (hasResolved)
            return;
          if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
            hasResolved = true;
          }
        },
        onreadystatechange: async function(responseDetails) {
          console.log(`[${envConfig.logPrefix}] Telemetry (Text): onreadystatechange fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
          if (hasResolved)
            return;
          if (responseDetails.readyState >= 2) {
            if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
              hasResolved = true;
            }
          }
        },
        onload: async function(responseDetails) {
          console.log(`[${envConfig.logPrefix}] Telemetry (Text): onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
          if (hasResolved)
            return;
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
  function hijackFetch() {
    const targetWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null;
    if (!targetWindow || typeof targetWindow.fetch !== "function") {
      console.error("[Nai-Gateway] Fatal: Target window fetch interface is unavailable.");
      return;
    }
    const originalFetch = targetWindow.fetch;
    targetWindow.fetch = async function(...args) {
      const url = args[0];
      const config = args[1] || {};
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : "";
      if (urlString) {
        if (urlString.includes("/user/data")) {
          const response = await originalFetch(...args);
          if (response && response.ok) {
            const cloned = response.clone();
            try {
              const data = await cloned.json();
              data.subscription = {
                tier: 3,
                active: true,
                paymentProcessor: null,
                expiresAt: 2524608e3,
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
        if (urlString.includes("/ai/trial-status")) {
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
            headers: { "Content-Type": "application/json" }
          });
        }
        if (urlString.includes("/user/subscription")) {
          return handleTextGenerationIntercept(urlString, config);
        }
        if (urlString.includes("/ai/generate-image") && !urlString.includes("/suggest-tags")) {
          return handleGenerationIntercept(urlString, config);
        }
        if (urlString.includes("/ai/generate-stream") || urlString.includes("/oa/v1/completions")) {
          return handleTextGenerationIntercept(urlString, config);
        }
        if (urlString.includes("/ai/encode-vibe")) {
          return handleTextGenerationIntercept(urlString, config);
        }
      }
      return originalFetch(...args);
    };
  }

  // src/userscripts/admin/index.js
  var browserId = GM_getValue("browser_id");
  var deviceSecret = GM_getValue("admin_token");
  var approved = GM_getValue("approved", false);
  var VPS_HOST = GM_getValue("vps_host", "");
  var currentSort = GM_getValue("admin_sort_mode", "anlas");
  var expandedKeys = /* @__PURE__ */ new Set();
  try {
    if (!browserId) {
      browserId = "b_" + generateUUID();
      GM_setValue("browser_id", browserId);
    }
  } catch (err) {
    console.error("Nai-Admin: Storage initialization crash:", err);
  }
  var enforcementInterval = null;
  function startUIEnforcement() {
    if (enforcementInterval)
      return;
    console.log("Nai-Admin: Starting high-frequency UI enforcement loop...");
    enforcementInterval = setInterval(() => {
      if (!document.body)
        return;
      let overlay = document.getElementById("vps-approval-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "vps-approval-overlay";
        overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:#121212 !important; color:#fff !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:sans-serif !important;";
        document.body.appendChild(overlay);
        renderSetupWizard(overlay);
      }
    }, 50);
  }
  function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card"))
      return;
    container.innerHTML = `
        <div class="setup-wizard-card" style="background:#1c1c1c; padding:35px; border-radius:6px; border:1px solid #c0392b; box-shadow:0 8px 30px rgba(0,0,0,0.6); max-width:90vw; width:420px; box-sizing:border-box;">
            <h3 style="margin:0 0 15px 0; color:#00bc8c; text-align:center; letter-spacing:1px; font-size:18px; font-family:sans-serif;">GATEWAY COORDINATOR SETUP (ADMIN)</h3>
            
            <!-- Gateway Domain Configuration -->
            <div id="step-1-container" style="margin-bottom:20px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:5px; font-weight:bold; font-family:sans-serif;">STEP 1: ENTER GATEWAY DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-domain" value="${GM_getValue("vps_host", "")}" placeholder="https://your-domain.duckdns.org" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                    <button id="btn-verify-domain" style="background:#2980b9; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Verify</button>
                </div>
                <div id="step-1-status" style="margin-top:5px; font-size:11px; font-family:sans-serif; display:none;"></div>
            </div>

            <!-- Nickname Configuration -->
            <div id="step-2-container" style="margin-bottom:20px; display:none;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:5px; font-weight:bold; font-family:sans-serif;">STEP 2: ENTER NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-nickname" value="${GM_getValue("device_nickname", "")}" placeholder="e.g. Admin" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                    <button id="btn-register-nickname" style="background:#27ae60; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Register</button>
                </div>
                <div id="step-2-status" style="margin-top:5px; font-size:11px; font-family:sans-serif; display:none;"></div>
            </div>

            <!-- Admin Passkey Verification -->
            <div id="step-3-container" style="display:none; border-top:1px solid #333; padding-top:15px; margin-top:15px;">
                <label style="display:block; font-size:12px; color:#aaa; margin-bottom:5px; font-weight:bold; font-family:sans-serif;">STEP 3: CONFIGURATION COMPLETE</label>
                <div id="step-3-content" style="font-size:12px; color:#bbb; line-height:1.5; font-family:sans-serif;"></div>
            </div>
        </div>
    `;
    const domainInput = container.querySelector("#setup-domain");
    const verifyBtn = container.querySelector("#btn-verify-domain");
    const step1Status = container.querySelector("#step-1-status");
    const nicknameInput = container.querySelector("#setup-nickname");
    const registerBtn = container.querySelector("#btn-register-nickname");
    const step2Status = container.querySelector("#step-2-status");
    const step2Container = container.querySelector("#step-2-container");
    const step3Container = container.querySelector("#step-3-container");
    const step3Content = container.querySelector("#step-3-content");
    let validatedHost = GM_getValue("vps_host", "");
    let validatedNickname = GM_getValue("device_nickname", "");
    async function verifyDomainAction() {
      let val = domainInput.value.trim().replace(/\/+$/, "");
      if (!val) {
        step1Status.style.display = "block";
        step1Status.style.color = "#e74c3c";
        step1Status.innerHTML = "\u2717 Domain cannot be empty.";
        return;
      }
      if (!/^https?:\/\//i.test(val)) {
        val = "https://" + val;
      }
      step1Status.style.display = "block";
      step1Status.style.color = "#f39c12";
      step1Status.innerHTML = "Connecting to server...";
      try {
        const res = await backgroundRequest({
          method: "GET",
          url: `${val}/auth/status?browser_id=ping`
        });
        if (res.status > 0) {
          step1Status.style.color = "#2ecc71";
          step1Status.innerHTML = "\u2713 Connected to Gateway!";
          GM_setValue("vps_host", val);
          validatedHost = val;
          step2Container.style.display = "block";
          domainInput.disabled = true;
          verifyBtn.disabled = true;
        } else {
          throw new Error("Bad response status");
        }
      } catch (err) {
        step1Status.style.color = "#e74c3c";
        step1Status.innerHTML = "\u2717 Connection failed. Ensure domain is correct and reachable.";
      }
    }
    async function registerNicknameAction() {
      const newNickname = nicknameInput.value.trim();
      if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
        step2Status.style.display = "block";
        step2Status.style.color = "#e74c3c";
        step2Status.innerHTML = "\u2717 Invalid nickname characters.";
        return;
      }
      step2Status.style.display = "block";
      step2Status.style.color = "#f39c12";
      step2Status.innerHTML = "Registering device...";
      try {
        const tempSecret = GM_getValue("admin_token", "temp_passkey");
        const res = await backgroundRequest({
          method: "POST",
          url: `${validatedHost}/auth/register`,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ browser_id: browserId, device_secret: tempSecret, label: newNickname })
        });
        if (res.status === 200) {
          step2Status.style.color = "#2ecc71";
          step2Status.innerHTML = "\u2713 Registered nickname successfully!";
          GM_setValue("device_nickname", newNickname);
          validatedNickname = newNickname;
          nicknameInput.disabled = true;
          registerBtn.disabled = true;
          step3Container.style.display = "block";
          showStep3();
        } else {
          throw new Error("Registration failed");
        }
      } catch (err) {
        step2Status.style.color = "#e74c3c";
        step2Status.innerHTML = "\u2717 Registration failed on server.";
      }
    }
    function showStep3() {
      step3Content.innerHTML = `
            <div style="margin-bottom:10px; font-family:sans-serif;">Your device is registered! Enter your Admin Passkey to authenticate this admin terminal:</div>
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <input type="password" id="setup-admin-key" placeholder="Enter admin passkey..." style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                <button id="btn-verify-admin" style="background:#e74c3c; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Verify</button>
            </div>
            <div id="admin-verify-status" style="font-size:11px; margin-top:5px; display:none; font-family:sans-serif;"></div>
        `;
      const adminKeyInput = step3Content.querySelector("#setup-admin-key");
      const verifyAdminBtn = step3Content.querySelector("#btn-verify-admin");
      const adminStatus = step3Content.querySelector("#admin-verify-status");
      verifyAdminBtn.onclick = async () => {
        const passkey = adminKeyInput.value.trim();
        if (!passkey) {
          adminStatus.style.display = "block";
          adminStatus.style.color = "#e74c3c";
          adminStatus.innerHTML = "\u2717 Passkey cannot be empty.";
          return;
        }
        adminStatus.style.display = "block";
        adminStatus.style.color = "#f39c12";
        adminStatus.innerHTML = "Verifying passkey...";
        try {
          const res = await backgroundRequest({
            method: "GET",
            url: `${validatedHost}/admin/devices`,
            headers: { "Authorization": `Bearer ${passkey}` }
          });
          if (res.status === 200) {
            adminStatus.style.color = "#2ecc71";
            adminStatus.innerHTML = "\u2713 Authenticated! Reloading...";
            GM_setValue("admin_token", passkey);
            GM_setValue("approved", true);
            setTimeout(() => window.location.reload(), 1500);
          } else {
            throw new Error("Invalid key");
          }
        } catch (err) {
          adminStatus.style.color = "#e74c3c";
          adminStatus.innerHTML = "\u2717 Invalid Admin Passkey.";
        }
      };
    }
    verifyBtn.onclick = verifyDomainAction;
    registerBtn.onclick = registerNicknameAction;
    if (validatedHost) {
      domainInput.value = validatedHost;
      step1Status.style.display = "block";
      step1Status.style.color = "#2ecc71";
      step1Status.innerHTML = "\u2713 Connected";
      domainInput.disabled = true;
      verifyBtn.disabled = true;
      step2Container.style.display = "block";
      if (validatedNickname) {
        nicknameInput.value = validatedNickname;
        step2Status.style.display = "block";
        step2Status.style.color = "#2ecc71";
        step2Status.innerHTML = "\u2713 Registered";
        nicknameInput.disabled = true;
        registerBtn.disabled = true;
        step3Container.style.display = "block";
        showStep3();
      }
    }
  }
  if (!approved || !VPS_HOST || !deviceSecret) {
    startUIEnforcement();
  } else {
    let toggleAdminPanel = function() {
      let modal = document.getElementById("vps-admin-panel");
      if (modal) {
        modal.remove();
        return;
      }
      modal = document.createElement("div");
      modal.id = "vps-admin-panel";
      modal.style.cssText = "position:fixed;top:60px;right:15px;width:380px;background:#1a1a1a;border:1px solid #c0392b;border-radius:4px;z-index:99997;color:#fff;padding:20px;font-family:sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.5);max-height:80vh;overflow-y:auto;";
      document.documentElement.appendChild(modal);
      renderAdminUI();
    }, injectGearButton = function() {
      if (document.getElementById("vps-gear-btn"))
        return;
      const gearBtn = document.createElement("button");
      gearBtn.id = "vps-gear-btn";
      gearBtn.innerHTML = "\u2699\uFE0F";
      gearBtn.style.cssText = "position:fixed; bottom:120px; right:15px; width:44px; height:44px; background:#1a1a1a; border:1px solid #c0392b; border-radius:50%; color:#fff; font-size:22px; cursor:pointer; z-index:99999; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 10px rgba(0,0,0,0.5); transition:transform 0.2s;";
      gearBtn.onclick = openSettingsModal;
      const banner = document.getElementById("vps-queue-banner");
      if (banner) {
        banner.style.bottom = "175px";
        banner.style.right = "15px";
      }
      document.documentElement.appendChild(gearBtn);
      if (GM_getValue("debug_mode", false)) {
        injectWarningBadge("\u26A0\uFE0F VPS DEBUG MODE ACTIVE", "#e74c3c");
      }
    };
    initInterceptor({
      browserId,
      deviceSecret,
      VPS_HOST,
      logPrefix: "Nai-Admin",
      onRevoked: () => {
        setTimeout(() => {
          if (typeof window !== "undefined" && window.location) {
            window.location.reload();
          }
        }, 500);
      }
    });
    const btn = document.createElement("button");
    btn.innerHTML = "VPS CONTROL PANEL";
    btn.style.cssText = "position:fixed;top:15px;right:15px;background:#c0392b;color:#fff;border:none;padding:10px 15px;border-radius:4px;z-index:99997;font-family:sans-serif;font-size:11px;font-weight:bold;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.5);";
    btn.onclick = toggleAdminPanel;
    document.documentElement.appendChild(btn);
    async function renderAdminUI() {
      const modal = document.getElementById("vps-admin-panel");
      if (!modal)
        return;
      modal.innerHTML = `
            <h4 style="margin:0 0 15px 0;border-bottom:1px solid #333;padding-bottom:5px;color:#c0392b;font-weight:bold;font-family:sans-serif;">COORDINATOR ADMINISTRATION</h4>
            
            <div style="margin-bottom:15px;">
                <label style="display:block;font-size:11px;color:#888;margin-bottom:5px;font-family:sans-serif;">MASTER NOVELAI SESSION TOKEN</label>
                <input type="password" id="vps-master-token-input" placeholder="Bearer jti_..." style="width:100%;background:#111;border:1px solid #444;color:#fff;padding:8px;font-size:11px;border-radius:3px;box-sizing:border-box;">
                <button id="vps-btn-push-token" style="background:#27ae60;border:none;color:#fff;padding:8px 12px;margin-top:8px;font-size:11px;font-weight:bold;cursor:pointer;border-radius:3px;width:100%;font-family:sans-serif;">PUSH TO VPS STORAGE</button>
            </div>

            <div style="border-top:1px solid #333;padding-top:15px;">
                <label style="display:block;font-size:11px;color:#888;margin-bottom:8px;font-family:sans-serif;">VERIFIED SYSTEM ACCOUNTS</label>
                
                <!-- Advanced sorting navigation header -->
                <div style="display:flex; justify-content:space-between; margin-bottom:12px; font-size:10px; background:#111; padding:6px; border-radius:3px; border:1px solid #222; font-family:sans-serif;">
                    <span style="color:#666;">Sort by:</span>
                    <a href="#" class="sort-trigger" data-sort="anlas" style="color: ${currentSort === "anlas" ? "#00bc8c; font-weight:bold" : "#999"}; text-decoration:none;">Anlas</a> |
                    <a href="#" class="sort-trigger" data-sort="reqs" style="color: ${currentSort === "reqs" ? "#00bc8c; font-weight:bold" : "#999"}; text-decoration:none;">Reqs</a> |
                    <a href="#" class="sort-trigger" data-sort="active" style="color: ${currentSort === "active" ? "#00bc8c; font-weight:bold" : "#999"}; text-decoration:none;">Active</a> |
                    <a href="#" class="sort-trigger" data-sort="status" style="color: ${currentSort === "status" ? "#00bc8c; font-weight:bold" : "#999"}; text-decoration:none;">Status</a>
                </div>

                <div id="vps-client-list" style="font-size:11px;display:flex;flex-direction:column;gap:8px;">
                    Loading system records...
                </div>
            </div>
        `;
      document.getElementById("vps-btn-push-token").onclick = async () => {
        const tk = document.getElementById("vps-master-token-input").value.trim();
        if (!tk)
          return;
        try {
          const res = await backgroundRequest({
            method: "POST",
            url: `${VPS_HOST}/admin/update-token`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
            data: JSON.stringify({ master_token: tk })
          });
          if (res.status === 200)
            alert("Master Token saved securely.");
          else
            alert("Token registration denied.");
        } catch (e) {
          alert("Communication execution failed.");
        }
      };
      modal.querySelectorAll(".sort-trigger").forEach((el) => {
        el.onclick = (e) => {
          e.preventDefault();
          const targetSort = e.currentTarget.getAttribute("data-sort");
          currentSort = targetSort;
          GM_setValue("admin_sort_mode", targetSort);
          renderAdminUI();
        };
      });
      try {
        const res = await backgroundRequest({
          method: "GET",
          url: `${VPS_HOST}/admin/devices`,
          headers: { "Authorization": `Bearer ${deviceSecret}` }
        });
        if (res.status === 200) {
          let groups = JSON.parse(res.responseText);
          const container = document.getElementById("vps-client-list");
          if (groups.length === 0) {
            container.innerHTML = "No clients pending registration.";
            return;
          }
          groups.sort((a, b) => {
            if (currentSort === "anlas") {
              return b.anlas_consumed - a.anlas_consumed;
            } else if (currentSort === "reqs") {
              return b.total_requests - a.total_requests;
            } else if (currentSort === "active") {
              return b.last_active_at - a.last_active_at;
            } else if (currentSort === "status") {
              return (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0);
            }
            return 0;
          });
          container.innerHTML = "";
          groups.forEach((group) => {
            const selectorId = group.discord_id || group.devices[0].browser_id;
            const isLinked = !!group.discord_id;
            const isExpanded = expandedKeys.has(selectorId);
            const el = document.createElement("div");
            el.style.cssText = "background:#222; border-radius:4px; border:1px solid #333; overflow:hidden; display:flex; flex-direction:column; transition: border-color 0.2s;";
            if (group.banned === 1) {
              el.style.borderColor = "#c0392b";
            }
            const statusDotColor = group.is_online ? "#2ecc71" : "#7f8c8d";
            const statusTitle = group.is_online ? "Online" : "Offline";
            const bannedBadge = group.banned === 1 ? `<span style="background:#c0392b; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px; letter-spacing:0.5px;">BANNED</span>` : "";
            let headerDebugBadge = "";
            if (group.has_debug_authorized) {
              headerDebugBadge = `<span style="background:#27ae60; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG ACTIVE</span>`;
            } else if (group.has_debug_intent) {
              headerDebugBadge = `<span style="background:#e67e22; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG REQUESTED</span>`;
            }
            el.innerHTML = `
                        <div class="client-card-header" data-key="${selectorId}" style="padding:12px; cursor:pointer; display:flex; align-items:center; justify-content:space-between; background:#1e1e1e; user-select:none;">
                            <div style="display:flex; align-items:center; gap:8px; max-width:60%;">
                                <div style="width:7px; height:7px; border-radius:50%; background:${statusDotColor};" title="${statusTitle}"></div>
                                <span style="font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fff;">${group.discord_username}</span>
                                ${bannedBadge}
                                ${headerDebugBadge}
                            </div>
                            <div style="font-size:10px; color:#aaa; display:flex; gap:10px; align-items:center;">
                                <span style="color:#00bc8c; font-weight:bold;">${group.anlas_consumed}A</span>
                                <span style="color:#3498db; font-weight:bold;">${group.total_requests}R</span>
                                <span style="font-size:8px; color:#555;">${isExpanded ? "\u25B2" : "\u25BC"}</span>
                            </div>
                        </div>
                    `;
            if (isExpanded) {
              const body = document.createElement("div");
              body.style.cssText = "padding:12px; border-top:1px solid #333; background:#252525; display:flex; flex-direction:column; gap:10px;";
              let devicesHtml = "";
              group.devices.forEach((d) => {
                const devOnlineColor = d.is_online ? "#2ecc71" : "#7f8c8d";
                const devBannedBadge = d.banned === 1 ? `<span style="color:#e74c3c; font-weight:bold; margin-left:4px;">(BANNED)</span>` : "";
                const allowanceBadge = d.metered_allowance !== null ? `<span style="color:#f39c12; font-weight:bold; margin-left:6px;">[${d.metered_allowance}/100 Imgs]</span>` : "";
                let devDebugBadge = "";
                let devDebugBtn = "";
                if (d.debug_authorized) {
                  const minsLeft = (d.debug_expires_in_ms / 6e4).toFixed(1);
                  devDebugBadge = `<span style="background:#27ae60; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">DEBUG ACTIVE (${minsLeft}m)</span>`;
                  devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="disarm" style="background:#e67e22; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">DISARM</button>`;
                } else if (d.debug_intent) {
                  devDebugBadge = `<span style="background:#e74c3c; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">\u26A0\uFE0F DEBUG REQUESTED</span>`;
                  devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="arm" style="background:#2980b9; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">AUTHORIZE (10M)</button>`;
                }
                devicesHtml += `
                                <div style="font-size:10px; color:#ccc; padding:6px 0; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                                    <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1;">
                                        <div style="width:5px; height:5px; border-radius:50%; background:${devOnlineColor};"></div>
                                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>${d.label}</strong> ${devBannedBadge}${allowanceBadge}${devDebugBadge} <code style="color:#666;">(${d.browser_id.substring(0, 8)}...)</code></span>
                                    </div>
                                    <div style="display:flex; gap:4px; align-items:center;">
                                        ${devDebugBtn}
                                        <button class="btn-prune-dev" data-id="${d.browser_id}" style="background:#8e44ad; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">PRUNE</button>
                                    </div>
                                </div>
                            `;
              });
              const lastActiveDate = group.last_active_at > 0 ? new Date(group.last_active_at).toLocaleTimeString() : "Never";
              const banToggleBtn = group.banned === 1 ? `<button class="btn-unban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#27ae60; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">UNBAN USER</button>` : `<button class="btn-ban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#c0392b; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">BAN USER</button>`;
              body.innerHTML = `
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:10px; color:#aaa; margin-bottom:4px;">
                                <div>Tier: <strong style="color:#00bc8c;">${group.priority_tier}</strong></div>
                                <div>Last Active: <strong style="color:#fff;">${lastActiveDate}</strong></div>
                                <div style="grid-column: span 2;">Discord ID: <code style="background:#111; padding:2px 4px; border-radius:2px; color:#888;">${group.discord_id || "Unlinked"}</code></div>
                            </div>

                            <div style="background:#1a1a1a; padding:8px; border-radius:3px; border:1px solid #333;">
                                <div style="font-weight:bold; font-size:9px; color:#555; text-transform:uppercase; margin-bottom:5px;">Hardware Footprints</div>
                                ${devicesHtml || '<div style="color:#666; font-style:italic; font-size:10px;">No hardware linked.</div>'}
                            </div>

                            <div style="display:flex; gap:6px; margin-top:4px;">
                                <select id="tier-select-${selectorId}" style="background:#111; border:1px solid #444; color:#fff; font-size:10px; padding:4px 6px; border-radius:3px;">
                                    <option value="Metered" ${group.priority_tier === "Metered" ? "selected" : ""}>Metered</option>
                                    <option value="Low" ${group.priority_tier === "Low" ? "selected" : ""}>Low</option>
                                    <option value="Normal" ${group.priority_tier === "Normal" ? "selected" : ""}>Normal</option>
                                    <option value="High" ${group.priority_tier === "High" ? "selected" : ""}>High</option>
                                    <option value="Admin" ${group.priority_tier === "Admin" ? "selected" : ""}>Admin</option>
                                </select>
                                <button class="btn-approve-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#2980b9; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">APPROVE & SET</button>
                                <button class="btn-revoke-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#7f8c8d; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">REVOKE</button>
                                ${banToggleBtn}
                            </div>
                        `;
              el.appendChild(body);
            }
            container.appendChild(el);
          });
          container.querySelectorAll(".client-card-header").forEach((h) => {
            h.onclick = (e) => {
              const key = e.currentTarget.getAttribute("data-key");
              if (expandedKeys.has(key)) {
                expandedKeys.delete(key);
              } else {
                expandedKeys.add(key);
              }
              renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-toggle-debug").forEach((b) => {
            b.onclick = async (e) => {
              const bid = e.currentTarget.getAttribute("data-id");
              const action = e.currentTarget.getAttribute("data-action");
              const enable = action === "arm";
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/debug-target`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify({ browser_id: bid, enable, ttl_ms: 6e5 })
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-approve-group").forEach((b) => {
            b.onclick = async (e) => {
              const target = e.currentTarget;
              const key = target.getAttribute("data-key");
              const isDiscord = target.getAttribute("data-is-discord") === "true";
              const tier = document.getElementById(`tier-select-${key}`).value;
              const payload = isDiscord ? { discord_id: key, priority_tier: tier } : { browser_id: key, priority_tier: tier };
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/approve`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify(payload)
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-revoke-group").forEach((b) => {
            b.onclick = async (e) => {
              const target = e.currentTarget;
              const key = target.getAttribute("data-key");
              const isDiscord = target.getAttribute("data-is-discord") === "true";
              if (!confirm(`Are you sure you want to revoke authorization for ${key}?`))
                return;
              const payload = isDiscord ? { discord_id: key } : { browser_id: key };
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/revoke`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify(payload)
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-ban-group").forEach((b) => {
            b.onclick = async (e) => {
              const target = e.currentTarget;
              const key = target.getAttribute("data-key");
              const isDiscord = target.getAttribute("data-is-discord") === "true";
              const reason = prompt("Enter a reason for banning this client:");
              if (reason === null)
                return;
              const payload = isDiscord ? { discord_id: key, reason } : { browser_id: key, reason };
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/ban`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify(payload)
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-unban-group").forEach((b) => {
            b.onclick = async (e) => {
              const target = e.currentTarget;
              const key = target.getAttribute("data-key");
              const isDiscord = target.getAttribute("data-is-discord") === "true";
              const payload = isDiscord ? { discord_id: key } : { browser_id: key };
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/unban`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify(payload)
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
          container.querySelectorAll(".btn-prune-dev").forEach((b) => {
            b.onclick = async (e) => {
              const bid = e.currentTarget.getAttribute("data-id");
              if (!confirm(`Are you sure you want to permanently delete device registration: ${bid}?`))
                return;
              const actionRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/admin/prune-device`,
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                data: JSON.stringify({ browser_id: bid })
              });
              if (actionRes.status === 200)
                renderAdminUI();
            };
          });
        }
      } catch (e) {
        document.getElementById("vps-client-list").innerHTML = "Error retrieving system data records.";
      }
    }
    async function openSettingsModal() {
      let modal = document.getElementById("vps-settings-modal");
      let backdrop = document.getElementById("vps-settings-backdrop");
      if (modal) {
        modal.remove();
        if (backdrop)
          backdrop.remove();
        return;
      }
      backdrop = document.createElement("div");
      backdrop.id = "vps-settings-backdrop";
      backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:99998;";
      backdrop.onclick = () => {
        modal.remove();
        backdrop.remove();
      };
      document.documentElement.appendChild(backdrop);
      modal = document.createElement("div");
      modal.id = "vps-settings-modal";
      modal.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); width:90vw; max-width:420px; background:#1c1c1c; border:1px solid #c0392b; border-radius:6px; z-index:99999; color:#fff; padding:25px; font-family:sans-serif; box-shadow:0 10px 40px rgba(0,0,0,0.6); max-height:90vh; overflow-y:auto; box-sizing:border-box;";
      const nickname = GM_getValue("device_nickname", "Admin");
      const domain = GM_getValue("vps_host", "");
      const debugActive = GM_getValue("debug_mode", false);
      const imageCount = GM_getValue("count_image_gens", 0);
      const textCount = GM_getValue("count_text_gens", 0);
      let preciseLimit = "Unlimited";
      let anlasConsumed = 0;
      let linkedDevicesList = "";
      let sessionStatus = "Exempt (Unlimited)";
      try {
        const res = await backgroundRequest({
          method: "GET",
          url: `${domain}/auth/status?browser_id=${browserId}`,
          headers: { "Authorization": `Bearer ${deviceSecret}` }
        });
        if (res.status === 200) {
          const data = JSON.parse(res.responseText);
          anlasConsumed = data.anlas_consumed || 0;
          preciseLimit = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} Refs`;
          if (data.session) {
            const allowance = data.session.allowance;
            const maxAllowance = data.session.max || 100;
            const refillInMins = (data.session.next_refill_in / 1e3 / 60).toFixed(1);
            const refillText = allowance < maxAllowance ? `(+1 image in ${refillInMins}m)` : "(Fully Charged)";
            sessionStatus = `<span style="color:#2ecc71; font-weight:bold;">${allowance}/${maxAllowance} Images</span> <span style="font-size:10px; color:#aaa;">${refillText}</span>`;
          } else {
            sessionStatus = `<span style="color:#00bc8c; font-weight:bold;">Exempt (Unlimited)</span>`;
          }
          if (data.linked_devices && data.linked_devices.length > 0) {
            linkedDevicesList = data.linked_devices.map((d) => `- \`${d.id.substring(0, 10)}...\` (${d.label})`).join("<br>");
          } else {
            linkedDevicesList = "No other active links.";
          }
        }
      } catch (e) {
      }
      modal.innerHTML = `
            <h4 style="margin:0 0 15px 0; color:#00bc8c; border-bottom:1px solid #333; padding-bottom:8px; font-size:16px; font-family:sans-serif;">GATEWAY SETTINGS</h4>
            
            <div style="background:#111; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #333; font-size:12px; line-height:1.6; font-family:sans-serif;">
                <label style="display:block; font-size:10px; color:#888; font-weight:bold; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Telemetry Stats & Profile</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div>Assigned Tier: <span style="color:#00bc8c; font-weight:bold;">Admin</span></div>
                    <div>Precise Ref Limit: <span style="color:#f39c12; font-weight:bold;">${preciseLimit}</span></div>
                    <div>Anlas Consumed: <span style="color:#e74c3c; font-weight:bold;">${anlasConsumed} Anlas</span></div>
                    <div>Rolling Allowance: <span style="font-weight:bold;">${sessionStatus}</span></div>
                    <div>Image Gens: <span style="font-weight:bold;">${imageCount}</span></div>
                    <div>Text Gens: <span style="font-weight:bold;">${textCount}</span></div>
                </div>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px; font-family:sans-serif;">NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-nickname" value="${nickname}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-nickname" style="background:#27ae60; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Save</button>
                </div>
                <div id="settings-nickname-status" style="font-size:10px; margin-top:3px; display:none; font-family:sans-serif;"></div>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px; font-family:sans-serif;">VPS DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-domain" value="${domain}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-domain" style="background:#2980b9; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; white-space:nowrap; font-family:sans-serif;">Save & Reset</button>
                </div>
            </div>

            <div style="background:#111; padding:12px; border-radius:4px; margin-bottom:15px; border:1px solid #333; font-size:11px; font-family:sans-serif;">
                <label style="display:block; font-size:10px; color:#888; font-weight:bold; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Hardware Footprints Linked (Max 3)</label>
                <div style="color:#ccc; font-family:monospace; line-height:1.4;">
                    ${linkedDevicesList}
                </div>
            </div>

            <div style="border-top:1px solid #333; padding-top:12px; margin-top:12px; font-family:sans-serif;">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; font-weight:bold; color:#f39c12;">
                    <input type="checkbox" id="settings-debug" ${debugActive ? "checked" : ""} style="cursor:pointer;">
                    ENABLE DEBUG MODE
                </label>
                <div id="debug-consent" style="font-size:11px; color:#999; margin-top:6px; line-height:1.4; background:#222; padding:8px; border-radius:4px; border-left:2px solid #f39c12;">
                    <strong>Consent Form:</strong> Enabling Debug Mode will log full API request payloads (including prompt texts and image inputs) to the VPS log telemetry. Your NovelAI authorization token and personal account credentials will <strong>NOT</strong> be logged.
                </div>
            </div>
        `;
      document.documentElement.appendChild(modal);
      const nickInput = modal.querySelector("#settings-nickname");
      const saveNickBtn = modal.querySelector("#btn-save-nickname");
      const nickStatus = modal.querySelector("#settings-nickname-status");
      const domInput = modal.querySelector("#settings-domain");
      const saveDomBtn = modal.querySelector("#btn-save-domain");
      const debugCheckbox = modal.querySelector("#settings-debug");
      saveNickBtn.onclick = async () => {
        const newNickname = nickInput.value.trim();
        if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
          nickStatus.style.display = "block";
          nickStatus.style.color = "#e74c3c";
          nickStatus.innerHTML = "\u2717 Invalid nickname characters.";
          return;
        }
        nickStatus.style.display = "block";
        nickStatus.style.color = "#f39c12";
        nickStatus.innerHTML = "Updating nickname...";
        try {
          const res = await backgroundRequest({
            method: "POST",
            url: `${domain}/auth/update-label`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
            data: JSON.stringify({ browser_id: browserId, label: newNickname })
          });
          if (res.status === 200) {
            nickStatus.style.color = "#2ecc71";
            nickStatus.innerHTML = "\u2713 Nickname updated successfully!";
            GM_setValue("device_nickname", newNickname);
          } else {
            throw new Error("Update failed");
          }
        } catch (err) {
          nickStatus.style.color = "#e74c3c";
          nickStatus.innerHTML = "\u2717 Failed to update nickname on VPS.";
        }
      };
      saveDomBtn.onclick = () => {
        let val = domInput.value.trim().replace(/\/+$/, "");
        if (!val)
          return;
        if (!/^https?:\/\//i.test(val))
          val = "https://" + val;
        GM_setValue("vps_host", val);
        GM_setValue("approved", false);
        modal.remove();
        backdrop.remove();
        window.location.reload();
      };
      debugCheckbox.onchange = () => {
        const checked = debugCheckbox.checked;
        GM_setValue("debug_mode", checked);
        if (checked)
          injectWarningBadge("\u26A0\uFE0F VPS DEBUG MODE ACTIVE", "#e74c3c");
        else
          removeWarningBadge();
      };
    }
    setInterval(injectGearButton, 1e3);
  }
})();
