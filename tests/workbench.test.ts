import { describe, expect, it, vi } from 'vitest';
import { workbenchFixture } from './workbench-fixture';

describe('project workbench with real SQLite', () => {
  it('creates owned projects and rejects stale metadata writes and cross-account access', async () => {
    const t = workbenchFixture(), alice = t.account('alice'), bob = t.account('bob');
    const created = await t.call('', 'POST', { name: ' Приложение ', description: 'Первое' }, alice);
    expect(created.status).toBe(201); expect(created.body.project).toMatchObject({ name: 'Приложение', revision: 0 });
    const id = created.body.project.id;
    expect((await t.call(`/${id}`, 'GET', undefined, bob)).status).toBe(404);
    expect((await t.call(`/${id}`, 'PATCH', { name: 'Новое', baseRevision: 0 }, alice)).body.project.revision).toBe(1);
    expect((await t.call(`/${id}`, 'PATCH', { name: 'Потерянная правка', baseRevision: 0 }, alice)).status).toBe(409);
    expect((await t.call('', 'GET', undefined, bob)).body.projects).toEqual([]);
    expect((await t.call(`/${id}`, 'GET', undefined, alice)).body.project.name).toBe('Новое');
  });
  it('searches Cyrillic case-insensitively and paginates stable ties without leaking owners', async () => {
    const t = workbenchFixture(), token = t.account('alice');
    for (let i = 0; i < 205; i++) t.project(`p${String(i).padStart(3, '0')}`, 'alice', i === 0 ? 'Ядро AZRAIL' : 'Проект');
    t.project('secret', 'bob', 'Ядро секрет');
    const search = await t.call('?q=ядро', 'GET', undefined, token);
    expect(search.body.projects.map((p: any) => p.id)).toEqual(['p000']); expect(search.body.nextCursor).toBeNull();
    const first = await t.call('?limit=2', 'GET', undefined, token);
    const second = await t.call(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, 'GET', undefined, token);
    expect([...first.body.projects, ...second.body.projects].map(p => p.id)).toEqual(['p204', 'p203', 'p202', 'p201']);
    expect((await t.call('?cursor=invalid', 'GET', undefined, token)).status).toBe(400);
  });
  it('enforces viewer, CSRF, archived-project and project-lock protections', async () => {
    const t = workbenchFixture(), viewer = t.account('viewer', 'viewer'); t.project('p', 'viewer');
    expect((await t.call('/p/files', 'GET', undefined, viewer)).status).toBe(200);
    expect((await t.call('/p', 'PATCH', { baseRevision: 0, name: 'x' }, viewer)).status).toBe(403);
    expect((await t.call('/p', 'PATCH', { baseRevision: 0 }, undefined, { Cookie: 'x=y', Origin: 'https://evil.invalid' })).status).toBe(403);
    await t.call('/p', 'PATCH', { baseRevision: 0, status: 'archived' });
    const digest = (await t.call('/p/files')).body.sourceDigest;
    expect((await t.call('/p/file', 'PUT', { path: 'x', content: 'x', baseDigest: digest })).status).toBe(409);
    t.sqlite.prepare('INSERT INTO operation_locks(project_id,owner,started_at) VALUES(?,?,?)').run('p', 'mission', Date.now());
    expect((await t.call('/p/files')).status).toBe(409);
  });
  it('binds file CAS to a whole project and rejects stale saves, traversal and binary edits', async () => {
    const t = workbenchFixture(); t.project('p'); t.project('other');
    const initial = (await t.call('/p/files')).body.sourceDigest;
    const saved = await t.call('/p/file', 'PUT', { path: 'src/тест.ts', content: 'export const x = 1;', baseDigest: initial });
    expect(saved.status).toBe(200);
    expect((await t.call('/p/file', 'PUT', { path: 'src/тест.ts', content: 'stale', baseDigest: initial })).status).toBe(409);
    expect((await t.call('/other/file', 'PUT', { path: 'x', content: 'x', baseDigest: saved.body.sourceDigest })).status).toBe(409);
    expect((await t.call('/p/file', 'PUT', { path: '../escape', content: 'x', baseDigest: saved.body.sourceDigest })).status).toBe(400);
    expect((await t.call('/p/file?path=src%2F%D1%82%D0%B5%D1%81%D1%82.ts')).body.content).toBe('export const x = 1;');
    await t.r2.put('projects/p/workspace/binary.bin', new Uint8Array([0, 255]));
    expect((await t.call('/p/file?path=binary.bin')).status).toBe(415);
  });
  it('publishes rename atomically and does not lose sources when a copy fails', async () => {
    const t = workbenchFixture(); t.project('p');
    await t.r2.put('projects/p/workspace/a.txt', 'a'); await t.r2.put('projects/p/workspace/b.txt', 'b');
    const digest = (await t.call('/p/files')).body.sourceDigest;
    const put = t.r2.put.bind(t.r2);
    const spy = vi.spyOn(t.r2, 'put').mockImplementation(async (key, value) => { if (key.includes('workspace-versions/') && key.endsWith('/b.txt')) throw new Error('R2 unavailable'); return put(key, value); });
    expect((await t.call('/p/rename', 'POST', { path: 'a.txt', newPath: 'renamed.txt', baseDigest: digest })).status).toBe(503);
    expect((await t.call('/p/file?path=a.txt')).body.content).toBe('a');
    expect(t.sqlite.prepare('SELECT * FROM workspace_heads').all()).toHaveLength(0);
    spy.mockRestore();
    const renamed = await t.call('/p/rename', 'POST', { path: 'a.txt', newPath: 'renamed.txt', baseDigest: digest });
    expect(renamed.status).toBe(200); expect((await t.call('/p/files')).body.files.map((f: any) => f.path)).toEqual(['b.txt', 'renamed.txt']);
    expect((await t.call('/p/file', 'DELETE', { path: 'renamed.txt', baseDigest: renamed.body.sourceDigest })).status).toBe(200);
  });
  it('rejects oversized lists and streamed file content without returning partial state', async () => {
    const t = workbenchFixture(); t.project('p');
    for (let i = 0; i < 401; i++) await t.r2.put(`projects/p/workspace/${i}.txt`, 'a');
    expect((await t.call('/p/files')).status).toBe(413);
    t.objects.clear(); await t.r2.put('projects/p/workspace/big.txt', 'a'.repeat(1024 * 1024 + 1));
    expect((await t.call('/p/file?path=big.txt')).status).toBe(413);
  });
  it('stores memory with compare-and-swap and exposes empty chat safely', async () => {
    const t = workbenchFixture(); t.project('p');
    expect((await t.call('/p/chat')).body).toEqual({ conversationId: 'p', messages: [] });
    const fact = { category: 'preference', key: 'language', value: 'Русский', baseValue: null };
    expect((await t.call('/p/memory', 'PUT', fact)).body.facts[0].value).toBe('Русский');
    expect((await t.call('/p/memory', 'PUT', { ...fact, value: 'English' })).status).toBe(409);
    expect((await t.call('/p/memory', 'DELETE', { category: fact.category, key: fact.key, baseValue: 'Русский' })).body.facts).toEqual([]);
  });
  it('snapshots and restores all files with an undo checkpoint and rejects missing snapshot objects', async () => {
    const t = workbenchFixture(); t.project('p'); await t.r2.put('projects/p/workspace/index.html', '<p>original</p>');
    const digest = (await t.call('/p/files')).body.sourceDigest;
    const version = await t.call('/p/versions', 'POST', { baseDigest: digest, summary: 'Original' });
    expect(version.status).toBe(201);
    const changed = await t.call('/p/file', 'PUT', { path: 'index.html', content: '<p>changed</p>', baseDigest: digest });
    const restored = await t.call(`/p/versions/${version.body.version.id}/restore`, 'POST', { baseDigest: changed.body.sourceDigest });
    expect(restored.body.restored).toBe(1); expect(restored.body.backupVersionId).toBeTruthy();
    expect((await t.call('/p/file?path=index.html')).body.content).toBe('<p>original</p>');
    const snapshotKey = [...t.objects.keys()].find(k => k.includes(`/workbench-versions/${version.body.version.id}/`))!;
    t.objects.delete(snapshotKey);
    expect((await t.call(`/p/versions/${version.body.version.id}/restore`, 'POST', { baseDigest: restored.body.sourceDigest })).status).toBe(409);
    expect((await t.call('/p/file?path=index.html')).body.content).toBe('<p>original</p>');
  });
  it('prepends restrictive static CSP, removes refresh and inlines only local CSS', async () => {
    const t = workbenchFixture(); t.project('p');
    await t.r2.put('projects/p/workspace/index.html', '<html><head><meta http-equiv="refresh" content="0;url=https://evil.invalid"><link rel="stylesheet" href="styles.css"></head><script>fetch("/api/private")</script><p>Preview</p></html>');
    await t.r2.put('projects/p/workspace/styles.css', 'p{color:red}');
    const preview = await t.call('/p/preview');
    expect(preview.status).toBe(200); expect(preview.body.html).toContain("script-src 'none'"); expect(preview.body.html).toContain('<style>p{color:red}</style>');
    expect(preview.body.html).not.toContain('http-equiv="refresh"'); expect(preview.body.warnings.length).toBeGreaterThan(0);
  });
  it('refuses runtime without sandbox capability and reports actual missing binding', async () => {
    const t = workbenchFixture(); t.project('p');
    expect((await t.call('/p/runtime', 'POST', { action: 'test', command: 'npm test' })).status).toBe(403);
    t.sqlite.prepare("INSERT INTO project_permissions(project_id,capability) VALUES('p','sandbox')").run();
    const missing = await t.call('/p/runtime', 'POST', { action: 'test', command: 'npm test' });
    expect(missing.status).toBe(503); expect(missing.body).toMatchObject({ available: false, code: 'runtime_unavailable' });
  });
});
