import type { Env } from '../types';
import { readBoundedBody } from './request-body';
import type { ModelEntry } from './model-registry';

const MAX_REQUEST_BYTES = 200_000; // Below the documented 272K long-context pricing threshold.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный объект модели.');
  return value as Record<string, unknown>;
};

/** Builds only the supported API shape; caller cannot override endpoint, model or storage. */
export function prepareOpenAIRequest(model: ModelEntry, input: Record<string, unknown>) {
  if (model.transport !== 'openai-responses') throw new Error('Модель не использует OpenAI Responses.');
  const messages = input.messages ?? (typeof input.prompt === 'string' ? [{ role: 'user', content: input.prompt }] : null);
  if (!Array.isArray(messages) || !messages.length || messages.length > 200) throw new Error('Требуется непустая история модели.');
  const items: Record<string, unknown>[] = [];
  for (const raw of messages) {
    const message = record(raw);
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') throw new Error('Некорректный результат инструмента.');
      items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(String(message.role))) throw new Error('Некорректная роль модели.');
    if (typeof message.content === 'string' && message.content.length) items.push({ role: message.role, content: message.content });
    else if (message.content != null && message.content !== '') throw new Error('Адаптер принимает текст; вложения должны быть преобразованы сервером.');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) throw new Error('Некорректные вызовы инструментов.');
      for (const rawCall of message.tool_calls) {
        const call = record(rawCall), fn = record(call.function);
        if (typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') throw new Error('Некорректный вызов инструмента.');
        items.push({ type: 'function_call', call_id: call.id, name: fn.name, arguments: fn.arguments });
      }
    }
  }
  if (!items.length) throw new Error('Пустая история модели.');
  const requested = input.max_tokens === undefined ? 4096 : Number(input.max_tokens);
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('Некорректный лимит токенов.');
  const body: Record<string, unknown> = {
    model: model.slug, input: items, store: false, stream: false,
    max_output_tokens: Math.min(32768, requested),
  };
  if (input.reasoning_effort !== undefined) {
    const effort = String(input.reasoning_effort);
    if (!model.reasoningEfforts?.some(v => v === effort)) throw new Error('Модель не поддерживает этот режим рассуждений.');
    body.reasoning = { effort };
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > 64) throw new Error('Некорректный список инструментов.');
    body.tools = input.tools.map(raw => {
      const tool = record(raw), fn = tool.function ? record(tool.function) : tool;
      if (tool.type !== 'function' || typeof fn.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name)) throw new Error('Допустимы только структурированные функции.');
      const parameters = record(fn.parameters);
      return { type: 'function', name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters, strict: fn.strict === true };
    });
    if (input.tool_choice !== undefined) {
      if (!['auto', 'none', 'required'].includes(String(input.tool_choice))) throw new Error('Неподдерживаемый выбор инструмента.');
      body.tool_choice = input.tool_choice;
    }
    body.parallel_tool_calls = false;
  }
  if (input.response_format !== undefined) {
    const format = record(input.response_format);
    if (format.type === 'json_object') body.text = { format: { type: 'json_object' } };
    else if (format.type === 'json_schema') {
      const schema = record(format.json_schema);
      if (typeof schema.name !== 'string') throw new Error('Нужно имя JSON-схемы.');
      body.text = { format: { type: 'json_schema', name: schema.name, schema: record(schema.schema), strict: schema.strict === true } };
    } else throw new Error('Неподдерживаемый формат ответа.');
  }
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) throw new Error('Контекст превышает лимит адаптера OpenAI.');
  return body;
}

/** One bounded paid request. Never retry here: an ambiguous outcome retains its reservation. */
export async function callOpenAIResponses(env: Env, body: Record<string, unknown>) {
  if (!env.OPENAI_API_KEY?.trim()) throw new Error('Серверный ключ OpenAI не настроен.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OpenAI вернул HTTP ${response.status}.`); // No echoed provider payload or credentials.
    }
    const raw = record(JSON.parse(new TextDecoder().decode(await readBoundedBody(response, MAX_RESPONSE_BYTES))));
    if (raw.status !== 'completed' || !Array.isArray(raw.output)) throw new Error('OpenAI не подтвердил завершение ответа.');
    const texts: string[] = [];
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    for (const value of raw.output) {
      const item = record(value);
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          const content = record(part);
          if (content.type === 'output_text' && typeof content.text === 'string') texts.push(content.text);
        }
      } else if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('Некорректный ответ инструмента.');
        toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      }
    }
    if (!texts.length && !toolCalls.length) throw new Error('OpenAI вернул пустой ответ.');
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    if (raw.usage) {
      const u = record(raw.usage);
      if (typeof u.input_tokens === 'number' && Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 &&
          typeof u.output_tokens === 'number' && Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0) {
        usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
      }
    }
    return { response: texts.join('\n'), choices: [{ message: { role: 'assistant', content: texts.join('\n'), tool_calls: toolCalls } }], usage };
  } finally { clearTimeout(timer); }
}
