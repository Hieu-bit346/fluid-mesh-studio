/* ==========================================================================
   sound-music.js — MUSIC LOGIC of the Soundscape. Pure functions: no Web Audio, no DOM, no globals (runs in Node too).

   Colour -> music ("synesthesia"), the same rules for the live player and for the WAV export. The colours of the artwork decide the music:

     HUE  (warm <-> cool)   continuous "warmth" of the palette, weighted by how much of the artwork each colour is
                            warm  (red / orange / yellow)       Major Pentatonic · faster · syncopated 3-3-2 accents · pick-up notes · few rests · rising, bouncing motifs
                            cool  (blue / teal / violet)        Minor Pentatonic or Dorian · slower · 4-4 accents · phrase-end rests · stepwise, falling, wide-open motifs
                            mixed / grey palettes               Lydian / Dorian, in-between tempo and density (every parameter moves continuously with the warmth)
     VALUE (brightness)     the register of the melody moves continuously (a dark artwork sits low and soft, a bright one high and clear)
     SATURATION             "openness" of the tone: each instrument turns it into its own filter / harmonic mix (see sound-engines.js)
     DOMINANCE              colours that cover more of the artwork are chosen more often, give the tonic and the bars of the progression;
                            a small exception colour appears rarely and cannot change the scale or the tempo
   Everything is derived from the artwork seed and palette only: the same artwork always plays the same piece.

   Public:  analyze(params) -> dna        noteAt(dna, idx) -> note        pickupAt(dna, note) -> note | null
            createSequencer(getDna, startTime) -> sequencer
            readColours(palette) -> profile      warmthOfHue(h) -> -1..1      modeKey(dna) -> 'style[:mode]'
            hash(seed, a, b) -> [0,1)            midiToFreq, SCALES, LEAD (session start -> first note)
   ========================================================================== */
const SoundMusic = (function () {
  'use strict';

  const SCALES = {
    majorPent: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24],
    minorPent: [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24],
    lydian:    [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19],
    dorian:    [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19]
  };

  /** Base step length (ms) per style / sub-mode (before warmth and the artwork's turbulence change it). Fluid: [warm palette, cool palette]. */
  const TEMPO_MS = {
    fluid: [620, 840],
    'paper:waves': 480, 'paper:canyon': 920, 'paper:cutout': 380,
    'aurora:prism': 1350, 'aurora:glass': 980, 'aurora:neon': 1100,
    'polygon:flat': 380, 'polygon:faceted': 380, 'polygon:constellation': 640, 'polygon:isometric': 340, 'polygon:shatter': 220,
    'crystal:harmonic': 340, 'crystal:chaotic': 240, 'crystal:geode': 880, 'crystal:stained': 1150,
    'chroma:mercury': 820, 'chroma:iridescent': 680, 'chroma:molten': 960
  };
  /** How often the line breathes (rests) before the palette's warmth is applied. */
  const REST_PROB = {
    'paper:canyon': 0.16, 'aurora:prism': 0.12, 'aurora:glass': 0.14, 'aurora:neon': 0.1, 'polygon:constellation': 0.14,
    'crystal:geode': 0.16, 'crystal:stained': 0.12, 'chroma:mercury': 0.1, 'chroma:iridescent': 0.1, 'chroma:molten': 0.1
  };
  /** Instruments whose notes are short enough for a pick-up (grace) note between two beats. Long, bowed, blown and struck-bowl voices never get one. */
  const PICKUP_KEYS = new Set(['fluid', 'paper:waves', 'paper:cutout', 'polygon:flat', 'polygon:faceted', 'polygon:isometric', 'polygon:constellation', 'crystal:harmonic']);

  /** Chord-root movement (semitones) over a 4-bar loop: sunlit palettes lift, moody ones sink. Converted to scale steps, so every note stays in the scale. */
  const PROGRESSION = { warm: [0, 5, 7, 5], cool: [0, -2, -5, -7] };
  /** Four-bar-loop melodies as offsets (in scale steps) from the bar's chord root. Warm: arpeggios that rise and bounce. Cool: stepwise, falling, spacious. */
  const MOTIFS = {
    warm: [[0, 2, 3, 5, 3, 2, 3, 2], [0, 1, 3, 2, 3, 5, 4, 3], [2, 3, 5, 3, 2, 0, 2, 3], [0, 3, 2, 3, 5, 3, 2, 1]],
    cool: [[5, 3, 2, 3, 0, 2, 0, -2], [3, 2, 0, 2, -2, 0, -2, -3], [2, 3, 2, 0, 2, -1, 0, -2], [5, 4, 2, 3, 2, 0, -1, 0]]
  };
  const ACCENTS = { warm: [0, 3, 6], cool: [0, 4] };      // 3-3-2 against 4-4
  const BAR = 8;                               // steps per bar
  /** Seconds between the start of a session (its ambient layer, its chorus LFO) and the first note. ONE value for the live player and the WAV export, so every
   *  LFO has the same phase at every note in both: a chorus is a comb filter, and 30 ms of difference there changes the envelope of a pad (measured). */
  const LEAD = 0.08;
  const WARM_EDGE = 0.2;                       // |warmth| above this: the palette is clearly warm / cool (below: mixed or grey)

  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const frac = x => x - Math.floor(x);
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  /** Legacy on/off warm test (kept for callers that want a yes / no); the music itself uses the continuous warmthOfHue(). */
  const isWarmHue = h => (h >= 0 && h <= 78) || h >= 305;

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  }

  /** Deterministic pseudo-random number in [0,1) from three integers (seed, step, stream): the same inputs always give the same value. */
  function hash(a, b, c) {
    let h = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA6B) ^ Math.imul((c | 0) + 0x165667B1, 0xC2B2AE35)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  function modeOf(style, p) {
    switch (style) {
      case 'paper': return p.paperMode || 'waves';
      case 'aurora': return p.auroraMode || 'prism';
      case 'polygon': return p.polyMode || 'flat';
      case 'crystal': return p.crystalMode || 'harmonic';
      case 'chroma': return p.chromaMode || 'mercury';
      default: return '';
    }
  }
  const modeKey = dna => (dna.mode ? dna.style + ':' + dna.mode : dna.style);

  /* ------------------------------------------------------------------ colour reading */

  /** -1 (coolest: blue-cyan, 210 deg) .. +1 (warmest: orange, 30 deg); red / yellow ~0.9, green and magenta ~0. Smooth: no cliff between two neighbouring hues. */
  const warmthOfHue = h => Math.cos(((h - 30) * Math.PI) / 180);
  /** A grey has no hue: its warmth counts less the less saturated it is. */
  const hueTrust = s => smoothstep(0.04, 0.22, s);
  /** How much a colour draws the eye (0..1): vivid and bright colours stand out. */
  const salience = (s, v) => clamp((0.1 + s) * (0.15 + 0.85 * v), 0, 1);
  const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  /** Do two palette entries read as the same colour? (a repeated colour is one colour with a bigger share, not several colours) */
  function sameColour(c, it) {
    const bothGrey = c.s < 0.12 && it.s < 0.12;
    const hueOk = bothGrey || (c.s >= 0.12 && it.s >= 0.12 && hueDistance(c.h, it.h) <= 20);
    return hueOk && Math.abs(c.s - it.s) <= 0.32 && Math.abs(c.v - it.v) <= 0.32;
  }

  /**
   * What the palette says, as numbers. Every palette entry weighs 1 (an entry the artwork uses more often is repeated, so it counts more) tilted by up to
   * +-40 % by how much it stands out. Entries that read as the same colour are merged into one cluster. Returns
   *   clusters  [{ h, s, v, warmth, w, share, members }]  strongest first       dominant  the first cluster
   *   warmth    -1..1, weighted over all clusters (greys count for nothing)        avgS, avgV  weighted means      contrast  weight share that opposes the warmth
   */
  function readColours(pal) {
    const items = pal.map((c, i) => {
      const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
      return { i, h, s, v, w: 0.6 + 0.4 * salience(s, v), warmth: warmthOfHue(h) * hueTrust(s) };
    });
    const clusters = [];
    items.slice().sort((a, b) => b.w - a.w || a.i - b.i).forEach(it => {
      let c = clusters.find(k => sameColour(k, it));
      if (!c) { c = { h: it.h, s: it.s, v: it.v, w: 0, hx: 0, hy: 0, sw: 0, vw: 0, ww: 0, members: [] }; clusters.push(c); }
      const r = (it.h * Math.PI) / 180;
      c.w += it.w; c.hx += it.w * Math.cos(r); c.hy += it.w * Math.sin(r); c.sw += it.w * it.s; c.vw += it.w * it.v; c.ww += it.w * it.warmth;
      c.h = (Math.atan2(c.hy, c.hx) * 180) / Math.PI; if (c.h < 0) c.h += 360;
      c.s = c.sw / c.w; c.v = c.vw / c.w; c.members.push(it);
    });
    const total = clusters.reduce((a, c) => a + c.w, 0) || 1;
    clusters.forEach(c => { c.share = c.w / total; c.warmth = c.ww / c.w; c.members.sort((a, b) => a.i - b.i); });
    clusters.sort((a, b) => b.w - a.w);
    const sum = f => clusters.reduce((a, c) => a + c.share * f(c), 0);
    const warmth = clamp(sum(c => c.warmth), -1, 1);
    const contrast = clusters.reduce((a, c) => a + (c.warmth * warmth < 0 && Math.abs(c.warmth) > 0.25 ? c.share : 0), 0);
    return { clusters, dominant: clusters[0], warmth, avgS: sum(c => c.s), avgV: sum(c => c.v), contrast, warmShare: sum(c => (c.warmth > 0 ? 1 : 0)) };
  }

  /* ------------------------------------------------------------------ scale, register, progression */

  /** Warm -> Major Pentatonic. Cool -> Minor Pentatonic for the deep end of the cool range (blue / indigo / violet) or Dorian for its airy end (green-blue, teal, cyan).
   *  The choice follows the HUE of the dominant colour, never its brightness: V decides register and energy only, so a bright and a dark version of one colour share a scale.
   *  Mixed / grey -> Lydian (leaning warm) or Dorian (leaning cool). */
  const MINOR_FROM_HUE = 205;
  function chooseScale(warmth, domHue) {
    if (warmth >= WARM_EDGE) return 'majorPent';
    if (warmth <= -WARM_EDGE) return domHue >= MINOR_FROM_HUE ? 'minorPent' : 'dorian';
    return warmth >= 0 ? 'lydian' : 'dorian';
  }

  /** The pitch classes of a scale, ascending (0..11). */
  const pitchClasses = scaleName => [...new Set(SCALES[scaleName].map(x => x % 12))].sort((a, b) => a - b);

  /** Every in-scale MIDI note from 24 to 100, ascending: the melody walks on this ladder, so no note can leave the scale. */
  function buildLattice(scaleName, rootPc) {
    const pcs = new Set(pitchClasses(scaleName)), out = [];
    for (let m = 24; m <= 100; m++) if (pcs.has((((m - rootPc) % 12) + 12) % 12)) out.push(m);
    return out;
  }

  /** How many scale steps up (or down) is the scale tone nearest to `semis` semitones above the tonic. */
  function stepsFromTonic(scaleName, semis) {
    const pcs = pitchClasses(scaleName), n = pcs.length, oct = Math.floor(semis / 12), r = ((semis % 12) + 12) % 12;
    let best = 0, bestD = 99;
    pcs.concat([12]).forEach((p, k) => { const d = Math.abs(p - r); if (d < bestD) { bestD = d; best = k; } });
    return oct * n + best;
  }

  const nearestIndex = (lattice, midi) => lattice.reduce((bi, m, i) => (Math.abs(m - midi) < Math.abs(lattice[bi] - midi) ? i : bi), 0);

  /** Chord roots of the 4-bar loop, as scale steps from the anchor. A strong opposite colour pulls the last bar toward its side. */
  function buildProgression(scaleName, warmth, contrast) {
    const steps = PROGRESSION[warmth >= 0 ? 'warm' : 'cool'].map(s => stepsFromTonic(scaleName, s));
    if (contrast > 0.2) steps[3] += warmth >= 0 ? -1 : 1;
    return steps;
  }

  /* ------------------------------------------------------------------ analysis (artwork -> DNA) */

  const cache = new WeakMap();

  /** Musical DNA of an artwork: scale, key, register, tempo, rests, progression and the colours it will be played from. Cached per params object. */
  function analyze(params) {
    if (params && typeof params === 'object' && cache.has(params)) return cache.get(params);
    const dna = compute(params);
    if (params && typeof params === 'object') cache.set(params, dna);
    return dna;
  }

  function compute(params) {
    const p = params || {};
    const pal = (p.palette && p.palette.length) ? p.palette : [[64, 224, 208], [30, 144, 255], [138, 99, 255]];
    const prof = readColours(pal);
    const { warmth, avgS, avgV } = prof, dom = prof.dominant;
    const t = 0.5 + 0.5 * warmth;                                            // 0 = coolest ... 1 = warmest

    const scaleName = chooseScale(warmth, dom.h);
    const rootMidi = 45 + Math.round((dom.h / 360) * 7);                     // the dominant colour names the key; tonic of the ambient layers (low), the melody's register is separate
    const rootPc = rootMidi % 12;
    const lattice = buildLattice(scaleName, rootPc);
    const centreMidi = 46 + 22 * avgV + 2 * warmth;                          // continuous in brightness: dark low, bright high; warm a little up, cool a little down
    const anchor = nearestIndex(lattice, centreMidi);

    const style = p.style || 'fluid';
    const mode = modeOf(style, p);
    const key = mode ? style + ':' + mode : style;
    const turb = p.turb !== undefined ? p.turb : 1;

    const tempo = TEMPO_MS[key];
    const baseMs = Array.isArray(tempo) ? lerp(tempo[1], tempo[0], t) : (tempo || lerp(800, 600, t)) * lerp(1.14, 0.88, t);
    const intervalMs = Math.max(160, Math.round(baseMs / Math.max(0.65, 0.78 + turb * 0.24)));
    const restProb = clamp((REST_PROB[key] || 0.07) + lerp(0.11, -0.03, t), 0.02, 0.36);
    const pickupProb = PICKUP_KEYS.has(key) ? 0.55 * smoothstep(0.6, 1, t) : 0;

    const cum = []; let acc = 0; prof.clusters.forEach(c => { acc += c.share; cum.push(acc); });
    const seed = (p.seed | 0) || 1;
    return {
      scale: SCALES[scaleName], scaleName, rootMidi, rootPc, lattice, anchor, centreMidi,
      progression: buildProgression(scaleName, warmth, prof.contrast),
      avgH: dom.h, avgS, avgV, warmth, warmth01: t, warmRatio: prof.warmShare, contrast: prof.contrast,
      colours: prof.clusters, cum,
      style, mode, key,
      paperMode: p.paperMode || 'waves', polyMode: p.polyMode || 'flat', crystalMode: p.crystalMode || 'harmonic',
      auroraMode: p.auroraMode || 'prism', chromaMode: p.chromaMode || 'mercury',
      intervalMs, restProb, pickupProb,
      palette: pal, seed
    };
  }

  /* ------------------------------------------------------------------ notes */

  /** The colour that plays step `idx`: palette colours in proportion to how much of the artwork they cover, spread evenly (no long runs of one colour). */
  function colourAt(dna, idx) {
    const u = frac(hash(dna.seed, 0, 31) + idx * 0.6180339887);
    let k = dna.cum.findIndex(c => u < c); if (k < 0) k = dna.cum.length - 1;
    const c = dna.colours[k], m = c.members[Math.floor(frac(hash(dna.seed, 1, 32) + idx * 0.7548776662) * c.members.length)];
    return m;
  }

  /** The motif of a bar: its family follows the palette's warmth (the first bar always follows its sign), the variant is picked by the seed. */
  function motifOf(dna, bar) {
    const pWarm = clamp(0.5 + 0.6 * dna.warmth, 0.05, 0.95);
    const warmBar = bar === 0 ? dna.warmth >= 0 : hash(dna.seed, bar, 11) < pWarm;
    return { family: warmBar ? 'warm' : 'cool', steps: MOTIFS[warmBar ? 'warm' : 'cool'][Math.floor(hash(dna.seed, bar, 13) * 4)] };
  }

  /**
   * One step of the piece. Everything about the note that the instruments need, decided here and nowhere else:
   *   midi / freq   pitch, always a tone of the scale          warm / warmth   the note's own colour (hard / -1..1): marimba vs kalimba, vowel, ...
   *   bright        0.65..1.45 from brightness (V): clear, airy attack     open   0.45..1.25 from saturation (S): each instrument's own filter / harmonics
   *   vel           0.52..1 loudness;  accent  true on the strong steps of this bar's feel (warm 3-3-2, cool 4-4)
   *   pan           -0.7..0.7: hue against the dominant hue, plus a slow sweep;  rest  true when the line breathes (no note)
   *   bar / step    position in the 8-step bar;  jitter  seconds of human timing;  rnd(k)  deterministic random stream for the instrument
   */
  function noteAt(dna, idx) {
    const col = colourAt(dna, idx);
    const bar = Math.floor(idx / BAR), step = idx % BAR;
    const rnd = k => hash(dna.seed, idx, k);
    const motif = motifOf(dna, bar), warmBar = motif.family === 'warm';

    // pitch: anchor (brightness) + the bar's chord root + the motif + small colour nudges, all counted in scale steps
    const dV = Math.round(clamp((col.v - dna.avgV) * 6, -2, 2));              // a brighter / darker colour than the artwork's average sits a step higher / lower
    const dW = Math.round(clamp((col.warmth - dna.warmth) * 0.8, -1.5, 1.5)); // a colour from the other side of the palette sits a step toward its side
    const vary = rnd(5) < 0.22 ? (rnd(6) < 0.5 ? -1 : 1) : 0;
    const li = clamp(dna.anchor + dna.progression[bar % 4] + motif.steps[step] + dV + dW + vary, 0, dna.lattice.length - 1);
    const midi = dna.lattice[li];

    const accentSteps = ACCENTS[warmBar ? 'warm' : 'cool'], accent = accentSteps.indexOf(step) >= 0;
    const sNote = 0.5 * col.s + 0.5 * dna.avgS, vNote = 0.5 * col.v + 0.5 * dna.avgV;
    const energy = 0.92 + 0.08 * Math.sin(2 * Math.PI * (bar / 8 + hash(dna.seed, 0, 21)));   // a slow 8-bar swell
    const vel = clamp(0.66 + (accent ? 0.1 + 0.1 * sNote : 0) + (col.v - 0.5) * 0.18 + (rnd(1) - 0.5) * 0.16, 0.52, 1) * (0.88 + 0.12 * vNote) * energy;

    const huePan = Math.sin(((col.h - dna.avgH) * Math.PI) / 180);
    const pan = clamp(0.5 * huePan + (frac(idx * 0.618034) - 0.5) * 0.9 + (rnd(2) - 0.5) * 0.1, -0.7, 0.7);
    let restAt = dna.restProb * (accent ? 0.35 : 1) * (!warmBar && (step === 3 || step === 7) ? 1.7 : 1);
    restAt = clamp(restAt, 0, 0.5);

    return {
      idx, bar, step, midi, freq: midiToFreq(midi), latIdx: li, hue: col.h, sat: col.s, val: col.v,
      warm: 0.75 * col.warmth + 0.25 * dna.warmth >= 0, warmth: col.warmth,
      bright: 0.6 + 0.85 * vNote, open: clamp(0.5 + 0.7 * sNote, 0.45, 1.25),
      vel: clamp(vel, 0.4, 1), accent, pan, rest: step !== 0 && rnd(3) < restAt, energy,
      jitter: step === 0 ? 0 : (rnd(4) - 0.5) * 0.024, rnd
    };
  }

  /** A short grace note half a step after a warm, syncopated step (never on instruments with long notes). Null when there is none. */
  function pickupAt(dna, note) {
    if (!dna.pickupProb || note.rest || note.pickup) return null;
    if (note.step !== 2 && note.step !== 5 && note.step !== 7) return null;
    if (hash(dna.seed, note.idx, 12) >= dna.pickupProb * note.energy) return null;
    const li = clamp(note.latIdx + (hash(dna.seed, note.idx, 14) < 0.5 ? 1 : 2), 0, dna.lattice.length - 1), midi = dna.lattice[li];
    const idx = note.idx + 0.5, rnd = k => hash(dna.seed, note.idx + 1000, k);
    return Object.assign({}, note, { pickup: true, idx, midi, freq: midiToFreq(midi), latIdx: li, vel: note.vel * 0.62, accent: false, rest: false, jitter: (rnd(4) - 0.5) * 0.016, rnd });
  }

  /**
   * Walks the piece forward in time. `getDna()` is asked for the current DNA at every step (the live player passes the artwork's
   * latest palette, the WAV export a fixed one). advance(until, emit) calls emit(note, time, dna) for every note that starts before `until`.
   */
  function createSequencer(getDna, startTime, firstIdx) {
    let next = startTime, idx = firstIdx | 0;
    return {
      /** `now` (live only): if the page was throttled and we fell behind, skip ahead instead of firing a burst of late notes. */
      advance(until, emit, now) {
        if (now !== undefined && next < now - 0.25) next = now + 0.02;
        while (next < until) {
          const dna = getDna();
          const note = noteAt(dna, idx);
          if (!note.rest) {
            emit(note, Math.max(0, next + note.jitter), dna);
            const pk = pickupAt(dna, note);
            if (pk) emit(pk, Math.max(0, next + dna.intervalMs / 2000 + pk.jitter), dna);
          }
          next += dna.intervalMs / 1000;
          idx++;
        }
      },
      /** Restart the step grid at `t` (a new sub-mode begins its own rhythm now instead of waiting for the old grid), keeping the piece's position. */
      retime(t) { next = t; },
      get nextTime() { return next; },
      get index() { return idx; }
    };
  }

  return { SCALES, BAR, LEAD, WARM_EDGE, midiToFreq, isWarmHue, warmthOfHue, rgbToHsv, readColours, hash, analyze, noteAt, pickupAt, createSequencer, modeKey, modeOf };
})();
