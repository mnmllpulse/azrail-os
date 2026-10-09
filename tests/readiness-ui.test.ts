import {afterEach,expect,it,vi} from 'vitest';
import {Window} from 'happy-dom';
import {mountReadiness} from '../ui/readiness';

const windows:Window[]=[];
const settle=async()=>{for(let index=0;index<3;index++)await new Promise(resolve=>setTimeout(resolve,0));};
afterEach(async()=>{vi.unstubAllGlobals();for(const window of windows){await window.happyDOM.abort();window.close();}windows.length=0;});
function dom(){const window=new Window({url:'https://app.example.com'});windows.push(window);vi.stubGlobal('document',window.document);const host=window.document.createElement('section');window.document.body.append(host);return host as unknown as HTMLElement;}
const click=(host:HTMLElement,label:string)=>{const button=[...host.querySelectorAll('button')].find(element=>element.textContent===label);expect(button).toBeDefined();button!.click();};
const catalog={models:[{id:'workers',name:'Workers model',transport:'workers-ai',available:true},{id:'openai',name:'OpenAI model',transport:'openai-responses',available:false,unavailableReason:'Серверный ключ OpenAI не настроен'}],configuration:{openaiConfigured:false,gatewayConfigured:false,paidModelsEnabled:false,policyReady:true,forceFree:true}};
const connections={catalog:[],connections:[],vaultConfigured:false};
const capabilities={image:false,sandbox:false};
const payload=(path:string)=>path==='/api/workbench/models'?catalog:path==='/api/connectors'?connections:capabilities;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

it('explains provider and runtime gaps without treating allowed models as verified',async()=>{
 const host=dom(),api=vi.fn(async(path:string)=>payload(path));const cleanup=mountReadiness(host,api,{openConnections:vi.fn()});await settle();
 expect(host.textContent).toContain('Серверный ключ OpenAI не настроен');
 expect(host.textContent).toContain('Workers model — Workers AI не подключён');
 expect(host.textContent).toContain('Sandbox не подключён');
 expect(host.textContent).toContain('Защищённое хранилище подключений не настроено');
 expect(host.textContent).toContain('Тестовые вызовы AI и внешние действия не выполнялись');
 expect(host.textContent).not.toContain('Настройки модели проекта');expect(host.textContent).not.toContain('Предпросмотр проекта');cleanup();
});

it('isolates an endpoint failure and still renders other checks and safe text',async()=>{
 const host=dom(),api=vi.fn(async(path:string)=>{if(path==='/api/connectors')throw Error('<script>failed()</script>');if(path==='/api/studio/capabilities')return {image:true,sandbox:true};return catalog;});
 const cleanup=mountReadiness(host,api,{openConnections:vi.fn()});await settle();
 expect(host.querySelector('[data-readiness="models"]')?.textContent).toContain('Серверный ключ OpenAI не настроен');
 expect(host.querySelector('[data-readiness="runtime"]')?.textContent).toContain('Sandbox подключён к серверу');
 expect(host.querySelector('[data-readiness="connections"]')?.textContent).toContain('Статус неизвестен: <script>failed()</script>');
 expect(host.querySelector('script')).toBeNull();expect(host.querySelector('[role="status"]')?.textContent).toContain('Часть настроек');cleanup();
});

it('does not infer Workers AI readiness when the capabilities request fails',async()=>{
 const host=dom();const cleanup=mountReadiness(host,async path=>{if(path==='/api/studio/capabilities')throw Error('Offline');return payload(path);},{openConnections:vi.fn()});await settle();
 expect(host.textContent).toContain('Workers model — Разрешена настройками; подключение Workers AI не подтверждено');
 expect(host.textContent).not.toContain('Workers model — Разрешена настройками; реальный вызов не проверен');cleanup();
});

it('refresh aborts previous requests and ignores late responses from that generation',async()=>{
 const host=dom(),first=deferred<unknown>(),signals:AbortSignal[]=[];let calls=0;
 const api=vi.fn(async(path:string,options?:RequestInit)=>{signals.push(options!.signal!);if(calls++<3)return first.promise;return payload(path);});
 const cleanup=mountReadiness(host,api,{openConnections:vi.fn()});
 click(host,'Обновить статус');await settle();
 expect(signals.slice(0,3).every(signal=>signal.aborted)).toBe(true);expect(signals.slice(3).every(signal=>!signal.aborted)).toBe(true);
 const current=host.innerHTML;first.resolve({models:[{name:'OLD MODEL',available:true}],image:true,sandbox:true,catalog:[],connections:[]});await settle();
 expect(host.innerHTML).toBe(current);expect(host.textContent).not.toContain('OLD MODEL');cleanup();
});

it('cleanup aborts requests and ignores later completions and detached callbacks',async()=>{
 const host=dom(),pending=deferred<unknown>(),signals:AbortSignal[]=[],openConnections=vi.fn();
 const cleanup=mountReadiness(host,async(_path,options)=>{signals.push(options!.signal!);return pending.promise;},{openConnections});
 const connectionButton=[...host.querySelectorAll('button')].find(element=>element.textContent==='Открыть подключения')!;
 cleanup();const previous=host.innerHTML;pending.resolve(connections);await settle();
 expect(signals.every(signal=>signal.aborted)).toBe(true);expect(host.innerHTML).toBe(previous);
 connectionButton.click();await settle();expect(openConnections).not.toHaveBeenCalled();
});

it('keeps discovery distinct from successful external actions and marks stale catalogs',async()=>{
 const host=dom(),now=Date.now();const cleanup=mountReadiness(host,async path=>path==='/api/connectors'?{
  catalog:[{id:'github'}],vaultConfigured:true,connections:[{label:'Fresh GitHub',verifiedAt:now-1000,toolCount:4},{label:'Old GitHub',verifiedAt:now-86_400_001,toolCount:4},{label:'Future GitHub',verifiedAt:now+3_600_000,toolCount:4}],
 }:payload(path),{openConnections:vi.fn()});await settle();
 expect(host.textContent).toContain('Fresh GitHub — Каталог инструментов проверен; инструментов: 4');
 expect(host.textContent).toContain('Old GitHub — Обновите проверку каталога инструментов');
 expect(host.textContent).toContain('Future GitHub — Обновите проверку каталога инструментов');
 expect(host.textContent).toContain('Проверка каталога не подтверждает успешное действие в сервисе');cleanup();
});

it('navigation callbacks only run on clicks and all checks use GET without payloads',async()=>{
 const host=dom(),api=vi.fn(async(path:string,_options?:RequestInit)=>payload(path));const actions={openConnections:vi.fn(),openProjectSettings:vi.fn(),openPreview:vi.fn()};
 const cleanup=mountReadiness(host,api,actions);await settle();
 expect(Object.values(actions).every(callback=>callback.mock.calls.length===0)).toBe(true);
 click(host,'Открыть подключения');click(host,'Настройки модели проекта');click(host,'Предпросмотр проекта');await settle();
 Object.values(actions).forEach(callback=>expect(callback).toHaveBeenCalledTimes(1));
 expect(api.mock.calls.map(([path])=>path).sort()).toEqual(['/api/connectors','/api/studio/capabilities','/api/workbench/models']);
 for(const [,options] of api.mock.calls){expect(options?.method).toBe('GET');expect(options?.body).toBeUndefined();}cleanup();
});
