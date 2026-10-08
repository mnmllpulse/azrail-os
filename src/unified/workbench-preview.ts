import type { Env } from '../types';
import { AccessError } from '../lib/accounts';
import { fileText, type WorkspaceView } from './workbench-storage';

const POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Static HTML only. The UI must also use an iframe with an empty sandbox. */
export async function staticPreview(env: Env, view: WorkspaceView, requestedPath: string | null) {
  const entry = requestedPath
    ? view.files.find(f => f.path === requestedPath && /\.html?$/i.test(f.path))
    : view.files.find(f => f.path === 'index.html') ?? view.files.find(f => /(^|\/)index\.html?$/.test(f.path));
  if (!entry) throw new AccessError('Для статического просмотра нужен index.html. React/TypeScript сначала требуется собрать в песочнице.', 404);
  let html = await fileText(env, entry), count = 0, total = new TextEncoder().encode(html).length;
  const warnings = ['Статический просмотр: JavaScript, формы и внешние запросы отключены.'];
  // Remove refresh and base elements before adding the first enforced policy.
  // This is defense in depth, not a replacement for CSP + sandbox isolation.
  html = html.replace(/<meta\b[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  for (const match of links) {
    const tag = match[0];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag) || !href || ++count > 16) continue;
    const url = new URL(href, `https://preview.invalid/${entry.path}`);
    if (url.origin !== 'https://preview.invalid' || url.search || url.hash) continue;
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(1)); } catch { continue; }
    const css = view.files.find(f => f.path === path && /\.css$/i.test(f.path));
    if (!css) { warnings.push(`Не найден CSS: ${path}`); continue; }
    if (total + css.size > 2 * 1024 * 1024) throw new AccessError('Статический просмотр превышает 2 МиБ.', 413);
    const content = await fileText(env, css);
    total += css.size;
    html = html.replace(tag, `<style>${content.replace(/<\/style/gi, '<\\/style')}</style>`);
  }
  const prefix = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
  return { html: prefix + html, sourceDigest: view.sourceDigest, warnings };
}
