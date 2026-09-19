/**
 * SHARED INTERFACE & HUD CONTROLLER (src/userscripts/shared/ui.js)
 * 
 * DESIGN PRINCIPLES:
 * 1. Unified Telemetry Gate: Consolidates queue feedback directly onto the primary
 *    generate button shield overlay. Completely eliminates vestigial floating toast banners.
 * 2. Visual Hierarchy Isolation: Warning badges sit on elevated z-index planes (99999)
 *    to remain visible above React modal dialogues.
 * 3. Autonomous Animation Styling: Injects isolated keyframe animations (@keyframes gwPulse)
 *    dynamically to eliminate external CSS dependencies.
 * 4. Re-exports DOM Engine primitives for unified module ingestion across userscript targets.
 */

'use strict';

import {
  injectNavBadge,
  injectAllowanceBar,
  updateAllowanceBar,
  injectQueueShield,
  setQueueShieldState,
  initDOMObserver,
  stopDOMObserver
} from './domEngine.js';

export {
  injectNavBadge,
  injectAllowanceBar,
  updateAllowanceBar,
  injectQueueShield,
  setQueueShieldState,
  initDOMObserver,
  stopDOMObserver
};

/**
 * Updates queue status telemetry directly on the Generate button shield overlay (#gw-button-shield).
 *
 * @param {string} text - Telemetry status text to display.
 */
export function showQueueStatusBanner(text) {
  setQueueShieldState(true, text);
}

/**
 * Disarms the Generate button shield overlay upon queue completion or abort.
 */
export function hideQueueStatusBanner() {
  setQueueShieldState(false, '');
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
  const root = document.body || document.documentElement;
  if (root) root.appendChild(badge);
}

/**
 * Removes the diagnostic warning badge when debug mode is disarmed.
 */
export function removeWarningBadge() {
  const badge = document.getElementById("vps-debug-badge");
  if (badge) badge.remove();
}