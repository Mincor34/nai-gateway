/**
 * SHARED INTERFACE & HUD CONTROLLER (src/userscripts/shared/ui.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Visual Hierarchy Isolation: Overlays, banners, and status monitors must sit on elevated
 *    z-index planes (`99998` - `99999`) to prevent the NovelAI React SPA modals from obscuring
 *    queue state telemetry.
 * 2. Viewport Collision Prevention: Stacks queue notification banners at `bottom: 175px` so they
 *    do not collide with the settings gear button located at `bottom: 120px` on mobile viewports.
 * 3. Autonomous Animation Styling: Injects isolated keyframe animations (`@keyframes vpsPulse`)
 *    dynamically to eliminate external CSS dependencies.
 */

'use strict';

/**
 * Displays or updates the persistent HUD banner indicating queue state or position.
 *
 * @param {string} text - Telemetry status text to display.
 */
export function showQueueStatusBanner(text) {
    let banner = document.getElementById("vps-queue-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "vps-queue-banner";
        // Positioned at bottom: 175px to stack directly above the settings gear button (120px) on mobile viewports
        banner.style.cssText = "position:fixed;bottom:175px;right:15px;background:#1b1b1b;color:#00bc8c;padding:12px 20px;border:1px solid #00bc8c;border-radius:4px;z-index:99998;font-family:sans-serif;font-size:13px;box-shadow:0 4px 15px rgba(0,0,0,0.4);display:flex;align-items:center;gap:10px;";
        document.documentElement.appendChild(banner);
    }
    banner.innerHTML = `
        <div style="width:8px;height:8px;background:#00bc8c;border-radius:50%;animation:vpsPulse 1s infinite alternate;"></div>
        <span>${text}</span>
        <style>@keyframes vpsPulse { 0% { opacity:0.3; } 100% { opacity:1; } }</style>
    `;
}

/**
 * Removes the HUD banner upon queue lock acquisition or failure.
 */
export function hideQueueStatusBanner() {
    const banner = document.getElementById("vps-queue-banner");
    if (banner) banner.remove();
}

/**
 * Injects a top-centered warning badge when diagnostic logging or debug intent is active.
 *
 * @param {string} message - Warning message string.
 * @param {string} bgColor - Background CSS color hex string.
 */
export function injectWarningBadge(message, bgColor) {
    if (document.getElementById("vps-debug-badge")) return;
    const badge = document.createElement("div");
    badge.id = "vps-debug-badge";
    badge.innerHTML = message;
    badge.style.cssText = `position:fixed; top:10px; left:50%; transform:translateX(-50%); background:${bgColor}; color:#fff; font-weight:bold; font-size:11px; padding:6px 12px; border-radius:4px; z-index:99999; box-shadow:0 2px 8px rgba(0,0,0,0.4); pointer-events:none; font-family:sans-serif;`;
    document.documentElement.appendChild(badge);
}

/**
 * Removes the diagnostic warning badge when debug mode is disarmed.
 */
export function removeWarningBadge() {
    const badge = document.getElementById("vps-debug-badge");
    if (badge) badge.remove();
}