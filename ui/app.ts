import {mountWorkbench,renderProjectHub,type WorkbenchTab} from './workbench';
import {renderMission} from './mission-view';
import {mountStudioDraft} from './studio-draft';
import {readPendingImage,requestImage} from './image-request';
import {createNavigation,type Route} from './navigation';
import {studios,studioById,type StudioId} from './studios';
export {};
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const local=!/^https?:$/.test(location.protocol);
type Account={id:string;name:string;operator?:boolean;role?:'viewer'|'editor'};
let account:Account|null=null,project='',mission='',pollTimer=0,epoch=0,studioEpoch=0,mediaCleanup=()=>{},lastBlob:Blob|null=null;
let workbenchCleanup=()=>{},composerDraftCleanup=()=>{},attachmentGeneration=0;
let draftCleanup=()=>{},pollFailures=0,missionSubmitting=false,studioRun=0;
const prompt=$<HTMLTextAreaElement>('prompt');
const composer=$('composer'),missionPanel=$('mission-panel');
prompt.addEventListener('input',()=>{try{sessionStorage.setItem(`pulse.prompt.${account?.id??'local'}.${project||'new'}`,prompt.value);}catch{}});
const composerHome=document.createComment('composer-home'),missionHome=document.createComment('mission-home');
composer.before(composerHome);missionPanel.before(missionHome);
const navigation=createNavigation(renderRoute);
let attachmentsText='',pending:{key:string;body:string}|null=null;
function clearAttachments(){attachmentGeneration++;attachmentsText='';$('attachment-names').textContent='';$<HTMLInputElement>('attachments').value='';}
try{pending=JSON.parse(sessionStorage.getItem('pulse.pending')??'null');project=sessionStorage.getItem('pulse.project')??'';mission=sessionStorage.getItem('pulse.mission')??'';}catch{}
function remember(){try{if(account){sessionStorage.setItem(`pulse.session.${account.id}`,JSON.stringify({project,mission,pending}));sessionStorage.setItem('pulse.account',account.id);sessionStorage.setItem(`pulse.mission.${account.id}.${project}`,mission);} if(pending)sessionStorage.setItem('pulse.pending',JSON.stringify(pending));else sessionStorage.removeItem('pulse.pending');sessionStorage.setItem('pulse.project',project);sessionStorage.setItem('pulse.mission',mission);}catch{}}

let noticeTimer=0;
function notice(message:string,persist=false){clearTimeout(noticeTimer);$('notice-text').textContent=message;$('notice').hidden=false;if(!persist)noticeTimer=window.setTimeout(()=>{$('notice').hidden=true;},6500);}
$('notice-close').onclick=()=>{clearTimeout(noticeTimer);$('notice').hidden=true;};
function failure(e:unknown){notice(e instanceof Error?e.message:String(e),true);}
class APIError extends Error {
 constructor(message:string,readonly status:number,readonly code?:string){super(message);}
}
async function api(path:string,options:RequestInit={}) {
 if(local)throw Error('Этот файл показывает интерфейс и локальные студии. Для AI и проектов откройте развёрнутое приложение.');
 const headers=new Headers(options.headers);if(typeof options.body==='string'&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
 const r=await fetch(path,{...options,credentials:'same-origin',headers,signal:options.signal??AbortSignal.timeout(90000)});
 if(r.status===204)return null;
 const text=await r.text();let body:any;try{body=JSON.parse(text);}catch{}
 if(!r.ok)throw new APIError(typeof body?.error==='string'?body.error:`Сервис вернул ошибку ${r.status}. Повторите позже.`,r.status,body?.code);
 if(body===undefined)throw Error('Сервис вернул неполный ответ. Статус операции требует проверки.');return body;
}
async function blobAPI(path:string){const r=await fetch(path,{credentials:'same-origin',signal:AbortSignal.timeout(90000)});if(!r.ok){const j=await r.json().catch(()=>({}));throw new APIError(j.error??'Не удалось скачать файл.',r.status);}return r.blob();}
function bind(id:string,fn:()=>unknown){$(id).onclick=()=>Promise.resolve().then(fn).catch(failure);}
function dialog(title:string,html:string){$('dialog-title').textContent=title;$('dialog-content').innerHTML=html;$<HTMLDialogElement>('dialog').showModal();}
bind('close-dialog',()=>$<HTMLDialogElement>('dialog').close());
function cleanupMedia(){const cleanup=mediaCleanup;mediaCleanup=()=>{};cleanup();}
function leaveStudio(){studioEpoch++;studioRun++;draftCleanup();draftCleanup=()=>{};cleanupMedia();lastBlob=null;composerHome.after(composer);missionHome.after(missionPanel);$('studio-work').hidden=true;$('studio-controls').replaceChildren();$('studio-result').replaceChildren();$('studio-result').removeAttribute('aria-busy');}
function renderRoute(route:Route,initial:boolean){
 if(route.page==='workbench'&&pending&&project!==route.project){notice('Предыдущая отправка требует проверки перед сменой проекта.',true);return;}
 composerDraftCleanup();composerDraftCleanup=()=>{};workbenchCleanup();workbenchCleanup=()=>{};leaveStudio();
 if(route.page==='workbench')selectProject(route.project);
const id=route.page==='studio'?'studio-page':route.page;
 document.querySelectorAll<HTMLElement>('.view').forEach(el=>el.hidden=el.id!==id);
 const nav=route.page==='studio'?'studios':route.page==='workbench'?'projects':route.page;
 document.querySelectorAll('.nav').forEach(el=>{const active=el.getAttribute('data-view')===nav;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 if(route.page==='studio')renderStudio(route.studio);
 if(route.page==='workbench')workbenchCleanup=mountWorkbench($('workbench'),{api,account,id:route.project,tab:route.tab,composer,mission:missionPanel,connect:()=>openConnections(),navigate:(id,tab)=>navigation.navigate({page:'workbench',project:id,tab}),onProject:p=>{document.title=`${p.name} · AZRAIL`;}});
 if(route.page==='create'||route.page==='workbench')composerDraftCleanup=mountStudioDraft(composer,'web',api,false,{scope:`${account?.id??'local'}:${project||'new'}`,preferCurrent:true});
 if(route.page==='projects')loadProjects().catch(failure);
 const title=route.page==='studio'?studioById(route.studio)!.title:route.page==='create'?'Создать':route.page==='projects'?'Проекты':route.page==='studios'?'Студии':route.page==='workbench'?'Проект':'Страница не найдена';
 document.title=`${title} · AZRAIL MNMLL PULSE OS`;
 if(!initial){document.querySelector<HTMLElement>(`#${id} h1`)?.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
}
function view(id:'create'|'projects'|'studios'){navigation.navigate({page:id});}
navigation.link(document.querySelector<HTMLAnchorElement>('[data-home]')!,{page:'create'});
document.querySelectorAll<HTMLAnchorElement>('[data-view]').forEach(el=>navigation.link(el,{page:el.dataset.view as 'create'|'projects'|'studios'}));
navigation.link($<HTMLAnchorElement>('close-studio'),{page:'studios'});
document.querySelectorAll<HTMLElement>('[data-prompt]').forEach(el=>el.onclick=()=>{prompt.value=el.dataset.prompt!;prompt.focus();});
document.querySelectorAll<HTMLElement>('[data-studio]').forEach(el=>el.onclick=()=>openStudio(el.dataset.studio!));
bind('attach',()=>$<HTMLInputElement>('attachments').click());
$<HTMLInputElement>('attachments').onchange=async()=>{const generation=++attachmentGeneration,scope=project,owner=account?.id;try{const files=[...($<HTMLInputElement>('attachments').files??[])];if(files.length>5||files.some(f=>f.size>100000))throw Error('До 5 текстовых файлов, каждый до 100 КБ.');const text=(await Promise.all(files.map(async f=>`\nФАЙЛ ${f.name}\n${await f.text()}`))).join('\n');if(generation!==attachmentGeneration||scope!==project||owner!==account?.id)return;attachmentsText=text;$('attachment-names').textContent=files.map(f=>f.name).join(' · ');}catch(e){if(generation===attachmentGeneration&&scope===project&&owner===account?.id){attachmentsText='';failure(e);}}};
bind('account',async()=>{if(!account){if(local)throw Error('Вход доступен после развёртывания приложения.');location.assign('/auth/login');return;}dialog('Ваш аккаунт','<p id="account-name"></p><p id="account-id"></p><button id="logout">Выйти</button>');$('account-name').textContent=account.name;$('account-id').textContent=account.id;bind('logout',async()=>{await api('/auth/logout',{method:'POST'});for(const key of ['pulse.pending','pulse.project','pulse.mission','pulse.image.pending'])sessionStorage.removeItem(key);location.reload();});});
async function refreshAccount(){if(local){$('local-notice').textContent='Локальный просмотр · WAV/MIDI, аудиоанализ и CSV доступны на устройстве. Для AI и проектов нужен вход в развёрнутое приложение.';$('local-notice').hidden=false;$('mode').textContent='AI подключается после развёртывания';return;}const a=await api('/auth/status');account=a.account;if(account){try{const previous=sessionStorage.getItem('pulse.account');const state=JSON.parse(sessionStorage.getItem(`pulse.session.${account.id}`)??'null');if(state){project=state.project??'';mission=state.mission??'';pending=state.pending??null;}else if(previous&&previous!==account.id){project='';mission='';pending=null;prompt.value='';clearAttachments();}remember();}catch{}$('account').textContent=account.name;await refreshMode();if(mission){$('mission-panel').hidden=false;await poll(++epoch);}}else if(!a.configured)notice('Настройте вход OIDC при развёртывании. Локальные студии уже доступны.');}
async function refreshMode(){const r=await api('/api/routing-settings');$('mode').textContent=r.policy.allowThirdPartyModels?'Сторонние модели включены':'Сторонние модели выключены';return r;}
bind('settings',async()=>{
 if(!account)throw Error('Войдите, чтобы посмотреть режим и лимиты.');
 const r=await refreshMode();dialog('Режим и лимиты','<label><input type="checkbox" id="third-party"> Сторонние AI-модели</label><label for="budget">Месячный лимит платных моделей, USD</label><input id="budget" type="number" min="0" step="1"><p id="budget-info"></p><p>OFF блокирует сторонние модели. На Workers Paid даже собственные модели могут расходовать деньги сверх квоты. R2 и Sandbox учитываются отдельно.</p><button id="save-mode" class="primary">Сохранить</button><button id="catalog">Каталог моделей</button>');
 $<HTMLInputElement>('third-party').checked=r.policy.allowThirdPartyModels;$<HTMLInputElement>('budget').value=String(r.policy.monthlyBudgetUsd);$('budget-info').textContent=`Учтено и зарезервировано: $${r.committedUsd.toFixed(4)}. План: ${r.workersPlan}.`;
 $<HTMLButtonElement>('save-mode').disabled=!account.operator;
 if(!account.operator)$('budget-info').textContent+=' Изменения доступны оператору платформы.';
 bind('save-mode',async()=>{await api('/api/admin/routing-settings',{method:'POST',body:JSON.stringify({allowThirdPartyModels:$<HTMLInputElement>('third-party').checked,monthlyBudgetUsd:Number($<HTMLInputElement>('budget').value)})});await refreshMode();notice('Настройки сохранены на сервере.');});
 bind('catalog',async()=>{const cat=await api('/api/model-catalog');const pre=document.createElement('pre');pre.textContent=JSON.stringify(cat,null,2);$('dialog-content').append(pre);});
});
bind('about',()=>dialog('AZRAIL × MNMLL PULSE','<p>Мультиагентное ядро AZRAIL и творческие инструменты PULSE в одном приложении. У каждого модуля студий своя страница.</p><p>Текст и голос → миссия → файлы проекта → проверка. Результат не получает статус готовности к публикации без успешной проверки кода.</p><p>Музыка здесь — локальный алгоритмический синтез. Видео — запись оригинальной анимации. Эти режимы не выдают себя за подключённые музыкальные или видео AI-сервисы.</p>'));
async function runMission(){
 if(missionSubmitting)return;
 if(!account)throw Error('Войдите в аккаунт, чтобы запустить AZRAIL.');
 if(account.role==='viewer')throw Error('Ваш аккаунт разрешает только просмотр.');
 const message=prompt.value.trim();if(!message)return;
 if(!pending){project=project||crypto.randomUUID();pending={key:crypto.randomUUID(),body:JSON.stringify({message:message+attachmentsText,projectId:project})};}
 remember();
 missionSubmitting=true;$<HTMLButtonElement>('submit').disabled=true;
 try{const r=await api('/api/mission',{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.body});mission=r.missionId;pending=null;remember();$('mission-panel').hidden=false;await poll(++epoch);}
 catch(e){
  // A definite admission rejection is editable. Network errors, 5xx and an
  // in-flight 409 retain the exact request/key: its delivery is uncertain.
  if(e instanceof APIError&&([400,401,403,404,405,413,415,422,429].includes(e.status)||e.code==='project_busy')){pending=null;remember();}
  throw e;
 }
 finally{missionSubmitting=false;$<HTMLButtonElement>('submit').disabled=false;}
}
$('composer').onsubmit=e=>{e.preventDefault();runMission().catch(failure);};
async function poll(version=epoch){
 clearTimeout(pollTimer);if(!mission||document.hidden)return;
 try {const r=await api(`/api/mission?missionId=${encodeURIComponent(mission)}`);if(version!==epoch)return;pollFailures=0;const state=renderMission(document,r,!!account?.operator);if(state.active)pollTimer=window.setTimeout(()=>void poll(version),3000);}
 catch(e){if(version!==epoch)return;pollFailures++;$('mission-connection').textContent=e instanceof APIError&&e.status===401?'Сессия завершена. Войдите снова, чтобы продолжить просмотр.':'Связь прервана. Задача может продолжать работу на сервере. Повторная отправка не выполняется.';if(!(e instanceof APIError&&[401,403,404].includes(e.status))&&pollFailures<6)pollTimer=window.setTimeout(()=>void poll(version),Math.min(30000,3000*2**pollFailures));}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll().catch(failure);else clearTimeout(pollTimer);});
bind('resume',()=>poll(++epoch));
bind('cancel',async()=>{if(mission){await api('/api/mission/cancel',{method:'POST',body:JSON.stringify({missionId:mission,projectId:project})});await poll(++epoch);}});
bind('export-project',async()=>{if(!project)throw Error('Выберите проект.');const {download}=await import('./media');download(await blobAPI(`/api/studio/project-zip?projectId=${encodeURIComponent(project)}`),'azrail-project.zip');});
bind('refresh-projects',loadProjects);
function selectProject(id:string){if(project===id)return;composerDraftCleanup();composerDraftCleanup=()=>{};try{sessionStorage.setItem(`pulse.prompt.${account?.id??'local'}.${project||'new'}`,prompt.value);}catch{}project=id;try{mission=sessionStorage.getItem(`pulse.mission.${account?.id??'local'}.${id}`)??'';prompt.value=sessionStorage.getItem(`pulse.prompt.${account?.id??'local'}.${id||'new'}`)??'';}catch{mission='';prompt.value='';}clearAttachments();remember();epoch++;clearTimeout(pollTimer);missionPanel.hidden=!mission;if(mission)void poll(epoch);}
function openProject(id:string,tab:WorkbenchTab='task'){navigation.navigate({page:'workbench',project:id,tab});}
bind('new-project',()=>{if(pending)throw Error('Сначала повторите отправку предыдущего запроса: он мог быть принят сервером.');if(!account){selectProject(crypto.randomUUID());view('create');prompt.focus();return;}dialog('Новый проект','<form id="project-create-form"><label for="project-create-name">Название</label><input id="project-create-name" required maxlength="120" placeholder="Например, сайт музыкального лейбла"><label for="project-create-description">Описание</label><textarea id="project-create-description" maxlength="2000" placeholder="Цель проекта и важные детали"></textarea><button id="project-create-submit" class="primary" type="submit">Создать проект</button><p id="project-create-status" role="status"></p></form>');const form=$<HTMLFormElement>('project-create-form');form.onsubmit=async event=>{event.preventDefault();const submit=$<HTMLButtonElement>('project-create-submit');if(submit.disabled)return;submit.disabled=true;try{const result=await api('/api/workbench/projects',{method:'POST',body:JSON.stringify({name:$<HTMLInputElement>('project-create-name').value,description:$<HTMLTextAreaElement>('project-create-description').value})});$<HTMLDialogElement>('dialog').close();openProject(result.project.id);}catch(e){$('project-create-status').textContent=e instanceof Error?e.message:String(e);}finally{submit.disabled=false;}};$('project-create-name').focus();});
bind('recover',async()=>{if(!mission)throw Error('Выберите миссию.');const r=await api('/api/mission/recover',{method:'POST',body:JSON.stringify({projectId:project,missionId:mission})});notice(r.resumed?'Миссия возобновлена.':r.reason);await poll(++epoch);});
bind('permit-sandbox',async()=>{if(!account?.operator)throw Error('Разрешение Sandbox выдаёт оператор платформы.');const c=await api('/api/studio/capabilities');if(!c.sandbox)throw Error('Sandbox отсутствует в этом профиле. Нужен Paid-профиль Cloudflare.');await api('/api/admin/permissions',{method:'POST',body:JSON.stringify({projectId:project,capability:'sandbox',enabled:true})});notice('Sandbox разрешён для этого проекта. Его использование тарифицируется отдельно.');});

let projectLoad=0;
async function loadProjects(){const token=++projectLoad;if(!account){$('project-list').textContent=local?'Проекты сохраняются после развёртывания приложения и входа.':'Войдите, чтобы увидеть свои проекты.';$('artifact-list').textContent='Локальные результаты можно скачать прямо из студии.';return;}const projectsHost=document.createElement('div'),artifactsHost=document.createElement('div');await renderProjectHub(projectsHost,artifactsHost,api,account,id=>openProject(id),$<HTMLInputElement>('project-search').value,$<HTMLSelectElement>('project-filter').value);if(token!==projectLoad)return;$('project-list').replaceChildren(...projectsHost.childNodes);$('artifact-list').replaceChildren(...artifactsHost.childNodes);}
let searchTimer=0;$<HTMLInputElement>('project-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=window.setTimeout(()=>void loadProjects().catch(failure),250);};$<HTMLSelectElement>('project-filter').onchange=()=>void loadProjects().catch(failure);
document.addEventListener('workbench-error',event=>notice((event as CustomEvent<string>).detail,true));
for(const studio of studios){
 const el=document.createElement('a');el.className='card';el.dataset.studio=studio.id;
 const small=document.createElement('small'),h=document.createElement('h3'),p=document.createElement('p'),action=document.createElement('span');
 small.textContent=studio.type;h.textContent=studio.title;p.textContent=studio.description;action.className='card-action';action.textContent=studio.action+' ↗';
 el.append(small,h,p,action);navigation.link(el,{page:'studio',studio:studio.id});$('studio-list').append(el);
}
const inputFile=(accept:string)=>`<label for="studio-file">Выберите файл</label><input id="studio-file" type="file" accept="${accept}">`;
const runButton='<div class="toolbar"><button id="studio-run" class="primary" type="button"></button></div>';
function file(){const f=$<HTMLInputElement>('studio-file').files?.[0];if(!f)throw Error('Выберите файл.');return f;}
function exportResult(blob:Blob,name:string,kind:'audio'|'video'|'image',persisted?:{id:string;projectId?:string|null},scope=project){
 cleanupMedia();lastBlob=blob;const url=URL.createObjectURL(blob),result=$('studio-result');result.replaceChildren();
 const media=document.createElement(kind==='image'?'img':kind);media.setAttribute('src',url);
 mediaCleanup=()=>{if(media instanceof HTMLMediaElement)media.pause();media.removeAttribute('src');URL.revokeObjectURL(url);};
 if(kind==='image'){media.className='result-image';media.setAttribute('alt','Сгенерированное изображение');}else media.setAttribute('controls','');result.append(media);
 const bar=document.createElement('div');bar.className='toolbar';const dl=document.createElement('button');dl.textContent='Скачать файл';dl.onclick=()=>{import('./media').then(m=>m.download(blob,name)).catch(failure);};bar.append(dl);
 if(account&&account.role!=='viewer'){
  const save=document.createElement('button');const uploadKey=crypto.randomUUID();save.textContent=persisted?'Назначить текущему проекту':'Сохранить в проектах';if(persisted&&persisted.projectId===scope){save.textContent='Сохранено в проекте';save.disabled=true;}save.onclick=()=>{
   if(save.disabled)return;save.disabled=true;
   (persisted?api(`/api/studio/artifacts/${encodeURIComponent(persisted.id)}`,{method:'PATCH',body:JSON.stringify({projectId:scope||null})}):api('/api/studio/artifacts',{method:'POST',headers:{'Content-Type':blob.type,'X-Filename':encodeURIComponent(name),'Idempotency-Key':uploadKey,...(scope?{'X-Project-Id':scope}:{})},body:blob}))
    .then(()=>{save.textContent='Сохранено';notice('Файл сохранён.');}).catch(e=>{save.disabled=false;failure(e);});
  };bar.append(save);
 }
 result.append(bar);
}
function openStudio(id:string){const studio=studioById(id);if(studio)navigation.navigate({page:'studio',studio:studio.id});}
function renderStudio(id:StudioId){
 const studio=studioById(id)!,token=++studioEpoch;
 $('studio-project-context').textContent=project?`Результаты и черновики относятся к выбранному проекту. ID: ${project}`:'Проект не выбран. Сохранённые файлы попадут в «Файлы без проекта».';
 $('studio-work').hidden=false;$('studio-title').textContent=studio.title;$('studio-description').textContent=studio.description;$('studio-type').textContent=studio.type;
 const controls=$('studio-controls');
 if(id==='web'){
  controls.innerHTML='<p class="context-note">Опишите результат. Ход миссии и готовые файлы появятся на этой странице. Для запуска нужен вход.</p>';
  controls.append(composer,missionPanel);
  draftCleanup=mountStudioDraft(controls,id,api,false,{scope:`${account?.id??'local'}:${project||'new'}`,preferCurrent:true});
  return;
 }
 if(id==='image')controls.innerHTML='<label for="studio-text">Опишите изображение</label><textarea id="studio-text" rows="3" maxlength="4000" placeholder="Обложка минимал-техно релиза: скульптурная форма, тёмный фон, фиолетовый свет"></textarea>'+runButton;
 if(id==='music')controls.innerHTML='<p class="muted">Алгоритмический синтез F minor. Текст задаёт вариацию мелодии. Результат — музыкальный эскиз для продолжения в DAW.</p><label for="studio-text">Название или идея</label><input id="studio-text" type="text" maxlength="4000" value="Midnight pulse"><div class="field-row"><label>Темп, BPM<input id="bpm" type="number" min="60" max="180" value="124"></label><label>Тактов<input id="bars" type="number" min="1" max="16" value="8"></label></div>'+runButton;
 if(id==='video')controls.innerHTML='<label for="studio-text">Текст для видео</label><input id="studio-text" type="text" maxlength="90" value="One idea. A whole world."><p class="context-note">Запись 8 секунд. Во время записи оставьте вкладку открытой.</p>'+runButton;
 if(id==='audio')controls.innerHTML=inputFile('audio/*')+'<label for="audio-reference">Референс для сравнения (необязательно)</label><input id="audio-reference" type="file" accept="audio/*"><p class="context-note">Файлы анализируются на устройстве. Моно/стерео, до 30 МБ и 15 минут на файл.</p>'+runButton;
 if(id==='als')controls.innerHTML=inputFile('.als,.xml')+'<p class="context-note">До 8 МБ. Разбор структуры ALS, без изменения исходного файла.</p>'+runButton;
 if(id==='data')controls.innerHTML=inputFile('.csv')+'<p class="context-note">CSV до 2 МБ. Таблица и статистика обрабатываются на устройстве.</p>'+runButton;
 if(id==='lab')controls.innerHTML='<p class="context-note">Проверка браузера и настроек сервера. Платные модели не запускаются.</p>'+runButton;
 if(id==='ledger')controls.innerHTML=runButton;
 if(id==='image'&&account){
  const restore=document.createElement('button');restore.textContent='Вернуть предыдущий запрос';restore.onclick=()=>{
   const pending=readPendingImage(account!.id,project);if(!pending){notice('Незавершённых запросов изображения в этой вкладке нет.');return;}
   try{$<HTMLTextAreaElement>('studio-text').value=JSON.parse(pending.body).prompt;$('studio-text').dispatchEvent(new Event('input'));notice('Предыдущий текст восстановлен. Повтор будет отправлен с тем же ключом.');}catch(e){failure(e);}
  };controls.append(restore);
 }
 draftCleanup=mountStudioDraft(controls,id,api,!!account,{scope:account?.id??'local',projectId:project||undefined,writable:account?.role!=='viewer',autosave:true});
 const run=$<HTMLButtonElement>('studio-run');run.textContent=studio.action+' ↗';
 const readOnly=account?.role==='viewer'&&['image','als'].includes(id);
 if((studio.cloud&&!account)||readOnly){
  run.disabled=true;const info=document.createElement('p');info.className='context-note';info.textContent=readOnly?'Ваш аккаунт разрешает только просмотр.':'Для этого инструмента войдите в развёрнутое приложение.';controls.append(info);
 }
 bind('studio-run',async()=>{
  if(run.disabled)return;
  run.disabled=true;const runToken=++studioRun,current=()=>token===studioEpoch&&runToken===studioRun;
  const abort=new AbortController();cleanupMedia();mediaCleanup=()=>abort.abort();lastBlob=null;
  $('studio-result').textContent=id==='video'?'Идёт запись 8 секунд…':'Выполняю…';$('studio-result').setAttribute('aria-busy','true');
  try{
   // Capture all input before lazy imports. Another page may own these IDs later.
   const runProject=project;
   const text=($('studio-text') as HTMLInputElement|null)?.value??'';
   const bpm=Number(($('bpm') as HTMLInputElement|null)?.value),bars=Number(($('bars') as HTMLInputElement|null)?.value);
   const source=['audio','als','data'].includes(id)?file():undefined;
   const reference=($('audio-reference') as HTMLInputElement|null)?.files?.[0];
   if(id==='image'){
    const r=await requestImage(account!.id,text,(path,options)=>api(path,{...options,signal:abort.signal}),runProject);
    if(!current())return;const blob=await blobAPI(r.url);if(current())exportResult(blob,r.name,'image',{id:r.id??r.artifactId??r.url.split('/').pop(),projectId:r.projectId},runProject);
   }
   if(id==='music'){
    const {renderMusic,download}=await import('./media');if(!current())return;
    const r=await renderMusic(text,bpm,bars);if(!current())return;exportResult(r.wav,'pulse-original.wav','audio',undefined,runProject);
    const midi=document.createElement('button');midi.textContent='Скачать MIDI';midi.onclick=()=>download(r.midi,'pulse-melody.mid');$('studio-result').append(midi);
   }
   if(id==='video'){
    const {renderVideo}=await import('./media');if(!current())return;
    const canvas=document.createElement('canvas');$('studio-result').append(canvas);
    const blob=await renderVideo(text,canvas,abort.signal);if(current())exportResult(blob,'pulse-motion.webm','video',undefined,runProject);
   }
   if(id==='audio'){
    const {analyzeAudio}=await import('./media');if(!current())return;
    const {renderAudioReport}=await import('./audio-analysis');if(!current())return;
    const r=await analyzeAudio(source!,abort.signal),ref=reference?await analyzeAudio(reference,abort.signal):undefined;
    if(current())renderAudioReport($('studio-result'),r,ref);
   }
   if(id==='als'){
    if(source!.size>8*1024*1024)throw Error('ALS должен быть не больше 8 МБ.');
    const r=await api('/api/studio/als',{method:'POST',body:source,signal:abort.signal});
    const {renderALS}=await import('./studio-reports');if(current())renderALS($('studio-result'),r);
   }
   if(id==='data'){
    if(source!.size>2_000_000)throw Error('CSV должен быть не больше 2 МБ.');
    const {analyzeCSV}=await import('./data');if(!current())return;
    const r=analyzeCSV(await source!.text());const {renderCSV}=await import('./studio-reports');if(current())renderCSV($('studio-result'),r);
   }
   if(id==='lab'){
    const capabilities=account?await api('/api/studio/capabilities',{signal:abort.signal}):undefined;
    const {renderLab}=await import('./studio-reports');if(current())renderLab($('studio-result'),capabilities);
   }
   if(id==='ledger'){
    const r=await api('/api/studio/ledger',{signal:abort.signal});const {renderLedger}=await import('./studio-reports');if(current())renderLedger($('studio-result'),r);
   }
  }catch(e){if(current()){$('studio-result').textContent=e instanceof Error?e.message:'Не удалось завершить действие. Параметры сохранены в форме.';throw e;}}
  finally{run.disabled=false;if(current())$('studio-result').setAttribute('aria-busy','false');}
 });
}
let recorder:MediaRecorder|null=null;
bind('voice',async()=>{const voiceProject=project,voiceAccount=account?.id,voiceGeneration=attachmentGeneration;if(recorder?.state==='recording'){recorder.stop();return;}if(!account)throw Error('Для распознавания речи войдите в аккаунт.');if(!navigator.mediaDevices?.getUserMedia)throw Error('Микрофон доступен по HTTPS в поддерживаемом браузере.');const stream=await navigator.mediaDevices.getUserMedia({audio:true});let active:MediaRecorder;try{active=new MediaRecorder(stream);}catch(e){stream.getTracks().forEach(t=>t.stop());throw e;}recorder=active;const chunks:BlobPart[]=[];active.ondataavailable=e=>chunks.push(e.data);$('voice').textContent='■';$('voice').setAttribute('aria-label','Остановить запись');const timer=setTimeout(()=>{if(active.state==='recording')active.stop();},30000);active.onstop=async()=>{clearTimeout(timer);stream.getTracks().forEach(t=>t.stop());$('voice').textContent='◉';$('voice').setAttribute('aria-label','Записать голосовой запрос');try{const blob=new Blob(chunks,{type:active.mimeType});const r=await api('/api/studio/voice',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:blob});if(voiceProject!==project||voiceAccount!==account?.id||voiceGeneration!==attachmentGeneration)return;prompt.value=[prompt.value,r.text].filter(Boolean).join(' ');notice('Текст распознан. Проверьте запрос перед отправкой.');}catch(e){failure(e);}};active.start();notice('Записываю. Нажмите квадрат, чтобы закончить. Максимум 30 секунд.');});
navigation.render(true);
refreshAccount().then(()=>{if(!local&&account)navigation.render(true);}).catch(failure);
// Avoid keeping a previous large export reachable after leaving its studio.
window.addEventListener('pagehide',()=>{composerDraftCleanup();workbenchCleanup();draftCleanup();cleanupMedia();lastBlob=null;});
void lastBlob;

bind('shortcuts',()=>dialog('Горячие клавиши','<p>Ctrl / ⌘ + Enter — отправить запрос.</p><p>Alt + 1 — создать; Alt + 2 — проекты; Alt + 3 — студии.</p><p>Escape — закрыть окно. Отмена и повтор текста доступны стандартными клавишами редактора.</p>'));
document.addEventListener('keydown',e=>{if(e.defaultPrevented||e.isComposing)return;if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&document.activeElement===prompt){e.preventDefault();$('composer').dispatchEvent(new Event('submit',{cancelable:true}));}if(e.altKey&&['1','2','3'].includes(e.key)){e.preventDefault();view((['create','projects','studios'] as const)[Number(e.key)-1]);}});

async function openConnections(){if(!account){dialog('Подключения','<p>Войдите в развёрнутое приложение, чтобы подключать сервисы к своему аккаунту.</p>');return;}dialog('Подключения','<div id="connector-panel"></div>');const {renderConnections}=await import('./connectors');await renderConnections($('connector-panel'),api,project||undefined);}
bind('connections',openConnections);

if(new URLSearchParams(location.search).get('connected')==='1'){notice('Сервис подключён. Откройте Подключения и проверьте соединение.');history.replaceState(null,'',location.pathname+location.hash);}

bind('project-design',async()=>{if(!project||!account)throw Error('Откройте свой проект.');const path='/api/studio/design-contract?projectId='+encodeURIComponent(project),r=await api(path);dialog('Стиль проекта','<p>Эти правила используются агентами при генерации и правках интерфейса проекта.</p><label for="design-accent">Акцент</label><input id="design-accent" type="color"><label for="design-font">Характер шрифта</label><select id="design-font"><option value="sans-serif">Прямой гротеск</option><option value="serif">С засечками</option><option value="monospace">Моноширинный</option></select><label for="design-action">Основное действие</label><input id="design-action" maxlength="60"><button id="design-save" class="primary">Сохранить стиль</button>');$<HTMLInputElement>('design-accent').value=r.contract.accent;$<HTMLSelectElement>('design-font').value=r.contract.fontFamily;$<HTMLInputElement>('design-action').value=r.contract.primaryAction;bind('design-save',async()=>{await api(path,{method:'PUT',body:JSON.stringify({baseRevision:r.revision,contract:{...r.contract,accent:$<HTMLInputElement>('design-accent').value,fontFamily:$<HTMLSelectElement>('design-font').value,primaryAction:$<HTMLInputElement>('design-action').value}})});$<HTMLDialogElement>('dialog').close();notice('Стиль сохранён. Следующие правки будут учитывать контракт.');});});
