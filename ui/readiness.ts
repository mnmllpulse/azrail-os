import {type API,button,errorText,node,status} from './workbench-common';

export interface ReadinessActions {
 openConnections:()=>void;
 openProjectSettings?:()=>void;
 openPreview?:()=>void;
}
type RecordValue=Record<string,unknown>;
type Result={state:'loading'}|{state:'error';message:string}|{state:'loaded';value:RecordValue};
type Section='models'|'connections'|'capabilities';
const record=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const rows=(value:unknown):RecordValue[]=>Array.isArray(value)?value.map(record):[];
const text=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?value:fallback;
const configured=(value:unknown)=>value===true?'настроено':value===false?'не настроено':'нет данных';

/** Configuration checks only: never dispatch a provider, discovery or runtime call. */
export function mountReadiness(host:HTMLElement,api:API,actions:ReadinessActions):()=>void {
 let disposed=false,epoch=0,controller:AbortController|undefined;
 let results:Record<Section,Result>={models:{state:'loading'},connections:{state:'loading'},capabilities:{state:'loading'}};
 host.dataset.panel='readiness';
 host.append(node('h2','Готовность к первой задаче'),node('p','Проверяем настройки сервера. Наличие подключения не подтверждает успешный вызов модели или выполнение команды.','context-note'));
 const message=status(host),cards=node('div','','cards');
 const modelCard=node('article','','card'),connectionCard=node('article','','card'),runtimeCard=node('article','','card');
 modelCard.dataset.readiness='models';connectionCard.dataset.readiness='connections';runtimeCard.dataset.readiness='runtime';
 cards.append(modelCard,connectionCard,runtimeCard);
 const toolbar=node('div','','toolbar'),refresh=button('Обновить статус',()=>{void load();});
 toolbar.append(refresh);host.append(toolbar,cards);
 const action=(label:string,callback:()=>void)=>button(label,()=>{if(!disposed)callback();});

 function prepare(card:HTMLElement,title:string,result:Result):RecordValue|null {
  card.replaceChildren(node('h3',title));
  if(result.state==='loading'){card.append(node('p','Проверяю настройки…'));return null;}
  if(result.state==='error'){card.append(node('p',`Статус неизвестен: ${result.message}`));return null;}
  return result.value;
 }
 function renderModels(){
  const value=prepare(modelCard,'AI-модели',results.models);
  if(value){
   const configuration=record(value.configuration),models=rows(value.models);
   modelCard.append(node('p',`OpenAI: ${configured(configuration.openaiConfigured)}. AI Gateway: ${configured(configuration.gatewayConfigured)}.`));
   if(configuration.forceFree===true)modelCard.append(node('p','Сервер разрешает только бесплатные маршруты.'));
   else if(configuration.paidModelsEnabled===false)modelCard.append(node('p','Сторонние и платные модели выключены.'));
   if(configuration.policyReady===false)modelCard.append(node('p','Политика выбора моделей ещё не настроена.'));
   const capabilities=results.capabilities;
   if(capabilities.state==='loaded')modelCard.append(node('p',`Workers AI: ${configured(capabilities.value.image)}.`));
   else modelCard.append(node('p',capabilities.state==='loading'?'Проверяю подключение Workers AI…':'Подключение Workers AI не удалось проверить.'));
   if(!models.length)modelCard.append(node('p','Каталог моделей пуст. Доступность AI-задач не подтверждена.'));
   else {
    const details=node('details'),list=node('ul');details.append(node('summary','Модели и причины ограничений'));
    for(const model of models){
     let reason=text(model.unavailableReason,'');
     if(!reason&&model.available!==true)reason='Доступность не подтверждена';
     if(!reason&&model.transport!=='openai-responses'){
      if(capabilities.state==='loaded'&&capabilities.value.image===false)reason='Workers AI не подключён';
      else if(capabilities.state!=='loaded'||capabilities.value.image!==true)reason='Разрешена настройками; подключение Workers AI не подтверждено';
     }
     if(!reason)reason='Разрешена настройками; реальный вызов не проверен';
     list.append(node('li',`${text(model.name,text(model.id,'Модель'))} — ${reason}`));
    }
    details.append(list);modelCard.append(details);
   }
  }
  if(actions.openProjectSettings)modelCard.append(action('Настройки модели проекта',actions.openProjectSettings));
 }
 function renderConnections(){
  const value=prepare(connectionCard,'Подключения и плагины',results.connections);
  if(value){
   const catalog=rows(value.catalog),connections=rows(value.connections);
   if(!catalog.length)connectionCard.append(node('p','Оператор ещё не добавил сервисы в каталог.'));
   else connectionCard.append(node('p',`Сервисов в каталоге: ${catalog.length}.`));
   if(value.vaultConfigured!==true)connectionCard.append(node('p',value.vaultConfigured===false?'Защищённое хранилище подключений не настроено.':'Состояние хранилища подключений неизвестно.'));
   if(!connections.length)connectionCard.append(node('p','Подключений аккаунта пока нет.'));
   else {
    const list=node('ul'),now=Date.now();
    for(const connection of connections){
     const verifiedAt=connection.verifiedAt;
     const fresh=typeof verifiedAt==='number'&&Number.isFinite(verifiedAt)&&verifiedAt>0&&verifiedAt<=now&&verifiedAt>now-86_400_000;
     const count=typeof connection.toolCount==='number'&&Number.isSafeInteger(connection.toolCount)&&connection.toolCount>=0?connection.toolCount:null;
     const state=fresh?`Каталог инструментов проверен${count!==null?`; инструментов: ${count}`:''}`:'Обновите проверку каталога инструментов';
     list.append(node('li',`${text(connection.label,'Подключение')} — ${state}`));
    }
    connectionCard.append(list);
   }
   connectionCard.append(node('p','Проверка каталога не подтверждает успешное действие в сервисе. Разрешения инструментов задаются отдельно в каждом проекте.','muted'));
  }
  connectionCard.append(action('Открыть подключения',actions.openConnections));
 }
 function renderRuntime(){
  const value=prepare(runtimeCard,'Среда выполнения',results.capabilities);
  if(value){
   runtimeCard.append(node('p',value.sandbox===true?'Sandbox подключён к серверу.':value.sandbox===false?'Sandbox не подключён. Команды и работающий preview пока недоступны.':'Состояние Sandbox неизвестно.'));
   runtimeCard.append(node('p','Статический предпросмотр файлов доступен отдельно. Для запуска команд нужны разрешение Sandbox для проекта и разрешённые инструменты. Наличие подключения не подтверждает эти права.','muted'));
  }
  if(actions.openPreview)runtimeCard.append(action('Предпросмотр проекта',actions.openPreview));
 }
 function render(){
  if(disposed)return;
  renderModels();renderConnections();renderRuntime();
  const values=Object.values(results),loading=values.some(value=>value.state==='loading'),failed=values.filter(value=>value.state==='error').length;
  cards.setAttribute('aria-busy',String(loading));
  message.textContent=loading?'Читаю настройки подключений…':failed?'Часть настроек не удалось прочитать. Доступные результаты показаны; попробуйте обновить статус.':'Настройки прочитаны. Тестовые вызовы AI и внешние действия не выполнялись.';
 }
 async function load(){
  if(disposed)return;
  const generation=++epoch;controller?.abort();controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
  results={models:{state:'loading'},connections:{state:'loading'},capabilities:{state:'loading'}};render();
  const endpoints:Array<[Section,string]>=[['models','/api/workbench/models'],['connections','/api/connectors'],['capabilities','/api/studio/capabilities']];
  await Promise.allSettled(endpoints.map(async([section,path])=>{
   try {
    const value=await api(path,{method:'GET',signal});
    if(disposed||epoch!==generation)return;
    if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('Сервер вернул некорректный ответ.');
    results[section]={state:'loaded',value:record(value)};
   }catch(error){if(disposed||epoch!==generation)return;results[section]={state:'error',message:errorText(error)};}
   render();
  }));
 }
 void load();
 return()=>{disposed=true;epoch++;controller?.abort();refresh.disabled=true;};
}
