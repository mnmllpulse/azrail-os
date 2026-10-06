import type {analyzeCSV} from './data';
import {download} from './media';
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const el=document.createElement(tag);el.textContent=text;return el;};
function table(headers:string[],rows:string[][]) {
 const wrap=make('div');wrap.className='table-wrap';const t=make('table'),thead=make('thead'),head=make('tr');
 headers.forEach(text=>head.append(make('th',text)));thead.append(head);t.append(thead);const body=make('tbody');
 rows.forEach(values=>{const row=make('tr');values.forEach(value=>row.append(make('td',value)));body.append(row);});t.append(body);wrap.append(t);return wrap;
}
function report(host:HTMLElement,value:unknown,name:string) {
 const details=make('details');details.append(make('summary','Полный отчёт JSON'),make('pre',JSON.stringify(value,null,2)));host.append(details);
 const button=make('button','Скачать отчёт JSON');button.onclick=()=>download(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),name);host.append(button);
}
const number=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?String(Math.round(value*10000)/10000):'Нет данных';
export function renderCSV(host:HTMLElement,value:ReturnType<typeof analyzeCSV>) {
 host.replaceChildren(make('h2',`${value.rows} строк · ${value.columns.length} столбцов`));
 if(value.raggedRows)host.append(make('p',`Проверьте ${value.raggedRows} строк: число ячеек отличается от заголовка.`));
 host.append(table(['Столбец','Заполнено','Числа','Минимум','Максимум','Среднее'],value.columns.map(c=>[c.name,String(c.filled),String(c.numeric),number(c.min),number(c.max),number(c.mean)])));
 report(host,value,'pulse-data-analysis.json');
}
export interface ALSReport {bpm:number|null;tracks:Array<{name:string;type:string;role:string}>;warnings:string[];}
export function renderALS(host:HTMLElement,value:ALSReport) {
 host.replaceChildren(make('h2',`${value.tracks.length} треков · темп ${number(value.bpm)} BPM`),table(['Трек','Тип','Роль'],value.tracks.map(t=>[t.name,t.type,t.role])));
 value.warnings.forEach(text=>host.append(make('p',text)));report(host,value,'pulse-ableton-analysis.json');
}
interface LedgerReport {limits:Array<{scope:string;unit:string;limit_units:number;committed_units:number}>;models:Array<{model:string;status:string;actual_micro_usd:number|null;reserved_micro_usd:number;started_at:string|number}>;note:string;}
export function renderLedger(host:HTMLElement,value:LedgerReport) {
 host.replaceChildren(make('h2','Лимиты платформы'),table(['Единица','Лимит','Учтено и зарезервировано'],value.limits.map(r=>[r.unit==='request'?'Запросы':r.unit,number(r.limit_units),number(r.committed_units)])),make('h2','Вызовы моделей ваших проектов'));
 if(value.models.length)host.append(table(['Модель','Состояние','Учтено, USD','Резерв, USD'],value.models.map(m=>[m.model,m.status,m.actual_micro_usd===null?'Не подтверждено':number(m.actual_micro_usd/1e6),number(m.reserved_micro_usd/1e6)])));
 else host.append(make('p','Учтённых вызовов моделей пока нет.'));
 host.append(make('p',value.note));report(host,value,'pulse-resource-ledger.json');
}
export function renderLab(host:HTMLElement,cloud?:Record<string,unknown>) {
 const checks:Array<[string,boolean]>=[['Синтез WAV',typeof OfflineAudioContext!=='undefined'],['Декодирование аудио',typeof AudioContext!=='undefined'],['Запись видео WebM',typeof MediaRecorder!=='undefined'&&typeof HTMLCanvasElement.prototype.captureStream==='function'],['Микрофон',!!navigator.mediaDevices?.getUserMedia],['Скачивание файлов','download' in document.createElement('a')]];
 host.replaceChildren(make('h2','Совместимость устройства'),table(['Инструмент','Доступность'],checks.map(([name,ok])=>[name,ok?'Доступно в браузере':'Не поддерживается'])));
 if(cloud){host.append(make('h2','Настройки сервера'),table(['Сервис','Подключение'],[['Workers AI',cloud.image?'Binding подключён':'Не подключён'],['Sandbox',cloud.sandbox?'Подключён':'Отсутствует в профиле'],['Авторизация',String(cloud.auth??'Нет данных')]]),make('p','Наличие binding не подтверждает работу провайдера. Диагностика не запускает платные модели.'));}
 else host.append(make('p','Для проверки серверных подключений войдите в развёрнутое приложение.'));
 report(host,{browser:checks.map(([name,available])=>({name,available})),server:cloud??null},'pulse-diagnostics.json');
}
