'use strict';
(()=>{
const $=id=>document.getElementById(id);
const cached=k=>{try{return sessionStorage.getItem(k)||''}catch{return ''}};
const token=cached('azrail_ultimate_token');
const project=cached('azrail_pulse_project');
const mode=cached('azrail_pulse_mode')||'auto';

function textValue(v){
  if(v===null||v===undefined)return '—';
  if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return String(v);
  return JSON.stringify(v);
}
function renderKv(rootId,obj,max=18){
  const root=$(rootId);root.replaceChildren();
  const entries=Object.entries(obj&&typeof obj==='object'?obj:{}).slice(0,max);
  if(!entries.length){const e=document.createElement('span');e.textContent='Нет данных';root.append(e);return;}
  for(const [k,v] of entries){
    const row=document.createElement('div');row.className='kv';
    const key=document.createElement('b');key.textContent=k;
    const val=document.createElement('span');val.textContent=textValue(v);
    row.append(key,val);root.append(row);
  }
}
async function api(path){
  if(!token)throw Object.assign(new Error('Сначала подключите AZRAIL в PULSE CREATE.'),{status:401});
  const r=await fetch(path,{headers:{Authorization:'Bearer '+token}});
  let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw Object.assign(new Error(d.error||'Сервис недоступен.'),{status:r.status});
  return d;
}
async function load(){
  $('mode').textContent=mode.toUpperCase();
  $('project').textContent=project?project.slice(0,8)+'…':'—';
  if(!token){$('notice').textContent='Нет активной AZRAIL-сессии. Вернитесь в CREATE и подключите ключ доступа.';return;}
  try{
    const calls=[api('/api/azrail/me'),api('/api/azrail/routing-settings')];
    if(project)calls.push(api('/api/azrail/metrics?projectId='+encodeURIComponent(project)));
    const [me,routing,metrics={}] = await Promise.all(calls);
    renderKv('identity',me.account||me);
    renderKv('routing',routing);
    renderKv('metrics',metrics);
    const budget=metrics?.budget||metrics?.writeBudget||metrics?.writes||null;
    $('budget').textContent=budget&&typeof budget==='object'
      ? String(budget.remaining??budget.used??'—')
      : textValue(budget);
    $('raw').textContent=JSON.stringify({identity:me,routing,metrics},null,2);
    $('notice').textContent='Данные обновлены из AZRAIL API.';
  }catch(e){
    $('notice').textContent=e.message;
  }
}
load();
})();