import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './stubs/sqlite-d1';
import type { Env } from '../src/types';
import { workbenchRoute } from '../src/unified/workbench';

export function workbenchFixture() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(readFileSync(new URL('../migrations/011-project-workbench.sql', import.meta.url), 'utf8'));
  const objects = new Map<string, Uint8Array>();
  function metadata(key: string) {
    const value = objects.get(key)!;
    return { key, size: value.length, etag: createHash('sha256').update(value).digest('hex'), uploaded: new Date('2026-10-04T00:00:00Z') };
  }
  const r2 = {
    async put(key: string, value: string | Uint8Array) { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); return metadata(key); },
    async get(key: string) { return objects.has(key) ? { ...metadata(key), body: new Response(objects.get(key)).body, text: async () => new TextDecoder().decode(objects.get(key)) } : null; },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort(), from = Number(cursor ?? 0), end = from + limit;
      return { objects: keys.slice(from, end).map(metadata), truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
    },
  };
  const env = { AUTH_MODE: 'legacy', AZRAIL_TOKEN: 'test-admin-secret', AZRAIL_D1: db, AZRAIL_R2: r2, AZRAIL_WRITE_BUDGET: '500000', PUBLIC_ORIGINS: 'https://app.example.com' } as unknown as Env;
  sqlite.prepare("INSERT OR IGNORE INTO users(id,name) VALUES('system','system')").run();
  function project(id: string, owner = 'owner', name = id) {
    sqlite.prepare("INSERT INTO projects(id,user_id,name) VALUES(?,'system',?)").run(id, name);
    sqlite.prepare("INSERT INTO resource_owners(kind,resource_id,account_id) VALUES('project',?,?)").run(id, owner);
  }
  function account(id: string, role = 'editor') {
    const token = 'az_' + createHash('sha256').update(id).digest('hex');
    sqlite.prepare('INSERT INTO access_accounts(id,name,role,token_hash,expires_at) VALUES(?,?,?,?,?)').run(id, id, role, createHash('sha256').update(token).digest('hex'), Date.now() + 86400_000);
    return token;
  }
  async function call(path: string, method = 'GET', body?: unknown, token = env.AZRAIL_TOKEN!, extraHeaders: Record<string, string> = {}) {
    const request = new Request(`https://app.example.com/api/workbench/projects${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await workbenchRoute(request, env);
    if (!response) throw new Error('route not handled');
    return { status: response.status, body: await response.json() as any };
  }
  return { env, db, sqlite, r2, objects, project, account, call };
}
