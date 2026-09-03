// AZRAIL — чтение исходников из любого поддерживаемого входа.
//
// Вынесено из CodeAgent.gatherContext(), потому что появился второй потребитель:
// Security Agent сканирует файлы ПОФАЙЛОВО (нужен путь и номер строки для находки),
// а Code Agent склеивает всё в один блоб для промпта. Один источник, два формата —
// поэтому ридер отдаёт структуру, а склейка живёт отдельной функцией.

import { unzipSync, strFromU8 } from "fflate";
import { pathSegments, splitRepo } from "./safe-path";
import type { Env, TaskRequest, GeneratedFile } from "../types";

export const MAX_CONTEXT_CHARS = 60_000;
const TEXT_FILE_RE = /\.(ts|tsx|js|jsx|json|md|css|html|py|toml|yaml|yml|sql|txt|env|lock|astro|vue|svelte|go|rs|java|kt|php|rb|sh)$/i;
const SKIP_RE = /node_modules|\.git\//;

/** Читает исходники и возвращает их пофайлово. Бросает при нечитаемом входе. */
export async function readSource(env: Env, request: TaskRequest, maxChars = MAX_CONTEXT_CHARS): Promise<GeneratedFile[]> {
  switch (request.inputType) {
    case "text":
    case "json":
      return request.payload ? [{ path: "input.txt", content: request.payload }] : [];

    case "zip": {
      if (!request.r2Key) throw new Error("r2Key отсутствует для input_type=zip");
      const obj = await env.AZRAIL_R2.get(request.r2Key);
      if (!obj) throw new Error(`Объект ${request.r2Key} не найден в AZRAIL_R2`);
      const unzipped = unzipSync(new Uint8Array(await obj.arrayBuffer()));

      const files: GeneratedFile[] = [];
      let total = 0;
      for (const [name, data] of Object.entries(unzipped)) {
        if (name.endsWith("/") || !TEXT_FILE_RE.test(name) || SKIP_RE.test(name)) continue;
        const content = strFromU8(data);
        files.push({ path: name, content });
        total += content.length;
        if (total > maxChars) break;
      }
      if (files.length === 0) throw new Error("В архиве не найдено текстовых файлов поддерживаемых типов");
      return files;
    }

    case "pdf":
    case "docx": {
      if (!request.r2Key) throw new Error(`r2Key отсутствует для input_type=${request.inputType}`);
      const obj = await env.AZRAIL_R2.get(request.r2Key);
      if (!obj) throw new Error(`Объект ${request.r2Key} не найден в AZRAIL_R2`);
      const mime =
        request.inputType === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const blob = new Blob([await obj.arrayBuffer()], { type: mime });
      const converted = (await env.AI.toMarkdown([{ name: request.r2Key, blob }])) as Array<{ data?: string }>;
      return [{ path: request.r2Key, content: converted[0]?.data ?? "" }];
    }

    case "code":
    case "image":
    case "audio":
    case "video": {
      if (!request.r2Key) throw new Error(`r2Key отсутствует для input_type=${request.inputType}`);
      const obj = await env.AZRAIL_R2.get(request.r2Key);
      if (!obj) throw new Error(`Объект ${request.r2Key} не найден в AZRAIL_R2`);
      // Код читается как есть — это текст, и путь важен для находок
      // Security Agent (файл + строка).
      if (request.inputType === "code") {
        return [{ path: request.payload || "input.code", content: await obj.text() }];
      }
      // Двоичное текстом читать нельзя — вернулась бы каша из байтов,
      // которую модель приняла бы за содержимое. Отдаём отметку о вложении:
      // разбор картинок и звука — отдельная работа, которой пока нет.
      return [{ path: request.r2Key, content: `[двоичное вложение: ${request.inputType}]` }];
    }

    case "github": {
      // Раньше owner/repo брались простым split без единой проверки:
      // payload "../../user" давал owner=".." и уводил запрос с эндпоинта.
      const { owner, repo } = splitRepo(request.payload, "payload (owner/name)");
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
        headers: {
          "User-Agent": "azrail-os",
          ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
      });
      if (!treeRes.ok) throw new Error(`GitHub API вернул ${treeRes.status} при чтении дерева ${owner}/${repo}`);
      const tree = (await treeRes.json()) as { tree: Array<{ path: string; type: string }> };
      const candidates = tree.tree
        .filter((t) => t.type === "blob" && TEXT_FILE_RE.test(t.path) && !SKIP_RE.test(t.path))
        .slice(0, 40);

      const files: GeneratedFile[] = [];
      let total = 0;
      for (const file of candidates) {
        // file.path приходит из ответа GitHub — источник внешний, значит
        // доверять ему так же нельзя, как и телу запроса.
        const rawRes = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${pathSegments(file.path, "file.path")}`,
        );
        if (!rawRes.ok) continue;
        const content = await rawRes.text();
        files.push({ path: file.path, content });
        total += content.length;
        if (total > maxChars) break;
      }
      return files;
    }

    default:
      return request.payload ? [{ path: "input.txt", content: request.payload }] : [];
  }
}

/** Склеивает файлы в один текст для промпта модели. */
export function joinForPrompt(files: GeneratedFile[], maxChars = MAX_CONTEXT_CHARS): string {
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const part = `--- ${f.path} ---\n${f.content}`;
    parts.push(part);
    total += part.length;
    if (total > maxChars) break;
  }
  return parts.join("\n\n");
}
