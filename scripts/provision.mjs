import {writeFile,readFile,mkdir} from 'node:fs/promises';
const apply=process.argv.includes('--apply');
const profile=process.env.DEPLOY_PROFILE??'free';if(!['free','paid'].includes(profile))throw Error('DEPLOY_PROFILE must be free or paid');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
const name=process.env.WORKER_NAME??'azrail-pulse';if(!/^[a-z0-9-]{3,50}$/.test(name))throw Error('Invalid WORKER_NAME');
const domains=(process.env.CUSTOM_DOMAINS??'mnmllpulse.com,mnmllpulse.org,pulse-labs.org').split(',').map(s=>s.trim());
for(const domain of domains)if(!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain))throw Error('Invalid custom domain');
if(!apply){console.log(JSON.stringify({worker:name,profile,d1:`${name}-db`,kv:`${name}-kv`,r2:`${name}-artifacts`,domains,action:'Plan only; --apply creates resources and writes wrangler.generated.json'},null,2));process.exit(0);}
if(!account||!token)throw Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required');
const config=JSON.parse(await readFile(`deploy/${profile}.json`,'utf8'));
async function api(path,method='GET',body){const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const json=await response.json();if(!response.ok||json.success===false)throw Error(`Cloudflare ${method} ${path}: ${response.status} ${json.errors?.map(e=>e.code).join(',')??''}`);return json.result;}
async function pages(path){let all=[];for(let page=1;page<=50;page++){const rows=await api(`${path}?page=${page}&per_page=100`);if(!Array.isArray(rows))throw Error('Unexpected API list');all.push(...rows);if(rows.length<100)return all;}throw Error('Resource list exceeds supported pagination; choose explicit IDs');}
const dbs=await pages('/d1/database'),namespaces=await pages('/storage/kv/namespaces');
const db=process.env.D1_DATABASE_ID?{uuid:process.env.D1_DATABASE_ID}:dbs.find(d=>d.name===`${name}-db`)??await api('/d1/database','POST',{name:`${name}-db`});
const kv=process.env.KV_NAMESPACE_ID?{id:process.env.KV_NAMESPACE_ID}:namespaces.find(k=>k.title===`${name}-kv`)??await api('/storage/kv/namespaces','POST',{title:`${name}-kv`});
const bucket=process.env.R2_BUCKET_NAME??`${name}-artifacts`;
try{await api(`/r2/buckets/${bucket}`);}catch(e){if(!String(e).includes(': 404'))throw e;await api('/r2/buckets','POST',{name:bucket});}
config.name=name;config.account_id=account;config.routes=domains.map(pattern=>({pattern,custom_domain:true}));
config.d1_databases[0].database_id=db.uuid;config.d1_databases[0].database_name=`${name}-db`;config.kv_namespaces[0].id=kv.id;config.r2_buckets[0].bucket_name=bucket;
config.vars.PUBLIC_ORIGINS=domains.map(d=>`https://${d}`).join(',');
for(const key of ['OIDC_ISSUER','OIDC_CLIENT_ID','OPERATOR_ACCOUNT_IDS','AI_GATEWAY_ID','DAILY_PROVIDER_CALLS','MCP_SERVERS','SANDBOX_PREVIEW_HOSTNAME','STUDIO_STORAGE_MAX_BYTES','STUDIO_STORAGE_MAX_FILES'])if(process.env[key])config.vars[key]=process.env[key];
await writeFile('wrangler.generated.json',JSON.stringify(config,null,2));
await mkdir('.work',{recursive:true});console.log(`Resources ready. Config: wrangler.generated.json. Profile: ${profile}. No Worker deployed.`);
