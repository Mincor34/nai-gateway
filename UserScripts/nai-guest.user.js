// ==UserScript==
// @name         GuildWeave
// @namespace    http://tampermonkey.net/
// @version      6.0.0
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
    console.log(`[GuildWeave Network] Dispatching request to ${details.url}...`);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        headers,
        onload: (r) => {
          console.log(`[GuildWeave Network] Received response status ${r.status} from ${details.url}`);
          resolve(r);
        },
        onerror: (e) => {
          console.error(`[GuildWeave Network] Request error to ${details.url}`, e);
          reject(e);
        }
      });
    });
  }
  function parseResponseHeaders(headerStr) {
    const headers = new Headers();
    if (!headerStr) return headers;
    const lines = headerStr.split(/[\r\n]+/);
    lines.forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return;
      const colonIndex = trimmedLine.indexOf(":");
      if (colonIndex === -1) return;
      const name = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      if (name) {
        if (/^[a-zA-Z0-9!#$%&'*+-.^_`|~]+$/.test(name)) {
          try {
            headers.append(name, value);
          } catch (e) {
            console.error(`[GuildWeave Network] Failed to append header "${name}":`, e);
          }
        } else {
          console.warn(`[GuildWeave Network] Dropping invalid header token: "${name}"`);
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
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  // src/userscripts/shared/assets/guild_badge.svg
  var guild_badge_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path fill="#fff" fill-rule="evenodd" stroke="#fff" stroke-linejoin="round" stroke-width=".3" d="M589 267a313 313 0 0 1 200 158l7 14c10-8 16-24 24-34 17-25 42-64 67-82 18-13 37-29 61-20 24 10 29 41 32 63 6 37-2 82-19 115q-12 19-26 37c37 8 40 36 35 70-9 54-39 83-86 106 7 8 16 12 20 22 20 51-31 79-72 85-16 3-59-7-74-14q-10-6-21-9a319 319 0 0 1-454-1c-10 1-20 9-29 12-35 10-68 17-104 4-37-14-61-75-18-98-3-5-12-6-16-9l-27-19c-27-22-48-70-43-104 2-14 2-29 16-39q10-5 20-6c-5-12-17-21-22-33l-10-23c-13-25-15-80-10-107 6-29 21-60 56-54 19 4 34 19 47 32 32 32 52 73 80 107 10-9 14-27 23-39 17-24 37-52 62-70 26-19 51-39 82-51 9-4 36-9 42-14a95 95 0 0 1-10-63c15-78 123-94 164-28 10 15 18 41 13 59-2 11-9 22-10 33Zm-17-5c8-10 11-26 11-38 0-64-76-102-123-55q-12 10-17 24-8 16-6 35 2 18 11 34c5 1 14-2 19-3l33-3c24-3 48 6 72 6Zm-78 47-41 5-46 15a272 272 0 0 0-157 189 268 268 0 0 0 365 302c58-22 116-82 138-139l6-13q10-35 16-71c4-22 0-48-4-68l-10-42c-4-13-11-30-19-41q-5-8-10-18l-15-19c-28-38-71-66-114-83-29-11-78-23-109-17ZM216 459q-13-18-25-37-30-45-68-85c-12-12-38-32-54-13-14 18-15 44-15 66 0 68 33 121 87 160 13 10 39 32 55 33 4-20 0-41 3-61l9-40zm608 110c15-1 32-12 44-20 57-36 94-79 96-149 1-21 2-72-23-82-25-9-54 27-68 43l-50 68c-5 8-15 18-19 27-1 5 9 30 11 37q6 26 9 54zM512 324q7-2 10 7 2 22 0 46c0 6 1 14-6 15-16 2-10-42-10-53 0-5 0-13 6-15Zm-125 34c6-1 9 6 12 10l22 38q6 8-1 15-7 2-11-4c-5-8-26-42-28-49q-1-8 6-10Zm266 13q11-1 11 10c-2 6-28 42-33 48-2 2-9 2-11 0-5-3-2-10 1-14l24-33q3-8 8-11Zm-156 53q20-3 37 2c69 12 111 62 122 129q3 14 1 30c-12 75-60 122-135 134q-29 3-57-7c-73-25-114-100-99-175 9-46 46-82 86-102 14-7 31-8 45-11Zm6 17q-19 1-39 7c-40 16-74 53-83 96a134 134 0 0 0 138 159q106-16 122-121 1-12-1-23l-2-19c-11-51-59-90-108-98q-14-3-27-1Zm-215 23c8-3 46 18 54 23q7 4 4 12c-2 6-10 4-14 2q-23-10-44-23c-5-3-8-12 0-14Zm450 17c7-1 12 7 8 12-5 7-38 20-47 23q-9 5-14-3-2-8 7-12c13-5 33-18 46-20Zm58 211q19 3 38-1c53-8 105-38 118-95q7-22 3-45c-3-15-23-21-36-17-6 2-24 18-30 22-17 13-43 26-65 30-7 36-8 74-28 106Zm-572 1c-7-20-17-40-21-61-1-5-3-27-5-30-5-4-15-6-21-9q-24-14-47-31c-17-12-27-32-50-27q-6 1-11 5c-13 13-6 45-2 61 13 52 65 82 114 90 12 2 31 6 43 2Zm80-106c7-1 34 3 18 15-6 4-40 3-48 3-5 0-13 1-15-4-5-17 35-12 45-14Zm395 0c8-1 49 1 58 3 3 1 5 7 4 10-1 7-10 5-15 5q-24 2-47-3c-6-2-6-13 0-15Zm-36 86c7-3 39 20 46 26 3 3 12 8 9 14q-4 6-9 5-6-2-11-8c-8-5-33-18-38-25-2-3-2-11 3-12Zm-311 4c6-2 13 5 10 11-3 8-33 27-41 33-3 3-9 7-13 3q-7-5-1-12c4-5 40-33 45-35Zm-120 32c-18 4-40 1-58-2-5-1-13-5-19-4-22 4-33 24-29 44 4 16 21 28 35 32 27 9 88 3 110-15q-15-15-26-34-6-10-13-21Zm518 56c7 8 25 11 35 13 32 8 80 13 100-21q5-7 7-14c4-20-12-37-30-40-8-1-39 6-51 7-6 0-17 2-22-1zm-153-34c8-2 10 6 13 11l20 36c3 4 5 13-1 15q-9 2-13-7c-6-12-22-35-25-47q-1-7 6-8Zm-174 3q11 0 10 11c-2 8-17 35-23 42-4 6-5 13-13 10q-7-4-3-12 9-20 20-38c2-4 5-12 9-13Zm89 22q7 1 9 7 2 23 0 47c0 6 1 14-7 15s-8-7-8-13v-41c0-4-1-15 6-15Z"/></svg>';

  // src/userscripts/shared/pricing.js
  var ANLAS_ALPHA = 2951823174884865e-21;
  var ANLAS_BETA = 5753298233447344e-22;
  var V5_MEDIUM_REF_STEPS = 23;
  var V5_MEDIUM_DIVISOR = 1.75;
  var V5_COST_MULTIPLIER = 1.5;
  var ANLAS_MAX_PER_IMAGE_CAP = 140;
  var ANLAS_MIN_PER_IMAGE_FLOOR = 2;
  var MAX_NOVELAI_PIXELS = 3145728;
  var MAX_NOVELAI_STEPS = 50;
  var V5_HIGH_NCP_COST = 18;
  var V5_MEDIUM_NCP_COST = 10;
  var FIREWALL_MAX_PIXELS = 1048576;
  var FIREWALL_MAX_STEPS = 28;
  var FIREWALL_MAX_SAMPLES = 1;
  var UPSCALE_COST_BUCKETS = [
    [1048576, 1],
    [1747627, 2],
    [2446678, 3],
    [3145728, 4]
  ];
  var UPSCALE_FAST_BYTES = 65536;
  var UPSCALE_JPEG_MAX_BYTES = 2097152;
  var BASE64_FAST_CHARS = 87384;
  var BASE64_JPEG_MAX_CHARS = 2796200;
  function isV5ModelFamily(model) {
    if (typeof model !== "string") return false;
    const trimmed = model.trim();
    if (/\d[-_.]5/i.test(trimmed)) return false;
    return /(?:^|[-_])v?5(?:[-_]|$)/i.test(trimmed);
  }
  function isV5MediumModel(model) {
    if (!isV5ModelFamily(model)) return false;
    return /medium/i.test(model.trim());
  }
  function parseStrictInt(val, fallback = null) {
    if (typeof val === "number") {
      if (!Number.isFinite(val)) return fallback;
      const truncated = Math.trunc(val);
      if (truncated > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
      if (truncated < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
      return truncated;
    }
    if (typeof val === "string") {
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
  function parseStrictFloat(val, fallback = null) {
    if (typeof val === "number") {
      return Number.isFinite(val) ? val : fallback;
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        return Number.isFinite(num) ? num : fallback;
      }
    }
    return fallback;
  }
  function extractImageDimensionsFromBytes(bytes) {
    if (!bytes || !(bytes instanceof Uint8Array) || bytes.length < 10) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      return width > 0 && height > 0 ? { width, height, format: "png" } : null;
    }
    if (bytes.length >= 30 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
      const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (tag === "VP8 ") {
        if ((bytes[20] & 1) === 0 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
          const width = view.getUint16(26, true) & 16383;
          const height = view.getUint16(28, true) & 16383;
          return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
        }
        return null;
      }
      if (tag === "VP8L") {
        if (bytes[20] === 47) {
          const bits = view.getUint32(21, true);
          const width = (bits & 16383) + 1;
          const height = (bits >> 14 & 16383) + 1;
          return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
        }
        return null;
      }
      if (tag === "VP8X") {
        const width = 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16);
        const height = 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16);
        return width > 0 && height > 0 ? { width, height, format: "webp" } : null;
      }
      return null;
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let pos = 2;
      while (pos + 1 < bytes.length) {
        if (bytes[pos] !== 255) {
          pos++;
          continue;
        }
        while (pos + 1 < bytes.length && bytes[pos + 1] === 255) {
          pos++;
        }
        if (pos + 1 >= bytes.length) break;
        const marker = bytes[pos + 1];
        pos += 2;
        if (marker === 0 || marker === 1 || marker >= 208 && marker <= 216) {
          continue;
        }
        if (marker === 217 || marker === 218) break;
        if (pos + 2 > bytes.length) break;
        const segLen = view.getUint16(pos, false);
        if (segLen < 2 || pos + segLen > bytes.length) break;
        const isSof = marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207;
        if (isSof && segLen >= 7 && pos + 7 <= bytes.length) {
          const height = view.getUint16(pos + 3, false);
          const width = view.getUint16(pos + 5, false);
          return width > 0 && height > 0 ? { width, height, format: "jpeg" } : null;
        }
        pos += segLen;
      }
      return null;
    }
    if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) {
      const width = view.getUint16(6, true);
      const height = view.getUint16(8, true);
      return width > 0 && height > 0 ? { width, height, format: "gif" } : null;
    }
    if (bytes.length >= 22 && bytes[0] === 66 && bytes[1] === 77) {
      const dibSize = view.getUint32(14, true);
      if (dibSize === 12) {
        const width = view.getUint16(18, true);
        const height = view.getUint16(20, true);
        return width > 0 && height > 0 ? { width, height, format: "bmp" } : null;
      }
      if (bytes.length >= 26) {
        const width = view.getInt32(18, true);
        const height = Math.abs(view.getInt32(22, true));
        return width > 0 && height > 0 ? { width, height, format: "bmp" } : null;
      }
    }
    return null;
  }
  function extractDimensionsFromBase64Browser(rawImageStr) {
    if (typeof rawImageStr !== "string" || typeof atob !== "function") return null;
    const trimmed = rawImageStr.trim();
    const commaIdx = trimmed.startsWith("data:image/") ? trimmed.indexOf(",") : -1;
    const cleanB64 = (commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed).replace(/\s+/g, "");
    if (cleanB64.length === 0) return null;
    const decodeSlice = (len) => {
      const aligned = len - len % 4;
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
    if (cleanB64.startsWith("/9j/") && cleanB64.length > BASE64_FAST_CHARS) {
      return decodeSlice(Math.min(cleanB64.length, BASE64_JPEG_MAX_CHARS));
    }
    return null;
  }
  async function extractUpscaleBodyParams(body) {
    if (!body) return null;
    try {
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const imgPart = body.get("image");
        if (!imgPart) return null;
        if (typeof Blob !== "undefined" && imgPart instanceof Blob) {
          const headerSlice = typeof imgPart.slice === "function" ? imgPart.slice(0, UPSCALE_FAST_BYTES) : imgPart;
          const fastBytes = new Uint8Array(await headerSlice.arrayBuffer());
          const fastDims = extractImageDimensionsFromBytes(fastBytes);
          if (fastDims) return fastDims;
          if (fastBytes.length >= 2 && fastBytes[0] === 255 && fastBytes[1] === 216 && typeof imgPart.slice === "function" && (imgPart.size || 0) > UPSCALE_FAST_BYTES) {
            const jpegSlice = imgPart.slice(0, Math.min(imgPart.size, UPSCALE_JPEG_MAX_BYTES));
            const jpegBytes = new Uint8Array(await jpegSlice.arrayBuffer());
            return extractImageDimensionsFromBytes(jpegBytes);
          }
          return null;
        }
        if (imgPart instanceof Uint8Array) {
          const fastDims = extractImageDimensionsFromBytes(imgPart.subarray(0, UPSCALE_FAST_BYTES));
          if (fastDims) return fastDims;
          if (imgPart.length > UPSCALE_FAST_BYTES && imgPart[0] === 255 && imgPart[1] === 216) {
            return extractImageDimensionsFromBytes(imgPart.subarray(0, UPSCALE_JPEG_MAX_BYTES));
          }
          return null;
        }
        if (typeof ArrayBuffer !== "undefined" && imgPart instanceof ArrayBuffer) {
          const fullView = new Uint8Array(imgPart);
          const fastDims = extractImageDimensionsFromBytes(fullView.subarray(0, UPSCALE_FAST_BYTES));
          if (fastDims) return fastDims;
          if (fullView.length > UPSCALE_FAST_BYTES && fullView[0] === 255 && fullView[1] === 216) {
            return extractImageDimensionsFromBytes(fullView.subarray(0, UPSCALE_JPEG_MAX_BYTES));
          }
          return null;
        }
        if (typeof imgPart === "string") {
          return extractDimensionsFromBase64Browser(imgPart);
        }
        return null;
      }
      let parsedJson = null;
      if (typeof body === "string") {
        parsedJson = JSON.parse(body);
      } else if (typeof Blob !== "undefined" && body instanceof Blob) {
        parsedJson = JSON.parse(await body.text());
      } else if (body instanceof Uint8Array || typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
        const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
        parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } else if (typeof body === "object" && !Array.isArray(body)) {
        parsedJson = body;
      }
      if (parsedJson && typeof parsedJson.image === "string") {
        return extractDimensionsFromBase64Browser(parsedJson.image);
      }
    } catch (_) {
    }
    return null;
  }
  function calculateUpscaleAnlasCost(width, height) {
    if (typeof width !== "number" || !Number.isInteger(width) || width <= 0 || typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
      throw new Error("Upscale image dimensions must be positive integers.");
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
  function evaluateUpscalePolicy(upscaleDims, state = {}) {
    if (!upscaleDims || !upscaleDims.width || !upscaleDims.height) {
      return {
        ok: false,
        status: 400,
        error: "INVALID_UPSCALE_PAYLOAD",
        message: "Unable to read source image dimensions for upscale billing.",
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
        error: "PARAMETRIC_LIMIT_EXCEEDED",
        message: err.message,
        cost: 0
      };
    }
    if (state.isInDebt) {
      return {
        ok: false,
        status: 403,
        error: "DEBT_LOCKED",
        message: `Anlas Overdrawn: ${state.virtualBalance} (Paid Features Paused). Upscaling requires restoring your Anlas balance.`,
        cost
      };
    }
    if (typeof state.availableAnlas === "number" && Number.isFinite(state.availableAnlas) && cost > state.availableAnlas) {
      return {
        ok: false,
        status: 403,
        error: "INSUFFICIENT_ANLAS",
        message: `Insufficient monthly Anlas (${state.availableAnlas} available, ${cost} required to upscale).`,
        cost
      };
    }
    if (state.subscriptionActive === false && typeof state.lastFetchedAt === "number" && state.lastFetchedAt > 0) {
      return {
        ok: false,
        status: 503,
        error: "MASTER_SUBSCRIPTION_INACTIVE",
        message: "Master NovelAI Opus subscription is inactive or expired. Upscaling temporarily unavailable.",
        cost
      };
    }
    return { ok: true, cost };
  }
  function calculateAnlasCostDetails(params, { isOpus = true, usageNegative = false } = {}) {
    if (!params || typeof params !== "object") {
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
    const model = typeof params.model === "string" ? params.model.trim() : "";
    const isV5Medium = isV5MediumModel(model);
    const isV5 = isV5ModelFamily(model);
    const parsedSteps = parseStrictInt(params.steps, 28);
    const rawSteps = parsedSteps > 0 ? parsedSteps : 28;
    const baseCalculated = isV5Medium ? (ANLAS_ALPHA * area + ANLAS_BETA * area * V5_MEDIUM_REF_STEPS) / V5_MEDIUM_DIVISOR : Math.ceil(ANLAS_ALPHA * area + ANLAS_BETA * area * rawSteps);
    let multiplier = 1;
    const sm = params.sm === true || params.sm === "true" || params.sm === 1;
    const smDyn = params.sm_dyn === true || params.sm_dyn === "true" || params.sm_dyn === 1;
    if (sm && smDyn) {
      multiplier = 1.4;
    } else if (sm) {
      multiplier = 1.2;
    }
    let w = baseCalculated * multiplier;
    if (isV5) {
      w *= V5_COST_MULTIPLIER;
    }
    let strengthFactor = 1;
    const hasMask = Boolean(params.has_mask || params.mask);
    const hasImage = Boolean(params.has_image || params.image);
    if (hasMask) {
      if (params.inpaintImg2ImgStrength !== void 0 && params.inpaintImg2ImgStrength !== null) {
        const s = parseStrictFloat(params.inpaintImg2ImgStrength);
        if (s !== null) strengthFactor = Math.max(0, Math.min(1, s));
      }
    } else if (hasImage) {
      if (params.strength !== void 0 && params.strength !== null) {
        const s = parseStrictFloat(params.strength);
        if (s !== null) strengthFactor = Math.max(0, Math.min(1, s));
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
    if (rawRefs === void 0 || rawRefs === null) {
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
      if (rawVibeRefs === void 0 || rawVibeRefs === null) {
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
  function evaluateGenerationPolicy(imgParams, state = {}) {
    const safeParams = imgParams && typeof imgParams === "object" ? imgParams : {};
    const width = parseStrictInt(safeParams.width, 1024) || 1024;
    const height = parseStrictInt(safeParams.height, 1024) || 1024;
    const area = width * height;
    const nSamples = parseStrictInt(safeParams.n_samples, 1) || 1;
    const model = typeof safeParams.model === "string" ? safeParams.model.trim() : "";
    const isV5 = isV5ModelFamily(model);
    const isV5Medium = isV5MediumModel(model);
    const steps = parseStrictInt(safeParams.steps, isV5Medium ? 14 : 28) || (isV5Medium ? 14 : 28);
    const costDetails = calculateAnlasCostDetails(safeParams, {
      isOpus: true,
      usageNegative: isV5 && Boolean(state.masterV5IsNegative)
    });
    const exceedsBaseLimits = area > FIREWALL_MAX_PIXELS || nSamples !== FIREWALL_MAX_SAMPLES || !isV5Medium && steps > FIREWALL_MAX_STEPS;
    const isBasePaid = exceedsBaseLimits;
    const reqNcp = isV5 && !isBasePaid ? isV5Medium ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST : 0;
    if (costDetails.exceeds_cap) {
      return {
        ok: false,
        status: 400,
        error: "PARAMETRIC_LIMIT_EXCEEDED",
        message: costDetails.cap_reason || `Per-image cost of ${costDetails.per_image} Anlas exceeds maximum cap of ${ANLAS_MAX_PER_IMAGE_CAP} Anlas.`,
        isV5,
        isV5Medium,
        isBasePaid,
        reqNcp,
        costDetails
      };
    }
    if (isV5 && !isV5Medium && area <= FIREWALL_MAX_PIXELS && nSamples === FIREWALL_MAX_SAMPLES && steps >= 24 && steps <= 28) {
      return {
        ok: false,
        status: 400,
        error: "PARAMETRIC_LIMIT_EXCEEDED",
        message: "V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24\u201328 are blocked to protect shared V5 limits\u2014use \u226423 steps or switch to Medium.",
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
        error: "DEBT_LOCKED",
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
        error: "BYPASS_DISABLED",
        message: `Anlas Specs Locked: Enable 'Use Monthly Anlas' in the GuildWeave bar or settings to generate >1MP sizes, batches (>1), or >28 steps (Estimated cost: ${totalAnlas} Anlas).`,
        isV5,
        isV5Medium,
        isBasePaid,
        reqNcp,
        costDetails
      };
    }
    if (requiresAnlas && typeof state.availableAnlas === "number" && Number.isFinite(state.availableAnlas) && totalAnlas > state.availableAnlas) {
      return {
        ok: false,
        status: 403,
        error: "INSUFFICIENT_ANLAS",
        message: `Insufficient monthly Anlas (${state.availableAnlas} available, ${totalAnlas} required).`,
        isV5,
        isV5Medium,
        isBasePaid,
        reqNcp,
        costDetails
      };
    }
    if (state.subscriptionActive === false && typeof state.lastFetchedAt === "number" && state.lastFetchedAt > 0) {
      return {
        ok: false,
        status: 503,
        error: "MASTER_SUBSCRIPTION_INACTIVE",
        message: "Master NovelAI Opus subscription is inactive or expired. Generation temporarily unavailable.",
        isV5,
        isV5Medium,
        isBasePaid,
        reqNcp,
        costDetails
      };
    }
    if (isV5 && !isBasePaid) {
      if (state.isHardLocked && !state.masterTokenExpired && state.clusterState !== "token_expired") {
        return {
          ok: false,
          status: 503,
          error: "V5_BATTERY_CRITICAL",
          message: "V5 Shared Pool Recharging: Shared capacity is below 5.5%. Switch to a legacy model or enable monthly Anlas for higher specs.",
          isV5,
          isV5Medium,
          isBasePaid,
          reqNcp,
          costDetails
        };
      }
      if (typeof state.v5AvailableNcp === "number" && Number.isFinite(state.v5AvailableNcp)) {
        const personalOk = state.v5AvailableNcp >= reqNcp;
        const surplusAvailable = typeof state.v5SurplusAvailableNcp === "number" ? state.v5SurplusAvailableNcp : 0;
        const surplusOk = Boolean(state.v5SurplusEligible) && surplusAvailable >= reqNcp;
        if (!personalOk && !surplusOk) {
          const highAvail = Math.floor(state.v5AvailableNcp / V5_HIGH_NCP_COST);
          const medAvail = Math.floor(state.v5AvailableNcp / V5_MEDIUM_NCP_COST);
          return {
            ok: false,
            status: 429,
            error: "V5_CAPACITY_DEPLETED",
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

  // src/userscripts/shared/theme.js
  var DEFAULT_PALETTE = {
    bg0: "#13152c",
    bg1: "#1a1d3a",
    bg2: "#23274c",
    cardBorder: "rgba(255, 255, 255, 0.14)",
    inputBg: "#13152c",
    inputBorder: "rgba(255, 255, 255, 0.24)",
    border: "rgba(255, 255, 255, 0.14)",
    borderStrong: "rgba(255, 255, 255, 0.24)",
    text: "#f5f3c2",
    textMuted: "rgba(245, 243, 194, 0.68)",
    accent: "#f5f3c2",
    accentText: "#13152c",
    controlAccent: "#23274c",
    controlAccentText: "#f5f3c2",
    success: "#34c77b",
    warning: "#f0b44c",
    error: "#ef5b5b",
    font: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  };
  function escapeHtml(value) {
    if (value === null || value === void 0) return "";
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  async function copyTextToClipboard(text) {
    if (typeof text !== "string" || text.length === 0) return false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
    }
    try {
      if (typeof document !== "undefined" && typeof document.createElement === "function" && typeof document.execCommand === "function") {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; pointer-events:none;";
        const host = document.body || document.documentElement;
        if (host && typeof host.appendChild === "function") {
          host.appendChild(ta);
          if (typeof ta.focus === "function") ta.focus({ preventScroll: true });
          if (typeof ta.select === "function") ta.select();
          if (typeof ta.setSelectionRange === "function") ta.setSelectionRange(0, text.length);
          const ok = Boolean(document.execCommand("copy"));
          ta.remove();
          if (ok) return true;
        }
      }
    } catch (_) {
    }
    return false;
  }
  function attachCopyChipHandlers(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
    const chips = rootEl.querySelectorAll(".gw-copy-chip[data-copy-id]");
    for (const chip of chips) {
      const fullId = chip.getAttribute("data-copy-id") || "";
      if (!fullId) continue;
      const originalLabel = chip.textContent || "";
      let resetTimer = null;
      let copySeq = 0;
      const handleCopy = async (e) => {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        const seq = ++copySeq;
        if (resetTimer) {
          clearTimeout(resetTimer);
          resetTimer = null;
        }
        const copied = await copyTextToClipboard(fullId);
        if (seq !== copySeq) return;
        chip.textContent = copied ? "Copied!" : "Copy failed";
        if (typeof setTimeout === "function") {
          if (resetTimer) {
            clearTimeout(resetTimer);
            resetTimer = null;
          }
          resetTimer = setTimeout(() => {
            if (seq !== copySeq) return;
            resetTimer = null;
            chip.textContent = originalLabel;
          }, 1500);
        }
      };
      chip.onclick = handleCopy;
      chip.onkeydown = (e) => {
        if (e && (e.key === "Enter" || e.key === " ")) {
          handleCopy(e);
        }
      };
    }
  }
  function parseAlphaToken(rawAlpha) {
    if (rawAlpha === void 0 || rawAlpha === null || rawAlpha === "") return 1;
    const trimmed = String(rawAlpha).trim();
    if (trimmed.endsWith("%")) {
      const pct = parseFloat(trimmed.slice(0, -1));
      return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
    }
    const num = parseFloat(trimmed);
    return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 1;
  }
  function hslToRgb(hDeg, sPct, lPct) {
    const h = (hDeg % 360 + 360) % 360 / 360;
    const s = Math.max(0, Math.min(1, sPct / 100));
    const l = Math.max(0, Math.min(1, lPct / 100));
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const hue2rgb = (p2, q2, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p2 + (q2 - p2) * 6 * tt;
      if (tt < 1 / 2) return q2;
      if (tt < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - tt) * 6;
      return p2;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    };
  }
  function parseCssColor(colorStr) {
    if (typeof colorStr !== "string") return null;
    const trimmed = colorStr.trim().toLowerCase();
    if (!trimmed || trimmed === "transparent") {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const rgbComma = trimmed.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.%]+))?\s*\)$/);
    if (rgbComma) {
      return {
        r: Math.round(parseFloat(rgbComma[1])),
        g: Math.round(parseFloat(rgbComma[2])),
        b: Math.round(parseFloat(rgbComma[3])),
        a: parseAlphaToken(rgbComma[4])
      };
    }
    const rgbSpace = trimmed.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.%]+))?\s*\)$/);
    if (rgbSpace) {
      return {
        r: Math.round(parseFloat(rgbSpace[1])),
        g: Math.round(parseFloat(rgbSpace[2])),
        b: Math.round(parseFloat(rgbSpace[3])),
        a: parseAlphaToken(rgbSpace[4])
      };
    }
    const hslMatch = trimmed.match(/^hsla?\(\s*([0-9.]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%(?:\s*[,\/]\s*([0-9.%]+))?\s*\)$/);
    if (hslMatch) {
      const rgb = hslToRgb(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]));
      return {
        r: rgb.r,
        g: rgb.g,
        b: rgb.b,
        a: parseAlphaToken(hslMatch[4])
      };
    }
    const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (hexMatch) {
      const h = hexMatch[1];
      if (h.length === 3) {
        return {
          r: parseInt(h[0] + h[0], 16),
          g: parseInt(h[1] + h[1], 16),
          b: parseInt(h[2] + h[2], 16),
          a: 1
        };
      }
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      };
    }
    return null;
  }
  function clampByte(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
  }
  function isOpaque(parsed) {
    return Boolean(parsed && parsed.a > 0.05);
  }
  function isSolidSurface(parsed, minAlpha = 0.75) {
    return Boolean(parsed && parsed.a >= minAlpha);
  }
  function isHiddenStyle(st) {
    if (!st) return true;
    return st.display === "none" || st.visibility === "hidden" || st.opacity === "0";
  }
  function isElementVisible(node, safeGetStyle) {
    if (!node) return false;
    const ownStyle = safeGetStyle(node);
    if (isHiddenStyle(ownStyle)) return false;
    let cur = node.parentElement;
    let hops = 0;
    while (cur && hops < 16) {
      const st = safeGetStyle(cur);
      if (st && (st.display === "none" || st.opacity === "0")) {
        return false;
      }
      if (cur === document.body || cur === document.documentElement) break;
      cur = cur.parentElement;
      hops++;
    }
    return true;
  }
  function pickVisibleElement(root, selector, safeGetStyle) {
    if (!root) return null;
    if (typeof root.querySelectorAll === "function") {
      const allMatches = root.querySelectorAll(selector);
      if (allMatches && allMatches.length > 0) {
        for (const el of allMatches) {
          if (el && !isInsideGuildWeave(el) && isElementVisible(el, safeGetStyle)) {
            return el;
          }
        }
        for (const el of allMatches) {
          if (el && !isInsideGuildWeave(el)) {
            return el;
          }
        }
      }
    }
    return typeof root.querySelector === "function" ? root.querySelector(selector) : null;
  }
  function relativeLuminance(rgb) {
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  }
  function shiftColor(rgb, delta) {
    return `rgb(${clampByte(rgb.r + delta)}, ${clampByte(rgb.g + delta)}, ${clampByte(rgb.b + delta)})`;
  }
  function withAlpha(rgb, alpha) {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }
  function compositeOver(fg, bg) {
    if (!fg) return null;
    if (fg.a >= 0.99 || !bg) {
      return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    }
    const a = Math.max(0, Math.min(1, fg.a));
    return {
      r: clampByte(bg.r * (1 - a) + fg.r * a),
      g: clampByte(bg.g * (1 - a) + fg.g * a),
      b: clampByte(bg.b * (1 - a) + fg.b * a),
      a: 1
    };
  }
  function isInsideGuildWeave(node) {
    if (!node) return false;
    if (node.id && (node.id.startsWith("gw-") || node.id.startsWith("vps-"))) return true;
    if (typeof node.closest === "function") {
      return Boolean(node.closest('[id^="gw-"]') || node.closest('[id^="vps-"]'));
    }
    return false;
  }
  function nodeContainsAny(container, targets) {
    if (!container || typeof container.contains !== "function") return false;
    for (const target of targets) {
      if (target && target !== container && container.contains(target)) {
        return true;
      }
    }
    return false;
  }
  function collectAncestors(el, maxHops = 6, { excludeRoot = false, stopAt = null } = {}) {
    const out = [];
    let cur = el ? el.parentElement : null;
    let steps = 0;
    while (cur && steps < maxHops) {
      if (stopAt && cur === stopAt) break;
      if (cur === document.body || cur === document.documentElement) {
        if (!excludeRoot) out.push(cur);
        break;
      }
      out.push(cur);
      cur = cur.parentElement;
      steps++;
    }
    return out;
  }
  function collectVisibleDescendants(root, maxDepth, maxNodes, stopDescendSet, safeGetStyle) {
    const result = [];
    if (!root || !root.children) return result;
    const queue = [];
    for (const child of Array.from(root.children)) {
      queue.push({ node: child, depth: 1 });
    }
    let head = 0;
    while (head < queue.length && result.length < maxNodes) {
      const { node, depth } = queue[head++];
      if (!node || stopDescendSet.has(node) || isInsideGuildWeave(node)) continue;
      const role = typeof node.getAttribute === "function" ? node.getAttribute("role") : null;
      const modalAttr = typeof node.getAttribute === "function" ? node.getAttribute("aria-modal") : null;
      if (role === "dialog" || modalAttr === "true") continue;
      const st = safeGetStyle(node);
      if (isHiddenStyle(st)) continue;
      result.push(node);
      if (depth < maxDepth && node.children && node.children.length > 0) {
        for (const child of Array.from(node.children)) {
          queue.push({ node: child, depth: depth + 1 });
        }
      }
    }
    return result;
  }
  function isPureBlackScrim(parsed) {
    return Boolean(parsed && parsed.a < 0.75 && parsed.r < 5 && parsed.g < 5 && parsed.b < 5);
  }
  function isStaleNavyColor(parsed) {
    return Boolean(parsed && parsed.r <= 28 && parsed.g <= 30 && parsed.b >= 36 && parsed.b - parsed.r >= 12);
  }
  function extractSurfaceColor(st, backdropParsed = null, { allowTranslucent = false, minAlpha = 0.75 } = {}) {
    if (isHiddenStyle(st)) return null;
    const bgCol = st.backgroundColor;
    const parsedBg = parseCssColor(bgCol);
    const bgImg = st.backgroundImage;
    if (typeof bgImg === "string" && bgImg !== "none" && bgImg.includes("gradient")) {
      const stopMatches = bgImg.match(/hsla?\([^)]+\)|rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
      if (stopMatches) {
        let firstTranslucentStop = null;
        for (const stop of stopMatches) {
          const parsedStop = parseCssColor(stop);
          if (isSolidSurface(parsedStop, minAlpha) && (minAlpha >= 0.75 || !isPureBlackScrim(parsedStop))) {
            return {
              color: `rgb(${parsedStop.r}, ${parsedStop.g}, ${parsedStop.b})`,
              parsed: { r: parsedStop.r, g: parsedStop.g, b: parsedStop.b, a: 1 }
            };
          }
          if (!firstTranslucentStop && parsedStop && parsedStop.a >= 0.03) {
            firstTranslucentStop = parsedStop;
          }
        }
        if (firstTranslucentStop) {
          const base = isSolidSurface(parsedBg) ? parsedBg : allowTranslucent ? backdropParsed : null;
          if (base) {
            const comp = compositeOver(firstTranslucentStop, base);
            return { color: `rgb(${comp.r}, ${comp.g}, ${comp.b})`, parsed: comp };
          }
        }
      }
    }
    if (isSolidSurface(parsedBg, minAlpha) && (minAlpha >= 0.75 || !isPureBlackScrim(parsedBg))) {
      const normalizedColor = parsedBg.a < 0.99 ? `rgb(${parsedBg.r}, ${parsedBg.g}, ${parsedBg.b})` : bgCol;
      return {
        color: normalizedColor,
        parsed: { r: parsedBg.r, g: parsedBg.g, b: parsedBg.b, a: parsedBg.a >= 0.99 ? 1 : parsedBg.a }
      };
    }
    if (allowTranslucent && parsedBg && parsedBg.a >= 0.03 && backdropParsed) {
      const comp = compositeOver(parsedBg, backdropParsed);
      return { color: `rgb(${comp.r}, ${comp.g}, ${comp.b})`, parsed: comp };
    }
    return null;
  }
  function extractBoxShadowBorderRing(boxShadow) {
    if (typeof boxShadow !== "string" || boxShadow === "none" || !boxShadow.trim()) {
      return null;
    }
    const layers = [];
    let current = "";
    let parenDepth = 0;
    for (let i = 0; i < boxShadow.length; i++) {
      const ch = boxShadow[i];
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      if (ch === "," && parenDepth === 0) {
        if (current.trim()) layers.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) layers.push(current.trim());
    for (const layer of layers) {
      const colorMatch = layer.match(/hsla?\([^)]+\)|rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
      if (!colorMatch) continue;
      const colorStr = colorMatch[0];
      const parsed = parseCssColor(colorStr);
      if (!isOpaque(parsed)) continue;
      const remainder = layer.replace(colorStr, "").replace(/\binset\b/gi, "").trim();
      const lengths = remainder.match(/-?\d+(?:\.\d+)?(?:px|rem|em)?/gi);
      if (!lengths || lengths.length < 4) continue;
      const x = parseFloat(lengths[0]);
      const y = parseFloat(lengths[1]);
      const blur = parseFloat(lengths[2]);
      const spread = parseFloat(lengths[3]);
      if (x === 0 && y === 0 && blur === 0 && spread > 0) {
        return { color: colorStr, parsed };
      }
    }
    return null;
  }
  function extractElementBorderColor(st) {
    if (isHiddenStyle(st)) return null;
    const sides = [
      { w: st.borderTopWidth, s: st.borderTopStyle, c: st.borderTopColor },
      { w: st.borderRightWidth, s: st.borderRightStyle, c: st.borderRightColor },
      { w: st.borderBottomWidth, s: st.borderBottomStyle, c: st.borderBottomColor },
      { w: st.borderLeftWidth, s: st.borderLeftStyle, c: st.borderLeftColor }
    ];
    for (const side of sides) {
      const bw = parseFloat(side.w || "1");
      const styleOk = !side.s || side.s !== "none";
      if ((Number.isNaN(bw) || bw > 0) && styleOk) {
        const parsed = parseCssColor(side.c);
        if (isOpaque(parsed)) {
          return { color: side.c, parsed };
        }
      }
    }
    if (st.borderColor) {
      const bw = parseFloat(st.borderTopWidth || "1");
      const styleOk = !st.borderTopStyle || st.borderTopStyle !== "none";
      if ((Number.isNaN(bw) || bw > 0) && styleOk) {
        const parsed = parseCssColor(st.borderColor);
        if (isOpaque(parsed)) {
          return { color: st.borderColor, parsed };
        }
      }
    }
    const ow = parseFloat(st.outlineWidth || "0");
    if ((!st.outlineStyle || st.outlineStyle !== "none") && (Number.isNaN(ow) || ow > 0)) {
      const parsedOut = parseCssColor(st.outlineColor);
      if (isOpaque(parsedOut)) {
        return { color: st.outlineColor, parsed: parsedOut };
      }
    }
    return extractBoxShadowBorderRing(st.boxShadow);
  }
  function scrapeNovelAITheme() {
    const palette = { ...DEFAULT_PALETTE };
    if (typeof window === "undefined" || typeof window.getComputedStyle !== "function" || typeof document === "undefined") {
      return palette;
    }
    try {
      const bodyEl = document.body || document.documentElement;
      if (!bodyEl) return palette;
      const safeGetStyle = (el, pseudoElt) => {
        if (!el) return null;
        try {
          return pseudoElt !== void 0 ? window.getComputedStyle(el, pseudoElt) : window.getComputedStyle(el);
        } catch (_) {
          return null;
        }
      };
      const navRow = pickVisibleElement(document, ".image-gen-nav-row", safeGetStyle);
      const footerEl = pickVisibleElement(document, ".image-gen-footer", safeGetStyle);
      const modelRow = pickVisibleElement(document, ".image-gen-model-mode-row", safeGetStyle);
      const genBtn = pickVisibleElement(document, ".image-gen-generate-button", safeGetStyle);
      const menuBtn = pickVisibleElement(document, 'button[aria-label="menu"]', safeGetStyle);
      const charPromptsEl = pickVisibleElement(document, ".image-gen-character-prompts", safeGetStyle);
      const charPromptsHeader = pickVisibleElement(document, ".image-gen-character-prompts-header", safeGetStyle);
      const promptMainEl = pickVisibleElement(document, ".image-gen-prompt-main", safeGetStyle);
      const promptBoxEl = pickVisibleElement(promptMainEl, '[data-prompt-input="true"]', safeGetStyle) || pickVisibleElement(promptMainEl, ".prompt-input-box-prompt", safeGetStyle) || pickVisibleElement(document, '[data-prompt-input="true"]', safeGetStyle) || pickVisibleElement(document, ".prompt-input-box-prompt", safeGetStyle);
      const boxEditorNode = pickVisibleElement(promptBoxEl, '[contenteditable="true"], textarea', safeGetStyle);
      const promptNode = boxEditorNode || pickVisibleElement(promptMainEl, '[contenteditable="true"], textarea', safeGetStyle) || pickVisibleElement(document, 'textarea, [contenteditable="true"]', safeGetStyle);
      const nextRoot = typeof document.getElementById === "function" ? document.getElementById("__next") : null;
      const stopDescendSet = new Set(
        [genBtn, menuBtn, promptNode, promptBoxEl, promptMainEl, charPromptsEl, charPromptsHeader, footerEl].filter(Boolean)
      );
      const outerToInner = (node, hops = 24) => collectAncestors(node, hops, { excludeRoot: true }).reverse();
      const nonRootBg0Candidates = [
        ...outerToInner(navRow, 24),
        navRow,
        ...outerToInner(menuBtn, 24),
        ...collectVisibleDescendants(nextRoot, 6, 48, stopDescendSet, safeGetStyle),
        ...collectVisibleDescendants(document.body, 4, 32, stopDescendSet, safeGetStyle),
        ...outerToInner(modelRow, 24),
        modelRow,
        ...outerToInner(footerEl, 24),
        footerEl,
        ...outerToInner(genBtn, 24),
        ...outerToInner(promptMainEl, 24),
        ...outerToInner(promptNode, 24)
      ].filter(Boolean);
      const excludedBg0Nodes = new Set(
        [genBtn, menuBtn, promptNode, promptBoxEl, charPromptsEl, charPromptsHeader].filter(Boolean)
      );
      const uniqueNonRootBg0 = [];
      const seenBg0 = /* @__PURE__ */ new Set();
      for (const node of nonRootBg0Candidates) {
        if (!node || seenBg0.has(node) || excludedBg0Nodes.has(node) || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        seenBg0.add(node);
        uniqueNonRootBg0.push(node);
      }
      let bg0Parsed = null;
      let usedBodyFallbackForBg0 = false;
      for (const node of uniqueNonRootBg0) {
        const st = safeGetStyle(node);
        const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 });
        if (extracted) {
          palette.bg0 = extracted.color;
          bg0Parsed = extracted.parsed;
          break;
        }
      }
      if (!bg0Parsed) {
        for (const node of uniqueNonRootBg0) {
          const st = safeGetStyle(node);
          const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.45 });
          if (extracted) {
            palette.bg0 = extracted.color;
            bg0Parsed = extracted.parsed;
            break;
          }
        }
      }
      if (!bg0Parsed) {
        for (const pseudoHost of [nextRoot, document.body, document.documentElement].filter(Boolean)) {
          const pSt = safeGetStyle(pseudoHost, "::before");
          if (pSt && pSt.content && pSt.content !== "none" && pSt.content !== "normal") {
            const extracted = extractSurfaceColor(pSt, null, { allowTranslucent: false, minAlpha: 0.45 });
            if (extracted) {
              palette.bg0 = extracted.color;
              bg0Parsed = extracted.parsed;
              break;
            }
          }
        }
      }
      if (!bg0Parsed) {
        for (const rootEl of [document.body, document.documentElement].filter(Boolean)) {
          const st = safeGetStyle(rootEl);
          const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 });
          if (extracted) {
            palette.bg0 = extracted.color;
            bg0Parsed = extracted.parsed;
            usedBodyFallbackForBg0 = true;
            break;
          }
        }
      }
      const isDark = !bg0Parsed || relativeLuminance(bg0Parsed) < 0.5;
      const bg0Lum = bg0Parsed ? relativeLuminance(bg0Parsed) : 0.08;
      if (bg0Parsed) {
        palette.bg1 = shiftColor(bg0Parsed, isDark ? 8 : -8);
        palette.bg2 = shiftColor(bg0Parsed, isDark ? 16 : -16);
        palette.controlAccent = palette.bg2;
        palette.inputBg = palette.bg0;
      }
      const textCandidates = [
        nextRoot,
        navRow,
        ...collectAncestors(navRow, 6, { excludeRoot: true }),
        menuBtn,
        ...collectAncestors(menuBtn, 6, { excludeRoot: true }),
        modelRow,
        footerEl,
        ...collectAncestors(genBtn, 4, { excludeRoot: true }),
        promptNode,
        pickVisibleElement(document, "span, label, p, button, h1, h2", safeGetStyle),
        document.body,
        document.documentElement
      ];
      let textParsed = null;
      for (const node of textCandidates) {
        if (!node || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        const st = safeGetStyle(node);
        if (st.fontFamily && st.fontFamily.trim() && palette.font === DEFAULT_PALETTE.font) {
          palette.font = st.fontFamily.trim();
        }
        const col = parseCssColor(st.color);
        if (isOpaque(col) && Math.abs(relativeLuminance(col) - bg0Lum) >= 0.25) {
          palette.text = st.color;
          textParsed = col;
          if (st.fontFamily && st.fontFamily.trim()) {
            palette.font = st.fontFamily.trim();
          }
          break;
        }
      }
      if (textParsed) {
        palette.textMuted = withAlpha(textParsed, 0.68);
        palette.border = withAlpha(textParsed, 0.14);
        palette.borderStrong = withAlpha(textParsed, 0.24);
        palette.cardBorder = palette.border;
        palette.inputBorder = palette.borderStrong;
        palette.accent = palette.text;
        palette.accentText = palette.bg0;
        palette.controlAccentText = palette.text;
      }
      const charPromptChildren = charPromptsEl && charPromptsEl.children ? Array.from(charPromptsEl.children) : [];
      const charPromptSiblings = charPromptsEl && charPromptsEl.parentElement && charPromptsEl.parentElement.children ? Array.from(charPromptsEl.parentElement.children).filter(
        (c) => c !== charPromptsEl && c !== promptMainEl && c !== promptBoxEl && c !== footerEl && c !== navRow && c !== modelRow && !isInsideGuildWeave(c) && !nodeContainsAny(c, [promptMainEl, footerEl, navRow, modelRow])
      ).slice(0, 6) : [];
      const explicitCardNodes = [
        charPromptsEl,
        charPromptsHeader,
        ...charPromptChildren,
        ...charPromptSiblings
      ].filter(Boolean);
      let bg1Parsed = null;
      let foundExplicitCardBg = false;
      let foundNonRootCardBg = false;
      for (const node of explicitCardNodes) {
        if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        const st = safeGetStyle(node);
        const extracted = extractSurfaceColor(st, bg0Parsed, { allowTranslucent: true });
        if (!extracted) continue;
        const lum = relativeLuminance(extracted.parsed);
        if (isDark ? lum < 0.45 : lum > 0.55) {
          palette.bg1 = extracted.color;
          bg1Parsed = extracted.parsed;
          palette.bg2 = shiftColor(extracted.parsed, isDark ? 10 : -10);
          foundExplicitCardBg = true;
          foundNonRootCardBg = true;
          break;
        }
      }
      if (!foundExplicitCardBg) {
        const dialogNode = pickVisibleElement(document, '[role="dialog"]', safeGetStyle);
        const fallbackCardNodes = [
          dialogNode,
          promptNode,
          ...collectAncestors(promptNode, 3, { excludeRoot: true }),
          ...collectAncestors(genBtn, 3, { excludeRoot: true })
        ].filter(Boolean);
        for (const node of fallbackCardNodes) {
          if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
          const st = safeGetStyle(node);
          const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 }) || extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.45 });
          if (!extracted || extracted.color === palette.bg0) continue;
          const lum = relativeLuminance(extracted.parsed);
          if (isDark ? lum < 0.35 : lum > 0.65) {
            palette.bg1 = extracted.color;
            bg1Parsed = extracted.parsed;
            palette.bg2 = shiftColor(extracted.parsed, isDark ? 10 : -10);
            foundNonRootCardBg = true;
            break;
          }
        }
      }
      if ((!bg0Parsed || usedBodyFallbackForBg0 && isStaleNavyColor(bg0Parsed) && !isStaleNavyColor(bg1Parsed)) && foundNonRootCardBg && bg1Parsed) {
        const bg1IsDark = relativeLuminance(bg1Parsed) < 0.5;
        const derivedBg0 = shiftColor(bg1Parsed, bg1IsDark ? -8 : 8);
        palette.bg0 = derivedBg0;
        bg0Parsed = parseCssColor(derivedBg0) || bg1Parsed;
        palette.inputBg = derivedBg0;
        if (textParsed) {
          palette.accentText = derivedBg0;
        }
      }
      const promptEditorChain = [];
      if (promptBoxEl) {
        promptEditorChain.push(promptBoxEl);
        if (boxEditorNode) {
          const between = [];
          let cur = boxEditorNode.parentElement;
          let hops = 0;
          while (cur && cur !== promptBoxEl && hops < 8) {
            between.push(cur);
            cur = cur.parentElement;
            hops++;
          }
          for (let i = between.length - 1; i >= 0; i--) {
            promptEditorChain.push(between[i]);
          }
          promptEditorChain.push(boxEditorNode);
        }
      } else if (promptNode) {
        promptEditorChain.push(promptNode);
        const stopNode = promptMainEl ? promptMainEl.parentElement : null;
        const maxPromptHops = promptMainEl ? 4 : 1;
        for (const anc of collectAncestors(promptNode, maxPromptHops, { excludeRoot: true, stopAt: stopNode })) {
          if (anc !== nextRoot && !promptEditorChain.includes(anc) && !nodeContainsAny(anc, [charPromptsEl, footerEl, navRow])) {
            promptEditorChain.push(anc);
          }
        }
      }
      const inputBackdrop = bg0Parsed || bg1Parsed;
      for (const node of promptEditorChain) {
        if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        const st = safeGetStyle(node);
        const extracted = extractSurfaceColor(st, inputBackdrop, { allowTranslucent: true });
        if (!extracted) continue;
        const lum = relativeLuminance(extracted.parsed);
        if (isDark ? lum < 0.45 : lum > 0.55) {
          palette.inputBg = extracted.color;
          break;
        }
      }
      let foundInputBorder = false;
      for (const node of promptEditorChain) {
        if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        const st = safeGetStyle(node);
        const borderInfo = extractElementBorderColor(st);
        if (borderInfo && borderInfo.color !== palette.inputBg && borderInfo.color !== palette.bg0) {
          palette.inputBorder = borderInfo.color;
          foundInputBorder = true;
          break;
        }
      }
      let foundExplicitBorder = false;
      let foundCardBorder = false;
      let foundExplicitControlAccent = false;
      const modelButtons = modelRow && typeof modelRow.querySelectorAll === "function" ? Array.from(modelRow.querySelectorAll("button")) : [];
      if (modelButtons.length >= 2) {
        let medBtn = null;
        let highBtn = null;
        for (const b of modelButtons) {
          const lbl = (b.textContent || "").trim().toLowerCase();
          if (lbl === "medium") medBtn = b;
          else if (lbl === "high") highBtn = b;
        }
        if (medBtn && highBtn) {
          const medSt = safeGetStyle(medBtn);
          const highSt = safeGetStyle(highBtn);
          const medBg = medSt ? parseCssColor(medSt.backgroundColor) : null;
          const highBg = highSt ? parseCssColor(highSt.backgroundColor) : null;
          const medAttr = medBtn.getAttribute("aria-pressed") === "true" || medBtn.getAttribute("aria-selected") === "true";
          const highAttr = highBtn.getAttribute("aria-pressed") === "true" || highBtn.getAttribute("aria-selected") === "true";
          let activeBtn = null;
          let inactiveBtn = null;
          if (medAttr !== highAttr) {
            activeBtn = medAttr ? medBtn : highBtn;
            inactiveBtn = medAttr ? highBtn : medBtn;
          } else if (isOpaque(medBg) && !isOpaque(highBg)) {
            activeBtn = medBtn;
            inactiveBtn = highBtn;
          } else if (isOpaque(highBg) && !isOpaque(medBg)) {
            activeBtn = highBtn;
            inactiveBtn = medBtn;
          } else if (isOpaque(medBg) && isOpaque(highBg) && medSt.backgroundColor !== highSt.backgroundColor) {
            const medLum = relativeLuminance(medBg);
            const highLum = relativeLuminance(highBg);
            const medActive = isDark ? medLum > highLum : medLum < highLum;
            activeBtn = medActive ? medBtn : highBtn;
            inactiveBtn = medActive ? highBtn : medBtn;
          }
          if (activeBtn) {
            const actSt = safeGetStyle(activeBtn);
            const actBg = actSt ? parseCssColor(actSt.backgroundColor) : null;
            if (isOpaque(actBg) && actSt.backgroundColor !== palette.bg0 && actSt.backgroundColor !== palette.bg1) {
              palette.controlAccent = actSt.backgroundColor;
              foundExplicitControlAccent = true;
              const actText = parseCssColor(actSt.color);
              if (isOpaque(actText) && Math.abs(relativeLuminance(actText) - relativeLuminance(actBg)) >= 0.25) {
                palette.controlAccentText = actSt.color;
              } else {
                palette.controlAccentText = relativeLuminance(actBg) > 0.55 ? "#111111" : palette.text;
              }
            }
            if (inactiveBtn) {
              const inactSt = safeGetStyle(inactiveBtn);
              const inactBg = inactSt ? parseCssColor(inactSt.backgroundColor) : null;
              if (isOpaque(inactBg) && inactSt.backgroundColor !== palette.bg0) {
                const lum = relativeLuminance(inactBg);
                if (isDark ? lum < 0.42 : lum > 0.58) {
                  palette.bg2 = inactSt.backgroundColor;
                }
              }
            }
          }
        }
      }
      for (const cardNode of explicitCardNodes) {
        if (!cardNode || cardNode === genBtn || isInsideGuildWeave(cardNode) || !isElementVisible(cardNode, safeGetStyle)) continue;
        const st = safeGetStyle(cardNode);
        const borderInfo = extractElementBorderColor(st);
        if (borderInfo && borderInfo.color !== palette.bg0 && borderInfo.color !== palette.bg1) {
          palette.cardBorder = borderInfo.color;
          palette.borderStrong = borderInfo.color;
          palette.border = borderInfo.parsed.a < 0.95 ? borderInfo.color : withAlpha(borderInfo.parsed, 0.72);
          foundCardBorder = true;
          foundExplicitBorder = true;
          break;
        }
      }
      if (!foundExplicitBorder) {
        const borderPool = [
          menuBtn,
          ...navRow && typeof navRow.querySelectorAll === "function" ? Array.from(navRow.querySelectorAll("button, div")).slice(0, 12) : [],
          ...modelButtons,
          ...modelRow && typeof modelRow.querySelectorAll === "function" ? Array.from(modelRow.querySelectorAll("div, button")).slice(0, 12) : [],
          promptBoxEl,
          promptNode,
          ...collectAncestors(promptNode, 4, { excludeRoot: true }),
          ...collectAncestors(genBtn, 4, { excludeRoot: true }),
          ...typeof document.querySelectorAll === "function" ? Array.from(document.querySelectorAll("input, button")).slice(0, 20) : []
        ].filter(Boolean);
        for (const ctrl of borderPool) {
          if (ctrl === genBtn || isInsideGuildWeave(ctrl) || !isElementVisible(ctrl, safeGetStyle)) continue;
          const st = safeGetStyle(ctrl);
          const borderInfo = extractElementBorderColor(st);
          if (borderInfo && borderInfo.color !== palette.bg0 && borderInfo.color !== palette.bg1) {
            palette.borderStrong = borderInfo.color;
            palette.border = borderInfo.parsed.a < 0.95 ? borderInfo.color : withAlpha(borderInfo.parsed, 0.58);
            if (!foundCardBorder) palette.cardBorder = borderInfo.color;
            foundExplicitBorder = true;
            break;
          }
        }
      }
      const controlBgPool = [
        menuBtn,
        ...modelButtons,
        promptNode,
        ...typeof document.querySelectorAll === "function" ? Array.from(document.querySelectorAll("input, button")).slice(0, 20) : []
      ].filter(Boolean);
      for (const ctrl of controlBgPool) {
        if (ctrl === genBtn || isInsideGuildWeave(ctrl) || !isElementVisible(ctrl, safeGetStyle)) continue;
        const st = safeGetStyle(ctrl);
        const bgParsed = parseCssColor(st.backgroundColor);
        if (isOpaque(bgParsed) && st.backgroundColor !== palette.bg0 && st.backgroundColor !== palette.bg1) {
          const lum = relativeLuminance(bgParsed);
          if (isDark ? lum < 0.45 : lum > 0.55) {
            palette.bg2 = st.backgroundColor;
            if (!foundExplicitControlAccent) {
              palette.controlAccent = st.backgroundColor;
              palette.controlAccentText = relativeLuminance(bgParsed) > 0.55 ? "#111111" : palette.text;
              foundExplicitControlAccent = true;
            }
            break;
          }
        }
      }
      if (genBtn) {
        const btnStyle = safeGetStyle(genBtn);
        if (btnStyle) {
          const btnBgParsed = parseCssColor(btnStyle.backgroundColor);
          const btnTextParsed = parseCssColor(btnStyle.color);
          const bgHasContrast = isOpaque(btnBgParsed) && btnStyle.backgroundColor !== palette.bg0 && (isDark ? relativeLuminance(btnBgParsed) >= 0.35 : relativeLuminance(btnBgParsed) <= 0.65);
          if (bgHasContrast) {
            palette.accent = btnStyle.backgroundColor;
            if (isOpaque(btnTextParsed)) {
              palette.accentText = btnStyle.color;
            } else {
              palette.accentText = relativeLuminance(btnBgParsed) > 0.55 ? "#111111" : "#ffffff";
            }
          } else if (isOpaque(btnTextParsed) && (isDark ? relativeLuminance(btnTextParsed) >= 0.45 : relativeLuminance(btnTextParsed) <= 0.45)) {
            palette.accent = btnStyle.color;
            palette.accentText = isDark ? palette.bg0 : "#ffffff";
          }
        }
      }
      if (!foundExplicitControlAccent) {
        palette.controlAccent = palette.accent;
        palette.controlAccentText = palette.accentText;
      }
      if (!foundExplicitBorder && isOpaque(parseCssColor(palette.bg2))) {
        const parsedBg2 = parseCssColor(palette.bg2);
        palette.borderStrong = shiftColor(parsedBg2, isDark ? 20 : -20);
        palette.border = withAlpha(parsedBg2, 0.65);
        palette.cardBorder = palette.borderStrong;
      }
      if (!foundInputBorder) {
        palette.inputBorder = palette.borderStrong;
      }
    } catch (_) {
    }
    return palette;
  }
  function ensureGuildWeaveStyles() {
    const theme = scrapeNovelAITheme();
    if (typeof document === "undefined" || typeof document.getElementById !== "function") {
      return theme;
    }
    let styleEl = document.getElementById("gw-ui-styles");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "gw-ui-styles";
      const host = typeof document.head !== "undefined" && document.head ? document.head : document.documentElement || document.body;
      if (host && typeof host.appendChild === "function") {
        host.appendChild(styleEl);
      }
    }
    const nextCss = `
    #vps-admin-panel, #vps-settings-modal, #vps-approval-overlay, #gw-v5-bar, #gw-allowance-bar {
      --theme-bg0: ${theme.bg0};
      --theme-bg1: ${theme.bg1};
      --theme-bg2: ${theme.borderStrong};
      --theme-text: ${theme.text};
      --theme-textSecondary: ${theme.textMuted};
      --theme-accent: ${theme.accent};
      --gw-bg0: var(--theme-bg0, ${theme.bg0});
      --gw-bg1: var(--theme-bg1, ${theme.bg1});
      --gw-bg2: ${theme.bg2};
      --gw-card-border: ${theme.cardBorder || theme.borderStrong};
      --gw-input-bg: ${theme.inputBg || theme.bg0};
      --gw-input-border: ${theme.inputBorder || theme.borderStrong};
      --gw-border: var(--theme-bg2, ${theme.border});
      --gw-border-strong: ${theme.borderStrong};
      --gw-text: var(--theme-text, ${theme.text});
      --gw-text-muted: var(--theme-textSecondary, ${theme.textMuted});
      --gw-accent: var(--theme-accent, ${theme.accent});
      --gw-accent-text: ${theme.accentText};
      --gw-control-bg: ${theme.controlAccent};
      --gw-control-text: ${theme.controlAccentText};
      --gw-control-border: ${theme.borderStrong};
      --gw-success: var(--theme-success, ${theme.success});
      --gw-warning: var(--theme-warning, ${theme.warning});
      --gw-error: var(--theme-error, ${theme.error});
      font-family: ${theme.font};
      box-sizing: border-box;
    }
    #vps-admin-panel *, #vps-settings-modal *, #vps-approval-overlay *, #gw-v5-bar *, #gw-allowance-bar * {
      box-sizing: border-box;
    }
    @keyframes gwPulse {
      0% { opacity: 0.45; transform: scale(0.92); }
      100% { opacity: 1; transform: scale(1.08); }
    }
    #gw-v5-bar.gw-v5-compact {
      padding: 3px 6px 4px !important;
      gap: 2px !important;
      margin-bottom: 2px !important;
      border-radius: 6px !important;
    }
    #gw-v5-bar.gw-v5-compact .gw-hud-row {
      flex-wrap: nowrap !important;
      gap: 4px !important;
    }
    #gw-v5-bar.gw-v5-compact .gw-hud-right {
      gap: 5px !important;
      flex-shrink: 0 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-track {
      height: 3px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-label,
    #gw-v5-bar.gw-v5-compact #gw-anlas-label,
    #gw-v5-bar.gw-v5-compact #gw-v5-cost,
    #gw-v5-bar.gw-v5-compact #gw-bypass-text {
      font-size: 10px !important;
      line-height: 1.2 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-eta {
      font-size: 9.5px !important;
      line-height: 1.2 !important;
      flex-shrink: 0 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-bypass-label {
      gap: 4px !important;
      font-size: 10px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-bypass-toggle {
      width: 12px !important;
      min-width: 12px !important;
      max-width: 12px !important;
      height: 12px !important;
      flex: 0 0 12px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-hud-alert {
      font-size: 10px !important;
      padding: 3px 5px !important;
    }
    @media (max-width: 640px) {
      #gw-v5-bar {
        padding: 3px 6px 4px !important;
        gap: 2px !important;
        margin-bottom: 2px !important;
        border-radius: 6px !important;
      }
      #gw-v5-bar .gw-hud-row {
        flex-wrap: nowrap !important;
        gap: 4px !important;
      }
      #gw-v5-bar .gw-hud-right {
        gap: 5px !important;
        flex-shrink: 0 !important;
      }
      #gw-v5-bar #gw-v5-track {
        height: 3px !important;
      }
      #gw-v5-bar #gw-v5-label,
      #gw-v5-bar #gw-anlas-label,
      #gw-v5-bar #gw-v5-cost,
      #gw-v5-bar #gw-bypass-text {
        font-size: 10px !important;
        line-height: 1.2 !important;
      }
      #gw-v5-bar #gw-v5-eta {
        font-size: 9.5px !important;
        line-height: 1.2 !important;
        flex-shrink: 0 !important;
      }
      #gw-v5-bar #gw-bypass-label {
        gap: 4px !important;
        font-size: 10px !important;
      }
      #gw-v5-bar #gw-bypass-toggle {
        width: 12px !important;
        min-width: 12px !important;
        max-width: 12px !important;
        height: 12px !important;
        flex: 0 0 12px !important;
      }
      #gw-allowance-bar {
        padding: 4px 6px !important;
        gap: 2px !important;
      }
      #vps-settings-modal, #vps-admin-panel {
        padding: 14px !important;
        width: 94vw !important;
        max-height: 88vh !important;
      }
      #vps-settings-modal .gw-modal-header, #vps-admin-panel .gw-modal-header {
        padding-bottom: 8px;
        margin-bottom: 10px;
      }
      #vps-settings-modal .gw-card, #vps-admin-panel .gw-card {
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      #vps-settings-modal .gw-stat-grid, #vps-admin-panel .gw-stat-grid {
        gap: 8px 10px;
      }
      #vps-settings-modal .gw-btn, #vps-admin-panel .gw-btn {
        padding: 7px 9px;
      }
    }
    .gw-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid ${theme.border};
    }
    .gw-modal-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: var(--gw-text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gw-pill-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--gw-control-bg);
      border: 1px solid var(--gw-control-border);
      color: var(--gw-control-text);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .gw-close-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--gw-text-muted);
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      cursor: pointer;
    }
    .gw-close-btn:hover {
      background: var(--gw-bg2);
      color: var(--gw-text);
    }
    .gw-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 4px;
      border-radius: 8px;
      background: var(--gw-bg1);
      border: 1px solid var(--gw-card-border);
      margin-bottom: 14px;
    }
    .gw-tab-btn {
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      background: transparent;
      color: var(--gw-text-muted);
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .gw-tab-btn.is-active {
      background: var(--gw-control-bg);
      border-color: var(--gw-control-border);
      color: var(--gw-control-text);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    .gw-card {
      background: var(--gw-bg1);
      border: 1px solid var(--gw-card-border);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .gw-section-title {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: var(--gw-text-muted);
      margin-bottom: 8px;
      letter-spacing: 0.2px;
    }
    .gw-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 14px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .gw-stat-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .gw-stat-label {
      font-size: 10px;
      color: var(--gw-text-muted);
    }
    .gw-stat-val {
      font-size: 12px;
      font-weight: 600;
      color: var(--gw-text);
    }
    .gw-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      user-select: none;
    }
    .gw-toggle-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .gw-toggle-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--gw-text);
    }
    .gw-toggle-desc {
      font-size: 11px;
      line-height: 1.4;
      color: var(--gw-text-muted);
    }
    input[type="checkbox"].gw-switch {
      appearance: none;
      -webkit-appearance: none;
      display: inline-block !important;
      width: 36px !important;
      min-width: 36px !important;
      max-width: 36px !important;
      height: 20px !important;
      min-height: 0 !important;
      flex: 0 0 36px !important;
      margin: 0 !important;
      padding: 0 !important;
      box-shadow: none !important;
      border-radius: 999px;
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      position: relative;
      cursor: pointer;
      transition: background 0.18s ease, border-color 0.18s ease;
    }
    input[type="checkbox"].gw-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--gw-text-muted);
      transition: transform 0.18s ease, background 0.18s ease;
    }
    input[type="checkbox"].gw-switch:checked {
      background: var(--gw-accent);
      border-color: var(--gw-accent);
    }
    input[type="checkbox"].gw-switch:checked::after {
      background: var(--gw-accent-text);
      transform: translateX(16px);
    }
    input[type="checkbox"].gw-switch:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    input[type="checkbox"].gw-inline-check {
      display: inline-block !important;
      width: 14px !important;
      min-width: 14px !important;
      max-width: 14px !important;
      height: 14px !important;
      min-height: 0 !important;
      flex: 0 0 14px !important;
      margin: 0 !important;
      box-shadow: none !important;
      accent-color: var(--gw-accent);
      cursor: pointer;
    }
    .gw-input-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .gw-input, .gw-select {
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      color: var(--gw-text);
      padding: 7px 10px;
      font-size: 12px;
      border-radius: 6px;
      outline: none;
    }
    .gw-input {
      flex: 1 1 auto;
      min-width: 0;
    }
    .gw-input:focus, .gw-select:focus {
      border-color: var(--gw-accent);
    }
    .gw-btn {
      border: 1px solid ${theme.borderStrong};
      background: var(--gw-bg2);
      color: var(--gw-text);
      padding: 7px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .gw-btn:hover {
      opacity: 0.9;
    }
    .gw-btn-primary, .gw-btn-success {
      background: var(--gw-control-bg);
      color: var(--gw-control-text);
      border-color: var(--gw-control-border);
    }
    .gw-btn-accent {
      background: var(--gw-accent);
      color: var(--gw-accent-text);
      border-color: var(--gw-accent);
    }
    .gw-btn-danger {
      background: var(--gw-error);
      color: #ffffff;
      border-color: var(--gw-error);
    }
    .gw-btn-warning {
      background: var(--gw-warning);
      color: #1f1404;
      border-color: var(--gw-warning);
    }
    .gw-btn-sm {
      padding: 4px 8px;
      font-size: 10px;
      border-radius: 4px;
    }
    .gw-feedback {
      font-size: 11px;
      margin-top: 6px;
      line-height: 1.4;
    }
    .gw-code-chip {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      color: var(--gw-text);
    }
    .gw-copy-chip {
      cursor: pointer;
      user-select: none;
      transition: border-color 0.15s ease, opacity 0.15s ease;
    }
    .gw-copy-chip:hover, .gw-copy-chip:focus-visible {
      border-color: var(--gw-accent);
      outline: none;
    }
    .gw-details-note {
      font-size: 11px;
      line-height: 1.45;
      color: var(--gw-text-muted);
      margin-top: 6px;
    }
  `.trim();
    if (styleEl.textContent !== nextCss) {
      styleEl.textContent = nextCss;
    }
    return theme;
  }

  // src/userscripts/shared/domEngine.js
  var V5_HIGH_IMAGES_PER_PERCENT = 17.28;
  var V5_CIRCUIT_BREAKER_PERCENT = 5.5;
  var classCache = /* @__PURE__ */ new Map();
  var cachedPolicyState = {
    virtualBalance: null,
    availableAnlas: null,
    heldAnlas: 0,
    monthlyQuota: null,
    isUnlimitedAnlas: false,
    isInDebt: false,
    v5BankedNcp: null,
    v5AvailableNcp: null,
    v5MaxBankNcp: null,
    v5DailyShareNcp: null,
    v5SurplusAvailableNcp: null,
    v5SurplusEligible: true,
    isUnlimitedV5: false,
    masterV5Percent: null,
    masterV5RawPercent: null,
    masterV5IsNegative: false,
    clusterState: null,
    nextPercentEtaMs: null,
    isHardLocked: false,
    masterTokenExpired: false,
    subscriptionActive: true,
    isGracePeriod: false,
    lastFetchedAt: 0,
    activeModel: "",
    bypassEnabled: false
  };
  var queueShieldLockActive = false;
  var lastHudAlertText = "";
  var lastHudAlertSeverity = "info";
  function safeGetGm(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallback);
      }
    } catch (_) {
    }
    return fallback;
  }
  function safeSetGm(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (_) {
    }
  }
  function getClientPolicyState() {
    const merged = { ...cachedPolicyState };
    merged.bypassEnabled = Boolean(safeGetGm("anlas_bypass_enabled", merged.bypassEnabled)) && !merged.isInDebt;
    return merged;
  }
  function setClientPolicyState(partial = {}) {
    const current = getClientPolicyState();
    const next = { ...current, ...partial };
    if (next.isInDebt) {
      next.bypassEnabled = false;
      safeSetGm("anlas_bypass_enabled", false);
    }
    cachedPolicyState = next;
    return { ...next };
  }
  function isDomNodeVisible(node) {
    if (!node) return false;
    const hasComputedStyle = typeof window !== "undefined" && typeof window.getComputedStyle === "function";
    const isStyleHidden = (el) => {
      if (!el) return true;
      if (hasComputedStyle) {
        try {
          const st = window.getComputedStyle(el);
          if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) {
            return true;
          }
        } catch (_) {
        }
      }
      const inline = el.style;
      if (inline && (inline.display === "none" || inline.visibility === "hidden" || inline.opacity === "0")) {
        return true;
      }
      return false;
    };
    if (isStyleHidden(node)) return false;
    let cur = node.parentElement;
    let hops = 0;
    while (cur && hops < 16) {
      if (hasComputedStyle) {
        try {
          const st = window.getComputedStyle(cur);
          if (st && (st.display === "none" || st.opacity === "0")) {
            return false;
          }
        } catch (_) {
        }
      }
      if (cur.style && (cur.style.display === "none" || cur.style.opacity === "0")) {
        return false;
      }
      if (typeof document !== "undefined" && (cur === document.body || cur === document.documentElement)) break;
      cur = cur.parentElement;
      hops++;
    }
    return true;
  }
  function pickVisibleDomElement(selector) {
    if (typeof document === "undefined") return null;
    if (typeof document.querySelectorAll === "function") {
      const matches = document.querySelectorAll(selector);
      if (matches && matches.length > 0) {
        for (const el of matches) {
          if (el && !isInsideGuildWeaveNode(el) && isDomNodeVisible(el)) {
            return el;
          }
        }
        for (const el of matches) {
          if (el && !isInsideGuildWeaveNode(el)) {
            return el;
          }
        }
      }
    }
    return typeof document.querySelector === "function" ? document.querySelector(selector) : null;
  }
  function isCompactHudLayout() {
    if (typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth <= 640) {
      return true;
    }
    if (typeof document !== "undefined" && typeof document.getElementById === "function") {
      const v5Root = document.getElementById("gw-v5-bar");
      if (v5Root && typeof v5Root.getBoundingClientRect === "function") {
        try {
          const rect = v5Root.getBoundingClientRect();
          if (rect && typeof rect.width === "number" && rect.width > 0 && rect.width < 310) {
            return true;
          }
        } catch (_) {
        }
      }
    }
    return false;
  }
  function parseRgbaColor(cssColor) {
    if (typeof cssColor !== "string") return null;
    const trimmed = cssColor.trim().toLowerCase();
    if (!trimmed || trimmed === "transparent") {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const match = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
    if (!match) return null;
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10),
      a: match[4] !== void 0 ? parseFloat(match[4]) : 1
    };
  }
  function detectActiveEffortButton(medBtn, highBtn) {
    if (!medBtn || !highBtn) return null;
    const isMarkedActive = (btn) => btn.getAttribute("aria-pressed") === "true" || btn.getAttribute("aria-selected") === "true" || btn.getAttribute("data-active") === "true";
    const medAttr = isMarkedActive(medBtn);
    const highAttr = isMarkedActive(highBtn);
    if (medAttr !== highAttr) {
      return medAttr ? "medium" : "high";
    }
    const getBg = (btn) => {
      if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
        try {
          return window.getComputedStyle(btn).backgroundColor || "";
        } catch (_) {
        }
      }
      return btn.style ? btn.style.backgroundColor || "" : "";
    };
    const medBgRaw = getBg(medBtn);
    const highBgRaw = getBg(highBtn);
    const medRgba = parseRgbaColor(medBgRaw);
    const highRgba = parseRgbaColor(highBgRaw);
    if (medRgba && highRgba) {
      if (medRgba.a > 0 && highRgba.a === 0) return "medium";
      if (highRgba.a > 0 && medRgba.a === 0) return "high";
      if (medBgRaw !== highBgRaw) {
        const parent = medBtn.parentElement;
        const parentBg = parent ? getBg(parent) : "";
        if (parentBg) {
          if (medBgRaw !== parentBg && highBgRaw === parentBg) return "medium";
          if (highBgRaw !== parentBg && medBgRaw === parentBg) return "high";
        }
        const medLuma = medRgba.r + medRgba.g + medRgba.b;
        const highLuma = highRgba.r + highRgba.g + highRgba.b;
        if (medLuma !== highLuma) {
          return medLuma > highLuma ? "medium" : "high";
        }
      }
    } else if (medBgRaw !== highBgRaw) {
      if (medBgRaw && !highBgRaw) return "medium";
      if (highBgRaw && !medBgRaw) return "high";
    }
    return null;
  }
  function isStepControlInput(input) {
    if (!input || input.tagName !== "INPUT") return false;
    if (input.id === "gw-bypass-toggle" || input.id === "settings-anlas-bypass") return false;
    const aria = (input.getAttribute("aria-label") || "").toLowerCase();
    const name = (input.getAttribute("name") || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
    const dataCtrl = (input.getAttribute("data-gw-control") || "").toLowerCase();
    return dataCtrl === "steps" || aria.includes("step") || name.includes("step") || id.includes("step");
  }
  function isInsideGuildWeaveNode(node) {
    if (!node) return false;
    if (node.id && (node.id.startsWith("gw-") || node.id.startsWith("vps-"))) return true;
    if (typeof node.closest === "function") {
      return Boolean(node.closest('[id^="gw-"]') || node.closest('[id^="vps-"]'));
    }
    return false;
  }
  function readNativeGenerationSpecsFromDOM(activeModel = "") {
    const isMed = isV5MediumModel(activeModel);
    let width = 1024;
    let height = 1024;
    let steps = isMed ? 14 : 23;
    let samples = 1;
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
      return { width, height, area: width * height, steps, samples };
    }
    let foundWidth = null;
    let foundHeight = null;
    let foundSteps = null;
    let foundSamples = null;
    let hiddenWidth = null;
    let hiddenHeight = null;
    let hiddenSteps = null;
    let hiddenSamples = null;
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      if (!input || isInsideGuildWeaveNode(input)) continue;
      const aria = (input.getAttribute("aria-label") || "").toLowerCase();
      const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();
      const name = (input.getAttribute("name") || "").toLowerCase();
      const id = (input.id || "").toLowerCase();
      const numVal = parseInt(input.value, 10);
      if (!Number.isFinite(numVal) || numVal <= 0) continue;
      const visible = isDomNodeVisible(input);
      if (isStepControlInput(input)) {
        if (visible) foundSteps = numVal;
        else if (hiddenSteps === null) hiddenSteps = numVal;
      } else if (aria === "width" || placeholder === "width" || name === "width" || id.includes("width")) {
        if (visible) foundWidth = numVal;
        else if (hiddenWidth === null) hiddenWidth = numVal;
      } else if (aria === "height" || placeholder === "height" || name === "height" || id.includes("height")) {
        if (visible) foundHeight = numVal;
        else if (hiddenHeight === null) hiddenHeight = numVal;
      } else if (aria.includes("number of images") || aria.includes("samples") || name === "n_samples" || id.includes("sample")) {
        if (visible) foundSamples = numVal;
        else if (hiddenSamples === null) hiddenSamples = numVal;
      }
    }
    if (foundWidth === null) foundWidth = hiddenWidth;
    if (foundHeight === null) foundHeight = hiddenHeight;
    if (foundSteps === null) foundSteps = hiddenSteps;
    if (foundSamples === null) foundSamples = hiddenSamples;
    if (foundSamples === null) {
      const genBtn = pickVisibleDomElement(".image-gen-generate-button");
      if (genBtn) {
        const btnTextParts = [];
        for (const child of genBtn.children) {
          if (child && child.id !== "gw-button-shield" && child.textContent) {
            btnTextParts.push(child.textContent);
          }
        }
        const btnText = btnTextParts.join(" ");
        const genMatch = btnText.match(/generate\s+(\d+)\s+image/i);
        if (genMatch) {
          const parsedSamples = parseInt(genMatch[1], 10);
          if (Number.isFinite(parsedSamples) && parsedSamples > 0) {
            foundSamples = parsedSamples;
          }
        }
      }
    }
    if (foundWidth === null || foundHeight === null) {
      const candidateGroups = [];
      if (typeof document.querySelectorAll === "function") {
        candidateGroups.push(...document.querySelectorAll("div, span, button"));
      }
      const footerEl = pickVisibleDomElement(".image-gen-footer");
      for (const el of candidateGroups) {
        if (!el || isInsideGuildWeaveNode(el)) continue;
        const cls = el.getAttribute("class") || "";
        const isControlSurface = cls.includes("singleValue") || Boolean(el.getAttribute("aria-haspopup")) || footerEl && el.parentElement === footerEl;
        if (!isControlSurface) continue;
        const txt = (el.textContent || "").trim();
        if (txt.length > 48) continue;
        const resMatch = txt.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/i);
        if (resMatch) {
          const w = parseInt(resMatch[1], 10);
          const h = parseInt(resMatch[2], 10);
          if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096) {
            foundWidth = w;
            foundHeight = h;
            break;
          }
        }
      }
    }
    if (foundWidth !== null && foundHeight !== null) {
      width = foundWidth;
      height = foundHeight;
    }
    if (foundSteps !== null) steps = foundSteps;
    if (foundSamples !== null) samples = foundSamples;
    return { width, height, area: width * height, steps, samples };
  }
  function readNativeModelAndEffortFromDOM() {
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
    const modelRow = pickVisibleDomElement(".image-gen-model-mode-row");
    if (!modelRow) return null;
    let modelText = "";
    const modelInput = modelRow.querySelector('input[aria-label="Select the Model"]') || pickVisibleDomElement('input[aria-label="Select the Model"]');
    if (modelInput && modelInput.parentElement) {
      const prev = modelInput.previousElementSibling;
      const parentPrev = modelInput.parentElement.previousElementSibling;
      if (prev && prev.textContent && prev.textContent.trim()) {
        modelText = prev.textContent.trim();
      } else if (parentPrev && parentPrev.textContent && parentPrev.textContent.trim()) {
        modelText = parentPrev.textContent.trim();
      } else if (modelInput.parentElement.textContent && modelInput.parentElement.textContent.trim()) {
        modelText = modelInput.parentElement.textContent.trim();
      }
    }
    if (!modelText) {
      const allDivs = modelRow.querySelectorAll("div");
      for (const d of allDivs) {
        const cls = d.getAttribute("class") || "";
        if (cls.includes("singleValue") && d.textContent) {
          modelText = d.textContent.trim();
          break;
        }
      }
    }
    const trimmedModel = modelText.trim();
    if (!trimmedModel) {
      return null;
    }
    const isNativeV5 = !/\d[-_.]5/i.test(trimmedModel) && /(?:^|[\s\-_])v?5(?![\d.])/i.test(trimmedModel);
    if (!isNativeV5) {
      return "legacy";
    }
    const buttons = modelRow.querySelectorAll("button");
    let medBtn = null;
    let highBtn = null;
    for (const btn of buttons) {
      const label = (btn.textContent || "").trim().toLowerCase();
      if (label === "medium") medBtn = btn;
      else if (label === "high") highBtn = btn;
    }
    const activeEffort = detectActiveEffortButton(medBtn, highBtn);
    if (activeEffort === "medium") {
      return "nai-diffusion-5-full-medium";
    }
    if (activeEffort === "high") {
      return "nai-diffusion-5-full";
    }
    const current = getClientPolicyState().activeModel || "";
    return isV5ModelFamily(current) ? current : "nai-diffusion-5-full";
  }
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
  function syncNavBadgeAppearance(badgeBtn, menuBtn) {
    const btnClasses = getElementClasses(menuBtn, "nav_menu_btn");
    if (btnClasses && badgeBtn.className !== btnClasses) {
      badgeBtn.className = btnClasses;
      badgeBtn.style.backgroundColor = "";
      badgeBtn.style.borderColor = "";
      badgeBtn.style.color = "";
    }
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      try {
        const menuStyle = window.getComputedStyle(menuBtn);
        const badgeStyle = window.getComputedStyle(badgeBtn);
        if (menuStyle && badgeStyle) {
          if (menuStyle.backgroundColor && badgeStyle.backgroundColor !== menuStyle.backgroundColor) {
            badgeBtn.style.backgroundColor = menuStyle.backgroundColor;
          }
          if (menuStyle.color && badgeStyle.color !== menuStyle.color) {
            badgeBtn.style.color = menuStyle.color;
          }
          const mBorder = menuStyle.borderTopColor || menuStyle.borderColor;
          const bBorder = badgeStyle.borderTopColor || badgeStyle.borderColor;
          if (mBorder && bBorder !== mBorder) {
            badgeBtn.style.borderColor = mBorder;
          }
        }
      } catch (_) {
      }
    }
  }
  function injectNavBadge(onClickHandler) {
    const menuBtn = pickVisibleDomElement('button[aria-label="menu"]');
    if (!menuBtn || !menuBtn.parentElement) return false;
    const existing = document.getElementById("gw-nav-badge");
    if (existing) {
      if (existing.parentElement === menuBtn.parentElement) {
        syncNavBadgeAppearance(existing, menuBtn);
        return true;
      }
      existing.remove();
    }
    const badgeBtn = document.createElement("button");
    badgeBtn.id = "gw-nav-badge";
    badgeBtn.setAttribute("aria-label", "GuildWeave Settings");
    badgeBtn.setAttribute("title", "GuildWeave Settings");
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
    syncNavBadgeAppearance(badgeBtn, menuBtn);
    return true;
  }
  function injectAllowanceBar() {
    const genBtn = pickVisibleDomElement(".image-gen-generate-button");
    if (!genBtn || !genBtn.parentElement) return false;
    const existing = document.getElementById("gw-allowance-bar");
    if (existing) {
      if (existing.parentElement === genBtn.parentElement && existing.nextElementSibling === genBtn) {
        return true;
      }
      existing.remove();
    }
    const theme = ensureGuildWeaveStyles();
    const barRoot = document.createElement("div");
    barRoot.id = "gw-allowance-bar";
    barRoot.style.cssText = `
    display: none;
    flex-direction: column;
    gap: 4px;
    padding: 6px 9px 7px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, ${theme.borderStrong});
    background-color: var(--theme-bg0, ${theme.bg0});
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
    color: var(--theme-text, ${theme.text});
    font-size: 0.75rem;
    font-weight: 600;
  `.replace(/\s+/g, " ").trim();
    labelSpan.textContent = "Image Allowance: --/100";
    headerRow.appendChild(labelSpan);
    const trackDiv = document.createElement("div");
    trackDiv.id = "gw-allowance-track";
    trackDiv.style.cssText = `
    height: 4px;
    width: 100%;
    background: var(--theme-bg2, ${theme.border});
    border-radius: 999px;
    overflow: hidden;
    position: relative;
  `.replace(/\s+/g, " ").trim();
    const fillDiv = document.createElement("div");
    fillDiv.id = "gw-allowance-fill";
    fillDiv.style.cssText = `
    height: 100%;
    width: 100%;
    background-color: var(--theme-accent, ${theme.accent});
    border-radius: 999px;
    transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;
  `.replace(/\s+/g, " ").trim();
    trackDiv.appendChild(fillDiv);
    barRoot.appendChild(headerRow);
    barRoot.appendChild(trackDiv);
    genBtn.parentElement.insertBefore(barRoot, genBtn);
    return true;
  }
  function refreshDualLedgerHud() {
    ensureGuildWeaveStyles();
    injectDualLedgerBar();
    const nativeModel = readNativeModelAndEffortFromDOM();
    if (nativeModel) {
      setClientPolicyState({ activeModel: nativeModel });
    }
    const latest = getClientPolicyState();
    renderDualLedgerHudFromState(latest);
    syncUIControlConstraints(latest);
    return latest;
  }
  function injectDualLedgerBar() {
    injectAllowanceBar();
    const allowanceBar = document.getElementById("gw-allowance-bar");
    if (!allowanceBar || !allowanceBar.parentElement) return false;
    const existing = document.getElementById("gw-v5-bar");
    if (existing) {
      if (existing.parentElement === allowanceBar.parentElement && existing.nextElementSibling === allowanceBar) {
        return true;
      }
      existing.remove();
    }
    const theme = ensureGuildWeaveStyles();
    const v5Root = document.createElement("div");
    v5Root.id = "gw-v5-bar";
    v5Root.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 7px 9px 8px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, ${theme.borderStrong});
    background-color: var(--theme-bg0, ${theme.bg0});
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 4px;
    box-sizing: border-box;
  `.replace(/\s+/g, " ").trim();
    const v5HeaderRow = document.createElement("div");
    v5HeaderRow.className = "gw-hud-row";
    v5HeaderRow.style.cssText = "display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px;";
    const v5Label = document.createElement("span");
    v5Label.id = "gw-v5-label";
    v5Label.style.cssText = `color: var(--theme-text, ${theme.text}); font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
    v5Label.textContent = "V5 Allowance: Syncing...";
    const v5Eta = document.createElement("span");
    v5Eta.id = "gw-v5-eta";
    v5Eta.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
    v5Eta.textContent = "";
    v5HeaderRow.appendChild(v5Label);
    v5HeaderRow.appendChild(v5Eta);
    const v5Track = document.createElement("div");
    v5Track.id = "gw-v5-track";
    v5Track.style.cssText = `height: 4px; width: 100%; background: var(--theme-bg2, ${theme.border}); border-radius: 999px; overflow: hidden; position: relative;`;
    const v5Fill = document.createElement("div");
    v5Fill.id = "gw-v5-fill";
    v5Fill.style.cssText = `height: 100%; width: 100%; background-color: var(--theme-accent, ${theme.accent}); border-radius: 999px; transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;`;
    v5Track.appendChild(v5Fill);
    const controlsRow = document.createElement("div");
    controlsRow.className = "gw-hud-row";
    controlsRow.style.cssText = "display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;";
    const anlasLabel = document.createElement("span");
    anlasLabel.id = "gw-anlas-label";
    anlasLabel.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
    anlasLabel.textContent = "Monthly Anlas: --";
    anlasLabel.setAttribute("title", "Resets each billing cycle; unused Anlas does not roll over.");
    const rightControls = document.createElement("div");
    rightControls.className = "gw-hud-right";
    rightControls.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const costBadge = document.createElement("span");
    costBadge.id = "gw-v5-cost";
    costBadge.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
    costBadge.textContent = "";
    const state = getClientPolicyState();
    const bypassLabel = document.createElement("label");
    bypassLabel.id = "gw-bypass-label";
    bypassLabel.style.cssText = `display: inline-flex; align-items: center; gap: 5px; font-size: 0.68rem; cursor: pointer; color: var(--theme-textSecondary, ${theme.textMuted}); white-space: nowrap;`;
    bypassLabel.setAttribute("title", "Enable spending monthly Anlas for sizes >1MP, >1 image, or >28 steps.");
    const bypassCheckbox = document.createElement("input");
    bypassCheckbox.type = "checkbox";
    bypassCheckbox.id = "gw-bypass-toggle";
    bypassCheckbox.className = "gw-inline-check";
    bypassCheckbox.checked = Boolean(state.bypassEnabled) && !state.isInDebt;
    bypassCheckbox.disabled = Boolean(state.isInDebt);
    bypassCheckbox.style.cssText = "width: 14px; min-width: 14px; flex: 0 0 14px; margin: 0; cursor: pointer;";
    bypassCheckbox.onchange = () => {
      const latest = getClientPolicyState();
      if (latest.isInDebt) {
        bypassCheckbox.checked = false;
        bypassCheckbox.disabled = true;
        return;
      }
      const nextVal = Boolean(bypassCheckbox.checked);
      safeSetGm("anlas_bypass_enabled", nextVal);
      setClientPolicyState({ bypassEnabled: nextVal });
      const modalBypass = document.getElementById("settings-anlas-bypass");
      if (modalBypass) modalBypass.checked = nextVal;
      refreshDualLedgerHud();
    };
    const bypassText = document.createElement("span");
    bypassText.id = "gw-bypass-text";
    bypassText.textContent = state.isInDebt ? "Anlas Paused" : "Use Anlas";
    bypassLabel.appendChild(bypassCheckbox);
    bypassLabel.appendChild(bypassText);
    rightControls.appendChild(costBadge);
    rightControls.appendChild(bypassLabel);
    controlsRow.appendChild(anlasLabel);
    controlsRow.appendChild(rightControls);
    const alertDiv = document.createElement("div");
    alertDiv.id = "gw-hud-alert";
    alertDiv.style.cssText = `display: none; font-size: 0.68rem; line-height: 1.35; padding: 4px 7px; border-radius: 5px; background: var(--theme-bg1, ${theme.bg1}); border: 1px solid ${theme.border}; color: var(--theme-warning, ${theme.warning});`;
    v5Root.appendChild(v5HeaderRow);
    v5Root.appendChild(v5Track);
    v5Root.appendChild(controlsRow);
    v5Root.appendChild(alertDiv);
    allowanceBar.parentElement.insertBefore(v5Root, allowanceBar);
    if (lastHudAlertText) {
      setHudAlert(lastHudAlertText, lastHudAlertSeverity);
    }
    renderDualLedgerHudFromState(getClientPolicyState());
    return true;
  }
  function setHudAlert(message, severity = "warning") {
    lastHudAlertText = message || "";
    lastHudAlertSeverity = severity;
    const alertEl = document.getElementById("gw-hud-alert");
    if (!alertEl) return;
    if (!message) {
      alertEl.style.display = "none";
      alertEl.textContent = "";
      return;
    }
    const theme = ensureGuildWeaveStyles();
    alertEl.style.display = "block";
    alertEl.textContent = message;
    alertEl.style.backgroundColor = `var(--theme-bg1, ${theme.bg1})`;
    alertEl.style.borderColor = theme.border;
    if (severity === "error") {
      alertEl.style.color = `var(--theme-error, ${theme.error})`;
    } else if (severity === "info") {
      alertEl.style.color = `var(--theme-accent, ${theme.accent})`;
    } else {
      alertEl.style.color = `var(--theme-warning, ${theme.warning})`;
    }
  }
  function formatNextPercentEta(etaMs, compact = false) {
    if (typeof etaMs !== "number" || !Number.isFinite(etaMs)) return "";
    if (etaMs <= 0) return "Full";
    const mins = Math.max(0.1, etaMs / 6e4);
    if (mins >= 60) {
      return compact ? `+${(mins / 60).toFixed(1)}h` : `+1% in ${(mins / 60).toFixed(1)}h`;
    }
    return compact ? `+${mins.toFixed(1)}m` : `+1% in ${mins.toFixed(1)}m`;
  }
  function formatReadableClusterState(clusterState) {
    switch (clusterState) {
      case "surplus_active":
        return "Shared Bonus Open";
      case "reserve_mode":
        return "Personal Allowance";
      case "throttled":
        return "Low Shared Pool";
      case "frozen":
        return "Recharging";
      case "token_expired":
        return "Session Expired";
      case "telemetry_offline":
        return "Syncing";
      default:
        return "";
    }
  }
  function resolveClusterStateColor(clusterState, theme) {
    if (clusterState === "frozen" || clusterState === "token_expired") return `var(--theme-error, ${theme.error})`;
    if (clusterState === "throttled" || clusterState === "telemetry_offline") return `var(--theme-warning, ${theme.warning})`;
    return `var(--theme-accent, ${theme.accent})`;
  }
  function computeClientSpendableMasterNcp(state) {
    if (typeof state.masterV5Percent !== "number" || !Number.isFinite(state.masterV5Percent)) {
      return null;
    }
    if (state.isHardLocked || state.subscriptionActive === false || state.masterTokenExpired) {
      return 0;
    }
    const rawPct = typeof state.masterV5RawPercent === "number" && Number.isFinite(state.masterV5RawPercent) ? state.masterV5RawPercent : state.masterV5Percent;
    return Math.floor(Math.max(0, rawPct - V5_CIRCUIT_BREAKER_PERCENT) * V5_HIGH_IMAGES_PER_PERCENT * V5_HIGH_NCP_COST);
  }
  function renderDualLedgerHudFromState(state) {
    const theme = ensureGuildWeaveStyles();
    const compact = isCompactHudLayout();
    const v5Root = document.getElementById("gw-v5-bar");
    const v5Track = document.getElementById("gw-v5-track");
    const v5Label = document.getElementById("gw-v5-label");
    const v5Eta = document.getElementById("gw-v5-eta");
    const v5Fill = document.getElementById("gw-v5-fill");
    const anlasLabel = document.getElementById("gw-anlas-label");
    const costBadge = document.getElementById("gw-v5-cost");
    const bypassCheckbox = document.getElementById("gw-bypass-toggle");
    const bypassText = document.getElementById("gw-bypass-text");
    const modalBypass = document.getElementById("settings-anlas-bypass");
    const allowanceRoot = document.getElementById("gw-allowance-bar");
    const allowanceLabel = document.getElementById("gw-allowance-label");
    const allowanceTrack = document.getElementById("gw-allowance-track");
    const shieldEl = document.getElementById("gw-button-shield");
    const shieldTextEl = document.getElementById("gw-shield-text");
    if (v5Root) {
      v5Root.style.backgroundColor = `var(--theme-bg0, ${theme.bg0})`;
      v5Root.style.border = `1px solid var(--theme-bg2, ${theme.borderStrong})`;
      if (compact) {
        v5Root.className = "gw-v5-compact";
      } else if (v5Root.className === "gw-v5-compact") {
        v5Root.className = "";
      }
    }
    if (v5Track) {
      v5Track.style.background = theme.border;
    }
    if (allowanceRoot) {
      allowanceRoot.style.backgroundColor = `var(--theme-bg0, ${theme.bg0})`;
      allowanceRoot.style.border = `1px solid var(--theme-bg2, ${theme.borderStrong})`;
    }
    if (allowanceLabel) {
      allowanceLabel.style.color = `var(--theme-text, ${theme.text})`;
    }
    if (allowanceTrack) {
      allowanceTrack.style.background = theme.border;
    }
    if (shieldEl) {
      shieldEl.style.background = `var(--theme-bg1, ${theme.bg1})`;
      shieldEl.style.border = `1px solid var(--theme-accent, ${theme.borderStrong})`;
    }
    if (shieldTextEl) {
      shieldTextEl.style.color = `var(--theme-textHeadings, ${theme.text})`;
    }
    const activeModel = state.activeModel || "";
    const isV5 = isV5ModelFamily(activeModel);
    const isMed = isV5MediumModel(activeModel);
    const specs = readNativeGenerationSpecsFromDOM(activeModel);
    const isBaseAnlasBypass = Boolean(state.bypassEnabled) && (specs.area > FIREWALL_MAX_PIXELS || specs.samples !== FIREWALL_MAX_SAMPLES || isV5 && !isMed && specs.steps > FIREWALL_MAX_STEPS);
    const spendableMasterNcp = computeClientSpendableMasterNcp(state);
    const pctText = typeof state.masterV5Percent === "number" && Number.isFinite(state.masterV5Percent) ? `${state.masterV5Percent.toFixed(1)}%` : "--%";
    if (v5Label && v5Fill) {
      v5Label.style.color = `var(--theme-text, ${theme.text})`;
      if (state.masterTokenExpired || state.clusterState === "token_expired") {
        v5Label.textContent = compact ? "Token Expired" : "Master Token Expired (Awaiting Admin)";
        v5Label.setAttribute("title", "The shared NovelAI session token expired and needs to be refreshed by an admin.");
        v5Fill.style.width = "0%";
        v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
      } else if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
        v5Label.textContent = compact ? "Sub Inactive" : "Master Subscription Inactive";
        v5Fill.style.width = "0%";
        v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
      } else if (state.isHardLocked) {
        v5Label.textContent = compact ? `Recharging (${pctText})` : `V5 Recharging (${pctText} <= 5.5%)`;
        v5Label.setAttribute("title", "Shared V5 capacity must stay above 5.5% to prevent a cluster-wide cooldown. Legacy models and Anlas-paid specs still work.");
        const widthPct = typeof state.masterV5Percent === "number" ? Math.max(0, Math.min(100, state.masterV5Percent)) : 0;
        v5Fill.style.width = `${widthPct}%`;
        v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
      } else if (state.isUnlimitedV5) {
        v5Label.textContent = compact ? "V5: Unlimited" : `V5 Allowance: Unlimited \xB7 Pool: ${pctText}`;
        v5Fill.style.width = "100%";
        v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState, theme);
      } else if (typeof state.v5AvailableNcp === "number") {
        const effectiveNcp = spendableMasterNcp !== null && state.lastFetchedAt > 0 ? Math.min(state.v5AvailableNcp, spendableMasterNcp) : state.v5AvailableNcp;
        const effectiveSurplus = spendableMasterNcp !== null && state.lastFetchedAt > 0 && typeof state.v5SurplusAvailableNcp === "number" ? Math.min(state.v5SurplusAvailableNcp, spendableMasterNcp) : state.v5SurplusAvailableNcp || 0;
        const highLeft = Math.floor(effectiveNcp / V5_HIGH_NCP_COST);
        const medLeft = Math.floor(effectiveNcp / V5_MEDIUM_NCP_COST);
        const maxNcp = typeof state.v5MaxBankNcp === "number" && state.v5MaxBankNcp > 0 ? state.v5MaxBankNcp : state.v5AvailableNcp;
        const surplusHigh = state.v5SurplusEligible && effectiveSurplus >= V5_HIGH_NCP_COST ? Math.floor(effectiveSurplus / V5_HIGH_NCP_COST) : 0;
        const surplusSuffix = surplusHigh > 0 ? ` (+${surplusHigh} Bonus)` : "";
        const depleted = effectiveNcp < V5_MEDIUM_NCP_COST && (!state.v5SurplusEligible || effectiveSurplus < V5_MEDIUM_NCP_COST);
        if (compact) {
          v5Label.textContent = depleted ? "V5 Limit Reached" : `V5: ${highLeft}H/${medLeft}M${surplusHigh > 0 ? `+${surplusHigh}` : ""}`;
        } else {
          v5Label.textContent = depleted ? `V5 Limit Reached \xB7 Pool: ${pctText}` : `V5 Free: ${highLeft} High / ${medLeft} Med${surplusSuffix} \xB7 Pool: ${pctText}`;
        }
        v5Label.setAttribute(
          "title",
          `Personal Reserve: ${effectiveNcp}/${maxNcp} V5 credits (accumulates daily up to 3 days). Bonus Pool activates above 50% shared pool.`
        );
        const barPct = maxNcp > 0 ? Math.min(100, Math.max(0, effectiveNcp / maxNcp * 100)) : 0;
        v5Fill.style.width = `${barPct}%`;
        v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState, theme);
      } else {
        v5Label.textContent = compact ? "V5: Syncing" : `V5 Allowance: Syncing \xB7 Pool: ${pctText}`;
      }
    }
    if (v5Eta) {
      v5Eta.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
      const fullEtaStr = formatNextPercentEta(state.nextPercentEtaMs, false);
      const fullStateLabel = formatReadableClusterState(state.clusterState);
      const fullCombo = [fullStateLabel, fullEtaStr].filter(Boolean).join(" \xB7 ");
      if (compact) {
        if (state.masterTokenExpired || state.clusterState === "token_expired") {
          v5Eta.textContent = "Admin Reset";
        } else if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
          v5Eta.textContent = "Paused";
        } else {
          const shortEta = formatNextPercentEta(state.nextPercentEtaMs, true);
          v5Eta.textContent = [pctText !== "--%" ? pctText : "", shortEta].filter(Boolean).join(" \xB7 ") || fullStateLabel;
        }
        if (fullCombo) {
          v5Eta.setAttribute("title", `${fullCombo} (Shared Pool ${pctText})`);
        }
      } else {
        v5Eta.textContent = fullCombo;
      }
    }
    if (costBadge) {
      if (!activeModel || isV5 && isBaseAnlasBypass) {
        costBadge.style.display = "none";
        costBadge.textContent = "";
      } else if (isMed) {
        costBadge.style.display = "";
        costBadge.textContent = compact ? `${V5_MEDIUM_NCP_COST} pts` : `Uses ${V5_MEDIUM_NCP_COST} V5 pts (Med)`;
        costBadge.setAttribute("title", `Medium effort uses ${V5_MEDIUM_NCP_COST} credits vs ${V5_HIGH_NCP_COST} on High.`);
        costBadge.style.color = `var(--theme-text, ${theme.text})`;
      } else if (isV5) {
        costBadge.style.display = "";
        costBadge.textContent = compact ? `${V5_HIGH_NCP_COST} pts` : `Uses ${V5_HIGH_NCP_COST} V5 pts (High)`;
        costBadge.setAttribute("title", `High effort uses ${V5_HIGH_NCP_COST} credits per free-size generation.`);
        costBadge.style.color = `var(--theme-text, ${theme.text})`;
      } else {
        costBadge.style.display = "";
        costBadge.textContent = compact ? "Legacy" : "Legacy (0 V5 pts)";
        costBadge.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
      }
    }
    if (anlasLabel) {
      if (state.isUnlimitedAnlas) {
        anlasLabel.textContent = compact ? "Anlas: Unlimited" : "Monthly Anlas: Unlimited";
        anlasLabel.style.color = `var(--theme-text, ${theme.text})`;
      } else if (state.isInDebt) {
        anlasLabel.textContent = compact ? `Anlas: ${state.virtualBalance} (Paused)` : `Anlas Overdrawn: ${state.virtualBalance} (Paid Paused)`;
        anlasLabel.style.color = `var(--theme-error, ${theme.error})`;
      } else if (typeof state.availableAnlas === "number") {
        const quotaSuffix = typeof state.monthlyQuota === "number" ? `/${state.monthlyQuota}` : "";
        anlasLabel.textContent = compact ? `Anlas: ${state.availableAnlas}${quotaSuffix}` : `Monthly Anlas: ${state.availableAnlas}${quotaSuffix}`;
        anlasLabel.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
      } else {
        anlasLabel.textContent = compact ? "Anlas: --" : "Monthly Anlas: --";
        anlasLabel.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
      }
    }
    if (bypassCheckbox && bypassText) {
      if (state.isInDebt) {
        bypassCheckbox.checked = false;
        bypassCheckbox.disabled = true;
        bypassText.textContent = compact ? "Paused" : "Anlas Paused";
        bypassText.style.color = `var(--theme-error, ${theme.error})`;
      } else {
        bypassCheckbox.disabled = false;
        bypassCheckbox.checked = Boolean(state.bypassEnabled);
        bypassText.textContent = "Use Anlas";
        bypassText.style.color = state.bypassEnabled ? `var(--theme-accent, ${theme.accent})` : `var(--theme-textSecondary, ${theme.textMuted})`;
      }
    }
    if (modalBypass) {
      if (state.isInDebt) {
        modalBypass.checked = false;
        modalBypass.disabled = true;
      } else {
        modalBypass.disabled = false;
        modalBypass.checked = Boolean(state.bypassEnabled);
      }
    }
    if (!queueShieldLockActive) {
      if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
        setGenerateLockoutState(true, "Subscription Inactive");
      } else if (isV5 && !isBaseAnlasBypass && !state.bypassEnabled && !state.masterTokenExpired && state.clusterState !== "token_expired") {
        if (state.isHardLocked) {
          setGenerateLockoutState(true, "V5 Recharging");
        } else if (typeof state.v5AvailableNcp === "number" && !state.isUnlimitedV5 && state.lastFetchedAt > 0) {
          const reqNcp = isMed ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST;
          const effectiveNcp = spendableMasterNcp !== null ? Math.min(state.v5AvailableNcp, spendableMasterNcp) : state.v5AvailableNcp;
          const effectiveSurplus = spendableMasterNcp !== null && typeof state.v5SurplusAvailableNcp === "number" ? Math.min(state.v5SurplusAvailableNcp, spendableMasterNcp) : state.v5SurplusAvailableNcp || 0;
          const surplusAvail = state.v5SurplusEligible ? effectiveSurplus : 0;
          if (effectiveNcp < reqNcp && surplusAvail < reqNcp) {
            setGenerateLockoutState(true, "V5 Allowance Reached");
          } else {
            setGenerateLockoutState(false, "");
          }
        } else {
          setGenerateLockoutState(false, "");
        }
      } else {
        setGenerateLockoutState(false, "");
      }
    }
  }
  function updateDualLedgerHud(statusData) {
    if (!statusData || typeof statusData !== "object") {
      return getClientPolicyState();
    }
    const patch = {};
    if (statusData.anlas && typeof statusData.anlas === "object") {
      const anlas = statusData.anlas;
      const isInDebt = Boolean(anlas.is_in_debt);
      const currentBypass = Boolean(safeGetGm("anlas_bypass_enabled", false)) && !isInDebt;
      if (isInDebt) {
        safeSetGm("anlas_bypass_enabled", false);
      }
      patch.virtualBalance = anlas.virtual_balance;
      patch.availableAnlas = anlas.available_balance;
      patch.heldAnlas = anlas.held || 0;
      patch.monthlyQuota = anlas.monthly_quota;
      patch.isUnlimitedAnlas = Boolean(anlas.is_unlimited);
      patch.isInDebt = isInDebt;
      patch.bypassEnabled = currentBypass;
    }
    if (statusData.v5 && typeof statusData.v5 === "object") {
      const v5 = statusData.v5;
      patch.v5BankedNcp = v5.banked_ncp;
      patch.v5AvailableNcp = v5.available_ncp;
      patch.v5MaxBankNcp = v5.max_bank_ncp;
      patch.v5DailyShareNcp = v5.daily_share_ncp;
      patch.v5SurplusAvailableNcp = v5.surplus_available_ncp;
      patch.v5SurplusEligible = Boolean(v5.surplus_eligible);
      patch.isUnlimitedV5 = Boolean(v5.is_unlimited);
    }
    if (statusData.telemetry && typeof statusData.telemetry === "object") {
      const telemetry = statusData.telemetry;
      patch.masterV5Percent = telemetry.master_v5_percent;
      patch.masterV5RawPercent = telemetry.master_v5_raw_percent;
      patch.masterV5IsNegative = Boolean(telemetry.master_v5_is_negative);
      patch.clusterState = telemetry.cluster_state;
      patch.nextPercentEtaMs = telemetry.next_percent_eta_ms;
      patch.isHardLocked = Boolean(telemetry.is_hard_locked);
      patch.masterTokenExpired = Boolean(telemetry.master_token_expired) || telemetry.cluster_state === "token_expired";
      patch.subscriptionActive = telemetry.subscription_active !== false;
      patch.isGracePeriod = Boolean(telemetry.is_grace_period);
      patch.lastFetchedAt = telemetry.last_fetched_at || 0;
    } else if (statusData.master_v5_percent !== void 0) {
      patch.masterV5Percent = statusData.master_v5_percent;
    }
    setClientPolicyState(patch);
    return refreshDualLedgerHud();
  }
  function syncUIControlConstraints(state = getClientPolicyState()) {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    const activeModel = state.activeModel || "";
    const isMed = isV5MediumModel(activeModel);
    const isV5High = isV5ModelFamily(activeModel) && !isMed;
    let deadbandTriggered = false;
    let foundStepInput = false;
    let hasStepInDeadband = false;
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      if (!isStepControlInput(input)) continue;
      foundStepInput = true;
      const numVal = parseInt(input.value, 10);
      if (Number.isFinite(numVal) && numVal >= 24 && numVal <= 28) {
        hasStepInDeadband = true;
      }
      if (isMed) {
        input.setAttribute("min", "1");
        input.setAttribute("max", "28");
      } else if (isV5High && !state.bypassEnabled) {
        input.setAttribute("min", "1");
        input.setAttribute("max", "23");
        if (Number.isFinite(numVal) && numVal >= 24 && numVal <= 28) {
          deadbandTriggered = true;
          setHudAlert(
            "V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24\u201328 are blocked to protect shared V5 limits\u2014use \u226423 steps or switch to Medium.",
            "warning"
          );
        }
      } else {
        input.setAttribute("min", "1");
        input.setAttribute("max", state.bypassEnabled ? "50" : "28");
      }
    }
    if (!deadbandTriggered && lastHudAlertText && lastHudAlertText.includes("24\u201328") && (!isV5High || foundStepInput && !hasStepInDeadband)) {
      setHudAlert("", "info");
    }
  }
  function scrapeDisplayedAnlasCost() {
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
    const genBtn = pickVisibleDomElement(".image-gen-generate-button");
    if (!genBtn) return null;
    const isInsideShield = (node) => {
      let cur = node;
      while (cur && cur !== genBtn) {
        if (cur.id === "gw-button-shield" || cur.id === "gw-shield-text") return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const isInsideGenerateLabel = (node) => {
      let cur = node;
      while (cur && cur !== genBtn) {
        const text = (cur.textContent || "").trim();
        if (/generate/i.test(text) || /image/i.test(text)) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const badgeNode = genBtn.querySelector(".native-anlas-container");
    if (badgeNode && !isInsideShield(badgeNode)) {
      const badgeText = (badgeNode.textContent || "").trim();
      const match = badgeText.match(/(\d+)\s*anlas/i) || badgeText.match(/^(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
    const candidates = genBtn.querySelectorAll("span");
    for (const node of candidates) {
      if (!node || isInsideShield(node)) continue;
      const text = (node.textContent || "").trim();
      if (!text || /generate/i.test(text) || /image/i.test(text)) continue;
      const anlasMatch = text.match(/^(\d+)\s*anlas$/i);
      if (anlasMatch) {
        return parseInt(anlasMatch[1], 10);
      }
    }
    for (const node of candidates) {
      if (!node || isInsideShield(node) || isInsideGenerateLabel(node)) continue;
      const text = (node.textContent || "").trim();
      const pureNumMatch = text.match(/^(\d+)$/);
      if (pureNumMatch) {
        return parseInt(pureNumMatch[1], 10);
      }
    }
    return null;
  }
  function updateAllowanceBar(allowance, maxAllowance, nextRefillMs = 0) {
    injectAllowanceBar();
    injectDualLedgerBar();
    const barRoot = document.getElementById("gw-allowance-bar");
    const labelSpan = document.getElementById("gw-allowance-label");
    const fillDiv = document.getElementById("gw-allowance-fill");
    if (!barRoot || !labelSpan || !fillDiv) return;
    const theme = ensureGuildWeaveStyles();
    if (allowance === null || maxAllowance === Infinity) {
      barRoot.style.display = "none";
      labelSpan.textContent = "Image Allowance: Unlimited";
      fillDiv.style.width = "100%";
      fillDiv.style.backgroundColor = `var(--theme-accent, ${theme.accent})`;
      return;
    }
    barRoot.style.display = "flex";
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
    labelSpan.textContent = `Image Allowance: ${clampedAllowance}/${max}${refillSuffix}`;
    fillDiv.style.width = `${percent}%`;
    if (percent < 20) {
      fillDiv.style.backgroundColor = `var(--theme-error, ${theme.error})`;
    } else if (percent < 50) {
      fillDiv.style.backgroundColor = `var(--theme-warning, ${theme.warning})`;
    } else {
      fillDiv.style.backgroundColor = `var(--theme-accent, ${theme.accent})`;
    }
  }
  function injectQueueShield() {
    const genBtn = pickVisibleDomElement(".image-gen-generate-button");
    if (!genBtn) return false;
    const existing = document.getElementById("gw-button-shield");
    if (existing) {
      if (existing.parentElement === genBtn) {
        return true;
      }
      existing.remove();
    }
    const theme = ensureGuildWeaveStyles();
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
    background: var(--theme-bg1, ${theme.bg1}) !important;
    border-radius: inherit !important;
    border: 1px solid var(--theme-accent, ${theme.borderStrong}) !important;
    cursor: wait !important;
    display: none;
    pointer-events: none;
    align-items: center;
    justify-content: center;
    opacity: 1 !important;
  `.replace(/\s+/g, " ").trim();
    const pulseIndicator = document.createElement("div");
    pulseIndicator.style.cssText = `width:8px; height:8px; border-radius:50%; background:var(--theme-accent, ${theme.accent}); margin-right:8px; animation:gwPulse 1s infinite alternate; flex-shrink:0;`;
    const labelText = document.createElement("span");
    labelText.id = "gw-shield-text";
    labelText.style.cssText = `font-weight:bold; font-size:13px; color:var(--theme-textHeadings, ${theme.text}); white-space:nowrap; letter-spacing:0.5px;`;
    labelText.textContent = "Joining Queue...";
    shield.appendChild(pulseIndicator);
    shield.appendChild(labelText);
    genBtn.appendChild(shield);
    return true;
  }
  function applyButtonShieldVisual(active, text, cursor = "wait") {
    injectQueueShield();
    const shield = document.getElementById("gw-button-shield");
    const labelText = document.getElementById("gw-shield-text");
    if (!shield || !labelText) return;
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
      shield.style.cursor = cursor;
    } else {
      shield.style.display = "none";
      shield.style.pointerEvents = "none";
    }
  }
  function setQueueShieldState(active, text = "") {
    queueShieldLockActive = Boolean(active);
    if (active) {
      applyButtonShieldVisual(true, text || "Processing Queue...", "wait");
    } else {
      applyButtonShieldVisual(false, "", "wait");
      renderDualLedgerHudFromState(getClientPolicyState());
    }
  }
  function setGenerateLockoutState(locked, reasonText = "") {
    if (queueShieldLockActive) return;
    applyButtonShieldVisual(Boolean(locked), reasonText || "V5 Allowance Reached", "not-allowed");
  }
  var observerInstance = null;
  var headObserverInstance = null;
  var rafScheduled = false;
  var observedInputRoot = null;
  var inputConstraintHandler = null;
  var resizeHandler = null;
  function initDOMObserver(options = {}) {
    stopDOMObserver();
    const runSync = () => {
      rafScheduled = false;
      injectNavBadge(options.onOpenSettings);
      injectAllowanceBar();
      injectDualLedgerBar();
      injectQueueShield();
      refreshDualLedgerHud();
    };
    const scheduleSync = () => {
      if (!rafScheduled) {
        rafScheduled = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(runSync);
        } else {
          setTimeout(runSync, 16);
        }
      }
    };
    observerInstance = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.target) {
          if (m.target.id && (m.target.id.startsWith("gw-") || m.target.id.startsWith("vps-"))) continue;
          if (typeof m.target.closest === "function" && (m.target.closest('[id^="gw-"]') || m.target.closest('[id^="vps-"]'))) continue;
        }
        if (m.type === "attributes") {
          relevant = true;
          break;
        }
        if (m.addedNodes && m.addedNodes.length > 0 || m.removedNodes && m.removedNodes.length > 0) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        scheduleSync();
      }
    });
    const root = document.body || document.documentElement;
    if (root) {
      observerInstance.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "aria-pressed", "aria-selected"]
      });
      if (typeof root.addEventListener === "function") {
        observedInputRoot = root;
        inputConstraintHandler = (ev) => {
          if (ev && ev.target && !isInsideGuildWeaveNode(ev.target)) {
            refreshDualLedgerHud();
          }
        };
        root.addEventListener("input", inputConstraintHandler, true);
        root.addEventListener("change", inputConstraintHandler, true);
      }
    }
    if (typeof document !== "undefined" && document.head && document.head !== root) {
      headObserverInstance = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.target && m.target.id === "gw-ui-styles") continue;
          const touchesOwnStyle = Array.from(m.addedNodes || []).some((n) => n && n.id === "gw-ui-styles") || Array.from(m.removedNodes || []).some((n) => n && n.id === "gw-ui-styles");
          if (!touchesOwnStyle) {
            scheduleSync();
            break;
          }
        }
      });
      headObserverInstance.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      resizeHandler = scheduleSync;
      window.addEventListener("resize", resizeHandler);
    }
    runSync();
  }
  function stopDOMObserver() {
    if (observerInstance) {
      observerInstance.disconnect();
      observerInstance = null;
    }
    if (headObserverInstance) {
      headObserverInstance.disconnect();
      headObserverInstance = null;
    }
    if (observedInputRoot && inputConstraintHandler && typeof observedInputRoot.removeEventListener === "function") {
      observedInputRoot.removeEventListener("input", inputConstraintHandler, true);
      observedInputRoot.removeEventListener("change", inputConstraintHandler, true);
    }
    if (resizeHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", resizeHandler);
    }
    observedInputRoot = null;
    inputConstraintHandler = null;
    resizeHandler = null;
  }

  // src/userscripts/shared/ui.js
  function showQueueStatusBanner(text) {
    setQueueShieldState(true, text);
  }
  function hideQueueStatusBanner() {
    setQueueShieldState(false, "");
  }
  function injectWarningBadge(message, bgColor) {
    if (document.getElementById("vps-debug-badge")) return;
    const badge = document.createElement("div");
    badge.id = "vps-debug-badge";
    badge.textContent = message;
    badge.style.cssText = `position:fixed; top:10px; left:50%; transform:translateX(-50%); background:${bgColor}; color:#fff; font-weight:600; font-size:11px; padding:6px 14px; border-radius:999px; z-index:99999; box-shadow:0 4px 12px rgba(0,0,0,0.45); pointer-events:none; font-family:sans-serif;`;
    const root = document.body || document.documentElement;
    if (root) root.appendChild(badge);
  }
  function removeWarningBadge() {
    const badge = document.getElementById("vps-debug-badge");
    if (badge) badge.remove();
  }

  // src/userscripts/shared/params.js
  async function extractImageParams(body) {
    if (!body) return null;
    const parseOptionalIntLocal = (val, fallback = null) => {
      if (typeof val === "number") {
        if (!Number.isFinite(val)) return fallback;
        const t = Math.trunc(val);
        if (t > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
        if (t < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
        return t;
      }
      if (typeof val === "string") {
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
      if (typeof val === "number") {
        return Number.isFinite(val) ? val : null;
      }
      if (typeof val === "string") {
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
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        formHasImage = typeof body.has === "function" ? body.has("image") : Boolean(body.get("image"));
        formHasMask = typeof body.has === "function" ? body.has("mask") : Boolean(body.get("mask"));
        const requestBlob = body.get("request");
        if (!requestBlob) return null;
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
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const params = payload.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters) ? payload.parameters : payload;
        const rawModel = typeof payload.model === "string" ? payload.model.trim() : typeof params.model === "string" ? params.model.trim() : "";
        const isV5Medium = !/\d[-_.]5/i.test(rawModel) && /(?:^|[-_])v?5(?:[-_]|$)/i.test(rawModel) && /medium/i.test(rawModel);
        const preciseRefs = (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) + (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0);
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
        if (rawVibeRefs === void 0 || rawVibeRefs === null) {
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
        const resolvedSteps = parsedSteps !== null && parsedSteps > 0 ? parsedSteps : isV5Medium ? 14 : 28;
        return {
          width: parsedWidth !== null && parsedWidth > 0 ? parsedWidth : 1024,
          height: parsedHeight !== null && parsedHeight > 0 ? parsedHeight : 1024,
          steps: resolvedSteps,
          has_explicit_steps: parsedSteps !== null && parsedSteps > 0,
          n_samples: parsedSamples !== null && parsedSamples > 0 ? parsedSamples : 1,
          precise_refs: preciseRefs,
          model: rawModel,
          sm: rawSm === true || rawSm === "true" || rawSm === 1,
          sm_dyn: rawSmDyn === true || rawSmDyn === "true" || rawSmDyn === 1,
          strength: parsedStrength !== null ? Math.max(0, Math.min(1, parsedStrength)) : null,
          inpaintImg2ImgStrength: parsedInpaintStrength !== null ? Math.max(0, Math.min(1, parsedInpaintStrength)) : null,
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

  // src/userscripts/shared/interceptor.js
  var envConfig = {
    browserId: "",
    deviceSecret: "",
    VPS_HOST: "",
    logPrefix: "GuildWeave",
    onRevoked: () => {
    },
    onTelemetryRefresh: () => {
    }
  };
  function initInterceptor(config) {
    envConfig = { ...envConfig, ...config };
    hijackFetch();
  }
  async function tryResolveProxyResponse(responseDetails, resolveObj, isImageGen, countAsTextGen = false, refreshTelemetry = isImageGen) {
    const status = extractStatusCode(responseDetails);
    if (status === 0) {
      return false;
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
      if ((isImageGen || refreshTelemetry) && typeof envConfig.onTelemetryRefresh === "function") {
        setTimeout(() => {
          try {
            envConfig.onTelemetryRefresh();
          } catch (_) {
          }
        }, 0);
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
      console.error("[GuildWeave] Telemetry: Proxy returned exception status code:", status);
      if (status === 401) {
        console.warn("[GuildWeave] Revocation signature caught. Restoring setup lock.");
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
        console.error("[GuildWeave] Error: Failed to extract string from raw exception stream:", e);
      }
      console.log(`[GuildWeave] Telemetry: Received raw error text: "${errorText}"`);
      let parsedError = null;
      try {
        if (errorText) parsedError = JSON.parse(errorText);
      } catch (e) {
      }
      if (parsedError && parsedError.error === "DEBT_LOCKED") {
        GM_setValue("anlas_bypass_enabled", false);
        setClientPolicyState({ isInDebt: true, bypassEnabled: false });
        refreshDualLedgerHud();
        setHudAlert(parsedError.message || "Anlas overdrawn. Paid features paused until balance is restored.", "error");
      } else if (parsedError && (parsedError.message || parsedError.error) && (status === 400 || status === 403 || status === 426 || status === 429 || status === 503)) {
        setHudAlert(parsedError.message || parsedError.error, status === 403 || status === 426 || status === 503 ? "error" : "warning");
      }
      if (typeof envConfig.onTelemetryRefresh === "function" && (status === 403 || status === 429 || status === 503)) {
        setTimeout(() => {
          try {
            envConfig.onTelemetryRefresh();
          } catch (_) {
          }
        }, 0);
      }
      const responseBody = parsedError && (parsedError.statusCode || parsedError.message || parsedError.error) ? JSON.stringify({
        statusCode: parsedError.statusCode || status,
        error: parsedError.error,
        message: parsedError.message || parsedError.error || errorText || "GuildWeave error"
      }) : JSON.stringify({
        statusCode: status,
        message: errorText || "GuildWeave error"
      });
      resolveObj(new Response(responseBody, {
        status,
        headers: parseResponseHeaders(responseDetails.responseHeaders)
      }));
      return true;
    }
  }
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
        if (typeof envConfig.onRevoked === "function") {
          envConfig.onRevoked();
        }
        return new Response(JSON.stringify({ statusCode: 401, message: "Device revoked." }), { status: 401 });
      }
      if (joinRes.status !== 200) {
        let errorDetails = {};
        try {
          errorDetails = JSON.parse(joinRes.responseText || "{}");
        } catch (e) {
          console.error(`[${envConfig.logPrefix}]: Failed to parse error response text safely`, e);
        }
        hideQueueStatusBanner();
        if (errorDetails.error === "ALLOWANCE_EXHAUSTED") {
          const msg = "Allowance Exhausted: You have run out of image tokens. Allowance refills at a rate of 1 image per 30 minutes (max 100).";
          setHudAlert(msg, "error");
          return new Response(JSON.stringify({
            statusCode: 403,
            error: "ALLOWANCE_EXHAUSTED",
            message: msg
          }), { status: 403 });
        }
        if (errorDetails.error === "DEBT_LOCKED") {
          GM_setValue("anlas_bypass_enabled", false);
          setClientPolicyState({ isInDebt: true, bypassEnabled: false });
          refreshDualLedgerHud();
        }
        if (typeof envConfig.onTelemetryRefresh === "function" && (joinRes.status === 403 || joinRes.status === 429 || joinRes.status === 503)) {
          setTimeout(() => {
            try {
              envConfig.onTelemetryRefresh();
            } catch (_) {
            }
          }, 0);
        }
        if (joinRes.status === 400 || joinRes.status === 403 || joinRes.status === 426 || joinRes.status === 429 || joinRes.status === 503) {
          const msg = errorDetails.message || errorDetails.error || "Queue admission rejected.";
          setHudAlert(msg, joinRes.status === 403 || joinRes.status === 426 || joinRes.status === 503 ? "error" : "warning");
          return new Response(JSON.stringify({
            statusCode: joinRes.status,
            error: errorDetails.error,
            message: msg
          }), {
            status: joinRes.status,
            headers: { "Content-Type": "application/json" }
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
        return new Response(JSON.stringify({ statusCode: 502, message: "Queue teardown aborted" }), { status: 502 });
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
    for (const [k, v] of Object.entries(proxyHeaders)) {
      if (v !== void 0 && v !== null) {
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
    if (typeof FormData !== "undefined" && config.body instanceof FormData) {
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
      setHudAlert("Displayed cost may differ from estimate.", "warning");
    } else if (policy.ok) {
      setHudAlert("", "info");
    }
    if (!policy.ok) {
      hideQueueStatusBanner();
      setHudAlert(policy.message, policy.status === 403 ? "error" : "warning");
      return new Response(JSON.stringify({
        statusCode: policy.status,
        error: policy.error,
        message: policy.message
      }), {
        status: policy.status,
        headers: { "Content-Type": "application/json" }
      });
    }
    const isV5Medium = isV5MediumModel(imgParams.model);
    const isV5 = isV5ModelFamily(imgParams.model);
    const joinPayload = {
      browser_id: envConfig.browserId,
      tab_id,
      req_id,
      ...imgParams.model ? { model: imgParams.model } : {},
      steps: imgParams.steps,
      width: imgParams.width,
      height: imgParams.height,
      n_samples: imgParams.n_samples,
      is_base_paid: policy.isBasePaid,
      is_v5: policy.isV5,
      declared_anlas: policy.costDetails.total
    };
    const proxyHeaders = {
      "x-gen-width": imgParams.width.toString(),
      "x-gen-height": imgParams.height.toString(),
      // Stage 5 Invariant: forward exact body steps (14 default for Medium / 28 default otherwise when absent)
      "x-gen-steps": imgParams.steps.toString(),
      "x-gen-samples": imgParams.n_samples.toString(),
      "x-precise-refs": imgParams.precise_refs.toString(),
      "x-gen-model": isV5Medium ? "V5-medium" : isV5 ? "V5" : "legacy",
      "x-base-paid": policy.isBasePaid ? "true" : "false",
      "x-declared-anlas": policy.costDetails.total.toString(),
      ...scrapedAnlas !== null ? { "x-scraped-anlas": scrapedAnlas.toString() } : {}
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
  async function handleUpscaleIntercept(url, config) {
    const req_id = "req_" + generateUUID();
    const tab_id = typeof sessionStorage !== "undefined" && sessionStorage.getItem("vps_tab_id") || (() => {
      const tid = "t_" + generateUUID();
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem("vps_tab_id", tid);
      }
      return tid;
    })();
    const dims = await extractUpscaleBodyParams(config.body);
    const currentState = getClientPolicyState();
    const policy = evaluateUpscalePolicy(dims, currentState);
    if (!policy.ok) {
      hideQueueStatusBanner();
      setHudAlert(policy.message, policy.status === 403 ? "error" : "warning");
      return new Response(JSON.stringify({
        statusCode: policy.status,
        error: policy.error,
        message: policy.message
      }), {
        status: policy.status,
        headers: { "Content-Type": "application/json" }
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
      "x-gen-width": dims.width.toString(),
      "x-gen-height": dims.height.toString(),
      "x-declared-anlas": policy.cost.toString()
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
  async function handleTextGenerationIntercept(url, config, defaultMethod = "POST", options = {}) {
    const { countAsTextGen = true, refreshTelemetry = false } = options;
    const requestMethod = config.method || defaultMethod;
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
      console.log(`[GuildWeave Debug Mode] Outbound text/telemetry payload:`, config.body);
    }
    updatedHeaders.delete("host");
    updatedHeaders.delete("content-length");
    if (typeof FormData !== "undefined" && config.body instanceof FormData) {
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
  function hijackFetch() {
    const targetWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null;
    if (!targetWindow || typeof targetWindow.fetch !== "function") {
      console.error("[GuildWeave] Fatal: Target window fetch interface is unavailable.");
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
              const policyState = getClientPolicyState();
              const hasKnownFiniteAnlas = typeof policyState.availableAnlas === "number" && Number.isFinite(policyState.availableAnlas) && !policyState.isUnlimitedAnlas;
              const fixedAnlas = hasKnownFiniteAnlas ? Math.max(0, Math.trunc(policyState.availableAnlas)) : 9999;
              const purchasedAnlas = hasKnownFiniteAnlas ? 0 : 9999;
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
          return handleTextGenerationIntercept(urlString, config, "GET", {
            countAsTextGen: false,
            refreshTelemetry: false
          });
        }
        if (urlString.includes("/ai/generate-image") && !urlString.includes("/suggest-tags")) {
          return handleGenerationIntercept(urlString, config);
        }
        if (urlString.includes("/ai/upscale")) {
          return handleUpscaleIntercept(urlString, config);
        }
        if (urlString.includes("/ai/generate-stream") || urlString.includes("/oa/v1/completions")) {
          return handleTextGenerationIntercept(urlString, config, "POST", {
            countAsTextGen: true,
            refreshTelemetry: false
          });
        }
        if (urlString.includes("/ai/encode-vibe")) {
          return handleTextGenerationIntercept(urlString, config, "POST", {
            countAsTextGen: false,
            refreshTelemetry: true
          });
        }
      }
      return originalFetch(...args);
    };
  }

  // src/userscripts/guest/index.js
  console.log("GuildWeave (Guest): Script injected successfully at document-start.");
  var browserId = GM_getValue("browser_id");
  var deviceSecret = GM_getValue("device_secret");
  var approved = GM_getValue("approved", false);
  var VPS_HOST = GM_getValue("vps_host", "");
  var DEFAULT_BYPASS_HINT = "Enables sizes >1MP, batches (>1), and >28 steps using monthly Anlas. On V5 High, steps 24\u201328 remain blocked to protect shared limits\u2014use \u226423 steps, Medium, or 29+ steps.";
  function parseVersionUpgradeMessage(responseText) {
    let msg = "Your GuildWeave Tampermonkey userscript is outdated. Please update to the latest version to proceed.";
    try {
      const parsed = JSON.parse(responseText || "{}");
      if (parsed && typeof parsed.message === "string" && parsed.message.trim().length > 0) {
        msg = parsed.message;
      }
    } catch (_) {
    }
    return msg;
  }
  try {
    if (!browserId || !deviceSecret) {
      browserId = "b_" + generateUUID();
      deviceSecret = "s_" + generateUUID();
      GM_setValue("browser_id", browserId);
      GM_setValue("device_secret", deviceSecret);
      GM_setValue("approved", false);
      approved = false;
      console.log("GuildWeave (Guest): Initialized clean device identity credentials.");
    }
    console.log(`GuildWeave (Guest): ID = ${browserId}, Approved = ${approved}`);
  } catch (err) {
    console.error("GuildWeave (Guest): Storage initialization crash:", err);
  }
  var enforcementInterval = null;
  function startUIEnforcement() {
    if (enforcementInterval) return;
    console.log("GuildWeave (Guest): Starting high-frequency UI enforcement loop...");
    enforcementInterval = setInterval(() => {
      if (!document.body) return;
      let overlay = document.getElementById("vps-approval-overlay");
      if (!overlay) {
        console.log("GuildWeave (Guest): UI overlay was missing or deleted by React. Re-injecting...");
        const theme = ensureGuildWeaveStyles();
        overlay = document.createElement("div");
        overlay.id = "vps-approval-overlay";
        overlay.style.cssText = `position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:var(--theme-bg0, ${theme.bg0}) !important; color:var(--theme-text, ${theme.text}) !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:inherit !important;`;
        document.body.appendChild(overlay);
        renderSetupWizard(overlay);
      }
    }, 50);
  }
  function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card")) return;
    const theme = ensureGuildWeaveStyles();
    const safeHost = escapeHtml(GM_getValue("vps_host", ""));
    const safeNick = escapeHtml(GM_getValue("device_nickname", ""));
    container.innerHTML = `
        <div class="setup-wizard-card gw-card" style="background:var(--gw-bg1, ${theme.bg1}); padding:28px; border-radius:12px; border:1px solid var(--gw-card-border, ${theme.cardBorder || theme.borderStrong}); box-shadow:0 12px 36px rgba(0,0,0,0.6); max-width:90vw; width:430px; color:var(--theme-text, ${theme.text});">
            <h3 style="margin:0 0 18px 0; color:var(--theme-accent, ${theme.accent}); text-align:center; font-size:18px; font-weight:700;">GuildWeave Setup</h3>
            
            <div id="step-1-container" style="margin-bottom:18px;">
                <label class="gw-section-title" for="setup-domain">1. GuildWeave Server URL</label>
                <div class="gw-input-row">
                    <input type="text" id="setup-domain" class="gw-input" value="${safeHost}" placeholder="https://your-domain.duckdns.org">
                    <button id="btn-verify-domain" class="gw-btn gw-btn-primary">Verify</button>
                </div>
                <div id="step-1-status" class="gw-feedback" style="display:none;"></div>
            </div>

            <div id="step-2-container" style="margin-bottom:18px; display:none;">
                <label class="gw-section-title" for="setup-nickname">2. Device Name</label>
                <div class="gw-input-row">
                    <input type="text" id="setup-nickname" class="gw-input" value="${safeNick}" placeholder="e.g. Desktop, Laptop">
                    <button id="btn-register-nickname" class="gw-btn gw-btn-success">Register</button>
                </div>
                <div id="step-2-status" class="gw-feedback" style="display:none;"></div>
            </div>

            <div id="step-3-container" style="display:none; border-top:1px solid ${theme.border}; padding-top:14px; margin-top:14px;">
                <label class="gw-section-title">3. Link on Discord</label>
                <div id="step-3-content" class="gw-details-note"></div>
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
        step1Status.style.color = `var(--theme-error, ${theme.error})`;
        step1Status.textContent = "Server URL cannot be empty.";
        return;
      }
      if (!/^https?:\/\//i.test(val)) {
        val = "https://" + val;
      }
      step1Status.style.display = "block";
      step1Status.style.color = `var(--theme-warning, ${theme.warning})`;
      step1Status.textContent = "Connecting to server...";
      try {
        const res = await backgroundRequest({
          method: "GET",
          url: `${val}/auth/status?browser_id=ping`
        });
        if (res.status > 0) {
          step1Status.style.color = `var(--theme-success, ${theme.success})`;
          step1Status.textContent = "Connected to GuildWeave.";
          GM_setValue("vps_host", val);
          validatedHost = val;
          step2Container.style.display = "block";
          domainInput.disabled = true;
          verifyBtn.disabled = true;
        } else {
          throw new Error("Bad response status");
        }
      } catch (err) {
        step1Status.style.color = `var(--theme-error, ${theme.error})`;
        step1Status.textContent = "Connection failed. Check that the domain is reachable.";
      }
    }
    async function registerNicknameAction() {
      const newNickname = nicknameInput.value.trim();
      if (!newNickname) {
        step2Status.style.display = "block";
        step2Status.style.color = `var(--theme-error, ${theme.error})`;
        step2Status.textContent = "Device name cannot be empty.";
        return;
      }
      if (!/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
        step2Status.style.display = "block";
        step2Status.style.color = `var(--theme-error, ${theme.error})`;
        step2Status.textContent = "Use only letters, numbers, spaces, or underscores.";
        return;
      }
      step2Status.style.display = "block";
      step2Status.style.color = `var(--theme-warning, ${theme.warning})`;
      step2Status.textContent = "Registering device...";
      try {
        const res = await backgroundRequest({
          method: "POST",
          url: `${validatedHost}/auth/register`,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: newNickname })
        });
        if (res.status === 200) {
          step2Status.style.color = `var(--theme-success, ${theme.success})`;
          step2Status.textContent = "Device registered.";
          GM_setValue("device_nickname", newNickname);
          validatedNickname = newNickname;
          nicknameInput.disabled = true;
          registerBtn.disabled = true;
          step3Container.style.display = "block";
          showStep3();
        } else if (res.status === 426) {
          step2Status.style.color = `var(--theme-error, ${theme.error})`;
          step2Status.textContent = parseVersionUpgradeMessage(res.responseText);
        } else {
          throw new Error("Registration rejected");
        }
      } catch (err) {
        step2Status.style.color = `var(--theme-error, ${theme.error})`;
        step2Status.textContent = "Registration failed on server.";
      }
    }
    function showStep3() {
      const safeFullBid = escapeHtml(browserId);
      step3Content.innerHTML = `
            <p style="margin: 0 0 8px 0; font-weight: 600; color: var(--theme-text, ${theme.text});">Link this browser via Discord:</p>
            <p style="margin: 0 0 10px 0;">Run this command in your Discord server to finish linking:</p>
            <div role="button" tabindex="0" class="gw-code-chip gw-copy-chip" data-copy-id="/link browser_id:${safeFullBid}" title="Click to copy command" style="display:block; padding:10px; text-align:center; word-break:break-all; color:var(--theme-warning, ${theme.warning}); margin-bottom:10px;">
                /link browser_id:${safeFullBid}
            </div>
            <p id="step-3-poll-status" style="margin:0; font-size:11px; text-align:center; animation: gwPulse 1.5s infinite alternate;">Waiting for approval...</p>
        `;
      attachCopyChipHandlers(step3Content);
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
          } else if (res.status === 426) {
            const pollStatusEl = step3Content.querySelector("#step-3-poll-status");
            if (pollStatusEl) {
              pollStatusEl.style.animation = "none";
              pollStatusEl.style.color = `var(--theme-error, ${theme.error})`;
              pollStatusEl.style.fontWeight = "600";
              pollStatusEl.textContent = parseVersionUpgradeMessage(res.responseText);
            }
          } else if (res.status === 401) {
            console.warn("GuildWeave (Guest): Server returned 401 during poll. Re-registering silently...");
            const nickname = GM_getValue("device_nickname", "Guest");
            backgroundRequest({
              method: "POST",
              url: `${validatedHost}/auth/register`,
              headers: { "Content-Type": "application/json" },
              data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
            }).catch((err) => console.error("GuildWeave (Guest): Silent re-registration failed:", err));
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
      step1Status.style.color = `var(--theme-success, ${theme.success})`;
      step1Status.textContent = "Connected";
      domainInput.disabled = true;
      verifyBtn.disabled = true;
      step2Container.style.display = "block";
      if (validatedNickname) {
        nicknameInput.value = validatedNickname;
        step2Status.style.display = "block";
        step2Status.style.color = `var(--theme-success, ${theme.success})`;
        step2Status.textContent = "Registered";
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
      setInterval(pollTelemetryState, 1e4);
    }, renderSettingsPanelContent = function(container, onClose) {
      const theme = ensureGuildWeaveStyles();
      const nickname = GM_getValue("device_nickname", "Guest");
      const domain = GM_getValue("vps_host", "");
      const debugActive = GM_getValue("debug_mode", false);
      const policyState = getClientPolicyState();
      const bypassChecked = Boolean(policyState.bypassEnabled) && !policyState.isInDebt;
      container.innerHTML = `
            <div class="gw-modal-header">
                <h4 class="gw-modal-title">GuildWeave <span class="gw-pill-tag">Guest</span></h4>
                ${onClose ? `<button id="guest-close-modal-btn" class="gw-close-btn" aria-label="Close">\u2715</button>` : ""}
            </div>

            <div class="gw-card">
                <span class="gw-section-title">Account Overview &amp; Allowances</span>
                <div class="gw-stat-grid">
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Tier</span>
                        <span id="guest-assigned-tier" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Character Reference Limit</span>
                        <span id="guest-precise-limit" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Monthly Anlas</span>
                        <span id="guest-virtual-anlas" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">V5 Free Generations</span>
                        <span id="guest-v5-bank" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Shared Bonus Pool</span>
                        <span id="guest-v5-surplus" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Shared V5 Capacity</span>
                        <span id="guest-v5-battery" class="gw-stat-val">Loading...</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">This Billing Cycle</span>
                        <span id="guest-period-usage" class="gw-stat-val">0 Anlas \xB7 0 images</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Total Anlas Used</span>
                        <span id="guest-anlas-consumed" class="gw-stat-val">0 Anlas</span>
                    </div>
                    <div id="guest-rolling-allowance-row" class="gw-stat-item" style="display:none; grid-column: span 2;">
                        <span class="gw-stat-label">Metered Image Allowance</span>
                        <span id="guest-rolling-allowance" class="gw-stat-val">Loading...</span>
                    </div>
                </div>
                <div class="gw-details-note" style="margin-top:10px; padding-top:8px; border-top:1px solid ${theme.border};">
                    <strong>How V5 Allowance Works:</strong> Each day adds free V5 generations to your personal reserve (up to 3 days saved). High effort uses 1 High slot; Medium effort costs ~44% less. When the shared pool is above 50%, a free bonus pool opens once personal slots run out.
                </div>
            </div>

            <div class="gw-card">
                <label class="gw-toggle-row" for="settings-anlas-bypass">
                    <div class="gw-toggle-copy">
                        <span class="gw-toggle-title">Use Monthly Anlas for Extra Specs</span>
                        <span id="settings-bypass-status" class="gw-toggle-desc">
                            ${policyState.isInDebt ? `<span style="color:var(--theme-error, ${theme.error}); font-weight:600;">Anlas Overdrawn: ${escapeHtml(policyState.virtualBalance)} (Paid Features Paused)</span>` : escapeHtml(DEFAULT_BYPASS_HINT)}
                        </span>
                    </div>
                    <input type="checkbox" id="settings-anlas-bypass" class="gw-switch" ${bypassChecked ? "checked" : ""} ${policyState.isInDebt ? "disabled" : ""}>
                </label>
            </div>

            <div class="gw-card">
                <span class="gw-section-title">Device Settings</span>
                <div style="margin-bottom:12px;">
                    <label class="gw-stat-label" for="settings-nickname" style="display:block; margin-bottom:5px;">Device Name</label>
                    <div class="gw-input-row">
                        <input type="text" id="settings-nickname" class="gw-input" value="${escapeHtml(nickname)}">
                        <button id="btn-save-nickname" class="gw-btn gw-btn-success">Save</button>
                    </div>
                    <div id="settings-nickname-status" class="gw-feedback" style="display:none;"></div>
                </div>

                <div style="margin-bottom:12px;">
                    <label class="gw-stat-label" for="settings-domain" style="display:block; margin-bottom:5px;">GuildWeave Server URL</label>
                    <div class="gw-input-row">
                        <input type="text" id="settings-domain" class="gw-input" value="${escapeHtml(domain)}">
                        <button id="btn-save-domain" class="gw-btn">Save &amp; Reset</button>
                    </div>
                </div>

                <div style="padding-top:10px; border-top:1px solid ${theme.border};">
                    <span class="gw-stat-label" style="display:block; margin-bottom:5px;">Linked Browsers (Up to 3)</span>
                    <div id="guest-linked-devices" class="gw-details-note" style="margin-top:0; display:flex; flex-direction:column; gap:4px;">
                        No linked browsers found.
                    </div>
                    <div class="gw-details-note">Remove old browsers in Discord using <span class="gw-code-chip">/mygateway unlink</span>.</div>
                </div>
            </div>

            <div class="gw-card" style="margin-bottom:0;">
                <label class="gw-toggle-row" for="settings-debug">
                    <div class="gw-toggle-copy">
                        <span class="gw-toggle-title">Share Generation Logs for Troubleshooting</span>
                        <span class="gw-toggle-desc">When authorized by an admin, shares your prompt and generation parameters in server logs to diagnose issues. <b>This includes input images (e.g., image2image, Precise References).</b> Personal account tokens stay strictly on your device. <b>When turned off (default), your prompts remain fully private.</b></span>
                    </div>
                    <input type="checkbox" id="settings-debug" class="gw-switch" ${debugActive ? "checked" : ""}>
                </label>
                <div id="debug-intent-status" class="gw-feedback" style="color:var(--theme-textSecondary, ${theme.textMuted});">
                    ${debugActive ? "Waiting for admin confirmation." : "Disabled"}
                </div>
            </div>
        `;
      if (onClose) {
        const closeBtn = container.querySelector("#guest-close-modal-btn");
        if (closeBtn) closeBtn.onclick = onClose;
      }
      const bypassToggle = container.querySelector("#settings-anlas-bypass");
      const bypassStatusEl = container.querySelector("#settings-bypass-status");
      if (bypassToggle) {
        bypassToggle.onchange = () => {
          const latest = getClientPolicyState();
          if (latest.isInDebt) {
            bypassToggle.checked = false;
            bypassToggle.disabled = true;
            return;
          }
          const checked = Boolean(bypassToggle.checked);
          GM_setValue("anlas_bypass_enabled", checked);
          setClientPolicyState({ bypassEnabled: checked });
          refreshDualLedgerHud();
        };
      }
      if (domain && deviceSecret) {
        backgroundRequest({
          method: "GET",
          url: `${domain}/auth/status?browser_id=${browserId}`,
          headers: { "Authorization": `Bearer ${deviceSecret}` }
        }).then((res) => {
          if (res.status === 200) {
            const data = JSON.parse(res.responseText);
            updateDualLedgerHud(data);
            const tierEl = container.querySelector("#guest-assigned-tier");
            if (tierEl) tierEl.textContent = data.tier || "Normal";
            const refEl = container.querySelector("#guest-precise-limit");
            if (refEl) refEl.textContent = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} max`;
            const anlasEl = container.querySelector("#guest-anlas-consumed");
            if (anlasEl) anlasEl.textContent = `${data.anlas_consumed || 0} Anlas`;
            const virtualEl = container.querySelector("#guest-virtual-anlas");
            if (virtualEl && data.anlas) {
              if (data.anlas.is_unlimited) {
                virtualEl.textContent = "Unlimited";
              } else if (data.anlas.is_in_debt) {
                virtualEl.innerHTML = `<span style="color:var(--theme-error, ${theme.error});">${escapeHtml(data.anlas.virtual_balance)} (Paused)</span>`;
              } else {
                virtualEl.textContent = `${data.anlas.available_balance}/${data.anlas.monthly_quota} (Resets monthly)`;
              }
            }
            const v5BankEl = container.querySelector("#guest-v5-bank");
            if (v5BankEl && data.v5) {
              if (data.v5.is_unlimited) {
                v5BankEl.textContent = "Unlimited";
              } else {
                const highAvail = Math.floor((data.v5.available_ncp || 0) / V5_HIGH_NCP_COST);
                const medAvail = Math.floor((data.v5.available_ncp || 0) / V5_MEDIUM_NCP_COST);
                v5BankEl.textContent = `${highAvail} High / ${medAvail} Med`;
                v5BankEl.setAttribute("title", `${data.v5.available_ncp}/${data.v5.max_bank_ncp ?? data.v5.banked_ncp} V5 credits`);
              }
            }
            const surplusEl = container.querySelector("#guest-v5-surplus");
            if (surplusEl && data.v5) {
              if (!data.v5.surplus_eligible) {
                surplusEl.textContent = "Not eligible";
              } else {
                const surHigh = Math.floor((data.v5.surplus_available_ncp || 0) / V5_HIGH_NCP_COST);
                surplusEl.textContent = surHigh > 0 ? `+${surHigh} High shared` : "None available";
              }
            }
            const batteryEl = container.querySelector("#guest-v5-battery");
            if (batteryEl && data.telemetry) {
              if (data.telemetry.master_token_expired) {
                batteryEl.innerHTML = `<span style="color:var(--theme-error, ${theme.error});">Session Expired</span>`;
              } else if (data.telemetry.last_fetched_at === 0) {
                batteryEl.innerHTML = `<span style="color:var(--theme-warning, ${theme.warning});">Syncing</span>`;
              } else {
                const pct = typeof data.telemetry.master_v5_percent === "number" ? `${data.telemetry.master_v5_percent.toFixed(1)}%` : "--%";
                const eta = typeof data.telemetry.next_percent_eta_ms === "number" && data.telemetry.next_percent_eta_ms > 0 ? ` (+1% in ${(data.telemetry.next_percent_eta_ms / 6e4).toFixed(1)}m)` : "";
                batteryEl.textContent = `${pct}${eta}`;
              }
            }
            const periodEl = container.querySelector("#guest-period-usage");
            if (periodEl && data.subscription_period) {
              const sp = data.subscription_period;
              const totalImgs = (sp.v5_consumed || 0) + (sp.legacy_image_gens || 0) + (sp.upscale_gens || 0);
              const parts = [`${sp.anlas_consumed || 0} Anlas`, `${totalImgs} images`];
              if ((sp.text_gens || 0) > 0) parts.push(`${sp.text_gens} text`);
              periodEl.textContent = parts.join(" \xB7 ");
            }
            if (bypassToggle && bypassStatusEl && data.anlas) {
              if (data.anlas.is_in_debt) {
                bypassToggle.checked = false;
                bypassToggle.disabled = true;
                bypassStatusEl.innerHTML = `<span style="color:var(--theme-error, ${theme.error}); font-weight:600;">Anlas Overdrawn: ${escapeHtml(data.anlas.virtual_balance)} (Paid Features Paused)</span>`;
              } else {
                bypassToggle.disabled = false;
                bypassToggle.checked = Boolean(GM_getValue("anlas_bypass_enabled", false));
                bypassStatusEl.textContent = DEFAULT_BYPASS_HINT;
              }
            }
            const sessionRow = container.querySelector("#guest-rolling-allowance-row");
            const sessionEl = container.querySelector("#guest-rolling-allowance");
            if (sessionRow && sessionEl) {
              if (data.session) {
                sessionRow.style.display = "flex";
                const allowance = data.session.allowance;
                const maxAllowance = data.session.max || 100;
                const refillInMins = (data.session.next_refill_in / 1e3 / 60).toFixed(1);
                const refillText = allowance < maxAllowance ? ` (+1 in ${refillInMins}m)` : " (Full)";
                sessionEl.textContent = `${allowance}/${maxAllowance} images${refillText}`;
              } else {
                sessionRow.style.display = "none";
              }
            }
            const devicesEl = container.querySelector("#guest-linked-devices");
            if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
              devicesEl.innerHTML = data.linked_devices.map((d) => {
                const fullId = escapeHtml(d.id || "");
                const shortId = escapeHtml((d.id || "").substring(0, 10));
                return `<div><span role="button" tabindex="0" class="gw-code-chip gw-copy-chip" data-copy-id="${fullId}" title="Click to copy full browser ID (${fullId})">${shortId}...</span> ${escapeHtml(d.label)}</div>`;
              }).join("");
              attachCopyChipHandlers(devicesEl);
            }
            const debugStatus = container.querySelector("#debug-intent-status");
            if (debugStatus) {
              if (data.debug_authorized) {
                const mins = (data.debug_expires_in_ms / 6e4).toFixed(1);
                debugStatus.innerHTML = `<span style="color:var(--theme-success, ${theme.success}); font-weight:600;">Active (${mins}m remaining)</span>`;
              } else if (data.debug_intent) {
                debugStatus.innerHTML = `<span style="color:var(--theme-warning, ${theme.warning}); font-weight:600;">Waiting for admin confirmation.</span>`;
              } else {
                debugStatus.textContent = "Disabled";
              }
            }
          } else if (res.status === 426) {
            const msg = parseVersionUpgradeMessage(res.responseText);
            const tierEl = container.querySelector("#guest-assigned-tier");
            if (tierEl) tierEl.innerHTML = `<span style="color:var(--theme-error, ${theme.error});">Update Required</span>`;
            setHudAlert(msg, "error");
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
          nickStatus.style.color = `var(--theme-error, ${theme.error})`;
          nickStatus.textContent = "Use only letters, numbers, spaces, or underscores.";
          return;
        }
        nickStatus.style.display = "block";
        nickStatus.style.color = `var(--theme-warning, ${theme.warning})`;
        nickStatus.textContent = "Saving...";
        try {
          const res = await backgroundRequest({
            method: "POST",
            url: `${domain}/auth/update-label`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
            data: JSON.stringify({ browser_id: browserId, label: newNickname })
          });
          if (res.status === 200) {
            nickStatus.style.color = `var(--theme-success, ${theme.success})`;
            nickStatus.textContent = "Saved.";
            GM_setValue("device_nickname", newNickname);
          } else if (res.status === 426) {
            nickStatus.style.color = `var(--theme-error, ${theme.error})`;
            nickStatus.textContent = parseVersionUpgradeMessage(res.responseText);
          } else {
            throw new Error("Update failed");
          }
        } catch (err) {
          nickStatus.style.color = `var(--theme-error, ${theme.error})`;
          nickStatus.textContent = "Failed to save device name.";
        }
      };
      saveDomBtn.onclick = () => {
        let val = domInput.value.trim().replace(/\/+$/, "");
        if (!val) return;
        if (!/^https?:\/\//i.test(val)) val = "https://" + val;
        GM_setValue("vps_host", val);
        GM_setValue("approved", false);
        if (typeof onClose === "function") onClose();
        window.location.reload();
      };
      debugCheckbox.onchange = async () => {
        const checked = debugCheckbox.checked;
        GM_setValue("debug_mode", checked);
        if (checked) injectWarningBadge("GuildWeave Troubleshooting Logs Requested", `var(--theme-warning, ${theme.warning})`);
        else removeWarningBadge();
        debugIntentStatus.style.display = "block";
        debugIntentStatus.style.color = `var(--theme-warning, ${theme.warning})`;
        debugIntentStatus.textContent = checked ? "Registering troubleshooting request..." : "Disabling troubleshooting logs...";
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
              debugIntentStatus.style.color = `var(--theme-success, ${theme.success})`;
              debugIntentStatus.textContent = `Active (${mins}m remaining).`;
            } else if (checked) {
              debugIntentStatus.style.color = `var(--theme-warning, ${theme.warning})`;
              debugIntentStatus.textContent = "Request sent. Waiting for admin confirmation.";
            } else {
              debugIntentStatus.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
              debugIntentStatus.textContent = "Disabled";
            }
          } else if (res.status === 426) {
            debugIntentStatus.style.color = `var(--theme-error, ${theme.error})`;
            debugIntentStatus.textContent = parseVersionUpgradeMessage(res.responseText);
          } else {
            throw new Error("Synchronization rejected");
          }
        } catch (err) {
          debugIntentStatus.style.color = `var(--theme-error, ${theme.error})`;
          debugIntentStatus.textContent = "Failed to update troubleshooting setting.";
        }
      };
    };
    async function pollTelemetryState() {
      if (!document.getElementById("gw-allowance-bar")) return;
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
          updateDualLedgerHud(data);
        } else if (res.status === 426) {
          setHudAlert(parseVersionUpgradeMessage(res.responseText), "error");
        }
      } catch (e) {
        console.error("GuildWeave (Guest): Failed to poll session state", e);
      }
    }
    initInterceptor({
      browserId,
      deviceSecret,
      VPS_HOST,
      logPrefix: "GuildWeave (Guest)",
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
      },
      onTelemetryRefresh: pollTelemetryState
    });
    async function openSettingsModal() {
      let modal = document.getElementById("vps-settings-modal");
      let backdrop = document.getElementById("vps-settings-backdrop");
      if (modal) {
        modal.remove();
        if (backdrop) backdrop.remove();
        return;
      }
      const theme = ensureGuildWeaveStyles();
      backdrop = document.createElement("div");
      backdrop.id = "vps-settings-backdrop";
      backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); backdrop-filter:blur(3px); z-index:99998;";
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
          width: 92vw;
          max-width: 480px;
          background: var(--theme-bg0, ${theme.bg0});
          border: 1px solid var(--theme-bg2, ${theme.borderStrong});
          border-radius: 12px;
          z-index: 99999;
          color: var(--theme-text, ${theme.text});
          padding: 20px;
          font-family: ${theme.font};
          box-shadow: 0 16px 48px rgba(0,0,0,0.65);
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
    syncUIControlConstraints(getClientPolicyState());
    startStatePolling();
  }
})();
