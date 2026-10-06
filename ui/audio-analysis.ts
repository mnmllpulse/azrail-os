const ranges=[[20,60],[60,250],[250,2000],[2000,6000],[6000,20000]] as const;
const db=(x:number)=>x>0?20*Math.log10(x):null;
export interface AudioMeasurements {
 durationSeconds:number;sampleRate:number;channels:number;peakDbFS:number|null;rmsDbFS:number|null;
 crestDb:number|null;clippedSamplePercent:number;stereoCorrelation:number|null;
 spectralCentroidHz:number|null;dominantFrequencyHz:number|null;
 bands:Array<{fromHz:number;toHz:number;analyzedToHz:number|null;energyPercent:number|null}>;
 spectrum:{fftSize:number;window:'Hann';frames:number;frequencyResolutionHz:number;sampled:boolean};note:string;
}
function fft(real:Float64Array,imag:Float64Array){
 const n=real.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];}}
 for(let size=2;size<=n;size*=2){const angle=-2*Math.PI/size,wr=Math.cos(angle),wi=Math.sin(angle);for(let start=0;start<n;start+=size){let xr=1,xi=0;for(let i=0;i<size/2;i++){const a=start+i,b=a+size/2,tr=xr*real[b]-xi*imag[b],ti=xr*imag[b]+xi*real[b];real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;const next=xr*wr-xi*wi;xi=xr*wi+xi*wr;xr=next;}}}
}
/** Full PCM level measurements; bounded, evenly distributed FFT windows.
 * Spectral powers are accumulated per channel, avoiding anti-phase cancellation. */
export async function measurePCM(channels:Float32Array[],sampleRate:number,signal?:AbortSignal):Promise<AudioMeasurements>{
 const n=channels[0]?.length??0;if(!n||channels.length>2||!channels.every(c=>c.length===n)||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000||n/sampleRate>900)throw Error('Нужно моно/стерео аудио до 15 минут, 8–192 кГц.');
 let peak=0,power=0,clipped=0,left=0,right=0,cross=0,sumL=0,sumR=0;
 for(let start=0;start<n;start+=65536){signal?.throwIfAborted();const end=Math.min(n,start+65536);for(let i=start;i<end;i++){
  for(const c of channels){const x=c[i];if(!Number.isFinite(x))throw Error('Аудио содержит недопустимые PCM-значения.');power+=x*x;peak=Math.max(peak,Math.abs(x));if(Math.abs(x)>=1)clipped++;}
  if(channels.length===2){const l=channels[0][i],r=channels[1][i];sumL+=l;sumR+=r;left+=l*l;right+=r*r;cross+=l*r;}
 }if(start%1048576===0)await new Promise<void>(resolve=>setTimeout(resolve,0));}
 const rms=Math.sqrt(power/(n*channels.length)),size=4096,frames=Math.min(128,Math.max(1,Math.floor(n/size))),spectrum=new Float64Array(size/2+1);
 for(let frame=0;frame<frames;frame++){
  signal?.throwIfAborted();const start=frames===1?0:Math.round(frame*Math.max(0,n-size)/(frames-1));
  for(const c of channels){const real=new Float64Array(size),imag=new Float64Array(size);let mean=0;const length=Math.min(size,n-start);for(let j=0;j<length;j++)mean+=c[start+j];mean/=length;
   for(let j=0;j<length;j++)real[j]=(c[start+j]-mean)*.5*(1-Math.cos(2*Math.PI*j/(size-1)));fft(real,imag);
   for(let k=1;k<=size/2;k++)spectrum[k]+=(real[k]**2+imag[k]**2)*(k===size/2?1:2);
  }
  if(frame%8===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
 }
 let total=0,weighted=0,max=0,dominant=0;const energy=ranges.map(()=>0),step=sampleRate/size,ceiling=Math.min(20000,sampleRate/2);
 for(let k=1;k<spectrum.length;k++){const hz=k*step;if(hz<20||hz>ceiling)continue;const value=spectrum[k];total+=value;weighted+=value*hz;if(value>max){max=value;dominant=hz;}const band=ranges.findIndex(([from,to])=>hz>=from&&(hz<to||hz===ceiling&&hz===to));if(band>=0)energy[band]+=value;}
 const covariance=cross-sumL*sumR/n,varianceL=Math.max(0,left-sumL**2/n),varianceR=Math.max(0,right-sumR**2/n);
 return {durationSeconds:n/sampleRate,sampleRate,channels:channels.length,peakDbFS:db(peak),rmsDbFS:db(rms),crestDb:peak&&rms?20*Math.log10(peak/rms):null,clippedSamplePercent:clipped/(n*channels.length)*100,stereoCorrelation:channels.length===2&&varianceL*varianceR>0?Math.max(-1,Math.min(1,covariance/Math.sqrt(varianceL*varianceR))):null,spectralCentroidHz:total>1e-18?weighted/total:null,dominantFrequencyHz:total>1e-18?dominant:null,bands:ranges.map(([from,to],i)=>({fromHz:from,toHz:to,analyzedToHz:from<ceiling?Math.min(to,ceiling):null,energyPercent:from>=ceiling||total<=1e-18?null:energy[i]/total*100})),spectrum:{fftSize:size,window:'Hann',frames,frequencyResolutionHz:step,sampled:frames*size<n},note:'Уровни измерены по декодированному PCM. Спектр: до 128 распределённых окон Hann, энергия 20 Гц–20 кГц в пределах Nyquist. Это не LUFS, true peak, BPM или оценка качества мастеринга. null означает отсутствие измеримого сигнала или неприменимую метрику.'};
}
export function compareAudio(candidate:AudioMeasurements,reference:AudioMeasurements){
 const delta=(a:number|null,b:number|null)=>a===null||b===null?null:a-b;
 const compatible=candidate.bands.every((b,i)=>b.analyzedToHz===reference.bands[i].analyzedToHz);
 return {rmsDifferenceDb:delta(candidate.rmsDbFS,reference.rmsDbFS),crestDifferenceDb:delta(candidate.crestDb,reference.crestDb),centroidDifferenceHz:compatible?delta(candidate.spectralCentroidHz,reference.spectralCentroidHz):null,bandDifferencePercentagePoints:compatible?candidate.bands.map((b,i)=>({fromHz:b.fromHz,toHz:b.toHz,difference:delta(b.energyPercent,reference.bands[i].energyPercent)})):null,note:'Разница = ваш файл минус референс. Сравнение полос нормировано по энергии, без оценки похожести или качества. При разных диапазонах Nyquist спектральная разница не вычисляется.'};
}
export function renderAudioReport(host:HTMLElement,value:AudioMeasurements,reference?:AudioMeasurements){
 const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const el=document.createElement(tag);el.textContent=text;return el;};
 const number=(v:number|null,suffix='')=>v===null?'Нет данных':v.toFixed(2)+suffix;
 const table=make('table'),head=make('tr');for(const text of ['Измерение','Ваш файл',...(reference?['Референс']:[])])head.append(make('th',text));table.append(head);
 const rows:Array<[string,(m:AudioMeasurements)=>string]>=[['Длительность',m=>number(m.durationSeconds,' с')],['Пик PCM',m=>number(m.peakDbFS,' dBFS')],['RMS',m=>number(m.rmsDbFS,' dBFS')],['Крест-фактор',m=>number(m.crestDb,' dB')],['Стереокорреляция',m=>number(m.stereoCorrelation)],['Центр спектра',m=>number(m.spectralCentroidHz,' Гц')]];
 for(const [label,get]of rows){const row=make('tr');row.append(make('th',label),make('td',get(value)));if(reference)row.append(make('td',get(reference)));table.append(row);}
 for(let i=0;i<ranges.length;i++){const format=(m:AudioMeasurements)=>{const b=m.bands[i];return number(b.energyPercent,' %')+(b.analyzedToHz!==null&&b.analyzedToHz<b.toHz?` (до ${b.analyzedToHz} Гц)`:'');};const row=make('tr');row.append(make('th',`${ranges[i][0]}–${ranges[i][1]} Гц`),make('td',format(value)));if(reference)row.append(make('td',format(reference)));table.append(row);}
 host.replaceChildren(table,make('p',value.note));const full=make('details');full.append(make('summary','Полный отчёт'));const report={candidate:value,...(reference?{reference,comparison:compareAudio(value,reference)}:{})};full.append(make('pre',JSON.stringify(report,null,2)));host.append(full);
 const save=make('button','Скачать отчёт JSON');save.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=make('a');link.href=url;link.download='pulse-audio-analysis.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);};host.append(save);
}
