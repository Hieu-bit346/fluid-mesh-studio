/* ==========================================================================
   sound-effects.js — EFFECTS of the Soundscape: the shared mix bus (reverb, echo, chorus) and the noise / impulse
   buffers. Works on ANY BaseAudioContext, so the live player and the offline WAV render build exactly the same bus.

   Public:  createBus(ctx, key, t0?) -> { input, output, dispose() }       noiseBuffer(ctx)       impulse(ctx, seconds, decay)
            distortionCurve(amount)                                   BUS_PRESETS (the per-mode settings, readable by tests)
   ========================================================================== */
const SoundFX = (function () {
  'use strict';

  function lcg(seed) {                         // tiny deterministic generator (same noise / impulse in every session and every export)
    let a = seed >>> 0;
    return function () { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  }

  /* ------------------------------------------------------------------ shared buffers */
  const noiseCache = new Map();
  const impulseCache = new Map();
  const curveCache = new Map();

  /** 4 s of looping pink-ish noise, RMS 0.22 (identical for live and WAV). */
  function noiseBuffer(ctx) {
    const rate = ctx.sampleRate;
    if (noiseCache.has(rate)) return noiseCache.get(rate);
    const len = rate * 4, buf = ctx.createBuffer(1, len, rate), out = buf.getChannelData(0), rng = lcg(777);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = rng() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759; b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856; b4 = 0.55000 * b4 + white * 0.5329522; b5 = -0.7616 * b5 - white * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
      b6 = white * 0.115926;
    }
    let sq = 0; for (let i = 0; i < len; i++) sq += out[i] * out[i];
    const k = 0.22 / Math.sqrt(sq / len);                    // normalise to RMS 0.22 so an envelope peak means what it says (the raw filter output is ~0.03)
    for (let i = 0; i < len; i++) out[i] *= k;
    noiseCache.set(rate, buf);
    return buf;
  }

  /** Stereo room impulse: decaying noise, a little pre-delay-free "bloom" so the tail starts soft. */
  function impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate, key = rate + ':' + seconds + ':' + decay;
    if (impulseCache.has(key)) return impulseCache.get(key);
    const length = Math.floor(rate * seconds), buf = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch), rng = lcg(101 + ch * 7919);
      for (let i = 0; i < length; i++) data[i] = (rng() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    impulseCache.set(key, buf);
    return buf;
  }

  /** Soft-clip curve for the molten growl (k = amount of drive). */
  function distortionCurve(k) {
    if (curveCache.has(k)) return curveCache.get(k);
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * k) / Math.tanh(k); }
    curveCache.set(k, curve);
    return curve;
  }

  /* ------------------------------------------------------------------ per-mode bus settings */
  /**
   * reverb [seconds, decay-shape], wet / dry levels, optional echo {time, feedback, tone, mix}, optional chorus {rate, depth, mix}.
   * The default is the user's original live reverb (2.8 s, wet .48, dry .82); modes that want a different space override it.
   */
  const DEFAULT_BUS = { reverb: [2.8, 2.6], wet: 0.48, dry: 0.82 };
  const BUS_PRESETS = {
    fluid:                  { reverb: [2.8, 2.6], wet: 0.48, dry: 0.82 },
    'paper:waves':          { reverb: [1.9, 2.8], wet: 0.34, dry: 0.9 },
    'paper:canyon':         { reverb: [3.8, 2.2], wet: 0.5, dry: 0.78, echo: { time: 0.41, feedback: 0.42, tone: 1700, mix: 0.34 } },
    'paper:cutout':         { reverb: [1.3, 3.0], wet: 0.24, dry: 0.95 },
    'aurora:prism':         { reverb: [4.4, 2.2], wet: 0.62, dry: 0.7 },
    'aurora:glass':         { reverb: [4.0, 2.3], wet: 0.58, dry: 0.74 },
    'aurora:neon':          { reverb: [3.0, 2.6], wet: 0.4, dry: 0.82, chorus: { rate: 0.38, depth: 0.0045, mix: 0.5 } },
    'polygon:flat':         { reverb: [1.8, 2.8], wet: 0.3, dry: 0.9 },
    'polygon:faceted':      { reverb: [2.4, 2.6], wet: 0.36, dry: 0.88 },
    'polygon:constellation':{ reverb: [4.2, 2.2], wet: 0.6, dry: 0.72 },
    'polygon:isometric':    { reverb: [1.5, 3.0], wet: 0.24, dry: 0.95 },
    'polygon:shatter':      { reverb: [2.2, 2.6], wet: 0.42, dry: 0.86, echo: { time: 0.19, feedback: 0.3, tone: 5200, mix: 0.2 } },
    'crystal:harmonic':     { reverb: [2.6, 2.6], wet: 0.44, dry: 0.84 },
    'crystal:chaotic':      { reverb: [3.2, 2.4], wet: 0.5, dry: 0.82 },
    'crystal:geode':        { reverb: [4.8, 2.0], wet: 0.6, dry: 0.72 },
    'crystal:stained':      { reverb: [4.6, 2.0], wet: 0.56, dry: 0.74 },
    'chroma:mercury':       { reverb: [3.0, 2.6], wet: 0.44, dry: 0.84 },
    'chroma:iridescent':    { reverb: [3.4, 2.4], wet: 0.5, dry: 0.78, chorus: { rate: 0.27, depth: 0.0038, mix: 0.45 } },
    'chroma:molten':        { reverb: [2.4, 2.8], wet: 0.32, dry: 0.92 }
  };

  /* ------------------------------------------------------------------ effects */
  /** Chorus: the signal plus a copy delayed by ~18 ms whose delay time is swayed by a slow LFO (thickens a pad, never changes its pitch much). */
  function chorus(ctx, spec, t0) {
    const input = ctx.createGain(), output = ctx.createGain(), delay = ctx.createDelay(0.05), lfo = ctx.createOscillator();
    const depth = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
    delay.delayTime.value = 0.018;
    lfo.frequency.value = spec.rate; depth.gain.value = spec.depth;
    wet.gain.value = spec.mix; dry.gain.value = 1 - spec.mix * 0.4;
    lfo.connect(depth); depth.connect(delay.delayTime);
    input.connect(dry); dry.connect(output);
    input.connect(delay); delay.connect(wet); wet.connect(output);
    lfo.start(t0);                           // an explicit start time: the LFO phase is then the same in the live player and in the offline render
    return { input, output, nodes: [lfo, input, output, delay, depth, wet, dry] };
  }

  /** Echo: a feedback delay whose repeats are darkened every pass (a voice bouncing between canyon walls / ice). */
  function echo(ctx, spec) {
    const input = ctx.createGain(), output = ctx.createGain(), delay = ctx.createDelay(1.5), fb = ctx.createGain();
    const tone = ctx.createBiquadFilter(), mix = ctx.createGain();
    delay.delayTime.value = spec.time; fb.gain.value = spec.feedback; mix.gain.value = spec.mix;
    tone.type = 'lowpass'; tone.frequency.value = spec.tone;
    input.connect(output);
    input.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay);
    tone.connect(mix); mix.connect(output);
    return { input, output, nodes: [input, output, delay, fb, tone, mix] };
  }

  /**
   * The mix bus every instrument and ambient layer plays into:
   *   input -> [chorus] -> [echo] -> dry + reverb(wet) -> output
   * `output` is what the live graph / the offline render connects to its master stage.
   */
  function createBus(ctx, key, t0) {
    t0 = t0 === undefined ? (ctx.currentTime || 0) : t0;
    const p = BUS_PRESETS[key] || BUS_PRESETS[String(key).split(':')[0]] || DEFAULT_BUS;
    const input = ctx.createGain(), sum = ctx.createGain(), output = ctx.createGain();
    const nodes = [input, sum, output];
    let head = input;
    [p.chorus && chorus(ctx, p.chorus, t0), p.echo && echo(ctx, p.echo)].forEach(fx => {
      if (!fx) return;
      head.connect(fx.input); head = fx.output; nodes.push(...fx.nodes);
    });
    const dry = ctx.createGain(), wet = ctx.createGain(), rev = ctx.createConvolver();
    dry.gain.value = p.dry; wet.gain.value = p.wet;
    rev.buffer = impulse(ctx, p.reverb[0], p.reverb[1]);
    head.connect(dry); dry.connect(sum);
    head.connect(rev); rev.connect(wet); wet.connect(sum);

    // No compressor on purpose: the per-mode levels are calibrated so that even 100 % volume leaves >= 6 dB of headroom (measured by t24), and a
    // DynamicsCompressorNode adds an automatic make-up gain (the loudness would stop being predictable) and ~6 ms of latency.
    sum.connect(output);
    nodes.push(dry, wet, rev);

    return {
      input, output, preset: p,
      dispose() { nodes.forEach(n => { try { if (n.stop) n.stop(); n.disconnect(); } catch (e) { /* already stopped */ } }); }
    };
  }

  return { noiseBuffer, impulse, distortionCurve, createBus, BUS_PRESETS, DEFAULT_BUS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SoundFX;
