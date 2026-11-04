/* ==========================================================================
   soundscape.js (v9) — the LIVE player of the Soundscape: AudioContext, transport (play / stop / fade), user volume + mute, the
   look-ahead scheduler and the WAV download. It contains no musical or instrument knowledge; that lives in four modules loaded before it:

     sound-music.js    Music logic     colour -> scale / tempo / notes (pure functions, deterministic)
     sound-effects.js  Effects         the mix bus: reverb, echo, chorus (per sub-mode)
     sound-engines.js  Sound engines   one instrument + one ambient bed for each of the 19 style / sub-mode combinations
     sound-export.js   Audio export    offline render of the SAME session + mastering + WAV encoder

   Live graph:   session (bed + notes -> bus) -> masterGain (play / stop fade) -> outputGain (user volume / mute) -> analyser -> speakers
   WAV render:   session (bed + notes -> bus) -> mastering (fades + one level)  -> 16-bit stereo WAV          [see sound-export.js]
   The live player and the export therefore run the same musical sequence, instruments, ambience, effects and relative levels;
   they differ only in the master stage and in how notes are scheduled (timer look-ahead vs. plain loop).

   Style / sub-mode -> instrument (details in sound-engines.js):
     fluid: surf + marimba (warm) / kalimba (cool)          paper: waves guitar+woodblock · canyon breathy flute+echo · cutout pizzicato+rustle
     aurora: prism vowel choir · glass glass-harp · neon analog chorus pad          polygon: flat koto · faceted harp+taiko · constellation
     bells · isometric marimba triads · shatter ice shards          crystal: harmonic celesta · chaotic wind chimes · geode singing bowl ·
     stained pipe organ+bell          chroma: mercury bowed cello · iridescent shimmer pair · molten sub-bass growl
   ========================================================================== */
const Soundscape = (function () {
  'use strict';

  const EPS = 0.0001;
  const GAIN_AT_FULL = 1.4;       // output gain at 100 % (the historical scale: volume * 1.4)
  const LOOKAHEAD = 0.5;          // seconds of notes scheduled ahead of the audio clock
  const TICK_MS = 90;             // how often the scheduler wakes up
  // WHEN a new session starts. Two facts about a real-time AudioContext decide this:
  //  1. Building a session (a few dozen nodes) takes real main-thread time (12-32 ms measured, more under load) while the audio clock keeps
  //     running. A node whose start time is already behind the clock starts late, so the bed and the chorus LFO would begin a little late against
  //     the notes - by a different amount on every start (the WAV has no such problem: its clock stands still while it is built).
  //  2. Start times land on the 128-frame render grid of the clock, not between its lines. The notes of one piece sit on that grid at fixed
  //     offsets from the session start, so the start must itself be ON the grid for the live notes to keep exactly the spacing the WAV has;
  //     off the grid, two overlapping notes of one pitch can end up half a wave apart and cancel (measured: -18 dB dips, envelope correlation 0.9 instead of 0.9999).
  // So the start is placed a whole number of render quanta ahead of the clock (SETUP_QUANTA = about 120 ms), never "now + some seconds".
  const QUANTUM = 128;
  const SETUP_QUANTA = 42;
  const sessionStart = now => { const q = QUANTUM / ctx.sampleRate; return (Math.round(now / q) + SETUP_QUANTA) * q; };

  let ctx = null;
  let masterGain = null;          // play / stop fade only
  let outputGain = null;          // user level (volume / mute)
  let analyser = null;
  let freqData = null;
  let playing = false;
  let starting = false;           // start() has been called, the AudioContext is still resuming
  let volume = 0.18;              // safe 18 % default (0..1, kept while muted)
  let lastAudible = 0.18;         // last non-zero volume, restored when un-muting from 0 %
  let muted = false;
  let startSlack = null;          // diagnostics: seconds between "session built" and its start time (must stay > 0, else the setup margin is too small)
  let contextsCreated = 0;        // diagnostics only: must stay 1 for the whole page (mute / volume never rebuild the graph)
  let timer = 0;
  let currentParams = null;
  let sequencer = null;
  let session = null;             // the sounding bed + instrument of the current style / sub-mode
  let sessionMode = '';           // dna.key the session was built for
  let sessionsAlive = 0;          // diagnostics: sessions created and not yet disposed (1 while playing, 2 only during a crossfade)
  const listeners = new Set();

  const getDna = () => SoundMusic.analyze(currentParams);

  /* ---------------------------------------------------------------- audio graph */
  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      contextsCreated++;
      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(EPS, ctx.currentTime);
      outputGain = ctx.createGain();
      outputGain.gain.setValueAtTime(outputLevel(), ctx.currentTime);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      masterGain.connect(outputGain);
      outputGain.connect(analyser);
      analyser.connect(ctx.destination);
      ctx.onstatechange = onContextStateChange;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /* ---------------------------------------------------------------- sessions (instrument + bed of one sub-mode) */
  function openSession(fadeIn, t0) {
    const dna = getDna();
    session = SoundEngines.createSession(ctx, dna, masterGain, { fadeIn, t0 });
    sessionsAlive++;
    sessionMode = dna.key;
    session.startBed(t0);
    startSlack = t0 - ctx.currentTime;
  }

  function closeSession(fadeSec) {
    if (!session) return;
    const old = session;
    session = null;
    const ms = old.close(ctx.currentTime, fadeSec);
    setTimeout(() => { old.dispose(); sessionsAlive--; }, ms);   // after the fade and the reverb tail
  }

  /* ---------------------------------------------------------------- scheduler */
  function tick() {
    clearTimeout(timer);
    if (!playing || !ctx || !sequencer) return;
    sequencer.advance(ctx.currentTime + LOOKAHEAD, (note, t, dna) => { if (session) session.play(note, t, dna); }, ctx.currentTime);
    timer = setTimeout(tick, TICK_MS);
  }

  /* ---------------------------------------------------------------- user level: volume + mute */
  /** Gain the output stage must have right now: exactly 0 when muted or at 0 %, never a "floor" that stays audible. */
  function outputLevel() {
    return muted ? 0 : volume * GAIN_AT_FULL;
  }

  /** Move the output gain to the current user level without re-creating anything (click-free ramp). */
  function applyOutputLevel(rampSec) {
    if (!ctx || !outputGain) return;
    const g = outputGain.gain, now = ctx.currentTime, target = outputLevel();
    const cur = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    if (target === cur) return;
    g.linearRampToValueAtTime(target, now + Math.max(0.01, rampSec));   // linear ramp reaches exactly 0 for mute / 0 %
  }

  function snapshot() {
    const running = !!ctx && ctx.state === 'running';
    const on = playing && (starting || running);
    return {
      playing: on,                                   // what the user hears or is about to hear
      muted,
      volume: Math.round(volume * 100),
      running,                                       // the AudioContext is really producing samples
      audible: on && running && !muted && volume > 0
    };
  }

  function emit() {
    const st = snapshot();
    listeners.forEach(fn => { try { fn(st); } catch (e) { console.error('[Soundscape.onChange]', e); } });
  }

  /** Subscribe to every change of play / mute / volume / real AudioContext state. Returns an unsubscribe function. */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** The browser suspended / interrupted the context (phone call, OS policy): stop cleanly instead of showing a lie. */
  function onContextStateChange() {
    if (playing && !starting && ctx && ctx.state !== 'running') halt(0.05);
    emit();
  }

  /* ---------------------------------------------------------------- transport */
  function start(params) {
    currentParams = params || currentParams;
    ensureContext();
    playing = true;
    starting = ctx.state !== 'running';
    const launch = () => {
      starting = false;
      if (!playing || !ctx) { emit(); return; }
      const now = ctx.currentTime, t0 = sessionStart(now), cur = Math.max(EPS, masterGain.gain.value);
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(cur, now);
      masterGain.gain.setValueAtTime(cur, t0);                       // the 0.45 s fade-in belongs to the start of the piece, not to the moment of the click
      masterGain.gain.linearRampToValueAtTime(1, t0 + 0.45);
      applyOutputLevel(0.02);
      closeSession(0.05);                                            // never two sessions at once, never state carried over
      sequencer = SoundMusic.createSequencer(getDna, t0 + SoundMusic.LEAD, 0);   // every start begins the piece from its first bar, the same lead-in as the WAV
      openSession(0, t0);
      tick();
      emit();
    };
    if (ctx.state === 'running') {
      launch();
    } else {
      emit();                                        // "starting": button is pressed, nothing is audible yet
      ctx.resume().then(launch, () => { starting = false; halt(0.05); emit(); });
      // A context that never resumes (blocked by the browser) must not leave the button pretending that sound is on.
      setTimeout(() => { if (starting && playing && ctx.state !== 'running') { halt(0.05); emit(); } }, 2500);
    }
  }

  function halt(fadeSec) {
    playing = false;
    starting = false;
    clearTimeout(timer);
    sequencer = null;
    if (ctx && masterGain) {
      const now = ctx.currentTime;
      closeSession(fadeSec);
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(Math.max(EPS, masterGain.gain.value), now);
      masterGain.gain.linearRampToValueAtTime(EPS, now + fadeSec);
    }
  }

  function stop() {
    halt(0.4);
    emit();
  }

  function toggle(params) {
    if (playing) { stop(); return false; }
    start(params);
    return true;
  }

  /** Mute keeps the music running (so un-muting continues in time) and keeps the chosen volume untouched. */
  function setMuted(flag) {
    flag = !!flag;
    if (!flag && volume === 0) volume = lastAudible;     // un-muting from 0 % would stay silent: go back to the last audible level
    if (flag === muted) { emit(); return muted; }
    muted = flag;
    applyOutputLevel(muted ? 0.06 : 0.12);
    emit();
    return muted;
  }

  /** One button for mute and un-mute; at 0 % the button restores the last audible volume instead. */
  function toggleMute() {
    if (!muted && volume === 0) { volume = lastAudible; applyOutputLevel(0.12); emit(); return false; }
    return setMuted(!muted);
  }

  /** The artwork changed. A new style / sub-mode crossfades into its own instrument and bed; a new palette just keeps playing with it. */
  function updateParams(params) {
    currentParams = params;
    if (!playing || !ctx || !session) return;
    if (getDna().key !== sessionMode) {
      const t0 = sessionStart(ctx.currentTime);
      closeSession(1.2);                              // the old instrument rings out under the new one instead of being cut
      openSession(0.35, t0);
      if (sequencer) sequencer.retime(t0 + SoundMusic.LEAD);    // and the new one speaks at once, not after the old grid's next step
    }
  }

  /** Volume 0..100 (%). Never changes the mute flag and never touches play / stop / style changes. */
  function setVolume(val0to100) {
    const n = Number(val0to100);
    volume = Math.max(0, Math.min(1, (isFinite(n) ? n : 18) / 100));
    if (volume > 0) lastAudible = volume;
    applyOutputLevel(0.05);
    emit();
  }

  /** Live loudness of the output (for the animation's audio-reactive physics). Silent while stopped or muted. */
  function getEnergy() {
    if (!playing || !analyser || !freqData) return { level: 0, bass: 0, treble: 0 };
    analyser.getByteFrequencyData(freqData);
    let bassSum = 0, trebSum = 0;
    const bassBins = 16, totalBins = 64;
    for (let i = 0; i < bassBins; i++) bassSum += freqData[i];
    for (let i = bassBins; i < totalBins; i++) trebSum += freqData[i];
    const bass = bassSum / (bassBins * 255);
    const treble = trebSum / ((totalBins - bassBins) * 255);
    return {
      level: Math.min(1, (bass * 0.65 + treble * 0.35) * 1.8),
      bass: Math.min(1, bass * 1.9),
      treble: Math.min(1, treble * 2.1)
    };
  }

  /* ---------------------------------------------------------------- WAV export (the render itself is sound-export.js) */
  /** Renders offline (never touches the live graph, volume or mute) and downloads the file. */
  async function exportWav(params, durationSec, artName) {
    const res = await SoundExport.render(params, durationSec);
    const blob = new Blob([SoundExport.toWavBuffer(res.channels, res.rate)], { type: 'audio/wav' });
    const safeName = (artName || 'Fluid_Soundscape').replace(/[^a-z0-9_-]/gi, '_');
    const fileName = `${safeName}_${res.seconds}s.wav`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { file: fileName, size: (blob.size / 1024 / 1024).toFixed(2) + ' MB', report: res.report };
  }

  return {
    start, stop, toggle, updateParams, setVolume, setMuted, toggleMute, getEnergy, exportWav,
    isPlaying: () => snapshot().playing,
    isMuted: () => muted,
    getVolume: () => Math.round(volume * 100),
    getState: snapshot,
    /** Offline render without download (tests, tools): { channels, rate, seconds, report }. */
    renderOffline: (params, seconds, opts) => SoundExport.render(params, seconds, opts),
    /** Read-only diagnostics for tests and bug reports (levels are linear gains, not percentages). */
    debug: () => ({
      contextsCreated, ctxState: ctx ? ctx.state : 'none', sampleRate: ctx ? ctx.sampleRate : null,
      outputGain: outputGain ? outputGain.gain.value : null, masterGain: masterGain ? masterGain.gain.value : null,
      time: ctx ? ctx.currentTime : 0, startSlackMs: startSlack === null ? null : Math.round(startSlack * 1000), sessionKey: session ? session.key : null, sessionOpen: !!session, sessionsAlive, step: sequencer ? sequencer.index : 0
    }),
    onChange,
    analyzeMusicalDNA: SoundMusic.analyze
  };
})();
