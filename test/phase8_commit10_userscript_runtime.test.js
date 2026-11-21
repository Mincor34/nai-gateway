/**
 * PHASE 8 COMMIT 10 VERIFICATION HARNESS (test/phase8_commit10_userscript_runtime.test.js)
 *
 * Exhaustively tests the compiled UserScript distribution bundles (`UserScripts/nai-admin.user.js`
 * and `UserScripts/nai-guest.user.js`) inside an isolated pure-browser VM sandbox:
 * 1. Full Bundle Contract:
 *    - Compiles bundles via `scripts/build-userscripts.js`.
 *    - Asserts zero `require(`, `process`, or `Buffer` references or leaks in compiled artifacts.
 *    - Verifies Tampermonkey metadata blocks, IIFE boundaries, and zero Node globals inside VM.
 * 2. Pricing & Stage 5 Parity (Module 643656 & Module 875333):
 *    - Verifies client-side `pricing.js` matches `auditEngine.js` across baseline Opus, multi-sample,
 *      V5 Full `1.5x` (`1536x2048` -> `90` Anlas, `1024x1024 @ 29` -> `32`, `1472x1472 @ 28` -> `63`),
 *      V5 Medium un-ceiled `/ 1.75` + `1.5x` (`1024x1024, 2 samples` -> `15`, `4 samples` -> `45`,
 *      `1472x1472, 1 sample` -> `31`, `1536x2048, 1 sample` -> `44`), `usageNegative` V5 discount
 *      suppression (`30` / `52`), SMEA/SMEA-DYN, Img2Img/Inpaint strength, Character Refs
 *      (`director_reference_images*`), V4.5 Vibe Transfer (`reference_image_multiple`),
 *      `>140` Anlas cap, `strength: 0` 3MP/50-step hard limits, and `.5` non-V5 parity (`3-5`, `1-5`).
 *    - Verifies Stage 5 `X-Gen-Steps` invariant: exact body integer forwarded (`25` stays `25`;
 *      absent steps default to `14` on Medium and `28` otherwise) while pricing V5 Medium via Module 643656.
 *    - Verifies `params.js` matches `auditEngine.extractParametersFromRawBody` 1-to-1, routing
 *      `reference_image_multiple` into `vibe_reference_count` and counting strictly Character References
 *      in `precise_refs` so `X-Precise-Refs` never diverges from Stage 5.
 * 3. Happy Path: Dual Meters, Cluster States, Native Selection Cost Display, Canary Scraper,
 *    /user/subscription GET Routing, /ai/encode-vibe Counter Isolation & Bypass Headers:
 *    - Polls `/auth/status` with full Commit 9 payload and verifies `#gw-v5-bar` mounts above
 *      `#gw-allowance-bar` while preserving `allowanceBar.nextElementSibling === genBtn`.
 *    - Verifies `#gw-effort-select` is absent (relies strictly on NovelAI's native `.image-gen-model-mode-row`).
 *    - Verifies `/user/subscription` without explicit `config.method` defaults to `GET`, leaves
 *      `count_text_gens` untouched, and suppresses unprompted `/auth/status` polling.
 *    - Verifies `/ai/encode-vibe` uses `POST`, leaves `count_text_gens` at 0, and triggers HUD telemetry refresh.
 *    - Verifies nested sample-count spans (`<span>Generate <span>1</span> Image</span>`) never hijack
 *      `X-Scraped-Anlas` or trigger false canary drift warnings when cost is `90` (`90 Anlas`).
 *    - Verifies V4.5 pre-encoded Vibe Transfer (`reference_image_multiple` 2 vibes) declares 0 Anlas and 0 refs.
 *    - Verifies `master_v5_is_negative: true` propagates into `X-Declared-Anlas: 30` on `1024x1024, 2 samples` Medium.
 *    - Verifies live countdown ETA (`+1% in Xm`), cluster state colors, personal NCP (`180/540 NCP`),
 *      surplus pool, zero-rollover Anlas display, native NCP cost badge, and Guest Settings modal fields.
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
 *      (`Cost: 10 NCP (Med)`, `Cost: 18 NCP (High)`, `Legacy (0 NCP)`), updates step slider max bounds
 *      (`23` vs `28`), clears deadband alerts, and never misclassifies `3.5` / `1.5` / `V50` as V5.
 *    - `FormData` with a `Blob` `request` part passes through untouched with matching `X-Gen-Model: V5-medium`.
 *    - High-res / >28 steps with bypass DISARMED is blocked client-side (`400`) with zero network calls.
 *    - Free-tier parameters (`1024x1024, 1 sample, 23 steps`) even with bypass toggle armed still
 *      transmit `X-Base-Paid: false` (no forged exemption on free geometry).
 * 5. Hell Path: Debt State UI Lockout & Ephemeral Telemetry Isolation:
 *    - Feeds `/auth/status` with negative Anlas balance (`virtual_balance: -40`, `is_in_debt: true`).
 *    - Asserts bypass toggle is forced unchecked & disabled in both HUD and settings modal,
 *      and HUD displays `Anlas Balance: -40 (Bypass Locked)`.
 *    - Asserts stale `gw_policy_state` in `GM_setValue` cannot poison a fresh page boot into locking out
 *      generations before `/auth/status` polls.
 *    - Asserts toggling `#settings-anlas-bypass` preserves `v5` and `telemetry` HUD fields,
 *      and clearing debt restores normal modal bypass hint text.
 *    - Asserts Anlas-consuming bypass request is blocked (`403`) with zero network calls while
 *      free Opus/V5 generation (`1024x1024, 23 steps, 1 sample`) succeeds.
 * 6. Hell Path: V5 Capacity Depletion, 5.5% Circuit Breaker, Token-Expired Immediate Recovery, Native Effort Shield Sync & Server Error HUD Propagation:
 *    - Feeds `/auth/status` with `is_hard_locked: true` or depleted NCP; asserts HUD locks V5
 *      (`Battery Recharging` / `V5 Quota Depleted`) immediately across both Guest and Admin.
 *    - Feeds `/auth/status` with `master_token_expired: true` AND `is_hard_locked: true`; asserts HUD
 *      displays `Master Token Expired (Awaiting Admin)` without locking Generate button AND does NOT
 *      falsely reject V5 clicks locally as `V5_BATTERY_CRITICAL` ("Battery Recharging"), allowing
 *      immediate post-token-push recovery or propagating `503 MASTER_TOKEN_EXPIRED` from server.
 *    - Toggling `#gw-bypass-toggle` or switching native Effort from `High` (`18 NCP`) to `Medium`
 *      (`10 NCP`) with `12 NCP` banked clears `#gw-button-shield` immediately without requiring a fetch.
 *    - Allows legacy V4.5 while blocking free V5 during battery recharging.
 *    - Simulates `/queue/join` returning `403 ALLOWANCE_EXHAUSTED` and `429 V5_CAPACITY_DEPLETED`, plus
 *      `/proxy/image/*` returning `503 MASTER_SUBSCRIPTION_INACTIVE` and `503 MASTER_TOKEN_EXPIRED`;
 *      asserts exact status, `#gw-hud-alert` update, and telemetry refresh.
 * 7. Happy Path & Hell Path: Admin Governance Dual-Ledger Controls, Unlinked `user_id` Actions, Post-Push Refresh, Operator Cycle Telemetry & Strict Prompt Validation:
 *    - Verifies Admin panel renders dual-ledger fields, `[TOKEN EXPIRED]` / `[INACTIVE]` subscription alerts,
 *      Operator Settings `Cycle Consumed` (`#operator-period-usage`), sends `{ user_id: ... }` for unlinked principals
 *      across approve/revoke/ban/unban, verifies `<select>` setter syncs `<option>` selections, rejects
 *      malformed deltas (`"12.5"`, `"50abc"`) without dispatching requests, and dispatches
 *      `POST /admin/adjust-balance` and `POST /admin/reconcile-debt`.
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

function createBrowserSandbox(initialStorage = {}, scriptSource = null) {
  const storage = new Map(Object.entries(initialStorage));
  const networkCalls = [];
  const intervals = [];
  const elements = new Map();
  const observerCallbacks = [];
  const promptQueue = [];
  const confirmQueue = [];
  const alertLog = [];

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

    // Check attributes first if present: e.g. [data-sort="reqs"] or .sort-trigger[data-sort="reqs"]
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

    // Strip bracketed attribute selectors to evaluate base tag/id/class prefix
    const baseSelector = trimmed.replace(attrRegex, '').trim();
    if (!baseSelector) {
      return hasAttrCheck;
    }

    if (baseSelector.startsWith('#')) {
      return el.id === baseSelector.slice(1);
    }
    if (baseSelector.startsWith('.')) {
      const cls = baseSelector.slice(1);
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      return classes.includes(cls);
    }
    if (baseSelector.includes('.')) {
      const parts = baseSelector.split('.');
      const tag = parts[0];
      const cls = parts[1];
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      return classes.includes(cls);
    }
    return el.tagName.toLowerCase() === baseSelector.toLowerCase();
  }

  function findSelector(root, sel, singleOnly, results = []) {
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
      return singleOnly ? (currentSet[0] || null) : currentSet;
    }

    for (const child of root.children) {
      if (matchesSelector(child, sel)) {
        if (singleOnly) return child;
        results.push(child);
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
    const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);

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
        currentParent._rawText += token;
      }
    }
  }

  function createMockElement(tagName = 'div') {
    let _id = '';
    let _innerHTML = '';
    let _children = [];
    let _value = '';
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
      parentElement: null,
      _rawText: '',

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
        if (_children.length > 0) {
          let out = el._rawText || '';
          for (const ch of _children) {
            out += ch.textContent;
          }
          return out || _innerHTML.replace(/<[^>]*>?/gm, '');
        }
        return el._rawText || _innerHTML.replace(/<[^>]*>?/gm, '');
      },
      set textContent(val) {
        _innerHTML = String(val || '');
        el._rawText = _innerHTML;
        for (const c of [..._children]) c.remove();
        _children = [];
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

      closest(sel) {
        let cur = el;
        while (cur) {
          if (sel === '[id^="gw-"]' && cur.id && cur.id.startsWith('gw-')) return cur;
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },

      appendChild(child) {
        _children.push(child);
        child.parentElement = el;
        notifyMutation(el, 'childList', [child], []);
        return child;
      },

      insertBefore(newChild, refChild) {
        const idx = _children.indexOf(refChild);
        if (idx === -1) _children.push(newChild);
        else _children.splice(idx, 0, newChild);
        newChild.parentElement = el;
        notifyMutation(el, 'childList', [newChild], []);
        return newChild;
      },

      remove() {
        if (_id && elements.get(_id) === el) elements.delete(_id);
        if (el.parentElement) {
          const idx = el.parentElement.children.indexOf(el);
          if (idx !== -1) el.parentElement.children.splice(idx, 1);
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

      get innerHTML() { return _innerHTML; },
      set innerHTML(html) {
        _innerHTML = String(html || '');
        el._rawText = '';
        for (const c of [..._children]) c.remove();
        _children = [];
        parseHTMLIntoChildren(el, _innerHTML);
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

  const documentMock = {
    body: createMockElement('body'),
    documentElement: createMockElement('html'),
    createElement: (tag) => createMockElement(tag),
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
    }
  };
  documentMock.documentElement.appendChild(documentMock.body);

  let originalPageFetch = async () => new Response('{}', { status: 200 });
  const unsafeWindowMock = {
    get fetch() { return originalPageFetch; },
    set fetch(fn) { originalPageFetch = fn; }
  };

  const windowMock = {
    document: documentMock,
    unsafeWindow: unsafeWindowMock,
    sessionStorage: {
      data: new Map(),
      getItem(k) { return this.data.get(k) || null; },
      setItem(k, v) { this.data.set(k, String(v)); }
    },
    location: { reloaded: false, reload() { this.reloaded = true; } },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: (el) => ({
      backgroundColor: (el && el.style && el.style.backgroundColor) ? el.style.backgroundColor : 'rgba(0, 0, 0, 0)'
    })
  };

  const cryptoMock = {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomValues: (arr) => nodeCrypto.getRandomValues(arr)
  };
  windowMock.crypto = cryptoMock;

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
    triggerIntervalAtMs: (ms) => {
      for (const entry of intervals) {
        if (entry.ms === ms) entry.fn();
      }
    },
    triggerObserverSync: () => {
      for (const cb of observerCallbacks) {
        cb([{ target: documentMock.body, type: 'childList', addedNodes: [documentMock.body], removedNodes: [] }]);
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
  await t.test('Pricing Parity: Client pricing.js and params.js match auditEngine.js (Module 643656 & Vibe Segregation)', async () => {
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
  // 3. HAPPY PATH: DUAL METERS, /user/subscription GET, ENCODE-VIBE ISOLATION, CANARY & HEADERS
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: Renders dual meters, preserves GET /user/subscription & counter isolation, scrapes canary & bypass headers', async () => {
    const { context, storage, networkCalls, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 'sec_guest_10',
      browser_id: 'b_guest_10',
      anlas_bypass_enabled: true
    }, guestCode);

    // Deliberately nest <span>1</span> inside "Generate <span>1</span> Image" to verify canary scraper ignores sample count
    context.document.body.innerHTML = `
      <div class="image-gen-nav-row">
        <div style="display:flex;">
          <button aria-label="menu" class="nav-btn"></button>
        </div>
      </div>
      <div class="image-gen-model-mode-row">
        <div><span>Model</span><div class="css-icpgrc"><div id="native-model-val" class="css-19vwdf1-singleValue">V5 Full</div><input aria-label="Select the Model" value="" /></div></div>
        <div><span>Effort</span><div><button id="native-med-btn" style="background-color: rgb(25, 90, 95);">Medium</button><button id="native-high-btn" style="background-color: rgba(0, 0, 0, 0);">High</button></div></div>
      </div>
      <div class="image-gen-footer">
        <button class="image-gen-generate-button">
          <span>Generate <span>1</span> Image</span>
          <div class="native-anlas-container"><span id="native-anlas-val">90 Anlas</span></div>
        </button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

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
        subscription_period: { anlas_consumed: 90, v5_consumed: 4 }
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

    const v5Label = context.document.getElementById('gw-v5-label');
    const v5Eta = context.document.getElementById('gw-v5-eta');
    const v5Cost = context.document.getElementById('gw-v5-cost');
    const anlasLabel = context.document.getElementById('gw-anlas-label');
    assert.match(v5Label.textContent, /180\/540 NCP/);
    assert.match(v5Label.textContent, /\+450 Surplus/);
    assert.match(v5Label.textContent, /82\.5%/);
    assert.match(v5Eta.textContent, /SURPLUS ACTIVE/);
    assert.match(v5Eta.textContent, /\+1% in 30\.0m/);
    assert.strictEqual(v5Cost.textContent, 'Cost: 10 NCP (Med)', 'HUD must display 10 NCP for native V5 Medium selection');
    assert.match(anlasLabel.textContent, /500\/500 \(No Rollover\)/);

    // Toggle native Effort to High in NovelAI's DOM -> HUD updates to 18 NCP immediately
    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Cost.textContent, 'Cost: 18 NCP (High)', 'HUD must display 18 NCP for native V5 High selection');

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

    // 5. master_v5_is_negative: true revokes Opus 1-sample discount -> X-Declared-Anlas: 30
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

    // 6. Guest Settings Modal renders dual-ledger fields & bypass toggle
    const badge = context.document.getElementById('gw-nav-badge');
    badge.onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    const modal = context.document.getElementById('vps-settings-modal');
    assert.ok(modal);
    assert.ok(modal.querySelector('#settings-anlas-bypass'));
    assert.ok(modal.querySelector('#guest-virtual-anlas'));
    assert.ok(modal.querySelector('#guest-v5-bank'));
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
    assert.strictEqual(v5Cost.textContent, 'Cost: 18 NCP (High)');
    assert.strictEqual(stepSlider.getAttribute('max'), '23');
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'none');

    // Simulate user typing/sliding steps to 25 (live input event without MutationObserver churn)
    stepSlider.value = '25';
    stepSlider.dispatchEvent({ type: 'input', target: stepSlider });
    assert.strictEqual(context.document.getElementById('gw-hud-alert').style.display, 'block', 'Live input event to step 25 must trigger deadband warning immediately');
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /battery deadband/i);

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
      assert.match(errBody.message, /battery deadband/i);
    }
    assert.strictEqual(networkCalls.length, 0, 'Deadband requests must never hit /queue/join');

    // 2. Switch NovelAI's native Effort pill to Medium -> clears deadband alert, updates cost to 10 NCP, restores slider max=28
    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(v5Cost.textContent, 'Cost: 10 NCP (Med)');
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

    // 5. Switch native Model dropdown to V4.5 Full, NAI 3.5, SD 1.5, and Model V50 -> must all render Legacy (0 NCP)
    for (const legacyLabel of ['V4.5 Full', 'NAI Diffusion 3.5', 'SD 1.5', 'Model V50']) {
      context.document.getElementById('native-model-val').textContent = legacyLabel;
      triggerObserverSync();
      await new Promise(r => setTimeout(r, 20));
      assert.strictEqual(v5Cost.textContent, 'Legacy (0 NCP)', `Model "${legacyLabel}" must not be misclassified as V5`);
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
  await t.test('Hell Path: Negative Anlas debt locks bypass, stale GM telemetry never poisons boot & forgiveness restores modal hint', async () => {
    // Seed stale gw_policy_state with isHardLocked: true & subscriptionActive: false to prove fresh boot ignores it
    const { context, storage, networkCalls, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
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
    assert.strictEqual(context.document.getElementById('gw-bypass-text').textContent, 'Bypass Locked');
    assert.match(context.document.getElementById('gw-anlas-label').textContent, /Anlas Balance: -40 \(Bypass Locked\)/);

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
    assert.doesNotMatch(modalStatusEl.textContent, /Bypass Locked/);

    modalBypass.checked = true;
    modalBypass.onchange();
    assert.match(
      context.document.getElementById('gw-v5-label').textContent,
      /180\/540 NCP/,
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
  await t.test('Hell Path: Enforces 5.5% Battery Recharging lockout, lets token_expired reach server immediately, and propagates errors', async () => {
    const { context, networkCalls, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
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
    assert.match(context.document.getElementById('gw-v5-eta').textContent, /TOKEN EXPIRED/);
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

    // Switch to 5.0% Battery Recharging circuit breaker
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
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'Battery Recharging');

    // Toggling #gw-bypass-toggle ON directly while sitting on Battery Recharging shield MUST clear shield immediately
    const bypassToggle = context.document.getElementById('gw-bypass-toggle');
    bypassToggle.checked = true;
    bypassToggle.onchange();
    assert.strictEqual(
      context.document.getElementById('gw-button-shield').style.display,
      'none',
      'Arming Anlas Bypass while Battery Recharging shield is shown must unlock Generate button immediately'
    );

    // Toggling back OFF must restore Battery Recharging shield immediately
    bypassToggle.checked = false;
    bypassToggle.onchange();
    assert.strictEqual(context.document.getElementById('gw-button-shield').style.display, 'flex');
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'Battery Recharging');

    // Test V5 Quota Depleted switching native Effort from High (18 NCP) to Medium (10 NCP) with 12 NCP available
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
    assert.strictEqual(context.document.getElementById('gw-shield-text').textContent, 'V5 Quota Depleted');

    context.document.getElementById('native-med-btn').style.backgroundColor = 'rgb(25, 90, 95)';
    context.document.getElementById('native-high-btn').style.backgroundColor = 'rgba(0, 0, 0, 0)';
    triggerObserverSync();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(
      context.document.getElementById('gw-button-shield').style.display,
      'none',
      'Switching native Effort from High (18 NCP) to Medium (10 NCP) with 12 NCP available must clear V5 Quota Depleted shield'
    );

    // Restore 5.0% circuit breaker lock on High for free-V5 vs legacy/base-paid verification
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

    // Legacy V4.5 passes untouched during V5 circuit breaker
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
    assert.match(context.document.getElementById('gw-hud-alert').textContent, /session token was rejected/);
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')));
  });

  // ---------------------------------------------------------------------------
  // 7. ADMIN DUAL-LEDGER GOVERNANCE, UNLINKED `user_id` & IMMEDIATE TOKEN REFRESH
  // ---------------------------------------------------------------------------
  await t.test('Admin Governance: Renders expired/inactive badges, operator cycle usage, unlinked user_id payloads & post-token-push refresh', async () => {
    const { context, networkCalls, promptQueue, alertLog, triggerIntervalAtMs, triggerObserverSync } = createBrowserSandbox({
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

    // Verify Admin HUD displays Battery Recharging when isHardLocked is true (<= 5.5%)
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
    assert.match(context.document.getElementById('gw-v5-label').textContent, /Battery Recharging/);

    networkCalls.length = 0;
    const mockDeviceGroups = [
      {
        user_id: 'discord_debtor',
        discord_id: 'discord_debtor',
        discord_username: 'DebtorUser',
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
        total_requests: 12,
        last_active_at: Date.now(),
        is_online: true,
        devices: [{
          browser_id: 'b_debtor_dev',
          label: 'Laptop',
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
        total_requests: 2,
        last_active_at: Date.now() - 1000,
        is_online: false,
        devices: []
      }
    ];

    context.document.getElementById('gw-nav-badge').onclick({ preventDefault: () => {}, stopPropagation: () => {} });
    await new Promise(r => setTimeout(r, 20));

    const devCall1 = networkCalls.find(c => c.url.includes('/admin/devices'));
    assert.ok(devCall1);
    devCall1.onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

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

    // Pushing fresh token via PUSH TO GUILDWEAVE STORAGE triggers immediate HUD poll + modal refresh
    networkCalls.length = 0;
    context.document.getElementById('vps-master-token-input').value = 'fresh_master_jwt';
    context.document.getElementById('vps-btn-push-token').onclick();
    const updateTokCall = networkCalls.find(c => c.url.includes('/admin/update-token'));
    assert.ok(updateTokCall);
    updateTokCall.onload({ status: 200, responseText: '{"success":true}' });
    await new Promise(r => setTimeout(r, 20));
    assert.ok(networkCalls.some(c => c.url.includes('/auth/status')), 'Token push must refresh operator HUD immediately');
    assert.ok(networkCalls.some(c => c.url.includes('/admin/devices')), 'Token push must refresh governance view immediately');
    const refreshedDevCall = networkCalls.find(c => c.url.includes('/admin/devices'));
    refreshedDevCall.onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    // Expand both cards
    const headers = context.document.querySelectorAll('.client-card-header');
    headers[0].onclick({ currentTarget: headers[0] });
    await new Promise(r => setTimeout(r, 20));
    let deviceCalls = networkCalls.filter(c => c.url.includes('/admin/devices'));
    deviceCalls[deviceCalls.length - 1].onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

    const headers2 = context.document.querySelectorAll('.client-card-header');
    headers2[1].onclick({ currentTarget: headers2[1] });
    await new Promise(r => setTimeout(r, 20));
    deviceCalls = networkCalls.filter(c => c.url.includes('/admin/devices'));
    deviceCalls[deviceCalls.length - 1].onload({ status: 200, responseText: JSON.stringify(mockDeviceGroups) });
    await new Promise(r => setTimeout(r, 20));

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

    // Operator Settings tab must render Cycle Consumed (subscription_period) alongside Lifetime Anlas
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
        anlas: { is_unlimited: true, is_in_debt: false },
        v5: { is_unlimited: true, surplus_available_ncp: 320, surplus_eligible: true },
        telemetry: { master_v5_percent: 72.0, cluster_state: 'surplus_active', subscription_active: true, last_fetched_at: Date.now() },
        subscription_period: { anlas_consumed: 65, v5_consumed: 9 }
      })
    });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(context.document.getElementById('operator-period-usage').textContent, '65A / 9 V5');
    assert.strictEqual(context.document.getElementById('operator-anlas-consumed').textContent, '240 Anlas');
  });
});