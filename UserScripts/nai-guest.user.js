// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Guest)
// @namespace    http://tampermonkey.net/
// @version      4.4.0
// @description  FIFO queue coordination, rolling allowance telemetry visualization, and background stream proxy pipeline
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      duckdns.org
// @updateURL    https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
// @downloadURL  https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
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

  // src/userscripts/shared/assets/guild_badge.svg
  var guild_badge_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path fill="#fff" fill-rule="evenodd" stroke="#fff" stroke-linejoin="round" stroke-width=".3" d="M589 267a313 313 0 0 1 200 158l7 14c10-8 16-24 24-34 17-25 42-64 67-82 18-13 37-29 61-20 24 10 29 41 32 63 6 37-2 82-19 115q-12 19-26 37c37 8 40 36 35 70-9 54-39 83-86 106 7 8 16 12 20 22 20 51-31 79-72 85-16 3-59-7-74-14q-10-6-21-9a319 319 0 0 1-454-1c-10 1-20 9-29 12-35 10-68 17-104 4-37-14-61-75-18-98-3-5-12-6-16-9l-27-19c-27-22-48-70-43-104 2-14 2-29 16-39q10-5 20-6c-5-12-17-21-22-33l-10-23c-13-25-15-80-10-107 6-29 21-60 56-54 19 4 34 19 47 32 32 32 52 73 80 107 10-9 14-27 23-39 17-24 37-52 62-70 26-19 51-39 82-51 9-4 36-9 42-14a95 95 0 0 1-10-63c15-78 123-94 164-28 10 15 18 41 13 59-2 11-9 22-10 33Zm-17-5c8-10 11-26 11-38 0-64-76-102-123-55q-12 10-17 24-8 16-6 35 2 18 11 34c5 1 14-2 19-3l33-3c24-3 48 6 72 6Zm-78 47-41 5-46 15a272 272 0 0 0-157 189 268 268 0 0 0 365 302c58-22 116-82 138-139l6-13q10-35 16-71c4-22 0-48-4-68l-10-42c-4-13-11-30-19-41q-5-8-10-18l-15-19c-28-38-71-66-114-83-29-11-78-23-109-17ZM216 459q-13-18-25-37-30-45-68-85c-12-12-38-32-54-13-14 18-15 44-15 66 0 68 33 121 87 160 13 10 39 32 55 33 4-20 0-41 3-61l9-40zm608 110c15-1 32-12 44-20 57-36 94-79 96-149 1-21 2-72-23-82-25-9-54 27-68 43l-50 68c-5 8-15 18-19 27-1 5 9 30 11 37q6 26 9 54zM512 324q7-2 10 7 2 22 0 46c0 6 1 14-6 15-16 2-10-42-10-53 0-5 0-13 6-15Zm-125 34c6-1 9 6 12 10l22 38q6 8-1 15-7 2-11-4c-5-8-26-42-28-49q-1-8 6-10Zm266 13q11-1 11 10c-2 6-28 42-33 48-2 2-9 2-11 0-5-3-2-10 1-14l24-33q3-8 8-11Zm-156 53q20-3 37 2c69 12 111 62 122 129q3 14 1 30c-12 75-60 122-135 134q-29 3-57-7c-73-25-114-100-99-175 9-46 46-82 86-102 14-7 31-8 45-11Zm6 17q-19 1-39 7c-40 16-74 53-83 96a134 134 0 0 0 138 159q106-16 122-121 1-12-1-23l-2-19c-11-51-59-90-108-98q-14-3-27-1Zm-215 23c8-3 46 18 54 23q7 4 4 12c-2 6-10 4-14 2q-23-10-44-23c-5-3-8-12 0-14Zm450 17c7-1 12 7 8 12-5 7-38 20-47 23q-9 5-14-3-2-8 7-12c13-5 33-18 46-20Zm58 211q19 3 38-1c53-8 105-38 118-95q7-22 3-45c-3-15-23-21-36-17-6 2-24 18-30 22-17 13-43 26-65 30-7 36-8 74-28 106Zm-572 1c-7-20-17-40-21-61-1-5-3-27-5-30-5-4-15-6-21-9q-24-14-47-31c-17-12-27-32-50-27q-6 1-11 5c-13 13-6 45-2 61 13 52 65 82 114 90 12 2 31 6 43 2Zm80-106c7-1 34 3 18 15-6 4-40 3-48 3-5 0-13 1-15-4-5-17 35-12 45-14Zm395 0c8-1 49 1 58 3 3 1 5 7 4 10-1 7-10 5-15 5q-24 2-47-3c-6-2-6-13 0-15Zm-36 86c7-3 39 20 46 26 3 3 12 8 9 14q-4 6-9 5-6-2-11-8c-8-5-33-18-38-25-2-3-2-11 3-12Zm-311 4c6-2 13 5 10 11-3 8-33 27-41 33-3 3-9 7-13 3q-7-5-1-12c4-5 40-33 45-35Zm-120 32c-18 4-40 1-58-2-5-1-13-5-19-4-22 4-33 24-29 44 4 16 21 28 35 32 27 9 88 3 110-15q-15-15-26-34-6-10-13-21Zm518 56c7 8 25 11 35 13 32 8 80 13 100-21q5-7 7-14c4-20-12-37-30-40-8-1-39 6-51 7-6 0-17 2-22-1zm-153-34c8-2 10 6 13 11l20 36c3 4 5 13-1 15q-9 2-13-7c-6-12-22-35-25-47q-1-7 6-8Zm-174 3q11 0 10 11c-2 8-17 35-23 42-4 6-5 13-13 10q-7-4-3-12 9-20 20-38c2-4 5-12 9-13Zm89 22q7 1 9 7 2 23 0 47c0 6 1 14-7 15s-8-7-8-13v-41c0-4-1-15 6-15Z"/></svg>';

  // src/userscripts/shared/domEngine.js
  var classCache = /* @__PURE__ */ new Map();
  function getElementClasses(el, cacheKey) {
    if (el && el.className && typeof el.className === "string") {
      const trimmed = el.className.trim();
      if (trimmed) {
        classCache.set(cacheKey, trimmed);
        return trimmed;
      }
    }
    return classCache.get(cacheKey) || "";
  }
  function injectNavBadge(onClickHandler) {
    if (document.getElementById("gw-nav-badge"))
      return true;
    const menuBtn = document.querySelector('button[aria-label="menu"]');
    if (!menuBtn || !menuBtn.parentElement)
      return false;
    const btnClasses = getElementClasses(menuBtn, "nav_menu_btn");
    const badgeBtn = document.createElement("button");
    badgeBtn.id = "gw-nav-badge";
    badgeBtn.className = btnClasses;
    badgeBtn.setAttribute("aria-label", "GuildWeave Gateway Settings");
    badgeBtn.setAttribute("title", "GuildWeave Gateway Settings");
    badgeBtn.style.marginRight = "8px";
    badgeBtn.style.cursor = "pointer";
    const innerDiv = document.createElement("div");
    innerDiv.style.cssText = "display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; pointer-events: none;";
    innerDiv.innerHTML = guild_badge_default;
    const svgEl = innerDiv.querySelector("svg");
    if (svgEl) {
      svgEl.setAttribute("width", "30");
      svgEl.setAttribute("height", "30");
      svgEl.style.width = "30px";
      svgEl.style.height = "30px";
      svgEl.style.display = "block";
      svgEl.style.margin = "-2px -8px 0 -7px";
    }
    badgeBtn.appendChild(innerDiv);
    badgeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onClickHandler === "function") {
        onClickHandler();
      }
    };
    menuBtn.parentElement.insertBefore(badgeBtn, menuBtn);
    return true;
  }
  function injectAllowanceBar() {
    if (document.getElementById("gw-allowance-bar"))
      return true;
    const genBtn = document.querySelector(".image-gen-generate-button");
    if (!genBtn || !genBtn.parentElement)
      return false;
    const barRoot = document.createElement("div");
    barRoot.id = "gw-allowance-bar";
    barRoot.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px 8px 7px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, rgb(34, 37, 63));
    background-color: var(--theme-bg0, rgb(14, 15, 33));
    font-size: 0.8125rem;
    font-weight: 600;
    margin-bottom: 0px;
    box-sizing: border-box;
  `.replace(/\s+/g, " ").trim();
    const headerRow = document.createElement("div");
    headerRow.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  `.replace(/\s+/g, " ").trim();
    const labelSpan = document.createElement("span");
    labelSpan.id = "gw-allowance-label";
    labelSpan.style.cssText = `
    flex: 0 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--theme-text, rgb(245, 243, 194));
    font-size: 0.75rem;
    font-weight: 600;
  `.replace(/\s+/g, " ").trim();
    labelSpan.textContent = "Rolling Allowance: --/100 Images";
    headerRow.appendChild(labelSpan);
    const trackDiv = document.createElement("div");
    trackDiv.style.cssText = `
    height: 4px;
    width: 100%;
    background: var(--theme-bg2, rgba(255, 255, 255, 0.1));
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  `.replace(/\s+/g, " ").trim();
    const fillDiv = document.createElement("div");
    fillDiv.id = "gw-allowance-fill";
    fillDiv.style.cssText = `
    height: 100%;
    width: 100%;
    background-color: var(--theme-success, #2ecc71);
    border-radius: 2px;
    transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;
  `.replace(/\s+/g, " ").trim();
    trackDiv.appendChild(fillDiv);
    barRoot.appendChild(headerRow);
    barRoot.appendChild(trackDiv);
    genBtn.parentElement.insertBefore(barRoot, genBtn);
    return true;
  }
  function updateAllowanceBar(allowance, maxAllowance, nextRefillMs = 0) {
    injectAllowanceBar();
    const labelSpan = document.getElementById("gw-allowance-label");
    const fillDiv = document.getElementById("gw-allowance-fill");
    if (!labelSpan || !fillDiv)
      return;
    if (allowance === null || maxAllowance === Infinity) {
      labelSpan.textContent = "Rolling Allowance: Exempt (Unlimited)";
      fillDiv.style.width = "100%";
      fillDiv.style.backgroundColor = "var(--theme-accent, #00bc8c)";
      return;
    }
    const max = maxAllowance || 100;
    const clampedAllowance = Math.max(0, allowance);
    const percent = Math.min(100, Math.max(0, clampedAllowance / max * 100));
    let refillSuffix = "";
    if (clampedAllowance < max && nextRefillMs > 0) {
      const mins = (nextRefillMs / 6e4).toFixed(1);
      refillSuffix = ` (+1 in ${mins}m)`;
    } else if (clampedAllowance >= max) {
      refillSuffix = " (Full)";
    }
    labelSpan.textContent = `Rolling Allowance: ${clampedAllowance}/${max} Images${refillSuffix}`;
    fillDiv.style.width = `${percent}%`;
    if (percent < 20) {
      fillDiv.style.backgroundColor = "var(--theme-error, #e74c3c)";
    } else if (percent < 50) {
      fillDiv.style.backgroundColor = "var(--theme-warning, #f39c12)";
    } else {
      fillDiv.style.backgroundColor = "var(--theme-success, #2ecc71)";
    }
  }
  function injectQueueShield() {
    const genBtn = document.querySelector(".image-gen-generate-button");
    if (!genBtn)
      return false;
    if (document.getElementById("gw-button-shield"))
      return true;
    genBtn.style.position = "relative";
    genBtn.style.overflow = "hidden";
    const shield = document.createElement("div");
    shield.id = "gw-button-shield";
    shield.style.cssText = `
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 9999 !important;
    box-sizing: border-box !important;
    margin: 0 !important;
    background: var(--theme-bg1, rgb(24, 26, 46)) !important;
    border-radius: inherit !important;
    border: 1px solid var(--theme-accent, #00bc8c) !important;
    cursor: wait !important;
    display: none;
    pointer-events: none;
    align-items: center;
    justify-content: center;
    opacity: 1 !important;
  `.replace(/\s+/g, " ").trim();
    const pulseIndicator = document.createElement("div");
    pulseIndicator.style.cssText = "width:8px; height:8px; border-radius:50%; background:var(--theme-accent, #00bc8c); margin-right:8px; animation:gwPulse 1s infinite alternate; flex-shrink:0;";
    const labelText = document.createElement("span");
    labelText.id = "gw-shield-text";
    labelText.style.cssText = "font-weight:bold; font-size:13px; color:var(--theme-textHeadings, #fff); white-space:nowrap; letter-spacing:0.5px;";
    labelText.textContent = "Queue Slot Active...";
    shield.appendChild(pulseIndicator);
    shield.appendChild(labelText);
    genBtn.appendChild(shield);
    return true;
  }
  function setQueueShieldState(active, text = "") {
    injectQueueShield();
    const shield = document.getElementById("gw-button-shield");
    const labelText = document.getElementById("gw-shield-text");
    if (!shield || !labelText)
      return;
    const genBtn = shield.parentElement;
    if (genBtn) {
      for (const child of genBtn.children) {
        if (child !== shield) {
          child.style.visibility = active ? "hidden" : "";
        }
      }
    }
    if (active) {
      labelText.textContent = text || "Processing Queue...";
      shield.style.display = "flex";
      shield.style.pointerEvents = "all";
    } else {
      shield.style.display = "none";
      shield.style.pointerEvents = "none";
    }
  }
  var observerInstance = null;
  var rafScheduled = false;
  function initDOMObserver(options = {}) {
    if (observerInstance)
      observerInstance.disconnect();
    const runSync = () => {
      rafScheduled = false;
      injectNavBadge(options.onOpenSettings);
      injectAllowanceBar();
      injectQueueShield();
    };
    observerInstance = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.target && m.target.id && m.target.id.startsWith("gw-"))
          continue;
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          relevant = true;
          break;
        }
      }
      if (relevant && !rafScheduled) {
        rafScheduled = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(runSync);
        } else {
          setTimeout(runSync, 16);
        }
      }
    });
    const root = document.body || document.documentElement;
    if (root) {
      observerInstance.observe(root, { childList: true, subtree: true });
    }
    runSync();
  }

  // src/userscripts/shared/ui.js
  function showQueueStatusBanner(text) {
    setQueueShieldState(true, text);
  }
  function hideQueueStatusBanner() {
    setQueueShieldState(false, "");
  }
  function injectWarningBadge(message, bgColor) {
    if (document.getElementById("vps-debug-badge"))
      return;
    const badge = document.createElement("div");
    badge.id = "vps-debug-badge";
    badge.innerHTML = message;
    badge.style.cssText = `position:fixed; top:10px; left:50%; transform:translateX(-50%); background:${bgColor}; color:#fff; font-weight:bold; font-size:11px; padding:6px 12px; border-radius:4px; z-index:99999; box-shadow:0 2px 8px rgba(0,0,0,0.4); pointer-events:none; font-family:sans-serif;`;
    const root = document.body || document.documentElement;
    if (root)
      root.appendChild(badge);
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

  // src/userscripts/guest/index.js
  console.log("Nai-Guest: Script injected successfully at document-start.");
  var browserId = GM_getValue("browser_id");
  var deviceSecret = GM_getValue("device_secret");
  var approved = GM_getValue("approved", false);
  var VPS_HOST = GM_getValue("vps_host", "");
  try {
    if (!browserId || !deviceSecret) {
      browserId = "b_" + generateUUID();
      deviceSecret = "s_" + generateUUID();
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
  var enforcementInterval = null;
  function startUIEnforcement() {
    if (enforcementInterval)
      return;
    console.log("Nai-Guest: Starting high-frequency UI enforcement loop...");
    enforcementInterval = setInterval(() => {
      if (!document.body)
        return;
      let overlay = document.getElementById("vps-approval-overlay");
      if (!overlay) {
        console.log("Nai-Guest: UI overlay was missing or deleted by React. Re-injecting...");
        overlay = document.createElement("div");
        overlay.id = "vps-approval-overlay";
        overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:var(--theme-bg0, #121212) !important; color:var(--theme-text, #fff) !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:inherit !important;";
        document.body.appendChild(overlay);
        renderSetupWizard(overlay);
      }
    }, 50);
  }
  function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card"))
      return;
    container.innerHTML = `
        <div class="setup-wizard-card" style="background:var(--theme-bg1, #1c1c1c); padding:35px; border-radius:8px; border:1px solid var(--theme-error, #c0392b); box-shadow:0 8px 30px rgba(0,0,0,0.6); max-width:90vw; width:420px; box-sizing:border-box; color:var(--theme-text, #fff); font-family:inherit;">
            <h3 style="margin:0 0 15px 0; color:var(--theme-accent, #00bc8c); text-align:center; letter-spacing:1px; font-size:18px;">GATEWAY COORDINATOR SETUP</h3>
            
            <!-- Gateway Domain Configuration -->
            <div id="step-1-container" style="margin-bottom:20px;">
                <label style="display:block; font-size:12px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">STEP 1: ENTER GATEWAY DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-domain" value="${GM_getValue("vps_host", "")}" placeholder="https://your-domain.duckdns.org" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:12px; border-radius:4px; font-family:inherit;">
                    <button id="btn-verify-domain" style="background:#2980b9; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Verify</button>
                </div>
                <div id="step-1-status" style="margin-top:5px; font-size:11px; display:none;"></div>
            </div>

            <!-- Nickname Configuration -->
            <div id="step-2-container" style="margin-bottom:20px; display:none;">
                <label style="display:block; font-size:12px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">STEP 2: ENTER NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-nickname" value="${GM_getValue("device_nickname", "")}" placeholder="e.g. Guest" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:12px; border-radius:4px; font-family:inherit;">
                    <button id="btn-register-nickname" style="background:var(--theme-success, #27ae60); border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Register</button>
                </div>
                <div id="step-2-status" style="margin-top:5px; font-size:11px; display:none;"></div>
            </div>

            <!-- Instructions & Background Verification -->
            <div id="step-3-container" style="display:none; border-top:1px solid var(--theme-bg2, #333); padding-top:15px; margin-top:15px;">
                <label style="display:block; font-size:12px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">STEP 3: CONFIGURATION COMPLETE</label>
                <div id="step-3-content" style="font-size:12px; color:var(--theme-textSecondary, #bbb); line-height:1.5;"></div>
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
        step1Status.style.color = "var(--theme-error, #e74c3c)";
        step1Status.innerHTML = "\u2717 Domain cannot be empty.";
        return;
      }
      if (!/^https?:\/\//i.test(val)) {
        val = "https://" + val;
      }
      step1Status.style.display = "block";
      step1Status.style.color = "var(--theme-warning, #f39c12)";
      step1Status.innerHTML = "Connecting to server...";
      try {
        const res = await backgroundRequest({
          method: "GET",
          url: `${val}/auth/status?browser_id=ping`
        });
        if (res.status > 0) {
          step1Status.style.color = "var(--theme-success, #2ecc71)";
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
        step1Status.style.color = "var(--theme-error, #e74c3c)";
        step1Status.innerHTML = "\u2717 Connection failed. Ensure domain is correct and reachable.";
      }
    }
    async function registerNicknameAction() {
      const newNickname = nicknameInput.value.trim();
      if (!newNickname) {
        step2Status.style.display = "block";
        step2Status.style.color = "var(--theme-error, #e74c3c)";
        step2Status.innerHTML = "\u2717 Nickname cannot be empty.";
        return;
      }
      if (!/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
        step2Status.style.display = "block";
        step2Status.style.color = "var(--theme-error, #e74c3c)";
        step2Status.innerHTML = "\u2717 Nickname cannot contain special characters.";
        return;
      }
      step2Status.style.display = "block";
      step2Status.style.color = "var(--theme-warning, #f39c12)";
      step2Status.innerHTML = "Registering device...";
      try {
        const res = await backgroundRequest({
          method: "POST",
          url: `${validatedHost}/auth/register`,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: newNickname })
        });
        if (res.status === 200) {
          step2Status.style.color = "var(--theme-success, #2ecc71)";
          step2Status.innerHTML = "\u2713 Registered nickname successfully!";
          GM_setValue("device_nickname", newNickname);
          validatedNickname = newNickname;
          nicknameInput.disabled = true;
          registerBtn.disabled = true;
          step3Container.style.display = "block";
          showStep3();
        } else {
          throw new Error("Registration rejected");
        }
      } catch (err) {
        step2Status.style.color = "var(--theme-error, #e74c3c)";
        step2Status.innerHTML = "\u2717 Registration failed on server.";
      }
    }
    function showStep3() {
      step3Content.innerHTML = `
            <p style="margin: 0 0 10px 0; font-weight: bold; color: var(--theme-text, #fff);">Register This Device Natively on Discord:</p>
            <p style="margin: 0 0 10px 0; color: var(--theme-textSecondary, #bbb); line-height: 1.4;">Copy the Browser ID below, navigate to your server, and register using this command:</p>
            <div style="background:var(--theme-bg0, #111); padding:10px; border-radius:4px; font-family:monospace; font-size:11px; word-break:break-all; border:1px solid var(--theme-bg2, #333); margin-bottom:10px; color:var(--theme-warning, #f39c12); text-align:center; font-weight:bold;">
                /link browser_id:${browserId}
            </div>
            <p style="margin:0; color:var(--theme-textSecondary, #888); font-size:11px; text-align:center; animation: vpsFader 1.5s infinite alternate;">\u23F3 Polling approval status from Discord registration...</p>
            <style>@keyframes vpsFader { 0% { opacity: 0.3; } 100% { opacity: 1; } }</style>
        `;
      const checkAuth = async () => {
        try {
          const res = await backgroundRequest({
            method: "GET",
            url: `${validatedHost}/auth/status?browser_id=${browserId}`,
            headers: { "Authorization": `Bearer ${deviceSecret}` }
          });
          if (res.status === 200) {
            const data = JSON.parse(res.responseText);
            if (data.approved) {
              GM_setValue("approved", true);
              window.location.reload();
            }
          } else if (res.status === 401) {
            console.warn("Nai-Guest: Server returned 401 during poll. Re-registering silently...");
            const nickname = GM_getValue("device_nickname", "Guest");
            backgroundRequest({
              method: "POST",
              url: `${validatedHost}/auth/register`,
              headers: { "Content-Type": "application/json" },
              data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
            }).catch((err) => console.error("Nai-Guest: Silent re-registration failed:", err));
          }
        } catch (err) {
          console.error("Setup wizard poll error:", err);
        }
      };
      setInterval(checkAuth, 5e3);
    }
    verifyBtn.onclick = verifyDomainAction;
    registerBtn.onclick = registerNicknameAction;
    if (validatedHost) {
      domainInput.value = validatedHost;
      step1Status.style.display = "block";
      step1Status.style.color = "var(--theme-success, #2ecc71)";
      step1Status.innerHTML = "\u2713 Connected";
      domainInput.disabled = true;
      verifyBtn.disabled = true;
      step2Container.style.display = "block";
      if (validatedNickname) {
        nicknameInput.value = validatedNickname;
        step2Status.style.display = "block";
        step2Status.style.color = "var(--theme-success, #2ecc71)";
        step2Status.innerHTML = "\u2713 Registered";
        nicknameInput.disabled = true;
        registerBtn.disabled = true;
        step3Container.style.display = "block";
        showStep3();
      }
    }
  }
  if (!approved || !VPS_HOST) {
    startUIEnforcement();
  } else {
    let startStatePolling = function() {
      const poll = async () => {
        if (!document.getElementById("gw-allowance-bar"))
          return;
        try {
          const res = await backgroundRequest({
            method: "GET",
            url: `${VPS_HOST}/auth/status?browser_id=${browserId}`,
            headers: { "Authorization": `Bearer ${deviceSecret}` }
          });
          if (res.status === 200) {
            const data = JSON.parse(res.responseText);
            if (data.session) {
              updateAllowanceBar(data.session.allowance, data.session.max, data.session.next_refill_in);
            } else {
              updateAllowanceBar(null, Infinity, 0);
            }
          }
        } catch (e) {
          console.error("Nai-Guest: Failed to poll session state", e);
        }
      };
      setInterval(poll, 1e4);
    }, renderSettingsPanelContent = function(container, onClose) {
      const nickname = GM_getValue("device_nickname", "Guest");
      const domain = GM_getValue("vps_host", "");
      const debugActive = GM_getValue("debug_mode", false);
      const imageCount = GM_getValue("count_image_gens", 0);
      const textCount = GM_getValue("count_text_gens", 0);
      container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--theme-bg2, #333); padding-bottom:10px; margin-bottom:12px;">
                <h4 style="margin:0; color:var(--theme-accent, #00bc8c); font-size:15px; font-weight:bold; letter-spacing:0.5px;">GATEWAY COORDINATOR (GUEST)</h4>
                ${onClose ? `<button id="guest-close-modal-btn" style="background:none; border:none; color:var(--theme-textSecondary, #888); font-size:18px; cursor:pointer; line-height:1;">\u2715</button>` : ""}
            </div>

            <div style="background:var(--theme-bg1, #111); padding:12px; border-radius:6px; margin-bottom:12px; border:1px solid var(--theme-bg2, #333); font-size:11px; line-height:1.6;">
                <label style="display:block; font-size:9px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:6px; text-transform:uppercase;">Guest Telemetry & Profile</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>Assigned Tier: <span id="guest-assigned-tier" style="color:var(--theme-accent, #00bc8c); font-weight:bold;">Loading...</span></div>
                    <div>Precise Ref Limit: <span id="guest-precise-limit" style="color:var(--theme-warning, #f39c12); font-weight:bold;">Loading...</span></div>
                    <div>Anlas Consumed: <span id="guest-anlas-consumed" style="color:var(--theme-error, #e74c3c); font-weight:bold;">0 Anlas</span></div>
                    <div>Rolling Allowance: <span id="guest-rolling-allowance" style="font-weight:bold;">Loading...</span></div>
                    <div>Image Gens: <span style="font-weight:bold;">${imageCount}</span></div>
                    <div>Text Gens: <span style="font-weight:bold;">${textCount}</span></div>
                </div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">NICKNAME</label>
                <div style="display:flex; gap:8px;">
                    <input type="text" id="settings-nickname" value="${nickname}" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:6px; font-size:11px; border-radius:4px; font-family:inherit;">
                    <button id="btn-save-nickname" style="background:var(--theme-success, #27ae60); border:none; color:var(--theme-bg0, #fff); padding:6px 12px; font-size:10px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Save</button>
                </div>
                <div id="settings-nickname-status" style="font-size:10px; margin-top:3px; display:none;"></div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">VPS GATEWAY DOMAIN</label>
                <div style="display:flex; gap:8px;">
                    <input type="text" id="settings-domain" value="${domain}" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:6px; font-size:11px; border-radius:4px; font-family:inherit;">
                    <button id="btn-save-domain" style="background:#2980b9; border:none; color:#fff; padding:6px 12px; font-size:10px; font-weight:bold; cursor:pointer; border-radius:4px; white-space:nowrap; font-family:inherit;">Save & Reset</button>
                </div>
            </div>

            <div style="background:var(--theme-bg1, #111); padding:10px; border-radius:6px; margin-bottom:12px; border:1px solid var(--theme-bg2, #333); font-size:10px;">
                <label style="display:block; font-size:9px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:4px; text-transform:uppercase;">Hardware Footprints Linked (Max 3)</label>
                <div id="guest-linked-devices" style="color:var(--theme-textSecondary, #ccc); font-family:monospace; line-height:1.4;">
                    No other active links.
                </div>
                <div style="font-size:9px; color:var(--theme-textSecondary, #666); margin-top:4px;">Prune unneeded profiles natively inside Discord using \`/mygateway unlink\`.</div>
            </div>

            <div style="border-top:1px solid var(--theme-bg2, #333); padding-top:10px; margin-top:10px; font-size:11px;">
                <label style="display:flex; align-items:center; gap:8px; font-size:11px; cursor:pointer; font-weight:bold; color:var(--theme-warning, #f39c12);">
                    <input type="checkbox" id="settings-debug" ${debugActive ? "checked" : ""} style="cursor:pointer;">
                    ENABLE DIAGNOSTIC PROMPT DEBUGGING
                </label>
                <div id="debug-intent-status" style="margin-top:4px; font-size:10px;">${debugActive ? "\u2713 Intent active. Awaiting admin authorization." : "Disabled"}</div>
                <div id="debug-consent" style="color:var(--theme-textSecondary, #999); margin-top:6px; line-height:1.4; background:var(--theme-bg1, #222); padding:8px; border-radius:4px; border-left:2px solid var(--theme-warning, #f39c12); font-size:10px;">
                    <strong>Privacy transparency:</strong> Enabling debugging uploads raw generation payloads to gateway logs for performance troubleshooting. Text prompt contexts, settings, and resolutions will be saved on the VPS. Personal tokens and encrypted databases remain strictly isolated.
                </div>
            </div>
        `;
      if (onClose) {
        const closeBtn = container.querySelector("#guest-close-modal-btn");
        if (closeBtn)
          closeBtn.onclick = onClose;
      }
      if (domain && deviceSecret) {
        backgroundRequest({
          method: "GET",
          url: `${domain}/auth/status?browser_id=${browserId}`,
          headers: { "Authorization": `Bearer ${deviceSecret}` }
        }).then((res) => {
          if (res.status === 200) {
            const data = JSON.parse(res.responseText);
            const tierEl = container.querySelector("#guest-assigned-tier");
            if (tierEl)
              tierEl.textContent = data.tier || "Normal";
            const refEl = container.querySelector("#guest-precise-limit");
            if (refEl)
              refEl.textContent = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} Refs`;
            const anlasEl = container.querySelector("#guest-anlas-consumed");
            if (anlasEl)
              anlasEl.textContent = `${data.anlas_consumed || 0} Anlas`;
            const sessionEl = container.querySelector("#guest-rolling-allowance");
            if (sessionEl) {
              if (data.session) {
                const allowance = data.session.allowance;
                const maxAllowance = data.session.max || 100;
                const refillInMins = (data.session.next_refill_in / 1e3 / 60).toFixed(1);
                const refillText = allowance < maxAllowance ? `(+1 in ${refillInMins}m)` : "(Full)";
                sessionEl.innerHTML = `<span style="color:var(--theme-success, #2ecc71); font-weight:bold;">${allowance}/${maxAllowance} Images</span> <span style="font-size:9px; color:var(--theme-textSecondary, #aaa);">${refillText}</span>`;
              } else {
                sessionEl.innerHTML = `<span style="color:var(--theme-accent, #00bc8c); font-weight:bold;">Exempt (Unlimited)</span>`;
              }
            }
            const devicesEl = container.querySelector("#guest-linked-devices");
            if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
              devicesEl.innerHTML = data.linked_devices.map((d) => `- \`${d.id.substring(0, 10)}...\` (${d.label})`).join("<br>");
            }
            const debugStatus = container.querySelector("#debug-intent-status");
            if (debugStatus) {
              if (data.debug_authorized) {
                const mins = (data.debug_expires_in_ms / 6e4).toFixed(1);
                debugStatus.innerHTML = `<span style="color:var(--theme-success, #2ecc71); font-weight:bold;">\u{1F7E2} Authorized by Administrator (${mins}m remaining)</span>`;
              } else if (data.debug_intent) {
                debugStatus.innerHTML = `<span style="color:var(--theme-warning, #f39c12); font-weight:bold;">\u23F3 Intent Active. Waiting for Administrator Authorization.</span>`;
              } else {
                debugStatus.innerHTML = `<span style="color:var(--theme-textSecondary, #888);">Disabled</span>`;
              }
            }
          }
        }).catch(() => {
        });
      }
      const nickInput = container.querySelector("#settings-nickname");
      const saveNickBtn = container.querySelector("#btn-save-nickname");
      const nickStatus = container.querySelector("#settings-nickname-status");
      const domInput = container.querySelector("#settings-domain");
      const saveDomBtn = container.querySelector("#btn-save-domain");
      const debugCheckbox = container.querySelector("#settings-debug");
      const debugIntentStatus = container.querySelector("#debug-intent-status");
      saveNickBtn.onclick = async () => {
        const newNickname = nickInput.value.trim();
        if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
          nickStatus.style.display = "block";
          nickStatus.style.color = "var(--theme-error, #e74c3c)";
          nickStatus.innerHTML = "\u2717 Invalid nickname characters.";
          return;
        }
        nickStatus.style.display = "block";
        nickStatus.style.color = "var(--theme-warning, #f39c12)";
        nickStatus.innerHTML = "Updating nickname...";
        try {
          const res = await backgroundRequest({
            method: "POST",
            url: `${domain}/auth/update-label`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
            data: JSON.stringify({ browser_id: browserId, label: newNickname })
          });
          if (res.status === 200) {
            nickStatus.style.color = "var(--theme-success, #2ecc71)";
            nickStatus.innerHTML = "\u2713 Nickname updated successfully!";
            GM_setValue("device_nickname", newNickname);
          } else {
            throw new Error("Update failed");
          }
        } catch (err) {
          nickStatus.style.color = "var(--theme-error, #e74c3c)";
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
        if (typeof onClose === "function")
          onClose();
        window.location.reload();
      };
      debugCheckbox.onchange = async () => {
        const checked = debugCheckbox.checked;
        GM_setValue("debug_mode", checked);
        if (checked)
          injectWarningBadge("\u26A0\uFE0F VPS DEBUG INTENT ACTIVE", "var(--theme-warning, #e67e22)");
        else
          removeWarningBadge();
        debugIntentStatus.style.display = "block";
        debugIntentStatus.style.color = "var(--theme-warning, #f39c12)";
        debugIntentStatus.innerHTML = checked ? "\u23F3 Synchronizing diagnostic debug intent with gateway..." : "\u23F3 Revoking diagnostic debug intent on gateway...";
        try {
          const res = await backgroundRequest({
            method: "POST",
            url: `${domain}/auth/debug-intent`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
            data: JSON.stringify({ browser_id: browserId, enabled: checked })
          });
          if (res.status === 200) {
            const data = JSON.parse(res.responseText);
            if (data.is_authorized) {
              const mins = (data.expires_in_ms / 6e4).toFixed(1);
              debugIntentStatus.style.color = "var(--theme-success, #2ecc71)";
              debugIntentStatus.innerHTML = `\u2713 Authorized by Administrator (${mins}m remaining). Telemetry logging active.`;
            } else if (checked) {
              debugIntentStatus.style.color = "var(--theme-warning, #f39c12)";
              debugIntentStatus.innerHTML = "\u2713 Intent registered on gateway. Awaiting administrator authorization.";
            } else {
              debugIntentStatus.style.color = "var(--theme-textSecondary, #888)";
              debugIntentStatus.innerHTML = "\u2713 Diagnostic debug intent revoked. Logging disabled.";
            }
          } else {
            throw new Error("Synchronization rejected");
          }
        } catch (err) {
          debugIntentStatus.style.color = "var(--theme-error, #e74c3c)";
          debugIntentStatus.innerHTML = "\u2717 Failed to synchronize debug intent with gateway.";
        }
      };
    };
    initInterceptor({
      browserId,
      deviceSecret,
      VPS_HOST,
      logPrefix: "Nai-Guest",
      onRevoked: () => {
        const nickname = GM_getValue("device_nickname", "Guest");
        backgroundRequest({
          method: "POST",
          url: `${VPS_HOST}/auth/register`,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
        }).finally(() => {
          if (typeof window !== "undefined" && window.location) {
            window.location.reload();
          }
        });
      }
    });
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
      backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); backdrop-filter:blur(2px); z-index:99998;";
      backdrop.onclick = () => {
        modal.remove();
        backdrop.remove();
      };
      document.documentElement.appendChild(backdrop);
      modal = document.createElement("div");
      modal.id = "vps-settings-modal";
      modal.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 90vw;
          max-width: 480px;
          background: var(--theme-bg0, rgb(14, 15, 33));
          border: 1px solid var(--theme-bg2, rgb(34, 37, 63));
          border-radius: 8px;
          z-index: 99999;
          color: var(--theme-text, rgb(245, 243, 194));
          padding: 20px;
          font-family: inherit;
          box-shadow: 0 10px 40px rgba(0,0,0,0.7);
          max-height: 85vh;
          overflow-y: auto;
          box-sizing: border-box;
        `.replace(/\s+/g, " ").trim();
      renderSettingsPanelContent(modal, () => {
        modal.remove();
        backdrop.remove();
      });
      document.documentElement.appendChild(modal);
    }
    initDOMObserver({
      onOpenSettings: openSettingsModal
    });
    startStatePolling();
  }
})();
