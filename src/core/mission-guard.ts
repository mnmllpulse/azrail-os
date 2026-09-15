import type { Env } from "../types";
import { log } from "../lib/resilience";

/**
 * ЗАЩИТА МИССИИ.
 *
 * Три дыры, найденные проверкой кода, а не догадками:
 *
 *  1. Миссия падала на пятом шаге из восьми — и файлы, записанные на
 *     первых четырёх, оставались. Проект в промежуточном состоянии, и
 *     никто об этом не говорил.
 *
 *  2. Цикл останавливали только три ОШИБКИ подряд. Повтор УСПЕШНОГО
 *     действия не ловился вообще: агент мог двадцать раз прочитать один
 *     файл, сжечь весь бюджет и отчитаться «потолок шагов» — хотя
 *     причина была видна на первом же повторе.
 *
 *  3. Тесты гонялись только в конце. Без замера ДО работы нельзя
 *     отличить «я починил» от «оно и так работало» и, что важнее, от
 *     «я сломал то, что работало».
 */

/* ── Обнаружение зацикливания ────────────────────────────────────── */

export interface StepFingerprint {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Отпечаток шага: инструмент плюс его вход.
 *
 * Ключи входа СОРТИРУЮТСЯ перед сериализацией. Без этого {a:1,b:2} и
 * {b:2,a:1} дают разные строки, и повтор не распознаётся — а модель
 * порядок полей не гарантирует.
 */
export function fingerprint(step: StepFingerprint): string {
  const input = step.input ?? {};
  const keys = Object.keys(input).sort();
  const norm = keys.map((k) => `${k}=${JSON.stringify(input[k])}`).join("&");
  return `${step.tool}(${norm})`;
}

export interface LoopVerdict {
  looping: boolean;
  /** Сколько раз повторён отпечаток, включая текущий вызов. */
  repeats: number;
  reason: string;
}

/** После скольких одинаковых вызовов считаем это зацикливанием. */
const REPEAT_LIMIT = 3;

/**
 * Проверить, не топчется ли цикл на месте.
 *
 * Считаются ТОЧНЫЕ повторы: тот же инструмент с тем же входом. Чтение
 * одного файла дважды — нормально (между ними могла быть правка).
 * Трижды подряд с тем же входом — уже симптом.
 *
 * Намеренно НЕ считается «тот же инструмент с другим входом»: перебор
 * файлов через list_files → read_file → read_file — это нормальная
 * работа, а не зацикливание.
 */
export function detectLoop(history: StepFingerprint[], next: StepFingerprint): LoopVerdict {
  const fp = fingerprint(next);
  const repeats = history.filter((h) => fingerprint(h) === fp).length + 1;

  if (repeats >= REPEAT_LIMIT) {
    return {
      looping: true,
      repeats,
      reason:
        `Шаг «${fp}» повторяется ${repeats}-й раз с тем же входом. ` +
        `Результат не меняется — нужен другой подход, а не повтор.`,
    };
  }
  return { looping: false, repeats, reason: "" };
}

/* ── Снимок и откат ──────────────────────────────────────────────── */

export interface Snapshot {
  versionId: string;
  files: number;
}

/**
 * Снять состояние рабочей области перед миссией.
 *
 * Возвращает null, если снимать нечего или не получилось. Это НЕ повод
 * останавливать миссию: снимок — страховка, а не условие работы. Новый
 * проект без файлов — обычный случай, и требовать снимок там было бы
 * абсурдом.
 */
export async function snapshotWorkspace(
  env: Env,
  projectId: string,
  note: string,
): Promise<Snapshot | null> {
  try {
    const prefix = `projects/${projectId}/workspace/`;
    const listed = await env.AZRAIL_R2.list({ prefix, limit: 300 });
    if (!listed.objects.length) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `projects/${projectId}/snapshots/${stamp}/`;

    // Копируем содержимое, а не ссылку: объект в рабочей области будет
    // перезаписан миссией, и ссылка на него после этого указывала бы на
    // уже изменённые данные — то есть снимок не был бы снимком.
    for (const obj of listed.objects) {
      const body = await env.AZRAIL_R2.get(obj.key);
      if (!body) continue;
      await env.AZRAIL_R2.put(key + obj.key.slice(prefix.length), await body.text());
    }

    const versionId = crypto.randomUUID();
    await env.AZRAIL_D1.prepare(
      `INSERT INTO project_versions (id, project_id, version_number, r2_object_key, summary, created_by_agent)
       SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, 'execution-engine'
       FROM project_versions WHERE project_id = ?`,
    )
      .bind(versionId, projectId, key, `Снимок до миссии: ${note.slice(0, 200)}`, projectId)
      .run();

    return { versionId, files: listed.objects.length };
  } catch (err) {
    // Снимок не удался — миссия всё равно идёт. Отсутствие страховки
    // хуже, чем её наличие, но лучше, чем отказ делать работу.
    log("warn", "snapshot.failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Вернуть рабочую область к снимку.
 *
 * ВАЖНО: файлы, появившиеся во время миссии и отсутствовавшие в снимке,
 * УДАЛЯЮТСЯ. Иначе откат неполон: остались бы половинчатые новые файлы,
 * на которые ничего не ссылается, и разбираться в этом пришлось бы
 * руками.
 */
export async function rollbackWorkspace(
  env: Env,
  projectId: string,
  snapshotKey: string,
): Promise<{ restored: number; removed: number } | null> {
  try {
    const prefix = `projects/${projectId}/workspace/`;

    const snap = await env.AZRAIL_R2.list({ prefix: snapshotKey, limit: 300 });
    const wanted = new Map<string, string>();
    for (const obj of snap.objects) {
      const body = await env.AZRAIL_R2.get(obj.key);
      if (body) wanted.set(obj.key.slice(snapshotKey.length), await body.text());
    }

    const current = await env.AZRAIL_R2.list({ prefix, limit: 300 });
    let removed = 0;
    for (const obj of current.objects) {
      const rel = obj.key.slice(prefix.length);
      if (!wanted.has(rel)) {
        await env.AZRAIL_R2.delete(obj.key);
        removed++;
      }
    }

    let restored = 0;
    for (const [rel, content] of wanted) {
      await env.AZRAIL_R2.put(prefix + rel, content);
      restored++;
    }

    return { restored, removed };
  } catch (err) {
    log("error", "rollback.failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/* ── Сравнение тестов до и после ─────────────────────────────────── */

export interface TestComparison {
  /** Стало ли хуже: то, что проходило, перестало. */
  regressed: boolean;
  /** Починено ли то, что падало. */
  fixed: boolean;
  summary: string;
}

/**
 * Сравнить замеры тестов до и после работы.
 *
 * Критерий взят из практики оценки агентов на реальных задачах и строже
 * очевидного:
 *   — целевое: падало до → проходит после;
 *   — И ВСЁ ОСТАЛЬНОЕ: проходило до → проходит после.
 *
 * Второе условие важнее первого. Агент, починивший одно и сломавший три,
 * формально решил задачу — и именно этот случай надо ловить.
 */
export function compareTests(
  before: { passed: number; failed: number } | null,
  after: { passed: number; failed: number } | null,
): TestComparison {
  if (!before || !after) {
    return {
      regressed: false,
      fixed: false,
      summary: before
        ? "Замер после работы не получен — сравнить не с чем."
        : "Замера до работы не было: нельзя отличить починку от того, что всё и так работало.",
    };
  }

  const regressed = after.passed < before.passed || after.failed > before.failed;
  const fixed = before.failed > 0 && after.failed === 0;

  if (regressed) {
    return {
      regressed: true,
      fixed: false,
      summary:
        `Стало хуже: было ${before.passed} пройдено / ${before.failed} упало, ` +
        `стало ${after.passed} / ${after.failed}. Сломано то, что работало.`,
    };
  }
  if (fixed) {
    return { regressed: false, fixed: true, summary: `Починено: ${before.failed} падавших тестов теперь проходят.` };
  }
  if (before.failed === 0 && after.failed === 0) {
    return {
      regressed: false,
      fixed: false,
      summary: "Тесты проходили и до работы, и после — задача не про них либо не проверяется тестами.",
    };
  }
  return {
    regressed: false,
    fixed: false,
    summary: `Без изменений: ${after.failed} тест(ов) падало до работы и падает после.`,
  };
}
