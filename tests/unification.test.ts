import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalApiPath, normalizeAzrailRequest } from '../src/protocol/facade';
import { validateProjectDescription, validateProjectName } from '../src/lib/projects-api';
import { capabilitiesForMode, defaultIterationsForMode, normalizeRoutingMode, tierPreferenceForMode } from '../src/lib/routing-mode';
import { modeForStudio, routeStudio } from '../src/lib/studio-router';
import { createAccount, hashToken, requireResource } from '../src/lib/accounts';
import { claimMission, finishAdmission } from '../src/lib/mission-admission';
import { sqliteD1 } from './stubs/sqlite-d1';
import type { Env } from '../src/types';
import { parseGuardConfig, validateStaging } from '../scripts/check-staging.mjs';
vi.mock('../src/core/azrail-sandbox', () => ({ Sandbox: class {} }));
import worker from '../src/unified/entry';

const root = resolve(import.meta.dirname, '..');
const productionFiles = ['wrangler.json', 'deploy/free.json', 'deploy/paid.json', 'wrangler.toml'];
const productions = productionFiles.map(file => parseGuardConfig(readFileSync(resolve(root, file), 'utf8'), file.endsWith('.json') ? 'json' : 'toml'));
const template = readFileSync(resolve(root, 'wrangler.staging.toml'), 'utf8');
const databases: Array<{ close(): void }> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });

async function fixture() {
  const { db, sqlite } = sqliteD1(); databases.push(sqlite);
  const env = {
    AZRAIL_D1: db, AUTH_MODE: 'oidc', PUBLIC_ORIGINS: 'https://app.test',
    UNIFIED_LEDGER: 'true', DAILY_PROVIDER_CALLS: '5',
    AZRAIL_R2: { list: async () => ({ objects: [], truncated: false }) },
    AI: { run: vi.fn() },
    ASSETS: { fetch: vi.fn(async () => new Response('<html>Unified</html>', { headers: { 'Content-Type': 'text/html' } })) },
  } as unknown as Env;
  const alice = await createAccount(env, 'Alice', 'editor');
  const bob = await createAccount(env, 'Bob', 'editor');
  for (const [who, token] of [[alice, 'a'.repeat(64)], [bob, 'b'.repeat(64)]] as const) {
    sqlite.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(await hashToken(token), who.id, 'https://app.test', Date.now() + 3600000);
  }
  await requireResource(env, alice, 'project', 'alice-project', true);
  await requireResource(env, bob, 'project', 'bob-project', true);
  const call = (path: string, init: RequestInit = {}, signedIn = true) => worker.fetch(new Request('https://app.test' + path, {
    ...init, headers: { ...(signedIn ? { Cookie: '__Host-pulse-session=' + 'a'.repeat(64) } : {}), Origin: 'https://app.test', 'Content-Type': 'application/json', ...init.headers },
  }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
  return { env, sqlite, alice, bob, call };
}

describe('Compatibility facade uses the active security boundary', () => {
  it('retries definite model admission rejection without leaving an in-flight key',async()=>{
    const f=await fixture(),init={method:'POST',headers:{'Idempotency-Key':'model-rejection-123456'},body:JSON.stringify({projectId:'alice-project',message:'Build',preferredModel:'gpt-6-astra'})};
    const first=await f.call('/api/mission',init),retry=await f.call('/api/mission',init);
    expect(first.status).toBe(409);expect(retry.status).toBe(409);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mission_admissions').get()?.n).toBe(0);
    expect(await retry.text()).toBe(await first.text());
  });
  it('normalizes known aliases and preserves query, headers and request body', async () => {
    expect(canonicalApiPath('/api/azrail/mission')).toBe('/api/mission');
    expect(canonicalApiPath('/api/azrail/projects/abc/versions')).toBe('/api/projects/abc/versions');
    expect(canonicalApiPath('/api/azrail/admin/secret')).toBe('/api/azrail/admin/secret');
    const request = normalizeAzrailRequest(new Request('https://app.test/api/azrail/mission?x=1', {
      method: 'POST', headers: { 'Idempotency-Key': 'request-123456' }, body: '{"message":"hello"}',
    }));
    expect(request.url).toBe('https://app.test/api/mission?x=1');
    expect(request.headers.get('Idempotency-Key')).toBe('request-123456');
    expect(await request.json()).toEqual({ message: 'hello' });
  });

  it('requires authentication on aliases and returns the same account on either path', async () => {
    const f = await fixture();
    expect((await f.call('/api/azrail/me', {}, false)).status).toBe(401);
    expect(await (await f.call('/api/azrail/me')).json()).toEqual(await (await f.call('/api/me')).json());
  });

  it('keeps project metrics private through both route spellings', async () => {
    const f = await fixture();
    for (const path of ['/api/metrics', '/api/azrail/metrics']) {
      expect((await f.call(path + '?projectId=bob-project')).status).toBe(404);
      expect((await f.call(path + '?projectId=alice-project')).status).toBe(200);
    }
  });

  it('shares admission replay across canonical and alias mission URLs', async () => {
    const f = await fixture();
    const body = JSON.stringify({ projectId: 'alice-project', message: 'Inspect project' });
    const key = 'shared-replay-123456';
    const scope = f.alice.id + ':' + key;
    const admission = await claimMission(f.env, scope, body);
    expect(admission.kind).toBe('claimed');
    if (admission.kind !== 'claimed') throw Error('Fixture admission failed');
    const response = { success: true, missionId: 'existing-mission', status: 'accepted' };
    await finishAdmission(f.env, scope, admission.claim, Response.json(response, { status: 202 }));
    for (const path of ['/api/mission', '/api/azrail/mission']) {
      const result = await f.call(path, { method: 'POST', headers: { 'Idempotency-Key': key }, body });
      expect(result.status).toBe(202);
      expect(result.headers.get('Idempotency-Replayed')).toBe('true');
      expect(await result.json()).toEqual(response);
    }
    expect(f.env.AI.run).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM mission_admissions').get()?.n).toBe(1);
  });

  it('rejects unsupported legacy routing fields instead of silently changing their meaning', async () => {
    const f = await fixture();
    for (const field of ['preferredMode', 'preferredStudio']) {
      const response = await f.call('/api/azrail/mission', { method: 'POST', body: JSON.stringify({ projectId: 'alice-project', message: 'Inspect project', [field]: 'auto' }) });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('routing_profile_deprecated');
    }
    expect(f.env.AI.run).not.toHaveBeenCalled();
  });

  it('serves the Unified application with CSP on the root and legacy HTML URL', async () => {
    const f = await fixture();
    for (const path of ['/', '/index.html', '/ultimate.html']) {
      const response = await f.call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    }
    for (const [request] of vi.mocked(f.env.ASSETS!.fetch).mock.calls) expect(new URL((request as Request).url).pathname).toBe('/app.html');
  });

  it('rejects cross-origin cookie mutations before either canonical or alias dispatch', async () => {
    const f = await fixture();
    const result = await f.call('/api/azrail/mission', { method: 'POST', headers: { Origin: 'https://foreign.test' }, body: '{}' });
    expect(result.status).toBe(403);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM mission_admissions').get()?.n).toBe(0);
    expect(f.env.AI.run).not.toHaveBeenCalled();
  });

  it('does not expose an inactive presence service as working', async () => {
    const f = await fixture();
    expect((await f.call('/api/azrail/presence')).status).toBe(404);
  });
});

describe('Retained input and routing helpers (legacy profiles are not active API modes)', () => {
  it('validates project metadata', () => {
    expect(validateProjectName('  Pulse Lab  ')).toBe('Pulse Lab');
    expect(() => validateProjectName('   ')).toThrow();
    expect(() => validateProjectName('x'.repeat(121))).toThrow();
    expect(validateProjectDescription(undefined)).toBeNull();
    expect(validateProjectDescription('  core  ')).toBe('core');
    expect(() => validateProjectDescription('x'.repeat(2001))).toThrow();
  });
  it('retains mode calculations for compatibility tooling', () => {
    expect(normalizeRoutingMode('unknown')).toBe('auto');
    expect(tierPreferenceForMode('auto')).toBeNull();
    expect(tierPreferenceForMode('fast')).toEqual(['fast', 'balanced', 'frontier']);
    expect(tierPreferenceForMode('deep')).toEqual(['frontier', 'balanced', 'fast']);
    expect(defaultIterationsForMode('fast')).toBeLessThan(defaultIterationsForMode('deep'));
    expect(capabilitiesForMode('code')).toEqual(['coding']);
  });
  it('classifies clear topic requests and gives an explicit studio priority', () => {
    expect(routeStudio('Исправь TypeScript ошибки и тесты').studio).toBe('development');
    expect(routeStudio('Анализ музыкальной аранжировки трека').studio).toBe('audio');
    expect(routeStudio('Настрой Cloudflare deploy и observability').studio).toBe('operations');
    expect(routeStudio('Проведи benchmark и измерь результат').studio).toBe('pulse-lab');
    expect(routeStudio('Сделай анализ музыкальной аранжировки трека', 'audio').studio).toBe('audio');
    expect(routeStudio('Привет, помоги с идеей').studio).toBe('auto');
    expect(modeForStudio('development')).toBe('code');
    expect(modeForStudio('audio')).toBe('creative');
  });
});

function readyStaging() {
  return parseGuardConfig(template
    .replaceAll('REPLACE_STAGING_D1_ID', '11111111-1111-4111-8111-111111111111')
    .replaceAll('REPLACE_STAGING_KV_ID', '11111111111111111111111111111111')
    .replaceAll('REPLACE_STAGING_ORIGIN', 'https://azrail-pulse-staging.example.workers.dev')
    .replaceAll('REPLACE_STAGING_OIDC_ISSUER', 'https://identity.example.test/staging')
    .replaceAll('REPLACE_STAGING_OIDC_CLIENT_ID', 'staging-client'));
}

describe('Unified staging isolation guard', () => {
  it('accepts a configured isolated profile and reads legacy and JSON production bindings', () => {
    const staging = readyStaging();
    expect(productions.at(-1).d1_databases[0].database_id).toBeTruthy();
    expect(productions.at(-1).kv_namespaces[0].id).toBeTruthy();
    expect(validateStaging(staging, productions)).toBe(staging);
  });
  it('fails closed until resource and OIDC placeholders are replaced', () => {
    expect(() => validateStaging(parseGuardConfig(template), productions)).toThrow('replace all REPLACE_');
  });
  it.each([
    ['D1', 'd1_databases', 'database_id'],
    ['KV', 'kv_namespaces', 'id'],
    ['R2', 'r2_buckets', 'bucket_name'],
  ])('blocks %s resource reuse from the deployed legacy production config', (_label, section, key) => {
    const staging = readyStaging();
    staging[section][0][key] = productions.at(-1)[section][0][key];
    expect(() => validateStaging(staging, productions)).toThrow();
  });
  it('also compares generated/current JSON production resources', () => {
    const staging = readyStaging();
    const generated = { name: 'actual-production', d1_databases: [{ database_id: staging.d1_databases[0].database_id }] };
    expect(() => validateStaging(staging, [...productions, generated])).toThrow('Staging D1 must not equal production D1');
  });
  it.each([
    ['legacy entry', (s: any) => { s.main = 'src/index.ts'; }],
    ['unprotected assets', (s: any) => { s.assets.run_worker_first = false; }],
    ['legacy auth', (s: any) => { s.vars.AUTH_MODE = 'legacy'; }],
    ['disabled metering', (s: any) => { s.vars.AZRAIL_METERING = 'observe'; }],
    ['paid models', (s: any) => { s.vars.AZRAIL_FORCE_FREE = 'false'; }],
    ['containers', (s: any) => { s.containers = [{ class_name: 'Sandbox' }]; }],
    ['production Durable Object', (s: any) => { s.durable_objects.bindings[0].script_name = 'azrail-os'; }],
    ['unbounded request limit', (s: any) => { s.vars.DAILY_PROVIDER_CALLS = '9'.repeat(500); }],
    ['plaintext secret', (s: any) => { s.vars.OIDC_CLIENT_SECRET = 'secret'; }],
    ['production origin', (s: any) => { s.vars.PUBLIC_ORIGINS = 'https://mnmllpulse.com'; }],
    ['extra environment', (s: any) => { s.env = { production: {} }; }],
  ])('rejects %s', (_label, mutate) => {
    const staging = readyStaging(); mutate(staging);
    expect(() => validateStaging(staging, productions)).toThrow();
  });
  it('rejects duplicated or unsupported TOML syntax', () => {
    expect(() => parseGuardConfig('name="one"\nname="two"')).toThrow('duplicate');
    expect(() => parseGuardConfig('name=unquoted')).toThrow('Unsupported TOML');
  });
});
