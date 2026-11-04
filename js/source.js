/* ==========================================================================
   source.js — the user's source images.
   Holds the File objects, small thumbnails, manual crop regions (keyed by file, so adding images never discards them),
   the 280 px colour samples, and turns them into a colour pool and palette.

   Memory: decoded images are never kept. Each file is decoded, sampled into a 280 x 280 canvas, and released.
   Everything is local — nothing is uploaded anywhere.
   ========================================================================== */
const Source = (function () {
  'use strict';

  const MAX_FILES = 30, SAMPLE = 280, THUMB = 96;
  const entries = [];                     // { file, thumb, w, h }
  const crops = new Map();                // File -> { x, y, r }  (normalised: r is a fraction of the shorter side)
  let viewIdx = 0;
  let samples = null, samplesKey = '';    // Uint8ClampedArray[] aligned with entries
  let poolCache = { key: '', pool: null };
  const listeners = new Set();
  let viewImg = null, viewFor = null;

  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  const tick = () => new Promise(r => setTimeout(r, 0));
  const sig = f => f.name + '|' + f.size + '|' + f.lastModified;

  /** Draw the region of `img` that colours are read from into a size x size canvas context. */
  function drawRegion(img, mode, ctx, size, norm) {
    const sw = img.width, sh = img.height;
    ctx.clearRect(0, 0, size, size);
    if (mode === 'manual' && norm) {
      const cx = sw * norm.x, cy = sh * norm.y, r = Math.min(sw, sh) * norm.r;
      ctx.save();                                   // sample only inside the circle the user drew (the corners of its bounding square are outside it)
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2, 0, 0, size, size);
      ctx.restore();
    } else {
      let sx = 0, sy = 0, cw = sw, ch = sh;
      if (mode !== 'full') { const f = mode === 'center' ? 0.72 : 0.52; cw = sw * f; ch = sh * f; sx = (sw - cw) / 2; sy = (sh - ch) / 2; }
      const scale = Math.max(size / cw, size / ch), dw = cw * scale, dh = ch * scale;
      ctx.drawImage(img, sx, sy, cw, ch, (size - dw) / 2, (size - dh) / 2, dw, dh);
    }
  }

  /** Decode a file to a small JPEG thumbnail + its natural size. Rejects when the browser cannot decode it. */
  async function makeThumb(file) {
    const img = await load(file);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('decode');
    const c = document.createElement('canvas'), s = THUMB / Math.min(w, h);
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { thumb: c.toDataURL('image/jpeg', 0.82), w, h };
  }

  /** Add files. Returns { added, failed:[names], skipped } so the UI can say exactly what happened. */
  async function add(fileList) {
    const res = { added: 0, failed: [], skipped: 0, notImages: 0, tooMany: false };
    for (const f of fileList) {
      if (!f.type || !f.type.startsWith('image/')) { res.notImages++; continue; }
      if (entries.some(e => sig(e.file) === sig(f))) { res.skipped++; continue; }
      if (entries.length >= MAX_FILES) { res.tooMany = true; break; }
      try {
        const info = await makeThumb(f);
        entries.push({ file: f, thumb: info.thumb, w: info.w, h: info.h });
        res.added++;
      } catch (e) { res.failed.push(f.name); }
    }
    if (res.added) { invalidate(); if (viewIdx >= entries.length) viewIdx = 0; emit(); }
    return res;
  }
  function remove(i) {
    const e = entries[i]; if (!e) return;
    crops.delete(e.file); entries.splice(i, 1);
    if (viewIdx >= entries.length) viewIdx = Math.max(0, entries.length - 1);
    releaseView(); invalidate(); emit();
  }
  function clear() { entries.length = 0; crops.clear(); viewIdx = 0; releaseView(); invalidate(); emit(); }
  function invalidate() { samples = null; samplesKey = ''; poolCache = { key: '', pool: null }; }

  /* ---------- crops (manual region) ---------- */
  const getCrop = i => (entries[i] ? crops.get(entries[i].file) : undefined);
  function setCrop(i, norm) {
    if (!entries[i]) return;
    const r = Math.min(0.5, Math.max(0.05, norm.r));
    crops.set(entries[i].file, { x: Math.min(1, Math.max(0, norm.x)), y: Math.min(1, Math.max(0, norm.y)), r });
    invalidate();
  }
  function setCropAll(norm) { entries.forEach((_, i) => setCrop(i, norm)); }
  const firstMissingCrop = () => entries.findIndex(e => !crops.has(e.file));

  /* ---------- sampling ---------- */
  const keyFor = mode => mode + '|' + entries.map(e => sig(e.file) + (mode === 'manual' ? JSON.stringify(crops.get(e.file) || null) : '')).join(',');

  /** Read the colour samples for every file (cached while nothing relevant changed). */
  async function extract(mode, onProgress) {
    const key = keyFor(mode);
    if (samples && samplesKey === key) return samples;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      if (onProgress) onProgress(i + 1, entries.length);
      await tick();
      const img = await load(entries[i].file);
      drawRegion(img, mode, ctx, SAMPLE, crops.get(entries[i].file));
      out.push(new Uint8ClampedArray(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data));
    }
    samples = out; samplesKey = key; poolCache = { key: '', pool: null };
    return out;
  }
  const hasSamples = () => !!samples;

  function getPool(minSat) {
    if (!samples) return null;
    const key = String(minSat);
    if (poolCache.key !== key) poolCache = { key, pool: buildPool(samples, minSat) };
    return poolCache.pool;
  }

  /**
   * A palette of exactly comp.count colours from the pool — or null when there is nothing usable.
   * Always padded, so a flat or tiny image can never produce fewer colours than layers.
   */
  function derive(comp) {
    const pool = getPool(comp.minSat / 100);
    if (!pool || !pool.n) return null;
    const rng = mulberry32(comp.pseed | 0);
    const pal = padPalette(diversePool(pool, comp.count, rng), comp.count);
    return { basePalette: pal, bgBase: poolMean(pool), poolSize: pool.n };
  }

  /** Colour DNA of the source image(s), measured on the sampled region (so it matches what the palette came from). */
  function metrics() {
    if (!samples) return null;
    const colors = [], stride = Math.max(1, Math.ceil(samples.length * SAMPLE * SAMPLE / 60000));
    for (const d of samples) for (let p = 0; p < d.length; p += 4 * stride) { if (d[p + 3] >= 40) colors.push([d[p], d[p + 1], d[p + 2]]); }
    return colors.length ? calcMetrics(colors) : null;
  }

  /* ---------- viewing / card avatar ---------- */
  function releaseView() { viewImg = null; viewFor = null; }
  async function getView() {
    const e = entries[viewIdx];
    if (!e) return null;
    if (viewFor !== e.file) { viewImg = await load(e.file); viewFor = e.file; }
    return viewImg;
  }
  /** Paint the source image to fit the canvas box, dimming everything outside the area colours are read from. */
  async function renderView(canvas, boxW, boxH, mode) {
    const img = await getView(); if (!img) return false;
    const w = img.width, h = img.height, s = Math.min(boxW / w, boxH / h, 1);
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(img, 0, 0, cw, ch);
    if (mode !== 'full') {
      ctx.save();
      ctx.fillStyle = 'rgba(6,6,10,0.62)'; ctx.beginPath(); ctx.rect(0, 0, cw, ch);
      if (mode === 'manual' && getCrop(viewIdx)) {
        const n = getCrop(viewIdx); ctx.moveTo(cw * n.x + Math.min(cw, ch) * n.r, ch * n.y);
        ctx.arc(cw * n.x, ch * n.y, Math.min(cw, ch) * n.r, 0, Math.PI * 2, true);
      } else if (mode !== 'manual') {
        const f = mode === 'center' ? 0.72 : 0.52; ctx.rect(cw * (1 - f) / 2, ch * (1 - f) / 2, cw * f, ch * f);
      }
      ctx.fill('evenodd'); ctx.restore();
    }
    return true;
  }
  /** A decoded copy of image i, downscaled so its longer side is at most maxSide (for the card avatar). */
  async function getImageCanvas(i, maxSide) {
    const e = entries[i]; if (!e) return null;
    const img = await load(e.file);
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.naturalSource = { w: img.width, h: img.height };
    return c;
  }

  /* ---------- thumbnails strip (the only DOM this module touches) ---------- */
  function renderThumbs(container, opts) {
    opts = opts || {};
    container.innerHTML = '';
    entries.forEach((e, i) => {
      const wrap = UI.el('div', { class: 'thumb-wrap' + (i === viewIdx ? ' is-view' : '') });
      const pick = UI.el('button', { class: 'thumb-btn', type: 'button', 'aria-pressed': i === viewIdx ? 'true' : 'false', 'aria-label': t('src_view_n', { n: i + 1, name: e.file.name }), 'data-tip': e.file.name,
        onclick: () => { viewIdx = i; releaseView(); renderThumbs(container, opts); if (opts.onView) opts.onView(i); } });
      pick.appendChild(UI.el('img', { class: 'thumb', src: e.thumb, alt: '', draggable: 'false' }));
      const del = UI.el('button', { class: 'thumb-del', type: 'button', 'aria-label': t('src_remove_n', { name: e.file.name }), onclick: ev => { ev.stopPropagation(); remove(i); } });
      del.innerHTML = UI.icon('x');
      wrap.appendChild(pick); wrap.appendChild(del);
      container.appendChild(wrap);
    });
  }

  return {
    add, remove, clear, extract, hasSamples, getPool, derive, metrics, drawRegion,
    getCrop, setCrop, setCropAll, firstMissingCrop, renderView, releaseView, getImageCanvas, renderThumbs,
    get count() { return entries.length; },
    get files() { return entries.map(e => e.file); },
    entry: i => entries[i],
    get viewIndex() { return viewIdx; },
    set viewIndex(i) { viewIdx = Math.max(0, Math.min(entries.length - 1, i)); releaseView(); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    SAMPLE, MAX_FILES
  };
})();
