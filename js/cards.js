/* ==========================================================================
   cards.js — Info Card Studio.
   A 900 x 1200 card (exported at 1x or 2x) with an Avatar (circle) and a Cover (the artwork), three layouts,
   the Color DNA radar, the five metrics and the palette. Everything is drawn with canvas, locally.

   One crop model for everything: a "view" is { zoom, u, v } — zoom >= 1 on top of a cover-fit, and (u, v) is the centre
   of the visible window as a fraction of the image. The frame you drag in the dialog, the live preview and the exported PNG
   all call the same windowFor(), so what you frame is what you get.

   Notes
   - ColorLab.init() and Cards.init() run inside App's initialiser, so init() must not touch `App` (it does not exist yet).
     App is only used when the dialog is opened.
   - drawRadar() clears its canvas, so the radar is drawn on a temporary canvas and composited onto the card.
   - No emoji are drawn on the canvas (fonts differ by system); metrics use coloured dots instead.
   - The card has its OWN language (S.lang), separate from the app language: it only decides which words are drawn on the card
     (metric names, default subtitle). It starts as the app language; a deliberate choice that differs from the app language is
     remembered under its own key ('fms-card-lang') and never touches 'fms-lang' or setLang(). The Easter eggs stay tied to the app language.
   ========================================================================== */
const Cards = (function () {
  'use strict';

  const CM = window.ColorMath, U = UI;
  const W = 900, H = 1200;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
  const CORAL = [255, 92, 119];                 // the studio accent (same as the original card)
  const DARK_BG = [24, 27, 34];                 // '#181b22', the original card background
  const RADAR_ZOOM = 1.5;                       // the radar is drawn in a smaller space and scaled up so its labels stay readable

  /** Geometry per template. coverH: height of the cover area. av: avatar circle. text: where the name block goes. */
  const LAYOUT = {
    classic: { coverH: 630,  av: { x: 450, y: 540, r: 90 }, text: { x: 450, align: 'center', maxW: 780, top: 682 }, fadeEnd: 1,   fade: 220 },
    minimal: { coverH: 560,  av: { x: 160, y: 560, r: 82 }, text: { x: 270, align: 'left',   maxW: 590, top: 612 }, fadeEnd: 0,   fade: 120 },
    poster:  { coverH: 1200, av: { x: 150, y: 640, r: 76 }, text: { x: 260, align: 'left',   maxW: 580, top: 632 }, fadeEnd: 0.96, fade: 0 }
  };
  const PAL_TOP = 1114, LOWER_END = 1170;       // the palette strip, and the lowest y the radar / metrics may reach without it
  const ZOOM_MAX = { avatar: 6, cover: 4 };

  const S = {
    tab: 'avatar',
    view: { avatar: { zoom: 1, u: 0.5, v: 0.5 }, cover: { zoom: 1, u: 0.5, v: 0.5 } },
    art: null, metrics: null, palette: [],
    av: null,         // { el, w, h, url, val, ownsUrl }
    cov: null,        // { el, w, h, url }
    fs: { avatar: null, cover: null },     // last frame layout: { Fw, Fh, s, cx, cy, vw, vh }
    touched: { title: false, subtitle: false },
    lang: 'en',       // the card's own language (see header)
    avTok: 0, opening: false, warned: false
  };
  const dlg = () => $('cardModal');
  const clamp = U.clamp;

  /* ------------------------------------------------------------------ crop maths (shared by frame, preview, export) */
  function windowFor(iw, ih, fw, fh, v) {
    const s = Math.max(fw / iw, fh / ih) * v.zoom;
    const vw = fw / s, vh = fh / s;
    const cx = clamp(v.u * iw, Math.min(vw / 2, iw / 2), Math.max(iw - vw / 2, iw / 2));
    const cy = clamp(v.v * ih, Math.min(vh / 2, ih / 2), Math.max(ih - vh / 2, ih / 2));
    return { s, vw, vh, cx, cy, sx: cx - vw / 2, sy: cy - vh / 2 };
  }
  function drawWindow(ctx, el, iw, ih, view, dx, dy, dw, dh, smooth) {
    const w = windowFor(iw, ih, dw, dh, view);
    ctx.imageSmoothingEnabled = smooth !== false; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(el, w.sx, w.sy, w.vw, w.vh, dx, dy, dw, dh);
  }

  /* ------------------------------------------------------------------ small drawing helpers */
  const css = (c, a) => (a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function ellipsize(ctx, str, maxW) {
    if (ctx.measureText(str).width <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(str.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
    return str.slice(0, lo).trimEnd() + '…';
  }
  /** Draw one line of text, shrinking to 60% of `size` and then trimming with an ellipsis so it never overflows. */
  function text(ctx, str, x, y, o) {
    let s = o.size;
    ctx.font = `${o.weight || 400} ${s}px ${FONT}`;
    if (o.maxW) {
      while (s > o.size * 0.6 && ctx.measureText(str).width > o.maxW) { s -= 1; ctx.font = `${o.weight || 400} ${s}px ${FONT}`; }
      str = ellipsize(ctx, str, o.maxW);
    }
    ctx.fillStyle = o.color; ctx.textAlign = o.align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }
  const mctx = document.createElement('canvas').getContext('2d');

  /** Greedy word wrap with the font already set on mctx. A single word wider than the line is cut by characters. */
  function wrapLines(str, maxW) {
    const lines = []; let cur = '';
    for (const w of str.split(/\s+/).filter(Boolean)) {
      const trial = cur ? cur + ' ' + w : w;
      if (mctx.measureText(trial).width <= maxW) { cur = trial; continue; }
      if (cur) lines.push(cur);
      if (mctx.measureText(w).width <= maxW) { cur = w; continue; }
      let part = '';
      for (const ch of Array.from(w)) { if (part && mctx.measureText(part + ch).width > maxW) { lines.push(part); part = ch; } else part += ch; }
      cur = part;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  /**
   * Fit a string into maxW: one line at full size, then one line slightly smaller, then wrapped onto up to maxLines lines
   * (a little smaller again), and only if it still does not fit, cut with an ellipsis. Returns { lines, size }; it can never overflow.
   */
  function fitText(str, o) {
    const weight = o.weight || 400, ml = o.maxLines || 1, big = o.size, mid = Math.round(o.size * 0.88), small = Math.round(o.size * 0.76);
    const tries = ml > 1 ? [[big, 1], [mid, 1], [mid, ml], [small, ml]] : [[big, 1], [mid, 1], [small, 1]];
    let lines = [];
    for (const [sz, n] of tries) {
      mctx.font = `${weight} ${sz}px ${FONT}`; lines = wrapLines(str, o.maxW);
      if (lines.length <= n) return { lines: lines.length ? lines : [''], size: sz };
    }
    mctx.font = `${weight} ${small}px ${FONT}`;
    const cut = lines.slice(0, ml); cut[ml - 1] = ellipsize(mctx, cut[ml - 1] + '…', o.maxW);
    return { lines: cut, size: small };
  }

  /* ------------------------------------------------------------------ the card */
  /** Everything the card draws, read from the controls (and the artwork passed in). */
  function model(art) {
    const items = S.palette;
    const bgSel = $('csBg').value, acSel = $('csAccent').value;
    let bg = DARK_BG;
    if (bgSel === 'palette' && items.length) {
      const d = items.find(i => i.roles.includes('darkest')) || items[0];
      bg = CM.mix([d.r, d.g, d.b], [0, 0, 0], 0.55).map(Math.round);       // always dark enough for light text
    } else if (bgSel === 'custom') { const c = CM.parseColor($('csBgColor').value); if (c) bg = [c.r, c.g, c.b]; }
    let accent = CORAL;
    if (acSel === 'palette' && items.length) { const v = items.find(i => i.roles.includes('vivid')) || items[0]; accent = [v.r, v.g, v.b]; }
    else if (acSel === 'custom') { const c = CM.parseColor($('csAccentColor').value); if (c) accent = [c.r, c.g, c.b]; }
    const light = CM.bestTextColor(CM.make(bg[0], bg[1], bg[2])).color.r === 0;
    return {
      template: LAYOUT[$('csTemplate').value] ? $('csTemplate').value : 'classic',
      art, artW: art.width, artH: art.height,
      av: S.av, avView: S.view.avatar, covView: S.view.cover,
      title: $('csTitle').value.trim(), subtitle: $('csSubtitle').value.trim(), note: $('csNote').value.trim(),
      bg, light, ink: light ? [11, 11, 16] : [255, 255, 255], accent,
      show: { radar: $('csShowRadar').checked, metrics: $('csShowMetrics').checked, palette: $('csShowPalette').checked },
      metrics: S.metrics, palette: items.slice(0, 6),
      lang: S.lang,
      labels: METRIC_DEFS.map(d => tl(S.lang, d.label))         // the card's language, not the app's
    };
  }

  function drawCard(ctx, k, m) {
    const L = LAYOUT[m.template], ink = m.ink;
    ctx.save();
    ctx.scale(k, k);
    ctx.fillStyle = css(m.bg); ctx.fillRect(0, 0, W, H);

    // cover (the artwork), cropped exactly like the frame in the dialog
    drawWindow(ctx, m.art, m.artW, m.artH, m.covView, 0, 0, W, L.coverH, true);
    if (m.template === 'poster') {
      const g = ctx.createLinearGradient(0, 360, 0, 780);
      g.addColorStop(0, css(m.bg, 0)); g.addColorStop(1, css(m.bg, 0.93));
      ctx.fillStyle = g; ctx.fillRect(0, 360, W, 420);
      ctx.fillStyle = css(m.bg, 0.93); ctx.fillRect(0, 780, W, H - 780);
    } else if (L.fade) {
      const g = ctx.createLinearGradient(0, L.coverH - L.fade, 0, L.coverH);
      g.addColorStop(0, css(m.bg, 0)); g.addColorStop(1, css(m.bg, L.fadeEnd));
      ctx.fillStyle = g; ctx.fillRect(0, L.coverH - L.fade, W, L.fade);
    }

    // avatar: a gap in the background colour, the picture clipped to a circle, then the accent ring
    const a = L.av;
    ctx.fillStyle = css(m.bg); ctx.beginPath(); ctx.arc(a.x, a.y, a.r + 9, 0, Math.PI * 2); ctx.fill();
    if (m.av) {
      ctx.save();
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      drawWindow(ctx, m.av.el, m.av.w, m.av.h, m.avView, a.x - a.r, a.y - a.r, a.r * 2, a.r * 2, Math.min(m.av.w, m.av.h) >= 200);
      ctx.restore();
    }
    ctx.lineWidth = 6; ctx.strokeStyle = css(m.accent); ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.stroke();

    // name block: measured first, so the radar / metrics below get exactly the space that is left
    const T = L.text, N = layoutName(m, L), tone = [1, 0.72, 0.6];
    N.blocks.forEach((b, bi) => {
      ctx.font = `${b.weight} ${b.size}px ${FONT}`; ctx.fillStyle = css(ink, tone[b.tone]); ctx.textAlign = T.align; ctx.textBaseline = 'alphabetic';
      b.lines.forEach((ln, li) => ctx.fillText(ln, T.x, b.y + li * b.pitch));
    });

    // radar, metrics, palette
    const hasPal = m.show.palette && m.palette.length, bottom = hasPal ? PAL_TOP - 26 : LOWER_END;
    const top = lowerTop(L, N), ah = bottom - top;
    if (m.metrics && ah > 120) {
      const both = m.show.radar && m.show.metrics;
      if (m.show.radar) drawRadarBox(ctx, k, m, both ? 30 : 130, top, both ? 480 : 640, ah);
      if (m.show.metrics) drawMetricRows(ctx, m, both ? 534 : 110, both ? 316 : 680, top, ah);
    }
    if (hasPal) drawPaletteStrip(ctx, m, PAL_TOP);
    ctx.restore();
  }

  /** Title (up to 2 lines), subtitle (up to 2), note (up to 2): sizes, line breaks and baselines. */
  function layoutName(m, L) {
    const T = L.text, blocks = []; let y = T.top;
    const add = (str, tone, size, weight, lh, gap) => {
      const f = fitText(str, { size, weight, maxLines: 2, maxW: T.maxW });
      if (blocks.length) y += gap;                                       // from the previous block's last baseline
      const pitch = Math.round(f.size * lh);
      blocks.push({ lines: f.lines, size: f.size, weight, tone, pitch, y });
      y += pitch * (f.lines.length - 1);
    };
    add(m.title, 0, 38, 700, 1.16, 0);
    if (m.subtitle) add(m.subtitle, 1, 22, 400, 1.3, 36);
    if (m.note) add(m.note, 2, 18, 400, 1.3, 30);
    return { blocks, bottom: y + 10 };
  }
  /** Where the radar / metrics start: below the last text line, and (for the layouts with the avatar beside the text) below the avatar. */
  function lowerTop(L, N) {
    const avBottom = L.av.y + L.av.r + 9;
    return Math.round(Math.max(N.bottom + 30, L.text.align === 'left' ? avBottom + 26 : 0));
  }

  function drawRadarBox(ctx, k, m, x, y, w, h) {
    const z = RADAR_ZOOM, sw = w / z, sh = h / z, rcap = 190;
    // the largest radius at which every side label still fits inside the box (each label is measured against its own angle)
    mctx.font = '600 11px system-ui, sans-serif';
    let rFit = Infinity;
    m.labels.forEach((lab, i) => {
      const c = Math.abs(Math.cos(Math.PI * 2 * i / 5 - Math.PI / 2));
      if (c > 0.2) rFit = Math.min(rFit, (sw / 2 - 6 - mctx.measureText(lab).width) / c - 12);
    });
    const r = Math.max(24, Math.min(rcap / z, sh / 2 - 38, rFit));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const rc = c.getContext('2d');
    rc.scale(k * z, k * z);
    drawRadar(rc, m.metrics, {
      width: sw, height: sh, radius: r, labels: m.labels, accent: m.accent,
      gridColor: css(m.ink, 0.2), textColor: css(m.ink), mutedColor: css(m.ink, 0.7)
    });
    ctx.drawImage(c, 0, 0, c.width, c.height, x, y, w, h);
  }

  function drawMetricRows(ctx, m, x0, mw, top, ah) {
    const pitch = clamp(ah / 5, 36, 64), y0 = top + (ah - pitch * 5) / 2;
    METRIC_DEFS.forEach((def, i) => {
      const v = clamp(m.metrics[def.key], 0, 100), y = y0 + i * pitch + 22;
      const color = (def.key === 'brightness' && m.light) ? '#6b7280' : def.color;     // the near-white bar vanishes on a light background
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x0 + 7, y - 7, 6, 0, Math.PI * 2); ctx.fill();
      text(ctx, m.labels[i], x0 + 24, y, { size: 21, color: css(m.ink, 0.78), maxW: mw - 24 - 96 });
      text(ctx, v.toFixed(1) + '%', x0 + mw, y, { size: 21, weight: 700, color: css(m.ink), align: 'right' });
      ctx.fillStyle = css(m.ink, 0.16); rr(ctx, x0, y + 10, mw, 8, 4); ctx.fill();
      if (v > 0) { ctx.fillStyle = color; rr(ctx, x0, y + 10, Math.max(8, mw * v / 100), 8, 4); ctx.fill(); }
    });
  }

  function drawPaletteStrip(ctx, m, y) {
    const n = m.palette.length, gap = 12, sw = Math.min(120, (780 - gap * (n - 1)) / n), total = sw * n + gap * (n - 1);
    let x = (W - total) / 2;
    m.palette.forEach(c => {
      const hx = CM.fmtHex(c, false);
      ctx.fillStyle = hx; rr(ctx, x, y, sw, 56, 10); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = css(m.ink, 0.22); rr(ctx, x + 0.5, y + 0.5, sw - 1, 55, 10); ctx.stroke();
      const fg = CM.bestTextColor(c).color.r === 0 ? '#0b0b10' : '#ffffff';
      text(ctx, hx.toUpperCase(), x + sw / 2, y + 34, { size: 16, weight: 700, color: fg, align: 'center', maxW: sw - 10 });
      x += sw + gap;
    });
  }

  /* ------------------------------------------------------------------ frames in the dialog */
  const FR = () => ({
    avatar: { box: $('avatarBox'), img: $('avImg') },
    cover: { box: $('coverBox'), img: $('covImg') }
  });
  const srcOf = which => (which === 'avatar' ? S.av : S.cov);
  const tplName = () => (LAYOUT[$('csTemplate').value] ? $('csTemplate').value : 'classic');
  const aspectOf = which => (which === 'avatar' ? 1 : W / LAYOUT[tplName()].coverH);

  function layoutFrame(which) {
    const f = FR()[which], src = srcOf(which);
    if (!src || !src.w || !src.h) return;
    const holder = f.box.parentNode, avail = Math.max(160, holder.clientWidth || 300), aspect = aspectOf(which);
    let Fw = Math.min(avail, which === 'avatar' ? 240 : 340), Fh = Fw / aspect;
    const maxH = Math.max(160, window.innerHeight * 0.4);
    if (Fh > maxH) { Fh = maxH; Fw = Fh * aspect; }
    Fw = Math.round(Fw); Fh = Math.round(Fh);
    f.box.style.width = Fw + 'px'; f.box.style.height = Fh + 'px';
    const v = S.view[which], win = windowFor(src.w, src.h, Fw, Fh, v);
    v.u = win.cx / src.w; v.v = win.cy / src.h;                       // keep the state inside the image
    const st = f.img.style;
    st.position = 'absolute'; st.maxWidth = 'none'; st.maxHeight = 'none'; st.left = '0'; st.top = '0';
    st.width = Math.round(src.w * win.s) + 'px'; st.height = Math.round(src.h * win.s) + 'px';
    st.transform = `translate(${Math.round(Fw / 2 - win.cx * win.s)}px, ${Math.round(Fh / 2 - win.cy * win.s)}px)`;
    st.imageRendering = Math.min(src.w, src.h) < 200 ? 'pixelated' : 'auto';
    S.fs[which] = { Fw, Fh, s: win.s, cx: win.cx, cy: win.cy, vw: win.vw, vh: win.vh };
    if (which === S.tab) {
      const sl = $('studioZoom'); if (Number(sl.value) !== v.zoom) sl.value = String(v.zoom);
      $('csZoomVal').textContent = v.zoom.toFixed(1) + '×';
    }
  }

  const drawPreview = U.debounce(function () {
    const d = dlg();
    if (!d || !d.open || !S.art || !S.metrics) return;
    const cv = $('cardPreviewCanvas');
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    try { ctx.clearRect(0, 0, W, H); drawCard(ctx, 1, model(S.art)); }
    catch (e) { console.error('[card preview]', e); if (!S.warned) { S.warned = true; U.toast(t('err_card'), { type: 'error' }); } }
  }, 60);
  const refresh = which => { layoutFrame(which || S.tab); drawPreview(); };

  function setTab(tab) {
    S.tab = tab;
    const F = FR();
    F.avatar.box.classList.toggle('hidden', tab !== 'avatar');
    F.cover.box.classList.toggle('hidden', tab !== 'cover');
    const sl = $('studioZoom'); sl.max = String(ZOOM_MAX[tab]);
    S.view[tab].zoom = Math.min(S.view[tab].zoom, ZOOM_MAX[tab]);
    sl.value = String(S.view[tab].zoom);
    sl.setAttribute('aria-label', t(tab === 'avatar' ? 'cs_zoom_av' : 'cs_zoom_cov'));
    layoutFrame(tab);
  }

  function wireFrame(which) {
    const f = FR()[which], box = f.box;
    box.style.touchAction = 'none';
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-describedby', 't_cs_hint');
    let drag = null;
    box.addEventListener('pointerdown', e => {
      const fs = S.fs[which]; if (!fs || (e.button !== undefined && e.button > 0)) return;
      e.preventDefault(); box.focus({ preventScroll: true });
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      drag = { x: e.clientX, y: e.clientY, cx: fs.cx, cy: fs.cy }; box.classList.add('dragging');
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const src = srcOf(which), fs = S.fs[which]; if (!src || !fs) return;
      const v = S.view[which];
      v.u = (drag.cx - (e.clientX - drag.x) / fs.s) / src.w;
      v.v = (drag.cy - (e.clientY - drag.y) / fs.s) / src.h;
      refresh(which);
    });
    const end = () => { drag = null; box.classList.remove('dragging'); };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', () => { S.view[which] = { zoom: 1, u: 0.5, v: 0.5 }; refresh(which); });
    box.addEventListener('keydown', e => {
      const src = srcOf(which), fs = S.fs[which]; if (!src || !fs) return;
      const v = S.view[which], step = (e.shiftKey ? 0.2 : 0.04);
      let used = true;
      switch (e.key) {
        case 'ArrowLeft': v.u -= step * fs.vw / src.w; break;
        case 'ArrowRight': v.u += step * fs.vw / src.w; break;
        case 'ArrowUp': v.v -= step * fs.vh / src.h; break;
        case 'ArrowDown': v.v += step * fs.vh / src.h; break;
        case '+': case '=': v.zoom = clamp(v.zoom + 0.2, 1, ZOOM_MAX[which]); break;
        case '-': case '_': v.zoom = clamp(v.zoom - 0.2, 1, ZOOM_MAX[which]); break;
        case '0': S.view[which] = { zoom: 1, u: 0.5, v: 0.5 }; break;
        default: used = false;
      }
      if (used) { e.preventDefault(); refresh(which); }
    });
  }

  /* ------------------------------------------------------------------ sources */
  let imgCache = { file: null, img: null };
  async function loadFile(file) {
    if (imgCache.file === file && imgCache.img) return imgCache.img;
    const img = await load(file);
    imgCache = { file, img };
    return img;
  }
  function revokeAv() { if (S.av && S.av.ownsUrl && S.av.url) URL.revokeObjectURL(S.av.url); }

  function fillAvatarSelect(selected) {
    const sel = $('csAvatarSrc'), keep = selected !== undefined ? selected : sel.value;
    sel.innerHTML = '';
    for (let i = 0; i < Source.count; i++) {
      const n = Source.entry(i).file.name;
      sel.appendChild(U.el('option', { value: 'src:' + i }, t('cs_src_img', { n: i + 1, name: n.length > 28 ? n.slice(0, 27) + '…' : n })));
    }
    sel.appendChild(U.el('option', { value: 'art' }, t('cs_src_art')));
    sel.value = [].some.call(sel.options, o => o.value === keep) ? keep : 'art';
  }

  /** Initial avatar framing: the manual crop circle if there is one, otherwise a centred cover-fit. */
  function initialAvatarView(idx) {
    const crop = Source.getCrop(idx);
    if (!crop) return { zoom: 1, u: 0.5, v: 0.5 };
    return { zoom: clamp(1 / (2 * crop.r), 1, ZOOM_MAX.avatar), u: crop.x, v: crop.y };
  }

  async function setAvatarSource(val, keepView) {
    const tok = ++S.avTok;
    let next = null;
    if (val && val.indexOf('src:') === 0) {
      const idx = parseInt(val.slice(4), 10), entry = Source.entry(idx);
      if (entry) {
        try {
          const el = await loadFile(entry.file);
          next = { el, w: el.naturalWidth || el.width, h: el.naturalHeight || el.height, url: URL.createObjectURL(entry.file), ownsUrl: true, val, idx };
        } catch (e) { U.toast(t('err_decode', { name: entry.file.name }), { type: 'error' }); }
      }
    }
    if (tok !== S.avTok) { if (next) URL.revokeObjectURL(next.url); return; }
    if (!next) next = { el: S.art, w: S.art.width, h: S.art.height, url: S.cov ? S.cov.url : '', ownsUrl: false, val: 'art' };
    revokeAv();
    S.av = next;
    if (!keepView) S.view.avatar = next.val === 'art' ? { zoom: 1, u: 0.5, v: 0.5 } : initialAvatarView(next.idx);
    $('csAvatarSrc').value = next.val;
    $('avImg').src = next.url || '';
    if (S.tab === 'avatar') setTab('avatar'); else layoutFrame('avatar');
    drawPreview();
  }

  /* ------------------------------------------------------------------ export */
  /** The artwork re-rendered large enough that the cropped cover has at least one source pixel per output pixel (long side <= 4096). */
  async function hiResArt(scale) {
    const comp = Store.get(), size = Engine.targetSize(comp), L = LAYOUT[tplName()], z = S.view.cover.zoom;
    let k = scale * z * Math.max(W / size.w, L.coverH / size.h);
    k = Math.min(k, 4096 / Math.max(size.w, size.h));
    k = Math.max(k, 640 / Math.max(size.w, size.h));
    const c = await Exports.renderComp(comp, { w: Math.max(1, Math.round(size.w * k)), h: Math.max(1, Math.round(size.h * k)) });
    return c || S.art;
  }

  async function exportCard() {
    const scale = parseInt($('csScale').value, 10) === 1 ? 1 : 2;
    UI.busy(true, t('exporting_card', { w: W * scale, h: H * scale }));
    try {
      await new Promise(r => setTimeout(r, 30));                       // let the busy overlay paint first
      const art = await hiResArt(scale), m = model(art);
      if (S.av && S.av.val === 'art') m.av = { el: art, w: art.width, h: art.height, val: 'art' };
      const c = document.createElement('canvas');
      c.width = W * scale; c.height = H * scale;
      drawCard(c.getContext('2d'), scale, m);
      const blob = await Exports.canvasToBlob(c, 'image/png');
      const filename = Exports.safeName(m.title || App.artName()) + '-Card.png';
      Exports.downloadBlob(blob, filename);
      U.toast(t('exported_file', { file: filename, size: Exports.bytesLabel(blob.size) }), { type: 'success' });
    } catch (e) {
      console.error('[card export]', e);
      U.toast(t('err_card'), { type: 'error' });
    } finally { UI.busy(false); }
  }

  /* ------------------------------------------------------------------ the card's own language */
  const LANGS = ['en', 'vi'], LANG_KEY = 'fms-card-lang';
  let memLang = null;                                                   // used when localStorage is unavailable (private mode): the choice then lasts for the session
  function readPref() {
    try { const v = localStorage.getItem(LANG_KEY); return LANGS.indexOf(v) >= 0 ? v : null; } catch (e) { return memLang; }
  }
  function writePref(v) {
    memLang = v;
    try { if (v) localStorage.setItem(LANG_KEY, v); else localStorage.removeItem(LANG_KEY); } catch (e) { /* the choice just lasts for this session */ }
  }
  /** The language a card starts in: the remembered choice, otherwise the app language at the moment the studio is opened. */
  const startLang = () => readPref() || (currentLang === 'vi' ? 'vi' : 'en');

  /** The default subtitle follows the card language. A subtitle the person typed is never replaced (only the two built-in defaults are swapped). */
  function syncDefaultSubtitle() {
    const el = $('csSubtitle'), v = el.value.trim();
    if (!S.touched.subtitle || LANGS.some(l => v === tl(l, 'cs_default_sub'))) el.value = tl(S.lang, 'cs_default_sub');
  }
  function syncLangSeg() {
    document.querySelectorAll('#csLangSeg [data-card-lang]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cardLang === S.lang ? 'true' : 'false'));
    $('cardPreviewCanvas').lang = S.lang;
  }
  /**
   * Switch the card language. This never calls setLang(): the app language, its storage key and the Easter eggs are untouched.
   * A choice that differs from the app language is remembered; choosing the app language again goes back to "follow the app".
   */
  function setCardLang(l, fromPerson) {
    S.lang = LANGS.indexOf(l) >= 0 ? l : 'en';
    if (fromPerson) writePref(S.lang === (currentLang === 'vi' ? 'vi' : 'en') ? null : S.lang);
    syncLangSeg(); syncDefaultSubtitle(); drawPreview();
  }

  /* ------------------------------------------------------------------ open / close */
  function release() {
    revokeAv(); S.av = null;
    if (S.cov && S.cov.url) URL.revokeObjectURL(S.cov.url);
    S.cov = null; S.art = null; imgCache = { file: null, img: null }; S.avTok++;
    $('avImg').removeAttribute('src'); $('covImg').removeAttribute('src');
  }

  async function open() {
    if (S.opening) return;
    const art = App.getArtCanvas();
    if (!art || !art.width) { U.toast(t('cs_need_art'), { type: 'warn' }); return; }
    S.opening = true;
    try {
      S.art = art;
      S.metrics = App.getMetrics() || App.computeMetrics(art);
      S.palette = App.paletteItems();
      S.warned = false;
      S.lang = startLang(); syncLangSeg();
      if (!S.touched.title) $('csTitle').value = App.artName();
      syncDefaultSubtitle();
      S.view = { avatar: { zoom: 1, u: 0.5, v: 0.5 }, cover: { zoom: 1, u: 0.5, v: 0.5 } };
      const blob = await Exports.canvasToBlob(art, 'image/jpeg', 0.92);
      S.cov = { el: art, w: art.width, h: art.height, url: URL.createObjectURL(blob) };
      $('covImg').src = S.cov.url;
      fillAvatarSelect(Source.count ? 'src:0' : 'art');
      $('cardPreviewCanvas').setAttribute('aria-label', t('cs_preview_label'));
      UI.open(dlg());
      tabsCtl.select($('tabAv'));
      await setAvatarSource($('csAvatarSrc').value, false);
      setTab('avatar'); drawPreview();
    } catch (e) {
      console.error('[card open]', e);
      U.toast(t('err_card'), { type: 'error' });
    } finally { S.opening = false; }
  }

  /* ------------------------------------------------------------------ init (must not touch App) */
  let tabsCtl = null;
  function syncColorFields() {
    $('csBgColorField').classList.toggle('hidden', $('csBg').value !== 'custom');
    $('csAccentColorField').classList.toggle('hidden', $('csAccent').value !== 'custom');
  }
  function init() {
    tabsCtl = U.tabs($('csTabs'), { onSelect: b => setTab(b.id === 'tabCov' ? 'cover' : 'avatar') });
    wireFrame('avatar'); wireFrame('cover');
    FR().avatar.box.setAttribute('aria-label', t('cs_frame_av'));
    FR().cover.box.setAttribute('aria-label', t('cs_frame_cov'));
    $('studioZoom').addEventListener('input', () => {
      S.view[S.tab].zoom = clamp(parseFloat($('studioZoom').value) || 1, 1, ZOOM_MAX[S.tab]);
      refresh();
    });
    $('csAvatarSrc').addEventListener('change', () => setAvatarSource($('csAvatarSrc').value, false));
    $('csTemplate').addEventListener('change', () => { layoutFrame('cover'); drawPreview(); });
    ['csBg', 'csAccent'].forEach(id => $(id).addEventListener('change', () => { syncColorFields(); drawPreview(); }));
    ['csBgColor', 'csAccentColor', 'csNote'].forEach(id => $(id).addEventListener('input', drawPreview));
    ['csShowRadar', 'csShowMetrics', 'csShowPalette'].forEach(id => $(id).addEventListener('change', drawPreview));
    $('csTitle').addEventListener('input', () => { S.touched.title = true; drawPreview(); });
    $('csSubtitle').addEventListener('input', () => { S.touched.subtitle = true; drawPreview(); });
    $('finalDlCardBtn').onclick = exportCard;
    $('csLangSeg').addEventListener('click', e => { const b = e.target.closest('[data-card-lang]'); if (b) setCardLang(b.dataset.cardLang, true); });
    dlg().addEventListener('close', release);
    syncColorFields();
    const holder = document.querySelector('#cardModal .frame-holder');
    if (holder && window.ResizeObserver) new ResizeObserver(U.debounce(() => { if (dlg().open) layoutFrame(S.tab); }, 80)).observe(holder);
    document.addEventListener('langchange', () => {
      FR().avatar.box.setAttribute('aria-label', t('cs_frame_av'));
      FR().cover.box.setAttribute('aria-label', t('cs_frame_cov'));
      /* the card keeps its own language: only the dialog's labels follow the app language here */
      if (dlg().open) {
        fillAvatarSelect();
        $('cardPreviewCanvas').setAttribute('aria-label', t('cs_preview_label'));
        $('studioZoom').setAttribute('aria-label', t(S.tab === 'avatar' ? 'cs_zoom_av' : 'cs_zoom_cov'));
        drawPreview();
      }
    });
  }

  return { init, open, _test: { windowFor, LAYOUT, fitText, layoutName, lowerTop, get lang() { return S.lang; } } };
})();
