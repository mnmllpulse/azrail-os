import type { Env } from '../types';
import { AccessError, authenticate, requireResource } from '../lib/accounts';
import { readJsonRecord } from './request-json';
import { MODEL_REGISTRY, findModel, type ReasoningEffort } from '../lib/model-registry';
import { FREE_MODEL_SLUGS, hasFreshModelPrice, modelBlockReason, readModelPolicy } from '../lib/model-policy';
import { DEFAULT_MISSION_ITERATIONS, MAX_MISSION_ITERATIONS } from '../lib/mission-limits';

export { withModelSettings } from '../lib/model-settings-context';
export interface ProjectModelSettings {
  preferredModel?: string;
  reasoningEffort?: ReasoningEffort;
  maxIterations?: number;
  maxCostUsd?: number;
}
const keys = ['preferredModel', 'reasoningEffort', 'maxIterations', 'maxCostUsd'] as const;
function budgetCap(env: Env) {
  const value = Number(env.AZRAIL_MISSION_BUDGET_USD ?? '1');
  if (!Number.isFinite(value) || value <= 0 || value > 1000) throw new AccessError('Бюджет сервера не настроен.', 503);
  return value;
}
function validateSettings(value: unknown, env: Env): ProjectModelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError('Некорректные настройки модели.', 400);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.some(k => k === key))) throw new AccessError('Неизвестное поле настроек модели.', 400);
  const result: ProjectModelSettings = {};
  if (raw.preferredModel !== undefined) {
    if (typeof raw.preferredModel !== 'string' || !findModel(raw.preferredModel)?.capabilities.includes('text_generation')) throw new AccessError('Неизвестная текстовая модель.', 400);
    result.preferredModel = raw.preferredModel;
  }
  if (raw.reasoningEffort !== undefined) {
    const model = result.preferredModel ? findModel(result.preferredModel) : undefined;
    if (typeof raw.reasoningEffort !== 'string' || !model?.reasoningEfforts?.some(e => e === raw.reasoningEffort)) throw new AccessError('Режим рассуждений не поддерживается выбранной моделью.', 400);
    result.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
  }
  if (raw.maxIterations !== undefined) {
    if (!Number.isSafeInteger(raw.maxIterations) || Number(raw.maxIterations) < 1 || Number(raw.maxIterations) > MAX_MISSION_ITERATIONS) throw new AccessError(`Число шагов: от 1 до ${MAX_MISSION_ITERATIONS}.`, 400);
    result.maxIterations = Number(raw.maxIterations);
  }
  if (raw.maxCostUsd !== undefined) {
    if (typeof raw.maxCostUsd !== 'number' || !Number.isFinite(raw.maxCostUsd) || raw.maxCostUsd < 0.000001 || raw.maxCostUsd > budgetCap(env)) throw new AccessError(`Бюджет задачи должен быть больше нуля и не больше ${budgetCap(env)} USD.`, 400);
    result.maxCostUsd = Math.floor(raw.maxCostUsd * 1e6) / 1e6;
  }
  return result;
}
export async function readProjectModelSettings(env: Env, projectId: string) {
  const row = await env.AZRAIL_D1.prepare('SELECT settings_json,revision FROM project_model_settings WHERE project_id=?').bind(projectId).first<{ settings_json: string; revision: number }>();
  // Missing migration/storage errors intentionally propagate, never silently discard saved policy.
  const raw = row ? JSON.parse(row.settings_json) as ProjectModelSettings : {};
  if (raw.maxCostUsd !== undefined) raw.maxCostUsd = Math.min(raw.maxCostUsd, budgetCap(env));
  return { settings: validateSettings(raw, env), revision: row?.revision ?? 0 };
}

/** Call only after project ownership authorization, before admissions/write reservations. */
export async function normalizeProjectModelRequest(env: Env, projectId: string, body: Record<string, unknown>): Promise<ProjectModelSettings> {
  const { settings } = await readProjectModelSettings(env, projectId);
  const override: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) override[key] = body[key];
  // A different explicit model must choose its own supported effort, not inherit an incompatible one.
  if (override.preferredModel !== undefined && override.preferredModel !== settings.preferredModel && override.reasoningEffort === undefined) delete settings.reasoningEffort;
  const merged = validateSettings({ ...settings, ...override }, env);
  if (merged.preferredModel) {
    const model = findModel(merged.preferredModel)!;
    const reason = modelBlockReason(model, await readModelPolicy(env), env);
    if (reason) throw new AccessError(reason, 409);
    if (!FREE_MODEL_SLUGS.has(model.slug) && !await hasFreshModelPrice(env, model.slug)) throw new AccessError('Нет свежего проверенного тарифа модели.', 409);
  }
  return { ...merged, maxIterations: merged.maxIterations ?? DEFAULT_MISSION_ITERATIONS, maxCostUsd: merged.maxCostUsd ?? budgetCap(env) };
}

export async function modelSettingsRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), catalog = url.pathname === '/api/workbench/models';
  const match = url.pathname.match(/^\/api\/workbench\/projects\/([^/]+)\/model$/);
  if (!catalog && !match) return null;
  const auth = await authenticate(request, env);
  if (!auth.ok || !auth.principal) throw new AccessError('Войдите в аккаунт.', 401);
  if (catalog) {
    if (request.method !== 'GET') throw new AccessError('Метод не поддерживается.', 405);
    const policy = await readModelPolicy(env), models = [];
    for (const model of MODEL_REGISTRY.filter(m => m.capabilities.includes('text_generation'))) {
      let unavailableReason = modelBlockReason(model, policy, env);
      const freshPrice = FREE_MODEL_SLUGS.has(model.slug) || await hasFreshModelPrice(env, model.slug);
      if (!unavailableReason && !freshPrice) unavailableReason = 'Нет свежего проверенного тарифа';
      models.push({ id: model.slug, slug: model.slug, name: model.displayName ?? model.slug, provider: model.provider,
        tier: model.tier, capabilities: model.capabilities, contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens, reasoningEfforts: model.reasoningEfforts ?? [],
        transport: model.transport ?? (model.requiresGateway ? 'cloudflare-gateway' : 'workers-ai'),
        available: !unavailableReason, unavailableReason, referencePrice: model.referencePrice,
        priceVerified: freshPrice, source: model.source });
    }
    return Response.json({ models, configuration: { openaiConfigured: !!env.OPENAI_API_KEY?.trim(), gatewayConfigured: !!env.AI_GATEWAY_ID,
      paidModelsEnabled: policy.allowThirdPartyModels, policyReady: policy.ready, forceFree: policy.forceFree,
      maxIterations: MAX_MISSION_ITERATIONS, defaultIterations: DEFAULT_MISSION_ITERATIONS, maxCostUsd: budgetCap(env) } });
  }
  const projectId = decodeURIComponent(match![1]);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new AccessError('Некорректный проект.', 400);
  await requireResource(env, auth.principal, 'project', projectId);
  if (request.method === 'GET') return Response.json(await readProjectModelSettings(env, projectId));
  if (request.method !== 'PUT') throw new AccessError('Метод не поддерживается.', 405);
  if (auth.principal.role === 'viewer') throw new AccessError('Роль разрешает только чтение.');
  const body = await readJsonRecord(request, 16 * 1024);
  if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) throw new AccessError('Требуется baseRevision.', 400);
  const settings = validateSettings(body.settings, env), revision = Number(body.baseRevision), now = Date.now();
  const result = revision === 0
    ? await env.AZRAIL_D1.prepare('INSERT INTO project_model_settings(project_id,settings_json,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT DO NOTHING RETURNING revision').bind(projectId, JSON.stringify(settings), now).first<{ revision: number }>()
    : await env.AZRAIL_D1.prepare('UPDATE project_model_settings SET settings_json=?,revision=revision+1,updated_at=? WHERE project_id=? AND revision=? RETURNING revision').bind(JSON.stringify(settings), now, projectId, revision).first<{ revision: number }>();
  if (!result) throw new AccessError('Настройки изменены в другом окне. Обновите их перед сохранением.', 409);
  return Response.json({ settings, revision: result.revision });
}
