/**
 * PHASE 8 COMMIT 10 VERIFICATION HARNESS (test/phase8_commit10_userscript_runtime.test.js)
 *
 * Exhaustively tests the compiled UserScript distribution bundles (`UserScripts/nai-admin.user.js`
 * and `UserScripts/nai-guest.user.js`) inside an isolated pure-browser VM sandbox:
 * 1. Full Bundle Contract:
 *    - Compiles bundles via `scripts/build-userscripts.js`.
 *    - Asserts zero `require(`, `process`, or `Buffer` references or leaks in compiled artifacts.
 *    - Verifies Tampermonkey metadata blocks, IIFE boundaries, and zero Node globals inside VM.
 * 2. Pricing & Stage 5 Parity (Module 643656, Module 875333 & `/ai/upscale`):
 *    - Verifies client-side `pricing.js` matches `auditEngine.js` across baseline Opus, multi-sample,
 *      V5 Full `1.5x` (`1536x2048` -> `90` Anlas, `1024x1024 @ 29` -> `32`, `1472x1472 @ 28` -> `63`),
 *      V5 Medium un-ceiled `/ 1.75` + `1.5x` (`1024x1024, 2 samples` -> `15`, `4 samples` -> `45`,
 *      `1472x1472, 1 sample` -> `31`, `1536x2048, 1 sample` -> `44`), `usageNegative` V5 discount
 *      suppression (`30` / `52`), SMEA/SMEA-DYN, Img2Img/Inpaint strength, Character Refs
 *      (`director_reference_images*`), V4.5 Vibe Transfer (`reference_image_multiple`),
 *      `>140` Anlas cap, `strength: 0` 3MP/50-step hard limits, `.5` non-V5 parity (`3-5`, `1-5`),
 *      and `/ai/upscale` pixel buckets (`1..4` Anlas + PNG/JPEG/WebP binary + multi-segment >64KB EXIF JPEG extraction).
 *    - Verifies Stage 5 `X-Gen-Steps` invariant: exact body integer forwarded (`25` stays `25`;
 *      absent steps default to `14` on Medium and `28` otherwise) while pricing V5 Medium via Module 643656.
 *    - Verifies `params.js` matches `auditEngine.extractParametersFromRawBody` 1-to-1, routing
 *      `reference_image_multiple` into `vibe_reference_count` and counting strictly Character References
 *      in `precise_refs` so `X-Precise-Refs` never diverges from Stage 5.
 * 3. Happy Path & Theme Inheritance (Desktop & Mobile Layouts):
 *    - Polls `/auth/status` with full Commit 9 + cycle-segregated payload and verifies `#gw-v5-bar`
 *      mounts above `#gw-allowance-bar` while preserving `allowanceBar.nextElementSibling === genBtn`.
 *    - Verifies `scrapeNovelAITheme()` skips stale navy `document.body` CSS (`rgb(19, 21, 44)`),
 *      ignores hidden `[role="dialog"]`, hidden desktop layouts (`display: none`) on mobile, and
 *      ancestor-hidden subtrees, ignores stale fallback `backgroundColor` buried under `linear-gradient(...)`,
 *      ignores low-alpha translucent overlays (`rgba(255,255,255,0.08)`), rejects blurred drop shadows
 *      while accepting spread-only `0 0 0 <N>px` rings, supports CSS Color 4 space-separated `rgb()`
 *      & semi-opaque mobile canvas/drawer layers, extracts `#__next`/layout backgrounds,
 *      `.image-gen-character-prompts` card background + outline (`--gw-bg1`, `--gw-card-border`),
 *      `[data-prompt-input="true"]` / `.prompt-input-box-prompt` background (`--gw-input-bg`, ignoring
 *      `.sc-b7a086c6-0` inner button row regardless of child order), card container `borderTopColor`,
 *      and active effort fills, keeps dark-button bright-text themes legible, refreshes `#gw-nav-badge`
 *      classes & computed colors when `button[aria-label="menu"]` transitions post-hydration, reacts to
 *      `document.head` `<style>` swaps while ignoring `#gw-ui-styles`, and hides `#gw-allowance-bar`
 *      for unlimited tiers.
 *    - Verifies mobile layout (`window.innerWidth = 375`) skips hidden desktop `.image-gen-nav-row` /
 *      `.image-gen-footer`, mounts onto visible mobile buttons, avoids `#13152c` navy bleed on both
 *      `#gw-v5-bar` and `#vps-settings-modal`, applies `.gw-v5-compact` single-line compact rows
 *      without truncating V5 generation counts, and adapts dynamically on `resize` back to desktop.
 *    - Verifies linked browser ID chips (`#guest-linked-devices`, Admin Governance, and Operator Settings)
 *      copy the full `browser_id` to clipboard on click, `Space`, and `Enter` key, cancel stale timers
 *      across rapid double clicks, display `'Copied!'` / `'Copy failed'` accurately, and fall back to
 *      `document.execCommand('copy')` with `focus()` and `setSelectionRange()` when `navigator.clipboard` rejects.
 *    - Verifies `/user/data` injects live `availableAnlas` into `trainingStepsLeft` after `/auth/status` arrives.
 *    - Verifies `#gw-effort-select` is absent (relies strictly on NovelAI's native `.image-gen-model-mode-row`).
 *    - Verifies `#gw-v5-cost` hides when configured for non-addon Anlas bypass (`1536x2048`, `2` samples,
 *      or `29` steps) while ignoring arbitrary `"1536x2048"` prompt text and keeping V5 credits on addon-only `1024x1024`.
 *    - Verifies `/user/subscription` without explicit `config.method` defaults to `GET`, leaves
 *      `count_text_gens` untouched, and suppresses unprompted `/auth/status` polling.
 *    - Verifies `/ai/encode-vibe` uses `POST`, leaves `count_text_gens` at 0, and triggers HUD telemetry refresh.
 *    - Verifies `/ai/upscale` FormData binary PNG extraction (`1024x1024 -> 1` Anlas), Channel A queue
 *      join (`is_upscale: true`), and proxy header transmission (`x-gen-width`, `x-gen-height`, `x-declared-anlas`).
 *    - Verifies nested sample-count spans (`<span>Generate <span>1</span> Image</span>`) never hijack
 *      `X-Scraped-Anlas` or trigger false canary drift warnings when cost is `90` (`90 Anlas`).
 *    - Verifies V4.5 pre-encoded Vibe Transfer (`reference_image_multiple` 2 vibes) declares 0 Anlas and 0 refs.
 *    - Verifies `master_v5_is_negative: true` propagates into `X-Declared-Anlas: 30` on `1024x1024, 2 samples` Medium.
 *    - Verifies live countdown ETA (`+1% in Xm`), readable cluster state labels, V5 High/Med counts,
 *      bonus pool availability, Anlas display, native V5 credit badge, and Guest Settings modal fields (no backticks).
 *    - Verifies high-res (`1536x2048`) generation with Anlas Bypass armed sends full Commit 6
 *      `POST /queue/join` metadata and sends `X-Base-Paid: true`, `X-Declared-Anlas: 90`,
 *      `X-Scraped-Anlas`, `X-Gen-Model: V5` without mutating the payload body.
 *    - Verifies Canary Drift detection warns (`"Displayed cost may differ from estimate."`) without blocking.
 * 4. Hell Path: Client Deadband Guard, Live Input Events, Native `.image-gen-model-mode-row` Sync, Legacy-5 Immunity & FormData Pass-Through:
 *    - V5 High (`nai-diffusion-5-full`) with steps `24`, `25`, `28` at `1024x1024, 1 sample`
 *      is blocked client-side (`400`) with zero network calls.
 *    - Editing the step `<input>` value via `input` / `change` events triggers deadband validation
 *      immediately without requiring `MutationObserver` attribute mutations.
 *    - Arming `Anlas Bypass` on `1024x1024, 1 sample, 25 steps` retains the deadband alert across
 *      subsequent `MutationObserver` ticks until steps move out of `24..28` or Effort switches to `Medium`.
 *    - Standard `react-select` nested input wrapper (`<div><div>NAI Diffusion V5New</div><div><input aria-label="Select the Model"></div></div>`)
 *      without `-singleValue` class resolves `V5 Full` cleanly.
 *    - Verifies `strength: 0` on `100000x100000` or `steps: 100000` is blocked client-side (`400`) with zero network calls.
 *    - Switching native `.image-gen-model-mode-row` Effort between `Medium` and `High` (and Model
 *      to `V4.5 Full`, `NAI Diffusion 3.5`, `SD 1.5`, or `Model V50`) dynamically updates `#gw-v5-cost`
 *      (`Uses 10 V5 pts (Med)`, `Uses 18 V5 pts (High)`, `Legacy (0 V5 pts)`), updates step slider max bounds
 *      (`23` vs `28`), clears deadband alerts, and never misclassifies `3.5` / `1.5` / `V50` as V5.
 *    - `FormData` with a `Blob` `request` part passes through untouched with matching `X-Gen-Model: V5-medium`.
 *    - High-res / >28 steps with bypass DISARMED is blocked client-side (`400`) with zero network calls.
 *    - Free-tier parameters (`1024x1024, 1 sample, 23 steps`) even with bypass toggle armed still
 *      transmit `X-Base-Paid: false` (no forged exemption on free geometry).
 * 5. Hell Path: Debt State UI Lockout & Ephemeral Telemetry Isolation:
 *    - Feeds `/auth/status` with negative Anlas balance (`virtual_balance: -40`, `is_in_debt: true`).
 *    - Asserts bypass toggle is forced unchecked & disabled in both HUD and settings modal,
 *      HUD displays `Anlas Overdrawn: -40 (Paid Paused)`, and `/user/data` clamps `fixedTrainingStepsLeft` to `0`.
 *    - Asserts stale `gw_policy_state` in `GM_setValue` cannot poison a fresh page boot into locking out
 *      generations before `/auth/status` polls.
 *    - Asserts toggling `#settings-anlas-bypass` preserves `v5` and `telemetry` HUD fields,
 *      and clearing debt restores normal modal bypass hint text.
 *    - Asserts Anlas-consuming bypass request and `/ai/upscale` are blocked (`403 DEBT_LOCKED`) with
 *      zero network calls while free Opus/V5 generation (`1024x1024, 23 steps, 1 sample`) succeeds.
 * 6. Hell Path: V5 Capacity Depletion, 5.5% Circuit Breaker, Token-Expired Immediate Recovery, Native Effort Shield Sync & Server Error HUD Propagation:
 *    - Feeds `/auth/status` with `is_hard_locked: true` or depleted allowance; asserts HUD locks V5
 *      (`V5 Recharging` / `V5 Allowance Reached`) immediately across both Guest and Admin.
 *    - Feeds `/auth/status` with `master_token_expired: true` AND `is_hard_locked: true`; asserts HUD
 *      displays `Master Token Expired (Awaiting Admin)` without locking Generate button AND does NOT
 *      falsely reject V5 clicks locally as `V5_BATTERY_CRITICAL`, allowing immediate post-token-push
 *      recovery or propagating `503 MASTER_TOKEN_EXPIRED` from server.
 *    - Toggling `#gw-bypass-toggle` or switching native Effort from `High` (`18 pts`) to `Medium`
 *      (`10 pts`) with `12 pts` banked clears `#gw-button-shield` immediately without requiring a fetch.
 *    - Allows legacy V4.5 and `/ai/upscale` while blocking free V5 during V5 recharging.
 *    - Simulates `/queue/join` returning `403 ALLOWANCE_EXHAUSTED` and `429 V5_CAPACITY_DEPLETED`, plus
 *      `/proxy/image/*` returning `503 MASTER_SUBSCRIPTION_INACTIVE` and `503 MASTER_TOKEN_EXPIRED`;
 *      asserts exact status, `#gw-hud-alert` update, `approved` preservation, and telemetry refresh.
 * 7. Happy Path & Hell Path: Admin Governance Cycle Selector, Stored XSS Escaping, `PENDING`/`(Pending)` Approval Badges, Dual-Ledger Controls, Unlinked `user_id` Actions, Post-Push Refresh, Operator Cycle Telemetry & Strict Prompt Validation:
 *    - Verifies Admin panel renders `/admin/cycles` dropdown, filters `/admin/devices?cycle_epoch=...` and
 *      `/admin/global-stats?cycle_epoch=...`, escapes stored XSS payloads (`<img>`, `<svg>`) across usernames
 *      and device labels, renders `PENDING` / `(Pending)` badges exclusively on unapproved non-banned accounts/devices,
 *      renders `[TOKEN EXPIRED]` / `[INACTIVE]` subscription alerts, handles `sortReqs`,
 *      triggers immediate HUD + governance refresh on `Save Token`, omits Rolling Allowance & backticks in
 *      Operator Settings while displaying `This Billing Cycle` (`#operator-period-usage`), sends `{ user_id: ... }`
 *      for unlinked principals across approve/revoke/ban, verifies `<select>` setter syncs `<option>` selections,
 *      rejects malformed deltas (`"12.5"`, `"50abc"`) without dispatching requests, and dispatches
 *      `POST /admin/adjust-balance` and `POST /admin/reconcile-debt`.
 * 8. Hell Path: Client `HTTP 426 SCRIPT_UPDATE_REQUIRED` Propagation & UI Alerting:
 *    - Verifies Guest `POST /queue/join`, `POST /proxy/image/ai/generate-image-stream`, and `GET /auth/status`
 *      returning `426` propagate exact `426` status (never `502`), display `#gw-hud-alert`, and leave `approved: true`.
 *    - Verifies Admin `GET /auth/status` poll and Governance `GET /admin/devices` returning `426` display
 *      `#gw-hud-alert` and `#vps-client-list` update prompt instead of hanging.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { build, targets } = require('../scripts/build-userscripts');
const auditEngine = require('../auditEngine');

function extractMetadataVersion(source) {
  if (!source || typeof source !== 'string') return '0.0.0';
  const headerMatch = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!headerMatch) return '0.0.0';
  const versionMatch = headerMatch[1].match(/\/\/\s*@version\s+([^\r\n]+)/);
  return versionMatch ? versionMatch[1].trim() : '0.0.0';
}

function createPngHeaderBlob(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return new Blob([bytes], { type: 'image/png' });
}

function createLargeExifJpegUint8Array(width, height, exifPaddingBytes = 90000) {
  const app1Segments = [];
  let remaining = exifPaddingBytes;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 45000);
    app1Segments.push(chunk);
    remaining -= chunk;
  }
  const app1TotalBytes = app1Segments.reduce((sum, len) => sum + 4 + len, 0);
  const bytes = new Uint8Array(2 + app1TotalBytes + 13);
  const view = new DataView(bytes.buffer);
  let pos = 0;
  bytes[pos++] = 0xFF; bytes[pos++] = 0xD8; // SOI
  for (const chunkLen of app1Segments) {
    bytes[pos++] = 0xFF; bytes[pos++] = 0xE1; // APP1
    view.setUint16(pos, chunkLen + 2, false);
    pos += 2 + chunkLen;
  }
  bytes[pos++] = 0xFF; bytes[pos++] = 0xC0; // SOF0
  view.setUint16(pos, 11, false);
  bytes[pos + 2] = 8;
  view.setUint16(pos + 3, height, false);
  view.setUint16(pos + 5, width, false);
  bytes[pos + 7] = 1;
  return bytes;
}

function escapeMockAttr(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeBasicEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function createBrowserSandbox(initialStorage = {}, scriptSource = null) {
  const storage = new Map(Object.entries(initialStorage));
  const networkCalls = [];
  const intervals = [];
  const elements = new Map();
  const observerCallbacks = [];
  const windowListeners = new Map();
  const promptQueue = [];
  const confirmQueue = [];
  const alertLog = [];
  const copiedTexts = [];
  const execCommands = [];
  let clipboardError = null;
  let execCommandReturn = true;
  let clipboardReadVal = '';
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);

  const resolvedVersion = extractMetadataVersion(scriptSource);

  function splitSelectorParts(sel) {
    const parts = [];
    let current = '';
    let bracketDepth = 0;
    let quote = null;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '[') {
        bracketDepth++;
        current += ch;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += ch;
      } else if (/\s/.test(ch) && bracketDepth === 0) {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  function matchesSelector(el, sel) {
    if (!sel || typeof sel !== 'string') return false;
    const trimmed = sel.trim();
    if (!trimmed) return false;

    const attrRegex = /\[([a-zA-Z0-9\-_:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
    let attrMatch;
    let hasAttrCheck = false;
    while ((attrMatch = attrRegex.exec(trimmed)) !== null) {
      hasAttrCheck = true;
      const attrName = attrMatch[1];
      const expectedVal = attrMatch[2] !== undefined ? attrMatch[2]
        : (attrMatch[3] !== undefined ? attrMatch[3]
          : (attrMatch[4] !== undefined ? attrMatch[4] : null));
      const actualVal = el.getAttribute(attrName);
      if (expectedVal === null) {
        if (actualVal === null || actualVal === undefined) return false;
      } else {
        if (actualVal !== expectedVal) return false;
      }
    }

    const baseSelector = trimmed.replace(attrRegex, '').trim();
    if (!baseSelector) {
      return hasAttrCheck;
    }

    if (baseSelector.startsWith('#')) {
      return el.id === baseSelector.slice(1);
    }
    if (baseSelector.startsWith('.')) {
      const cls = baseSelector.slice(1);
      if (!cls.includes('.')) {
        const classes = (el.getAttribute('class') || '').split(/\s+/);
        return classes.includes(cls);
      }
    }
    if (baseSelector.includes('.')) {
      const dotParts = baseSelector.split('.').filter(Boolean);
      const hasTagPrefix = !baseSelector.startsWith('.');
      const tag = hasTagPrefix ? dotParts[0] : '';
      const requiredClasses = hasTagPrefix ? dotParts.slice(1) : dotParts;
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      return requiredClasses.every(c => classes.includes(c));
    }
    return el.tagName.toLowerCase() === baseSelector.toLowerCase();
  }

  function findSelector(root, sel, singleOnly, results = []) {
    const commaParts = sel.split(',').map(s => s.trim()).filter(Boolean);
    if (commaParts.length > 1) {
      for (const sub of commaParts) {
        const hit = findSelector(root, sub, singleOnly, results);
        if (singleOnly && hit) return hit;
      }
      return singleOnly ? null : results;
    }

    const parts = splitSelectorParts(sel);
    if (parts.length > 1) {
      let currentSet = [root];
      for (const part of parts) {
        const nextSet = [];
        for (const node of currentSet) {
          findSelector(node, part, false, nextSet);
        }
        currentSet = nextSet;
      }
      if (!singleOnly) {
        for (const item of currentSet) {
          if (!results.includes(item)) results.push(item);
        }
        return results;
      }
      return currentSet[0] || null;
    }

    for (const child of root.children) {
      if (matchesSelector(child, sel)) {
        if (singleOnly) return child;
        if (!results.includes(child)) results.push(child);
      }
      const found = findSelector(child, sel, singleOnly, results);
      if (singleOnly && found) return found;
    }
    return singleOnly ? null : results;
  }

  function notifyMutation(target, type, added = [], removed = []) {
    for (const cb of observerCallbacks) {
      cb([{ target, type, addedNodes: added, removedNodes: removed }]);
    }
  }

  function parseHTMLIntoChildren(parent, html) {
    if (!html || typeof html !== 'string') return;
    const tokens = html.match(/<[^>]+>|[^<]+/g) || [];
    const stack = [parent];

    for (const token of tokens) {
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
      } else if (token.startsWith('<') && !token.startsWith('<!--')) {
        const match = token.match(/<([a-zA-Z0-9\-]+)([^>]*)>/);
        if (!match) continue;
        const tagName = match[1];
        const attrString = match[2] || '';
        const isSelfClosing = token.endsWith('/>') || voidTags.has(tagName.toLowerCase());

        const childEl = createMockElement(tagName);
        const attrRegex = /([a-zA-Z0-9\-_:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrString)) !== null) {
          const attrName = attrMatch[1];
          const attrVal = attrMatch[2] !== undefined ? attrMatch[2]
            : (attrMatch[3] !== undefined ? attrMatch[3]
              : (attrMatch[4] !== undefined ? attrMatch[4] : ''));
          childEl.setAttribute(attrName, attrVal);
          if (attrName.toLowerCase() === 'style') childEl.style.cssText = attrVal;
          if (attrName === 'value') childEl.value = attrVal;
          if (attrName === 'checked') childEl.checked = true;
          if (attrName === 'selected') childEl.selected = true;
          if (attrName === 'disabled') childEl.disabled = true;
        }

        const currentParent = stack[stack.length - 1];
        currentParent.appendChild(childEl);

        if (!isSelfClosing) stack.push(childEl);
      } else {
        const currentParent = stack[stack.length - 1];
        currentParent._nodes.push({
          isText: true,
          html: token,
          text: decodeBasicEntities(token)
        });
      }
    }
  }

  function serializeElementOuterHTML(el) {
    const tag = el.tagName.toLowerCase();
    const attrMap = new Map(el.attributes.entries());
    if (el.id && !attrMap.has('id')) {
      attrMap.set('id', el.id);
    }
    if (el.style && el.style.cssText && !attrMap.has('style')) {
      attrMap.set('style', el.style.cssText);
    }
    let attrOut = '';
    for (const [k, v] of attrMap.entries()) {
      attrOut += v === '' ? ` ${k}` : ` ${k}="${escapeMockAttr(v)}"`;
    }
    if (voidTags.has(tag)) {
      return `<${tag}${attrOut}>`;
    }
    return `<${tag}${attrOut}>${el.innerHTML}</${tag}>`;
  }

  function createMockElement(tagName = 'div') {
    let _id = '';
    let _children = [];
    let _nodes = [];
    let _value = '';
    let _focusCalled = false;
    let _selectionRange = null;
    const attributes = new Map();
    const listeners = new Map();

    const styleTarget = { cssText: '' };
    const style = new Proxy(styleTarget, {
      get(target, prop) { return target[prop] || ''; },
      set(target, prop, val) {
        target[prop] = String(val);
        if (prop === 'cssText') {
          for (const d of String(val).split(';')) {
            const colon = d.indexOf(':');
            if (colon !== -1) {
              const k = d.slice(0, colon).trim();
              const v = d.slice(colon + 1).trim();
              const camelK = k.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
              target[camelK] = v;
              target[k] = v;
            }
          }
        } else {
          const kebab = String(prop).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
          target[kebab] = String(val);
        }
        return true;
      }
    });

    const el = {
      tagName: tagName.toUpperCase(),
      style,
      attributes,
      disabled: false,
      selected: false,
      checked: false,
      onclick: null,
      onchange: null,
      onkeydown: null,
      parentElement: null,
      _nodes,

      get id() { return _id; },
      set id(val) {
        const oldId = _id;
        _id = String(val || '');
        if (oldId && elements.get(oldId) === el) elements.delete(oldId);
        if (_id) elements.set(_id, el);
      },

      get className() { return attributes.get('class') || ''; },
      set className(val) { attributes.set('class', String(val || '')); },

      get value() {
        if (el.tagName === 'SELECT') {
          const selectedOption = _children.find(c => c.tagName === 'OPTION' && (c.selected || c.getAttribute('selected') !== null));
          if (selectedOption) return selectedOption.value;
          const firstOption = _children.find(c => c.tagName === 'OPTION');
          if (firstOption) return firstOption.value;
        }
        return _value;
      },
      set value(val) {
        const nextVal = String(val !== undefined && val !== null ? val : '');
        _value = nextVal;
        if (el.tagName === 'SELECT') {
          for (const opt of _children) {
            if (opt.tagName === 'OPTION') {
              const isMatch = opt.value === nextVal;
              opt.selected = isMatch;
              if (isMatch) opt.attributes.set('selected', '');
              else opt.attributes.delete('selected');
            }
          }
        }
      },

      get textContent() {
        let out = '';
        for (const node of el._nodes) {
          out += node.isText ? node.text : node.textContent;
        }
        return out;
      },
      set textContent(val) {
        for (const c of [..._children]) c.remove();
        _children = [];
        el._nodes = [];
        const strVal = val !== undefined && val !== null ? String(val) : '';
        if (strVal.length > 0) {
          el._nodes.push({
            isText: true,
            html: escapeMockAttr(strVal),
            text: strVal
          });
        }
      },

      get children() { return _children; },
      get firstElementChild() { return _children[0] || null; },
      get previousElementSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx > 0 ? el.parentElement.children[idx - 1] : null;
      },
      get nextElementSibling() {
        if (!el.parentElement) return null;
        const idx = el.parentElement.children.indexOf(el);
        return idx !== -1 && idx < el.parentElement.children.length - 1 ? el.parentElement.children[idx + 1] : null;
      },

      contains(other) {
        if (!other) return false;
        let cur = other;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },

      closest(sel) {
        let cur = el;
        while (cur) {
          if (sel === '[id^="gw-"]' && cur.id && cur.id.startsWith('gw-')) return cur;
          if (sel === '[id^="vps-"]' && cur.id && cur.id.startsWith('vps-')) return cur;
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },

      focus() {
        _focusCalled = true;
      },

      select() {
        clipboardReadVal = el.value || '';
      },

      setSelectionRange(start, end) {
        _selectionRange = [start, end];
      },

      get _clipboardMeta() {
        return { focusCalled: _focusCalled, selectionRange: _selectionRange };
      },

      appendChild(child) {
        _children.push(child);
        el._nodes.push(child);
        child.parentElement = el;
        notifyMutation(el, 'childList', [child], []);
        return child;
      },

      insertBefore(newChild, refChild) {
        const idx = _children.indexOf(refChild);
        if (idx === -1) _children.push(newChild);
        else _children.splice(idx, 0, newChild);

        const nodeIdx = el._nodes.indexOf(refChild);
        if (nodeIdx === -1) el._nodes.push(newChild);
        else el._nodes.splice(nodeIdx, 0, newChild);

        newChild.parentElement = el;
        notifyMutation(el, 'childList', [newChild], []);
        return newChild;
      },

      remove() {
        if (_id && elements.get(_id) === el) elements.delete(_id);
        if (el.parentElement) {
          const idx = el.parentElement.children.indexOf(el);
          if (idx !== -1) el.parentElement.children.splice(idx, 1);
          const nodeIdx = el.parentElement._nodes.indexOf(el);
          if (nodeIdx !== -1) el.parentElement._nodes.splice(nodeIdx, 1);
          notifyMutation(el.parentElement, 'childList', [], [el]);
          el.parentElement = null;
        }
      },

      setAttribute(k, v) {
        const strVal = String(v);
        attributes.set(k, strVal);
        if (k.toLowerCase() === 'id') el.id = strVal;
        if (k.toLowerCase() === 'class') attributes.set('class', strVal);
        if (k.toLowerCase() === 'selected') el.selected = true;
      },

      getAttribute(k) {
        if (k.toLowerCase() === 'id') return _id || null;
        return attributes.has(k) ? attributes.get(k) : null;
      },

      get innerHTML() {
        let out = '';
        for (const node of el._nodes) {
          out += node.isText ? node.html : serializeElementOuterHTML(node);
        }
        return out;
      },
      set innerHTML(html) {
        for (const c of [..._children]) c.remove();
        _children = [];
        el._nodes = [];
        const rawHtml = String(html || '');
        parseHTMLIntoChildren(el, rawHtml);
        notifyMutation(el, 'childList', _children, []);
      },

      querySelector(sel) { return findSelector(el, sel, true); },
      querySelectorAll(sel) {
        const results = [];
        findSelector(el, sel, false, results);
        return results;
      },
      addEventListener(type, fn) {
        el[`on${type}`] = fn;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
        if (el[`on${type}`] === fn) el[`on${type}`] = null;
      },
      dispatchEvent(eventObj) {
        const ev = eventObj && typeof eventObj === 'object' ? { ...eventObj } : { type: String(eventObj) };
        if (!ev.target) ev.target = el;
        let cur = el;
        while (cur) {
          const set = cur._getListeners ? cur._getListeners(ev.type) : null;
          if (set) {
            for (const fn of set) fn(ev);
          }
          cur = cur.parentElement;
        }
      },
      _getListeners(type) {
        return listeners.get(type) || null;
      }
    };

    return el;
  }

  let lastCreatedTextarea = null;
  const documentMock = {
    body: createMockElement('body'),
    head: createMockElement('head'),
    documentElement: createMockElement('html'),
    createElement: (tag) => {
      const node = createMockElement(tag);
      if (String(tag).toLowerCase() === 'textarea') lastCreatedTextarea = node;
      return node;
    },
    createElementNS: (_, tag) => createMockElement(tag),
    getElementById: (id) => elements.get(id) || null,
    querySelector(sel) {
      if (documentMock.body && matchesSelector(documentMock.body, sel)) return documentMock.body;
      return findSelector(documentMock.documentElement, sel, true);
    },
    querySelectorAll(sel) {
      const results = [];
      findSelector(documentMock.documentElement, sel, false, results);
      return results;
    },
    execCommand(cmd) {
      execCommands.push({
        cmd,
        value: clipboardReadVal,
        focusCalled: lastCreatedTextarea ? lastCreatedTextarea._clipboardMeta.focusCalled : false,
        selectionRange: lastCreatedTextarea ? lastCreatedTextarea._clipboardMeta.selectionRange : null
      });
      if (cmd === 'copy' && execCommandReturn && clipboardReadVal) {
        copiedTexts.push(clipboardReadVal);
        return true;
      }
      return false;
    }
  };
  documentMock.documentElement.appendChild(documentMock.head);
  documentMock.documentElement.appendChild(documentMock.body);

  let originalPageFetch = async () => new Response('{}', { status: 200 });
  const unsafeWindowMock = {
    get fetch() { return originalPageFetch; },
    set fetch(fn) { originalPageFetch = fn; }
  };

  const windowMock = {
    innerWidth: 1280,
    document: documentMock,
    unsafeWindow: unsafeWindowMock,
    sessionStorage: {
      data: new Map(),
      getItem(k) { return this.data.get(k) || null; },
      setItem(k, v) { this.data.set(k, String(v)); }
    },
    location: { reloaded: false, reload() { this.reloaded = true; } },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      if (windowListeners.has(type)) windowListeners.get(type).delete(fn);
    },
    getComputedStyle: (el) => ({
      backgroundColor: (el && el.style && el.style.backgroundColor) ? el.style.backgroundColor : 'rgba(0, 0, 0, 0)',
      backgroundImage: (el && el.style && el.style.backgroundImage) ? el.style.backgroundImage : 'none',
      color: (el && el.style && el.style.color) ? el.style.color : '',
      fontFamily: (el && el.style && el.style.fontFamily) ? el.style.fontFamily : '',
      borderTopColor: (el && el.style && (el.style.borderTopColor || el.style.borderColor)) ? (el.style.borderTopColor || el.style.borderColor) : '',
      borderRightColor: (el && el.style && (el.style.borderRightColor || el.style.borderColor)) ? (el.style.borderRightColor || el.style.borderColor) : '',
      borderBottomColor: (el && el.style && (el.style.borderBottomColor || el.style.borderColor)) ? (el.style.borderBottomColor || el.style.borderColor) : '',
      borderLeftColor: (el && el.style && (el.style.borderLeftColor || el.style.borderColor)) ? (el.style.borderLeftColor || el.style.borderColor) : '',
      borderColor: (el && el.style && (el.style.borderColor || el.style.borderTopColor)) ? (el.style.borderColor || el.style.borderTopColor) : '',
      borderTopWidth: (el && el.style && el.style.borderTopWidth) ? el.style.borderTopWidth : '',
      borderRightWidth: (el && el.style && el.style.borderRightWidth) ? el.style.borderRightWidth : '',
      borderBottomWidth: (el && el.style && el.style.borderBottomWidth) ? el.style.borderBottomWidth : '',
      borderLeftWidth: (el && el.style && el.style.borderLeftWidth) ? el.style.borderLeftWidth : '',
      borderTopStyle: (el && el.style && el.style.borderTopStyle) ? el.style.borderTopStyle : '',
      borderRightStyle: (el && el.style && el.style.borderRightStyle) ? el.style.borderRightStyle : '',
      borderBottomStyle: (el && el.style && el.style.borderBottomStyle) ? el.style.borderBottomStyle : '',
      borderLeftStyle: (el && el.style && el.style.borderLeftStyle) ? el.style.borderLeftStyle : '',
      outlineWidth: (el && el.style && el.style.outlineWidth) ? el.style.outlineWidth : '',
      outlineStyle: (el && el.style && el.style.outlineStyle) ? el.style.outlineStyle : '',
      outlineColor: (el && el.style && el.style.outlineColor) ? el.style.outlineColor : '',
      boxShadow: (el && el.style && el.style.boxShadow) ? el.style.boxShadow : 'none',
      display: (el && el.style && el.style.display) ? el.style.display : '',
      visibility: (el && el.style && el.style.visibility) ? el.style.visibility : '',
      opacity: (el && el.style && el.style.opacity) ? el.style.opacity : ''
    })
  };

  const cryptoMock = {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomValues: (arr) => nodeCrypto.getRandomValues(arr)
  };
  windowMock.crypto = cryptoMock;

  const navigatorMock = {
    clipboard: {
      writeText: async (text) => {
        if (clipboardError) throw clipboardError;
        copiedTexts.push(String(text));
      }
    }
  };

  class MockMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() { observerCallbacks.push(this.cb); }
    disconnect() {
      const idx = observerCallbacks.indexOf(this.cb);
      if (idx !== -1) observerCallbacks.splice(idx, 1);
    }
  }

  const sandbox = {
    window: windowMock,
    unsafeWindow: unsafeWindowMock,
    document: documentMock,
    navigator: navigatorMock,
    sessionStorage: windowMock.sessionStorage,
    location: windowMock.location,
    requestAnimationFrame: windowMock.requestAnimationFrame,
    Headers,
    Response,
    Request,
    FormData,
    Blob,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    crypto: cryptoMock,
    MutationObserver: MockMutationObserver,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    alert: (msg) => { alertLog.push(msg); },
    prompt: () => (promptQueue.length > 0 ? promptQueue.shift() : '0'),
    confirm: () => (confirmQueue.length > 0 ? confirmQueue.shift() : true),
    GM_getValue: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
    GM_setValue: (key, val) => { storage.set(key, val); },
    GM_info: { script: { version: resolvedVersion } },
    GM_xmlhttpRequest: (details) => { networkCalls.push(details); },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Buffer: undefined,
    process: undefined,
    require: undefined,
    global: undefined
  };

  sandbox.globalThis = sandbox;
  windowMock.globalThis = sandbox;

  return {
    context: vm.createContext(sandbox),
    storage,
    networkCalls,
    intervals,
    promptQueue,
    confirmQueue,
    alertLog,
    copiedTexts,
    execCommands,
    setClipboardError: (err) => { clipboardError = err; },
    setExecCommandReturn: (val) => { execCommandReturn = Boolean(val); },
    setPageFetch: (fn) => { originalPageFetch = fn; },
    triggerResize: (newWidth) => {
      windowMock.innerWidth = newWidth;
      const set = windowListeners.get('resize');
      if (set) {
        for (const fn of set) fn();
      }
    },
    triggerIntervalAtMs: (ms) => {
      for (const entry of intervals) {
        if (entry.ms === ms) entry.fn();
      }
    },
    triggerObserverSync: () => {
      for (const cb of observerCallbacks) {
        cb([{ target: documentMock.body, type: 'childList', addedNodes: [documentMock.body], removedNodes: [] }]);
      }
    },
    triggerHeadStyleMutation: (styleEl) => {
      for (const cb of observerCallbacks) {
        cb([{ target: styleEl || documentMock.head, type: 'childList', addedNodes: [], removedNodes: [] }]);
      }
    }
  };
}

test('Phase 8 Commit 10: Client UserScript Runtime, Dynamic Design Engine & Production Bundling', async (t) => {
  await build();

  const adminCode = fs.readFileSync(targets.find(x => x.name === 'nai-admin').outfile, 'utf8');
  const guestCode = fs.readFileSync(targets.find(x => x.name === 'nai-guest').outfile, 'utf8');
  const pricingMod = await import('../src/userscripts/shared/pricing.js');

  // ---------------------------------------------------------------------------
  // 1. FULL BUNDLE CONTRACT (ZERO NODE LEAKS)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Full Bundle Contract asserts zero require(), process, or Buffer references in compiled files', () => {
    for (const target of targets) {
      const code = fs.readFileSync(target.outfile, 'utf8');
      assert.ok(code.startsWith('// ==UserScript=='), `${target.name} must begin with UserScript metadata`);
      assert.ok(code.includes('// ==/UserScript=='), `${target.name} must terminate metadata`);

      const body = code.slice(code.indexOf('// ==/UserScript=='));
      assert.doesNotMatch(body, /\brequire\s*\(/, `${target.name} must contain zero require() calls`);
      assert.doesNotMatch(body, /\bprocess\b/, `${target.name} must contain zero process references`);
      assert.doesNotMatch(body, /\bBuffer\b/, `${target.name} must contain zero Buffer references`);

      const { context } = createBrowserSandbox({}, code);
      vm.runInContext(
        `if (typeof Buffer !== 'undefined' || typeof process !== 'undefined' || typeof require !== 'undefined') {
           throw new Error('Node leak detected in sandbox');
         }`,
        context
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 2. PRICING ENGINE & PARAMS PARITY WITH SERVER `auditEngine.js`
  // ---------------------------------------------------------------------------
  await t.test('Pricing Parity: Client pricing.js and params.js match auditEngine.js (Module 643656, Vibe Segregation & Upscale)', async () => {
    const vectors = [
      { width: 1024, height: 1024, steps: 28, n_samples: 1, model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 2, model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 1, reference_image_multiple: ['v1', 'v2'], model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 1, reference_image_multiple: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'], model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 1, director_reference_images: ['char1'], model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 2, model: 'nai-diffusion-3-5' },
      { width: 1024, height: 1024, steps: 28, n_samples: 2, model: 'sd-1-5' },
      { width: 832, height: 1216, steps: 29, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 29, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 35, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 50, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 23, n_samples: 4, model: 'nai-diffusion-5-full' },
      { width: 1472, height: 1472, steps: 28, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1536, height: 2048, steps: 28, n_samples: 1, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 14, n_samples: 2, model: 'nai-diffusion-5-full-medium' },
      { width: 1024, height: 1024, steps: 14, n_samples: 4, model: 'nai-diffusion-5-full-medium' },
      { width: 1472, height: 1472, steps: 14, n_samples: 1, model: 'nai-diffusion-5-full-medium' },
      { width: 1472, height: 1472, steps: 14, n_samples: 4, model: 'nai-diffusion-5-full-medium' },
      { width: 1536, height: 2048, steps: 14, n_samples: 1, model: 'nai-diffusion-5-full-medium' },
      { width: 1536, height: 2048, steps: 50, n_samples: 1, model: 'nai-diffusion-5-full-medium' },
      { width: 1024, height: 1024, steps: 23, n_samples: 1, precise_refs: 3, model: 'nai-diffusion-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 2, sm: true, sm_dyn: true, model: 'nai-diffusion-4-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 2, strength: 0.5, has_image: true, model: 'nai-diffusion-4-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 1, uncached_vibe_count: 2, vibe_reference_count: 6, model: 'nai-diffusion-4-5-full' },
      { width: 1024, height: 1024, steps: 28, n_samples: 1, uncached_vibe_count: 2, vibe_reference_count: 6, model: 'nai-diffusion-5-full' }
    ];

    for (const vec of vectors) {
      const clientCost = pricingMod.calculateAnlasCost(vec, { isOpus: true });
      const serverCost = auditEngine.calculateAnlasCost(vec, { isOpus: true });
      assert.strictEqual(clientCost, serverCost, `Client/server price mismatch for ${JSON.stringify(vec)}`);
    }

    // Upscale pixel-bucket parity
    for (const [w, h] of [[512, 512], [1024, 1024], [1280, 1280], [1536, 1536], [1536, 2048]]) {
      assert.strictEqual(
        pricingMod.calculateUpscaleAnlasCost(w, h),
        auditEngine.calculateUpscaleAnlasCost(w, h),
        `Upscale bucket mismatch for ${w}x${h}`
      );
    }
    assert.throws(() => pricingMod.calculateUpscaleAnlasCost(2048, 2048), /3145728px/);
    assert.throws(() => auditEngine.calculateUpscaleAnlasCost(2048, 2048), /3145728px/);

    // Large EXIF (>64KB chained APP1) JPEG extraction in both FormData Blob and whitespace-padded Base64 JSON
    const largeExifJpeg = createLargeExifJpegUint8Array(1280, 1280, 90000);
    const largeJpegFd = new FormData();
    largeJpegFd.append('image', new Blob([largeExifJpeg], { type: 'image/jpeg' }), 'photo.jpg');
    const fdJpegDims = await pricingMod.extractUpscaleBodyParams(largeJpegFd);
    assert.deepStrictEqual(fdJpegDims, { width: 1280, height: 1280, format: 'jpeg' });

    const b64WithNewlines = Buffer.from(largeExifJpeg).toString('base64').replace(/(.{76})/g, '$1\n');
    const jsonJpegDims = await pricingMod.extractUpscaleBodyParams(JSON.stringify({
      image: `data:image/jpeg;base64,${b64WithNewlines}`
    }));
    assert.deepStrictEqual(jsonJpegDims, { width: 1280, height: 1280, format: 'jpeg' });

    assert.strictEqual(auditEngine.isV5ModelFamily('nai-diffusion-3-5'), false);
    assert.strictEqual(auditEngine.isV5ModelFamily('sd-1-5'), false);
    assert.strictEqual(pricingMod.isV5ModelFamily('nai-diffusion-3-5'), false);
    assert.strictEqual(pricingMod.isV5ModelFamily('sd-1-5'), false);

    assert.strictEqual(pricingMod.calculateAnlasCost({ width: 1024, height: 1024, n_samples: 2, model: 'nai-diffusion-5-full-medium' }), 15);
    assert.strictEqual(pricingMod.calculateAnlasCost({ width: 1472, height: 1472, n_samples: 1, model: 'nai-diffusion-5-full-medium' }), 31);
    assert.strictEqual(pricingMod.calculateAnlasCost({ width: 1536, height: 2048, n_samples: 1, model: 'nai-diffusion-5-full-medium' }), 44);
    assert.strictEqual(pricingMod.calculateAnlasCost({ width: 1536, height: 2048, steps: 28, n_samples: 1, model: 'nai-diffusion-5-full' }), 90);
    assert.strictEqual(
      pricingMod.calculateAnlasCost({ width: 1024, height: 1024, n_samples: 2, model: 'nai-diffusion-5-full-medium' }, { isOpus: true, usageNegative: true }),
      30
    );
    assert.throws(
      () => pricingMod.calculateAnlasCost({ width: 3000, height: 3000, steps: 50, n_samples: 1, model: 'nai-diffusion-4-full' }),
      /140 Anlas/
    );
    assert.throws(
      () => pricingMod.calculateAnlasCost({ width: 1536, height: 2048, steps: 50, n_samples: 1, model: 'nai-diffusion-5-full' }),
      /140 Anlas/
    );
    assert.throws(
      () => pricingMod.calculateAnlasCost({ width: 100000, height: 100000, steps: 28, n_samples: 1, has_image: true, strength: 0, model: 'nai-diffusion-4-5-full' }),
      /3145728px/
    );
    assert.throws(
      () => pricingMod.calculateAnlasCost({ width: 1024, height: 1024, steps: 100000, n_samples: 1, has_image: true, strength: 0, model: 'nai-diffusion-5-full' }),
      /50 steps/
    );

    const { extractImageParams } = await import('../src/userscripts/shared/params.js');
    const scalarPayload = JSON.stringify({
      model: 'nai-diffusion-4-5-full',
      parameters: {
        width: 1024, height: 1024, steps: 28, n_samples: 1,
        reference_count: 3,
        reference_image_multiple: ['vibe1', 'vibe2'],
        director_reference_images: ['char1']
      }
    });
    const clientExtracted = await extractImageParams(scalarPayload);
    const serverExtracted = auditEngine.extractParametersFromRawBody(Buffer.from(scalarPayload));
    assert.strictEqual(clientExtracted.precise_refs, serverExtracted.precise_ref_count);
    assert.strictEqual(clientExtracted.precise_refs, 1, 'Must count director_reference_images (1), not reference_image_multiple');
    assert.strictEqual(clientExtracted.vibe_reference_count, serverExtracted.vibe_reference_count);
    assert.strictEqual(clientExtracted.vibe_reference_count, 2);

    const legacyMedPayload = JSON.stringify({
      model: 'nai-diffusion-3-5-medium',
      parameters: { width: 1024, height: 1024, n_samples: 1 }
    });
    assert.strictEqual((await extractImageParams(legacyMedPayload)).steps, 28, 'nai-diffusion-3-5-medium must not match V5 Medium default 14 steps');
  });

  // ---------------------------------------------------------------------------
  // 3. HAPPY PATH: LIVE THEME SCRAPING (TRANSPARENT BODY + NEXT WRAPPER), HIDDEN ALLOWANCE,
  //    BASE-BYPASS NCP SUPPRESSION, NATIVE ANLAS VIRTUALIZATION, /user/subscription GET & /ai/upscale
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Inherits live Next.js wrapper theme on transparent body, hides exempt allowance & base-bypass NCP cost, virtualizes Anlas & proxies /ai/upscale', async () => {
    const { context, storage, networkCalls, setPageFetch, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_guest_10',
      browser_id: 'b_guest_10',
      anlas_bypass_enabled: true
    }, guestCode);

    // Simulate real NovelAI DOM: transparent body, opaque #__next wrapper, opaque textarea card,
    // dark-teal menu button + border, active teal Effort button, cream Generate button,
    // prompt text containing "1536x2048" (must NOT trigger false base-bypass), and nested <span>1</span> sample count.
    context.document.body.innerHTML = `
      <div id="__next" style="background-color: rgb(6, 9, 9); color: rgb(245, 243, 194);">
        <div class="image-gen-nav-row" style="background-color: rgba(0, 0, 0, 0);">
          <div style="display:flex;">
            <button aria-label="menu" class="nav-btn" style="background-color: rgb(12, 36, 36); border-top-color: rgb(29, 93, 91); border-top-width: 1px;"></button>
          </div>
        </div>
        <div style="background-color: rgb(13, 18, 18);">
          <textarea>1536x2048 masterpiece prompt tag</textarea>
        </div>
        <div class="image-gen-model-mode-row">
          <div><span>Model</span><div class="css-icpgrc"><div id="native-model-val" class="css-19vwdf1-singleValue">V5 Full</div><input aria-label="Select the Model" value="" /></div></div>
          <div><span>Effort</span><div><button id="native-med-btn" style="background-color: rgb(20, 76, 74); color: rgb(245, 243, 194);">Medium</button><button id="native-high-btn" style="background-color: rgba(0, 0, 0, 0);">High</button></div></div>
        </div>
        <div class="image-gen-footer" style="background-color: rgba(0, 0, 0, 0);">
          <input type="number" id="native-width-input" aria-label="Width" value="1024" />
          <input type="number" id="native-height-input" aria-label="Height" value="1024" />
          <button class="image-gen-generate-button" style="background-color: rgb(245, 243, 194); color: rgb(18, 18, 22);">
            <span>Generate <span>1</span> Image</span>
            <div class="native-anlas-container"><span id="native-anlas-val">90 Anlas</span></div>
          </button>
        </div>
      </div>
    `;

    setPageFetch(async (url) => {
      if (url.includes('/user/data')) {
        return new Response(JSON.stringify({
          subscription: { tier: 0, active: false, expiresAt: 0 },
          keystore: { keystore: 'E2EE_OK' }
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    // Scoped stylesheet must inherit live #__next background, textarea card, teal border, teal control & cream accent
    const styleSheet = context.document.getElementById('gw-ui-styles');
    assert.ok(styleSheet, '#gw-ui-styles must mount');
    assert.match(styleSheet.textContent, /--theme-bg0:\s*rgb\(6,\s*9,\s*9\)/, 'Scoped --theme-bg0 must override stale :root variables');
    assert.match(styleSheet.textContent, /--gw-bg0:\s*var\(--theme-bg0,\s*rgb\(6,\s*9,\s*9\)\)/, 'Must inherit #__next background when document.body is transparent');
    assert.match(styleSheet.textContent, /--gw-bg1:\s*var\(--theme-bg1,\s*rgb\(13,\s*18,\s*18\)\)/, 'Must inherit textarea card surface');
    assert.match(styleSheet.textContent, /--gw-control-bg:\s*rgb\(20,\s*76,\s*74\)/, 'Must inherit active teal Effort button as control fill');
    assert.match(styleSheet.textContent, /--gw-border-strong:\s*rgb\(29,\s*93,\s*91\)/, 'Must inherit teal border color');
    assert.match(styleSheet.textContent, /rgb\(245,\s*243,\s*194\)/, 'Must inherit cream primary accent');
    assert.match(styleSheet.textContent, /input\[type="checkbox"\]\.gw-switch/, 'Stylesheet must isolate switch sizing');

    // No redundant #gw-effort-select dropdown should exist
    assert.strictEqual(context.document.getElementById('gw-effort-select'), null, 'Must not inject redundant #gw-effort-select');

    // /user/subscription without explicit config.method MUST default to GET, leave count_text_gens untouched,
    // and NOT fire spurious /auth/status telemetry refreshes
    const subPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/user/subscription', {
        headers: { 'Authorization': 'Bearer guest_jwt' }
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1);
    assert.strictEqual(networkCalls[0].method, 'GET', '/user/subscription must default to GET when config.method is omitted');
    assert.strictEqual(networkCalls[0].url, 'https://vps.example.duckdns.org/proxy/image/user/subscription');
    networkCalls[0].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"tier":3}')); c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/json'
    });
    const subResp = await subPromise;
    assert.strictEqual(subResp.status, 200);
    assert.strictEqual(storage.get('count_text_gens') || 0, 0, '/user/subscription must NOT increment count_text_gens');
    assert.strictEqual(networkCalls.some(c => c.url.includes('/auth/status')), false, '/user/subscription must NOT trigger extra /auth/status poll');

    // /ai/encode-vibe MUST use POST, leave count_text_gens at 0, and trigger telemetry refresh on 200 OK
    networkCalls.length = 0;
    const vibePromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/encode-vibe', {
        body: JSON.stringify({ image: 'base64vibe' })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls[0].method, 'POST');
    networkCalls[0].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('encoded_vibe')); c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream'
    });
    await vibePromise;
    assert.strictEqual(storage.get('count_text_gens') || 0, 0, '/ai/encode-vibe must NOT increment count_text_gens');
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')), '/ai/encode-vibe 200 OK must refresh HUD telemetry');

    networkCalls.length = 0;
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));

    const statusCall = networkCalls.find(c => c.url.includes('/auth/status'));
    assert.ok(statusCall, 'Guest poller must request /auth/status');

    statusCall.onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas_consumed: 120,
        precise_limit: 2,
        session: null,
        linked_devices: [{ id: 'b_guest_10', label: 'Desktop' }],
        master_v5_percent: 82.5,
        anlas: {
          virtual_balance: 500,
          available_balance: 500,
          held: 0,
          monthly_quota: 500,
          is_unlimited: false,
          is_in_debt: false,
          zero_rollover: true,
          subscription_period_consumed: 90,
          lifetime_consumed: 120
        },
        v5: {
          banked_ncp: 180,
          available_ncp: 180,
          held_ncp: 0,
          is_unlimited: false,
          daily_share_ncp: 180,
          max_bank_ncp: 540,
          surplus_pool_ncp: 450,
          surplus_available_ncp: 450,
          surplus_eligible: true
        },
        telemetry: {
          master_v5_percent: 82.5,
          master_v5_is_negative: false,
          cluster_state: 'surplus_active',
          next_percent_eta_ms: 1800000,
          is_hard_locked: false,
          subscription_active: true,
          last_fetched_at: Date.now()
        },
        subscription_period: { anlas_consumed: 90, v5_consumed: 4, legacy_image_gens: 1, upscale_gens: 0, text_gens: 2 }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    const v5Bar = context.document.getElementById('gw-v5-bar');
    const allowanceBar = context.document.getElementById('gw-allowance-bar');
    const genBtn = context.document.querySelector('.image-gen-generate-button');
    assert.ok(v5Bar, '#gw-v5-bar must mount');
    assert.ok(allowanceBar, '#gw-allowance-bar must mount');
    assert.strictEqual(v5Bar.nextElementSibling, allowanceBar, '#gw-v5-bar must sit above #gw-allowance-bar');
    assert.strictEqual(allowanceBar.nextElementSibling, genBtn, 'Must preserve #gw-allowance-bar.nextElementSibling === genBtn');
    assert.strictEqual(allowanceBar.style.display, 'none', '#gw-allowance-bar must hide when exempt (session === null)');
    assert.match(v5Bar.style.backgroundColor, /rgb\(6,\s*9,\s*9\)/, '#gw-v5-bar must inherit live app background color');

    const v5Label = context.document.getElementById('gw-v5-label');
    const v5Eta = context.document.getElementById('gw-v5-eta');
    const v5Cost = context.document.getElementById('gw-v5-cost');
    const anlasLabel = context.document.getElementById('gw-anlas-label');
    assert.match(v5Label.textContent, /10 High \/ 18 Med/);
    assert.match(v5Label.textContent, /\+25 Bonus/);
    assert.match(v5Label.textContent, /82\.5%/);
    assert.match(v5Eta.textContent, /Shared Bonus Open/);
    assert.match(v5Eta.textContent, /\+1% in 30\.0m/);
    assert.strictEqual(v5Cost.style.display, '', 'Prompt text 1536x2048 must NOT falsely hide V5 credit cost');
    assert.strictEqual(v5Cost.textContent, 'Uses 10 V5 pts (Med)', '1024x1024 + Anlas enabled (addon-only) must still show V5 credit cost');
    assert.match(anlasLabel.textContent, /Monthly Anlas: 500\/500/);

    // Once /auth/status populated available_balance = 500, /user/data injects live virtual Anlas into native Anlas bar
    const userDataResp = await vm.runInContext(`unsafeWindow.fetch('https://image.novelai.net/user/data')`, context);
    const userDataJson = await userDataResp.json();
    assert.strictEqual(userDataJson.subscription.trainingStepsLeft.fixedTrainingStepsLeft, 500);
    assert.strictEqual(userDataJson.subscription.trainingStepsLeft.purchasedTrainingSteps, 0);
    assert.strictEqual(userDataJson.keystore.keystore, 'E2EE_OK');

    // Setting width=1536, height=2048 with bypass enabled -> NON-ADDON Anlas bypass -> V5 cost badge MUST hide!
    context.document.getElementById('native-width-input').value = '1536';
    context.document.getElementById('native-height-input').value = '2048';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Cost.style.display, 'none', 'V5 credit cost must hide when configured for non-addon Anlas bypass');

    // Restore 1024x1024 and toggle native Effort to High in NovelAI's DOM -> cost badge reappears at 18 V5 pts immediately
    context.document.getElementById('native-width-input').value = '1024';
    context.document.getElementById('native-height-input').value = '1024';
    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgb(20, 76, 74)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Cost.style.display, '');
    assert.strictEqual(v5Cost.textContent, 'Uses 18 V5 pts (High)', 'HUD must display 18 V5 pts for native V5 High selection');

    // 1. Matching scraped cost (90 Anlas with nested <span>1</span> inside Generate label):
    //    must report X-Scraped-Anlas: 90 (NOT 1) and must NOT show a false drift warning!
    networkCalls.length = 0;
    const matchResPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'none', 'Nested <span>1</span> inside Generate label must not trigger false canary drift');
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls[2].headers['x-scraped-anlas'], '90', 'Must scrape 90 Anlas rather than nested sample count 1');
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    await matchResPromise;

    // 2. Genuine canary drift (UI shows 99 Anlas while estimate is 90) -> warns without blocking
    context.document.getElementById('native-anlas-val').textContent = '99 Anlas';
    networkCalls.length = 0;
    const highResPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const joinCall = networkCalls[0];
    assert.strictEqual(joinCall.url, 'https://vps.example.duckdns.org/queue/join');
    const joinBody = JSON.parse(joinCall.data);
    assert.strictEqual(joinBody.model, 'nai-diffusion-5-full');
    assert.strictEqual(joinBody.width, 1536);
    assert.strictEqual(joinBody.height, 2048);
    assert.strictEqual(joinBody.n_samples, 1);
    assert.strictEqual(joinBody.steps, 28);
    assert.strictEqual(joinBody.is_base_paid, true);
    assert.strictEqual(joinBody.is_v5, true);
    assert.strictEqual(joinBody.declared_anlas, 90);

    const alertEl = context.document.getElementById('gw-hud-alert');
    assert.strictEqual(alertEl.style.display, 'block');
    assert.match(alertEl.textContent, /Displayed cost may differ from estimate/);

    joinCall.onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));

    const proxyCall = networkCalls[2];
    assert.strictEqual(proxyCall.headers['x-gen-model'], 'V5');
    assert.strictEqual(proxyCall.headers['x-base-paid'], 'true');
    assert.strictEqual(proxyCall.headers['x-declared-anlas'], '90');
    assert.strictEqual(proxyCall.headers['x-scraped-anlas'], '99');
    assert.strictEqual(proxyCall.headers['x-gen-steps'], '28');

    proxyCall.onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    const highResResp = await highResPromise;
    assert.strictEqual(highResResp.status, 200);

    // 3. Stage 5 Invariant for V5 Medium:
    //    Explicit steps: 25 in body -> X-Gen-Steps MUST forward '25', while pricing uses Module 643656 un-ceiled / 1.75 * 1.5 (= 44 Anlas)
    networkCalls.length = 0;
    const medExplicitPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full-medium',
          parameters: { width: 1536, height: 2048, steps: 25, n_samples: 1 }
        })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const medJoin = networkCalls[0];
    const medJoinBody = JSON.parse(medJoin.data);
    assert.strictEqual(medJoinBody.model, 'nai-diffusion-5-full-medium');
    assert.strictEqual(medJoinBody.steps, 25);
    assert.strictEqual(medJoinBody.declared_anlas, 44, 'V5 Medium 1536x2048 must price at 44 Anlas');

    medJoin.onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));

    const medProxy = networkCalls[2];
    assert.strictEqual(medProxy.headers['x-gen-model'], 'V5-medium');
    assert.strictEqual(medProxy.headers['x-gen-steps'], '25', 'Stage 5 Invariant: X-Gen-Steps must match explicit body steps');
    assert.strictEqual(medProxy.headers['x-declared-anlas'], '44');

    medProxy.onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    await medExplicitPromise;

    // 4. V4.5 Vibe Transfer (`reference_image_multiple` 2 vibes) reports X-Declared-Anlas: 0 & X-Precise-Refs: 0
    networkCalls.length = 0;
    const vibe45Promise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nai-diffusion-4-5-full',
          parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1, reference_image_multiple: ['v1', 'v2'] }
        })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(JSON.parse(networkCalls[0].data).declared_anlas, 0, '2 V4.5 Vibe Transfers must declare 0 Anlas');
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls[2].headers['x-precise-refs'], '0');
    assert.strictEqual(networkCalls[2].headers['x-declared-anlas'], '0');
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    await vibe45Promise;

    // 5. /ai/upscale FormData interception: extracts PNG IHDR (1024x1024 -> 1 Anlas), queues via Channel A
    networkCalls.length = 0;
    context._testPngBlob = createPngHeaderBlob(1024, 1024);
    const upscalePromise = vm.runInContext(`
      (() => {
        const fd = new FormData();
        fd.append('image', globalThis._testPngBlob, 'blob');
        fd.append('request', new Blob([JSON.stringify({
          image: 'image',
          model: 'nai-diffusion-5-curated',
          declared_blur_sigma: 0
        })], { type: 'application/json' }));
        return unsafeWindow.fetch('https://image.novelai.net/ai/upscale', {
          method: 'POST',
          body: fd
        });
      })()
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const upJoin = networkCalls[0];
    assert.strictEqual(upJoin.url, 'https://vps.example.duckdns.org/queue/join');
    const upJoinBody = JSON.parse(upJoin.data);
    assert.strictEqual(upJoinBody.is_upscale, true);
    assert.strictEqual(upJoinBody.width, 1024);
    assert.strictEqual(upJoinBody.height, 1024);
    assert.strictEqual(upJoinBody.declared_anlas, 1);

    upJoin.onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));

    const upProxy = networkCalls[2];
    assert.strictEqual(upProxy.url, 'https://vps.example.duckdns.org/proxy/image/ai/upscale');
    assert.strictEqual(upProxy.headers['x-gen-width'], '1024');
    assert.strictEqual(upProxy.headers['x-gen-height'], '1024');
    assert.strictEqual(upProxy.headers['x-declared-anlas'], '1');
    upProxy.onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('PNG_UPSCALED')); c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: image/png'
    });
    assert.strictEqual((await upscalePromise).status, 200);

    // 6. master_v5_is_negative: true revokes Opus 1-sample discount -> X-Declared-Anlas: 30
    networkCalls.length = 0;
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 0, master_v5_is_negative: true, cluster_state: 'frozen', is_hard_locked: true, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    networkCalls.length = 0;
    const negMultiPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nai-diffusion-5-full-medium',
          parameters: { width: 1024, height: 1024, steps: 14, n_samples: 2 }
        })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(JSON.parse(networkCalls[0].data).declared_anlas, 30, 'Negative V5 tank must revoke Opus 1-sample discount (30 Anlas)');
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    await negMultiPromise;

    // 7. Guest Settings Modal renders dual-ledger fields, hides Rolling Allowance when exempt & contains zero backticks
    const badge = context.document.getElementById('gw-nav-badge');
    badge.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));
    const modal = context.document.getElementById('vps-settings-modal');
    assert.ok(modal);
    assert.doesNotMatch(modal.innerHTML, /`/, 'Settings modal must not render literal Markdown backticks');
    assert.ok(modal.querySelector('#settings-anlas-bypass'));
    assert.ok(modal.querySelector('#guest-virtual-anlas'));
    assert.ok(modal.querySelector('#guest-v5-bank'));
    assert.strictEqual(context.document.getElementById('guest-rolling-allowance-row').style.display, 'none');

    // Simulate Metered session payload -> both #gw-allowance-bar and #guest-rolling-allowance-row become visible
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Metered',
        session: { allowance: 42, max: 100, next_refill_in: 60000 },
        anlas: { virtual_balance: 0, available_balance: 0, monthly_quota: 0, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 0, available_ncp: 0, max_bank_ncp: 0, surplus_available_ncp: 0, surplus_eligible: false, is_unlimited: false },
        telemetry: { master_v5_percent: 80, cluster_state: 'reserve_mode', is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() },
        subscription_period: { anlas_consumed: 0, v5_consumed: 0, legacy_image_gens: 3, upscale_gens: 0, text_gens: 1 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('guest-rolling-allowance-row').style.display, 'flex');
    assert.strictEqual(context.document.getElementById('guest-period-usage').textContent, '0 Anlas · 3 images · 1 text');

    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Metered',
        session: { allowance: 42, max: 100, next_refill_in: 60000 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('gw-allowance-bar').style.display, 'flex');
    assert.match(context.document.getElementById('gw-allowance-label').textContent, /42\/100/);
  });

  // ---------------------------------------------------------------------------
  // 3b. HELL PATH: STALE NAVY BODY + LINEAR GRADIENT + TRANSLUCENT TINTS + DELAYED NAV BADGE SWAP
  // ---------------------------------------------------------------------------
  await t.test('Theme Scraping Hell Paths: Skips stale navy body, translucent overlays, extracts gradients & syncs delayed nav badge theme swap', async () => {
    const { context, triggerObserverSync, triggerHeadStyleMutation } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_brown_theme',
      browser_id: 'b_brown_theme'
    }, guestCode);

    // Stale navy CSS on body (rgb(19, 21, 44)) + translucent white hover tint overlay +
    // real warm-brown theme painted via linear-gradient on layout wrapper + card container border +
    // delayed teal->brown transition on button[aria-label="menu"].
    context.document.body.style.backgroundColor = 'rgb(19, 21, 44)';
    context.document.body.style.color = 'rgb(245, 243, 194)';
    context.document.body.innerHTML = `
      <div id="__next">
        <div id="theme-canvas" style="background-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgb(50, 27, 15) 100%);">
          <div style="background-color: rgba(255, 255, 255, 0.08);">
            <div class="image-gen-nav-row" style="background-color: rgba(0, 0, 0, 0.15);">
              <div style="display:flex;">
                <button id="menu-btn" aria-label="menu" class="nav-btn-teal" style="background-color: rgb(12, 36, 36); color: rgb(255, 255, 255);"></button>
              </div>
              <div style="border-top-color: rgb(91, 56, 36); border-top-width: 1px;">Anlas: 112</div>
            </div>
            <div style="background-color: rgb(33, 8, 4); border-top-color: rgb(91, 56, 36); border-top-width: 1px;">
              <textarea>prompt</textarea>
            </div>
            <div class="image-gen-footer">
              <button class="image-gen-generate-button" style="background-color: rgb(245, 203, 92); color: rgb(26, 15, 10);">
                <span>Generate 1 Image</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const styleSheet = context.document.getElementById('gw-ui-styles');
    const v5Bar = context.document.getElementById('gw-v5-bar');
    const navBadge = context.document.getElementById('gw-nav-badge');
    assert.ok(styleSheet && v5Bar && navBadge);

    assert.match(styleSheet.textContent, /--theme-bg0:\s*rgb\(50,\s*27,\s*15\)/, 'Must inherit inner warm-brown gradient instead of stale navy body');
    assert.match(styleSheet.textContent, /--theme-bg2:\s*rgb\(91,\s*56,\s*36\)/, 'Must inherit card/pill borderTopColor instead of translucent white fallback');
    assert.match(v5Bar.style.backgroundColor, /rgb\(50,\s*27,\s*15\)/);
    assert.match(v5Bar.style.border, /rgb\(91,\s*56,\s*36\)/);
    assert.strictEqual(navBadge.className, 'nav-btn-teal');

    const menuBtn = context.document.getElementById('menu-btn');
    menuBtn.className = 'nav-btn-brown';
    menuBtn.style.backgroundColor = 'rgb(75, 43, 26)';
    menuBtn.style.color = 'rgb(245, 243, 194)';
    menuBtn.style.borderTopColor = 'rgb(91, 56, 36)';
    context.document.getElementById('theme-canvas').style.backgroundImage = 'none';
    context.document.getElementById('theme-canvas').style.backgroundColor = 'rgb(56, 30, 17)';

    const headStyle = context.document.createElement('style');
    context.document.head.appendChild(headStyle);
    triggerHeadStyleMutation(headStyle);
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(navBadge.className, 'nav-btn-brown', 'Delayed theme hydration must sync #gw-nav-badge className');
    assert.strictEqual(navBadge.style.backgroundColor, 'rgb(75, 43, 26)', 'Delayed theme hydration must sync #gw-nav-badge backgroundColor');
    assert.strictEqual(navBadge.style.color, 'rgb(245, 243, 194)', 'Delayed theme hydration must sync #gw-nav-badge color');
    assert.match(styleSheet.textContent, /--theme-bg0:\s*rgb\(56,\s*30,\s*17\)/, 'Head style mutation must refresh live scraped theme');
  });

  // ---------------------------------------------------------------------------
  // 3b-ii. HELL PATH: CHARACTER PROMPTS CARD + PROMPT INPUT BOX + CLICK-TO-COPY CHIPS
  // ---------------------------------------------------------------------------
  await t.test('Theme & Clipboard: Cards match Character Prompts bg + outline, inputs/chips match Prompt box bg, and browser chips copy full ID', async () => {
    const fullBid1 = 'b_1c92fbcf00112233445566778899aabb';
    const fullBid2 = 'b_1073eb7c998877665544332211ffeedd';

    const { context, networkCalls, copiedTexts, execCommands, setClipboardError, setExecCommandReturn, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_novelai_dom',
      browser_id: fullBid1
    }, guestCode);

    // Replicates NovelAI's real DOM:
    // - Hidden [role="dialog"] carrying navy fallback rgb(19, 21, 44) (must be ignored!)
    // - Outer sidebar wrapper carrying stale navy backgroundColor: rgb(19, 21, 44) UNDER a warm-brown gradient
    // - .image-gen-character-prompts + .image-gen-character-prompts-header painting card bg + outline
    // - .image-gen-prompt-main > .prompt-input-box-prompt[data-prompt-input="true"] painting recessed prompt box bg,
    //   with inner .sc-b7a086c6-0 toolbar carrying bright button color that must NOT leak into --gw-input-bg!
    context.document.body.style.backgroundColor = 'rgb(19, 21, 44)';
    context.document.body.innerHTML = `
      <div role="dialog" style="display: none; background-color: rgb(19, 21, 44);">Hidden Dialog</div>
      <div id="__next">
        <div id="sidebar-wrapper" style="background-color: rgb(19, 21, 44); background-image: linear-gradient(180deg, rgb(50, 27, 15) 0%, rgb(44, 23, 12) 100%); color: rgb(245, 243, 194);">
          <div class="image-gen-nav-row">
            <div style="display:flex;">
              <button aria-label="menu" style="background-color: rgb(75, 43, 26); color: rgb(245, 243, 194);"></button>
            </div>
          </div>
          <div class="image-gen-model-mode-row">
            <div><span>Model</span><div class="css-icpgrc"><div class="css-singleValue">V5 Full</div><input aria-label="Select the Model" value="" /></div></div>
            <div><span>Effort</span><div><button style="background-color: rgb(95, 58, 36);">Medium</button><button style="background-color: rgba(0, 0, 0, 0);">High</button></div></div>
          </div>
          <div class="image-gen-prompt-main">
            <div class="prompt-input-box-prompt" data-prompt-input="true" style="background-color: rgb(37, 7, 3); border-top-color: rgb(105, 44, 24); border-top-width: 1px;">
              <div class="relative">
                <div class="sc-58cb76b2-43 hHIolY">
                  <div contenteditable="true" translate="no" class="ProseMirror"><p>minccino</p></div>
                </div>
              </div>
              <div class="sc-b7a086c6-0 dZAKno" style="background-color: rgb(120, 80, 60);">
                <button style="background-color: rgb(200, 160, 120);">Transparent BG</button>
              </div>
            </div>
          </div>
          <div class="sc-5eac4fda-0 eRsbjO image-gen-character-prompts" style="background-color: rgba(255, 255, 255, 0.08); border-top-color: rgb(102, 62, 38); border-top-width: 1px; border-top-style: solid;">
            <div class="sc-5eac4fda-1 fQipBf image-gen-character-prompts-header">
              <div>Character Prompts</div>
            </div>
          </div>
          <div class="image-gen-footer">
            <button class="image-gen-generate-button" style="background-color: rgb(245, 203, 92); color: rgb(26, 15, 10);">
              <span>Generate 1 Image</span>
            </button>
          </div>
        </div>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const styleSheet = context.document.getElementById('gw-ui-styles');
    assert.ok(styleSheet);

    // 1. Sidebar wrapper gradient rgb(50, 27, 15) must win over stale navy fallback rgb(19, 21, 44)
    assert.match(styleSheet.textContent, /--theme-bg0:\s*rgb\(50,\s*27,\s*15\)/);
    // 2. Character Prompts rgba(255,255,255,0.08) composited over rgb(50,27,15) -> rgb(66, 45, 34), never navy!
    assert.match(styleSheet.textContent, /--theme-bg1:\s*rgb\(66,\s*45,\s*34\)/, 'Card bg must inherit composited Character Prompts surface');
    assert.doesNotMatch(styleSheet.textContent, /--theme-bg1:\s*rgb\(19,\s*21,\s*44\)/, 'Hidden dialog / stale fallback navy must never leak into --theme-bg1');
    // 3. Card outline matches Character Prompts border-top-color rgb(102, 62, 38)
    assert.match(styleSheet.textContent, /--gw-card-border:\s*rgb\(102,\s*62,\s*38\)/);
    assert.match(styleSheet.textContent, /\.gw-card\s*\{[^}]*border:\s*1px solid var\(--gw-card-border\)/);
    // 4. Text fields & inline code chips inherit Prompt input box rgb(37, 7, 3) + border rgb(105, 44, 24) (never toolbar rgb(120,80,60))
    assert.match(styleSheet.textContent, /--gw-input-bg:\s*rgb\(37,\s*7,\s*3\)/);
    assert.match(styleSheet.textContent, /--gw-input-border:\s*rgb\(105,\s*44,\s*24\)/);
    assert.match(styleSheet.textContent, /\.gw-input,\s*\.gw-select\s*\{[^}]*background:\s*var\(--gw-input-bg\)/);
    assert.match(styleSheet.textContent, /\.gw-code-chip\s*\{[^}]*background:\s*var\(--gw-input-bg\)/);

    // 5. Linked browser ID chunks in Guest modal copy the FULL browser_id on click & Enter, and fall back to execCommand
    context.document.getElementById('gw-nav-badge').onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));
    const statusCall = networkCalls.find(c => c.url.includes('/auth/status'));
    assert.ok(statusCall);
    statusCall.onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Low',
        linked_devices: [
          { id: fullBid1, label: 'Test' },
          { id: fullBid2, label: 'GuestTest1' }
        ],
        anlas: { virtual_balance: 112, available_balance: 112, monthly_quota: 250, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 25.0, cluster_state: 'reserve_mode', is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    const chips = context.document.querySelectorAll('#guest-linked-devices .gw-copy-chip');
    assert.strictEqual(chips.length, 2, 'Guest linked browser chips must render as copyable .gw-copy-chip elements');
    assert.strictEqual(chips[0].textContent, 'b_1c92fbcf...');
    assert.strictEqual(chips[0].getAttribute('data-copy-id'), fullBid1);

    // Click copies full ID and restores original truncated label
    chips[0].onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(copiedTexts[0], fullBid1, 'Clicking truncated chip must copy FULL browser_id');
    assert.strictEqual(chips[0].textContent, 'b_1c92fbcf...', 'Original chip label must remain intact after reset timer');

    // Keyboard Enter triggers copy on second chip
    chips[1].onkeydown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(copiedTexts[1], fullBid2, 'Pressing Enter on truncated chip must copy FULL browser_id');

    // Verify navigator.clipboard failure falls back cleanly to document.execCommand('copy') with focus() & setSelectionRange()
    setClipboardError(new Error('Clipboard API blocked'));
    chips[0].onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(execCommands.length, 1);
    assert.strictEqual(execCommands[0].cmd, 'copy');
    assert.strictEqual(execCommands[0].focusCalled, true);
    assert.deepStrictEqual(execCommands[0].selectionRange, [0, fullBid1.length]);
    assert.strictEqual(copiedTexts[2], fullBid1, 'Fallback execCommand must copy full browser_id when Clipboard API rejects');

    // 6. Scoped async timer checks: 'Copy failed', Spacebar copy, and overlapping rapid double-click cancellation
    const origSandboxSetTimeout = context.setTimeout;
    const origSandboxClearTimeout = context.clearTimeout;
    const origClipboardWrite = context.navigator.clipboard.writeText;
    const activeResetTimers = new Map();
    let asyncTimerSeq = 100;

    context.setTimeout = (fn, delay = 0) => {
      if (delay >= 1500) {
        const id = asyncTimerSeq++;
        activeResetTimers.set(id, fn);
        return id;
      }
      return origSandboxSetTimeout(fn, delay);
    };
    context.clearTimeout = (id) => {
      if (activeResetTimers.has(id)) {
        activeResetTimers.delete(id);
        return;
      }
      return origSandboxClearTimeout(id);
    };

    try {
      setExecCommandReturn(false);
      chips[0].onclick({ preventDefault: () => {}, stopPropagation: () => {} });
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(chips[0].textContent, 'Copy failed', 'Total clipboard failure must display Copy failed');
      assert.strictEqual(activeResetTimers.size, 1);
      for (const [id, fn] of Array.from(activeResetTimers.entries())) {
        activeResetTimers.delete(id);
        fn();
      }
      assert.strictEqual(chips[0].textContent, 'b_1c92fbcf...');

      setExecCommandReturn(true);
      setClipboardError(null);
      let resolveFirstWrite;
      let asyncCalls = 0;
      context.navigator.clipboard.writeText = (text) => {
        asyncCalls += 1;
        copiedTexts.push(String(text));
        if (asyncCalls === 1) {
          return new Promise(resolve => { resolveFirstWrite = resolve; });
        }
        return Promise.resolve();
      };

      chips[0].onclick({ preventDefault: () => {}, stopPropagation: () => {} });
      chips[0].onclick({ preventDefault: () => {}, stopPropagation: () => {} });
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(chips[0].textContent, 'Copied!', 'Overlapping rapid double-click must hold Copied! label');
      assert.strictEqual(activeResetTimers.size, 1, 'Overlapping rapid double-click must arm exactly one reset timer');

      resolveFirstWrite();
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(chips[0].textContent, 'Copied!', 'Superseded first click resolving late must not clobber Copied!');
      assert.strictEqual(activeResetTimers.size, 1);

      for (const [id, fn] of Array.from(activeResetTimers.entries())) {
        activeResetTimers.delete(id);
        fn();
      }
      assert.strictEqual(chips[0].textContent, 'b_1c92fbcf...');

      let spacePrevented = false;
      chips[1].onkeydown({
        key: ' ',
        preventDefault: () => { spacePrevented = true; },
        stopPropagation: () => {}
      });
      await new Promise(r => setTimeout(r, 10));
      assert.strictEqual(spacePrevented, true);
      assert.strictEqual(chips[1].textContent, 'Copied!');
      for (const [id, fn] of Array.from(activeResetTimers.entries())) {
        activeResetTimers.delete(id);
        fn();
      }
      assert.strictEqual(chips[1].textContent, 'b_1073eb7c...');
    } finally {
      context.setTimeout = origSandboxSetTimeout;
      context.clearTimeout = origSandboxClearTimeout;
      context.navigator.clipboard.writeText = origClipboardWrite;
    }

    // 7. Toolbar-first prompt box, ancestor-hidden wrappers, blurred drop shadow vs 0 0 0 1px ring & inputBorder sync
    const hellSandbox = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_theme_hell',
      browser_id: 'b_theme_hell'
    }, guestCode);
    hellSandbox.context.document.body.style.backgroundColor = 'rgb(19, 21, 44)';
    hellSandbox.context.document.body.innerHTML = `
      <div style="display: none;">
        <div role="dialog" style="background-color: rgb(19, 21, 44);">Hidden Portal Dialog</div>
      </div>
      <textarea style="background-color: rgb(220, 40, 40);">stray</textarea>
      <div id="__next">
        <div style="background-image: linear-gradient(180deg, rgb(50, 27, 15) 0%, rgb(44, 23, 12) 100%); color: rgb(245, 243, 194);">
          <div class="image-gen-nav-row"><button aria-label="menu" style="background-color: rgb(75, 43, 26);"></button></div>
          <div class="image-gen-prompt-main">
            <div class="prompt-input-box-prompt" data-prompt-input="true" style="background-color: rgba(0, 0, 0, 0); box-shadow: rgba(0, 0, 0, 0.55) 0px 4px 12px 0px;">
              <div class="sc-b7a086c6-0" style="background-color: rgb(210, 170, 120);"><button>Tags</button></div>
              <div class="relative" style="background-color: rgb(37, 7, 3);">
                <div contenteditable="true" class="ProseMirror"><p>prompt</p></div>
              </div>
            </div>
          </div>
          <div id="cards-col">
            <div class="image-gen-character-prompts" style="background-color: rgb(66, 45, 34); box-shadow: rgba(0, 0, 0, 0.45) 0px 4px 12px 0px, rgb(102, 62, 38) 0px 0px 0px 1px;">
              <div class="image-gen-character-prompts-header">Characters</div>
            </div>
          </div>
          <div class="image-gen-footer">
            <button class="image-gen-generate-button" style="background-color: rgb(245, 203, 92); color: rgb(26, 15, 10);"><span>Generate 1 Image</span></button>
          </div>
        </div>
      </div>
    `;
    vm.runInContext(guestCode, hellSandbox.context);
    hellSandbox.triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    const hellCss = hellSandbox.context.document.getElementById('gw-ui-styles').textContent;
    assert.match(hellCss, /--theme-bg1:\s*rgb\(66,\s*45,\s*34\)/);
    assert.doesNotMatch(hellCss, /--theme-bg1:\s*rgb\(19,\s*21,\s*44\)/);
    assert.match(hellCss, /--gw-input-bg:\s*rgb\(37,\s*7,\s*3\)/, 'Toolbar-first .sc-b7a086c6-0 and stray textarea must not hijack --gw-input-bg');
    assert.doesNotMatch(hellCss, /rgba\(0,\s*0,\s*0,\s*0\.45\)/, 'Blurred drop shadow must never hijack border tokens');
    assert.doesNotMatch(hellCss, /rgba\(0,\s*0,\s*0,\s*0\.55\)/, 'Prompt drop shadow must never hijack --gw-input-border');
    assert.match(hellCss, /--gw-card-border:\s*rgb\(102,\s*62,\s*38\)/);
    assert.match(hellCss, /--gw-input-border:\s*rgb\(102,\s*62,\s*38\)/, 'Borderless prompt box must inherit resolved borderStrong');

    hellSandbox.context.document.getElementById('cards-col').style.opacity = '0';
    hellSandbox.triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    const hiddenCardCss = hellSandbox.context.document.getElementById('gw-ui-styles').textContent;
    assert.doesNotMatch(hiddenCardCss, /--theme-bg1:\s*rgb\(66,\s*45,\s*34\)/, 'opacity: 0 ancestor must exclude hidden character prompts card');
    assert.doesNotMatch(hiddenCardCss, /--theme-bg1:\s*rgb\(19,\s*21,\s*44\)/, 'display: none ancestor around [role="dialog"] must never leak navy bg1');
  });

  // ---------------------------------------------------------------------------
  // 3b-iii. HELL PATH: MOBILE LAYOUT THEME INHERITANCE, HIDDEN DESKTOP DUPLICATES & COMPACT HUD
  // ---------------------------------------------------------------------------
  await t.test('Mobile Layout Hell Path: Skips hidden desktop DOM & stale body navy, mounts on mobile controls & renders compact single-line HUD', async () => {
    const mobileSandbox = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_mobile',
      browser_id: 'b_mobile',
      anlas_bypass_enabled: true
    }, guestCode);
    const { context, networkCalls, triggerIntervalAtMs, triggerObserverSync, triggerResize } = mobileSandbox;

    context.window.innerWidth = 375;
    context.document.body.style.backgroundColor = 'rgb(19, 21, 44)';
    context.document.body.style.color = 'rgb(245, 243, 194)';

    // Emulates NovelAI mobile DOM:
    // - Child 0 under #__next is the desktop layout hidden via display: none (with .image-gen-nav-row / .image-gen-footer)
    // - Child 1 is the visible mobile layout without .image-gen-nav-row / .image-gen-footer / .image-gen-model-mode-row,
    //   painting warm brown via CSS Color 4 space-separated `rgb(45 22 11)` on the main mobile wrapper
    //   and semi-opaque brown drawer around prompt + mobile Generate button.
    context.document.body.innerHTML = `
      <div id="__next">
        <div id="desktop-hidden" style="display: none; background-color: rgb(19, 21, 44);">
          <div class="image-gen-nav-row"><button aria-label="menu"></button></div>
          <div class="image-gen-character-prompts" style="background-color: rgb(19, 21, 44);"></div>
          <div class="image-gen-footer"><button class="image-gen-generate-button"><span>Generate 1 Image</span></button></div>
        </div>
        <div id="mobile-shell" style="background-color: rgb(45 22 11); color: rgb(245, 243, 194);">
          <div id="mobile-top-bar" style="background-color: rgba(0, 0, 0, 0);">
            <button id="mobile-menu-btn" aria-label="menu" style="background-color: rgb(75, 43, 26); border-top-color: rgb(102, 62, 38); border-top-width: 1px; color: rgb(245, 243, 194);"></button>
          </div>
          <div id="mobile-canvas" style="background-color: rgba(0, 0, 0, 0);"></div>
          <div id="mobile-drawer" style="background-color: rgb(66, 45, 34); border-top-color: rgb(102, 62, 38); border-top-width: 1px;">
            <div class="prompt-input-box-prompt" data-prompt-input="true" style="background-color: rgb(37, 7, 3);">
              <div contenteditable="true" class="ProseMirror"><p>minccino</p></div>
            </div>
            <div id="mobile-action-row">
              <button id="mobile-gen-btn" class="image-gen-generate-button" style="background-color: rgb(245, 203, 92); color: rgb(26, 15, 10);">
                <span>Generate 1 Image</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    // Verify theme inherited mobile brown rgb(45 22 11) and NEVER stale body navy rgb(19, 21, 44)
    const styleEl = context.document.getElementById('gw-ui-styles');
    assert.ok(styleEl);
    assert.match(styleEl.textContent, /--theme-bg0:\s*rgb\(45\s+22\s+11\)/, 'Mobile layout must extract active theme bg0 instead of falling back to body #13152c');
    assert.doesNotMatch(styleEl.textContent, /--theme-bg0:\s*rgb\(19,\s*21,\s*44\)/);
    assert.match(styleEl.textContent, /#gw-v5-bar\.gw-v5-compact/, 'Stylesheet must include compact mobile HUD CSS rules');

    // Verify #gw-nav-badge & #gw-v5-bar mounted on VISIBLE mobile controls (NOT hidden desktop!)
    const navBadge = context.document.getElementById('gw-nav-badge');
    const v5Bar = context.document.getElementById('gw-v5-bar');
    const allowanceBar = context.document.getElementById('gw-allowance-bar');
    const mobileGenBtn = context.document.getElementById('mobile-gen-btn');
    const mobileMenuBtn = context.document.getElementById('mobile-menu-btn');
    assert.strictEqual(navBadge.parentElement, mobileMenuBtn.parentElement, 'Badge must mount next to visible mobile menu button');
    assert.strictEqual(v5Bar.parentElement, mobileGenBtn.parentElement, '#gw-v5-bar must mount inside visible mobile drawer');
    assert.strictEqual(allowanceBar.nextElementSibling, mobileGenBtn);
    assert.strictEqual(v5Bar.className, 'gw-v5-compact', 'Mobile viewport must apply .gw-v5-compact class');
    assert.match(v5Bar.style.backgroundColor, /rgb\(45\s+22\s+11\)/);

    // Poll /auth/status and verify compact non-truncating single-line text on mobile
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    const statusCall = networkCalls.find(c => c.url.includes('/auth/status'));
    statusCall.onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Low',
        anlas: { virtual_balance: 88, available_balance: 88, monthly_quota: 250, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 2180, available_ncp: 2180, max_bank_ncp: 2700, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 19.0, cluster_state: 'reserve_mode', next_percent_eta_ms: 7200000, is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(context.document.getElementById('gw-v5-label').textContent, 'V5: 121H/218M', 'Mobile must keep High & Med counts compact so they never clip into ellipsis');
    assert.strictEqual(context.document.getElementById('gw-v5-eta').textContent, '19.0% · +2.0h');
    assert.strictEqual(context.document.getElementById('gw-anlas-label').textContent, 'Anlas: 88/250');

    // Open mobile settings modal -> modal outer shell must also inherit warm brown (not navy #13152c)
    navBadge.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));
    const modal = context.document.getElementById('vps-settings-modal');
    assert.ok(modal);
    assert.match(modal.style.background, /rgb\(45\s+22\s+11\)/, 'Mobile modal must not revert to navy #13152c');
    context.document.getElementById('guest-close-modal-btn').onclick();

    // Second mobile edge case: ONLY mobile drawer card has background color (no outer #mobile-shell color) + stale body navy
    const fallbackMobile = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_mobile2',
      browser_id: 'b_mobile2'
    }, guestCode);
    fallbackMobile.context.window.innerWidth = 375;
    fallbackMobile.context.document.body.style.backgroundColor = 'rgb(19, 21, 44)';
    fallbackMobile.context.document.body.innerHTML = `
      <div id="__next">
        <div id="mobile-drawer" style="background-color: rgba(54, 28, 15, 0.72);">
          <textarea>prompt</textarea>
          <button class="image-gen-generate-button" style="background-color: rgb(245, 203, 92);"><span>Generate 1 Image</span></button>
        </div>
      </div>
    `;
    vm.runInContext(guestCode, fallbackMobile.context);
    fallbackMobile.triggerObserverSync();
    const fallbackCss = fallbackMobile.context.document.getElementById('gw-ui-styles').textContent;
    assert.match(fallbackCss, /--theme-bg0:\s*rgb\(54,\s*28,\s*15\)/, 'Semi-opaque mobile drawer layer must beat stale navy body fallback');
    assert.doesNotMatch(fallbackCss, /--theme-bg0:\s*rgb\(19,\s*21,\s*44\)/);

    // Resizing back to desktop (1280px) dynamically drops .gw-v5-compact and restores full desktop HUD copy
    triggerResize(1280);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Bar.className, '', 'Resizing to desktop width must clear .gw-v5-compact');
    assert.match(context.document.getElementById('gw-v5-label').textContent, /121 High \/ 218 Med/);
    assert.match(context.document.getElementById('gw-anlas-label').textContent, /Monthly Anlas: 88\/250/);
  });

  // ---------------------------------------------------------------------------
  // 3c. HELL PATH: DARK BUTTON SURFACE + BRIGHT TEXT CONTRAST IN THEME SCRAPER
  // ---------------------------------------------------------------------------
  await t.test('Theme Contrast: Dark Generate button surface adopts bright text color as accent (never dark-on-dark)', () => {
    const { context, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_theme',
      browser_id: 'b_theme'
    }, guestCode);

    context.document.body.style.backgroundColor = 'rgb(14, 15, 33)';
    context.document.body.style.color = 'rgb(245, 243, 194)';
    context.document.body.innerHTML = `
      <div class="image-gen-footer">
        <button class="image-gen-generate-button" style="background-color: rgb(24, 27, 54); color: rgb(245, 243, 194);">
          <span>Generate 1 Image</span>
        </button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const styleSheet = context.document.getElementById('gw-ui-styles');
    assert.ok(styleSheet);
    assert.match(
      styleSheet.textContent,
      /--gw-accent:\s*var\(--theme-accent,\s*rgb\(245,\s*243,\s*194\)\)/,
      'Dark Generate button surface must fall back to bright button text color instead of creating dark-on-dark accent'
    );
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: CLIENT DEADBAND GUARD, LIVE INPUT EVENTS, BADGE TEXT & FORMDATA
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Blocks V5 High deadband, detects V5New badge, ignores V50/3.5, blocks strength=0 evasion & passes FormData/Blob', async () => {
    const { context, networkCalls, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_deadband',
      browser_id: 'b_deadband',
      anlas_bypass_enabled: false
    }, guestCode);

    // Uses standard react-select nested input wrapper WITHOUT -singleValue class to verify parent sibling traversal
    context.document.body.innerHTML = `
      <div class="image-gen-model-mode-row">
        <div><span>Model</span><div class="css-val-container"><div id="native-model-val" class="hashed-val">NAI Diffusion V5New</div><div class="hashed-input-wrap"><input aria-label="Select the Model" value="" /></div></div></div>
        <div><span>Effort</span><div><button id="native-med-btn" style="background-color: rgba(0, 0, 0, 0);">Medium</button><button id="native-high-btn" style="background-color: rgb(25, 90, 95);">High</button></div></div>
      </div>
      <div class="image-gen-footer">
        <input type="number" id="step-slider" aria-label="Steps" value="23" />
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const stepSlider = context.document.getElementById('step-slider');
    const v5Cost = context.document.getElementById('gw-v5-cost');
    assert.strictEqual(v5Cost.textContent, 'Uses 18 V5 pts (High)');
    assert.strictEqual(stepSlider.getAttribute('max'), '23');
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'none');

    // Simulate user typing/sliding steps to 25 (live input event without MutationObserver churn)
    stepSlider.value = '25';
    stepSlider.dispatchEvent({ type: 'input', target: stepSlider });
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'block', 'Live input event to step 25 must trigger deadband warning immediately');
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /Steps 24–28 are blocked/);

    // Arming Anlas Bypass while steps remain 25 on V5 High -> clicking Generate sets deadband alert,
    // and subsequent MutationObserver ticks MUST NOT erase that deadband alert until steps change
    const bypassToggle = context.document.getElementById('gw-bypass-toggle');
    bypassToggle.checked = true;
    bypassToggle.onchange();

    const armedDeadbandResp = await vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1024, height: 1024, steps: 25, n_samples: 1 }
        })
      })
    `, context);
    assert.strictEqual(armedDeadbandResp.status, 400);
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'block');

    // strength: 0 with 100000x100000 dimensions must fail locally (400) with zero network calls
    const strength0Resp = await vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-4-5-full',
          parameters: { width: 100000, height: 100000, steps: 28, n_samples: 1, image: 'img', strength: 0 }
        })
      })
    `, context);
    assert.strictEqual(strength0Resp.status, 400);
    assert.strictEqual(networkCalls.length, 0);

    bypassToggle.checked = false;
    bypassToggle.onchange();
    for (const badStep of [24, 25, 28]) {
      const resp = await vm.runInContext(`
        unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
          method: 'POST',
          body: JSON.stringify({
            model: 'nai-diffusion-5-full',
            parameters: { width: 1024, height: 1024, steps: ${badStep}, n_samples: 1 }
          })
        })
      `, context);
      assert.strictEqual(resp.status, 400, `V5 High step ${badStep} must block client-side`);
      const errBody = await resp.json();
      assert.match(errBody.message, /Steps 24–28 are blocked/);
    }
    assert.strictEqual(networkCalls.length, 0, 'Deadband requests must never hit /queue/join');

    // 2. Switch NovelAI's native Effort pill to Medium -> clears deadband alert, updates cost to 10 V5 pts, restores slider max=28
    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Cost.textContent, 'Uses 10 V5 pts (Med)');
    assert.strictEqual(stepSlider.getAttribute('max'), '28');
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'none', 'Switching to Medium must clear deadband alert');

    // 3. FormData with Blob `request` part (native Medium payload) passes untouched with matching X-Gen-Model: V5-medium
    const fdPromise = vm.runInContext(`
      (() => {
        const fd = new FormData();
        fd.append('request', new Blob([JSON.stringify({
          model: 'nai-diffusion-5-full-medium',
          parameters: { width: 1024, height: 1024, n_samples: 1 }
        })], { type: 'application/json' }));
        return unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
          method: 'POST',
          body: fd
        });
      })()
    `, context);

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1);
    const fdJoinBody = JSON.parse(networkCalls[0].data);
    assert.strictEqual(fdJoinBody.model, 'nai-diffusion-5-full-medium');
    assert.strictEqual(fdJoinBody.steps, 14, 'Absent steps on Medium must default to 14');
    assert.strictEqual(fdJoinBody.is_base_paid, false);
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));

    const fdProxyCall = networkCalls[2];
    assert.strictEqual(fdProxyCall.headers['x-gen-model'], 'V5-medium');
    assert.strictEqual(fdProxyCall.headers['x-gen-steps'], '14');
    const rawBlobPayload = JSON.parse(await fdProxyCall.data.get('request').text());
    assert.strictEqual(rawBlobPayload.model, 'nai-diffusion-5-full-medium');
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    assert.strictEqual((await fdPromise).status, 200);

    // 4. High-res (1536x2048) with Anlas Bypass DISARMED -> blocked client-side (400) with zero network calls
    networkCalls.length = 0;
    const unbypassedResp = await vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-4-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      })
    `, context);
    assert.strictEqual(unbypassedResp.status, 400);
    const unbypassedJson = await unbypassedResp.json();
    assert.strictEqual(unbypassedJson.error, 'BYPASS_DISABLED');
    assert.strictEqual(networkCalls.length, 0);

    // 5. Switch native Model dropdown to V4.5 Full, NAI 3.5, SD 1.5, and Model V50 -> must all render Legacy (0 V5 pts)
    for (const legacyLabel of ['V4.5 Full', 'NAI Diffusion 3.5', 'SD 1.5', 'Model V50']) {
      context.document.getElementById('native-model-val').textContent = legacyLabel;
      triggerObserverSync();
      await new Promise(r => setTimeout(r, 20));
      assert.strictEqual(v5Cost.textContent, 'Legacy (0 V5 pts)', `Model "${legacyLabel}" must not be misclassified as V5`);
      assert.strictEqual(stepSlider.getAttribute('max'), '28');
    }

    // 6. Arming Anlas Bypass toggle on free-tier geometry (1024x1024, 23 steps, 1 sample)
    //    MUST still send X-Base-Paid: false so proxy Stage 6 never rejects valid free gens
    networkCalls.length = 0;
    bypassToggle.checked = true;
    bypassToggle.onchange();

    const freeWhileArmedPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 }
        })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const freeJoinBody = JSON.parse(networkCalls[0].data);
    assert.strictEqual(freeJoinBody.is_base_paid, false, 'Free geometry must keep is_base_paid: false even when bypass is armed');
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls[2].headers['x-base-paid'], 'false');

    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    assert.strictEqual((await freeWhileArmedPromise).status, 200);
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: DEBT STATE UI LOCKOUT & EPHEMERAL TELEMETRY ISOLATION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Negative Anlas debt locks bypass & upscale, stale GM telemetry never poisons boot & forgiveness restores hint', async () => {
    // Seed stale gw_policy_state with isHardLocked: true & subscriptionActive: false to prove fresh boot ignores it
    const { context, storage, networkCalls, setPageFetch, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_debt10',
      browser_id: 'b_debt10',
      anlas_bypass_enabled: true,
      gw_policy_state: JSON.stringify({
        isHardLocked: true,
        subscriptionActive: false,
        lastFetchedAt: Date.now() - 3600000,
        masterV5Percent: 2.0
      })
    }, guestCode);

    context.document.body.innerHTML = `
      <div class="image-gen-nav-row"><button aria-label="menu"></button></div>
      <div class="image-gen-model-mode-row">
        <div><span>Model</span><div class="css-icpgrc"><div id="native-model-val" class="css-19vwdf1-singleValue">V5 Full</div><input aria-label="Select the Model" value="" /></div></div>
        <div><span>Effort</span><div><button id="native-med-btn" style="background-color: rgba(0, 0, 0, 0);">Medium</button><button id="native-high-btn" style="background-color: rgb(25, 90, 95);">High</button></div></div>
      </div>
      <div class="image-gen-footer">
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;

    setPageFetch(async (url) => {
      if (url.includes('/user/data')) {
        return new Response(JSON.stringify({ subscription: { tier: 0, active: false } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    // Fresh boot must ignore stale gw_policy_state and keep Generate button unblocked before /auth/status responds
    assert.strictEqual(
      context.document.getElementById('gw-button-shield').style.display,
      'none',
      'Fresh page boot must NOT lock Generate button using stale cross-session gw_policy_state'
    );

    const bypassToggle = context.document.getElementById('gw-bypass-toggle');
    assert.strictEqual(bypassToggle.checked, true);

    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));

    const statusCall = networkCalls.find(c => c.url.includes('/auth/status'));
    statusCall.onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas_consumed: 600,
        precise_limit: 2,
        session: null,
        linked_devices: [],
        master_v5_percent: 80,
        anlas: {
          virtual_balance: -40,
          available_balance: -40,
          held: 0,
          monthly_quota: 500,
          is_unlimited: false,
          is_in_debt: true,
          zero_rollover: true
        },
        v5: {
          banked_ncp: 180,
          available_ncp: 180,
          max_bank_ncp: 540,
          surplus_available_ncp: 100,
          surplus_eligible: true,
          is_unlimited: false
        },
        telemetry: {
          master_v5_percent: 80,
          cluster_state: 'surplus_active',
          next_percent_eta_ms: 1200000,
          is_hard_locked: false,
          subscription_active: true,
          last_fetched_at: Date.now()
        }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(storage.get('anlas_bypass_enabled'), false, 'Debt state must wipe stored bypass toggle');
    assert.strictEqual(bypassToggle.checked, false);
    assert.strictEqual(bypassToggle.disabled, true);
    assert.strictEqual(context.document.getElementById('gw-bypass-text').textContent, 'Anlas Paused');
    assert.match(context.document.getElementById('gw-anlas-label').textContent, /Anlas Overdrawn: -40 \(Paid Paused\)/);

    // Negative debt clamps /user/data native Anlas bar to 0
    const debtUserData = await (await vm.runInContext(`unsafeWindow.fetch('https://image.novelai.net/user/data')`, context)).json();
    assert.strictEqual(debtUserData.subscription.trainingStepsLeft.fixedTrainingStepsLeft, 0);

    // Debt also blocks /ai/upscale locally (403 DEBT_LOCKED)
    networkCalls.length = 0;
    context._debtPng = createPngHeaderBlob(1024, 1024);
    const blockedUpscale = await vm.runInContext(`
      (() => {
        const fd = new FormData();
        fd.append('image', globalThis._debtPng, 'blob');
        fd.append('request', new Blob(['{"image":"image"}'], { type: 'application/json' }));
        return unsafeWindow.fetch('https://image.novelai.net/ai/upscale', { method: 'POST', body: fd });
      })()
    `, context);
    assert.strictEqual(blockedUpscale.status, 403);
    assert.strictEqual((await blockedUpscale.json()).error, 'DEBT_LOCKED');
    assert.strictEqual(networkCalls.length, 0);

    // Open settings modal and reconcile debt -> restores normal hint & HUD sync
    context.document.getElementById('gw-nav-badge').onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 100, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 80, cluster_state: 'surplus_active', next_percent_eta_ms: 1200000, is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    const modalBypass = context.document.getElementById('settings-anlas-bypass');
    const modalStatusEl = context.document.getElementById('settings-bypass-status');
    assert.strictEqual(modalBypass.disabled, false);
    assert.doesNotMatch(modalStatusEl.textContent, /Paid Features Paused/);

    modalBypass.checked = true;
    modalBypass.onchange();
    assert.match(
      context.document.getElementById('gw-v5-label').textContent,
      /10 High \/ 18 Med/,
      'Modal bypass toggle must preserve V5/telemetry state in HUD'
    );
    assert.strictEqual(bypassToggle.checked, true, 'Modal bypass toggle must sync HUD checkbox');

    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: -40, available_balance: -40, monthly_quota: 500, is_unlimited: false, is_in_debt: true },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 100, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 80, cluster_state: 'surplus_active', next_percent_eta_ms: 1200000, is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(modalBypass.disabled, true);
    assert.strictEqual(modalBypass.checked, false);

    networkCalls.length = 0;
    const paidBlocked = await vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 }
        })
      })
    `, context);
    assert.strictEqual(paidBlocked.status, 403);
    assert.strictEqual((await paidBlocked.json()).error, 'DEBT_LOCKED');
    assert.strictEqual(networkCalls.length, 0);

    // Free Opus/V5 generation (1024x1024, 23 steps, 1 sample) succeeds (200) even while in debt
    const freePromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({
          model: 'nai-diffusion-5-full',
          parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 }
        })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1);
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    const freeResp = await freePromise;
    assert.strictEqual(freeResp.status, 200);
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: V5 BATTERY LOCKOUT, TOKEN EXPIRED DISPLAY/RECOVERY & SERVER ERRORS
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Enforces 5.5% V5 Recharging lockout, lets token_expired reach server immediately, and propagates errors', async () => {
    const { context, storage, networkCalls, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_lock10',
      browser_id: 'b_lock10',
      anlas_bypass_enabled: false
    }, guestCode);

    context.document.body.innerHTML = `
      <div class="image-gen-model-mode-row">
        <div><span>Model</span><div class="css-icpgrc"><div id="native-model-val" class="css-19vwdf1-singleValue">V5 Full</div><input aria-label="Select the Model" value="" /></div></div>
        <div><span>Effort</span><div><button id="native-med-btn" style="background-color: rgba(0, 0, 0, 0);">Medium</button><button id="native-high-btn" style="background-color: rgb(25, 90, 95);">High</button></div></div>
      </div>
      <div class="image-gen-footer">
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));

    // Master Token Expired status surfaces explicitly without locking Generate shield
    // AND does NOT falsely block V5 locally as V5_BATTERY_CRITICAL (allows immediate post-push recovery!)
    networkCalls[0].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: null, master_token_expired: true, cluster_state: 'token_expired', is_hard_locked: true, subscription_active: false, last_fetched_at: 0 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(context.document.getElementById('gw-v5-label').textContent, /Master Token Expired/);
    assert.match(context.document.getElementById('gw-v5-eta').textContent, /Session Expired/);
    assert.strictEqual(context.document.getElementById('gw-button-shield').style.display, 'none', 'Token expired must not lock Generate button behind client shield');

    networkCalls.length = 0;
    const immediateRecoveryPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1, 'master_token_expired must not block V5 locally so guests recover immediately upon admin token push');
    assert.strictEqual(networkCalls[0].url, 'https://vps.example.duckdns.org/queue/join');
    // Simulate server still expired -> returns 503 MASTER_TOKEN_EXPIRED and refreshes HUD
    networkCalls[0].onload({
      status: 503,
      responseText: JSON.stringify({
        statusCode: 503,
        error: 'MASTER_TOKEN_EXPIRED',
        message: 'Master NovelAI session token was rejected upstream (401).'
      })
    });
    const expiredJoinResp = await immediateRecoveryPromise;
    assert.strictEqual(expiredJoinResp.status, 503);
    assert.strictEqual((await expiredJoinResp.json()).error, 'MASTER_TOKEN_EXPIRED');
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /session token was rejected/);

    // Switch to 5.0% V5 Recharging circuit breaker
    networkCalls.length = 0;
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 5.0, cluster_state: 'frozen', is_hard_locked: true, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(context.document.getElementById('gw-button-shield').style.display, 'flex');
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'V5 Recharging');

    // Toggling #gw-bypass-toggle ON directly while sitting on V5 Recharging shield MUST clear shield immediately
    const bypassToggle = context.document.getElementById('gw-bypass-toggle');
    bypassToggle.checked = true;
    bypassToggle.onchange();
    assert.strictEqual(
      context.document.getElementById('gw-button-shield').style.display,
      'none',
      'Arming Use Anlas while V5 Recharging shield is shown must unlock Generate button immediately'
    );

    // Toggling back OFF must restore V5 Recharging shield immediately
    bypassToggle.checked = false;
    bypassToggle.onchange();
    assert.strictEqual(context.document.getElementById('gw-button-shield').style.display, 'flex');
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'V5 Recharging');

    // Test V5 Allowance Reached switching native Effort from High (18 pts) to Medium (10 pts) with 12 pts available
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 12, available_ncp: 12, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 40.0, cluster_state: 'reserve_mode', is_hard_locked: false, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'V5 Allowance Reached');

    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(
      context.document.getElementById('gw-button-shield').style.display,
      'none',
      'Switching native Effort from High (18 pts) to Medium (10 pts) with 12 pts available must clear V5 Allowance Reached shield'
    );

    // Restore 5.0% circuit breaker lock on High for free-V5 vs upscale/legacy verification
    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    triggerObserverSync();
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[networkCalls.length - 1].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Normal',
        anlas: { virtual_balance: 500, available_balance: 500, monthly_quota: 500, is_unlimited: false, is_in_debt: false },
        v5: { banked_ncp: 180, available_ncp: 180, max_bank_ncp: 540, surplus_available_ncp: 0, surplus_eligible: true, is_unlimited: false },
        telemetry: { master_v5_percent: 5.0, cluster_state: 'frozen', is_hard_locked: true, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));

    // Free V5 blocked locally (503)
    networkCalls.length = 0;
    const lockedV5Resp = await vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1 } })
      })
    `, context);
    assert.strictEqual(lockedV5Resp.status, 503);
    assert.strictEqual((await lockedV5Resp.json()).error, 'V5_BATTERY_CRITICAL');
    assert.strictEqual(networkCalls.length, 0);

    // /ai/upscale passes through untouched even during 5.0% V5 battery circuit breaker
    context._upscaleWhileBreakerPng = createPngHeaderBlob(1024, 1024);
    const upscaleDuringBreakerPromise = vm.runInContext(`
      (() => {
        const fd = new FormData();
        fd.append('image', globalThis._upscaleWhileBreakerPng, 'blob');
        fd.append('request', new Blob(['{"image":"image","model":"nai-diffusion-5-curated"}'], { type: 'application/json' }));
        return unsafeWindow.fetch('https://image.novelai.net/ai/upscale', { method: 'POST', body: fd });
      })()
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1);
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: image/png'
    });
    assert.strictEqual((await upscaleDuringBreakerPromise).status, 200);

    // Legacy V4.5 passes untouched during V5 circuit breaker
    networkCalls.length = 0;
    const legacyPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(networkCalls.length, 1);
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onloadstart({
      status: 200,
      response: new ReadableStream({ start(c) { c.close(); } }),
      responseHeaders: 'HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack'
    });
    assert.strictEqual((await legacyPromise).status, 200);

    // Simulate ALLOWANCE_EXHAUSTED on /queue/join -> surfaces #gw-hud-alert consistently
    networkCalls.length = 0;
    const exhaustedPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({
      status: 403,
      responseText: JSON.stringify({ error: 'ALLOWANCE_EXHAUSTED' })
    });
    const exhaustedResp = await exhaustedPromise;
    assert.strictEqual(exhaustedResp.status, 403);
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'block');
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /Allowance Exhausted/i);

    // Simulate server returning 429 V5_CAPACITY_DEPLETED on /queue/join -> propagates & refreshes telemetry
    bypassToggle.checked = true;
    bypassToggle.onchange();
    networkCalls.length = 0;
    const staleJoinPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-5-full', parameters: { width: 1536, height: 2048, steps: 28, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({
      status: 429,
      responseText: JSON.stringify({ statusCode: 429, error: 'V5_CAPACITY_DEPLETED', message: 'Insufficient V5 compute capacity.' })
    });
    const propagated = await staleJoinPromise;
    assert.strictEqual(propagated.status, 429, 'Must propagate 429 from /queue/join rather than masking as 502');
    const propJson = await propagated.json();
    assert.strictEqual(propJson.error, 'V5_CAPACITY_DEPLETED');
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')), '429 rejection must trigger telemetry refresh');

    // Simulate /proxy/image/* returning 503 MASTER_SUBSCRIPTION_INACTIVE -> surfaces HUD alert & triggers telemetry refresh
    networkCalls.length = 0;
    const subInactivePromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onload({
      status: 503,
      readyState: 4,
      responseHeaders: 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json',
      responseText: JSON.stringify({
        statusCode: 503,
        error: 'MASTER_SUBSCRIPTION_INACTIVE',
        message: 'Master NovelAI Opus subscription is inactive or expired.'
      })
    });
    const subInactiveResp = await subInactivePromise;
    assert.strictEqual(subInactiveResp.status, 503);
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /Opus subscription is inactive/);
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')), '503 subscription inactive must trigger telemetry refresh');

    // /proxy/image/* returning 503 MASTER_TOKEN_EXPIRED surfaces HUD alert and does NOT wipe approved
    networkCalls.length = 0;
    const proxyFailPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, context);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    networkCalls[2].onload({
      status: 503,
      readyState: 4,
      responseHeaders: 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json',
      responseText: JSON.stringify({
        statusCode: 503,
        error: 'MASTER_TOKEN_EXPIRED',
        message: 'Master NovelAI session token was rejected upstream (401).'
      })
    });
    const proxyFailResp = await proxyFailPromise;
    assert.strictEqual(proxyFailResp.status, 503);
    assert.strictEqual(storage.get('approved'), true, 'Upstream 503 MASTER_TOKEN_EXPIRED must NOT wipe guest approved flag');
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /session token was rejected/);
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')));
  });

  // ---------------------------------------------------------------------------
  // 7. ADMIN DUAL-LEDGER GOVERNANCE, XSS ESCAPING, CYCLE FILTER, COPY CHIPS, UNLINKED `user_id` & OPERATOR SETTINGS
  // ---------------------------------------------------------------------------
  await t.test('Admin Governance: Escapes XSS payloads, populates cycle selector, copies full browser IDs, handles sort/token-push refresh, omits Rolling Allowance & validates strict deltas', async () => {
    const fullDebtorBid = 'b_debtor_dev_00112233445566778899aa';
    const fullAdminLinkedBid = 'b_admin_link_99887766554433221100ff';

    const { context, networkCalls, promptQueue, alertLog, copiedTexts, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      admin_token: 'adm_sec_10',
      browser_id: 'b_admin_10'
    }, adminCode);

    context.document.body.innerHTML = `
      <div class="image-gen-nav-row"><button aria-label="menu"></button></div>
      <div class="image-gen-footer">
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;

    vm.runInContext(adminCode, context);
    triggerObserverSync();

    // Verify Admin HUD displays V5 Recharging when isHardLocked is true (<= 5.5%)
    triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    networkCalls[0].onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Admin',
        anlas: { is_unlimited: true, is_in_debt: false },
        v5: { is_unlimited: true, surplus_available_ncp: 0, surplus_eligible: true },
        telemetry: { master_v5_percent: 4.8, cluster_state: 'frozen', is_hard_locked: true, subscription_active: true, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(context.document.getElementById('gw-v5-label').textContent, /V5 Recharging/);

    networkCalls.length = 0;
    const xssPayloadName = '<img src=x onerror=alert(1)>';
    const mockDeviceGroups = [
      {
        user_id: 'discord_debtor',
        discord_id: 'discord_debtor',
        discord_username: xssPayloadName,
        priority_tier: 'Normal',
        approved: 1,
        banned: 0,
        anlas_consumed: 200,
        virtual_anlas_balance: -50,
        available_anlas_balance: -50,
        is_in_debt: true,
        anlas_unlimited: false,
        v5_banked_balance: 90,
        v5_available_balance: 90,
        subscription_period_anlas: 90,
        subscription_period_v5: 4,
        subscription_period_legacy_images: 1,
        subscription_period_upscales: 0,
        subscription_period_text_gens: 0,
        subscription_period_requests: 5,
        total_requests: 12,
        last_active_at: Date.now(),
        is_online: true,
        devices: [{
          browser_id: fullDebtorBid,
          label: '<svg onload=alert(2)>Laptop',
          approved: 1,
          banned: 0,
          anlas_consumed: 200,
          total_requests: 12,
          last_active_at: Date.now(),
          is_online: true,
          metered_allowance: null,
          debug_intent: false,
          debug_authorized: false,
          debug_expires_in_ms: 0
        }]
      },
      {
        user_id: 'b_pruned_orphan',
        discord_id: null,
        discord_username: 'Unlinked Device',
        priority_tier: 'Low',
        approved: 0,
        banned: 0,
        anlas_consumed: 10,
        virtual_anlas_balance: 190,
        available_anlas_balance: 190,
        is_in_debt: false,
        anlas_unlimited: false,
        v5_banked_balance: 50,
        v5_available_balance: 50,
        subscription_period_anlas: 10,
        subscription_period_v5: 1,
        subscription_period_requests: 1,
        total_requests: 2,
        last_active_at: Date.now() - 1000,
        is_online: false,
        devices: [{
          browser_id: 'b_pruned_orphan',
          label: '<img src=x onerror=alert(9)>PendingDev',
          approved: 0,
          banned: 0,
          total_requests: 2,
          last_active_at: Date.now() - 1000,
          is_online: false,
          metered_allowance: null,
          debug_intent: false,
          debug_authorized: false,
          debug_expires_in_ms: 0
        }]
      },
      {
        user_id: 'u_ban_ui',
        discord_id: 'u_ban_ui',
        discord_username: 'BannedUser',
        priority_tier: 'Normal',
        approved: 0,
        banned: 1,
        anlas_consumed: 0,
        virtual_anlas_balance: 0,
        available_anlas_balance: 0,
        is_in_debt: false,
        anlas_unlimited: false,
        v5_banked_balance: 0,
        v5_available_balance: 0,
        subscription_period_anlas: 0,
        subscription_period_v5: 0,
        subscription_period_requests: 0,
        total_requests: 0,
        last_active_at: 0,
        is_online: false,
        devices: [{
          browser_id: 'b_ban_ui',
          label: 'BanDev',
          approved: 0,
          banned: 1,
          total_requests: 0,
          last_active_at: 0,
          is_online: false,
          metered_allowance: null,
          debug_intent: false,
          debug_authorized: false,
          debug_expires_in_ms: 0
        }]
      }
    ];

    context.document.getElementById('gw-nav-badge').onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));

    // Cycles dropdown populates from /admin/cycles
    const cyclesCall1 = networkCalls.find(c => c.url.includes('/admin/cycles'));
    assert.ok(cyclesCall1, 'Governance panel must fetch /admin/cycles');
    cyclesCall1.onload({
      status: 200,
      responseText: JSON.stringify({
        active_cycle_epoch: 1762000000000,
        cycles: [
          { cycle_epoch: 1762000000000, is_active: true },
          { cycle_epoch: 1759400000000, is_active: false }
        ]
      })
    });

    const devCall1 = networkCalls.find(c => c.url.includes('/admin/devices'));
    assert.ok(devCall1);
    devCall1.onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    // Stored XSS payload must be escaped cleanly (zero live <img> elements and escaped HTML entities)
    const clientListEl = context.document.getElementById('vps-client-list');
    assert.strictEqual(clientListEl.querySelectorAll('img').length, 0, 'XSS <img> node must never mount in DOM');
    assert.doesNotMatch(clientListEl.innerHTML, /<img\s/i, 'XSS <img> tag must be escaped');
    assert.match(clientListEl.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);

    // Verify governance panel renders 3 client cards (approved, unapproved, banned) with correct PENDING/BANNED badges
    const initialHeaders = clientListEl.querySelectorAll('.client-card-header');
    assert.strictEqual(initialHeaders.length, 3);
    assert.doesNotMatch(initialHeaders[0].innerHTML, /PENDING/, 'Approved account header must not display PENDING badge');
    assert.match(initialHeaders[1].innerHTML, /PENDING/, 'Unapproved account header must display PENDING badge');
    assert.doesNotMatch(initialHeaders[2].innerHTML, /PENDING/, 'Banned account header must not display PENDING badge');
    assert.match(initialHeaders[2].innerHTML, /BANNED/, 'Banned account header must display BANNED badge');

    // First global-stats response verifies [TOKEN EXPIRED]
    const statsCall1 = networkCalls.find(c => c.url.includes('/admin/global-stats'));
    assert.ok(statsCall1);
    statsCall1.onload({
      status: 200,
      responseText: JSON.stringify({
        v5_surplus_pool: 0,
        v5_surplus_available: 0,
        telemetry: { master_v5_percent: null, master_token_expired: true, subscription_active: false, is_grace_period: false, master_anlas: null, last_fetched_at: 0 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('admin-stat-battery').textContent, '[TOKEN EXPIRED]');

    // Sort trigger triggers a fresh governance render and a brand-new /admin/global-stats request
    networkCalls.length = 0;
    const sortReqs = context.document.querySelector('.sort-trigger[data-sort="reqs"]');
    assert.ok(sortReqs);
    sortReqs.onclick({ preventDefault: () => {}, currentTarget: sortReqs });
    await new Promise(r => setTimeout(r, 20));

    const cyclesCall2 = networkCalls.find(c => c.url.includes('/admin/cycles'));
    if (cyclesCall2) {
      cyclesCall2.onload({
        status: 200,
        responseText: JSON.stringify({
          active_cycle_epoch: 1762000000000,
          cycles: [
            { cycle_epoch: 1762000000000, is_active: true },
            { cycle_epoch: 1759400000000, is_active: false }
          ]
        })
      });
    }

    let currentDeviceCalls = networkCalls.filter(c => c.url.includes('/admin/devices'));
    currentDeviceCalls[currentDeviceCalls.length - 1].onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    // Fresh global-stats response verifies [INACTIVE]
    let currentStatsCalls = networkCalls.filter(c => c.url.includes('/admin/global-stats'));
    const statsCall2 = currentStatsCalls[currentStatsCalls.length - 1];
    assert.ok(statsCall2);
    statsCall2.onload({
      status: 200,
      responseText: JSON.stringify({
        v5_surplus_pool: 0,
        v5_surplus_available: 0,
        telemetry: { master_v5_percent: 0, master_token_expired: false, subscription_active: false, is_grace_period: false, master_anlas: 2995, last_fetched_at: Date.now() }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(context.document.getElementById('admin-stat-battery').textContent, /\[INACTIVE\]/);

    // Cycle selector triggers filtered /admin/devices?cycle_epoch=... & /admin/global-stats?cycle_epoch=...
    const cycleSelect = context.document.getElementById('admin-cycle-select');
    assert.ok(cycleSelect.querySelectorAll('option').length >= 3);
    networkCalls.length = 0;
    cycleSelect.value = '1759400000000';
    cycleSelect.onchange();
    await new Promise(r => setTimeout(r, 20));
    assert.ok(networkCalls.some(c => c.url.includes('/admin/devices?cycle_epoch=1759400000000')));
    networkCalls.filter(c => c.url.includes('/admin/devices')).pop().onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));
    assert.ok(networkCalls.some(c => c.url.includes('/admin/global-stats?cycle_epoch=1759400000000')));

    // Pushing fresh token via Save Token button triggers immediate HUD + modal refresh
    networkCalls.length = 0;
    context.document.getElementById('vps-master-token-input').value = 'fresh_master_jwt';
    context.document.getElementById('vps-btn-push-token').onclick();
    const updateTokCall = networkCalls.find(c => c.url.includes('/admin/update-token'));
    assert.ok(updateTokCall);
    updateTokCall.onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 20));
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')), 'Token push must refresh operator HUD immediately');
    assert.ok(networkCalls.some(c => c.url.includes('/admin/devices')), 'Token push must refresh governance view immediately');
    const refreshedDevCall = networkCalls.filter(c => c.url.includes('/admin/devices')).pop();
    refreshedDevCall.onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    // Expand both cards
    const headers = context.document.querySelectorAll('.client-card-header');
    headers[0].onclick({ currentTarget: headers[0] });
    await new Promise(r => setTimeout(r, 20));
    let deviceCalls = networkCalls.filter(c => c.url.includes('/admin/devices'));
    deviceCalls[deviceCalls.length - 1].onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(clientListEl.querySelectorAll('svg').length, 0, 'XSS <svg> node must never mount in DOM');
    assert.doesNotMatch(context.document.getElementById('vps-client-list').innerHTML, /<svg\s/i, 'XSS <svg> device label must be escaped');

    // Governance linked browser chip copies full browser_id on click
    const govChip = context.document.querySelector('#vps-client-list .gw-copy-chip');
    assert.ok(govChip);
    govChip.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(copiedTexts[0], fullDebtorBid, 'Governance browser chip must copy full browser_id');
    assert.strictEqual(govChip.textContent, 'b_debtor...');

    const headers2 = context.document.querySelectorAll('.client-card-header');
    headers2[1].onclick({ currentTarget: headers2[1] });
    await new Promise(r => setTimeout(r, 20));
    deviceCalls = networkCalls.filter(c => c.url.includes('/admin/devices'));
    deviceCalls[deviceCalls.length - 1].onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    const expandedListHtml = context.document.getElementById('vps-client-list').innerHTML;
    assert.match(expandedListHtml, /\(Pending\)/, 'Unapproved device row must display (Pending) badge');

    alertLog.length = 0;
    networkCalls.length = 0;
    const adjBtns = context.document.querySelectorAll('.btn-adjust-anlas');
    const forgiveBtn = context.document.querySelector('.btn-reconcile-debt');
    assert.strictEqual(adjBtns.length, 2, 'Both expanded cards must expose ADJUST ANLAS buttons');
    assert.ok(forgiveBtn, 'Indebted user card must expose FORGIVE DEBT button');

    for (const badDelta of ['12.5', '50abc']) {
      promptQueue.push(badDelta);
      adjBtns[0].onclick({ currentTarget: adjBtns[0] });
    }
    assert.strictEqual(
      networkCalls.some(c => c.url.includes('/admin/adjust-balance')),
      false,
      'Non-integer delta prompts must be rejected locally without mutating server balances'
    );
    assert.ok(alertLog.some(m => /Invalid integer delta/i.test(m)));

    promptQueue.push('100');
    adjBtns[0].onclick({ currentTarget: adjBtns[0] });
    const adjCallLinked = networkCalls.find(c => c.url.includes('/admin/adjust-balance'));
    assert.ok(adjCallLinked);
    assert.deepStrictEqual(JSON.parse(adjCallLinked.data), { discord_id: 'discord_debtor', anlas_delta: 100 });

    // Unlinked device-pruned principal must send { user_id: 'b_pruned_orphan' } rather than { browser_id: ... }
    promptQueue.push('25');
    adjBtns[1].onclick({ currentTarget: adjBtns[1] });
    const adjCalls = networkCalls.filter(c => c.url.includes('/admin/adjust-balance'));
    assert.deepStrictEqual(JSON.parse(adjCalls[1].data), { user_id: 'b_pruned_orphan', anlas_delta: 25 });

    // Verify Mock DOM <select> setter accurately updates selected <option> before approve
    const orphanSelect = context.document.getElementById('tier-select-b_pruned_orphan');
    assert.strictEqual(orphanSelect.value, 'Low');
    orphanSelect.value = 'High';
    assert.strictEqual(orphanSelect.value, 'High');

    // Unlinked approve/revoke/ban actions must also pass { user_id: 'b_pruned_orphan' }
    const approveBtns = context.document.querySelectorAll('.btn-approve-group');
    approveBtns[1].onclick({ currentTarget: approveBtns[1] });
    const appCall = networkCalls.find(c => c.url.includes('/admin/approve'));
    assert.deepStrictEqual(JSON.parse(appCall.data), { user_id: 'b_pruned_orphan', priority_tier: 'High' });

    const revokeBtns = context.document.querySelectorAll('.btn-revoke-group');
    revokeBtns[1].onclick({ currentTarget: revokeBtns[1] });
    const revCall = networkCalls.find(c => c.url.includes('/admin/revoke'));
    assert.deepStrictEqual(JSON.parse(revCall.data), { user_id: 'b_pruned_orphan' });

    const banBtns = context.document.querySelectorAll('.btn-ban-group');
    promptQueue.push('Abuse');
    banBtns[1].onclick({ currentTarget: banBtns[1] });
    const banCall = networkCalls.find(c => c.url.includes('/admin/ban'));
    assert.deepStrictEqual(JSON.parse(banCall.data), { user_id: 'b_pruned_orphan', reason: 'Abuse' });

    forgiveBtn.onclick({ currentTarget: forgiveBtn });
    const recCall = networkCalls.find(c => c.url.includes('/admin/reconcile-debt'));
    assert.ok(recCall);
    assert.deepStrictEqual(JSON.parse(recCall.data), { discord_id: 'discord_debtor' });

    // Operator Settings tab: omits Rolling Allowance completely, copies linked browser IDs, and displays cycle-segregated usage without backticks
    networkCalls.length = 0;
    context.document.getElementById('admin-tab-settings').onclick();
    await new Promise(r => setTimeout(r, 20));
    const opStatusCall = networkCalls.find(c => c.url.includes('/auth/status'));
    assert.ok(opStatusCall);
    opStatusCall.onload({
      status: 200,
      responseText: JSON.stringify({
        approved: true,
        tier: 'Admin',
        anlas_consumed: 240,
        precise_limit: 'Unlimited',
        linked_devices: [{ id: fullAdminLinkedBid, label: 'Workstation' }],
        anlas: { is_unlimited: true, is_in_debt: false },
        v5: { is_unlimited: true, surplus_available_ncp: 320, surplus_eligible: true },
        telemetry: { master_v5_percent: 72.0, cluster_state: 'surplus_active', subscription_active: true, last_fetched_at: Date.now() },
        subscription_period: { anlas_consumed: 65, v5_consumed: 9, legacy_image_gens: 2, upscale_gens: 1, text_gens: 4 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    const adminPanelHtml = context.document.getElementById('vps-admin-panel').innerHTML;
    assert.doesNotMatch(adminPanelHtml, /Rolling Allowance/i, 'Admin Operator Settings must omit Rolling Allowance row');
    assert.doesNotMatch(adminPanelHtml, /`/, 'Admin Operator Settings must contain zero literal Markdown backticks');
    assert.strictEqual(context.document.getElementById('operator-period-usage').textContent, '65 Anlas · 12 images · 4 text');
    assert.strictEqual(context.document.getElementById('operator-anlas-consumed').textContent, '240 Anlas');

    const opChip = context.document.querySelector('#operator-linked-devices .gw-copy-chip');
    assert.ok(opChip);
    opChip.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(copiedTexts[1], fullAdminLinkedBid, 'Operator linked browser chip must copy full browser_id');
    assert.strictEqual(opChip.textContent, 'b_admin_li...');
  });

  // ---------------------------------------------------------------------------
  // 8. HELL PATH: CLIENT HTTP 426 SCRIPT_UPDATE_REQUIRED PROPAGATION & UI ALERTING
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Propagates HTTP 426 SCRIPT_UPDATE_REQUIRED across /queue/join, /proxy, /auth/status & Admin UI without wiping approval', async () => {
    const guestBox = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_426_guest',
      browser_id: 'b_426_guest'
    }, guestCode);

    guestBox.context.document.body.innerHTML = `
      <div class="image-gen-footer">
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;

    vm.runInContext(guestCode, guestBox.context);
    guestBox.triggerObserverSync();

    // 1. /queue/join returning 426 must resolve 426 (never 502), alert HUD, and keep approved: true
    const join426Promise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, guestBox.context);
    await new Promise(r => setTimeout(r, 20));
    guestBox.networkCalls[0].onload({
      status: 426,
      responseText: JSON.stringify({
        statusCode: 426,
        error: 'SCRIPT_UPDATE_REQUIRED',
        message: 'Your GuildWeave Tampermonkey userscript (v5.0.0) is outdated (minimum required: v6.0.0).'
      })
    });
    const join426Resp = await join426Promise;
    assert.strictEqual(join426Resp.status, 426, 'Must propagate 426 from /queue/join rather than throwing 502');
    const join426Body = await join426Resp.json();
    assert.strictEqual(join426Body.error, 'SCRIPT_UPDATE_REQUIRED');
    assert.strictEqual(guestBox.storage.get('approved'), true);
    assert.strictEqual(guestBox.context.document.getElementById('gw-hud-alert').style.display, 'block');
    assert.match(guestBox.context.document.getElementById('gw-hud-alert').textContent, /outdated \(minimum required: v6\.0\.0\)/);

    // 2. /proxy/image/* returning 426 must propagate 426, alert HUD, and keep approved: true
    guestBox.networkCalls.length = 0;
    const proxy426Promise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } })
      })
    `, guestBox.context);
    await new Promise(r => setTimeout(r, 20));
    guestBox.networkCalls[0].onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 1050));
    guestBox.networkCalls[1].onload({ status: 200, responseText: '{"status":"your_turn"}' });
    await new Promise(r => setTimeout(r, 20));
    guestBox.networkCalls[2].onload({
      status: 426,
      readyState: 4,
      responseHeaders: 'HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json',
      responseText: JSON.stringify({
        statusCode: 426,
        error: 'SCRIPT_UPDATE_REQUIRED',
        message: 'Please update GuildWeave script to v6.0.0.'
      })
    });
    const proxy426Resp = await proxy426Promise;
    assert.strictEqual(proxy426Resp.status, 426);
    assert.strictEqual(guestBox.storage.get('approved'), true);
    assert.match(guestBox.context.document.getElementById('gw-hud-alert').textContent, /Please update GuildWeave script to v6\.0\.0/);

    // 3. Guest /auth/status poll returning 426 surfaces #gw-hud-alert immediately
    guestBox.networkCalls.length = 0;
    guestBox.triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    guestBox.networkCalls[0].onload({
      status: 426,
      responseText: JSON.stringify({
        statusCode: 426,
        error: 'SCRIPT_UPDATE_REQUIRED',
        message: 'Update required from status poll.'
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(guestBox.context.document.getElementById('gw-hud-alert').textContent, /Update required from status poll/);

    // 4. Admin /auth/status poll & /admin/devices returning 426 surface HUD alert & #vps-client-list update notice
    const adminBox = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      admin_token: 'adm_sec_426',
      browser_id: 'b_426_admin'
    }, adminCode);
    adminBox.context.document.body.innerHTML = `
      <div class="image-gen-nav-row"><button aria-label="menu"></button></div>
      <div class="image-gen-footer">
        <button class="image-gen-generate-button"><span>Generate 1 Image</span></button>
      </div>
    `;
    vm.runInContext(adminCode, adminBox.context);
    adminBox.triggerObserverSync();

    adminBox.triggerIntervalAtMs(10000);
    await new Promise(r => setTimeout(r, 20));
    adminBox.networkCalls[0].onload({
      status: 426,
      responseText: JSON.stringify({
        statusCode: 426,
        error: 'SCRIPT_UPDATE_REQUIRED',
        message: 'Admin script outdated (min v6.0.0).'
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(adminBox.context.document.getElementById('gw-hud-alert').textContent, /Admin script outdated/);

    adminBox.networkCalls.length = 0;
    adminBox.context.document.getElementById('gw-nav-badge').onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));
    const admDevCall = adminBox.networkCalls.find(c => c.url.includes('/admin/devices'));
    assert.ok(admDevCall);
    admDevCall.onload({
      status: 426,
      responseText: JSON.stringify({
        statusCode: 426,
        error: 'SCRIPT_UPDATE_REQUIRED',
        message: 'Update Admin panel to v6.0.0.'
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.match(adminBox.context.document.getElementById('vps-client-list').textContent, /Update Admin panel to v6\.0\.0/);
  });
});