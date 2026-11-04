/* ==========================================================================
   engine.js — the composition model.
   A "composition" (comp) is a small, serialisable description of one artwork: render style, seeds,
   palette, parameters and output size. Everything visual is *derived* from it, deterministically:
       comp  ->  buildParams(comp)  ->  renderCanvas(params, canvas, w, h)
   Same comp in = same picture out (at any resolution — geometry is stored in diagonal-relative units).
   Depends on: color.js (hsv helpers, mulberry32), color-math.js.
   ========================================================================== */
(function () {
  'use strict';

  const CM = window.ColorMath;
  const STYLES = ['fluid', 'paper', 'aurora', 'polygon', 'crystal', 'chroma'];

  /** Maximum layer / band count per style (Aurora capped at 35 so overlapping bands stay crisp). */
  const STYLE_MAX_COUNT = {
    fluid: 100,
    paper: 60,
    aurora: 35,
    polygon: 80,
    crystal: 100,
    chroma: 45
  };

  /** Which inspector controls make sense for each render style (nothing is forced onto every style). */
  const STYLE_CONTROLS = {
    fluid:   ['count', 'soft', 'turb', 'intensity', 'angle', 'bg', 'grain'],
    paper:   ['paperMode', 'count', 'soft', 'turb', 'paperAngle', 'angle', 'bg', 'grain'],
    aurora:  ['auroraMode', 'count', 'soft', 'turb', 'intensity', 'angle', 'bg', 'grain'],
    polygon: ['polyMode', 'count', 'soft', 'turb', 'edge', 'angle', 'bg', 'grain'],
    crystal: ['crystalMode', 'count', 'soft', 'jitter', 'facet', 'angle', 'bg', 'grain'],
    chroma:  ['chromaMode', 'count', 'soft', 'turb', 'intensity', 'edge', 'angle', 'bg', 'grain']
  };

  const COMP_DEFAULTS = {
    v: 2,
    style: 'fluid',
    seed: 1, pseed: 1,
    count: 10, minSat: 10,
    angleMode: 'random', angleDeg: 0,
    ratio: '1', ratioW: 16, ratioH: 9,
    size: '1024', customSize: 2048,
    soft: 20, grain: 0, turb: 100,
    intensity: 100, edge: 100, jitter: 100, facet: 100,
    paperMode: 'waves', polyMode: 'flat', paperAngle: 45, crystalMode: 'harmonic', auroraMode: 'prism', chromaMode: 'mercury',
    bgMode: 'auto', bgColor: '#101820',
    hue: 0, satAdj: 0, valAdj: 0,
    palSrc: 'custom',
    basePalette: [[0, 191, 255], [30, 144, 255], [64, 224, 208], [138, 99, 255], [255, 120, 190], [255, 190, 90], [0, 128, 255], [120, 230, 255], [90, 70, 200], [255, 90, 120]],
    bgBase: [24, 40, 70],
    harmony: { on: false, scheme: 'complementary', baseHue: null, strength: 70, variation: 30 },
    legacy: null
  };

  const RANGES = {
    count: [3, 100], minSat: [0, 80], soft: [0, 100], grain: [0, 25], turb: [0, 200],
    intensity: [10, 200], edge: [0, 200], jitter: [0, 150], facet: [0, 250],
    paperAngle: [0, 360], hue: [0, 360], satAdj: [-100, 100], valAdj: [-100, 100],
    customSize: [500, 4096], angleDeg: [-360, 360], ratioW: [1, 100], ratioH: [1, 100],
    seed: [0, 2147483000], pseed: [0, 2147483000]
  };
  const ENUMS = {
    style: STYLES,
    angleMode: ['random', '0', '45', '90', 'custom'],
    ratio: ['1', '1.7777', '0.5625', '0.8', '1.5', 'custom'],
    size: ['1024', '1920', '2560', '3840', 'custom'],
    paperMode: ['waves', 'canyon', 'cutout'],
    polyMode: ['flat', 'faceted', 'constellation', 'isometric', 'shatter'],
    crystalMode: ['harmonic', 'chaotic', 'geode', 'stained'],
    auroraMode: ['prism', 'glass', 'neon'],
    chromaMode: ['mercury', 'iridescent', 'molten'],
    bgMode: ['auto', 'dark', 'light', 'custom'],
    palSrc: ['custom', 'image']
  };
  const SCHEME_KEYS = Object.keys(CM.SCHEMES);
  const GEOMETRY_KEYS = ['seed', 'count', 'turb', 'angleMode', 'angleDeg', 'style', 'paperMode', 'polyMode', 'crystalMode', 'chromaMode'];

  const clamp = CM.clamp;
  const newSeed = () => 1 + Math.floor(Math.random() * 999999);
  const clonePal = p => p.map(c => c.slice());
  const isRgb = c => Array.isArray(c) && c.length === 3 && c.every(v => Number.isFinite(v));

  /* ---------- palette helpers ---------- */

  function luminance(c) { return CM.relativeLuminance(CM.fromArray(c)); }

  /** Exactly n colours: evenly sample when too many, interpolate along hue order when too few. */
  function fitPalette(pal, n) {
    if (!pal.length) return clonePal(COMP_DEFAULTS.basePalette).slice(0, n);
    if (pal.length === n) return clonePal(pal);
    if (pal.length > n) return Array.from({ length: n }, (_, i) => pal[Math.round(i * (pal.length - 1) / Math.max(1, n - 1))].slice());
    const sorted = clonePal(pal).sort((a, b) => hsv(...a)[0] - hsv(...b)[0]);
    return padPalette(sorted, n);
  }

  function orderPalette(pal, style, pseed) {
    const p = clonePal(pal);
    if (style === 'paper') {                                   // seeded Fisher–Yates (the original used a biased sort-shuffle)
      const rng = mulberry32((pseed | 0) + 7);
      for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = p[i]; p[i] = p[j]; p[j] = tmp; }
      return p;
    }
    return p.sort((a, b) => hsv(...a)[0] - hsv(...b)[0]);       // glow styles read best as a smooth hue ramp
  }

  /** Hue / saturation / brightness grade. Identity (no rounding drift) when all three are zero. */
  function gradeColor(c, hue, satAdj, valAdj) {
    if (!hue && !satAdj && !valAdj) return c.map(Math.round);
    let [h, s, v] = hsv(...c);
    h = (h + hue) % 360;
    s = satAdj >= 0 ? s + (1 - s) * satAdj / 100 : s * (1 + satAdj / 100);
    v = valAdj >= 0 ? v + (1 - v) * valAdj / 100 : v * (1 + valAdj / 100);
    return hsvToRgb(h, clamp(s, 0, 1), clamp(v, 0, 1));
  }

  function autoBaseHue(pal) {
    if (!pal.length) return 0;
    const roles = CM.paletteRoles(pal);
    let idx = roles.findIndex(r => r.includes('vivid'));
    if (idx < 0) idx = 0;
    return CM.rgbToHsl(pal[idx][0], pal[idx][1], pal[idx][2]).h;
  }

  /** base -> (harmony) -> grade -> style order. Returns every stage so the UI can show what it needs. */
  function effectivePalette(comp) {
    let pal = comp.basePalette;
    const hm = comp.harmony;
    if (hm && hm.on) {
      pal = CM.harmonize(pal, {
        scheme: hm.scheme, strength: hm.strength, variation: hm.variation, seed: comp.pseed,
        baseHue: hm.baseHue === null || hm.baseHue === undefined ? autoBaseHue(pal) : hm.baseHue
      });
    }
    const graded = pal.map(c => gradeColor(c, comp.hue, comp.satAdj, comp.valAdj));
    const ordered = comp.legacy ? graded : orderPalette(graded, comp.style, comp.pseed);
    return { harmonised: pal, graded, ordered };
  }

  function backgroundFor(comp, graded) {
    switch (comp.bgMode) {
      case 'dark': {
        const dk = graded.reduce((a, b) => luminance(b) < luminance(a) ? b : a, graded[0]);
        return CM.mix(dk, [0, 0, 0], 0.55).map(Math.round);
      }
      case 'light': {
        const lt = graded.reduce((a, b) => luminance(b) > luminance(a) ? b : a, graded[0]);
        return CM.mix(lt, [255, 255, 255], 0.7).map(Math.round);
      }
      case 'custom': {
        const c = CM.parseColor(comp.bgColor);
        return c ? [c.r, c.g, c.b] : gradeColor(comp.bgBase, comp.hue, comp.satAdj, comp.valAdj);
      }
      default: return gradeColor(comp.bgBase, comp.hue, comp.satAdj, comp.valAdj);
    }
  }

  /* ---------- sizes ---------- */

  /** Same rules as the original: "Resolution" is the longer edge; ratio < 1 narrows the width, > 1 shortens the height. */
  function targetSize(comp) {
    let ratio = comp.ratio === 'custom' ? comp.ratioW / comp.ratioH : parseFloat(comp.ratio);
    if (!isFinite(ratio) || ratio <= 0) ratio = 1;
    const side = comp.size === 'custom' ? clamp(Math.round(comp.customSize), 500, 4096) : parseInt(comp.size, 10);
    let w = side, h = side;
    if (ratio < 1) w = Math.round(h * ratio); else if (ratio > 1) h = Math.round(w / ratio);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }
  function angleValue(comp) {
    if (comp.angleMode === 'random') return 'random';
    const deg = comp.angleMode === 'custom' ? comp.angleDeg : parseInt(comp.angleMode, 10);
    return deg * Math.PI / 180;
  }

  /* ---------- geometry ---------- */

  /**
   * Layer geometry in diagonal-relative units, from the shape seed only (so it never depends on colours).
   * Consumption order of the random stream follows the original generator.
   */
  function buildLayers(comp, ordered) {
    if (comp.legacy && comp.legacy.layers && comp.legacy.layers.length === comp.count) {
      return comp.legacy.layers.map((l, i) => ({ angle: l.angle, yOffset: l.yOffset, pts: l.pts, color: ordered[i], nextColor: ordered[(i + 1) % ordered.length] }));
    }
    const rng = mulberry32(comp.seed | 0);
    const bAngle = angleValue(comp), n = comp.count, turb = comp.turb / 100;
    const stacked = comp.style === 'fluid' || comp.style === 'paper' || comp.style === 'polygon' || comp.style === 'chroma';
    const layers = [];
    for (let i = 0; i < n; i++) {
      let angle = bAngle;
      if (bAngle === 'random') angle = (rng() - 0.5) * Math.PI * 2.5; else angle += (rng() - 0.5) * 0.4;
      const yOffset = stacked ? 0.05 + (i / n) * 0.8 + rng() * 0.1 : 0.05 + rng() * 0.9;
      const pts = [];
      for (let j = 0; j <= 6; j++) pts.push({ x: j / 6, y: yOffset + (rng() - 0.5) * 0.45 * turb, phase: rng() * Math.PI * 2 });
      layers.push({ angle, yOffset, pts, color: ordered[i], nextColor: ordered[(i + 1) % ordered.length] });
    }
    return layers;
  }

  function buildParams(comp) {
    const eff = effectivePalette(comp);
    return {
      norm: true, v: 2,
      style: comp.style, seed: comp.seed,
      palette: eff.ordered, waveCount: comp.count,
      layers: buildLayers(comp, eff.ordered),
      avgBg: backgroundFor(comp, eff.graded),
      soft: comp.soft / 100, grain: comp.grain / 100, grainSeed: comp.seed, turb: comp.turb / 100,
      paperMode: comp.paperMode, polyMode: comp.polyMode, paperAngle: comp.paperAngle,
      crystalMode: comp.crystalMode, auroraMode: comp.auroraMode, chromaMode: comp.chromaMode,
      intensity: comp.intensity / 100, edge: comp.edge / 100, jitter: comp.jitter / 100, facet: comp.facet / 100,
      transparent: false
    };
  }

  /* ---------- validation / migration ---------- */

  /**
   * Values that earlier builds wrote and that no longer exist, mapped to the mode that LOOKS most like them
   * (measured: an old "hybrid" polygon is closest to "faceted" — RMS colour difference 5.7/255 versus 117/255 for "constellation").
   */
  function migrateRemovedValues(src) {
    const patch = {};
    if (src.style === 'topo') patch.style = 'chroma';
    if (src.paperMode === 'origami') patch.paperMode = 'cutout';
    if (src.polyMode === 'hybrid') patch.polyMode = 'faceted';
    if (src.polyMode === 'wireframe') patch.polyMode = 'constellation';
    if (src.crystalMode === 'quartz') patch.crystalMode = 'geode';
    if (src.crystalMode === 'prism') patch.crystalMode = 'stained';
    return Object.keys(patch).length ? Object.assign({}, src, patch) : src;
  }

  /**
   * The sub-mode a SAVED artwork had when the file / board item / session did not record one — what the builds that wrote it
   * would have drawn. COMP_DEFAULTS is for NEW artworks (e.g. Aurora starts as "prism"); old Aurora artworks were "glass".
   */
  const LEGACY_MODE_DEFAULTS = { paperMode: 'waves', polyMode: 'flat', crystalMode: 'harmonic', auroraMode: 'glass', chromaMode: 'mercury' };

  /** sanitize() for data that was SAVED earlier (project file, board item, session, v5 item): same validation, old artworks keep their look. */
  function fromSaved(input) {
    let src = input && typeof input === 'object' ? migrateRemovedValues(input) : {};
    const fill = {};
    for (const k of Object.keys(LEGACY_MODE_DEFAULTS)) if (!ENUMS[k].includes(String(src[k]))) fill[k] = LEGACY_MODE_DEFAULTS[k];
    return sanitize(Object.keys(fill).length ? Object.assign({}, src, fill) : src);
  }

  /** If the count asked for is above what the (resolved) style can draw, say so: { style, asked, max } or null. Used for notices; sanitize() still clamps. */
  function countClamp(input) {
    const src = input && typeof input === 'object' ? migrateRemovedValues(input) : {};
    const style = STYLES.includes(String(src.style)) ? String(src.style) : COMP_DEFAULTS.style;
    const asked = Math.round(Number(src.count)), max = STYLE_MAX_COUNT[style] || 100;
    return Number.isFinite(asked) && asked > max ? { style, asked, max } : null;
  }

  /** Accept anything (project file, history, legacy), return a complete, in-range comp. Never throws. */
  function sanitize(input) {
    let src = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const k of Object.keys(COMP_DEFAULTS)) out[k] = COMP_DEFAULTS[k];
    out.basePalette = clonePal(COMP_DEFAULTS.basePalette);
    out.bgBase = COMP_DEFAULTS.bgBase.slice();
    out.harmony = Object.assign({}, COMP_DEFAULTS.harmony);
    src = migrateRemovedValues(src);
    for (const k of Object.keys(ENUMS)) if (ENUMS[k].includes(String(src[k]))) out[k] = String(src[k]);
    for (const k of Object.keys(RANGES)) {
      const v = Number(src[k]);
      if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(v)) out[k] = clamp(v, RANGES[k][0], RANGES[k][1]);
    }
    const maxCount = STYLE_MAX_COUNT[out.style] || 100;
    out.count = clamp(Math.round(out.count), RANGES.count[0], maxCount);
    out.seed = Math.round(out.seed); out.pseed = Math.round(out.pseed);
    if (typeof src.bgColor === 'string') {                       // always plain #rrggbb so the colour picker input accepts it
      const pc = CM.parseColor(src.bgColor);
      if (pc) out.bgColor = CM.fmtHex(pc, false);
    }
    if (Array.isArray(src.basePalette) && src.basePalette.length && src.basePalette.every(isRgb)) {
      out.basePalette = src.basePalette.slice(0, 100).map(c => c.map(v => clamp(Math.round(v), 0, 255)));
    }
    if (isRgb(src.bgBase)) out.bgBase = src.bgBase.map(v => clamp(Math.round(v), 0, 255));
    if (src.harmony && typeof src.harmony === 'object') {
      const h = src.harmony;
      out.harmony = {
        on: !!h.on,
        scheme: SCHEME_KEYS.includes(h.scheme) ? h.scheme : 'complementary',
        baseHue: Number.isFinite(h.baseHue) ? ((h.baseHue % 360) + 360) % 360 : null,
        strength: Number.isFinite(h.strength) ? clamp(h.strength, 0, 100) : 70,
        variation: Number.isFinite(h.variation) ? clamp(h.variation, 0, 100) : 30
      };
    }
    if (src.legacy && Array.isArray(src.legacy.layers) && src.legacy.layers.length) out.legacy = src.legacy;
    out.basePalette = fitPalette(out.basePalette, out.count);
    return out;
  }

  /** v5 board items stored absolute-pixel layers. Convert to diagonal-relative so they render at any size. */
  function legacyToComp(item) {
    const p = item.params || {};
    const w = item.w || 1024, h = item.h || 1024;
    const diagOld = Math.sqrt(w * w + h * h) * 1.5;
    const layersSrc = p.layers || p.baseLayers || [];
    const palette = (p.palette && p.palette.length ? p.palette : p.basePalette) || COMP_DEFAULTS.basePalette;
    const side = Math.max(w, h), ratio = w / h;
    const comp = {
      style: STYLES.includes(p.style) ? p.style : 'fluid',
      seed: p.seed || 1, pseed: p.seed || 1,
      count: p.waveCount || palette.length,
      soft: Math.round((p.soft || 0) * 100), grain: Math.round((p.grain || 0) * 100),
      paperMode: p.paperMode, polyMode: p.polyMode, paperAngle: p.paperAngle,
      crystalMode: p.crystalMode, auroraMode: p.auroraMode, chromaMode: p.chromaMode,
      palSrc: 'custom', basePalette: palette, bgBase: p.avgBg || COMP_DEFAULTS.bgBase,
      size: 'custom', customSize: side, ratio: 'custom', ratioW: Math.round(ratio * 1000), ratioH: 1000
    };
    comp.legacy = {
      layers: layersSrc.map(l => ({
        angle: l.angle, yOffset: l.yOffset / diagOld,
        pts: (l.pts || []).map(q => ({ x: q.x / diagOld, y: q.y / diagOld, phase: q.phase }))
      }))
    };
    if (comp.legacy.layers.length !== comp.count) comp.legacy = null;
    return fromSaved(comp);
  }

  /** When a geometry/palette-defining field changes, a frozen legacy layer set no longer applies. */
  function normalizePatch(comp, patch) {
    if (comp.legacy && !('legacy' in patch)) {
      const touches = GEOMETRY_KEYS.some(k => k in patch) || 'basePalette' in patch || 'pseed' in patch || 'harmony' in patch;
      if (touches) return Object.assign({}, patch, { legacy: null });
    }
    return patch;
  }

  /* ---------- randomise / remix ---------- */

  /** Ranges that reliably give a good-looking picture (the full slider range does not). */
  const SAFE = {
    fluid:   { count: [6, 24], soft: [10, 55], turb: [70, 150], intensity: [70, 120], grain: [0, 6] },
    paper:   { count: [6, 20], soft: [20, 70], turb: [70, 150], paperAngle: [0, 360], grain: [0, 6] },
    aurora:  { count: [6, 26], soft: [15, 60], turb: [80, 160], intensity: [85, 135], grain: [0, 6] },
    polygon: { count: [6, 22], soft: [10, 60], turb: [70, 150], edge: [60, 140], grain: [0, 6] },
    crystal: { count: [14, 60], soft: [10, 60], jitter: [50, 110], facet: [60, 160], grain: [0, 6] },
    chroma:  { count: [10, 26], soft: [25, 75], turb: [80, 160], intensity: [85, 140], edge: [70, 145], grain: [0, 5] }
  };
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function between(rng, [a, b], integer) { const v = a + rng() * (b - a); return integer ? Math.round(v) : Math.round(v * 10) / 10; }

  /**
   * mode: 'all' | 'shapes' | 'colors' | 'remix'. Returns a patch (never touches size, ratio or the source).
   */
  function randomPatch(comp, mode, rng, hasSource) {
    rng = rng || Math.random;
    const patch = {};
    if (mode === 'shapes') { patch.seed = newSeed(); return patch; }
    if (mode === 'colors') {
      patch.pseed = newSeed();
      if (!hasSource || comp.palSrc !== 'image') { patch.hue = Math.floor(rng() * 360); }
      return patch;
    }
    if (mode === 'remix') {
      const s = SAFE[comp.style] || SAFE.fluid;
      patch.seed = newSeed();
      const nudge = (key, spread) => {
        const [lo, hi] = s[key]; const v = comp[key] + (rng() - 0.5) * spread * (hi - lo);
        patch[key] = Math.round(clamp(v, lo, hi));
      };
      ['soft', 'turb', 'intensity', 'edge', 'jitter', 'facet'].forEach(k => { if (s[k]) nudge(k, 0.35); });
      patch.hue = Math.round((comp.hue + (rng() - 0.5) * 50 + 360) % 360);
      if (comp.style === 'paper' && rng() < 0.3) patch.paperMode = pick(rng, ENUMS.paperMode);
      if (comp.style === 'polygon' && rng() < 0.3) patch.polyMode = pick(rng, ENUMS.polyMode);
      if (comp.style === 'crystal' && rng() < 0.3) patch.crystalMode = pick(rng, ENUMS.crystalMode);
      if (comp.style === 'aurora' && rng() < 0.25) patch.auroraMode = pick(rng, ENUMS.auroraMode);
      if (comp.style === 'chroma' && rng() < 0.3) patch.chromaMode = pick(rng, ENUMS.chromaMode);
      return patch;
    }
    // 'all'
    const style = pick(rng, STYLES), s = SAFE[style];
    patch.style = style; patch.seed = newSeed(); patch.pseed = newSeed();
    patch.count = between(rng, s.count, true);
    patch.soft = between(rng, s.soft, true);
    patch.grain = rng() < 0.7 ? 0 : between(rng, s.grain, true);
    if (s.turb) patch.turb = between(rng, s.turb, true);
    if (s.intensity) patch.intensity = between(rng, s.intensity, true);
    if (s.edge) patch.edge = between(rng, s.edge, true);
    if (s.jitter) patch.jitter = between(rng, s.jitter, true);
    if (s.facet) patch.facet = between(rng, s.facet, true);
    if (s.paperAngle) patch.paperAngle = between(rng, s.paperAngle, true);
    patch.paperMode = pick(rng, ENUMS.paperMode);
    patch.polyMode = pick(rng, ENUMS.polyMode);
    patch.crystalMode = pick(rng, ENUMS.crystalMode);
    patch.auroraMode = pick(rng, ENUMS.auroraMode);
    patch.chromaMode = pick(rng, ENUMS.chromaMode);
    patch.angleMode = rng() < 0.55 ? 'random' : pick(rng, ['0', '45', '90']);
    patch.hue = rng() < 0.5 ? 0 : Math.floor(rng() * 360);
    return patch;
  }

  /** Does every field in this comp make sense? (used by tests and by the randomiser's self-check) */
  function validate(comp) {
    const problems = [];
    for (const k of Object.keys(RANGES)) if (!(comp[k] >= RANGES[k][0] && comp[k] <= RANGES[k][1])) problems.push(k + ' out of range: ' + comp[k]);
    const maxC = STYLE_MAX_COUNT[comp.style] || 100;
    if (comp.count > maxC) problems.push('count ' + comp.count + ' > style max ' + maxC);
    for (const k of Object.keys(ENUMS)) if (!ENUMS[k].includes(comp[k])) problems.push(k + ' invalid: ' + comp[k]);
    if (!comp.basePalette.length || comp.basePalette.length !== comp.count) problems.push('palette length ' + comp.basePalette.length + ' != count ' + comp.count);
    return problems;
  }

  /** The unique colours of the final palette, as {r,g,b,a,roles}. */
  function paletteItems(comp, limit) {
    const eff = effectivePalette(comp);
    const seen = new Set(), uniq = [];
    for (const c of eff.ordered) { const k = c.join(','); if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
    const roles = CM.paletteRoles(uniq);
    return uniq.slice(0, limit || uniq.length).map((c, i) => Object.assign(CM.fromArray(c), { roles: roles[i] }));
  }

  window.Engine = {
    STYLES, STYLE_MAX_COUNT, STYLE_CONTROLS, COMP_DEFAULTS, RANGES, ENUMS, SAFE, GEOMETRY_KEYS,
    newSeed, sanitize, fromSaved, countClamp, LEGACY_MODE_DEFAULTS, legacyToComp, normalizePatch, validate,
    effectivePalette, backgroundFor, gradeColor, orderPalette, fitPalette, autoBaseHue,
    targetSize, angleValue, buildLayers, buildParams, randomPatch, paletteItems,
    clonePal
  };
})();