import {it,expect,vi,afterEach} from 'vitest';
import {requestImage,readPendingImage} from '../ui/image-request';
afterEach(()=>vi.unstubAllGlobals());
it('reuses the exact image operation after lost response or reload, blocks edits, and clears it after success',async()=>{
 const values=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
 const api=vi.fn(async()=>{throw Error('Network disconnected');});await expect(requestImage('alice','Orbit',api)).rejects.toThrow();const pending=readPendingImage('alice');expect(pending).not.toBeNull();expect(readPendingImage('bob')).toBeNull();
 await expect(requestImage('alice','Another prompt',api)).rejects.toThrow('Предыдущая генерация');expect(api).toHaveBeenCalledTimes(1);
 const retry=vi.fn(async()=>({url:'/api/studio/artifacts/known-id'}));await requestImage('alice','Orbit',retry);expect(retry.mock.calls[0]).toEqual(api.mock.calls[0]);expect(readPendingImage('alice')).toBeNull();
});
