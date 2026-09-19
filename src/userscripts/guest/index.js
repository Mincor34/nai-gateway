/**
 * NOVELAI SPLIT-TOKEN GATEWAY COORDINATOR (GUEST CLIENT)
 * Architecture Level 4: Client State Coordinator, Telemetry HUD, & Settings Portal
 *
 * Implements client-side metadata spoofing (Opus subscription mapping) and 
 * redirects generation operations to the VPS coordinate gateway.
 *
 * PROCESS FLOW:
 * 1. Generates unique identities and stores them in sandbox memory (GM_setValue).
 * 2. Authenticates queries using bearer token parameters.
 * 3. Hijacks unsafeWindow.fetch calls to mock tier-specific capabilities.
 * 4. Extends image request lifecycles to complete validation queue phases 
 *    before passing raw data streams up to the secure VPS.
 * 5. Manages in-band diagnostic intent signaling over the bilateral consent gate.
 *
 * DESIGN PRINCIPLES:
 * 1. Dedicated Single Presentation Portal: Eliminates redundant user settings sidebar tabs, centralizing
 *    all guest configurations into the modal invoked strictly by #gw-nav-badge and styled using NovelAI CSS variables.
 * 2. Complete HUD Self-Service: Preserves full visibility of Anlas balances, generation limits,
 *    refill countdowns, hardware footprint links, and gateway destination settings.
 * 3. Strict Input Defense: Client-side regex sanitization prevents malformed nicknames from hitting SQLite.
 * 4. High-Frequency UI Enforcement: Fights React SPA DOM purges by holding a 50ms verification
 *    loop during zero-state onboarding.
 * 5. Dynamic Design-Token Harmonization: Automatically applies NovelAI CSS custom properties.
 */

'use strict';

import { generateUUID } from '../shared/crypto.js';
import { backgroundRequest } from '../shared/network.js';
import {
  injectWarningBadge,
  removeWarningBadge,
  updateAllowanceBar,
  initDOMObserver
} from '../shared/ui.js';
import { initInterceptor } from '../shared/interceptor.js';

console.log("Nai-Guest: Script injected successfully at document-start.");

let browserId = GM_getValue("browser_id");
let deviceSecret = GM_getValue("device_secret");
let approved = GM_getValue("approved", false);
let VPS_HOST = GM_getValue("vps_host", "");

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

// High-frequency UI enforcement loop (forces UI overlay to stay mounted and visible)
// React's virtual DOM reconciliation frequently cleans unmanaged nodes during SPA boot;
// this 50ms polling loop forces the setup wizard back into the DOM until registration completes.
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
            overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:var(--theme-bg0, #121212) !important; color:var(--theme-text, #fff) !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:inherit !important;";
            document.body.appendChild(overlay);
            renderSetupWizard(overlay);
        }
    }, 50);
}

/**
 * Setup Wizard UI updated to explicitly instruct guests on Discord slash command usage.
 *
 * @param {HTMLElement} container - Outer viewport overlay mount.
 */
function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card")) return;
    
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
            step1Status.innerHTML = "✗ Domain cannot be empty.";
            return;
        }
        if (!/^https?:\/\//i.test(val)) {
            val = "https://" + val;
        }

        step1Status.style.display = "block";
        step1Status.style.color = "var(--theme-warning, #f39c12)";
        step1Status.innerHTML = "Connecting to server...";

        try {
            // Connection evaluation ping targeting the gateway authorization endpoint
            const res = await backgroundRequest({
                method: "GET",
                url: `${val}/auth/status?browser_id=ping`
            });
            if (res.status > 0) {
                step1Status.style.color = "var(--theme-success, #2ecc71)";
                step1Status.innerHTML = "✓ Connected to Gateway!";
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
            step1Status.innerHTML = "✗ Connection failed. Ensure domain is correct and reachable.";
        }
    }

    async function registerNicknameAction() {
        const newNickname = nicknameInput.value.trim();
        if (!newNickname) {
            step2Status.style.display = "block";
            step2Status.style.color = "var(--theme-error, #e74c3c)";
            step2Status.innerHTML = "✗ Nickname cannot be empty.";
            return;
        }
        if (!/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
            step2Status.style.display = "block";
            step2Status.style.color = "var(--theme-error, #e74c3c)";
            step2Status.innerHTML = "✗ Nickname cannot contain special characters.";
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
                step2Status.innerHTML = "✓ Registered nickname successfully!";
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
            step2Status.innerHTML = "✗ Registration failed on server.";
        }
    }

    function showStep3() {
        step3Content.innerHTML = `
            <p style="margin: 0 0 10px 0; font-weight: bold; color: var(--theme-text, #fff);">Register This Device Natively on Discord:</p>
            <p style="margin: 0 0 10px 0; color: var(--theme-textSecondary, #bbb); line-height: 1.4;">Copy the Browser ID below, navigate to your server, and register using this command:</p>
            <div style="background:var(--theme-bg0, #111); padding:10px; border-radius:4px; font-family:monospace; font-size:11px; word-break:break-all; border:1px solid var(--theme-bg2, #333); margin-bottom:10px; color:var(--theme-warning, #f39c12); text-align:center; font-weight:bold;">
                /link browser_id:${browserId}
            </div>
            <p style="margin:0; color:var(--theme-textSecondary, #888); font-size:11px; text-align:center; animation: vpsFader 1.5s infinite alternate;">⏳ Polling approval status from Discord registration...</p>
            <style>@keyframes vpsFader { 0% { opacity: 0.3; } 100% { opacity: 1; } }</style>
        `;

        // Verification short-polling loop
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
                    // Server deleted this device. Silently re-register to re-appear in the admin panel.
                    console.warn("Nai-Guest: Server returned 401 during poll. Re-registering silently...");
                    const nickname = GM_getValue("device_nickname", "Guest");
                    backgroundRequest({
                        method: "POST",
                        url: `${validatedHost}/auth/register`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
                    }).catch(err => console.error("Nai-Guest: Silent re-registration failed:", err));
                }
            } catch (err) {
                console.error("Setup wizard poll error:", err);
            }
        };
        setInterval(checkAuth, 5000);
    }

    verifyBtn.onclick = verifyDomainAction;
    registerBtn.onclick = registerNicknameAction;

    if (validatedHost) {
        domainInput.value = validatedHost;
        step1Status.style.display = "block";
        step1Status.style.color = "var(--theme-success, #2ecc71)";
        step1Status.innerHTML = "✓ Connected";
        domainInput.disabled = true;
        verifyBtn.disabled = true;
        step2Container.style.display = "block";
        
        if (validatedNickname) {
            nicknameInput.value = validatedNickname;
            step2Status.style.display = "block";
            step2Status.style.color = "var(--theme-success, #2ecc71)";
            step2Status.innerHTML = "✓ Registered";
            nicknameInput.disabled = true;
            registerBtn.disabled = true;
            step3Container.style.display = "block";
            showStep3();
        }
    }
}

// ----------------- RUNTIME BOOTSTRAP -----------------
if (!approved || !VPS_HOST) {
    startUIEnforcement();
} else {
    initInterceptor({ 
        browserId, 
        deviceSecret, 
        VPS_HOST, 
        logPrefix: 'Nai-Guest',
        onRevoked: () => {
            const nickname = GM_getValue("device_nickname", "Guest");
            backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/auth/register`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
            }).finally(() => {
                if (typeof window !== 'undefined' && window.location) {
                    window.location.reload();
                }
            });
        }
    });

    // Background Telemetry Poller: updates the allowance bar when mounted
    function startStatePolling() {
        const poll = async () => {
            // Defensively exit if the allowance bar is not mounted in the current viewport
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
                }
            } catch (e) {
                console.error("Nai-Guest: Failed to poll session state", e);
            }
        };
        // Schedule interval cleanly without an unprompted top-level synchronous execution
        setInterval(poll, 10000);
    }

    /**
     * Standalone Settings Modal styled using NovelAI CSS variables.
     */
    async function openSettingsModal() {
        let modal = document.getElementById("vps-settings-modal");
        let backdrop = document.getElementById("vps-settings-backdrop");
        if (modal) {
            modal.remove();
            if (backdrop) backdrop.remove();
            return;
        }

        backdrop = document.createElement("div");
        backdrop.id = "vps-settings-backdrop";
        backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); backdrop-filter:blur(2px); z-index:99998;";
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
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
        `.replace(/\s+/g, ' ').trim();
        
        renderSettingsPanelContent(modal, () => {
            modal.remove();
            backdrop.remove();
        });

        document.documentElement.appendChild(modal);
    }

    /**
     * Renders the complete guest settings dashboard matching NovelAI design system tokens.
     * Mounts DOM elements synchronously and hydrates telemetry asynchronously.
     *
     * @param {HTMLElement} container - Mount destination.
     * @param {Function} [onClose] - Close callback.
     */
    function renderSettingsPanelContent(container, onClose) {
        const nickname = GM_getValue("device_nickname", "Guest");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const imageCount = GM_getValue("count_image_gens", 0);
        const textCount = GM_getValue("count_text_gens", 0);

        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--theme-bg2, #333); padding-bottom:10px; margin-bottom:12px;">
                <h4 style="margin:0; color:var(--theme-accent, #00bc8c); font-size:15px; font-weight:bold; letter-spacing:0.5px;">GATEWAY COORDINATOR (GUEST)</h4>
                ${onClose ? `<button id="guest-close-modal-btn" style="background:none; border:none; color:var(--theme-textSecondary, #888); font-size:18px; cursor:pointer; line-height:1;">✕</button>` : ''}
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
                    <input type="checkbox" id="settings-debug" ${debugActive ? 'checked' : ''} style="cursor:pointer;">
                    ENABLE DIAGNOSTIC PROMPT DEBUGGING
                </label>
                <div id="debug-intent-status" style="margin-top:4px; font-size:10px;">${debugActive ? '✓ Intent active. Awaiting admin authorization.' : 'Disabled'}</div>
                <div id="debug-consent" style="color:var(--theme-textSecondary, #999); margin-top:6px; line-height:1.4; background:var(--theme-bg1, #222); padding:8px; border-radius:4px; border-left:2px solid var(--theme-warning, #f39c12); font-size:10px;">
                    <strong>Privacy transparency:</strong> Enabling debugging uploads raw generation payloads to gateway logs for performance troubleshooting. Text prompt contexts, settings, and resolutions will be saved on the VPS. Personal tokens and encrypted databases remain strictly isolated.
                </div>
            </div>
        `;

        if (onClose) {
            const closeBtn = container.querySelector("#guest-close-modal-btn");
            if (closeBtn) closeBtn.onclick = onClose;
        }

        // Asynchronous Telemetry Hydration
        if (domain && deviceSecret) {
            backgroundRequest({
                method: "GET",
                url: `${domain}/auth/status?browser_id=${browserId}`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            }).then(res => {
                if (res.status === 200) {
                    const data = JSON.parse(res.responseText);
                    const tierEl = container.querySelector("#guest-assigned-tier");
                    if (tierEl) tierEl.textContent = data.tier || "Normal";
                    const refEl = container.querySelector("#guest-precise-limit");
                    if (refEl) refEl.textContent = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} Refs`;
                    const anlasEl = container.querySelector("#guest-anlas-consumed");
                    if (anlasEl) anlasEl.textContent = `${data.anlas_consumed || 0} Anlas`;
                    
                    const sessionEl = container.querySelector("#guest-rolling-allowance");
                    if (sessionEl) {
                        if (data.session) {
                            const allowance = data.session.allowance;
                            const maxAllowance = data.session.max || 100;
                            const refillInMins = (data.session.next_refill_in / 1000 / 60).toFixed(1);
                            const refillText = allowance < maxAllowance ? `(+1 in ${refillInMins}m)` : '(Full)';
                            sessionEl.innerHTML = `<span style="color:var(--theme-success, #2ecc71); font-weight:bold;">${allowance}/${maxAllowance} Images</span> <span style="font-size:9px; color:var(--theme-textSecondary, #aaa);">${refillText}</span>`;
                        } else {
                            sessionEl.innerHTML = `<span style="color:var(--theme-accent, #00bc8c); font-weight:bold;">Exempt (Unlimited)</span>`;
                        }
                    }

                    const devicesEl = container.querySelector("#guest-linked-devices");
                    if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
                        devicesEl.innerHTML = data.linked_devices.map(d => `- \`${d.id.substring(0, 10)}...\` (${d.label})`).join('<br>');
                    }

                    const debugStatus = container.querySelector("#debug-intent-status");
                    if (debugStatus) {
                        if (data.debug_authorized) {
                            const mins = (data.debug_expires_in_ms / 60000).toFixed(1);
                            debugStatus.innerHTML = `<span style="color:var(--theme-success, #2ecc71); font-weight:bold;">🟢 Authorized by Administrator (${mins}m remaining)</span>`;
                        } else if (data.debug_intent) {
                            debugStatus.innerHTML = `<span style="color:var(--theme-warning, #f39c12); font-weight:bold;">⏳ Intent Active. Waiting for Administrator Authorization.</span>`;
                        } else {
                            debugStatus.innerHTML = `<span style="color:var(--theme-textSecondary, #888);">Disabled</span>`;
                        }
                    }
                }
            }).catch(() => {});
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
                nickStatus.innerHTML = "✗ Invalid nickname characters.";
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
                    nickStatus.innerHTML = "✓ Nickname updated successfully!";
                    GM_setValue("device_nickname", newNickname);
                } else {
                    throw new Error("Update failed");
                }
            } catch (err) {
                nickStatus.style.color = "var(--theme-error, #e74c3c)";
                nickStatus.innerHTML = "✗ Failed to update nickname on VPS.";
            }
        };

        saveDomBtn.onclick = () => {
            let val = domInput.value.trim().replace(/\/+$/, "");
            if (!val) return;
            if (!/^https?:\/\//i.test(val)) val = "https://" + val;
            GM_setValue("vps_host", val);
            GM_setValue("approved", false);
            if (typeof onClose === 'function') onClose();
            window.location.reload();
        };

        debugCheckbox.onchange = async () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("⚠️ VPS DEBUG INTENT ACTIVE", "var(--theme-warning, #e67e22)");
            else removeWarningBadge();

            debugIntentStatus.style.display = "block";
            debugIntentStatus.style.color = "var(--theme-warning, #f39c12)";
            debugIntentStatus.innerHTML = checked 
                ? "⏳ Synchronizing diagnostic debug intent with gateway..." 
                : "⏳ Revoking diagnostic debug intent on gateway...";

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
                        const mins = (data.expires_in_ms / 60000).toFixed(1);
                        debugIntentStatus.style.color = "var(--theme-success, #2ecc71)";
                        debugIntentStatus.innerHTML = `✓ Authorized by Administrator (${mins}m remaining). Telemetry logging active.`;
                    } else if (checked) {
                        debugIntentStatus.style.color = "var(--theme-warning, #f39c12)";
                        debugIntentStatus.innerHTML = "✓ Intent registered on gateway. Awaiting administrator authorization.";
                    } else {
                        debugIntentStatus.style.color = "var(--theme-textSecondary, #888)";
                        debugIntentStatus.innerHTML = "✓ Diagnostic debug intent revoked. Logging disabled.";
                    }
                } else {
                    throw new Error("Synchronization rejected");
                }
            } catch (err) {
                debugIntentStatus.style.color = "var(--theme-error, #e74c3c)";
                debugIntentStatus.innerHTML = "✗ Failed to synchronize debug intent with gateway.";
            }
        };
    }

    initDOMObserver({
        onOpenSettings: openSettingsModal
    });

    startStatePolling();
}