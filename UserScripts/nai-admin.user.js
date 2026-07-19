// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Admin Panel)
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  Secure administration panel and session token injector
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

/**
 * ADMINISTRATIVE UTILITY (nai-admin.user.js)
 *
 * Implements a secure control layer on top of the NovelAI site UI.
 * Connects directly to the VPS using privileged background XMLHttpRequest tasks 
 * to bypass browser-level CSP (Content Security Policy) protections.
 *
 * Key Operations:
 * - Manage and approve device registrations.
 * - Set queue priority tiers on active devices.
 * - Extract and push active tokens securely to SQLite storage on the VPS.
 */

(function() {
    'use strict';

    function generateUUID() {
        let d = new Date().getTime();
        let d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now() * 1000)) || 0;
        return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            let r = Math.random() * 16;
            if (d > 0) {
                r = (d + r) % 16 | 0;
                d = Math.floor(d / 16);
            } else {
                r = (d2 + r) % 16 | 0;
                d = Math.floor(d2 / 16);
            }
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    let browserId = GM_getValue("browser_id");
    let deviceSecret = GM_getValue("admin_token"); // Admin uses system key directly as secret
    let approved = GM_getValue("approved", false);
    let VPS_HOST = GM_getValue("vps_host", "");

    try {
        if (!browserId) {
            browserId = 'b_' + generateUUID();
            GM_setValue("browser_id", browserId);
        }
    } catch (err) {
        console.error("Nai-Admin: Storage initialization crash:", err);
    }

    function backgroundRequest(details) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                onload: (r) => resolve(r),
                onerror: (e) => reject(e)
            });
        });
    }

    // High-frequency UI enforcement loop (forces UI overlay to stay mounted and visible)
    let enforcementInterval = null;

    function startUIEnforcement() {
        if (enforcementInterval) return;
        console.log("Nai-Admin: Starting high-frequency UI enforcement loop...");
        enforcementInterval = setInterval(() => {
            if (!document.body) return; // Wait for body to be constructed

            let overlay = document.getElementById("vps-approval-overlay");
            if (!overlay) {
                console.log("Nai-Admin: UI overlay was missing or deleted by React. Re-injecting...");
                overlay = document.createElement("div");
                overlay.id = "vps-approval-overlay";
                overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:#121212 !important; color:#fff !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:sans-serif !important;";
                document.body.appendChild(overlay);
                renderSetupWizard(overlay);
            }
        }, 50);
    }

    /**
     * Renders the sequential admin setup wizard.
     * Step 3 prompts for the master ADMIN_SECRET_KEY to verify the device directly.
     */
    function renderSetupWizard(container) {
        if (container.querySelector(".setup-wizard-card")) return;
        
        container.innerHTML = `
            <div class="setup-wizard-card" style="background:#1c1c1c; padding:35px; border-radius:6px; border:1px solid #c0392b; box-shadow:0 8px 30px rgba(0,0,0,0.6); max-width:450px; width:100%; box-sizing:border-box;">
                <h3 style="margin:0 0 15px 0; color:#00bc8c; text-align:center; letter-spacing:1px; font-size:18px; font-family:sans-serif;">GATEWAY COORDINATOR SETUP (ADMIN)</h3>
                
                <!-- Step 1: Gateway Domain Configuration -->
                <div id="step-1-container" style="margin-bottom:20px;">
                    <label style="display:block; font-size:12px; color:#aaa; margin-bottom:5px; font-weight:bold; font-family:sans-serif;">STEP 1: ENTER GATEWAY DOMAIN</label>
                    <div style="display:flex; gap:10px;">
                        <input type="text" id="setup-domain" value="${GM_getValue("vps_host", "")}" placeholder="https://your-domain.duckdns.org" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                        <button id="btn-verify-domain" style="background:#2980b9; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Verify</button>
                    </div>
                    <div id="step-1-status" style="margin-top:5px; font-size:11px; font-family:sans-serif; display:none;"></div>
                </div>

                <!-- Step 2: Nickname Configuration -->
                <div id="step-2-container" style="margin-bottom:20px; display:none;">
                    <label style="display:block; font-size:12px; color:#aaa; margin-bottom:5px; font-weight:bold; font-family:sans-serif;">STEP 2: ENTER NICKNAME</label>
                    <div style="display:flex; gap:10px;">
                        <input type="text" id="setup-nickname" value="${GM_getValue("device_nickname", "")}" placeholder="e.g. Admin" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                        <button id="btn-register-nickname" style="background:#27ae60; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Register</button>
                    </div>
                    <div id="step-2-status" style="margin-top:5px; font-size:11px; font-family:sans-serif; display:none;"></div>
                </div>

                <!-- Step 3: Admin Passkey Verification -->
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
                // Connection evaluation ping targeting gateway authorization endpoint
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
            const nickname = nicknameInput.value.trim();
            if (!nickname || !/^[a-zA-Z0-9_\s]+$/.test(nickname)) {
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
                    data: JSON.stringify({ browser_id: browserId, device_secret: tempSecret, label: nickname })
                });
                if (res.status === 200) {
                    step2Status.style.color = "#2ecc71";
                    step2Status.innerHTML = "✓ Registered nickname successfully!";
                    GM_setValue("device_nickname", nickname);
                    validatedNickname = nickname;
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
                <div style="margin-bottom:10px;">Your device is registered! Enter your Admin Passkey to authenticate this admin terminal:</div>
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

    if (!approved || !VPS_HOST || !deviceSecret) {
        startUIEnforcement();
        return; // Halt loading sequence
    }

    // Build float controller button interface
    const btn = document.createElement("button");
    btn.innerHTML = "VPS CONTROL PANEL";
    btn.style = "position:fixed;top:15px;right:15px;background:#c0392b;color:#fff;border:none;padding:10px 15px;border-radius:4px;z-index:99997;font-family:sans-serif;font-size:11px;font-weight:bold;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.5);";
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
        modal.style = "position:fixed;top:60px;right:15px;width:350px;background:#1a1a1a;border:1px solid #c0392b;border-radius:4px;z-index:99997;color:#fff;padding:20px;font-family:sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.5);max-height:80vh;overflow-y:auto;";
        document.documentElement.appendChild(modal);

        renderAdminUI();
    }

    async function renderAdminUI() {
        const modal = document.getElementById("vps-admin-panel");
        if (!modal) return;

        modal.innerHTML = `
            <h4 style="margin:0 0 15px 0;border-bottom:1px solid #333;padding-bottom:5px;color:#c0392b;">COORDINATOR ADMINISTRATION</h4>
            
            <div style="margin-bottom:20px;">
                <label style="display:block;font-size:11px;color:#888;margin-bottom:5px;">MASTER NOVELAI SESSION TOKEN</label>
                <input type="password" id="vps-master-token-input" placeholder="Bearer jti_..." style="width:100%;background:#111;border:1px solid #444;color:#fff;padding:8px;font-size:11px;border-radius:3px;box-sizing:border-box;">
                <button id="vps-btn-push-token" style="background:#27ae60;border:none;color:#fff;padding:8px 12px;margin-top:8px;font-size:11px;font-weight:bold;cursor:pointer;border-radius:3px;width:100%;">PUSH TO VPS STORAGE</button>
            </div>

            <div>
                <label style="display:block;font-size:11px;color:#888;margin-bottom:8px;">VERIFIED CLIENT RECORDS</label>
                <div id="vps-client-list" style="font-size:11px;display:flex;flex-direction:column;gap:10px;">
                    Loading system records...
                </div>
            </div>
        `;

        document.getElementById("vps-btn-push-token").onclick = async () => {
            const tk = document.getElementById("vps-master-token-input").value;
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

        try {
            const res = await backgroundRequest({
                method: "GET",
                url: `${VPS_HOST}/admin/devices`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            });
            if (res.status === 200) {
                const devices = JSON.parse(res.responseText);
                const container = document.getElementById("vps-client-list");
                if (devices.length === 0) {
                    container.innerHTML = "No clients pending registration.";
                    return;
                }
                container.innerHTML = "";
                devices.forEach(dev => {
                    const el = document.createElement("div");
                    el.style = "background:#222;padding:10px;border-radius:3px;border-left:3px solid " + (dev.approved ? '#27ae60' : '#f39c12');
                    el.innerHTML = `
                        <div style="font-weight:bold;margin-bottom:3px;">${dev.label}</div>
                        <div style="font-size:10px;color:#777;word-break:break-all;">ID: ${dev.browser_id}</div>
                        <div style="font-size:10px;color:#999;margin-top:3px;">Tier: <span style="color:#00bc8c;">${dev.priority_tier}</span></div>
                        <div style="display:flex;gap:5px;margin-top:8px;">
                            <select id="tier-select-${dev.browser_id}" style="background:#111;border:1px solid #444;color:#fff;font-size:10px;padding:3px;">
                                <option value="Low" ${dev.priority_tier === 'Low' ? 'selected' : ''}>Low</option>
                                <option value="Normal" ${dev.priority_tier === 'Normal' ? 'selected' : ''}>Normal</option>
                                <option value="High" ${dev.priority_tier === 'High' ? 'selected' : ''}>High</option>
                                <option value="Admin" ${dev.priority_tier === 'Admin' ? 'selected' : ''}>Admin</option>
                            </select>
                            <button class="btn-approve-dev" data-id="${dev.browser_id}" style="background:#27ae60;border:none;color:#fff;padding:4px 8px;font-size:10px;cursor:pointer;border-radius:2px;font-weight:bold;">APPROVE</button>
                            <button class="btn-revoke-dev" data-id="${dev.browser_id}" style="background:#c0392b;border:none;color:#fff;padding:4px 8px;font-size:10px;cursor:pointer;border-radius:2px;font-weight:bold;">REVOKE</button>
                        </div>
                    `;
                    container.appendChild(el);
                });

                container.querySelectorAll(".btn-approve-dev").forEach(b => {
                    b.onclick = async (e) => {
                        const bid = e.target.getAttribute("data-id");
                        const tier = document.getElementById(`tier-select-${bid}`).value;
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/approve`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify({ browser_id: bid, priority_tier: tier })
                        });
                        if (actionRes.status === 200) renderAdminUI();
                    };
                });

                container.querySelectorAll(".btn-revoke-dev").forEach(b => {
                    b.onclick = async (e) => {
                        const bid = e.target.getAttribute("data-id");
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/revoke`,
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
        gearBtn.style.cssText = "position:fixed; bottom:15px; right:15px; width:36px; height:36px; background:#1a1a1a; border:1px solid #c0392b; border-radius:50%; color:#fff; font-size:18px; cursor:pointer; z-index:99999; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 10px rgba(0,0,0,0.5); transition:transform 0.2s;";
        gearBtn.onclick = openSettingsModal;
        
        const banner = document.getElementById("vps-queue-banner");
        if (banner) {
            banner.style.bottom = "60px";
            banner.style.right = "15px";
        }
        document.documentElement.appendChild(gearBtn);
        if (GM_getValue("debug_mode", false)) {
            injectWarningBadge();
        }
    }

    function injectWarningBadge() {
        if (document.getElementById("vps-debug-badge")) return;
        const badge = document.createElement("div");
        badge.id = "vps-debug-badge";
        badge.innerHTML = "⚠️ VPS DEBUG MODE ACTIVE";
        badge.style.cssText = "position:fixed; top:10px; left:50%; transform:translateX(-50%); background:#e74c3c; color:#fff; font-weight:bold; font-size:11px; padding:6px 12px; border-radius:4px; z-index:99999; box-shadow:0 2px 8px rgba(0,0,0,0.4); pointer-events:none;";
        document.documentElement.appendChild(badge);
    }

    function removeWarningBadge() {
        const badge = document.getElementById("vps-debug-badge");
        if (badge) badge.remove();
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
        modal.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); width:400px; background:#1c1c1c; border:1px solid #c0392b; border-radius:6px; z-index:99999; color:#fff; padding:20px; font-family:sans-serif; box-shadow:0 10px 40px rgba(0,0,0,0.6); max-height:90vh; overflow-y:auto;";
        
        const nickname = GM_getValue("device_nickname", "Admin");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const imageCount = GM_getValue("count_image_gens", 0);
        const textCount = GM_getValue("count_text_gens", 0);

        modal.innerHTML = `
            <h4 style="margin:0 0 15px 0; color:#00bc8c; border-bottom:1px solid #333; padding-bottom:8px; font-size:16px;">GATEWAY SETTINGS</h4>
            
            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px;">NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-nickname" value="${nickname}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-nickname" style="background:#27ae60; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px;">Save</button>
                </div>
                <div id="settings-nickname-status" style="font-size:10px; margin-top:3px; display:none;"></div>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px;">VPS DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-domain" value="${domain}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-domain" style="background:#2980b9; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; white-space:nowrap;">Save & Reset</button>
                </div>
            </div>

            <div style="background:#111; padding:12px; border-radius:4px; margin-bottom:15px; border:1px solid #333;">
                <label style="display:block; font-size:10px; color:#888; font-weight:bold; margin-bottom:6px; text-transform:uppercase;">Usage Stats & Information</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px;">
                    <div>Tier: <span style="color:#00bc8c; font-weight:bold;">Admin</span></div>
                    <div>Anlas Spent: <span style="color:#f39c12; font-weight:bold;">0 Anlas</span></div>
                    <div>Image Gens: <span style="font-weight:bold;">${imageCount}</span></div>
                    <div>Text Gens: <span style="font-weight:bold;">${textCount}</span></div>
                </div>
                <div style="font-size:10px; color:#666; margin-top:6px; text-align:center;">Unlimited high priority execution.</div>
            </div>

            <div style="border-top:1px solid #333; padding-top:12px; margin-top:12px;">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; font-weight:bold; color:#f39c12;">
                    <input type="checkbox" id="settings-debug" ${debugActive ? 'checked' : ''} style="cursor:pointer;">
                    ENABLE DEBUG MODE
                </label>
                <div id="debug-consent" style="font-size:11px; color:#999; margin-top:6px; line-height:1.4; background:#222; padding:8px; border-radius:4px; border-left:2px solid #f39c12;">
                    <strong>Consent Form:</strong> Enabling Debug Mode will log full API request payloads (including prompt texts and image inputs such as image-to-image, vibe transfer, and precise reference) to the VPS log telemetry. Your NovelAI authorization token and personal account credentials will <strong>NOT</strong> be logged.
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
            const nickname = nickInput.value.trim();
            if (!nickname || !/^[a-zA-Z0-9_\s]+$/.test(nickname)) {
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
                    data: JSON.stringify({ browser_id: browserId, label: nickname })
                });
                if (res.status === 200) {
                    nickStatus.style.color = "#2ecc71";
                    nickStatus.innerHTML = "✓ Nickname updated successfully!";
                    GM_setValue("device_nickname", nickname);
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
            if (!/^https?:\/\//i.test(val)) {
                val = "https://" + val;
            }
            GM_setValue("vps_host", val);
            GM_setValue("approved", false);
            modal.remove();
            backdrop.remove();
            window.location.reload();
        };

        debugCheckbox.onchange = () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge();
            else removeWarningBadge();
        };
    }

    // High-frequency thread to inject the settings gear button safely on DOM creation
    setInterval(injectGearButton, 1000);

    // ----------------- QUEUE PIPELINE INTERCEPTION (ADMIN-SPECIFIC INTEGRATION) -----------------
    function parseResponseHeaders(headerStr) {
        const headers = new Headers();
        if (!headerStr) return headers;

        const lines = headerStr.split(/[\r\n]+/);
        lines.forEach(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return;

            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) return; // Ignore status lines

            const name = trimmedLine.slice(0, colonIndex).trim();
            const value = trimmedLine.slice(colonIndex + 1).trim();

            if (name) {
                if (/^[a-zA-Z0-9!#$%&'*+-.^_`|~]+$/.test(name)) {
                    try {
                        headers.append(name, value);
                    } catch (e) {
                        console.error(`Nai-Admin: Failed to append header "${name}":`, e);
                    }
                } else {
                    console.warn(`Nai-Admin: Dropping invalid header name token: "${name}"`);
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
        return 0; // Return 0 to indicate status code could not be resolved yet
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
        result += decoder.decode(); // Flush stream buffer
        return result;
    }

    async function tryResolveProxyResponse(responseDetails, resolveObj, isImageGen, isTextGen) {
        const status = extractStatusCode(responseDetails);
        if (status === 0) {
            return false; // Status code not yet populated; defer resolution
        }

        if (status === 200) {
            if (!responseDetails.response) {
                console.error("[Nai-Admin] Telemetry: Success code detected, but readable response stream was empty.");
                return false; // Wait for response body context to bind
            }
            console.log("[Nai-Admin] Telemetry: Stream successfully acquired. Piping stream response directly to web page fetch promise.");
            
            // Increment telemetry variables on validation success
            if (isImageGen) {
                GM_setValue("count_image_gens", GM_getValue("count_image_gens", 0) + 1);
            } else if (isTextGen) {
                GM_setValue("count_text_gens", GM_getValue("count_text_gens", 0) + 1);
            }

            resolveObj(new Response(responseDetails.response, {
                status: status,
                headers: parseResponseHeaders(responseDetails.responseHeaders)
            }));
            return true;
        } else {
            console.error(`[Nai-Admin] Telemetry: Proxy returned exception status code: ${status}`);

            let errorText = "";
            try {
                if (responseDetails.response) {
                    if (typeof responseDetails.response.getReader === 'function') {
                        errorText = await readStreamAsString(responseDetails.response);
                    } else if (typeof responseDetails.response === 'string') {
                        errorText = responseDetails.response;
                    }
                }
            } catch (e) {
                console.error("[Nai-Admin] Error: Failed to extract string from raw exception stream:", e);
            }

            console.log(`[Nai-Admin] Telemetry: Received raw error text: "${errorText}"`);

            // Standardize raw anomalies into correct structured exception parameters for SPA parsing
            let parsedError = null;
            try {
                if (errorText) parsedError = JSON.parse(errorText);
            } catch (e) {}

            const responseBody = parsedError && (parsedError.statusCode || parsedError.message || parsedError.error)
                ? JSON.stringify({
                    statusCode: parsedError.statusCode || status,
                    message: parsedError.message || parsedError.error || errorText || "Gateway processing error"
                  })
                : JSON.stringify({
                    statusCode: status,
                    message: errorText || "Gateway processing error"
                  });

            resolveObj(new Response(responseBody, {
                status: status,
                headers: parseResponseHeaders(responseDetails.responseHeaders)
            }));
            return true;
        }
    }

    async function extractImageParams(body) {
        if (!body) return null;
        try {
            let payload = null;
            if (body instanceof FormData) {
                const requestBlob = body.get("request");
                if (!requestBlob) return null;
                const text = typeof requestBlob.text === 'function'
                    ? await requestBlob.text()
                    : requestBlob;
                payload = JSON.parse(text);
            } else if (typeof body === 'string') {
                payload = JSON.parse(body);
            }

            if (payload && payload.parameters) {
                return {
                    width: parseInt(payload.parameters.width, 10) || 1024,
                    height: parseInt(payload.parameters.height, 10) || 1024,
                    steps: parseInt(payload.parameters.steps, 10) || 28,
                    n_samples: parseInt(payload.parameters.n_samples, 10) || 1
                };
            }
        } catch (e) {
            console.error("Nai-Admin: Parameter extraction failed:", e);
        }
        return null;
    }

    function showQueueStatusBanner(text) {
        let banner = document.getElementById("vps-queue-banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "vps-queue-banner";
            banner.style = "position:fixed;bottom:60px;right:15px;background:#1b1b1b;color:#00bc8c;padding:12px 20px;border:1px solid #00bc8c;border-radius:4px;z-index:99998;font-family:sans-serif;font-size:13px;box-shadow:0 4px 15px rgba(0,0,0,0.4);display:flex;align-items:center;gap:10px;";
            document.documentElement.appendChild(banner);
        }
        banner.innerHTML = `<div style="width:8px;height:8px;background:#00bc8c;border-radius:50%;animation:vpsPulse 1s infinite alternate;"></div><span>${text}</span>
        <style>@keyframes vpsPulse { 0% { opacity:0.3; } 100% { opacity:1; } }</style>`;
    }

    function hideQueueStatusBanner() {
        const banner = document.getElementById("vps-queue-banner");
        if (banner) banner.remove();
    }

    async function handleGenerationIntercept(url, config) {
        const req_id = 'req_' + generateUUID();
        const tab_id = sessionStorage.getItem("vps_tab_id") || (() => {
            const tid = 't_' + generateUUID();
            sessionStorage.setItem("vps_tab_id", tid);
            return tid;
        })();

        const originalBody = config.body;
        let imgParams = { width: 1024, height: 1024, steps: 28, n_samples: 1 };

        const extracted = await extractImageParams(originalBody);
        if (extracted) imgParams = extracted;

        try {
            const joinRes = await backgroundRequest({
                method: "POST",
                url: `${VPS_HOST}/queue/join`,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${deviceSecret}`
                },
                data: JSON.stringify({ browser_id: browserId, tab_id, req_id })
            });
            if (joinRes.status !== 200) throw new Error("Join rejection");
        } catch (e) {
            return new Response(JSON.stringify({ statusCode: 502, message: "Queue allocation failure" }), { status: 502 });
        }

        let turnAcquired = false;
        showQueueStatusBanner("Acquiring channel slot...");

        while (!turnAcquired) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const statusRes = await backgroundRequest({
                    method: "GET",
                    url: `${VPS_HOST}/queue/status?req_id=${req_id}`
                });
                if (statusRes.status === 200) {
                    const sData = JSON.parse(statusRes.responseText);
                    if (sData.status === 'your_turn') {
                        turnAcquired = true;
                        hideQueueStatusBanner();
                    } else if (sData.status === 'waiting') {
                        showQueueStatusBanner(`Queue Position: ${sData.position}`);
                    }
                } else {
                    throw new Error("Expired state");
                }
            } catch (e) {
                hideQueueStatusBanner();
                backgroundRequest({
                    method: "POST",
                    url: `${VPS_HOST}/queue/complete`,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ req_id })
                });
                return new Response(JSON.stringify({ statusCode: 502, message: "Queue processing aborted" }), { status: 502 });
            }
        }

        const originalUrlObj = new URL(url);
        // Extract subdomain dynamically (e.g., 'image' or 'text' or 'api') to support flexible routing across multiple NovelAI subdomains.
        const subdomain = originalUrlObj.hostname.split('.')[0];
        const proxyUrl = `${VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;

        const updatedHeaders = new Map();
        if (config.headers) {
            if (config.headers instanceof Headers) {
                for (let [k, v] of config.headers.entries()) {
                    updatedHeaders.set(k.toLowerCase(), v);
                }
            } else {
                Object.keys(config.headers).forEach(k => {
                    updatedHeaders.set(k.toLowerCase(), config.headers[k]);
                });
            }
        }

        updatedHeaders.set("x-browser-id", browserId);
        updatedHeaders.set("x-request-id", req_id);
        updatedHeaders.set("x-gen-width", imgParams.width.toString());
        updatedHeaders.set("x-gen-height", imgParams.height.toString());
        updatedHeaders.set("x-gen-steps", imgParams.steps.toString());
        updatedHeaders.set("x-gen-samples", imgParams.n_samples.toString());
        updatedHeaders.set("authorization", `Bearer ${deviceSecret}`);
        if (GM_getValue("debug_mode", false)) {
            updatedHeaders.set("x-debug-mode", "true");
            console.log(`[VPS Debug Mode] Outbound image generation details:`, originalBody);
        }

        updatedHeaders.delete("host");
        updatedHeaders.delete("content-length"); // Prevent boundary mismatches from desynchronizing streams

        if (originalBody instanceof FormData) {
            updatedHeaders.delete("content-type");
        }

        let hasResolved = false;
        console.log(`[Nai-Admin] Intercepting fetch targeting VPS rewrite URL: ${proxyUrl}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: config.method || "POST",
                url: proxyUrl,
                headers: Object.fromEntries(updatedHeaders.entries()),
                data: originalBody,
                responseType: "stream",
                onloadstart: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry: onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Resolve immediately on stream header initiation to preserve live piping features.
                    if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                        hasResolved = true;
                    }
                },
                onreadystatechange: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry: onreadystatechange fired. ReadyState: ${responseDetails.readyState}, ExtractedStatus: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Fallback evaluation for legacy engines
                    if (responseDetails.readyState >= 2) {
                        if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                            hasResolved = true;
                        }
                    }
                },
                onload: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry: onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve, true, false)) {
                        hasResolved = true;
                    }
                },
                onerror: (err) => {
                    console.error("[Nai-Admin] Telemetry: Fatal network transport crash during GM_xmlhttpRequest transmission.", err);

                    backgroundRequest({
                        method: "POST",
                        url: `${VPS_HOST}/queue/complete`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ req_id })
                    });

                    if (!hasResolved) {
                        hasResolved = true;
                        reject(err);
                    }
                }
            });
        });
    }

    /**
     * Intercepts and routes text generation requests directly to the VPS 
     * bypassing the heavy FIFO image generation channel lock (Channel B).
     */
    async function handleTextGenerationIntercept(url, config) {
        const originalUrlObj = new URL(url);
        // Extract subdomain dynamically (e.g., 'image' or 'text' or 'api') to support flexible routing across multiple NovelAI subdomains.
        const subdomain = originalUrlObj.hostname.split('.')[0];
        const proxyUrl = `${VPS_HOST}/proxy/${subdomain}${originalUrlObj.pathname}${originalUrlObj.search}`;
        const updatedHeaders = new Map();

        if (config.headers) {
            if (config.headers instanceof Headers) {
                for (let [k, v] of config.headers.entries()) {
                    updatedHeaders.set(k.toLowerCase(), v);
                }
            } else {
                Object.keys(config.headers).forEach(k => {
                    updatedHeaders.set(k.toLowerCase(), config.headers[k]);
                });
            }
        }

        updatedHeaders.set("x-browser-id", browserId);
        updatedHeaders.set("authorization", `Bearer ${deviceSecret}`);
        if (GM_getValue("debug_mode", false)) {
            updatedHeaders.set("x-debug-mode", "true");
            console.log(`[VPS Debug Mode] Outbound text prompt payload:`, config.body);
        }

        updatedHeaders.delete("host");
        updatedHeaders.delete("content-length"); // Prevent stream desynchronization

        let hasResolved = false;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: config.method || "POST",
                url: proxyUrl,
                headers: Object.fromEntries(updatedHeaders.entries()),
                data: config.body,
                responseType: "stream",
                onloadstart: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry (Text): onloadstart fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Resolve immediately on stream header initiation to preserve live piping features.
                    if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                        hasResolved = true;
                    }
                },
                onreadystatechange: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry (Text): onreadystatechange fired. ReadyState: ${responseDetails.readyState}, Status: ${extractStatusCode(responseDetails)}`);
                    if (hasResolved) return;
                    // Fallback evaluation for legacy engines
                    if (responseDetails.readyState >= 2) {
                        if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                            hasResolved = true;
                        }
                    }
                },
                onload: async function(responseDetails) {
                    console.log(`[Nai-Admin] Telemetry (Text): onload fired. Status: ${extractStatusCode(responseDetails)}. Socket download complete.`);
                    if (hasResolved) return;
                    if (await tryResolveProxyResponse(responseDetails, resolve, false, true)) {
                        hasResolved = true;
                    }
                },
                onerror: (err) => {
                    console.error("[Nai-Admin] Telemetry (Text): Fatal network transport crash during GM_xmlhttpRequest transmission.", err);
                    if (!hasResolved) {
                        hasResolved = true;
                        reject(err);
                    }
                }
            });
        });
    }

    // Capture and hook unsafeWindow fetch pipelines
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const url = args[0];
        const config = args[1] || {};
        const urlString = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');

        if (urlString) {
            // Spoof personal metadata retrieval endpoints to display Opus eligibility status
            if (urlString.includes('/user/data')) {
                const response = await originalFetch(...args);
                if (response.ok) {
                    const cloned = response.clone();
                    try {
                        const data = await cloned.json();
                        data.subscription = {
                            tier: 3,
                            active: true,
                            paymentProcessor: null,
                            expiresAt: 2524608000,
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

            // Spoof Trial limitations to prevent local UI blockades
            if (urlString.includes('/ai/trial-status')) {
                const mockTrial = {
                    "used_text_actions": 0,
                    "remaining_text_actions": 50,
                    "used_image_actions": 0,
                    "remaining_image_actions": 50,
                    "eligible_for_text_gens": true,
                    "eligible_for_image_gens": true,
                    "trial_activated": true
                };
                return new Response(JSON.stringify(mockTrial), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Generation Interceptions (Explicitly bypass tag suggestions autocomplete to keep autocomplete functional)
            if (urlString.includes('/ai/generate-image') && !urlString.includes('/suggest-tags')) {
                return handleGenerationIntercept(urlString, config);
            }

            // Route both legacy and new OpenAI-compatible text generation endpoints through our secure fast-track text queue
            if (urlString.includes('/ai/generate-stream') || urlString.includes('/oa/v1/completions')) {
                return handleTextGenerationIntercept(urlString, config);
            }
        }

        return originalFetch(...args);
    };
})();