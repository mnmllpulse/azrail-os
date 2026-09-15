// AZRAIL — гарантия существования проекта.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ ЕСТЬ: таблицы project_versions, task_history и
// project_memory объявляют FOREIGN KEY на projects(id), но строка в projects
// не создавалась НИГДЕ. В D1 внешние ключи включены, поэтому каждая вставка
// в зависимые таблицы падала бы с SQLITE_CONSTRAINT_FOREIGNKEY.
//
// Хуже всего то, что падала бы ТИХО: весь этот код обёрнут в try/catch с
// комментарием «не роняем задачу из-за аналитики». Задачи выполнялись бы,
// ответы возвращались, а история, версии и память проекта оставались пустыми.
// Симптом выглядел бы как «Evolution Agent ничего не находит» — и искали бы
// причину не там.
//
// Обнаружено при проверке атомарной вставки на живой D1, а не компилятором:
// такие ошибки не видны ни в типах, ни в dry-run сборке.

import type { Env } from "../types";
import { log } from "./resilience";

/** Кеш в пределах инстанса: повторно дёргать D1 на каждую задачу незачем.
 *  Durable Object живёт долго, но не вечно — после выгрузки кеш просто
 *  наполнится заново, лишний INSERT OR IGNORE безвреден. */
/** СРОК ЖИЗНИ ЗАПИСИ ОБЯЗАТЕЛЕН. Без него кеш утверждает «проект есть»
 *  ровно до выгрузки объекта — то есть часами. Если строку удалят из D1
 *  (руками, чисткой, откатом), все последующие записи полетят во внешний
 *  ключ, которого нет, и будут падать, пока объект не выгрузят. Срок
 *  превращает это из «сломано до перезапуска» в «само починится за пять
 *  минут». */
const CACHE_TTL_MS = 5 * 60_000;
const known = new Map<string, number>();

/** Забыть проект: следующий вызов пойдёт в базу, а не поверит кешу.
 *
 * НЕ ВЫЗЫВАЕТСЯ НИОТКУДА, и это осознанно: удаления проектов в системе
 * нет, а единственный источник рассинхрона — чужая запись в базу мимо
 * воркера. Её закрывает TTL в пять минут. Функция остаётся точкой, куда
 * подключится удаление, когда появится. Помечено, чтобы через месяц не
 * искать, забыли её подключить или так и задумано. */
export function forgetProject(projectId: string): void {
  known.delete(projectId);
}

/** Владелец проектов, созданных самой системой. Отдельная сущность нужна
 *  потому, что projects.user_id тоже внешний ключ — на users(id).
 *  Цепочка целиком: users ← projects ← {project_versions, task_history,
 *  project_memory}. Проверять надо всю, а не только последнее звено —
 *  первая версия этой функции чинила только нижний уровень и падала сама. */
const SYSTEM_USER_ID = "system";
let systemUserReady = false;

async function ensureSystemUser(env: Env): Promise<void> {
  if (systemUserReady) return;
  await env.AZRAIL_D1.prepare(`INSERT OR IGNORE INTO users (id, name) VALUES (?, 'AZRAIL system')`)
    .bind(SYSTEM_USER_ID)
    .run();
  systemUserReady = true;
}

/**
 * Создаёт строку проекта, если её ещё нет. Вызывать ПЕРЕД любой записью
 * в project_versions / task_history / project_memory.
 *
 * Возвращает true, если проект точно существует и можно писать дальше.
 */
export async function ensureProject(env: Env, projectId: string, name?: string): Promise<boolean> {
  if (!projectId) return false;
  const cachedAt = known.get(projectId);
  if (cachedAt !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return true;

  try {
    await ensureSystemUser(env);

    // INSERT OR IGNORE, а не SELECT-затем-INSERT: второе не атомарно, и два
    // параллельных агента на одном проекте гонялись бы за первичный ключ.
    await env.AZRAIL_D1.prepare(
      `INSERT OR IGNORE INTO projects (id, user_id, name, status)
       VALUES (?, ?, ?, 'active')`,
    )
      .bind(projectId, SYSTEM_USER_ID, name ?? projectId)
      .run();
    known.set(projectId, Date.now());
    return true;
  } catch (err) {
    // Не глушим молча — именно молчание сделало исходную ошибку незаметной.
    // Неудача не должна оставить в кеше отметку об успехе.
    known.delete(projectId);
    log("error", "project.ensure_failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
