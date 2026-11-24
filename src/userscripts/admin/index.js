/**
 * GUILDWEAVE GATEWAY COORDINATOR (ADMIN PANEL)
 * Architecture Level 4: Administrative UI, Dual-Ledger Governance, & Token Injector
 *
 * Implements a theme-matched administrative control and telemetry console on top of NovelAI.
 * Intercepts outbound generation/upscale requests, executes secure token swaps, exposes
 * billing-cycle-segregated telemetry (`GET /admin/cycles`, `?cycle_epoch=` filtering),
 * Anlas/V5 balances, expired/offline token states, immediate post-push telemetry refresh,
 * 426 version-mismatch surfacing, explicit Pending approval indicators, clickable linked-browser
 * ID copy chips, balance adjustments (`POST /admin/adjust-balance`), debt forgiveness
 * (`POST /admin/reconcile-debt`), escapes all untrusted identifiers against stored XSS,
 * and coordinates bilateral debug gates.
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
  setClientPolicyState,
  setHudAlert,
  initDOMObserver,
  ensureGuildWeaveStyles,
  escapeHtml,
  attachCopyChipHandlers
} from '../shared/ui.js';
import { V5_HIGH_NCP_COST, V5_MEDIUM_NCP_COST } from '../shared/pricing.js';
import { initInterceptor } from '../shared/interceptor.js';

let browserId = GM_getValue("browser_id");
let deviceSecret = GM_getValue("admin_token"); // Admin uses system key directly as secret
let approved = GM_getValue("approved", false);
let VPS_HOST = GM_getValue("vps_host", "");
let currentSort = GM_getValue("admin_sort_mode", "anlas");
let selectedCycleEpoch = ""; // "" -> active billing cycle, "all" -> lifetime, or numeric epoch string
let activeSubTab = "governance"; // "governance" | "settings"
const expandedKeys = new Set();

/**
 * Extracts a human-readable message from an HTTP 426 SCRIPT_UPDATE_REQUIRED payload.
 *
 * @param {string} responseText - Raw JSON response text.
 * @returns {string} Extracted update prompt message.
 */
function parseVersionUpgradeMessage(responseText) {
    let msg = "Your GuildWeave Admin userscript is outdated. Please update to the latest version to proceed.";
    try {
        const parsed = JSON.parse(responseText || '{}');
        if (parsed && typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
            msg = parsed.message;
        }
    } catch (_) {}
    return msg;
}

/**
 * Strictly parses a signed safe integer from admin prompt text.
 * Rejects floats ("12.5") and trailing junk ("50abc") that loose `parseInt()` accepts.
 *
 * @param {string} rawInput - Raw prompt string.
 * @returns {number|null} Validated safe integer or null.
 */
function parseStrictPromptInt(rawInput) {
    if (typeof rawInput !== 'string') return null;
    const trimmed = rawInput.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatCycleLabel(cycle) {
    if (!cycle || !cycle.cycle_epoch) return 'Pre-Cycle Baseline';
    const dt = new Date(cycle.cycle_epoch);
    const dateStr = isNaN(dt.getTime()) ? String(cycle.cycle_epoch) : dt.toLocaleDateString();
    return cycle.is_active ? `Current Cycle (${dateStr})` : `Cycle: ${dateStr}`;
}

try {
    if (!browserId) {
        browserId = 'b_' + generateUUID();
        GM_setValue("browser_id", browserId);
    }
} catch (err) {
    console.error("GuildWeave (Admin): Storage initialization crash:", err);
}

let enforcementInterval = null;

function startUIEnforcement() {
    if (enforcementInterval) return;
    console.log("GuildWeave (Admin): Starting high-frequency UI enforcement loop...");
    enforcementInterval = setInterval(() => {
        if (!document.body) return;

        let overlay = document.getElementById("vps-approval-overlay");
        if (!overlay) {
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
 * Renders the administrative setup configuration wizard.
 *
 * @param {HTMLElement} container - Outer viewport mount target.
 */
function renderSetupWizard(container) {
    if (container.querySelector(".setup-wizard-card")) return;
    const theme = ensureGuildWeaveStyles();
    const safeHost = escapeHtml(GM_getValue("vps_host", ""));
    const safeNick = escapeHtml(GM_getValue("device_nickname", ""));

    container.innerHTML = `
        <div class="setup-wizard-card gw-card" style="background:var(--gw-bg1, ${theme.bg1}); padding:28px; border-radius:12px; border:1px solid var(--gw-card-border, ${theme.cardBorder || theme.borderStrong}); box-shadow:0 12px 36px rgba(0,0,0,0.6); max-width:90vw; width:430px; color:var(--theme-text, ${theme.text});">
            <h3 style="margin:0 0 18px 0; color:var(--theme-accent, ${theme.accent}); text-align:center; font-size:18px; font-weight:700;">GuildWeave Admin Setup</h3>
            
            <div id="step-1-container" style="margin-bottom:18px;">
                <label class="gw-section-title" for="setup-domain">1. GuildWeave Server URL</label>
                <div class="gw-input-row">
                    <input type="text" id="setup-domain" class="gw-input" value="${safeHost}" placeholder="https://your-domain.duckdns.org">
                    <button id="btn-verify-domain" class="gw-btn gw-btn-primary">Verify</button>
                </div>
                <div id="step-1-status" class="gw-feedback" style="display:none;"></div>
            </div>

            <div id="step-2-container" style="margin-bottom:18px; display:none;">
                <label class="gw-section-title" for="setup-nickname">2. Admin Device Name</label>
                <div class="gw-input-row">
                    <input type="text" id="setup-nickname" class="gw-input" value="${safeNick}" placeholder="e.g. Admin">
                    <button id="btn-register-nickname" class="gw-btn gw-btn-success">Register</button>
                </div>
                <div id="step-2-status" class="gw-feedback" style="display:none;"></div>
            </div>

            <div id="step-3-container" style="display:none; border-top:1px solid ${theme.border}; padding-top:14px; margin-top:14px;">
                <label class="gw-section-title">3. Authenticate Admin Key</label>
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
        if (!newNickname || !/^[a-zA-Z0-9_\s]+$/.test(newNickname)) {
            step2Status.style.display = "block";
            step2Status.style.color = `var(--theme-error, ${theme.error})`;
            step2Status.textContent = "Use only letters, numbers, spaces, or underscores.";
            return;
        }

        step2Status.style.display = "block";
        step2Status.style.color = `var(--theme-warning, ${theme.warning})`;
        step2Status.textContent = "Registering device...";

        try {
            const tempSecret = GM_getValue("admin_token", "temp_passkey");
            const res = await backgroundRequest({
                method: "POST",
                url: `${validatedHost}/auth/register`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ browser_id: browserId, device_secret: tempSecret, label: newNickname })
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
            } else if (res.status === 426) {
                step2Status.style.color = `var(--theme-error, ${theme.error})`;
                step2Status.textContent = parseVersionUpgradeMessage(res.responseText);
            } else {
                throw new Error("Registration failed");
            }
        } catch (err) {
            step2Status.style.color = `var(--theme-error, ${theme.error})`;
            step2Status.textContent = "Registration failed on server.";
        }
    }

    function showStep3() {
        step3Content.innerHTML = `
            <div style="margin-bottom:10px;">Enter your administrator passkey to unlock management controls:</div>
            <div class="gw-input-row" style="margin-bottom:8px;">
                <input type="password" id="setup-admin-key" class="gw-input" placeholder="Enter admin passkey...">
                <button id="btn-verify-admin" class="gw-btn gw-btn-danger">Verify</button>
            </div>
            <div id="admin-verify-status" class="gw-feedback" style="display:none;"></div>
        `;

        const adminKeyInput = step3Content.querySelector("#setup-admin-key");
        const verifyAdminBtn = step3Content.querySelector("#btn-verify-admin");
        const adminStatus = step3Content.querySelector("#admin-verify-status");

        verifyAdminBtn.onclick = async () => {
            const passkey = adminKeyInput.value.trim();
            if (!passkey) {
                adminStatus.style.display = "block";
                adminStatus.style.color = `var(--theme-error, ${theme.error})`;
                adminStatus.textContent = "Passkey cannot be empty.";
                return;
            }
            adminStatus.style.display = "block";
            adminStatus.style.color = `var(--theme-warning, ${theme.warning})`;
            adminStatus.textContent = "Verifying passkey...";

            try {
                const res = await backgroundRequest({
                    method: "GET",
                    url: `${validatedHost}/admin/devices`,
                    headers: { "Authorization": `Bearer ${passkey}` }
                });
                if (res.status === 200) {
                    adminStatus.style.color = `var(--theme-success, ${theme.success})`;
                    adminStatus.textContent = "Authenticated. Reloading...";
                    GM_setValue("admin_token", passkey);
                    GM_setValue("approved", true);
                    setTimeout(() => window.location.reload(), 1500);
                } else if (res.status === 426) {
                    adminStatus.style.color = `var(--theme-error, ${theme.error})`;
                    adminStatus.textContent = parseVersionUpgradeMessage(res.responseText);
                } else {
                    throw new Error("Invalid key");
                }
            } catch (err) {
                adminStatus.style.color = `var(--theme-error, ${theme.error})`;
                adminStatus.textContent = "Invalid admin passkey.";
            }
        };
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
if (!approved || !VPS_HOST || !deviceSecret) {
    startUIEnforcement();
} else {
    async function pollAdminTelemetryState() {
        if (!document.getElementById("gw-allowance-bar")) return;
        try {
            const res = await backgroundRequest({
                method: "GET",
                url: `${VPS_HOST}/auth/status?browser_id=${browserId}`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            });
            if (res.status === 200) {
                const data = JSON.parse(res.responseText);
                updateAllowanceBar(null, Infinity, 0);
                updateDualLedgerHud(data);
            } else if (res.status === 426) {
                setHudAlert(parseVersionUpgradeMessage(res.responseText), 'error');
            }
        } catch (e) {
            console.error("GuildWeave (Admin): Failed to poll operator telemetry", e);
        }
    }

    initInterceptor({ 
        browserId, 
        deviceSecret, 
        VPS_HOST, 
        logPrefix: 'GuildWeave (Admin)',
        onRevoked: () => {
            setTimeout(() => {
                if (typeof window !== 'undefined' && window.location) {
                    window.location.reload();
                }
            }, 500);
        },
        onTelemetryRefresh: pollAdminTelemetryState
    });

    function openAdminModal() {
        let modal = document.getElementById("vps-admin-panel");
        let backdrop = document.getElementById("vps-admin-backdrop");
        if (modal) {
            modal.remove();
            if (backdrop) backdrop.remove();
            return;
        }

        const theme = ensureGuildWeaveStyles();

        backdrop = document.createElement("div");
        backdrop.id = "vps-admin-backdrop";
        backdrop.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); backdrop-filter:blur(3px); z-index:99998;";
        backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
        document.documentElement.appendChild(backdrop);

        modal = document.createElement("div");
        modal.id = "vps-admin-panel";
        modal.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 92vw;
          max-width: 500px;
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
        document.documentElement.appendChild(modal);

        renderAdminUnifiedView(modal, () => {
            modal.remove();
            backdrop.remove();
        });
    }

    function renderAdminUnifiedView(container, onClose) {
        if (!container) return;

        const isGovernance = activeSubTab === "governance";

        container.innerHTML = `
            <div class="gw-modal-header">
                <h4 class="gw-modal-title">GuildWeave <span class="gw-pill-tag">Admin</span></h4>
                ${onClose ? `<button id="admin-close-modal-btn" class="gw-close-btn" aria-label="Close">✕</button>` : ''}
            </div>

            <div class="gw-tabs">
                <button id="admin-tab-governance" class="gw-tab-btn ${isGovernance ? 'is-active' : ''}">
                    Account Governance
                </button>
                <button id="admin-tab-settings" class="gw-tab-btn ${!isGovernance ? 'is-active' : ''}">
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
     * Sub-Tab 1: Account Governance, Billing Cycle Filter, Cluster Surplus Telemetry,
     * Balance Adjustment, & Master Session Token Injector.
     *
     * @param {HTMLElement} contentHost - Inner content container.
     * @param {HTMLElement} parentContainer - Outer dialog container.
     * @param {Function} [onClose] - Close handler.
     */
    async function renderGovernanceTab(contentHost, parentContainer, onClose) {
        const theme = ensureGuildWeaveStyles();
        const cycleQuery = selectedCycleEpoch ? `?cycle_epoch=${encodeURIComponent(selectedCycleEpoch)}` : '';

        contentHost.innerHTML = `
            <div class="gw-card">
                <span class="gw-section-title">Master NovelAI Session Token</span>
                <div class="gw-input-row">
                    <input type="password" id="vps-master-token-input" class="gw-input" placeholder="Paste Opus token (JWT / pst-...)">
                    <button id="vps-btn-push-token" class="gw-btn gw-btn-success">Save Token</button>
                </div>
            </div>

            <div id="admin-cluster-telemetry" class="gw-card" style="padding:10px 14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; font-size:11px;">
                    <span>Pool: <strong id="admin-stat-battery" style="color:var(--theme-accent, ${theme.accent});">--%</strong></span>
                    <span>Shared Bonus: <strong id="admin-stat-surplus" style="color:var(--theme-warning, ${theme.warning});">-- pts</strong></span>
                    <span>Master Anlas: <strong id="admin-stat-anlas">--</strong></span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; padding-top:8px; border-top:1px solid ${theme.border}; font-size:11px;">
                    <span style="color:var(--theme-textSecondary, ${theme.textMuted});">Telemetry Period:</span>
                    <select id="admin-cycle-select" class="gw-select" style="padding:3px 6px; font-size:11px;">
                        <option value="" ${selectedCycleEpoch === '' ? 'selected' : ''}>Current Billing Cycle</option>
                        <option value="all" ${selectedCycleEpoch === 'all' ? 'selected' : ''}>All Time</option>
                    </select>
                </div>
            </div>

            <div style="padding-top:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span class="gw-section-title" style="margin:0;">Accounts</span>
                    <div style="display:flex; gap:8px; font-size:11px;">
                        <a href="#" class="sort-trigger" data-sort="anlas" style="color:${currentSort === 'anlas' ? `var(--theme-accent, ${theme.accent}); font-weight:700` : `var(--theme-textSecondary, ${theme.textMuted})`}; text-decoration:none;">Anlas</a>
                        <a href="#" class="sort-trigger" data-sort="reqs" style="color:${currentSort === 'reqs' ? `var(--theme-accent, ${theme.accent}); font-weight:700` : `var(--theme-textSecondary, ${theme.textMuted})`}; text-decoration:none;">Requests</a>
                        <a href="#" class="sort-trigger" data-sort="active" style="color:${currentSort === 'active' ? `var(--theme-accent, ${theme.accent}); font-weight:700` : `var(--theme-textSecondary, ${theme.textMuted})`}; text-decoration:none;">Active</a>
                        <a href="#" class="sort-trigger" data-sort="status" style="color:${currentSort === 'status' ? `var(--theme-accent, ${theme.accent}); font-weight:700` : `var(--theme-textSecondary, ${theme.textMuted})`}; text-decoration:none;">Online</a>
                    </div>
                </div>

                <div id="vps-client-list" style="font-size:12px; display:flex; flex-direction:column; gap:8px;">
                    Loading accounts...
                </div>
            </div>
        `;

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
                    if (res.status === 200) {
                        alert("Master Token saved securely.");
                        pollAdminTelemetryState();
                        renderGovernanceTab(contentHost, parentContainer, onClose);
                    } else if (res.status === 426) {
                        alert(parseVersionUpgradeMessage(res.responseText));
                    } else {
                        alert("Token registration denied.");
                    }
                } catch (e) {
                    alert("Communication execution failed.");
                }
            };
        }

        const cycleSelect = contentHost.querySelector("#admin-cycle-select");
        if (cycleSelect) {
            cycleSelect.onchange = () => {
                selectedCycleEpoch = cycleSelect.value;
                renderGovernanceTab(contentHost, parentContainer, onClose);
            };
            backgroundRequest({
                method: "GET",
                url: `${VPS_HOST}/admin/cycles`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            }).then(cRes => {
                if (cRes && cRes.status === 200 && cRes.responseText) {
                    const parsed = JSON.parse(cRes.responseText);
                    const cycles = Array.isArray(parsed.cycles) ? parsed.cycles : [];
                    const opts = [
                        `<option value="" ${selectedCycleEpoch === '' ? 'selected' : ''}>Current Billing Cycle</option>`,
                        ...cycles.map(c => {
                            const val = String(c.cycle_epoch);
                            const sel = selectedCycleEpoch === val ? 'selected' : '';
                            return `<option value="${escapeHtml(val)}" ${sel}>${escapeHtml(formatCycleLabel(c))}</option>`;
                        }),
                        `<option value="all" ${selectedCycleEpoch === 'all' ? 'selected' : ''}>All Time</option>`
                    ];
                    cycleSelect.innerHTML = opts.join('');
                }
            }).catch(() => {});
        }

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
                url: `${VPS_HOST}/admin/devices${cycleQuery}`,
                headers: { "Authorization": `Bearer ${deviceSecret}` }
            });
            if (res.status === 200) {
                let groups = JSON.parse(res.responseText);
                const container = contentHost.querySelector("#vps-client-list");
                if (!container) return;

                backgroundRequest({
                    method: "GET",
                    url: `${VPS_HOST}/admin/global-stats${cycleQuery}`,
                    headers: { "Authorization": `Bearer ${deviceSecret}` }
                }).then(statsRes => {
                    if (statsRes && statsRes.status === 200 && statsRes.responseText) {
                        const stats = JSON.parse(statsRes.responseText);
                        const batEl = contentHost.querySelector("#admin-stat-battery");
                        if (batEl && stats.telemetry) {
                            const pctStr = typeof stats.telemetry.master_v5_percent === 'number'
                                ? `${stats.telemetry.master_v5_percent.toFixed(1)}%`
                                : '--%';
                            if (stats.telemetry.master_token_expired) {
                                batEl.style.color = `var(--theme-error, ${theme.error})`;
                                batEl.textContent = '[TOKEN EXPIRED]';
                            } else if (stats.telemetry.last_fetched_at === 0) {
                                batEl.style.color = `var(--theme-warning, ${theme.warning})`;
                                batEl.textContent = '[OFFLINE]';
                            } else if (stats.telemetry.subscription_active === false) {
                                batEl.style.color = `var(--theme-error, ${theme.error})`;
                                batEl.textContent = `${pctStr} [INACTIVE]`;
                            } else if (stats.telemetry.is_grace_period) {
                                batEl.style.color = `var(--theme-warning, ${theme.warning})`;
                                batEl.textContent = `${pctStr} [GRACE]`;
                            } else {
                                batEl.style.color = `var(--theme-accent, ${theme.accent})`;
                                batEl.textContent = pctStr;
                            }
                        }
                        const surEl = contentHost.querySelector("#admin-stat-surplus");
                        if (surEl && typeof stats.v5_surplus_available === 'number') {
                            surEl.textContent = `${stats.v5_surplus_available}/${stats.v5_surplus_pool} pts`;
                        }
                        const anlasStatEl = contentHost.querySelector("#admin-stat-anlas");
                        if (anlasStatEl && stats.telemetry) {
                            if (stats.telemetry.master_anlas !== null && stats.telemetry.master_anlas !== undefined) {
                                anlasStatEl.textContent = `${stats.telemetry.master_anlas}`;
                            } else {
                                anlasStatEl.textContent = '--';
                            }
                        }
                    }
                }).catch(() => {});

                if (groups.length === 0) {
                    container.textContent = "No clients pending registration.";
                    return;
                }

                const usePeriodSort = selectedCycleEpoch !== 'all';
                groups.sort((a, b) => {
                    if (currentSort === "anlas") {
                        const valA = usePeriodSort ? (a.subscription_period_anlas ?? a.anlas_consumed) : a.anlas_consumed;
                        const valB = usePeriodSort ? (b.subscription_period_anlas ?? b.anlas_consumed) : b.anlas_consumed;
                        return valB - valA;
                    }
                    if (currentSort === "reqs") {
                        const reqA = usePeriodSort ? (a.subscription_period_requests ?? a.total_requests) : a.total_requests;
                        const reqB = usePeriodSort ? (b.subscription_period_requests ?? b.total_requests) : b.total_requests;
                        return reqB - reqA;
                    }
                    if (currentSort === "active") return b.last_active_at - a.last_active_at;
                    if (currentSort === "status") return (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0);
                    return 0;
                });

                container.innerHTML = "";
                groups.forEach(group => {
                    const selectorId = group.user_id || group.discord_id || (group.devices && group.devices[0] ? group.devices[0].browser_id : '');
                    const safeSelectorId = escapeHtml(selectorId);
                    const safeName = escapeHtml(group.discord_username || 'Guest');
                    const isLinked = !!group.discord_id;
                    const isExpanded = expandedKeys.has(selectorId);

                    const el = document.createElement("div");
                    el.style.cssText = `background:var(--gw-bg1, ${theme.bg1}); border-radius:8px; border:1px solid ${group.banned === 1 ? `var(--theme-error, ${theme.error})` : `var(--gw-card-border, ${theme.cardBorder || theme.border})`}; overflow:hidden; display:flex; flex-direction:column; transition:border-color 0.2s;`;

                    const statusDotColor = group.is_online ? `var(--theme-success, ${theme.success})` : `var(--theme-textSecondary, ${theme.textMuted})`;
                    const statusTitle = group.is_online ? "Online" : "Offline";
                    const bannedBadge = group.banned === 1
                        ? `<span style="background:var(--theme-error, ${theme.error}); color:#fff; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">BANNED</span>`
                        : '';
                    const pendingBadge = (group.banned !== 1 && group.approved !== 1)
                        ? `<span style="background:var(--theme-warning, ${theme.warning}); color:#1f1404; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">PENDING</span>`
                        : '';
                    const debtBadge = group.is_in_debt
                        ? `<span style="background:var(--theme-error, ${theme.error}); color:#fff; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">DEBT</span>`
                        : '';

                    let headerDebugBadge = '';
                    if (group.has_debug_authorized) {
                        headerDebugBadge = `<span style="background:var(--theme-success, ${theme.success}); color:#0b1912; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">LOGS ON</span>`;
                    } else if (group.has_debug_intent) {
                        headerDebugBadge = `<span style="background:var(--theme-warning, ${theme.warning}); color:#1f1404; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">LOGS REQ</span>`;
                    }

                    const headerAnlas = usePeriodSort ? (group.subscription_period_anlas ?? group.anlas_consumed ?? 0) : (group.anlas_consumed ?? 0);
                    const headerReqs = usePeriodSort
                        ? (group.subscription_period_requests ?? ((group.subscription_period_v5 || 0) + (group.subscription_period_legacy_images || 0)) ?? group.total_requests ?? 0)
                        : (group.total_requests ?? 0);

                    el.innerHTML = `
                        <div class="client-card-header" data-key="${safeSelectorId}" style="padding:10px 12px; cursor:pointer; display:flex; align-items:center; justify-content:space-between; background:var(--theme-bg0, ${theme.bg0}); user-select:none;">
                            <div style="display:flex; align-items:center; gap:8px; max-width:65%; min-width:0;">
                                <div style="width:7px; height:7px; border-radius:50%; background:${statusDotColor}; flex-shrink:0;" title="${statusTitle}"></div>
                                <span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--theme-text, ${theme.text});">${safeName}</span>
                                ${bannedBadge}
                                ${pendingBadge}
                                ${debtBadge}
                                ${headerDebugBadge}
                            </div>
                            <div style="font-size:11px; color:var(--theme-textSecondary, ${theme.textMuted}); display:flex; gap:10px; align-items:center; font-variant-numeric:tabular-nums;">
                                <span style="color:var(--theme-accent, ${theme.accent}); font-weight:600;">${headerAnlas}A</span>
                                <span style="font-weight:600;">${headerReqs}R</span>
                                <span style="font-size:9px;">${isExpanded ? '▲' : '▼'}</span>
                            </div>
                        </div>
                    `;

                    if (isExpanded) {
                        const body = document.createElement("div");
                        body.style.cssText = `padding:12px; border-top:1px solid ${theme.border}; background:var(--gw-bg1, ${theme.bg1}); display:flex; flex-direction:column; gap:10px;`;

                        let devicesHtml = '';
                        (group.devices || []).forEach(d => {
                            const safeBid = escapeHtml(d.browser_id);
                            const safeBidShort = escapeHtml((d.browser_id || '').substring(0, 8));
                            const safeDevLabel = escapeHtml(d.label || 'Unnamed Browser');
                            const devOnlineColor = d.is_online ? `var(--theme-success, ${theme.success})` : `var(--theme-textSecondary, ${theme.textMuted})`;
                            const devBannedBadge = d.banned === 1 ? `<span style="color:var(--theme-error, ${theme.error}); font-weight:700; margin-left:4px;">(Banned)</span>` : '';
                            const devPendingBadge = (d.banned !== 1 && d.approved !== 1) ? `<span style="color:var(--theme-warning, ${theme.warning}); font-weight:700; margin-left:4px;">(Pending)</span>` : '';
                            const allowanceBadge = d.metered_allowance !== null ? `<span style="color:var(--theme-warning, ${theme.warning}); font-weight:600; margin-left:6px;">[${escapeHtml(d.metered_allowance)}/100]</span>` : '';

                            let devDebugBadge = '';
                            let devDebugBtn = '';

                            if (d.debug_authorized) {
                                const minsLeft = (d.debug_expires_in_ms / 60000).toFixed(1);
                                devDebugBadge = `<span style="background:var(--theme-success, ${theme.success}); color:#0b1912; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">Logs (${minsLeft}m)</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug gw-btn gw-btn-warning gw-btn-sm" data-id="${safeBid}" data-action="disarm">Disarm</button>`;
                            } else if (d.debug_intent) {
                                devDebugBadge = `<span style="background:var(--theme-warning, ${theme.warning}); color:#1f1404; font-size:9px; padding:1px 5px; border-radius:999px; font-weight:700; margin-left:4px;">Logs Requested</span>`;
                                devDebugBtn = `<button class="btn-toggle-debug gw-btn gw-btn-primary gw-btn-sm" data-id="${safeBid}" data-action="arm">Authorize (10m)</button>`;
                            }

                            devicesHtml += `
                                <div style="font-size:11px; color:var(--theme-textSecondary, ${theme.textMuted}); padding:6px 0; border-bottom:1px solid ${theme.border}; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                    <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1;">
                                        <div style="width:6px; height:6px; border-radius:50%; background:${devOnlineColor}; flex-shrink:0;"></div>
                                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--theme-text, ${theme.text});"><strong>${safeDevLabel}</strong> ${devBannedBadge}${devPendingBadge}${allowanceBadge}${devDebugBadge} <span role="button" tabindex="0" class="gw-code-chip gw-copy-chip" data-copy-id="${safeBid}" title="Click to copy full browser ID (${safeBid})">${safeBidShort}...</span></span>
                                    </div>
                                    <div style="display:flex; gap:4px; align-items:center;">
                                        ${devDebugBtn}
                                        <button class="btn-prune-dev gw-btn gw-btn-sm" data-id="${safeBid}">Prune</button>
                                    </div>
                                </div>
                            `;
                        });

                        const lastActiveDate = group.last_active_at > 0 ? new Date(group.last_active_at).toLocaleTimeString() : 'Never';
                        const virtualAnlasStr = group.anlas_unlimited
                            ? 'Unlimited'
                            : (group.virtual_anlas_balance !== undefined ? `${group.available_anlas_balance ?? group.virtual_anlas_balance}/${group.virtual_anlas_balance}` : '--');
                        const v5Avail = group.v5_available_balance ?? group.v5_banked_balance ?? 0;
                        const v5BankStr = group.v5_banked_balance !== undefined
                            ? `${Math.floor(v5Avail / V5_HIGH_NCP_COST)}H / ${Math.floor(v5Avail / V5_MEDIUM_NCP_COST)}M (${v5Avail}/${group.v5_banked_balance} pts)`
                            : '--';
                        const periodParts = [
                            `${group.subscription_period_anlas ?? 0}A`,
                            `${group.subscription_period_v5 ?? 0} V5`
                        ];
                        if ((group.subscription_period_legacy_images || 0) > 0) periodParts.push(`${group.subscription_period_legacy_images} Leg`);
                        if ((group.subscription_period_upscales || 0) > 0) periodParts.push(`${group.subscription_period_upscales} Up`);
                        if ((group.subscription_period_text_gens || 0) > 0) periodParts.push(`${group.subscription_period_text_gens} Txt`);
                        const periodStr = periodParts.join(' · ');

                        const banToggleBtn = group.banned === 1
                            ? `<button class="btn-unban-group gw-btn gw-btn-success" data-key="${safeSelectorId}" data-is-discord="${isLinked}" style="flex:1;">UNBAN USER</button>`
                            : `<button class="btn-ban-group gw-btn gw-btn-danger" data-key="${safeSelectorId}" data-is-discord="${isLinked}" style="flex:1;">BAN USER</button>`;

                        const forgiveBtn = group.is_in_debt
                            ? `<button class="btn-reconcile-debt gw-btn gw-btn-warning gw-btn-sm" data-key="${safeSelectorId}" data-is-discord="${isLinked}">FORGIVE DEBT</button>`
                            : '';

                        body.innerHTML = `
                            <div class="gw-stat-grid" style="font-size:11px;">
                                <div class="gw-stat-item"><span class="gw-stat-label">Tier</span><span class="gw-stat-val" style="color:var(--theme-accent, ${theme.accent});">${escapeHtml(group.priority_tier)}</span></div>
                                <div class="gw-stat-item"><span class="gw-stat-label">Last Active</span><span class="gw-stat-val">${escapeHtml(lastActiveDate)}</span></div>
                                <div class="gw-stat-item"><span class="gw-stat-label">Monthly Anlas</span><span class="gw-stat-val" style="color:${group.is_in_debt ? `var(--theme-error, ${theme.error})` : `var(--theme-accent, ${theme.accent})`};">${escapeHtml(virtualAnlasStr)}</span></div>
                                <div class="gw-stat-item"><span class="gw-stat-label">V5 Reserve</span><span class="gw-stat-val">${escapeHtml(v5BankStr)}</span></div>
                                <div class="gw-stat-item"><span class="gw-stat-label">Period Activity</span><span class="gw-stat-val">${escapeHtml(periodStr)}</span></div>
                                <div class="gw-stat-item"><span class="gw-stat-label">Discord ID</span><span class="gw-code-chip">${escapeHtml(group.discord_id || 'Unlinked')}</span></div>
                            </div>

                            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                                ${!group.anlas_unlimited ? `<button class="btn-adjust-anlas gw-btn gw-btn-sm" data-key="${safeSelectorId}" data-is-discord="${isLinked}">ADJUST ANLAS</button>` : ''}
                                <button class="btn-adjust-v5 gw-btn gw-btn-sm" data-key="${safeSelectorId}" data-is-discord="${isLinked}">ADJUST V5 NCP</button>
                                ${forgiveBtn}
                            </div>

                            <div style="background:var(--theme-bg0, ${theme.bg0}); padding:8px 10px; border-radius:6px; border:1px solid ${theme.border};">
                                <span class="gw-section-title" style="margin-bottom:4px;">Linked Browsers</span>
                                ${devicesHtml || `<div class="gw-details-note" style="margin:0;">No browsers linked.</div>`}
                            </div>

                            <div style="display:flex; gap:6px; margin-top:2px;">
                                <select id="tier-select-${safeSelectorId}" class="gw-select" style="padding:5px 8px; font-size:11px;">
                                    <option value="Metered" ${group.priority_tier === 'Metered' ? 'selected' : ''}>Metered</option>
                                    <option value="Low" ${group.priority_tier === 'Low' ? 'selected' : ''}>Low</option>
                                    <option value="Normal" ${group.priority_tier === 'Normal' ? 'selected' : ''}>Normal</option>
                                    <option value="High" ${group.priority_tier === 'High' ? 'selected' : ''}>High</option>
                                    <option value="Admin" ${group.priority_tier === 'Admin' ? 'selected' : ''}>Admin</option>
                                </select>
                                <button class="btn-approve-group gw-btn gw-btn-primary" data-key="${safeSelectorId}" data-is-discord="${isLinked}" style="flex:1;">APPROVE &amp; SET</button>
                                <button class="btn-revoke-group gw-btn" data-key="${safeSelectorId}" data-is-discord="${isLinked}" style="flex:1;">REVOKE</button>
                                ${banToggleBtn}
                            </div>
                        `;
                        el.appendChild(body);
                    }

                    container.appendChild(el);
                });

                attachCopyChipHandlers(container);

                contentHost.querySelectorAll(".client-card-header").forEach(h => {
                    h.onclick = (e) => {
                        const key = e.currentTarget.getAttribute("data-key");
                        if (expandedKeys.has(key)) expandedKeys.delete(key);
                        else expandedKeys.add(key);
                        renderGovernanceTab(contentHost, parentContainer, onClose);
                    };
                });

                contentHost.querySelectorAll(".btn-adjust-anlas").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const rawDelta = prompt("Enter signed integer Anlas delta (e.g. 100 or -50):");
                        if (rawDelta === null) return;
                        const delta = parseStrictPromptInt(rawDelta);
                        if (delta === null) return alert("Invalid integer delta.");
                        const payload = isDiscord ? { discord_id: key, anlas_delta: delta } : { user_id: key, anlas_delta: delta };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/adjust-balance`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                        else if (actionRes.status === 426) alert(parseVersionUpgradeMessage(actionRes.responseText));
                        else alert("Failed to adjust Anlas balance.");
                    };
                });

                contentHost.querySelectorAll(".btn-adjust-v5").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const rawDelta = prompt("Enter signed integer V5 credit delta (18 per High, 10 per Med):");
                        if (rawDelta === null) return;
                        const delta = parseStrictPromptInt(rawDelta);
                        if (delta === null) return alert("Invalid integer delta.");
                        const payload = isDiscord ? { discord_id: key, v5_ncp_delta: delta } : { user_id: key, v5_ncp_delta: delta };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/adjust-balance`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                        else if (actionRes.status === 426) alert(parseVersionUpgradeMessage(actionRes.responseText));
                        else alert("Failed to adjust V5 credits.");
                    };
                });

                contentHost.querySelectorAll(".btn-reconcile-debt").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        if (!confirm(`Forgive outstanding Anlas debt for ${key}?`)) return;
                        const payload = isDiscord ? { discord_id: key } : { user_id: key };
                        const actionRes = await backgroundRequest({
                            method: "POST",
                            url: `${VPS_HOST}/admin/reconcile-debt`,
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deviceSecret}` },
                            data: JSON.stringify(payload)
                        });
                        if (actionRes.status === 200) renderGovernanceTab(contentHost, parentContainer, onClose);
                        else if (actionRes.status === 426) alert(parseVersionUpgradeMessage(actionRes.responseText));
                        else alert("Failed to reconcile Anlas debt.");
                    };
                });

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

                contentHost.querySelectorAll(".btn-approve-group").forEach(b => {
                    b.onclick = async (e) => {
                        const target = e.currentTarget;
                        const key = target.getAttribute("data-key");
                        const isDiscord = target.getAttribute("data-is-discord") === "true";
                        const tierSelect = document.getElementById(`tier-select-${key}`) || contentHost.querySelector(`#tier-select-${key}`);
                        const tier = tierSelect ? tierSelect.value : 'Normal';
                        
                        const payload = isDiscord ? { discord_id: key, priority_tier: tier } : { user_id: key, priority_tier: tier };
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

                        const payload = isDiscord ? { discord_id: key } : { user_id: key };
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

                        const payload = isDiscord ? { discord_id: key, reason } : { user_id: key, reason };
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
                        const payload = isDiscord ? { discord_id: key } : { user_id: key };
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
            } else if (res.status === 426) {
                const msg = parseVersionUpgradeMessage(res.responseText);
                setHudAlert(msg, 'error');
                const container = contentHost.querySelector("#vps-client-list");
                if (container) {
                    container.innerHTML = `<div style="color:var(--theme-error, ${theme.error}); font-weight:600;">${escapeHtml(msg)}</div>`;
                }
            } else {
                const container = contentHost.querySelector("#vps-client-list");
                if (container) container.textContent = `Error retrieving system data records (HTTP ${res.status}).`;
            }
        } catch (e) {
            const container = contentHost.querySelector("#vps-client-list");
            if (container) container.textContent = "Error retrieving system data records.";
        }
    }

    /**
     * Sub-Tab 2: Operator Profile, Dual-Ledger Telemetry, Billing-Cycle Usage,
     * Extra Specs Anlas Toggle, Device Name, Server URL, and Logging Consent.
     * Rolling Allowance is omitted completely since Admin is always exempt.
     *
     * @param {HTMLElement} contentHost - Inner content container.
     * @param {Function} [onClose] - Close handler.
     */
    function renderOperatorSettingsTab(contentHost, onClose) {
        const theme = ensureGuildWeaveStyles();
        const nickname = GM_getValue("device_nickname", "Admin");
        const domain = GM_getValue("vps_host", "");
        const debugActive = GM_getValue("debug_mode", false);
        const bypassChecked = Boolean(GM_getValue("anlas_bypass_enabled", false));

        contentHost.innerHTML = `
            <div class="gw-card">
                <span class="gw-section-title">Operator Overview</span>
                <div class="gw-stat-grid">
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Tier</span>
                        <span class="gw-stat-val" style="color:var(--theme-accent, ${theme.accent});">Admin</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Character Reference Limit</span>
                        <span id="operator-precise-limit" class="gw-stat-val">Unlimited</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Shared V5 Capacity</span>
                        <span id="operator-v5-battery" class="gw-stat-val">--%</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Shared Bonus Pool</span>
                        <span id="operator-v5-surplus" class="gw-stat-val">--</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">This Billing Cycle</span>
                        <span id="operator-period-usage" class="gw-stat-val">0 Anlas · 0 images</span>
                    </div>
                    <div class="gw-stat-item">
                        <span class="gw-stat-label">Total Anlas Used</span>
                        <span id="operator-anlas-consumed" class="gw-stat-val">0 Anlas</span>
                    </div>
                </div>
            </div>

            <div class="gw-card">
                <label class="gw-toggle-row" for="settings-anlas-bypass">
                    <div class="gw-toggle-copy">
                        <span class="gw-toggle-title">Use Anlas for Extra Specs</span>
                        <span class="gw-toggle-desc">Enables sizes &gt;1MP, batches (&gt;1), and &gt;28 steps.</span>
                    </div>
                    <input type="checkbox" id="settings-anlas-bypass" class="gw-switch" ${bypassChecked ? 'checked' : ''}>
                </label>
            </div>

            <div class="gw-card">
                <span class="gw-section-title">Terminal Settings</span>
                <div style="margin-bottom:12px;">
                    <label class="gw-stat-label" for="settings-nickname" style="display:block; margin-bottom:5px;">Admin Device Name</label>
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
                    <div id="operator-linked-devices" class="gw-details-note" style="margin-top:0; display:flex; flex-direction:column; gap:4px;">
                        No other active links.
                    </div>
                </div>
            </div>

            <div class="gw-card" style="margin-bottom:0;">
                <label class="gw-toggle-row" for="settings-debug">
                    <div class="gw-toggle-copy">
                        <span class="gw-toggle-title">Log Generation Payloads</span>
                        <span class="gw-toggle-desc">Prints prompts and generation parameters from this terminal to server logs for troubleshooting. Master and personal tokens stay isolated.</span>
                    </div>
                    <input type="checkbox" id="settings-debug" class="gw-switch" ${debugActive ? 'checked' : ''}>
                </label>
            </div>
        `;

        const bypassCheckbox = contentHost.querySelector("#settings-anlas-bypass");
        if (bypassCheckbox) {
            bypassCheckbox.onchange = () => {
                const checked = Boolean(bypassCheckbox.checked);
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
                    const anlasEl = contentHost.querySelector('#operator-anlas-consumed');
                    if (anlasEl) anlasEl.textContent = `${data.anlas_consumed || 0} Anlas`;
                    const periodEl = contentHost.querySelector('#operator-period-usage');
                    if (periodEl && data.subscription_period) {
                        const sp = data.subscription_period;
                        const totalImgs = (sp.v5_consumed || 0) + (sp.legacy_image_gens || 0) + (sp.upscale_gens || 0);
                        const parts = [`${sp.anlas_consumed || 0} Anlas`, `${totalImgs} images`];
                        if ((sp.text_gens || 0) > 0) parts.push(`${sp.text_gens} text`);
                        periodEl.textContent = parts.join(' · ');
                    }
                    const refEl = contentHost.querySelector('#operator-precise-limit');
                    if (refEl) refEl.textContent = data.precise_limit === "Unlimited" ? "Unlimited" : `${data.precise_limit} max`;
                    const batEl = contentHost.querySelector('#operator-v5-battery');
                    if (batEl && data.telemetry) {
                        if (data.telemetry.master_token_expired) {
                            batEl.style.color = `var(--theme-error, ${theme.error})`;
                            batEl.textContent = '[TOKEN EXPIRED]';
                        } else if (data.telemetry.last_fetched_at === 0) {
                            batEl.style.color = `var(--theme-warning, ${theme.warning})`;
                            batEl.textContent = '[OFFLINE]';
                        } else if (typeof data.telemetry.master_v5_percent === 'number') {
                            const subSuffix = data.telemetry.subscription_active === false ? ' [INACTIVE]' : '';
                            batEl.textContent = `${data.telemetry.master_v5_percent.toFixed(1)}%${subSuffix}`;
                        }
                    }
                    const surEl = contentHost.querySelector('#operator-v5-surplus');
                    if (surEl && data.v5) {
                        const surHigh = Math.floor((data.v5.surplus_available_ncp || 0) / V5_HIGH_NCP_COST);
                        surEl.textContent = surHigh > 0 ? `+${surHigh} High (${data.v5.surplus_available_ncp} pts)` : '0 shared';
                    }
                    const devicesEl = contentHost.querySelector('#operator-linked-devices');
                    if (devicesEl && data.linked_devices && data.linked_devices.length > 0) {
                        devicesEl.innerHTML = data.linked_devices
                            .map(d => {
                                const fullId = escapeHtml(d.id || '');
                                const shortId = escapeHtml((d.id || '').substring(0, 10));
                                return `<div><span role="button" tabindex="0" class="gw-code-chip gw-copy-chip" data-copy-id="${fullId}" title="Click to copy full browser ID (${fullId})">${shortId}...</span> ${escapeHtml(d.label)}</div>`;
                            })
                            .join('');
                        attachCopyChipHandlers(devicesEl);
                    }
                } else if (res.status === 426) {
                    setHudAlert(parseVersionUpgradeMessage(res.responseText), 'error');
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
                } else if (res.status === 426) {
                    nickStatus.style.color = `var(--theme-error, ${theme.error})`;
                    nickStatus.textContent = parseVersionUpgradeMessage(res.responseText);
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

        debugCheckbox.onchange = () => {
            const checked = debugCheckbox.checked;
            GM_setValue("debug_mode", checked);
            if (checked) injectWarningBadge("GuildWeave Operator Logging Active", `var(--theme-error, ${theme.error})`);
            else removeWarningBadge();
        };
    }

    initDOMObserver({
        onOpenSettings: openAdminModal
    });

    updateAllowanceBar(null, Infinity, 0);
    setInterval(pollAdminTelemetryState, 10000);
}