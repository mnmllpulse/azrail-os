import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inspection is the default. Remote writes need an explicit --remote --apply.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let config = 'wrangler.toml';
const at = args.indexOf('--config');
if(at>=0){
  if(!args[at+1] || args[at+1].startsWith('--')) throw Error('--config requires a file path');
  config = args[at+1]; args.splice(at,2);
}
const allowed = new Set(['--remote', '--local', '--apply']);
if(args.some(a=>!allowed.has(a)) || (args.includes('--remote')&&args.includes('--local'))){
  throw Error('Usage: npm run db:migrate -- [--local|--remote] [--apply] [--config file.toml]');
}
config = resolve(root,config);
readFileSync(config); // Fail before inspection when the selected config does not exist.
const location = args.includes('--remote') ? '--remote' : '--local';
const apply = args.includes('--apply');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const run = (...params) => execFileSync(process.execPath, [wrangler, ...params, '--config', config], {
  cwd:root, encoding:'utf8', maxBuffer:32*1024*1024,
});
const query = sql => {
  const output = run('d1', 'execute', 'AZRAIL_D1', location, '--command', sql, '--json');
  // Wrangler writes diagnostics to stderr; stdout in --json mode is JSON.
  const response = JSON.parse(output);
  if (!Array.isArray(response) || response.some(r => r.success === false)) throw Error('D1 inspection failed');
  return response.flatMap(r => r.results ?? []);
};
const tables = new Set(query("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
const sql = [];
if (!tables.has('missions')) {
  if (tables.has('projects') || tables.has('conversations')) {
    throw Error('Partial legacy schema: inspect manually before creating tables.');
  }
  sql.push(readFileSync(resolve(root, 'schema.sql'), 'utf8'));
} else {
  const columns = new Set(query("PRAGMA table_info('missions')").map(r => r.name));
  if (!columns.has('result_json')) sql.push('ALTER TABLE missions ADD COLUMN result_json TEXT;');
  sql.push('CREATE INDEX IF NOT EXISTS idx_missions_status_updated ON missions(status, updated_at);');
  for (const file of ['003-bench.sql', '004-security-hardening.sql', '005-platform.sql', '006-model-policy.sql', '007-mission-hints.sql', '020-pulse-presence.sql']) {
    sql.push(readFileSync(resolve(root, 'migrations', file), 'utf8'));
  }
}
mkdirSync(resolve(root, '.work'), { recursive: true });
const plan = resolve(root, '.work/migration-plan.sql');
writeFileSync(plan, sql.join('\n\n'));
console.log(`Config: ${config}. Target: ${location}. SQL plan: ${plan}`);
if (!apply) {
  console.log('Inspection only. Add --apply to execute the plan. No remote data changed.');
} else {
  // Save an independent SQL export BEFORE changing the schema. A failed export
  // aborts the update. R2 is separate: see the restore checklist in the guide.
  mkdirSync(resolve(root, 'backups'), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backup = resolve(root, `backups/d1-before-${stamp}.sql`);
  run('d1', 'export', 'AZRAIL_D1', location, '--output', backup);
  console.log(`D1 backup: ${backup}`);
  console.log(run('d1', 'execute', 'AZRAIL_D1', location, '--file', plan, '--yes'));
  const required = ['access_accounts','resource_owners','operation_locks','mission_outbox',
    'mission_checkpoints','model_calls','backup_manifests','workspace_heads','request_quotas','bench_runs','model_routing_settings','mission_hints','pulse_presence'];
  const after = new Set(query("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  if (required.some(name => !after.has(name))) throw Error('Migration incomplete. Keep Worker on the previous version.');
  console.log('Schema verified. Worker deployment has not been run.');
}
