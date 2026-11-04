/* ==========================================================================
   sound-ui.js — the one controller for every Soundscape control in the page.

   Two places show the same controls (the stage bar under the artwork and the Live-animation dialog). Both are described by
   one table (PANELS) and both are drawn from ONE source of truth: Soundscape.getState(). Nothing here keeps its own copy of
   "is it playing / muted / what volume", so the buttons can never disagree with the audio engine or with each other.

     Sound button   toggles play / stop           (aria-pressed = really playing)
     chevron button opens the level popover       (aria-expanded; click / tap / Enter / Space; Esc or outside click closes)
     mute button    mute <-> un-mute              (silent, keeps the chosen volume; never re-creates the audio graph)
     volume slider  0..100 %                      (changing it never un-mutes, never touches play / stop / style changes)
     WAV button     offline render + download     (independent of live volume / mute)

   Loaded after soundscape.js; talks to App / Engine / Store only inside event handlers (App does not exist yet at load time).
   ========================================================================== */
const SoundUI = (function () {
  'use strict';

  const PANELS = [
    { wrap: 'soundBar',      play: 'btnSoundscape', menu: 'btnSoundMenu', pop: 'soundPop',     mute: 'btnSoundMute', vol: 'soundVol',      val: 'soundVolVal',      wav: 'btnDownloadWav', seconds: () => 10 },
    { wrap: 'animSoundWrap', play: 'animSoundBtn',  menu: 'animSoundMenu', pop: 'animSoundPop', mute: 'animMute',     vol: 'animSoundVol',  val: 'animSoundVolVal',  wav: 'dlSoundBtn',
      seconds: () => Math.max(8, Number($('animDuration') && $('animDuration').value) || 10) }
  ];

  let panels = [];
  let exporting = false;
  let startedByUser = false;     // a start was requested by a click and not yet confirmed (to tell "blocked by the browser" apart)
  let ready = false;

  const sound = () => (typeof Soundscape !== 'undefined' ? Soundscape : null);

  /* ------------------------------------------------------------------ drawing */
  function icon(btn, name) {
    const use = btn && btn.querySelector('use');
    if (use && use.getAttribute('href') !== '#' + name) use.setAttribute('href', '#' + name);
  }

  function setTip(btn, text) {
    if (!btn) return;
    if (text) btn.dataset.tip = text; else delete btn.dataset.tip;
  }

  function render() {
    const S = sound();
    if (!S) return;
    const st = S.getState();
    const silent = st.muted || st.volume === 0;
    panels.forEach(p => {
      p.wrap.classList.toggle('is-playing', st.playing);
      p.wrap.classList.toggle('is-muted', silent);
      p.wrap.dataset.sound = st.playing ? (silent ? 'muted' : 'playing') : 'off';
      p.play.setAttribute('aria-pressed', st.playing ? 'true' : 'false');
      icon(p.play, silent ? 'i-volume-x' : 'i-volume');
      setTip(p.play, t(st.playing ? 'sound_tip_stop' : 'sound_tip'));

      p.mute.setAttribute('aria-pressed', silent ? 'true' : 'false');
      p.mute.setAttribute('aria-label', t('sound_mute'));
      icon(p.mute, silent ? 'i-volume-x' : 'i-volume');
      setTip(p.mute, t(silent ? 'sound_unmute' : 'sound_mute'));

      if (Number(p.vol.value) !== st.volume) p.vol.value = String(st.volume);
      p.vol.setAttribute('aria-valuetext', st.muted ? t('sound_vol_muted', { vol: st.volume }) : st.volume + '%');
      p.val.textContent = st.volume + '%';
      p.wav.disabled = exporting;
    });
  }

  /* ------------------------------------------------------------------ popover */
  function setOpen(p, open, returnFocus) {
    if (!!p.pop.hidden === !open) return;
    p.pop.hidden = !open;
    p.menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    p.wrap.classList.toggle('is-open', open);
    if (!open && returnFocus) p.menu.focus();
  }

  function closeAll(except) {
    panels.forEach(p => { if (p !== except) setOpen(p, false); });
  }

  /* ------------------------------------------------------------------ actions */
  function toast(msg, opts) { if (typeof UI !== 'undefined') UI.toast(msg, opts); }

  function onPlay() {
    const S = sound();
    if (!S) return;
    const wasOn = S.getState().playing;
    startedByUser = !wasOn;
    S.toggle(App.getParams());
    if (!wasOn) {
      const st = S.getState();
      if (st.playing) toast(t(st.muted || st.volume === 0 ? 'sound_on_muted' : 'sound_on', { vol: st.volume }), { type: 'info', ms: 2400 });
    }
  }

  /** Called on every engine change: if a user-requested start never came through (browser blocked audio), say so. */
  function onEngineChange() {
    const S = sound();
    if (startedByUser && S) {
      const st = S.getState();
      if (st.playing && st.running) startedByUser = false;                 // confirmed
      else if (!st.playing) { startedByUser = false; toast(t('sound_blocked'), { type: 'warn', ms: 4200 }); }
    }
    render();
  }

  async function onWav(p) {
    const S = sound();
    if (!S || exporting) return;
    exporting = true;
    panels.forEach(q => { q.wav.classList.toggle('is-busy', q === p); q.wav.setAttribute('aria-busy', q === p ? 'true' : 'false'); });
    render();
    try {
      const res = await S.exportWav(App.getParams(), p.seconds(), App.artName());
      toast(t('sound_exported', { file: res.file, size: res.size }), { type: 'success' });
    } catch (err) {
      console.error('[Soundscape.exportWav]', err);
      toast(t('sound_export_fail'), { type: 'error' });
    } finally {
      exporting = false;
      panels.forEach(q => { q.wav.classList.remove('is-busy'); q.wav.removeAttribute('aria-busy'); });
      render();
    }
  }

  /* ------------------------------------------------------------------ wiring */
  function wire(p) {
    p.play.addEventListener('click', onPlay);
    p.menu.addEventListener('click', () => { const open = p.pop.hidden; closeAll(p); setOpen(p, open); });
    p.mute.addEventListener('click', () => { const S = sound(); if (S) S.toggleMute(); });
    p.vol.addEventListener('input', e => { const S = sound(); if (S) S.setVolume(Number(e.target.value)); });
    p.wav.addEventListener('click', () => onWav(p));

    // Esc closes the popover first (and, inside the dialog, does not also close the dialog); focus returns to the opener.
    p.wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !p.pop.hidden) { e.preventDefault(); e.stopPropagation(); setOpen(p, false, true); }
    });
    // Tabbing out of the control closes it.
    p.wrap.addEventListener('focusout', e => {
      if (!p.pop.hidden && e.relatedTarget && !p.wrap.contains(e.relatedTarget)) setOpen(p, false);
    });
  }

  function init() {
    if (ready) return;                       // never bind twice
    const S = sound();
    panels = PANELS.map(def => {
      const p = { seconds: def.seconds };
      for (const k of ['wrap', 'play', 'menu', 'pop', 'mute', 'vol', 'val', 'wav']) p[k] = $(def[k]);
      return p;
    }).filter(p => p.wrap && p.play && p.menu && p.pop && p.mute && p.vol && p.val && p.wav);
    if (!S || !panels.length) return;
    ready = true;
    panels.forEach(wire);
    // outside click / tap closes
    document.addEventListener('pointerdown', e => { panels.forEach(p => { if (!p.pop.hidden && !p.wrap.contains(e.target)) setOpen(p, false); }); }, true);
    // dialogs: closing the Animation dialog closes its popover
    document.addEventListener('close', e => { panels.forEach(p => { if (e.target.contains && e.target !== document && e.target.contains(p.wrap)) setOpen(p, false); }); }, true);
    document.addEventListener('langchange', render);
    S.onChange(onEngineChange);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { init, render, closeAll };
})();
