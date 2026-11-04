/* ==========================================================================
   sound-engines.js — SOUND ENGINES of the Soundscape: one instrument per style / sub-mode, plus the ambient bed that belongs to it.

   Everything here is written against a plain BaseAudioContext, so the SAME code plays live (AudioContext) and renders the WAV
   (OfflineAudioContext). The only things that differ between the two are outside this file: who owns the master stage, and who calls
   session.play() (a look-ahead timer live, a plain loop offline).

   Layers of a session:   notes (instrument)  +  bed (continuous ambience, see BEDS)  ->  trim  ->  bus (SoundFX: reverb / echo / chorus)
   Public:  createSession(ctx, dna, dest, opts) -> { key, play(note, t), startBed(t), close(t, fade) -> ms, dispose() }
            resolveKey(dna) · KEYS (every instrument) · hasBed(key) · LEVEL_TRIM / BED_LEVEL (calibrated levels)
            instruments (the raw instrument functions, for tests that listen to one voice without the bus)
   ========================================================================== */
const SoundEngines = (function () {
  'use strict';

  const EPS = 0.0001;
  const FX = SoundFX;
  const midiToFreq = SoundMusic.midiToFreq;

  /* ------------------------------------------------------------------ toolbox */
  function filt(ctx, type, f, q, dest) {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = Math.max(20, Math.min(f, ctx.sampleRate * 0.45)); b.Q.value = q || 0.7;
    if (dest) b.connect(dest);
    return b;
  }

  function osc(ctx, type, f, t, end, dest, cents) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (cents) o.detune.value = cents;
    if (dest) o.connect(dest);
    o.start(t); o.stop(end);
    return o;
  }

  /** Percussive envelope: quick linear attack, exponential decay to silence. */
  function pluckEnv(ctx, dest, t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.value = EPS;                                               // a GainNode starts at 1: a source that starts a fraction of a sample early would leak one full-level sample (a click on noise bursts) before the first event
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(Math.max(EPS * 2, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(EPS, t + attack + decay);
    g.connect(dest);
    return g;
  }

  /** Sustained envelope (organ, pad, bowed string): attack, hold at the peak, exponential release. */
  function holdEnv(ctx, dest, t, peak, attack, hold, release) {
    const g = ctx.createGain();
    g.gain.value = EPS;                                               // (see pluckEnv)
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(Math.max(EPS * 2, peak), t + attack);
    g.gain.setValueAtTime(Math.max(EPS * 2, peak), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(EPS, t + attack + hold + release);
    g.connect(dest);
    return g;
  }

  /**
   * Additive synthesis. spec = [[ratio, amp, decaySec, attackSec?], ...]; amplitudes are normalised so they add up to `peak`
   * (so every instrument starts from a comparable level). Partials above 45 % of the sample rate are dropped (no aliasing).
   * opts: peak, atk (default attack), cents (detune of the whole set), bend {cents, time}, hold (seconds: sustain at the peak before decaying — bowed / blown sounds)
   */
  function partials(ctx, dest, t, f0, spec, opts) {
    const atk = opts.atk === undefined ? 0.004 : opts.atk;
    const usable = spec.filter(s => f0 * s[0] < ctx.sampleRate * 0.45 && s[1] > 0);
    const total = usable.reduce((a, s) => a + s[1], 0) || 1;
    const made = [];
    usable.forEach(s => {
      const a = s[3] === undefined ? atk : s[3];
      const peak = opts.peak * s[1] / total;
      const g = opts.hold ? holdEnv(ctx, dest, t, peak, a, opts.hold, s[2]) : pluckEnv(ctx, dest, t, peak, a, s[2]);
      const o = osc(ctx, 'sine', f0 * s[0], t, t + a + (opts.hold || 0) + s[2] + 0.05, g, opts.cents);
      if (opts.bend) {
        o.detune.setValueAtTime(opts.bend.cents + (opts.cents || 0), t);
        o.detune.linearRampToValueAtTime(opts.cents || 0, t + opts.bend.time);
      }
      made.push(o);
    });
    return made;
  }

  /** A burst (or swell) of filtered noise: mallet thump, pick, breath, paper rustle, ice crack. */
  function breath(ctx, dest, t, dur, o) {
    const src = ctx.createBufferSource();
    src.buffer = FX.noiseBuffer(ctx);
    const f = filt(ctx, o.type || 'bandpass', o.freq, o.q || 1);
    const g = o.hold
      ? holdEnv(ctx, dest, t, o.peak, o.atk || 0.01, o.hold, dur)
      : pluckEnv(ctx, dest, t, o.peak, o.atk || 0.003, dur);
    src.connect(f); f.connect(g);
    src.start(t, o.offset || 0);
    src.stop(t + (o.atk || 0.01) + (o.hold || 0) + dur + 0.05);
  }

  /** Delayed, fading-in vibrato (in cents) applied to the detune of the given oscillators. */
  function vibrato(ctx, oscs, t, end, rate, cents, delay, fade) {
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = rate;
    depth.gain.setValueAtTime(0, t);
    depth.gain.setValueAtTime(0, t + delay);
    depth.gain.linearRampToValueAtTime(cents, t + delay + fade);
    lfo.connect(depth);
    oscs.forEach(o => depth.connect(o.detune));
    lfo.start(t); lfo.stop(end);
  }

  function panner(ctx, dest, pan) {
    if (!ctx.createStereoPanner) return dest;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(dest);
    return p;
  }

  const BELL = [[1, 1, 2.6], [2.756, 0.5, 1.2], [5.404, 0.28, 0.6], [8.933, 0.14, 0.3]];   // free metal bar: glockenspiel / chime

  /* ------------------------------------------------------------------ colour -> timbre helpers
     Brightness (n.bright, from V) and saturation (n.open, from S) reach every instrument, and each instrument spends `open` on what makes
     ITS tone richer: the upper partials of a bar, the cutoff of a pluck, the drawbars of an organ, the FM index of an ice shard ... ("open" = 1 is the
     reference tone: the instrument sounds as it always did; below 1 it is rounder and quieter in the highs, above 1 brighter and richer). */
  const pw = (x, k) => Math.pow(x, k);
  /** Scale the amplitude of every partial above the first by open^(k * partial number): low saturation thins the highs fastest. */
  const richen = (spec, open, k) => spec.map((s, i) => (i ? [s[0], s[1] * pw(open, k * i)].concat(s.slice(2)) : s));
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  /* ------------------------------------------------------------------ plucked strings (guitar, koto, harp, pizzicato) */
  /** o: parts, tilt (higher = duller), decay (s), cut (filter Hz), sweep [Hz, s], bend {cents,time}, peak, atk, pick {freq, peak} */
  function pluck(v, f, o) {
    const { ctx, out, t, n } = v;
    const lp = filt(ctx, 'lowpass', Math.min(o.cut, 9000), o.q || 0.8, out);
    if (o.sweep) {
      lp.frequency.setValueAtTime(Math.min(o.cut, 9000), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(180, o.sweep[0]), t + o.sweep[1]);
    }
    const spec = [];
    for (let k = 1; k <= o.parts; k++) spec.push([k * (1 + 0.0004 * k * k), Math.pow(k, -o.tilt), o.decay * Math.pow(k, -0.7)]);
    partials(ctx, lp, t, f, spec, { peak: o.peak * n.vel, atk: o.atk, bend: o.bend });
    if (o.pick) breath(ctx, lp, t, 0.02, { freq: o.pick.freq, q: 1.1, peak: o.pick.peak * n.vel, offset: n.rnd(8) * 3 });
  }

  /** Marimba / kalimba bar: strong fundamental, a short "ping" partial, a soft mallet thump. */
  function mallet(v, f, o) {
    const { ctx, out, t, n } = v;
    const gain = o.gain === undefined ? 1 : o.gain;
    if (gain < 0.03) return;                                            // a blend: the other mallet carries it
    const lp = filt(ctx, 'lowpass', o.cut, 0.7, out);
    const spec = o.spec.map(s => [s[0], s[1], s[2] * (o.dscale || 1)].concat(s.slice(3)));
    if (o.tines) {                                                      // two tines a few cents apart: the slow shimmer of a kalimba
      partials(ctx, lp, t, f, spec, { peak: o.peak * n.vel * gain * 0.7, atk: o.atk || 0.003, cents: -o.tines });
      partials(ctx, lp, t, f, spec, { peak: o.peak * n.vel * gain * 0.3, atk: o.atk || 0.003, cents: o.tines });   // 70 / 30: the beat shimmers (-7 dB at the dips) without ever nulling the note
    } else {
      partials(ctx, lp, t, f, spec, { peak: o.peak * n.vel * gain, atk: o.atk || 0.003 });
    }
    breath(ctx, lp, t, o.thumpDur || 0.014, { type: 'bandpass', freq: o.thump || 900, q: 1, peak: (o.thumpPeak || 0.04) * n.vel * n.bright * gain, offset: n.rnd(8) * 3 });
  }

  /* ------------------------------------------------------------------ instruments (one per style / sub-mode) */
  const INSTR = {};

  /* fluid (Mesh Glow) — the colour of each note picks its instrument:
       warm (red / orange / yellow)  rosewood MARIMBA: hard mallet (sharp click), bright 4x and 10x bar partials, short wooden decay
       cool (blue / teal / violet)   deep KALIMBA: thumb-soft start, two tines beating, a low box resonance, a long mellow ring, the tine's 6.27x ping
     A palette of one colour family is purely one instrument; mixed palettes use both (in proportion to the colours), and a colour on the border blends them. */
  INSTR.fluid = v => {
    const n = v.n, o = n.open, dw = v.dna && v.dna.warmth01 !== undefined ? v.dna.warmth01 : 0.5;
    const warmth = 0.75 * (0.5 + 0.5 * n.warmth) + 0.25 * dw;
    const marimba = smooth(0.38, 0.62, warmth);
    mallet(v, n.freq, { gain: marimba, spec: [[1, 1, 1.4], [4, 0.5 * pw(o, 1.6), 0.2], [9.9, 0.2 * pw(o, 2.2), 0.06]], cut: 1800 * n.bright * pw(o, 0.8), peak: 0.3, thump: 900, thumpPeak: 0.06, atk: 0.002 });
    mallet(v, n.freq, { gain: 1 - marimba, spec: [[0.5, 0.22, 2.6], [1, 1, 3.0], [6.27, 0.17 * pw(o, 1.8), 0.34]], cut: 900 * n.bright * pw(o, 0.6), peak: 0.3, thump: 420, thumpPeak: 0.05, thumpDur: 0.05, atk: 0.012, tines: 3 });
  };

  /* paper — waves: acoustic guitar + woodblock tap */
  INSTR['paper:waves'] = v => {
    const n = v.n, f = n.freq;
    pluck(v, f, {
      parts: n.warm ? 8 : 5, tilt: (n.warm ? 0.95 : 1.4) + (1 - n.open) * 0.9, decay: 2.0, cut: Math.min(5200, f * (3.5 + n.bright * 4) * pw(n.open, 0.8)),
      sweep: [f * 1.4, 0.45], peak: 0.34, atk: 0.005, q: 1.6, pick: { freq: 2400, peak: 0.05 * n.open }
    });
    if (n.idx % 4 === 0) {                                              // woodblock tap on the beat (the original's tactile click)
      const { ctx, out, t } = v;
      const g = pluckEnv(ctx, out, t, 0.14 * n.vel, 0.002, 0.045);
      const o = osc(ctx, 'sine', n.warm ? 760 : 580, t, t + 0.06, g);
      o.frequency.exponentialRampToValueAtTime(240, t + 0.035);
    }
  };

  /* paper — canyon: breathy bamboo (shakuhachi) flute with an echo off the canyon walls (the echo is on the bus) */
  INSTR['paper:canyon'] = v => {
    const { ctx, out, t, n } = v, f = n.freq;
    const body = holdEnv(ctx, filt(ctx, 'lowpass', Math.min(5200, f * 5.5 * (n.warm ? 1 : 0.8) * pw(n.open, 0.8)), 0.7, out), t, 0.3 * n.vel, 0.13, 0.6, 1.0);
    const end = t + 1.85, oscs = [];
    [[1, 1], [2, 0.24 * pw(n.open, 1.5)], [3, 0.08 * pw(n.open, 2)]].forEach(h => {
      const g = ctx.createGain(); g.gain.value = h[1]; g.connect(body);
      const o = osc(ctx, 'sine', f * h[0] * 0.97, t, end, g);              // blown slightly flat, rises into the note
      o.frequency.exponentialRampToValueAtTime(f * h[0], t + 0.1);
      oscs.push(o);
    });
    vibrato(ctx, oscs, t, end, 4.6 + n.rnd(9) * 0.8, 14, 0.35, 0.45);
    breath(ctx, out, t, 1.1, { freq: f * 2.1, q: 3, peak: 0.2 * n.vel, atk: 0.09, hold: 0.45, offset: n.rnd(8) * 3 });   // air in the tube
    breath(ctx, out, t, 0.05, { freq: f * 3, q: 2, peak: 0.1 * n.vel * n.open, atk: 0.004, offset: n.rnd(7) * 3 });                // chiff
  };

  /* paper — cutout: pizzicato strings / ukulele + a snip of paper */
  INSTR['paper:cutout'] = v => {
    const n = v.n, f = n.freq * (n.warm ? 1 : 1.5);
    pluck(v, f, { parts: 5, tilt: 0.8 + (1 - n.open) * 0.6, decay: 0.5, cut: f * 7 * pw(n.open, 0.9), sweep: [f * 2, 0.14], peak: 0.34, atk: 0.002, q: 1.3 });
    if (n.accent) breath(v.ctx, v.out, v.t, 0.05, { type: 'highpass', freq: 3600, q: 0.7, peak: 0.06 * n.vel * n.open, offset: n.rnd(8) * 3 });
  };

  /* aurora — prism: three-voice vowel choir + a prism chime on the strong beats */
  INSTR['aurora:prism'] = v => {
    const { ctx, out, t, n } = v;
    const vowel = (n.warm ? [800, 1150] : [350, 700]).map(fc => fc * (0.7 + 0.3 * n.open));     // "ah" for sunlit colours, "oo" for cool ones; a saturated colour opens the mouth and sharpens the vowel (higher formant Q)
    const third = n.warm ? 4 : 3, end = t + 3.0;
    [0, third, 7].forEach((semi, i) => {
      const body = holdEnv(ctx, out, t, 0.1 * n.vel, 0.6, 0.9, 1.3);
      const o = osc(ctx, 'sawtooth', midiToFreq(Math.min(84, n.midi + semi)), t, end, null, (i - 1) * 9);
      vibrato(ctx, [o], t, end, 5 + i * 0.3, 10, 0.5, 0.6);
      vowel.forEach((fc, k) => { const b = filt(ctx, 'bandpass', fc + i * 60, 5.5, body); o.connect(b); b.Q.value = (5.5 - k) * (0.65 + 0.35 * n.open); });
    });
    if (n.accent) partials(ctx, out, t + 0.02, n.freq * 4, [[1, 1, 1.4], [2.756, 0.3, 0.5]], { peak: 0.07 * n.vel * n.open, atk: 0.01 });
  };

  /* aurora — glass: bowed wine-glass harp (glass partials, two glasses beating) */
  INSTR['aurora:glass'] = v => {
    const { ctx, out, t, n } = v, f = n.freq * 2, spec = richen([[1, 1, 1.6], [2.32, 0.3, 1.2], [4.25, 0.1, 0.8]], n.open, 1.5);
    partials(ctx, out, t, f, spec, { peak: 0.11 * n.vel, atk: 0.35, hold: 0.9, cents: -3 });
    partials(ctx, out, t, f, spec, { peak: 0.06 * n.vel, atk: 0.4, hold: 0.9, cents: 3 });
  };

  /* aurora — neon: 80s analog chorus pad (detuned saws, resonant sweep, sub-octave; the chorus itself is on the bus) */
  INSTR['aurora:neon'] = v => {
    const { ctx, out, t, n } = v;
    [-11, 0, 11].forEach(d0 => {
      const det = d0 * (0.55 + 0.45 * n.open);                           // a saturated colour detunes the saws further apart: a lusher pad
      const lp = filt(ctx, 'lowpass', 280, 2.4 + 0.6 * n.open);
      lp.frequency.setValueAtTime(280, t);
      lp.frequency.exponentialRampToValueAtTime(1900 * n.bright * pw(n.open, 0.7), t + 0.8);
      lp.frequency.exponentialRampToValueAtTime(340, t + 2.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(0.11 * n.vel, t + 0.35); g.gain.exponentialRampToValueAtTime(EPS, t + 2.5);
      lp.connect(g); g.connect(out);
      osc(ctx, 'sawtooth', n.freq, t, t + 2.55, lp, det);
    });
    partials(ctx, out, t, n.freq * 0.5, [[1, 1, 2.2]], { peak: 0.06 * n.vel, atk: 0.3 });
  };

  /* polygon — flat: koto (bright pluck whose pitch dips as the string settles) */
  INSTR['polygon:flat'] = v => {
    const f = v.n.freq;
    pluck(v, f, { parts: 6, tilt: 0.9 + (1 - v.n.open) * 0.7, decay: 1.3, cut: f * 10 * pw(v.n.open, 0.8), sweep: [f * 3, 0.25], bend: { cents: 35, time: 0.05 }, peak: 0.34, atk: 0.004, q: 1.4, pick: { freq: 3000, peak: 0.06 * v.n.open } });
  };

  /* polygon — faceted: concert harp + taiko sub-drum */
  INSTR['polygon:faceted'] = v => {
    const { ctx, out, t, n, dna } = v;
    pluck(v, n.freq, { parts: 5, tilt: 1.5 + (1 - n.open) * 0.7, decay: 2.6, cut: n.freq * 6 * pw(n.open, 0.8), peak: 0.34, atk: 0.006, q: 0.8 });
    if (n.idx % 2 === 0) {
      const base = midiToFreq(dna.rootMidi - 12), g = pluckEnv(ctx, out, t, 0.28, 0.003, 0.24);
      const o = osc(ctx, 'sine', base * 2.1, t, t + 0.27, g);
      o.frequency.exponentialRampToValueAtTime(base * 0.75, t + 0.11);
      breath(ctx, out, t, 0.05, { type: 'lowpass', freq: 320, q: 0.8, peak: 0.12, offset: n.rnd(8) * 3 });   // the skin
    }
  };

  /* polygon — constellation: glockenspiel / Rhodes bell floating in space */
  INSTR['polygon:constellation'] = v => {
    const n = v.n;
    partials(v.ctx, v.out, v.t, n.freq * 1.5, richen(BELL, n.open, 1.2), { peak: 0.26 * n.vel, atk: 0.003 });
  };

  /* polygon — isometric: marimba triad stabs (three "faces" 25 ms apart) with a chip-tune blip on top */
  INSTR['polygon:isometric'] = v => {
    const { ctx, out, t, n } = v;
    [1, n.warm ? 1.25 : 1.2, 1.5].forEach((mult, i) => {
      const vv = { ctx, out, t: t + i * 0.025, n };
      mallet(vv, n.freq * mult, { spec: [[1, 1, 1.1], [4, 0.45, 0.16], [9.9, 0.15, 0.05]], dscale: 0.5, cut: 2600 * pw(n.open, 0.8), peak: 0.15, thump: 1100 });
    });
    const g = pluckEnv(ctx, out, t, 0.035 * n.vel * n.open, 0.002, 0.06);
    osc(ctx, 'square', n.freq * 4, t, t + 0.08, g);
  };

  /* polygon — shatter: ice shards (FM burst with a falling index) + a glassy crack */
  INSTR['polygon:shatter'] = v => {
    const { ctx, out, t, n } = v, f = n.freq * 2;
    const env = pluckEnv(ctx, out, t, 0.22 * n.vel, 0.004, 0.35);
    const car = osc(ctx, 'sine', f, t, t + 0.4, env);
    const mod = ctx.createOscillator(), idx = ctx.createGain();
    mod.type = 'triangle'; mod.frequency.setValueAtTime(f * 3.55, t);
    idx.gain.setValueAtTime(f * 1.8 * pw(n.open, 1.3), t); idx.gain.exponentialRampToValueAtTime(0.1, t + 0.045);
    mod.connect(idx); idx.connect(car.frequency); mod.start(t); mod.stop(t + 0.07);
    breath(ctx, out, t, 0.02, { type: 'highpass', freq: 4500, q: 0.7, peak: 0.1 * n.vel * pw(n.open, 1.5), atk: 0.001, offset: n.rnd(8) * 3 });
    partials(ctx, out, t, f * 2.5, [[1, 1, 0.16]], { peak: 0.05 * n.vel * n.open, atk: 0.002 });
  };

  /* crystal — harmonic: celesta / music box */
  INSTR['crystal:harmonic'] = v => {
    partials(v.ctx, v.out, v.t, v.n.freq * 1.5, richen([[1, 1, 2.0], [4.01, 0.3, 0.4], [7.2, 0.1, 0.15]], v.n.open, 1.4), { peak: 0.26 * v.n.vel, atk: 0.004 });
  };

  /* crystal — chaotic: wind chimes — random tuning of every tube, clusters of strikes, long metallic ring */
  INSTR['crystal:chaotic'] = v => {
    const { ctx, out, t, n } = v;
    const strikes = 1 + (n.rnd(6) < 0.5 ? 1 : 0) + (n.rnd(7) < 0.25 ? 1 : 0);
    for (let i = 0; i < strikes; i++) {
      const cents = (n.rnd(10 + i) - 0.5) * 70, ts = t + i * (0.045 + n.rnd(20 + i) * 0.05);
      const spec = richen([[1, 1, 3.2], [2.756, 0.55 * n.bright, 2.0], [5.404, 0.32, 1.1], [8.933, 0.2, 0.6], [11.3, 0.1, 0.3]], n.open, 0.9);
      partials(ctx, out, ts, n.freq * 2 * (i ? 1.2599 * (n.rnd(30 + i) < 0.5 ? 1 : 0.5) : 1), spec, { peak: 0.2 * n.vel / (1 + i * 0.5), atk: 0.002, cents });
    }
    breath(ctx, out, t, 0.008, { type: 'highpass', freq: 6000, q: 0.7, peak: 0.06 * n.vel, atk: 0.001, offset: n.rnd(8) * 3 });
  };

  /* crystal — geode: deep Tibetan singing bowl (two beating fundamentals, the second mode swells like a wet rim) */
  INSTR['crystal:geode'] = v => {
    const { ctx, out, t, n } = v, f = n.freq * 0.75;
    const spec = richen([[1, 1, 5.4], [2.71, 0.34, 3.4, 1.0], [5.15, 0.12, 1.8, 0.6]], n.open, 1.0);
    partials(ctx, out, t, f, spec, { peak: 0.14 * n.vel, atk: 0.04, cents: -2.5 });
    partials(ctx, out, t, f, spec, { peak: 0.08 * n.vel, atk: 0.05, cents: 2.5 });
    breath(ctx, out, t, 0.02, { type: 'lowpass', freq: 500, q: 0.8, peak: 0.08 * n.vel, offset: n.rnd(8) * 3 });             // the soft mallet
  };

  /* crystal — stained: cathedral pipe organ (sustained drawbars, tremulant, chiff) + sanctuary bell */
  INSTR['crystal:stained'] = v => {
    const { ctx, out, t, n, dna } = v;
    const hold = Math.min(1.8, dna.intervalMs / 1000 * 1.1), rel = 0.7, end = t + 0.12 + hold + rel + 0.08;
    const sum = ctx.createGain(); sum.gain.value = 0.95; sum.connect(out);
    const trem = ctx.createOscillator(), depth = ctx.createGain();
    trem.frequency.value = 5.2; depth.gain.value = 0.05; trem.connect(depth); depth.connect(sum.gain); trem.start(t); trem.stop(end);
    const bars = [[0.5, 0.1], [1, 0.14], [2, 0.08], [3, 0.05], [4, 0.04], [6, 0.02]];
    bars.forEach((b, i) => {
      const g = holdEnv(ctx, sum, t, b[1] * n.vel * 1.5 * (i >= 3 ? pw(n.open, 1.6) : 1), 0.12, hold, rel);     // the upper stops (3rd, 4th, 6th) are the registration a saturated colour pulls out
      osc(ctx, i === 0 ? 'triangle' : 'sine', n.freq * b[0], t, end, g, (i - 2) * 3);
    });
    breath(ctx, out, t, 0.07, { freq: n.freq * 3, q: 3, peak: 0.05 * n.vel * n.open, atk: 0.005, offset: n.rnd(8) * 3 });
    if (n.step === 0) partials(ctx, out, t, n.freq * 2, BELL.map(s => [s[0], s[1], s[2] * 1.6]), { peak: 0.1 * n.vel, atk: 0.004 });
  };

  /* chroma — bowed strings. o: voices [{mult, wave, peak}], cut, q, vibrato cents */
  function bowed(v, o) {
    const { ctx, out, t, n, st } = v, f = n.freq;
    const prev = st.last > 40 ? st.last : f * (n.warm ? 0.94 : 1.06);       // liquid portamento from the previous note
    st.last = f;
    const dur = 1.5, end = t + dur + 0.12;
    const lp = filt(ctx, 'lowpass', o.cut * n.bright * pw(n.open, 0.8), o.q, out);
    const oscs = [];
    o.voices.forEach(vo => {
      const g = holdEnv(ctx, lp, t, vo.peak * n.vel, o.atk || 0.2, 0.3, 0.95);
      [-4, 4].forEach(c => {
        const x = osc(ctx, vo.wave, prev * vo.mult, t, end, g, c);
        x.frequency.exponentialRampToValueAtTime(f * vo.mult, t + 0.2);
        oscs.push(x);
      });
    });
    vibrato(ctx, oscs, t, end, 5.5, o.vib, 0.28, 0.35);
    breath(ctx, out, t, dur * 0.8, { freq: f * 3, q: 1.5, peak: 0.025 * n.vel, atk: 0.08, hold: 0.3, offset: n.rnd(8) * 3 });  // rosin
  }

  /* mercury: a solo cello — dark, woody, one voice */
  INSTR['chroma:mercury'] = v => bowed(v, { voices: [{ mult: 1, wave: 'sawtooth', peak: 0.085 }], cut: v.n.warm ? 920 : 640, q: 3.2, vib: 14, atk: 0.11 });   // a bowed attack of ~0.1 s: the cello speaks; iridescent's glass voices swell over 0.4 s

  /* iridescent: two pure (triangle) voices a fifth apart, glass-bright, with a tremolo-shimmer an octave and a twelfth above; chorus on the bus */
  INSTR['chroma:iridescent'] = v => {
    const { ctx, out, t, n } = v;
    bowed(v, { voices: [{ mult: 1, wave: 'triangle', peak: 0.08 }, { mult: 1.5, wave: 'triangle', peak: 0.07 }], cut: 3200, q: 1.1, vib: 9, atk: 0.4 });
    const shim = ctx.createGain(); shim.gain.value = 0.6; shim.connect(out);
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 6.3; depth.gain.value = 0.4; lfo.connect(depth); depth.connect(shim.gain); lfo.start(t); lfo.stop(t + 2.3);
    partials(ctx, shim, t + 0.1, n.freq * 2, [[1, 1, 1.4, 0.4], [1.5, 0.5, 1.2, 0.5]], { peak: 0.07 * n.vel * pw(n.open, 1.2), hold: 0.5 });
  };

  /* chroma — molten: sub bass + distorted growl whose cutoff slowly pulses */
  INSTR['chroma:molten'] = v => {
    const { ctx, out, t, n, st } = v, f = n.freq;
    const prev = st.last > 40 ? st.last : f * (n.warm ? 0.94 : 1.06); st.last = f;
    const end = t + 1.65;
    partials(ctx, out, t, f * 0.5, [[1, 1, 1.4, 0.2]], { peak: 0.2 * n.vel });
    const shaper = ctx.createWaveShaper(); shaper.curve = FX.distortionCurve(Math.round(3.2 * (0.7 + 0.3 * n.open) / 0.4) * 0.4); shaper.oversample = '2x';   // a saturated colour drives the growl harder (a few discrete drive levels: the curves are cached)
    const lp = filt(ctx, 'lowpass', 680 * n.bright * pw(n.open, 0.8), 4.8, holdEnv(ctx, out, t, 0.1 * n.vel, 0.22, 0.3, 0.95));
    shaper.connect(lp);
    const x = osc(ctx, 'sawtooth', prev, t, end, shaper);
    x.frequency.exponentialRampToValueAtTime(f, t + 0.2);
    const lfo = ctx.createOscillator(), d = ctx.createGain();
    lfo.frequency.value = 0.7; d.gain.value = 240; lfo.connect(d); d.connect(lp.frequency); lfo.start(t); lfo.stop(end);
  };

  /* ------------------------------------------------------------------ ambient beds (continuous layers under the notes) */
  function loopNoise(L, offset) {
    const s = L.ctx.createBufferSource();
    s.buffer = FX.noiseBuffer(L.ctx); s.loop = true; s.loopStart = 0;
    s.start(L.t, offset || 0); L.srcs.push(s);
    return s;
  }
  function lfo(L, rate, depth, param) {
    const o = L.ctx.createOscillator(), g = L.ctx.createGain();
    o.frequency.value = rate; g.gain.value = depth; o.connect(g); g.connect(param); o.start(L.t); L.srcs.push(o);
  }
  function drone(L, type, f, cents, filter, gain) {
    const o = L.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = cents;
    const g = L.ctx.createGain(); g.gain.value = gain;
    if (filter) { o.connect(filter); filter.connect(g); } else o.connect(g);
    g.connect(L.dest); o.start(L.t); L.srcs.push(o);
    return g;
  }
  function noiseThrough(L, filter, gain, offset) {
    const g = L.ctx.createGain(); g.gain.value = gain;
    loopNoise(L, offset).connect(filter); filter.connect(g); g.connect(L.dest);
    return g;
  }

  /** Level of each bed relative to its notes (linear, calibrated by measurement: the bed sits about 10 dB under the notes' RMS). */
  const BED_LEVEL = {
    'fluid': 0.312,
    'paper:waves': 1.85,
    'paper:canyon': 2.962,
    'paper:cutout': 1.04,
    'aurora:prism': 0.442,
    'aurora:glass': 2.919,
    'aurora:neon': 0.078,
    'polygon:constellation': 0.275,
    'crystal:harmonic': 0.159,
    'crystal:chaotic': 0.152,
    'crystal:geode': 0.101,
    'crystal:stained': 0.463
  };

  const BEDS = {
    /* fluid: ocean surf — a band of noise that swells, plus a slow low undertow */
    fluid(L) {
      const wt = L.dna.warmth01 === undefined ? 0.5 : L.dna.warmth01;      // 0 = cool ... 1 = warm: a brighter, livelier surf for warm colours
      const bp = filt(L.ctx, 'bandpass', 280 + 180 * wt, 1.2);
      noiseThrough(L, bp, 0.28, 0);
      lfo(L, 0.11 + 0.07 * wt, 180, bp.frequency);
      const under = noiseThrough(L, filt(L.ctx, 'lowpass', 240, 0.7), 0.1, 1.7);
      lfo(L, 0.08, 0.07, under.gain);
    },
    /* paper: waves = soft lo-fi crackle, canyon = hollow wind, cutout = airy paper rustle */
    'paper:waves'(L) { const g = noiseThrough(L, filt(L.ctx, 'bandpass', 1550, 2.2), 0.1, 0); lfo(L, 0.2, 0.03, g.gain); },
    'paper:canyon'(L) {
      const bp = filt(L.ctx, 'bandpass', 520, 3.8);
      const g = noiseThrough(L, bp, 0.16, 0);
      lfo(L, 0.06, 160, bp.frequency); lfo(L, 0.09, 0.06, g.gain);
    },
    'paper:cutout'(L) { const g = noiseThrough(L, filt(L.ctx, 'bandpass', 3400, 1.4), 0.07, 0.8); lfo(L, 0.45, 0.035, g.gain); },
    /* aurora: a root + fifth drone whose filter drifts slowly (sine for glass, saw otherwise, low-passed for neon) */
    aurora(L) {
      const m = L.dna.auroraMode, neon = m === 'neon';
      [midiToFreq(L.dna.rootMidi - 12), midiToFreq(L.dna.rootMidi - 5)].forEach((f, i) => {
        const wt = L.dna.warmth01 === undefined ? 0.5 : L.dna.warmth01;
        const fl = filt(L.ctx, neon ? 'lowpass' : 'bandpass', neon ? 360 : 520 + 260 * wt, neon ? 2.0 : 4.2);
        drone(L, m === 'glass' ? 'sine' : 'sawtooth', f, i === 0 ? -8 : 8, fl, 0.13);
        lfo(L, 0.05 + i * 0.02, neon ? 60 : 120, fl.frequency);
      });
    },
    /* crystal: a singing-bowl hum (two sines beating slowly); stained: an organ pedal point instead */
    crystal(L) {
      const f = midiToFreq(L.dna.rootMidi);
      drone(L, 'sine', f, 0, null, 0.08); drone(L, 'sine', f * 1.003, 0, null, 0.08);
    },
    'crystal:stained'(L) {
      const f = midiToFreq(L.dna.rootMidi - 12);
      drone(L, 'triangle', f, 0, null, 0.08); drone(L, 'sine', f * 1.5, 0, null, 0.08);
    },
    /* constellation: a faint starfield of two high sines that breathe */
    'polygon:constellation'(L) {
      const base = midiToFreq(L.dna.rootMidi + 12);
      [1, 1.5].forEach((m, i) => { const g = drone(L, 'sine', base * m, i ? 4 : -4, null, 0.03); lfo(L, 0.11 + i * 0.05, 0.02, g.gain); });
    }
  };

  function bedBuilder(key) {
    return BEDS[key] || BEDS[key.split(':')[0]] || null;
  }
  const hasBed = key => !!bedBuilder(key);

  /** Builds a bed that fades in over a second, returns { stop(t) } (fade out, then stop every source). */
  function startBed(ctx, dest, dna, key, t) {
    const build = bedBuilder(key);
    if (!build) return null;
    const layer = ctx.createGain();
    layer.gain.setValueAtTime(EPS, t); layer.gain.linearRampToValueAtTime(0.9 * (BED_LEVEL[key] || 1), t + 1.0);
    layer.connect(dest);
    const L = { ctx, dest: layer, dna, t, srcs: [] };
    build(L);
    return {
      stop(at) {
        layer.gain.cancelScheduledValues(at);
        layer.gain.setValueAtTime(Math.max(EPS, layer.gain.value), at);
        layer.gain.linearRampToValueAtTime(EPS, at + 0.4);
        L.srcs.forEach(s => { try { s.stop(at + 0.5); } catch (e) { /* already stopped */ } });
      }
    };
  }

  /* ------------------------------------------------------------------ levels + session */
  /** Per-instrument level trim (linear), calibrated by measurement: every mode lands at the same RMS (-29.5 dBFS before mastering, the
   *  level of the default Fluid style), peaks capped at -9 dBFS. Re-derive with scratchpad tool snd-trim.js after changing any instrument. */
  const LEVEL_TRIM = {
    'fluid': 1.402,
    'paper:waves': 1.086,
    'paper:canyon': 0.505,
    'paper:cutout': 1.518,
    'aurora:prism': 2.138,
    'aurora:glass': 1.087,
    'aurora:neon': 1.913,
    'polygon:flat': 1.581,
    'polygon:faceted': 0.825,
    'polygon:constellation': 1.696,
    'polygon:isometric': 1.977,
    'polygon:shatter': 1.706,
    'crystal:harmonic': 0.999,
    'crystal:chaotic': 1.01,
    'crystal:geode': 1.643,
    'crystal:stained': 0.442,
    'chroma:mercury': 2.338,
    'chroma:iridescent': 1.438,
    'chroma:molten': 1.057
  };

  const DEFAULT_MODE = { paper: 'waves', aurora: 'prism', polygon: 'flat', crystal: 'harmonic', chroma: 'mercury' };
  const KEYS = Object.keys(INSTR);

  /** The key of the instrument that will really play. A sub-mode this build does not know falls back to its style's first mode. */
  function resolveKey(dna) {
    if (INSTR[dna.key]) return dna.key;
    const mode = DEFAULT_MODE[dna.style];
    return mode ? dna.style + ':' + mode : 'fluid';
  }

  function createSession(ctx, dna, dest, opts) {
    opts = opts || {};
    const key = resolveKey(dna);
    const t0 = opts.t0 !== undefined ? opts.t0 : (ctx.currentTime || 0);      // when this session starts: its LFOs and its ambient layer start HERE (live and WAV alike)
    const bus = FX.createBus(ctx, key, t0);
    const fade = ctx.createGain();                       // session fade: new session fades in, closing one fades out
    const trim = ctx.createGain();
    const st = {};                                       // per-session instrument memory (e.g. last bowed pitch) — never shared, never leaks
    trim.gain.value = LEVEL_TRIM[key] || 1;
    trim.connect(bus.input); bus.output.connect(fade); fade.connect(dest);
    if (opts.fadeIn) {
      fade.gain.setValueAtTime(EPS, t0); fade.gain.linearRampToValueAtTime(1, t0 + opts.fadeIn);
    }
    const instrument = INSTR[key];
    let bed = null;
    return {
      key, bus, t0,
      play(note, t, d) { instrument({ ctx, out: panner(ctx, trim, note.pan), t, n: note, dna: d || dna, st }); },
      startBed(t) { if (!bed) bed = startBed(ctx, trim, dna, key, t); },
      /** Fade the whole session out; returns how many ms until it is safe to dispose() (reverb tail included). */
      close(t, fadeSec) {
        if (bed) bed.stop(t);
        fade.gain.cancelScheduledValues(t);
        fade.gain.setValueAtTime(Math.max(EPS, fade.gain.value), t);
        fade.gain.linearRampToValueAtTime(EPS, t + fadeSec);
        return Math.ceil((fadeSec + 0.8) * 1000);
      },
      dispose() { try { trim.disconnect(); fade.disconnect(); } catch (e) { /* gone */ } bus.dispose(); }
    };
  }

  return { createSession, resolveKey, hasBed, bedBuilder, KEYS, LEVEL_TRIM, BED_LEVEL, startBed, instruments: INSTR };
})();
