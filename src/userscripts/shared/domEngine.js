/**
 * DYNAMIC CLASS HARVESTER & DOM INJECTION ENGINE (src/userscripts/shared/domEngine.js)
 * 
 * ARCHITECTURAL MANDATE:
 * Implements the runtime "Anchor -> Scrape -> Inject" paradigm with live NovelAI theme parity
 * across both desktop and mobile layouts.
 * 1. Semantic Query Anchoring: Targets visible permanent semantic anchors (`button[aria-label="menu"]`,
 *    `.image-gen-generate-button`, `.image-gen-model-mode-row`) while skipping hidden (`display: none`)
 *    duplicate desktop/mobile nodes so mounts, theme colors, and native Model/Effort/Spec reads stay
 *    locked to the active layout across viewport resizes.
 * 2. Point-in-Time Class & Style Synchronization: Extracts compiled styled-components class strings
 *    from native DOM nodes (like `button[aria-label="menu"]`) AND continuously synchronizes class
 *    and computed color changes onto `#gw-nav-badge` when NovelAI loads user theme preferences
 *    asynchronously or swaps themes live.
 * 3. Live Theme Parity & Compact Mobile Dual-Ledger HUD:
 *    - Scrapes active NovelAI surface, text, border, control, and accent colors via `theme.js`,
 *      dynamically refreshing `#gw-v5-bar`, `#gw-allowance-bar`, and `#gw-button-shield` inline
 *      surfaces while preserving `var(--theme-bg0, <scraped>)` and `var(--theme-bg2, <scraped>)`
 *      wrappers for contract safety.
 *    - Renders the Dual-Ledger HUD (`#gw-v5-bar`) directly ABOVE `#gw-allowance-bar` so that
 *      `#gw-allowance-bar.nextElementSibling === .image-gen-generate-button` always remains intact.
 *    - Automatically engages compact `.gw-v5-compact` mobile formatting (`window.innerWidth <= 640`
 *      or narrow container `< 310px`), condensing rows to two crisp non-wrapping single lines
 *      without truncating V5 High/Med generation counts or bloating mobile drawer height.
 *    - Translates internal V5 NCP units into human-readable High/Medium generation counts bounded
 *      against spendable master tank capacity, suppresses V5 generation cost display when configured
 *      for non-addon Anlas bypass (`>1MP`, `>1` sample, or `>28` steps on V5 High), and hides
 *      `#gw-allowance-bar` (`display: none`) when exempt from Metered limits.
 *    - Shields the primary Generate button with an opaque, absolute event-gating overlay (`inset: 0`,
 *      `z-index: 9999`), hiding sibling children to prevent text superposition.
 * 4. Single Presentation Portal: Centralizes all settings into the dedicated standalone modal
 *    triggered by `#gw-nav-badge`.
 * 5. Ephemeral Telemetry Isolation: Keeps server telemetry strictly in page RAM (`cachedPolicyState`)
 *    and persists only explicit user preferences (`anlas_bypass_enabled`) in `GM_setValue`.
 * 6. Guarded MutationObserver, Head Stylesheet Observer & Resize Listener: Employs requestAnimationFrame
 *    debouncing, strict self-mutation filtering (including `#gw-ui-styles`), and guarded input/resize
 *    listeners for live deadband, cost, compact-mode, and theme updates.
 * 7. Zero Node.js Leaks: Strictly browser-safe.
 */

'use strict';

import GUILD_BADGE_SVG from './assets/guild_badge.svg';
import {
  isV5ModelFamily,
  isV5MediumModel,
  V5_HIGH_NCP_COST,
  V5_MEDIUM_NCP_COST,
  FIREWALL_MAX_PIXELS,
  FIREWALL_MAX_STEPS,
  FIREWALL_MAX_SAMPLES
} from './pricing.js';
import { ensureGuildWeaveStyles } from './theme.js';

export { GUILD_BADGE_SVG };

const V5_HIGH_IMAGES_PER_PERCENT = 17.28;
const V5_CIRCUIT_BREAKER_PERCENT = 5.5;

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
 * Checks whether a DOM node and its ancestors are visible, remaining safe when
 * `window.getComputedStyle` is unavailable (e.g. minimal VM sandboxes).
 *
 * @param {Element|null} node - Target DOM node.
 * @returns {boolean} True if visible.
 */
function isDomNodeVisible(node) {
  if (!node) return false;
  const hasComputedStyle = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function';

  const isStyleHidden = (el) => {
    if (!el) return true;
    if (hasComputedStyle) {
      try {
        const st = window.getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) {
          return true;
        }
      } catch (_) {}
    }
    const inline = el.style;
    if (inline && (inline.display === 'none' || inline.visibility === 'hidden' || inline.opacity === '0')) {
      return true;
    }
    return false;
  };

  if (isStyleHidden(node)) return false;

  let cur = node.parentElement;
  let hops = 0;
  while (cur && hops < 16) {
    if (hasComputedStyle) {
      try {
        const st = window.getComputedStyle(cur);
        if (st && (st.display === 'none' || st.opacity === '0')) {
          return false;
        }
      } catch (_) {}
    }
    if (cur.style && (cur.style.display === 'none' || cur.style.opacity === '0')) {
      return false;
    }
    if (typeof document !== 'undefined' && (cur === document.body || cur === document.documentElement)) break;
    cur = cur.parentElement;
    hops++;
  }
  return true;
}

/**
 * Selects the first visible matching element for a CSS selector, falling back to
 * the first DOM match if all matches are currently hidden.
 *
 * @param {string} selector - CSS selector string.
 * @returns {Element|null} Matched element or null.
 */
function pickVisibleDomElement(selector) {
  if (typeof document === 'undefined') return null;
  if (typeof document.querySelectorAll === 'function') {
    const matches = document.querySelectorAll(selector);
    if (matches && matches.length > 0) {
      for (const el of matches) {
        if (el && !isInsideGuildWeaveNode(el) && isDomNodeVisible(el)) {
          return el;
        }
      }
      for (const el of matches) {
        if (el && !isInsideGuildWeaveNode(el)) {
          return el;
        }
      }
    }
  }
  return typeof document.querySelector === 'function' ? document.querySelector(selector) : null;
}

/**
 * Determines whether the GuildWeave HUD should render in compact mobile layout
 * (`window.innerWidth <= 640` or narrow `#gw-v5-bar` width `< 310px`).
 *
 * @returns {boolean} True when compact layout should be applied.
 */
export function isCompactHudLayout() {
  if (
    typeof window !== 'undefined' &&
    typeof window.innerWidth === 'number' &&
    window.innerWidth > 0 &&
    window.innerWidth <= 640
  ) {
    return true;
  }
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    const v5Root = document.getElementById('gw-v5-bar');
    if (v5Root && typeof v5Root.getBoundingClientRect === 'function') {
      try {
        const rect = v5Root.getBoundingClientRect();
        if (rect && typeof rect.width === 'number' && rect.width > 0 && rect.width < 310) {
          return true;
        }
      } catch (_) {}
    }
  }
  return false;
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

function isInsideGuildWeaveNode(node) {
  if (!node) return false;
  if (node.id && (node.id.startsWith('gw-') || node.id.startsWith('vps-'))) return true;
  if (typeof node.closest === 'function') {
    return Boolean(node.closest('[id^="gw-"]') || node.closest('[id^="vps-"]'));
  }
  return false;
}

/**
 * Reads NovelAI's live generation geometry (width, height, steps, sample count) from
 * native UI controls (prioritizing visible controls over hidden drawer duplicates)
 * so `#gw-v5-cost` accurately suppresses V5 credit charges whenever the user has
 * configured a non-addon Anlas bypass (`>1MP`, `>1` sample, or `>28` steps on V5 High)
 * while keeping V5 credit charges visible for addon-only Anlas usage.
 *
 * @param {string} [activeModel=''] - Active model identifier.
 * @returns {{ width: number, height: number, area: number, steps: number, samples: number }}
 */
export function readNativeGenerationSpecsFromDOM(activeModel = '') {
  const isMed = isV5MediumModel(activeModel);
  let width = 1024;
  let height = 1024;
  let steps = isMed ? 14 : 23;
  let samples = 1;

  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return { width, height, area: width * height, steps, samples };
  }

  let foundWidth = null;
  let foundHeight = null;
  let foundSteps = null;
  let foundSamples = null;

  let hiddenWidth = null;
  let hiddenHeight = null;
  let hiddenSteps = null;
  let hiddenSamples = null;

  const inputs = document.querySelectorAll('input');
  for (const input of inputs) {
    if (!input || isInsideGuildWeaveNode(input)) continue;
    const aria = (input.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    const name = (input.getAttribute('name') || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const numVal = parseInt(input.value, 10);
    if (!Number.isFinite(numVal) || numVal <= 0) continue;

    const visible = isDomNodeVisible(input);
    if (isStepControlInput(input)) {
      if (visible) foundSteps = numVal;
      else if (hiddenSteps === null) hiddenSteps = numVal;
    } else if (aria === 'width' || placeholder === 'width' || name === 'width' || id.includes('width')) {
      if (visible) foundWidth = numVal;
      else if (hiddenWidth === null) hiddenWidth = numVal;
    } else if (aria === 'height' || placeholder === 'height' || name === 'height' || id.includes('height')) {
      if (visible) foundHeight = numVal;
      else if (hiddenHeight === null) hiddenHeight = numVal;
    } else if (
      aria.includes('number of images') ||
      aria.includes('samples') ||
      name === 'n_samples' ||
      id.includes('sample')
    ) {
      if (visible) foundSamples = numVal;
      else if (hiddenSamples === null) hiddenSamples = numVal;
    }
  }

  if (foundWidth === null) foundWidth = hiddenWidth;
  if (foundHeight === null) foundHeight = hiddenHeight;
  if (foundSteps === null) foundSteps = hiddenSteps;
  if (foundSamples === null) foundSamples = hiddenSamples;

  // Fallback for sample count inside `.image-gen-generate-button` ("Generate 4 Images")
  if (foundSamples === null) {
    const genBtn = pickVisibleDomElement('.image-gen-generate-button');
    if (genBtn) {
      const btnTextParts = [];
      for (const child of genBtn.children) {
        if (child && child.id !== 'gw-button-shield' && child.textContent) {
          btnTextParts.push(child.textContent);
        }
      }
      const btnText = btnTextParts.join(' ');
      const genMatch = btnText.match(/generate\s+(\d+)\s+image/i);
      if (genMatch) {
        const parsedSamples = parseInt(genMatch[1], 10);
        if (Number.isFinite(parsedSamples) && parsedSamples > 0) {
          foundSamples = parsedSamples;
        }
      }
    }
  }

  // Restricted fallback for resolution selector labels (ignores arbitrary prompt/history text in document.body)
  if (foundWidth === null || foundHeight === null) {
    const candidateGroups = [];
    if (typeof document.querySelectorAll === 'function') {
      candidateGroups.push(...document.querySelectorAll('div, span, button'));
    }
    const footerEl = pickVisibleDomElement('.image-gen-footer');
    for (const el of candidateGroups) {
      if (!el || isInsideGuildWeaveNode(el)) continue;
      const cls = el.getAttribute('class') || '';
      const isControlSurface = cls.includes('singleValue') ||
        Boolean(el.getAttribute('aria-haspopup')) ||
        (footerEl && el.parentElement === footerEl);
      if (!isControlSurface) continue;

      const txt = (el.textContent || '').trim();
      if (txt.length > 48) continue;
      const resMatch = txt.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/i);
      if (resMatch) {
        const w = parseInt(resMatch[1], 10);
        const h = parseInt(resMatch[2], 10);
        if (w >= 64 && h >= 64 && w <= 4096 && h <= 4096) {
          foundWidth = w;
          foundHeight = h;
          break;
        }
      }
    }
  }

  if (foundWidth !== null && foundHeight !== null) {
    width = foundWidth;
    height = foundHeight;
  }
  if (foundSteps !== null) steps = foundSteps;
  if (foundSamples !== null) samples = foundSamples;

  return { width, height, area: width * height, steps, samples };
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

  const modelRow = pickVisibleDomElement('.image-gen-model-mode-row');
  if (!modelRow) return null;

  let modelText = '';
  const modelInput = modelRow.querySelector('input[aria-label="Select the Model"]') ||
    pickVisibleDomElement('input[aria-label="Select the Model"]');

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
 * Keeps `#gw-nav-badge` synchronized with `button[aria-label="menu"]`'s live
 * classes and computed colors after theme hydration or dynamic theme switching.
 *
 * @param {Element} badgeBtn - Injected GuildWeave nav badge button.
 * @param {Element} menuBtn - Native NovelAI hamburger menu button.
 */
function syncNavBadgeAppearance(badgeBtn, menuBtn) {
  const btnClasses = getElementClasses(menuBtn, 'nav_menu_btn');
  if (btnClasses && badgeBtn.className !== btnClasses) {
    badgeBtn.className = btnClasses;
    badgeBtn.style.backgroundColor = '';
    badgeBtn.style.borderColor = '';
    badgeBtn.style.color = '';
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const menuStyle = window.getComputedStyle(menuBtn);
      const badgeStyle = window.getComputedStyle(badgeBtn);
      if (menuStyle && badgeStyle) {
        if (menuStyle.backgroundColor && badgeStyle.backgroundColor !== menuStyle.backgroundColor) {
          badgeBtn.style.backgroundColor = menuStyle.backgroundColor;
        }
        if (menuStyle.color && badgeStyle.color !== menuStyle.color) {
          badgeBtn.style.color = menuStyle.color;
        }
        const mBorder = menuStyle.borderTopColor || menuStyle.borderColor;
        const bBorder = badgeStyle.borderTopColor || badgeStyle.borderColor;
        if (mBorder && bBorder !== mBorder) {
          badgeBtn.style.borderColor = mBorder;
        }
      }
    } catch (_) {}
  }
}

/**
 * Injects the Guild Badge trigger button into the visible `button[aria-label="menu"]`
 * wrapper (supporting both desktop `.image-gen-nav-row` and mobile top bars) and keeps
 * its classes and computed colors synced across theme changes and viewport resizes.
 *
 * @param {Function} onClickHandler - Callback invoked when the badge button is clicked.
 * @returns {boolean} True if element is mounted and synced.
 */
export function injectNavBadge(onClickHandler) {
  const menuBtn = pickVisibleDomElement('button[aria-label="menu"]');
  if (!menuBtn || !menuBtn.parentElement) return false;

  const existing = document.getElementById('gw-nav-badge');
  if (existing) {
    if (existing.parentElement === menuBtn.parentElement) {
      syncNavBadgeAppearance(existing, menuBtn);
      return true;
    }
    existing.remove();
  }

  const badgeBtn = document.createElement('button');
  badgeBtn.id = 'gw-nav-badge';
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
  syncNavBadgeAppearance(badgeBtn, menuBtn);
  return true;
}

/**
 * Constructs and injects the standalone Rolling Allowance Bar directly above the visible
 * `.image-gen-generate-button` inside its parent wrapper. Automatically relocates if
 * responsive layout switches which Generate button is visible.
 * Hidden by default (`display: none`) until `/auth/status` confirms a Metered tier (`session !== null`),
 * preserving `allowanceBar.nextElementSibling === genBtn`.
 *
 * @returns {boolean} True if element was injected or already exists in the active slot.
 */
export function injectAllowanceBar() {
  const genBtn = pickVisibleDomElement('.image-gen-generate-button');
  if (!genBtn || !genBtn.parentElement) return false;

  const existing = document.getElementById('gw-allowance-bar');
  if (existing) {
    if (existing.parentElement === genBtn.parentElement && existing.nextElementSibling === genBtn) {
      return true;
    }
    existing.remove();
  }

  const theme = ensureGuildWeaveStyles();

  const barRoot = document.createElement('div');
  barRoot.id = 'gw-allowance-bar';
  barRoot.style.cssText = `
    display: none;
    flex-direction: column;
    gap: 4px;
    padding: 6px 9px 7px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, ${theme.borderStrong});
    background-color: var(--theme-bg0, ${theme.bg0});
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
    color: var(--theme-text, ${theme.text});
    font-size: 0.75rem;
    font-weight: 600;
  `.replace(/\s+/g, ' ').trim();
  labelSpan.textContent = 'Image Allowance: --/100';

  headerRow.appendChild(labelSpan);

  const trackDiv = document.createElement('div');
  trackDiv.id = 'gw-allowance-track';
  trackDiv.style.cssText = `
    height: 4px;
    width: 100%;
    background: var(--theme-bg2, ${theme.border});
    border-radius: 999px;
    overflow: hidden;
    position: relative;
  `.replace(/\s+/g, ' ').trim();

  const fillDiv = document.createElement('div');
  fillDiv.id = 'gw-allowance-fill';
  fillDiv.style.cssText = `
    height: 100%;
    width: 100%;
    background-color: var(--theme-accent, ${theme.accent});
    border-radius: 999px;
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
  ensureGuildWeaveStyles();
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
 * @returns {boolean} True if mounted or already present in the active slot.
 */
export function injectDualLedgerBar() {
  injectAllowanceBar();
  const allowanceBar = document.getElementById('gw-allowance-bar');
  if (!allowanceBar || !allowanceBar.parentElement) return false;

  const existing = document.getElementById('gw-v5-bar');
  if (existing) {
    if (existing.parentElement === allowanceBar.parentElement && existing.nextElementSibling === allowanceBar) {
      return true;
    }
    existing.remove();
  }

  const theme = ensureGuildWeaveStyles();

  const v5Root = document.createElement('div');
  v5Root.id = 'gw-v5-bar';
  v5Root.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 7px 9px 8px;
    border-radius: 8px;
    border: 1px solid var(--theme-bg2, ${theme.borderStrong});
    background-color: var(--theme-bg0, ${theme.bg0});
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 4px;
    box-sizing: border-box;
  `.replace(/\s+/g, ' ').trim();

  // Row 1: V5 Free Allowance (in readable High / Med images) + Shared Pool Status & Recharge ETA
  const v5HeaderRow = document.createElement('div');
  v5HeaderRow.className = 'gw-hud-row';
  v5HeaderRow.style.cssText = 'display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px;';

  const v5Label = document.createElement('span');
  v5Label.id = 'gw-v5-label';
  v5Label.style.cssText = `color: var(--theme-text, ${theme.text}); font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
  v5Label.textContent = 'V5 Allowance: Syncing...';

  const v5Eta = document.createElement('span');
  v5Eta.id = 'gw-v5-eta';
  v5Eta.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
  v5Eta.textContent = '';

  v5HeaderRow.appendChild(v5Label);
  v5HeaderRow.appendChild(v5Eta);

  // V5 Progress Track
  const v5Track = document.createElement('div');
  v5Track.id = 'gw-v5-track';
  v5Track.style.cssText = `height: 4px; width: 100%; background: var(--theme-bg2, ${theme.border}); border-radius: 999px; overflow: hidden; position: relative;`;

  const v5Fill = document.createElement('div');
  v5Fill.id = 'gw-v5-fill';
  v5Fill.style.cssText = `height: 100%; width: 100%; background-color: var(--theme-accent, ${theme.accent}); border-radius: 999px; transition: width 0.35s ease-in-out, background-color 0.35s ease-in-out;`;
  v5Track.appendChild(v5Fill);

  // Row 2: Monthly Anlas + Active V5 Cost (hidden during non-addon Anlas bypass) + Use Monthly Anlas Toggle
  const controlsRow = document.createElement('div');
  controlsRow.className = 'gw-hud-row';
  controlsRow.style.cssText = 'display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;';

  const anlasLabel = document.createElement('span');
  anlasLabel.id = 'gw-anlas-label';
  anlasLabel.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
  anlasLabel.textContent = 'Monthly Anlas: --';
  anlasLabel.setAttribute('title', 'Resets each billing cycle; unused Anlas does not roll over.');

  const rightControls = document.createElement('div');
  rightControls.className = 'gw-hud-right';
  rightControls.style.cssText = 'display: flex; align-items: center; gap: 8px;';

  const costBadge = document.createElement('span');
  costBadge.id = 'gw-v5-cost';
  costBadge.style.cssText = `color: var(--theme-textSecondary, ${theme.textMuted}); font-size: 0.68rem; white-space: nowrap;`;
  costBadge.textContent = '';

  const state = getClientPolicyState();

  const bypassLabel = document.createElement('label');
  bypassLabel.id = 'gw-bypass-label';
  bypassLabel.style.cssText = `display: inline-flex; align-items: center; gap: 5px; font-size: 0.68rem; cursor: pointer; color: var(--theme-textSecondary, ${theme.textMuted}); white-space: nowrap;`;
  bypassLabel.setAttribute('title', 'Enable spending monthly Anlas for sizes >1MP, >1 image, or >28 steps.');

  const bypassCheckbox = document.createElement('input');
  bypassCheckbox.type = 'checkbox';
  bypassCheckbox.id = 'gw-bypass-toggle';
  bypassCheckbox.className = 'gw-inline-check';
  bypassCheckbox.checked = Boolean(state.bypassEnabled) && !state.isInDebt;
  bypassCheckbox.disabled = Boolean(state.isInDebt);
  bypassCheckbox.style.cssText = 'width: 14px; min-width: 14px; flex: 0 0 14px; margin: 0; cursor: pointer;';
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
  bypassText.textContent = state.isInDebt ? 'Anlas Paused' : 'Use Anlas';

  bypassLabel.appendChild(bypassCheckbox);
  bypassLabel.appendChild(bypassText);

  rightControls.appendChild(costBadge);
  rightControls.appendChild(bypassLabel);

  controlsRow.appendChild(anlasLabel);
  controlsRow.appendChild(rightControls);

  // Row 3: Contextual Alert Line (Drift / Deadband / Recharging)
  const alertDiv = document.createElement('div');
  alertDiv.id = 'gw-hud-alert';
  alertDiv.style.cssText = `display: none; font-size: 0.68rem; line-height: 1.35; padding: 4px 7px; border-radius: 5px; background: var(--theme-bg1, ${theme.bg1}); border: 1px solid ${theme.border}; color: var(--theme-warning, ${theme.warning});`;

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

  const theme = ensureGuildWeaveStyles();
  alertEl.style.display = 'block';
  alertEl.textContent = message;
  alertEl.style.backgroundColor = `var(--theme-bg1, ${theme.bg1})`;
  alertEl.style.borderColor = theme.border;
  if (severity === 'error') {
    alertEl.style.color = `var(--theme-error, ${theme.error})`;
  } else if (severity === 'info') {
    alertEl.style.color = `var(--theme-accent, ${theme.accent})`;
  } else {
    alertEl.style.color = `var(--theme-warning, ${theme.warning})`;
  }
}

/**
 * Formats milliseconds until next percent into compact human-readable countdown text.
 *
 * @param {number|null|undefined} etaMs - Milliseconds until next percent.
 * @param {boolean} [compact=false] - Whether to omit verbose `"in "` wording for mobile.
 * @returns {string} Formatted countdown badge.
 */
function formatNextPercentEta(etaMs, compact = false) {
  if (typeof etaMs !== 'number' || !Number.isFinite(etaMs)) return '';
  if (etaMs <= 0) return 'Full';
  const mins = Math.max(0.1, etaMs / 60000);
  if (mins >= 60) {
    return compact ? `+${(mins / 60).toFixed(1)}h` : `+1% in ${(mins / 60).toFixed(1)}h`;
  }
  return compact ? `+${mins.toFixed(1)}m` : `+1% in ${mins.toFixed(1)}m`;
}

/**
 * Maps internal cluster state identifiers to plain, user-friendly labels.
 *
 * @param {string|null} clusterState - Internal cluster state token.
 * @returns {string} User-friendly label.
 */
function formatReadableClusterState(clusterState) {
  switch (clusterState) {
    case 'surplus_active':
      return 'Shared Bonus Open';
    case 'reserve_mode':
      return 'Personal Allowance';
    case 'throttled':
      return 'Low Shared Pool';
    case 'frozen':
      return 'Recharging';
    case 'token_expired':
      return 'Session Expired';
    case 'telemetry_offline':
      return 'Syncing';
    default:
      return '';
  }
}

/**
 * Maps `cluster_state` to theme-matched progress bar fills, reserving warning/error
 * colors exclusively for degraded states.
 *
 * @param {string|null} clusterState - Cluster state token from `/auth/status`.
 * @param {object} theme - Active scraped NovelAI theme palette.
 * @returns {string} CSS color expression.
 */
function resolveClusterStateColor(clusterState, theme) {
  if (clusterState === 'frozen' || clusterState === 'token_expired') return `var(--theme-error, ${theme.error})`;
  if (clusterState === 'throttled' || clusterState === 'telemetry_offline') return `var(--theme-warning, ${theme.warning})`;
  return `var(--theme-accent, ${theme.accent})`;
}

/**
 * Computes spendable master V5 headroom above the 5.5% circuit breaker in NCP
 * so HUD display never exceeds physical master bucket capacity.
 *
 * @param {object} state - Client policy state.
 * @returns {number|null} Maximum spendable NCP or null when battery telemetry is unknown.
 */
function computeClientSpendableMasterNcp(state) {
  if (typeof state.masterV5Percent !== 'number' || !Number.isFinite(state.masterV5Percent)) {
    return null;
  }
  if (state.isHardLocked || state.subscriptionActive === false || state.masterTokenExpired) {
    return 0;
  }
  const rawPct = (typeof state.masterV5RawPercent === 'number' && Number.isFinite(state.masterV5RawPercent))
    ? state.masterV5RawPercent
    : state.masterV5Percent;
  return Math.floor(Math.max(0, rawPct - V5_CIRCUIT_BREAKER_PERCENT) * V5_HIGH_IMAGES_PER_PERCENT * V5_HIGH_NCP_COST);
}

/**
 * Renders the `#gw-v5-bar` labels, compact mobile formatting (`gw-v5-compact`),
 * native V5 generation credit indicator (suppressed when spending non-addon Anlas),
 * live scraped theme surface/border colors, progress fill, debt warnings, and toggle state.
 *
 * @param {object} state - Normalized client policy state.
 */
function renderDualLedgerHudFromState(state) {
  const theme = ensureGuildWeaveStyles();
  const compact = isCompactHudLayout();

  const v5Root = document.getElementById('gw-v5-bar');
  const v5Track = document.getElementById('gw-v5-track');
  const v5Label = document.getElementById('gw-v5-label');
  const v5Eta = document.getElementById('gw-v5-eta');
  const v5Fill = document.getElementById('gw-v5-fill');
  const anlasLabel = document.getElementById('gw-anlas-label');
  const costBadge = document.getElementById('gw-v5-cost');
  const bypassCheckbox = document.getElementById('gw-bypass-toggle');
  const bypassText = document.getElementById('gw-bypass-text');
  const modalBypass = document.getElementById('settings-anlas-bypass');
  const allowanceRoot = document.getElementById('gw-allowance-bar');
  const allowanceLabel = document.getElementById('gw-allowance-label');
  const allowanceTrack = document.getElementById('gw-allowance-track');
  const shieldEl = document.getElementById('gw-button-shield');
  const shieldTextEl = document.getElementById('gw-shield-text');

  // Continuously keep injected bars synced with live NovelAI theme colors & compact state
  if (v5Root) {
    v5Root.style.backgroundColor = `var(--theme-bg0, ${theme.bg0})`;
    v5Root.style.border = `1px solid var(--theme-bg2, ${theme.borderStrong})`;
    if (compact) {
      v5Root.className = 'gw-v5-compact';
    } else if (v5Root.className === 'gw-v5-compact') {
      v5Root.className = '';
    }
  }
  if (v5Track) {
    v5Track.style.background = theme.border;
  }
  if (allowanceRoot) {
    allowanceRoot.style.backgroundColor = `var(--theme-bg0, ${theme.bg0})`;
    allowanceRoot.style.border = `1px solid var(--theme-bg2, ${theme.borderStrong})`;
  }
  if (allowanceLabel) {
    allowanceLabel.style.color = `var(--theme-text, ${theme.text})`;
  }
  if (allowanceTrack) {
    allowanceTrack.style.background = theme.border;
  }
  if (shieldEl) {
    shieldEl.style.background = `var(--theme-bg1, ${theme.bg1})`;
    shieldEl.style.border = `1px solid var(--theme-accent, ${theme.borderStrong})`;
  }
  if (shieldTextEl) {
    shieldTextEl.style.color = `var(--theme-textHeadings, ${theme.text})`;
  }

  const activeModel = state.activeModel || '';
  const isV5 = isV5ModelFamily(activeModel);
  const isMed = isV5MediumModel(activeModel);
  const specs = readNativeGenerationSpecsFromDOM(activeModel);
  const isBaseAnlasBypass = Boolean(state.bypassEnabled) && (
    specs.area > FIREWALL_MAX_PIXELS ||
    specs.samples !== FIREWALL_MAX_SAMPLES ||
    (isV5 && !isMed && specs.steps > FIREWALL_MAX_STEPS)
  );

  const spendableMasterNcp = computeClientSpendableMasterNcp(state);
  const pctText = typeof state.masterV5Percent === 'number' && Number.isFinite(state.masterV5Percent)
    ? `${state.masterV5Percent.toFixed(1)}%`
    : '--%';

  if (v5Label && v5Fill) {
    v5Label.style.color = `var(--theme-text, ${theme.text})`;

    if (state.masterTokenExpired || state.clusterState === 'token_expired') {
      v5Label.textContent = compact ? 'Token Expired' : 'Master Token Expired (Awaiting Admin)';
      v5Label.setAttribute('title', 'The shared NovelAI session token expired and needs to be refreshed by an admin.');
      v5Fill.style.width = '0%';
      v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
    } else if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
      v5Label.textContent = compact ? 'Sub Inactive' : 'Master Subscription Inactive';
      v5Fill.style.width = '0%';
      v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
    } else if (state.isHardLocked) {
      v5Label.textContent = compact ? `Recharging (${pctText})` : `V5 Recharging (${pctText} <= 5.5%)`;
      v5Label.setAttribute('title', 'Shared V5 capacity must stay above 5.5% to prevent a cluster-wide cooldown. Legacy models and Anlas-paid specs still work.');
      const widthPct = typeof state.masterV5Percent === 'number' ? Math.max(0, Math.min(100, state.masterV5Percent)) : 0;
      v5Fill.style.width = `${widthPct}%`;
      v5Fill.style.backgroundColor = `var(--theme-error, ${theme.error})`;
    } else if (state.isUnlimitedV5) {
      v5Label.textContent = compact ? 'V5: Unlimited' : `V5 Allowance: Unlimited · Pool: ${pctText}`;
      v5Fill.style.width = '100%';
      v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState, theme);
    } else if (typeof state.v5AvailableNcp === 'number') {
      const effectiveNcp = (spendableMasterNcp !== null && state.lastFetchedAt > 0)
        ? Math.min(state.v5AvailableNcp, spendableMasterNcp)
        : state.v5AvailableNcp;
      const effectiveSurplus = (spendableMasterNcp !== null && state.lastFetchedAt > 0 && typeof state.v5SurplusAvailableNcp === 'number')
        ? Math.min(state.v5SurplusAvailableNcp, spendableMasterNcp)
        : (state.v5SurplusAvailableNcp || 0);

      const highLeft = Math.floor(effectiveNcp / V5_HIGH_NCP_COST);
      const medLeft = Math.floor(effectiveNcp / V5_MEDIUM_NCP_COST);
      const maxNcp = typeof state.v5MaxBankNcp === 'number' && state.v5MaxBankNcp > 0 ? state.v5MaxBankNcp : state.v5AvailableNcp;
      const surplusHigh = (state.v5SurplusEligible && effectiveSurplus >= V5_HIGH_NCP_COST)
        ? Math.floor(effectiveSurplus / V5_HIGH_NCP_COST)
        : 0;
      const surplusSuffix = surplusHigh > 0 ? ` (+${surplusHigh} Bonus)` : '';
      const depleted = effectiveNcp < V5_MEDIUM_NCP_COST && (!state.v5SurplusEligible || effectiveSurplus < V5_MEDIUM_NCP_COST);

      if (compact) {
        v5Label.textContent = depleted
          ? 'V5 Limit Reached'
          : `V5: ${highLeft}H/${medLeft}M${surplusHigh > 0 ? `+${surplusHigh}` : ''}`;
      } else {
        v5Label.textContent = depleted
          ? `V5 Limit Reached · Pool: ${pctText}`
          : `V5 Free: ${highLeft} High / ${medLeft} Med${surplusSuffix} · Pool: ${pctText}`;
      }
      v5Label.setAttribute(
        'title',
        `Personal Reserve: ${effectiveNcp}/${maxNcp} V5 credits (accumulates daily up to 3 days). Bonus Pool activates above 50% shared pool.`
      );
      const barPct = maxNcp > 0 ? Math.min(100, Math.max(0, (effectiveNcp / maxNcp) * 100)) : 0;
      v5Fill.style.width = `${barPct}%`;
      v5Fill.style.backgroundColor = resolveClusterStateColor(state.clusterState, theme);
    } else {
      v5Label.textContent = compact ? 'V5: Syncing' : `V5 Allowance: Syncing · Pool: ${pctText}`;
    }
  }

  if (v5Eta) {
    v5Eta.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
    const fullEtaStr = formatNextPercentEta(state.nextPercentEtaMs, false);
    const fullStateLabel = formatReadableClusterState(state.clusterState);
    const fullCombo = [fullStateLabel, fullEtaStr].filter(Boolean).join(' · ');

    if (compact) {
      if (state.masterTokenExpired || state.clusterState === 'token_expired') {
        v5Eta.textContent = 'Admin Reset';
      } else if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
        v5Eta.textContent = 'Paused';
      } else {
        const shortEta = formatNextPercentEta(state.nextPercentEtaMs, true);
        v5Eta.textContent = [pctText !== '--%' ? pctText : '', shortEta].filter(Boolean).join(' · ') || fullStateLabel;
      }
      if (fullCombo) {
        v5Eta.setAttribute('title', `${fullCombo} (Shared Pool ${pctText})`);
      }
    } else {
      v5Eta.textContent = fullCombo;
    }
  }

  if (costBadge) {
    if (!activeModel || (isV5 && isBaseAnlasBypass)) {
      costBadge.style.display = 'none';
      costBadge.textContent = '';
    } else if (isMed) {
      costBadge.style.display = '';
      costBadge.textContent = compact ? `${V5_MEDIUM_NCP_COST} pts` : `Uses ${V5_MEDIUM_NCP_COST} V5 pts (Med)`;
      costBadge.setAttribute('title', `Medium effort uses ${V5_MEDIUM_NCP_COST} credits vs ${V5_HIGH_NCP_COST} on High.`);
      costBadge.style.color = `var(--theme-text, ${theme.text})`;
    } else if (isV5) {
      costBadge.style.display = '';
      costBadge.textContent = compact ? `${V5_HIGH_NCP_COST} pts` : `Uses ${V5_HIGH_NCP_COST} V5 pts (High)`;
      costBadge.setAttribute('title', `High effort uses ${V5_HIGH_NCP_COST} credits per free-size generation.`);
      costBadge.style.color = `var(--theme-text, ${theme.text})`;
    } else {
      costBadge.style.display = '';
      costBadge.textContent = compact ? 'Legacy' : 'Legacy (0 V5 pts)';
      costBadge.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
    }
  }

  if (anlasLabel) {
    if (state.isUnlimitedAnlas) {
      anlasLabel.textContent = compact ? 'Anlas: Unlimited' : 'Monthly Anlas: Unlimited';
      anlasLabel.style.color = `var(--theme-text, ${theme.text})`;
    } else if (state.isInDebt) {
      anlasLabel.textContent = compact
        ? `Anlas: ${state.virtualBalance} (Paused)`
        : `Anlas Overdrawn: ${state.virtualBalance} (Paid Paused)`;
      anlasLabel.style.color = `var(--theme-error, ${theme.error})`;
    } else if (typeof state.availableAnlas === 'number') {
      const quotaSuffix = typeof state.monthlyQuota === 'number' ? `/${state.monthlyQuota}` : '';
      anlasLabel.textContent = compact
        ? `Anlas: ${state.availableAnlas}${quotaSuffix}`
        : `Monthly Anlas: ${state.availableAnlas}${quotaSuffix}`;
      anlasLabel.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
    } else {
      anlasLabel.textContent = compact ? 'Anlas: --' : 'Monthly Anlas: --';
      anlasLabel.style.color = `var(--theme-textSecondary, ${theme.textMuted})`;
    }
  }

  if (bypassCheckbox && bypassText) {
    if (state.isInDebt) {
      bypassCheckbox.checked = false;
      bypassCheckbox.disabled = true;
      bypassText.textContent = compact ? 'Paused' : 'Anlas Paused';
      bypassText.style.color = `var(--theme-error, ${theme.error})`;
    } else {
      bypassCheckbox.disabled = false;
      bypassCheckbox.checked = Boolean(state.bypassEnabled);
      bypassText.textContent = 'Use Anlas';
      bypassText.style.color = state.bypassEnabled
        ? `var(--theme-accent, ${theme.accent})`
        : `var(--theme-textSecondary, ${theme.textMuted})`;
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
  if (!queueShieldLockActive) {
    if (state.subscriptionActive === false && state.lastFetchedAt > 0) {
      setGenerateLockoutState(true, 'Subscription Inactive');
    } else if (isV5 && !isBaseAnlasBypass && !state.bypassEnabled && !state.masterTokenExpired && state.clusterState !== 'token_expired') {
      if (state.isHardLocked) {
        setGenerateLockoutState(true, 'V5 Recharging');
      } else if (
        typeof state.v5AvailableNcp === 'number' &&
        !state.isUnlimitedV5 &&
        state.lastFetchedAt > 0
      ) {
        const reqNcp = isMed ? V5_MEDIUM_NCP_COST : V5_HIGH_NCP_COST;
        const effectiveNcp = (spendableMasterNcp !== null) ? Math.min(state.v5AvailableNcp, spendableMasterNcp) : state.v5AvailableNcp;
        const effectiveSurplus = (spendableMasterNcp !== null && typeof state.v5SurplusAvailableNcp === 'number')
          ? Math.min(state.v5SurplusAvailableNcp, spendableMasterNcp)
          : (state.v5SurplusAvailableNcp || 0);
        const surplusAvail = state.v5SurplusEligible ? effectiveSurplus : 0;
        if (effectiveNcp < reqNcp && surplusAvail < reqNcp) {
          setGenerateLockoutState(true, 'V5 Allowance Reached');
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
          'V5 High allows up to 23 steps without Anlas (or 29+ steps when using Anlas). Steps 24–28 are blocked to protect shared V5 limits—use ≤23 steps or switch to Medium.',
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
    lastHudAlertText.includes('24–28') &&
    (!isV5High || (foundStepInput && !hasStepInDeadband))
  ) {
    setHudAlert('', 'info');
  }
}

/**
 * Scrapes NovelAI's rendered Anlas cost integer from the visible `.image-gen-generate-button`
 * children (ignoring `#gw-button-shield` and sample-count numbers nested inside `"Generate N Image"`
 * labels). Prioritizes `.native-anlas-container`, then explicit `"<N> Anlas"` spans, and finally
 * pure numeric spans whose ancestor chain inside the button contains no Generate/Image text.
 *
 * @returns {number|null} Scraped integer Anlas cost or null if absent.
 */
export function scrapeDisplayedAnlasCost() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  const genBtn = pickVisibleDomElement('.image-gen-generate-button');
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
 * Hides `#gw-allowance-bar` (`display: none`) when the user is exempt (`allowance === null || maxAllowance === Infinity`),
 * preserving DOM sibling relationships (`#gw-allowance-bar.nextElementSibling === .image-gen-generate-button`).
 *
 * @param {number|null} allowance - Current token balance.
 * @param {number} maxAllowance - Upper token boundary.
 * @param {number} [nextRefillMs=0] - Duration in ms until the next token replenishment.
 */
export function updateAllowanceBar(allowance, maxAllowance, nextRefillMs = 0) {
  injectAllowanceBar();
  injectDualLedgerBar();

  const barRoot = document.getElementById('gw-allowance-bar');
  const labelSpan = document.getElementById('gw-allowance-label');
  const fillDiv = document.getElementById('gw-allowance-fill');
  if (!barRoot || !labelSpan || !fillDiv) return;

  const theme = ensureGuildWeaveStyles();

  if (allowance === null || maxAllowance === Infinity) {
    barRoot.style.display = 'none';
    labelSpan.textContent = 'Image Allowance: Unlimited';
    fillDiv.style.width = '100%';
    fillDiv.style.backgroundColor = `var(--theme-accent, ${theme.accent})`;
    return;
  }

  barRoot.style.display = 'flex';
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

  labelSpan.textContent = `Image Allowance: ${clampedAllowance}/${max}${refillSuffix}`;
  fillDiv.style.width = `${percent}%`;

  if (percent < 20) {
    fillDiv.style.backgroundColor = `var(--theme-error, ${theme.error})`;
  } else if (percent < 50) {
    fillDiv.style.backgroundColor = `var(--theme-warning, ${theme.warning})`;
  } else {
    fillDiv.style.backgroundColor = `var(--theme-accent, ${theme.accent})`;
  }
}

/**
 * Mounts an absolute pointer-event shield over the visible `.image-gen-generate-button`.
 * Strictly avoids polluting the overlay element with the button's own CSS class hashes.
 *
 * @returns {boolean} True if shield is mounted or exists on the active button.
 */
export function injectQueueShield() {
  const genBtn = pickVisibleDomElement('.image-gen-generate-button');
  if (!genBtn) return false;

  const existing = document.getElementById('gw-button-shield');
  if (existing) {
    if (existing.parentElement === genBtn) {
      return true;
    }
    existing.remove();
  }

  const theme = ensureGuildWeaveStyles();

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
    background: var(--theme-bg1, ${theme.bg1}) !important;
    border-radius: inherit !important;
    border: 1px solid var(--theme-accent, ${theme.borderStrong}) !important;
    cursor: wait !important;
    display: none;
    pointer-events: none;
    align-items: center;
    justify-content: center;
    opacity: 1 !important;
  `.replace(/\s+/g, ' ').trim();

  const pulseIndicator = document.createElement('div');
  pulseIndicator.style.cssText = `width:8px; height:8px; border-radius:50%; background:var(--theme-accent, ${theme.accent}); margin-right:8px; animation:gwPulse 1s infinite alternate; flex-shrink:0;`;

  const labelText = document.createElement('span');
  labelText.id = 'gw-shield-text';
  labelText.style.cssText = `font-weight:bold; font-size:13px; color:var(--theme-textHeadings, ${theme.text}); white-space:nowrap; letter-spacing:0.5px;`;
  labelText.textContent = 'Joining Queue...';

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
 * (`V5 Allowance Reached` or `V5 Recharging`) when no queue turn is actively running.
 *
 * @param {boolean} locked - True if V5 generation is locked out.
 * @param {string} [reasonText=''] - Capacity prompt text.
 */
export function setGenerateLockoutState(locked, reasonText = '') {
  if (queueShieldLockActive) return;
  applyButtonShieldVisual(Boolean(locked), reasonText || 'V5 Allowance Reached', 'not-allowed');
}

let observerInstance = null;
let headObserverInstance = null;
let rafScheduled = false;
let observedInputRoot = null;
let inputConstraintHandler = null;
let resizeHandler = null;

/**
 * Initializes the unified MutationObserver lifecycle engine, head stylesheet observer,
 * viewport resize handler, and reactive input listeners. Executes idempotent mounts
 * and tracks native Model / Effort / Theme / Spec mutations via requestAnimationFrame.
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

  const scheduleSync = () => {
    if (!rafScheduled) {
      rafScheduled = true;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(runSync);
      } else {
        setTimeout(runSync, 16);
      }
    }
  };

  observerInstance = new MutationObserver((mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (m.target) {
        if (m.target.id && (m.target.id.startsWith('gw-') || m.target.id.startsWith('vps-'))) continue;
        if (typeof m.target.closest === 'function' && (m.target.closest('[id^="gw-"]') || m.target.closest('[id^="vps-"]'))) continue;
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

    if (relevant) {
      scheduleSync();
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
        if (ev && ev.target && !isInsideGuildWeaveNode(ev.target)) {
          refreshDualLedgerHud();
        }
      };
      root.addEventListener('input', inputConstraintHandler, true);
      root.addEventListener('change', inputConstraintHandler, true);
    }
  }

  // Observe styled-components `<style>` additions/mutations in `<head>` (ignoring #gw-ui-styles self-updates)
  if (typeof document !== 'undefined' && document.head && document.head !== root) {
    headObserverInstance = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target && m.target.id === 'gw-ui-styles') continue;
        const touchesOwnStyle =
          Array.from(m.addedNodes || []).some(n => n && n.id === 'gw-ui-styles') ||
          Array.from(m.removedNodes || []).some(n => n && n.id === 'gw-ui-styles');
        if (!touchesOwnStyle) {
          scheduleSync();
          break;
        }
      }
    });
    headObserverInstance.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    resizeHandler = scheduleSync;
    window.addEventListener('resize', resizeHandler);
  }

  runSync();
}

/**
 * Disconnects active MutationObservers and removes reactive step-input and resize listeners.
 */
export function stopDOMObserver() {
  if (observerInstance) {
    observerInstance.disconnect();
    observerInstance = null;
  }
  if (headObserverInstance) {
    headObserverInstance.disconnect();
    headObserverInstance = null;
  }
  if (observedInputRoot && inputConstraintHandler && typeof observedInputRoot.removeEventListener === 'function') {
    observedInputRoot.removeEventListener('input', inputConstraintHandler, true);
    observedInputRoot.removeEventListener('change', inputConstraintHandler, true);
  }
  if (resizeHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('resize', resizeHandler);
  }
  observedInputRoot = null;
  inputConstraintHandler = null;
  resizeHandler = null;
}