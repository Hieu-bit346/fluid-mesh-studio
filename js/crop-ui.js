/* ==========================================================================
   crop-ui.js — the manual crop tool.
   Same workflow as the original: a circular region on the image, drag to move, zoom slider to resize,
   Save & Next walks through every image, Apply to All copies the region, Cancel leaves everything as it was.
   New: pointer events (mouse + touch + pen), keyboard control, Reset, crisp HiDPI drawing,
   a region that always fits inside the image, and the canvas never taller than the viewport.
   Regions are stored on Source (keyed by file) as { x, y, r } — all fractions, so they survive resizing.
   ========================================================================== */
const CropUI = (function () {
  'use strict';

  const dlg = $('manualCropModal'), cc = $('cropCanvas'), slider = $('cropZoomSlider'), zoomOut = $('cropZoomVal');
  slider.min = '0.1'; slider.max = '0.5';           // r is a fraction of the shorter side; > 0.5 would leave the image
  let idx = 0, img = null, cw = 0, ch = 0, dpr = 1, cx = 0, cy = 0, r = 0;
  let dragging = false, dragDX = 0, dragDY = 0, ctx = null;
  let done = null, cancelled = null, finished = false, tok = 0;      // tok: invalidates a slow image load when the user moves on / cancels

  const DEFAULT_R = 0.28;
  const clampPos = () => { cx = Math.max(r, Math.min(cw - r, cx)); cy = Math.max(r, Math.min(ch - r, cy)); };
  const norm = () => ({ x: cx / cw, y: cy / ch, r: r / Math.min(cw, ch) });
  const setR = frac => { r = Math.min(cw, ch) * Math.min(0.5, Math.max(0.1, frac)); slider.value = String(r / Math.min(cw, ch)); zoomOut.textContent = Math.round(r / Math.min(cw, ch) * 100) + '%'; clampPos(); };

  function draw() {
    if (!img || !ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    ctx.fillStyle = 'rgba(6,6,10,0.66)';
    ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fill('evenodd');
    ctx.lineWidth = 2.5; ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff5c77';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9); ctx.stroke();
  }

  async function show(i, keep) {
    idx = i;
    const my = ++tok;
    img = null;                                      // buttons / keys are inert until the new image is ready (no stale-crop saves)
    $('cropIdx').textContent = i + 1; $('cropTotal').textContent = Source.count;
    $('btnCropNext').textContent = i < Source.count - 1 ? t('crop_next') : t('crop_done');
    let loaded;
    try { loaded = await load(Source.entry(i).file); }
    catch (e) { if (my !== tok) return; UI.toast(t('err_decode', { name: Source.entry(i).file.name }), { type: 'error' }); finish(false); return; }
    if (my !== tok || finished) return;              // superseded by another show() or the dialog was closed meanwhile
    img = loaded;
    const maxW = Math.min(window.innerWidth * 0.85, 460), maxH = Math.max(180, window.innerHeight * 0.5);
    const s = Math.min(maxW / img.width, maxH / img.height);
    cw = Math.max(1, Math.round(img.width * s)); ch = Math.max(1, Math.round(img.height * s));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cc.width = Math.round(cw * dpr); cc.height = Math.round(ch * dpr);
    cc.style.width = cw + 'px'; cc.style.height = ch + 'px';
    ctx = cc.getContext('2d');
    const saved = keep || Source.getCrop(i);
    if (saved) { cx = saved.x * cw; cy = saved.y * ch; setR(saved.r); } else { cx = cw / 2; cy = ch / 2; setR(DEFAULT_R); }
    clampPos(); draw();
    if (!dlg.open) UI.open(dlg);
    cc.focus({ preventScroll: true });
  }

  function finish(ok) {
    finished = true; tok++;
    if (dlg.open) dlg.close();
    img = null;
    const cb = ok ? done : cancelled;
    done = cancelled = null;
    if (cb) cb();
  }

  /** open(startIndex, { onDone, onCancel }) */
  function open(start, opts) {
    opts = opts || {};
    if (!Source.count) return;
    done = opts.onDone || null; cancelled = opts.onCancel || null; finished = false;
    show(Math.max(0, Math.min(Source.count - 1, start || 0)));
  }

  /* ---------- pointer ---------- */
  function pos(e) { const b = cc.getBoundingClientRect(); return { x: (e.clientX - b.left) * (cw / b.width), y: (e.clientY - b.top) * (ch / b.height) }; }
  cc.addEventListener('pointerdown', e => {
    if (!img) return;
    e.preventDefault(); cc.setPointerCapture(e.pointerId); dragging = true; cc.classList.add('dragging');
    const p = pos(e), inside = Math.hypot(p.x - cx, p.y - cy) <= r;
    if (inside) { dragDX = cx - p.x; dragDY = cy - p.y; } else { dragDX = dragDY = 0; cx = p.x; cy = p.y; clampPos(); draw(); }
  });
  cc.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = pos(e); cx = p.x + dragDX; cy = p.y + dragDY; clampPos(); draw();
  });
  const endDrag = () => { dragging = false; cc.classList.remove('dragging'); };
  cc.addEventListener('pointerup', endDrag); cc.addEventListener('pointercancel', endDrag);

  /* ---------- keyboard ---------- */
  cc.addEventListener('keydown', e => {
    if (!img) return;
    const step = (e.shiftKey ? 0.05 : 0.01), px = step * Math.min(cw, ch);
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': cx -= px; break; case 'ArrowRight': cx += px; break;
      case 'ArrowUp': cy -= px; break; case 'ArrowDown': cy += px; break;
      case '+': case '=': setR(r / Math.min(cw, ch) + 0.02); break;
      case '-': case '_': setR(r / Math.min(cw, ch) - 0.02); break;
      case 'Enter': if (!e.repeat) $('btnCropNext').click(); break;
      default: used = false;
    }
    if (used) { e.preventDefault(); clampPos(); draw(); }
  });
  slider.addEventListener('input', () => { setR(parseFloat(slider.value)); draw(); });

  /* ---------- buttons ---------- */
  $('btnCropReset').onclick = () => { if (!img) return; cx = cw / 2; cy = ch / 2; setR(DEFAULT_R); draw(); cc.focus({ preventScroll: true }); };
  $('btnCropNext').onclick = () => {
    if (!img) return;
    Source.setCrop(idx, norm());
    if (idx < Source.count - 1) show(idx + 1); else finish(true);
  };
  $('btnCropApplyAll').onclick = () => { if (!img) return; Source.setCropAll(norm()); finish(true); };
  $('btnCropCancel').onclick = () => finish(false);
  dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); });     // Esc
  dlg.addEventListener('close', () => { if (!finished) { finished = true; tok++; img = null; const cb = cancelled; done = cancelled = null; if (cb) cb(); } });
  window.addEventListener('resize', UI.debounce(() => { if (dlg.open && img) show(idx, norm()); }, 200));   // keep unsaved adjustments

  return { open };
})();
