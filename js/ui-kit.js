/* ==========================================================================
   ui-kit.js — small, dependency-free UI primitives shared by every module.
   UI.toast / UI.menu / UI.tabs / UI.open / UI.close / UI.confirm / UI.copy / UI.busy (optionally with a Cancel) / UI.setBusy
   plus helpers: UI.esc, UI.icon, UI.el, UI.debounce, UI.raf, UI.clamp, UI.isTyping
   ========================================================================== */
const UI = (function () {
  'use strict';

  const tr = (k, v) => (typeof t === 'function' ? t(k, v) : k);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls) => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  /** el('button', {class:'btn', onclick: fn, dataset:{x:1}}, 'text' | node | [nodes]) — text always goes in as text. */
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        // custom properties (--c) only work through setProperty; Object.assign(style, ...) silently ignores them
        for (const p of Object.keys(v)) { if (p.startsWith('--')) n.style.setProperty(p, v[p]); else n.style[p] = v[p]; }
      }
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    [].concat(kids === undefined ? [] : kids).forEach(c => {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }

  function debounce(fn, ms) {
    let id = 0;
    const d = function () { const a = arguments, self = this; clearTimeout(id); id = setTimeout(() => fn.apply(self, a), ms); };
    d.cancel = () => clearTimeout(id);
    d.flush = function () { clearTimeout(id); fn.apply(this, arguments); };
    return d;
  }
  /** Run fn at most once per animation frame (last arguments win). */
  function raf(fn) {
    let queued = false, args;
    return function () { args = arguments; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn.apply(null, args); }); };
  }
  const isTyping = e => {
    const el = e.target;
    if (!el || !el.tagName) return false;
    return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes(el.type));
  };

  /* ------------------------------ toasts ------------------------------ */
  const ICON = { success: 'check', info: 'info', warn: 'info', error: 'info' };
  function toast(msg, opts) {
    opts = opts || {};
    const host = document.getElementById('toasts');
    if (!host) return null;
    const type = opts.type || 'info';
    const node = el('div', { class: 'toast toast-' + type, role: type === 'error' ? 'alert' : 'status' });
    node.innerHTML = icon(ICON[type] || 'info', 'toast-ico');
    node.appendChild(el('span', { class: 'toast-msg' }, msg));
    let timer = 0;
    const dismiss = () => {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 180);
    };
    if (opts.action) {
      node.appendChild(el('button', { class: 'toast-act', type: 'button', onclick: () => { dismiss(); opts.action.fn(); } }, opts.action.label));
    }
    const x = el('button', { class: 'toast-x', type: 'button', 'aria-label': tr('close'), onclick: dismiss });
    x.innerHTML = icon('x');
    node.appendChild(x);
    host.appendChild(node);
    while (host.children.length > 4) host.firstElementChild.remove();
    const ms = opts.ms === undefined ? (type === 'error' || type === 'warn' ? 6500 : 3200) : opts.ms;
    const arm = () => { if (ms > 0) { clearTimeout(timer); timer = setTimeout(dismiss, ms); } };
    // The message itself ignores the pointer (see CSS), so only hovering its buttons, or focusing them, pauses the countdown.
    node.querySelectorAll('button').forEach(btn => { btn.addEventListener('pointerenter', () => clearTimeout(timer)); btn.addEventListener('pointerleave', arm); });
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('focusout', arm);
    arm();
    return { dismiss, node };
  }

  /* ------------------------------ tooltips ------------------------------ */
  function tooltips() {
    const tip = el('div', { class: 'tooltip', role: 'tooltip', id: 'tooltip' });
    tip.hidden = true;
    document.body.appendChild(tip);
    let showTimer = 0, current = null;
    function place(target) {
      const r = target.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = '0px'; tip.style.top = '0px';
      const tr_ = tip.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr_.width / 2;
      x = clamp(x, 8, window.innerWidth - tr_.width - 8);
      let y = r.top - tr_.height - 8, below = false;
      if (y < 8) { y = r.bottom + 8; below = true; }
      tip.dataset.side = below ? 'below' : 'above';
      tip.style.left = Math.round(x) + 'px'; tip.style.top = Math.round(y) + 'px';
    }
    function show(target, delay) {
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        const text = target.dataset.tip;
        if (!text) return;
        current = target; tip.textContent = text; place(target);
        target.setAttribute('aria-describedby', 'tooltip');
      }, delay);
    }
    function hide() {
      clearTimeout(showTimer);
      tip.hidden = true;
      if (current) { current.removeAttribute('aria-describedby'); current = null; }
    }
    document.addEventListener('pointerover', e => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const target = e.target.closest && e.target.closest('[data-tip]');
      if (target) show(target, 380);
    });
    document.addEventListener('pointerout', e => {
      const target = e.target.closest && e.target.closest('[data-tip]');
      if (target && !target.contains(e.relatedTarget)) hide();
    });
    document.addEventListener('focusin', e => {
      const target = e.target.closest && e.target.closest('[data-tip]');
      if (target && e.target.matches(':focus-visible')) show(target, 0);
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
  }

  /* ------------------------------ menu button ------------------------------ */
  function menu(btn, panel, onPick) {
    const items = () => Array.from(panel.querySelectorAll('[role="menuitem"]'));
    const outside = e => { if (!panel.contains(e.target) && !btn.contains(e.target)) close(false); };
    function open() {
      panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      const f = items()[0]; if (f) f.focus();
    }
    function close(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      if (returnFocus) btn.focus();
    }
    btn.addEventListener('click', () => (panel.hidden ? open() : close(true)));
    btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && panel.hidden) { e.preventDefault(); open(); } });
    panel.addEventListener('keydown', e => {
      const list = items(), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    panel.addEventListener('click', e => {
      const item = e.target.closest('[role="menuitem"]');
      if (!item) return;
      close(true); onPick(item);
    });
    return { open, close };
  }

  /* ------------------------------ tabs / segmented control ------------------------------ */
  function tabs(list, opts) {
    opts = opts || {};
    const items = () => Array.from(list.querySelectorAll('[role="tab"]'));
    function select(btn, focus, silent) {
      if (!btn) return;
      items().forEach(b => {
        const on = b === btn;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        const pid = b.getAttribute('aria-controls');
        if (pid) { const p = document.getElementById(pid); if (p) p.hidden = !on; }
      });
      if (focus) btn.focus();
      if (!silent && opts.onSelect) opts.onSelect(btn);
    }
    function current() { return items().find(b => b.getAttribute('aria-selected') === 'true') || items()[0]; }
    function refresh() { const c = current(); items().forEach(b => { b.tabIndex = b === c ? 0 : -1; }); }
    list.addEventListener('click', e => {
      const b = e.target.closest('[role="tab"]');
      if (b && list.contains(b) && !b.disabled) select(b);
    });
    list.addEventListener('keydown', e => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const list_ = items().filter(b => !b.disabled), i = list_.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      let n = i;
      if (e.key === 'ArrowRight') n = (i + 1) % list_.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + list_.length) % list_.length;
      else if (e.key === 'Home') n = 0; else n = list_.length - 1;
      select(list_[n], true);
    });
    refresh();
    return { select, items, current, refresh, byValue: (attr, v) => items().find(b => b.dataset[attr] === v) };
  }

  /** Pressed / checked groups (aria-pressed or aria-checked buttons) — exactly one active. */
  function radioGroup(group, attr, onPick) {
    const items = () => Array.from(group.children).filter(b => b.hasAttribute(attr) || b.getAttribute('role') === 'radio');
    const key = attr === 'aria-pressed' ? 'aria-pressed' : 'aria-checked';
    function set(btn, silent) {
      items().forEach(b => { b.setAttribute(key, b === btn ? 'true' : 'false'); if (key === 'aria-checked') b.tabIndex = b === btn ? 0 : -1; });
      if (!silent && onPick) onPick(btn);
    }
    group.addEventListener('click', e => { const b = e.target.closest('button'); if (b && group.contains(b)) set(b); });
    if (key === 'aria-checked') {
      group.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const list = items(), i = list.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const n = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        set(list[n]); list[n].focus();
      });
    }
    return { set, items };
  }

  /* ------------------------------ dialogs ------------------------------ */
  const NO_BACKDROP = new Set(['manualCropModal', 'cardModal', 'animModal']);
  function wireDialogs() {
    document.querySelectorAll('dialog').forEach(d => {
      d.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('[data-close]')) { d.close(); return; }
        if (e.target !== d || NO_BACKDROP.has(d.id)) return;
        const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
      });
      d.addEventListener('close', () => {
        const back = d._returnFocus; d._returnFocus = null;
        if (back && document.contains(back) && typeof back.focus === 'function') { try { back.focus(); } catch (e) { /* ignore */ } }
      });
    });
  }
  function open(id) {
    const d = typeof id === 'string' ? document.getElementById(id) : id;
    if (!d) return null;
    if (!d.open) { d._returnFocus = document.activeElement; d.showModal(); }
    return d;
  }
  function close(id) { const d = typeof id === 'string' ? document.getElementById(id) : id; if (d && d.open) d.close(); }

  function confirm(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      let d = document.getElementById('confirmModal');
      if (!d) {
        d = el('dialog', { id: 'confirmModal', class: 'modal modal-sm', 'aria-labelledby': 'confirmTitle' });
        d.innerHTML = '<div class="modal-head"><h3 id="confirmTitle"></h3></div><p class="confirm-msg" id="confirmMsg"></p>' +
          '<div class="modal-foot"><button class="btn secondary" id="confirmNo" type="button"></button><button class="btn primary" id="confirmYes" type="button"></button></div>';
        document.body.appendChild(d);
      }
      d.querySelector('#confirmTitle').textContent = opts.title || tr('confirm_title');
      d.querySelector('#confirmMsg').textContent = message;
      const yes = d.querySelector('#confirmYes'), no = d.querySelector('#confirmNo');
      yes.textContent = opts.yes || tr('confirm_yes'); no.textContent = opts.no || tr('cancel');
      yes.classList.toggle('danger', !!opts.danger);
      let answer = false;
      const done = () => { d.removeEventListener('close', done); yes.onclick = no.onclick = null; resolve(answer); };
      yes.onclick = () => { answer = true; d.close(); };
      no.onclick = () => { answer = false; d.close(); };
      d.addEventListener('close', done);
      d._returnFocus = document.activeElement;
      d.showModal(); no.focus();
    });
  }

  /* ------------------------------ clipboard ------------------------------ */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = el('textarea', { readonly: '', 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
      ta.value = text; document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }
  function flash(btn) {
    if (!btn) return;
    btn.classList.add('is-done');
    const use = btn.querySelector('use'), old = use && use.getAttribute('href');
    if (use) use.setAttribute('href', '#i-check');
    setTimeout(() => { btn.classList.remove('is-done'); if (use && old) use.setAttribute('href', old); }, 1300);
  }
  /** Copy text; the toast and the button flash only appear when the copy really happened. */
  async function copy(text, opts) {
    opts = opts || {};
    const ok = await copyText(text);
    if (ok) {
      flash(opts.btn);
      if (!opts.quiet) toast(opts.label ? tr('copied_what', { what: opts.label }) : tr('copied'), { type: 'success', ms: 1800 });
    } else {
      toast(tr('copy_failed'), { type: 'error' });
    }
    return ok;
  }

  /* ------------------------------ busy button ------------------------------ */
  /** Processing state of ONE button, the same everywhere: disabled + aria-busy. The CSS ([aria-busy="true"]) draws a spinner in place of the label at the
   *  button's own size and keeps full opacity (it is working, not unavailable). setBusy(btn, false) restores it. */
  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  }

  /* ------------------------------ busy overlay ------------------------------ */
  let busyCancel = null;                                  // what the overlay's Cancel button does right now (null = no button)
  /** busy(true, text, { onCancel }) shows the overlay (with a Cancel button when onCancel is given and until busy(false)); busy(true, text) only changes the text. */
  function busy(on, text, opts) {
    const b = document.getElementById('busy'), tx = document.getElementById('busyText'), cb = document.getElementById('busyCancel');
    if (!b) return;
    if (text && tx) tx.textContent = text;
    if (!on) busyCancel = null; else if (opts && typeof opts.onCancel === 'function') busyCancel = opts.onCancel;
    if (cb) cb.classList.toggle('hidden', !busyCancel);
    b.classList.toggle('hidden', !on);
  }
  function cancelBusy() { const f = busyCancel; if (f) { busyCancel = null; const cb = document.getElementById('busyCancel'); if (cb) cb.classList.add('hidden'); f(); } }

  function shortcuts(listEl, rows) {
    listEl.innerHTML = '';
    rows.forEach(([keys, descKey]) => {
      const dt = el('dt', null, keys.map((k, i) => [i ? el('span', { class: 'kbd-plus' }, '+') : null, el('kbd', null, k)]).flat());
      listEl.appendChild(el('div', { class: 'sc-row' }, [dt, el('dd', null, tr(descKey))]));
    });
  }

  /** Thickness of a thin classic scrollbar (0 for overlay scrollbars), published as --sbw so rows that can grow a
   *  horizontal scrollbar (the colour rail) reserve that room up front and the artwork above them never changes size. */
  function measureScrollbar() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99px;top:-99px;width:60px;height:60px;overflow:scroll;scrollbar-width:thin;visibility:hidden';
    document.body.appendChild(probe);
    const w = Math.max(probe.offsetHeight - probe.clientHeight, probe.offsetWidth - probe.clientWidth);
    probe.remove();
    document.documentElement.style.setProperty('--sbw', Math.max(0, Math.min(24, w)) + 'px');
  }

  /** The overlay's Cancel button, and Escape while it is showing (a long export must always be abortable). */
  function wireBusyCancel() {
    const cb = document.getElementById('busyCancel');
    if (cb) cb.addEventListener('click', cancelBusy);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && busyCancel) { e.preventDefault(); cancelBusy(); } });
  }
  function init() { measureScrollbar(); tooltips(); wireDialogs(); wireBusyCancel(); }

  return { init, toast, menu, tabs, radioGroup, open, close, confirm, copy, copyText, busy, setBusy, shortcuts,
    esc, icon, el, debounce, raf, clamp, isTyping };
})();
