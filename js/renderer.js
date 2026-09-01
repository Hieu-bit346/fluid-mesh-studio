function drawRadar(ctxObj, metricsObj, customRadius = null) {
    const W = ctxObj.canvas.width, H = ctxObj.canvas.height, cx = W/2, cy = H/2;
    const r = customRadius || (Math.min(W,H) / 2 - 62); 
    
    ctxObj.clearRect(0,0,W,H);
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
    const ctx = targetCanvas.getContext('2d'); targetCanvas.width = w; targetCanvas.height = h;
    const diag = Math.sqrt(w*w + h*h) * 1.5;
    
    if(params.style === 'aurora') ctx.fillStyle = '#0a0a14'; else ctx.fillStyle = hex(params.avgBg);
    ctx.fillRect(0, 0, w, h);
    if(params.style === 'aurora') ctx.globalCompositeOperation = 'screen'; else ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < params.waveCount; i++) {
        const layer = params.layers[i];
        ctx.save(); ctx.translate(w/2, h/2); ctx.rotate(layer.angle); ctx.translate(-diag/2, -diag/2);
        ctx.beginPath(); ctx.moveTo(0, diag); ctx.lineTo(0, layer.yOffset);
        
        if (params.style === 'polygon') {
            for (let j = 0; j <= 6; j++) { ctx.lineTo(layer.pts[j].x, layer.pts[j].y + Math.sin(timeOffset + layer.pts[j].phase)*35); }
            ctx.lineTo(diag, layer.yOffset);
        } else {
            const tempPts = layer.pts.map(p => ({x: p.x, y: p.y + Math.sin(timeOffset + p.phase)*35}));
            for (let j = 0; j < tempPts.length - 1; j++) {
                const mx = (tempPts[j].x + tempPts[j+1].x) / 2, my = (tempPts[j].y + tempPts[j+1].y) / 2;
                ctx.quadraticCurveTo(tempPts[j].x, tempPts[j].y, mx, my);
            }
            ctx.lineTo(diag, layer.yOffset);
        }
        ctx.lineTo(diag, diag); ctx.closePath();

        // ... (phần trên giữ nguyên)
        ctx.lineTo(diag, diag); ctx.closePath();

        const grad = ctx.createLinearGradient(0, layer.yOffset - diag*0.2, 0, layer.yOffset + diag*0.4);
        if (params.style === 'aurora') {
            grad.addColorStop(0, `rgba(${layer.color[0]}, ${layer.color[1]}, ${layer.color[2]}, 1)`); 
            grad.addColorStop(1, `rgba(${layer.nextColor[0]}, ${layer.nextColor[1]}, ${layer.nextColor[2]}, 0)`);
        } else {
            grad.addColorStop(0, `rgb(${layer.color.join(',')})`); 
            grad.addColorStop(1, `rgb(${layer.nextColor.join(',')})`);
        }

        // Reset các giá trị bóng và alpha để tránh lỗi tràn từ vòng lặp trước
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.shadowColor = 'transparent';
        ctx.globalAlpha = 1.0;
        
        const solidColor = `rgb(${layer.color.join(',')})`;
        // BRANCH OF STYLE
        if (params.style === 'paper') {
            ctx.fillStyle = solidColor; 
            if (params.soft > 0) { 
                ctx.shadowColor = `rgba(15, 23, 42, ${0.45 + params.soft*0.2})`; 
                ctx.shadowBlur = diag * 0.01 * params.soft; 
                ctx.shadowOffsetY = diag * 0.02 * params.soft; 
            }
            ctx.fill();

        } else if (params.style === 'polygon') {
            ctx.fillStyle = grad; 
            ctx.fill();
            if (params.soft > 0) {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = `rgba(255, 255, 255, ${params.soft * 0.3})`;
                ctx.stroke();
            }

        } else if (params.style === 'aurora') {
            ctx.fillStyle = grad;
            if (params.soft > 0) { 
                ctx.shadowColor = solidColor; 
                ctx.shadowBlur = diag * 0.2 * params.soft; 
                ctx.globalAlpha = Math.max(0.08, 2.5 / params.waveCount); 
            }
            ctx.fill();

        } else { 
            ctx.fillStyle = grad;
            if (params.soft > 0) { 
                ctx.shadowColor = solidColor; 
                ctx.shadowBlur = diag * 0.15 * params.soft; 
                ctx.shadowOffsetY = 0; 
            }
            ctx.fill();
        }

        ctx.restore();
        if (timeOffset === 0 && i % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
    
    // ... (Phần thêm noise hạt bên dưới giữ nguyên)
        if (timeOffset === 0 && i % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }
    
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1.0;
    if(params.grain > 0) {
        if(!params.noiseC) {
            params.noiseC = document.createElement('canvas'); params.noiseC.width = 256; params.noiseC.height = 256;
            const nctx = params.noiseC.getContext('2d'), imgData = nctx.createImageData(256, 256);
            for(let i=0; i<imgData.data.length; i+=4) { const val = Math.random() * 255; imgData.data[i] = val; imgData.data[i+1] = val; imgData.data[i+2] = val; imgData.data[i+3] = params.grain * 255; }
            nctx.putImageData(imgData, 0, 0);
        }
        ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = ctx.createPattern(params.noiseC, 'repeat'); ctx.fillRect(0, 0, w, h); ctx.globalCompositeOperation = 'source-over';
    }
}
