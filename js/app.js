function setLang(l) {
    currentLang = l;
    Object.keys(dict[l]).forEach(k => {
        if($(k)) {
            if($(k).tagName === 'INPUT') $(k).placeholder = dict[l][k];
            else $(k).innerHTML = dict[l][k];
        }
    });
    if($('heroName')) $('heroName').placeholder = dict[l].t_name_ph;
    if($('status').textContent !== dict[l].statusDone && !files.length) $('status').textContent = dict[l].statusEmpty;
    if(comparison.length) renderCompare();
}
$('langBtn').onclick = () => setLang(currentLang === 'en' ? 'vi' : 'en');

[['blobs','blobVal',''],['soft','softVal','%'],['sat','satVal','%'],['grain','grainVal','%']].forEach(([a,b,s])=>$(a).addEventListener('input',()=>$(b).textContent=$(a).value+s));

if ($('paperAngle')) {
    $('paperAngle').addEventListener('input', () => $('paperAngleVal').textContent = $('paperAngle').value + '°');
}

if ($('styleMode')) {
    $('styleMode').addEventListener('change', (e) => {
        if ($('polyModeBox')) $('polyModeBox').classList.toggle('hidden', e.target.value !== 'polygon');
        if ($('paperAngleBox')) $('paperAngleBox').classList.toggle('hidden', e.target.value !== 'paper');
        if ($('crystalModeBox')) $('crystalModeBox').classList.toggle('hidden', e.target.value !== 'crystal');
        if ($('auroraModeBox')) $('auroraModeBox').classList.toggle('hidden', e.target.value !== 'aurora');
    });
}

$('size').addEventListener('change', (e) => { $('customSize').classList.toggle('hidden', e.target.value !== 'custom'); });
$('angleMode').addEventListener('change', (e) => { $('customAngle').classList.toggle('hidden', e.target.value !== 'custom'); });
$('ratio').addEventListener('change', (e) => { $('customRatioBox').classList.toggle('hidden', e.target.value !== 'custom'); });

const input=$('files'), drop=$('drop'), preview=$('preview'), status=$('status'), out=$('out'), outCtx=out.getContext('2d');
drop.onclick=()=>input.click(); input.onchange=e=>addFiles([...e.target.files]);
['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add('drag')}));
['dragleave','drop'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove('drag')}));
drop.addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));

function addFiles(arr){ files.push(...arr.filter(f=>f.type.startsWith('image/'))); cropNormList = []; renderInputPreview(); }
function renderInputPreview() {
    preview.innerHTML = '';
    files.forEach((f, idx) => {
        const wrap = document.createElement('div'); wrap.className = 'thumb-wrap';
        const img = document.createElement('img'); img.className = 'thumb'; img.src = URL.createObjectURL(f);
        const del = document.createElement('button'); del.className = 'thumb-del'; del.innerHTML = '✕';
        del.onclick = (e) => { e.stopPropagation(); files.splice(idx, 1); cropNormList.splice(idx, 1); renderInputPreview(); };
        wrap.appendChild(img); wrap.appendChild(del); preview.appendChild(wrap);
    });
    status.textContent = files.length ? `${files.length} images selected.` : dict[currentLang].statusEmpty;
    
    if ($('clear')) {
        $('clear').classList.toggle('hidden', files.length < 2);
    }
}

function copyCSS(paletteHex) {
    let css = ':root {\n'; paletteHex.forEach((h, i) => css += `  --color-${i+1}: ${h};\n`); css += '}';
    navigator.clipboard.writeText(css);
    const old = status.textContent; status.textContent = dict[currentLang].statusCopy;
    setTimeout(() => status.textContent = old, 2500);
}

$('dlPaletteBtn').onclick = () => {
    if(!currentOutput) return;
    let gplContent = "GIMP Palette\nName: " + currentOutput.name + " Color DNA\nColumns: 4\n#\n";
    currentOutput.hexColors.forEach(h => {
        const r = parseInt(h.slice(1,3), 16);
        const g = parseInt(h.slice(3,5), 16);
        const b = parseInt(h.slice(5,7), 16);
        gplContent += `${r.toString().padStart(3)} ${g.toString().padStart(3)} ${b.toString().padStart(3)} ${h}\n`;
    });
    const blob = new Blob([gplContent], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = currentOutput.name + '_palette.gpl'; a.click();
};

$('hueShift').oninput = async (e) => {
    if(!currentOutput) return;
    const shift = parseInt(e.target.value);
    $('hueVal').textContent = shift + '°';

    const p = currentOutput.params;
    const shiftedPalette = p.basePalette.map(c => shiftColor(c, shift));
    const shiftedAvgBg = shiftColor(p.baseAvgBg, shift);
    const shiftedLayers = p.baseLayers.map(l => ({ ...l, color: shiftColor(l.baseColor, shift), nextColor: shiftColor(l.baseNextColor, shift) }));

    p.palette = shiftedPalette; p.avgBg = shiftedAvgBg; p.layers = shiftedLayers;

    await renderCanvas(p, out, currentOutput.w, currentOutput.h, 0);

    const metricC = document.createElement('canvas'); metricC.width = 256; metricC.height = 256;
    metricC.getContext('2d').drawImage(out, 0, 0, 256, 256);
    const outData = metricC.getContext('2d').getImageData(0,0,256,256).data, outColors = []; 
    for(let i=0; i<outData.length; i+=4) outColors.push([outData[i], outData[i+1], outData[i+2]]);
    
    currentOutput.metrics = calcMetrics(outColors); 
    renderMetricsText(currentOutput.metrics); 
    drawRadar($('radarChart').getContext('2d'), currentOutput.metrics);
    
    currentOutput.hexColors = [...new Set(shiftedPalette.map(c => hex(c)))].slice(0, 7); 
    let paletteHTML = ''; 
    currentOutput.hexColors.forEach(c => { paletteHTML += `<div class="color-swatch" style="background:${c}" onclick="copyCSS(${JSON.stringify(currentOutput.hexColors)})">${c}</div>`; });
    $('paletteBox').innerHTML = paletteHTML;
};

$('go').onclick = async () => {
    if(!files.length){status.textContent='Please select at least 1 image.';return;}
    const crop = $('crop').value;
    if (crop === 'manual' && cropNormList.length < files.length) { openCropModal(0); return; }
    generateProcess();
};

async function generateProcess(){
    $('customAngle').classList.remove('error-border'); $('customRatioBox').style.boxShadow = ''; $('customSize').classList.remove('error-border');
    
    const styleMode=$('styleMode').value, angleMode=$('angleMode').value;
    
    let bAngle = 'random';
    if(angleMode === 'custom') {
        const val = parseInt($('customAngle').value);
        if(isNaN(val)) { $('customAngle').classList.add('error-border'); return; }
        bAngle = (val * Math.PI) / 180;
    } else if(angleMode !== 'random') bAngle = (parseInt(angleMode) * Math.PI) / 180;

    let targetW = 1024, targetH = 1024, ratioVal = 1;
    const ratioMode = $('ratio').value;
    if(ratioMode === 'custom') {
        const rw = parseFloat($('customRatioW').value), rh = parseFloat($('customRatioH').value);
        if (isNaN(rw) || isNaN(rh) || rw <= 0 || rh <= 0) { $('customRatioBox').style.boxShadow = '0 0 8px red'; return; }
        ratioVal = rw / rh;
    } else ratioVal = parseFloat(ratioMode);

    const sizeOpt = $('size').value;
    if(sizeOpt === 'custom') {
        const val = parseInt($('customSize').value);
        if(isNaN(val) || val < 500 || val > 4096) { $('customSize').classList.add('error-border'); alert("Max: 4096"); return; }
        targetW = val; targetH = val;
    } else { targetW = parseInt(sizeOpt); targetH = parseInt(sizeOpt); }
    if(ratioVal < 1) targetW = Math.round(targetH * ratioVal); else if(ratioVal > 1) targetH = Math.round(targetW / ratioVal);

    $('go').disabled = true; $('hueShift').value = 0; $('hueVal').textContent = '0°';
    
    const minSat=+$('sat').value/100, crop=$('crop').value;
    const sample=document.createElement('canvas'), sctx=sample.getContext('2d',{willReadFrequently:true}); sample.width=sample.height=280;
    let colors=[];
    
    let inputName = $('heroName').value.trim();
    let isAetheria = (currentLang === 'en' && inputName.toLowerCase() === 'aetheria');
    let isPhuongVi = (currentLang === 'vi' && inputName.toLowerCase() === 'phượng vĩ');
    let avatarFullUrl = "";
    
    if(isAetheria) { status.textContent = dict[currentLang].ee_aetheria; colors = [[0,191,255], [0,128,255], [0,255,255], [30,144,255], [64,224,208]]; } 
    else if (isPhuongVi) { status.textContent = dict[currentLang].ee_phuongvi; colors = [[255,69,0], [255,0,0], [255,140,0], [220,20,60], [178,34,34]]; } 
    else {
        for(let i=0;i<files.length;i++){
            status.textContent=`Analyzing image ${i+1}/${files.length}...`; await new Promise(r => setTimeout(r, 10)); 
            const im=await load(files[i]); extractCrop(im, crop, sctx, 280, i);
            
            if(i===0 && files.length === 1) {
                const avC = document.createElement('canvas'); const sc = Math.min(600/im.width, 600/im.height, 1);
                avC.width = im.width * sc; avC.height = im.height * sc;
                avC.getContext('2d').drawImage(im, 0, 0, avC.width, avC.height);
                avatarFullUrl = avC.toDataURL('image/jpeg', 0.9);
            }
            
            const d=sctx.getImageData(0,0,280,280).data;
            for(let p=0;p<d.length;p+=4){
                if(d[p+3]<40)continue;
                const c=[d[p],d[p+1],d[p+2]]; const [h, s, v] = hsv(...c);
                if(s >= minSat && v >= 0.2) colors.push(c);
            }
        }
    }
    
    if(!colors.length){status.textContent='Image too dark or desaturated. Lower saturate filter.'; $('go').disabled=false;return;}
    
    status.textContent=dict[currentLang].statusGen;
    const rngSeed = Math.floor(Math.random()*1000000), rng = mulberry32(rngSeed);
    const waveCount = +$('blobs').value;
    let palette = diverse(colors, waveCount, rng);
    
    if(styleMode === 'fluid' || styleMode === 'aurora' || styleMode === 'polygon' || styleMode === 'crystal') {
        palette.sort((a,b)=>hsv(...a)[0]-hsv(...b)[0]); 
    } else {
        palette.sort(() => rng() - 0.5);
    }
    
    const avgBg = colors.reduce((acc, c)=>[acc[0]+c[0], acc[1]+c[1], acc[2]+c[2]], [0,0,0]).map(v=>Math.round(v/colors.length));
    const diag = Math.sqrt(targetW*targetW + targetH*targetH) * 1.5;
    
    const layers = [];
    for(let i=0; i<waveCount; i++) {
        let angle = bAngle;
        if(bAngle === 'random') angle = (rng() - 0.5) * Math.PI * 2.5; else angle += (rng() - 0.5) * 0.4;
        let yOffset = (styleMode === 'fluid' || styleMode === 'paper' || styleMode === 'polygon') ? diag * (0.05 + (i / waveCount) * 0.8 + (rng() * 0.1)) : diag * (0.05 + rng() * 0.9);
        let pts = []; for(let j=0; j<=6; j++) pts.push({ x: diag*(j/6), y: yOffset + (rng() - 0.5) * (diag*0.45), phase: rng() * Math.PI*2 });
        layers.push({ angle, yOffset, pts, color: palette[i], nextColor: palette[(i+1)%palette.length], baseColor: palette[i], baseNextColor: palette[(i+1)%palette.length] });
    }

    const polyModeOpt = $('polyMode') ? $('polyMode').value : 'flat';
    const pAngleOpt = $('paperAngle') ? +$('paperAngle').value : 45;
    const crystalModeOpt = $('crystalMode') ? $('crystalMode').value : 'harmonic';
    const auroraModeOpt = $('auroraMode') ? $('auroraMode').value : 'glass';

    const params = { seed: rngSeed, palette, waveCount, style: styleMode, polyMode: polyModeOpt, paperAngle: pAngleOpt, crystalMode: crystalModeOpt, auroraMode: auroraModeOpt, baseAngle: bAngle, soft: +$('soft').value / 100, grain: +$('grain').value / 100, avgBg, layers, basePalette: palette, baseAvgBg: avgBg, baseLayers: layers };
    
    await renderCanvas(params, out, targetW, targetH, 0);

    const metricC = document.createElement('canvas'); metricC.width = 256; metricC.height = 256;
    metricC.getContext('2d').drawImage(out, 0, 0, 256, 256);
    const outData = metricC.getContext('2d').getImageData(0,0,256,256).data, outColors = []; 
    for(let p=0; p<outData.length; p+=4) outColors.push([outData[p], outData[p+1], outData[p+2]]);
    const m = calcMetrics(outColors); 
    
    renderMetricsText(m); drawRadar($('radarChart').getContext('2d'), m);
    let paletteHTML = ''; const uniqueHex = [...new Set(palette.map(c => hex(c)))].slice(0, 7); 
    uniqueHex.forEach(c => { paletteHTML += `<div class="color-swatch" style="background:${c}" onclick="copyCSS(${JSON.stringify(uniqueHex)})">${c}</div>`; });
    $('paletteBox').innerHTML = paletteHTML; $('paletteBox').classList.remove('hidden');

    $('resultCard').classList.remove('hidden');
    
    currentOutput = { name: inputName || `Obj ${comparison.length+1}`, thumb: metricC.toDataURL('image/jpeg', 0.8), avatar: avatarFullUrl, params: params, metrics: m, w: targetW, h: targetH, hexColors: uniqueHex };
    
    currentSaved = false; status.textContent = dict[currentLang].statusDone; $('go').disabled=false;
}

function openLightbox(src) { $('lightboxImg').src = src; $('lightboxModal').classList.remove('hidden'); }
$('viewArtBtn').onclick = () => { if(currentOutput) openLightbox(out.toDataURL('image/png', 1.0)); };
$('dlArtBtn').onclick = () => { const a=document.createElement('a'); a.download=(currentOutput?.name||'art')+'.png'; a.href=out.toDataURL('image/png', 1.0); a.click(); };

let cardTab = 'avatar';
let avX = 0, avY = 0, avScale = 1;
let covX = 0, covY = 0, covScale = 1;
let isDragging = false, startX, startY;

const avImgEl = $('avImg'), covImgEl = $('covImg');
const avBox = $('avatarBox'), covBox = $('coverBox');

avImgEl.style.imageRendering = 'pixelated';
covImgEl.style.imageRendering = 'pixelated';

$('tabAv').onclick = () => {
    cardTab = 'avatar'; $('tabAv').className = 'primary'; $('tabCov').className = 'secondary';
    avBox.style.display = 'block'; covBox.style.display = 'none'; $('studioZoom').value = avScale;
};

$('tabCov').onclick = () => {
    cardTab = 'cover'; $('tabCov').className = 'primary'; $('tabAv').className = 'secondary';
    avBox.style.display = 'none'; covBox.style.display = 'block'; $('studioZoom').value = covScale;
};

function handleStart(e) {
    e.preventDefault(); isDragging = true;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    if(cardTab === 'avatar') { startX = cx - avX; startY = cy - avY; }
    else { startX = cx - covX; startY = cy - covY; }
}

function handleMove(e) {
    if(!isDragging) return; e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    
    if(cardTab === 'avatar') {
        const avRatio = avImgEl.naturalWidth / avImgEl.naturalHeight;
        const imgW = (avRatio > 1) ? 200 * avRatio : 200;
        const imgH = (avRatio > 1) ? 200 : 200 / avRatio;
        avX = Math.min(0, Math.max(200 - (imgW * avScale), cx - startX));
        avY = Math.min(0, Math.max(200 - (imgH * avScale), cy - startY));
        avImgEl.style.transform = `translate(${avX}px, ${avY}px) scale(${avScale})`;
    } else {
        const outRatio = out.width / out.height;
        const imgW = (outRatio > 252/182) ? 182 * outRatio : 252;
        const imgH = (outRatio > 252/182) ? 182 : 252 / outRatio;
        covX = Math.min(0, Math.max(252 - (imgW * covScale), cx - startX));
        covY = Math.min(0, Math.max(182 - (imgH * covScale), cy - startY));
        covImgEl.style.transform = `translate(${covX}px, ${covY}px) scale(${covScale})`;
    }
}

function handleEnd() { isDragging = false; }

[avImgEl, covImgEl].forEach(el => {
    el.addEventListener('mousedown', handleStart);
    el.addEventListener('touchstart', handleStart, {passive:false});
});
window.addEventListener('mousemove', handleMove);
window.addEventListener('touchmove', handleMove, {passive:false});
window.addEventListener('mouseup', handleEnd);
window.addEventListener('touchend', handleEnd);

$('studioZoom').oninput = (e) => {
    const scale = parseFloat(e.target.value);
    if(cardTab === 'avatar') {
        avScale = scale;
        const avRatio = avImgEl.naturalWidth / avImgEl.naturalHeight;
        const imgW = (avRatio > 1) ? 200 * avRatio : 200;
        const imgH = (avRatio > 1) ? 200 : 200 / avRatio;
        avX = Math.min(0, Math.max(200 - (imgW * avScale), avX));
        avY = Math.min(0, Math.max(200 - (imgH * avScale), avY));
        avImgEl.style.transform = `translate(${avX}px, ${avY}px) scale(${avScale})`;
    } else {
        covScale = scale;
        const outRatio = out.width / out.height;
        const imgW = (outRatio > 252/182) ? 182 * outRatio : 252;
        const imgH = (outRatio > 252/182) ? 182 : 252 / outRatio;
        covX = Math.min(0, Math.max(252 - (imgW * covScale), covX));
        covY = Math.min(0, Math.max(182 - (imgH * covScale), covY));
        covImgEl.style.transform = `translate(${covX}px, ${covY}px) scale(${covScale})`;
    }
};

$('openCardStudioBtn').onclick = async () => {
    if(!currentOutput) return;
    if(files.length > 1) { alert("Only single image input supports Info Card!"); return; }
    
    avX = 0; avY = 0; avScale = 1;
    covX = 0; covY = 0; covScale = 1;
    
    avImgEl.src = currentOutput.avatar;
    avImgEl.onload = () => {
        const avRatio = avImgEl.naturalWidth / avImgEl.naturalHeight;
        if (avRatio > 1) { avImgEl.style.height = '200px'; avImgEl.style.width = 'auto'; }
        else { avImgEl.style.width = '200px'; avImgEl.style.height = 'auto'; }
        avImgEl.style.transform = 'translate(0px, 0px) scale(1)';
    };
    
    covImgEl.src = out.toDataURL('image/jpeg', 0.6);
    const outRatio = out.width / out.height;
    if(outRatio > (252/182)) { covImgEl.style.height = '182px'; covImgEl.style.width = 'auto'; }
    else { covImgEl.style.width = '252px'; covImgEl.style.height = 'auto'; }
    covImgEl.style.transform = 'translate(0px, 0px) scale(1)';
    
    $('tabAv').click();
    $('cardModal').classList.remove('hidden');
    $('cardPreviewImg').src = await drawCardToCanvas();
};

$('updateCardBtn').onclick = async () => { $('cardPreviewImg').src = await drawCardToCanvas(); };

$('finalDlCardBtn').onclick = async () => {
    const src = await drawCardToCanvas();
    const a=document.createElement('a'); a.download=(currentOutput.name)+'-Card.png'; a.href=src; a.click();
};

async function drawCardToCanvas() {
    const c = document.createElement('canvas'); c.width = 900; c.height = 1200; const ctx = c.getContext('2d');
    ctx.fillStyle = '#181b22'; ctx.fillRect(0,0,900,1200);
    
    // RENDER COVER (Giữ nguyên vì đang hoạt động tốt)
    const snapCov = document.createElement('canvas'); snapCov.width = 252; snapCov.height = 182;
    const sCovCtx = snapCov.getContext('2d');
    sCovCtx.save();
    sCovCtx.translate(covX, covY);
    sCovCtx.scale(covScale, covScale);
    const outRatio = out.width / out.height;
    let dW = (outRatio > 252/182) ? 182 * outRatio : 252;
    let dH = (outRatio > 252/182) ? 182 : 252 / outRatio;
    sCovCtx.drawImage(out, 0, 0, out.width, out.height, 0, 0, dW, dH);
    sCovCtx.restore();
    ctx.drawImage(snapCov, 0, 0, 252, 182, 0, 0, 900, 650);
    
    ctx.fillStyle = 'rgba(24,27,34,0.9)'; ctx.fillRect(0, 560, 900, 100);
    
    // RENDER AVATAR
    if(currentOutput.avatar) {
        const av = new Image(); av.src = currentOutput.avatar; await new Promise(r=>av.onload=r);
        
        ctx.save(); 
        ctx.beginPath(); 
        ctx.arc(450, 560, 90, 0, Math.PI*2); 
        ctx.closePath(); 
        ctx.clip();
        
        if (av.width < 200) ctx.imageSmoothingEnabled = false;

        ctx.translate(360, 470);
        
        ctx.scale(0.9, 0.9);

        ctx.translate(avX, avY);
        ctx.scale(avScale, avScale);
        
        const avRatio = av.width / av.height;
        let aW = (avRatio > 1) ? 200 * avRatio : 200;
        let aH = (avRatio > 1) ? 200 : 200 / avRatio;
        
        ctx.drawImage(av, 0, 0, aW, aH);
        
        ctx.restore();
        
        ctx.beginPath(); ctx.arc(450, 560, 90, 0, Math.PI*2); ctx.lineWidth = 6; ctx.strokeStyle = '#ff5c77'; ctx.stroke();
    }
    
    ctx.fillStyle = '#fff'; ctx.font = 'bold 38px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(currentOutput.name, 450, 695);
    ctx.fillStyle = '#a9b0bc'; ctx.font = '20px sans-serif'; ctx.fillText('Color DNA Signature', 450, 730);
    
    const radarC = document.createElement('canvas'); radarC.width = 400; radarC.height = 400;
    drawRadar(radarC.getContext('2d'), currentOutput.metrics, 120); 
    ctx.drawImage(radarC, 20, 770, 400, 400);
    
    ctx.textAlign = 'left'; const m = currentOutput.metrics;
    const labels = [`🌈 ${dict[currentLang].m_div}`, `✨ ${dict[currentLang].m_col}`, `🎯 ${dict[currentLang].m_mon}`, `🔥 ${dict[currentLang].m_war}`, `☀️ ${dict[currentLang].m_bri}`];
    const vals = [m.diversity, m.colorfulness, m.monochromatic, m.warm, m.brightness];
    const colors = ['#7c5cff', '#ffd700', '#62d3a2', '#ff7a45', '#ffffff'];
    for(let i=0; i<5; i++) {
        const y = 800 + i*40;
        ctx.fillStyle = '#a9b0bc'; ctx.font = '15px sans-serif'; ctx.fillText(labels[i], 450, y);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(vals[i].toFixed(1) + '%', 790, y);
        ctx.fillStyle = '#363c49'; ctx.beginPath(); ctx.roundRect(450, y+8, 380, 6, 3); ctx.fill();
        ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.roundRect(450, y+8, 380 * (vals[i]/100), 6, 3); ctx.fill();
    }
    
    const hexs = currentOutput.hexColors.slice(0,6);
    hexs.forEach((hx, i) => {
        const px = 450 + (i%3)*130, py = 1040 + Math.floor(i/3)*65;
        ctx.fillStyle = hx; ctx.beginPath(); ctx.roundRect(px, py, 110, 40, 6); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(hx.toUpperCase(), px + 55, py + 25);
    });
    return c.toDataURL('image/png');
} 

let animReq;
$('viewAnimBtn').onclick = () => {
    if(!currentOutput) return; $('animModal').classList.remove('hidden');
    const ac = $('animCanvas'); let time = 0;
    const loop = () => { renderCanvas(currentOutput.params, ac, 800, 800, time); time += 0.05; animReq = requestAnimationFrame(loop); }; loop();
};
function closeAnimModal() { $('animModal').classList.add('hidden'); cancelAnimationFrame(animReq); }
$('dlAnimBtn').onclick = async () => {
    if(!currentOutput) return; status.textContent = "Recording WebM (3s)...";
    const vC = document.createElement('canvas'); vC.width = 800; vC.height = 800;
    const stream = vC.captureStream(30); const rec = new MediaRecorder(stream, {mimeType: 'video/webm'});
    const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
        const blob = new Blob(chunks, {type: 'video/webm'}); const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = currentOutput.name + '.webm'; a.click(); status.textContent = dict[currentLang].statusDone;
    };
    rec.start(); let time = 0; const tId = setInterval(() => { renderCanvas(currentOutput.params, vC, 800, 800, time); time += 0.05; }, 1000/30);
    setTimeout(() => { clearInterval(tId); rec.stop(); }, 3000);
};

$('clear').onclick=()=>{ files=[]; cropNormList=[]; renderInputPreview(); $('resultCard').classList.add('hidden'); };

setLang('en');
