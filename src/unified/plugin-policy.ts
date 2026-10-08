import type { Env } from '../types';
import { AccessError, activeAccount } from '../lib/accounts';
import { connectorPolicies, toolRisk } from './connector-policy';
import { TOOL_REGISTRY } from '../lib/tool-registry';

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  kind: 'skill' | 'connector';
  tools: string[];
  endpointKey?: string;
  skill?: { id: string; name: string; description: string };
}
export interface ProjectPlugin {
  id: string;
  version?: string;
  enabled: boolean;
  connectionIds?: string[];
  allowedTools?: string[];
}
export interface ProjectPluginPolicy { plugins: ProjectPlugin[]; revision: number; configured: boolean }

const reader = ['read_file', 'list_files', 'search_files', 'git_diff', 'call_model'];
const skills = [
  { id: 'builtin.app-builder', name: 'Создание приложения', description: 'Изучить проект, внести проверяемые изменения и показать результат.', tools: [...reader, 'write_file', 'edit_file', 'apply_patch', 'run_tests', 'sandbox_test', 'sandbox_exec', 'sandbox_preview'],
    instructions: 'Изучи файлы, зависимости и инструкции проекта. Составь небольшой план. Сохраняй существующие данные и API. Правь существующие файлы точечно. Проверь доступными реальными тестами и сборкой. Покажи изменения и отдельно укажи непроверенное. Публикация требует явного действия владельца.' },
  { id: 'builtin.code-review', name: 'Проверка кода', description: 'Найти подтверждённые ошибки с путями и объяснением последствий.', tools: reader,
    instructions: 'Прочитай изменённые файлы и связанные вызовы. Проверь границы аккаунта, проекта, ошибок и конкурентных запросов. Сообщай конкретные воспроизводимые дефекты с путём файла и причиной. Не редактируй файлы в рамках этого сценария. Отделяй доказанные ошибки от недостающей проверки.' },
  { id: 'builtin.release-check', name: 'Подготовка выпуска', description: 'Проверить тесты, сборку и ограничения перед выпуском.', tools: [...reader, 'run_tests', 'sandbox_test'],
    instructions: 'Изучи команды проверки и конфигурацию проекта. Выполни доступные реальные проверки через разрешённую песочницу или CI. Не считай текст модели или статический просмотр доказательством запуска. Укажи успешные, проваленные и недоступные проверки. Подготовь список блокеров выпуска. Не публикуй приложение.' },
] as const;

/** Only shipped, reviewed instructions are executable skills. Remote manifests
 * never supply JS, URLs to fetch, model system prompts or credentials. */
export function pluginCatalog(env: Env): PluginManifest[] {
  const builtins: PluginManifest[] = skills.map(s => ({ manifestVersion: 1, id: s.id, version: '1.0.0', name: s.name, description: s.description, kind: 'skill', tools: [...s.tools], skill: { id: s.id, name: s.name, description: s.description } }));
  const connectors: PluginManifest[] = connectorPolicies(env).map(p => ({ manifestVersion: 1, id: `mcp:${p.id}`, version: '1.0.0', name: p.name, description: 'Инструменты MCP-сервиса, разрешённого оператором. Внешние изменения требуют подтверждения.', kind: 'connector', endpointKey: p.id, tools: [] }));
  return [...builtins, ...connectors].map(validateManifest);
}

export function validateManifest(value: PluginManifest): PluginManifest {
  if (value.manifestVersion !== 1 || !/^(builtin\.[a-z-]+|mcp:[A-Za-z0-9_.-]{1,128})$/.test(value.id) || !/^\d+\.\d+\.\d+$/.test(value.version) || !value.name || value.name.length > 80 || !value.description || value.description.length > 500 || !['skill', 'connector'].includes(value.kind) || !Array.isArray(value.tools) || value.tools.length > 50 || value.tools.some(t => !TOOL_REGISTRY.some(d => d.name === t)) || new Set(value.tools).size !== value.tools.length) throw new AccessError('Некорректный манифест плагина.', 503);
  if (value.kind === 'skill' && (!value.skill || value.skill.id !== value.id || !value.id.startsWith('builtin.')) || value.kind === 'connector' && value.id !== `mcp:${value.endpointKey}`) throw new AccessError('Некорректный тип плагина.', 503);
  return value;
}

export async function readProjectPlugins(env: Env, project?: string): Promise<ProjectPluginPolicy> {
  if (!project) return { plugins: [], revision: 0, configured: false };
  const row = await env.AZRAIL_D1.prepare('SELECT revision,plugins_json FROM project_plugin_policies WHERE project_id=?').bind(project).first<{ revision: number; plugins_json: string }>();
  if (!row) return { plugins: [], revision: 0, configured: false };
  // Corruption never becomes the legacy allow-all policy.
  let plugins: unknown;
  try { plugins = JSON.parse(row.plugins_json); } catch { throw new AccessError('Политика плагинов повреждена.', 503); }
  return { plugins: parseInstallations(plugins), revision: row.revision, configured: true };
}

function stringList(value: unknown, limit: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || !pattern.test(v)) || new Set(value).size !== value.length) throw new AccessError('Некорректный список возможностей плагина.', 400);
  return value as string[];
}
export function parseInstallations(value: unknown): ProjectPlugin[] {
  if (!Array.isArray(value) || value.length > 100) throw new AccessError('Нужен список установленных плагинов.', 400);
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AccessError('Некорректная установка плагина.', 400);
    const p = item as Record<string, unknown>;
    if (Object.keys(p).some(k => !['id', 'version', 'enabled', 'connectionIds', 'allowedTools'].includes(k)) || typeof p.id !== 'string' || !/^(builtin\.[a-z-]+|mcp:[A-Za-z0-9_.-]{1,128})$/.test(p.id) || seen.has(p.id) || typeof p.enabled !== 'boolean' || p.version !== undefined && (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(p.version))) throw new AccessError('Некорректная установка плагина.', 400);
    seen.add(p.id);
    return { id: p.id, enabled: p.enabled, ...(p.version === undefined ? {} : { version: p.version as string }), ...(p.connectionIds === undefined ? {} : { connectionIds: stringList(p.connectionIds, 30, /^[A-Za-z0-9_-]{1,128}$/) }), ...(p.allowedTools === undefined ? {} : { allowedTools: stringList(p.allowedTools, 200, /^[A-Za-z0-9_.:-]{1,128}$/) }) };
  });
}

export async function projectPluginOwner(env: Env, project: string): Promise<string> {
  const row = await env.AZRAIL_D1.prepare("SELECT account_id FROM resource_owners WHERE kind='project' AND resource_id=?").bind(project).first<{ account_id: string }>();
  if (!row || !await activeAccount(env, row.account_id)) throw new AccessError('Нет активного владельца проекта.');
  return row.account_id;
}

export function pluginAllowsTool(env: Env, policy: ProjectPluginPolicy, tool: string): boolean {
  if (!policy.configured) return true;
  const catalog = pluginCatalog(env);
  return policy.plugins.some(p => {
    if (!p.enabled) return false;
    const manifest = catalog.find(m => m.id === p.id);
    if (!manifest || p.version !== manifest.version) return false;
    if (manifest.kind === 'connector') return ['connector_search', 'connector_call', 'connector_status'].includes(tool) && !!p.connectionIds?.length && !!p.allowedTools?.length;
    return manifest.tools.includes(tool) && !!p.allowedTools?.includes(tool);
  });
}

export async function requirePluginTool(env: Env, project: string | undefined, tool: string): Promise<void> {
  if (!pluginAllowsTool(env, await readProjectPlugins(env, project), tool)) throw new AccessError(`Инструмент ${tool} отключён в плагинах проекта.`);
}

export function projectAllowsConnector(policy: ProjectPluginPolicy, endpointKey: string, connectionId: string, tool: string): boolean {
  if (!policy.configured) return true;
  const installation = policy.plugins.find(p => p.id === `mcp:${endpointKey}` && p.version === '1.0.0' && p.enabled);
  return !!installation?.connectionIds?.includes(connectionId) && !!installation.allowedTools?.includes(tool);
}

export async function requireProjectConnectorTool(env: Env, project: string, account: string, connectionId: string, tool: string): Promise<number> {
  if (await projectPluginOwner(env, project) !== account) throw new AccessError('Подключение недоступно этому проекту.', 404);
  const policy = await readProjectPlugins(env, project);
  const row = await env.AZRAIL_D1.prepare('SELECT endpoint_key FROM connector_connections WHERE id=? AND account_id=? AND disabled=0').bind(connectionId, account).first<{ endpoint_key: string }>();
  if (!row) throw new AccessError('Подключение недоступно.', 404);
  const provider = connectorPolicies(env).find(p => p.id === row.endpoint_key);
  if (!provider || toolRisk(provider, tool) === 'blocked') throw new AccessError('Инструмент запрещён оператором.');
  if (!projectAllowsConnector(policy, row.endpoint_key, connectionId, tool)) throw new AccessError('Инструмент или подключение не разрешены в этом проекте.');
  return policy.revision;
}

/** Resolve instructions on demand from trusted bundled content. An enabled
 * integration alone cannot install model instructions. */
export async function selectedProjectSkills(env: Env, project: string, value: unknown): Promise<string> {
  if (value === undefined) return '';
  const ids = stringList(value, 3, /^builtin\.[a-z-]+$/);
  const policy = await readProjectPlugins(env, project);
  return ids.map(id => {
    const installation = policy.plugins.find(p => p.id === id && p.enabled && p.version === '1.0.0');
    const skill = skills.find(s => s.id === id);
    if (!installation || !skill) throw new AccessError('Сценарий не установлен или отключён в проекте.', 400);
    return `СЦЕНАРИЙ ${skill.name} (1.0.0):\n${skill.instructions}`;
  }).join('\n\n');
}
