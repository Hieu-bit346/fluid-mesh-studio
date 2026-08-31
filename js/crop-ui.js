let currentCropIdx = 0, cropCx = 0, cropCy = 0, cropR = 0, cropCurrentImg = null, isDraggingCrop = false;
const cc = $('cropCanvas');
function openCropModal(idx) {
    currentCropIdx = idx; $('cropIdx').textContent = idx + 1; $('cropTotal').textContent = files.length;
    const u = URL.createObjectURL(files[idx]); cropCurrentImg = new Image();
    cropCurrentImg.onload = () => {
        URL.revokeObjectURL(u);
        const maxW = Math.min(window.innerWidth * 0.85, 460), scale = maxW / cropCurrentImg.width;
        cc.width = maxW; cc.height = cropCurrentImg.height * scale;
        if (cropNormList[idx]) {
            cropCx = cropNormList[idx].x * cc.width; cropCy = cropNormList[idx].y * cc.height; cropR = cropNormList[idx].r * Math.min(cc.width, cc.height);
            $('cropZoomSlider').value = cropNormList[idx].r;
        } else { cropCx = cc.width / 2; cropCy = cc.height / 2; cropR = Math.min(cc.width, cc.height) * 0.28; $('cropZoomSlider').value = 0.28; }
        drawCropUI(); $('manualCropModal').classList.remove('hidden');
    };
    cropCurrentImg.src = u;
}
function drawCropUI() {
    const ctx = cc.getContext('2d'); ctx.clearRect(0,0,cc.width,cc.height); ctx.drawImage(cropCurrentImg, 0, 0, cc.width, cc.height);
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0,0,cc.width,cc.height);
    ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cropCx, cropCy, cropR, 0, Math.PI*2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over'; ctx.beginPath(); ctx.arc(cropCx, cropCy, cropR, 0, Math.PI*2); ctx.strokeStyle = '#ff5c77'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cropCx - 10, cropCy); ctx.lineTo(cropCx + 10, cropCy); ctx.moveTo(cropCx, cropCy - 10); ctx.lineTo(cropCx, cropCy + 10); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}
function getEventPos(e) { const rect = cc.getBoundingClientRect(), clientX = e.touches ? e.touches[0].clientX : e.clientX, clientY = e.touches ? e.touches[0].clientY : e.clientY; return { x: (clientX - rect.left) * (cc.width / rect.width), y: (clientY - rect.top) * (cc.height / rect.height) }; }
cc.addEventListener('mousedown', (e) => { e.preventDefault(); isDraggingCrop = true; });
cc.addEventListener('mousemove', (e) => { if(!isDraggingCrop) return; e.preventDefault(); const pos = getEventPos(e); cropCx = Math.max(cropR, Math.min(cc.width - cropR, pos.x)); cropCy = Math.max(cropR, Math.min(cc.height - cropR, pos.y)); drawCropUI(); });
window.addEventListener('mouseup', () => { isDraggingCrop = false; });
cc.addEventListener('touchstart', (e) => { isDraggingCrop = true; }, {passive:false});
cc.addEventListener('touchmove', (e) => { if(!isDraggingCrop) return; e.preventDefault(); const pos = getEventPos(e); cropCx = Math.max(cropR, Math.min(cc.width - cropR, pos.x)); cropCy = Math.max(cropR, Math.min(cc.height - cropR, pos.y)); drawCropUI(); }, {passive:false});
window.addEventListener('touchend', () => { isDraggingCrop = false; });
$('cropZoomSlider').addEventListener('input', (e) => {
    cropR = Math.min(cc.width, cc.height) * parseFloat(e.target.value);
    cropCx = Math.max(cropR, Math.min(cc.width - cropR, cropCx)); cropCy = Math.max(cropR, Math.min(cc.height - cropR, cropCy)); drawCropUI();
});
$('btnCropNext').onclick = () => { cropNormList[currentCropIdx] = { x: cropCx / cc.width, y: cropCy / cc.height, r: cropR / Math.min(cc.width, cc.height) }; if (currentCropIdx < files.length - 1) openCropModal(currentCropIdx + 1); else { $('manualCropModal').classList.add('hidden'); generateProcess(); } };
$('btnCropApplyAll').onclick = () => { const norm = { x: cropCx / cc.width, y: cropCy / cc.height, r: cropR / Math.min(cc.width, cc.height) }; for(let i=0; i<files.length; i++) cropNormList[i] = norm; $('manualCropModal').classList.add('hidden'); generateProcess(); };
$('btnCropCancel').onclick = () => { $('manualCropModal').classList.add('hidden'); $('go').disabled = false; status.textContent = 'Cancelled.'; }

function extractCrop(img,mode,ctx,size, fileIdx){
 const sw=img.width,sh=img.height; ctx.clearRect(0,0,size,size);
 if (mode === 'manual' && cropNormList[fileIdx]) {
     const norm = cropNormList[fileIdx], cx = sw * norm.x, cy = sh * norm.y, r = Math.min(sw, sh) * norm.r, sx = cx - r, sy = cy - r, sSide = r * 2;
     ctx.drawImage(img, sx, sy, sSide, sSide, 0, 0, size, size);
 } else {
     let sx=0,sy=0,cw=sw,ch=sh;
     if(mode!=='full'){ const factor = mode==='center'?0.72:0.52; cw=sw*factor;ch=sh*factor;sx=(sw-cw)/2;sy=(sh-ch)/2; }
     const scale=Math.max(size/cw,size/ch),dw=cw*scale,dh=ch*scale; ctx.drawImage(img,sx,sy,cw,ch,(size-dw)/2,(size-dh)/2,dw,dh);
 }
}