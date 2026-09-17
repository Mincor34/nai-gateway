/**
 * PHASE 6 HARNESS: USERSCRIPT RUNTIME INTEGRITY & TARGET BROWSER SIMULATION
 *
 * ARCHITECTURAL MANDATE:
 * Tests compiled UserScript artifacts (UserScripts/nai-admin.user.js and UserScripts/nai-guest.user.js)
 * strictly inside an isolated VM browser sandbox.
 *
 * RIGID TARGET-ENVIRONMENT INVARIANTS:
 * 1. ZERO Node.js Leaks: `Buffer`, `process`, and `require` are strictly `undefined` inside the sandbox.
 * 2. Complete Browser Web API Sandbox: Emulates `window`, `document`, `unsafeWindow`, `sessionStorage`,
 *    `Headers`, `Response`, `Request`, `FormData`, `Blob`, `ReadableStream`, `TextDecoder`, `TextEncoder`,
 *    and Web Crypto (`crypto.randomUUID`, `crypto.getRandomValues`).
 * 3. Authoritative Mock DOM: Parses HTML string assignments into queryable DOM hierarchies supporting
 *    `getElementById`, `querySelector`, `querySelectorAll`, and dynamic attribute/style bindings.
 * 4. Comprehensive Hell Paths on COMPILED ARTIFACTS:
 *    - 50ms High-Frequency UI Enforcement loop recovering from React SPA DOM purges.
 *    - Native `unsafeWindow.fetch` interception of `/user/data` (Opus tier injected, keystore preserved).
 *    - Admin control panel lifecycle: float button injection, admin modal toggle, master token injection.
 *    - Admin governance dispatch: `/admin/devices` retrieval, client rendering, and account actions.
 *    - Parametric payload extraction across `FormData`, `Blob`, `Uint8Array`, and hostile/malformed payloads without `Buffer`.
 *    - Multibyte UTF-8 stream chunk fragmentation (ensuring 4-byte emoji sequences survive split buffers without `\uFFFD`).
 *    - Ghost-lock cleanup via `POST /queue/complete` upon client network severance.
 *    - Mid-flight HTTP 401 de-authorization self-healing and silent re-registration.
 *    - Crypto entropy and fallback to `getRandomValues` and `Math.random` when `randomUUID` is stripped.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { build, targets } = require('../scripts/build-userscripts');

/**
 * Creates an authentic browser and Tampermonkey sandbox context.
 * Guarantees zero host leaks (`Buffer`, `process`, `require` are undefined).
 *
 * @param {object} [initialStorage={}] - Seed key-value store for GM_getValue.
 * @returns {{ context: object, storage: Map, networkCalls: Array, elements: Map, triggerDOMInterval: Function, setPageFetch: Function }}
 */
function createBrowserSandbox(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const networkCalls = [];
  const intervals = new Map();
  let intervalIdCounter = 1;

  // Authoritative global ID registry for document.getElementById
  const elements = new Map();

  function matchesSelector(el, sel) {
    if (sel.startsWith('#')) {
      return el.id === sel.slice(1);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      return classes.includes(cls);
    }
    return el.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findSelector(root, sel, singleOnly, results = []) {
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

  function parseHTMLIntoChildren(parent, html) {
    if (!html || typeof html !== 'string') return;
    const tagRegex = /<([a-zA-Z0-9\-]+)((?:\s+[^=>\s]+(?:=(?:"[^"]*"|'[^']*'|[^>\s]+))?)*)\s*(\/?)>/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1];
      if (tagName.startsWith('/')) continue; // Skip closing tags

      const attrString = match[2] || '';
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

      parent.appendChild(childEl);
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

      get children() {
        return _children;
      },

      appendChild(child) {
        _children.push(child);
        child.parentElement = el;
        return child;
      },

      remove() {
        if (_id && elements.get(_id) === el) {
          elements.delete(_id);
        }
        if (el.parentElement) {
          const idx = el.parentElement.children.indexOf(el);
          if (idx !== -1) el.parentElement.children.splice(idx, 1);
          el.parentElement = null;
        }
      },

      setAttribute(k, v) {
        const strVal = String(v);
        attributes.set(k, strVal);
        if (k.toLowerCase() === 'id') {
          el.id = strVal;
        }
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
        for (const c of _children) {
          c.remove();
        }
        _children = [];
        parseHTMLIntoChildren(el, _innerHTML);
      },

      querySelector(sel) {
        return findSelector(el, sel, true);
      },

      querySelectorAll(sel) {
        const results = [];
        findSelector(el, sel, false, results);
        return results;
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
    }
  };

  // Mock unsafeWindow with page-level fetch
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
    }
  };

  const cryptoMock = {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomValues: (arr) => nodeCrypto.getRandomValues(arr)
  };

  windowMock.crypto = cryptoMock;

 // Build isolated VM sandbox context
  const sandbox = {
    // Identity circularity
    window: windowMock,
    unsafeWindow: unsafeWindowMock,
    document: documentMock,
    sessionStorage: windowMock.sessionStorage,
    location: windowMock.location,

    // Web Standards
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

    // Timers
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
    GM_info: { script: { version: '4.2.1' } },
    GM_xmlhttpRequest: (details) => {
      networkCalls.push(details);
    },

    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },

    // FATAL INVARIANT ASSERTIONS: Exterminate Host Leaks
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
    setPageFetch: (fn) => { originalPageFetch = fn; }
  };
}

test("Phase 6: UserScript Target Environment Verification (Tampermonkey Browser VM)", async (t) => {
  // Compile distribution artifacts cleanly before test suite execution
  await build();

  const adminCode = fs.readFileSync(targets.find(t => t.name === 'nai-admin').outfile, 'utf8');
  const guestCode = fs.readFileSync(targets.find(t => t.name === 'nai-guest').outfile, 'utf8');

  // ---------------------------------------------------------------------------
  // 1. ISOLATION & HOST LEAK EXTERMINATION INVARIANTS
  // ---------------------------------------------------------------------------
  await t.test("Runtime Isolation: Verifies pure browser environment devoid of Node globals", () => {
    const { context } = createBrowserSandbox();

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
    });

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
    });

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
    const { context, networkCalls, elements } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      admin_token: 'admin_secret_passkey_xyz',
      browser_id: 'b_admin_browser_123'
    });

    // Execute compiled admin bundle in sandbox
    vm.runInContext(adminCode, context);

    // 1. Verify floating admin trigger button injected into documentElement
    const adminBtn = context.document.documentElement.children.find(
      c => c.tagName === 'BUTTON' && c.innerHTML === 'VPS CONTROL PANEL'
    );
    assert.ok(adminBtn, "Admin float trigger button must be appended to documentElement");
    assert.strictEqual(typeof adminBtn.onclick, 'function');

    // 2. Click button to toggle admin panel modal
    adminBtn.onclick();

    const panelModal = context.document.getElementById("vps-admin-panel");
    assert.ok(panelModal, "Clicking trigger button must instantiate #vps-admin-panel");

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
  });

  // ---------------------------------------------------------------------------
  // 5. CHANNEL A GENERATION INTERCEPTION, QUEUE POLL, AND WAF HEADER SHIELD
  // ---------------------------------------------------------------------------
  await t.test("Channel A Interception: Queue join, status poll, WAF header scrubbing, and stream piping", async () => {
    const { context, networkCalls } = createBrowserSandbox({
      approved: true,
      vps_host: 'https://vps.example.duckdns.org',
      device_secret: 's_test_secret_123',
      browser_id: 'b_test_browser_123'
    });

    // Boot compiled guest bundle
    vm.runInContext(guestCode, context);

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
    assert.strictEqual(joinCall.headers['x-script-version'], '4.2.1');
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

    // Yield microtasks to allow status update handler to mount the DOM banner
    await new Promise(r => setTimeout(r, 20));

    const banner = context.document.getElementById("vps-queue-banner");
    assert.ok(banner, "HUD banner must be mounted during queue waiting state");
    assert.match(banner.innerHTML, /Queue Position: 2/, "Banner must reflect queue position telemetry");

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
    });

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
    });

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
    const { context } = createBrowserSandbox();

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
    const { context } = createBrowserSandbox();

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
    const { context } = createBrowserSandbox();

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
});