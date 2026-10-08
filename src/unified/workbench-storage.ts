import type { Env } from '../types';
import { AccessError, hashToken } from '../lib/accounts';
import { readBoundedBody } from '../lib/request-body';
import { workspacePath, workspacePrefix, storedWorkspacePath, logicalWorkspacePath } from '../lib/workspace-head';

export const WORKBENCH_LIMITS = { files: 400, bytes: 16 * 1024 * 1024, textBytes: 1024 * 1024 } as const;
export interface WorkbenchFile { path: string; key: string; size: number; etag: string; uploaded?: Date }
export interface WorkspaceView { prefix: string; files: WorkbenchFile[]; sourceDigest: string; bytes: number }

export function checkedPath(value: unknown): string {
  try {
    const path = workspacePath(value);
    if (/^[A-Za-z]:/.test(path)) throw new Error('absolute path');
    return path;
  } catch { throw new AccessError('Нужен относительный путь без .., обратных слешей и управляющих символов.', 400); }
}

/** Callers hold the existing project lock, shared with missions and backups. */
export async function workspaceView(env: Env, project: string): Promise<WorkspaceView> {
  const prefix = await workspacePrefix(env, project);
  const files: WorkbenchFile[] = [], seen = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  do {
    const page = await env.AZRAIL_R2.list({ prefix, cursor, limit: WORKBENCH_LIMITS.files + 1 - files.length });
    for (const entry of page.objects) {
      if (!entry.key.startsWith(prefix) || !entry.etag || !Number.isSafeInteger(entry.size) || entry.size < 0)
        throw new AccessError('Не удалось проверить состав рабочей области.', 409);
      const path = checkedPath(logicalWorkspacePath(prefix, entry.key.slice(prefix.length)));
      bytes += entry.size;
      files.push({ path, key: entry.key, size: entry.size, etag: entry.etag, uploaded: entry.uploaded });
      if (files.length > WORKBENCH_LIMITS.files || bytes > WORKBENCH_LIMITS.bytes)
        throw new AccessError('Рабочая область превышает лимит: 400 файлов / 16 МиБ.', 413);
    }
    if (!page.truncated) break;
    if (!page.cursor || seen.has(page.cursor)) throw new AccessError('Неполный список файлов.', 409);
    seen.add(page.cursor); cursor = page.cursor;
  } while (true);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map(f => f.path)).size !== files.length) throw new AccessError('Повторяющиеся пути файлов.', 409);
  return { prefix, files, bytes, sourceDigest: await hashToken(JSON.stringify([prefix, files.map(f => [f.path, f.size, f.etag])])) };
}

export function checkDigest(view: WorkspaceView, digest: unknown): void {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new AccessError('Нужен baseDigest прочитанной рабочей области.', 400);
  if (view.sourceDigest !== digest) throw new AccessError('Файлы изменились. Обновите редактор и сравните изменения.', 409);
}

export async function fileBytes(env: Env, entry: WorkbenchFile, cap = WORKBENCH_LIMITS.bytes): Promise<Uint8Array> {
  if (entry.size > cap) throw new AccessError('Файл превышает лимит чтения.', 413);
  const object = await env.AZRAIL_R2.get(entry.key);
  if (!object || object.etag !== entry.etag) throw new AccessError('Файл изменился во время чтения.', 409);
  const bytes = await readBoundedBody(new Response(object.body), cap);
  if (bytes.length !== entry.size) throw new AccessError('Размер файла изменился во время чтения.', 409);
  return bytes;
}

export async function fileText(env: Env, entry: WorkbenchFile): Promise<string> {
  const bytes = await fileBytes(env, entry, WORKBENCH_LIMITS.textBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary');
    return text;
  } catch { throw new AccessError('Редактор поддерживает текстовые файлы UTF-8.', 415); }
}

export async function workspaceValues(env: Env, view: WorkspaceView) {
  const values: Array<{ path: string; content: Uint8Array }> = [];
  for (const entry of view.files) values.push({ path: entry.path, content: await fileBytes(env, entry) });
  return values;
}

export async function mutateFile(env: Env, project: string, operation: 'put' | 'delete' | 'rename', input: Record<string, unknown>) {
  const path = checkedPath(input.path), view = await workspaceView(env, project);
  checkDigest(view, input.baseDigest);
  const existing = view.files.find(f => f.path === path);
  if (operation === 'put') {
    if (typeof input.content !== 'string') throw new AccessError('content должен быть строкой.', 400);
    const bytes = new TextEncoder().encode(input.content).length;
    if (bytes > WORKBENCH_LIMITS.textBytes || view.bytes - (existing?.size ?? 0) + bytes > WORKBENCH_LIMITS.bytes || !existing && view.files.length >= WORKBENCH_LIMITS.files)
      throw new AccessError('Превышен лимит файла (1 МиБ) или рабочей области (400 файлов / 16 МиБ).', 413);
    // R2 replaces one object atomically; the project lock prevents engine races.
    await env.AZRAIL_R2.put(view.prefix + storedWorkspacePath(view.prefix, path), input.content, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  } else {
    if (!existing) throw new AccessError('Файл не найден.', 404);
    if (operation === 'delete') await env.AZRAIL_R2.delete(existing.key);
    else {
      const newPath = checkedPath(input.newPath);
      if (path === newPath) return { path, sourceDigest: view.sourceDigest };
      if (view.files.some(f => f.path === newPath)) throw new AccessError('Файл с таким именем уже существует.', 409);
      // Publish a complete head only after every object is copied. A failed
      // rename can never remove the source or leave a half-published workspace.
      const values = await workspaceValues(env, view);
      await replaceWorkspace(env, project, view, values.map(f => ({ ...f, path: f.path === path ? newPath : f.path })));
      return { path: newPath, sourceDigest: (await workspaceView(env, project)).sourceDigest };
    }
  }
  return { path, sourceDigest: (await workspaceView(env, project)).sourceDigest };
}

export async function replaceWorkspace(env: Env, project: string, previous: WorkspaceView, values: Array<{ path: string; content: Uint8Array }>) {
  const prefix = `projects/${project}/workspace-versions/${crypto.randomUUID()}/`, staged: string[] = [];
  let publishing = false;
  try {
    for (const file of values) {
      const key = prefix + checkedPath(file.path);
      staged.push(key); await env.AZRAIL_R2.put(key, file.content);
    }
    publishing = true;
    await env.AZRAIL_D1.prepare('INSERT INTO workspace_heads(project_id,prefix) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET prefix=excluded.prefix').bind(project, prefix).run();
  } catch (error) {
    // Once D1 publication was attempted, an ambiguous error must retain staged
    // objects; deleting them could erase a head whose write actually succeeded.
    if (!publishing && staged.length) await env.AZRAIL_R2.delete(staged).catch(() => {});
    throw error;
  }
  // Old heads are working storage, never named version snapshots. Cleanup after
  // publication is best effort and cannot change the new source of truth.
  if (previous.files.length) await env.AZRAIL_R2.delete(previous.files.map(f => f.key)).catch(() => {});
}
