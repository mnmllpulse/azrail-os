import type { Env, AttachmentRef } from "../types";

/**
 * ЧТЕНИЕ ВЛОЖЕНИЙ ОБРАТНО ИЗ R2
 *
 * Цепь рвалась в трёх местах сразу, и все три — молча:
 *   1. интерфейс отправлял `attachments`, сервер это поле не читал;
 *   2. `AttachmentRef` был объявлен в types.ts и нигде не использован;
 *   3. R2 трогали только healthcheck и самотест — ни одна строка кода
 *      никогда не читала загруженный файл обратно.
 *
 * Итог для человека: файл уходит, кружок крутится, приходит «не найдено
 * исходных модулей». Ничего не падало — просто содержимое не доезжало.
 *
 * ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ. Читает то, что уже лежит в R2, и подмешивает
 * текст в задачу. ЧЕГО НЕ ДЕЛАЕТ — не распаковывает архивы: в Worker нет
 * средств прочитать центральный каталог ZIP, а тянуть ради этого
 * библиотеку в воркер неразумно, когда рядом есть контейнер. Про архив
 * говорится прямо, а не выдаётся пустой результат.
 */

/** Потолок на текст одного файла. Больше не влезет в окно модели с пользой. */
const MAX_TEXT_BYTES = 256 * 1024;

/** Сколько вложений читать за раз: защита от «выделил всю папку». */
const MAX_FILES = 12;

/** Расширения, которые имеет смысл читать как текст. */
const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "txt", "css", "html",
  "yml", "yaml", "toml", "sql", "sh", "py", "rs", "go", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "rb", "php", "xml", "svg", "csv", "env", "gitignore",
]);

/** Архивы: распознаём, чтобы сказать правду, а не молчать. */
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

export interface LoadedAttachment {
  fileName: string;
  /** Содержимое, если файл читаем как текст. */
  text?: string;
  /** Почему содержимого нет. Заполнено ВСЕГДА, когда нет text. */
  skipped?: string;
  bytes?: number;
}

/**
 * Читает вложения из R2.
 *
 * Не бросает: недоступное вложение — не повод ронять задачу, которую
 * человек уже отправил. Каждая неудача возвращается строкой в `skipped`,
 * чтобы агент видел причину и мог о ней сказать.
 */
export async function loadAttachments(
  env: Env,
  refs: AttachmentRef[] | undefined,
): Promise<LoadedAttachment[]> {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  if (!env.AZRAIL_R2) {
    return refs.map((r) => ({ fileName: r.fileName, skipped: "хранилище файлов недоступно" }));
  }

  const out: LoadedAttachment[] = [];

  for (const ref of refs.slice(0, MAX_FILES)) {
    const name = ref.fileName || "без имени";
    const ext = extOf(name);

    if (ARCHIVE_EXT.has(ext)) {
      // Честный отказ вместо пустого результата. Человек должен понимать,
      // почему архив не сработал, а не гадать.
      out.push({
        fileName: name,
        skipped: "архив — распаковка возможна только в песочнице; пришли файлы по отдельности",
      });
      continue;
    }

    if (!ref.r2Key) {
      out.push({ fileName: name, skipped: "нет ключа в хранилище" });
      continue;
    }

    try {
      const obj = await env.AZRAIL_R2.get(ref.r2Key);
      if (!obj) {
        out.push({ fileName: name, skipped: "файл не найден в хранилище" });
        continue;
      }

      // Двоичное читать как текст бессмысленно: модель получит мусор и
      // будет рассуждать о нём как о коде.
      const looksText = TEXT_EXT.has(ext) || (ref.mimeType ?? "").startsWith("text/");
      if (!looksText) {
        out.push({ fileName: name, skipped: `тип «${ext || "неизвестен"}» не читается как текст` });
        continue;
      }

      const text = await obj.text();
      if (text.length > MAX_TEXT_BYTES) {
        out.push({
          fileName: name,
          text: text.slice(0, MAX_TEXT_BYTES),
          bytes: text.length,
          skipped: `показано первые ${Math.round(MAX_TEXT_BYTES / 1024)} КБ из ${Math.round(text.length / 1024)}`,
        });
        continue;
      }

      out.push({ fileName: name, text, bytes: text.length });
    } catch (err) {
      out.push({ fileName: name, skipped: err instanceof Error ? err.message : String(err) });
    }
  }

  if (refs.length > MAX_FILES) {
    out.push({
      fileName: `…и ещё ${refs.length - MAX_FILES}`,
      skipped: `за раз читается не больше ${MAX_FILES} файлов`,
    });
  }

  return out;
}

/**
 * Сворачивает прочитанное в текст для задачи.
 *
 * Пропущенные файлы попадают сюда ТОЖЕ — иначе агент решит, что их не
 * присылали, и ответит так, будто их не было. Причина пропуска ему нужна
 * не меньше содержимого.
 */
export function attachmentsToText(loaded: LoadedAttachment[]): string {
  if (loaded.length === 0) return "";

  const parts = loaded.map((a) => {
    if (a.text) {
      const note = a.skipped ? `\n[${a.skipped}]` : "";
      return `--- ФАЙЛ: ${a.fileName} ---${note}\n${a.text}`;
    }
    return `--- ФАЙЛ: ${a.fileName} — НЕ ПРОЧИТАН: ${a.skipped ?? "причина неизвестна"} ---`;
  });

  return `\n\nПРИЛОЖЕННЫЕ ФАЙЛЫ (${loaded.length}):\n\n${parts.join("\n\n")}`;
}
