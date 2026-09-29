'use strict';
(()=>{
const $=id=>document.getElementById(id);
const cached=k=>{try{return sessionStorage.getItem(k)||''}catch{return ''}};
const token=cached('azrail_ultimate_token');
const project=cached('azrail_pulse_project');
const mode=cached('azrail_pulse_mode')||'auto';

function safeJson(value,fallback=null){try{return JSON.parse(value)}catch{return fallback}}
function usd(micro){const n=Number(micro);return Number.isFinite(n)?'$'+(n/1e6).toFixed(4):'—'}
function scalar(v){
  if(v===null||v===undefined)return '—';
  if(typeof v==='boolean')return v?'YES':'NO';
  if(typeof v==='string'||typeof v==='number')return String(v);
  return JSON.stringify(v);
}
function row(root,key,value){
  const el=document.createElement('div');el.className='kv';
  const k=document.createElement('b');k.textContent=key;
  const v=document.createElement('span');v.textContent=scalar(value);
  el.append(k,v);root.append(el);
}
function clear(id){const root=$(id);root.replaceChildren();return root}
async function api(path){
  if(!token)throw Object.assign(new Error('Сначала подключите AZRAIL в PULSE CREATE.'),{status:401});
  const r=await fetch(path,{headers:{Authorization:'Bearer '+token}});
  let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw Object.assign(new Error(d.error||'Сервис недоступен.'),{status:r.status});
  return d;
}
function renderIdentity(me){
  const root=clear('identity'),a=me?.account||{};
  row(root,'name',a.name);
  row(root,'role',a.role);
  row(root,'account',a.id);
  row(root,'expires',a.expiresAt||a.expires_at);
}
function renderRouting(data){
  const root=clear('routing'),policy=data?.policy||{};
  const profile=policy.forceFree||!policy.allowThirdPartyModels?'FREE':'HYBRID';
  row(root,'profile',profile);
  row(root,'workers plan',data?.workersPlan);
  row(root,'AI Gateway',data?.gatewayConfigured?'configured':'not configured');
  row(root,'monthly budget','$'+Number(policy.monthlyBudgetUsd||0).toFixed(2));
  row(root,'committed','$'+Number(data?.committedUsd||0).toFixed(4));
  row(root,'policy ready',policy.ready);
  row(root,'revision',policy.revision);
  row(root,'month',data?.month);
}
function renderMetrics(data){
  const root=clear('metrics');
  const missions=Array.isArray(data?.missions)?data.missions:[];
  if(!missions.length)row(root,'missions','0');
  for(const item of missions)row(root,'missions · '+String(item.status||'unknown'),item.count??0);
  const m=data?.models||{};
  row(root,'model calls',m.calls??0);
  row(root,'input tokens',m.input_tokens??0);
  row(root,'output tokens',m.output_tokens??0);
  row(root,'measured cost',usd(m.measured_micro_usd));
  row(root,'unknown-cost calls',m.unknown_cost_calls??0);
  row(root,'mean latency',m.mean_ms==null?'—':Math.round(Number(m.mean_ms))+' ms');
  row(root,'metering',data?.metering||'off');
}
async function load(){
  $('mode').textContent=mode.toUpperCase();
  $('project').textContent=project?project.slice(0,8)+'…':'—';

  const write=safeJson(cached('azrail_pulse_write_budget'));
  $('budget').textContent=write&&Number.isFinite(Number(write.remaining))
    ? String(write.remaining)+' / '+String(write.limit??'—')
    : '—';

  if(!token){
    $('notice').textContent='Нет активной AZRAIL-сессии. Вернитесь в CREATE и подключите ключ доступа.';
    return;
  }
  try{
    const requests=[api('/api/azrail/me'),api('/api/azrail/routing-settings')];
    if(project)requests.push(api('/api/azrail/metrics?projectId='+encodeURIComponent(project)));
    const [me,routing,metrics={}] = await Promise.all(requests);
    renderIdentity(me);
    renderRouting(routing);
    renderMetrics(metrics);
    $('raw').textContent=JSON.stringify({identity:me,routing,metrics,writeBudget:write},null,2);
    $('notice').textContent='Данные обновлены из AZRAIL API.';
  }catch(e){
    $('notice').textContent=e.message;
  }
}
load();
})();