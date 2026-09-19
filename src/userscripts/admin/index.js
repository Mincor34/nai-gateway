/**
 * NOVELAI SPLIT-TOKEN GATEWAY COORDINATOR (ADMIN PANEL)
 * Architecture Level 4: Administrative UI, Device Management, and Token Injector
 *
 * Implements a high-security control and telemetry layout on top of the NovelAI Single Page App (SPA).
 * Intercepts outbound generation requests, manages dynamic FIFO queuing, executes secure token swaps,
 * and coordinates the bilateral mutual-consent diagnostic debug authorization gate.
 *
 * SECURITY DESIGN PRINCIPLES:
 * 1. Privileged Background Transport: Outbound requests targeting the VPS `/proxy/`, `/queue/`, and `/admin/`
 *    endpoints are routed using Tampermonkey's privileged background context (`GM_xmlhttpRequest`). This breaks
 *    through local Content Security Policy (CSP) headers served by novelai.net that would otherwise block
 *    connection sockets to your external gateway domain.
 * 2. High-Frequency UI Enforcement: NovelAI's React SPA aggressively cleans unmanaged DOM nodes during
 *    early render passes. Holds a 50ms polling loop during initial onboarding to guarantee the setup wizard
 *    stays mounted until valid administrative passkeys are verified.
 * 3. Authoritative Governance: Exposes immediate approval, revocation, tier assignment, hardware pruning,
 *    and permanent account banishment tools directly within the SPA viewport.
 * 4. Master Credential Injection: Directly pushes the paid account's Bearer session token to SQLite storage.
 * 5. Dedicated Single Presentation Portal: Eliminates redundant user settings sidebar tabs, housing both
 *    Device Governance and Operator Personal Settings (Debug Mode, VPS host, and Nickname) in a unified modal
 *    invoked strictly by #gw-nav-badge and styled using NovelAI CSS custom properties.
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

let browserId = GM_getValue("browser_id");
let deviceSecret = GM_getValue("admin_token"); // Admin uses system key directly as secret
let approved = GM_getValue("approved", false);
let VPS_HOST = GM_getValue("vps_host", "");
let currentSort = GM_getValue("admin_sort_mode", "anlas"); // Persistence across browser refreshes
let activeSubTab = "governance"; // "governance" | "settings"
const expandedKeys = new Set(); // Stores collapsible states of client groups (RAM-only)

try {
    if (!browserId) {
        browserId = 'b_' + generateUUID();
        GM_setValue("browser_id", browserId);
    }
} catch (err) {
    console.error("Nai-Admin: Storage initialization crash:", err);
}

// High-frequency UI enforcement loop (forces UI overlay to stay mounted and visible during initial config)
// React's virtual DOM reconciliation frequently cleans unmanaged nodes during SPA boot;
// this 50ms polling loop forces the setup wizard back into the DOM until registration completes.
let enforcementInterval = null;

function startUIEnforcement() {
    if (enforcementInterval) return;
    console.log("Nai-Admin: Starting high-frequency UI enforcement loop...");
    enforcementInterval = setInterval(() => {
        if (!document.body) return; // Wait for document body to construct

        let overlay = document.getElementById("vps-approval-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "vps-approval-overlay";
            overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:var(--theme-bg0, #121212) !important; color:var(--theme-text, #fff) !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:inherit !important;";
            document.body.appendChild(overlay);
            renderSetupWizard(overlay);
        }
    }, 50);
}

/**
 * Renders the administrative setup configuration wizard.
 *
 * @param {HTMLElement} container - Outer viewport mount target.
 */
function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card")) return;
    
    container.innerHTML = `
        <div class="setup-wizard-card" style="background:var(--theme-bg1, #1c1c1c); padding:35px; border-radius:8px; border:1px solid var(--theme-error, #c0392b); box-shadow:0 8px 30px rgba(0,0,0,0.6); max-width:90vw; width:420px; box-sizing:border-box; color:var(--theme-text, #fff); font-family:inherit;">
            <h3 style="margin:0 0 15px 0; color:var(--theme-accent, #00bc8c); text-align:center; letter-spacing:1px; font-size:18px;">GATEWAY COORDINATOR SETUP (ADMIN)</h3>
            
            <!-- Gateway Domain Configuration -->
            <div id="step-1-container" style="margin-bottom:20px;">
                <label style="display:block; font-size:12px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">STEP 1: ENTER GATEWAY DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-domain" value="${GM_getValue("vps_host", "")}" placeholder="https://your-domain.duckdns.org" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:12px; border-radius:4px; font-family:inherit;">
                    <button id="btn-verify-domain" style="background:var(--theme-accent, #2980b9); border:none; color:var(--theme-bg0, #fff); padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Verify</button>
                </div>
                <div id="step-1-status" style="margin-top:5px; font-size:11px; display:none;"></div>
            </div>

            <!-- Nickname Configuration -->
            <div id="step-2-container" style="margin-bottom:20px; display:none;">
                <label style="display:block; font-size:12px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">STEP 2: ENTER NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="setup-nickname" value="${GM_getValue("device_nickname", "")}" placeholder="e.g. Admin" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:12px; border-radius:4px; font-family:inherit;">
                    <button id="btn-register-nickname" style="background:var(--theme-success, #27ae60); border:none; color:var(--theme-bg0, #fff); padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Register</button>
                </div>
                <div id="step-2-status" style="margin-top:5px; font-size:11px; display:none;"></div>
            </div>

            <!-- Admin Passkey Verification -->
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
            // Verification ping to confirm domain connection path is alive
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
        if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
            step2Status.style.display = "block";
            step2Status.style.color = "var(--theme-error, #e74c3c)";
            step2Status.innerHTML = "✗ Invalid nickname characters.";
            return;
        }

        step2Status.style.display = "block";
        step2Status.style.color = "var(--theme-warning, #f39c12)";
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
                step2Status.style.color = "var(--theme-success, #2ecc71)";
                step2Status.innerHTML = "✓ Registered nickname successfully!";
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
            step2Status.style.color = "var(--theme-error, #e74c3c)";
            step2Status.innerHTML = "✗ Registration failed on server.";
        }
    }

    function showStep3() {
        step3Content.innerHTML = `
            <div style="margin-bottom:10px;">Your device is registered! Enter your Admin Passkey to authenticate this admin terminal:</div>
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <input type="password" id="setup-admin-key" placeholder="Enter admin passkey..." style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:12px; border-radius:4px; font-family:inherit;">
                <button id="btn-verify-admin" style="background:var(--theme-error, #e74c3c); border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Verify</button>
            </div>
            <div id="admin-verify-status" style="font-size:11px; margin-top:5px; display:none;"></div>
        `;

        const adminKeyInput = step3Content.querySelector("#setup-admin-key");
        const verifyAdminBtn = step3Content.querySelector("#btn-verify-admin");
        const adminStatus = step3Content.querySelector("#admin-verify-status");

        verifyAdminBtn.onclick = async () => {
            const passkey = adminKeyInput.value.trim();
            if (!passkey) {
                adminStatus.style.display = "block";
                adminStatus.style.color = "var(--theme-error, #e74c3c)";
                adminStatus.innerHTML = "✗ Passkey cannot be empty.";
                return;
            }
            adminStatus.style.display = "block";
            adminStatus.style.color = "var(--theme-warning, #f39c12)";
            adminStatus.innerHTML = "Verifying passkey...";

            try {
                const res = await backgroundRequest({
                    method: "GET",
                    url: `${validatedHost}/admin/devices`,
                    headers: { "Authorization": `Bearer ${passkey}` }
                });
                if (res.status === 200) {
                    adminStatus.style.color = "var(--theme-success, #2ecc71)";
                    adminStatus.innerHTML = "✓ Authenticated! Reloading...";
                    GM_setValue("admin_token", passkey);
                    GM_setValue("approved", true);
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    throw new Error("Invalid key");
                }
            } catch (err) {
                adminStatus.style.color = "var(--theme-error, #e74c3c)";
                adminStatus.innerHTML = "✗ Invalid Admin Passkey.";
            }
        };
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
if (!approved || !VPS_HOST || !deviceSecret) {
    startUIEnforcement();
} else {
    initInterceptor({ 
        browserId, 
        deviceSecret, 
        VPS_HOST, 
        logPrefix: 'Nai-Admin',
        onRevoked: () => {
            setTimeout(() => {
                if (typeof window !== 'undefined' && window.location) {
                    window.location.reload();
                }
            }, 500);
        }
    });

    /**
     * Standalone Themed Modal Portal for Administrator.
     * Invoked strictly by #gw-nav-badge. Styled using NovelAI CSS custom properties.
     */
    function openAdminModal() {
        let modal = document.getElementById("vps-admin-panel");
        let backdrop = document.getElementById("vps-admin-backdrop");
        if (modal) {
            modal.remove();
            if (backdrop) backdrop.remove();
            return;
        }

        backdrop = document.createElement("div");
        backdrop.id = "vps-admin-backdrop";
        backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); backdrop-filter:blur(2px); z-index:99998;";
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
        document.documentElement.appendChild(backdrop);

        modal = document.createElement("div");
        modal.id = "vps-admin-panel";
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
        document.documentElement.appendChild(modal);

        renderAdminUnifiedView(modal, () => {
            modal.remove();
            backdrop.remove();
        });
    }

    /**
     * Renders the complete, dual-tab unified administration console.
     * Integrates Device Governance and Operator Personal Settings (Debug Mode, Domain, Nickname).
     *
     * @param {HTMLElement} container - Mount target element.
     * @param {Function} [onClose] - Close callback.
     */
    function renderAdminUnifiedView(container, onClose) {
        if (!container) return;

        const isGovernance = activeSubTab === "governance";

        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--theme-bg2, #333); padding-bottom:10px; margin-bottom:12px;">
                <h4 style="margin:0; color:var(--theme-accent, #00bc8c); font-size:15px; font-weight:bold; letter-spacing:0.5px;">GATEWAY COORDINATOR (ADMIN)</h4>
                ${onClose ? `<button id="admin-close-modal-btn" style="background:none; border:none; color:var(--theme-textSecondary, #888); font-size:18px; cursor:pointer; line-height:1;">✕</button>` : ''}
            </div>

            <!-- Sub-Tab Navigation Bar -->
            <div style="display:flex; gap:8px; margin-bottom:15px; border-bottom:1px solid var(--theme-bg2, #222); padding-bottom:8px;">
                <button id="admin-tab-governance" style="flex:1; padding:6px 10px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; border:1px solid ${isGovernance ? 'var(--theme-accent, #c0392b)' : 'transparent'}; background:${isGovernance ? 'var(--theme-bg2, #222)' : 'var(--theme-bg1, #111)'}; color:var(--theme-text, #fff); transition:background 0.2s; font-family:inherit;">
                    Device Governance
                </button>
                <button id="admin-tab-settings" style="flex:1; padding:6px 10px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; border:1px solid ${!isGovernance ? 'var(--theme-accent, #c0392b)' : 'transparent'}; background:${!isGovernance ? 'var(--theme-bg2, #222)' : 'var(--theme-bg1, #111)'}; color:var(--theme-text, #fff); transition:background 0.2s; font-family:inherit;">
                    Operator Settings
                </button>
            </div>

            <div id="admin-tab-content"></div>
        `;

        if (onClose) {
            const closeBtn = container.querySelector("#admin-close-modal-btn");
            if (closeBtn) closeBtn.onclick = onClose;
        }

        const govBtn = container.querySelector("#admin-tab-governance");
        const setBtn = container.querySelector("#admin-tab-settings");

        govBtn.onclick = () => {
            activeSubTab = "governance";
            renderAdminUnifiedView(container, onClose);
        };

        setBtn.onclick = () => {
            activeSubTab = "settings";
            renderAdminUnifiedView(container, onClose);
        };

        const contentHost = container.querySelector("#admin-tab-content");
        if (isGovernance) {
            renderGovernanceTab(contentHost, container, onClose);
        } else {
            renderOperatorSettingsTab(contentHost, onClose);
        }
    }

    /**
     * Sub-Tab 1: Device Governance & Master Session Token Injector.
     *
     * @param {HTMLElement} contentHost - Inner content container.
     * @param {HTMLElement} parentContainer - Outer dialog container.
     * @param {Function} [onClose] - Close handler.
     */
    async function renderGovernanceTab(contentHost, parentContainer, onClose) {
        contentHost.innerHTML = `
            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:5px; text-transform:uppercase;">MASTER NOVELAI SESSION TOKEN</label>
                <input type="password" id="vps-master-token-input" placeholder="Bearer jti_..." style="width:100%; background:var(--theme-bg1, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:8px; font-size:11px; border-radius:4px; box-sizing:border-box; font-family:inherit;">
                <button id="vps-btn-push-token" style="background:var(--theme-success, #27ae60); border:none; color:var(--theme-bg0, #fff); padding:8px 12px; margin-top:8px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:4px; width:100%; font-family:inherit;">PUSH TO VPS STORAGE</button>
            </div>

            <div style="border-top:1px solid var(--theme-bg2, #333); padding-top:12px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:8px; text-transform:uppercase;">VERIFIED SYSTEM ACCOUNTS</label>
                
                <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:10px; background:var(--theme-bg1, #111); padding:6px; border-radius:4px; border:1px solid var(--theme-bg2, #222);">
                    <span style="color:var(--theme-textSecondary, #666);">Sort by:</span>
                    <a href="#" class="sort-trigger" data-sort="anlas" style="color: ${currentSort === 'anlas' ? 'var(--theme-accent, #00bc8c); font-weight:bold' : 'var(--theme-textSecondary, #999)'}; text-decoration:none;">Anlas</a> |
                    <a href="#" class="sort-trigger" data-sort="reqs" style="color: ${currentSort === 'reqs' ? 'var(--theme-accent, #00bc8c); font-weight:bold' : 'var(--theme-textSecondary, #999)'}; text-decoration:none;">Reqs</a> |
                    <a href="#" class="sort-trigger" data-sort="active" style="color: ${currentSort === 'active' ? 'var(--theme-accent, #00bc8c); font-weight:bold' : 'var(--theme-textSecondary, #999)'}; text-decoration:none;">Active</a> |
                    <a href="#" class="sort-trigger" data-sort="status" style="color: ${currentSort === 'status' ? 'var(--theme-accent, #00bc8c); font-weight:bold' : 'var(--theme-textSecondary, #999)'}; text-decoration:none;">Status</a>
                </div>

                <div id="vps-client-list" style="font-size:11px; display:flex; flex-direction:column; gap:8px;">
                    Loading system records...
                </div>
            </div>
        `;

        // Handle master session token submission
        const pushBtn = contentHost.querySelector("#vps-btn-push-token");
        if (pushBtn) {
            pushBtn.onclick = async () => {
                const tk = contentHost.querySelector("#vps-master-token-input").value.trim();
                if (!tk) return;
                try {
                    const res = await backgroundRequest({
                        method: "POST",
                        url: `${VPS_HOST}/admin/update-token`,
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                        data: JSON.stringify({ master_token: tk })
                    });
                    if (res.status === 200) alert("Master Token saved securely.");
                    else alert("Token registration denied.");
                } catch (e) {
                    alert("Communication execution failed.");
                }
            };
        }

        // Attach event listeners for sort operations
        contentHost.querySelectorAll(".sort-trigger").forEach(el => {
            el.onclick = (e) => {
                e.preventDefault();
                currentSort = e.currentTarget.getAttribute("data-sort");
                GM_setValue("admin_sort_mode", currentSort);
                renderGovernanceTab(contentHost, parentContainer, onClose);
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
                const container = contentHost.querySelector("#vps-client-list");
                if (!container) return;
                if (groups.length === 0) {
                    container.innerHTML = "No clients pending registration.";
                    return;
                }

                // Execute selected sort criteria
                groups.sort((a, b) => {
                    if (currentSort === "anlas") return b.anlas_consumed - a.anlas_consumed;
                    if (currentSort === "reqs") return b.total_requests - a.total_requests;
                    if (currentSort === "active") return b.last_active_at - a.last_active_at;
                    if (currentSort === "status") return (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0);
                    return 0;
                });

                container.innerHTML = "";
                groups.forEach(group => {
                    const selectorId = group.discord_id || group.devices[0].browser_id;
                    const isLinked = !!group.discord_id;
                    const isExpanded = expandedKeys.has(selectorId);
                    
                    const el = document.createElement("div");
                    el.style.cssText = `background:var(--theme-bg1, #222); border-radius:4px; border:1px solid ${group.banned === 1 ? 'var(--theme-error, #c0392b)' : 'var(--theme-bg2, #333)'}; overflow:hidden; display:flex; flex-direction:column; transition: border-color 0.2s;`;

                    // Online/Offline & Status tags
                    const statusDotColor = group.is_online ? "var(--theme-success, #2ecc71)" : "var(--theme-textSecondary, #7f8c8d)";
                    const statusTitle = group.is_online ? "Online" : "Offline";
                    const bannedBadge = group.banned === 1 
                        ? `<span style="background:var(--theme-error, #c0392b); color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">BANNED</span>` 
                        : '';

                    // In-band debug intent badge indicator on header
                    let headerDebugBadge = '';
                    if (group.has_debug_authorized) {
                        headerDebugBadge = `<span style="background:var(--theme-success, #27ae60); color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG ACTIVE</span>`;
                    } else if (group.has_debug_intent) {
                        headerDebugBadge = `<span style="background:var(--theme-warning, #e67e22); color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG REQUESTED</span>`;
                    }

                    // Collapsed condensed header markup
                    el.innerHTML = `
                        <div class="client-card-header" data-key="${selectorId}" style="padding:10px 12px; cursor:pointer; display:flex; align-items:center; justify-content:space-between; background:var(--theme-bg0, #1e1e1e); user-select:none;">
                            <div style="display:flex; align-items:center; gap:8px; max-width:60%;">
                                <div style="width:7px; height:7px; border-radius:50%; background:${statusDotColor};" title="${statusTitle}"></div>
                                <span style="font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--theme-text, #fff);">${group.discord_username}</span>
                                ${bannedBadge}
                                ${headerDebugBadge}
                            </div>
                            <div style="font-size:10px; color:var(--theme-textSecondary, #aaa); display:flex; gap:10px; align-items:center;">
                                <span style="color:var(--theme-accent, #00bc8c); font-weight:bold;">${group.anlas_consumed}A</span>
                                <span style="color:#3498db; font-weight:bold;">${group.total_requests}R</span>
                                <span style="font-size:8px; color:var(--theme-textSecondary, #555);">${isExpanded ? '▲' : '▼'}</span>
                            </div>
                        </div>
                    `;

                    // Expanded detailed view panel
                    if (isExpanded) {
                        const body = document.createElement("div");
                        body.style.cssText = "padding:12px; border-top:1px solid var(--theme-bg2, #333); background:var(--theme-bg1, #252525); display:flex; flex-direction:column; gap:10px;";
                        
                        let devicesHtml = '';
                        group.devices.forEach(d => {
                            const devOnlineColor = d.is_online ? "var(--theme-success, #2ecc71)" : "var(--theme-textSecondary, #7f8c8d)";
                            const devBannedBadge = d.banned === 1 ? `<span style="color:var(--theme-error, #e74c3c); font-weight:bold; margin-left:4px;">(BANNED)</span>` : '';
                            const allowanceBadge = d.metered_allowance !== null ? `<span style="color:var(--theme-warning, #f39c12); font-weight:bold; margin-left:6px;">[${d.metered_allowance}/100 Imgs]</span>` : '';
                            
                            // Bilateral Debug Status Badges & Action Buttons
                            let devDebugBadge = '';
                            let devDebugBtn = '';

                            if (d.debug_authorized) {
                                const minsLeft = (d.debug_expires_in_ms / 60000).toFixed(1);
                                devDebugBadge = `<span style="background:var(--theme-success, #27ae60); color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">DEBUG ACTIVE (${minsLeft}m)</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="disarm" style="background:var(--theme-warning, #e67e22); border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:3px; font-weight:bold; font-family:inherit;">DISARM</button>`;
                            } else if (d.debug_intent) {
                                devDebugBadge = `<span style="background:var(--theme-error, #e74c3c); color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">⚠️ DEBUG REQUESTED</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="arm" style="background:#2980b9; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:3px; font-weight:bold; font-family:inherit;">AUTHORIZE (10M)</button>`;
                            }

                            devicesHtml += `
                                <div style="font-size:10px; color:var(--theme-textSecondary, #ccc); padding:6px 0; border-bottom:1px solid var(--theme-bg2, #444); display:flex; justify-content:space-between; align-items:center; gap:10px;">
                                    <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1;">
                                        <div style="width:5px; height:5px; border-radius:50%; background:${devOnlineColor};"></div>
                                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>${d.label}</strong> ${devBannedBadge}${allowanceBadge}${devDebugBadge} <code style="color:var(--theme-textSecondary, #666);">(${d.browser_id.substring(0,8)}...)</code></span>
                                    </div>
                                    <div style="display:flex; gap:4px; align-items:center;">
                                        ${devDebugBtn}
                                        <button class="btn-prune-dev" data-id="${d.browser_id}" style="background:#8e44ad; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:3px; font-weight:bold; font-family:inherit;">PRUNE</button>
                                    </div>
                                </div>
                            `;
                        });

                        const lastActiveDate = group.last_active_at > 0 ? new Date(group.last_active_at).toLocaleTimeString() : 'Never';
                        const banToggleBtn = group.banned === 1 
                            ? `<button class="btn-unban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:var(--theme-success, #27ae60); border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1; font-family:inherit;">UNBAN USER</button>`
                            : `<button class="btn-ban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:var(--theme-error, #c0392b); border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1; font-family:inherit;">BAN USER</button>`;

                        body.innerHTML = `
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:10px; color:var(--theme-textSecondary, #aaa); margin-bottom:4px;">
                                <div>Tier: <strong style="color:var(--theme-accent, #00bc8c);">${group.priority_tier}</strong></div>
                                <div>Last Active: <strong style="color:var(--theme-text, #fff);">${lastActiveDate}</strong></div>
                                <div style="grid-column: span 2;">Discord ID: <code style="background:var(--theme-bg0, #111); padding:2px 4px; border-radius:2px; color:var(--theme-textSecondary, #888);">${group.discord_id || 'Unlinked'}</code></div>
                            </div>

                            <div style="background:var(--theme-bg0, #1a1a1a); padding:8px; border-radius:4px; border:1px solid var(--theme-bg2, #333);">
                                <div style="font-weight:bold; font-size:9px; color:var(--theme-textSecondary, #555); text-transform:uppercase; margin-bottom:5px;">Hardware Footprints</div>
                                ${devicesHtml || '<div style="color:var(--theme-textSecondary, #666); font-style:italic; font-size:10px;">No hardware linked.</div>'}
                            </div>

                            <div style="display:flex; gap:6px; margin-top:4px;">
                                <select id="tier-select-${selectorId}" style="background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); font-size:10px; padding:4px 6px; border-radius:3px; font-family:inherit;">
                                    <option value="Metered" ${group.priority_tier === 'Metered' ? 'selected' : ''}>Metered</option>
                                    <option value="Low" ${group.priority_tier === 'Low' ? 'selected' : ''}>Low</option>
                                    <option value="Normal" ${group.priority_tier === 'Normal' ? 'selected' : ''}>Normal</option>
                                    <option value="High" ${group.priority_tier === 'High' ? 'selected' : ''}>High</option>
                                    <option value="Admin" ${group.priority_tier === 'Admin' ? 'selected' : ''}>Admin</option>
                                </select>
                                <button class="btn-approve-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#2980b9; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1; font-family:inherit;">APPROVE & SET</button>
                                <button class="btn-revoke-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:var(--theme-bg2, #7f8c8d); border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1; font-family:inherit;">REVOKE</button>
                                ${banToggleBtn}
                            </div>
                        `;
                        el.appendChild(body);
                    }

                    container.appendChild(el);
                });

                // Expand/collapse click events
                contentHost.querySelectorAll(".client-card-header").forEach(h => {
                    h.onclick = (e) => {
                        const key = e.currentTarget.getAttribute("data-key");
                        if (expandedKeys.has(key)) expandedKeys.delete(key);
                        else expandedKeys.add(key);
                        renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                // Bilateral Debug Arm/Disarm Action Button
                contentHost.querySelectorAll(".btn-toggle-debug").forEach(b => {
                    b.onclick = async (e) => {
                        const bid = e.currentTarget.getAttribute("data-id");
                        const action = e.currentTarget.getAttribute("data-action");
                        const enable = action === "arm";

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/debug-target`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify({ browser_id: bid, enable, ttl_ms: 600000 })
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                // Hardened action buttons utilizing e.currentTarget to bypass inner-node click tracking anomalies
                contentHost.querySelectorAll(".btn-approve-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const tierSelect = contentHost.querySelector(`#tier-select-${key}`);
                        const tier = tierSelect ? tierSelect.value : 'Normal';
                        
                        const payload = isDiscord ? { discord_id: key, priority_tier: tier } : { browser_id: key, priority_tier: tier };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/approve`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                contentHost.querySelectorAll(".btn-revoke-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        if (!confirm(`Are you sure you want to revoke authorization for ${key}?`)) return;

                        const payload = isDiscord ? { discord_id: key } : { browser_id: key };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/revoke`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                contentHost.querySelectorAll(".btn-ban-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const reason = prompt("Enter a reason for banning this client:");
                        if (reason === null) return;

                        const payload = isDiscord ? { discord_id: key, reason } : { browser_id: key, reason };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/ban`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                contentHost.querySelectorAll(".btn-unban-group").forEach(b => {
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
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                contentHost.querySelectorAll(".btn-prune-dev").forEach(b => {
                    b.onclick = async (e) => {
                        const bid = e.currentTarget.getAttribute("data-id");
                        if (!confirm(`Are you sure you want to permanently delete device registration: ${bid}?`)) return;

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/prune-device`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify({ browser_id: bid })
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });
            }
        } catch (e) {
            const container = contentHost.querySelector("#vps-client-list");
            if (container) container.innerHTML = "Error retrieving system data records.";
        }
    }

    /**
     * Sub-Tab 2: Operator Personal Profile, Nickname, Domain, and Debug Mode Consent.
     * Synchronously renders the DOM shell from local persistent memory; hydrates telemetry asynchronously.
     *
     * @param {HTMLElement} contentHost - Inner content container.
     * @param {Function} [onClose] - Close handler.
     */
    function renderOperatorSettingsTab(contentHost, onClose) {
        const nickname = GM_getValue("device_nickname", "Admin");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const imageCount = GM_getValue("count_image_gens", 0);
        const textCount = GM_getValue("count_text_gens", 0);

        // Synchronous DOM Mounting: Guarantees zero latency and instantaneous input availability
        contentHost.innerHTML = `
            <div style="background:var(--theme-bg1, #111); padding:12px; border-radius:6px; margin-bottom:12px; border:1px solid var(--theme-bg2, #333); font-size:11px; line-height:1.6;">
                <label style="display:block; font-size:9px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:6px; text-transform:uppercase;">Operator Telemetry & Profile</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>Assigned Tier: <span style="color:var(--theme-accent, #00bc8c); font-weight:bold;">Admin</span></div>
                    <div>Precise Ref Limit: <span id="operator-precise-limit" style="color:var(--theme-warning, #f39c12); font-weight:bold;">Unlimited</span></div>
                    <div>Anlas Consumed: <span id="operator-anlas-consumed" style="color:var(--theme-error, #e74c3c); font-weight:bold;">0 Anlas</span></div>
                    <div>Rolling Allowance: <span style="color:var(--theme-accent, #00bc8c); font-weight:bold;">Exempt (Unlimited)</span></div>
                    <div>Image Gens: <span style="font-weight:bold;">${imageCount}</span></div>
                    <div>Text Gens: <span style="font-weight:bold;">${textCount}</span></div>
                </div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">ADMIN NICKNAME</label>
                <div style="display:flex; gap:8px;">
                    <input type="text" id="settings-nickname" value="${nickname}" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:6px; font-size:11px; border-radius:4px; font-family:inherit;">
                    <button id="btn-save-nickname" style="background:var(--theme-success, #27ae60); border:none; color:var(--theme-bg0, #fff); padding:6px 12px; font-size:10px; font-weight:bold; cursor:pointer; border-radius:4px; font-family:inherit;">Save</button>
                </div>
                <div id="settings-nickname-status" style="font-size:10px; margin-top:3px; display:none;"></div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block; font-size:10px; color:var(--theme-textSecondary, #aaa); margin-bottom:5px; font-weight:bold;">GATEWAY DOMAIN</label>
                <div style="display:flex; gap:8px;">
                    <input type="text" id="settings-domain" value="${domain}" style="flex:1; background:var(--theme-bg0, #111); border:1px solid var(--theme-bg2, #444); color:var(--theme-text, #fff); padding:6px; font-size:11px; border-radius:4px; font-family:inherit;">
                    <button id="btn-save-domain" style="background:#2980b9; border:none; color:#fff; padding:6px 12px; font-size:10px; font-weight:bold; cursor:border; border-radius:4px; white-space:nowrap; font-family:inherit;">Save & Reset</button>
                </div>
            </div>

            <div style="background:var(--theme-bg1, #111); padding:10px; border-radius:6px; margin-bottom:12px; border:1px solid var(--theme-bg2, #333); font-size:10px;">
                <label style="display:block; font-size:9px; color:var(--theme-textSecondary, #888); font-weight:bold; margin-bottom:4px; text-transform:uppercase;">Hardware Footprints Linked (Max 3)</label>
                <div id="operator-linked-devices" style="color:var(--theme-textSecondary, #ccc); font-family:monospace; line-height:1.4;">
                    No other active links.
                </div>
            </div>

            <div style="border-top:1px solid var(--theme-bg2, #333); padding-top:10px; margin-top:10px; font-size:11px;">
                <label style="display:flex; align-items:center; gap:8px; font-size:11px; cursor:pointer; font-weight:bold; color:var(--theme-warning, #f39c12);">
                    <input type="checkbox" id="settings-debug" ${debugActive ? 'checked' : ''} style="cursor:pointer;">
                    ENABLE OPERATOR PROMPT DEBUGGING
                </label>
                <div id="debug-consent" style="font-size:10px; color:var(--theme-textSecondary, #999); margin-top:6px; line-height:1.4; background:var(--theme-bg1, #222); padding:8px; border-radius:4px; border-left:2px solid var(--theme-warning, #f39c12);">
                    <strong>Consent Form:</strong> Enabling Debug Mode logs full outbound API request payloads (including prompts and image parameters) to VPS telemetry. Personal session tokens remain strictly isolated.
                </div>
            </div>
        `;

        // Asynchronous Telemetry Hydration: Updates ledger stats when network resolves without blocking UI
        if (domain && deviceSecret) {
            backgroundRequest({
                method: "GET",
                url: `${domain}/auth/status?browser_id=${browserId}`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            }).then(res => {
                if (res.status === 200) {
                    const data = JSON.parse(res.responseText);
                    const anlasEl = contentHost.querySelector('#operator-anlas-consumed');
                    if (anlasEl) anlasEl.textContent = `${data.anlas_consumed || 0} Anlas`;
                    const refEl = contentHost.querySelector('#operator-precise-limit');
                    if (refEl) refEl.textContent = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} Refs`;
                    const devicesEl = contentHost.querySelector('#operator-linked-devices');
                    if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
                        devicesEl.innerHTML = data.linked_devices.map(d => `- \`${d.id.substring(0, 10)}...\` (${d.label})`).join('<br>');
                    }
                }
            }).catch(() => {});
        }

        const nickInput = contentHost.querySelector("#settings-nickname");
        const saveNickBtn = contentHost.querySelector("#btn-save-nickname");
        const nickStatus = contentHost.querySelector("#settings-nickname-status");
        const domInput = contentHost.querySelector("#settings-domain");
        const saveDomBtn = contentHost.querySelector("#btn-save-domain");
        const debugCheckbox = contentHost.querySelector("#settings-debug");

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

        debugCheckbox.onchange = () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("⚠️ VPS DEBUG MODE ACTIVE", "var(--theme-error, #e74c3c)");
            else removeWarningBadge();
        };
    }

    // Initialize unified DOM observer strictly for Badge, Allowance bar, and Button shield
    initDOMObserver({
        onOpenSettings: openAdminModal
    });

    // Invariant: Enforce immediate display of Exempt status on the allowance bar for Administrator
    updateAllowanceBar(null, Infinity, 0);
}