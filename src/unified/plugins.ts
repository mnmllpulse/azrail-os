import type { Env } from '../types';
import { AccessError, authenticate, requireResource } from '../lib/accounts';
import { readJsonRecord } from './request-json';
import { connectorPolicies, toolRisk } from './connector-policy';
import { parseInstallations, pluginCatalog, projectPluginOwner, readProjectPlugins, type ProjectPlugin } from './plugin-policy';
import type { MCPTool } from './mcp-client';

interface CatalogConnection { id: string; endpoint_key: string; label: string; revision: number; verified_at: number | null; tools_json: string }

async function connections(env: Env, account: string) {
  const policies = connectorPolicies(env);
  const rows = await env.AZRAIL_D1.prepare('SELECT id,endpoint_key,label,revision,verified_at,tools_json FROM connector_connections WHERE account_id=? AND disabled=0 ORDER BY updated_at DESC LIMIT 100').bind(account).all<CatalogConnection>();
  return rows.results.flatMap(c => {
    const policy = policies.find(p => p.id === c.endpoint_key);
    if (!policy) return [];
    const fresh = c.verified_at !== null && c.verified_at > Date.now() - 86400000;
    const tools = fresh ? (JSON.parse(c.tools_json) as MCPTool[]).filter(t => toolRisk(policy, t.name) !== 'blocked').map(t => ({ name: t.name, description: t.description, risk: toolRisk(policy, t.name) })) : [];
    return [{ id: c.id, endpointKey: c.endpoint_key, label: c.label, revision: c.revision, verifiedAt: c.verified_at, tools }];
  });
}

async function validateInstallations(env: Env, account: string, value: unknown): Promise<ProjectPlugin[]> {
  const plugins = parseInstallations(value), catalog = pluginCatalog(env), available = await connections(env, account);
  return plugins.map(p => {
    const manifest = catalog.find(m => m.id === p.id);
    // A retired plugin may be removed, or retained disabled to preserve the UI
    // record. It can never gain capabilities merely from persisted JSON.
    if (!manifest) {
      if (p.enabled) throw new AccessError('Плагин отсутствует в каталоге оператора.', 400);
      return { id: p.id, enabled: false, version: p.version ?? '1.0.0', allowedTools: [], connectionIds: [] };
    }
    if (p.version !== undefined && p.version !== manifest.version) throw new AccessError('Версия плагина изменилась. Обновите каталог.', 409);
    if (manifest.kind === 'skill') {
      if (p.connectionIds?.length) throw new AccessError('Встроенный сценарий не принимает подключения.', 400);
      const allowedTools = p.allowedTools ?? manifest.tools;
      if (allowedTools.some(t => !manifest.tools.includes(t))) throw new AccessError('Возможность не входит в манифест сценария.', 400);
      return { id: p.id, enabled: p.enabled, version: manifest.version, allowedTools };
    }
    if (p.enabled && (!p.connectionIds?.length || p.allowedTools === undefined)) throw new AccessError('Выберите подключения и разрешённые инструменты плагина.', 400);
    const chosen = (p.connectionIds ?? []).map(id => {
      const c = available.find(c => c.id === id && c.endpointKey === manifest.endpointKey);
      if (!c) throw new AccessError('Подключение недоступно владельцу проекта.', 404);
      return c;
    });
    const allowedTools = p.allowedTools ?? [];
    if (p.enabled && allowedTools.some(t => !chosen.some(c => c.tools.some(d => d.name === t)))) throw new AccessError('Инструмент не найден в проверенных подключениях. Обновите каталог сервиса.', 400);
    return { id: p.id, enabled: p.enabled, version: manifest.version, connectionIds: p.connectionIds ?? [], allowedTools };
  });
}

export async function pluginRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const match = path.match(/^\/api\/workbench\/projects\/([A-Za-z0-9_-]{1,128})\/plugins$/);
  if (path !== '/api/plugins/catalog' && !match) return null;
  const auth = await authenticate(request, env);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
  const principal = auth.principal!;
  if (path === '/api/plugins/catalog') {
    if (request.method !== 'GET') throw new AccessError('Метод недоступен.', 405);
    return Response.json({ plugins: pluginCatalog(env), connections: await connections(env, principal.id) });
  }
  const project = match![1];
  await requireResource(env, principal, 'project', project);
  const account = await projectPluginOwner(env, project);
  if (request.method === 'GET') return Response.json(await readProjectPlugins(env, project));
  if (request.method !== 'PUT') throw new AccessError('Метод недоступен.', 405);
  if (principal.role === 'viewer') throw new AccessError('Роль разрешает только чтение.');
  const body = await readJsonRecord(request, 32000);
  if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0 || Object.keys(body).some(k => !['baseRevision', 'plugins'].includes(k))) throw new AccessError('Неверная версия настроек плагинов.', 400);
  const plugins = await validateInstallations(env, account, body.plugins), now = Date.now();
  const row = body.baseRevision === 0
    ? await env.AZRAIL_D1.prepare('INSERT INTO project_plugin_policies(project_id,revision,plugins_json,updated_at) VALUES(?,1,?,?) ON CONFLICT DO NOTHING RETURNING revision').bind(project, JSON.stringify(plugins), now).first<{ revision: number }>()
    : await env.AZRAIL_D1.prepare('UPDATE project_plugin_policies SET revision=revision+1,plugins_json=?,updated_at=? WHERE project_id=? AND revision=? RETURNING revision').bind(JSON.stringify(plugins), now, project, body.baseRevision).first<{ revision: number }>();
  if (!row) throw new AccessError('Плагины изменены в другой вкладке. Обновите настройки.', 409);
  return Response.json({ plugins, revision: row.revision, configured: true });
}
