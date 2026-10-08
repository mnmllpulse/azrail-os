export type API=(path:string,options?:RequestInit)=>Promise<any>;
export type Account={id:string;name:string;operator?:boolean;role?:'viewer'|'editor'};
export interface Project {id:string;name:string;description?:string;status:'active'|'archived';revision:number;updatedAt?:string;missionId?:string;}
export const projectAPI=(id:string)=>`/api/workbench/projects/${encodeURIComponent(id)}`;
export function node<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className=''):HTMLElementTagNameMap[K]{const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;}
export function errorText(error:unknown){return error instanceof Error?error.message:String(error);}
export function button(text:string,action:()=>unknown,className=''):HTMLButtonElement{const b=node('button',text,className);b.type='button';b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{await action();}catch(error){const target=b.closest('[data-panel]')?.querySelector<HTMLElement>('[role=status]');if(target)target.textContent=errorText(error);else document.dispatchEvent(new CustomEvent('workbench-error',{detail:errorText(error)}));}finally{b.disabled=false;}};return b;}
export function field(label:string,id:string,value='',type='text'){const wrap=node('label',label);const input=node('input');input.type=type;input.id=id;input.value=value;wrap.htmlFor=id;wrap.append(input);return {wrap,input};}
export function status(host:HTMLElement){const el=node('p','','context-note');el.setAttribute('role','status');host.append(el);return el;}
export function output(host:HTMLElement,value:unknown){const pre=node('pre',typeof value==='string'?value:JSON.stringify(value,null,2));host.append(pre);return pre;}
export function localRead<T>(key:string,fallback:T):T {try{return JSON.parse(sessionStorage.getItem(key)??'null')??fallback;}catch{return fallback;}}
export function localWrite(key:string,value:unknown){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}
