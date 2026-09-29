'use strict';
(()=>{
const $=id=>document.getElementById(id);
const cached=(k,v)=>{try{if(v!==undefined)sessionStorage.setItem(k,v);return sessionStorage.getItem(k)||'';}catch{return '';}};
const uuid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);
let token=cached('azrail_ultimate_token');
let project=cached('azrail_pulse_project');
let mission=cached('azrail_pulse_mission');
let timer=null,busy=false;
let mode=cached('azrail_pulse_mode')||'auto';
const labels={accepted:'Принято',queued:'В очереди',planning:'Планирование',executing:'Выполнение',verifying:'Проверка',checking:'Проверка',repairing:'Исправление',waiting_approval:'Нужно решение',completed:'Готово',done:'Готово',failed:'Ошибка',cancelled:'Остановлено'};
function notice(t){$('notice').textContent=t||'';}
function headers(json,key){const h={Authorization:'Bearer '+token};if(json)h['Content-Type']='application/json';if(key)h['Idempotency-Key']=key;return h;}
async function api(path,opt={}){
  if(!token)throw Object.assign(new Error('Подключите ключ AZRAIL.'),{status:401});
  const method=opt.method||'GET';
  const body=opt.body;
  const r=await fetch(path,{method,headers:headers(body!==undefined,opt.key||''),body:body===undefined?undefined:JSON.stringify(body)});
  let d={};try{d=await r.json();}catch{}
  if(!r.ok)throw Object.assign(new Error(d.error||'Сервис недоступен.'),{status:r.status,code:d.code});
  return d;
}
function openAccess(msg){$('access').hidden=false;$('accessKey').value=token;$('accessNotice').textContent=msg||'';$('accessKey').focus();}
function closeAccess(){$('access').hidden=true;}
function setBusy(v){busy=v;$('createButton').disabled=v;$('idea').readOnly=v;}
function setMode(next){
  mode=next||'auto';cached('azrail_pulse_mode',mode);
  for(const b of document.querySelectorAll('[data-mode]'))b.classList.toggle('active',b.dataset.mode===mode);
}
function setProgress(status){
  const stage=status==='completed'||status==='done'?4:status==='verifying'||status==='checking'?3:status==='executing'||status==='repairing'?2:status==='planning'?1:0;
  for(const el of document.querySelectorAll('#progress .step')){
    const n=Number(el.dataset.stage);el.classList.toggle('done',n<stage);el.classList.toggle('active',n===stage);
  }
}
async function connect(){
  const candidate=$('accessKey').value.trim();if(!candidate){$('accessNotice').textContent='Введите ключ доступа.';return;}
  const previous=token;token=candidate;
  try{const me=await api('/api/azrail/me');cached('azrail_ultimate_token',token);closeAccess();notice('AZRAIL подключён: '+(me.account?.name||'доступ подтверждён')+'.');await ensureProjectList();if(mission)poll();}
  catch(e){token=previous;$('accessNotice').textContent=e.message;}
}
async function ensureProjectList(){
  if(project)return project;
  const d=await api('/api/azrail/projects');
  if(Array.isArray(d.projects)&&d.projects.length){project=d.projects[0].id;cached('azrail_pulse_project',project);return project;}
  return '';
}
function projectNameFrom(message){const clean=message.replace(/\s+/g,' ').trim();return clean.length>54?clean.slice(0,54)+'…':clean||'Новый проект';}
async function ensureProject(message){
  const existing=await ensureProjectList();if(existing)return existing;
  const d=await api('/api/azrail/projects',{method:'POST',body:{name:projectNameFrom(message)}});
  project=d.project.id;cached('azrail_pulse_project',project);return project;
}
function renderMission(d){
  $('mission').hidden=false;const m=d.mission||{};
  $('missionTitle').textContent=m.goal||m.title||'AZRAIL mission';
  $('missionState').textContent=(labels[m.status]||m.status||'WORKING').toUpperCase();setProgress(m.status);
  const list=$('missionSteps');list.replaceChildren();
  for(const step of d.plan||[]){const li=document.createElement('li');li.textContent=(step.title||'Шаг')+' · '+(labels[step.status]||step.status||'');list.append(li);}
  const r=d.result;$('missionResult').textContent=typeof r==='string'?r:[r?.summary,r?.error,Array.isArray(r?.questions)?r.questions.join('\n'):null].filter(Boolean).join('\n\n');
  return !!d.done;
}
async function poll(){
  clearTimeout(timer);if(!token||!mission||document.hidden)return;
  try{const d=await api('/api/azrail/mission?missionId='+encodeURIComponent(mission));const done=renderMission(d);
    if(done){setBusy(false);notice(d.mission?.status==='completed'?'Миссия завершена и проверена.':'Миссия завершилась: '+(labels[d.mission?.status]||d.mission?.status||''));return;}
    setBusy(true);timer=setTimeout(poll,3500);
  }catch(e){setBusy(false);if(e.status===401)openAccess(e.message);else notice(e.message);}
}
$('composer').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;const message=$('idea').value.trim();if(!message){notice('Опишите результат, который нужно получить.');return;}
  if(!token){openAccess('Сначала подключите AZRAIL.');return;}
  setBusy(true);notice('Создаю проект и передаю задачу AZRAIL…');
  try{const projectId=await ensureProject(message);const key=uuid();const d=await api('/api/azrail/mission',{method:'POST',key,body:{message,projectId,preferredMode:mode}});
    mission=d.missionId;cached('azrail_pulse_mission',mission);$('mission').hidden=false;$('missionTitle').textContent=message;$('missionState').textContent='ACCEPTED';
    notice('Задача принята. AZRAIL продолжит работу независимо от открытой страницы.');poll();
  }catch(e){setBusy(false);if(e.status===401)openAccess(e.message);else notice(e.message);}
});
for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>setMode(b.dataset.mode));
setMode(mode);
$('accessConnect').addEventListener('click',connect);
$('accessClose').addEventListener('click',closeAccess);
$('accessKey').addEventListener('keydown',e=>{if(e.key==='Enter')connect();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if(mission)poll();});
if(token){ensureProjectList().then(()=>{notice('AZRAIL подключён.');if(mission){setBusy(true);poll();}}).catch(e=>{if(e.status===401)openAccess('Ключ нужно проверить повторно.');else notice(e.message);});}
else notice('Введите задачу. При первом запуске система предложит подключить AZRAIL.');
})();