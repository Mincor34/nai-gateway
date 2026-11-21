/**
 * DYNAMIC CLASS HARVESTER & DOM INJECTION ENGINE (src/userscripts/shared/domEngine.js)
 * 
 * ARCHITECTURAL MANDATE:
 * Implements the runtime "Anchor -> Scrape -> Inject" paradigm with strict visual parity.
 * 1. Semantic Query Anchoring: Targets unstyled, permanent semantic anchors (.image-gen-nav-row,
 *    .image-gen-footer, .image-gen-model-mode-row) to locate mount targets and observe native
 *    Model / Effort selections without coupling to transient sc-* hashes.
 * 2. Point-in-Time Class Harvester: Extracts compiled styled-components class strings from native
 *    DOM nodes (like the nav hamburger button) and caches them in memory.
 * 3. Exact Design System Parity via CSS Custom Properties:
 *    - Injects the Guild Badge into the 3-column flex layout of .image-gen-nav-row without layout shifts,
 *      importing the vector asset as an inlined text bundle via esbuild's text loader.
 *    - Renders the ACS-1 Dual-Ledger HUD (`#gw-v5-bar`) directly ABOVE `#gw-allowance-bar` so that
 *      `#gw-allowance-bar.nextElementSibling === .image-gen-generate-button` always remains intact.
 *    - Displays personal V5 banked NCP (`available / max`), Cluster Surplus Pool NCP, live master
 *      battery replenishment countdown (`next_percent_eta_ms`), color-coded cluster state
 *      (`surplus_active`, `reserve_mode`, `throttled`, `frozen`, `token_expired`, `telemetry_offline`),
 *      virtual Anlas balance with zero-rollover or red debt lockout indicators, active NCP cost for
 *      the natively selected NovelAI Model/Effort (`10 NCP (Med)`, `18 NCP (High)`, `Legacy (0 NCP)`),
 *      inline Anlas Bypass toggle, and contextual drift/deadband/capacity alerts.
 *    - Shields the primary Generate button with an opaque, absolute event-gating overlay (`inset: 0`,
 *      `z-index: 9999`), hiding sibling children to prevent text superposition.
 * 4. Single Presentation Portal: Eliminates redundant user settings sidebar tabs, centralizing
 *    all script management into the dedicated standalone modal triggered by the nav badge.
 * 5. Ephemeral Telemetry Isolation: Keeps server telemetry strictly in page RAM (`cachedPolicyState`)
 *    and persists only explicit user preferences (`anlas_bypass_enabled`) in `GM_setValue`, preventing
 *    stale cross-session lockouts on fresh page boots.
 * 6. Guarded MutationObserver & Reactive Input Listeners: Employs requestAnimationFrame debouncing,
 *    strict self-mutation filtering, and guarded step-input listeners for live deadband feedback.
 * 7. Zero Node.js Leaks: Strictly browser-safe.
 */

'use strict';

import GUILD_BADGE_SVG from './assets/guild_badge.svg';
import { isV5ModelFamily, isV5MediumModel, V5_HIGH_NCP_COST, V5_MEDIUM_NCP_COST } from './pricing.js';

export { GUILD_BADGE_SVG };

// In-memory class cache storing last-known-good styled-components class hashes
const classCache = new Map();

// Latest policy/telemetry state mirrored strictly in page RAM for reactive DOM HUD updates
let cachedPolicyState = {
  virtualBalance: null,
  availableAnlas: null,
  heldAnlas: 0,
  monthlyQuota: null,
  isUnlimitedAnlas: false,
  isInDebt: false,
  v5BankedNcp: null,
  v5AvailableNcp: null,
  v5MaxBankNcp: null,
  v5DailyShareNcp: null,
  v5SurplusAvailableNcp: null,
  v5SurplusEligible: true,
  isUnlimitedV5: false,
  masterV5Percent: null,
  masterV5RawPercent: null,
  masterV5IsNegative: false,
  clusterState: null,
  nextPercentEtaMs: null,
  isHardLocked: false,
  masterTokenExpired: false,
  subscriptionActive: true,
  isGracePeriod: false,
  lastFetchedAt: 0,
  activeModel: '',
  bypassEnabled: false
};

let queueShieldLockActive = false;
let lastHudAlertText = '';
let lastHudAlertSeverity = 'info';

/**
 * Safely reads a Tampermonkey storage value if GM_getValue is available.
 *
 * @param {string} key - Storage key.
 * @param {*} fallback - Default value.
 * @returns {*} Stored or fallback value.
 */
function safeGetGm(key, fallback) {
  try {
    if (typeof GM_getValue === 'function') {
      return GM_getValue(key, fallback);
    }
  } catch (_) {}
  return fallback;
}

/**
 * Safely writes a Tampermonkey storage value if GM_setValue is available.
 *
 * @param {string} key - Storage key.
 * @param {*} value - Value to store.
 */
function safeSetGm(key, value) {
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
    }
  } catch (_) {}
}

/**
 * Retrieves the current merged client policy state for `evaluateGenerationPolicy()`.
 * Ephemeral telemetry resides in RAM while `anlas_bypass_enabled` is read from `GM_getValue`.
 *
 * @returns {object} Consolidated policy state.
 */
export function getClientPolicyState() {
  const merged = { ...cachedPolicyState };
  merged.bypassEnabled = Boolean(safeGetGm('anlas_bypass_enabled', merged.bypassEnabled)) && !merged.isInDebt;
  return merged;
}

/**
 * Updates cached in-memory policy state and enforces debt lockout on persisted bypass toggle.
 *
 * @param {object} [partial={}] - Partial state updates.
 * @returns {object} Updated policy state.
 */
export function setClientPolicyState(partial = {}) {
  const current = getClientPolicyState();
  const next = { ...current, ...partial };
  if (next.isInDebt) {
    next.bypassEnabled = false;
    safeSetGm('anlas_bypass_enabled', false);
  }
  cachedPolicyState = next;
  return { ...next };
}

/**
 * Parses an `rgb()` / `rgba()` CSS color string into RGBA components.
 *
 * @param {string} cssColor - Computed CSS color value.
 * @returns {{r: number, g: number, b: number, a: number}|null} Parsed RGBA tuple or null.
 */
function parseRgbaColor(cssColor) {
  if (typeof cssColor !== 'string') return null;
  const trimmed = cssColor.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const match = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
  if (!match) return null;
  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10),
    a: match[4] !== undefined ? parseFloat(match[4]) : 1
  };
}

/**
 * Determines which of two native Effort toggle buttons (`Medium` vs `High`) is active
 * without coupling to obfuscated styled-component class hashes.
 *
 * @param {Element} medBtn - Native Medium button element.
 * @param {Element} highBtn - Native High button element.
 * @returns {'medium'|'high'|null} Active effort identifier or null if indeterminate.
 */
function detectActiveEffortButton(medBtn, highBtn) {
  if (!medBtn || !highBtn) return null;

  const isMarkedActive = (btn) =>
    btn.getAttribute('aria-pressed') === 'true' ||
    btn.getAttribute('aria-selected') === 'true' ||
    btn.getAttribute('data-active') === 'true';

  const medAttr = isMarkedActive(medBtn);
  const highAttr = isMarkedActive(highBtn);
  if (medAttr !== highAttr) {
    return medAttr ? 'medium' : 'high';
  }

  // Real-browser computed style comparison: active pill has non-transparent highlight fill
  const getBg = (btn) => {
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        return window.getComputedStyle(btn).backgroundColor || '';
      } catch (_) {}
    }
    return btn.style ? (btn.style.backgroundColor || '') : '';
  };

  const medBgRaw = getBg(medBtn);
  const highBgRaw = getBg(highBtn);
  const medRgba = parseRgbaColor(medBgRaw);
  const highRgba = parseRgbaColor(highBgRaw);

  if (medRgba && highRgba) {
    if (medRgba.a > 0 && highRgba.a === 0) return 'medium';
    if (highRgba.a > 0 && medRgba.a === 0) return 'high';
    if (medBgRaw !== highBgRaw) {
      const parent = medBtn.parentElement;
      const parentBg = parent ? getBg(parent) : '';
      if (parentBg) {
        if (medBgRaw !== parentBg && highBgRaw === parentBg) return 'medium';
        if (highBgRaw !== parentBg && medBgRaw === parentBg) return 'high';
      }
      const medLuma = medRgba.r + medRgba.g + medRgba.b;
      const highLuma = highRgba.r + highRgba.g + highRgba.b;
      if (medLuma !== highLuma) {
        return medLuma > highLuma ? 'medium' : 'high';
      }
    }
  } else if (medBgRaw !== highBgRaw) {
    if (medBgRaw && !highBgRaw) return 'medium';
    if (highBgRaw && !medBgRaw) return 'high';
  }

  return null;
}

/**
 * Reads NovelAI's natively selected Model and Effort (`Medium` / `High`) directly from
 * `.image-gen-model-mode-row` without relying on fragile styled-component hashes.
 * Handles inline badge text adjacent to `V5` (e.g., `"NAI Diffusion V5New"`) while
 * strictly rejecting decimal legacy versions (`1.5`, `3.5`, `4.5`), multi-digit
 * numbers (`V50`), or unanchored tokens (`heavy5`).
 *
 * @returns {string|null} Canonical model family identifier (`nai-diffusion-5-full-medium`,
 *   `nai-diffusion-5-full`, or `legacy`) or null if `.image-gen-model-mode-row` is absent.
 */
export function readNativeModelAndEffortFromDOM() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;

  const modelRow = document.querySelector('.image-gen-model-mode-row');
  if (!modelRow) return null;

  let modelText = '';
  const modelInput = modelRow.querySelector('input[aria-label="Select the Model"]') ||
    document.querySelector('input[aria-label="Select the Model"]');

  if (modelInput && modelInput.parentElement) {
    const prev = modelInput.previousElementSibling;
    const parentPrev = modelInput.parentElement.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.trim()) {
      modelText = prev.textContent.trim();
    } else if (parentPrev && parentPrev.textContent && parentPrev.textContent.trim()) {
      modelText = parentPrev.textContent.trim();
    } else if (modelInput.parentElement.textContent && modelInput.parentElement.textContent.trim()) {
      modelText = modelInput.parentElement.textContent.trim();
    }
  }

  if (!modelText) {
    const allDivs = modelRow.querySelectorAll('div');
    for (const d of allDivs) {
      const cls = d.getAttribute('class') || '';
      if (cls.includes('singleValue') && d.textContent) {
        modelText = d.textContent.trim();
        break;
      }
    }
  }

  const trimmedModel = modelText.trim();
  if (!trimmedModel) {
    return null;
  }

  const isNativeV5 = !/\d[-_.]5/i.test(trimmedModel) && /(?:^|[\s\-_])v?5(?![\d.])/i.test(trimmedModel);

  if (!isNativeV5) {
    return 'legacy';
  }

  const buttons = modelRow.querySelectorAll('button');
  let medBtn = null;
  let highBtn = null;
  for (const btn of buttons) {
    const label = (btn.textContent || '').trim().toLowerCase();
    if (label === 'medium') medBtn = btn;
    else if (label === 'high') highBtn = btn;
  }

  const activeEffort = detectActiveEffortButton(medBtn, highBtn);
  if (activeEffort === 'medium') {
    return 'nai-diffusion-5-full-medium';
  }
  if (activeEffort === 'high') {
    return 'nai-diffusion-5-full';
  }

  // Fallback when V5 is selected in dropdown but effort toggle styling is indeterminate:
  // preserve existing V5 effort if already known, otherwise assume V5 High (18 NCP) safely.
  const current = getClientPolicyState().activeModel || '';
  return isV5ModelFamily(current) ? current : 'nai-diffusion-5-full';
}

/**
 * Safely extracts className from a DOM node and caches it under a semantic key.
 *
 * @param {Element|null} el - Target DOM node.
 * @param {string} cacheKey - Fallback identifier in classCache.
 * @returns {string} Harvested class string or cached fallback.
 */
export function getElementClasses(el, cacheKey) {
  if (el && el.className && typeof el.className === 'string') {
    const trimmed = el.className.trim();
    if (trimmed) {
      classCache.set(cacheKey, trimmed);
      return trimmed;
    }
  }
  return classCache.get(cacheKey) || '';
}

/**
 * Injects the Guild Badge trigger button into .image-gen-nav-row.
 * Preserves the 3-item flex distribution by nesting inside the hamburger menu's wrapper.
 *
 * @param {Function} onClickHandler - Callback invoked when the badge button is clicked.
 * @returns {boolean} True if element was injected or already present.
 */
export function injectNavBadge(onClickHandler) {
  if (document.getElementById('gw-nav-badge')) return true;

  const menuBtn = document.querySelector('button[aria-label="menu"]');
  if (!menuBtn || !menuBtn.parentElement) return false;

  const btnClasses = getElementClasses(menuBtn, 'nav_menu_btn');

  const badgeBtn = document.createElement('button');
  badgeBtn.id = 'gw-nav-badge';
  badgeBtn.className = btnClasses;
  badgeBtn.setAttribute('aria-label', 'GuildWeave Settings');
  badgeBtn.setAttribute('title', 'GuildWeave Settings');
  badgeBtn.style.marginRight = '8px';
  badgeBtn.style.cursor = 'pointer';

  const innerDiv = document.createElement('div');
  innerDiv.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; pointer-events: none;';
  innerDiv.innerHTML = GUILD_BADGE_SVG;

  const svgEl = innerDiv.querySelector('svg');
  if (svgEl) {
    svgEl.setAttribute('width', '30');
    svgEl.setAttribute('height', '30');
    svgEl.style.width = '30px';
    svgEl.style.height = '30px';
    svgEl.style.display = 'block';
    svgEl.style.margin = '-2px -8px 0 -7px';
  }

  badgeBtn.appendChild(innerDiv);

  badgeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof onClickHandler === 'function') {
      onClickHandler();
    }
  };

  menuBtn.parentElement.insertBefore(badgeBtn, menuBtn);
  return true;
}

/**
 * Constructs and injects the standalone Rolling Allowance Bar directly above
 * .image-gen-generate-button inside .image-gen-footer.
 *
 * @returns {boolean} True if element was injected or already exists.
 */
export function injectAllowanceBar() {
  if (document.getElementById('gw-allowance-bar')) return true;

  const genBtn = document.querySelector('.image-gen-generate-button');
  if (!genBtn || !genBtn.parentElement) return false;

  const barRoot = document.createElement('div');
  barRoot.id = 'gw-allowance-bar';
  barRoot.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px 8px 7px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, rgb(34, 37, 63));
    background-color: var(--theme-bg0, rgb(14, 15, 33));
    font-size: 0.8125rem;
    font-weight: 600;
    margin-bottom: 0px;
    box-sizing: border-box;
  `.replace(/\s+/g, ' ').trim();

  const headerRow = document.createElement('div');
  headerRow.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  `.replace(/\s+/g, ' ').trim();

  const labelSpan = document.createElement('span');
  labelSpan.id = 'gw-allowance-label';
  labelSpan.style.cssText = `
    flex: 0 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--theme-text, rgb(245, 243, 194));
    font-size: 0.75rem;
    font-weight: 600;
  `.replace(/\s+/g, ' ').trim();
  labelSpan.textContent = 'Rolling Allowance: --/100 Images';

  headerRow.appendChild(labelSpan);

  const trackDiv = document.createElement('div');
  trackDiv.style.cssText = `
    height: 4px;
    width: 100%;
    background: var(--theme-bg2, rgba(255, 255, 255, 0.1));
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  `.replace(/\s+/g, ' ').trim();

  const fillDiv = document.createElement('div');
  fillDiv.id = 'gw-allowance-fill';
  fillDiv.style.cssText = `
    height: 100%;
    width: 100%;
    background-color: var(--theme-success, #2ecc71);
    border-radius: 2px;
    transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;
  `.replace(/\s+/g, ' ').trim();

  trackDiv.appendChild(fillDiv);
  barRoot.appendChild(headerRow);
  barRoot.appendChild(trackDiv);

  genBtn.parentElement.insertBefore(barRoot, genBtn);
  return true;
}

/**
 * Synchronizes `activeModel` from NovelAI's native `.image-gen-model-mode-row` when present,
 * then re-renders `#gw-v5-bar`, `#gw-button-shield` capacity lockouts, and UI slider constraints.
 *
 * @returns {object} Current normalized client policy state.
 */
export function refreshDualLedgerHud() {
  injectDualLedgerBar();
  const nativeModel = readNativeModelAndEffortFromDOM();
  if (nativeModel) {
    setClientPolicyState({ activeModel: nativeModel });
  }
  const latest = getClientPolicyState();
  renderDualLedgerHudFromState(latest);
  syncUIControlConstraints(latest);
  return latest;
}

/**
 * Constructs and injects the ACS-1 Dual-Ledger HUD (`#gw-v5-bar`) immediately ABOVE
 * `#gw-allowance-bar`, preserving `#gw-allowance-bar.nextElementSibling === genBtn`.
 *
 * @returns {boolean} True if mounted or already present.
 */
export function injectDualLedgerBar() {
  injectAllowanceBar();
  if (document.getElementById('gw-v5-bar')) return true;

  const allowanceBar = document.getElementById('gw-allowance-bar');
  if (!allowanceBar || !allowanceBar.parentElement) return false;

  const v5Root = document.createElement('div');
  v5Root.id = 'gw-v5-bar';
  v5Root.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 6px 8px 7px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, rgb(34, 37, 63));
    background-color: var(--theme-bg0, rgb(14, 15, 33));
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 4px;
    box-sizing: border-box;
  `.replace(/\s+/g, ' ').trim();

  // Row 1: V5 Banked NCP + Cluster Battery & ETA
  const v5HeaderRow = document.createElement('div');
  v5HeaderRow.style.cssText = 'display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px;';

  const v5Label = document.createElement('span');
  v5Label.id = 'gw-v5-label';
  v5Label.style.cssText = 'color: var(--theme-text, rgb(245, 243, 194)); font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
  v5Label.textContent = 'V5 Bank: --/-- NCP | Tank: --%';

  const v5Eta = document.createElement('span');
  v5Eta.id = 'gw-v5-eta';
  v5Eta.style.cssText = 'color: var(--theme-textSecondary, #aaa); font-size: 0.68rem; white-space: nowrap;';
  v5Eta.textContent = '';

  v5HeaderRow.appendChild(v5Label);
  v5HeaderRow.appendChild(v5Eta);

  // V5 Progress Track
  const v5Track = document.createElement('div');
  v5Track.style.cssText = 'height: 4px; width: 100%; background: var(--theme-bg2, rgba(255, 255, 255, 0.1)); border-radius: 2px; overflow: hidden; position: relative;';

  const v5Fill = document.createElement('div');
  v5Fill.id = 'gw-v5-fill';
  v5Fill.style.cssText = 'height: 100%; width: 100%; background-color: var(--theme-success, #2ecc71); border-radius: 2px; transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;';
  v5Track.appendChild(v5Fill);

  // Row 2: Anlas Balance / Zero-Rollover / Debt Lockout + Native Selection Cost + Bypass Toggle
  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;';

  const anlasLabel = document.createElement('span');
  anlasLabel.id = 'gw-anlas-label';
  anlasLabel.style.cssText = 'color: var(--theme-textSecondary, #ccc); font-size: 0.68rem; white-space: nowrap;';
  anlasLabel.textContent = 'Anlas: -- (No Rollover)';

  const rightControls = document.createElement('div');
  rightControls.style.cssText = 'display: flex; align-items: center; gap: 8px;';

  const costBadge = document.createElement('span');
  costBadge.id = 'gw-v5-cost';
  costBadge.style.cssText = 'color: var(--theme-textSecondary, #aaa); font-size: 0.68rem; white-space: nowrap;';
  costBadge.textContent = '';

  const state = getClientPolicyState();

  const bypassLabel = document.createElement('label');
  bypassLabel.id = 'gw-bypass-label';
  bypassLabel.style.cssText = 'display: flex; align-items: center; gap: 4px; font-size: 0.68rem; cursor: pointer; color: var(--theme-warning, #f39c12); white-space: nowrap;';

  const bypassCheckbox = document.createElement('input');
  bypassCheckbox.type = 'checkbox';
  bypassCheckbox.id = 'gw-bypass-toggle';
  bypassCheckbox.checked = Boolean(state.bypassEnabled) && !state.isInDebt;
  bypassCheckbox.disabled = Boolean(state.isInDebt);
  bypassCheckbox.style.cursor = 'pointer';
  bypassCheckbox.onchange = () => {
    const latest = getClientPolicyState();
    if (latest.isInDebt) {
      bypassCheckbox.checked = false;
      bypassCheckbox.disabled = true;
      return;
    }
    const nextVal = Boolean(bypassCheckbox.checked);
    safeSetGm('anlas_bypass_enabled', nextVal);
    setClientPolicyState({ bypassEnabled: nextVal });
    const modalBypass = document.getElementById('settings-anlas-bypass');
    if (modalBypass) modalBypass.checked = nextVal;
    refreshDualLedgerHud();
  };

  const bypassText = document.createElement('span');
  bypassText.id = 'gw-bypass-text';
  bypassText.textContent = state.isInDebt ? 'Bypass Locked' : 'Anlas Bypass';

  bypassLabel.appendChild(bypassCheckbox);
  bypassLabel.appendChild(bypassText);

  rightControls.appendChild(costBadge);
  rightControls.appendChild(bypassLabel);

  controlsRow.appendChild(anlasLabel);
  controlsRow.appendChild(rightControls);

  // Row 3: Contextual Alert Line (Drift / Deadband / Battery Recharging)
  const alertDiv = document.createElement('div');
  alertDiv.id = 'gw-hud-alert';
  alertDiv.style.cssText = 'display: none; font-size: 0.68rem; line-height: 1.3; padding: 3px 6px; border-radius: 4px; background: var(--theme-bg1, #222); color: var(--theme-warning, #f39c12);';

  v5Root.appendChild(v5HeaderRow);
  v5Root.appendChild(v5Track);
  v5Root.appendChild(controlsRow);
  v5Root.appendChild(alertDiv);

  allowanceBar.parentElement.insertBefore(v5Root, allowanceBar);

  if (lastHudAlertText) {
    setHudAlert(lastHudAlertText, lastHudAlertSeverity);
  }
  renderDualLedgerHudFromState(getClientPolicyState());
  return true;
}

/**
 * Displays or clears a contextual alert banner inside `#gw-v5-bar`.
 *
 * @param {string} message - Alert copy (empty string hides the alert).
 * @param {'info'|'warning'|'error'} [severity='warning'] - Visual severity level.
 */
export function setHudAlert(message, severity = 'warning') {
  lastHudAlertText = message || '';
  lastHudAlertSeverity = severity;

  const alertEl = document.getElementById('gw-hud-alert');
  if (!alertEl) return;

  if (!message) {
    alertEl.style.display = 'none';
    alertEl.textContent = '';
    return;
  }

  alertEl.style.display = 'block';
  alertEl.textContent = message;
  if (severity === 'error') {
    alertEl.style.color = 'var(--theme-error, #e74c3c)';
  } else if (severity === 'info') {
    alertEl.style.color = 'var(--theme-accent, #00bc8c)';
  } else {
    alertEl.style.color = 'var(--theme-warning, #f39c12)';
  }
}

/**
 * Formats milliseconds until next percent into compact human-readable countdown text.
 *
 * @param {number|null|undefined} etaMs - Milliseconds until next percent.
 * @returns {string} Formatted countdown badge.
 */
function formatNextPercentEta(etaMs) {
  if (typeof etaMs !== 'number' || !Number.isFinite(etaMs)) return '';
  if (etaMs <= 0) return 'Full';
  const mins = Math.max(0.1, etaMs / 60000);
  if (mins >= 60) {
    return `+1% in ${(mins / 60).toFixed(1)}h`;
  }
  return `+1% in ${mins.toFixed(1)}m`;
}

/**
 * Maps `cluster_state` to semantic theme CSS colors.
 *
 * @param {string|null} clusterState - Cluster state token from `/auth/status`.
 * @returns {string} CSS color expression.
 */
function resolveClusterStateColor(clusterState) {
  if (clusterState === 'frozen' || clusterState === 'token_expired') return 'var(--theme-error, #e74c3c)';
  if (clusterState === 'throttled' || clusterState === 'telemetry_offline') return 'var(--theme-warning, #e67e22)';
  if (clusterState === 'reserve_mode') return 'var(--theme-warning, #f1c40f)';
  return 'var(--theme-success, #2ecc71)';
}

/**
 * Renders the `#gw-v5-bar` labels, native NCP cost indicator, progress fill, debt warnings,
 * and bypass toggle using the normalized client policy state.
 * Evaluates token-expired, subscription-inactive, and 5.5% circuit-breaker states before
 * unlimited-tier shortcuts because those gates apply across all tiers including Admin.
 *
 * @param {object} state - Normalized client policy state.
 */
function renderDualLedgerHudFromState(state) {
  const v5Label = document.getElementById('gw-v5-label');
  const v5Eta = document.getElementById('gw-v5-eta');
  const v5Fill = document.getElementById('gw-v5-fill');
  const anlasLabel = document.getElementById('gw-anlas-label');
  const costBadge = document.getElementById('gw-v5-cost');
  const bypassCheckbox = document.getElementById('gw-bypass-toggle');
  const bypassText = document.getElementById('gw-bypass-text');
  const modalBypass = document.getElementById('settings-anlas-bypass');

  const activeModel = state.activeModel || '';
  const isV5 = isV5ModelFamily(activeModel);
  const isMed = isV5MediumModel(activeModel);

  if (v5Label && v5Fill) {
    const pctText = typeof state.masterV5Percent === 'number' && Number.isFinite(state.masterV5Percent)
      ? `${state.masterV5Percent.toFixed(1)}%`
      : '--%';

    if (state.masterTokenExpired || state.clusterState === 'token_expired') {
      v5Label.textContent = 'Master Token Expired (Awaiting Admin)';
      v5Fill.style.width = '0%';
      v5Fill.style.backgroundColor = 'var(--theme-error, #e74c3c)';
    } else if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
      v5Label.textContent = 'Master Subscription Inactive';
      v5Fill.style.width = '0%';
      v5Fill.style.backgroundColor = 'var(--theme-error, #e74c3c)';
    } else if (state.isHardLocked) {
      v5Label.textContent = `Battery Recharging (${pctText} <= 5.5%)`;
      const widthPct = typeof state.masterV5Percent === 'number' ? Math.max(0, Math.min(100, state.masterV5Percent)) : 0;
      v5Fill.style.width = `${widthPct}%`;
      v5Fill.style.backgroundColor = 'var(--theme-error, #e74c3c)';
    } else if (state.isUnlimitedV5) {
      v5Label.textContent = `V5 Bank: Exempt (Unlimited) | Tank: ${pctText}`;
      v5Fill.style.width = '100%';
      v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState);
    } else if (typeof state.v5AvailableNcp === 'number') {
      const maxNcp = typeof state.v5MaxBankNcp === 'number' && state.v5MaxBankNcp > 0 ? state.v5MaxBankNcp : state.v5AvailableNcp;
      const surplusSuffix = (state.v5SurplusEligible && typeof state.v5SurplusAvailableNcp === 'number' && state.v5SurplusAvailableNcp > 0)
        ? ` (+${state.v5SurplusAvailableNcp} Surplus)`
        : '';
      const depleted = state.v5AvailableNcp < 10 && (!state.v5SurplusEligible || (state.v5SurplusAvailableNcp || 0) < 10);
      v5Label.textContent = depleted
        ? `V5 Quota Depleted (0/${maxNcp} NCP) | Tank: ${pctText}`
        : `V5 Bank: ${state.v5AvailableNcp}/${maxNcp} NCP${surplusSuffix} | Tank: ${pctText}`;
      const barPct = maxNcp > 0 ? Math.min(100, Math.max(0, (state.v5AvailableNcp / maxNcp) * 100)) : 0;
      v5Fill.style.width = `${barPct}%`;
      v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState);
    } else {
      v5Label.textContent = `V5 Bank: --/-- NCP | Tank: ${pctText}`;
    }
  }

  if (v5Eta) {
    const etaStr = formatNextPercentEta(state.nextPercentEtaMs);
    const stateTag = state.clusterState ? state.clusterState.replace(/_/g, ' ').toUpperCase() : '';
    v5Eta.textContent = [stateTag, etaStr].filter(Boolean).join(' · ');
  }

  if (costBadge) {
    if (!activeModel) {
      costBadge.textContent = '';
    } else if (isMed) {
      costBadge.textContent = `Cost: ${V5_MEDIUM_NCP_COST} NCP (Med)`;
      costBadge.style.color = 'var(--theme-accent, #00bc8c)';
    } else if (isV5) {
      costBadge.textContent = `Cost: ${V5_HIGH_NCP_COST} NCP (High)`;
      costBadge.style.color = 'var(--theme-accent, #00bc8c)';
    } else {
      costBadge.textContent = 'Legacy (0 NCP)';
      costBadge.style.color = 'var(--theme-textSecondary, #aaa)';
    }
  }

  if (anlasLabel) {
    if (state.isUnlimitedAnlas) {
      anlasLabel.textContent = 'Anlas: Unlimited';
      anlasLabel.style.color = 'var(--theme-accent, #00bc8c)';
    } else if (state.isInDebt) {
      anlasLabel.textContent = `Anlas Balance: ${state.virtualBalance} (Bypass Locked)`;
      anlasLabel.style.color = 'var(--theme-error, #e74c3c)';
    } else if (typeof state.availableAnlas === 'number') {
      const quotaSuffix = typeof state.monthlyQuota === 'number' ? `/${state.monthlyQuota}` : '';
      anlasLabel.textContent = `Anlas: ${state.availableAnlas}${quotaSuffix} (No Rollover)`;
      anlasLabel.style.color = 'var(--theme-textSecondary, #ccc)';
    } else {
      anlasLabel.textContent = 'Anlas: -- (No Rollover)';
      anlasLabel.style.color = 'var(--theme-textSecondary, #ccc)';
    }
  }

  if (bypassCheckbox && bypassText) {
    if (state.isInDebt) {
      bypassCheckbox.checked = false;
      bypassCheckbox.disabled = true;
      bypassText.textContent = 'Bypass Locked';
      bypassText.style.color = 'var(--theme-error, #e74c3c)';
    } else {
      bypassCheckbox.disabled = false;
      bypassCheckbox.checked = Boolean(state.bypassEnabled);
      bypassText.textContent = 'Anlas Bypass';
      bypassText.style.color = 'var(--theme-warning, #f39c12)';
    }
  }

  if (modalBypass) {
    if (state.isInDebt) {
      modalBypass.checked = false;
      modalBypass.disabled = true;
    } else {
      modalBypass.disabled = false;
      modalBypass.checked = Boolean(state.bypassEnabled);
    }
  }

  // Sync Generate button capacity lockout state when subscription is inactive or V5 is locked/depleted.
  // Note: master_token_expired surfaces prominently in the HUD without locking the button via shield
  // so guests can recover immediately once the admin pushes a fresh token without waiting 10s.
  if (!queueShieldLockActive) {
    if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
      setGenerateLockoutState(true, 'Subscription Inactive');
    } else if (isV5 && !state.bypassEnabled && !state.masterTokenExpired && state.clusterState !== 'token_expired') {
      if (state.isHardLocked) {
        setGenerateLockoutState(true, 'Battery Recharging');
      } else if (
        typeof state.v5AvailableNcp === 'number' &&
        !state.isUnlimitedV5 &&
        state.lastFetchedAt > 0
      ) {
        const reqNcp = isMed ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST;
        const surplusAvail = state.v5SurplusEligible ? (state.v5SurplusAvailableNcp || 0) : 0;
        if (state.v5AvailableNcp < reqNcp && surplusAvail < reqNcp) {
          setGenerateLockoutState(true, 'V5 Quota Depleted');
        } else {
          setGenerateLockoutState(false, '');
        }
      } else {
        setGenerateLockoutState(false, '');
      }
    } else {
      setGenerateLockoutState(false, '');
    }
  }
}

/**
 * Consumes a `/auth/status` response payload (or partial ledger update without wiping
 * absent telemetry/v5 slices), enforces debt lockout on local bypass state,
 * updates the secondary V5/Anlas HUD bar, and synchronizes UI slider constraints.
 *
 * @param {object} statusData - Parsed JSON response from `GET /auth/status`.
 * @returns {object} Updated normalized client policy state.
 */
export function updateDualLedgerHud(statusData) {
  if (!statusData || typeof statusData !== 'object') {
    return getClientPolicyState();
  }

  const patch = {};

  if (statusData.anlas && typeof statusData.anlas === 'object') {
    const anlas = statusData.anlas;
    const isInDebt = Boolean(anlas.is_in_debt);
    const currentBypass = Boolean(safeGetGm('anlas_bypass_enabled', false)) && !isInDebt;
    if (isInDebt) {
      safeSetGm('anlas_bypass_enabled', false);
    }
    patch.virtualBalance = anlas.virtual_balance;
    patch.availableAnlas = anlas.available_balance;
    patch.heldAnlas = anlas.held || 0;
    patch.monthlyQuota = anlas.monthly_quota;
    patch.isUnlimitedAnlas = Boolean(anlas.is_unlimited);
    patch.isInDebt = isInDebt;
    patch.bypassEnabled = currentBypass;
  }

  if (statusData.v5 && typeof statusData.v5 === 'object') {
    const v5 = statusData.v5;
    patch.v5BankedNcp = v5.banked_ncp;
    patch.v5AvailableNcp = v5.available_ncp;
    patch.v5MaxBankNcp = v5.max_bank_ncp;
    patch.v5DailyShareNcp = v5.daily_share_ncp;
    patch.v5SurplusAvailableNcp = v5.surplus_available_ncp;
    patch.v5SurplusEligible = Boolean(v5.surplus_eligible);
    patch.isUnlimitedV5 = Boolean(v5.is_unlimited);
  }

  if (statusData.telemetry && typeof statusData.telemetry === 'object') {
    const telemetry = statusData.telemetry;
    patch.masterV5Percent = telemetry.master_v5_percent;
    patch.masterV5RawPercent = telemetry.master_v5_raw_percent;
    patch.masterV5IsNegative = Boolean(telemetry.master_v5_is_negative);
    patch.clusterState = telemetry.cluster_state;
    patch.nextPercentEtaMs = telemetry.next_percent_eta_ms;
    patch.isHardLocked = Boolean(telemetry.is_hard_locked);
    patch.masterTokenExpired = Boolean(telemetry.master_token_expired) || telemetry.cluster_state === 'token_expired';
    patch.subscriptionActive = telemetry.subscription_active !== false;
    patch.isGracePeriod = Boolean(telemetry.is_grace_period);
    patch.lastFetchedAt = telemetry.last_fetched_at || 0;
  } else if (statusData.master_v5_percent !== undefined) {
    patch.masterV5Percent = statusData.master_v5_percent;
  }

  setClientPolicyState(patch);
  return refreshDualLedgerHud();
}

/**
 * Evaluates whether an `<input>` node represents NovelAI's native generation step control.
 *
 * @param {Element|null} input - Candidate input node.
 * @returns {boolean} True if target is a step control input.
 */
function isStepControlInput(input) {
  if (!input || input.tagName !== 'INPUT') return false;
  if (input.id === 'gw-bypass-toggle' || input.id === 'settings-anlas-bypass') return false;
  const aria = (input.getAttribute('aria-label') || '').toLowerCase();
  const name = (input.getAttribute('name') || '').toLowerCase();
  const id = (input.id || '').toLowerCase();
  const dataCtrl = (input.getAttribute('data-gw-control') || '').toLowerCase();
  return dataCtrl === 'steps' || aria.includes('step') || name.includes('step') || id.includes('step');
}

/**
 * Clamps native step inputs according to NovelAI's active native Model / Effort selection
 * and Anlas Bypass state, clearing stale deadband warnings only when switching off V5 High
 * or moving step inputs outside the 24..28 deadband.
 *
 * @param {object} [state=getClientPolicyState()] - Normalized client policy state.
 */
export function syncUIControlConstraints(state = getClientPolicyState()) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;

  const activeModel = state.activeModel || '';
  const isMed = isV5MediumModel(activeModel);
  const isV5High = isV5ModelFamily(activeModel) && !isMed;

  let deadbandTriggered = false;
  let foundStepInput = false;
  let hasStepInDeadband = false;
  const inputs = document.querySelectorAll('input');
  for (const input of inputs) {
    if (!isStepControlInput(input)) continue;
    foundStepInput = true;

    const numVal = parseInt(input.value, 10);
    if (Number.isFinite(numVal) && numVal >= 24 && numVal <= 28) {
      hasStepInDeadband = true;
    }

    if (isMed) {
      input.setAttribute('min', '1');
      input.setAttribute('max', '28');
    } else if (isV5High && !state.bypassEnabled) {
      input.setAttribute('min', '1');
      input.setAttribute('max', '23');
      if (Number.isFinite(numVal) && numVal >= 24 && numVal <= 28) {
        deadbandTriggered = true;
        setHudAlert(
          'Steps 24-28 on V5 Full (High) are prohibited (battery deadband). Use ≤23 for free tier, switch to Medium effort, or enable Anlas bypass with >28 steps.',
          'warning'
        );
      }
    } else {
      input.setAttribute('min', '1');
      input.setAttribute('max', state.bypassEnabled ? '50' : '28');
    }
  }

  if (
    !deadbandTriggered &&
    lastHudAlertText &&
    lastHudAlertText.includes('deadband') &&
    (!isV5High || (foundStepInput && !hasStepInDeadband))
  ) {
    setHudAlert('', 'info');
  }
}

/**
 * Scrapes NovelAI's rendered Anlas cost integer from `.image-gen-generate-button` children
 * (ignoring `#gw-button-shield` and sample-count numbers nested inside `"Generate N Image"` labels).
 * Prioritizes `.native-anlas-container`, then explicit `"<N> Anlas"` spans, and finally
 * pure numeric spans whose ancestor chain inside the button contains no Generate/Image text.
 *
 * @returns {number|null} Scraped integer Anlas cost or null if absent.
 */
export function scrapeDisplayedAnlasCost() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  const genBtn = document.querySelector('.image-gen-generate-button');
  if (!genBtn) return null;

  const isInsideShield = (node) => {
    let cur = node;
    while (cur && cur !== genBtn) {
      if (cur.id === 'gw-button-shield' || cur.id === 'gw-shield-text') return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const isInsideGenerateLabel = (node) => {
    let cur = node;
    while (cur && cur !== genBtn) {
      const text = (cur.textContent || '').trim();
      if (/generate/i.test(text) || /image/i.test(text)) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const badgeNode = genBtn.querySelector('.native-anlas-container');
  if (badgeNode && !isInsideShield(badgeNode)) {
    const badgeText = (badgeNode.textContent || '').trim();
    const match = badgeText.match(/(\d+)\s*anlas/i) || badgeText.match(/^(\d+)$/);
    if (match) return parseInt(match[1], 10);
  }

  const candidates = genBtn.querySelectorAll('span');

  for (const node of candidates) {
    if (!node || isInsideShield(node)) continue;
    const text = (node.textContent || '').trim();
    if (!text || /generate/i.test(text) || /image/i.test(text)) continue;
    const anlasMatch = text.match(/^(\d+)\s*anlas$/i);
    if (anlasMatch) {
      return parseInt(anlasMatch[1], 10);
    }
  }

  for (const node of candidates) {
    if (!node || isInsideShield(node) || isInsideGenerateLabel(node)) continue;
    const text = (node.textContent || '').trim();
    const pureNumMatch = text.match(/^(\d+)$/);
    if (pureNumMatch) {
      return parseInt(pureNumMatch[1], 10);
    }
  }

  return null;
}

/**
 * Dynamically updates the Rolling Allowance bar telemetry without triggering DOM reconstruction.
 *
 * @param {number|null} allowance - Current token balance.
 * @param {number} maxAllowance - Upper token boundary.
 * @param {number} [nextRefillMs=0] - Duration in ms until the next token replenishment.
 */
export function updateAllowanceBar(allowance, maxAllowance, nextRefillMs = 0) {
  injectAllowanceBar();
  injectDualLedgerBar();

  const labelSpan = document.getElementById('gw-allowance-label');
  const fillDiv = document.getElementById('gw-allowance-fill');
  if (!labelSpan || !fillDiv) return;

  if (allowance === null || maxAllowance === Infinity) {
    labelSpan.textContent = 'Rolling Allowance: Exempt (Unlimited)';
    fillDiv.style.width = '100%';
    fillDiv.style.backgroundColor = 'var(--theme-accent, #00bc8c)';
    return;
  }

  const max = maxAllowance || 100;
  const clampedAllowance = Math.max(0, allowance);
  const percent = Math.min(100, Math.max(0, (clampedAllowance / max) * 100));

  let refillSuffix = '';
  if (clampedAllowance < max && nextRefillMs > 0) {
    const mins = (nextRefillMs / 60000).toFixed(1);
    refillSuffix = ` (+1 in ${mins}m)`;
  } else if (clampedAllowance >= max) {
    refillSuffix = ' (Full)';
  }

  labelSpan.textContent = `Rolling Allowance: ${clampedAllowance}/${max} Images${refillSuffix}`;
  fillDiv.style.width = `${percent}%`;

  if (percent < 20) {
    fillDiv.style.backgroundColor = 'var(--theme-error, #e74c3c)';
  } else if (percent < 50) {
    fillDiv.style.backgroundColor = 'var(--theme-warning, #f39c12)';
  } else {
    fillDiv.style.backgroundColor = 'var(--theme-success, #2ecc71)';
  }
}

/**
 * Mounts an absolute pointer-event shield over .image-gen-generate-button.
 * Strictly avoids polluting the overlay element with the button's own CSS class hashes.
 *
 * @returns {boolean} True if shield is mounted or exists.
 */
export function injectQueueShield() {
  const genBtn = document.querySelector('.image-gen-generate-button');
  if (!genBtn) return false;

  if (document.getElementById('gw-button-shield')) return true;

  genBtn.style.position = 'relative';
  genBtn.style.overflow = 'hidden';

  const shield = document.createElement('div');
  shield.id = 'gw-button-shield';
  shield.style.cssText = `
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 9999 !important;
    box-sizing: border-box !important;
    margin: 0 !important;
    background: var(--theme-bg1, rgb(24, 26, 46)) !important;
    border-radius: inherit !important;
    border: 1px solid var(--theme-accent, #00bc8c) !important;
    cursor: wait !important;
    display: none;
    pointer-events: none;
    align-items: center;
    justify-content: center;
    opacity: 1 !important;
  `.replace(/\s+/g, ' ').trim();

  const pulseIndicator = document.createElement('div');
  pulseIndicator.style.cssText = 'width:8px; height:8px; border-radius:50%; background:var(--theme-accent, #00bc8c); margin-right:8px; animation:gwPulse 1s infinite alternate; flex-shrink:0;';

  const labelText = document.createElement('span');
  labelText.id = 'gw-shield-text';
  labelText.style.cssText = 'font-weight:bold; font-size:13px; color:var(--theme-textHeadings, #fff); white-space:nowrap; letter-spacing:0.5px;';
  labelText.textContent = 'Queue Slot Active...';

  shield.appendChild(pulseIndicator);
  shield.appendChild(labelText);
  genBtn.appendChild(shield);

  return true;
}

/**
 * Applies a visual state to `#gw-button-shield` and hides sibling children inside the Generate button.
 *
 * @param {boolean} active - True to show the shield overlay.
 * @param {string} text - Label text to render inside the shield.
 * @param {string} [cursor='wait'] - CSS cursor style.
 */
function applyButtonShieldVisual(active, text, cursor = 'wait') {
  injectQueueShield();

  const shield = document.getElementById('gw-button-shield');
  const labelText = document.getElementById('gw-shield-text');
  if (!shield || !labelText) return;

  const genBtn = shield.parentElement;
  if (genBtn) {
    for (const child of genBtn.children) {
      if (child !== shield) {
        child.style.visibility = active ? 'hidden' : '';
      }
    }
  }

  if (active) {
    labelText.textContent = text || 'Processing Queue...';
    shield.style.display = 'flex';
    shield.style.pointerEvents = 'all';
    shield.style.cursor = cursor;
  } else {
    shield.style.display = 'none';
    shield.style.pointerEvents = 'none';
  }
}

/**
 * Updates the state of the Generate button shield overlay for active queue turns.
 *
 * @param {boolean} active - True if a queue task is in flight.
 * @param {string} [text=''] - Telemetry string to display.
 */
export function setQueueShieldState(active, text = '') {
  queueShieldLockActive = Boolean(active);
  if (active) {
    applyButtonShieldVisual(true, text || 'Processing Queue...', 'wait');
  } else {
    applyButtonShieldVisual(false, '', 'wait');
    renderDualLedgerHudFromState(getClientPolicyState());
  }
}

/**
 * Disables or restores the Generate button overlay for V5 capacity/battery exhaustion prompts
 * (`V5 Quota Depleted` or `Battery Recharging`) when no queue turn is actively running.
 *
 * @param {boolean} locked - True if V5 generation is locked out.
 * @param {string} [reasonText=''] - Capacity prompt text.
 */
export function setGenerateLockoutState(locked, reasonText = '') {
  if (queueShieldLockActive) return;
  applyButtonShieldVisual(Boolean(locked), reasonText || 'V5 Quota Depleted', 'not-allowed');
}

let observerInstance = null;
let rafScheduled = false;
let observedInputRoot = null;
let inputConstraintHandler = null;

/**
 * Initializes the unified MutationObserver lifecycle engine and reactive step-input listeners.
 * Executes idempotent mounts and tracks native Model/Effort changes via requestAnimationFrame.
 *
 * @param {object} options - Lifecycle callbacks.
 * @param {Function} [options.onOpenSettings] - Triggered by the nav row badge.
 */
export function initDOMObserver(options = {}) {
  stopDOMObserver();

  const runSync = () => {
    rafScheduled = false;
    injectNavBadge(options.onOpenSettings);
    injectAllowanceBar();
    injectDualLedgerBar();
    injectQueueShield();
    refreshDualLedgerHud();
  };

  observerInstance = new MutationObserver((mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (m.target) {
        if (m.target.id && m.target.id.startsWith('gw-')) continue;
        if (typeof m.target.closest === 'function' && m.target.closest('[id^="gw-"]')) continue;
      }
      if (m.type === 'attributes') {
        relevant = true;
        break;
      }
      if ((m.addedNodes && m.addedNodes.length > 0) || (m.removedNodes && m.removedNodes.length > 0)) {
        relevant = true;
        break;
      }
    }

    if (relevant && !rafScheduled) {
      rafScheduled = true;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(runSync);
      } else {
        setTimeout(runSync, 16);
      }
    }
  });

  const root = document.body || document.documentElement;
  if (root) {
    observerInstance.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-pressed', 'aria-selected']
    });

    if (typeof root.addEventListener === 'function') {
      observedInputRoot = root;
      inputConstraintHandler = (ev) => {
        if (ev && isStepControlInput(ev.target)) {
          syncUIControlConstraints(getClientPolicyState());
        }
      };
      root.addEventListener('input', inputConstraintHandler, true);
      root.addEventListener('change', inputConstraintHandler, true);
    }
  }

  runSync();
}

/**
 * Disconnects the active MutationObserver and removes reactive step-input listeners.
 */
export function stopDOMObserver() {
  if (observerInstance) {
    observerInstance.disconnect();
    observerInstance = null;
  }
  if (observedInputRoot && inputConstraintHandler && typeof observedInputRoot.removeEventListener === 'function') {
    observedInputRoot.removeEventListener('input', inputConstraintHandler, true);
    observedInputRoot.removeEventListener('change', inputConstraintHandler, true);
  }
  observedInputRoot = null;
  inputConstraintHandler = null;
}