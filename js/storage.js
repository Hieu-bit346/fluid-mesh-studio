/* ==========================================================================
   storage.js — the Comparison Board: saved artworks, ranking, side-by-side compare, composite sheets.

   A board item is { id, name, thumb, comp, metrics, w, h, savedAt }. The picture is *always re-rendered from comp*
   (never from stored render params), so hue shifts, grain, size changes and reloads cannot corrupt a saved item —
   that was the root of two bugs in the original board.

   Persistence: localStorage 'fluidStudioV6'. Boards saved by the previous version ('fluidStudioV5') are migrated once.
   Browser storage is small and can be unavailable, so every read/write is guarded and a failed write is reported.
   ========================================================================== */
const Board = (function () {
  'use strict';
  const KEY = 'fluidStudioV6', OLD_KEY = 'fluidStudioV5', MAX_ITEMS = 60, COMPOSITE_MAX = 8, COMPARE_MAX = 4;
  // Thumbnails: 448 px square (cards show ~300 px, so a 1x screen downsamples instead of enlarging a 192 px picture 1.6x).
  // THUMB_V marks items whose thumbnail has this size; older ones are upgraded in the background (see upgradeThumbs).
  const THUMB_SIDE = 448, THUMB_V = 2, THUMB_BUDGET = 28000;      // budget = data-URL characters per thumbnail (60 items stay well inside the ~5 MB localStorage quota)
  let items = [];
  // Two separate selections: the side-by-side comparison holds at most 4, the composite sheet at most 8.
  // They never share state, so ticking something for one cannot change or cap the other.
  const cmpSel = new Set(), colSel = new Set();
  let warnedStorage = false;
  const num = v => (Number.isFinite(v) ? v : 0);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- persistence ---------- */
  function cleanMetrics(m) {
    const o = {}; METRIC_DEFS.forEach(d => { o[d.key] = Math.min(100, Math.max(0, num(m && m[d.key]))); });
    return o;
  }
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/, THUMB_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+\/=]*$/;
  function validItem(it) {
    if (!it || typeof it !== 'object' || !it.comp) return null;
    try {
      const thumb = typeof it.thumb === 'string' && it.thumb.length < 400000 && THUMB_RE.test(it.thumb) ? it.thumb : '';
      return { id: typeof it.id === 'string' && ID_RE.test(it.id) ? it.id : uid(), name: String(it.name || 'Untitled').slice(0, 60),
        thumb, tv: thumb && it.tv === THUMB_V ? THUMB_V : 0,
        comp: Engine.fromSaved(it.comp), metrics: cleanMetrics(it.metrics), w: num(it.w) || 1024, h: num(it.h) || 1024, savedAt: num(it.savedAt) };
    } catch (e) { return null; }
  }
  function load() {
    items = [];
    let raw = null, migrated = false;
    try { raw = localStorage.getItem(KEY); if (raw === null) { raw = localStorage.getItem(OLD_KEY); migrated = raw !== null; } } catch (e) { return; }
    if (!raw) return;
    let data; try { data = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(data)) return;
    for (const it of data.slice(0, MAX_ITEMS)) {
      let v = null;
      if (migrated || (it && it.params && !it.comp)) {
        try { v = validItem({ id: uid(), name: it.name, thumb: it.thumb, comp: Engine.legacyToComp(it), metrics: it.metrics, w: it.w, h: it.h, savedAt: Date.now() }); } catch (e) { v = null; }
      } else v = validItem(it);
      if (v) { if (items.some(x => x.id === v.id)) v.id = uid(); items.push(v); }
    }
    if (migrated && items.length) save();
  }
  function save(quiet) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.map(i => ({ id: i.id, name: i.name, thumb: i.thumb, tv: i.tv || 0, comp: i.comp, metrics: i.metrics, w: i.w, h: i.h, savedAt: i.savedAt }))));
      warnedStorage = false; return true;
    } catch (e) {
      if (!quiet && !warnedStorage) { warnedStorage = true; UI.toast(t('err_storage'), { type: 'warn', ms: 9000 }); }
      return false;
    }
  }

  /* ---------- mutations ---------- */
  function sameComp(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  /** Returns 'added' | 'duplicate' | 'full' */
  function add(comp, name, metrics, thumb) {
    if (items.some(i => sameComp(i.comp, comp))) return 'duplicate';
    if (items.length >= MAX_ITEMS) return 'full';
    const size = Engine.targetSize(comp);
    items.push({ id: uid(), name: name || 'Obj ' + (items.length + 1), thumb: thumb || '', tv: thumb ? THUMB_V : 0, comp: JSON.parse(JSON.stringify(comp)), metrics: cleanMetrics(metrics), w: size.w, h: size.h, savedAt: Date.now() });
    save(); render();
    return 'added';
  }
  function remove(id) {
    const i = items.findIndex(x => x.id === id); if (i < 0) return;
    const removed = { item: items[i], index: i };       // each toast undoes only its own removal
    items.splice(i, 1); cmpSel.delete(id); colSel.delete(id); save(); render();
    const undo = () => {
      if (items.some(x => x.id === removed.item.id)) return;
      if (items.length >= MAX_ITEMS) { UI.toast(t('board_full', { n: MAX_ITEMS }), { type: 'warn' }); return; }
      items.splice(Math.min(removed.index, items.length), 0, removed.item); save(); render();
    };
    UI.toast(t('board_removed'), { action: { label: t('undo'), fn: undo }, ms: 6000 });
  }
  async function clearAll() {
    if (!items.length) return;
    if (!await UI.confirm(t('board_clear_q'), { danger: true, yes: t('btn_clearboard') })) return;
    items = []; cmpSel.clear(); colSel.clear();
    try { localStorage.setItem(KEY, '[]'); localStorage.removeItem(OLD_KEY); } catch (e) { /* storage unavailable */ }   // '[]' (not removeItem) so load() never falls back to the old v5 board
    render();
    const ab = document.activeElement;                                   // the Clear button just disappeared: keep keyboard focus somewhere sensible
    if (!ab || ab === document.body || ab.closest('[hidden], .hidden')) { const tab = document.querySelector('.view-tab[data-view="board"]'); if (tab) tab.focus(); }
  }

  /* ---------- rendering the board ---------- */
  const strip = (comp, n) => Engine.paletteItems(comp, n).map(c => `<i style="background:${CM_hex(c)}"></i>`).join('');
  const CM_hex = c => ColorMath.fmtHex(c, false);

  function rankBoxes() {
    return METRIC_DEFS.map(def => {
      const top = [...items].sort((a, b) => b.metrics[def.key] - a.metrics[def.key]).slice(0, 3);
      return `<div class="rank-box" style="--mc:${def.color}"><h4><span class="rank-ico" aria-hidden="true">${def.icon}</span> ${UI.esc(t('top_n', { metric: t(def.label) }))}</h4>` +
        top.map((h, i) => `<div class="rank-item" data-tid="${UI.esc(h.id)}"><b class="rank-pos">#${i + 1}</b>${h.thumb ? `<img src="${UI.esc(h.thumb)}" alt="">` : '<span class="thumb-ph"></span>'}<span class="rank-name">${UI.esc(h.name)}</span><b class="rank-val">${h.metrics[def.key].toFixed(1)}%</b></div>`).join('') + '</div>';
    }).join('');
  }
  function heroCard(h, i) {
    const sel = cmpSel.has(h.id), inCol = colSel.has(h.id);
    const rows = METRIC_DEFS.map(def => `<div class="mini-metric"><span>${def.icon} ${UI.esc(t(def.label))}</span><b style="color:${def.color}">${h.metrics[def.key].toFixed(1)}%</b></div>`).join('');
    return `<article class="hero-card${sel ? ' is-selected' : ''}" data-id="${UI.esc(h.id)}">
      <label class="hero-select" data-tip="${UI.esc(t('board_select'))}"><input type="checkbox" data-act="select" ${sel ? 'checked' : ''} aria-label="${UI.esc(t('board_select_n', { name: h.name }))}"><span class="check-box" aria-hidden="true">${UI.icon('check')}</span></label>
      <button class="hero-collage" type="button" data-act="collage" aria-pressed="${inCol ? 'true' : 'false'}" aria-label="${UI.esc(t('board_collage_n', { name: h.name }))}" data-tip="${UI.esc(t('board_collage_tip'))}">${UI.icon('grid')}</button>
      <div class="hero-thumb" data-tid="${UI.esc(h.id)}">${h.thumb ? `<img src="${UI.esc(h.thumb)}" alt="${UI.esc(h.name)}">` : '<span class="thumb-ph"></span>'}
        <button class="img-zoom-btn" type="button" data-act="zoom" aria-label="${UI.esc(t('board_zoom_n', { name: h.name }))}" data-tip="${UI.esc(t('board_zoom'))}">${UI.icon('expand')}</button></div>
      <div class="hero-body">
        <strong class="hero-name" title="${UI.esc(h.name)}">${UI.esc(h.name)}</strong>
        <div class="hero-meta mono">${h.w}×${h.h} · ${UI.esc(t('style_' + h.comp.style))}</div>
        <div class="palette-strip" aria-hidden="true">${strip(h.comp, 10)}</div>
        <div class="hero-metrics">${rows}</div>
        <div class="hero-actions">
          <button class="btn secondary sm" type="button" data-act="restore">${UI.icon('reset')}<span>${UI.esc(t('board_restore'))}</span></button>
          <button class="icon-btn" type="button" data-act="download" aria-label="${UI.esc(t('board_download_n', { name: h.name }))}" data-tip="${UI.esc(t('btn_dl'))}">${UI.icon('download')}</button>
          <button class="icon-btn danger" type="button" data-act="remove" aria-label="${UI.esc(t('board_remove_n', { name: h.name }))}" data-tip="${UI.esc(t('board_remove'))}">${UI.icon('trash')}</button>
        </div></div></article>`;
  }

  function render() {
    const wrap = $('compareWrapper'), badge = $('boardBadge');
    badge.textContent = items.length; badge.hidden = !items.length;
    $('boardSub').textContent = items.length ? t('board_sub', { n: items.length }) : '';
    for (const set of [cmpSel, colSel]) { const keep = [...set].filter(id => items.some(i => i.id === id)); set.clear(); keep.forEach(id => set.add(id)); }
    $('boardSelectBar').classList.toggle('hidden', !items.length);
    $('makeComposite').classList.toggle('hidden', items.length < 2);
    $('clearCompare').classList.toggle('hidden', !items.length);
    if (!items.length) {
      wrap.innerHTML = `<div class="empty-state"><svg class="i empty-ico"><use href="#i-layers"/></svg><h3>${UI.esc(t('board_empty_title'))}</h3><p class="muted">${UI.esc(t('board_empty_text'))}</p></div>`;
      syncSelection();
      return;
    }
    wrap.innerHTML = `<div class="rank-grid">${rankBoxes()}</div><div class="hero-grid">${items.map(heroCard).join('')}</div>`;
    syncSelection();
    scheduleUpgrade();
  }

  /* ---------- selection (comparison: max 4, composite: max 8; independent) ---------- */
  let msgTimer = 0;
  function say(id, text) {                                         // a short notice next to the group it belongs to, back to the plain hint after a while
    const el = $(id), hint = id === 'cmpMsg' ? 'board_cmp_hint' : 'board_col_hint';
    el.textContent = text; el.classList.toggle('is-warn', text !== t(hint));
    clearTimeout(msgTimer); if (text !== t(hint)) msgTimer = setTimeout(() => { el.textContent = t(hint); el.classList.remove('is-warn'); }, 7000);
  }
  function flash(el) { el.classList.remove('is-bump'); void el.offsetWidth; el.classList.add('is-bump'); }
  function syncSelection() {
    document.querySelectorAll('#compareWrapper .hero-card').forEach(card => {
      const id = card.dataset.id, a = cmpSel.has(id), b = colSel.has(id);
      card.classList.toggle('is-selected', a); card.classList.toggle('is-collage', b);
      const cb = card.querySelector('[data-act="select"]'); if (cb && cb.checked !== a) cb.checked = a;
      const ct = card.querySelector('[data-act="collage"]'); if (ct) ct.setAttribute('aria-pressed', b ? 'true' : 'false');
    });
    const n = cmpSel.size, m = colSel.size, enough = items.length >= 2;
    $('cmpCount').textContent = n + '/' + COMPARE_MAX; $('cmpCount').setAttribute('aria-label', t('board_sel_count', { n, max: COMPARE_MAX }));
    $('colCount').textContent = m + '/' + COMPOSITE_MAX; $('colCount').setAttribute('aria-label', t('board_sel_count', { n: m, max: COMPOSITE_MAX }));
    $('cmpCount').classList.toggle('is-full', n >= COMPARE_MAX); $('colCount').classList.toggle('is-full', m >= COMPOSITE_MAX);
    $('btnBoardCompare').disabled = n < 2;
    $('btnCmpFirst').disabled = $('btnCmpRandom').disabled = !enough;
    $('btnCmpClear').disabled = n === 0; $('btnColClear').disabled = m === 0;
    if (n < COMPARE_MAX && $('cmpMsg').classList.contains('is-warn')) say('cmpMsg', t('board_cmp_hint'));
    if (m < COMPOSITE_MAX && $('colMsg').classList.contains('is-warn')) say('colMsg', t('board_col_hint'));
  }
  const setCompare = ids => { cmpSel.clear(); ids.slice(0, COMPARE_MAX).forEach(id => cmpSel.add(id)); syncSelection(); };
  function pickFirst() { setCompare(items.slice(0, COMPARE_MAX).map(i => i.id)); }
  /** A random group of 4 (all of them when there are fewer); pressing it again always gives a different group when one exists. */
  function pickRandom() {
    const ids = items.map(i => i.id), k = Math.min(COMPARE_MAX, ids.length), key = g => g.slice().sort().join('|'), cur = key([...cmpSel]);
    let g = ids.slice(0, k);
    for (let tries = 0; tries < 24; tries++) {
      const a = ids.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; }
      g = a.slice(0, k);
      if (ids.length <= k || key(g) !== cur) break;
    }
    setCompare(g);
  }
  function toggleCompare(id, on, box) {
    if (on) {
      if (!cmpSel.has(id) && cmpSel.size >= COMPARE_MAX) {                  // a 5th one is refused, never silently kept
        if (box) box.checked = false;
        say('cmpMsg', t('board_compare_max')); flash($('cmpCount'));
        UI.toast(t('board_compare_max'), { type: 'warn' });
        return false;
      }
      cmpSel.add(id);
    } else cmpSel.delete(id);
    syncSelection(); return true;
  }
  function toggleCollage(id) {
    if (colSel.has(id)) colSel.delete(id);
    else {
      if (colSel.size >= COMPOSITE_MAX) { const m = t('composite_max', { n: COMPOSITE_MAX }); say('colMsg', m); flash($('colCount')); UI.toast(m, { type: 'warn' }); return false; }
      colSel.add(id);
    }
    syncSelection(); return true;
  }

  /* ---------- thumbnails ---------- */
  const WEBP_OK = (() => { try { return document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) { return false; } })();
  /** Centre square of a canvas (cover crop) at `side` px. Large sources are halved step by step first so the downscale stays sharp. */
  function squareThumb(src, side) {
    const m = Math.min(src.width, src.height);
    let cur = src, cx = (src.width - m) / 2, cy = (src.height - m) / 2, cw = m;
    while (cw / 2 >= side) {
      const half = document.createElement('canvas'); half.width = half.height = Math.ceil(cw / 2);
      const x = half.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, cx, cy, cw, cw, 0, 0, half.width, half.height);
      if (cur !== src) cur.width = cur.height = 1;
      cur = half; cx = cy = 0; cw = half.width;
    }
    const out = document.createElement('canvas'); out.width = out.height = side;
    const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cur, cx, cy, cw, cw, 0, 0, side, side);
    if (cur !== src) cur.width = cur.height = 1;
    return out;
  }
  /** WebP when the browser can encode it (about 30-45% smaller than JPEG at the same look), JPEG otherwise; quality steps down only if a noisy picture would be too big. */
  function encodeThumb(c) {
    const fmt = WEBP_OK ? 'image/webp' : 'image/jpeg';
    let url = '';
    for (const q of [0.82, 0.72, 0.62, 0.5]) { url = c.toDataURL(fmt, q); if (url.length <= THUMB_BUDGET) break; }
    return url;
  }
  /** Square, aspect-correct thumbnail of a canvas (cover crop). */
  function makeThumb(canvas, side) {
    side = side || THUMB_SIDE;
    const sq = squareThumb(canvas, side); let url = encodeThumb(sq); sq.width = sq.height = 1;
    if (url.length > THUMB_BUDGET * 1.6 && side > 320) { const small = squareThumb(canvas, 320); url = encodeThumb(small); small.width = small.height = 1; }   // extreme grain: trade size for bytes
    return url;
  }

  /** Re-draw the thumbnail from the saved comp at the item's own aspect ratio, then crop exactly like makeThumb does for a fresh save. */
  async function thumbFromComp(item) {
    const size = Engine.targetSize(item.comp);
    const k = Math.min(640 / Math.min(size.w, size.h), 1536 / Math.max(size.w, size.h));
    const c = await Exports.renderComp(item.comp, { w: Math.max(16, Math.round(size.w * k)), h: Math.max(16, Math.round(size.h * k)) });
    if (!c) return '';
    const url = makeThumb(c); c.width = c.height = 1;
    return url;
  }
  const loadImg = url => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
  /** True when two thumbnails show the same picture (mean RGB difference of a 16 x 16 reduction). A replacement that disagrees with the old one is never used. */
  async function sameLook(oldUrl, newUrl) {
    const [a, b] = await Promise.all([loadImg(oldUrl), loadImg(newUrl)]);
    const px = im => { const c = document.createElement('canvas'); c.width = c.height = 16; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, 16, 16); return x.getImageData(0, 0, 16, 16).data; };
    const A = px(a), B = px(b); let sum = 0, n = 0;
    for (let i = 0; i < A.length; i += 4) { sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]); n += 3; }
    return sum / n <= 26;
  }
  function patchThumb(it) {
    document.querySelectorAll('[data-tid]').forEach(box => {
      if (box.dataset.tid !== it.id) return;
      let im = box.querySelector('img');
      if (!im) {
        const ph = box.querySelector('.thumb-ph'); im = document.createElement('img'); im.alt = box.classList.contains('hero-thumb') ? it.name : '';
        if (ph) ph.replaceWith(im); else box.prepend(im);
      }
      im.src = it.thumb;
    });
  }
  /** Old (192 px) or missing thumbnails are redrawn one at a time in the background, only when the new picture matches the old one and
   *  the browser can still store it; otherwise the old thumbnail stays exactly as it was. Nothing is ever deleted. */
  let upgrading = null;
  const needsUpgrade = i => i.tv !== THUMB_V || !i.thumb;
  function scheduleUpgrade() {
    if (upgrading || !items.some(i => needsUpgrade(i) && !i._skip)) return;
    upgrading = (async () => {
      await new Promise(r => setTimeout(r, 500));                    // let the page finish starting up first
      for (const it of items.slice()) {
        if (!items.includes(it) || !needsUpgrade(it) || it._skip) continue;
        try {
          const url = await thumbFromComp(it);
          if (!items.includes(it)) continue;
          if (!url || (it.thumb && !await sameLook(it.thumb, url))) { it._skip = true; continue; }
          const prev = { thumb: it.thumb, tv: it.tv };
          it.thumb = url; it.tv = THUMB_V;
          if (!save(true)) { it.thumb = prev.thumb; it.tv = prev.tv; it._skip = true; break; }     // storage is full: keep the old pictures and stop
          patchThumb(it);
        } catch (e) { it._skip = true; }
        await new Promise(r => setTimeout(r, 40));
      }
    })().finally(() => { upgrading = null; });
    return upgrading;
  }

  /* ---------- side-by-side compare ---------- */
  async function openCompare(list) {
    const chosen = (list || items.filter(i => cmpSel.has(i.id))).slice(0, COMPARE_MAX);
    if (chosen.length < 2) return;
    const body = $('compareBody'); body.innerHTML = '';
    body.style.setProperty('--cols', Math.min(COMPARE_MAX, chosen.length));
    body.style.setProperty('--rows', 4 + METRIC_DEFS.length);          // art, name, size line, palette, then one row per metric: the columns share these rows (subgrid), so they line up
    const best = {}; METRIC_DEFS.forEach(d => { best[d.key] = Math.max(...chosen.map(c => c.metrics[d.key])); });
    const cols = chosen.map(h => {
      const col = UI.el('div', { class: 'cmp-col' });
      col.innerHTML = `<div class="cmp-art"><canvas aria-label="${UI.esc(h.name)}"></canvas></div><strong class="cmp-name">${UI.esc(h.name)}</strong>
        <div class="hero-meta mono">${h.w}×${h.h} · ${UI.esc(t('style_' + h.comp.style))}</div><div class="palette-strip big" aria-hidden="true">${strip(h.comp, 10)}</div>` +
        METRIC_DEFS.map(def => { const v = h.metrics[def.key], top = v === best[def.key] && chosen.length > 1;
          return `<div class="cmp-metric${top ? ' is-best' : ''}"><div class="metric-head"><span class="metric-label">${def.icon} ${UI.esc(t(def.label))}</span><span class="metric-val">${v.toFixed(1)}%</span></div>${top ? `<em class="best-tag">${UI.esc(t('cmp_highest'))}</em>` : ''}<div class="bar"><i style="width:${v}%;background:${def.color}"></i></div></div>`; }).join('');
      body.appendChild(col);
      return { h, canvas: col.querySelector('canvas') };
    });
    UI.open('compareModal');
    for (const { h, canvas } of cols) {
      const k = 520 / Math.max(h.w, h.h);
      try { await renderCanvas(Engine.buildParams(h.comp), canvas, Math.round(h.w * k), Math.round(h.h * k), 0); } catch (e) { console.error(e); }
    }
  }

  /* ---------- composite sheet ---------- */
  let compositeCanvas = null, compositeUrl = '', compositeList = [];
  async function buildComposite(list, cols) {
    const n = list.length, tile = 1024, gap = 8, rows = Math.ceil(n / cols);
    const used = Math.min(cols, n);
    const canvas = document.createElement('canvas');
    canvas.width = used * tile + (used - 1) * gap; canvas.height = rows * tile + (rows - 1) * gap;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0c0c0f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < n; i++) {
      UI.busy(true, t('composite_progress', { i: i + 1, n }));
      const row = Math.floor(i / cols), inRow = row === rows - 1 ? n - row * cols : cols, col = i % cols;
      const x = (canvas.width - (inRow * tile + (inRow - 1) * gap)) / 2 + col * (tile + gap), y = row * (tile + gap);
      const c = await Exports.renderComp(Object.assign({}, list[i].comp, { size: '1024', ratio: '1' }), { w: tile, h: tile });
      if (c) { ctx.drawImage(c, x, y, tile, tile); c.width = c.height = 1; }
    }
    return canvas;
  }
  async function openComposite(cols) {
    const sel = items.filter(i => colSel.has(i.id));
    const list = sel.length >= 2 ? sel : items;                          // nothing (or one) picked: every saved object, as before
    if (list.length < 2) return;
    if (list.length > COMPOSITE_MAX) { UI.toast(t('composite_max', { n: COMPOSITE_MAX }), { type: 'warn' }); return; }
    compositeList = list; cols = cols || parseInt($('compCols').value, 10) || 2;
    try {
      const canvas = await buildComposite(list, Math.min(cols, list.length));
      if (compositeCanvas) { compositeCanvas.width = compositeCanvas.height = 1; }
      compositeCanvas = canvas;
      const blob = await Exports.canvasToBlob(canvas, 'image/jpeg', 0.9);
      if (compositeUrl) URL.revokeObjectURL(compositeUrl);
      compositeUrl = URL.createObjectURL(blob);
      $('compositePreview').alt = t('comp_preview_alt'); $('compositePreview').src = compositeUrl;
      UI.open('compositeModal');
    } catch (e) { console.error('[composite]', e); UI.toast(t('err_composite'), { type: 'error' }); }
    finally { UI.busy(false); }
  }
  $('compCols').addEventListener('change', () => openComposite(parseInt($('compCols').value, 10)));
  $('downloadComposite').onclick = async () => {
    if (!compositeCanvas) return;
    try {
      const blob = await Exports.canvasToBlob(compositeCanvas, 'image/png');
      const file = 'Composite_' + compositeList.length + '_Objects.png';
      Exports.downloadBlob(blob, file);
      UI.toast(t('exported_png', { file, size: Exports.bytesLabel(blob.size) }), { type: 'success' });
    } catch (e) { UI.toast(t('err_export_png'), { type: 'error' }); }
  };
  $('compositeModal').addEventListener('close', () => {
    if (compositeUrl) { URL.revokeObjectURL(compositeUrl); compositeUrl = ''; $('compositePreview').removeAttribute('src'); }
    if (compositeCanvas) { compositeCanvas.width = compositeCanvas.height = 1; compositeCanvas = null; }
  });

  /* ---------- events ---------- */
  function wire() {
    $('compareWrapper').addEventListener('click', e => {
      const card = e.target.closest('.hero-card'); if (!card) return;
      const item = items.find(i => i.id === card.dataset.id); if (!item) return;
      const act = e.target.closest('[data-act]'); if (!act) return;
      if (act.dataset.act === 'zoom') Exports.viewLarge(item.comp);
      else if (act.dataset.act === 'download') Exports.exportPng(item.comp, item.name);
      else if (act.dataset.act === 'remove') remove(item.id);
      else if (act.dataset.act === 'restore') App.restoreComp(item.comp, item.name);
      else if (act.dataset.act === 'collage') toggleCollage(item.id);
    });
    $('compareWrapper').addEventListener('change', e => {
      if (!e.target.matches('[data-act="select"]')) return;
      toggleCompare(e.target.closest('.hero-card').dataset.id, e.target.checked, e.target);
    });
    $('btnBoardCompare').onclick = () => openCompare();
    $('btnCmpFirst').onclick = pickFirst;
    $('btnCmpRandom').onclick = pickRandom;
    $('btnCmpClear').onclick = () => { cmpSel.clear(); syncSelection(); };
    $('btnColClear').onclick = () => { colSel.clear(); syncSelection(); };
    $('makeComposite').onclick = () => openComposite();
    document.addEventListener('langchange', () => { $('cmpMsg').classList.remove('is-warn'); $('colMsg').classList.remove('is-warn'); });   // the app re-renders the board itself; the notices are plain hints again in the new language
    $('clearCompare').onclick = clearAll;
  }

  function init() { load(); wire(); render(); }

  return { init, add, render, makeThumb, openCompare, get count() { return items.length; }, items: () => items, MAX_ITEMS, COMPARE_MAX, COMPOSITE_MAX, THUMB_V,
    selection: () => ({ compare: [...cmpSel], collage: [...colSel] }), thumbsReady: () => upgrading || Promise.resolve() };
})();
