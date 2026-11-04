/* ==========================================================================
   color-math.js — pure colour maths + palette exporters (no DOM access).
   Loaded as a classic <script> (exposes window.ColorMath) and also usable from
   Node (module.exports) so the maths can be unit-tested: node tests/color-math.test.js

   Conventions
   - Colours are plain objects { r, g, b, a } — r/g/b integers 0-255, a in 0-1.
   - Alpha is quantised to one byte so #RRGGBBAA round-trips exactly:
       a = round(a8 / 255), hex alpha byte = round(a * 255).
   - Everything is sRGB (what a <canvas> gives you). No colour management.
   - Contrast: colours with alpha < 1 are first flattened over the other colour
     (the background is treated as opaque).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColorMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const byte = v => clamp(Math.round(v), 0, 255);
  const hex2 = v => byte(v).toString(16).padStart(2, '0').toUpperCase();

  /* ---------- construction / parsing ---------- */

  function make(r, g, b, a) {
    const a8 = a === undefined ? 255 : clamp(Math.round(a * 255), 0, 255);
    return { r: byte(r), g: byte(g), b: byte(b), a: a8 / 255 };
  }
  function fromArray(c, a) { return make(c[0], c[1], c[2], a); }
  function toArray(c) { return [c.r, c.g, c.b]; }
  function alpha8(c) { return clamp(Math.round((c.a === undefined ? 1 : c.a) * 255), 0, 255); }

  const HEX_RE = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  /** Parse HEX (#RGB #RGBA #RRGGBB #RRGGBBAA), rgb()/rgba(), hsl()/hsla(). Returns null if invalid. */
  function parseColor(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s) return null;

    let m = s.match(HEX_RE);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(ch => ch + ch).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a8 = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
      return { r, g, b, a: a8 / 255 };
    }

    m = s.match(/^(rgba?|hsla?)\(\s*([^)]*)\)$/i);
    if (!m) return null;
    const fn = m[1].toLowerCase();
    // accept "r, g, b[, a]" and "r g b[ / a]"
    const parts = m[2].replace('/', ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const num = (str, pctMax) => {
      const isPct = str.endsWith('%');
      const v = parseFloat(isPct ? str.slice(0, -1) : str);
      if (!isFinite(v) || !/^[+-]?(\d+\.?\d*|\.\d+)%?$/.test(str)) return NaN;
      return isPct ? v / 100 * pctMax : v;
    };
    let a = 1;
    if (parts.length === 4) {
      a = num(parts[3], 1);
      if (!isFinite(a)) return null;
      a = clamp(a, 0, 1);
    }
    if (fn.startsWith('rgb')) {
      const r = num(parts[0], 255), g = num(parts[1], 255), b = num(parts[2], 255);
      if (![r, g, b].every(isFinite)) return null;
      if ([r, g, b].some(v => v < 0 || v > 255)) return null; // reject instead of silently clamping typos
      return make(r, g, b, a);
    }
    const h = parseFloat(parts[0].replace(/deg$/i, ''));
    const sat = num(parts[1], 100), lig = num(parts[2], 100);
    if (!isFinite(h) || !isFinite(sat) || !isFinite(lig)) return null;
    if (sat < 0 || sat > 100 || lig < 0 || lig > 100) return null;
    const rgb = hslToRgb(h, sat, lig);
    return make(rgb[0], rgb[1], rgb[2], a);
  }

  /* ---------- model conversions (return floats; callers round for display) ---------- */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: s * 100, l: l * 100 };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx === 0 ? 0 : d / mx * 100, v: mx * 100 };
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; v = clamp(v, 0, 100) / 100;
    const c = v * s, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  /* ---------- formatting ---------- */

  function fmtAlpha(c) {
    const v = Math.round(alpha8(c) / 255 * 100) / 100;
    return String(v);
  }
  /** '#RRGGBB' (uppercase) or '#RRGGBBAA' when withAlpha is true (alpha byte always written) */
  function fmtHex(c, withAlpha) {
    return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (withAlpha ? hex2(alpha8(c)) : '');
  }
  function fmtRgb(c) { return `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`; }
  function fmtRgba(c) { return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${fmtAlpha(c)})`; }
  function fmtHsl(c) {
    const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
    return `hsl(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%)`;
  }
  function fmtHsla(c) {
    const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
    return `hsla(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%, ${fmtAlpha(c)})`;
  }
  function fmtHsv(c) {
    const { h, s, v } = rgbToHsv(c.r, c.g, c.b);
    return `hsv(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(v)}%)`;
  }
  /** Everything the inspector shows, as label → string (same order as the UI). */
  function allFormats(c) {
    return {
      hex: fmtHex(c, false),
      hexa: fmtHex(c, true),
      rgb: fmtRgb(c),
      rgba: fmtRgba(c),
      hsl: fmtHsl(c),
      hsla: fmtHsla(c),
      hsv: fmtHsv(c)
    };
  }

  /* ---------- luminance / contrast (WCAG 2.x) ---------- */

  function channelToLinear(v) {
    v /= 255;
    // IEC 61966-2-1 threshold (0.04045); WCAG's 0.03928 differs by < 1e-5 in the result.
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function relativeLuminance(c) {
    return 0.2126 * channelToLinear(c.r) + 0.7152 * channelToLinear(c.g) + 0.0722 * channelToLinear(c.b);
  }
  /** Flatten fg (with alpha) over an opaque bg. */
  function compositeOver(fg, bg) {
    const a = fg.a === undefined ? 1 : fg.a;
    return make(fg.r * a + bg.r * (1 - a), fg.g * a + bg.g * (1 - a), fg.b * a + bg.b * (1 - a), 1);
  }
  function contrastRatio(fg, bg) {
    const f = (fg.a !== undefined && fg.a < 1) ? compositeOver(fg, bg) : fg;
    const l1 = relativeLuminance(f), l2 = relativeLuminance(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  /** Truncate (never round up) so "4.50" is only shown when 4.5 is really reached. */
  function fmtRatio(r) { return (Math.floor(r * 100) / 100).toFixed(2); }
  function wcagLevels(ratio) {
    return {
      aaNormal: ratio >= 4.5,
      aaLarge: ratio >= 3,
      aaaNormal: ratio >= 7,
      aaaLarge: ratio >= 4.5,
      ui: ratio >= 3 // WCAG 1.4.11 non-text contrast
    };
  }
  const BLACK = make(0, 0, 0), WHITE = make(255, 255, 255);
  /** Whichever of black / white reads better on bg. */
  function bestTextColor(bg) {
    const flat = (bg.a !== undefined && bg.a < 1) ? compositeOver(bg, WHITE) : bg;
    const cb = contrastRatio(BLACK, flat), cw = contrastRatio(WHITE, flat);
    return cb >= cw ? { color: BLACK, ratio: cb } : { color: WHITE, ratio: cw };
  }

  /* ---------- palette helpers ---------- */

  /**
   * Objective roles only (no guessing at "primary"): darkest and lightest by relative luminance,
   * vivid by HSV chroma (s*v). Returns an array (same order as palette) of role-key arrays.
   */
  function paletteRoles(palette) {
    const roles = palette.map(() => []);
    if (!palette.length) return roles;
    const lum = palette.map(c => relativeLuminance(fromArray(c)));
    const vivid = palette.map(c => { const o = rgbToHsv(c[0], c[1], c[2]); return o.s * o.v / 100; });
    let dk = 0, lt = 0, vv = 0;
    for (let i = 1; i < palette.length; i++) {
      if (lum[i] < lum[dk]) dk = i;
      if (lum[i] > lum[lt]) lt = i;
      if (vivid[i] > vivid[vv]) vv = i;
    }
    if (palette.length > 1) { roles[dk].push('darkest'); if (lt !== dk) roles[lt].push('lightest'); }
    if (vivid[vv] >= 20) roles[vv].push('vivid');
    return roles;
  }

  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* ---------- harmony ---------- */

  const SCHEMES = {
    complementary: [0, 180],
    analogous: [-30, 0, 30],
    triadic: [0, 120, 240],
    split: [0, 150, 210],
    monochromatic: [0]
  };
  function mulberry32(a) {
    return function () {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function lerpHue(a, b, t) {
    let d = ((b - a + 540) % 360) - 180; // shortest signed distance
    return (a + d * t + 360) % 360;
  }

  /**
   * A fresh swatch set built around base ([r,g,b]) — what the Harmony Lab shows.
   * `variation` 0-100 spreads lightness/saturation (and nudges hue slightly).
   */
  function harmonySwatches(base, scheme, count, variation, seed) {
    const offs = SCHEMES[scheme] || SCHEMES.complementary;
    const rng = mulberry32((seed | 0) + 17);
    const hs = rgbToHsl(base[0], base[1], base[2]);
    const v = clamp(variation, 0, 100) / 100;
    const out = [];
    const rounds = Math.ceil(count / offs.length);
    for (let k = 0; k < count; k++) {
      const off = offs[k % offs.length], round = Math.floor(k / offs.length);
      let h = hs.h + off, s = hs.s, l = hs.l;
      if (scheme === 'monochromatic') {
        const t = count === 1 ? 0.5 : k / (count - 1);
        l = clamp(hs.l + (t - 0.5) * (30 + 60 * v), 8, 94);
        s = clamp(hs.s * (1 - 0.35 * v * Math.abs(t - 0.5) * 2), 0, 100);
      } else {
        const centred = rounds === 1 ? 0 : (round / (rounds - 1) - 0.5);
        l = clamp(hs.l + centred * (20 + 50 * v) + (rng() - 0.5) * 12 * v, 8, 94);
        s = clamp(hs.s + (rng() - 0.5) * 30 * v, 0, 100);
        h += (rng() - 0.5) * 24 * v;
      }
      out.push(hslToRgb(h, s, l).map(byte));
    }
    return out;
  }

  /**
   * Tone-preserving recolour: every palette colour keeps its own lightness and (mostly) saturation but
   * takes a hue from the scheme (colours grouped by hue rank so related colours stay related).
   * strength 0-100 blends from the original (0) to fully harmonised (100). Never mutates input.
   */
  function harmonize(palette, opts) {
    const scheme = SCHEMES[opts.scheme] ? opts.scheme : 'complementary';
    const offs = SCHEMES[scheme];
    const t = clamp(opts.strength === undefined ? 100 : opts.strength, 0, 100) / 100;
    const v = clamp(opts.variation === undefined ? 30 : opts.variation, 0, 100) / 100;
    const rng = mulberry32((opts.seed | 0) + 101);
    const n = palette.length;
    if (!n || t === 0) return palette.map(c => c.slice());
    const baseHue = opts.baseHue === undefined ? rgbToHsl(palette[0][0], palette[0][1], palette[0][2]).h : opts.baseHue;
    const hsl = palette.map(c => rgbToHsl(c[0], c[1], c[2]));
    const order = hsl.map((_, i) => i).sort((a, b) => hsl[a].h - hsl[b].h);
    const rank = new Array(n);
    order.forEach((idx, r) => { rank[idx] = r; });
    return palette.map((c, i) => {
      const group = Math.min(offs.length - 1, Math.floor(rank[i] * offs.length / n));
      const targetH = baseHue + offs[group] + (rng() - 0.5) * 24 * v;
      const targetS = clamp(hsl[i].s + (rng() - 0.5) * 24 * v, 0, 100);
      const h = lerpHue(hsl[i].h, targetH, t);
      const s = hsl[i].s + (targetS - hsl[i].s) * t;
      return hslToRgb(h, s, hsl[i].l).map(byte);
    });
  }

  /* ---------- exporters ---------- */

  function cleanName(s) { return String(s).replace(/[\r\n]+/g, ' ').trim(); }
  function cssName(s) { return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'color'; }

  /**
   * items: [{ r,g,b,a?, name?, roles? }]. naming 'roles' uses background/darkest/lightest/vivid where known.
   * Returns [{ item, name }] with unique names.
   */
  function nameItems(items, naming) {
    const used = new Set();
    return items.map((it, i) => {
      let base = it.name ? cssName(it.name) : null;
      if (!base && naming === 'roles' && it.roles && it.roles.length) base = it.roles.map(cssName).join('-');
      if (!base) base = 'color-' + (i + 1);
      let nm = base, k = 2;
      while (used.has(nm)) nm = base + '-' + (k++);
      used.add(nm);
      return { item: it, name: nm };
    });
  }

  function exportCSS(items, opts) {
    opts = opts || {};
    const prefix = opts.prefix === undefined ? '--' : opts.prefix;
    const lines = nameItems(items, opts.naming).map(({ item, name }) =>
      `  ${prefix}${name.startsWith('color-') ? name : 'color-' + name}: ${fmtHex(item, alpha8(item) < 255)};`);
    return ':root {\n' + lines.join('\n') + '\n}';
  }
  /** GIMP palette (.gpl). Alpha is not part of the format and is dropped. */
  function exportGPL(items, opts) {
    opts = opts || {};
    let out = 'GIMP Palette\nName: ' + cleanName(opts.name || 'Fluid Mesh Palette') + '\nColumns: 4\n#\n';
    items.forEach((it, i) => {
      const label = it.name ? cleanName(it.name) : fmtHex(it, false);
      out += `${String(byte(it.r)).padStart(3)} ${String(byte(it.g)).padStart(3)} ${String(byte(it.b)).padStart(3)} ${label}\n`;
    });
    return out;
  }
  function exportJSON(items, opts) {
    opts = opts || {};
    const named = nameItems(items, opts.naming);
    const data = {
      name: opts.name || 'Fluid Mesh Palette',
      generator: 'Fluid Mesh Studio HD',
      colorSpace: 'sRGB',
      colors: named.map(({ item, name }) => {
        const hsl = rgbToHsl(item.r, item.g, item.b), hsv = rgbToHsv(item.r, item.g, item.b);
        const o = {
          name,
          hex: fmtHex(item, false),
          rgb: { r: byte(item.r), g: byte(item.g), b: byte(item.b) },
          hsl: { h: Math.round(hsl.h) % 360, s: Math.round(hsl.s), l: Math.round(hsl.l) },
          hsv: { h: Math.round(hsv.h) % 360, s: Math.round(hsv.s), v: Math.round(hsv.v) },
          alpha: +(alpha8(item) / 255).toFixed(2)
        };
        if (alpha8(item) < 255) o.hexa = fmtHex(item, true);
        if (item.roles && item.roles.length) o.roles = item.roles.slice();
        return o;
      })
    };
    return JSON.stringify(data, null, 2);
  }
  /** format: 'hex' | 'rgb' | 'hsl' — one colour per line */
  function exportTXT(items, opts) {
    const f = (opts && opts.format) || 'hex';
    return items.map(it => f === 'rgb' ? (alpha8(it) < 255 ? fmtRgba(it) : fmtRgb(it))
      : f === 'hsl' ? (alpha8(it) < 255 ? fmtHsla(it) : fmtHsl(it))
      : fmtHex(it, alpha8(it) < 255)).join('\n') + '\n';
  }

  return {
    clamp, byte, make, fromArray, toArray, alpha8,
    parseColor, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb,
    fmtHex, fmtRgb, fmtRgba, fmtHsl, fmtHsla, fmtHsv, fmtAlpha, allFormats,
    relativeLuminance, compositeOver, contrastRatio, fmtRatio, wcagLevels, bestTextColor,
    paletteRoles, mix, SCHEMES, harmonySwatches, harmonize, lerpHue,
    exportCSS, exportGPL, exportJSON, exportTXT, nameItems, mulberry32
  };
});
