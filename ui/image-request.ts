type Pending={account:string;key:string;body:string};
const storageKey='pulse.image.pending';
const keyFor=(account:string,projectId='')=>projectId?`${storageKey}.${account}.${projectId}`:storageKey;
export function readPendingImage(account:string,projectId=''):Pending|null {try{const p=JSON.parse(sessionStorage.getItem(keyFor(account,projectId))??'null');return p?.account===account&&typeof p.key==='string'&&typeof p.body==='string'?p:null;}catch{return null;}}
export async function requestImage(account:string,prompt:string,api:(path:string,options:RequestInit)=>Promise<any>,projectId=''){
 const storageKey=keyFor(account,projectId);
 const body=JSON.stringify({prompt,...(projectId?{projectId}:{})}),old=readPendingImage(account,projectId);
 if(old&&old.body!==body)throw Error('Предыдущая генерация могла быть принята. Сначала проверьте её кнопкой «Вернуть предыдущий запрос».');
 const pending=old??{account,key:crypto.randomUUID(),body};
 // If persistence is unavailable, do not launch an operation whose key would
 // immediately be lost. No image prompt or token is written to localStorage.
 sessionStorage.setItem(storageKey,JSON.stringify(pending));
 try{const result=await api('/api/studio/image',{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.body});sessionStorage.removeItem(storageKey);return result;}
 catch(e){const status=(e as {status?:number})?.status;if(status&&[400,401,403,404,405,413,415,422,429].includes(status))sessionStorage.removeItem(storageKey);throw e;}
}
