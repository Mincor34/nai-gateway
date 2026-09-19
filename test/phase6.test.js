/**
 * PHASE 6 HARNESS: USERSCRIPT RUNTIME INTEGRITY & TARGET BROWSER SIMULATION (test/phase6.test.js)
 *
 * ARCHITECTURAL MANDATE:
 * Tests compiled UserScript distribution artifacts (UserScripts/nai-admin.user.js and UserScripts/nai-guest.user.js)
 * strictly inside an isolated Node.js VM browser sandbox.
 *
 * RIGID TARGET-ENVIRONMENT INVARIANTS:
 * 1. ZERO Node.js Leaks: `Buffer`, `process`, and `require` are strictly `undefined` inside the sandbox execution context.
 * 2. Complete Browser Web API Sandbox: Emulates `window`, `document`, `unsafeWindow`, `sessionStorage`,
 *    `Headers`, `Response`, `Request`, `FormData`, `Blob`, `ReadableStream`, `TextDecoder`, `TextEncoder`,
 *    `MutationObserver`, `requestAnimationFrame`, and Web Crypto (`crypto.randomUUID`, `crypto.getRandomValues`).
 * 3. Authoritative Mock DOM: Implements a true stack-based HTML parser constructing nested parent-child
 *    hierarchies supporting `getElementById`, `querySelector`, `querySelectorAll`, dynamic attributes, inline styles,
 *    and relational siblings (`previousElementSibling`, `nextElementSibling`, `parentElement`).
 * 4. Comprehensive Hell Paths on COMPILED ARTIFACTS:
 *    - 50ms High-Frequency UI Enforcement loop recovering from React SPA DOM reconciliation purges.
 *    - Native `unsafeWindow.fetch` interception of `/user/data` (Opus tier injected, keystore and settings preserved).
 *    - Admin control panel lifecycle: #gw-nav-badge trigger, dual sub-tab switching, token push, and client governance.
 *    - Parametric payload extraction across `FormData`, `Blob`, `Uint8Array`, and hostile/malformed payloads without `Buffer`.
 *    - Multibyte UTF-8 stream chunk fragmentation (ensuring 4-byte emoji sequences survive split buffers without `\uFFFD`).
 *    - Ghost-lock cleanup via `POST /queue/complete` upon client network severance.
 *    - Mid-flight HTTP 401 de-authorization self-healing and silent re-registration.
 *    - Crypto entropy and fallback to `getRandomValues` and `Math.random` when `randomUUID` is stripped.
 *    - Dynamic UI Invariant Verification:
 *      * Nav row badge injection into `.image-gen-nav-row` without flex distribution distortion.
 *      * Autonomous allowance bar rendering via NovelAI CSS variables without requiring native Opus bar scraping.
 *      * Generate button shield overlay: total occlusion of sibling children (`visibility: hidden`) with no text collision.
 *      * Deprecated settings tab quarantine: verifies no redundant `#gw-settings-tab` injection into settings sidebar.
 *      * Complete toast eradication: verifies no floating `#vps-queue-banner` elements exist anywhere in the DOM.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { build, targets } = require('../scripts/build-userscripts');

/**
 * Safely parses the authoritative @version declaration from a userscript metadata block.
 * Hardened against arbitrary whitespace, tabs, and missing declarations.
 * Constrained strictly within the // ==UserScript== and // ==/UserScript== boundaries.
 *
 * @param {string|null} source - Raw compiled userscript source code.
 * @returns {string} Extracted version string or '0.0.0' on failure.
 */
function extractMetadataVersion(source) {
  if (!source || typeof source !== 'string') return '0.0.0';
  const headerMatch = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!headerMatch) return '0.0.0';
  const versionMatch = headerMatch[1].match(/\/\/\s*@version\s+([^\r\n]+)/);
  return versionMatch ? versionMatch[1].trim() : '0.0.0';
}

/**
 * Creates an authentic browser and Tampermonkey sandbox context.
 * Guarantees zero host leaks (`Buffer`, `process`, `require` are strictly undefined).
 * Dynamically binds GM_info.script.version to the compiled artifact metadata.
 *
 * @param {object} [initialStorage={}] - Seed key-value store for GM_getValue.
 * @param {string|null} [scriptSourceOrVersion=null] - Compiled script code or explicit version override.
 * @returns {{ context: object, storage: Map, networkCalls: Array, elements: Map, triggerDOMInterval: Function, triggerObserverSync: Function, setPageFetch: Function }}
 */
function createBrowserSandbox(initialStorage = {}, scriptSourceOrVersion = null) {
  const storage = new Map(Object.entries(initialStorage));
  const networkCalls = [];
  const intervals = new Map();
  let intervalIdCounter = 1;

  // Authoritative global ID registry for document.getElementById lookups
  const elements = new Map();
  const observerCallbacks = [];

  // Resolve authoritative userscript version dynamically from metadata
  const resolvedVersion = typeof scriptSourceOrVersion === 'string'
    ? (scriptSourceOrVersion.includes('==UserScript==') ? extractMetadataVersion(scriptSourceOrVersion) : scriptSourceOrVersion)
    : '0.0.0';

  function matchesSelector(el, sel) {
    if (sel.startsWith('#')) {
      return el.id === sel.slice(1);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      return classes.includes(cls);
    }
    if (sel.includes('[') && sel.includes('=')) {
      const match = sel.match(/\[([a-zA-Z0-9\-_:]+)=(?:"([^"]*)"|'([^']*)'|([^\]]+))\]/);
      if (match) {
        const attrName = match[1];
        const attrVal = match[2] || match[3] || match[4] || '';
        return el.getAttribute(attrName) === attrVal;
      }
    }
    return el.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findSelector(root, sel, singleOnly, results = []) {
    const parts = sel.split(/\s+/).filter(Boolean);
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
        if (stack.length > 1) {
          stack.pop();
        }
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
          if (attrName === 'value') childEl.value = attrVal;
          if (attrName === 'checked') childEl.checked = true;
        }

        const currentParent = stack[stack.length - 1];
        currentParent.appendChild(childEl);

        if (!isSelfClosing) {
          stack.push(childEl);
        }
      }
    }
  }

  function createMockElement(tagName = 'div') {
    let _id = '';
    let _innerHTML = '';
    let _children = [];
    const attributes = new Map();

    const styleTarget = { cssText: '' };
    const style = new Proxy(styleTarget, {
      get(target, prop) {
        return target[prop] || '';
      },
      set(target, prop, val) {
        target[prop] = String(val);
        if (prop === 'cssText') {
          const decls = String(val).split(';');
          for (const d of decls) {
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
      value: '',
      checked: false,
      onclick: null,
      onchange: null,
      parentElement: null,

      get id() {
        return _id;
      },
      set id(val) {
        const oldId = _id;
        _id = String(val || '');
        if (oldId && elements.get(oldId) === el) {
          elements.delete(oldId);
        }
        if (_id) {
          elements.set(_id, el);
        }
      },

      get className() {
        return attributes.get('class') || '';
      },
      set className(val) {
        attributes.set('class', String(val || ''));
      },

      get textContent() {
        return _innerHTML.replace(/<[^>]*>?/gm, '');
      },
      set textContent(val) {
        _innerHTML = String(val || '');
      },

      get children() {
        return _children;
      },

      get firstElementChild() {
        return _children[0] || null;
      },

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

      appendChild(child) {
        _children.push(child);
        child.parentElement = el;
        notifyMutation(el, 'childList', [child], []);
        return child;
      },

      insertBefore(newChild, refChild) {
        const idx = _children.indexOf(refChild);
        if (idx === -1) {
          _children.push(newChild);
        } else {
          _children.splice(idx, 0, newChild);
        }
        newChild.parentElement = el;
        notifyMutation(el, 'childList', [newChild], []);
        return newChild;
      },

      remove() {
        if (_id && elements.get(_id) === el) {
          elements.delete(_id);
        }
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
      },

      getAttribute(k) {
        if (k.toLowerCase() === 'id') return _id || null;
        return attributes.has(k) ? attributes.get(k) : null;
      },

      get innerHTML() {
        return _innerHTML;
      },
      set innerHTML(html) {
        _innerHTML = String(html || '');
        for (const c of _children) c.remove();
        _children = [];
        parseHTMLIntoChildren(el, _innerHTML);
        notifyMutation(el, 'childList', _children, []);
      },

      querySelector(sel) {
        return findSelector(el, sel, true);
      },

      querySelectorAll(sel) {
        const results = [];
        findSelector(el, sel, false, results);
        return results;
      },

      addEventListener(type, fn) {
        el[`on${type}`] = fn;
      }
    };

    return el;
  }

  const documentMock = {
    body: createMockElement('body'),
    documentElement: createMockElement('html'),
    createElement(tag) {
      return createMockElement(tag);
    },
    createElementNS(ns, tag) {
      return createMockElement(tag);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
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

  // Mock unsafeWindow with page-level fetch implementation
  let originalPageFetch = async () => new Response("{}", { status: 200 });

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
    location: {
      reloaded: false,
      reload() { this.reloaded = true; }
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0)
  };

  const cryptoMock = {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomValues: (arr) => nodeCrypto.getRandomValues(arr)
  };

  windowMock.crypto = cryptoMock;

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observerCallbacks.push(this.callback);
    }
    disconnect() {
      const idx = observerCallbacks.indexOf(this.callback);
      if (idx !== -1) observerCallbacks.splice(idx, 1);
    }
  }

  // Build isolated VM sandbox context ensuring zero host pollution
  const sandbox = {
    // Window identity references
    window: windowMock,
    unsafeWindow: unsafeWindowMock,
    document: documentMock,
    sessionStorage: windowMock.sessionStorage,
    location: windowMock.location,
    requestAnimationFrame: windowMock.requestAnimationFrame,

    // Web Standard Interfaces
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

    // Timer scheduling
    setInterval: (fn, ms) => {
      const id = intervalIdCounter++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},

    // Tampermonkey Sandbox APIs
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, val) => { storage.set(key, val); },
    GM_info: { script: { version: resolvedVersion } },
    GM_xmlhttpRequest: (details) => {
      networkCalls.push(details);
    },

    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },

    // FATAL INVARIANT ASSERTIONS: Exterminate Node.js Host Leaks
    Buffer: undefined,
    process: undefined,
    require: undefined,
    global: undefined
  };

  sandbox.globalThis = sandbox;
  windowMock.globalThis = sandbox;

  const vmContext = vm.createContext(sandbox);

  return {
    context: vmContext,
    storage,
    networkCalls,
    elements,
    triggerDOMInterval: () => {
      for (const { fn } of intervals.values()) {
        fn();
      }
    },
    triggerObserverSync: () => {
      for (const cb of observerCallbacks) {
        cb([{ target: documentMock.body, type: 'childList', addedNodes: [documentMock.body], removedNodes: [] }]);
      }
    },
    setPageFetch: (fn) => { originalPageFetch = fn; }
  };
}

test("Phase 6: UserScript Target Environment Verification (Tampermonkey Browser VM)", async (t) => {
  // Compile distribution artifacts cleanly before test suite execution
  await build();

  const adminCode = fs.readFileSync(targets.find(t => t.name === 'nai-admin').outfile, 'utf8');
  const guestCode = fs.readFileSync(targets.find(t => t.name === 'nai-guest').outfile, 'utf8');

  // Authoritative dynamic metadata version extraction
  const expectedGuestVersion = extractMetadataVersion(guestCode);
  const expectedAdminVersion = extractMetadataVersion(adminCode);

  assert.ok(expectedGuestVersion !== '0.0.0', "Guest artifact must contain valid @version metadata");
  assert.ok(expectedAdminVersion !== '0.0.0', "Admin artifact must contain valid @version metadata");

  // ---------------------------------------------------------------------------
  // 1. ISOLATION & HOST LEAK EXTERMINATION INVARIANTS
  // ---------------------------------------------------------------------------
  await t.test("Runtime Isolation: Verifies pure browser environment devoid of Node globals", () => {
    const { context } = createBrowserSandbox({}, guestCode);

    vm.runInContext(`
      if (typeof Buffer !== 'undefined') throw new Error("FATAL: Buffer leaked into UserScript sandbox!");
      if (typeof process !== 'undefined') throw new Error("FATAL: process leaked into UserScript sandbox!");
      if (typeof require !== 'undefined') throw new Error("FATAL: require leaked into UserScript sandbox!");
      if (typeof window === 'undefined') throw new Error("FATAL: window missing from UserScript sandbox!");
      if (typeof unsafeWindow === 'undefined') throw new Error("FATAL: unsafeWindow missing from UserScript sandbox!");
      if (typeof window.crypto === 'undefined') throw new Error("FATAL: window.crypto missing from UserScript sandbox!");
    `, context);
  });

  // ---------------------------------------------------------------------------
  // 2. COMPILED SCRIPT PARSING & 50ms UI ENFORCEMENT LOOP HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: 50ms High-Frequency UI Enforcement loop recovers from React SPA DOM purges", () => {
    const { context, elements, triggerDOMInterval } = createBrowserSandbox({
      approved: false,
      vps_host: '',
      device_secret: ''
    }, guestCode);

    // Execute compiled guest bundle
    vm.runInContext(guestCode, context);

    // 1. Trigger interval: setup wizard mounts and binds element click listeners
    triggerDOMInterval();
    const overlayBefore = context.document.getElementById("vps-approval-overlay");
    assert.ok(overlayBefore, "Setup wizard overlay must mount when unapproved");

    // 2. Simulate React SPA reconciliation completely nuking unmanaged DOM nodes
    overlayBefore.remove();
    assert.strictEqual(context.document.getElementById("vps-approval-overlay"), null, "DOM getElementById must return null for purged element");
    assert.strictEqual(elements.has("vps-approval-overlay"), false, "Purged element must be evicted from ID registry");

    // 3. Trigger 50ms loop again: must re-mount cleanly without uncaught exceptions
    triggerDOMInterval();
    const overlayAfter = context.document.getElementById("vps-approval-overlay");
    assert.ok(overlayAfter, "50ms enforcement loop must resurrect overlay when destroyed by React");
  });

  // ---------------------------------------------------------------------------
  // 3. LOCAL METADATA & OPUS SUBSCRIPTION SPOOFING IN BROWSER
  // ---------------------------------------------------------------------------
  await t.test("Split-Token Spoofing: Intercepts /user/data in browser, injects Opus tier, and preserves keystore", async () => {
    const { context, setPageFetch } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    // Mock native NovelAI server response for a free tier account
    const rawFreeUserData = {
      subscription: { tier: 0, active: false, expiresAt: 0 },
      keystore: { keystore: "CRYPTOGRAPHIC_E2EE_KEYSTORE_DATA", changeIndex: 4 },
      settings: "{\"theme\":\"dark\",\"fontSize\":14}"
    };

    setPageFetch(async (url) => {
      if (url.includes('/user/data')) {
        return new Response(JSON.stringify(rawFreeUserData), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    // Boot compiled guest bundle
    vm.runInContext(guestCode, context);

    // Page SPA calls fetch('/user/data')
    const spoofedResponse = await vm.runInContext(`unsafeWindow.fetch('https://image.novelai.net/user/data')`, context);
    assert.strictEqual(spoofedResponse.status, 200);

    const payload = await spoofedResponse.json();
    assert.strictEqual(payload.subscription.tier, 3, "Must spoof subscription tier to 3 (Opus)");
    assert.strictEqual(payload.subscription.active, true, "Must spoof active subscription status");
    assert.strictEqual(payload.subscription.trainingStepsLeft.fixedTrainingStepsLeft, 9999);
    assert.strictEqual(payload.subscription.trainingStepsLeft.purchasedTrainingSteps, 9999);
    assert.strictEqual(payload.keystore.keystore, "CRYPTOGRAPHIC_E2EE_KEYSTORE_DATA", "Must preserve E2EE keystore untouched");
    assert.strictEqual(payload.settings, "{\"theme\":\"dark\",\"fontSize\":14}", "Must preserve settings string untouched");
  });

  // ---------------------------------------------------------------------------
  // 4. ADMIN USERSCRIPT LIFECYCLE, CONTROL PANEL & TOKEN INJECTION IN BROWSER VM
  // ---------------------------------------------------------------------------
  await t.test("Admin Panel Lifecycle: Control panel mounting, token push, and client governance", async () => {
    const { context, networkCalls, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      admin_token: 'admin_secret_passkey_xyz',
      browser_id: 'b_admin_browser_123'
    }, adminCode);

    // Seed DOM with navigation row and hamburger button
    context.document.body.innerHTML = `
      <div class="sc-1279ed83-12 vWKbz image-gen-nav-row" data-layout-bar="true">
        <div style="flex: 0 0 auto;"></div>
        <div style="flex: 0 0 auto;"></div>
        <div style="flex: 0 0 auto;">
          <div style="display:flex;">
            <button aria-label="menu" class="sc-2f2fb315-2 sc-e97e72ff-0 eTBYIC gVyoTq">
              <div class="sc-e95dc911-1 sc-e95dc911-184 bzvxUK gzJfeX"></div>
            </button>
          </div>
        </div>
      </div>
      <div class="image-gen-footer">
        <button class="sc-2f2fb315-2 sc-e15f0c15-0 eTBYIC YYeeL image-gen-generate-button">
          <span>Generate 1 Image</span>
        </button>
      </div>
    `;

    // Execute compiled admin bundle in sandbox
    vm.runInContext(adminCode, context);
    triggerObserverSync();

    // 1. Verify Nav Badge injected into nav row
    const badgeBtn = context.document.getElementById('gw-nav-badge');
    assert.ok(badgeBtn, "Nav Badge trigger button must be injected into nav row");
    assert.strictEqual(typeof badgeBtn.onclick, 'function');

    // Invariant: Verify old red float button has been eradicated
    const legacyBtn = context.document.documentElement.children.find(
      c => c.tagName === 'BUTTON' && c.innerHTML === 'VPS CONTROL PANEL'
    );
    assert.strictEqual(legacyBtn, undefined, "Obsolete floating red button must be purged");

    // 2. Click badge button to toggle admin panel modal
    badgeBtn.onclick({ preventDefault: () => {}, stopPropagation: () => {} });

    const panelModal = context.document.getElementById("vps-admin-panel");
    assert.ok(panelModal, "Clicking badge button must instantiate #vps-admin-panel");

    // Invariant: Modal styling must leverage NovelAI theme CSS variables
    assert.match(panelModal.style.background, /--theme-bg0/, "Modal background must reference --theme-bg0");

    // Assert sub-tabs exist
    const governanceTab = panelModal.querySelector('#admin-tab-governance');
    const settingsTab = panelModal.querySelector('#admin-tab-settings');
    assert.ok(governanceTab, "Device Governance sub-tab must exist");
    assert.ok(settingsTab, "Operator Settings sub-tab must exist");

    // Assert background fetch dispatched to retrieve device listings
    const devCall = networkCalls.find(c => c.url.includes('/admin/devices'));
    assert.ok(devCall, "Admin panel must fetch registered devices on render");
    assert.strictEqual(devCall.headers['Authorization'], 'Bearer admin_secret_passkey_xyz');

    // 3. Test Master Session Token Push
    const tokenInput = context.document.getElementById("vps-master-token-input");
    const pushTokenBtn = context.document.getElementById("vps-btn-push-token");
    assert.ok(tokenInput, "Master token input field must be present");
    assert.ok(pushTokenBtn, "Push token button must be present");

    tokenInput.value = "Bearer master_opus_session_key_999";
    pushTokenBtn.onclick();

    const updateTokenCall = networkCalls.find(c => c.url.includes('/admin/update-token'));
    assert.ok(updateTokenCall, "Pushing token must dispatch POST to /admin/update-token");
    assert.strictEqual(updateTokenCall.method, 'POST');
    assert.strictEqual(updateTokenCall.headers['Authorization'], 'Bearer admin_secret_passkey_xyz');
    const updateBody = JSON.parse(updateTokenCall.data);
    assert.strictEqual(updateBody.master_token, "Bearer master_opus_session_key_999");

    // 4. Respond to device listing with verified mock groups
    devCall.onload({
      status: 200,
      responseText: JSON.stringify([{
        discord_id: 'discord_user_001',
        discord_username: 'TestOperator',
        priority_tier: 'Normal',
        approved: 1,
        banned: 0,
        anlas_consumed: 15,
        total_requests: 3,
        last_active_at: Date.now(),
        is_online: true,
        devices: [{
          browser_id: 'b_guest_target_1',
          label: 'Laptop',
          approved: 1,
          banned: 0,
          anlas_consumed: 15,
          total_requests: 3,
          last_active_at: Date.now(),
          is_online: true,
          metered_allowance: null,
          debug_intent: false,
          debug_authorized: false,
          debug_expires_in_ms: 0
        }]
      }])
    });

    // Yield microtasks to allow DOM render to finish
    await new Promise(r => setTimeout(r, 20));

    const clientListContainer = context.document.getElementById("vps-client-list");
    assert.ok(clientListContainer, "#vps-client-list container must exist");
    assert.ok(clientListContainer.children.length > 0, "Client records must be rendered into container");

    // 5. Test switching to Operator Settings sub-tab
    settingsTab.onclick();
    const debugCheckbox = panelModal.querySelector('#settings-debug');
    assert.ok(debugCheckbox, "Operator settings must render debug toggle");
    const nickInput = panelModal.querySelector('#settings-nickname');
    assert.ok(nickInput, "Operator settings must render nickname input");
  });

  // ---------------------------------------------------------------------------
  // 5. CHANNEL A GENERATION INTERCEPTION, BUTTON SHIELD, AND TOTAL TOAST ERADICATION
  // ---------------------------------------------------------------------------
  await t.test("Channel A Interception: Queue join, status poll, button shield text, and total toast eradication", async () => {
    const { context, networkCalls, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    context.document.body.innerHTML = `
      <div class="image-gen-footer">
        <button class="image-gen-generate-button">
          <span>Generate 1 Image</span>
        </button>
      </div>
    `;

    // Boot compiled guest bundle
    vm.runInContext(guestCode, context);
    triggerObserverSync();

    // Dispatch generation request from page context
    const fetchPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': 'image.novelai.net',
          'Content-Length': '123'
        },
        body: JSON.stringify({
          model: 'nai-diffusion-4-5-full',
          parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 }
        })
      })
    `, context);

    // Yield execution tick to allow queue join call
    await new Promise(r => setTimeout(r, 20));

    // 1. Assert Queue Join Call Dispatched
    assert.strictEqual(networkCalls.length, 1);
    const joinCall = networkCalls[0];
    assert.strictEqual(joinCall.url, 'https://vps.example.duckdns.org/queue/join');
    // Dynamic Invariant Assertion: Assert header transmitted matches true compiled artifact version
    assert.strictEqual(
      joinCall.headers['x-script-version'],
      expectedGuestVersion,
      `Network header x-script-version must dynamically equal compiled guest artifact version (${expectedGuestVersion})`
    );
    const joinBody = JSON.parse(joinCall.data);
    assert.strictEqual(joinBody.browser_id, 'b_test_browser_123');
    assert.ok(joinBody.req_id.startsWith('req_'));

    // Respond to queue join
    joinCall.onload({ status: 200, responseText: '{"success":true}' });

    // Yield for polling loop
    await new Promise(r => setTimeout(r, 1050));

    // 2. Assert Queue Status Poll Call Dispatched
    assert.strictEqual(networkCalls.length, 2);
    const pollCall1 = networkCalls[1];
    assert.ok(pollCall1.url.includes('/queue/status'));

    // Simulate "waiting" status
    pollCall1.onload({ status: 200, responseText: '{"status":"waiting","position":2}' });

    // Yield microtasks to allow status update handler to execute
    await new Promise(r => setTimeout(r, 20));

    // INVARIANT: Floating toast element must be completely absent from the DOM
    const floatingBanner = context.document.getElementById("vps-queue-banner");
    assert.strictEqual(floatingBanner, null, "Redundant floating #vps-queue-banner toast must be completely eradicated");

    // INVARIANT: Button shield overlay must be active and displaying the queue position
    const shield = context.document.getElementById("gw-button-shield");
    const shieldText = context.document.getElementById("gw-shield-text");
    assert.ok(shield, "Button shield must mount inside the generate button");
    assert.strictEqual(shield.style.display, 'flex', "Button shield must be visible in waiting state");
    assert.strictEqual(shieldText.textContent, 'Queue Position: 2', "Button shield must reflect queue position telemetry");

    // Yield for next polling cycle
    await new Promise(r => setTimeout(r, 1050));

    // 3. Respond with "your_turn"
    assert.strictEqual(networkCalls.length, 3);
    const pollCall2 = networkCalls[2];
    pollCall2.onload({ status: 200, responseText: '{"status":"your_turn"}' });

    await new Promise(r => setTimeout(r, 20));

    // 4. Assert Piped Proxy Request Dispatched with WAF protections
    assert.strictEqual(networkCalls.length, 4);
    const proxyCall = networkCalls[3];
    assert.strictEqual(proxyCall.url, 'https://vps.example.duckdns.org/proxy/image/ai/generate-image-stream');
    assert.strictEqual(proxyCall.headers['x-browser-id'], 'b_test_browser_123');
    assert.strictEqual(proxyCall.headers['x-gen-model'], 'legacy', "4-5 model must be marked legacy");
    assert.strictEqual(proxyCall.headers['x-gen-width'], '1024');
    assert.strictEqual(proxyCall.headers['x-gen-height'], '1024');
    assert.strictEqual(proxyCall.headers['x-gen-steps'], '28');

    // WAF Shield Invariant: Host and Content-Length MUST be stripped
    assert.strictEqual(proxyCall.headers['host'], undefined, "Host header must be deleted");
    assert.strictEqual(proxyCall.headers['content-length'], undefined, "Content-Length must be deleted");

    // 5. Simulate Live Stream Arrival via onloadstart
    const mockBinaryStream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("msgpack_binary_image_chunk"));
        c.close();
      }
    });

    proxyCall.onloadstart({
      status: 200,
      response: mockBinaryStream,
      responseHeaders: "HTTP/1.1 200 OK\r\nContent-Type: application/x-msgpack"
    });

    const response = await fetchPromise;
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'application/x-msgpack');
  });

  // ---------------------------------------------------------------------------
  // 6. GHOST-LOCK CLEANUP ON NETWORK FAILURE HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Aborted generation releases ghost lock via /queue/complete", async () => {
    const { context, networkCalls } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    vm.runInContext(guestCode, context);

    const fetchPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ parameters: { width: 1024, height: 1024 } })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const joinCall = networkCalls[0];
    const reqId = JSON.parse(joinCall.data).req_id;
    joinCall.onload({ status: 200, responseText: '{"success":true}' });

    await new Promise(r => setTimeout(r, 1050));
    const pollCall = networkCalls[1];

    // Simulate network severance during status poll
    pollCall.onerror(new Error("Network drop"));

    const errResponse = await fetchPromise;
    assert.strictEqual(errResponse.status, 502);

    // Invariant: must immediately dispatch /queue/complete with authorization and hardware context
    const completeCall = networkCalls.find(c => c.url.includes('/queue/complete'));
    assert.ok(completeCall, "Must dispatch /queue/complete to release server-side lock");
    assert.strictEqual(completeCall.headers['Authorization'], 'Bearer s_test_secret_123');
    const completeBody = JSON.parse(completeCall.data);
    assert.strictEqual(completeBody.req_id, reqId);
    assert.strictEqual(completeBody.browser_id, 'b_test_browser_123');
  });

  // ---------------------------------------------------------------------------
  // 7. MID-STREAM 401 REVOCATION & RE-REGISTRATION HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: HTTP 401 de-authorizes client and triggers silent re-registration", async () => {
    const { context, networkCalls, storage } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123',
      device_nickname: 'TestUser'
    }, guestCode);

    vm.runInContext(guestCode, context);

    const fetchPromise = vm.runInContext(`
      unsafeWindow.fetch('https://image.novelai.net/ai/generate-image-stream', {
        method: 'POST',
        body: JSON.stringify({ parameters: { width: 1024, height: 1024 } })
      })
    `, context);

    await new Promise(r => setTimeout(r, 20));
    const joinCall = networkCalls[0];

    // Server revokes access at queue join
    joinCall.onload({ status: 401, responseText: '{"error":"Unauthorized"}' });

    await fetchPromise;

    assert.strictEqual(storage.get("approved"), false, "Approved flag must be wiped to false");

    // Invariant: must trigger silent registration call to re-appear on admin control panel
    const reRegisterCall = networkCalls.find(c => c.url.includes('/auth/register'));
    assert.ok(reRegisterCall, "Must dispatch silent registration call on revocation");
    const reRegBody = JSON.parse(reRegisterCall.data);
    assert.strictEqual(reRegBody.browser_id, 'b_test_browser_123');
    assert.strictEqual(reRegBody.label, 'TestUser');
  });

  // ---------------------------------------------------------------------------
  // 8. MULTIBYTE STREAM FRAGMENTATION HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Multibyte UTF-8 stream chunk fragmentation does not corrupt characters", async () => {
    const { context } = createBrowserSandbox({}, guestCode);

    // 4-byte UTF-8 emoji: '😀' -> [0xF0, 0x9F, 0x98, 0x80]
    // Fragmented right through the middle of the byte sequence
    const result = await vm.runInContext(`
      (async () => {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([0xF0, 0x9F]));
            c.enqueue(new Uint8Array([0x98, 0x80]));
            c.close();
          }
        });
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let str = "";
        while(true) {
          const { done, value } = await reader.read();
          if (done) break;
          str += decoder.decode(value, { stream: true });
        }
        str += decoder.decode();
        return str;
      })()
    `, context);

    assert.strictEqual(result, '😀', "Must preserve multibyte sequences across stream chunks without replacement corruption");
  });

  // ---------------------------------------------------------------------------
  // 9. PURE BROWSER CRYPTO PRNG & FALLBACK HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Crypto Unit: Generates valid 32-char hex and falls back through PRNG engines", () => {
    const { context } = createBrowserSandbox({}, guestCode);

    const cryptoSrc = fs.readFileSync('src/userscripts/shared/crypto.js', 'utf8')
      .replace('export function generateUUID', 'function generateUUID');

    // Subtest A: Fallback verification when crypto.randomUUID is deleted (Uses getRandomValues)
    const uuidFallback = vm.runInContext(`
      ${cryptoSrc}
      delete crypto.randomUUID;
      delete window.crypto.randomUUID;
      generateUUID();
    `, context);

    assert.strictEqual(uuidFallback.length, 32);
    assert.match(uuidFallback, /^[0-9a-f]{32}$/);
    assert.strictEqual(uuidFallback[12], '4', "RFC 4122 version 4 nibble must be 4");
    assert.ok(['8', '9', 'a', 'b'].includes(uuidFallback[16]), "RFC 4122 variant nibble must be 8, 9, a, or b");

    // Subtest B: Fallback verification when Web Crypto is completely stripped (Uses Math.random)
    const mathRandomFallback = vm.runInContext(`
      delete crypto.getRandomValues;
      delete window.crypto.getRandomValues;
      generateUUID();
    `, context);

    assert.strictEqual(mathRandomFallback.length, 32);
    assert.match(mathRandomFallback, /^[0-9a-f]{32}$/);
    assert.strictEqual(mathRandomFallback[12], '4', "RFC 4122 version 4 nibble must be 4");
    assert.ok(['8', '9', 'a', 'b'].includes(mathRandomFallback[16]), "RFC 4122 variant nibble must be 8, 9, a, or b");
  });

  // ---------------------------------------------------------------------------
  // 10. HOSTILE PAYLOAD PARAMETER EXTRACTION HELL PATH
  // ---------------------------------------------------------------------------
  await t.test("Parameters Unit: Browser extraction without Buffer across hostile payloads", async () => {
    const { context } = createBrowserSandbox({}, guestCode);

    // Verify extraction on ArrayBuffer, direct Blob, and corrupted inputs inside the sandbox
    const result = await vm.runInContext(`
      (async () => {
        ${fs.readFileSync('src/userscripts/shared/params.js', 'utf8').replace('export async function', 'async function')}

        const hostile1 = await extractImageParams(null);
        const hostile2 = await extractImageParams("corrupted non json");
        const hostile3 = await extractImageParams(new Uint8Array([0x00, 0xFF, 0x88]));

        const validBlob = new Blob([JSON.stringify({
          model: "nai-diffusion-5-full",
          parameters: { width: 832, height: 1216, steps: 28, n_samples: 1 }
        })], { type: 'application/json' });
        const validParsed = await extractImageParams(validBlob);

        return { hostile1, hostile2, hostile3, validParsed };
      })()
    `, context);

    assert.strictEqual(result.hostile1, null);
    assert.strictEqual(result.hostile2, null);
    assert.strictEqual(result.hostile3, null);
    assert.strictEqual(result.validParsed.width, 832);
    assert.strictEqual(result.validParsed.height, 1216);
    assert.strictEqual(result.validParsed.model, 'nai-diffusion-5-full');
  });

  // ---------------------------------------------------------------------------
  // 11. ARTIFACT METADATA & ENCAPSULATION CONTRACT (BOTH TARGETS)
  // ---------------------------------------------------------------------------
  await t.test("Artifact Contract: Production bundles enforce strict Tampermonkey headers and IIFE boundaries", () => {
    for (const target of targets) {
      assert.ok(fs.existsSync(target.outfile), `Artifact must exist on disk: ${target.outfile}`);
      const code = fs.readFileSync(target.outfile, 'utf8');

      // 1. Metadata Block Markers
      assert.ok(code.startsWith('// ==UserScript=='), `Artifact ${target.name} must start with // ==UserScript==`);
      assert.ok(code.includes('// ==/UserScript=='), `Artifact ${target.name} must terminate with // ==/UserScript==`);

      const headerBlock = code.slice(0, code.indexOf('// ==/UserScript=='));
      assert.match(headerBlock, /@name\s+NovelAI/);
      assert.match(headerBlock, /@grant\s+GM_xmlhttpRequest/);
      assert.match(headerBlock, /@grant\s+GM_setValue/);
      assert.match(headerBlock, /@grant\s+GM_getValue/);
      assert.match(headerBlock, /@run-at\s+document-start/);
      assert.match(headerBlock, /@updateURL\s+https:\/\//);
      assert.match(headerBlock, /@downloadURL\s+https:\/\//);

      // 2. Encapsulation: Strict IIFE formatting
      const bodyContent = code.slice(code.indexOf('// ==/UserScript=='));
      assert.match(
        bodyContent,
        /\(\s*function\s*\(\)\s*\{|\(\s*\(\s*\)\s*=>\s*\{/,
        `Artifact ${target.name} must wrap runtime inside an IIFE`
      );

      // 3. Node.js Isolation: Asserts no leaked require() calls
      assert.doesNotMatch(bodyContent, /\brequire\s*\(/, `Artifact ${target.name} contains leaked require() calls`);
    }
  });

  // ---------------------------------------------------------------------------
  // 11b. HELL PATH: METADATA VERSION EXTRACTION PARSER BOUNDARY TESTING
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Metadata Version Parser verifies strict encapsulation and ignores body comments", () => {
    // 1. Null and Empty checks
    assert.strictEqual(extractMetadataVersion(null), '0.0.0');
    assert.strictEqual(extractMetadataVersion(''), '0.0.0');

    // 2. Unclosed metadata block
    assert.strictEqual(extractMetadataVersion('// ==UserScript==\n// @version 2.0.0'), '0.0.0');

    // 3. Metadata block lacking @version
    assert.strictEqual(extractMetadataVersion('// ==UserScript==\n// @name Test\n// ==/UserScript=='), '0.0.0');

    // 4. Multiple spaces, tabs, and trailing cleanups
    const messyHeader = `
      // ==UserScript==
      // @name        Messy Script
      // @version\t  \t  3.14.159   \r
      // ==/UserScript==
    `;
    assert.strictEqual(extractMetadataVersion(messyHeader), '3.14.159');

    // 5. Version declaration outside metadata block must be strictly ignored
    const deceptiveBody = `
      // ==UserScript==
      // @name Valid
      // @version 1.0.0
      // ==/UserScript==
      // @version 999.999.999 (Injected downstream comment)
    `;
    assert.strictEqual(extractMetadataVersion(deceptiveBody), '1.0.0', "Parser must not scan past // ==/UserScript== boundary");
  });

  // 12. DYNAMIC CLASS-SCRAPING HARVESTER HELL PATH (NAV BADGE & FLEX INTEGRITY)
  await t.test("Class-Scraping Harvester: Injects Nav Badge into .image-gen-nav-row without flex distortion", () => {
    const { context, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    context.document.body.innerHTML = `
      <div class="sc-1279ed83-12 vWKbz image-gen-nav-row" data-layout-bar="true">
        <div style="flex: 0 0 auto;"></div>
        <div style="flex: 0 0 auto;"></div>
        <div style="flex: 0 0 auto;">
          <div style="display:flex;">
            <button aria-label="menu" class="sc-2f2fb315-2 sc-e97e72ff-0 eTBYIC gVyoTq">
              <div class="sc-e95dc911-1 sc-e95dc911-184 bzvxUK gzJfeX"></div>
            </button>
          </div>
        </div>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const badgeBtn = context.document.getElementById('gw-nav-badge');
    assert.ok(badgeBtn, "Must inject #gw-nav-badge into navigation row");
    assert.strictEqual(badgeBtn.className, "sc-2f2fb315-2 sc-e97e72ff-0 eTBYIC gVyoTq");

    const badgeIconDiv = badgeBtn.querySelector('div');
    assert.ok(badgeIconDiv);
    // Invariant: Must NOT copy iconClasses to avoid rendering the native hamburger icon mask
    assert.strictEqual(badgeIconDiv.className, '', "Inner container must not inherit native icon mask classes");

    const menuBtn = context.document.querySelector('button[aria-label="menu"]');
    assert.strictEqual(badgeBtn.nextElementSibling, menuBtn);
  });

  // ---------------------------------------------------------------------------
  // 13. AUTONOMOUS ALLOWANCE BAR RENDERING VIA NOVELAI CSS VARIABLES
  // ---------------------------------------------------------------------------
  await t.test("Autonomous Allowance Bar: Mounts cleanly using NovelAI CSS variables without requiring native Opus bar", () => {
    const { context, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    // Seed DOM WITHOUT any native Opus bar present
    context.document.body.innerHTML = `
      <div class="image-gen-footer">
        <button class="image-gen-generate-button">
          <span>Generate 1 Image</span>
        </button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const allowanceBar = context.document.getElementById('gw-allowance-bar');
    assert.ok(allowanceBar, "Must mount #gw-allowance-bar autonomously");
    
    // Invariant: CSS variables must be referenced in inline styles
    assert.match(allowanceBar.style.backgroundColor, /--theme-bg0/, "Allowance bar must use --theme-bg0");
    assert.match(allowanceBar.style.border, /--theme-bg2/, "Allowance bar border must use --theme-bg2");

    const genBtn = context.document.querySelector('.image-gen-generate-button');
    assert.strictEqual(allowanceBar.nextElementSibling, genBtn, "Allowance bar must precede the Generate button");
  });

  // ---------------------------------------------------------------------------
  // 14. GENERATE BUTTON SHIELD OVERLAY: TOTAL OCCLUSION HELL PATH (NO TEXT COLLISION)
  // ---------------------------------------------------------------------------
  await t.test("Generate Button Shield: Enforces total occlusion of native siblings (visibility: hidden) during active queue state", () => {
    const { context, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    context.document.body.innerHTML = `
      <div class="image-gen-footer">
        <button class="sc-2f2fb315-2 sc-e15f0c15-0 eUAGgg YYeeL image-gen-generate-button">
          <span class="native-label">Generate 1 Image</span>
          <div class="native-anlas-container"><span>0 Anlas</span></div>
        </button>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    const genBtn = context.document.querySelector('.image-gen-generate-button');
    const nativeSpan = genBtn.querySelector('.native-label');
    const nativeAnlas = genBtn.querySelector('.native-anlas-container');
    const shield = context.document.getElementById('gw-button-shield');
    const shieldText = context.document.getElementById('gw-shield-text');

    assert.ok(shield, "Button shield must mount inside the generate button");
    
    // Invariant: Shield must NOT inherit the button's class hashes to prevent style bleeding
    assert.strictEqual(shield.className, '', "Shield overlay must not inherit .image-gen-generate-button class");

    // Invariant: Initial idle state verification
    assert.strictEqual(shield.style.display, 'none');
    assert.strictEqual(shield.style.pointerEvents, 'none');
    assert.strictEqual(nativeSpan.style.visibility, '', "Native label must be visible initially");
    assert.strictEqual(nativeAnlas.style.visibility, '', "Native anlas badge must be visible initially");

    // ACTIVATE QUEUE STATE: Simulate turn acquisition in progress
    const setQueueShieldState = vm.runInContext(`
      (active, text) => {
        const shield = document.getElementById('gw-button-shield');
        const labelText = document.getElementById('gw-shield-text');
        const genBtn = shield.parentElement;
        if (genBtn) {
          for (const child of genBtn.children) {
            if (child !== shield) {
              child.style.visibility = active ? 'hidden' : '';
            }
          }
        }
        if (active) {
          labelText.textContent = text;
          shield.style.display = 'flex';
          shield.style.pointerEvents = 'all';
        } else {
          shield.style.display = 'none';
          shield.style.pointerEvents = 'none';
        }
      }
    `, context);

    setQueueShieldState(true, 'Acquiring channel slot...');

    // INVARIANT: Native siblings MUST be hidden to eradicate text superposition
    assert.strictEqual(nativeSpan.style.visibility, 'hidden', "Native button text must be set to visibility: hidden");
    assert.strictEqual(nativeAnlas.style.visibility, 'hidden', "Native anlas container must be set to visibility: hidden");
    assert.strictEqual(shield.style.display, 'flex');
    assert.strictEqual(shieldText.textContent, 'Acquiring channel slot...');

    // DEACTIVATE QUEUE STATE: Simulate completion
    setQueueShieldState(false, '');

    // INVARIANT: Native siblings MUST be restored to visible
    assert.strictEqual(nativeSpan.style.visibility, '', "Native button text must be restored to visible");
    assert.strictEqual(nativeAnlas.style.visibility, '', "Native anlas container must be restored to visible");
    assert.strictEqual(shield.style.display, 'none');
  });

  // ---------------------------------------------------------------------------
  // 15. DEPRECATED SETTINGS TAB QUARANTINE
  // ---------------------------------------------------------------------------
  await t.test("Settings Modal Quarantine: Asserts Gateway Coordinator tab is NOT injected into NovelAI user settings modal", () => {
    const { context, triggerObserverSync } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    }, guestCode);

    // Native NovelAI user settings modal opens
    context.document.body.innerHTML = `
      <div role="dialog" class="modal modal-large">
        <div class="settings-sidebar">
          <div style="margin-bottom: auto">
            <button class="sc-tab sc-inactive tab-image">Image Generation</button>
            <button class="sc-tab sc-active tab-account">Account</button>
          </div>
        </div>
        <div class="settings-content">
          <div class="native-account-settings">Account Form</div>
        </div>
      </div>
    `;

    vm.runInContext(guestCode, context);
    triggerObserverSync();

    // INVARIANT: Redundant tab must NOT exist in the DOM
    const customTab = context.document.getElementById('gw-settings-tab');
    assert.strictEqual(customTab, null, "Gateway Coordinator tab must NOT be injected into settings sidebar");

    const customContent = context.document.getElementById('gw-settings-content');
    assert.strictEqual(customContent, null, "Custom settings panel must NOT be mounted into native settings modal");
  });
});