import type { Env } from '../types';
import { AccessError, authenticate, requireResource, type Principal } from '../lib/accounts';
import { BodyLimitError, readBoundedBody } from '../lib/request-body';
import { createProject, validateProjectDescription, validateProjectName } from '../lib/projects-api';
import { withProjectLock } from '../lib/project-control';
import { chargeWrites } from '../lib/write-budget';
import { listFacts, type MemoryCategory } from '../lib/memory-agent';
import { listMessages } from '../lib/chat-store';
import { listVersions } from '../lib/versions';
import { checkDigest, checkedPath, fileText, fileBytes, mutateFile, replaceWorkspace, workspaceValues, workspaceView, WORKBENCH_LIMITS, type WorkspaceView, type WorkbenchFile } from './workbench-storage';
import { staticPreview } from './workbench-preview';
import { workbenchRuntime } from './workbench-runtime';
export { workbenchPreviewProxy, cleanupWorkbenchPreviews } from './workbench-runtime';

interface ProjectRow { id: string; name: string; description: string | null; status: 'active' | 'archived'; created_at: string; updated_at: string; revision: number }
const SELECT_PROJECT = `SELECT p.id,p.name,p.description,p.status,p.created_at,p.updated_at,COALESCE(w.revision,0) AS revision FROM projects p LEFT JOIN project_workbench w ON w.project_id=p.id`;
const projectSummary = (p: ProjectRow) => ({ id: p.id, name: p.name, description: p.description ?? undefined, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at, revision: p.revision });
const CATEGORIES = ['architecture_decision', 'code_style', 'tech_choice', 'known_issue', 'preference'];

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const bytes = await readBoundedBody(request, WORKBENCH_LIMITS.textBytes * 6 + 4096);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body as Record<string, unknown>;
  } catch (error) { if (error instanceof BodyLimitError) throw error; throw new AccessError('Ожидался JSON-объект.', 400); }
}

async function projectRow(env: Env, id: string): Promise<ProjectRow> {
  const row = await env.AZRAIL_D1.prepare(`${SELECT_PROJECT} WHERE p.id=? AND p.status<>'deleted'`).bind(id).first<ProjectRow>();
  if (!row) throw new AccessError('Проект не найден.', 404);
  return row;
}
async function projectsPage(env: Env, principal: Principal, url: URL) {
  const q = url.searchParams.get('q')?.trim() ?? '', status = url.searchParams.get('status') ?? 'active';
  const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 50 : Number(rawLimit);
  if (q.length > 120 || !['active', 'archived', 'all'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new AccessError('Некорректный поиск, status или limit (1–100).', 400);
  let after: { date: string; id: string } | null = null;
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error('size');
      const parsed = JSON.parse(atob(cursor));
      if (!parsed || typeof parsed.date !== 'string' || parsed.date.length > 64 || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)) throw new Error('cursor');
      after = parsed;
    } catch { throw new AccessError('Недопустимый cursor.', 400); }
  }
  const where = [`p.status<>'deleted'`], args: unknown[] = [];
  if (principal.role !== 'admin') { where.push(`EXISTS(SELECT 1 FROM resource_owners o WHERE o.kind='project' AND o.resource_id=p.id AND o.account_id=?)`); args.push(principal.id); }
  if (status !== 'all') { where.push('p.status=?'); args.push(status); }
  if (after) { where.push('(p.updated_at<? OR (p.updated_at=? AND p.id<?))'); args.push(after.date, after.date, after.id); }
  // Unicode case folding happens in JS: SQLite lower() only handles ASCII.
  // Scan bounded pages without dropping a cursor when a search has few hits.
  const projects: ReturnType<typeof projectSummary>[] = [];
  let nextCursor: string | null = null, scanned = 0, scanAfter = after;
  while (projects.length < limit && scanned < 5000) {
    const scanWhere = [...where], scanArgs = [...args];
    if (scanAfter && scanAfter !== after) { scanWhere.push('(p.updated_at<? OR (p.updated_at=? AND p.id<?))'); scanArgs.push(scanAfter.date, scanAfter.date, scanAfter.id); }
    const rows = (await env.AZRAIL_D1.prepare(`${SELECT_PROJECT} WHERE ${scanWhere.join(' AND ')} ORDER BY p.updated_at DESC,p.id DESC LIMIT 201`).bind(...scanArgs).all<ProjectRow>()).results;
    if (!rows.length) { nextCursor = null; break; }
    let exhausted = true;
    for (let i = 0; i < Math.min(rows.length, 200); i++) {
      const row = rows[i]; scanned++;
      scanAfter = { date: row.updated_at, id: row.id };
      if (!q || `${row.name}\n${row.description ?? ''}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())) projects.push(projectSummary(row));
      if (projects.length >= limit || scanned >= 5000) { exhausted = false; nextCursor = i + 1 < rows.length ? btoa(JSON.stringify(scanAfter)) : null; break; }
    }
    if (!exhausted) break;
    if (rows.length <= 200) { nextCursor = null; break; }
    nextCursor = btoa(JSON.stringify(scanAfter));
  }
  return { projects, nextCursor };
}

async function editMetadata(env: Env, id: string, input: Record<string, unknown>) {
  const existing = await projectRow(env, id);
  if (!Number.isSafeInteger(input.baseRevision) || Number(input.baseRevision) < 0) throw new AccessError('Нужен baseRevision проекта.', 400);
  if (input.baseRevision !== existing.revision) throw new AccessError('Проект изменился. Обновите карточку.', 409);
  const name = input.name === undefined ? existing.name : validateProjectName(input.name);
  const description = input.description === undefined ? existing.description : validateProjectDescription(input.description);
  const status = input.status ?? existing.status;
  if (status !== 'active' && status !== 'archived') throw new AccessError('status: active или archived.', 400);
  await env.AZRAIL_D1.batch([
    env.AZRAIL_D1.prepare('UPDATE projects SET name=?,description=?,status=?,updated_at=? WHERE id=?').bind(name, description, status, new Date().toISOString(), id),
    env.AZRAIL_D1.prepare('INSERT INTO project_workbench(project_id,revision) VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1').bind(id),
  ]);
  return { project: projectSummary(await projectRow(env, id)) };
}

async function memoryMutation(env: Env, id: string, method: string, body: Record<string, unknown>) {
  if (!CATEGORIES.includes(String(body.category)) || typeof body.key !== 'string' || !body.key.trim() || body.key.length > 100)
    throw new AccessError('Нужны допустимая категория и key до 100 символов.', 400);
  if (body.baseValue !== null && typeof body.baseValue !== 'string') throw new AccessError('Нужен baseValue: null для создания или прежнее значение.', 400);
  const category = body.category as MemoryCategory, key = body.key.trim();
  const existing = await env.AZRAIL_D1.prepare('SELECT value FROM project_memory WHERE project_id=? AND category=? AND key=?').bind(id, category, key).first<{ value: string }>();
  if ((existing?.value ?? null) !== body.baseValue) throw new AccessError('Запись памяти изменилась. Обновите список.', 409);
  if (method === 'DELETE') {
    if (!existing) throw new AccessError('Запись не найдена.', 404);
    await env.AZRAIL_D1.prepare('DELETE FROM project_memory WHERE project_id=? AND category=? AND key=? AND value=?').bind(id, category, key, body.baseValue).run();
  } else {
    if (typeof body.value !== 'string' || !body.value.trim() || body.value.length > 2000) throw new AccessError('value: от 1 до 2000 символов.', 400);
    const count = await env.AZRAIL_D1.prepare('SELECT COUNT(*) AS n FROM project_memory WHERE project_id=?').bind(id).first<{ n: number }>();
    if (!existing && (count?.n ?? 0) >= 200) throw new AccessError('Лимит: 200 записей памяти проекта.', 413);
    await env.AZRAIL_D1.prepare(`INSERT INTO project_memory(id,project_id,category,key,value,source_agent,updated_at) VALUES(?,?,?,?,?,'workbench',?) ON CONFLICT(project_id,category,key) DO UPDATE SET value=excluded.value,source_agent=excluded.source_agent,updated_at=excluded.updated_at`)
      .bind(crypto.randomUUID(), id, category, key, body.value.trim(), new Date().toISOString()).run();
  }
  return { facts: await listFacts(env, id, 200) };
}

async function saveVersion(env: Env, id: string, view: WorkspaceView, summary: unknown) {
  if (summary !== undefined && (typeof summary !== 'string' || summary.length > 500)) throw new AccessError('summary должен быть строкой до 500 символов.', 400);
  const versionId = crypto.randomUUID(), prefix = `projects/${id}/workbench-versions/${versionId}/`;
  const values = await workspaceValues(env, view), staged: string[] = [], manifest: WorkbenchFile[] = [];
  let registering = false;
  try {
    for (const file of values) {
      staged.push(prefix + file.path);
      const object = await env.AZRAIL_R2.put(prefix + file.path, file.content);
      if (!object) throw new Error('Snapshot write failed');
      manifest.push({ path: file.path, key: prefix + file.path, size: file.content.length, etag: object.etag });
    }
    registering = true;
    await env.AZRAIL_D1.batch([
      env.AZRAIL_D1.prepare(`INSERT INTO project_versions(id,project_id,version_number,r2_object_key,summary,created_by_agent) SELECT ?,?,COALESCE(MAX(version_number),0)+1,?,?,'workbench' FROM project_versions WHERE project_id=?`)
        .bind(versionId, id, prefix, summary ?? 'Снимок рабочей области', id),
      env.AZRAIL_D1.prepare('INSERT INTO workbench_version_manifests(version_id,project_id,manifest_json) VALUES(?,?,?)').bind(versionId, id, JSON.stringify(manifest)),
    ]);
  } catch (error) {
    if (!registering && staged.length) await env.AZRAIL_R2.delete(staged).catch(() => {});
    throw error;
  }
  const version = (await listVersions(env, id, 1))[0];
  return { version: { ...version, restorable: true }, sourceDigest: view.sourceDigest };
}

async function restoreWorkbenchVersion(env: Env, id: string, versionId: string, view: WorkspaceView) {
  const row = await env.AZRAIL_D1.prepare(`SELECT v.r2_object_key,m.manifest_json FROM project_versions v JOIN workbench_version_manifests m ON m.version_id=v.id AND m.project_id=v.project_id WHERE v.project_id=? AND v.id=? AND v.created_by_agent='workbench'`).bind(id, versionId).first<{ r2_object_key: string; manifest_json: string }>();
  if (!row || row.r2_object_key !== `projects/${id}/workbench-versions/${versionId}/`) throw new AccessError('Эта версия не является полным снимком рабочей области.', 409);
  let entries: WorkbenchFile[];
  try { entries = JSON.parse(row.manifest_json); } catch { throw new AccessError('Повреждённый манифест версии.', 409); }
  if (!Array.isArray(entries) || entries.length > WORKBENCH_LIMITS.files) throw new AccessError('Повреждённый манифест версии.', 409);
  let total = 0;
  for (const entry of entries) {
    if (!entry || entry.key !== row.r2_object_key + checkedPath(entry.path) || typeof entry.etag !== 'string' || !entry.etag || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new AccessError('Повреждённый снимок.', 409);
    total += entry.size;
  }
  if (new Set(entries.map(e => e.path)).size !== entries.length || total > WORKBENCH_LIMITS.bytes) throw new AccessError('Снимок превышает лимит или содержит повторяющиеся пути.', 413);
  const values = [];
  for (const entry of entries) values.push({ path: entry.path, content: await fileBytes(env, entry) });
  const backup = await saveVersion(env, id, view, `Перед восстановлением ${versionId}`);
  await replaceWorkspace(env, id, view, values);
  return { restored: values.length, backupVersionId: backup.version.id, sourceDigest: (await workspaceView(env, id)).sourceDigest };
}

/** Self-contained authenticated adapter; unknown plugin/model routes fall through. */
export async function workbenchRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), match = /^\/api\/workbench\/projects(?:\/([A-Za-z0-9_-]{1,128})(?:\/(.*))?)?$/.exec(url.pathname);
  if (!match) return null;
  const id = match[1], route = match[2] ?? '';
  if (route && !['files', 'file', 'rename', 'preview', 'runtime', 'memory', 'versions', 'chat'].includes(route) && !/^versions\/[A-Za-z0-9_-]+\/restore$/.test(route)) return null;
  try {
    const auth = await authenticate(request, env);
    if (!auth.ok || !auth.principal) return Response.json({ error: auth.error }, { status: auth.status ?? 401 });
    const principal = auth.principal, mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutating && request.headers.has('Cookie') && request.headers.get('Origin') !== url.origin) throw new AccessError('Cross-origin request blocked', 403);
    if (mutating && principal.role === 'viewer') throw new AccessError('Ваш аккаунт разрешает только просмотр.', 403);
    if (id) { await requireResource(env, principal, 'project', id); await projectRow(env, id); }
    if (mutating && !(await chargeWrites(env, 5)).allowed) throw new AccessError('Лимит записей исчерпан.', 429);
    if (!id) {
      if (request.method === 'GET') return Response.json(await projectsPage(env, principal, url));
      if (request.method === 'POST') {
        const project = await createProject(env, principal, await bodyObject(request));
        return Response.json({ project: { ...project, revision: 0 } }, { status: 201 });
      }
      return Response.json({ error: 'Метод не поддерживается.' }, { status: 405 });
    }
    if (!route && request.method === 'GET') return Response.json({ project: projectSummary(await projectRow(env, id)) });
    if (route === 'chat' && request.method === 'GET') {
      const conversation = await env.AZRAIL_D1.prepare('SELECT project_id FROM conversations WHERE id=?').bind(id).first<{ project_id: string | null }>();
      if (!conversation) return Response.json({ conversationId: id, messages: [] });
      if (conversation.project_id !== id) throw new AccessError('Диалог не относится к проекту.', 404);
      await requireResource(env, principal, 'conversation', id);
      return Response.json({ conversationId: id, messages: await listMessages(env, id, 200) });
    }
    if (route === 'memory' && request.method === 'GET') return Response.json({ facts: await listFacts(env, id, 200) });
    if (route === 'versions' && request.method === 'GET') return Response.json({ versions: (await listVersions(env, id)).map(v => ({ ...v, restorable: v.createdByAgent === 'workbench' })) });
    const input = mutating ? await bodyObject(request) : {};
    return await withProjectLock(env, id, `workbench:${crypto.randomUUID()}`, async () => {
      if (!route && request.method === 'PATCH') return Response.json(await editMetadata(env, id, input));
      if (mutating && (await projectRow(env, id)).status === 'archived') throw new AccessError('Сначала верните проект из архива.', 409);
      if (route === 'memory' && ['PUT', 'DELETE'].includes(request.method)) return Response.json(await memoryMutation(env, id, request.method, input));
      if (route === 'file' && ['PUT', 'DELETE'].includes(request.method)) return Response.json(await mutateFile(env, id, request.method === 'PUT' ? 'put' : 'delete', input));
      if (route === 'rename' && request.method === 'POST') return Response.json(await mutateFile(env, id, 'rename', input));
      const view = await workspaceView(env, id);
      if (route === 'files' && request.method === 'GET') return Response.json({ files: view.files.map(f => ({ path: f.path, size: f.size, uploaded: f.uploaded })), sourceDigest: view.sourceDigest });
      if (route === 'file' && request.method === 'GET') {
        const path = checkedPath(url.searchParams.get('path')), entry = view.files.find(f => f.path === path);
        if (!entry) throw new AccessError('Файл не найден.', 404);
        return Response.json({ path, content: await fileText(env, entry), sourceDigest: view.sourceDigest });
      }
      if (route === 'preview' && request.method === 'GET') return Response.json(await staticPreview(env, view, url.searchParams.get('path')));
      if (route === 'runtime' && request.method === 'POST') return workbenchRuntime(request, env, principal, id, view, input);
      if (route === 'versions' && request.method === 'POST') { checkDigest(view, input.baseDigest); return Response.json(await saveVersion(env, id, view, input.summary), { status: 201 }); }
      if (/^versions\/[^/]+\/restore$/.test(route) && request.method === 'POST') { checkDigest(view, input.baseDigest); return Response.json(await restoreWorkbenchVersion(env, id, route.split('/')[1], view)); }
      return Response.json({ error: 'Метод не поддерживается.' }, { status: 405 });
    });
  } catch (error) {
    const status = error instanceof AccessError ? error.status : error instanceof BodyLimitError ? 413 : error instanceof TypeError ? 400 : 503;
    return Response.json({ error: status === 503 ? 'Рабочая область недоступна. Проверьте журнал сервера.' : (error as Error).message }, { status });
  }
}
