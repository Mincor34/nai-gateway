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
 */

'use strict';

import { generateUUID } from '../shared/crypto.js';
import { backgroundRequest } from '../shared/network.js';
import { injectWarningBadge, removeWarningBadge } from '../shared/ui.js';
import { initInterceptor } from '../shared/interceptor.js';

let browserId = GM_getValue("browser_id");
let deviceSecret = GM_getValue("admin_token"); // Admin uses system key directly as secret
let approved = GM_getValue("approved", false);
let VPS_HOST = GM_getValue("vps_host", "");
let currentSort = GM_getValue("admin_sort_mode", "anlas"); // Persistence across browser refreshes
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
            overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:#121212 !important; color:#fff !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:sans-serif !important;";
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
            step1Status.innerHTML = "✗ Domain cannot be empty.";
            return;
        }
        if (!/^https?:\/\//i.test(val)) {
            val = "https://" + val;
        }

        step1Status.style.display = "block";
        step1Status.style.color = "#f39c12";
        step1Status.innerHTML = "Connecting to server...";

        try {
            // Verification ping to confirm domain connection path is alive
            const res = await backgroundRequest({
                method: "GET",
                url: `${val}/auth/status?browser_id=ping`
            });
            if (res.status > 0) {
                step1Status.style.color = "#2ecc71";
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
            step1Status.style.color = "#e74c3c";
            step1Status.innerHTML = "✗ Connection failed. Ensure domain is correct and reachable.";
        }
    }

    async function registerNicknameAction() {
        const newNickname = nicknameInput.value.trim();
        if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
            step2Status.style.display = "block";
            step2Status.style.color = "#e74c3c";
            step2Status.innerHTML = "✗ Invalid nickname characters.";
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
            step2Status.style.color = "#e74c3c";
            step2Status.innerHTML = "✗ Registration failed on server.";
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
                adminStatus.innerHTML = "✗ Passkey cannot be empty.";
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
                    adminStatus.innerHTML = "✓ Authenticated! Reloading...";
                    GM_setValue("admin_token", passkey);
                    GM_setValue("approved", true);
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    throw new Error("Invalid key");
                }
            } catch (err) {
                adminStatus.style.color = "#e74c3c";
                adminStatus.innerHTML = "✗ Invalid Admin Passkey.";
            }
        };
    }

    verifyBtn.onclick = verifyDomainAction;
    registerBtn.onclick = registerNicknameAction;

    if (validatedHost) {
        domainInput.value = validatedHost;
        step1Status.style.display = "block";
        step1Status.style.color = "#2ecc71";
        step1Status.innerHTML = "✓ Connected";
        domainInput.disabled = true;
        verifyBtn.disabled = true;
        step2Container.style.display = "block";
        
        if (validatedNickname) {
            nicknameInput.value = validatedNickname;
            step2Status.style.display = "block";
            step2Status.style.color = "#2ecc71";
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

    // Build float controller button interface
    const btn = document.createElement("button");
    btn.innerHTML = "VPS CONTROL PANEL";
    btn.style.cssText = "position:fixed;top:15px;right:15px;background:#c0392b;color:#fff;border:none;padding:10px 15px;border-radius:4px;z-index:99997;font-family:sans-serif;font-size:11px;font-weight:bold;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.5);";
    btn.onclick = toggleAdminPanel;
    document.documentElement.appendChild(btn);

    function toggleAdminPanel() {
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
    }

    /**
     * Renders the administrative dashboard interface.
     * Evaluates grouping and sorting sequences, and handles bilateral diagnostic debug arming.
     */
    async function renderAdminUI() {
        const modal = document.getElementById("vps-admin-panel");
        if (!modal) return;

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
                    <a href="#" class="sort-trigger" data-sort="anlas" style="color: ${currentSort === 'anlas' ? '#00bc8c; font-weight:bold' : '#999'}; text-decoration:none;">Anlas</a> |
                    <a href="#" class="sort-trigger" data-sort="reqs" style="color: ${currentSort === 'reqs' ? '#00bc8c; font-weight:bold' : '#999'}; text-decoration:none;">Reqs</a> |
                    <a href="#" class="sort-trigger" data-sort="active" style="color: ${currentSort === 'active' ? '#00bc8c; font-weight:bold' : '#999'}; text-decoration:none;">Active</a> |
                    <a href="#" class="sort-trigger" data-sort="status" style="color: ${currentSort === 'status' ? '#00bc8c; font-weight:bold' : '#999'}; text-decoration:none;">Status</a>
                </div>

                <div id="vps-client-list" style="font-size:11px;display:flex;flex-direction:column;gap:8px;">
                    Loading system records...
                </div>
            </div>
        `;

        // Handle master session token submission
        document.getElementById("vps-btn-push-token").onclick = async () => {
            const tk = document.getElementById("vps-master-token-input").value.trim();
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

        // Attach event listeners for sort operations
        modal.querySelectorAll(".sort-trigger").forEach(el => {
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

                // Execute selected sort criteria
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
                groups.forEach(group => {
                    const selectorId = group.discord_id || group.devices[0].browser_id;
                    const isLinked = !!group.discord_id;
                    const isExpanded = expandedKeys.has(selectorId);
                    
                    const el = document.createElement("div");
                    el.style.cssText = "background:#222; border-radius:4px; border:1px solid #333; overflow:hidden; display:flex; flex-direction:column; transition: border-color 0.2s;";
                    if (group.banned === 1) {
                        el.style.borderColor = "#c0392b"; // Render critical red borders on banned accounts
                    }

                    // Online/Offline & Status tags
                    const statusDotColor = group.is_online ? "#2ecc71" : "#7f8c8d";
                    const statusTitle = group.is_online ? "Online" : "Offline";
                    const bannedBadge = group.banned === 1 
                        ? `<span style="background:#c0392b; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px; letter-spacing:0.5px;">BANNED</span>` 
                        : '';

                    // In-band debug intent badge indicator on header
                    let headerDebugBadge = '';
                    if (group.has_debug_authorized) {
                        headerDebugBadge = `<span style="background:#27ae60; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG ACTIVE</span>`;
                    } else if (group.has_debug_intent) {
                        headerDebugBadge = `<span style="background:#e67e22; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:6px;">DEBUG REQUESTED</span>`;
                    }

                    // Collapsed condensed header markup
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
                                <span style="font-size:8px; color:#555;">${isExpanded ? '▲' : '▼'}</span>
                            </div>
                        </div>
                    `;

                    // Expanded detailed view panel
                    if (isExpanded) {
                        const body = document.createElement("div");
                        body.style.cssText = "padding:12px; border-top:1px solid #333; background:#252525; display:flex; flex-direction:column; gap:10px;";
                        
                        let devicesHtml = '';
                        group.devices.forEach(d => {
                            const devOnlineColor = d.is_online ? "#2ecc71" : "#7f8c8d";
                            const devBannedBadge = d.banned === 1 ? `<span style="color:#e74c3c; font-weight:bold; margin-left:4px;">(BANNED)</span>` : '';
                            const allowanceBadge = d.metered_allowance !== null ? `<span style="color:#f39c12; font-weight:bold; margin-left:6px;">[${d.metered_allowance}/100 Imgs]</span>` : '';
                            
                            // Bilateral Debug Status Badges & Action Buttons
                            let devDebugBadge = '';
                            let devDebugBtn = '';

                            if (d.debug_authorized) {
                                const minsLeft = (d.debug_expires_in_ms / 60000).toFixed(1);
                                devDebugBadge = `<span style="background:#27ae60; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">DEBUG ACTIVE (${minsLeft}m)</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="disarm" style="background:#e67e22; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">DISARM</button>`;
                            } else if (d.debug_intent) {
                                devDebugBadge = `<span style="background:#e74c3c; color:#fff; font-size:8px; padding:1px 4px; border-radius:2px; font-weight:bold; margin-left:4px;">⚠️ DEBUG REQUESTED</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug" data-id="${d.browser_id}" data-action="arm" style="background:#2980b9; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">AUTHORIZE (10M)</button>`;
                            }

                            devicesHtml += `
                                <div style="font-size:10px; color:#ccc; padding:6px 0; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                                    <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1;">
                                        <div style="width:5px; height:5px; border-radius:50%; background:${devOnlineColor};"></div>
                                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>${d.label}</strong> ${devBannedBadge}${allowanceBadge}${devDebugBadge} <code style="color:#666;">(${d.browser_id.substring(0,8)}...)</code></span>
                                    </div>
                                    <div style="display:flex; gap:4px; align-items:center;">
                                        ${devDebugBtn}
                                        <button class="btn-prune-dev" data-id="${d.browser_id}" style="background:#8e44ad; border:none; color:#fff; padding:2px 6px; font-size:9px; cursor:pointer; border-radius:2px; font-weight:bold; flex-shrink:0;">PRUNE</button>
                                    </div>
                                </div>
                            `;
                        });

                        const lastActiveDate = group.last_active_at > 0 
                            ? new Date(group.last_active_at).toLocaleTimeString() 
                            : 'Never';

                        const banToggleBtn = group.banned === 1
                            ? `<button class="btn-unban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#27ae60; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">UNBAN USER</button>`
                            : `<button class="btn-ban-group" data-key="${selectorId}" data-is-discord="${isLinked}" style="background:#c0392b; border:none; color:#fff; padding:5px 10px; font-size:10px; cursor:pointer; border-radius:3px; font-weight:bold; flex:1;">BAN USER</button>`;

                        body.innerHTML = `
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:10px; color:#aaa; margin-bottom:4px;">
                                <div>Tier: <strong style="color:#00bc8c;">${group.priority_tier}</strong></div>
                                <div>Last Active: <strong style="color:#fff;">${lastActiveDate}</strong></div>
                                <div style="grid-column: span 2;">Discord ID: <code style="background:#111; padding:2px 4px; border-radius:2px; color:#888;">${group.discord_id || 'Unlinked'}</code></div>
                            </div>

                            <div style="background:#1a1a1a; padding:8px; border-radius:3px; border:1px solid #333;">
                                <div style="font-weight:bold; font-size:9px; color:#555; text-transform:uppercase; margin-bottom:5px;">Hardware Footprints</div>
                                ${devicesHtml || '<div style="color:#666; font-style:italic; font-size:10px;">No hardware linked.</div>'}
                            </div>

                            <div style="display:flex; gap:6px; margin-top:4px;">
                                <select id="tier-select-${selectorId}" style="background:#111; border:1px solid #444; color:#fff; font-size:10px; padding:4px 6px; border-radius:3px;">
                                    <option value="Metered" ${group.priority_tier === 'Metered' ? 'selected' : ''}>Metered</option>
                                    <option value="Low" ${group.priority_tier === 'Low' ? 'selected' : ''}>Low</option>
                                    <option value="Normal" ${group.priority_tier === 'Normal' ? 'selected' : ''}>Normal</option>
                                    <option value="High" ${group.priority_tier === 'High' ? 'selected' : ''}>High</option>
                                    <option value="Admin" ${group.priority_tier === 'Admin' ? 'selected' : ''}>Admin</option>
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

                // Expand/collapse click events
                container.querySelectorAll(".client-card-header").forEach(h => {
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

                // Bilateral Debug Arm/Disarm Action Button
                container.querySelectorAll(".btn-toggle-debug").forEach(b => {
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
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                // Hardened action buttons utilizing e.currentTarget to bypass inner-node click tracking anomalies
                container.querySelectorAll(".btn-approve-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const tier = document.getElementById(`tier-select-${key}`).value;
                        
                        const payload = isDiscord 
                            ? { discord_id: key, priority_tier: tier } 
                            : { browser_id: key, priority_tier: tier };

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/approve`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                container.querySelectorAll(".btn-revoke-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        
                        if (!confirm(`Are you sure you want to revoke authorization for ${key}?`)) return;

                        const payload = isDiscord 
                            ? { discord_id: key } 
                            : { browser_id: key };

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/revoke`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                container.querySelectorAll(".btn-ban-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        
                        const reason = prompt("Enter a reason for banning this client:");
                        if (reason === null) return; // Terminate early on cancellation

                        const payload = isDiscord 
                            ? { discord_id: key, reason } 
                            : { browser_id: key, reason };

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/ban`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                container.querySelectorAll(".btn-unban-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        
                        const payload = isDiscord 
                            ? { discord_id: key } 
                            : { browser_id: key };

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/unban`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                container.querySelectorAll(".btn-prune-dev").forEach(b => {
                    b.onclick = async (e) => {
                        const bid = e.currentTarget.getAttribute("data-id");
                        if (!confirm(`Are you sure you want to permanently delete device registration: ${bid}?`)) return;

                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/prune-device`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify({ browser_id: bid })
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });
            }
        } catch (e) {
            document.getElementById("vps-client-list").innerHTML = "Error retrieving system data records.";
        }
    }

    // ----------------- DYNAMIC SETTINGS GEAR MODAL (ADMIN) -----------------
    function injectGearButton() {
        if (document.getElementById("vps-gear-btn")) return;
        const gearBtn = document.createElement("button");
        gearBtn.id = "vps-gear-btn";
        gearBtn.innerHTML = "⚙️";
        // Relocated bottom offset to 120px to avoid bottom mobile layout toolbars
        gearBtn.style.cssText = "position:fixed; bottom:120px; right:15px; width:44px; height:44px; background:#1a1a1a; border:1px solid #c0392b; border-radius:50%; color:#fff; font-size:22px; cursor:pointer; z-index:99999; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 10px rgba(0,0,0,0.5); transition:transform 0.2s;";
        gearBtn.onclick = openSettingsModal;
        
        const banner = document.getElementById("vps-queue-banner");
        if (banner) {
            banner.style.bottom = "175px"; // Adjust banner to sit stacked cleanly above the gear
            banner.style.right = "15px";
        }
        document.documentElement.appendChild(gearBtn);
        if (GM_getValue("debug_mode", false)) {
            injectWarningBadge("⚠️ VPS DEBUG MODE ACTIVE", "#e74c3c");
        }
    }

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
        backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:99998;";
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
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
        let linkedDevicesList = '';
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
                // Gracefully catch both the raw string token and explicit fallbacks
                preciseLimit = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} Refs`;
                if (data.session) {
                    const allowance = data.session.allowance;
                    const maxAllowance = data.session.max || 100; // Safe dynamic denominator fallback
                    const refillInMins = (data.session.next_refill_in / 1000 / 60).toFixed(1);
                    const refillText = allowance < maxAllowance ? `(+1 image in ${refillInMins}m)` : '(Fully Charged)';
                    sessionStatus = `<span style="color:#2ecc71; font-weight:bold;">${allowance}/${maxAllowance} Images</span> <span style="font-size:10px; color:#aaa;">${refillText}</span>`;
                } else {
                    sessionStatus = `<span style="color:#00bc8c; font-weight:bold;">Exempt (Unlimited)</span>`;
                }
                if (data.linked_devices && data.linked_devices.length > 0) {
                    linkedDevicesList = data.linked_devices.map(d => `- \`${d.id.substring(0, 10)}...\` (${d.label})`).join('<br>');
                } else {
                    linkedDevicesList = 'No other active links.';
                }
            }
        } catch (e) {}

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
                    <input type="checkbox" id="settings-debug" ${debugActive ? 'checked' : ''} style="cursor:pointer;">
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
                nickStatus.innerHTML = "✗ Invalid nickname characters.";
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
                    nickStatus.innerHTML = "✓ Nickname updated successfully!";
                    GM_setValue("device_nickname", newNickname);
                } else {
                    throw new Error("Update failed");
                }
            } catch (err) {
                nickStatus.style.color = "#e74c3c";
                nickStatus.innerHTML = "✗ Failed to update nickname on VPS.";
            }
        };

        saveDomBtn.onclick = () => {
            let val = domInput.value.trim().replace(/\/+$/, "");
            if (!val) return;
            if (!/^https?:\/\//i.test(val)) val = "https://" + val;
            GM_setValue("vps_host", val);
            GM_setValue("approved", false);
            modal.remove();
            backdrop.remove();
            window.location.reload();
        };

        debugCheckbox.onchange = () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("⚠️ VPS DEBUG MODE ACTIVE", "#e74c3c");
            else removeWarningBadge();
        };
    }

    // High-frequency thread to inject the settings gear button safely on DOM creation
    setInterval(injectGearButton, 1000);
}