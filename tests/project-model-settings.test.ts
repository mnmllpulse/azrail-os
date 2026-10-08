import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './stubs/sqlite-d1';
import type { Env } from '../src/types';
import { createAccount } from '../src/lib/accounts';
import { modelSettingsRoute, normalizeProjectModelRequest, withModelSettings } from '../src/unified/model-settings';
import { runModel } from '../src/lib/model-router';
import { setModelPolicy, policyModelCall } from '../src/lib/model-policy';
import { findModel } from '../src/lib/model-registry';
import { initializeMissionBudget } from '../src/lib/billing';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(readFileSync('migrations/013-project-models.sql', 'utf8'));
  const run = vi.fn(async () => ({ response: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));
  const env = { AZRAIL_D1: db, AI: { run }, AUTH_MODE: 'legacy', AZRAIL_MISSION_BUDGET_USD: '2',
    AZRAIL_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const alice = await createAccount(env, 'Alice', 'editor'), bob = await createAccount(env, 'Bob', 'editor'), viewer = await createAccount(env, 'Viewer', 'viewer');
  sqlite.prepare('INSERT INTO resource_owners VALUES(?,?,?)').run('project', 'alice-project', alice.id);
  sqlite.prepare('INSERT INTO resource_owners VALUES(?,?,?)').run('project', 'view-project', viewer.id);
  const call = (path: string, body?: unknown, token = alice.token) => modelSettingsRoute(new Request(`https://app.test${path}`, {
    method: body === undefined ? 'GET' : 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { env, sqlite, call, alice, bob, viewer, run };
}
describe('project model settings', () => {
  it('enforces the per-task budget in addition to the monthly budget before provider dispatch', async () => {
    const f=await fixture(); f.env.OPENAI_API_KEY='unit-test-credential';
    await setModelPolicy(f.env,true,10);
    f.sqlite.prepare('INSERT INTO model_prices VALUES(?,?,?,?)').run('gpt-6-astra',10e6,50e6,Date.now());
    f.sqlite.prepare('INSERT INTO spend_limits(scope,limit_micro_usd) VALUES(?,?)').run('task:bounded',1000);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(policyModelCall(f.env,findModel('gpt-6-astra')!,{messages:[{role:'user',content:'Hello'}]},'task:bounded')).rejects.toThrow('бюджет');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces ownership and read-only roles', async () => {
    const f = await fixture();
    await expect(f.call('/api/workbench/projects/alice-project/model', undefined, f.bob.token)).rejects.toMatchObject({ status: 404 });
    await expect(f.call('/api/workbench/projects/alice-project/model', { baseRevision: 0, settings: {} }, f.bob.token)).rejects.toMatchObject({ status: 404 });
    await expect(f.call('/api/workbench/projects/view-project/model', { baseRevision: 0, settings: {} }, f.viewer.token)).rejects.toMatchObject({ status: 403 });
  });
  it('uses CAS for both the first write and subsequent saves', async () => {
    const f = await fixture(), path = '/api/workbench/projects/alice-project/model';
    expect(await (await f.call(path))!.json()).toEqual({ settings: {}, revision: 0 });
    const results = await Promise.allSettled([1, 2].map(() => f.call(path, { baseRevision: 0, settings: { maxIterations: 7 } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await (await f.call(path, { baseRevision: 1, settings: { maxIterations: 8 } }))!.json()).toEqual({ settings: { maxIterations: 8 }, revision: 2 });
    await expect(f.call(path, { baseRevision: 1, settings: { maxIterations: 9 } })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects unsupported reasoning effort, model, steps and excess budget', async () => {
    const f = await fixture();
    for (const settings of [ { preferredModel: 'unknown' }, { reasoningEffort: 'high' }, { preferredModel: 'gpt-6-astra', reasoningEffort: 'none' }, { maxIterations: 21 }, { maxCostUsd: 3 }, { maxCostUsd: '1' }, { maxCostUsd: 0 } ]) {
      await expect(f.call('/api/workbench/projects/alice-project/model', { baseRevision: 0, settings })).rejects.toMatchObject({ status: 400 });
    }
    expect((await f.call('/api/workbench/projects/alice-project/model', { baseRevision: 0, settings: { preferredModel: 'gpt-6-luna', reasoningEffort: 'none' } }))!.status).toBe(200);
  });
  it('applies persisted settings and bounded overrides, blocks unavailable models before admission', async () => {
    const f = await fixture();
    await f.call('/api/workbench/projects/alice-project/model', { baseRevision: 0, settings: { preferredModel: '@cf/meta/llama-3.2-3b-instruct', maxIterations: 7, maxCostUsd: 0.2 } });
    expect(await normalizeProjectModelRequest(f.env, 'alice-project', { maxIterations: 8 })).toEqual({ preferredModel: '@cf/meta/llama-3.2-3b-instruct', maxIterations: 8, maxCostUsd: 0.2 });
    await expect(normalizeProjectModelRequest(f.env, 'alice-project', { preferredModel: 'gpt-6-astra' })).rejects.toMatchObject({ status: 409 });
    f.env.AZRAIL_MISSION_BUDGET_USD = '0.1';
    expect((await normalizeProjectModelRequest(f.env, 'alice-project', {})).maxCostUsd).toBe(0.1);
  });
  it('reports readiness without leaking secrets or treating Gateway as direct OpenAI access', async () => {
    const f = await fixture(); f.env.AI_GATEWAY_ID = 'gateway';
    await setModelPolicy(f.env, true, 10);
    const json = await (await f.call('/api/workbench/models'))!.json() as any;
    const astra = json.models.find((m: any) => m.id === 'gpt-6-astra');
    expect(astra).toMatchObject({ available: false, transport: 'openai-responses', unavailableReason: 'Серверный ключ OpenAI не настроен', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    f.env.OPENAI_API_KEY = 'unit-test-credential';
    const response = await (await f.call('/api/workbench/models'))!.text();
    expect(response).not.toContain(f.env.OPENAI_API_KEY);
    expect(JSON.parse(response).models.find((m: any) => m.id === 'gpt-6-astra').available).toBe(false);
  });
  it('preserves independent execution settings across concurrent missions and provider billing', async () => {
    const f = await fixture(); f.env.OPENAI_API_KEY = 'unit-test-credential';
    await setModelPolicy(f.env, true, 10);
    for (const model of ['gpt-6-astra', 'gpt-6-luna']) f.sqlite.prepare('INSERT INTO model_prices VALUES(?,?,?,?)').run(model, 10e6, 50e6, Date.now());
    await initializeMissionBudget(f.env, 'a'); await initializeMissionBudget(f.env, 'b');
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      await Promise.resolve();
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `${body.model}:${body.reasoning.effort}` }] }], usage: { input_tokens: 10, output_tokens: 5 } });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await Promise.all([
      withModelSettings({ preferredModel: 'gpt-6-astra', reasoningEffort: 'high' }, () => runModel(f.env, 'answer', { messages: [{ role: 'user', content: 'A' }] })),
      withModelSettings({ preferredModel: 'gpt-6-luna', reasoningEffort: 'none' }, () => runModel(f.env, 'answer', { messages: [{ role: 'user', content: 'B' }] })),
    ]);
    expect(result.map(r => (r.output as any).response)).toEqual(['gpt-6-astra:high', 'gpt-6-luna:none']);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE status='completed'").get()?.n).toBe(2);
  });
});
