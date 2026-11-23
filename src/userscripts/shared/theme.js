/**
 * LIVE NOVELAI THEME SCRAPER, CSS INJECTOR & HTML ESCAPER (src/userscripts/shared/theme.js)
 *
 * DESIGN PRINCIPLES:
 * 1. Dynamic Runtime Theme Matching: NovelAI styles via compiled styled-components without
 *    global `:root` CSS variables, often keeping base dark-navy fallback CSS on `document.body`
 *    or `linear-gradient(...)` backgrounds on `#__next` / layout containers while painting the
 *    active theme onto inner `.image-gen-*` ancestor wrappers, `textarea` cards, `div` borders,
 *    and effort pills. Walks inner-to-outer layout containers BEFORE `document.body`, validates
 *    solid surface alpha (`>= 0.75`), parses `backgroundImage` gradient stops, derives `bg0` from
 *    `bg1` if no canvas backdrop is exposed, and scopes `--theme-bg*` / `--theme-text*` / `--theme-accent`
 *    directly onto GuildWeave's own root containers so stale `:root` variables cannot leak in.
 * 2. Preserves `--theme-bg0` / `--theme-bg2` Fallback Wrappers: Emits `var(--theme-bg0, <scraped>)`
 *    so existing Phase 6 and Commit 10 contracts hold while live NovelAI colors win at runtime.
 * 3. Scoped Stylesheet Isolation: Injects a single `<style id="gw-ui-styles">` sheet scoped
 *    strictly to `#gw-v5-bar`, `#gw-allowance-bar`, `#vps-settings-modal`, `#vps-admin-panel`,
 *    and `#vps-approval-overlay`, locking checkbox geometry against NovelAI global `input`
 *    rules and only mutating `styleEl.textContent` when computed CSS actually changes.
 * 4. Strict XSS Defense: Exposes `escapeHtml()` for all dynamic user/Discord strings.
 * 5. Pure Browser Sandbox Compatibility: Guards `window.getComputedStyle` and `document.head`
 *    for minimal VM harnesses lacking full CSS engines.
 */

'use strict';

const DEFAULT_PALETTE = {
  bg0: '#13152c',
  bg1: '#1a1d3a',
  bg2: '#23274c',
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
 * Parses an `rgb()`, `rgba()`, or `#hex` color string into numeric RGBA channels.
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
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
      a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1
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

function isSolidSurface(parsed) {
  return Boolean(parsed && parsed.a >= 0.75);
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

function isInsideGuildWeave(node) {
  if (!node) return false;
  if (node.id && (node.id.startsWith('gw-') || node.id.startsWith('vps-'))) return true;
  if (typeof node.closest === 'function') {
    return Boolean(node.closest('[id^="gw-"]') || node.closest('[id^="vps-"]'));
  }
  return false;
}

function collectAncestors(el, maxHops = 6, { excludeRoot = false } = {}) {
  const out = [];
  let cur = el ? el.parentElement : null;
  let steps = 0;
  while (cur && steps < maxHops) {
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

/**
 * Extracts a solid background color from `style.backgroundColor`, or falls back to
 * the first solid gradient color stop in `style.backgroundImage` when NovelAI paints
 * theme backgrounds via CSS gradients.
 *
 * @param {CSSStyleDeclaration|object|null} st - Computed style declaration.
 * @returns {{color: string, parsed: {r: number, g: number, b: number, a: number}}|null}
 */
function extractSolidBackground(st) {
  if (!st) return null;

  const bgCol = st.backgroundColor;
  const parsedBg = parseCssColor(bgCol);
  if (isSolidSurface(parsedBg)) {
    return { color: bgCol, parsed: parsedBg };
  }

  const bgImg = st.backgroundImage;
  if (typeof bgImg === 'string' && bgImg !== 'none' && bgImg.includes('gradient')) {
    const stopMatches = bgImg.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
    if (stopMatches) {
      for (const stop of stopMatches) {
        const parsedStop = parseCssColor(stop);
        if (isSolidSurface(parsedStop)) {
          return { color: `rgb(${parsedStop.r}, ${parsedStop.g}, ${parsedStop.b})`, parsed: parsedStop };
        }
      }
    }
  }

  return null;
}

/**
 * Scrapes NovelAI's currently active theme directly from computed DOM styles across
 * inner layout ancestors, `backgroundImage` gradient stops, panel containers, borders
 * (`borderTopColor`), active effort pills, and the primary Generate button.
 * Falls back cleanly inside headless DOM sandboxes.
 *
 * @returns {{bg0: string, bg1: string, bg2: string, border: string, borderStrong: string, text: string, textMuted: string, accent: string, accentText: string, controlAccent: string, controlAccentText: string, success: string, warning: string, error: string, font: string}}
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

    const safeGetStyle = (el) => {
      if (!el) return null;
      try { return window.getComputedStyle(el); } catch (_) { return null; }
    };

    const navRow = typeof document.querySelector === 'function' ? document.querySelector('.image-gen-nav-row') : null;
    const footerEl = typeof document.querySelector === 'function' ? document.querySelector('.image-gen-footer') : null;
    const modelRow = typeof document.querySelector === 'function' ? document.querySelector('.image-gen-model-mode-row') : null;
    const genBtn = typeof document.querySelector === 'function' ? document.querySelector('.image-gen-generate-button') : null;
    const menuBtn = typeof document.querySelector === 'function' ? document.querySelector('button[aria-label="menu"]') : null;
    const promptNode = typeof document.querySelector === 'function'
      ? (document.querySelector('textarea') || document.querySelector('[contenteditable="true"]'))
      : null;

    // 1. Active Theme Workspace Background (`bg0`):
    //    Walk inner-to-outer layout containers around semantic anchors BEFORE document.body so
    //    stale base CSS on `body`/`html` never masks the active styled-components theme wrapper.
    const nextRoot = typeof document.getElementById === 'function' ? document.getElementById('__next') : null;
    const topDownWrappers = [];
    const pushChain = (startNode, depth = 4) => {
      let cur = startNode;
      for (let i = 0; cur && i < depth; i++) {
        topDownWrappers.push(cur);
        cur = cur.firstElementChild;
      }
    };
    pushChain(nextRoot, 4);
    pushChain(bodyEl.firstElementChild, 4);

    const bg0Candidates = [
      ...collectAncestors(navRow, 24, { excludeRoot: true }),
      ...collectAncestors(modelRow, 24, { excludeRoot: true }),
      ...collectAncestors(footerEl, 24, { excludeRoot: true }),
      navRow,
      modelRow,
      footerEl,
      ...topDownWrappers,
      document.body,
      document.documentElement
    ];

    const seenBg0 = new Set();
    let bg0Parsed = null;
    for (const node of bg0Candidates) {
      if (!node || seenBg0.has(node) || node === genBtn || node === promptNode || isInsideGuildWeave(node)) continue;
      seenBg0.add(node);
      const st = safeGetStyle(node);
      const extracted = extractSolidBackground(st);
      if (extracted) {
        palette.bg0 = extracted.color;
        bg0Parsed = extracted.parsed;
        break;
      }
    }

    const isDark = !bg0Parsed || relativeLuminance(bg0Parsed) < 0.5;
    const bg0Lum = bg0Parsed ? relativeLuminance(bg0Parsed) : 0.08;
    if (bg0Parsed) {
      palette.bg1 = shiftColor(bg0Parsed, isDark ? 8 : -8);
      palette.bg2 = shiftColor(bg0Parsed, isDark ? 16 : -16);
      palette.controlAccent = palette.bg2;
    }

    // 2. Primary Font & Contrasting Text (`text` / `textMuted`)
    const textCandidates = [
      nextRoot,
      navRow,
      ...collectAncestors(navRow, 6, { excludeRoot: true }),
      modelRow,
      footerEl,
      promptNode,
      typeof document.querySelector === 'function' ? document.querySelector('span, label, p, button, h1, h2') : null,
      document.body,
      document.documentElement
    ];

    let textParsed = null;
    for (const node of textCandidates) {
      if (!node || isInsideGuildWeave(node)) continue;
      const st = safeGetStyle(node);
      if (!st) continue;
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
      palette.accent = palette.text;
      palette.accentText = palette.bg0;
      palette.controlAccentText = palette.text;
    }

    // 3. Elevated Card / Modal Surface (`bg1`)
    const dialogNode = typeof document.querySelector === 'function' ? document.querySelector('[role="dialog"]') : null;
    const footerChildren = footerEl && footerEl.children ? Array.from(footerEl.children) : [];
    const surfaceNodes = [
      dialogNode,
      promptNode,
      ...collectAncestors(promptNode, 4, { excludeRoot: true }),
      navRow,
      footerEl,
      modelRow,
      ...collectAncestors(modelRow, 3, { excludeRoot: true }),
      ...footerChildren
    ];

    let bg1Parsed = null;
    for (const node of surfaceNodes) {
      if (!node || node === genBtn || isInsideGuildWeave(node)) continue;
      const st = safeGetStyle(node);
      const extracted = extractSolidBackground(st);
      if (!extracted || extracted.color === palette.bg0) continue;
      const lum = relativeLuminance(extracted.parsed);
      if (isDark ? lum < 0.35 : lum > 0.65) {
        palette.bg1 = extracted.color;
        bg1Parsed = extracted.parsed;
        palette.bg2 = shiftColor(extracted.parsed, isDark ? 10 : -10);
        break;
      }
    }

    // If no opaque workspace background was detectable anywhere, derive bg0 from bg1 instead of dark navy fallback
    if (!bg0Parsed && bg1Parsed) {
      const bg1IsDark = relativeLuminance(bg1Parsed) < 0.5;
      palette.bg0 = shiftColor(bg1Parsed, bg1IsDark ? 10 : -10);
    }

    // 4. Native Interactive Control Colors (`bg2`, `border`, `borderStrong`, `controlAccent`)
    let foundExplicitBorder = false;
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

    const borderPool = [
      menuBtn,
      ...(navRow && typeof navRow.querySelectorAll === 'function' ? Array.from(navRow.querySelectorAll('button, div')).slice(0, 12) : []),
      ...modelButtons,
      ...(modelRow && typeof modelRow.querySelectorAll === 'function' ? Array.from(modelRow.querySelectorAll('div, button')).slice(0, 12) : []),
      promptNode,
      ...collectAncestors(promptNode, 3, { excludeRoot: true }),
      ...(typeof document.querySelectorAll === 'function' ? Array.from(document.querySelectorAll('input, button')).slice(0, 20) : [])
    ].filter(Boolean);

    for (const ctrl of borderPool) {
      if (ctrl === genBtn || isInsideGuildWeave(ctrl)) continue;
      const st = safeGetStyle(ctrl);
      if (!st) continue;

      const bw = parseFloat(st.borderTopWidth || '1');
      const borderStyleOk = !st.borderTopStyle || st.borderTopStyle !== 'none';
      const borderRaw = st.borderTopColor || st.borderColor;
      const borderParsed = parseCssColor(borderRaw);
      if (
        (Number.isNaN(bw) || bw > 0) &&
        borderStyleOk &&
        isOpaque(borderParsed) &&
        borderRaw !== palette.bg0 &&
        borderRaw !== palette.bg1
      ) {
        palette.borderStrong = borderRaw;
        palette.border = withAlpha(borderParsed, 0.58);
        foundExplicitBorder = true;
        break;
      }
    }

    const controlBgPool = [
      menuBtn,
      ...modelButtons,
      promptNode,
      ...(typeof document.querySelectorAll === 'function' ? Array.from(document.querySelectorAll('input, button')).slice(0, 20) : [])
    ].filter(Boolean);

    for (const ctrl of controlBgPool) {
      if (ctrl === genBtn || isInsideGuildWeave(ctrl)) continue;
      const st = safeGetStyle(ctrl);
      if (!st) continue;

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

    // 5. Primary CTA / Accent (`accent` & `accentText`)
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
    }
  } catch (_) {}

  return palette;
}

/**
 * Injects or refreshes the scoped GuildWeave stylesheet using live NovelAI theme colors.
 * Overrides `--theme-bg*` / `--theme-text*` / `--theme-accent` strictly on GuildWeave root
 * containers to neutralize stale `:root` defaults while preserving fallback CSS variable syntax.
 *
 * @returns {{bg0: string, bg1: string, bg2: string, border: string, borderStrong: string, text: string, textMuted: string, accent: string, accentText: string, controlAccent: string, controlAccentText: string, success: string, warning: string, error: string, font: string}}
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
      border: 1px solid ${theme.border};
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
      border: 1px solid ${theme.border};
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
      background: var(--gw-bg0);
      border: 1px solid ${theme.borderStrong};
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
      background: var(--gw-bg0);
      border: 1px solid ${theme.borderStrong};
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
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--gw-bg0);
      border: 1px solid ${theme.border};
      color: var(--gw-text);
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