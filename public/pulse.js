'use strict';
(()=>{
const $=id=>document.getElementById(id);
const cached=(k,v)=>{try{if(v!==undefined)sessionStorage.setItem(k,v);return sessionStorage.getItem(k)||'';}catch{return '';}};
const uuid=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);
let token=cached('azrail_ultimate_token');
let project=cached('azrail_pulse_project');
let mission=cached('azrail_pulse_mission');
let timer=null,busy=false,presenceTimer=null,globeReady=false;
const presenceSession=cached('azrail_pulse_presence')||('s_'+uuid().replaceAll('-',''));
cached('azrail_pulse_presence',presenceSession);
let mode=cached('azrail_pulse_mode')||'auto';
let knownProjects=[];
let studioCatalogData=null;
let studioHint='';
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
function sendPresenceToGlobe(sessions){
  if(!globeReady)return;
  const frame=$('pulseGlobe');
  frame?.contentWindow?.postMessage({type:'pulse:presence',sessions:Array.isArray(sessions)?sessions:[]},location.origin);
}
async function heartbeatPresence(){
  clearTimeout(presenceTimer);
  if(!token||document.hidden)return;
  try{
    await api('/api/azrail/presence',{method:'POST',body:{sessionId:presenceSession,projectId:project||undefined}});
    const qs=new URLSearchParams({sessionId:presenceSession});
    if(project)qs.set('projectId',project);
    const d=await api('/api/azrail/presence?'+qs.toString());
    sendPresenceToGlobe(d.sessions);
  }catch(e){
    if(e.status===401)return;
  }finally{
    if(token&&!document.hidden)presenceTimer=setTimeout(heartbeatPresence,30000);
  }
}
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
  try{const me=await api('/api/azrail/me');cached('azrail_ultimate_token',token);closeAccess();notice('AZRAIL подключён: '+(me.account?.name||'доступ подтверждён')+'.');await ensureProjectList();heartbeatPresence();if(mission)poll();}
  catch(e){token=previous;$('accessNotice').textContent=e.message;}
}
async function ensureProjectList(){
  const d=await api('/api/azrail/projects');
  knownProjects=Array.isArray(d.projects)?d.projects:[];
  const existing=knownProjects.find(p=>p.id===project);
  if(existing)return existing.id;
  if(knownProjects.length){
    project=knownProjects[0].id;
    cached('azrail_pulse_project',project);
    return project;
  }
  project='';
  cached('azrail_pulse_project','');
  return '';
}
function projectNameFrom(message){const clean=message.replace(/\s+/g,' ').trim();return clean.length>54?clean.slice(0,54)+'…':clean||'Новый проект';}
async function ensureProject(message){
  const existing=await ensureProjectList();if(existing)return existing;
  const d=await api('/api/azrail/projects',{method:'POST',body:{name:projectNameFrom(message)}});
  project=d.project.id;cached('azrail_pulse_project',project);heartbeatPresence();return project;
}

function workspaceRow(title,meta){
  const row=document.createElement('div');row.className='workspace-row';
  const b=document.createElement('b');b.textContent=title||'—';row.append(b);
  if(meta){const s=document.createElement('span');s.textContent=meta;row.append(s);}
  return row;
}
function workspaceEmpty(text){
  const el=document.createElement('div');el.className='workspace-empty';el.textContent=text;return el;
}
function renderWorkspaceList(id,items,map,limit=12){
  const root=$(id);root.replaceChildren();
  const list=Array.isArray(items)?items.slice(0,limit):[];
  if(!list.length){root.append(workspaceEmpty('Нет данных'));return;}
  for(const item of list){const [title,meta]=map(item);root.append(workspaceRow(title,meta));}
  if(items.length>limit)root.append(workspaceEmpty('Ещё '+(items.length-limit)+'…'));
}
async function loadProjectWorkspace(projectId,meta){
  $('projectTitle').textContent=meta?.name||projectId;
  $('projectDescription').textContent=meta?.description||('Project ID: '+projectId);
  const d=await api('/api/azrail/projects/'+encodeURIComponent(projectId)+'/workspace');
  const files=d.files?.files||[];
  const memory=Array.isArray(d.memory)?d.memory:[];
  const versions=Array.isArray(d.versions)?d.versions:[];
  const history=Array.isArray(d.history)?d.history:[];
  $('filesCount').textContent=String(files.length)+(d.files?.truncated?'+':'');
  $('memoryCount').textContent=String(memory.length);
  $('versionsCount').textContent=String(versions.length);
  $('historyCount').textContent=String(history.length);
  renderWorkspaceList('projectFiles',files,f=>[f.path,(typeof f.size==='number'?f.size+' B':'')]);
  renderWorkspaceList('projectMemory',memory,m=>['['+(m.category||'memory')+'] '+(m.key||'fact'),m.value||'']);
  renderWorkspaceList('projectVersions',versions,v=>['v'+(v.versionNumber??'?')+(v.summary?' · '+v.summary:''),v.createdByAgent||v.createdAt||'']);
  renderWorkspaceList('projectHistory',history,x=>[(x.intent||x.agent||'task')+' · '+(x.status||''),x.output_summary||x.error||x.started_at||'']);
}
function renderProjectButtons(){
  const root=$('projectList');root.replaceChildren();
  if(!knownProjects.length){root.append(workspaceEmpty('Проектов пока нет. Первый создастся из Composer.'));return;}
  for(const p of knownProjects){
    const button=document.createElement('button');button.type='button';button.className='project-item'+(p.id===project?' active':'');
    const name=document.createElement('b');name.textContent=p.name||p.id;
    const meta=document.createElement('span');meta.textContent=(p.status||'active')+' · '+(p.updatedAt||'');
    button.append(name,meta);
    button.addEventListener('click',async()=>{
      if(busy&&p.id!==project){notice('Сначала дождитесь завершения текущей миссии перед сменой активного проекта.');return;}
      if(p.id!==project){
        project=p.id;cached('azrail_pulse_project',project);
        mission='';cached('azrail_pulse_mission','');$('mission').hidden=true;setProgress('');
        heartbeatPresence();
      }
      renderProjectButtons();
      try{await loadProjectWorkspace(p.id,p);}catch(e){notice(e.message);}
    });
    root.append(button);
  }
}
async function openProjects(){
  if(!token){openAccess('Сначала подключите AZRAIL.');return;}
  try{
    await ensureProjectList();
    renderProjectButtons();
    $('projectsPanel').hidden=false;
    const current=knownProjects.find(p=>p.id===project)||knownProjects[0];
    if(current)await loadProjectWorkspace(current.id,current);
  }catch(e){notice(e.message);}
}
function closeProjects(){$('projectsPanel').hidden=true;}


async function loadStudioCatalog(){
  if(studioCatalogData)return studioCatalogData;
  const r=await fetch('/pulse-studios.json',{cache:'no-store'});
  if(!r.ok)throw new Error('Не удалось загрузить каталог Studio/Labs.');
  const d=await r.json();
  studioCatalogData=Array.isArray(d.studios)?d.studios:[];
  return studioCatalogData;
}
function catalogChip(text){
  const el=document.createElement('span');el.className='catalog-chip';el.textContent=text;return el;
}
function renderStudioCatalog(kind){
  const grid=$('studioCatalogGrid');grid.replaceChildren();
  const items=(studioCatalogData||[]).filter(x=>kind==='lab'?x.kind==='lab':x.kind!=='lab');
  $('studioCatalogTitle').textContent=kind==='lab'?'LABS':'STUDIO';
  if(!items.length){grid.append(workspaceEmpty('Нет доступных направлений.'));return;}
  items.forEach((item,index)=>{
    const card=document.createElement('article');card.className='catalog-card';
    const num=document.createElement('span');num.className='catalog-index';num.textContent=String(index+1).padStart(2,'0');
    const title=document.createElement('h3');title.textContent=item.title||item.id;
    const desc=document.createElement('p');desc.textContent=item.description||'';
    const meta=document.createElement('div');meta.className='catalog-meta';
    meta.append(catalogChip(String(item.mode||'auto').toUpperCase()));
    meta.append(catalogChip(String(item.status||'planned').toUpperCase()));
    meta.append(catalogChip(String(Array.isArray(item.modules)?item.modules.length:0)+' MODULES'));
    const modules=document.createElement('ul');modules.className='catalog-modules';
    for(const name of (item.modules||[])){const li=document.createElement('li');li.textContent=name;modules.append(li);}
    const run=document.createElement('button');run.type='button';run.className='catalog-run';run.textContent='Использовать →';
    run.addEventListener('click',()=>{
      $('idea').value=item.prompt||'';
      studioHint=item.id||'';
      setMode(item.mode||'auto');
      closeStudioCatalog();
      $('idea').focus();
      notice((item.kind==='lab'?'Лаборатория ':'Студия ')+(item.title||item.id)+' подготовила запрос. Отредактируйте его или запускайте.');
    });
    card.append(num,title,desc,meta,modules,run);grid.append(card);
  });
}
async function openStudioCatalog(kind){
  try{
    await loadStudioCatalog();
    renderStudioCatalog(kind);
    $('studioCatalog').hidden=false;
  }catch(e){notice(e.message);}
}
function closeStudioCatalog(){$('studioCatalog').hidden=true;}
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
  try{const projectId=await ensureProject(message);const key=uuid();const d=await api('/api/azrail/mission',{method:'POST',key,body:{message,projectId,preferredMode:mode,preferredStudio:studioHint||undefined}});
    mission=d.missionId;cached('azrail_pulse_mission',mission);studioHint='';$('mission').hidden=false;$('missionTitle').textContent=message;$('missionState').textContent='ACCEPTED';
    const routed=d.studio?.studio&&d.studio.studio!=='auto'?' · '+d.studio.studio.toUpperCase():'';
    notice('Задача принята'+routed+'. AZRAIL продолжит работу независимо от открытой страницы.');poll();
  }catch(e){setBusy(false);if(e.status===401)openAccess(e.message);else notice(e.message);}
});
for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>setMode(b.dataset.mode));
setMode(mode);
$('studiosOpen').addEventListener('click',()=>openStudioCatalog('studio'));
$('labsOpen').addEventListener('click',()=>openStudioCatalog('lab'));
$('studioCatalogClose').addEventListener('click',closeStudioCatalog);
$('studioCatalog').addEventListener('click',e=>{if(e.target===$('studioCatalog'))closeStudioCatalog();});
$('projectsOpen').addEventListener('click',openProjects);
$('projectsClose').addEventListener('click',closeProjects);
$('projectsPanel').addEventListener('click',e=>{if(e.target===$('projectsPanel'))closeProjects();});
$('accessConnect').addEventListener('click',connect);
$('accessClose').addEventListener('click',closeAccess);
$('accessKey').addEventListener('keydown',e=>{if(e.key==='Enter')connect();});
addEventListener('message',e=>{
  if(e.origin!==location.origin||e.data?.type!=='pulse:globe-ready')return;
  globeReady=true;heartbeatPresence();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){clearTimeout(timer);clearTimeout(presenceTimer);}
  else{if(mission)poll();heartbeatPresence();}
});
if(token){ensureProjectList().then(()=>{notice('AZRAIL подключён.');heartbeatPresence();if(mission){setBusy(true);poll();}}).catch(e=>{if(e.status===401)openAccess('Ключ нужно проверить повторно.');else notice(e.message);});}
else notice('Введите задачу. При первом запуске система предложит подключить AZRAIL.');
})();