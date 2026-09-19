/**
 * DYNAMIC CLASS HARVESTER & DOM INJECTION ENGINE (src/userscripts/shared/domEngine.js)
 * 
 * ARCHITECTURAL MANDATE:
 * Implements the runtime "Anchor -> Scrape -> Inject" paradigm with strict visual parity.
 * 1. Semantic Query Anchoring: Targets unstyled, permanent semantic anchors (.image-gen-nav-row,
 *    .image-gen-footer) to locate mount targets without coupling to transient sc-* hashes.
 * 2. Point-in-Time Class Harvester: Extracts compiled styled-components class strings from native
 *    DOM nodes (like the nav hamburger button) and caches them in memory.
 * 3. Exact Design System Parity via CSS Custom Properties:
 *    - Injects the Guild Badge into the 3-column flex layout of .image-gen-nav-row without layout shifts,
 *      importing the vector asset as an inlined text bundle via esbuild's text loader.
 *    - Renders an autonomous Rolling Allowance Bar matching the exact padding, border, and track geometry
 *      of NovelAI's native Opus capacity bar, styled directly using NovelAI's CSS variables (--theme-bg0,
 *      --theme-bg2, --theme-text, etc.) without fragile runtime scraping of transient elements.
 *    - Shields the primary Generate button with an opaque, absolute event-gating overlay (inset: 0,
 *      z-index: 9999). Programmatically sets `visibility: hidden` on all sibling nodes within the button
 *      to completely eradicate label collision artifacts and text bleed-through.
 * 4. Single Presentation Portal: Eliminates redundant user settings sidebar tabs, centralizing
 *    all script management into the dedicated standalone modal triggered by the nav badge.
 * 5. Guarded MutationObserver: Employs requestAnimationFrame debouncing and strict self-mutation filtering.
 * 6. Zero Node.js Leaks: Strictly browser-safe (zero Buffer, process, or require calls).
 */

'use strict';

import GUILD_BADGE_SVG from './assets/guild_badge.svg';

export { GUILD_BADGE_SVG };

// In-memory class cache storing last-known-good styled-components class hashes
const classCache = new Map();

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
 * Strictly avoids copying icon-specific class hashes from the menu button to prevent
 * CSS mask-image collisions from rendering the native hamburger icon over the custom SVG.
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
  badgeBtn.setAttribute('aria-label', 'GuildWeave Gateway Settings');
  badgeBtn.setAttribute('title', 'GuildWeave Gateway Settings');
  badgeBtn.style.marginRight = '8px';
  badgeBtn.style.cursor = 'pointer';

  // Dedicated container strictly providing alignment without inheriting NovelAI's icon CSS masks
  const innerDiv = document.createElement('div');
  innerDiv.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; pointer-events: none;';
  innerDiv.innerHTML = GUILD_BADGE_SVG;

  // Enforce boundary normalization on arbitrary SVG payloads to prevent navbar flex blowout
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
 * Uses NovelAI's CSS custom properties to guarantee theme alignment without runtime scraping.
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
 * Dynamically updates the Rolling Allowance bar telemetry without triggering DOM reconstruction.
 *
 * @param {number|null} allowance - Current token balance.
 * @param {number} maxAllowance - Upper token boundary.
 * @param {number} [nextRefillMs=0] - Duration in ms until the next token replenishment.
 */
export function updateAllowanceBar(allowance, maxAllowance, nextRefillMs = 0) {
  injectAllowanceBar();

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
 * Updates the state of the Generate button shield overlay.
 * Toggles `visibility: hidden` on all sibling children in the parent button when active.
 * This completely prevents the underlying "Generate 1 Image" text and Anlas badges
 * from rendering or floating behind/through the shield text.
 *
 * @param {boolean} active - True if a queue task is in flight.
 * @param {string} [text=''] - Telemetry string to display.
 */
export function setQueueShieldState(active, text = '') {
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
  } else {
    shield.style.display = 'none';
    shield.style.pointerEvents = 'none';
  }
}

let observerInstance = null;
let rafScheduled = false;

/**
 * Initializes the unified MutationObserver lifecycle engine.
 * Eliminates 50ms polling loops, executing idempotent mounts via requestAnimationFrame.
 *
 * @param {object} options - Lifecycle callbacks.
 * @param {Function} [options.onOpenSettings] - Triggered by the nav row badge.
 */
export function initDOMObserver(options = {}) {
  if (observerInstance) observerInstance.disconnect();

  const runSync = () => {
    rafScheduled = false;
    injectNavBadge(options.onOpenSettings);
    injectAllowanceBar();
    injectQueueShield();
  };

  observerInstance = new MutationObserver((mutations) => {
    let relevant = false;
    for (const m of mutations) {
      if (m.target && m.target.id && m.target.id.startsWith('gw-')) continue;
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
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
    observerInstance.observe(root, { childList: true, subtree: true });
  }

  runSync();
}

/**
 * Disconnects the active MutationObserver.
 */
export function stopDOMObserver() {
  if (observerInstance) {
    observerInstance.disconnect();
    observerInstance = null;
  }
}