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
 * 1. Complete HUD Self-Service: Preserves full visibility of Anlas balances, generation limits,
 *    refill countdowns, hardware footprint links, and gateway destination settings.
 * 2. Strict Input Defense: Client-side regex sanitization prevents malformed nicknames from hitting SQLite.
 * 3. Defensive DOM Stacking: Coordinates absolute viewport positioning between the SVG rolling
 *    allowance ring (120px) and the transient queue position banner (175px).
 * 4. High-Frequency UI Enforcement: Fights React SPA DOM purges by holding a 50ms verification
 *    loop during zero-state onboarding.
 */

'use strict';

import { generateUUID } from '../shared/crypto.js';
import { backgroundRequest } from '../shared/network.js';
import { injectWarningBadge, removeWarningBadge } from '../shared/ui.js';
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
            overlay.style.cssText = "position:fixed !important; top:0 !important; left:0 !important; width:100vw !important; height:100vh !important; background:#121212 !important; color:#fff !important; z-index:2147483647 !important; display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:center !important; font-family:sans-serif !important;";
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
        <div class="setup-wizard-card" style="background:#1c1c1c; padding:35px; border-radius:6px; border:1px solid #c0392b; box-shadow:0 8px 30px rgba(0,0,0,0.6); max-width:90vw; width:420px; box-sizing:border-box;">
            <h3 style="margin:0 0 15px 0; color:#00bc8c; text-align:center; letter-spacing:1px; font-size:18px; font-family:sans-serif;">GATEWAY COORDINATOR SETUP</h3>
            
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
                    <input type="text" id="setup-nickname" value="${GM_getValue("device_nickname", "")}" placeholder="e.g. Guest" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:8px; font-size:12px; border-radius:3px;">
                    <button id="btn-register-nickname" style="background:#27ae60; border:none; color:#fff; padding:8px 15px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; font-family:sans-serif;">Register</button>
                </div>
                <div id="step-2-status" style="margin-top:5px; font-size:11px; font-family:sans-serif; display:none;"></div>
            </div>

            <!-- Instructions & Background Verification -->
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
            // Connection evaluation ping targeting the gateway authorization endpoint
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
        if (!newNickname) {
            step2Status.style.display = "block";
            step2Status.style.color = "#e74c3c";
            step2Status.innerHTML = "✗ Nickname cannot be empty.";
            return;
        }
        if (!/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
            step2Status.style.display = "block";
            step2Status.style.color = "#e74c3c";
            step2Status.innerHTML = "✗ Nickname cannot contain special characters.";
            return;
        }

        step2Status.style.display = "block";
        step2Status.style.color = "#f39c12";
        step2Status.innerHTML = "Registering device...";

        try {
            const res = await backgroundRequest({
                method: "POST",
                url: `${validatedHost}/auth/register`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: newNickname })
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
                throw new Error("Registration rejected");
            }
        } catch (err) {
            step2Status.style.color = "#e74c3c";
            step2Status.innerHTML = "✗ Registration failed on server.";
        }
    }

    function showStep3() {
        step3Content.innerHTML = `
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #fff;">Register This Device Natively on Discord:</p>
            <p style="margin: 0 0 10px 0; color: #bbb; line-height: 1.4;">Copy the Browser ID below, navigate to your server, and register using this command:</p>
            <div style="background:#111; padding:10px; border-radius:4px; font-family:monospace; font-size:11px; word-break:break-all; border:1px solid #333; margin-bottom:10px; color:#f39c12; text-align:center; font-weight:bold;">
                /link browser_id:${browserId}
            </div>
            <p style="margin:0; color:#888; font-size:11px; text-align:center; animation: vpsFader 1.5s infinite alternate;">⏳ Polling approval status from Discord registration...</p>
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

    // ----------------- DYNAMIC SETTINGS GEAR MODAL (WITH PROGRESS RING) -----------------
    function injectGearButton() {
        if (document.getElementById("vps-gear-container")) return;

        const container = document.createElement("div");
        container.id = "vps-gear-container";
        // Positioned at bottom: 120px to prevent overlapping bottom mobile toolbars
        container.style.cssText = "position:fixed; bottom:120px; right:15px; width:44px; height:44px; z-index:99999;";

        const gearBtn = document.createElement("button");
        gearBtn.id = "vps-gear-btn";
        gearBtn.innerHTML = "⚙️";
        gearBtn.style.cssText = "width:44px; height:44px; background:#1a1a1a; border:1px solid #c0392b; border-radius:50%; color:#fff; font-size:22px; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 10px rgba(0,0,0,0.5); transition:transform 0.2s; position:relative; z-index:2;";
        gearBtn.onclick = openSettingsModal;

        // Dynamic SVG Circular Rolling Allowance Progress Ring
        const svgRing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgRing.id = "vps-progress-svg";
        svgRing.setAttribute("width", "52");
        svgRing.setAttribute("height", "52");
        svgRing.style.cssText = "position:absolute; top:-4px; left:-4px; z-index:1; pointer-events:none; display:none;";

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.id = "vps-ring-circle";
        circle.setAttribute("stroke", "#e74c3c");
        circle.setAttribute("stroke-width", "3");
        circle.setAttribute("fill", "transparent");
        circle.setAttribute("r", "23");
        circle.setAttribute("cx", "26");
        circle.setAttribute("cy", "26");
        circle.setAttribute("pathLength", "100"); // Normalizes path length to exactly 100 units
        circle.style.cssText = "transition: stroke-dashoffset 0.35s; transform: rotate(-90deg); transform-origin: 50% 50%;";

        svgRing.appendChild(circle);
        container.appendChild(gearBtn);
        container.appendChild(svgRing);
        
        // Set bottom: 175px to stack above the settings gear cleanly on mobile viewports
        const banner = document.getElementById("vps-queue-banner");
        if (banner) {
            banner.style.bottom = "175px"; // Adjust banner to sit stacked cleanly above the gear
            banner.style.right = "15px";
        }
        document.documentElement.appendChild(container);
        if (GM_getValue("debug_mode", false)) {
            injectWarningBadge("⚠️ VPS DEBUG INTENT ACTIVE", "#e67e22");
        }

        startStatePolling();
    }

    function updateProgressRing(percent, color, visible = true) {
        const svg = document.getElementById("vps-progress-svg");
        const circle = document.getElementById("vps-ring-circle");
        if (!svg || !circle) return;

        if (!visible) {
            svg.style.display = "none";
            return;
        }

        svg.style.display = "block";
        // Clamp the percent to protect against rendering wrap-arounds
        const clampedPercent = Math.min(100, Math.max(0, percent));
        
        // Manipulate attributes natively rather than risking CSS length unit issues
        circle.setAttribute("stroke-dasharray", "100");
        circle.setAttribute("stroke-dashoffset", (100 - clampedPercent).toString());
        circle.style.stroke = color;
    }

    function startStatePolling() {
        const poll = async () => {
            try {
                const res = await backgroundRequest({
                    method: "GET",
                    url: `${VPS_HOST}/auth/status?browser_id=${browserId}`,
                    headers: { "Authorization": `Bearer ${deviceSecret}` }
                });
                if (res.status === 200) {
                    const data = JSON.parse(res.responseText);
                    if (data.session) {
                        const allowance = data.session.allowance;
                        const percent = allowance; // Raw tokens represent the visual percentage of 100
                        let color = "#2ecc71"; // Green
                        if (allowance < 20) color = "#e74c3c"; // Red
                        else if (allowance < 50) color = "#f39c12"; // Orange
                        updateProgressRing(percent, color, true);
                    } else {
                        updateProgressRing(0, "transparent", false);
                    }
                }
            } catch (e) {
                console.error("Nai-Guest: Failed to poll session state", e);
            }
        };
        setInterval(poll, 10000);
        poll();
    }

    /**
     * Renders the complete guest settings dashboard and self-service management portal.
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
        backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:99998;";
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
        document.documentElement.appendChild(backdrop);

        modal = document.createElement("div");
        modal.id = "vps-settings-modal";
        modal.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); width:90vw; max-width:420px; background:#1c1c1c; border:1px solid #c0392b; border-radius:6px; z-index:99999; color:#fff; padding:25px; font-family:sans-serif; box-shadow:0 10px 40px rgba(0,0,0,0.6); max-height:90vh; overflow-y:auto; box-sizing:border-box;";
        
        const nickname = GM_getValue("device_nickname", "Guest");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const imageCount = GM_getValue("count_image_gens", 0);
        const textCount = GM_getValue("count_text_gens", 0);
        
        let tier = "Loading...";
        let anlasConsumed = 0;
        let preciseLimit = "Loading...";
        let sessionStatus = "Loading...";
        let linkedDevicesList = '';
        let debugStatusMsg = debugActive ? '✓ Intent active. Awaiting admin authorization.' : 'Disabled';

        try {
            const res = await backgroundRequest({
                method: "GET",
                url: `${domain}/auth/status?browser_id=${browserId}`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            });
            if (res.status === 200) {
                const data = JSON.parse(res.responseText);
                tier = data.tier || "Normal";
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

                if (data.debug_authorized) {
                    const mins = (data.debug_expires_in_ms / 60000).toFixed(1);
                    debugStatusMsg = `<span style="color:#2ecc71; font-weight:bold;">🟢 Authorized by Administrator (${mins}m remaining)</span>`;
                } else if (data.debug_intent) {
                    debugStatusMsg = `<span style="color:#f39c12; font-weight:bold;">⏳ Intent Active. Waiting for Administrator Authorization.</span>`;
                } else {
                    debugStatusMsg = `<span style="color:#888;">Disabled</span>`;
                }
            } else {
                tier = "Unknown";
                sessionStatus = "Error loading";
            }
        } catch (e) {
            tier = "Error fetching";
            sessionStatus = "Network error";
        }

        modal.innerHTML = `
            <h4 style="margin:0 0 15px 0; color:#00bc8c; border-bottom:1px solid #333; padding-bottom:8px; font-size:16px; letter-spacing:0.5px;">VPS GATEWAY CONTROL PORTAL</h4>
            
            <div style="background:#111; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #333; font-size:12px; line-height:1.6;">
                <label style="display:block; font-size:10px; color:#888; font-weight:bold; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Telemetry Stats & Profile</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div>Assigned Tier: <span style="color:#00bc8c; font-weight:bold;">${tier}</span></div>
                    <div>Precise Ref Limit: <span style="color:#f39c12; font-weight:bold;">${preciseLimit}</span></div>
                    <div>Anlas Consumed: <span style="color:#e74c3c; font-weight:bold;">${anlasConsumed} Anlas</span></div>
                    <div>Rolling Allowance: <span style="font-weight:bold;">${sessionStatus}</span></div>
                    <div>Image Gens: <span style="font-weight:bold;">${imageCount}</span></div>
                    <div>Text Gens: <span style="font-weight:bold;">${textCount}</span></div>
                </div>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px; font-weight:bold;">NICKNAME</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-nickname" value="${nickname}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-nickname" style="background:#27ae60; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px;">Save</button>
                </div>
                <div id="settings-nickname-status" style="font-size:10px; margin-top:3px; display:none;"></div>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block; font-size:11px; color:#aaa; margin-bottom:5px; font-weight:bold;">VPS GATEWAY DOMAIN</label>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="settings-domain" value="${domain}" style="flex:1; background:#111; border:1px solid #444; color:#fff; padding:6px; font-size:12px; border-radius:3px;">
                    <button id="btn-save-domain" style="background:#2980b9; border:none; color:#fff; padding:6px 12px; font-size:11px; font-weight:bold; cursor:pointer; border-radius:3px; white-space:nowrap;">Save & Reset</button>
                </div>
            </div>

            <div style="background:#111; padding:12px; border-radius:4px; margin-bottom:15px; border:1px solid #333; font-size:11px;">
                <label style="display:block; font-size:10px; color:#888; font-weight:bold; margin-bottom:6px; text-transform:uppercase;">Hardware Footprints Linked (Max 3)</label>
                <div style="color:#ccc; font-family:monospace; line-height:1.4;">
                    ${linkedDevicesList}
                </div>
                <div style="font-size:10px; color:#666; margin-top:6px;">Prune unneeded profiles natively inside Discord using \`/mygateway unlink\`.</div>
            </div>

            <div style="border-top:1px solid #333; padding-top:12px; margin-top:12px; font-size:11px;">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; font-weight:bold; color:#f39c12;">
                    <input type="checkbox" id="settings-debug" ${debugActive ? 'checked' : ''} style="cursor:pointer;">
                    ENABLE DIAGNOSTIC PROMPT DEBUGGING
                </label>
                <div id="debug-intent-status" style="margin-top:6px; font-size:11px; font-family:sans-serif;">${debugStatusMsg}</div>
                <div id="debug-consent" style="color:#999; margin-top:6px; line-height:1.4; background:#222; padding:8px; border-radius:4px; border-left:2px solid #f39c12; font-size:10px;">
                    <strong>Privacy transparency:</strong> Enabling debugging uploads raw generation payloads to gateway logs for performance troubleshooting. Text prompt contexts, settings, and resolutions will be saved on the VPS. Personal tokens and encrypted databases remain strictly isolated. (Even when checked, diagnostic payloads are <strong>never</strong> recorded unless an administrator also arms a temporary 10-minute inspection window. You may revoke consent at any time by unchecking this box.)
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
        const debugIntentStatus = modal.querySelector("#debug-intent-status");

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
            if (!/^https?:\/\//i.test(val)) {
                val = "https://" + val;
            }
            GM_setValue("vps_host", val);
            GM_setValue("approved", false);
            modal.remove();
            backdrop.remove();
            window.location.reload();
        };

        debugCheckbox.onchange = async () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("⚠️ VPS DEBUG INTENT ACTIVE", "#e67e22");
            else removeWarningBadge();

            debugIntentStatus.style.display = "block";
            debugIntentStatus.style.color = "#f39c12";
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
                        debugIntentStatus.style.color = "#2ecc71";
                        debugIntentStatus.innerHTML = `✓ Authorized by Administrator (${mins}m remaining). Telemetry logging active.`;
                    } else if (checked) {
                        debugIntentStatus.style.color = "#f39c12";
                        debugIntentStatus.innerHTML = "✓ Intent registered on gateway. Awaiting administrator authorization.";
                    } else {
                        debugIntentStatus.style.color = "#888";
                        debugIntentStatus.innerHTML = "✓ Diagnostic debug intent revoked. Logging disabled.";
                    }
                } else {
                    throw new Error("Synchronization rejected");
                }
            } catch (err) {
                debugIntentStatus.style.color = "#e74c3c";
                debugIntentStatus.innerHTML = "✗ Failed to synchronize debug intent with gateway.";
            }
        };
    }

    // High-frequency injection listener to guarantee UI recovery
    setInterval(injectGearButton, 1000);
}