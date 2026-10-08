import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Read the deliberately small staging TOML. Unsupported syntax fails closed.
export function parseGuardConfig(text, format = 'toml') {
  if (format === 'json') return JSON.parse(text);
  const config = {};
  let section = config;
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^(\[\[?)([A-Za-z0-9_.-]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const parts = header[2].split('.');
      let parent = config;
      for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
      const key = parts.at(-1);
      if (header[1] === '[[') {
        const list = parent[key] ??= [];
        if (!Array.isArray(list)) throw Error('Ambiguous TOML section: ' + header[2]);
        section = {}; list.push(section);
      } else {
        if (parent[key] !== undefined) throw Error('Duplicate TOML section: ' + header[2]);
        section = parent[key] = {};
      }
      continue;
    }
    const field = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!field || Object.hasOwn(section, field[1])) throw Error('Unsupported or duplicate TOML field: ' + line);
    // Current configs use JSON-compatible string, boolean and array literals.
    try { section[field[1]] = JSON.parse(field[2].replace(/\s+#.*$/, '')); }
    catch { throw Error('Unsupported TOML value for ' + field[1]); }
  }
  return config;
}

function binding(config, type, name) {
  const list = config[type];
  if (!Array.isArray(list) || list.length !== 1 || list[0].binding !== name) throw Error('Staging requires exactly one ' + name + ' binding.');
  return list[0];
}

function httpsUrl(value, label, originOnly = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.origin !== value)) throw Error();
    return url;
  } catch { throw Error(label + ' must be an exact HTTPS ' + (originOnly ? 'origin.' : 'URL.')); }
}

export function validateStaging(staging, productions) {
  const serialized = JSON.stringify(staging);
  if (/REPLACE_[A-Z0-9_]+/.test(serialized)) throw Error('Staging config is not ready: replace all REPLACE_* values.');
  if (staging.env || staging.routes || staging.route) throw Error('Staging uses one explicit config and a separate workers.dev origin; env/routes overrides are unsupported.');
  if (staging.main !== 'src/unified.free.ts' || staging.assets?.directory !== './site' || staging.assets?.binding !== 'ASSETS' || staging.assets?.run_worker_first !== true) throw Error('Staging must use the Unified entry, site assets and Worker-first security headers.');
  if(staging.assets?.html_handling !== 'none')throw Error('Staging HTML handling must be none to prevent app.html redirect loops.');
  if (!staging.name || !staging.name.endsWith('-staging')) throw Error('Staging Worker name must end in -staging.');
  if (staging.containers || staging.durable_objects?.bindings?.some(b => b.name === 'AZRAIL_SANDBOX' || b.class_name === 'Sandbox')) throw Error('Staging config must not include Sandbox/container bindings.');
  const objects = staging.durable_objects?.bindings;
  if (!Array.isArray(objects) || objects.length !== 1 || objects[0].name !== 'Orchestrator' || objects[0].class_name !== 'Orchestrator' || objects[0].script_name || objects[0].environment) throw Error('Staging must use its own local Orchestrator, never another Worker.');
  const vars = staging.vars ?? {};
  if (vars.AUTH_MODE !== 'oidc' || vars.UNIFIED_LEDGER !== 'true' || vars.AZRAIL_METERING !== 'enforce') throw Error('Staging must enforce OIDC, provider accounting and metering.');
  if (vars.AZRAIL_FORCE_FREE !== 'true' || vars.AZRAIL_WORKERS_PLAN !== 'free') throw Error('Staging must force free model routing.');
  for (const key of ['DAILY_PROVIDER_CALLS', 'AZRAIL_WRITE_BUDGET']) {
    if (!/^[1-9][0-9]*$/.test(vars[key] ?? '') || !Number.isSafeInteger(Number(vars[key]))) throw Error('Staging requires a positive finite ' + key + '.');
  }
  if (!(Number(vars.AZRAIL_MISSION_BUDGET_USD) > 0) || !Number.isFinite(Number(vars.AZRAIL_MISSION_BUDGET_USD))) throw Error('Staging requires a finite mission budget.');
  const origin = httpsUrl(vars.PUBLIC_ORIGINS, 'PUBLIC_ORIGINS', true).origin;
  httpsUrl(vars.OIDC_ISSUER, 'OIDC_ISSUER');
  if (typeof vars.OIDC_CLIENT_ID !== 'string' || !vars.OIDC_CLIENT_ID.trim()) throw Error('Staging requires OIDC_CLIENT_ID.');
  for (const key of ['OIDC_CLIENT_SECRET', 'INTEGRATION_KEY', 'OPENAI_API_KEY', 'MCP_OAUTH_SECRETS', 'AZRAIL_TOKEN']) {
    if (Object.hasOwn(vars, key)) throw Error('Keep ' + key + ' in Worker secrets, outside the staging config.');
  }
  const d1 = binding(staging, 'd1_databases', 'AZRAIL_D1');
  const kv = binding(staging, 'kv_namespaces', 'AZRAIL_KV');
  const r2 = binding(staging, 'r2_buckets', 'AZRAIL_R2');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d1.database_id ?? '') || /^0+$/.test(d1.database_id.replaceAll('-', ''))) throw Error('Staging D1 id is invalid.');
  if (!/^[a-f0-9]{32}$/i.test(kv.id ?? '') || /^0+$/.test(kv.id)) throw Error('Staging KV id is invalid.');
  if (!d1.database_name?.endsWith('-staging') || !r2.bucket_name?.endsWith('-staging')) throw Error('Staging database and bucket names must end in -staging.');
  for (const production of productions) {
    if (staging.name === production.name) throw Error('Staging Worker must not equal production Worker.');
    if ((production.d1_databases ?? []).some(b => b.database_id === d1.database_id || b.database_name === d1.database_name)) throw Error('Staging D1 must not equal production D1.');
    if ((production.kv_namespaces ?? []).some(b => b.id === kv.id)) throw Error('Staging KV must not equal production KV.');
    if ((production.r2_buckets ?? []).some(b => b.bucket_name === r2.bucket_name)) throw Error('Staging R2 must not equal production R2.');
    if ((production.vars?.PUBLIC_ORIGINS ?? '').split(',').map(s => s.trim()).includes(origin)) throw Error('Staging origin must not equal a production origin.');
  }
  return staging;
}

export function checkStaging(config = 'wrangler.staging.toml') {
  const selected = resolve(root, config);
  const staging = parseGuardConfig(readFileSync(selected, 'utf8'), selected.endsWith('.json') ? 'json' : 'toml');
  const candidates = ['wrangler.json', 'deploy/free.json', 'deploy/paid.json', 'wrangler.generated.json', 'wrangler.toml'];
  const productions = candidates.filter(file => existsSync(resolve(root, file))).map(file => parseGuardConfig(readFileSync(resolve(root, file), 'utf8'), file.endsWith('.json') ? 'json' : 'toml'));
  if (!productions.length) throw Error('No production configurations available for comparison.');
  validateStaging(staging, productions);
  console.log(`Config: ${selected}. Staging Unified entry, authentication and resource isolation verified.`);
  return staging;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--'))) {
    throw Error('Usage: node scripts/check-staging.mjs [--config file.toml|file.json]');
  }
  checkStaging(args[1]);
}
