// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Admin Panel)
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  Secure administration panel and session token injector
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *.duckdns.org
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

    // Retrieve host from browser storage; prompt on first run to avoid hardcoding targets
    let VPS_HOST = GM_getValue("vps_host", "");
    if (!VPS_HOST) {
        const inputHost = prompt("Nai-Admin: Enter your VPS Gateway URL (e.g., https://your-domain.duckdns.org):");
        if (inputHost) {
            let sanitized = inputHost.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(sanitized)) {
                sanitized = "https://" + sanitized;
            }
            GM_setValue("vps_host", sanitized);
            VPS_HOST = sanitized;
            alert(`VPS Host saved: ${VPS_HOST}. Reloading page.`);
            window.location.reload();
        } else {
            console.error("Nai-Admin: Missing VPS Gateway target URL. Admin panel deactivated.");
            return;
        }
    }

    // Dynamic configuration modifier key listener (Ctrl + Shift + H) to update VPS target
    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "H") {
            const currentHost = GM_getValue("vps_host", "");
            const newHost = prompt("Enter new VPS Gateway URL (e.g., https://your-domain.duckdns.org):", currentHost);
            if (newHost !== null) {
                let sanitized = newHost.trim().replace(/\/+$/, "");
                if (sanitized && !/^https?:\/\//i.test(sanitized)) {
                    sanitized = "https://" + sanitized;
                }
                GM_setValue("vps_host", sanitized);
                alert("VPS Gateway URL updated. Page reloading.");
                window.location.reload();
            }
        }
    });

    function backgroundRequest(details) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                onload: (r) => resolve(r),
                onerror: (e) => reject(e)
            });
        });
    }

    // Dynamic key entry listener (Ctrl + Shift + A) to set and save admin API secret
    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "A") {
            const token = prompt("Enter Administration secret passkey:");
            if (token) {
                GM_setValue("admin_token", token);
                alert("Passkey saved. Page reloading.");
                window.location.reload();
            }
        }
    });

    const adminToken = GM_getValue("admin_token");
    if (!adminToken) {
        console.warn("Nai-Admin: Administrative token is unconfigured. Press Ctrl + Shift + A to authenticate.");
        return;
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
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
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
                headers: { "Authorization": `Bearer ${adminToken}` }
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
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
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
                            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
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
})();