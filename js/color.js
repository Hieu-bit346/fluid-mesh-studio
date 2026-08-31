function load(f){return new Promise((res,rej)=>{const i=new Image(),u=URL.createObjectURL(f);i.onload=()=>{URL.revokeObjectURL(u);res(i)};i.onerror=rej;i.src=u})}
function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360}return[h,mx?d/mx:0,mx]}
function hsvToRgb(h, s, v) { let f=(n,k=(n+h/60)%6)=>v-v*s*Math.max(Math.min(k,4-k,1),0); return [Math.round(f(5)*255),Math.round(f(3)*255),Math.round(f(1)*255)]; }
function shiftColor(rgb, shift) { let [h, s, v] = hsv(...rgb); h = (h + shift) % 360; return hsvToRgb(h, s, v); }
function hex(c){return '#'+c.map(x=>Math.round(x).toString(16).padStart(2,'0')).join('')}
function colorDist(a,b){const r=a[0]-b[0],g=a[1]-b[1],bl=a[2]-b[2];return r*r+g*g+bl*bl}
function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
function diverse(colors, n, rng){
  if(colors.length<=n) return colors.slice();
  const out=[colors[Math.floor(rng()*colors.length)]];
  while(out.length<n){
    let best=null, score=-1;
    for(let k=0;k<400;k++){
      const c=colors[Math.floor(rng()*colors.length)];
      let near=Infinity; for(const x of out) near=Math.min(near,colorDist(c,x));
      if(near>score){score=near; best=c}
    }
    out.push(best);
  }
  return out;
}
function calcMetrics(colors){
 let sat=0, val=0, warm=0;const bins=new Set();const sum=[0,0,0];
 for(const c of colors){const [h,s,v]=hsv(...c);sat+=s;val+=v;sum[0]+=c[0];sum[1]+=c[1];sum[2]+=c[2];bins.add(Math.floor(h/15));if(h<70||h>=300)warm++}
 const n=colors.length, div=bins.size/24*100, col=(sat/n)*100, mono=Math.max(0,100-(div*.52+col*.48));
 return {diversity:Math.min(100, div),colorfulness:Math.min(100, col),monochromatic:Math.min(100, mono),brightness:Math.min(100, val/n*100),warm:Math.min(100, warm/n*100),dominant:sum.map(x=>Math.round(x/n))};
}
function renderMetricsText(m){
 $('metricsText').innerHTML=`
 <div class="metric">
    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>🌈 ${dict[currentLang].m_div}</span><b style="color:#7c5cff">${m.diversity.toFixed(1)}%</b></div>
    <div class="bar"><i style="width:${m.diversity}%; background:#7c5cff"></i></div>
 </div>
 <div class="metric">
    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>✨ ${dict[currentLang].m_col}</span><b style="color:#ffd700">${m.colorfulness.toFixed(1)}%</b></div>
    <div class="bar"><i style="width:${m.colorfulness}%; background:#ffd700"></i></div>
 </div>
 <div class="metric">
    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>🎯 ${dict[currentLang].m_mon}</span><b style="color:#62d3a2">${m.monochromatic.toFixed(1)}%</b></div>
    <div class="bar"><i style="width:${m.monochromatic}%; background:#62d3a2"></i></div>
 </div>
 <div class="metric">
    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>🔥 ${dict[currentLang].m_war}</span><b style="color:#ff7a45">${m.warm.toFixed(1)}%</b></div>
    <div class="bar"><i style="width:${m.warm}%; background:#ff7a45"></i></div>
 </div>
 <div class="metric">
    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>☀️ ${dict[currentLang].m_bri}</span><b style="color:#fffff">${m.brightness.toFixed(1)}%</b></div>
    <div class="bar"><i style="width:${m.brightness}%; background:#ffffff"></i></div>
 </div>`;
}
