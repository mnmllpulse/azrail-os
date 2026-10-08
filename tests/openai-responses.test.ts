import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenAIResponses, prepareOpenAIRequest } from '../src/lib/openai-responses';
import { findModel } from '../src/lib/model-registry';
import { runModel } from '../src/lib/model-router';
import { setModelPolicy } from '../src/lib/model-policy';
import { sqliteD1 } from './stubs/sqlite-d1';
import type { Env } from '../src/types';

afterEach(() => vi.unstubAllGlobals());
const astra = findModel('gpt-6-astra')!;
const messages = [{ role: 'user', content: 'Inspect project' }];
const env = { OPENAI_API_KEY: 'unit-test-credential' } as Env;
describe('bounded OpenAI Responses adapter', () => {
  it('maps function schemas, prior calls/results and JSON schema output without built-in paid tools', () => {
    const body = prepareOpenAIRequest(astra, { messages: [...messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'file contents' }], max_tokens: 40000, reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      response_format: { type: 'json_schema', json_schema: { name: 'decision', schema: { type: 'object' }, strict: true } } });
    expect(body).toMatchObject({ model: 'gpt-6-astra', store: false, stream: false, max_output_tokens: 32768, reasoning: { effort: 'high' }, parallel_tool_calls: false });
    expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: 'file contents' });
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'decision', schema: { type: 'object' }, strict: true } });
    expect(() => prepareOpenAIRequest(astra, { messages, tools: [{ type: 'web_search' }] })).toThrow();
  });
  it('bounds request/output sizes and refuses unsupported modes before dispatch', () => {
    expect(() => prepareOpenAIRequest(astra, { messages, reasoning_effort: 'none' })).toThrow();
    expect(() => prepareOpenAIRequest(astra, { messages: [{ role: 'user', content: 'x'.repeat(200_000) }] })).toThrow('Контекст');
    expect(() => prepareOpenAIRequest(astra, { messages, max_tokens: -1 })).toThrow();
  });
  it('returns text, function calls and token usage without exposing hidden reasoning', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'completed', output: [
      { type: 'reasoning', summary: [{ text: 'internal reasoning' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Ready' }] },
      { type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '{"path":"a"}' },
    ], usage: { input_tokens: 20, output_tokens: 15, output_tokens_details: { reasoning_tokens: 10 } } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await callOpenAIResponses(env, prepareOpenAIRequest(astra, { messages }));
    expect(result.response).toBe('Ready');
    expect(result.choices[0].message.tool_calls[0].function.name).toBe('read_file');
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 15 });
    expect(JSON.stringify(result)).not.toContain('internal reasoning');
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it('rejects a truncated response and response bodies over the bound', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'incomplete', output: [] })));
    await expect(callOpenAIResponses(env, prepareOpenAIRequest(astra, { messages }))).rejects.toThrow('завершение');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))));
    await expect(callOpenAIResponses(env, prepareOpenAIRequest(astra, { messages }))).rejects.toThrow('лимит');
  });
  it('never calls without a secret, fresh price, paid policy and an adequate budget; ambiguous response keeps reservation', async () => {
    const { db, sqlite } = sqliteD1();
    const localEnv = { AZRAIL_D1: db, AI: { run: vi.fn() }, AI_GATEWAY_ID: 'gateway' } as unknown as Env;
    const fetcher = vi.fn(async () => { throw new Error('connection lost'); }); vi.stubGlobal('fetch', fetcher);
    const invoke = () => runModel(localEnv, 'answer', { messages }, { preferredModel: 'gpt-6-astra' });
    await setModelPolicy(localEnv, true, 1);
    await expect(invoke()).rejects.toThrow('ключ');
    localEnv.OPENAI_API_KEY = 'unit-test-credential';
    await expect(invoke()).rejects.toThrow('тариф');
    sqlite.prepare('INSERT INTO model_prices VALUES(?,?,?,?)').run('gpt-6-astra', 10e6, 50e6, Date.now());
    await setModelPolicy(localEnv, true, 0.001);
    await expect(invoke()).rejects.toThrow('бюджет');
    expect(fetcher).not.toHaveBeenCalled();
    await setModelPolicy(localEnv, true, 1);
    await expect(invoke()).rejects.toThrow('неопределённый');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT status FROM model_calls").get()?.status).toBe('uncertain');
    expect(Number(sqlite.prepare('SELECT spent_micro_usd FROM spend_limits').get()?.spent_micro_usd)).toBeGreaterThan(0);
  });
});
