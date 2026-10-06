import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const cfg='wrangler.generated.json';
const run=(args,input)=>{const r=spawnSync(process.execPath,args,{stdio:input?['pipe','inherit','inherit']:'inherit',input,encoding:'utf8'});if(r.status!==0)throw Error(`Command failed: ${args[0]}`);};
// Check local input and compile assets before the first cloud mutation.
if(!process.env.OIDC_ISSUER?.trim()||!process.env.OIDC_CLIENT_ID?.trim())throw Error('OIDC_ISSUER and OIDC_CLIENT_ID must be configured before deployment');
try{const issuer=new URL(process.env.OIDC_ISSUER);if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash)throw Error();}catch{throw Error('OIDC_ISSUER must be an HTTPS issuer URL without credentials, query or fragment');}
const profile=process.env.DEPLOY_PROFILE??'free';if(!['free','paid'].includes(profile))throw Error('DEPLOY_PROFILE must be free or paid');
JSON.parse(readFileSync(`deploy/${profile}.json`,'utf8'));
const daily=process.env.DAILY_PROVIDER_CALLS;if(daily!==undefined&&(!daily.trim()||!Number.isSafeInteger(Number(daily))||Number(daily)<0))throw Error('DAILY_PROVIDER_CALLS must be a non-negative integer');
for(const key of ['MCP_SERVERS','MCP_OAUTH_SECRETS'])if(process.env[key]){try{JSON.parse(process.env[key]);}catch{throw Error(`${key} must contain valid JSON`);}}
if(!process.env.CLOUDFLARE_ACCOUNT_ID||!process.env.CLOUDFLARE_API_TOKEN)throw Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required');
run(['scripts/build-unified.mjs']);
run(['scripts/provision.mjs','--apply']);
const config=JSON.parse(readFileSync(cfg,'utf8'));
if(!config.vars.OIDC_ISSUER||!config.vars.OIDC_CLIENT_ID)throw Error('OIDC_ISSUER and OIDC_CLIENT_ID must be configured before deployment');
run(['scripts/migrate.mjs','--remote','--apply','--config',cfg]);
const wrangler='node_modules/wrangler/bin/wrangler.js';
// Secret values go through stdin, never command arguments or logs. Missing
// variables preserve the existing deployed secret, including the stable vault key.
const secrets=Object.fromEntries(['OIDC_CLIENT_SECRET','INTEGRATION_KEY','MCP_OAUTH_SECRETS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
if(Object.keys(secrets).length)run([wrangler,'secret','bulk','--config',cfg],JSON.stringify(secrets));
run([wrangler,'deploy','--config',cfg]);
