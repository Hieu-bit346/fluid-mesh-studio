/* ==========================================================================
   colorlab.js — the Color Inspector ("Color Lab").

   What it does
   - Sample any pixel of the generated artwork or of a source image (click / tap / arrow keys, with a magnifier loupe),
     or any pixel on screen where the browser supports the EyeDropper API.
   - Show one colour in HEX, HEX+alpha, RGB, RGBA, HSL, HSLA, HSV/HSB and as a CSS variable, each with its own copy button.
   - Inspect every palette colour (swatch, HEX, RGB, role, best text colour, copy) and pick one without leaving the lab.
   - Edit a colour: validated text input (HEX / RGB / HSL), native picker, R/G/B/A sliders, Reset.
   - WCAG 2.x contrast against white, black, the artwork background or any custom colour, with a live text preview.
   - Collect colours and export them as .gpl / CSS / JSON / text (same exporters as the palette export in the Studio).
   - A small popover (showPopover) lets the Studio's palette rail and harmony swatches reach the same details.

   Notes
   - All values are sRGB as the canvas reports them. Colour-managed images are converted to sRGB by the browser first.
   - Semi-transparent pixels can lose a unit of precision because canvases store premultiplied alpha.
   - ColorLab.init() runs inside App's initialiser, so it must not touch `App` until an event fires (it does not exist yet).
   ========================================================================== */
const ColorLab = (function () {
  'use strict';

  const CM = window.ColorMath, U = UI;
  const COLL_KEY = 'fms-collection-v1', COLL_MAX = 64;
  const WHITE = CM.make(255, 255, 255), BLACK = CM.make(0, 0, 0);
  const ROLE_KEYS = ['darkest', 'lightest', 'vivid'];

  const S = {
    src: 'art',                  // 'art' | 'src'
    srcIdx: 0,                   // which source image when src === 'src'
    cur: CM.make(124, 92, 255),  // the colour being inspected / edited
    orig: CM.make(124, 92, 255), // the colour as it was picked (Reset returns here)
    pixel: null,                 // { x, y } when cur came from the sampling surface
    img: null, imgFile: null, iw: 0, ih: 0,
    palOpen: false,              // the detailed palette sheet
    token: 0,
    contrast: 'white', other: CM.make(17, 17, 17),
    collection: [],
    dirty: true, ready: false
  };

  const inView = () => document.body.dataset.view === 'lab';
  const hexOf = c => CM.fmtHex(c, false);
  const toColor = it => CM.make(it.r, it.g, it.b, it.a === undefined ? 1 : it.a);
  const sameRgb = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
  const sameRgba = (a, b) => sameRgb(a, b) && CM.alpha8(a) === CM.alpha8(b);
  const inkOf = c => (CM.bestTextColor(c).color.r === 0 ? '#0b0b10' : '#ffffff');
  const cssRgba = c => `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a === undefined ? 1 : c.a})`;
  /** Palette of the current artwork. Cached: sliders fire many events, and building it re-derives the whole palette. */
  let palCache = null;
  const freshPalette = () => (palCache = Engine.paletteItems(Store.get()));
  const paletteItems = () => palCache || freshPalette();
  const projectName = () => ($('heroName').value || '').trim() || 'Collection';
  const esc = U.esc;
  const roleBadges = roles => (roles || []).map(r => `<span class="badge role">${esc(t('role_' + r))}</span>`).join('');

  /* ------------------------------------------------------------------ formats */
  const FORMATS = [
    { id: 'hex',  key: 'fmt_hex',  fn: c => CM.fmtHex(c, false) },
    { id: 'hexa', key: 'fmt_hexa', fn: c => CM.fmtHex(c, true) },
    { id: 'rgb',  key: 'fmt_rgb',  fn: c => CM.fmtRgb(c) },
    { id: 'rgba', key: 'fmt_rgba', fn: c => CM.fmtRgba(c) },
    { id: 'hsl',  key: 'fmt_hsl',  fn: c => CM.fmtHsl(c) },
    { id: 'hsla', key: 'fmt_hsla', fn: c => CM.fmtHsla(c) },
    { id: 'hsv',  key: 'fmt_hsv',  fn: c => CM.fmtHsv(c) },
    { id: 'css',  key: 'fmt_css',  fn: c => '--color: ' + CM.fmtHex(c, CM.alpha8(c) < 255) + ';' }
  ];

  function renderFormats() {
    $('labFormats').innerHTML = FORMATS.map(f => {
      const label = t(f.key);
      return `<li class="fmt-row"><span class="fmt-label">${esc(label)}</span><code class="fmt-val mono">${esc(f.fn(S.cur))}</code>` +
        `<button type="button" class="icon-btn" data-fmt="${f.id}" aria-label="${esc(t('copy_fmt', { what: label }))}" data-tip="${esc(t('copy'))}">${U.icon('copy')}</button></li>`;
    }).join('');
  }

  /** Every value on its own line, with language-neutral labels so the text can be pasted straight into code or notes. */
  function allValuesText(c) { return FORMATS.map(f => f.id.toUpperCase() + ': ' + f.fn(c)).join('\n'); }

  /* ------------------------------------------------------------------ current colour */
  function renderSwatch() {
    const c = S.cur;
    $('labSwatch').style.setProperty('--c', cssRgba(c));
    const txt = $('labSwatchText');
    txt.textContent = CM.fmtHex(c, CM.alpha8(c) < 255);
    const seeThrough = CM.alpha8(c) < 255;                         // the label sits on the checkerboard: give it its own solid chip
    txt.classList.toggle('pill', seeThrough);
    txt.style.color = seeThrough ? '#fff' : inkOf(c);
  }

  function renderMeta() {
    const items = paletteItems(), i = items.findIndex(it => sameRgb(it, S.cur));
    const parts = [];
    if (S.pixel && sameRgba(S.cur, S.orig)) parts.push(`<span class="badge">${esc(t('lab_pixel', { x: S.pixel.x, y: S.pixel.y }))}</span>`);
    if (i >= 0) parts.push(roleBadges(items[i].roles) + `<span class="badge">${esc(t('lab_in_palette'))}</span>`);
    else parts.push(`<span class="badge subtle">${esc(t('lab_not_in_palette'))}</span>`);
    $('labRoles').innerHTML = parts.join('');
    const best = CM.bestTextColor(S.cur);
    $('labTextRec').textContent = t('lab_best_text', { color: t(best.color.r === 0 ? 'word_black' : 'word_white'), ratio: CM.fmtRatio(best.ratio) }) +
      (S.cur.a < 1 ? ' ' + t('lab_over_white') : '');
  }

  /** R, G, B and alpha sliders. Each slider's track shows what moving it does to the colour. */
  const CHANNELS = [['r', 'ch_r', 255], ['g', 'ch_g', 255], ['b', 'ch_b', 255], ['a', 'ch_a', 255]];
  function buildChannels() {
    $('labChannels').innerHTML = CHANNELS.map(([k, key, max]) =>
      `<label class="field range-field chan chan-${k}"><span class="rf-head"><span data-chan-label="${key}">${esc(t(key))}</span><output data-chan-out="${k}"></output></span>` +
      `<input type="range" min="0" max="${max}" step="1" data-chan="${k}"></label>`).join('');
  }
  function renderChannels() {
    const c = S.cur, a8 = CM.alpha8(c);
    const vals = { r: c.r, g: c.g, b: c.b, a: a8 };
    const tracks = {
      r: `linear-gradient(90deg, rgb(0,${c.g},${c.b}), rgb(255,${c.g},${c.b}))`,
      g: `linear-gradient(90deg, rgb(${c.r},0,${c.b}), rgb(${c.r},255,${c.b}))`,
      b: `linear-gradient(90deg, rgb(${c.r},${c.g},0), rgb(${c.r},${c.g},255))`,
      a: `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0), rgb(${c.r},${c.g},${c.b}))`
    };
    CHANNELS.forEach(([k]) => {
      const input = $('labChannels').querySelector(`[data-chan="${k}"]`), out = $('labChannels').querySelector(`[data-chan-out="${k}"]`);
      if (String(vals[k]) !== input.value) input.value = String(vals[k]);
      input.style.setProperty('--track', tracks[k]);
      input.setAttribute('aria-valuetext', k === 'a' ? Math.round(a8 / 255 * 100) + '%' : String(vals[k]));
      out.textContent = k === 'a' ? Math.round(a8 / 255 * 100) + '%' : String(vals[k]);
    });
  }

  /** Re-render everything that depends on the current colour. `from` says which control produced the change. */
  function renderCurrent(from) {
    renderSwatch(); renderFormats(); renderMeta(); renderChannels(); renderContrast(); markPalette();
    if (from !== 'input') $('labInput').value = CM.fmtHex(S.cur, CM.alpha8(S.cur) < 255);
    if (from !== 'input') { $('labInput').removeAttribute('aria-invalid'); setMsg('', ''); }
    if (from !== 'picker') $('labPicker').value = hexOf(S.cur).toLowerCase();
  }

  /**
   * Make `color` the current colour.
   * opts.edit   true  -> an edit of the same colour: keep the Reset target and the pixel marker
   * opts.from   which control produced it ('input' | 'picker' | 'channel' | ...), so that control is not rewritten under the user's hands
   * opts.pixel  { x, y } when it was sampled from the surface
   */
  function setCurrent(color, opts) {
    opts = opts || {};
    S.cur = CM.make(color.r, color.g, color.b, color.a === undefined ? 1 : color.a);
    if (!opts.edit) { S.orig = S.cur; S.pixel = opts.pixel || null; if (!opts.pixel) hideMarker(); }
    renderCurrent(opts.from);
  }

  /* ------------------------------------------------------------------ edit controls */
  function setMsg(text, kind) {
    const m = $('labInputMsg'); m.textContent = text; m.dataset.kind = kind || '';
  }
  const showBad = U.debounce(() => { if (!CM.parseColor($('labInput').value) && $('labInput').value.trim()) { $('labInput').setAttribute('aria-invalid', 'true'); setMsg(t('lab_input_bad'), 'error'); } }, 450);

  function wireEdit() {
    const input = $('labInput');
    input.addEventListener('input', () => {
      const v = input.value.trim();
      if (!v) { input.removeAttribute('aria-invalid'); setMsg('', ''); showBad.cancel(); return; }
      const c = CM.parseColor(v);
      if (c) { showBad.cancel(); input.removeAttribute('aria-invalid'); setMsg('', ''); setCurrent(c, { edit: true, from: 'input' }); }
      else showBad();                                    // wait for a pause: half-typed values are not errors yet
    });
    input.addEventListener('change', () => {              // blur / Enter: tidy up a valid value, flag an invalid one
      const v = input.value.trim(), c = CM.parseColor(v);
      if (!v) { input.value = CM.fmtHex(S.cur, CM.alpha8(S.cur) < 255); return; }
      if (c) { setCurrent(c, { edit: true }); }
      else { showBad.cancel(); input.setAttribute('aria-invalid', 'true'); setMsg(t('lab_input_bad'), 'error'); }
    });
    $('labPicker').addEventListener('input', e => {
      const c = CM.parseColor(e.target.value); if (!c) return;
      setCurrent(CM.make(c.r, c.g, c.b, S.cur.a), { edit: true, from: 'picker' });
    });
    $('labChannels').addEventListener('input', e => {
      const el = e.target.closest('[data-chan]'); if (!el) return;
      const c = S.cur, v = Number(el.value);
      const next = { r: c.r, g: c.g, b: c.b, a: CM.alpha8(c) / 255 };
      if (el.dataset.chan === 'a') next.a = v / 255; else next[el.dataset.chan] = v;
      setCurrent(CM.make(next.r, next.g, next.b, next.a), { edit: true, from: 'channel' });
    });
    $('btnLabReset').onclick = () => { setCurrent(S.orig, { edit: true }); toast(t('lab_reset_done'), { type: 'info', ms: 1500 }); };
  }
  const toast = (m, o) => U.toast(m, o);

  /* ------------------------------------------------------------------ contrast */
  /** The colour the artwork is really drawn on: the renderer's own definition (renderedBackground), never a second copy of its rules. */
  function artBackground() {
    return CM.fromArray(renderedBackground(Engine.buildParams(Store.get())));
  }
  function otherColor() {
    if (S.contrast === 'white') return WHITE;
    if (S.contrast === 'black') return BLACK;
    if (S.contrast === 'bg') return artBackground();
    return S.other;
  }
  const levelName = r => (r >= 7 ? 'lvl_aaa' : r >= 4.5 ? 'lvl_aa' : r >= 3 ? 'lvl_aa_large' : 'lvl_fail');
  const lum4 = c => CM.relativeLuminance(c).toFixed(4);

  function renderContrast() {
    const c = S.cur, o = otherColor();
    const ratio = CM.contrastRatio(c, o), lv = CM.wcagLevels(ratio);
    const flat = c.a < 1 ? CM.compositeOver(c, o) : c;
    const rows = [['wcag_aa_normal', lv.aaNormal], ['wcag_aa_large', lv.aaLarge], ['wcag_aaa_normal', lv.aaaNormal], ['wcag_aaa_large', lv.aaaLarge], ['wcag_ui', lv.ui]];
    const note = (c.a < 1 || o.a < 1) ? `<p class="muted small">${esc(t('lab_alpha_note'))}</p>` : '';
    $('contrastOut').innerHTML =
      `<div class="ratio-line"><span class="ratio-big mono">${CM.fmtRatio(ratio)}<small>:1</small></span>` +
      `<span class="muted small">${esc(t('lab_lum_row', { a: lum4(flat), b: lum4(o) }))}</span></div>` +
      `<ul class="wcag-list">${rows.map(([k, ok]) =>
        `<li class="${ok ? 'pass' : 'fail'}"><span>${esc(t(k))}</span><b class="pill ${ok ? 'pass' : 'fail'}">${U.icon(ok ? 'check' : 'x')}${esc(t(ok ? 'pass' : 'fail'))}</b></li>`).join('')}</ul>` + note;

    // previews: light and dark text on this colour, and this colour as text on the other colour
    const onFlat = c.a < 1 ? CM.compositeOver(c, o) : c;
    const rl = CM.contrastRatio(WHITE, onFlat), rd = CM.contrastRatio(BLACK, onFlat);
    const sample = esc(t('lab_sample'));
    const textBox = (fg, ratioV, labelKey) =>
      `<span class="cp-line" style="color:${hexOf(fg)}"><b class="cp-aa">Aa</b> ${sample}</span>` +
      `<span class="cp-tag" style="color:${hexOf(fg)}">${esc(t(labelKey))} · ${CM.fmtRatio(ratioV)}:1 · ${esc(t(levelName(ratioV)))}</span>`;
    $('contrastPreview').innerHTML =
      `<div class="cp-box" style="background:${hexOf(onFlat)}">${textBox(WHITE, rl, 'lab_prev_light')}${textBox(BLACK, rd, 'lab_prev_dark')}</div>` +
      `<div class="cp-box" style="background:${hexOf(o)}"><span class="cp-line" style="color:${hexOf(flat)}"><b class="cp-aa">Aa</b> ${sample}</span>` +
      `<span class="cp-tag" style="color:${hexOf(flat)}">${esc(t('lab_prev_as_text'))} · ${CM.fmtRatio(ratio)}:1 · ${esc(t(levelName(ratio)))}</span></div>`;
  }

  const CONTRAST_MODES = [['white', 'cmp_white'], ['black', 'cmp_black'], ['bg', 'cmp_bg'], ['custom', 'cmp_custom']];
  /** Built once (the radio group keeps its listeners); labels are refreshed on language change. */
  function buildContrastChoices() {
    const box = $('contrastChoices'); box.innerHTML = '';
    box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('cmp_against'));
    CONTRAST_MODES.forEach(([mode, key]) => box.appendChild(U.el('button', {
      type: 'button', class: 'chip', role: 'radio', 'data-mode': mode, 'data-label': key, 'aria-checked': S.contrast === mode ? 'true' : 'false', tabindex: S.contrast === mode ? '0' : '-1'
    }, t(key))));
    const pick = U.el('input', { type: 'color', id: 'contrastCustom', class: 'color-input' + (S.contrast === 'custom' ? '' : ' hidden'), 'aria-label': t('cmp_custom_label'), value: hexOf(S.other).toLowerCase() });
    pick.addEventListener('input', e => { const c = CM.parseColor(e.target.value); if (c) { S.other = c; renderContrast(); } });
    box.appendChild(pick);
    U.radioGroup(box, 'aria-checked', btn => {
      S.contrast = btn.dataset.mode;
      pick.classList.toggle('hidden', S.contrast !== 'custom');
      renderContrast();
    });
  }
  function relabelContrastChoices() {
    const box = $('contrastChoices');
    box.setAttribute('aria-label', t('cmp_against'));
    box.querySelectorAll('[data-label]').forEach(b => { b.textContent = t(b.dataset.label); });
    const pick = $('contrastCustom'); if (pick) pick.setAttribute('aria-label', t('cmp_custom_label'));
  }

  /* ------------------------------------------------------------------ palette inspection */
  function renderPalette() {
    const items = freshPalette(), strip = $('labStrip');
    $('labPalCount').textContent = t('lab_palette_count', { n: items.length });
    // the compact row: one fixed-height strip of swatches (scrolls sideways when there are many colours)
    strip.innerHTML = items.map((it, i) => {
      const hx = hexOf(it), roles = (it.roles || []).map(r => t('role_' + r));
      return `<button type="button" class="lab-sw" style="--c:${hx}" data-idx="${i}" aria-pressed="false" tabindex="-1" aria-label="${esc(t('lab_inspect_n', { hex: hx }))}" data-tip="${esc(hx + (roles.length ? ' · ' + roles.join(', ') : ''))}"></button>`;
    }).join('');
    if (S.palOpen) renderCards(items); else $('labPalette').innerHTML = '';
    markPalette();
  }
  /** The detailed cards live in the sheet and are only built while it is open (up to 100 colours would be a lot of hidden DOM). */
  function renderCards(items) {
    const box = $('labPalette');
    if (!items.length) { box.innerHTML = `<p class="muted">${esc(t('lab_palette_empty'))}</p>`; return; }
    box.innerHTML = items.map((it, i) => {
      const hx = hexOf(it), best = CM.bestTextColor(it), ink = inkOf(it);
      return `<div class="pal-card" role="listitem" data-idx="${i}">` +
        `<button type="button" class="pal-swatch" style="--c:${hx};--ink:${ink}" data-act="select" aria-pressed="false" aria-label="${esc(t('lab_inspect_n', { hex: hx }))}"><span class="mono">${hx}</span></button>` +
        `<div class="pal-meta"><span class="mono small">${esc(CM.fmtRgb(it))}</span><div class="roles">${roleBadges(it.roles)}</div>` +
        `<span class="muted small">${esc(t('lab_text_on', { color: t(best.color.r === 0 ? 'word_black' : 'word_white'), ratio: CM.fmtRatio(best.ratio) }))}</span></div>` +
        `<button type="button" class="icon-btn" data-act="copy" aria-label="${esc(t('copy_fmt', { what: hx }))}" data-tip="${esc(t('copy'))}">${U.icon('copy')}</button></div>`;
    }).join('');
  }
  /** Highlight the palette entry that matches the current colour (text-free cue: a ring and aria-pressed). */
  function markPalette() {
    const items = paletteItems(), strip = $('labStrip');
    let selBtn = null;
    strip.querySelectorAll('.lab-sw').forEach(b => {
      const it = items[Number(b.dataset.idx)], on = !!it && sameRgb(it, S.cur);
      b.classList.toggle('is-selected', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && !selBtn) selBtn = b;
    });
    const tabStop = selBtn || strip.querySelector('.lab-sw');
    strip.querySelectorAll('.lab-sw').forEach(b => { b.tabIndex = b === tabStop ? 0 : -1; });
    if (selBtn) {                                                                   // keep the selected swatch visible without scrolling anything but the strip
      const l = selBtn.offsetLeft, r = l + selBtn.offsetWidth;
      if (l < strip.scrollLeft) strip.scrollLeft = Math.max(0, l - 8);
      else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 8;
    }
    $('labPalette').querySelectorAll('.pal-card').forEach(card => {
      const it = items[Number(card.dataset.idx)], on = !!it && sameRgb(it, S.cur);
      card.classList.toggle('is-selected', on);
      card.querySelector('.pal-swatch').setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  /** Open / close the detailed sheet. It overlays the artwork area (or sits beside a portrait artwork) and never resizes it. */
  function setPalOpen(open, opts) {
    open = !!open; opts = opts || {};
    const box = $('labPalette'), btn = $('btnLabPal');
    if (open === !!S.palOpen && box.classList.contains('hidden') === !open) return;
    const hadFocus = box.contains(document.activeElement);
    S.palOpen = open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { renderCards(paletteItems()); markPalette(); box.classList.remove('hidden'); box.scrollTop = 0; }
    else { box.classList.add('hidden'); box.innerHTML = ''; if (hadFocus || opts.focus) btn.focus({ preventScroll: true }); }
  }
  function wirePalette() {
    $('labPalette').addEventListener('click', e => {
      const card = e.target.closest('.pal-card'), act = e.target.closest('[data-act]');
      if (!card || !act) return;
      const it = paletteItems()[Number(card.dataset.idx)]; if (!it) return;
      if (act.dataset.act === 'copy') U.copy(hexOf(it), { btn: act, label: hexOf(it) });
      else setCurrent(toColor(it), {});
    });
    const strip = $('labStrip');
    strip.addEventListener('click', e => {
      const b = e.target.closest('.lab-sw'); if (!b) return;
      const it = paletteItems()[Number(b.dataset.idx)]; if (it) setCurrent(toColor(it), {});
    });
    strip.addEventListener('keydown', e => {                                        // roving tab stop: one Tab stop for the whole strip, arrows move inside it
      const list = Array.from(strip.querySelectorAll('.lab-sw')), i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const j = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: list.length - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault(); const n = list[Math.max(0, Math.min(list.length - 1, j))];
      list.forEach(b => { b.tabIndex = b === n ? 0 : -1; }); n.focus();
    });
    $('btnLabPal').addEventListener('click', () => setPalOpen(!S.palOpen));
  }

  /* ------------------------------------------------------------------ sampling surface */
  const px = document.createElement('canvas'); px.width = px.height = 1;
  const pctx = px.getContext('2d', { willReadFrequently: true });
  let marker = null;

  function readPixel(src, x, y) {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, 1, 1); pctx.imageSmoothingEnabled = false;
    pctx.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return CM.make(d[0], d[1], d[2], d[3] / 255);
  }
  function releaseImg() { S.img = null; S.imgFile = null; }
  async function ensureImg() {
    const e = Source.entry(S.srcIdx);
    if (!e) return null;
    if (S.imgFile !== e.file) { S.img = await load(e.file); S.imgFile = e.file; }
    return S.img;
  }
  /** The element samples are read from, with its pixel size. */
  async function surfaceSource() {
    if (S.src === 'art') { const c = $('out'); return c.width ? { el: c, w: c.width, h: c.height } : null; }
    let img;
    try { img = await ensureImg(); }
    catch (e) { const en = Source.entry(S.srcIdx); toast(t('err_decode', { name: en ? en.file.name : '' }), { type: 'error' }); return null; }
    return img ? { el: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height } : null;
  }

  /** The hint is one fixed line (so the picture never changes height); when it is cut short the full text is on the tooltip. */
  function setHint(text) {
    const h = $('labHint'); h.textContent = text;
    if (h.scrollWidth > h.clientWidth + 1) h.dataset.tip = text; else delete h.dataset.tip;
  }

  async function paintSurface() {
    if (!inView()) return;
    const tok = ++S.token, wrap = $('labCanvasWrap'), cv = $('labCanvas');
    const src = await surfaceSource();
    if (tok !== S.token) return;
    if (!src) { cv.width = cv.height = 0; cv.style.width = cv.style.height = '0px'; wrap.classList.remove('pal-side'); setHint(t(S.src === 'src' ? 'lab_src_none' : 'lab_hint')); return; }
    setHint(t('lab_hint'));
    S.iw = src.w; S.ih = src.h;
    const cs = getComputedStyle(wrap);
    const availW = Math.max(80, wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const availH = Math.max(80, wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    const s = Math.min(availW / src.w, availH / src.h, 6);       // small images are enlarged without smoothing so single pixels stay visible
    const cssW = Math.max(1, Math.floor(src.w * s)), cssH = Math.max(1, Math.floor(src.h * s));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    // a portrait picture leaves empty bands on both sides: when one is wide enough, the palette sheet opens there instead of over the picture
    wrap.classList.toggle('pal-side', (availW - cssW) / 2 >= 300);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = s < 1; ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(src.el, 0, 0, cv.width, cv.height);
    if (S.pixel && S.pixel.src === S.src + ':' + S.srcIdx) placeMarker(S.pixel.x, S.pixel.y); else hideMarker();
  }

  function pointToPixel(clientX, clientY) {
    const cv = $('labCanvas'), r = cv.getBoundingClientRect();
    if (!r.width || !r.height || !S.iw) return null;
    const u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
    return { x: Math.min(S.iw - 1, Math.max(0, Math.floor(u * S.iw))), y: Math.min(S.ih - 1, Math.max(0, Math.floor(v * S.ih))) };
  }

  function ensureMarker() {
    if (marker) return marker;
    marker = U.el('div', { class: 'lab-marker hidden', 'aria-hidden': 'true' });
    $('labCanvasWrap').appendChild(marker);
    return marker;
  }
  function placeMarker(x, y) {
    const cv = $('labCanvas'), m = ensureMarker();
    m.style.left = (cv.offsetLeft + (x + 0.5) / S.iw * cv.offsetWidth) + 'px';
    m.style.top = (cv.offsetTop + (y + 0.5) / S.ih * cv.offsetHeight) + 'px';
    m.classList.remove('hidden');
  }
  function hideMarker() { if (marker) marker.classList.add('hidden'); }

  /** Magnifier: 9 x 9 source pixels around the pointer, centre pixel outlined. */
  async function drawLoupe(x, y, clientX, clientY) {
    const src = await surfaceSource(); if (!src) return;
    const lp = $('loupe'), lc = $('loupeCanvas'), lctx = lc.getContext('2d'), N = 9, cell = lc.width / N;
    lctx.imageSmoothingEnabled = false; lctx.clearRect(0, 0, lc.width, lc.height);
    lctx.drawImage(src.el, x - 4, y - 4, N, N, 0, 0, lc.width, lc.height);
    lctx.lineWidth = 2; lctx.strokeStyle = '#000'; lctx.strokeRect(4 * cell, 4 * cell, cell, cell);
    lctx.lineWidth = 1; lctx.strokeStyle = '#fff'; lctx.strokeRect(4 * cell + 1.5, 4 * cell + 1.5, cell - 3, cell - 3);
    const c = readPixel(src.el, x, y);
    $('loupeHex').textContent = CM.fmtHex(c, CM.alpha8(c) < 255);
    lp.classList.remove('hidden');
    if (clientX !== undefined) {
      const wr = $('labCanvasWrap').getBoundingClientRect(), w = lp.offsetWidth || 104, h = lp.offsetHeight || 128;
      let lx = clientX - wr.left + 20, ly = clientY - wr.top - h - 14;
      if (lx + w > wr.width - 4) lx = clientX - wr.left - w - 20;
      if (ly < 4) ly = clientY - wr.top + 22;
      lp.style.left = Math.max(4, lx) + 'px'; lp.style.top = Math.max(4, ly) + 'px';
    }
  }
  const hideLoupe = () => $('loupe').classList.add('hidden');

  async function pick(x, y) {
    const src = await surfaceSource(); if (!src) return;
    const c = readPixel(src.el, x, y);
    S.pixel = null;
    setCurrent(c, { pixel: { x, y } });
    S.pixel = { x, y, src: S.src + ':' + S.srcIdx };
    renderMeta(); placeMarker(x, y);
  }

  function wireSurface() {
    const cv = $('labCanvas');
    let down = false;
    cv.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault(); cv.focus({ preventScroll: true });
      if (S.palOpen && !$('labCanvasWrap').classList.contains('pal-side')) setPalOpen(false);   // the sheet covers part of the picture: get it out of the way
      down = true; try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      const p = pointToPixel(e.clientX, e.clientY); if (p) drawLoupe(p.x, p.y, e.clientX, e.clientY);
    });
    cv.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' && !down) return;
      const p = pointToPixel(e.clientX, e.clientY); if (p) drawLoupe(p.x, p.y, e.clientX, e.clientY);
    });
    cv.addEventListener('pointerup', e => {
      if (!down) return; down = false;
      const p = pointToPixel(e.clientX, e.clientY);
      if (e.pointerType !== 'mouse') hideLoupe();
      if (p) pick(p.x, p.y);
    });
    cv.addEventListener('pointercancel', () => { down = false; hideLoupe(); });
    cv.addEventListener('pointerleave', () => { if (!down) hideLoupe(); });
    cv.addEventListener('keydown', e => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d || !S.iw) return;
      e.preventDefault(); hideLoupe();                             // the marker shows the position now; a stale loupe would show another pixel
      const step = e.shiftKey ? 10 : 1, cur = (S.pixel && S.pixel.src === S.src + ':' + S.srcIdx) ? S.pixel : { x: Math.floor(S.iw / 2), y: Math.floor(S.ih / 2) };
      pick(Math.min(S.iw - 1, Math.max(0, cur.x + d[0] * step)), Math.min(S.ih - 1, Math.max(0, cur.y + d[1] * step)));
    });
  }

  /* ---- sources: artwork / source image ---- */
  function buildSourceSeg() {
    const seg = $('labSourceSeg'); seg.innerHTML = '';
    [['art', 'lab_src_art'], ['src', 'lab_src_image']].forEach(([id, key]) => seg.appendChild(U.el('button', {
      type: 'button', role: 'tab', 'data-src': id, 'aria-selected': S.src === id ? 'true' : 'false', tabindex: S.src === id ? '0' : '-1'
    }, U.el('span', { 'data-src-label': key }, t(key)))));
    U.tabs(seg, { onSelect: b => { S.src = b.dataset.src; refreshSources(); paintSurface(); } });
    const sel = U.el('select', { id: 'labSrcSelect', class: 'sm hidden' });
    sel.addEventListener('change', () => { S.srcIdx = parseInt(sel.value, 10) || 0; releaseImg(); S.pixel = null; hideMarker(); paintSurface(); });
    $('btnEyedropper').parentNode.insertBefore(sel, $('btnEyedropper'));
  }
  function refreshSources() {
    const n = Source.count, seg = $('labSourceSeg'), btn = seg.querySelector('[data-src="src"]');
    if (btn) { btn.disabled = !n; btn.title = n ? '' : t('lab_src_none'); }
    if (S.src === 'src' && !n) S.src = 'art';
    if (S.srcIdx >= n) S.srcIdx = Math.max(0, n - 1);
    seg.querySelectorAll('[role="tab"]').forEach(b => { const on = b.dataset.src === S.src; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    const sel = $('labSrcSelect');
    sel.setAttribute('aria-label', t('lab_pick_image'));
    sel.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const name = Source.entry(i).file.name;
      sel.appendChild(U.el('option', { value: String(i) }, t('lab_img_n', { n: i + 1, name: name.length > 26 ? name.slice(0, 25) + '…' : name })));
    }
    sel.value = String(S.srcIdx);
    sel.classList.toggle('hidden', !(S.src === 'src' && n > 1));
  }

  /* ---- screen eyedropper (progressive enhancement) ---- */
  function wireEyedropper() {
    const btn = $('btnEyedropper'), ok = 'EyeDropper' in window;
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    btn.classList.toggle('is-unsupported', !ok);
    btn.dataset.tip = ok ? t('lab_eyedropper_tip') : t('lab_eyedropper_unsupported');
    btn.onclick = async () => {
      if (!('EyeDropper' in window)) { toast(t('lab_eyedropper_unsupported'), { type: 'info', ms: 5000 }); return; }
      try {
        const res = await new window.EyeDropper().open();
        const c = CM.parseColor(res && res.sRGBHex);
        if (c) { setCurrent(c, {}); toast(t('lab_picked', { hex: hexOf(c) }), { type: 'success', ms: 1800 }); }
      } catch (e) {
        if (!e || e.name !== 'AbortError') toast(t('lab_eyedropper_failed'), { type: 'error' });   // AbortError = the user pressed Esc
      }
    };
  }

  /* ------------------------------------------------------------------ collection */
  function loadCollection() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLL_KEY) || 'null');
      if (!Array.isArray(raw)) return;
      S.collection = raw.slice(0, COLL_MAX).filter(a => Array.isArray(a) && a.length >= 4 && a.slice(0, 4).every(Number.isFinite))
        .map(a => Object.assign(CM.make(a[0], a[1], a[2], a[3] / 255), { roles: Array.isArray(a[4]) ? a[4].filter(r => ROLE_KEYS.includes(r)) : [] }));
    } catch (e) { S.collection = []; }
  }
  function saveCollection() {
    try { localStorage.setItem(COLL_KEY, JSON.stringify(S.collection.map(c => [c.r, c.g, c.b, CM.alpha8(c), c.roles || []]))); } catch (e) { /* storage unavailable: the collection lasts for this visit */ }
  }
  /** Returns 'added' | 'duplicate' | 'full'. */
  function addToCollection(color, roles) {
    if (S.collection.some(c => sameRgba(c, color))) return 'duplicate';
    if (S.collection.length >= COLL_MAX) return 'full';
    S.collection.push(Object.assign(CM.make(color.r, color.g, color.b, color.a), { roles: (roles || []).slice() }));
    saveCollection(); renderCollection();
    return 'added';
  }
  function reportAdd(r, color) {
    if (r === 'added') toast(t('coll_added', { hex: CM.fmtHex(color, CM.alpha8(color) < 255) }), { type: 'success', ms: 1800 });
    else if (r === 'duplicate') toast(t('coll_dupe'), { type: 'info' });
    else toast(t('coll_full', { n: COLL_MAX }), { type: 'warn' });
  }
  function renderCollection() {
    $('collCount').textContent = t('coll_count', { n: S.collection.length });
    const box = $('collection');
    if (!S.collection.length) { box.innerHTML = `<p class="muted small">${esc(t('coll_empty'))}</p>`; return; }
    box.innerHTML = S.collection.map((c, i) => {
      const hx = CM.fmtHex(c, CM.alpha8(c) < 255);
      return `<div class="coll-chip" data-i="${i}"><button type="button" class="coll-pick" data-act="pick" aria-label="${esc(t('lab_inspect_n', { hex: hx }))}">` +
        `<i class="coll-dot" style="--c:${cssRgba(c)}"></i><span class="mono">${hx}</span></button>` +
        `<button type="button" class="icon-btn sm" data-act="remove" aria-label="${esc(t('coll_remove_n', { hex: hx }))}">${U.icon('x')}</button></div>`;
    }).join('');
  }
  const collOpts = () => ({ name: projectName(), naming: 'roles', txt: $('collTxtFormat').value });

  function wireCollection() {
    $('btnCollAdd').onclick = () => reportAdd(addToCollection(S.cur, currentRoles()), S.cur);
    $('btnCollPalette').onclick = () => {
      const items = paletteItems(); let added = 0;
      items.forEach(it => { if (addToCollection(it, it.roles) === 'added') added++; });
      toast(added ? t('coll_added_n', { n: added }) : t('coll_dupe'), { type: added ? 'success' : 'info', ms: 2200 });
    };
    $('btnCollClear').onclick = async () => {
      if (!S.collection.length) return;
      if (!await U.confirm(t('coll_clear_q'), { danger: true, yes: t('coll_clear') })) return;
      S.collection = []; saveCollection(); renderCollection();
    };
    $('collection').addEventListener('click', e => {
      const chip = e.target.closest('.coll-chip'), act = e.target.closest('[data-act]'); if (!chip || !act) return;
      const i = Number(chip.dataset.i), c = S.collection[i]; if (!c) return;
      if (act.dataset.act === 'remove') { S.collection.splice(i, 1); saveCollection(); renderCollection(); }
      else setCurrent(c, {});
    });
    const syncTxt = () => $('collTxtField').classList.toggle('hidden', $('collFormat').value !== 'txt');
    $('collFormat').addEventListener('change', syncTxt); syncTxt();
    $('btnCollCopy').onclick = () => Exports.copyPalette(S.collection, $('collFormat').value, collOpts(), $('btnCollCopy'));
    $('btnCollDownload').onclick = () => Exports.downloadPalette(S.collection, $('collFormat').value, collOpts());
  }
  function currentRoles() { const it = paletteItems().find(p => sameRgb(p, S.cur)); return it ? it.roles : []; }

  /* ------------------------------------------------------------------ popover (Studio -> quick look) */
  let popAnchor = null;
  const pop = () => $('swatchPop');
  function hidePopover() {
    const p = pop(); if (p.classList.contains('hidden')) return;
    p.classList.add('hidden');
    document.removeEventListener('pointerdown', popOutside, true);
    window.removeEventListener('resize', hidePopover);
    const a = popAnchor; popAnchor = null;
    if (a && document.contains(a)) { try { a.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function popOutside(e) { const p = pop(); if (!p.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) hidePopover(); }

  /** Quick look at one colour from anywhere in the Studio (palette rail, harmony swatches). */
  function showPopover(anchor, item) {
    const p = pop();
    if (p.parentNode !== document.body) document.body.appendChild(p);      // fixed positioning must not be clipped by a panel
    if (popAnchor === anchor && !p.classList.contains('hidden')) { hidePopover(); return; }
    const c = toColor(item), items = paletteItems(), idx = items.findIndex(it => sameRgb(it, c));
    const roles = item.roles && item.roles.length ? item.roles : (idx >= 0 ? items[idx].roles : []);
    const best = CM.bestTextColor(c), hx = hexOf(c);
    const rows = ['hex', 'rgb', 'hsl'].map(id => {
      const f = FORMATS.find(x => x.id === id), label = t(f.key);
      return `<div class="fmt-row"><span class="fmt-label">${esc(label)}</span><code class="fmt-val mono">${esc(f.fn(c))}</code>` +
        `<button type="button" class="icon-btn" data-fmt="${id}" aria-label="${esc(t('copy_fmt', { what: label }))}" data-tip="${esc(t('copy'))}">${U.icon('copy')}</button></div>`;
    }).join('');
    p.innerHTML =
      `<div class="pop-head"><i class="pop-dot" style="--c:${hx}"></i><div><strong class="mono">${hx}</strong><div class="roles">${roleBadges(roles)}</div></div>` +
      `<button type="button" class="icon-btn sm" data-act="close" aria-label="${esc(t('close'))}">${U.icon('x')}</button></div>` +
      rows +
      `<p class="muted small">${esc(t('lab_text_on', { color: t(best.color.r === 0 ? 'word_black' : 'word_white'), ratio: CM.fmtRatio(best.ratio) }))}</p>` +
      `<div class="btn-row"><button type="button" class="btn secondary sm" data-act="lab">${U.icon('eyedropper')}<span>${esc(t('pop_open_lab'))}</span></button>` +
      `<button type="button" class="btn secondary sm" data-act="add">${U.icon('plus')}<span>${esc(t('pop_add'))}</span></button></div>`;
    p._color = c; p._roles = roles;
    p.setAttribute('aria-label', t('aria_color_details') + ' ' + hx);
    p.style.visibility = 'hidden'; p.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
    const x = U.clamp(r.left + r.width / 2 - pw / 2, 8, Math.max(8, window.innerWidth - pw - 8));
    let y = r.top - ph - 10;
    if (y < 8) y = r.bottom + 10;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, window.innerHeight - ph - 8);
    p.style.left = Math.round(x) + 'px'; p.style.top = Math.round(y) + 'px'; p.style.visibility = '';
    popAnchor = anchor;
    document.addEventListener('pointerdown', popOutside, true);
    window.addEventListener('resize', hidePopover);
    const first = p.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }
  function wirePopover() {
    const p = pop();
    p.setAttribute('tabindex', '-1');
    p.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.fmt) { const f = FORMATS.find(x => x.id === b.dataset.fmt); U.copy(f.fn(p._color), { btn: b, label: t(f.key) }); return; }
      if (b.dataset.act === 'close') hidePopover();
      else if (b.dataset.act === 'add') reportAdd(addToCollection(p._color, p._roles), p._color);
      else if (b.dataset.act === 'lab') { const c = p._color; hidePopover(); setCurrent(c, {}); if (typeof App !== 'undefined') App.setView('lab'); }
    });
    p.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hidePopover(); }
      else if (e.key === 'Tab') {                       // keep focus inside while it is open
        const f = Array.from(p.querySelectorAll('button')), i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
  }

  /* ------------------------------------------------------------------ lifecycle */
  function refreshAll() {
    renderPalette(); renderFormats(); renderMeta(); renderContrast(); markPalette();
    refreshSources(); paintSurface();
  }
  function onShow() { S.dirty = false; refreshAll(); }
  /** Called after every full render of the artwork. */
  function onArtChanged() {
    if (!S.ready) return;
    if (!inView()) { S.dirty = true; return; }
    renderPalette(); renderContrast(); renderMeta();
    if (S.src === 'art') paintSurface();
  }
  function rebuildText() {
    hidePopover();                                                // its text was built in the old language
    $('labSourceSeg').querySelectorAll('[data-src-label]').forEach(s => { s.textContent = t(s.dataset.srcLabel); });
    $('labChannels').querySelectorAll('[data-chan-label]').forEach(s => { s.textContent = t(s.dataset.chanLabel); });
    relabelContrastChoices(); wireEyedropper(); refreshSources();
    renderPalette(); renderFormats(); renderMeta(); renderContrast(); renderCollection();
    if (inView()) paintSurface();
  }

  function init() {
    loadCollection();
    buildSourceSeg(); buildChannels(); buildContrastChoices();
    wireSurface(); wireEdit(); wirePalette(); wireCollection(); wirePopover(); wireEyedropper();
    $('labFormats').addEventListener('click', e => {
      const b = e.target.closest('[data-fmt]'); if (!b) return;
      const f = FORMATS.find(x => x.id === b.dataset.fmt); U.copy(f.fn(S.cur), { btn: b, label: t(f.key) });
    });
    $('btnCopyAll').onclick = () => U.copy(allValuesText(S.cur), { btn: $('btnCopyAll'), label: t('lab_all_values') });
    Source.on(() => { releaseImg(); S.pixel = null; hideMarker(); refreshSources(); if (inView()) paintSurface(); });
    document.addEventListener('langchange', rebuildText);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!pop().classList.contains('hidden')) hidePopover();
      else if (S.palOpen && inView() && !document.querySelector('dialog[open]')) setPalOpen(false, { focus: true });
    });
    new ResizeObserver(U.debounce(() => { if (inView()) paintSurface(); }, 80)).observe($('labCanvasWrap'));
    new MutationObserver(() => { if (!inView()) { releaseImg(); hideLoupe(); } }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    // start on the most vivid palette colour so the panel is never empty
    const items = paletteItems(), start = items.find(it => it.roles.includes('vivid')) || items[0];
    if (start) { S.cur = toColor(start); S.orig = S.cur; }
    renderCurrent(); renderPalette(); renderCollection();
    S.ready = true;
  }

  return { init, onShow, onArtChanged, showPopover, select: c => setCurrent(c, {}), getColor: () => S.cur, getCollection: () => S.collection.slice() };
})();
