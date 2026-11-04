/* ==========================================================================
   state.js — the composition store with undo / redo.

   Store.get()                         current comp (treat as immutable; every change creates a new object)
   Store.init(comp)                    replace everything and clear history
   Store.set(patch, opts)              merge a patch -> Engine.normalizePatch -> Engine.sanitize. Returns true if anything changed.
        opts.coalesce  'key'           consecutive changes with the same key within ~0.9 s form ONE undo step (slider drags, typing)
        opts.history   false           change without recording (used for derived / automatic changes)
        opts.meta      any             passed to subscribers
   Store.replace(comp, opts)           like set() but with a whole comp (presets, project open, variation restore)
   Store.undo() / Store.redo()         return true when a step was taken
   Store.canUndo() / Store.canRedo()
   Store.on(fn) -> off()               fn(comp, prev, info)  info = { kind, changed:[keys], meta }

   History holds comp snapshots only (a few KB each) — capped at 100 steps, never pointer-move or animation frames.
   ========================================================================== */
const Store = (function () {
  'use strict';
  const LIMIT = 100, COALESCE_MS = 900;
  let comp = Engine.sanitize({});
  let past = [], future = [];
  let lastKey = null, lastTime = 0;
  const subs = new Set();

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

  function changedKeys(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter(k => !sameValue(a[k], b[k]));
  }
  function emit(prev, kind, meta) {
    const info = { kind, changed: changedKeys(prev, comp), meta: meta || null };
    subs.forEach(fn => { try { fn(comp, prev, info); } catch (e) { console.error('[Store subscriber]', e); } });
  }
  function record(prev, opts) {
    if (opts && opts.history === false) return;
    const t = now();
    const merge = opts && opts.coalesce && opts.coalesce === lastKey && (t - lastTime) < COALESCE_MS && past.length;
    if (!merge) { past.push(prev); if (past.length > LIMIT) past.shift(); }
    lastKey = (opts && opts.coalesce) || null; lastTime = t;
    future = [];
  }

  function apply(next, opts, kind) {
    if (sameValue(next, comp)) return false;
    const prev = comp;
    record(prev, opts);
    comp = next;
    emit(prev, kind, opts && opts.meta);
    return true;
  }

  return {
    get: () => comp,
    init(c) {
      const prev = comp;
      comp = Engine.sanitize(c || {});
      past = []; future = []; lastKey = null;
      emit(prev, 'init');
    },
    set(patch, opts) {
      const p = Engine.normalizePatch(comp, patch || {});
      return apply(Engine.sanitize(Object.assign({}, comp, p)), opts, 'set');
    },
    replace(c, opts) { return apply(Engine.sanitize(c || {}), opts, 'replace'); },
    undo() {
      if (!past.length) return false;
      const prev = comp; future.push(comp); comp = past.pop(); lastKey = null;
      emit(prev, 'undo'); return true;
    },
    redo() {
      if (!future.length) return false;
      const prev = comp; past.push(comp); comp = future.pop(); lastKey = null;
      emit(prev, 'redo'); return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    depth: () => ({ undo: past.length, redo: future.length }),
    on(fn) { subs.add(fn); return () => subs.delete(fn); }
  };
})();
