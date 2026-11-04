/* ==========================================================================
   exports.js — everything that leaves the app: PNG, large preview, palette files, project files (.fluidmesh.json),
   plus AnimUI, the live animation dialog (interactive physics, WebM recording, WAV export button).

   Rules this module keeps:
   - An export re-renders from the comp at the real target size (the on-screen preview is smaller), so the file matches the
     preview configuration exactly.
   - A "done" message is only shown after a non-empty file/blob has actually been produced; a cancelled or failed export
     never downloads anything.
   - One heavy render at a time (a double click or a held key does not start a second export).
   - Project files are validated before anything is applied; a rejected file leaves the current artwork untouched.
   - Failures (canvas too large, unsupported recorder, empty recording, invalid project) say what went wrong.

   Shared helpers used by other modules (cards.js, storage.js): safeName, bytesLabel, canvasToBlob, renderComp, downloadBlob.
   ========================================================================== */
const Exports = (function () {
  'use strict';

  const CM = window.ColorMath;
  const PROJECT_FORMAT = 'fluid-mesh-studio-project', PROJECT_VERSION = 1, PROJECT_MAX_BYTES = 5 * 1024 * 1024;
  // Animation settings that can be stored in a project; the limits mirror the controls in index.html.
  const ANIM_LIMITS = { speedMin: 0.25, speedMax: 3, durations: [3, 5, 8, 12], sizes: [540, 800, 1080] };

  /* ------------------------------ small helpers ------------------------------ */
  function slug(name) {
    return (name || 'artwork').trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'artwork';
  }
  /** Readable file-name stem: keeps spaces and accents, drops characters that are illegal in file names. */
  const safeName = s => (String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)) || 'artwork';
  /** "1.5 KB" / "2.40 MB" — used by the palette / project / audio toasts. */
  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }
  /** Compact size label used by the card studio and the board ("12 KB", "1.4 MB"). Invalid input reads as 0 KB. */
  const bytesLabel = n => !Number.isFinite(n) || n < 0 ? '0 KB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);              // big files need time before the object URL goes away
  }

  /** canvas -> Blob. Rejects (never resolves with null/empty) for an unusable canvas or a failed encode. */
  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function' || !canvas.width || !canvas.height) { reject(new Error('empty-canvas')); return; }
      try { canvas.toBlob(b => (b && b.size ? resolve(b) : reject(new Error('empty-image'))), type || 'image/png', quality); }
      catch (e) { reject(e); }
    });
  }

  async function downloadCanvas(canvas, filename) {
    const blob = await canvasToBlob(canvas, 'image/png');
    downloadBlob(blob, filename);
    return { file: filename, size: fmtBytes(blob.size) };
  }

  /** Share (0..1) of pixels that are not fully opaque, sampled from a 96 px copy of the whole canvas. */
  function transparentShare(canvas) {
    const s = 96, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, s, s);
    const d = x.getImageData(0, 0, s, s).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++;
    return n / (s * s);
  }

  /** Render a comp at its real output size (or opts.w / opts.h) into a new offscreen canvas. Resolves null when cancelled. */
  async function renderComp(comp, opts) {
    opts = opts || {};
    const size = Engine.targetSize(comp);
    const w = Math.max(1, Math.round(opts.w || size.w)), h = Math.max(1, Math.round(opts.h || size.h));
    const params = Engine.buildParams(comp);
    if (opts.transparent) params.transparent = true;
    const c = document.createElement('canvas');
    const ok = await renderCanvas(params, c, w, h, 0, { cancel: opts.cancel });
    return ok ? c : null;
  }

  /* ------------------------------ PNG / large preview ------------------------------ */
  let exportingPng = false, viewingLarge = false;                    // one heavy render at a time (held key / double click)

  /**
   * PNG download. Resolves { blob, w, h, filename, transparentShare } or null (cancelled, busy or failed; a toast says which).
   * Where the browser can (Worker + OffscreenCanvas, see png-worker.js) the drawing AND the PNG encoding run off the main thread, so the page keeps
   * responding and the busy overlay tells the truth (drawing -> encoding, with a Cancel button). Anywhere else, or if the worker fails, the same
   * picture is drawn on the main thread exactly as before. Either way: one export at a time, a done message only after a non-empty file exists.
   */
  async function exportPng(comp, name, opts) {
    if (exportingPng) return null;
    exportingPng = true;
    opts = opts || {};
    const size = Engine.targetSize(comp);
    let cancelled = false, job = null;
    const onCancel = () => { cancelled = true; if (job) job.cancel(); };
    UI.busy(true, t('exporting_png', { w: size.w, h: size.h }), { onCancel });
    try {
      await new Promise(r => setTimeout(r, 30));                      // let the busy overlay paint before the heavy work
      let blob = null, seeThrough = null;
      if (!cancelled && PngWorker.enabled()) {
        try {
          const params = Engine.buildParams(comp);
          if (opts.transparent) params.transparent = true;
          job = PngWorker.render({ params, w: size.w, h: size.h, measureTransparency: !!opts.transparent }, {
            onStage: st => { if (st === 'encode' && !cancelled) UI.busy(true, t('exporting_png_encode', { w: size.w, h: size.h })); }
          });
          const r = await job.promise;
          blob = r.blob; seeThrough = opts.transparent ? r.transparentShare : null;
        } catch (e) {
          if (cancelled || (e && e.cancelled)) { UI.toast(t('export_png_cancelled'), { type: 'info' }); return null; }
          console.warn('[exportPng] the worker could not do it, drawing on the main thread instead:', e);
        } finally { job = null; }
      }
      if (cancelled) { UI.toast(t('export_png_cancelled'), { type: 'info' }); return null; }
      if (!blob) {                                                    // main-thread path (no worker support, or the worker failed)
        const canvas = await renderComp(comp, { transparent: !!opts.transparent, cancel: () => cancelled });
        if (!canvas) { if (cancelled) UI.toast(t('export_png_cancelled'), { type: 'info' }); return null; }
        seeThrough = opts.transparent ? transparentShare(canvas) : null;   // measured on the real pixels, not guessed
        blob = await canvasToBlob(canvas, 'image/png');
        canvas.width = canvas.height = 1;                             // release the big backing store promptly
      }
      const file = slug(name) + '_' + size.w + 'x' + size.h + '.png';
      downloadBlob(blob, file);
      const opaque = seeThrough !== null && seeThrough < 0.005;       // asked for transparency but nothing is see-through
      UI.toast(t(opaque ? 'exported_png_opaque' : 'exported_png', { file, size: fmtBytes(blob.size) }), { type: opaque ? 'warn' : 'success' });
      return { blob, w: size.w, h: size.h, filename: file, transparentShare: seeThrough };
    } catch (e) {
      console.error('[exportPng]', e);
      UI.toast(t('err_export_png'), { type: 'error' });
      return null;
    } finally {
      exportingPng = false;
      UI.busy(false);
    }
  }

  /** Render for the "View large" lightbox (long side capped so the preview opens quickly). */
  async function viewLarge(comp) {
    if (viewingLarge) return;
    viewingLarge = true;
    const size = Engine.targetSize(comp);
    const k = Math.min(1, 1920 / Math.max(size.w, size.h));
    UI.busy(true, t('rendering'));
    try {
      await new Promise(r => setTimeout(r, 20));
      const canvas = await renderComp(comp, { w: Math.max(2, Math.round(size.w * k)), h: Math.max(2, Math.round(size.h * k)) });
      if (!canvas) return;
      const blob = await canvasToBlob(canvas, 'image/png');
      const img = $('lightboxImg');
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      const url = URL.createObjectURL(blob); img.dataset.url = url; img.src = url;
      UI.open('lightboxModal');
    } catch (e) {
      console.error('[viewLarge]', e);
      UI.toast(t('err_render'), { type: 'error' });
    } finally {
      viewingLarge = false;
      UI.busy(false);
    }
  }
  $('lightboxModal').addEventListener('close', () => {
    const img = $('lightboxImg');
    if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url; img.removeAttribute('src'); }
  });

  /* ------------------------------ palette files ------------------------------ */
  function itemName(it, idx, naming) {
    if (naming === 'roles' && it.roles && it.roles.length) return it.roles[0] + '-' + (idx + 1);
    return 'color-' + String(idx + 1).padStart(2, '0');
  }

  function paletteText(items, fmt, opts) {
    opts = opts || {};
    const name = opts.name || 'Fluid Mesh Palette';
    const naming = opts.naming || 'seq';
    const txtFmt = opts.txt || 'hex';
    if (!items || !items.length) return '';

    if (fmt === 'gpl') {
      const lines = ['GIMP Palette', 'Name: ' + name, 'Columns: 5', '#'];
      items.forEach((it, i) => {
        lines.push(`${String(it.r).padStart(3, ' ')} ${String(it.g).padStart(3, ' ')} ${String(it.b).padStart(3, ' ')}	${itemName(it, i, naming)} (${CM.fmtHex(it, false)})`);
      });
      return lines.join('\n');
    }
    if (fmt === 'css') {
      const lines = [':root {'];
      items.forEach((it, i) => { lines.push(`  --${itemName(it, i, naming)}: ${CM.fmtHex(it, false)};`); });
      lines.push('}');
      return lines.join('\n');
    }
    if (fmt === 'json') {
      const arr = items.map((it, i) => ({
        name: itemName(it, i, naming),
        hex: CM.fmtHex(it, false),
        rgb: [it.r, it.g, it.b],
        hsl: (() => { const h = CM.rgbToHsl(it.r, it.g, it.b); return [Math.round(h.h), Math.round(h.s), Math.round(h.l)]; })(),
        roles: it.roles || []
      }));
      return JSON.stringify({ name, colors: arr }, null, 2);
    }
    return items.map(it => {
      if (txtFmt === 'rgb') return CM.fmtRgb(it);
      if (txtFmt === 'hsl') return CM.fmtHsl(it);
      return CM.fmtHex(it, false);
    }).join('\n');
  }

  function copyPalette(items, fmt, opts, btnEl) {
    if (!items || !items.length) { UI.toast(t('err_empty_palette'), { type: 'warn' }); return; }
    const txt = paletteText(items, fmt, opts);
    // UI.copy (not UI.copyText, the raw clipboard writer that takes only the text): it flashes the button, toasts "copied" and reports a failed copy.
    return UI.copy(txt, { label: t('pal_fmt_' + fmt), btn: btnEl });
  }

  function downloadPalette(items, fmt, opts) {
    if (!items || !items.length) { UI.toast(t('err_empty_palette'), { type: 'warn' }); return; }
    const txt = paletteText(items, fmt, opts);
    const ext = fmt === 'gpl' ? '.gpl' : fmt === 'css' ? '.css' : fmt === 'json' ? '.json' : '.txt';
    const file = slug(opts && opts.name) + '_palette' + ext;
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, file);
    UI.toast(t('exported_file', { file, size: fmtBytes(blob.size) }), { type: 'success' });
  }

  /* ------------------------------ project files ------------------------------ */
  /** Animation settings as they are stored in / read from a project. Anything out of range falls back to the control's default. */
  function cleanAnimation(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const L = ANIM_LIMITS, speed = Number(a.speed), dur = Number(a.duration), size = Number(a.size);
    return {
      speed: Number.isFinite(speed) ? Math.min(L.speedMax, Math.max(L.speedMin, Math.round(speed * 4) / 4)) : 1,
      duration: L.durations.includes(dur) ? dur : 5,
      size: L.sizes.includes(size) ? size : 800,
      loop: a.loop !== false,
      physics: a.physics !== false
    };
  }

  function buildProject(comp, extras) {
    extras = extras || {};
    const c = JSON.parse(JSON.stringify(comp));
    c.legacy = null;                                                  // frozen geometry from old board items is not portable
    return {
      format: PROJECT_FORMAT, version: PROJECT_VERSION, app: 'Fluid Mesh Studio HD',
      savedAt: new Date().toISOString(), name: extras.name || '',
      comp: c,
      animation: cleanAnimation(extras.animation),
      source: { included: false, count: extras.sourceCount || 0, names: (extras.sourceNames || []).slice(0, 30), region: extras.region || null,
        note: 'Source images are not stored in project files; the extracted palette is.' }
    };
  }

  function saveProject(comp, extras) {
    const text = JSON.stringify(buildProject(comp, extras), null, 2);
    const file = safeName(extras && extras.name || 'project') + '.fluidmesh.json';
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    if (!blob.size) { UI.toast(t('err_empty_export'), { type: 'error' }); return false; }
    downloadBlob(blob, file);
    UI.toast(t('exported_file', { file, size: fmtBytes(blob.size) }), { type: 'success' });
    return true;
  }

  /**
   * Which kind of project file is this? Returns { kind, error }.
   *  - 'current': { format: 'fluid-mesh-studio-project', version: 1.. }  (what saveProject writes, also read by earlier builds)
   *  - 'v2':      { app: 'fluid-mesh-studio', version: 2 }                (written by an interim build; no "format" field)
   *  - 'bare':    a bare composition { style, basePalette, ... }          (very old exports)
   * A file that names a different format is rejected, never guessed at.
   */
  function projectKind(data) {
    if (data.format !== undefined) {
      if (data.format !== PROJECT_FORMAT) return { error: 'proj_err_format' };
      if (!Number.isInteger(data.version) || data.version < 1) return { error: 'proj_err_format' };
      if (data.version > PROJECT_VERSION) return { error: 'proj_err_newer' };
      return { kind: 'current' };
    }
    if (data.app === 'fluid-mesh-studio') {
      if (!Number.isInteger(data.version) || data.version < 1) return { error: 'proj_err_format' };
      if (data.version > 2) return { error: 'proj_err_newer' };
      return { kind: 'v2' };
    }
    if (typeof data.style === 'string' && Array.isArray(data.basePalette)) return { kind: 'bare' };
    return { error: 'proj_err_format' };
  }

  /** Validate a project file's text. Returns { ok:true, comp, name, animation, source, migrated } or { ok:false, error:i18nKey }. */
  function parseProject(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'proj_err_empty' };
    if (text.length > PROJECT_MAX_BYTES) return { ok: false, error: 'proj_err_big' };
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'proj_err_json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'proj_err_format' };
    const k = projectKind(data);
    if (k.error) return { ok: false, error: k.error };
    const src = k.kind === 'bare' ? data : data.comp;
    if (!src || typeof src !== 'object' || Array.isArray(src) || !Array.isArray(src.basePalette) || !src.basePalette.length) return { ok: false, error: 'proj_err_comp' };
    let comp;
    let clamped = null;
    try { clamped = Engine.countClamp(src); comp = Engine.fromSaved(Object.assign({}, src, { legacy: null })); } catch (e) { return { ok: false, error: 'proj_err_comp' }; }
    const info = data.source && typeof data.source === 'object' ? data.source : {};
    return {
      ok: true, comp, clamped, migrated: k.kind !== 'current',
      name: typeof data.name === 'string' ? data.name.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60) : '',
      animation: cleanAnimation(data.animation),
      source: { count: Number.isFinite(info.count) ? info.count : 0, names: Array.isArray(info.names) ? info.names.filter(n => typeof n === 'string').slice(0, 30) : [] }
    };
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > PROJECT_MAX_BYTES) { reject(new Error('proj_err_big')); return; }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('proj_err_read'));
      r.readAsText(file);
    });
  }

  return {
    slug, safeName, fmtBytes, bytesLabel, downloadBlob, downloadCanvas, canvasToBlob, renderComp,
    exportPng, viewLarge,
    paletteText, copyPalette, downloadPalette,
    buildProject, saveProject, parseProject, readTextFile, cleanAnimation, PROJECT_FORMAT, PROJECT_VERSION, ANIM_LIMITS
  };
})();

/* ==========================================================================
   AnimUI — Live Animation modal + Interactive Physics (Cursor Ripple / Magnet + Audio-Reactive) + WebM recording.

   Clocks and physics run on REAL elapsed time (dt from requestAnimationFrame), never "per frame", so 30 / 60 / 144 Hz
   screens behave the same. A hidden tab simply does not advance them (no jump when you come back); a long stall is real
   time and is not clamped. Recording is a small state machine (recording -> finished | cancelled | error): only
   "finished" downloads a file; cancel / close / error release the stream and drop the chunks.
   ========================================================================== */
const AnimUI = (function () {
  'use strict';

  const settings = { speed: 1, duration: 5, size: 800, loop: true, physics: true };
  const CYCLE_RATE = 1.8;                 // animation clock = real seconds * speed * 1.8 (one seamless cycle = 2π / (speed * 1.8) s)
  const POINTER_ATTACK = 8.4;             // pointer strength gained per second while the cursor is over the canvas (was 0.14 per frame @60 Hz)
  const POINTER_RELEASE = 3.6;            // ... and lost per second after it leaves (was 0.06 per frame @60 Hz)
  const VELOCITY_TAU = 0.1026;            // seconds: the old "x0.85 per frame @60 Hz" decay, expressed in time
  const MAX_VELOCITY = 0.35;              // sanity bound on the pointer velocity handed to the renderer
  const LOCKED_WHILE_RECORDING = ['animPlay', 'animSpeed', 'animDuration', 'animSize', 'animLoop'];   // they change the clip being recorded; physics, sound and Close stay usable

  let rafId = 0, playing = false, lastTs = 0, elapsed = 0, params = null, bound = false;
  let rec = null;                         // the one recording in progress
  let note = { key: '', vars: null };

  // Interactive pointer state (normalised 0..1 coordinates on #animCanvas); dx/dy collect movement until the next frame.
  const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, vx: 0, vy: 0, active: false, down: false, strength: 0 };

  const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(reduceMQ && reduceMQ.matches);
  const isOpen = () => { const m = $('animModal'); return !!(m && m.open); };
  const fmtSpeed = v => Number(v).toFixed(2).replace(/\.00$/, '.0') + '×';

  /* ------------------------------ notes (re-translated on language change) ------------------------------ */
  function setNote(key, vars) {
    note = { key: key || '', vars: vars || null };
    const el = $('animNote');
    if (el) el.textContent = key ? t(key, vars) : '';
  }

  /* ------------------------------ geometry ------------------------------ */
  function syncCanvasSize() {
    const c = $('animCanvas');
    if (!c) return;
    const comp = Store.get();
    const size = Engine.targetSize(comp);
    const long = Number($('animSize').value) || 800;
    const k = long / Math.max(size.w, size.h);
    const w = Math.max(2, Math.round(size.w * k));
    const h = Math.max(2, Math.round(size.h * k));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    c.style.aspectRatio = w + ' / ' + h;
    params = Engine.buildParams(comp);
  }

  /** Duration actually recorded: with "seamless loop" it snaps to a whole number of cycles. */
  function loopDuration() {
    let dur = Number($('animDuration').value) || 5;
    const spd = Number($('animSpeed').value) || 1;
    if ($('animLoop').checked) {
      const cycle = (Math.PI * 2) / (spd * CYCLE_RATE);
      dur = Math.round(Math.max(1, Math.round(dur / cycle)) * cycle * 10) / 10;
    }
    return dur;
  }

  /* ------------------------------ frame ------------------------------ */
  /** Pointer + audio inputs for the renderer, advanced by `dt` real seconds. */
  function interactiveOpts(dt) {
    const physOn = !$('animPhysics') || $('animPhysics').checked;
    const audio = (typeof Soundscape !== 'undefined' && Soundscape.isPlaying())
      ? Soundscape.getEnergy()
      : { level: 0, bass: 0, treble: 0 };

    if (dt > 0) {
      // velocity in "per frame @60 Hz" units (the scale the renderer was tuned with), derived from real movement over real time
      const decay = Math.exp(-dt / VELOCITY_TAU);
      const clampV = v => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
      const tx = clampV(pointer.dx / dt / 60), ty = clampV(pointer.dy / dt / 60);
      pointer.vx = Math.abs(tx) > Math.abs(pointer.vx * decay) ? tx : pointer.vx * decay;
      pointer.vy = Math.abs(ty) > Math.abs(pointer.vy * decay) ? ty : pointer.vy * decay;
      pointer.dx = pointer.dy = 0;
      if (pointer.active && physOn) pointer.strength = Math.min(1, pointer.strength + POINTER_ATTACK * dt);
      else pointer.strength = Math.max(0, pointer.strength - POINTER_RELEASE * dt);
    }

    return {
      sync: true,
      physics: (physOn && pointer.strength > 0.01) ? {
        x: pointer.x, y: pointer.y, vx: pointer.vx, vy: pointer.vy,
        strength: pointer.strength * (pointer.down ? 1.65 : 1.0),
        attract: pointer.down
      } : null,
      audio: physOn ? audio : null
    };
  }

  function draw(dt) {
    const c = $('animCanvas');
    if (c && params) renderCanvas(params, c, c.width, c.height, elapsed, interactiveOpts(dt));
  }

  function step(ts) {
    if (!playing) return;
    if (document.hidden) { lastTs = 0; rafId = requestAnimationFrame(step); return; }      // a hidden tab does not advance the clock
    const dt = lastTs ? Math.max(0, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    elapsed += dt * (Number($('animSpeed').value) || 1) * CYCLE_RATE;
    draw(dt);
    rafId = requestAnimationFrame(step);
  }

  function run() { lastTs = 0; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(step); }

  /* ------------------------------ labels ------------------------------ */
  function updatePlayBtn() {
    const b = $('animPlay');
    if (!b) return;
    b.setAttribute('aria-pressed', playing ? 'true' : 'false');
    b.innerHTML = `${UI.icon(playing ? 'pause' : 'play')}<span>${UI.esc(t(playing ? 'anim_pause' : 'anim_play'))}</span>`;
  }

  function updateLoopNote() {
    if (!$('animNote') || !$('animDuration') || !$('animSpeed') || !$('animLoop')) return;
    if (rec) return;                                                    // the recording note stays while recording
    if ($('animLoop').checked) setNote('anim_loop_snap', { s: loopDuration() }); else setNote('');
  }

  function setRecButton(on) {
    const b = $('dlAnimBtn');
    if (!b) return;
    b.querySelector('span').textContent = t(on ? 'anim_cancel_rec' : 'btn_dl_anim');
    b.classList.toggle('danger', on);
  }

  function lockControls(on) {
    LOCKED_WHILE_RECORDING.forEach(id => { const el = $(id); if (el) el.disabled = on; });
  }

  /* ------------------------------ project settings ------------------------------ */
  /** Put validated settings (from a project file) into the controls and the settings object. */
  function applySettings(a) {
    const c = Exports.cleanAnimation(a);
    if (!c || rec) return false;
    Object.assign(settings, c);
    $('animSpeed').value = String(c.speed); $('animSpeedVal').textContent = fmtSpeed(c.speed);
    $('animDuration').value = String(c.duration); $('animSize').value = String(c.size);
    $('animLoop').checked = c.loop; $('animPhysics').checked = c.physics;
    if (isOpen()) { syncCanvasSize(); updateLoopNote(); }
    return true;
  }

  /* ------------------------------ open / close ------------------------------ */
  function open() {
    syncCanvasSize();
    const still = reducedMotion();                                      // OS "reduce motion": start paused, the Play button is the user's explicit opt-in
    playing = !still;
    UI.open('animModal');
    updatePlayBtn();
    if (still) { setNote('anim_reduced'); draw(0); } else { updateLoopNote(); run(); }
  }

  function close() {
    playing = false;
    cancelAnimationFrame(rafId);
    endRecording('cancelled', true);                                    // closing the dialog while recording discards the clip
  }

  /* ------------------------------ WebM recording: recording -> finished | cancelled | error ------------------------------ */
  const recVisibleMs = r => r.doneMs + (r.running ? performance.now() - r.segStart : 0);

  function scheduleEnd(r) {
    clearTimeout(r.endTimer);
    r.endTimer = setTimeout(() => endRecording('finished'), Math.max(0, r.durMs - recVisibleMs(r)));
  }

  function updateProgress(r) {
    const prog = $('animProgress'), bar = $('animProgressBar');
    const pct = Math.min(100, Math.round(recVisibleMs(r) / r.durMs * 100));
    bar.style.width = pct + '%';
    prog.setAttribute('aria-valuenow', String(pct));
  }

  /** The recorded clock only runs while the tab is visible (nothing is drawn while hidden): pause / resume the recorder with it. */
  function pauseRecClock(r) {
    if (!r.running) return;
    r.doneMs += performance.now() - r.segStart; r.running = false;
    clearTimeout(r.endTimer);
    try { if (r.recorder.state === 'recording') r.recorder.pause(); } catch (e) { /* ignore */ }
  }
  function resumeRecClock(r) {
    if (r.running || r.status !== 'recording') return;
    try { if (r.recorder.state === 'paused') r.recorder.resume(); } catch (e) { /* ignore */ }
    r.segStart = performance.now(); r.running = true;
    scheduleEnd(r);
  }

  function startRecording() {
    const c = $('animCanvas');
    if (rec) return;
    if (typeof MediaRecorder === 'undefined' || !c.captureStream) { UI.toast(t('anim_unsupported'), { type: 'warn' }); return; }
    syncCanvasSize();
    if (!playing) { playing = true; updatePlayBtn(); run(); }

    const dur = loopDuration();
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    let stream = null, recorder = null;
    try {
      stream = c.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
    } catch (e) {
      if (stream) stream.getTracks().forEach(tr => { try { tr.stop(); } catch (err) { /* ignore */ } });
      UI.toast(t('anim_failed'), { type: 'error' });
      return;
    }

    const r = rec = { recorder, stream, mime, dur, durMs: dur * 1000, chunks: [], status: 'recording', done: false, silent: false,
                      doneMs: 0, segStart: performance.now(), running: true, tick: 0, endTimer: 0 };
    lockControls(true); setRecButton(true);
    setNote('anim_recording');
    $('animProgress').classList.remove('hidden'); $('animProgressBar').style.width = '0%'; $('animProgress').setAttribute('aria-valuenow', '0');

    recorder.ondataavailable = e => { if (rec === r && e.data && e.data.size > 0) r.chunks.push(e.data); };
    recorder.onerror = () => endRecording('error');
    recorder.onstop = () => finalise(r);
    try { recorder.start(200); } catch (e) { endRecording('error'); return; }
    r.tick = setInterval(() => updateProgress(r), 100);
    if (document.hidden) pauseRecClock(r); else scheduleEnd(r);
  }

  /** Decide the outcome FIRST, then stop the recorder: onstop (finalise) must know whether the clip may be saved. */
  function endRecording(outcome, silent) {
    const r = rec;
    if (!r || r.status !== 'recording') return;
    r.status = outcome; r.silent = !!silent;
    clearInterval(r.tick); clearTimeout(r.endTimer);
    if (r.recorder.state !== 'inactive') {
      try { r.recorder.stop(); } catch (e) { finalise(r); }
    } else {
      finalise(r);
    }
  }

  /** Runs once per recording, after the recorder has stopped: release everything, then (only if finished) save. */
  function finalise(r) {
    if (r.done) return;
    r.done = true;
    clearInterval(r.tick); clearTimeout(r.endTimer);
    r.stream.getTracks().forEach(tr => { try { tr.stop(); } catch (e) { /* ignore */ } });
    const chunks = r.chunks; r.chunks = [];
    if (rec === r) rec = null;
    lockControls(false); setRecButton(false);
    $('animProgress').classList.add('hidden');

    if (r.status === 'finished') {
      if (!chunks.length) { setNote('anim_empty'); UI.toast(t('anim_empty'), { type: 'error' }); return; }
      const blob = new Blob(chunks, { type: r.mime });
      const file = Exports.slug(App.artName()) + '_' + r.dur + 's.webm';
      Exports.downloadBlob(blob, file);
      setNote('anim_saved', { file, size: Exports.fmtBytes(blob.size), s: r.dur });
    } else if (r.status === 'cancelled') {
      setNote('anim_cancelled');
      if (r.silent) UI.toast(t('anim_cancelled'), { type: 'info' });    // the dialog is closing: a toast is what the user will see
    } else {
      setNote('anim_failed');
      UI.toast(t('anim_failed'), { type: 'error' });
    }
  }

  /* ------------------------------ events (bound exactly once) ------------------------------ */
  function bindEvents() {
    const c = $('animCanvas');
    if (bound || !c) return;
    bound = true;

    const updatePointer = e => {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      pointer.dx += nx - pointer.x;
      pointer.dy += ny - pointer.y;
      pointer.x = nx;
      pointer.y = ny;
      pointer.active = true;
    };

    c.addEventListener('pointermove', updatePointer);
    c.addEventListener('pointerdown', e => { pointer.down = true; updatePointer(e); });
    window.addEventListener('pointerup', () => { pointer.down = false; });
    window.addEventListener('pointercancel', () => { pointer.down = false; pointer.active = false; });
    c.addEventListener('pointerleave', () => { pointer.active = false; pointer.down = false; });

    $('animPlay').onclick = () => {
      if (rec) return;
      playing = !playing;
      updatePlayBtn();
      if (playing) { run(); updateLoopNote(); }
    };
    $('animSpeed').addEventListener('input', e => {
      settings.speed = Number(e.target.value) || 1;
      $('animSpeedVal').textContent = fmtSpeed(settings.speed);
      updateLoopNote();
    });
    $('animSize').addEventListener('change', () => { settings.size = Number($('animSize').value) || 800; syncCanvasSize(); });
    $('animDuration').addEventListener('change', () => { settings.duration = Number($('animDuration').value) || 5; updateLoopNote(); });
    $('animLoop').addEventListener('change', () => { settings.loop = $('animLoop').checked; updateLoopNote(); });
    $('animPhysics').addEventListener('change', () => { settings.physics = $('animPhysics').checked; });
    $('animModal').addEventListener('close', close);

    $('dlAnimBtn').onclick = () => { if (rec) endRecording('cancelled'); else startRecording(); };

    document.addEventListener('visibilitychange', () => {
      lastTs = 0;                                                       // first visible frame has dt = 0: no jump after being hidden
      if (!rec) return;
      if (document.hidden) pauseRecClock(rec); else resumeRecClock(rec);
    });
    document.addEventListener('langchange', () => { updatePlayBtn(); setRecButton(!!rec); setNote(note.key, note.vars); });
    if (reduceMQ && reduceMQ.addEventListener) {
      reduceMQ.addEventListener('change', () => {                       // the system setting flipped while the dialog is open
        if (!reducedMotion() || !isOpen() || rec) return;
        playing = false; cancelAnimationFrame(rafId); updatePlayBtn(); setNote('anim_reduced');
      });
    }
    // The Soundscape / WAV controls of this dialog are handled by js/sound-ui.js (one controller for both places).
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bindEvents); else bindEvents();

  return { open, close, settings, applySettings, isRecording: () => !!rec, _test: { pointer, interactiveOpts } };
})();
