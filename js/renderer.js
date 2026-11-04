/* ==========================================================================
   renderer.js — drawing only (no app state).
   renderCanvas(params, canvas, w, h, timeOffset, opts) paints one artwork.
   - params come from Engine.buildParams(comp). Geometry is diagonal-relative, so a 512 px draft, the
     1280 px preview and a 4096 px export are the same picture.
   - opts.cancel(): return true to abandon a stale render (resolves to false).
   - opts.sync: never yield to the event loop (used by the animation loop).
   Supports 6 styles (fluid, paper, aurora, polygon, crystal, chroma) and their sub-modes.
   ========================================================================== */

/* The whole drawing module lives in ONE function (RendererFactory) so the very same text can run twice: on the page (the `var { ... } = RendererFactory()` line
   at the bottom publishes the four entry points other files use, as before) and inside the PNG export worker (png-worker.js builds the worker from
   RendererFactory.toString()). Nothing in it may touch the DOM except through makeScratchCanvas(); outside helpers it needs are listed in png-worker.js (PRELUDE). */
function RendererFactory() {

const WOBBLE = 0.0161;            // 35 px on the original 1024 x 1024 canvas, as a fraction of the working diagonal
const CRYSTAL_WOBBLE = 0.0146;    // 15 px on 1024
const REF_DIAG = 1448;            // hypot(1024, 1024)
const AURORA_NIGHT_RGB = [10, 10, 20];   // base colour of prism / neon Aurora (#0a0a14); Color Lab reads it through renderedBackground()

function setupHiDPICanvas(canvas, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Radar of the five Colour DNA metrics.
 */
function drawRadar(ctxObj, metricsObj, opts) {
  if (typeof opts === 'number') opts = { radius: opts };
  opts = opts || {};
  const W = opts.width || ctxObj.canvas.width, H = opts.height || ctxObj.canvas.height, cx = W / 2, cy = H / 2;
  const hasNames = !!opts.labels;
  const r = opts.radius || (Math.min(W, H) / 2 - (hasNames ? 54 : 62));
  const acc = opts.accent || [255, 92, 119];
  const accent = `rgb(${acc.join(',')})`;
  const grid = opts.gridColor || '#363c49', text = opts.textColor || '#fff', muted = opts.mutedColor || '#a9b0bc';

  ctxObj.clearRect(0, 0, W, H);
  ctxObj.strokeStyle = grid; ctxObj.lineWidth = 1; ctxObj.setLineDash([]);
  for (let level = 1; level <= 4; level++) {
    ctxObj.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2, x = cx + Math.cos(a) * (r * level / 4), y = cy + Math.sin(a) * (r * level / 4);
      if (i === 0) ctxObj.moveTo(x, y); else ctxObj.lineTo(x, y);
    }
    ctxObj.closePath(); ctxObj.stroke();
  }

  const icons = ['🌈', '✨', '🎯', '🔥', '☀️'];
  const keys = ['diversity', 'colorfulness', 'monochromatic', 'warm', 'brightness'];
  const vals = keys.map(k => metricsObj[k]);

  ctxObj.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    ctxObj.beginPath(); ctxObj.moveTo(cx, cy); ctxObj.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctxObj.stroke();

    const labelDist = r + (hasNames ? 12 : 16);
    const lx = cx + Math.cos(a) * labelDist, ly = cy + Math.sin(a) * labelDist;
    const align = Math.abs(Math.cos(a)) < 0.1 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
    ctxObj.textAlign = align;
    if (hasNames) {
      const above = Math.sin(a) < -0.5, below = Math.sin(a) > 0.5;
      const yShift = above ? -14 : below ? 14 : 0;
      ctxObj.font = '600 11px system-ui, sans-serif'; ctxObj.fillStyle = muted;
      ctxObj.fillText(opts.labels[i], lx, ly + yShift - 7);
      ctxObj.font = '700 13px system-ui, sans-serif'; ctxObj.fillStyle = text;
      ctxObj.fillText(vals[i].toFixed(0) + '%', lx, ly + yShift + 8);
    } else {
      ctxObj.font = 'bold 12px system-ui, sans-serif'; ctxObj.fillStyle = text;
      const txt = `${icons[i]} ${vals[i].toFixed(0)}%`;
      if (align === 'center') ctxObj.fillText(txt, cx, ly + (Math.sin(a) > 0 ? 8 : -8)); else ctxObj.fillText(txt, lx, ly);
    }
  }

  const poly = vs => {
    ctxObj.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2, valR = r * (vs[i] / 100), x = cx + Math.cos(a) * valR, y = cy + Math.sin(a) * valR;
      if (i === 0) ctxObj.moveTo(x, y); else ctxObj.lineTo(x, y);
    }
    ctxObj.closePath();
  };
  if (opts.compare) {
    poly(keys.map(k => opts.compare[k]));
    ctxObj.setLineDash([5, 4]); ctxObj.strokeStyle = muted; ctxObj.lineWidth = 1.5; ctxObj.stroke(); ctxObj.setLineDash([]);
  }
  poly(vals);
  ctxObj.fillStyle = `rgba(${acc.join(',')},0.30)`; ctxObj.fill(); ctxObj.strokeStyle = accent; ctxObj.lineWidth = 2.5; ctxObj.stroke();
  if (hasNames) {
    ctxObj.fillStyle = accent;
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2, valR = r * (vals[i] / 100);
      ctxObj.beginPath(); ctxObj.arc(cx + Math.cos(a) * valR, cy + Math.sin(a) * valR, 3.5, 0, Math.PI * 2); ctxObj.fill();
    }
  }
}

/** A scratch canvas that works on the page (DOM canvas) and inside a worker (OffscreenCanvas). */
function makeScratchCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

/* ---------- film grain: a seeded noise tile, cached ---------- */
let _noise = { key: '', canvas: null };
function getNoiseTile(seed, alpha) {
  const key = seed + ':' + Math.round(alpha * 255);
  if (_noise.key === key) return _noise.canvas;
  const c = makeScratchCanvas(256, 256);
  const nctx = c.getContext('2d'), img = nctx.createImageData(256, 256), rnd = mulberry32((seed | 0) + 99);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd() * 255;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = alpha * 255;
  }
  nctx.putImageData(img, 0, 0);
  _noise = { key, canvas: c };
  return c;
}

const _sleep0 = () => new Promise(r => setTimeout(r, 0));

/**
 * Interactive Physics helper: displaces a canvas point (px, py) in [0..w, 0..h]
 * based on pointer ripple/attraction and real-time audio energy.
 */
function applyPointPhysics(x, y, w, h, opts, phase) {
  let dx = 0, dy = 0;
  if (opts && opts.audio && opts.audio.level > 0.01) {
    const amp = opts.audio.bass * Math.min(w, h) * 0.032;
    dx += Math.cos(phase * 1.7) * amp * 0.45;
    dy += Math.sin(phase * 1.3) * amp;
  }
  if (opts && opts.physics && opts.physics.strength > 0.01) {
    const p = opts.physics;
    const mx = p.x * w, my = p.y * h;
    const vx = x - mx, vy = y - my;
    const dist = Math.hypot(vx, vy);
    const radius = Math.hypot(w, h) * 0.34;
    if (dist < radius && dist > 0.001) {
      const falloff = Math.pow(1 - dist / radius, 1.8) * p.strength;
      const dir = p.attract ? -1 : 1;
      const push = dir * falloff * Math.min(w, h) * 0.095;
      dx += (vx / dist) * push + (p.vx || 0) * w * falloff * 0.6;
      dy += (vy / dist) * push + (p.vy || 0) * h * falloff * 0.6;
    }
  }
  return { x: x + dx, y: y + dy };
}

/**
 * The colour this renderer paints underneath everything for these params (what a viewer sees "behind" the layers).
 * ONE definition: renderCanvas fills with it and Color Lab's "artwork background" contrast reads it, so the two cannot drift apart.
 * (Neon / prism Aurora sit on a night base; Constellation on a darkened copy of the average; Canyon on its darkened core colour.)
 */
function renderedBackground(params) {
  const style = params.style;
  if (style === 'aurora' && (params.auroraMode || 'prism') !== 'glass') return AURORA_NIGHT_RGB.slice();
  if (style === 'polygon' && params.polyMode === 'constellation') {
    const bg = params.avgBg || [14, 18, 32];
    return bg.map(v => Math.round(v * 0.28 + 8));
  }
  if (style === 'paper' && params.paperMode === 'canyon' && params.layers && params.layers[0] && params.layers[0].color) {
    return params.layers[0].color.map(v => Math.round(v * 0.55));
  }
  return (params.avgBg || [0, 0, 0]).slice();
}

async function renderCanvas(params, targetCanvas, w, h, timeOffset = 0, opts = {}) {
  const ctx = targetCanvas.getContext('2d');
  if (targetCanvas.width !== w) targetCanvas.width = w;
  if (targetCanvas.height !== h) targetCanvas.height = h;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.clearRect(0, 0, w, h);

  const hyp = Math.sqrt(w * w + h * h), diag = hyp * 1.5, px = hyp / REF_DIAG;
  const cancelled = () => !!(opts.cancel && opts.cancel());
  const canYield = !opts.sync && timeOffset === 0;
  const aMode = params.auroraMode || 'prism';
  const isGlass = params.style === 'aurora' && aMode === 'glass';
  const isPrism = params.style === 'aurora' && aMode === 'prism';

  if (!params.transparent) {
    ctx.fillStyle = hex(renderedBackground(params));
    ctx.fillRect(0, 0, w, h);
  }

  let lastYield = performance.now();

  if (params.style === 'crystal') {
    drawCrystal(ctx, params, w, h, timeOffset, px, diag, opts);
  } else if (params.style === 'chroma') {
    await drawChroma(ctx, params, w, h, diag, timeOffset, px, canYield, cancelled, opts);
  } else if (params.style === 'paper' && (params.paperMode === 'canyon' || params.paperMode === 'cutout')) {
    drawPaperSubMode(ctx, params, w, h, diag, timeOffset, px, opts);
  } else if (params.style === 'polygon' && (params.polyMode === 'isometric' || params.polyMode === 'shatter' || params.polyMode === 'constellation')) {
    drawPolygonSubMode(ctx, params, w, h, diag, timeOffset, px, opts);
  } else {
    const n = Math.max(1, params.waveCount);
    for (let i = 0; i < n; i++) {
      const layer = params.layers[i];
      const yOff = layer.yOffset * diag, wob = WOBBLE * diag;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(layer.angle);
      ctx.translate(-diag / 2, -diag / 2);
      ctx.beginPath();
      ctx.moveTo(0, diag);
      ctx.lineTo(0, yOff);

      const isPaper = params.style === 'paper';
      const audioBoost = (opts && opts.audio) ? (1 + opts.audio.bass * (isPaper ? 1.55 : 1.15)) : 1;
      const physMult = isPaper ? 0.145 : 0.09;
      const physShift = (opts && opts.physics) ? ((opts.physics.y - 0.5) * diag * physMult * opts.physics.strength * (opts.physics.attract ? -1 : 1)) : 0;
      const tempPts = layer.pts.map((p, idx) => {
        let px0 = p.x * diag;
        let py = p.y * diag + Math.sin(timeOffset + p.phase) * wob * audioBoost;
        if (opts && opts.physics && opts.physics.strength > 0.01) {
          const distX = Math.abs(p.x - opts.physics.x);
          const span = isPaper ? 0.55 : 0.45;
          if (distX < span) {
            const bell = Math.cos((distX / span) * Math.PI * 0.5);
            py += bell * physShift * (isPaper ? Math.cos(idx * 0.9 + layer.angle) : Math.sin(idx + layer.angle));
            if (isPaper) px0 += bell * (opts.physics.x - 0.5) * diag * 0.045 * opts.physics.strength;
          }
        }
        return { x: px0, y: py };
      });
      if (params.style === 'polygon') {
        for (let j = 0; j <= 6; j++) ctx.lineTo(tempPts[j].x, tempPts[j].y);
        ctx.lineTo(diag, yOff);
      } else {
        for (let j = 0; j < tempPts.length - 1; j++) {
          const mx = (tempPts[j].x + tempPts[j + 1].x) / 2, my = (tempPts[j].y + tempPts[j + 1].y) / 2;
          ctx.quadraticCurveTo(tempPts[j].x, tempPts[j].y, mx, my);
        }
        ctx.lineTo(diag, yOff);
      }
      ctx.lineTo(diag, diag);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, yOff - diag * 0.2, 0, yOff + diag * 0.4);
      if (params.style === 'aurora') {
        grad.addColorStop(0, `rgba(${layer.color[0]}, ${layer.color[1]}, ${layer.color[2]}, 1)`);
        grad.addColorStop(1, `rgba(${layer.nextColor[0]}, ${layer.nextColor[1]}, ${layer.nextColor[2]}, 0)`);
      } else {
        grad.addColorStop(0, `rgb(${layer.color.join(',')})`);
        grad.addColorStop(1, `rgb(${layer.nextColor.join(',')})`);
      }

      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'transparent'; ctx.globalAlpha = 1.0;
      const solidColor = `rgb(${layer.color.join(',')})`;
      const intensity = params.intensity === undefined ? 1 : params.intensity;

      if (params.style === 'paper') {
        ctx.fillStyle = solidColor;
        const depth = (i + 1) / Math.max(1, n);
        if (opts && opts.physics && opts.physics.strength > 0.01) {
          const p = opts.physics;
          const dir = p.attract ? -1 : 1;
          const pxShift = (p.x - 0.5) * diag * 0.055 * depth * p.strength * dir;
          const pyShift = (p.y - 0.5) * diag * 0.055 * depth * p.strength * dir;
          ctx.translate(pxShift, pyShift);
        }
        if (params.soft > 0) {
          const audioPulse = (opts && opts.audio) ? (1 + opts.audio.bass * 0.65) : 1;
          ctx.shadowColor = `rgba(15, 23, 42, ${Math.min(0.92, 0.42 + params.soft * 0.42)})`;
          ctx.shadowBlur = diag * 0.016 * params.soft * audioPulse;
          const shadowDist = diag * 0.026 * params.soft * audioPulse;
          let angleRad = (params.paperAngle === undefined ? 45 : params.paperAngle) * (Math.PI / 180);
          if (opts && opts.physics && opts.physics.strength > 0.01) {
            angleRad += ((opts.physics.x - 0.5) * 0.9 - (opts.physics.y - 0.5) * 0.6) * opts.physics.strength;
          }
          ctx.shadowOffsetX = shadowDist * Math.cos(angleRad);
          ctx.shadowOffsetY = shadowDist * Math.sin(angleRad);
        }
        ctx.fill();

      } else if (params.style === 'polygon') {
        if (params.polyMode !== 'flat') ctx.globalAlpha = 0.88;
        const polyGrad = ctx.createLinearGradient(0, yOff, diag * 0.6, yOff + diag * 0.4);
        polyGrad.addColorStop(0, `rgb(${layer.color.join(',')})`);
        polyGrad.addColorStop(1, `rgb(${layer.nextColor.join(',')})`);
        ctx.fillStyle = polyGrad;
        ctx.fill();

        const edge = params.edge === undefined ? 1 : params.edge;
        ctx.save();
        for (let j = 0; j < 6; j++) {
          const x1 = tempPts[j].x, y1 = tempPts[j].y, x2 = tempPts[j + 1].x, y2 = tempPts[j + 1].y;
          const hasTriangle = params.polyMode === 'faceted';
          if (hasTriangle) {
            const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
            const peakX = midX + (y2 - y1) * 0.35, peakY = midY - (x2 - x1) * 0.35;
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(peakX, peakY); ctx.lineTo(midX, midY); ctx.closePath();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.10)'; ctx.fill();
            ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(peakX, peakY); ctx.lineTo(midX, midY); ctx.closePath();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.12)'; ctx.fill();
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(peakX, peakY); ctx.lineTo(x2, y2);
          } else {
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          }
          const dark = layer.color.map(v => Math.max(0, Math.round(v * 0.62)));
          const baseAlpha = params.soft > 0 ? Math.min(0.42, 0.18 + params.soft * 0.22) : 0.15;
          ctx.lineWidth = Math.max(0.6, (params.soft > 0 ? 1.0 + params.soft * 0.4 : 1.0) * px);
          ctx.strokeStyle = `rgba(${dark[0]}, ${dark[1]}, ${dark[2]}, ${Math.min(0.9, baseAlpha * edge)})`;
          ctx.shadowBlur = 0;
          ctx.stroke();
        }
        ctx.restore();

      } else if (params.style === 'aurora') {
        ctx.fillStyle = grad;
        let baseAlpha;
        if (isGlass) {
          ctx.globalCompositeOperation = 'multiply';
          baseAlpha = 0.52 * Math.pow(10 / Math.max(6, n), 0.46);
        } else if (isPrism) {
          ctx.globalCompositeOperation = (i % 3 === 1) ? 'multiply' : 'screen';
          baseAlpha = 0.48 * Math.pow(10 / Math.max(6, n), 0.42);
        } else {
          ctx.globalCompositeOperation = 'screen';
          baseAlpha = 0.46 * Math.pow(10 / Math.max(5, n), 0.48);
        }
        ctx.globalAlpha = Math.min(0.92, Math.max(0.12, baseAlpha * intensity));
        if (params.soft > 0) {
          ctx.shadowColor = solidColor;
          ctx.shadowBlur = diag * (isGlass ? 0.08 : 0.28) * params.soft;
          ctx.shadowOffsetY = 0;
        }
        ctx.fill();

      } else {                       // fluid: "Mesh Glow"
        ctx.fillStyle = grad;
        ctx.globalAlpha = Math.min(1, 0.85 * intensity);
        if (params.soft > 0) {
          ctx.shadowColor = solidColor;
          ctx.shadowBlur = diag * 0.18 * params.soft;
          ctx.shadowOffsetY = 0;
        }
        ctx.fill();
      }

      ctx.restore();
      if (canYield) {
        const now = performance.now();
        if (now - lastYield > 14) { await _sleep0(); lastYield = performance.now(); }
      }
      if (cancelled()) return false;
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  if (params.grain > 0 && !params.transparent) {
    const s = Math.max(1, hyp / REF_DIAG);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.scale(s, s);
    ctx.fillStyle = ctx.createPattern(getNoiseTile(params.grainSeed || 1, params.grain), 'repeat');
    ctx.fillRect(0, 0, w / s, h / s);
    ctx.restore();
  }
  return !cancelled();
}

/* ==========================================================================
   Style #6: Liquid Chroma ('mercury', 'iridescent', 'molten')
   ========================================================================== */
async function drawChroma(ctx, params, w, h, diag, t, px, canYield, cancelled, opts = {}) {
  const audioBoost = (opts && opts.audio) ? (1 + opts.audio.bass * 1.2) : 1;
  const n = Math.max(3, params.waveCount);
  const mode = params.chromaMode || 'mercury';
  const turb = params.turb === undefined ? 1 : params.turb;
  const intensity = params.intensity === undefined ? 1 : params.intensity;
  const edge = params.edge === undefined ? 1 : params.edge;
  const wob = WOBBLE * diag * 1.25;
  let lastYield = performance.now();

  for (let i = 0; i < n; i++) {
    const layer = params.layers[i];
    const yOff = layer.yOffset * diag;
    const c1 = layer.color;
    const c2 = layer.nextColor;
    const cHi = c1.map(v => Math.min(255, Math.round(v * 0.35 + 215)));
    const cDark = c1.map(v => Math.max(0, Math.round(v * 0.18)));
    const cMid = mode === 'iridescent' ? shiftColor(c1, 65 + (i * 23) % 120) : c2;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(layer.angle);
    ctx.translate(-diag / 2, -diag / 2);

    const tempPts = layer.pts.map((p, idx) => ({
      x: p.x * diag,
      y: p.y * diag + (Math.sin(t + p.phase + idx * 0.6) * wob + Math.cos(t * 0.7 - p.phase) * wob * 0.45 * turb) * audioBoost + ((opts && opts.physics && Math.abs(p.x - opts.physics.x) < 0.4) ? (opts.physics.y - 0.5) * diag * 0.08 * opts.physics.strength : 0)
    }));

    ctx.beginPath();
    ctx.moveTo(0, diag);
    ctx.lineTo(0, tempPts[0].y);
    for (let j = 0; j < tempPts.length - 1; j++) {
      const mx = (tempPts[j].x + tempPts[j + 1].x) / 2;
      const my = (tempPts[j].y + tempPts[j + 1].y) / 2;
      ctx.quadraticCurveTo(tempPts[j].x, tempPts[j].y, mx, my);
    }
    ctx.lineTo(diag, tempPts[tempPts.length - 1].y);
    ctx.lineTo(diag, diag);
    ctx.closePath();

    const bandSpan = diag * 0.36;
    const grad = ctx.createLinearGradient(0, yOff - bandSpan * 0.45, 0, yOff + bandSpan);
    if (mode === 'molten') {
      const cGlow = c1.map(v => Math.min(255, Math.round(v * 1.35 + 40)));
      grad.addColorStop(0, `rgb(${cDark.join(',')})`);
      grad.addColorStop(0.18, `rgb(${cGlow.join(',')})`);
      grad.addColorStop(0.32, `rgb(255, 245, 220)`);
      grad.addColorStop(0.52, `rgb(${c1.join(',')})`);
      grad.addColorStop(0.80, `rgb(${c2.map(v => Math.round(v * 0.45)).join(',')})`);
      grad.addColorStop(1, `rgb(${cDark.join(',')})`);
    } else if (mode === 'iridescent') {
      const cShift2 = shiftColor(c2, -55);
      grad.addColorStop(0, `rgb(${cDark.join(',')})`);
      grad.addColorStop(0.16, `rgb(${c1.join(',')})`);
      grad.addColorStop(0.30, `rgb(${cHi.join(',')})`);
      grad.addColorStop(0.48, `rgb(${cMid.join(',')})`);
      grad.addColorStop(0.72, `rgb(${cShift2.join(',')})`);
      grad.addColorStop(1, `rgb(${cDark.join(',')})`);
    } else {
      grad.addColorStop(0, `rgb(${cDark.join(',')})`);
      grad.addColorStop(0.15, `rgb(${c1.join(',')})`);
      grad.addColorStop(0.26, `rgb(${cHi.join(',')})`);
      grad.addColorStop(0.38, `rgb(${cDark.join(',')})`);
      grad.addColorStop(0.58, `rgb(${c2.join(',')})`);
      grad.addColorStop(0.82, `rgb(${cHi.map(v => Math.round(v * 0.85)).join(',')})`);
      grad.addColorStop(1, `rgb(${cDark.join(',')})`);
    }

    ctx.globalAlpha = Math.min(1, 0.94 * intensity);
    if (params.soft > 0) {
      ctx.shadowColor = mode === 'molten' ? `rgb(${c1.join(',')})` : `rgba(0, 0, 0, 0.65)`;
      ctx.shadowBlur = diag * 0.035 * params.soft;
      ctx.shadowOffsetY = -diag * 0.008 * params.soft;
    }
    ctx.fillStyle = grad;
    ctx.fill();

    if (edge > 0.05) {
      ctx.beginPath();
      ctx.moveTo(0, tempPts[0].y);
      for (let j = 0; j < tempPts.length - 1; j++) {
        const mx = (tempPts[j].x + tempPts[j + 1].x) / 2;
        const my = (tempPts[j].y + tempPts[j + 1].y) / 2;
        ctx.quadraticCurveTo(tempPts[j].x, tempPts[j].y, mx, my);
      }
      ctx.lineTo(diag, tempPts[tempPts.length - 1].y);
      ctx.strokeStyle = `rgba(${cHi[0]}, ${cHi[1]}, ${cHi[2]}, ${Math.min(0.95, 0.48 * edge)})`;
      ctx.lineWidth = Math.max(0.6, (1.5 + params.soft * 1.2) * px);
      ctx.shadowColor = `rgb(${cHi.join(',')})`;
      ctx.shadowBlur = diag * 0.012 * params.soft;
      ctx.stroke();
    }

    ctx.restore();
    if (canYield) {
      const now = performance.now();
      if (now - lastYield > 14) { await _sleep0(); lastYield = performance.now(); }
    }
    if (cancelled()) return;
  }
}

/* ==========================================================================
   Paper Cut Sub-modes: 'canyon' (Concentric Canyon) & 'cutout' (Layered Cutout Art)
   ========================================================================== */
function drawPaperSubMode(ctx, params, w, h, diag, t, px, opts = {}) {
  const n = Math.max(1, params.waveCount);
  const mode = params.paperMode;
  const baseAngleRad = (params.paperAngle === undefined ? 45 : params.paperAngle) * (Math.PI / 180);
  const turb = params.turb === undefined ? 1 : params.turb;
  const rng = mulberry32((params.seed | 0) + 47);
  const audioBass = (opts && opts.audio) ? opts.audio.bass : 0;
  const hasPhys = !!(opts && opts.physics && opts.physics.strength > 0.01);

  // Dynamic light-source shadow angle tilted by cursor position
  let angleRad = baseAngleRad;
  if (hasPhys) {
    angleRad += ((opts.physics.x - 0.5) * 0.95 - (opts.physics.y - 0.5) * 0.65) * opts.physics.strength;
  }

  if (mode === 'canyon') {
    const minDim = Math.min(w, h);
    const minR = minDim * 0.11;
    const maxR = Math.hypot(w, h) * 0.48;
    const nodes = 16;
    ctx.fillStyle = hex(renderedBackground(params));                 // the canyon core colour (same definition as the base fill)
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < n; i++) {
      const layer = params.layers[i];
      const frac = i / Math.max(1, n - 1);
      const depth = 1 - frac; // Inner canyon layers sit deeper -> stronger 3D parallax
      const baseR = (minR + Math.pow(frac, 0.92) * (maxR - minR)) * (1 + audioBass * 0.08 * (0.4 + depth));
      let driftX = Math.cos(layer.angle) * minDim * 0.03 * depth;
      let driftY = Math.sin(layer.angle) * minDim * 0.03 * depth;
      if (hasPhys) {
        const p = opts.physics;
        const dir = p.attract ? 1 : -1;
        driftX += (p.x - 0.5) * minDim * 0.16 * (0.35 + depth * 0.85) * p.strength * dir;
        driftY += (p.y - 0.5) * minDim * 0.16 * (0.35 + depth * 0.85) * p.strength * dir;
      }
      const cx = w / 2 + driftX, cy = h / 2 + driftY;

      ctx.save();
      ctx.fillStyle = `rgb(${layer.color.join(',')})`;
      if (params.soft > 0) {
        const shadowBoost = 1 + audioBass * 0.45;
        ctx.shadowColor = `rgba(8, 12, 24, ${Math.min(0.95, 0.45 + params.soft * 0.42)})`;
        ctx.shadowBlur = diag * 0.016 * params.soft * shadowBoost;
        const dist = diag * 0.015 * params.soft * shadowBoost;
        ctx.shadowOffsetX = dist * Math.cos(angleRad);
        ctx.shadowOffsetY = dist * Math.sin(angleRad);
      }

      ctx.beginPath();
      ctx.rect(-diag, -diag, diag * 3, diag * 3);

      const ringPts = [];
      for (let k = 0; k < nodes; k++) {
        const a = (Math.PI * 2 * k) / nodes + layer.angle * 0.25;
        const p1 = layer.pts[k % layer.pts.length];
        const p2 = layer.pts[(k + 2) % layer.pts.length];
        const wave = (Math.sin(a * 3 + p1.phase + i * 0.55) * 0.11 + Math.cos(a * 5 - p2.phase) * 0.06) * Math.min(1.4, turb * 0.85);
        const anim = Math.sin(t + p1.phase + k * 0.4) * (0.028 + audioBass * 0.045);
        const rk = Math.max(minDim * 0.05, baseR * (1 + wave + anim));
        const rawX = cx + Math.cos(a) * rk;
        const rawY = cy + Math.sin(a) * rk;
        ringPts.push(applyPointPhysics(rawX, rawY, w, h, opts, i * 1.3 + k * 0.7));
      }

      const startMidX = (ringPts[0].x + ringPts[nodes - 1].x) / 2;
      const startMidY = (ringPts[0].y + ringPts[nodes - 1].y) / 2;
      ctx.moveTo(startMidX, startMidY);
      for (let k = nodes - 1; k >= 0; k--) {
        const prev = ringPts[(k - 1 + nodes) % nodes];
        const mx = (ringPts[k].x + prev.x) / 2, my = (ringPts[k].y + prev.y) / 2;
        ctx.quadraticCurveTo(ringPts[k].x, ringPts[k].y, mx, my);
      }
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
    }
  } else {
    // 'cutout': Organic layered paper islands with 3D parallax, audio-reactive breathing & per-vertex cursor deformation
    for (let i = 0; i < n; i++) {
      const layer = params.layers[i];
      const frac = i / Math.max(1, n - 1);
      const depth = 0.25 + frac * 0.75; // Top cutout layers float higher and respond more strongly to cursor parallax
      let cx = w * (0.15 + 0.7 * ((i * 0.6180339 + rng() * 0.18) % 1)) + Math.sin(t + layer.pts[0].phase) * w * 0.035;
      let cy = h * (0.15 + 0.7 * ((i * 0.381966 + rng() * 0.18) % 1)) + Math.cos(t * 0.8 + layer.pts[1].phase) * h * 0.035;

      if (hasPhys) {
        const p = opts.physics;
        const dir = p.attract ? 1 : -1;
        cx += (p.x - 0.5) * w * 0.14 * depth * p.strength * dir;
        cy += (p.y - 0.5) * h * 0.14 * depth * p.strength * dir;
      }
      const centerPhys = applyPointPhysics(cx, cy, w, h, opts, i * 2.1);
      cx = centerPhys.x;
      cy = centerPhys.y;

      const radius = Math.min(w, h) * (0.48 - frac * 0.24) * (1 + audioBass * 0.11 * depth);
      const points = 10;

      ctx.save();
      const cTop = layer.color.map(v => Math.min(255, Math.round(v * 1.05)));
      const cBot = layer.color.map(v => Math.max(0, Math.round(v * 0.92)));
      const g = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      g.addColorStop(0, `rgb(${cTop.join(',')})`);
      g.addColorStop(1, `rgb(${cBot.join(',')})`);
      ctx.fillStyle = g;

      if (params.soft > 0) {
        const shadowBoost = 1 + audioBass * 0.5;
        ctx.shadowColor = `rgba(12, 16, 28, ${Math.min(0.92, 0.38 + params.soft * 0.42)})`;
        ctx.shadowBlur = diag * 0.019 * params.soft * shadowBoost;
        const dist = diag * 0.017 * params.soft * shadowBoost * (0.6 + depth * 0.6);
        ctx.shadowOffsetX = dist * Math.cos(angleRad);
        ctx.shadowOffsetY = dist * Math.sin(angleRad);
      }

      ctx.beginPath();
      const pts = [];
      for (let k = 0; k < points; k++) {
        const a = (Math.PI * 2 * k) / points + layer.angle * 0.3;
        const wave = Math.sin(a * 2 + layer.pts[k % layer.pts.length].phase) * 0.18 * turb
                   + Math.cos(a * 3 - i) * 0.1 * turb
                   + Math.sin(t + k * 0.6 + i) * (0.035 + audioBass * 0.055);
        const distVar = Math.max(radius * 0.35, radius * (1 + wave));
        const vx = cx + Math.cos(a) * distVar;
        const vy = cy + Math.sin(a) * distVar;
        pts.push(applyPointPhysics(vx, vy, w, h, opts, i * 1.7 + k * 0.9));
      }
      ctx.moveTo((pts[points - 1].x + pts[0].x) / 2, (pts[points - 1].y + pts[0].y) / 2);
      for (let k = 0; k < points; k++) {
        const next = pts[(k + 1) % points];
        const mx = (pts[k].x + next.x) / 2, my = (pts[k].y + next.y) / 2;
        ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
      }
      ctx.closePath();
      ctx.fill();

      // Subtle paper rim highlight
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
      ctx.lineWidth = Math.max(0.6, 1.15 * px);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* ==========================================================================
   Polygon Sub-modes: 'isometric' (3D Cubes with Deep Shadows), 'shatter' & 'constellation'
   ========================================================================== */
function drawPolygonSubMode(ctx, params, w, h, diag, t, px, opts = {}) {
  const pal = params.palette;
  const edge = params.edge === undefined ? 1 : params.edge;
  const turb = params.turb === undefined ? 1 : params.turb;
  const rng = mulberry32((params.seed | 0) + 31);
  const topAngle = (params.layers[0] ? params.layers[0].angle : 0) * 0.35;

  if (params.polyMode === 'isometric') {
    const cols = Math.max(4, Math.round(4 + params.waveCount * 0.28));
    const R = Math.max(w, h) / cols * 0.85;
    const dx = R * Math.sqrt(3), dy = R * 1.5;
    const nx = Math.ceil(diag / dx) + 2, ny = Math.ceil(diag / dy) + 2;

    ctx.save();
    ctx.translate(w / 2, h / 2); ctx.rotate(topAngle); ctx.translate(-w / 2, -h / 2);
    ctx.lineJoin = 'round';
    const x0 = w / 2 - (nx * dx) / 2, y0 = h / 2 - (ny * dy) / 2;
    const rx = R * Math.sqrt(3) / 2, ry = R / 2;
    const borderW = Math.max(0.5, R * 0.032 * edge);

    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const cx = x0 + c * dx + (r % 2 ? dx / 2 : 0);
        const cy = y0 + r * dy;
        const pIso = applyPointPhysics(cx, cy, w, h, opts, c + r);
        const elev = Math.sin(t + (c * 0.45 + r * 0.35) + rng() * Math.PI) * R * 0.34 * turb + (cy - pIso.y) * 0.65;
        const uy = cy - elev;
        const base = pal[Math.floor(rng() * pal.length)];

        // 1. Cast deep 3D ambient drop shadow under the entire cube onto cubes below it
        if (params.soft > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(cx, uy - R);
          ctx.lineTo(cx + rx, uy - ry);
          ctx.lineTo(cx + rx, uy + ry);
          ctx.lineTo(cx, uy + R);
          ctx.lineTo(cx - rx, uy + ry);
          ctx.lineTo(cx - rx, uy - ry);
          ctx.closePath();
          ctx.shadowColor = `rgba(4, 6, 14, ${Math.min(0.92, 0.55 + params.soft * 0.38)})`;
          ctx.shadowBlur = R * (0.28 + params.soft * 0.45);
          ctx.shadowOffsetX = R * 0.08;
          ctx.shadowOffsetY = R * (0.18 + params.soft * 0.22);
          ctx.fillStyle = `rgb(${base.join(',')})`;
          ctx.fill();
          ctx.restore();
        }

        // 2. Shaded 3D faces with internal directional gradients for rich volumetric depth
        const topHi = base.map(v => Math.min(255, Math.round(v * 1.28 + 18)));
        const topLo = base.map(v => Math.min(255, Math.round(v * 1.06)));
        const leftHi = base.map(v => Math.round(v * 0.96));
        const leftLo = base.map(v => Math.round(v * 0.74));
        const rightHi = base.map(v => Math.round(v * 0.64));
        const rightLo = base.map(v => Math.max(0, Math.round(v * 0.38)));

        const paintGradFace = (pts, cA, cB) => {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
          ctx.closePath();
          const g = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[2][0], pts[2][1]);
          g.addColorStop(0, `rgb(${cA.join(',')})`);
          g.addColorStop(1, `rgb(${cB.join(',')})`);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.lineWidth = borderW;
          ctx.strokeStyle = edge > 0.05 ? `rgba(8, 11, 20, ${Math.min(0.9, 0.45 * edge)})` : `rgb(${cA.join(',')})`;
          ctx.stroke();
        };

        paintGradFace([[cx, uy - R], [cx + rx, uy - ry], [cx, uy], [cx - rx, uy - ry]], topHi, topLo);
        paintGradFace([[cx - rx, uy - ry], [cx, uy], [cx, uy + R], [cx - rx, uy + ry]], leftHi, leftLo);
        paintGradFace([[cx, uy], [cx + rx, uy - ry], [cx + rx, uy + ry], [cx, uy + R]], rightHi, rightLo);

        // Specular Y-ridge highlight at the front corner of the cube
        ctx.beginPath();
        ctx.moveTo(cx - rx, uy - ry); ctx.lineTo(cx, uy); ctx.lineTo(cx + rx, uy - ry);
        ctx.moveTo(cx, uy); ctx.lineTo(cx, uy + R);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.22 + params.soft * 0.18})`;
        ctx.lineWidth = Math.max(0.5, R * 0.022);
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (params.polyMode === 'shatter') {
    const fx = w * (0.5 + (rng() - 0.5) * 0.28);
    const fy = h * (0.5 + (rng() - 0.5) * 0.28);
    const rays = Math.max(10, Math.min(48, Math.round(8 + params.waveCount * 0.7)));
    const rings = Math.max(3, Math.min(12, Math.round(3 + params.waveCount * 0.16)));
    const maxR = Math.hypot(w, h) * 0.85;

    ctx.save();
    ctx.lineJoin = 'round';
    const grid = [];
    for (let ir = 0; ir <= rings; ir++) {
      const row = [];
      const baseR = ir === 0 ? 0 : Math.pow(ir / rings, 0.88) * maxR;
      for (let ia = 0; ia < rays; ia++) {
        if (ir === 0) { row.push({ x: fx, y: fy }); continue; }
        const a = (Math.PI * 2 * ia) / rays + (rng() - 0.5) * (Math.PI * 2 / rays) * 0.42 * turb + topAngle;
        const rr = baseR * (1 + (rng() - 0.5) * 0.22 * turb + Math.sin(t + ia * 0.5 + ir) * 0.025);
        row.push({ x: fx + Math.cos(a) * rr, y: fy + Math.sin(a) * rr });
      }
      grid.push(row);
    }

    for (let ir = 0; ir < rings; ir++) {
      for (let ia = 0; ia < rays; ia++) {
        const na = (ia + 1) % rays;
        const p1 = grid[ir][ia], p2 = grid[ir + 1][ia], p3 = grid[ir + 1][na], p4 = grid[ir][na];
        const cA = pal[(ir * 3 + ia) % pal.length], cB = pal[(ir * 3 + ia + 1) % pal.length];
        const drawShard = (a, b, c, shade) => {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
          const colA = `rgb(${cA.map(v => Math.min(255, Math.max(0, Math.round(v * shade)))).join(',')})`;
          const colB = `rgb(${cB.map(v => Math.min(255, Math.max(0, Math.round(v * shade)))).join(',')})`;
          const g = ctx.createLinearGradient(a.x, a.y, c.x, c.y);
          g.addColorStop(0, colA); g.addColorStop(1, colB);
          ctx.fillStyle = g; ctx.fill();
          ctx.lineWidth = Math.max(0.5, (edge > 0.05 ? (0.9 + params.soft * 0.45) : 0.8) * px);
          ctx.strokeStyle = edge > 0.05 ? `rgba(255, 255, 255, ${Math.min(0.75, 0.2 * edge)})` : colA;
          ctx.stroke();
        };
        if (ir === 0) {
          drawShard(p1, p2, p3, 1.06);
        } else {
          drawShard(p1, p2, p3, 1.08);
          drawShard(p1, p3, p4, 0.88);
        }
      }
    }
    ctx.restore();
  } else {
    // 'constellation': Serene Star Constellation — translucent crystalline facets + delicate starlight threads + glowing star nodes
    const cols = Math.max(5, Math.min(13, Math.round(4 + Math.sqrt(params.waveCount) * 0.9)));
    const rows = Math.max(4, Math.min(11, Math.round(cols * (h / w))));
    const cellW = w / cols, cellH = h / rows;
    const rngC = mulberry32((params.seed | 0) + 83);

    const nodes = [];
    for (let r = 0; r <= rows; r++) {
      nodes[r] = [];
      for (let c = 0; c <= cols; c++) {
        const jx = (rngC() - 0.5) * cellW * 0.62 * turb;
        const jy = (rngC() - 0.5) * cellH * 0.62 * turb;
        const wx = Math.sin(t + c * 0.6 + r * 0.4) * cellW * 0.07;
        const wy = Math.cos(t + r * 0.6 - c * 0.4) * cellH * 0.07;
        const col = pal[(r * 3 + c * 2) % pal.length];
        const pCon = applyPointPhysics(c * cellW + jx + wx, r * cellH + jy + wy, w, h, opts, r * 5 + c);
        nodes[r][c] = { x: pCon.x, y: pCon.y, color: col, star: rngC() > 0.45 };
      }
    }

    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // 1. Soft translucent glass triangles connecting the constellation
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n1 = nodes[r][c], n2 = nodes[r][c + 1], n3 = nodes[r + 1][c], n4 = nodes[r + 1][c + 1];
        const paintGlassTri = (a, b, d, alphaMul) => {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.closePath();
          const g = ctx.createLinearGradient(a.x, a.y, d.x, d.y);
          g.addColorStop(0, `rgba(${a.color.join(',')}, ${0.28 * alphaMul})`);
          g.addColorStop(1, `rgba(${d.color.join(',')}, ${0.08 * alphaMul})`);
          ctx.fillStyle = g;
          ctx.fill();
        };
        paintGlassTri(n1, n2, n4, 1.1);
        paintGlassTri(n1, n4, n3, 0.8);
      }
    }

    // 2. Delicate glowing starlight filaments
    ctx.globalCompositeOperation = 'screen';
    const lineW = Math.max(0.5, (1.1 + params.soft * 0.8) * px);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n1 = nodes[r][c], n2 = nodes[r][c + 1], n3 = nodes[r + 1][c], n4 = nodes[r + 1][c + 1];
        const col = n1.color.map(v => Math.min(255, Math.round(v * 0.6 + 110)));
        ctx.strokeStyle = `rgba(${col.join(',')}, ${Math.min(0.85, 0.36 * edge)})`;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(n1.x, n1.y); ctx.lineTo(n2.x, n2.y);
        ctx.moveTo(n1.x, n1.y); ctx.lineTo(n3.x, n3.y);
        ctx.moveTo(n1.x, n1.y); ctx.lineTo(n4.x, n4.y);
        ctx.stroke();
      }
    }

    // 3. Softly glowing star halos at constellation vertices
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const nd = nodes[r][c];
        if (!nd.star) continue;
        const glowR = Math.max(2, cellW * (0.09 + params.soft * 0.08));
        const sg = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, glowR);
        const cBright = nd.color.map(v => Math.min(255, Math.round(v * 0.4 + 165)));
        sg.addColorStop(0, '#ffffff');
        sg.addColorStop(0.35, `rgba(${cBright.join(',')}, 0.85)`);
        sg.addColorStop(1, `rgba(${nd.color.join(',')}, 0)`);
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

/* ==========================================================================
   Crystal: 'harmonic', 'chaotic', 'geode' (Agate Geode Cavity), 'stained' (Cathedral Stained Glass)
   ========================================================================== */
const CRYSTAL_MAX_POINTS = 40000;

function drawCrystal(ctx, params, w, h, t, px, diag, opts = {}) {
  const mode = params.crystalMode || 'harmonic';
  if (mode === 'geode') {
    drawCrystalGeode(ctx, params, w, h, t, px, opts);
    return;
  }
  if (mode === 'stained') {
    drawCrystalStained(ctx, params, w, h, t, px, diag, opts);
    return;
  }

  const isChaotic = mode === 'chaotic';
  const jitterFactor = (isChaotic ? 0.95 : 0.42) * (params.jitter === undefined ? 1 : params.jitter);
  const spread = (isChaotic ? 0.3 : 0.12) * (params.facet === undefined ? 1 : params.facet);
  const cols = Math.max(4, Math.floor(params.waveCount * 0.45));
  const rows = Math.max(4, Math.floor(cols * (h / w)));
  let cellW = w / cols, cellH = h / rows;
  const R = Math.sqrt(w * w + h * h) / 2;
  let nx = Math.ceil(2 * R / cellW) + 3, ny = Math.ceil(2 * R / cellH) + 3;

  if ((nx + 1) * (ny + 1) > CRYSTAL_MAX_POINTS) {
    const f = Math.sqrt((nx + 1) * (ny + 1) / CRYSTAL_MAX_POINTS);
    cellW *= f; cellH *= f;
    nx = Math.ceil(2 * R / cellW) + 3; ny = Math.ceil(2 * R / cellH) + 3;
  }
  const gx0 = w / 2 - nx * cellW / 2, gy0 = h / 2 - ny * cellH / 2;
  const top = params.layers[params.waveCount - 1] || params.layers[0];

  let localSeed = ((params.seed | 0) + params.waveCount + 1) % 2147483646 + 1;
  const rand = () => { localSeed = (localSeed * 16807) % 2147483647; return (localSeed - 1) / 2147483646; };
  const wobAmp = params.soft > 0 ? 1 : 0.2;
  const pal = params.palette;

  const pts = [];
  for (let c = 0; c <= nx; c++) {
    pts[c] = [];
    for (let r = 0; r <= ny; r++) {
      const jx = (rand() - 0.5) * cellW * jitterFactor, jy = (rand() - 0.5) * cellH * jitterFactor;
      pts[c][r] = applyPointPhysics(
        gx0 + c * cellW + jx + Math.sin(t + c * 0.5) * (CRYSTAL_WOBBLE * w * wobAmp),
        gy0 + r * cellH + jy + Math.cos(t + r * 0.5) * (CRYSTAL_WOBBLE * h * wobAmp),
        w, h, opts, c + r
      );
    }
  }

  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.rotate(top.angle); ctx.translate(-w / 2, -h / 2);
  ctx.lineWidth = Math.max(0.6, px); ctx.lineJoin = 'round';

  const drawTri = (ta, tb, tc) => {
    ctx.beginPath(); ctx.moveTo(ta.x, ta.y); ctx.lineTo(tb.x, tb.y); ctx.lineTo(tc.x, tc.y); ctx.closePath();
    let color;
    if (isChaotic) {
      color = pal[Math.floor(rand() * pal.length)];
    } else {
      const triCx = (ta.x + tb.x + tc.x) / (3 * w), triCy = (ta.y + tb.y + tc.y) / (3 * h);
      const tNorm = Math.min(0.999, Math.max(0, (triCx + triCy) / 2));
      const exactPos = tNorm * (pal.length - 1), idx1 = Math.floor(exactPos), idx2 = Math.min(idx1 + 1, pal.length - 1), blend = exactPos - idx1;
      const c1 = pal[idx1], c2 = pal[idx2];
      color = [c1[0] * (1 - blend) + c2[0] * blend, c1[1] * (1 - blend) + c2[1] * blend, c1[2] * (1 - blend) + c2[2] * blend];
    }
    const lightOffset = (rand() - 0.5) * spread;
    const fill = `rgb(${Math.min(255, Math.max(0, Math.round(color[0] * (1 + lightOffset))))},${Math.min(255, Math.max(0, Math.round(color[1] * (1 + lightOffset))))},${Math.min(255, Math.max(0, Math.round(color[2] * (1 + lightOffset))))})`;
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = fill; ctx.stroke();
  };

  for (let c = 0; c < nx; c++) {
    for (let r = 0; r < ny; r++) {
      const p1 = pts[c][r], p2 = pts[c + 1][r], p3 = pts[c][r + 1], p4 = pts[c + 1][r + 1];
      if (rand() > 0.5) { drawTri(p1, p2, p4); drawTri(p1, p4, p3); }
      else { drawTri(p1, p2, p3); drawTri(p2, p4, p3); }
    }
  }
  ctx.restore();
}

/**
 * Crystal Sub-mode 1: 'geode' — Natural Agate & Quartz Geode Cavity (Core druzy cavity uses background color).
 */
function drawCrystalGeode(ctx, params, w, h, t, px, opts = {}) {
  const pal = params.palette;
  const jitter = params.jitter === undefined ? 1 : params.jitter;
  const facet = params.facet === undefined ? 1 : params.facet;
  const wobAmp = params.soft > 0 ? (0.3 + params.soft * 0.7) : 0.15;
  const rng = mulberry32((params.seed | 0) + 109);
  const top = params.layers[0] || { angle: 0 };

  const cx = w / 2, cy = h / 2;
  const maxR = Math.hypot(w, h) * 0.62;
  const coreR = Math.min(w, h) * 0.12;
  const rings = Math.max(5, Math.min(18, Math.round(4 + params.waveCount * 0.16)));
  const segs = Math.max(16, Math.min(56, Math.round(16 + params.waveCount * 0.45)));

  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2, p3 = rng() * Math.PI * 2;
  const shapeFactor = a => 1 + Math.sin(a * 2 + p1) * 0.12 * jitter + Math.cos(a * 3 + p2) * 0.09 * jitter + Math.sin(a * 5 + p3) * 0.05 * jitter;

  const ringPts = [];
  for (let ir = 0; ir <= rings; ir++) {
    const frac = ir / rings;
    const baseR = coreR + Math.pow(frac, 0.9) * (maxR - coreR);
    const row = [];
    for (let s = 0; s < segs; s++) {
      const a = (Math.PI * 2 * s) / segs + top.angle * 0.25 + (ir % 2 ? Math.PI / segs : 0);
      const tooth = ir <= 2 ? ((s % 2 === 0 ? -0.18 : 0.14) * facet) : ((rng() - 0.5) * 0.14 * jitter);
      const wob = Math.sin(t + s * 0.4 + ir * 0.6) * 0.022 * wobAmp;
      const rr = Math.max(coreR * 0.35, baseR * shapeFactor(a) * (1 + tooth * (1 - frac * 0.45) + wob));
      row.push(applyPointPhysics(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, w, h, opts, ir + s));
    }
    ringPts.push(row);
  }

  ctx.save();
  ctx.lineJoin = 'round';

  for (let ir = rings - 1; ir >= 0; ir--) {
    const outer = ringPts[ir + 1], inner = ringPts[ir];
    const bandCol = pal[(rings - 1 - ir) % pal.length];
    const nextCol = pal[(rings - ir) % pal.length];

    for (let s = 0; s < segs; s++) {
      const ns = (s + 1) % segs;
      const o1 = outer[s], o2 = outer[ns], i1 = inner[s], i2 = inner[ns];

      const paintCrystal = (a, b, c, isInnerPointing) => {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
        const shade = 1 + (rng() - 0.5) * 0.28 * facet + (isInnerPointing ? 0.08 : -0.06);
        const col = bandCol.map(v => Math.min(255, Math.max(0, Math.round(v * shade))));
        if (ir <= 2 && isInnerPointing) {
          const tipCol = col.map(v => Math.min(255, Math.round(v * 0.45 + 140)));
          const g = ctx.createLinearGradient(a.x, a.y, c.x, c.y);
          g.addColorStop(0, `rgb(${col.join(',')})`);
          g.addColorStop(1, `rgb(${tipCol.join(',')})`);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = `rgb(${col.join(',')})`;
        }
        ctx.fill();
        ctx.lineWidth = Math.max(0.6, px * 0.9);
        ctx.strokeStyle = ir <= 2 ? 'rgba(255,255,255,0.28)' : `rgb(${col.join(',')})`;
        ctx.stroke();
      };

      paintCrystal(o1, o2, i1, true);
      paintCrystal(o2, i2, i1, false);
    }

    if (ir > 0 && ir % 2 === 0) {
      ctx.beginPath();
      for (let s = 0; s < segs; s++) {
        const p = inner[s];
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      const rim = nextCol.map(v => Math.min(255, Math.round(v * 0.5 + 125)));
      ctx.strokeStyle = `rgba(${rim[0]}, ${rim[1]}, ${rim[2]}, 0.45)`;
      ctx.lineWidth = Math.max(0.7, 1.4 * px);
      ctx.stroke();
    }
  }

  // Druzy crystal cavity core: uses background color (`params.avgBg`)
  const innerRing = ringPts[0];
  ctx.beginPath();
  for (let s = 0; s < segs; s++) {
    if (s === 0) ctx.moveTo(innerRing[s].x, innerRing[s].y);
    else ctx.lineTo(innerRing[s].x, innerRing[s].y);
  }
  ctx.closePath();
  const bgc = params.avgBg || [36, 24, 66];
  const coreLight = bgc.map(v => Math.min(255, Math.round(v * 1.15 + 22)));
  const coreDeep = bgc.map(v => Math.round(v * 0.58 + 10));
  const coreGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreR * 1.35);
  coreGrad.addColorStop(0, `rgb(${coreLight.join(',')})`);
  coreGrad.addColorStop(1, `rgb(${coreDeep.join(',')})`);
  ctx.fillStyle = coreGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = Math.max(0.9, 1.6 * px);
  ctx.stroke();

  ctx.restore();
}

/**
 * Crystal Sub-mode 2: 'stained' — Voronoi Cathedral Stained Glass.
 * Lead came width (`leadWidth`) is a direct fraction of the cell size (`Math.min(cellW, cellH)`),
 * so the thick black solder lines look identically bold on both the small preset thumbnail and the full artwork!
 */
function drawCrystalStained(ctx, params, w, h, t, px, diag, opts = {}) {
  const pal = params.palette;
  const jitter = Math.min(1.35, (params.jitter === undefined ? 1 : params.jitter) * 0.85);
  const facet = params.facet === undefined ? 1 : params.facet;
  const wobAmp = params.soft > 0 ? (0.25 + params.soft * 0.75) : 0.15;
  const top = params.layers[0] || { angle: 0 };

  let localSeed = ((params.seed | 0) + params.waveCount + 19) % 2147483646 + 1;
  const rand = () => { localSeed = (localSeed * 16807) % 2147483647; return (localSeed - 1) / 2147483646; };

  const cols = Math.max(4, Math.min(14, Math.round(3 + Math.sqrt(params.waveCount) * 1.15)));
  const rows = Math.max(4, Math.min(14, Math.round(cols * (h / w))));
  const cellW = w / cols, cellH = h / rows;

  const sites = [];
  for (let r = -1; r <= rows + 1; r++) {
    for (let c = -1; c <= cols + 1; c++) {
      const jx = (rand() - 0.5) * cellW * jitter;
      const jy = (rand() - 0.5) * cellH * jitter;
      const wx = Math.sin(t + c * 0.7 + r * 0.5) * cellW * 0.08 * wobAmp;
      const wy = Math.cos(t + r * 0.7 - c * 0.5) * cellH * 0.08 * wobAmp;
      const pSt = applyPointPhysics((c + 0.5) * cellW + jx + wx, (r + 0.5) * cellH + jy + wy, w, h, opts, r * 7 + c);
      const sx = pSt.x, sy = pSt.y;
      const u = Math.min(0.999, Math.max(0, (sx / w + sy / h) * 0.5));
      const baseCol = pal[Math.floor(u * pal.length) % pal.length];
      sites.push({ x: sx, y: sy, r, c, color: baseCol, shade: (rand() - 0.5) * 0.26 * facet, angle: rand() * Math.PI * 2 });
    }
  }

  const clipPolygon = (poly, px0, py0, nx, ny) => {
    const out = [];
    const n = poly.length;
    if (!n) return out;
    for (let i = 0; i < n; i++) {
      const A = poly[i], B = poly[(i + 1) % n];
      const da = (A.x - px0) * nx + (A.y - py0) * ny;
      const db = (B.x - px0) * nx + (B.y - py0) * ny;
      if (da <= 0) {
        out.push(A);
        if (db > 0) {
          const s = da / (da - db);
          out.push({ x: A.x + (B.x - A.x) * s, y: A.y + (B.y - A.y) * s });
        }
      } else if (db <= 0) {
        const s = da / (da - db);
        out.push({ x: A.x + (B.x - A.x) * s, y: A.y + (B.y - A.y) * s });
      }
    }
    return out;
  };

  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const pad = Math.max(cellW, cellH) * 2;
  // Proportional to cell dimension (~7% to 13% of cell size) so the lead border is bold on every resolution
  const cellRef = Math.min(cellW, cellH);
  const leadWidth = Math.max(1.2, cellRef * (0.068 + params.soft * 0.06));

  for (let i = 0; i < sites.length; i++) {
    const S = sites[i];
    if (S.r < 0 || S.r > rows || S.c < 0 || S.c > cols) continue;

    let poly = [
      { x: S.x - pad, y: S.y - pad },
      { x: S.x + pad, y: S.y - pad },
      { x: S.x + pad, y: S.y + pad },
      { x: S.x - pad, y: S.y + pad }
    ];

    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const N = sites[j];
      if (Math.abs(N.r - S.r) > 2 || Math.abs(N.c - S.c) > 2) continue;
      const mx = (S.x + N.x) * 0.5, my = (S.y + N.y) * 0.5;
      const vx = N.x - S.x, vy = N.y - S.y;
      poly = clipPolygon(poly, mx, my, vx, vy);
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;

    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x, poly[k].y);
    ctx.closePath();

    const cMain = S.color.map(v => Math.min(255, Math.max(0, Math.round(v * (1 + S.shade)))));
    const cGlow = cMain.map(v => Math.min(255, Math.round(v * 0.55 + 115)));
    const cEdge = cMain.map(v => Math.max(0, Math.round(v * 0.42)));
    const rad = Math.max(cellW, cellH) * 0.78;
    const g = ctx.createRadialGradient(
      S.x - Math.cos(S.angle + top.angle) * rad * 0.22,
      S.y - Math.sin(S.angle + top.angle) * rad * 0.22,
      rad * 0.05,
      S.x, S.y, rad
    );
    g.addColorStop(0, `rgb(${cGlow.join(',')})`);
    g.addColorStop(0.52, `rgb(${cMain.join(',')})`);
    g.addColorStop(1, `rgb(${cEdge.join(',')})`);
    ctx.fillStyle = g;
    ctx.fill();

    // Inner dark glass vignette & bevel rim just inside the lead came
    ctx.strokeStyle = `rgba(0, 0, 0, 0.38)`;
    ctx.lineWidth = leadWidth * 1.55;
    ctx.stroke();

    // Bold dark lead came solder line separating the glass panes
    ctx.strokeStyle = '#0d0e14';
    ctx.lineWidth = leadWidth;
    ctx.stroke();

    // Subtle metallic sheen along the center of the lead came
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(0.5, leadWidth * 0.22);
    ctx.stroke();
  }
  ctx.restore();
}

return { renderCanvas, renderedBackground, drawRadar, setupHiDPICanvas };
}
// the four entry points the other scripts call (window properties, exactly as the former top-level functions were)
var { renderCanvas, renderedBackground, drawRadar, setupHiDPICanvas } = RendererFactory();
