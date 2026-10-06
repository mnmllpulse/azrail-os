import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';

it('validates login configuration before spawning any provisioning, migration or deployment',()=>{
 // Replace the native subprocess API before importing the real entry point.
 // No Cloudflare request or child command can run from this test.
 const script=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
 cp.spawnSync=(_exe,args)=>{console.log('CHILD:'+JSON.stringify(args));return {status:1};};syncBuiltinESMExports();await import('./scripts/deploy-ci.mjs');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,OIDC_ISSUER:'',OIDC_CLIENT_ID:''}});
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('OIDC_ISSUER');expect(result.stdout).not.toContain('CHILD:');
});
