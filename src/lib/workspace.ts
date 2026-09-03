import type { Env } from "../types";
import { pathSegments } from "./safe-path";

const PREFIX = (projectId: string) => `projects/${projectId}/workspace/`;

export async function writeFile(env: Env, projectId: string, path: string, content: string) {
  const key = PREFIX(projectId) + pathSegments(path, "workspace path");
  await env.AZRAIL_R2.put(key, content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return { key, path, bytes: new TextEncoder().encode(content).byteLength };
}

export async function readFile(env: Env, projectId: string, path: string) {
  const key = PREFIX(projectId) + pathSegments(path, "workspace path");
  const obj = await env.AZRAIL_R2.get(key);
  if (!obj) return null;
  return { path, content: await obj.text(), key };
}

export async function listFiles(env: Env, projectId: string, limit = 500) {
  const listed = await env.AZRAIL_R2.list({ prefix: PREFIX(projectId), limit });
  return listed.objects.map(o => ({ path: o.key.slice(PREFIX(projectId).length), size: o.size, uploaded: o.uploaded }));
}


export async function editFile(env: Env, projectId: string, path: string, search: string, replacement: string) {
  const current = await readFile(env, projectId, path);
  if (!current) throw new Error(`Файл не найден: ${path}`);
  if (!search) throw new Error("search обязателен.");
  const index = current.content.indexOf(search);
  if (index === -1) throw new Error(`Фрагмент не найден в ${path}.`);

  // Неоднозначная замена — ОТКАЗ, а не «возьмём первое».
  //
  // Раньше при нескольких совпадениях молча правилось первое. Для модели
  // это худший из возможных ответов: она получает "ок", считает задачу
  // закрытой, а в файле осталось ещё два таких же места. Дальше она
  // перечитывает файл, видит незаменённое и либо правит по кругу, либо
  // решает, что инструмент сломан.
  //
  // Явный отказ дешевле: модель добавит контекста вокруг фрагмента и
  // попадёт точно. Ровно так же ведут себя нормальные инструменты правки.
  const second = current.content.indexOf(search, index + search.length);
  if (second !== -1) {
    const total = current.content.split(search).length - 1;
    throw new Error(
      `Фрагмент встречается в ${path} ${total} раз(а) — непонятно, какой править. ` +
        `Добавь окружающий текст, чтобы совпадение стало единственным.`,
    );
  }

  const next = current.content.slice(0, index) + replacement + current.content.slice(index + search.length);
  return writeFile(env, projectId, path, next);
}

/** Сколько файлов вообще разрешено прочитать за один поиск. */
const SEARCH_SCAN_CAP = 120;
/** Сколько чтений идёт одновременно. */
const SEARCH_BATCH = 12;

export async function searchFiles(env: Env, projectId: string, needle: string, limit = 50) {
  // Единая форма ответа при любом исходе: разные формы возврата из одной
  // функции — то, на чём tsc поймал этот код, и правильно сделал.
  if (!needle) return { matches: [], scannedAll: true, scanned: 0 };

  /* Работа ограничена по ЧТЕНИЯМ, а не по находкам.
   *
   * Раньше цикл шёл по всем файлам подряд и прерывался только набрав
   * limit совпадений. Поиск, который ничего не находит — самый обычный
   * случай — прочитывал все 500 файлов ПОСЛЕДОВАТЕЛЬНО. У Workers есть
   * потолок подзапросов (на бесплатном плане 50), так что такой поиск
   * либо упирался в него, либо тянулся десятки секунд и съедал время
   * всей миссии.
   *
   * Теперь потолок стоит на прочитанном, чтения идут пачками, а если
   * просмотрено не всё — это СКАЗАНО. Молча урезанный результат хуже
   * честно неполного: по нему делают вывод «такого в проекте нет».
   */
  const files = (await listFiles(env, projectId, 500)).slice(0, SEARCH_SCAN_CAP);
  const scannedAll = files.length < SEARCH_SCAN_CAP;
  const out: { path: string }[] = [];

  for (let i = 0; i < files.length && out.length < limit; i += SEARCH_BATCH) {
    const batch = files.slice(i, i + SEARCH_BATCH);
    const read = await Promise.all(
      batch.map(async (f) => {
        try {
          const file = await readFile(env, projectId, f.path);
          return file?.content.includes(needle) ? f.path : null;
        } catch {
          // Один нечитаемый файл не должен обрывать весь поиск.
          return null;
        }
      }),
    );
    for (const hit of read) {
      if (hit && out.length < limit) out.push({ path: hit });
    }
  }

  return { matches: out, scannedAll, scanned: files.length };
}
