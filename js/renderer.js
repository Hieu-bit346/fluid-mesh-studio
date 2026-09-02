function drawRadar(ctxObj, metricsObj, customRadius = null) {
    const W = ctxObj.canvas.width, H = ctxObj.canvas.height, cx = W/2, cy = H/2;
    const r = customRadius || (Math.min(W,H) / 2 - 62); 
    
    ctxObj.clearRect(0, 0, W, H);
    ctxObj.strokeStyle = '#363c49'; ctxObj.lineWidth = 1;
    for(let level=1; level<=4; level++) { 
        ctxObj.beginPath(); 
        for(let i=0; i<5; i++) { 
            const a = (Math.PI*2 * i)/5 - Math.PI/2, x = cx + Math.cos(a) * (r * level/4), y = cy + Math.sin(a) * (r * level/4); 
            if(i===0) ctxObj.moveTo(x,y); else ctxObj.lineTo(x,y); 
        } 
        ctxObj.closePath(); ctxObj.stroke(); 
    }
    
    const icons = ['🌈', '✨', '🎯', '🔥', '☀️'];
    const vals = [metricsObj.diversity, metricsObj.colorfulness, metricsObj.monochromatic, metricsObj.warm, metricsObj.brightness];
    
    ctxObj.fillStyle = '#fff'; ctxObj.font = 'bold 12px system-ui, sans-serif'; ctxObj.textBaseline = 'middle';
    for(let i=0; i<5; i++) { 
        const a = (Math.PI*2 * i)/5 - Math.PI/2; 
        ctxObj.beginPath(); ctxObj.moveTo(cx, cy); ctxObj.lineTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r); ctxObj.stroke(); 
        
        const labelDist = r + 16;
        const lx = cx + Math.cos(a)*labelDist, ly = cy + Math.sin(a)*labelDist;
        const txt = `${icons[i]} ${vals[i].toFixed(0)}%`;
        
        if (Math.abs(Math.cos(a)) < 0.1) {
            ctxObj.textAlign = 'center'; ctxObj.fillText(txt, cx, ly + (Math.sin(a) > 0 ? 8 : -8));
        } else if (Math.cos(a) > 0) {
            ctxObj.textAlign = 'left'; ctxObj.fillText(txt, lx, ly);
        } else {
            ctxObj.textAlign = 'right'; ctxObj.fillText(txt, lx, ly);
        }
    }
    
    ctxObj.beginPath();
    for(let i=0; i<5; i++) { 
        const a = (Math.PI*2 * i)/5 - Math.PI/2, valR = r * (vals[i]/100), x = cx + Math.cos(a) * valR, y = cy + Math.sin(a) * valR; 
        if(i===0) ctxObj.moveTo(x,y); else ctxObj.lineTo(x,y); 
    }
    ctxObj.closePath(); ctxObj.fillStyle = 'rgba(255,92,119,0.35)'; ctxObj.fill(); ctxObj.strokeStyle = '#ff5c77'; ctxObj.lineWidth = 2.5; ctxObj.stroke();
}

async function renderCanvas(params, targetCanvas, w, h, timeOffset = 0) {
    const ctx = targetCanvas.getContext('2d'); 
    targetCanvas.width = w; 
    targetCanvas.height = h;
    const diag = Math.sqrt(w*w + h*h) * 1.5;
    
    if (params.style === 'aurora') ctx.fillStyle = '#0a0a14'; 
    else ctx.fillStyle = hex(params.avgBg);
    
    ctx.fillRect(0, 0, w, h);
    if (params.style === 'aurora') ctx.globalCompositeOperation = 'screen'; 
    else ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < params.waveCount; i++) {
        const layer = params.layers[i];
        ctx.save(); 
        ctx.translate(w/2, h/2); 
        ctx.rotate(layer.angle); 
        ctx.translate(-diag/2, -diag/2);
        ctx.beginPath(); 
        ctx.moveTo(0, diag); 
        ctx.lineTo(0, layer.yOffset);
        
        if (params.style === 'polygon') {
            for (let j = 0; j <= 6; j++) { 
                ctx.lineTo(layer.pts[j].x, layer.pts[j].y + Math.sin(timeOffset + layer.pts[j].phase)*35); 
            }
            ctx.lineTo(diag, layer.yOffset);
        } else {
            const tempPts = layer.pts.map(p => ({x: p.x, y: p.y + Math.sin(timeOffset + p.phase)*35}));
            for (let j = 0; j < tempPts.length - 1; j++) {
                const mx = (tempPts[j].x + tempPts[j+1].x) / 2, my = (tempPts[j].y + tempPts[j+1].y) / 2;
                ctx.quadraticCurveTo(tempPts[j].x, tempPts[j].y, mx, my);
            }
            ctx.lineTo(diag, layer.yOffset);
        }
        ctx.lineTo(diag, diag); 
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, layer.yOffset - diag*0.2, 0, layer.yOffset + diag*0.4);
        if (params.style === 'aurora') {
            grad.addColorStop(0, `rgba(${layer.color[0]}, ${layer.color[1]}, ${layer.color[2]}, 1)`); 
            grad.addColorStop(1, `rgba(${layer.nextColor[0]}, ${layer.nextColor[1]}, ${layer.nextColor[2]}, 0)`);
        } else {
            grad.addColorStop(0, `rgb(${layer.color.join(',')})`); 
            grad.addColorStop(1, `rgb(${layer.nextColor.join(',')})`);
        }

        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.shadowColor = 'transparent';
        ctx.globalAlpha = 1.0;
        
        const solidColor = `rgb(${layer.color.join(',')})`;
        
        // PAPER CUT
        if (params.style === 'paper') {
            ctx.fillStyle = solidColor; 
            if (params.soft > 0) { 
                ctx.shadowColor = `rgba(15, 23, 42, ${0.4 + params.soft * 0.4})`; 
                ctx.shadowBlur = diag * 0.015 * params.soft; 
                const shadowDist = diag * 0.025 * params.soft;
                const angleRad = (params.paperAngle || 45) * (Math.PI / 180);
                ctx.shadowOffsetX = shadowDist * Math.cos(angleRad);
                ctx.shadowOffsetY = shadowDist * Math.sin(angleRad); 
            }
            ctx.fill();

        // POLYGON
        } else if (params.style === 'polygon') {
            if (params.polyMode !== 'flat') {
                ctx.globalAlpha = 0.88; 
            }

            const polyGrad = ctx.createLinearGradient(0, layer.yOffset, diag * 0.6, layer.yOffset + diag * 0.4);
            polyGrad.addColorStop(0, `rgb(${layer.color.join(',')})`);
            polyGrad.addColorStop(1, `rgb(${layer.nextColor.join(',')})`);
            
            ctx.fillStyle = polyGrad;
            ctx.fill();

            ctx.save();
            for (let j = 0; j < 6; j++) {
                const p1 = layer.pts[j];
                const p2 = layer.pts[j + 1];
                
                const x1 = p1.x;
                const y1 = p1.y + Math.sin(timeOffset + p1.phase) * 35;
                const x2 = p2.x;
                const y2 = p2.y + Math.sin(timeOffset + p2.phase) * 35;

                let hasTriangle = false;
                if (params.polyMode === 'hybrid') {
                    hasTriangle = Math.abs(Math.sin(i * 19.17 + j * 11.31 + (p1.phase || 0))) > 0.45;
                } else if (params.polyMode === 'faceted') {
                    hasTriangle = true;
                }

                if (hasTriangle) {
                    const midX = (x1 + x2) / 2;
                    const midY = (y1 + y2) / 2;
                    const peakX = midX + (y2 - y1) * 0.35;
                    const peakY = midY - (x2 - x1) * 0.35;

                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(peakX, peakY);
                    ctx.lineTo(midX, midY);
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(x2, y2);
                    ctx.lineTo(peakX, peakY);
                    ctx.lineTo(midX, midY);
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(peakX, peakY);
                    ctx.lineTo(x2, y2);
                } else {
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                }
                const darkR = Math.max(0, Math.round(layer.color[0] * 0.62));
                const darkG = Math.max(0, Math.round(layer.color[1] * 0.62));
                const darkB = Math.max(0, Math.round(layer.color[2] * 0.62));
                
                const strokeAlpha = params.soft > 0 
                    ? Math.min(0.42, 0.18 + params.soft * 0.22) 
                    : 0.15;

                ctx.lineWidth = params.soft > 0 ? 1.0 + params.soft * 0.4 : 1.0;
                ctx.strokeStyle = `rgba(${darkR}, ${darkG}, ${darkB}, ${strokeAlpha})`;
                ctx.shadowBlur = 0;
                ctx.stroke();
            }
            ctx.restore();
            
        // AURORA
        } else if (params.style === 'aurora') {
            const isGlass = params.auroraMode === 'glass';

            if (i === 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1.0;
                ctx.fillStyle = isGlass ? `rgb(${params.avgBg.join(',')})` : '#0a0a14';
                ctx.fillRect(-w, -h, w * 3, h * 3); 
                ctx.restore();
            }

            ctx.fillStyle = grad;
            ctx.globalCompositeOperation = isGlass ? 'multiply' : 'screen';
            ctx.globalAlpha = isGlass ? 0.5 : Math.max(0.25, 4.0 / params.waveCount);

            if (params.soft > 0) {
                ctx.shadowColor = solidColor;
                ctx.shadowBlur = diag * (isGlass ? 0.08 : 0.3) * params.soft; 
                ctx.shadowOffsetY = 0;
            }
            
            ctx.fill();

        // MESH GLOW (Fluid)
        } else if (params.style === 'fluid') {
            ctx.fillStyle = grad;
            ctx.globalAlpha = 0.85;
            if (params.soft > 0) {
                ctx.shadowColor = solidColor;
                ctx.shadowBlur = diag * 0.18 * params.soft;
                ctx.shadowOffsetY = 0;
            }
            ctx.fill();

        // CRYSTAL MOSAIC
        } else if (params.style === 'crystal') {
            let localSeed = params.seed + i;
            const rand = () => { localSeed = (localSeed * 16807) % 2147483647; return (localSeed - 1) / 2147483646; };

            const isChaotic = params.crystalMode === 'chaotic';
            const jitterFactor = isChaotic ? 0.95 : 0.42;

            const cols = Math.max(4, Math.floor(params.waveCount * 0.45)); 
            const rows = Math.max(4, Math.floor(cols * (h / w)));
            const cellW = w / cols;
            const cellH = h / rows;
            
            let pts = [];
            for (let c = 0; c <= cols + 2; c++) {
                pts[c] = [];
                for (let r = 0; r <= rows + 2; r++) {
                    const jitterX = (rand() - 0.5) * cellW * jitterFactor;
                    const jitterY = (rand() - 0.5) * cellH * jitterFactor;
                    
                    let px = (c - 1) * cellW + jitterX;
                    let py = (r - 1) * cellH + jitterY;
                    
                    px += Math.sin(timeOffset + c * 0.5) * (15 * (params.soft > 0 ? 1 : 0.2));
                    py += Math.cos(timeOffset + r * 0.5) * (15 * (params.soft > 0 ? 1 : 0.2));
                    
                    pts[c][r] = { x: px, y: py };
                }
            }

            ctx.save();
            ctx.translate(-w/2 + diag/2, -h/2 + diag/2); 

            for (let c = 0; c < cols + 1; c++) {
                for (let r = 0; r < rows + 1; r++) {
                    const p1 = pts[c][r];
                    const p2 = pts[c+1][r];
                    const p3 = pts[c][r+1];
                    const p4 = pts[c+1][r+1];

                   let color;
                        if (isChaotic) {
                            // Chaos
                            color = params.palette[Math.floor(rand() * params.palette.length)];
                        } else {
                            // Cleanr
                            const triCx = (ta.x + tb.x + tc.x) / (3 * w);
                            const triCy = (ta.y + tb.y + tc.y) / (3 * h);
                            
                            // Create a gradient axis from the top-left corner to the bottom-right corner.
                            const tNorm = Math.min(0.999, Math.max(0, (triCx + triCy) / 2));
                            
                            // Find the two closest colors in the palette to mix.
                            const exactPos = tNorm * (params.palette.length - 1);
                            const idx1 = Math.floor(exactPos);
                            const idx2 = Math.min(idx1 + 1, params.palette.length - 1);
                            const blend = exactPos - idx1; // Mixing ratio 0.0 -> 1.0
                            
                            const c1 = params.palette[idx1];
                            const c2 = params.palette[idx2];
                            
                            // Mix 2 RGB colors
                            color = [
                                c1[0] * (1 - blend) + c2[0] * blend,
                                c1[1] * (1 - blend) + c2[1] * blend,
                                c1[2] * (1 - blend) + c2[2] * blend
                            ];
                        }
                        
                        // Light and dark deviation (Light harmonic deviation 12%, Strong chaotic deviation 30%)
                        const spread = isChaotic ? 0.3 : 0.12;
                        const lightOffset = (rand() - 0.5) * spread; 
                        const rc = Math.min(255, Math.max(0, color[0] * (1 + lightOffset)));
                        const gc = Math.min(255, Math.max(0, color[1] * (1 + lightOffset)));
                        const bc = Math.min(255, Math.max(0, color[2] * (1 + lightOffset)));
                        
                        const fillStyle = `rgb(${rc},${gc},${bc})`;
                        ctx.fillStyle = fillStyle;
                        ctx.fill();

                        ctx.lineWidth = 1;
                        ctx.strokeStyle = fillStyle;
                        ctx.stroke();
                    };

                    if (rand() > 0.5) {
                        drawTri(p1, p2, p4);
                        drawTri(p1, p4, p3);
                    } else {
                        drawTri(p1, p2, p3);
                        drawTri(p2, p4, p3);
                    }
                }
            }
            ctx.restore();
        }
        
        ctx.restore();
        if (timeOffset === 0 && i % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
    
    ctx.globalCompositeOperation = 'source-over'; 
    ctx.globalAlpha = 1.0;
    if (params.grain > 0) {
        if (!params.noiseC) {
            params.noiseC = document.createElement('canvas'); 
            params.noiseC.width = 256; 
            params.noiseC.height = 256;
            const nctx = params.noiseC.getContext('2d'), imgData = nctx.createImageData(256, 256);
            for(let i=0; i<imgData.data.length; i+=4) { 
                const val = Math.random() * 255; 
                imgData.data[i] = val; 
                imgData.data[i+1] = val; 
                imgData.data[i+2] = val; 
                imgData.data[i+3] = params.grain * 255; 
            }
            nctx.putImageData(imgData, 0, 0);
        }
        ctx.globalCompositeOperation = 'overlay'; 
        ctx.fillStyle = ctx.createPattern(params.noiseC, 'repeat'); 
        ctx.fillRect(0, 0, w, h); 
        ctx.globalCompositeOperation = 'source-over';
    }
}
