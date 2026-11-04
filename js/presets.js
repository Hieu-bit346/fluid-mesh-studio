/* ==========================================================================
   presets.js — twelve creative looks.
   A preset is a *look* (style + parameters + colour grade + background) and, optionally, its own palette.
   "My colors" applies the look to the palette you extracted; "Preset colors" also swaps in the preset palette.
   Seeds, size, ratio and your source images are never touched, and applying a preset is one undo step.
   Names / descriptions live in dict.js as preset_<id> and preset_<id>_d.
   ========================================================================== */
const Presets = (function () {
  'use strict';

  /** Every preset starts from these, so nothing from the previous look leaks through. */
  const NEUTRAL = {
    hue: 0, satAdj: 0, valAdj: 0, grain: 0, soft: 20, turb: 100,
    intensity: 100, edge: 100, jitter: 100, facet: 100,
    angleMode: 'random', angleDeg: 0, bgMode: 'auto', paperAngle: 45,
    paperMode: 'waves', polyMode: 'flat', crystalMode: 'harmonic', auroraMode: 'prism', chromaMode: 'mercury'
  };

  const list = [
    {
      id: 'deepocean',
      patch: { style: 'fluid', count: 14, soft: 38, turb: 120, intensity: 105, angleMode: '0', bgMode: 'dark', valAdj: -6, grain: 3 },
      colors: [[3, 18, 43], [7, 43, 82], [10, 84, 124], [14, 124, 148], [28, 164, 168], [66, 201, 190], [140, 232, 214], [34, 92, 170], [12, 60, 110], [90, 170, 220]],
      bgBase: [2, 12, 28]
    },
    {
      id: 'etherealaurora',
      patch: { style: 'aurora', auroraMode: 'prism', count: 12, soft: 42, turb: 125, intensity: 110, bgMode: 'dark' },
      colors: [[52, 235, 172], [38, 198, 208], [82, 148, 245], [142, 102, 242], [208, 104, 238], [78, 228, 152], [28, 172, 164], [112, 182, 242]],
      bgBase: [10, 10, 20]
    },
    {
      id: 'sakurashatter',
      patch: { style: 'polygon', polyMode: 'shatter', count: 14, soft: 30, turb: 95, edge: 90, bgMode: 'light', grain: 2 },
      colors: [[255, 224, 232], [252, 192, 210], [244, 162, 188], [255, 212, 194], [255, 238, 216], [218, 198, 238], [198, 222, 238], [242, 178, 198]],
      bgBase: [252, 242, 244]
    },
    {
      id: 'matchacutout',
      patch: { style: 'paper', paperMode: 'cutout', count: 12, soft: 48, turb: 110, paperAngle: 55, bgMode: 'light', grain: 3 },
      colors: [[244, 241, 228], [222, 232, 206], [186, 212, 174], [144, 184, 142], [104, 152, 114], [72, 118, 88], [214, 196, 168], [168, 198, 162]],
      bgBase: [242, 238, 224]
    },
    {
      id: 'cosmicdust',
      patch: { style: 'polygon', polyMode: 'faceted', count: 14, soft: 50, edge: 80, angleMode: '45', bgMode: 'dark', grain: 6, satAdj: 4 },
      colors: [[38, 26, 68], [82, 44, 128], [134, 64, 156], [192, 82, 154], [236, 118, 138], [252, 172, 124], [255, 216, 162], [82, 102, 178], [48, 72, 132]],
      bgBase: [16, 12, 34]
    },
    {
      id: 'canyonglow',
      patch: { style: 'paper', paperMode: 'canyon', count: 12, soft: 55, turb: 110, paperAngle: 45, bgMode: 'dark', grain: 4 },
      colors: [[42, 18, 38], [88, 28, 56], [142, 44, 66], [198, 72, 68], [238, 118, 74], [252, 172, 96], [255, 222, 148]],
      bgBase: [24, 10, 22]
    },
    {
      id: 'agategeode',
      patch: { style: 'crystal', crystalMode: 'geode', count: 38, soft: 42, jitter: 75, facet: 115, bgMode: 'auto' },
      colors: [[46, 32, 82], [88, 56, 142], [138, 88, 192], [192, 132, 228], [234, 188, 248], [92, 178, 212], [58, 122, 178], [242, 214, 172]],
      bgBase: [36, 24, 66]
    },
    {
      id: 'isomatrix',
      patch: { style: 'polygon', polyMode: 'isometric', count: 18, soft: 55, turb: 115, edge: 125, bgMode: 'dark', grain: 4 },
      colors: [[18, 34, 62], [32, 74, 122], [48, 134, 178], [72, 198, 212], [158, 242, 232], [112, 92, 210], [220, 104, 168]],
      bgBase: [10, 16, 28]
    },
    {
      id: 'stainedcathedral',
      patch: { style: 'crystal', crystalMode: 'stained', count: 38, soft: 55, jitter: 85, facet: 125, bgMode: 'dark' },
      colors: [[220, 38, 68], [245, 130, 32], [255, 205, 52], [36, 182, 148], [42, 112, 218], [132, 62, 202], [214, 72, 168]],
      bgBase: [12, 12, 18]
    },
    {
      id: 'liquidchrome',
      patch: { style: 'chroma', chromaMode: 'mercury', count: 14, soft: 60, turb: 130, intensity: 115, edge: 120, bgMode: 'dark' },
      colors: [[238, 244, 255], [182, 204, 238], [118, 152, 212], [74, 96, 168], [168, 122, 228], [238, 142, 204], [92, 224, 228]],
      bgBase: [12, 15, 24]
    },
    {
      id: 'minimalmono',
      patch: { style: 'paper', paperMode: 'waves', count: 6, soft: 28, turb: 90, paperAngle: 90, angleMode: '90', bgMode: 'auto', satAdj: -100, grain: 6 },
      colors: [[245, 245, 245], [210, 210, 214], [160, 160, 168], [110, 110, 120], [60, 60, 68], [24, 24, 30]],
      bgBase: [18, 18, 22]
    },
    {
      id: 'crystalprism',
      patch: { style: 'crystal', crystalMode: 'harmonic', count: 40, soft: 40, jitter: 70, facet: 110, satAdj: 6 },
      colors: [[255, 95, 109], [255, 160, 80], [255, 214, 90], [120, 230, 140], [70, 200, 230], [100, 130, 255], [170, 100, 255], [255, 110, 200]],
      bgBase: [16, 16, 28]
    }
  ];
  list.forEach(p => { p.nameKey = 'preset_' + p.id; p.descKey = 'preset_' + p.id + '_d'; });

  const byId = id => list.find(p => p.id === id) || null;

  /** The patch to hand to Store.set(). With useColors the preset palette replaces the working palette. */
  function patchFor(preset, comp, useColors) {
    const p = Object.assign({}, NEUTRAL, preset.patch);
    p.harmony = Object.assign({}, comp.harmony, { on: false });
    if (useColors) {
      p.basePalette = preset.colors.map(c => c.slice());
      p.bgBase = preset.bgBase.slice();
      p.palSrc = 'custom';
    }
    return p;
  }

  /** A complete, sanitised comp showing what the preset would look like (thumbnails). */
  function previewComp(preset, comp, useColors) {
    const patch = Engine.normalizePatch(comp, patchFor(preset, comp, useColors));
    return Engine.sanitize(Object.assign({}, comp, patch, { size: '1024', ratio: '1.5' }));
  }

  return { list, byId, patchFor, previewComp, NEUTRAL };
})();