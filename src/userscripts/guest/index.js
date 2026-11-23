/**
 * GUILDWEAVE GATEWAY COORDINATOR (GUEST CLIENT)
 * Architecture Level 4: Client State Coordinator, Dual-Ledger Telemetry HUD, & Settings Portal
 *
 * Implements client-side metadata spoofing (Opus subscription mapping), dual-ledger HUD rendering
 * (Monthly Anlas balance + debt lockouts + V5 free generation allowance + shared bonus pool +
 * recharge ETA), explicit Anlas usage toggle governance, and redirects generation/upscale operations
 * to the GuildWeave gateway.
 *
 * PROCESS FLOW:
 * 1. Generates unique identities and stores them in sandbox memory (GM_setValue).
 * 2. Authenticates queries using bearer token parameters.
 * 3. Hijacks unsafeWindow.fetch calls to mock tier-specific capabilities.
 * 4. Polls `/auth/status` to keep Rolling Allowance (when Metered), V5 Allowance, Shared Bonus Pool,
 *    cycle-segregated activity counters, and Anlas debt lockouts synchronized across HUD and modal.
 * 5. Escapes all untrusted identifiers before DOM insertion and manages in-band debug consent.
 */

'use strict';

import { generateUUID } from '../shared/crypto.js';
import { backgroundRequest } from '../shared/network.js';
import {
  injectWarningBadge,
  removeWarningBadge,
  updateAllowanceBar,
  updateDualLedgerHud,
  refreshDualLedgerHud,
  syncUIControlConstraints,
  getClientPolicyState,
  setClientPolicyState,
  initDOMObserver,
  ensureGuildWeaveStyles,
  escapeHtml
} from '../shared/ui.js';
import { V5_HIGH_NCP_COST, V5_MEDIUM_NCP_COST } from '../shared/pricing.js';
import { initInterceptor } from '../shared/interceptor.js';

console.log("GuildWeave (Guest): Script injected successfully at document-start.");

let browserId = GM_getValue("browser_id");
let deviceSecret = GM_getValue("device_secret");
let approved = GM_getValue("approved", false);
let VPS_HOST = GM_getValue("vps_host", "");

const DEFAULT_BYPASS_HINT = 'Enables sizes >1MP, batches (>1), and >28 steps using monthly Anlas. On V5 High, steps 24–28 remain blocked to protect shared limits—use ≤23 steps, Medium, or 29+ steps.';

try {
    if (!browserId || !deviceSecret) {
        browserId = 'b_' + generateUUID();
        deviceSecret = 's_' + generateUUID();
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

let enforcementInterval = null;

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

/**
 * Setup Wizard UI instructing guests on Discord slash command usage.
 *
 * @param {HTMLElement} container - Outer viewport overlay mount.
 */
function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card")) return;
    const theme = ensureGuildWeaveStyles();
    const safeHost = escapeHtml(GM_getValue("vps_host", ""));
    const safeNick = escapeHtml(GM_getValue("device_nickname", ""));

    container.innerHTML = `
        <div class="setup-wizard-card gw-card" style="background:var(--theme-bg1, ${theme.bg1}); padding:28px; border-radius:12px; border:1px solid var(--theme-bg2, ${theme.borderStrong}); box-shadow:0 12px 36px rgba(0,0,0,0.6); max-width:90vw; width:430px; color:var(--theme-text, ${theme.text});">
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
            } else {
                throw new Error("Registration rejected");
            }
        } catch (err) {
            step2Status.style.color = `var(--theme-error, ${theme.error})`;
            step2Status.textContent = "Registration failed on server.";
        }
    }

    function showStep3() {
        step3Content.innerHTML = `
            <p style="margin: 0 0 8px 0; font-weight: 600; color: var(--theme-text, ${theme.text});">Link this browser via Discord:</p>
            <p style="margin: 0 0 10px 0;">Run this command in your Discord server to finish linking:</p>
            <div class="gw-code-chip" style="display:block; padding:10px; text-align:center; word-break:break-all; color:var(--theme-warning, ${theme.warning}); margin-bottom:10px;">
                /link browser_id:${escapeHtml(browserId)}
            </div>
            <p style="margin:0; font-size:11px; text-align:center; animation: gwPulse 1.5s infinite alternate;">Waiting for approval...</p>
        `;

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
                    console.warn("GuildWeave (Guest): Server returned 401 during poll. Re-registering silently...");
                    const nickname = GM_getValue("device_nickname", "Guest");
                    backgroundRequest({
                        method: "POST",
                        url: `${validatedHost}/auth/register`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ browser_id: browserId, device_secret: deviceSecret, label: nickname })
                    }).catch(err => console.error("GuildWeave (Guest): Silent re-registration failed:", err));
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

// ----------------- RUNTIME BOOTSTRAP -----------------
if (!approved || !VPS_HOST) {
    startUIEnforcement();
} else {
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
            }
        } catch (e) {
            console.error("GuildWeave (Guest): Failed to poll session state", e);
        }
    }

    initInterceptor({ 
        browserId, 
        deviceSecret, 
        VPS_HOST, 
        logPrefix: 'GuildWeave (Guest)',
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
        },
        onTelemetryRefresh: pollTelemetryState
    });

    function startStatePolling() {
        setInterval(pollTelemetryState, 10000);
    }

    /**
     * Standalone Settings Modal styled using NovelAI's scraped live theme.
     */
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
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
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
        `.replace(/\s+/g, ' ').trim();
        
        renderSettingsPanelContent(modal, () => {
            modal.remove();
            backdrop.remove();
        });

        document.documentElement.appendChild(modal);
    }

    /**
     * Renders the guest settings dashboard with user-friendly language, live theme styling,
     * cycle-segregated server usage telemetry, V5 Allowance explanation, and XSS escaping.
     *
     * @param {HTMLElement} container - Mount destination.
     * @param {Function} [onClose] - Close callback.
     */
    function renderSettingsPanelContent(container, onClose) {
        const theme = ensureGuildWeaveStyles();
        const nickname = GM_getValue("device_nickname", "Guest");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const policyState = getClientPolicyState();
        const bypassChecked = Boolean(policyState.bypassEnabled) && !policyState.isInDebt;

        container.innerHTML = `
            <div class="gw-modal-header">
                <h4 class="gw-modal-title">GuildWeave <span class="gw-pill-tag">Guest</span></h4>
                ${onClose ? `<button id="guest-close-modal-btn" class="gw-close-btn" aria-label="Close">✕</button>` : ''}
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
                        <span id="guest-period-usage" class="gw-stat-val">0 Anlas · 0 images</span>
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
                            ${policyState.isInDebt
                                ? `<span style="color:var(--theme-error, ${theme.error}); font-weight:600;">Anlas Overdrawn: ${escapeHtml(policyState.virtualBalance)} (Paid Features Paused)</span>`
                                : escapeHtml(DEFAULT_BYPASS_HINT)}
                        </span>
                    </div>
                    <input type="checkbox" id="settings-anlas-bypass" class="gw-switch" ${bypassChecked ? 'checked' : ''} ${policyState.isInDebt ? 'disabled' : ''}>
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
                    <div id="guest-linked-devices" class="gw-details-note" style="margin-top:0;">
                        No linked browsers found.
                    </div>
                    <div class="gw-details-note">Remove old browsers in Discord using <span class="gw-code-chip">/mygateway unlink</span>.</div>
                </div>
            </div>

            <div class="gw-card" style="margin-bottom:0;">
                <label class="gw-toggle-row" for="settings-debug">
                    <div class="gw-toggle-copy">
                        <span class="gw-toggle-title">Share Generation Logs for Troubleshooting</span>
                        <span class="gw-toggle-desc">When authorized by an admin, shares your prompt and generation parameters in server logs to diagnose issues. Personal account tokens stay strictly on your device.</span>
                    </div>
                    <input type="checkbox" id="settings-debug" class="gw-switch" ${debugActive ? 'checked' : ''}>
                </label>
                <div id="debug-intent-status" class="gw-feedback" style="color:var(--theme-textSecondary, ${theme.textMuted});">
                    ${debugActive ? 'Waiting for admin confirmation.' : 'Disabled'}
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
            }).then(res => {
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
                            v5BankEl.setAttribute('title', `${data.v5.available_ncp}/${data.v5.max_bank_ncp ?? data.v5.banked_ncp} V5 credits`);
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
                            const pct = typeof data.telemetry.master_v5_percent === 'number'
                                ? `${data.telemetry.master_v5_percent.toFixed(1)}%`
                                : '--%';
                            const eta = typeof data.telemetry.next_percent_eta_ms === 'number' && data.telemetry.next_percent_eta_ms > 0
                                ? ` (+1% in ${(data.telemetry.next_percent_eta_ms / 60000).toFixed(1)}m)`
                                : '';
                            batteryEl.textContent = `${pct}${eta}`;
                        }
                    }

                    const periodEl = container.querySelector("#guest-period-usage");
                    if (periodEl && data.subscription_period) {
                        const sp = data.subscription_period;
                        const totalImgs = (sp.v5_consumed || 0) + (sp.legacy_image_gens || 0) + (sp.upscale_gens || 0);
                        const parts = [`${sp.anlas_consumed || 0} Anlas`, `${totalImgs} images`];
                        if ((sp.text_gens || 0) > 0) parts.push(`${sp.text_gens} text`);
                        periodEl.textContent = parts.join(' · ');
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
                            sessionRow.style.display = 'flex';
                            const allowance = data.session.allowance;
                            const maxAllowance = data.session.max || 100;
                            const refillInMins = (data.session.next_refill_in / 1000 / 60).toFixed(1);
                            const refillText = allowance < maxAllowance ? ` (+1 in ${refillInMins}m)` : ' (Full)';
                            sessionEl.textContent = `${allowance}/${maxAllowance} images${refillText}`;
                        } else {
                            sessionRow.style.display = 'none';
                        }
                    }

                    const devicesEl = container.querySelector("#guest-linked-devices");
                    if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
                        devicesEl.innerHTML = data.linked_devices
                            .map(d => `<div><span class="gw-code-chip">${escapeHtml((d.id || '').substring(0, 10))}...</span> ${escapeHtml(d.label)}</div>`)
                            .join('');
                    }

                    const debugStatus = container.querySelector("#debug-intent-status");
                    if (debugStatus) {
                        if (data.debug_authorized) {
                            const mins = (data.debug_expires_in_ms / 60000).toFixed(1);
                            debugStatus.innerHTML = `<span style="color:var(--theme-success, ${theme.success}); font-weight:600;">Active (${mins}m remaining)</span>`;
                        } else if (data.debug_intent) {
                            debugStatus.innerHTML = `<span style="color:var(--theme-warning, ${theme.warning}); font-weight:600;">Waiting for admin confirmation.</span>`;
                        } else {
                            debugStatus.textContent = "Disabled";
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
            if (typeof onClose === 'function') onClose();
            window.location.reload();
        };

        debugCheckbox.onchange = async () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("GuildWeave Troubleshooting Logs Requested", `var(--theme-warning, ${theme.warning})`);
            else removeWarningBadge();

            debugIntentStatus.style.display = "block";
            debugIntentStatus.style.color = `var(--theme-warning, ${theme.warning})`;
            debugIntentStatus.textContent = checked
                ? "Registering troubleshooting request..."
                : "Disabling troubleshooting logs...";

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
                        debugIntentStatus.style.color = `var(--theme-success, ${theme.success})`;
                        debugIntentStatus.textContent = `Active (${mins}m remaining).`;
                    } else if (checked) {
                        debugIntentStatus.style.color = `var(--theme-warning, ${theme.warning})`;
                        debugIntentStatus.textContent = "Request sent. Waiting for admin confirmation.";
                    } else {
                        debugIntentStatus.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
                        debugIntentStatus.textContent = "Disabled";
                    }
                } else {
                    throw new Error("Synchronization rejected");
                }
            } catch (err) {
                debugIntentStatus.style.color = `var(--theme-error, ${theme.error})`;
                debugIntentStatus.textContent = "Failed to update troubleshooting setting.";
            }
        };
    }

    initDOMObserver({
        onOpenSettings: openSettingsModal
    });

    syncUIControlConstraints(getClientPolicyState());
    startStatePolling();
}