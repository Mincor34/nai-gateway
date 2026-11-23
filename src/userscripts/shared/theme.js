/**
 * LIVE NOVELAI THEME SCRAPER, CSS INJECTOR, CLIPBOARD HELPER & HTML ESCAPER (src/userscripts/shared/theme.js)
 *
 * DESIGN PRINCIPLES:
 * 1. Dynamic Runtime Theme Matching: NovelAI styles via compiled styled-components without
 *    global `:root` CSS variables, often keeping base dark-navy fallback CSS on `document.body`,
 *    outer wrappers beneath `linear-gradient(...)` surfaces, hidden desktop layout containers on
 *    mobile breakpoints, or ancestor-hidden `[role="dialog"]` nodes while painting the active theme
 *    onto visible layout containers, `.image-gen-character-prompts` cards, `[data-prompt-input="true"]`
 *    / `.prompt-input-box-prompt` inputs, and effort pills.
 *    Skips hidden (`display: none` / `visibility: hidden` / `opacity: 0`) DOM branches so mobile
 *    layouts never scrape hidden desktop nodes, inspects visible `backgroundImage` gradient stops
 *    BEFORE `backgroundColor` (supporting comma/space `rgb()`/`hsl()`/`#hex` syntax), rejects blurred
 *    elevation drop shadows while accepting `0 0 0 <N>px` border rings, walks bounded visible layout
 *    descendants of `#__next`/`body` plus visible `menuBtn`/`genBtn`/`promptNode` ancestors (outer-to-inner),
 *    guards against stale `#13152c` body fallbacks when visible warm/colored card surfaces exist,
 *    and scopes `--theme-*` and `--gw-*` tokens onto GuildWeave root containers.
 * 2. Preserves `--theme-bg0` / `--theme-bg2` Fallback Wrappers: Emits `var(--theme-bg0, <scraped>)`
 *    so existing Phase 6 and Commit 10 contracts hold while live NovelAI colors win at runtime.
 * 3. Scoped Stylesheet Isolation & Compact Mobile Rules: Injects a single `<style id="gw-ui-styles">`
 *    sheet scoped strictly to `#gw-v5-bar`, `#gw-allowance-bar`, `#vps-settings-modal`, `#vps-admin-panel`,
 *    and `#vps-approval-overlay`, locking switch geometry and providing compact `@media (max-width: 640px)`
 *    + `.gw-v5-compact` rules that keep mobile HUD rows single-line without vertical bloat.
 * 4. Strict XSS Defense & Clipboard Hygiene: Exposes `escapeHtml()`, `copyTextToClipboard()`, and
 *    `attachCopyChipHandlers()` with monotonic `copySeq` timer cancellation for safe untrusted
 *    string rendering and full-ID copying across rapid clicks.
 * 5. Pure Browser Sandbox Compatibility: Guards `window.getComputedStyle`, `document.head`,
 *    `document.querySelectorAll`, `navigator.clipboard`, and `document.execCommand` for minimal VM harnesses.
 */

'use strict';

const DEFAULT_PALETTE = {
  bg0: '#13152c',
  bg1: '#1a1d3a',
  bg2: '#23274c',
  cardBorder: 'rgba(255, 255, 255, 0.14)',
  inputBg: '#13152c',
  inputBorder: 'rgba(255, 255, 255, 0.24)',
  border: 'rgba(255, 255, 255, 0.14)',
  borderStrong: 'rgba(255, 255, 255, 0.24)',
  text: '#f5f3c2',
  textMuted: 'rgba(245, 243, 194, 0.68)',
  accent: '#f5f3c2',
  accentText: '#13152c',
  controlAccent: '#23274c',
  controlAccentText: '#f5f3c2',
  success: '#34c77b',
  warning: '#f0b44c',
  error: '#ef5b5b',
  font: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
};

/**
 * Escapes HTML special characters to neutralize stored XSS inside HTML templates.
 *
 * @param {*} value - Untrusted text value.
 * @returns {string} HTML-escaped string.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Copies text to the system clipboard using `navigator.clipboard.writeText` with a
 * temporary `<textarea>` + `document.execCommand('copy')` fallback for restricted contexts.
 *
 * @param {string} text - Exact string to copy.
 * @returns {Promise<boolean>} True if clipboard write succeeded.
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string' || text.length === 0) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}

  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof document.execCommand === 'function') {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; pointer-events:none;';
      const host = document.body || document.documentElement;
      if (host && typeof host.appendChild === 'function') {
        host.appendChild(ta);
        if (typeof ta.focus === 'function') ta.focus({ preventScroll: true });
        if (typeof ta.select === 'function') ta.select();
        if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length);
        const ok = Boolean(document.execCommand('copy'));
        ta.remove();
        if (ok) return true;
      }
    }
  } catch (_) {}

  return false;
}

/**
 * Binds accessible click and keyboard (Enter / Space) copy handlers to `.gw-copy-chip[data-copy-id]`
 * badges inside a rendered container, preserving original badge labels across rapid clicks via
 * monotonic sequence cancellation.
 *
 * @param {Element|null} rootEl - Container holding rendered `.gw-copy-chip` badges.
 */
export function attachCopyChipHandlers(rootEl) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;

  const chips = rootEl.querySelectorAll('.gw-copy-chip[data-copy-id]');
  for (const chip of chips) {
    const fullId = chip.getAttribute('data-copy-id') || '';
    if (!fullId) continue;

    const originalLabel = chip.textContent || '';
    let resetTimer = null;
    let copySeq = 0;

    const handleCopy = async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

      const seq = ++copySeq;
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }

      const copied = await copyTextToClipboard(fullId);
      if (seq !== copySeq) return;

      chip.textContent = copied ? 'Copied!' : 'Copy failed';

      if (typeof setTimeout === 'function') {
        if (resetTimer) {
          clearTimeout(resetTimer);
          resetTimer = null;
        }
        resetTimer = setTimeout(() => {
          if (seq !== copySeq) return;
          resetTimer = null;
          chip.textContent = originalLabel;
        }, 1500);
      }
    };

    chip.onclick = handleCopy;
    chip.onkeydown = (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) {
        handleCopy(e);
      }
    };
  }
}

function parseAlphaToken(rawAlpha) {
  if (rawAlpha === undefined || rawAlpha === null || rawAlpha === '') return 1;
  const trimmed = String(rawAlpha).trim();
  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
  }
  const num = parseFloat(trimmed);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 1;
}

function hslToRgb(hDeg, sPct, lPct) {
  const h = ((hDeg % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  };
}

/**
 * Parses comma/space `rgb()`, `rgba()`, `hsl()`, `hsla()`, or `#hex` color strings into RGBA channels.
 *
 * @param {string} colorStr - CSS color value.
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
export function parseCssColor(colorStr) {
  if (typeof colorStr !== 'string') return null;
  const trimmed = colorStr.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const rgbComma = trimmed.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.%]+))?\s*\)$/);
  if (rgbComma) {
    return {
      r: Math.round(parseFloat(rgbComma[1])),
      g: Math.round(parseFloat(rgbComma[2])),
      b: Math.round(parseFloat(rgbComma[3])),
      a: parseAlphaToken(rgbComma[4])
    };
  }

  const rgbSpace = trimmed.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.%]+))?\s*\)$/);
  if (rgbSpace) {
    return {
      r: Math.round(parseFloat(rgbSpace[1])),
      g: Math.round(parseFloat(rgbSpace[2])),
      b: Math.round(parseFloat(rgbSpace[3])),
      a: parseAlphaToken(rgbSpace[4])
    };
  }

  const hslMatch = trimmed.match(/^hsla?\(\s*([0-9.]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%(?:\s*[,\/]\s*([0-9.%]+))?\s*\)$/);
  if (hslMatch) {
    const rgb = hslToRgb(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]));
    return {
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      a: parseAlphaToken(hslMatch[4])
    };
  }

  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hexMatch) {
    const h = hexMatch[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }
  return null;
}

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function isOpaque(parsed) {
  return Boolean(parsed && parsed.a > 0.05);
}

function isSolidSurface(parsed, minAlpha = 0.75) {
  return Boolean(parsed && parsed.a >= minAlpha);
}

function isHiddenStyle(st) {
  if (!st) return true;
  return st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0';
}

function isElementVisible(node, safeGetStyle) {
  if (!node) return false;
  const ownStyle = safeGetStyle(node);
  if (isHiddenStyle(ownStyle)) return false;

  let cur = node.parentElement;
  let hops = 0;
  while (cur && hops < 16) {
    const st = safeGetStyle(cur);
    if (st && (st.display === 'none' || st.opacity === '0')) {
      return false;
    }
    if (cur === document.body || cur === document.documentElement) break;
    cur = cur.parentElement;
    hops++;
  }
  return true;
}

function pickVisibleElement(root, selector, safeGetStyle) {
  if (!root) return null;
  if (typeof root.querySelectorAll === 'function') {
    const allMatches = root.querySelectorAll(selector);
    if (allMatches && allMatches.length > 0) {
      for (const el of allMatches) {
        if (el && !isInsideGuildWeave(el) && isElementVisible(el, safeGetStyle)) {
          return el;
        }
      }
      for (const el of allMatches) {
        if (el && !isInsideGuildWeave(el)) {
          return el;
        }
      }
    }
  }
  return typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
}

function relativeLuminance(rgb) {
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function shiftColor(rgb, delta) {
  return `rgb(${clampByte(rgb.r + delta)}, ${clampByte(rgb.g + delta)}, ${clampByte(rgb.b + delta)})`;
}

function withAlpha(rgb, alpha) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function compositeOver(fg, bg) {
  if (!fg) return null;
  if (fg.a >= 0.99 || !bg) {
    return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  }
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: clampByte(bg.r * (1 - a) + fg.r * a),
    g: clampByte(bg.g * (1 - a) + fg.g * a),
    b: clampByte(bg.b * (1 - a) + fg.b * a),
    a: 1
  };
}

function isInsideGuildWeave(node) {
  if (!node) return false;
  if (node.id && (node.id.startsWith('gw-') || node.id.startsWith('vps-'))) return true;
  if (typeof node.closest === 'function') {
    return Boolean(node.closest('[id^="gw-"]') || node.closest('[id^="vps-"]'));
  }
  return false;
}

function nodeContainsAny(container, targets) {
  if (!container || typeof container.contains !== 'function') return false;
  for (const target of targets) {
    if (target && target !== container && container.contains(target)) {
      return true;
    }
  }
  return false;
}

function collectAncestors(el, maxHops = 6, { excludeRoot = false, stopAt = null } = {}) {
  const out = [];
  let cur = el ? el.parentElement : null;
  let steps = 0;
  while (cur && steps < maxHops) {
    if (stopAt && cur === stopAt) break;
    if (cur === document.body || cur === document.documentElement) {
      if (!excludeRoot) out.push(cur);
      break;
    }
    out.push(cur);
    cur = cur.parentElement;
    steps++;
  }
  return out;
}

function collectVisibleDescendants(root, maxDepth, maxNodes, stopDescendSet, safeGetStyle) {
  const result = [];
  if (!root || !root.children) return result;
  const queue = [];
  for (const child of Array.from(root.children)) {
    queue.push({ node: child, depth: 1 });
  }
  let head = 0;
  while (head < queue.length && result.length < maxNodes) {
    const { node, depth } = queue[head++];
    if (!node || stopDescendSet.has(node) || isInsideGuildWeave(node)) continue;
    const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    const modalAttr = typeof node.getAttribute === 'function' ? node.getAttribute('aria-modal') : null;
    if (role === 'dialog' || modalAttr === 'true') continue;
    const st = safeGetStyle(node);
    if (isHiddenStyle(st)) continue;
    result.push(node);
    if (depth < maxDepth && node.children && node.children.length > 0) {
      for (const child of Array.from(node.children)) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return result;
}

function isPureBlackScrim(parsed) {
  return Boolean(parsed && parsed.a < 0.75 && parsed.r < 5 && parsed.g < 5 && parsed.b < 5);
}

function isStaleNavyColor(parsed) {
  return Boolean(parsed && parsed.r <= 28 && parsed.g <= 30 && parsed.b >= 36 && (parsed.b - parsed.r) >= 12);
}

/**
 * Extracts a rendered surface color from `backgroundImage` gradients first (since CSS paints
 * gradients above `backgroundColor`, hiding stale base-theme fallbacks underneath) and then
 * inspects `backgroundColor`. Supports alpha-compositing translucent surfaces over `backdropParsed`
 * when `allowTranslucent` is enabled for explicit card or input anchors, or extracting solid RGB
 * from semi-opaque non-scrim theme layers (`minAlpha`).
 *
 * @param {CSSStyleDeclaration|object|null} st - Computed style declaration.
 * @param {{r: number, g: number, b: number, a: number}|null} [backdropParsed=null] - Backdrop RGB for compositing.
 * @param {object} [options={}] - Extraction behavior options.
 * @param {boolean} [options.allowTranslucent=false] - Whether to composite translucent rgba surfaces.
 * @param {number} [options.minAlpha=0.75] - Minimum alpha to accept a surface directly.
 * @returns {{color: string, parsed: {r: number, g: number, b: number, a: number}}|null}
 */
function extractSurfaceColor(st, backdropParsed = null, { allowTranslucent = false, minAlpha = 0.75 } = {}) {
  if (isHiddenStyle(st)) return null;

  const bgCol = st.backgroundColor;
  const parsedBg = parseCssColor(bgCol);
  const bgImg = st.backgroundImage;

  if (typeof bgImg === 'string' && bgImg !== 'none' && bgImg.includes('gradient')) {
    const stopMatches = bgImg.match(/hsla?\([^)]+\)|rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
    if (stopMatches) {
      let firstTranslucentStop = null;
      for (const stop of stopMatches) {
        const parsedStop = parseCssColor(stop);
        if (isSolidSurface(parsedStop, minAlpha) && (minAlpha >= 0.75 || !isPureBlackScrim(parsedStop))) {
          return {
            color: `rgb(${parsedStop.r}, ${parsedStop.g}, ${parsedStop.b})`,
            parsed: { r: parsedStop.r, g: parsedStop.g, b: parsedStop.b, a: 1 }
          };
        }
        if (!firstTranslucentStop && parsedStop && parsedStop.a >= 0.03) {
          firstTranslucentStop = parsedStop;
        }
      }
      if (firstTranslucentStop) {
        const base = isSolidSurface(parsedBg) ? parsedBg : (allowTranslucent ? backdropParsed : null);
        if (base) {
          const comp = compositeOver(firstTranslucentStop, base);
          return { color: `rgb(${comp.r}, ${comp.g}, ${comp.b})`, parsed: comp };
        }
      }
    }
  }

  if (isSolidSurface(parsedBg, minAlpha) && (minAlpha >= 0.75 || !isPureBlackScrim(parsedBg))) {
    const normalizedColor = parsedBg.a < 0.99
      ? `rgb(${parsedBg.r}, ${parsedBg.g}, ${parsedBg.b})`
      : bgCol;
    return {
      color: normalizedColor,
      parsed: { r: parsedBg.r, g: parsedBg.g, b: parsedBg.b, a: parsedBg.a >= 0.99 ? 1 : parsedBg.a }
    };
  }

  if (allowTranslucent && parsedBg && parsedBg.a >= 0.03 && backdropParsed) {
    const comp = compositeOver(parsedBg, backdropParsed);
    return { color: `rgb(${comp.r}, ${comp.g}, ${comp.b})`, parsed: comp };
  }

  return null;
}

/**
 * Extracts a spread-only `0 0 0 <spread>px` ring border color from `boxShadow`,
 * ignoring blurred/offset elevation drop shadows.
 *
 * @param {string|undefined} boxShadow - Computed CSS `box-shadow` string.
 * @returns {{color: string, parsed: {r: number, g: number, b: number, a: number}}|null}
 */
function extractBoxShadowBorderRing(boxShadow) {
  if (typeof boxShadow !== 'string' || boxShadow === 'none' || !boxShadow.trim()) {
    return null;
  }

  const layers = [];
  let current = '';
  let parenDepth = 0;
  for (let i = 0; i < boxShadow.length; i++) {
    const ch = boxShadow[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (ch === ',' && parenDepth === 0) {
      if (current.trim()) layers.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) layers.push(current.trim());

  for (const layer of layers) {
    const colorMatch = layer.match(/hsla?\([^)]+\)|rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
    if (!colorMatch) continue;
    const colorStr = colorMatch[0];
    const parsed = parseCssColor(colorStr);
    if (!isOpaque(parsed)) continue;

    const remainder = layer.replace(colorStr, '').replace(/\binset\b/gi, '').trim();
    const lengths = remainder.match(/-?\d+(?:\.\d+)?(?:px|rem|em)?/gi);
    if (!lengths || lengths.length < 4) continue;

    const x = parseFloat(lengths[0]);
    const y = parseFloat(lengths[1]);
    const blur = parseFloat(lengths[2]);
    const spread = parseFloat(lengths[3]);

    if (x === 0 && y === 0 && blur === 0 && spread > 0) {
      return { color: colorStr, parsed };
    }
  }

  return null;
}

/**
 * Extracts a visible outline/border color per-side from a computed style object,
 * falling back to `outlineColor` and spread-only `0 0 0 <N>px` `boxShadow` rings
 * when standard borders are absent.
 *
 * @param {CSSStyleDeclaration|object|null} st - Computed style declaration.
 * @returns {{color: string, parsed: {r: number, g: number, b: number, a: number}}|null}
 */
function extractElementBorderColor(st) {
  if (isHiddenStyle(st)) return null;

  const sides = [
    { w: st.borderTopWidth, s: st.borderTopStyle, c: st.borderTopColor },
    { w: st.borderRightWidth, s: st.borderRightStyle, c: st.borderRightColor },
    { w: st.borderBottomWidth, s: st.borderBottomStyle, c: st.borderBottomColor },
    { w: st.borderLeftWidth, s: st.borderLeftStyle, c: st.borderLeftColor }
  ];

  for (const side of sides) {
    const bw = parseFloat(side.w || '1');
    const styleOk = !side.s || side.s !== 'none';
    if ((Number.isNaN(bw) || bw > 0) && styleOk) {
      const parsed = parseCssColor(side.c);
      if (isOpaque(parsed)) {
        return { color: side.c, parsed };
      }
    }
  }

  if (st.borderColor) {
    const bw = parseFloat(st.borderTopWidth || '1');
    const styleOk = !st.borderTopStyle || st.borderTopStyle !== 'none';
    if ((Number.isNaN(bw) || bw > 0) && styleOk) {
      const parsed = parseCssColor(st.borderColor);
      if (isOpaque(parsed)) {
        return { color: st.borderColor, parsed };
      }
    }
  }

  const ow = parseFloat(st.outlineWidth || '0');
  if ((!st.outlineStyle || st.outlineStyle !== 'none') && (Number.isNaN(ow) || ow > 0)) {
    const parsedOut = parseCssColor(st.outlineColor);
    if (isOpaque(parsedOut)) {
      return { color: st.outlineColor, parsed: parsedOut };
    }
  }

  return extractBoxShadowBorderRing(st.boxShadow);
}

/**
 * Scrapes NovelAI's currently active theme directly from computed DOM styles across
 * visible desktop & mobile layout containers, `backgroundImage` gradient stops,
 * `.image-gen-character-prompts` sidebar cards + outlines, `[data-prompt-input="true"]` /
 * `.prompt-input-box-prompt` input surfaces, active effort pills, and the primary Generate button.
 * Falls back cleanly inside headless DOM sandboxes.
 *
 * @returns {{bg0: string, bg1: string, bg2: string, cardBorder: string, inputBg: string, inputBorder: string, border: string, borderStrong: string, text: string, textMuted: string, accent: string, accentText: string, controlAccent: string, controlAccentText: string, success: string, warning: string, error: string, font: string}}
 */
export function scrapeNovelAITheme() {
  const palette = { ...DEFAULT_PALETTE };

  if (
    typeof window === 'undefined' ||
    typeof window.getComputedStyle !== 'function' ||
    typeof document === 'undefined'
  ) {
    return palette;
  }

  try {
    const bodyEl = document.body || document.documentElement;
    if (!bodyEl) return palette;

    const safeGetStyle = (el, pseudoElt) => {
      if (!el) return null;
      try {
        return pseudoElt !== undefined
          ? window.getComputedStyle(el, pseudoElt)
          : window.getComputedStyle(el);
      } catch (_) {
        return null;
      }
    };

    const navRow = pickVisibleElement(document, '.image-gen-nav-row', safeGetStyle);
    const footerEl = pickVisibleElement(document, '.image-gen-footer', safeGetStyle);
    const modelRow = pickVisibleElement(document, '.image-gen-model-mode-row', safeGetStyle);
    const genBtn = pickVisibleElement(document, '.image-gen-generate-button', safeGetStyle);
    const menuBtn = pickVisibleElement(document, 'button[aria-label="menu"]', safeGetStyle);
    const charPromptsEl = pickVisibleElement(document, '.image-gen-character-prompts', safeGetStyle);
    const charPromptsHeader = pickVisibleElement(document, '.image-gen-character-prompts-header', safeGetStyle);
    const promptMainEl = pickVisibleElement(document, '.image-gen-prompt-main', safeGetStyle);
    const promptBoxEl =
      pickVisibleElement(promptMainEl, '[data-prompt-input="true"]', safeGetStyle) ||
      pickVisibleElement(promptMainEl, '.prompt-input-box-prompt', safeGetStyle) ||
      pickVisibleElement(document, '[data-prompt-input="true"]', safeGetStyle) ||
      pickVisibleElement(document, '.prompt-input-box-prompt', safeGetStyle);
    const boxEditorNode =
      pickVisibleElement(promptBoxEl, '[contenteditable="true"], textarea', safeGetStyle);
    const promptNode = boxEditorNode ||
      pickVisibleElement(promptMainEl, '[contenteditable="true"], textarea', safeGetStyle) ||
      pickVisibleElement(document, 'textarea, [contenteditable="true"]', safeGetStyle);

    // 1. Active Theme Workspace Background (`bg0`):
    //    Walk outer-to-inner visible layout ancestors of nav/menu/footer/generate/prompt anchors
    //    plus bounded visible `#__next` / `body` BFS descendants BEFORE `document.body` so stale
    //    base CSS on `body`/`html` or hidden desktop sidebars never force a navy `#13152c` shell.
    const nextRoot = typeof document.getElementById === 'function' ? document.getElementById('__next') : null;
    const stopDescendSet = new Set(
      [genBtn, menuBtn, promptNode, promptBoxEl, promptMainEl, charPromptsEl, charPromptsHeader, footerEl].filter(Boolean)
    );

    const outerToInner = (node, hops = 24) => collectAncestors(node, hops, { excludeRoot: true }).reverse();

    const nonRootBg0Candidates = [
      ...outerToInner(navRow, 24),
      navRow,
      ...outerToInner(menuBtn, 24),
      ...collectVisibleDescendants(nextRoot, 6, 48, stopDescendSet, safeGetStyle),
      ...collectVisibleDescendants(document.body, 4, 32, stopDescendSet, safeGetStyle),
      ...outerToInner(modelRow, 24),
      modelRow,
      ...outerToInner(footerEl, 24),
      footerEl,
      ...outerToInner(genBtn, 24),
      ...outerToInner(promptMainEl, 24),
      ...outerToInner(promptNode, 24)
    ].filter(Boolean);

    const excludedBg0Nodes = new Set(
      [genBtn, menuBtn, promptNode, promptBoxEl, charPromptsEl, charPromptsHeader].filter(Boolean)
    );

    const uniqueNonRootBg0 = [];
    const seenBg0 = new Set();
    for (const node of nonRootBg0Candidates) {
      if (!node || seenBg0.has(node) || excludedBg0Nodes.has(node) || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
      seenBg0.add(node);
      uniqueNonRootBg0.push(node);
    }

    let bg0Parsed = null;
    let usedBodyFallbackForBg0 = false;

    for (const node of uniqueNonRootBg0) {
      const st = safeGetStyle(node);
      const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 });
      if (extracted) {
        palette.bg0 = extracted.color;
        bg0Parsed = extracted.parsed;
        break;
      }
    }

    if (!bg0Parsed) {
      for (const node of uniqueNonRootBg0) {
        const st = safeGetStyle(node);
        const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.45 });
        if (extracted) {
          palette.bg0 = extracted.color;
          bg0Parsed = extracted.parsed;
          break;
        }
      }
    }

    if (!bg0Parsed) {
      for (const pseudoHost of [nextRoot, document.body, document.documentElement].filter(Boolean)) {
        const pSt = safeGetStyle(pseudoHost, '::before');
        if (pSt && pSt.content && pSt.content !== 'none' && pSt.content !== 'normal') {
          const extracted = extractSurfaceColor(pSt, null, { allowTranslucent: false, minAlpha: 0.45 });
          if (extracted) {
            palette.bg0 = extracted.color;
            bg0Parsed = extracted.parsed;
            break;
          }
        }
      }
    }

    if (!bg0Parsed) {
      for (const rootEl of [document.body, document.documentElement].filter(Boolean)) {
        const st = safeGetStyle(rootEl);
        const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 });
        if (extracted) {
          palette.bg0 = extracted.color;
          bg0Parsed = extracted.parsed;
          usedBodyFallbackForBg0 = true;
          break;
        }
      }
    }

    const isDark = !bg0Parsed || relativeLuminance(bg0Parsed) < 0.5;
    const bg0Lum = bg0Parsed ? relativeLuminance(bg0Parsed) : 0.08;
    if (bg0Parsed) {
      palette.bg1 = shiftColor(bg0Parsed, isDark ? 8 : -8);
      palette.bg2 = shiftColor(bg0Parsed, isDark ? 16 : -16);
      palette.controlAccent = palette.bg2;
      palette.inputBg = palette.bg0;
    }

    // 2. Primary Font & Contrasting Text (`text` / `textMuted`)
    const textCandidates = [
      nextRoot,
      navRow,
      ...collectAncestors(navRow, 6, { excludeRoot: true }),
      menuBtn,
      ...collectAncestors(menuBtn, 6, { excludeRoot: true }),
      modelRow,
      footerEl,
      ...collectAncestors(genBtn, 4, { excludeRoot: true }),
      promptNode,
      pickVisibleElement(document, 'span, label, p, button, h1, h2', safeGetStyle),
      document.body,
      document.documentElement
    ];

    let textParsed = null;
    for (const node of textCandidates) {
      if (!node || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
      const st = safeGetStyle(node);
      if (st.fontFamily && st.fontFamily.trim() && palette.font === DEFAULT_PALETTE.font) {
        palette.font = st.fontFamily.trim();
      }
      const col = parseCssColor(st.color);
      if (isOpaque(col) && Math.abs(relativeLuminance(col) - bg0Lum) >= 0.25) {
        palette.text = st.color;
        textParsed = col;
        if (st.fontFamily && st.fontFamily.trim()) {
          palette.font = st.fontFamily.trim();
        }
        break;
      }
    }

    if (textParsed) {
      palette.textMuted = withAlpha(textParsed, 0.68);
      palette.border = withAlpha(textParsed, 0.14);
      palette.borderStrong = withAlpha(textParsed, 0.24);
      palette.cardBorder = palette.border;
      palette.inputBorder = palette.borderStrong;
      palette.accent = palette.text;
      palette.accentText = palette.bg0;
      palette.controlAccentText = palette.text;
    }

    // 3. Elevated Card / Segment Surface (`bg1`) — Prioritizes `.image-gen-character-prompts`
    //    and sibling sidebar segments over generic wrappers so stale base CSS never leaks.
    const charPromptChildren = (charPromptsEl && charPromptsEl.children)
      ? Array.from(charPromptsEl.children)
      : [];
    const charPromptSiblings = (charPromptsEl && charPromptsEl.parentElement && charPromptsEl.parentElement.children)
      ? Array.from(charPromptsEl.parentElement.children).filter(c =>
          c !== charPromptsEl &&
          c !== promptMainEl &&
          c !== promptBoxEl &&
          c !== footerEl &&
          c !== navRow &&
          c !== modelRow &&
          !isInsideGuildWeave(c) &&
          !nodeContainsAny(c, [promptMainEl, footerEl, navRow, modelRow])
        ).slice(0, 6)
      : [];
    const explicitCardNodes = [
      charPromptsEl,
      charPromptsHeader,
      ...charPromptChildren,
      ...charPromptSiblings
    ].filter(Boolean);

    let bg1Parsed = null;
    let foundExplicitCardBg = false;
    let foundNonRootCardBg = false;

    for (const node of explicitCardNodes) {
      if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
      const st = safeGetStyle(node);
      const extracted = extractSurfaceColor(st, bg0Parsed, { allowTranslucent: true });
      if (!extracted) continue;
      const lum = relativeLuminance(extracted.parsed);
      if (isDark ? lum < 0.45 : lum > 0.55) {
        palette.bg1 = extracted.color;
        bg1Parsed = extracted.parsed;
        palette.bg2 = shiftColor(extracted.parsed, isDark ? 10 : -10);
        foundExplicitCardBg = true;
        foundNonRootCardBg = true;
        break;
      }
    }

    if (!foundExplicitCardBg) {
      const dialogNode = pickVisibleElement(document, '[role="dialog"]', safeGetStyle);
      const fallbackCardNodes = [
        dialogNode,
        promptNode,
        ...collectAncestors(promptNode, 3, { excludeRoot: true }),
        ...collectAncestors(genBtn, 3, { excludeRoot: true })
      ].filter(Boolean);

      for (const node of fallbackCardNodes) {
        if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
        const st = safeGetStyle(node);
        const extracted = extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.75 }) ||
          extractSurfaceColor(st, null, { allowTranslucent: false, minAlpha: 0.45 });
        if (!extracted || extracted.color === palette.bg0) continue;
        const lum = relativeLuminance(extracted.parsed);
        if (isDark ? lum < 0.35 : lum > 0.65) {
          palette.bg1 = extracted.color;
          bg1Parsed = extracted.parsed;
          palette.bg2 = shiftColor(extracted.parsed, isDark ? 10 : -10);
          foundNonRootCardBg = true;
          break;
        }
      }
    }

    // If bg0 fell back solely to NovelAI's stale base navy `document.body` (`#13152c`) while
    // visible DOM cards resolved to a distinct non-navy theme (e.g., mobile warm brown drawer),
    // derive bg0 from `bg1Parsed` so modals and bars never render a mismatched navy shell.
    if ((!bg0Parsed || (usedBodyFallbackForBg0 && isStaleNavyColor(bg0Parsed) && !isStaleNavyColor(bg1Parsed))) && foundNonRootCardBg && bg1Parsed) {
      const bg1IsDark = relativeLuminance(bg1Parsed) < 0.5;
      const derivedBg0 = shiftColor(bg1Parsed, bg1IsDark ? -8 : 8);
      palette.bg0 = derivedBg0;
      bg0Parsed = parseCssColor(derivedBg0) || bg1Parsed;
      palette.inputBg = derivedBg0;
      if (textParsed) {
        palette.accentText = derivedBg0;
      }
    }

    // 4. Prompt Input Box Background & Border (`inputBg`, `inputBorder`)
    //    Walks strictly the direct lineage from `promptBoxEl` down to `boxEditorNode`
    //    so sibling button toolbars (`.sc-b7a086c6-0`) are bypassed regardless of child order.
    const promptEditorChain = [];
    if (promptBoxEl) {
      promptEditorChain.push(promptBoxEl);
      if (boxEditorNode) {
        const between = [];
        let cur = boxEditorNode.parentElement;
        let hops = 0;
        while (cur && cur !== promptBoxEl && hops < 8) {
          between.push(cur);
          cur = cur.parentElement;
          hops++;
        }
        for (let i = between.length - 1; i >= 0; i--) {
          promptEditorChain.push(between[i]);
        }
        promptEditorChain.push(boxEditorNode);
      }
    } else if (promptNode) {
      promptEditorChain.push(promptNode);
      const stopNode = promptMainEl ? promptMainEl.parentElement : null;
      const maxPromptHops = promptMainEl ? 4 : 1;
      for (const anc of collectAncestors(promptNode, maxPromptHops, { excludeRoot: true, stopAt: stopNode })) {
        if (anc !== nextRoot && !promptEditorChain.includes(anc) && !nodeContainsAny(anc, [charPromptsEl, footerEl, navRow])) {
          promptEditorChain.push(anc);
        }
      }
    }

    const inputBackdrop = bg0Parsed || bg1Parsed;
    for (const node of promptEditorChain) {
      if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
      const st = safeGetStyle(node);
      const extracted = extractSurfaceColor(st, inputBackdrop, { allowTranslucent: true });
      if (!extracted) continue;
      const lum = relativeLuminance(extracted.parsed);
      if (isDark ? lum < 0.45 : lum > 0.55) {
        palette.inputBg = extracted.color;
        break;
      }
    }

    let foundInputBorder = false;
    for (const node of promptEditorChain) {
      if (!node || node === genBtn || isInsideGuildWeave(node) || !isElementVisible(node, safeGetStyle)) continue;
      const st = safeGetStyle(node);
      const borderInfo = extractElementBorderColor(st);
      if (borderInfo && borderInfo.color !== palette.inputBg && borderInfo.color !== palette.bg0) {
        palette.inputBorder = borderInfo.color;
        foundInputBorder = true;
        break;
      }
    }

    // 5. Native Interactive Control Colors (`bg2`, `cardBorder`, `border`, `borderStrong`, `controlAccent`)
    let foundExplicitBorder = false;
    let foundCardBorder = false;
    let foundExplicitControlAccent = false;

    const modelButtons = modelRow && typeof modelRow.querySelectorAll === 'function'
      ? Array.from(modelRow.querySelectorAll('button'))
      : [];
    if (modelButtons.length >= 2) {
      let medBtn = null;
      let highBtn = null;
      for (const b of modelButtons) {
        const lbl = (b.textContent || '').trim().toLowerCase();
        if (lbl === 'medium') medBtn = b;
        else if (lbl === 'high') highBtn = b;
      }
      if (medBtn && highBtn) {
        const medSt = safeGetStyle(medBtn);
        const highSt = safeGetStyle(highBtn);
        const medBg = medSt ? parseCssColor(medSt.backgroundColor) : null;
        const highBg = highSt ? parseCssColor(highSt.backgroundColor) : null;
        const medAttr = medBtn.getAttribute('aria-pressed') === 'true' || medBtn.getAttribute('aria-selected') === 'true';
        const highAttr = highBtn.getAttribute('aria-pressed') === 'true' || highBtn.getAttribute('aria-selected') === 'true';

        let activeBtn = null;
        let inactiveBtn = null;
        if (medAttr !== highAttr) {
          activeBtn = medAttr ? medBtn : highBtn;
          inactiveBtn = medAttr ? highBtn : medBtn;
        } else if (isOpaque(medBg) && !isOpaque(highBg)) {
          activeBtn = medBtn;
          inactiveBtn = highBtn;
        } else if (isOpaque(highBg) && !isOpaque(medBg)) {
          activeBtn = highBtn;
          inactiveBtn = medBtn;
        } else if (isOpaque(medBg) && isOpaque(highBg) && medSt.backgroundColor !== highSt.backgroundColor) {
          const medLum = relativeLuminance(medBg);
          const highLum = relativeLuminance(highBg);
          const medActive = isDark ? medLum > highLum : medLum < highLum;
          activeBtn = medActive ? medBtn : highBtn;
          inactiveBtn = medActive ? highBtn : medBtn;
        }

        if (activeBtn) {
          const actSt = safeGetStyle(activeBtn);
          const actBg = actSt ? parseCssColor(actSt.backgroundColor) : null;
          if (isOpaque(actBg) && actSt.backgroundColor !== palette.bg0 && actSt.backgroundColor !== palette.bg1) {
            palette.controlAccent = actSt.backgroundColor;
            foundExplicitControlAccent = true;
            const actText = parseCssColor(actSt.color);
            if (isOpaque(actText) && Math.abs(relativeLuminance(actText) - relativeLuminance(actBg)) >= 0.25) {
              palette.controlAccentText = actSt.color;
            } else {
              palette.controlAccentText = relativeLuminance(actBg) > 0.55 ? '#111111' : palette.text;
            }
          }
          if (inactiveBtn) {
            const inactSt = safeGetStyle(inactiveBtn);
            const inactBg = inactSt ? parseCssColor(inactSt.backgroundColor) : null;
            if (isOpaque(inactBg) && inactSt.backgroundColor !== palette.bg0) {
              const lum = relativeLuminance(inactBg);
              if (isDark ? lum < 0.42 : lum > 0.58) {
                palette.bg2 = inactSt.backgroundColor;
              }
            }
          }
        }
      }
    }

    for (const cardNode of explicitCardNodes) {
      if (!cardNode || cardNode === genBtn || isInsideGuildWeave(cardNode) || !isElementVisible(cardNode, safeGetStyle)) continue;
      const st = safeGetStyle(cardNode);
      const borderInfo = extractElementBorderColor(st);
      if (borderInfo && borderInfo.color !== palette.bg0 && borderInfo.color !== palette.bg1) {
        palette.cardBorder = borderInfo.color;
        palette.borderStrong = borderInfo.color;
        palette.border = borderInfo.parsed.a < 0.95 ? borderInfo.color : withAlpha(borderInfo.parsed, 0.72);
        foundCardBorder = true;
        foundExplicitBorder = true;
        break;
      }
    }

    if (!foundExplicitBorder) {
      const borderPool = [
        menuBtn,
        ...(navRow && typeof navRow.querySelectorAll === 'function' ? Array.from(navRow.querySelectorAll('button, div')).slice(0, 12) : []),
        ...modelButtons,
        ...(modelRow && typeof modelRow.querySelectorAll === 'function' ? Array.from(modelRow.querySelectorAll('div, button')).slice(0, 12) : []),
        promptBoxEl,
        promptNode,
        ...collectAncestors(promptNode, 4, { excludeRoot: true }),
        ...collectAncestors(genBtn, 4, { excludeRoot: true }),
        ...(typeof document.querySelectorAll === 'function' ? Array.from(document.querySelectorAll('input, button')).slice(0, 20) : [])
      ].filter(Boolean);

      for (const ctrl of borderPool) {
        if (ctrl === genBtn || isInsideGuildWeave(ctrl) || !isElementVisible(ctrl, safeGetStyle)) continue;
        const st = safeGetStyle(ctrl);
        const borderInfo = extractElementBorderColor(st);
        if (borderInfo && borderInfo.color !== palette.bg0 && borderInfo.color !== palette.bg1) {
          palette.borderStrong = borderInfo.color;
          palette.border = borderInfo.parsed.a < 0.95 ? borderInfo.color : withAlpha(borderInfo.parsed, 0.58);
          if (!foundCardBorder) palette.cardBorder = borderInfo.color;
          foundExplicitBorder = true;
          break;
        }
      }
    }

    const controlBgPool = [
      menuBtn,
      ...modelButtons,
      promptNode,
      ...(typeof document.querySelectorAll === 'function' ? Array.from(document.querySelectorAll('input, button')).slice(0, 20) : [])
    ].filter(Boolean);

    for (const ctrl of controlBgPool) {
      if (ctrl === genBtn || isInsideGuildWeave(ctrl) || !isElementVisible(ctrl, safeGetStyle)) continue;
      const st = safeGetStyle(ctrl);

      const bgParsed = parseCssColor(st.backgroundColor);
      if (isOpaque(bgParsed) && st.backgroundColor !== palette.bg0 && st.backgroundColor !== palette.bg1) {
        const lum = relativeLuminance(bgParsed);
        if (isDark ? lum < 0.45 : lum > 0.55) {
          palette.bg2 = st.backgroundColor;
          if (!foundExplicitControlAccent) {
            palette.controlAccent = st.backgroundColor;
            palette.controlAccentText = relativeLuminance(bgParsed) > 0.55 ? '#111111' : palette.text;
            foundExplicitControlAccent = true;
          }
          break;
        }
      }
    }

    // 6. Primary CTA / Accent (`accent` & `accentText`)
    if (genBtn) {
      const btnStyle = safeGetStyle(genBtn);
      if (btnStyle) {
        const btnBgParsed = parseCssColor(btnStyle.backgroundColor);
        const btnTextParsed = parseCssColor(btnStyle.color);

        const bgHasContrast = isOpaque(btnBgParsed) &&
          btnStyle.backgroundColor !== palette.bg0 &&
          (isDark ? relativeLuminance(btnBgParsed) >= 0.35 : relativeLuminance(btnBgParsed) <= 0.65);

        if (bgHasContrast) {
          palette.accent = btnStyle.backgroundColor;
          if (isOpaque(btnTextParsed)) {
            palette.accentText = btnStyle.color;
          } else {
            palette.accentText = relativeLuminance(btnBgParsed) > 0.55 ? '#111111' : '#ffffff';
          }
        } else if (
          isOpaque(btnTextParsed) &&
          (isDark ? relativeLuminance(btnTextParsed) >= 0.45 : relativeLuminance(btnTextParsed) <= 0.45)
        ) {
          palette.accent = btnStyle.color;
          palette.accentText = isDark ? palette.bg0 : '#ffffff';
        }
      }
    }

    if (!foundExplicitControlAccent) {
      palette.controlAccent = palette.accent;
      palette.controlAccentText = palette.accentText;
    }

    if (!foundExplicitBorder && isOpaque(parseCssColor(palette.bg2))) {
      const parsedBg2 = parseCssColor(palette.bg2);
      palette.borderStrong = shiftColor(parsedBg2, isDark ? 20 : -20);
      palette.border = withAlpha(parsedBg2, 0.65);
      palette.cardBorder = palette.borderStrong;
    }

    if (!foundInputBorder) {
      palette.inputBorder = palette.borderStrong;
    }
  } catch (_) {}

  return palette;
}

/**
 * Injects or refreshes the scoped GuildWeave stylesheet using live NovelAI theme colors.
 * Overrides `--theme-bg*` / `--theme-text*` / `--theme-accent` strictly on GuildWeave root
 * containers to neutralize stale `:root` defaults while preserving fallback CSS variable syntax.
 *
 * @returns {{bg0: string, bg1: string, bg2: string, cardBorder: string, inputBg: string, inputBorder: string, border: string, borderStrong: string, text: string, textMuted: string, accent: string, accentText: string, controlAccent: string, controlAccentText: string, success: string, warning: string, error: string, font: string}}
 */
export function ensureGuildWeaveStyles() {
  const theme = scrapeNovelAITheme();
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return theme;
  }

  let styleEl = document.getElementById('gw-ui-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'gw-ui-styles';
    const host = (typeof document.head !== 'undefined' && document.head)
      ? document.head
      : (document.documentElement || document.body);
    if (host && typeof host.appendChild === 'function') {
      host.appendChild(styleEl);
    }
  }

  const nextCss = `
    #vps-admin-panel, #vps-settings-modal, #vps-approval-overlay, #gw-v5-bar, #gw-allowance-bar {
      --theme-bg0: ${theme.bg0};
      --theme-bg1: ${theme.bg1};
      --theme-bg2: ${theme.borderStrong};
      --theme-text: ${theme.text};
      --theme-textSecondary: ${theme.textMuted};
      --theme-accent: ${theme.accent};
      --gw-bg0: var(--theme-bg0, ${theme.bg0});
      --gw-bg1: var(--theme-bg1, ${theme.bg1});
      --gw-bg2: ${theme.bg2};
      --gw-card-border: ${theme.cardBorder || theme.borderStrong};
      --gw-input-bg: ${theme.inputBg || theme.bg0};
      --gw-input-border: ${theme.inputBorder || theme.borderStrong};
      --gw-border: var(--theme-bg2, ${theme.border});
      --gw-border-strong: ${theme.borderStrong};
      --gw-text: var(--theme-text, ${theme.text});
      --gw-text-muted: var(--theme-textSecondary, ${theme.textMuted});
      --gw-accent: var(--theme-accent, ${theme.accent});
      --gw-accent-text: ${theme.accentText};
      --gw-control-bg: ${theme.controlAccent};
      --gw-control-text: ${theme.controlAccentText};
      --gw-control-border: ${theme.borderStrong};
      --gw-success: var(--theme-success, ${theme.success});
      --gw-warning: var(--theme-warning, ${theme.warning});
      --gw-error: var(--theme-error, ${theme.error});
      font-family: ${theme.font};
      box-sizing: border-box;
    }
    #vps-admin-panel *, #vps-settings-modal *, #vps-approval-overlay *, #gw-v5-bar *, #gw-allowance-bar * {
      box-sizing: border-box;
    }
    @keyframes gwPulse {
      0% { opacity: 0.45; transform: scale(0.92); }
      100% { opacity: 1; transform: scale(1.08); }
    }
    #gw-v5-bar.gw-v5-compact {
      padding: 3px 6px 4px !important;
      gap: 2px !important;
      margin-bottom: 2px !important;
      border-radius: 6px !important;
    }
    #gw-v5-bar.gw-v5-compact .gw-hud-row {
      flex-wrap: nowrap !important;
      gap: 4px !important;
    }
    #gw-v5-bar.gw-v5-compact .gw-hud-right {
      gap: 5px !important;
      flex-shrink: 0 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-track {
      height: 3px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-label,
    #gw-v5-bar.gw-v5-compact #gw-anlas-label,
    #gw-v5-bar.gw-v5-compact #gw-v5-cost,
    #gw-v5-bar.gw-v5-compact #gw-bypass-text {
      font-size: 10px !important;
      line-height: 1.2 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-v5-eta {
      font-size: 9.5px !important;
      line-height: 1.2 !important;
      flex-shrink: 0 !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-bypass-label {
      gap: 4px !important;
      font-size: 10px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-bypass-toggle {
      width: 12px !important;
      min-width: 12px !important;
      max-width: 12px !important;
      height: 12px !important;
      flex: 0 0 12px !important;
    }
    #gw-v5-bar.gw-v5-compact #gw-hud-alert {
      font-size: 10px !important;
      padding: 3px 5px !important;
    }
    @media (max-width: 640px) {
      #gw-v5-bar {
        padding: 3px 6px 4px !important;
        gap: 2px !important;
        margin-bottom: 2px !important;
        border-radius: 6px !important;
      }
      #gw-v5-bar .gw-hud-row {
        flex-wrap: nowrap !important;
        gap: 4px !important;
      }
      #gw-v5-bar .gw-hud-right {
        gap: 5px !important;
        flex-shrink: 0 !important;
      }
      #gw-v5-bar #gw-v5-track {
        height: 3px !important;
      }
      #gw-v5-bar #gw-v5-label,
      #gw-v5-bar #gw-anlas-label,
      #gw-v5-bar #gw-v5-cost,
      #gw-v5-bar #gw-bypass-text {
        font-size: 10px !important;
        line-height: 1.2 !important;
      }
      #gw-v5-bar #gw-v5-eta {
        font-size: 9.5px !important;
        line-height: 1.2 !important;
        flex-shrink: 0 !important;
      }
      #gw-v5-bar #gw-bypass-label {
        gap: 4px !important;
        font-size: 10px !important;
      }
      #gw-v5-bar #gw-bypass-toggle {
        width: 12px !important;
        min-width: 12px !important;
        max-width: 12px !important;
        height: 12px !important;
        flex: 0 0 12px !important;
      }
      #gw-allowance-bar {
        padding: 4px 6px !important;
        gap: 2px !important;
      }
      #vps-settings-modal, #vps-admin-panel {
        padding: 14px !important;
        width: 94vw !important;
        max-height: 88vh !important;
      }
      #vps-settings-modal .gw-modal-header, #vps-admin-panel .gw-modal-header {
        padding-bottom: 8px;
        margin-bottom: 10px;
      }
      #vps-settings-modal .gw-card, #vps-admin-panel .gw-card {
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      #vps-settings-modal .gw-stat-grid, #vps-admin-panel .gw-stat-grid {
        gap: 8px 10px;
      }
      #vps-settings-modal .gw-btn, #vps-admin-panel .gw-btn {
        padding: 7px 9px;
      }
    }
    .gw-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid ${theme.border};
    }
    .gw-modal-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: var(--gw-text);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gw-pill-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--gw-control-bg);
      border: 1px solid var(--gw-control-border);
      color: var(--gw-control-text);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .gw-close-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--gw-text-muted);
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      cursor: pointer;
    }
    .gw-close-btn:hover {
      background: var(--gw-bg2);
      color: var(--gw-text);
    }
    .gw-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 4px;
      border-radius: 8px;
      background: var(--gw-bg1);
      border: 1px solid var(--gw-card-border);
      margin-bottom: 14px;
    }
    .gw-tab-btn {
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      background: transparent;
      color: var(--gw-text-muted);
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .gw-tab-btn.is-active {
      background: var(--gw-control-bg);
      border-color: var(--gw-control-border);
      color: var(--gw-control-text);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    .gw-card {
      background: var(--gw-bg1);
      border: 1px solid var(--gw-card-border);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .gw-section-title {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: var(--gw-text-muted);
      margin-bottom: 8px;
      letter-spacing: 0.2px;
    }
    .gw-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 14px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .gw-stat-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .gw-stat-label {
      font-size: 10px;
      color: var(--gw-text-muted);
    }
    .gw-stat-val {
      font-size: 12px;
      font-weight: 600;
      color: var(--gw-text);
    }
    .gw-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      user-select: none;
    }
    .gw-toggle-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .gw-toggle-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--gw-text);
    }
    .gw-toggle-desc {
      font-size: 11px;
      line-height: 1.4;
      color: var(--gw-text-muted);
    }
    input[type="checkbox"].gw-switch {
      appearance: none;
      -webkit-appearance: none;
      display: inline-block !important;
      width: 36px !important;
      min-width: 36px !important;
      max-width: 36px !important;
      height: 20px !important;
      min-height: 0 !important;
      flex: 0 0 36px !important;
      margin: 0 !important;
      padding: 0 !important;
      box-shadow: none !important;
      border-radius: 999px;
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      position: relative;
      cursor: pointer;
      transition: background 0.18s ease, border-color 0.18s ease;
    }
    input[type="checkbox"].gw-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--gw-text-muted);
      transition: transform 0.18s ease, background 0.18s ease;
    }
    input[type="checkbox"].gw-switch:checked {
      background: var(--gw-accent);
      border-color: var(--gw-accent);
    }
    input[type="checkbox"].gw-switch:checked::after {
      background: var(--gw-accent-text);
      transform: translateX(16px);
    }
    input[type="checkbox"].gw-switch:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    input[type="checkbox"].gw-inline-check {
      display: inline-block !important;
      width: 14px !important;
      min-width: 14px !important;
      max-width: 14px !important;
      height: 14px !important;
      min-height: 0 !important;
      flex: 0 0 14px !important;
      margin: 0 !important;
      box-shadow: none !important;
      accent-color: var(--gw-accent);
      cursor: pointer;
    }
    .gw-input-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .gw-input, .gw-select {
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      color: var(--gw-text);
      padding: 7px 10px;
      font-size: 12px;
      border-radius: 6px;
      outline: none;
    }
    .gw-input {
      flex: 1 1 auto;
      min-width: 0;
    }
    .gw-input:focus, .gw-select:focus {
      border-color: var(--gw-accent);
    }
    .gw-btn {
      border: 1px solid ${theme.borderStrong};
      background: var(--gw-bg2);
      color: var(--gw-text);
      padding: 7px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    .gw-btn:hover {
      opacity: 0.9;
    }
    .gw-btn-primary, .gw-btn-success {
      background: var(--gw-control-bg);
      color: var(--gw-control-text);
      border-color: var(--gw-control-border);
    }
    .gw-btn-accent {
      background: var(--gw-accent);
      color: var(--gw-accent-text);
      border-color: var(--gw-accent);
    }
    .gw-btn-danger {
      background: var(--gw-error);
      color: #ffffff;
      border-color: var(--gw-error);
    }
    .gw-btn-warning {
      background: var(--gw-warning);
      color: #1f1404;
      border-color: var(--gw-warning);
    }
    .gw-btn-sm {
      padding: 4px 8px;
      font-size: 10px;
      border-radius: 4px;
    }
    .gw-feedback {
      font-size: 11px;
      margin-top: 6px;
      line-height: 1.4;
    }
    .gw-code-chip {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--gw-input-bg);
      border: 1px solid var(--gw-input-border);
      color: var(--gw-text);
    }
    .gw-copy-chip {
      cursor: pointer;
      user-select: none;
      transition: border-color 0.15s ease, opacity 0.15s ease;
    }
    .gw-copy-chip:hover, .gw-copy-chip:focus-visible {
      border-color: var(--gw-accent);
      outline: none;
    }
    .gw-details-note {
      font-size: 11px;
      line-height: 1.45;
      color: var(--gw-text-muted);
      margin-top: 6px;
    }
  `.trim();

  if (styleEl.textContent !== nextCss) {
    styleEl.textContent = nextCss;
  }

  return theme;
}