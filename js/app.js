/* ==========================================================================
   app.js — the Studio: wires the composition store, source images, renderer, inspector, exports, soundscape and views together.

   Data flow (one direction):
       control / preset / undo  ->  Store (comp)  ->  Engine.buildParams  ->  renderCanvas  ->  #out  ->  metrics, palette rail, accent, Soundscape

   - Sliders render a small draft while dragging and a full preview ~220 ms after the last movement.
   - Every render is cancellable; only the newest one reaches the screen (no half-painted or interleaved frames).
   - Nothing is uploaded anywhere: images are decoded, sampled and released in the browser.
   ========================================================================== */
const App = (function () {
  'use strict';

  const CM = window.ColorMath;
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const S = {
    view: 'studio', stageView: 'art', egg: null, touched: false,
    metrics: null, srcMetrics: null, srcMetricsVersion: -1, srcVersion: 0,
    params: null, renderTok: 0, generating: false, doneStatus: false, thumbsDirty: true, lastDrawn: null,
    present: false, presentTok: 0
  };
  const out = $('out'), octx = out.getContext('2d');
  const work = document.createElement('canvas');
  const metricC = document.createElement('canvas'); metricC.width = metricC.height = 256;
  const mctx = metricC.getContext('2d', { willReadFrequently: true });
  const SURFACE = CM.make(14, 14, 18);

  const pct = v => v + '%', deg = v => v + '°', signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
  const OUT_FMT = { soft: pct, turb: pct, intensity: pct, edge: pct, jitter: pct, facet: pct, grain: pct, minSat: pct,
    paperAngle: deg, hue: deg, satAdj: signed, valAdj: signed, harmStrength: pct, harmVariation: pct };

  const setStatus = msg => { $('status').textContent = msg; };
  const artName = () => $('heroName').value.trim() || ('Obj ' + (Board.count + 1));
  const toast = UI.toast;
  const hexOf = c => CM.fmtHex(Array.isArray(c) ? CM.fromArray(c) : c, false);
  const inkFor = c => (CM.bestTextColor(Array.isArray(c) ? CM.fromArray(c) : c).color.r === 0 ? '#0b0b10' : '#ffffff');

  /* ======================================================================
     Accent: the interface borrows its colour from the artwork
     ====================================================================== */
  function badgeColors(stops) {
    if (!stops.length) return { ink: '#101014', stops: [[136, 136, 136], [136, 136, 136]] };
    if (stops.length === 1) stops = [stops[0], stops[0]];
    const sample = list => { const out = []; for (let i = 0; i <= 24; i++) { const x = i / 24 * (list.length - 1), k = Math.min(list.length - 2, Math.floor(x)); out.push(CM.mix(list[k], list[k + 1], x - k).map(Math.round)); } return out; };
    const worst = (list, ink) => Math.min(...sample(list).map(c => CM.contrastRatio(CM.fromArray(c), CM.fromArray(ink))));
    const INKS = [{ css: '#101014', rgb: [16, 16, 20], toward: [255, 255, 255] }, { css: '#ffffff', rgb: [255, 255, 255], toward: [0, 0, 0] }];
    let best = null;
    for (const ink of INKS) {
      let t = 0, list = stops;
      for (; t <= 0.9; t += 0.05) { list = t === 0 ? stops : stops.map(c => CM.mix(c, ink.toward, t).map(Math.round)); if (worst(list, ink.rgb) >= 4.6) break; }
      const ok = worst(list, ink.rgb) >= 4.6, base = worst(stops, ink.rgb);
      if (!best || (ok && !best.ok) || (ok === best.ok && (t < best.t - 1e-9 || (Math.abs(t - best.t) < 1e-9 && base > best.base)))) best = { ink: ink.css, stops: list, t, ok, base };
    }
    return { ink: best.ink, stops: best.stops };
  }

  function applyAccent(comp) {
    const items = Engine.paletteItems(comp);
    const root = document.documentElement.style;
    if (!items.length) return;
    let best = items[0], score = -1;
    items.forEach(it => { const o = CM.rgbToHsv(it.r, it.g, it.b); const sc = o.s * Math.min(1, o.v / 55); if (sc > score) { score = sc; best = it; } });
    let rgb;
    if (score < 14) rgb = [214, 219, 232];
    else {
      const hsl = CM.rgbToHsl(best.r, best.g, best.b);
      let l = Math.min(74, Math.max(60, hsl.l)), s = Math.max(hsl.s, 58);
      rgb = CM.hslToRgb(hsl.h, s, l).map(CM.byte);
      for (let g = 0; g < 14 && CM.contrastRatio(CM.fromArray(rgb), SURFACE) < 4.6; g++) { l = Math.min(92, l + 3); rgb = CM.hslToRgb(hsl.h, s, l).map(CM.byte); }
    }
    root.setProperty('--accent', CM.fmtHex(CM.fromArray(rgb)));
    root.setProperty('--accent-rgb', rgb.join(','));
    root.setProperty('--accent-ink', inkFor(rgb));
    const byHue = items.slice().sort((a, b) => CM.rgbToHsl(a.r, a.g, a.b).h - CM.rgbToHsl(b.r, b.g, b.b).h);
    const n = Math.min(6, byHue.length), stops = [];
    for (let i = 0; i < n; i++) stops.push(hexOf(byHue[Math.round(i * (byHue.length - 1) / Math.max(1, n - 1))]));
    root.setProperty('--spectrum', n > 1 ? `linear-gradient(90deg, ${stops.join(', ')})` : `linear-gradient(90deg, ${stops[0] || '#888'}, ${stops[0] || '#888'})`);
    const hd = badgeColors(Array.from({ length: n }, (_, i) => { const c = byHue[Math.round(i * (byHue.length - 1) / Math.max(1, n - 1))]; return [c.r, c.g, c.b]; }));
    root.setProperty('--hd-bg', `linear-gradient(90deg, ${hd.stops.map(c => CM.fmtHex(CM.fromArray(c), false)).join(', ')})`);
    root.setProperty('--hd-ink', hd.ink);
    const bg = S.params ? S.params.avgBg : [24, 40, 70];
    root.setProperty('--m1', hexOf(bg));
    root.setProperty('--m2', hexOf(best));
    root.setProperty('--m3', hexOf(items[Math.floor(items.length / 2)]));
  }

  /* ======================================================================
     Store helpers
     ====================================================================== */
  /** Tell the user when the number of layers they asked for is above what the style can draw (e.g. Aurora 60 -> 35); never silent. */
  function noticeCountClamp(c) {
    if (c) toast(t('count_clamped', { style: t('style_' + c.style), asked: c.asked, max: c.max }), { type: 'warn', ms: 5200 });
  }

  function setComp(patch, opts) {
    const cur = Store.get();
    const merged = Object.assign({}, cur, patch);
    let clamp = null;
    if ('count' in patch || 'style' in patch) clamp = Engine.countClamp(merged);        // what was asked for, before anything is cut
    if ('style' in patch && Engine.STYLE_MAX_COUNT) {
      const maxC = Engine.STYLE_MAX_COUNT[merged.style] || 100;
      if (merged.count > maxC && !('count' in patch)) {
        patch = Object.assign({}, patch, { count: maxC });
        merged.count = maxC;
      }
    }
    const touchesPalette = ['count', 'minSat', 'pseed', 'style'].some(k => k in patch);
    if (touchesPalette && merged.palSrc === 'image' && Source.hasSamples() && !('basePalette' in patch)) {
      const d = Source.derive(merged);
      if (!d) { toast(t('err_flat'), { type: 'warn' }); syncControls(cur); return false; }
      patch = Object.assign({}, patch, { basePalette: d.basePalette, bgBase: d.bgBase });
    }
    const changed = Store.set(patch, opts);
    if (clamp && !(opts && opts.silent)) noticeCountClamp(clamp);
    return changed;
  }

  async function refreshSource(opts) {
    opts = opts || {};
    if (!Source.count) { if (Store.get().palSrc === 'image') Store.set({ palSrc: 'custom' }, { history: false }); return false; }
    const mode = $('crop').value;
    if (mode === 'manual' && Source.firstMissingCrop() >= 0) {
      CropUI.open(Source.firstMissingCrop(), { onDone: () => refreshSource(opts), onCancel: () => { setStatus(t('status_cancelled')); $('go').disabled = false; } });
      return false;
    }
    try {
      await Source.extract(mode, (i, n) => setStatus(t('status_analyzing', { i, n })));
    } catch (e) { console.error('[extract]', e); setStatus(t('err_extract')); toast(t('err_extract'), { type: 'error' }); return false; }
    S.srcVersion++;
    const comp = Store.get();
    if (comp.palSrc !== 'image' && !opts.toImage) return true;
    const patch = { palSrc: 'image' };
    if (opts.reseed) { patch.seed = Engine.newSeed(); patch.pseed = Engine.newSeed(); patch.harmony = Object.assign({}, comp.harmony, { on: false }); }
    const d = Source.derive(Object.assign({}, comp, patch));
    if (!d) { setStatus(t('err_flat')); toast(t('err_flat'), { type: 'warn' }); return false; }
    S.touched = true; S.egg = null;
    S.doneStatus = true;
    Store.set(Object.assign(patch, { basePalette: d.basePalette, bgBase: d.bgBase }), {});
    return true;
  }

  /* ======================================================================
     Rendering
     ====================================================================== */
  let rafPending = false, wantFull = false, settleTimer = 0, busyTimer = 0, renderErrorShown = false;
  function requestRender(draft) {
    if (!draft) wantFull = true;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; const full = wantFull; wantFull = false; doRender(!full); });
    }
    if (draft) { clearTimeout(settleTimer); settleTimer = setTimeout(() => requestRender(false), 220); }
  }
  function flushSettle() { clearTimeout(settleTimer); requestRender(false); }

  async function doRender(draft) {
    const comp = Store.get();
    let params;
    try { params = Engine.buildParams(comp); }
    catch (e) { console.error('[buildParams]', e); toast(t('err_render'), { type: 'error' }); return; }
    const size = Engine.targetSize(comp);
    const long = draft ? 480 : 1280, k = Math.min(1, long / Math.max(size.w, size.h));
    const pw = Math.max(2, Math.round(size.w * k)), ph = Math.max(2, Math.round(size.h * k));
    const tok = ++S.renderTok;
    if (!draft) { clearTimeout(busyTimer); busyTimer = setTimeout(() => UI.busy(true, t('rendering')), 380); }
    let ok = false;
    try { ok = await renderCanvas(params, work, pw, ph, 0, { cancel: () => tok !== S.renderTok }); }
    catch (e) {
      console.error('[render]', e);
      if (!renderErrorShown) { renderErrorShown = true; toast(t('err_render'), { type: 'error' }); }
    }
    if (tok !== S.renderTok) return;
    clearTimeout(busyTimer); UI.busy(false);
    if (!ok) return;
    renderErrorShown = false;
    if (out.width !== pw) out.width = pw;
    if (out.height !== ph) out.height = ph;
    octx.clearRect(0, 0, pw, ph); octx.drawImage(work, 0, 0);
    S.params = params; S.lastDrawn = { w: size.w, h: size.h, draft, comp };
    fitCanvas();
    if (!draft) { try { afterFullRender(comp); } catch (e) { console.error('[afterRender]', e); } }
  }

  function computeMetrics(canvas) {
    mctx.clearRect(0, 0, 256, 256);
    mctx.drawImage(canvas, 0, 0, 256, 256);
    return metricsFromRGBA(mctx.getImageData(0, 0, 256, 256).data, 1);
  }

  function afterFullRender(comp) {
    S.metrics = computeMetrics(out);
    if (S.srcMetricsVersion !== S.srcVersion) { S.srcMetrics = Source.metrics(); S.srcMetricsVersion = S.srcVersion; }
    applyAccent(comp);
    renderAnalyze();
    renderRail(comp);
    $('dimLabel').textContent = S.lastDrawn.w + ' × ' + S.lastDrawn.h + ' px';
    $('outDims').textContent = S.lastDrawn.w + ' × ' + S.lastDrawn.h + ' px';
    if (S.doneStatus) { setStatus(t('status_done')); S.doneStatus = false; }
    if (S.present) renderPresentSoon();
    scheduleThumbs();
    if (typeof ColorLab !== 'undefined') ColorLab.onArtChanged();
    if (typeof Soundscape !== 'undefined' && S.params) Soundscape.updateParams(S.params);
  }

  function fitCanvas() {
    const wrap = $('canvasWrap'), frame = $('canvasFrame');
    if (!wrap.clientWidth) return;
    const cs = getComputedStyle(wrap), note = $('sampleNote');
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const noteH = note.classList.contains('hidden') ? 0 : note.offsetHeight + 8 + (parseFloat(getComputedStyle(note).marginTop) || 0);
    const availW = Math.max(60, wrap.clientWidth - padX), availH = Math.max(60, wrap.clientHeight - padY - noteH);
    if (S.stageView === 'src' && Source.count) {
      Source.renderView($('srcCanvas'), availW, availH, $('crop').value).then(() => {
        frame.style.width = $('srcCanvas').style.width; frame.style.height = $('srcCanvas').style.height;
      }).catch(e => { console.error('[srcView]', e); showStageView('art'); });
      return;
    }
    const size = Engine.targetSize(Store.get());
    const s = Math.min(availW / size.w, availH / size.h);
    frame.style.width = Math.max(40, Math.floor(size.w * s)) + 'px';
    frame.style.height = Math.max(40, Math.floor(size.h * s)) + 'px';
  }

  function showStageView(v) {
    S.stageView = (v === 'src' && Source.count) ? 'src' : 'art';
    const seg = $('stageViewSeg');
    Array.from(seg.querySelectorAll('[role="tab"]')).forEach(b => { const on = b.dataset.stageView === S.stageView; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    out.classList.toggle('hidden', S.stageView === 'src');
    $('srcCanvas').classList.toggle('hidden', S.stageView !== 'src');
    fitCanvas();
  }

  /* ======================================================================
     Controls <-> store
     ====================================================================== */
  function syncControls(comp) {
    const active = document.activeElement;
    const blobsEl = $('blobs');
    if (blobsEl && Engine.STYLE_MAX_COUNT) {
      const maxC = String(Engine.STYLE_MAX_COUNT[comp.style] || 100);
      if (blobsEl.max !== maxC) blobsEl.max = maxC;
    }
    $$('[data-key]').forEach(el => {
      const key = el.dataset.key; if (!(key in comp)) return;
      if (el === active && (el.type === 'number' || el.type === 'text')) return;
      const v = String(comp[key]);
      if (el.value !== v) el.value = v;
    });
    const hm = comp.harmony;
    $('harmStrength').value = hm.strength; $('harmVariation').value = hm.variation;
    $$('[data-out]').forEach(o => {
      const k = o.dataset.out;
      const v = k === 'harmStrength' ? hm.strength : k === 'harmVariation' ? hm.variation : comp[k];
      if (v !== undefined) o.textContent = (OUT_FMT[k] || String)(v);
    });
    $('customAngle').classList.toggle('hidden', comp.angleMode !== 'custom');
    $('customRatioBox').classList.toggle('hidden', comp.ratio !== 'custom');
    syncRatioQuick(comp);
    $('customSize').classList.toggle('hidden', comp.size !== 'custom');
    $('bgColor').classList.toggle('hidden', comp.bgMode !== 'custom');
    const wanted = Engine.STYLE_CONTROLS[comp.style] || [];
    $$('#styleControls [data-ctl]').forEach(el => { el.hidden = !wanted.includes(el.dataset.ctl); });
    $$('#styleGrid .style-card').forEach(b => { const on = b.dataset.style === comp.style; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    $('styleDesc').textContent = t('style_desc_' + comp.style);
    refreshLabels(comp);
    $('seedLabel').textContent = comp.seed + ' · ' + comp.pseed;
    $('sat').disabled = comp.palSrc !== 'image' || !Source.count;
    renderPaletteInfo(comp);
    renderHarmony(comp);
    $('btnUndo').disabled = !Store.canUndo(); $('btnRedo').disabled = !Store.canRedo();
    $('sampleNote').classList.toggle('hidden', Source.count > 0 || S.touched);
    $('transparentNote').classList.toggle('hidden', !$('exportTransparent').checked);
  }

  const RATIO_NAMES = { '1': '1:1', '1.7777': '16:9', '0.5625': '9:16', '0.8': '4:5', '1.5': '3:2' };
  function syncRatioQuick(comp) {
    $$('#ratioQuickSeg [data-ratio]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ratio === comp.ratio ? 'true' : 'false'));
    const custom = comp.ratio === 'custom';
    $('ratioQuickCustom').classList.toggle('hidden', !custom);
    $('ratioNow').classList.toggle('hidden', custom);
    $('ratioNow').textContent = RATIO_NAMES[comp.ratio] || '';
  }
  $('ratioQuickSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-ratio]'); if (!b) return;
    if (setComp({ ratio: b.dataset.ratio }, {})) S.touched = true;
  });

  function refreshLabels(comp) {
    comp = comp || Store.get();
    $$('#styleControls [data-label-key]').forEach(span => {
      const ctl = span.closest('[data-ctl]').dataset.ctl, key = 'lbl_' + ctl + '_' + comp.style;
      const has = window.dict && window.dict.en && window.dict.en[key] !== undefined;
      span.textContent = has ? t(key) : t(span.dataset.labelKey);
    });
  }

  function onKeyControl(el, final) {
    const key = el.dataset.key; let v;
    if (el.type === 'range' || el.type === 'number') {
      if (el.value === '') return;
      v = Number(el.value); if (!Number.isFinite(v)) return;
    } else v = el.value;
    const draft = (el.type === 'range' || el.type === 'color') && !final;
    setComp({ [key]: v }, { coalesce: key, meta: { draft } });
    if (final && (el.type === 'range' || el.type === 'color')) flushSettle();
  }
  document.addEventListener('input', e => {
    const el = e.target; if (!el.dataset || !el.dataset.key) return;
    if (el.type === 'range' || el.type === 'color') onKeyControl(el, false);
  });
  document.addEventListener('change', e => {
    const el = e.target; if (!el.dataset || !el.dataset.key) return;
    onKeyControl(el, true);
    if (el.type === 'number' || el.type === 'text') {
      const cur = Store.get(), v = el.dataset.key in cur ? String(cur[el.dataset.key]) : null;
      if (v !== null && el.value !== v) el.value = v;
    }
  });

  /* ======================================================================
     Source images
     ====================================================================== */
  function updateSourceUI() {
    const n = Source.count;
    $('srcInfo').textContent = n ? t('src_count', { n }) : '';
    $('clear').classList.toggle('hidden', n < 2);
    $('btnEditCrop').classList.toggle('hidden', !(n && $('crop').value === 'manual'));
    $('btnViewSrc').disabled = !n;
    if (!n && S.stageView === 'src') showStageView('art');
    if (!S.generating) setStatus(n ? t(n === 1 ? 'status_one' : 'status_many', { n }) : t('status_empty'));
    $('sampleNote').classList.toggle('hidden', n > 0 || S.touched);
    $('btnReextract').classList.toggle('hidden', !(n > 0 && Store.get().palSrc === 'custom'));
    $('sat').disabled = Store.get().palSrc !== 'image' || !n;
    fitCanvas();
  }

  const renderThumbs = () => Source.renderThumbs($('preview'), { onView: () => { if (S.stageView === 'src') fitCanvas(); } });
  Source.on(() => {
    renderThumbs();
    S.srcVersion++;
    updateSourceUI();
  });

  async function addFiles(list) {
    list = Array.from(list || []);
    if (!list.length) return;
    const hadImagePalette = Source.count > 0 && Store.get().palSrc === 'image';
    setStatus(t('status_reading'));
    const res = await Source.add(list);
    if (res.failed.length) toast(t('err_decode', { name: res.failed.slice(0, 2).join(', ') + (res.failed.length > 2 ? ' +' + (res.failed.length - 2) : '') }), { type: 'error' });
    if (res.notImages) toast(t('err_not_image', { n: res.notImages }), { type: 'warn' });
    if (res.skipped) toast(t('src_dupe', { n: res.skipped }), { type: 'info' });
    if (res.tooMany) toast(t('src_max', { n: Source.MAX_FILES }), { type: 'warn' });
    if (!res.added) { updateSourceUI(); return; }
    await refreshSource({ reseed: !hadImagePalette, toImage: !hadImagePalette });
  }

  const EGGS = {
    aetheria: { colors: [[0, 191, 255], [0, 128, 255], [0, 255, 255], [30, 144, 255], [64, 224, 208]], msg: 'ee_aetheria' },
    phuongvi: { colors: [[255, 69, 0], [255, 0, 0], [255, 140, 0], [220, 20, 60], [178, 34, 34]], msg: 'ee_phuongvi' }
  };
  function eggFor(name) {
    const n = name.trim().toLowerCase();
    if (currentLang === 'en' && n === 'aetheria') return 'aetheria';
    if (currentLang === 'vi' && n === 'phượng vĩ') return 'phuongvi';
    return null;
  }

  async function generate() {
    if (S.generating) return;
    if (!Source.count) {
      setStatus(t('status_pick')); toast(t('status_pick'), { type: 'info', action: { label: t('choose_image'), fn: () => $('files').click() } });
      $('drop').classList.add('nudge'); setTimeout(() => $('drop').classList.remove('nudge'), 900);
      return;
    }
    S.generating = true; UI.setBusy($('go'), true);
    try {
      const egg = eggFor($('heroName').value);
      if (egg) {
        const comp = Store.get(), cols = EGGS[egg].colors;
        const mean = cols.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map(v => Math.round(v / cols.length));
        setStatus(t(EGGS[egg].msg));
        S.egg = egg; S.touched = true; S.doneStatus = false;
        Store.set({ palSrc: 'custom', seed: Engine.newSeed(), pseed: Engine.newSeed(), basePalette: padPalette(cols, comp.count), bgBase: mean, harmony: Object.assign({}, comp.harmony, { on: false }) }, {});
        return;
      }
      S.doneStatus = true;
      const ok = await refreshSource({ reseed: true, toImage: true });
      if (!ok) S.doneStatus = false;
      else setStatus(t('status_rendering'));
    } finally { S.generating = false; UI.setBusy($('go'), false); }
  }

  /* ---- drop zone ---- */
  const drop = $('drop'), fileInput = $('files');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', e => { addFiles(e.target.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); drop.classList.add('drag'); $('stage').classList.add('drag'); }
  }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
    if (ev === 'dragleave' && e.relatedTarget) return;
    drop.classList.remove('drag'); $('stage').classList.remove('drag');
  }));
  document.addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault(); addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', e => {
    if (UI.isTyping(e)) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('clear').onclick = () => { Source.clear(); S.egg = null; $('drop').focus({ preventScroll: true }); };
  $('go').onclick = generate;
  $('crop').addEventListener('change', () => { updateSourceUI(); if (Source.count) refreshSource({}); });
  $('btnEditCrop').onclick = () => { if (Source.count) CropUI.open(Source.viewIndex, { onDone: () => refreshSource({}) }); };
  $('heroName').addEventListener('input', () => persistSoon());
  UI.tabs($('stageViewSeg'), { onSelect: b => showStageView(b.dataset.stageView) });

  /* ======================================================================
     Palette rail + quick inspector
     ====================================================================== */
  function railItems(comp, max) {
    const all = Engine.paletteItems(comp);
    if (all.length <= max) return all;
    const keep = new Set();
    all.forEach((it, i) => { if (it.roles && it.roles.length) keep.add(i); });
    const free = Math.max(0, max - keep.size);
    for (let k = 0; k < free; k++) keep.add(Math.round(k * (all.length - 1) / Math.max(1, free - 1)));
    return Array.from(keep).sort((a, b) => a - b).slice(0, max).map(i => all[i]);
  }
  function renderRail(comp) {
    const rail = $('paletteRail'); rail.innerHTML = '';
    railItems(comp, 10).forEach(it => {
      const hx = hexOf(it), roles = (it.roles || []).map(r => t('role_' + r));
      const b = UI.el('button', { type: 'button', class: 'swatch', style: { '--c': hx }, 'aria-label': hx + (roles.length ? ', ' + roles.join(', ') : ''), 'data-tip': hx + (roles.length ? ' · ' + roles.join(', ') : '') });
      b.appendChild(UI.el('span', { class: 'sw-label', style: { color: inkFor(it) } }, hx));
      b.addEventListener('click', () => ColorLab.showPopover(b, it));
      rail.appendChild(UI.el('div', { role: 'listitem', class: 'rail-item' }, b));
    });
  }
  $('btnRailCss').onclick = () => Exports.copyPalette(railItems(Store.get(), 10), 'css', { naming: 'seq' }, $('btnRailCss'));
  $('btnRailLab').onclick = () => { setView('lab'); };

  /* ======================================================================
     Look tab: presets + styles
     ====================================================================== */
  const presetMode = () => ($('presetColorSeg').querySelector('[aria-pressed="true"]') || {}).dataset.presetColors || 'keep';
  function buildPresetGrid() {
    const grid = $('presetGrid'); grid.innerHTML = '';
    Presets.list.forEach(p => {
      const b = UI.el('button', { type: 'button', class: 'preset-card', 'data-id': p.id, 'data-tip': t(p.descKey), 'aria-label': t(p.nameKey) + '. ' + t(p.descKey) });
      b.appendChild(UI.el('canvas', { width: 132, height: 88, 'aria-hidden': 'true' }));
      b.appendChild(UI.el('span', { class: 'preset-name' }, t(p.nameKey)));
      grid.appendChild(b);
    });
    S.thumbsDirty = true; scheduleThumbs();
  }
  function applyPreset(id) {
    const p = Presets.byId(id); if (!p) return;
    const comp = Store.get();
    if (setComp(Presets.patchFor(p, comp, presetMode() === 'use'), {})) {
      S.touched = true;
      toast(t('preset_applied', { name: t(p.nameKey) }), { type: 'success', action: { label: t('undo'), fn: () => Store.undo() } });
    }
  }
  $('presetGrid').addEventListener('click', e => { const b = e.target.closest('.preset-card'); if (b) applyPreset(b.dataset.id); });
  UI.radioGroup($('presetColorSeg'), 'aria-pressed', () => { S.thumbsDirty = true; scheduleThumbs(); try { localStorage.setItem('fms-presetcolors', presetMode()); } catch (e) { /* ignore */ } });
  try { const pm = localStorage.getItem('fms-presetcolors'); if (pm === 'use') { const g = $('presetColorSeg'); g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.presetColors === 'use' ? 'true' : 'false')); } } catch (e) { /* ignore */ }
  UI.radioGroup($('styleGrid'), 'aria-checked', b => setComp({ style: b.dataset.style }, {}));

  function miniRender(comp, canvas, w, h) {
    try { renderCanvas(Engine.buildParams(Object.assign({}, comp, { legacy: null })), canvas, w, h, 0, { sync: true }); } catch (e) { /* leave the thumbnail blank */ }
  }
  const scheduleThumbs = UI.debounce(() => {
    if (document.body.dataset.view !== 'studio') { S.thumbsDirty = true; return; }
    if ($('tab-look').hidden) { S.thumbsDirty = true; return; }
    S.thumbsDirty = false;
    const comp = Store.get();
    $$('#styleGrid .style-card').forEach(b => {
      miniRender(Engine.sanitize(Object.assign({}, comp, { style: b.dataset.style, size: '1024', ratio: '1', legacy: null })), b.querySelector('canvas'), 112, 112);
    });
    const use = presetMode() === 'use';
    $$('#presetGrid .preset-card').forEach(b => {
      const p = Presets.byId(b.dataset.id);
      if (p) miniRender(Presets.previewComp(p, Object.assign({}, comp, { legacy: null }), use), b.querySelector('canvas'), 132, 88);
    });
  }, 260);

  /* ======================================================================
     Color tab: palette info, grade, harmony
     ====================================================================== */
  function renderPaletteInfo(comp) {
    const n = Source.count;
    let msg;
    if (comp.palSrc === 'image' && n) msg = t('pal_from_image', { n, c: comp.count });
    else if (S.egg) msg = t('pal_egg');
    else if (n) msg = t('pal_custom_src');
    else msg = t('pal_custom');
    $('palInfo').textContent = msg;
    $('btnReextract').classList.toggle('hidden', !(n > 0 && comp.palSrc === 'custom'));
  }
  $('btnReextract').onclick = () => { S.doneStatus = false; refreshSource({ toImage: true }); };
  $('btnGradeReset').onclick = () => { setComp({ hue: 0, satAdj: 0, valAdj: 0 }, {}); };
  $('btnSeedDice').onclick = () => setComp({ seed: Engine.newSeed() }, {});
  $('btnPSeedDice').onclick = () => setComp({ pseed: Engine.newSeed() }, {});

  const schemeGroup = UI.radioGroup($('harmonySchemes'), 'aria-checked', b => setComp({ harmony: Object.assign({}, Store.get().harmony, { scheme: b.dataset.scheme }) }, {}));
  $('harmStrength').addEventListener('input', e => setComp({ harmony: Object.assign({}, Store.get().harmony, { strength: Number(e.target.value) }) }, { coalesce: 'hs', meta: { draft: true } }));
  $('harmVariation').addEventListener('input', e => setComp({ harmony: Object.assign({}, Store.get().harmony, { variation: Number(e.target.value) }) }, { coalesce: 'hv', meta: { draft: true } }));
  $('harmStrength').addEventListener('change', flushSettle); $('harmVariation').addEventListener('change', flushSettle);
  $('btnHarmPreview').onclick = () => { const c = Store.get(); setComp({ harmony: Object.assign({}, c.harmony, { on: !c.harmony.on }) }, {}); };
  $('btnHarmApply').onclick = () => {
    const c = Store.get(); if (!c.harmony.on) return;
    const eff = Engine.effectivePalette(c);
    if (setComp({ basePalette: eff.harmonised.map(x => x.slice()), palSrc: 'custom', harmony: Object.assign({}, c.harmony, { on: false }) }, {})) {
      S.touched = true; toast(t('harm_applied'), { type: 'success', action: { label: t('undo'), fn: () => Store.undo() } });
    }
  };
  $('harmonyBase').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const c = Store.get(); const hue = b.dataset.hue === '' ? null : Number(b.dataset.hue);
    setComp({ harmony: Object.assign({}, c.harmony, { baseHue: hue }) }, {});
  });

  function renderHarmony(comp) {
    const hm = comp.harmony;
    schemeGroup.set(schemeGroup.items().find(b => b.dataset.scheme === hm.scheme), true);
    const uniq = [], seen = new Set();
    comp.basePalette.forEach(c => { const k = c.join(','); if (!seen.has(k)) { seen.add(k); uniq.push(c); } });
    const roles = CM.paletteRoles(uniq);
    const baseBox = $('harmonyBase'); baseBox.innerHTML = '';
    const mk = (hue, rgb, label, selected) => {
      const b = UI.el('button', { type: 'button', role: 'radio', 'aria-checked': selected ? 'true' : 'false', class: 'base-chip' + (rgb ? '' : ' auto'), 'data-hue': hue === null ? '' : String(hue), style: rgb ? { '--c': hexOf(rgb) } : null, 'aria-label': label, 'data-tip': label, tabindex: selected ? 0 : -1 });
      if (!rgb) b.textContent = t('harm_auto');
      baseBox.appendChild(b);
    };
    mk(null, null, t('harm_auto_tip'), hm.baseHue === null);
    const picks = uniq.length <= 8 ? uniq : Array.from({ length: 8 }, (_, i) => uniq[Math.round(i * (uniq.length - 1) / 7)]);
    picks.forEach(c => { const h = Math.round(CM.rgbToHsl(c[0], c[1], c[2]).h) % 360; mk(h, c, hexOf(c), hm.baseHue !== null && Math.abs(((hm.baseHue - h + 540) % 360) - 180) < 1); });
    let baseRgb;
    if (hm.baseHue === null) { const vi = roles.findIndex(r => r.includes('vivid')); baseRgb = uniq[vi >= 0 ? vi : 0]; }
    else baseRgb = uniq.reduce((a, c) => { const d = Math.abs(((CM.rgbToHsl(c[0], c[1], c[2]).h - hm.baseHue + 540) % 360) - 180); return d < a.d ? { d, c } : a; }, { d: 999, c: uniq[0] }).c;
    const sw = CM.harmonySwatches(baseRgb, hm.scheme, 8, hm.variation, comp.pseed);
    const prev = $('harmonyPreview'); prev.innerHTML = '';
    sw.forEach(c => prev.appendChild(UI.el('button', { type: 'button', class: 'swatch sm', style: { '--c': hexOf(c) }, 'aria-label': hexOf(c), 'data-tip': hexOf(c), onclick: ev => ColorLab.showPopover(ev.currentTarget, CM.fromArray(c)) })));
    $('btnHarmPreview').setAttribute('aria-pressed', hm.on ? 'true' : 'false');
    $('btnHarmApply').disabled = !hm.on;
  }

  /* ======================================================================
     Analyze tab
     ====================================================================== */
  function accentRgb() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    const a = v ? v.split(',').map(Number) : [255, 92, 119];
    return a.length === 3 && a.every(Number.isFinite) ? a : [255, 92, 119];
  }
  function renderAnalyze() {
    const m = S.metrics; if (!m) return;
    const showCmp = !!(S.srcMetrics && !S.egg && Source.count && $('cmpToggle').checked);
    const sw = $('cmpSwitch'); sw.classList.toggle('is-disabled', !(S.srcMetrics && !S.egg && Source.count)); $('cmpToggle').disabled = !(S.srcMetrics && !S.egg && Source.count);
    renderMetricsText(m, $('metricsText'), showCmp ? S.srcMetrics : null);
    const box = $('radarChart').parentElement, cssW = Math.max(220, box.clientWidth || 300), cssH = Math.max(220, box.clientHeight || 300);
    if ($('tab-analyze').hidden) { S.analyzeDirty = true; return; }
    S.analyzeDirty = false;
    const ctx = setupHiDPICanvas($('radarChart'), cssW, cssH);
    $('radarChart').style.width = cssW + 'px'; $('radarChart').style.height = cssH + 'px';
    drawRadar(ctx, m, { width: cssW, height: cssH, labels: METRIC_DEFS.map(d => t(d.label)), compare: showCmp ? S.srcMetrics : null, accent: accentRgb(), gridColor: '#2b3040', textColor: '#f2f4f8', mutedColor: '#98a2b8' });
    $('radarLegend').innerHTML = `<span class="lg"><i class="lg-solid"></i>${UI.esc(t('lg_art'))}</span>` + (showCmp ? `<span class="lg"><i class="lg-dash"></i>${UI.esc(t('lg_src'))}</span>` : '') + '<p class="muted small" id="radarCaption"></p>';
  }
  $('cmpToggle').addEventListener('change', renderAnalyze);
  $('radarChart').addEventListener('pointermove', e => {
    if (!S.metrics) return;
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    if (Math.hypot(x, y) < 12) return;
    const a = Math.atan2(y, x) + Math.PI / 2, idx = ((Math.round((a < 0 ? a + Math.PI * 2 : a) / (Math.PI * 2) * 5)) % 5 + 5) % 5, def = METRIC_DEFS[idx];
    const cap = $('radarCaption'); if (cap) cap.textContent = t(def.label) + ' ' + S.metrics[def.key].toFixed(1) + '% — ' + t(def.info);
  });

  /* ======================================================================
     Export tab & Soundscape controls
     ====================================================================== */
  const palFull = () => Engine.paletteItems(Store.get());
  function updatePalPreview() {
    if ($('tab-export').hidden) { S.exportDirty = true; return; }
    S.exportDirty = false;
    const fmt = $('palFormat').value, items = palFull();
    $('palNamingField').classList.toggle('hidden', !(fmt === 'css' || fmt === 'json'));
    $('palTxtField').classList.toggle('hidden', fmt !== 'txt');
    $('palPreview').value = items.length ? Exports.paletteText(items, fmt, { name: artName(), naming: $('palNaming').value, txt: $('palTxtFormat').value }) : '';
    $('palExportNote').textContent = t('pal_export_note', { n: items.length });
  }
  ['palFormat', 'palNaming', 'palTxtFormat'].forEach(id => $(id).addEventListener('change', updatePalPreview));
  $('btnPalCopy').onclick = () => Exports.copyPalette(palFull(), $('palFormat').value, { name: artName(), naming: $('palNaming').value, txt: $('palTxtFormat').value }, $('btnPalCopy'));
  $('dlPaletteBtn').onclick = () => Exports.downloadPalette(palFull(), $('palFormat').value, { name: artName(), naming: $('palNaming').value, txt: $('palTxtFormat').value });
  $('exportTransparent').addEventListener('change', () => $('transparentNote').classList.toggle('hidden', !$('exportTransparent').checked));

  // One PNG export at a time: Exports.exportPng refuses a second request, and the buttons show it (disabled + aria-busy) until it ends.
  const PNG_BTNS = ['dlArtBtn', 'btnExportPng'];
  async function downloadPng() {
    if (PNG_BTNS.some(id => $(id).getAttribute('aria-busy') === 'true')) return null;
    PNG_BTNS.forEach(id => UI.setBusy($(id), true));
    try { return await Exports.exportPng(Store.get(), artName(), { transparent: $('exportTransparent').checked }); }
    finally { PNG_BTNS.forEach(id => UI.setBusy($(id), false)); }
  }
  $('dlArtBtn').onclick = downloadPng; $('btnExportPng').onclick = downloadPng;
  $('viewArtBtn').onclick = () => Exports.viewLarge(Store.get()); $('btnExportView').onclick = () => Exports.viewLarge(Store.get());
  $('openCardStudioBtn').onclick = () => Cards.open();
  $('viewAnimBtn').onclick = () => AnimUI.open();

  // Soundscape / Mute / Volume / WAV controls live in js/sound-ui.js (one controller for the stage bar and the Live-animation dialog).

  /* ======================================================================
     Stage foot: always ONE row at desktop widths. When it would not fit, labels fold to icons step by step
     (fold-1 View / Save / Card, fold-2 Live / Sound, fold-3 PNG); the Live + Sound pair never splits and nothing wraps,
     so the artwork keeps its height. Measured, not guessed, so it holds in every language and at every window width.
     ====================================================================== */
  const stageFoot = $('stageFoot');
  const phoneMQ = window.matchMedia('(max-width: 560px)');
  function footExtent() {
    const kids = Array.from(stageFoot.children).filter(el => el.offsetWidth);
    if (!kids.length) return 0;
    return kids[kids.length - 1].getBoundingClientRect().right - kids[0].getBoundingClientRect().left;
  }
  function fitStageFoot() {
    if (!stageFoot) return;
    stageFoot.classList.remove('fold-1', 'fold-2', 'fold-3');
    let level = 0;
    if (!phoneMQ.matches && stageFoot.clientWidth > 0) {
      const cs = getComputedStyle(stageFoot);
      const avail = stageFoot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      while (level < 3 && footExtent() > avail + 0.5) stageFoot.classList.add('fold-' + (++level));
    }
    stageFoot.querySelectorAll('[data-fold-at], #dlArtBtn').forEach(btn => {      // a folded button keeps its name as a tooltip
      if (btn.hasAttribute('data-i18n-tip')) return;
      const at = btn.id === 'dlArtBtn' ? 3 : Number(btn.dataset.foldAt);
      const lbl = btn.querySelector('.foot-lbl');
      if (level >= at && lbl) btn.dataset.tip = lbl.textContent.trim(); else delete btn.dataset.tip;
    });
  }
  if (stageFoot) {
    new ResizeObserver(fitStageFoot).observe(stageFoot);
    phoneMQ.addEventListener('change', fitStageFoot);
    document.addEventListener('langchange', fitStageFoot);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitStageFoot);
  }

  async function saveToBoard() {
    clearTimeout(settleTimer);
    const fresh = () => { const d = S.lastDrawn; return !!d && !d.draft && !rafPending && d.comp === Store.get(); };
    for (let i = 0; i < 2 && !fresh(); i++) await doRender(false);
    const d = S.lastDrawn;
    if (!d || d.draft || !S.metrics) { toast(t('err_render'), { type: 'error' }); return; }
    const r = Board.add(d.comp, artName(), S.metrics, Board.makeThumb(out));
    if (r === 'added') toast(t('board_saved'), { type: 'success', action: { label: t('open_board'), fn: () => setView('board') } });
    else if (r === 'duplicate') toast(t('board_dupe'), { type: 'info' });
    else toast(t('board_full', { n: Board.MAX_ITEMS }), { type: 'warn' });
  }
  $('saveCompare').onclick = saveToBoard;

  /* ---- project files ---- */
  $('btnSaveProject').onclick = () => Exports.saveProject(Store.get(), { name: artName(), animation: AnimUI.settings, sourceCount: Source.count, sourceNames: Source.files.map(f => f.name) });
  $('btnOpenProject').onclick = () => $('projectFile').click();
  $('projectFile').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const res = Exports.parseProject(await Exports.readTextFile(file));
      if (!res.ok) { toast(t(res.error), { type: 'error' }); return; }
      if (res.animation) AnimUI.applySettings(res.animation);
      S.egg = null; S.touched = true;
      Store.replace(Object.assign({}, res.comp, { palSrc: 'custom' }), {});
      if (res.name) $('heroName').value = res.name;
      toast(t(Source.count ? 'proj_loaded' : 'proj_loaded_nosrc', { name: res.name || file.name }), { type: 'success', ms: 5200 });
      noticeCountClamp(res.clamped);
      if (res.migrated) toast(t('proj_migrated'), { type: 'info', ms: 5200 });
    } catch (err) { toast(t(err && /^proj_/.test(err.message) ? err.message : 'proj_err_read'), { type: 'error' }); }
  });

  function restoreComp(comp, name) {
    S.egg = null; S.touched = true;
    Store.replace(Object.assign({}, comp, { palSrc: 'custom' }), {});
    if (name) $('heroName').value = name;
    setView('studio');
    toast(t('restored', { name: name || '' }), { type: 'success', action: { label: t('undo'), fn: () => Store.undo() } });
  }

  /* ======================================================================
     Randomize / remix
     ====================================================================== */
  function randomize(mode) {
    const comp = Store.get();
    const patch = Engine.randomPatch(comp, mode, null, Source.hasSamples());
    if (setComp(Engine.normalizePatch(comp, patch), {})) S.touched = true;
  }
  UI.menu($('btnRandom'), $('randomMenu'), item => randomize(item.dataset.rand));

  /* ======================================================================
     Variation gallery
     ====================================================================== */
  const V = { items: [], selected: new Set(), tok: 0 };
  function updateVarCompare() { $('btnVarCompare').disabled = !(V.selected.size >= 2 && V.selected.size <= 4); }
  function varCard(item, idx) {
    const card = UI.el('article', { class: 'var-card', 'data-id': item.id });
    card.innerHTML = `<label class="hero-select" data-tip="${UI.esc(t('board_select'))}"><input type="checkbox" data-act="select" aria-label="${UI.esc(t('var_select_n', { n: idx + 1 }))}"><span class="check-box" aria-hidden="true">${UI.icon('check')}</span></label>
      <div class="var-art"><canvas aria-label="${UI.esc(t('var_n', { n: idx + 1 }))}"></canvas></div>
      <div class="var-meta"><strong>${UI.esc(t('var_n', { n: idx + 1 }))}</strong><span class="mono muted small">${item.comp.seed} · ${item.comp.pseed}</span></div>
      <div class="var-actions">
        <button class="btn secondary sm" type="button" data-act="use">${UI.icon('reset')}<span>${UI.esc(t('var_use'))}</span></button>
        <button class="icon-btn" type="button" data-act="save" aria-label="${UI.esc(t('var_save_n', { n: idx + 1 }))}" data-tip="${UI.esc(t('save'))}">${UI.icon('bookmark')}</button>
        <button class="icon-btn" type="button" data-act="view" aria-label="${UI.esc(t('board_zoom_n', { name: t('var_n', { n: idx + 1 }) }))}" data-tip="${UI.esc(t('board_zoom'))}">${UI.icon('expand')}</button>
        <button class="icon-btn" type="button" data-act="download" aria-label="${UI.esc(t('var_dl_n', { n: idx + 1 }))}" data-tip="${UI.esc(t('btn_dl'))}">${UI.icon('download')}</button>
      </div>`;
    return card;
  }
  async function generateVariations() {
    const base = Store.get(), mode = $('varMode').value, n = parseInt($('varCount').value, 10) || 9;
    const tok = ++V.tok, grid = $('varGrid');
    V.items = []; V.selected.clear(); grid.innerHTML = ''; updateVarCompare();
    UI.setBusy($('btnVarGenerate'), true); $('varNote').textContent = t('var_working', { i: 0, n });
    const size = Engine.targetSize(base), k = 340 / Math.max(size.w, size.h), cw = Math.max(2, Math.round(size.w * k)), ch = Math.max(2, Math.round(size.h * k));
    const rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
    for (let i = 0; i < n; i++) {
      if (tok !== V.tok) return;
      let patch = mode === 'all' ? { seed: Engine.newSeed(), pseed: Engine.newSeed() } : Engine.randomPatch(base, mode, rng, Source.hasSamples());
      const merged = Object.assign({}, base, patch);
      if (merged.palSrc === 'image' && Source.hasSamples() && 'pseed' in patch) {
        const d = Source.derive(merged); if (d) patch = Object.assign({}, patch, { basePalette: d.basePalette, bgBase: d.bgBase });
      }
      const comp = Engine.sanitize(Object.assign({}, base, Engine.normalizePatch(base, patch)));
      if (Engine.validate(comp).length) { i--; continue; }
      const item = { id: 'v' + tok + '_' + i, comp, name: t('var_n', { n: i + 1 }), w: size.w, h: size.h, metrics: null };
      const card = varCard(item, i); grid.appendChild(card);
      const canvas = card.querySelector('canvas');
      try { await renderCanvas(Engine.buildParams(comp), canvas, cw, ch, 0, { cancel: () => tok !== V.tok }); } catch (e) { console.error(e); }
      if (tok !== V.tok) return;
      item.metrics = computeMetrics(canvas); item.canvas = canvas; V.items.push(item);
      $('varNote').textContent = t('var_working', { i: i + 1, n });
      await new Promise(r => setTimeout(r, 0));
    }
    UI.setBusy($('btnVarGenerate'), false); $('varNote').textContent = t('var_done', { n: V.items.length });
    $('varGenLabel').textContent = t('var_more');
  }
  $('btnVariations').onclick = () => { UI.open('variationsModal'); if (!V.items.length) generateVariations(); };
  $('btnVarGenerate').onclick = generateVariations;
  $('variationsModal').addEventListener('close', () => { V.tok++; UI.setBusy($('btnVarGenerate'), false); });
  $('varGrid').addEventListener('click', async e => {
    const card = e.target.closest('.var-card'); if (!card) return;
    const item = V.items.find(v => v.id === card.dataset.id); if (!item) return;
    const act = e.target.closest('[data-act]'); if (!act) return;
    if (act.dataset.act === 'use') { UI.close('variationsModal'); S.egg = null; S.touched = true; Store.replace(item.comp, {}); toast(t('var_applied'), { type: 'success', action: { label: t('undo'), fn: () => Store.undo() } }); }
    else if (act.dataset.act === 'save') {
      const r = Board.add(item.comp, item.name, item.metrics, Board.makeThumb(item.canvas));
      toast(r === 'added' ? t('board_saved') : r === 'duplicate' ? t('board_dupe') : t('board_full', { n: Board.MAX_ITEMS }), { type: r === 'added' ? 'success' : 'info' });
    } else if (act.dataset.act === 'view') Exports.viewLarge(item.comp);
    else if (act.dataset.act === 'download') Exports.exportPng(item.comp, item.name);
  });
  $('varGrid').addEventListener('change', e => {
    if (!e.target.matches('[data-act="select"]')) return;
    const id = e.target.closest('.var-card').dataset.id;
    if (e.target.checked) V.selected.add(id); else V.selected.delete(id);
    e.target.closest('.var-card').classList.toggle('is-selected', e.target.checked);
    updateVarCompare();
  });
  $('btnVarCompare').onclick = () => Board.openCompare(V.items.filter(v => V.selected.has(v.id)));

  /* ======================================================================
     Presentation mode
     ====================================================================== */
  let presentIdle = 0;
  async function renderPresent() {
    if (!S.present) return;
    const c = $('presentCanvas'), comp = Store.get(), size = Engine.targetSize(comp);
    const vw = window.innerWidth, vh = window.innerHeight, fit = Math.min(vw / size.w, vh / size.h) * (S.presentInfo ? 0.86 : 0.97);
    const cssW = Math.max(40, Math.floor(size.w * fit)), cssH = Math.max(40, Math.floor(size.h * fit));
    const dpr = Math.min(window.devicePixelRatio || 1, 2), k = Math.min(1, 2400 / Math.max(cssW * dpr, cssH * dpr));
    c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
    const tok = ++S.presentTok;
    try { await renderCanvas(Engine.buildParams(comp), c, Math.round(cssW * dpr * k), Math.round(cssH * dpr * k), 0, { cancel: () => tok !== S.presentTok }); } catch (e) { console.error(e); }
    updatePresentInfo();
  }
  const renderPresentSoon = UI.debounce(renderPresent, 120);
  function updatePresentInfo() {
    const info = $('presentInfo'), comp = Store.get(), size = Engine.targetSize(comp);
    info.classList.toggle('hidden', !S.presentInfo);
    $('presentInfoBtn').setAttribute('aria-pressed', S.presentInfo ? 'true' : 'false');
    info.innerHTML = '';
    info.appendChild(UI.el('strong', { class: 'pi-name' }, artName()));
    info.appendChild(UI.el('span', { class: 'muted' }, t('style_' + comp.style) + ' · ' + size.w + ' × ' + size.h + ' px'));
    const dots = UI.el('div', { class: 'pi-dots' });
    railItems(comp, 8).forEach(it => dots.appendChild(UI.el('i', { style: { background: hexOf(it) }, title: hexOf(it) })));
    info.appendChild(dots);
  }
  function openPresent() {
    if (S.present) return;
    S.present = true; S.presentReturn = document.activeElement;
    $('presentLayer').classList.remove('hidden'); document.body.classList.add('is-present');
    renderPresent(); $('presentExit').focus();
    wakePresent();
  }
  function closePresent() {
    if (!S.present) return;
    S.present = false; S.presentTok++;
    $('presentLayer').classList.add('hidden'); document.body.classList.remove('is-present');
    if (S.presentReturn && document.contains(S.presentReturn)) { try { S.presentReturn.focus(); } catch (e) { /* ignore */ } }
  }
  function wakePresent() {
    const bar = $('presentBar'); bar.classList.remove('idle'); clearTimeout(presentIdle);
    presentIdle = setTimeout(() => bar.classList.add('idle'), 2600);
  }
  $('presentLayer').addEventListener('pointermove', wakePresent);
  $('presentLayer').addEventListener('keydown', e => {
    wakePresent();
    if (e.key === 'Tab') {
      const f = Array.from($('presentBar').querySelectorAll('button')), i = f.indexOf(document.activeElement);
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  });
  $('btnPresent').onclick = openPresent; $('presentExit').onclick = closePresent;
  $('presentInfoBtn').onclick = () => { S.presentInfo = !S.presentInfo; renderPresent(); };
  $('presentRemix').onclick = () => randomize('remix');
  $('presentSave').onclick = downloadPng;
  window.addEventListener('resize', UI.debounce(() => { if (S.present) renderPresent(); }, 160));

  /* ======================================================================
     Views, drawers, history buttons, language
     ====================================================================== */
  const viewTabs = UI.tabs($('viewTabs'), { onSelect: b => setView(b.dataset.view) });
  function setView(v) {
    S.view = v; document.body.dataset.view = v; closeDrawers();
    $$('[data-view-panel]').forEach(p => { p.hidden = p.dataset.viewPanel !== v; });
    const b = viewTabs.byValue('view', v);
    Array.from($('viewTabs').querySelectorAll('[role="tab"]')).forEach(x => { const on = x === b; x.setAttribute('aria-selected', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; });
    if (v === 'studio') { fitCanvas(); if (S.thumbsDirty) scheduleThumbs(); }
    if (v === 'lab') ColorLab.onShow();
    if (v === 'board') Board.render();
  }
  function closeDrawers() {
    document.body.classList.remove('drawer-left', 'drawer-right');
    $('btnPanelLeft').setAttribute('aria-expanded', 'false'); $('btnPanelRight').setAttribute('aria-expanded', 'false'); $('scrim').hidden = true;
  }
  function toggleDrawer(side) {
    const cls = 'drawer-' + side, on = !document.body.classList.contains(cls);
    closeDrawers();
    if (on) { document.body.classList.add(cls); $('scrim').hidden = false; $(side === 'left' ? 'btnPanelLeft' : 'btnPanelRight').setAttribute('aria-expanded', 'true'); }
  }
  $('btnPanelLeft').onclick = () => toggleDrawer('left'); $('btnPanelRight').onclick = () => toggleDrawer('right');
  $('scrim').onclick = closeDrawers;
  UI.tabs($('inspectorTabs'), { onSelect: b => {
    if (b.dataset.tab === 'look' && S.thumbsDirty) scheduleThumbs();
    if (b.dataset.tab === 'analyze') renderAnalyze();
    if (b.dataset.tab === 'export') updatePalPreview();
  } });
  $('btnUndo').onclick = () => Store.undo(); $('btnRedo').onclick = () => Store.redo();
  $('langBtn').onclick = () => setLang(currentLang === 'en' ? 'vi' : 'en');
  $('btnHelp').onclick = () => UI.open('helpModal');
  new ResizeObserver(UI.debounce(() => { fitCanvas(); if (!$('tab-analyze').hidden) renderAnalyze(); }, 60)).observe($('canvasWrap'));

  function buildShortcuts() {
    UI.shortcuts($('shortcutList'), [
      [['Ctrl', 'Z'], 'sc_undo'], [['Ctrl', 'Shift', 'Z'], 'sc_redo'], [['G'], 'sc_generate'], [['R'], 'sc_remix'], [['Shift', 'R'], 'sc_random'],
      [['V'], 'sc_variations'], [['S'], 'sc_save'], [['E'], 'sc_export'], [['M'], 'sc_sound'], [['P'], 'sc_present'], [['1'], 'sc_view_studio'], [['2'], 'sc_view_lab'],
      [['3'], 'sc_view_board'], [['?'], 'sc_help'], [['Esc'], 'sc_close']
    ]);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (S.present) { e.preventDefault(); closePresent(); } else if (document.body.classList.contains('drawer-left') || document.body.classList.contains('drawer-right')) closeDrawers(); return; }
    if (e.defaultPrevented || UI.isTyping(e) || document.querySelector('dialog[open]') || S.present) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && !e.altKey && k === 'z') { e.preventDefault(); if (e.shiftKey) Store.redo(); else Store.undo(); return; }
    if (mod && !e.altKey && k === 'y') { e.preventDefault(); Store.redo(); return; }
    if (mod || e.altKey) return;
    if (e.repeat) return;
    if (k === '?' || (k === '/' && e.shiftKey)) { e.preventDefault(); UI.open('helpModal'); }
    else if (k === 'g') { e.preventDefault(); setView('studio'); generate(); }
    else if (k === 'r') { e.preventDefault(); randomize(e.shiftKey ? 'all' : 'remix'); }
    else if (k === 'v') { e.preventDefault(); setView('studio'); $('btnVariations').click(); }
    else if (k === 's') { e.preventDefault(); saveToBoard(); }
    else if (k === 'e') { e.preventDefault(); downloadPng(); }
    else if (k === 'm' && $('btnSoundscape')) { e.preventDefault(); $('btnSoundscape').click(); }
    else if (k === 'p') { e.preventDefault(); openPresent(); }
    else if (k === '1') setView('studio'); else if (k === '2') setView('lab'); else if (k === '3') setView('board');
  });

  /* ======================================================================
     Session: reopen where you left off (palette travels with the comp; source images do not)
     ====================================================================== */
  const SESSION_KEY = 'fms-session';
  const persistSoon = UI.debounce(() => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, comp: Object.assign({}, Store.get(), { legacy: null }), name: $('heroName').value })); } catch (e) { /* ignore */ }
  }, 900);
  function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY); if (!raw) return false;
      const d = JSON.parse(raw); if (!d || !d.comp) return false;
      Store.init(Engine.fromSaved(Object.assign({}, d.comp, { palSrc: 'custom' })));
      if (typeof d.name === 'string') $('heroName').value = d.name.slice(0, 60);
      S.touched = true; return true;
    } catch (e) { return false; }
  }

  /* ======================================================================
     Store subscription + boot
     ====================================================================== */
  Store.on((comp, prev, info) => {
    syncControls(comp);
    const draft = !!(info.meta && info.meta.draft);
    const keys = info.changed;
    if (keys.some(k => ['basePalette', 'seed', 'pseed', 'hue', 'satAdj', 'valAdj', 'bgMode', 'bgColor', 'bgBase', 'count', 'harmony', 'turb', 'angleMode', 'angleDeg', 'paperMode', 'polyMode', 'crystalMode', 'auroraMode', 'chromaMode'].includes(k))) S.thumbsDirty = true;
    requestRender(draft);
    persistSoon();
    if (!draft) { if (!$('tab-export').hidden) updatePalPreview(); else S.exportDirty = true; }
  });

  document.addEventListener('langchange', () => {
    buildPresetGrid(); syncControls(Store.get()); renderThumbs(); updateSourceUI(); renderRail(Store.get()); renderAnalyze(); updatePalPreview(); buildShortcuts();
    Board.render(); if (S.present) updatePresentInfo();
    $('seedLabel').dataset.tip = t('seed_tip');
    $('btnUndo').dataset.tip = t('undo') + ' (Ctrl+Z)'; $('btnRedo').dataset.tip = t('redo') + ' (Ctrl+Shift+Z)';
    $('btnPresent').dataset.tip = t('present') + ' (P)'; $('btnHelp').dataset.tip = t('shortcuts') + ' (?)';
    $('btnRailCss').dataset.tip = t('rail_css_tip');
    $('btnSeedDice').dataset.tip = t('seed_new_shape'); $('btnPSeedDice').dataset.tip = t('seed_new_color');
    $('heroName').placeholder = t('t_name_ph');
  });

  function init() {
    UI.init();
    initLang();
    Source.renderThumbs($('preview'), {});
    buildPresetGrid(); buildShortcuts();
    Board.init();
    ColorLab.init();
    Cards.init();
    if (!restoreSession()) Store.init({ seed: Engine.newSeed(), pseed: Engine.newSeed() });
    syncControls(Store.get());
    updateSourceUI();
    setView('studio');
    requestRender(false);
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: currentLang } }));
    document.documentElement.setAttribute('data-fms-ready', '1');      // tells the boot guard in index.html that start-up finished (it shows an explanation otherwise)
  }

  const api = {
    artName, getParams: () => S.params || Engine.buildParams(Store.get()), restoreComp, setView, randomize, generate, saveToBoard, computeMetrics,
    getMetrics: () => S.metrics, getSrcMetrics: () => S.srcMetrics, getArtCanvas: () => out,
    paletteItems: () => Engine.paletteItems(Store.get()), railItems: n => railItems(Store.get(), n || 10),
    applyComp: (patch, opts) => setComp(patch, opts), toast
  };
  window.addEventListener('DOMContentLoaded', () => {});
  init();
  return api;
})();