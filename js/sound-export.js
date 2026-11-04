/* ==========================================================================
   sound-export.js — AUDIO EXPORT of the Soundscape: renders the very same session the live player uses (SoundMusic + SoundEngines +
   SoundFX bus) into an OfflineAudioContext, masters it and encodes a 16-bit stereo WAV.

   What differs from the live player (and only this):
     live   notes are scheduled by a look-ahead timer; the master stage is the user's volume / mute + the analyser that feeds the animation.
     WAV    notes are scheduled by a plain loop; the master stage is a fixed mastering step (fades + level), independent of the user's volume / mute.
     The sample rate is 44.1 kHz here and whatever the device runs at live; the arrangement, layers, envelopes, effects and relative levels are the same code.

   Mastering (master()): fade-in 0.45 s and fade-out 1.4 s applied to the samples, then ONE gain for the whole file so that RMS reaches
   -18 dBFS but the peak never exceeds -1 dBFS. A single gain keeps every layer's relative level exactly as the engine made it.

   Public:  render(params, seconds, opts?) -> Promise<{ channels, rate, seconds, report }>   (opts.layers {bed, notes}: diagnostics only)      toWavBuffer(channels, rate) -> ArrayBuffer
            master(channels, rate, seconds) · measure(channels, rate, from, to) · clampSeconds(s) · constants
   ========================================================================== */
const SoundExport = (function () {
  'use strict';

  const RATE = 44100;
  const MIN_SEC = 4, MAX_SEC = 30;
  const HEAD = SoundMusic.LEAD;      // first note, seconds after the start: the SAME lead-in as the live player (shared constant)
  const FADE_IN = 0.45, FADE_OUT = 1.4;
  const NOTES_END_BEFORE = 1.6;      // no new notes in the last 1.6 s: the end of the file is the tails of earlier notes
  const TARGET_PEAK_DB = -1, TARGET_RMS_DB = -18, MAX_GAIN = 16;

  const db = x => 20 * Math.log10(Math.max(x, 1e-12));
  const clampSeconds = s => Math.max(MIN_SEC, Math.min(MAX_SEC, Number(s) || 10));

  /** Peak and RMS (over all channels) of the samples between two times. */
  function measure(channels, rate, from, to) {
    const a = Math.max(0, Math.floor((from || 0) * rate)), b = Math.min(channels[0].length, Math.floor((to === undefined ? channels[0].length / rate : to) * rate));
    let peak = 0, sum = 0, count = 0;
    channels.forEach(ch => {
      for (let i = a; i < b; i++) { const x = ch[i], ax = x < 0 ? -x : x; if (ax > peak) peak = ax; sum += x * x; count++; }
    });
    return { peak, rms: count ? Math.sqrt(sum / count) : 0 };
  }

  /** Fades + one overall gain, in place. Returns what was done (for the export report and the tests). */
  function master(channels, rate, seconds) {
    const n = channels[0].length, fi = Math.floor(FADE_IN * rate), fo = Math.floor(FADE_OUT * rate);
    channels.forEach(ch => {
      for (let i = 0; i < fi && i < n; i++) { const k = Math.sin((i / fi) * Math.PI / 2); ch[i] *= k * k; }
      for (let i = 0; i < fo && i < n; i++) { const k = Math.sin((i / fo) * Math.PI / 2); ch[n - 1 - i] *= k * k; }
    });
    const before = measure(channels, rate);
    let gain = 1;
    if (before.peak > 1e-6 && before.rms > 1e-7) {
      gain = Math.min(Math.pow(10, TARGET_PEAK_DB / 20) / before.peak, Math.pow(10, TARGET_RMS_DB / 20) / before.rms, MAX_GAIN);
      channels.forEach(ch => { for (let i = 0; i < n; i++) ch[i] *= gain; });
    }
    const after = measure(channels, rate);
    return { gain, gainDb: db(gain), peakDb: db(after.peak), rmsDb: db(after.rms), peakBeforeDb: db(before.peak), rmsBeforeDb: db(before.rms), seconds };
  }

  /** 16-bit PCM WAV (interleaved, little-endian) — pure, works in Node too. */
  function toWavBuffer(channels, rate) {
    const numCh = channels.length, samples = channels[0].length, blockAlign = numCh * 2, dataSize = samples * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize), dv = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, numCh, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        dv.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), true); o += 2;
      }
    }
    return ab;
  }

  /** Renders the artwork's soundscape. Nothing here touches the live AudioContext or the live graph. */
  async function render(params, seconds, opts) {
    const layers = Object.assign({ bed: true, notes: true }, opts && opts.layers);   // layers: only for tests / diagnostics (bed-only, notes-only)
    const sec = clampSeconds(seconds);
    const OAC = (typeof window !== 'undefined') && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!OAC) throw new Error('OfflineAudioContext is not available');
    const off = new OAC(2, Math.floor(RATE * sec), RATE);
    const dna = SoundMusic.analyze(params);

    const out = off.createGain();
    out.connect(off.destination);
    const session = SoundEngines.createSession(off, dna, out, { t0: 0 });
    if (layers.bed) session.startBed(0);
    let notes = 0;
    if (layers.notes) SoundMusic.createSequencer(() => dna, HEAD, 0).advance(sec - NOTES_END_BEFORE, (note, t) => { session.play(note, t, dna); notes++; });

    const rendered = await off.startRendering();
    const channels = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(new Float32Array(rendered.getChannelData(c)));
    const m = master(channels, RATE, sec);
    return {
      channels, rate: RATE, seconds: sec,
      report: Object.assign({ key: session.key, notes, bed: SoundEngines.hasBed(session.key), scale: dna.scaleName, intervalMs: dna.intervalMs }, m)
    };
  }

  return { render, master, measure, toWavBuffer, clampSeconds, RATE, FADE_IN, FADE_OUT, HEAD, NOTES_END_BEFORE, TARGET_PEAK_DB, TARGET_RMS_DB };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SoundExport;
