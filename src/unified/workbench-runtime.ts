import type { Env } from '../types';
import { AccessError, activeAccount, requireResource, type Principal } from '../lib/accounts';
import { requireCapability } from '../lib/project-control';
import { getContainer, parseTestOutput, runInContainer, SANDBOX_LIMITS, findDisallowedHosts } from '../core/sandbox';
import { claimMission, finishAdmission } from '../lib/mission-admission';
import { reserveQuota } from '../lib/quota';
import { checkDigest, fileBytes, type WorkspaceView } from './workbench-storage';
import { requirePluginTool } from './plugin-policy';

const PREVIEW_MS = 10 * 60_000;
const unavailable = (error: string) => Response.json({ available: false, code: 'runtime_unavailable', error }, { status: 503 });
function previewHostname(env: Env): string | null {
  const host = env.SANDBOX_PREVIEW_HOSTNAME?.trim().toLowerCase();
  return host && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) && !host.endsWith('.workers.dev') ? host : null;
}
function publicHosts(env: Env): string[] {
  return (env.PUBLIC_ORIGINS ?? '').split(',').map(value => {
    try { return new URL(value.trim()).hostname; } catch { return ''; }
  }).filter(Boolean);
}
function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
const boundedOutput = (value: string) => value.length <= 65_536 ? value : `${value.slice(0, 32_768)}\n… вывод сокращён …\n${value.slice(-32_768)}`;

/** Real stable-SDK execution. A fresh container prevents deleted source files
 * and previous runs' node_modules from silently contaminating verification. */
export async function workbenchRuntime(request: Request, env: Env, principal: Principal, project: string, view: WorkspaceView, input: Record<string, unknown>) {
  const { action, command } = input;
  if (!['test', 'exec', 'preview'].includes(String(action))) throw new AccessError('action: test, exec или preview.', 400);
  if (typeof command !== 'string' || !command.trim() || command.length > 8000 || command.includes('\0')) throw new AccessError('Укажите команду длиной до 8000 символов.', 400);
  if (input.baseDigest !== undefined) checkDigest(view, input.baseDigest);
  await requireCapability(env, project, 'sandbox');
  await requirePluginTool(env, project, `sandbox_${action}`);
  if (findDisallowedHosts(command).length) throw new AccessError('Команда содержит запрещённый сетевой адрес.', 403);
  const ns = getContainer(env);
  if (!ns) return unavailable('Песочница Cloudflare не настроена. Команда не выполнялась.');
  const host = previewHostname(env), origin = new URL(request.url).hostname;
  if (action === 'preview' && (!host || [origin, ...publicHosts(env)].some(app => app === host || app.endsWith(`.${host}`))))
    return unavailable('Для работающего приложения нужен отдельный SANDBOX_PREVIEW_HOSTNAME с wildcard DNS. Статический просмотр доступен отдельно.');
  const port = input.port;
  if (action === 'preview' && (!Number.isSafeInteger(port) || Number(port) < 1024 || Number(port) > 65535 || port === 3000))
    throw new AccessError('Нужен порт 1024–65535, кроме внутреннего порта 3000.', 400);
  const key = request.headers.get('Idempotency-Key') ?? '';
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new AccessError('Нужен Idempotency-Key для запуска песочницы.', 400);
  const scope = `workbench-runtime:${principal.id}:${project}:${key}`;
  const admission = await claimMission(env, scope, JSON.stringify({ action, command, port: port ?? null, sourceDigest: view.sourceDigest }));
  if (admission.kind === 'replay') return new Response(admission.body, { status: admission.status, headers: { 'Content-Type': 'application/json' } });
  if (admission.kind !== 'claimed') throw new AccessError('Этот запуск уже выполняется, требует сверки или ключ занят другим запросом.', 409);
  const quota = await reserveQuota(env, `workbench-runtime:${principal.id}`, 1, 12);
  if (!quota.allowed) {
    const response = Response.json({ error: 'Лимит: 12 запусков песочницы в час.' }, { status: 429 });
    await finishAdmission(env, scope, admission.claim, response); return response;
  }
  const { getSandbox } = await import('@cloudflare/sandbox');
  const name = `wb-${crypto.randomUUID()}`, box = getSandbox(ns, name);
  let keep = false;
  try {
    // One live preview per project. Revoke its capability before replacement.
    if (action === 'preview') {
      const prior = await env.AZRAIL_D1.prepare('SELECT hostname,sandbox_name FROM workbench_previews WHERE project_id=?').bind(project).all<{ hostname: string; sandbox_name: string }>();
      await env.AZRAIL_D1.prepare('UPDATE workbench_previews SET expires_at=0 WHERE project_id=?').bind(project).run();
      for (const old of prior.results) {
        await getSandbox(ns, old.sandbox_name).destroy();
        await env.AZRAIL_D1.prepare('DELETE FROM workbench_previews WHERE hostname=? AND expires_at=0').bind(old.hostname).run();
      }
    }
    await box.mkdir('/workspace', { recursive: true });
    for (const entry of view.files) {
      if (entry.size > SANDBOX_LIMITS.MAX_FILE_BYTES) throw new AccessError(`Файл ${entry.path} превышает лимит песочницы 1 МиБ.`, 413);
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
      if (entry.path.includes('/')) await box.mkdir(`/workspace/${parent}`, { recursive: true });
      await box.writeFile(`/workspace/${entry.path}`, base64(await fileBytes(env, entry)), { encoding: 'base64' });
    }
    let result: Record<string, unknown>;
    if (action === 'preview') {
      const proc = await box.startProcess(command, { cwd: '/workspace', timeout: PREVIEW_MS });
      await proc.waitForPort(Number(port), { timeout: 30_000 });
      const exposed = await box.exposePort(Number(port), { hostname: host! });
      const expiresAt = Date.now() + PREVIEW_MS;
      await env.AZRAIL_D1.prepare('INSERT INTO workbench_previews(hostname,project_id,account_id,sandbox_name,expires_at) VALUES(?,?,?,?,?)')
        .bind(new URL(exposed.url).hostname, project, principal.id, name, expiresAt).run();
      result = { available: true, action, sourceDigest: view.sourceDigest, url: exposed.url, expiresAt, output: 'Процесс запущен, порт отвечает.', processId: proc.id };
      keep = true;
    } else {
      const execution = await runInContainer(env, command, { cwd: '/workspace', sandboxName: name, timeoutMs: SANDBOX_LIMITS.COMMAND_TIMEOUT_MS });
      const tests = action === 'test' ? parseTestOutput(execution.stdout + '\n' + execution.stderr, execution.exitCode) : undefined;
      if (tests) tests.ok = execution.exitCode === 0 && tests.total > 0 && tests.failed === 0;
      result = { available: true, action, sourceDigest: view.sourceDigest, exitCode: execution.exitCode, output: boundedOutput(execution.output), tests,
        commandSucceeded: execution.exitCode === 0, filesPersisted: false,
        ...(tests && tests.total === 0 ? { warning: 'Команда завершилась, но отчёт тестового раннера не распознан. Прохождение тестов не подтверждено.' } : {}) };
    }
    const response = Response.json(result);
    await finishAdmission(env, scope, admission.claim, response);
    return response;
  } catch (error) {
    // Keep admission reserved after SDK dispatch: a lost response is not proof
    // that the paid command did not execute. A repeat must not run it twice.
    if (error instanceof AccessError) throw error;
    throw new AccessError('Песочница не подтвердила результат. Повтор этого запуска заблокирован; проверьте журнал перед новым запуском.', 503);
  } finally { if (!keep) await box.destroy().catch(() => {}); }
}

/** Called before app/auth routing. Only recorded, unexpired preview hosts can
 * reach the SDK; app credentials are never forwarded into user programs. */
export async function workbenchPreviewProxy(request: Request, env: Env): Promise<Response | null> {
  const host = previewHostname(env), actual = new URL(request.url).hostname;
  if (!host || !actual.endsWith(`.${host}`)) return null;
  const denied = () => new Response('Preview unavailable', { status: 404 });
  if (publicHosts(env).includes(actual)) return denied();
  const row = await env.AZRAIL_D1.prepare('SELECT project_id,account_id,expires_at FROM workbench_previews WHERE hostname=?').bind(actual)
    .first<{ project_id: string; account_id: string; expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) return denied();
  const principal = await activeAccount(env, row.account_id);
  if (!principal) return denied();
  try {
    await requireResource(env, principal, 'project', row.project_id);
    await requireCapability(env, row.project_id, 'sandbox');
    await requirePluginTool(env, row.project_id, 'sandbox_preview');
  } catch { return denied(); }
  const ns = getContainer(env);
  if (!ns) return denied();
  const forwarded = new Request(request);
  forwarded.headers.delete('Cookie'); forwarded.headers.delete('Authorization');
  const { proxyToSandbox } = await import('@cloudflare/sandbox');
  const response = await proxyToSandbox(forwarded, { Sandbox: ns });
  if (!response) return denied();
  // The app uses __Host- session cookies, which sibling code cannot overwrite.
  // Also prevent user programs from setting parent-domain cookies in responses.
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie'); headers.delete('Clear-Site-Data');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'no-store');
  // Preserve Cloudflare's WebSocket response extension when proxying upgrades.
  return new Response(response.body, { ...response, status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket });
}

/** Scheduled bounded cleanup, after capability expiry. Failed destroys remain
 * recorded for the next attempt; expired hosts are denied independently. */
export async function cleanupWorkbenchPreviews(env: Env): Promise<void> {
  const ns = getContainer(env);
  if (!ns) return;
  const expired = await env.AZRAIL_D1.prepare('SELECT hostname,sandbox_name FROM workbench_previews WHERE expires_at<=? LIMIT 100').bind(Date.now())
    .all<{ hostname: string; sandbox_name: string }>();
  if (!expired.results.length) return;
  const { getSandbox } = await import('@cloudflare/sandbox');
  for (const row of expired.results) {
    try {
      await getSandbox(ns, row.sandbox_name).destroy();
      await env.AZRAIL_D1.prepare('DELETE FROM workbench_previews WHERE hostname=? AND expires_at<=?').bind(row.hostname, Date.now()).run();
    } catch { /* retry on next scheduled invocation */ }
  }
}
