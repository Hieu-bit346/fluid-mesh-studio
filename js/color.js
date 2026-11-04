/* ==========================================================================
   color.js — image loading, HSV helpers, palette extraction and Color DNA metrics.
   The original helpers keep their names and behaviour (load, hsv, hsvToRgb, shiftColor, hex,
   colorDist, mulberry32, diverse, calcMetrics). Additions are marked NEW.
   ========================================================================== */

function load(f) {
  return new Promise((res, rej) => {
    const i = new Image(), u = URL.createObjectURL(f);
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
    i.src = u;
  });
}
function hsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360 } return [h, mx ? d / mx : 0, mx] }
function hsvToRgb(h, s, v) { let f = (n, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0); return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)]; }
function shiftColor(rgb, shift) { let [h, s, v] = hsv(...rgb); h = (h + shift) % 360; return hsvToRgb(h, s, v); }
function hex(c) { return '#' + c.map(x => Math.round(x).toString(16).padStart(2, '0')).join('') }
function colorDist(a, b) { const r = a[0] - b[0], g = a[1] - b[1], bl = a[2] - b[2]; return r * r + g * g + bl * bl }
function mulberry32(a) { return function () { let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function diverse(colors, n, rng) {
  if (colors.length <= n) return colors.slice();
  const out = [colors[Math.floor(rng() * colors.length)]];
  while (out.length < n) {
    let best = null, score = -1;
    for (let k = 0; k < 400; k++) {
      const c = colors[Math.floor(rng() * colors.length)];
      let near = Infinity; for (const x of out) near = Math.min(near, colorDist(c, x));
      if (near > score) { score = near; best = c }
    }
    out.push(best);
  }
  return out;
}

/* Colour DNA — formulas unchanged from the original. */
function calcMetrics(colors) {
  let sat = 0, val = 0, warm = 0; const bins = new Set(); const sum = [0, 0, 0];
  for (const c of colors) { const [h, s, v] = hsv(...c); sat += s; val += v; sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; bins.add(Math.floor(h / 15)); if (h < 70 || h >= 300) warm++ }
  const n = colors.length, div = bins.size / 24 * 100, col = (sat / n) * 100, mono = Math.max(0, 100 - (div * .52 + col * .48));
  return { diversity: Math.min(100, div), colorfulness: Math.min(100, col), monochromatic: Math.min(100, mono), brightness: Math.min(100, val / n * 100), warm: Math.min(100, warm / n * 100), dominant: sum.map(x => Math.round(x / n)) };
}

/* ---------- NEW: flat colour pools (avoids one small array per pixel) ---------- */

/**
 * Build the colour pool from raw RGBA samples using the original acceptance rule
 * (alpha >= 40, saturation >= minSat, value >= 0.2). pool = { data: Uint8Array(rgb triples), n }.
 */
function buildPool(samples, minSat) {
  let total = 0; for (const s of samples) total += s.length / 4;
  const data = new Uint8Array(total * 3); let n = 0;
  for (const d of samples) {
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] < 40) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const v = mx / 255, s = mx ? (mx - mn) / mx : 0;
      if (s >= minSat && v >= 0.2) { data[n * 3] = r; data[n * 3 + 1] = g; data[n * 3 + 2] = b; n++; }
    }
  }
  return { data: n === total ? data : data.slice(0, n * 3), n };
}
function poolColor(pool, i) { return [pool.data[i * 3], pool.data[i * 3 + 1], pool.data[i * 3 + 2]]; }
function poolMean(pool) {
  if (!pool.n) return [128, 128, 128];
  let r = 0, g = 0, b = 0; for (let i = 0; i < pool.n; i++) { r += pool.data[i * 3]; g += pool.data[i * 3 + 1]; b += pool.data[i * 3 + 2]; }
  return [Math.round(r / pool.n), Math.round(g / pool.n), Math.round(b / pool.n)];
}
/** Same farthest-point sampling as diverse(), over a flat pool. May return fewer than n if the pool is nearly flat. */
function diversePool(pool, n, rng) {
  if (!pool.n) return [];
  const out = [poolColor(pool, Math.floor(rng() * pool.n))];
  while (out.length < n) {
    let best = null, score = -1;
    for (let k = 0; k < 400; k++) {
      const c = poolColor(pool, Math.floor(rng() * pool.n));
      let near = Infinity; for (const x of out) near = Math.min(near, colorDist(c, x));
      if (near > score) { score = near; best = c }
    }
    if (score <= 0) break;       // only repeats left: let padPalette() interpolate instead
    out.push(best);
  }
  return out;
}
/**
 * Always return exactly n colours. If fewer were found (flat image, tiny crop, preset egg palettes…)
 * the missing ones are interpolated along the existing colours so every layer gets a distinct, valid colour.
 */
function padPalette(colors, n) {
  if (!colors.length) throw new Error('empty palette');
  if (colors.length >= n) return colors.slice(0, n).map(c => c.slice());
  if (colors.length === 1) {
    const [h, s, v] = hsv(...colors[0]);
    return Array.from({ length: n }, (_, i) => hsvToRgb(h, s, Math.min(1, Math.max(0.2, v * (0.82 + 0.36 * (n === 1 ? 0.5 : i / (n - 1)))))));
  }
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1) * (colors.length - 1), a = Math.floor(t), b = Math.min(colors.length - 1, a + 1), f = t - a;
    return colors[a].map((x, k) => Math.round(x + (colors[b][k] - x) * f));
  });
}

/** Colour DNA straight from RGBA pixels (stride keeps it cheap on big samples). */
function metricsFromRGBA(d, stride) {
  stride = stride || 1; const colors = [];
  for (let p = 0; p < d.length; p += 4 * stride) { if (d[p + 3] < 40) continue; colors.push([d[p], d[p + 1], d[p + 2]]); }
  return colors.length ? calcMetrics(colors) : null;
}

/* ---------- Metric descriptions + rendering (UI) ---------- */

const METRIC_DEFS = [
  { key: 'diversity', icon: '🌈', color: '#8d7bff', label: 'm_div', info: 'm_div_info' },
  { key: 'colorfulness', icon: '✨', color: '#ffd24a', label: 'm_col', info: 'm_col_info' },
  { key: 'monochromatic', icon: '🎯', color: '#62d3a2', label: 'm_mon', info: 'm_mon_info' },
  { key: 'warm', icon: '🔥', color: '#ff7a45', label: 'm_war', info: 'm_war_info' },
  { key: 'brightness', icon: '☀️', color: '#e9edf5', label: 'm_bri', info: 'm_bri_info' }
];

/**
 * Metric rows with a number, a bar, a one-line explanation and (optionally) the delta against the source image.
 * Nothing here relies on colour alone: every row carries its label and number.
 */
function renderMetricsText(m, target, sourceM) {
  const el = target || $('metricsText');
  if (!el) return;
  const T = k => (window.t ? window.t(k) : k);
  el.innerHTML = METRIC_DEFS.map(def => {
    const v = m[def.key];
    let delta = '';
    if (sourceM) {
      const d = v - sourceM[def.key];
      const cls = Math.abs(d) < 0.5 ? 'flat' : (d > 0 ? 'up' : 'down');
      delta = `<span class="metric-delta ${cls}" title="${T('m_vs_source')}">${Math.abs(d) < 0.5 ? '±0' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(0)}</span>`;
    }
    return `<div class="metric">
      <div class="metric-head"><span>${def.icon} ${T(def.label)}</span><span class="metric-val" style="color:${def.color}">${v.toFixed(1)}%${delta}</span></div>
      <div class="bar" role="presentation"><i style="width:${v}%;background:${def.color}"></i></div>
      <p class="metric-info note tight">${T(def.info)}</p>
    </div>`;
  }).join('');
}
