// AZRAIL — загрузка файлов напрямую из чата/дашборда в AZRAIL_R2

import type { Env, InputType } from "../types";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — мягкий лимит приложения,
// не платформенный: реальный потолок размера тела запроса зависит от плана
// Cloudflare, см. README.

// В этой связке зависимостей (wrangler хочет workers-types v5, agents/partyserver
// требует v4 — см. package.json) ambient-тип File после сужения типа резолвится
// в `never`, а не в File. Похоже на конфликт объявлений между версиями. Обходим
// собственным структурным интерфейсом вместо ambient File — рантайм-объект от
// FormData.get() всё равно ему соответствует, гарантия из спецификации FormData.
interface UploadedFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const EXT_TO_TYPE: Record<string, InputType> = {
  zip: "zip",
  pdf: "pdf",
  docx: "docx",
  // Код — отдельный тип, а не "text": source-reader отдаёт его файлом с
  // путём, а не склеенным блобом.
  js: "code", ts: "code", tsx: "code", jsx: "code",
  html: "code", css: "code", py: "code", md: "code",
  json: "json", txt: "text",
  // Двоичные вложения читать текстом нельзя — source-reader вернёт для них
  // отметку о вложении, а не содержимое.
  png: "image", jpg: "image", jpeg: "image", webp: "image", svg: "image",
  mp3: "audio", wav: "audio", m4a: "audio",
  mp4: "video", mov: "video", webm: "video",
};

export function inferInputType(filename: string): InputType | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && ext in EXT_TO_TYPE ? EXT_TO_TYPE[ext] : null;
}

export function sanitizeFilename(name: string): string {
  // Сначала убираем последовательности точек, потом всё остальное.
  // Порядок важен: без первого шага "../../evil.zip" превращается в
  // ".._.._evil.zip" — слэшей нет, но ".." остаётся. В R2 это безвредно
  // (ключи плоские, traversal без слэша не работает), но если имя когда-нибудь
  // попадёт в файловый путь — станет дырой. Дешевле обезвредить здесь.
  return name.replace(/\.{2,}/g, ".").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

export interface UploadResult {
  r2Key: string;
  inputType: InputType;
  fileName: string;
  size: number;
}

export interface UploadError {
  error: string;
  status: number;
}

export async function handleUpload(request: Request, env: Env): Promise<UploadResult | UploadError> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { error: "Ожидался multipart/form-data.", status: 400 };
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return { error: 'Поле "file" обязательно.', status: 400 };
  }
  const uploaded = file as unknown as UploadedFile;

  const inputType = inferInputType(uploaded.name);
  if (!inputType) {
    return {
      error: `Неподдерживаемый тип файла. Разрешены: ${Object.keys(EXT_TO_TYPE).join(", ")}.`,
      status: 400,
    };
  }

  if (uploaded.size > MAX_UPLOAD_BYTES) {
    return { error: `Файл больше ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`, status: 413 };
  }

  // Ключ: проект + UUID, а не только время. Date.now() имеет разрешение в
  // миллисекунду — два файла с одинаковым именем, загруженные подряд, могли
  // получить один ключ и затереть друг друга. UUID это исключает, а папка
  // проекта заодно даёт разделение: загрузки одного проекта лежат вместе.
  // projectId проверяется по белому списку символов — он попадает в путь R2,
  // и произвольная строка оттуда открыла бы обход по каталогам.
  const projectId = form.get("projectId");
  const safeProject =
    typeof projectId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(projectId) ? projectId : "inbox";
  const r2Key = `uploads/${safeProject}/${crypto.randomUUID()}-${sanitizeFilename(uploaded.name)}`;
  await env.AZRAIL_R2.put(r2Key, await uploaded.arrayBuffer(), {
    httpMetadata: { contentType: uploaded.type || "application/octet-stream" },
  });

  return { r2Key, inputType, fileName: uploaded.name, size: uploaded.size };
}
