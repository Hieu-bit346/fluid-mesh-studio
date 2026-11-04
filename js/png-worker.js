/* ==========================================================================
   png-worker.js — PNG export OFF the main thread.

   Why: the canvas is drawn lazily. A 3840 x 3840 picture is only really painted when something reads the pixels back (toBlob, getImageData), so
   on the main thread the whole drawing lands as ONE freeze of the page (measured in this project's benchmark: from 0.06 s up to 5.4 s of a frozen
   page for the 19 styles, against 0.05-0.65 s for the PNG encoding itself). Here the drawing AND the encoding run in a Web Worker on an
   OffscreenCanvas, so the page keeps painting, scrolling and answering touches.

   How: the worker is built at run time from the code that is already on the page - RendererFactory.toString() (renderer.js, the same drawing code,
   not a copy) plus the five small colour helpers it needs (PRELUDE) - and started from a Blob URL. A Worker started from a separate .js file is
   refused by Chromium when the page is opened from file://; a Blob-URL worker is not (checked in Chromium 141, see tests/e2e/t28-png-worker.js).

   Honest limits:
   - Needs Worker + OffscreenCanvas 2D + OffscreenCanvas.convertToBlob. Anything missing (or a worker that fails to start / run) falls back to the
     previous main-thread path in exports.js: same picture, same file, but the page is busy while it draws.
   - The progress it can report is the stage (drawing -> encoding PNG), not a percentage: the drawing code has no per-pixel progress to give.
   - One job = one fresh worker, terminated when the job ends (done, failed or cancelled), so nothing is left behind: no worker, no Blob URL.
   - Verified only in Chromium (headless, software raster). Other browsers / real GPUs: see docs/DEVICE-CHECKLIST.md ("not tested").
   ========================================================================== */
const PngWorker = (function () {
  'use strict';

  /** Helpers that renderer.js takes from other scripts (color.js): their source is copied into the worker. Keep in step with the free variables of RendererFactory. */
  const PRELUDE = ['hsv', 'hsvToRgb', 'shiftColor', 'hex', 'mulberry32'];

  const stats = { created: 0, finished: 0, failed: 0, cancelled: 0, alive: 0, urlsLive: 0, lastError: null };
  let forcedOff = false, brokenForSession = false;
  let testPrelude = '';                                   // test seam: code run inside the worker before the renderer (used by the failure tests)

  /** Everything this export path needs exists in this browser. (Feature detection only: a worker that later fails is handled by the caller.) */
  function supported() {
    try {
      if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
      if (typeof OffscreenCanvas !== 'function' || typeof OffscreenCanvas.prototype.convertToBlob !== 'function') return false;
      return !!new OffscreenCanvas(1, 1).getContext('2d');
    } catch (e) { return false; }
  }
  const enabled = () => !forcedOff && !brokenForSession && supported();

  /** Runs INSIDE the worker (serialised with toString, so it must not use anything from this file). */
  function workerMain(R) {
    self.onmessage = async function (e) {
      const m = e.data;
      if (!m || m.type !== 'render') return;
      try {
        const canvas = new OffscreenCanvas(m.w, m.h);
        self.postMessage({ type: 'stage', stage: 'render' });
        const ok = await R.renderCanvas(m.params, canvas, m.w, m.h, 0, {});
        if (!ok) throw new Error('render-abandoned');
        let share = null;
        if (m.measure) {                                  // share of see-through pixels, sampled from a 96 px copy of the whole picture (same rule as the main-thread path)
          const s = 96, c = new OffscreenCanvas(s, s), x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(canvas, 0, 0, s, s);
          const d = x.getImageData(0, 0, s, s).data; let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++;
          share = n / (s * s);
        }
        self.postMessage({ type: 'stage', stage: 'encode' });
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        if (!blob || !blob.size) throw new Error('empty-image');
        canvas.width = canvas.height = 1;                 // release the big backing store before the worker is terminated
        self.postMessage({ type: 'done', blob: blob, w: m.w, h: m.h, share: share });
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };
  }

  function workerSource() {
    const parts = PRELUDE.map(name => {
      const f = typeof window !== 'undefined' ? window[name] : undefined;
      if (typeof f !== 'function') throw Object.assign(new Error('png-worker: helper "' + name + '" is missing'), { unavailable: true });
      return f.toString();
    });
    if (testPrelude) parts.unshift(testPrelude);
    parts.push(RendererFactory.toString());
    parts.push('(' + workerMain.toString() + ')(RendererFactory());');
    return parts.join('\n');
  }

  /**
   * Start one export job. job = { params, w, h, measureTransparency }, hooks = { onStage(stage: 'render' | 'encode') }.
   * Returns { promise, cancel() }. The promise resolves { blob, w, h, transparentShare } or rejects (error.cancelled = true after cancel(),
   * error.unavailable = true when the worker could not even start: the caller then stops trying workers for this page).
   */
  function render(job, hooks) {
    hooks = hooks || {};
    let worker = null, url = null, settled = false, rejectOuter = null;
    const cleanup = () => {
      if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; stats.alive--; }
      if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } url = null; stats.urlsLive--; }
    };
    const promise = new Promise((resolve, reject) => {
      rejectOuter = reject;
      const fail = (err, unavailable) => {
        if (settled) return; settled = true; cleanup(); stats.failed++; stats.lastError = String(err && err.message || err);
        if (unavailable) { err.unavailable = true; brokenForSession = true; }
        reject(err);
      };
      try {
        url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })); stats.urlsLive++;
        worker = new Worker(url); stats.alive++; stats.created++;
      } catch (e) { fail(e, true); return; }
      worker.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); fail(new Error('worker-error: ' + ((ev && ev.message) || 'failed to run')), true); };
      worker.onmessageerror = () => fail(new Error('worker-message-error'));
      worker.onmessage = ev => {
        const m = ev.data || {};
        if (settled) return;
        if (m.type === 'stage') { try { hooks.onStage && hooks.onStage(m.stage); } catch (e) { /* a UI hook must never break the job */ } }
        else if (m.type === 'done') { settled = true; cleanup(); stats.finished++; resolve({ blob: m.blob, w: m.w, h: m.h, transparentShare: m.share }); }
        else if (m.type === 'error') fail(new Error(m.message || 'worker-render-failed'));
      };
      worker.postMessage({ type: 'render', params: job.params, w: job.w, h: job.h, measure: !!job.measureTransparency });
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true; cleanup(); stats.cancelled++;
        rejectOuter(Object.assign(new Error('cancelled'), { cancelled: true }));
      }
    };
  }

  return {
    supported, enabled, render,
    /** Turn the worker path off / on (the main-thread path is then used); for tests and for anyone debugging a browser. */
    disable(off) { forcedOff = !!off; if (!off) brokenForSession = false; },
    /** Code run in the worker before the renderer: test seam for breaking the worker on purpose. */
    setTestPrelude(code) { testPrelude = String(code || ''); },
    debug: () => Object.assign({ enabled: enabled(), supported: supported(), forcedOff, brokenForSession }, stats),
    sourceText: workerSource
  };
})();
