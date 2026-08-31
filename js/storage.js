if(localStorage.getItem('fluidStudioV5')) { try { comparison = JSON.parse(localStorage.getItem('fluidStudioV5')); renderCompare(); } catch(e){} }

window.showHighRes = async (idx) => {
    const h = comparison[idx];
    if (h.data) { openLightbox(h.data); return; }
    
    status.textContent = "Loading HD preview...";
    const tempCanvas = document.createElement('canvas');
    await renderCanvas(h.params, tempCanvas, h.w, h.h, 0);
    h.data = tempCanvas.toDataURL('image/png', 1.0); 
    status.textContent = dict[currentLang].statusDone;
    openLightbox(h.data);
};

$('saveCompare').onclick=()=>{
  if(!currentOutput) return;
  if(currentSaved || (comparison.length > 0 && comparison[comparison.length - 1].name === currentOutput.name && comparison[comparison.length - 1].params.seed === currentOutput.params.seed)){ 
      status.textContent='Already saved to board!'; return; 
  }
  comparison.push({...currentOutput}); currentSaved = true; renderCompare(); status.textContent='Saved to Board.';
}
$('clearCompare').onclick=()=>{ if(confirm('Clear all board?')) { comparison=[]; localStorage.removeItem('fluidStudioV5'); renderCompare(); } }
window.removeHero = (index) => { comparison.splice(index, 1); renderCompare(); }

function renderCompare(){
 const wrap=$('compareWrapper'), btnComposite=$('makeComposite');
 try { const safeData = comparison.map(c => ({name: c.name, thumb: c.thumb, params: c.params, metrics: c.metrics, w: c.w, h: c.h})); localStorage.setItem('fluidStudioV5', JSON.stringify(safeData)); } catch(e) {}
 
 if(!comparison.length){ wrap.innerHTML=`<div class="muted">${dict[currentLang].t_empty_board}</div>`; btnComposite.classList.add('hidden'); return; }
 if(comparison.length >= 2 && comparison.length <= 8) btnComposite.classList.remove('hidden'); else btnComposite.classList.add('hidden');
 
 const sortedDiv = [...comparison].sort((a,b)=>b.metrics.diversity - a.metrics.diversity).slice(0, 3);
 const sortedCol = [...comparison].sort((a,b)=>b.metrics.colorfulness - a.metrics.colorfulness).slice(0, 3);
 const sortedMon = [...comparison].sort((a,b)=>b.metrics.monochromatic - a.metrics.monochromatic).slice(0, 3);
 const sortedWar = [...comparison].sort((a,b)=>b.metrics.warm - a.metrics.warm).slice(0, 3);
 
 let html = '<div class="grid-4">';
 html += `<div class="rank-box"><h4 style="color:#7c5cff">🌈 Top ${dict[currentLang].m_div}</h4>`;
 sortedDiv.forEach((h, i) => { html += `<div class="rank-item"><b>#${i+1}</b> <img src="${h.thumb}"> <div style="flex-grow:1; font-size:13px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${h.name}</div> <b style="font-size:14px">${h.metrics.diversity.toFixed(1)}%</b></div>`; }); html += '</div>';

 html += `<div class="rank-box"><h4 style="color:#ffd700">✨ Top ${dict[currentLang].m_col}</h4>`;
 sortedCol.forEach((h, i) => { html += `<div class="rank-item"><b>#${i+1}</b> <img src="${h.thumb}"> <div style="flex-grow:1; font-size:13px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${h.name}</div> <b style="font-size:14px">${h.metrics.colorfulness.toFixed(1)}%</b></div>`; }); html += '</div>';

 html += `<div class="rank-box"><h4 style="color:#62d3a2">🎯 Top ${dict[currentLang].m_mon}</h4>`;
 sortedMon.forEach((h, i) => { html += `<div class="rank-item"><b>#${i+1}</b> <img src="${h.thumb}"> <div style="flex-grow:1; font-size:13px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${h.name}</div> <b style="font-size:14px">${h.metrics.monochromatic.toFixed(1)}%</b></div>`; }); html += '</div>';

 html += `<div class="rank-box"><h4 style="color:#ff7a45">🔥 Top ${dict[currentLang].m_war}</h4>`;
 sortedWar.forEach((h, i) => { html += `<div class="rank-item"><b>#${i+1}</b> <img src="${h.thumb}"> <div style="flex-grow:1; font-size:13px; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${h.name}</div> <b style="font-size:14px">${h.metrics.warm.toFixed(1)}%</b></div>`; }); html += '</div></div>';

 html += '<div class="compareList">';
 html += comparison.map((h, i)=>`
 <div class="heroCard">
   <button class="del-btn" onclick="removeHero(${i})">✕</button>
   <div class="img-container">
     <img src="${h.thumb}" style="width:100%; height:100%; object-fit:cover; border-radius:9px;">
     <button class="img-zoom-btn" onclick="showHighRes(${i})" title="Zoom HD">🔍</button>
   </div>
   <div style="flex-grow:1; min-width:0;">
     <strong style="font-size:15px">${h.name}</strong>
     <div class="small">
       🌈 ${dict[currentLang].m_div}: <b style="color:#7c5cff">${h.metrics.diversity.toFixed(1)}%</b><br>
       ✨ ${dict[currentLang].m_col}: <b style="color:#ffd700">${h.metrics.colorfulness.toFixed(1)}%</b><br>
       🎯 ${dict[currentLang].m_mon}: <b style="color:#62d3a2">${h.metrics.monochromatic.toFixed(1)}%</b><br>
       🔥 ${dict[currentLang].m_war}: <b style="color:#ff7a45">${h.metrics.warm.toFixed(1)}%</b><br>
       ☀️ ${dict[currentLang].m_bri}: <b style="color:#fff">${h.metrics.brightness.toFixed(1)}%</b>
     </div>
   </div>
 </div>`).join('');
 html += '</div>'; wrap.innerHTML = html;
}

$('makeComposite').onclick = async () => {
    try {
        const n = comparison.length; 
        if(n < 2 || n > 8) return;
        
        status.textContent = "Rendering Composite Board...";
        const baseW = 1024, baseH = 1024, gap = 8, cols = 2, rows = Math.ceil(n / 2);
        const canvas = document.createElement('canvas'); 
        canvas.width = cols * baseW + gap; 
        canvas.height = rows * baseH + (rows - 1) * gap;
        const ctx = canvas.getContext('2d'); 
        
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); 
        ctx.fillStyle = '#000000';
        const fullRows = Math.floor(n / 2); 
        if (fullRows > 0) ctx.fillRect(baseW, 0, gap, fullRows * baseH + (fullRows - 1) * gap);
        for (let r = 1; r < rows; r++) ctx.fillRect(0, r * baseH + (r - 1) * gap, canvas.width, gap);
        
        for (let i = 0; i < n; i++) {
            let row = Math.floor(i / 2), col = i % 2, isLastOdd = (n % 2 !== 0 && i === n - 1);
            let px = isLastOdd ? (baseW + gap) / 2 : col * (baseW + gap), py = row * (baseH + gap);
            let tempCanvas = document.createElement('canvas'); 
            await renderCanvas(comparison[i].params, tempCanvas, baseW, baseH, 0); 
            ctx.drawImage(tempCanvas, px, py, baseW, baseH);
        }
        
        status.textContent = dict[currentLang].statusDone; 
        $('compositePreview').src = canvas.toDataURL('image/jpeg', 0.9); 
        $('compositeModal').classList.remove('hidden');
        
        $('downloadComposite').onclick = () => { 
            const a = document.createElement('a'); 
            a.download = `Composite_${n}_Objects.png`; 
            a.href = canvas.toDataURL('image/png', 1.0); 
            a.click(); 
        };
    } catch(err) { console.error("Composite Error:", err); alert("Failed to render composite: " + err.message); }
};