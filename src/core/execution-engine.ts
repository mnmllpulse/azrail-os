import type { Env, TaskRequest, TaskResult, ToolName } from "../types";
import { editFile, listFiles, readFile, searchFiles, writeFile } from "../lib/workspace";
import { describeTools, availableTools, TOOL_REGISTRY } from "../lib/tool-registry";
import { extractText, runModel } from "../lib/model-router";
import { emitMissionEvent } from "../lib/event-store";
import { log } from "../lib/resilience";
import { rememberFact } from "../lib/memory-agent";
import { type PlanStep, parsePlan, savePlan, advancePlan, renderPlan, planProgress } from "./planner";
import { checkResult, findTestEvidence, CHECK_LIMITS } from "./checker";
import { detectBackend, describeBackend, parseTestOutput, truncateOutput, runInContainer, getContainer } from "./sandbox";
import {
  detectLoop,
  snapshotWorkspace,
  rollbackWorkspace,
  compareTests,
  type Snapshot,
} from "./mission-guard";

export interface ExecutionContext {
  missionId: string;
  projectId?: string;
  iteration: number;
  maxIterations: number;
  /** Явно закреплённая пользователем модель. Проходит насквозь в каждое
   *  решение цикла — иначе выбор модели действовал бы только на первый шаг. */
  preferredModel?: string;
  /**
   * Живая трансляция шага наружу. Необязательная: запись в D1 идёт всегда и
   * не зависит от этого — тут только показ «прямо сейчас». Если обработчик
   * бросит, миссия не должна упасть: смотреть на неё некому, но делать её
   * это не мешает (см. notify ниже).
   */
  onEvent?: (payload: { event: string; tool?: string; reason?: string; iteration?: number; maxIterations?: number; steps?: number; files?: number }) => void;
  /**
   * Вызов агента по возможности. Прокидывается роутом, у которого есть
   * ссылка на Оркестратор — сам движок Durable Object'ом не является и
   * subAgent() позвать не может. Без него инструменты open_pr / git_diff /
   * run_tests отказывают явно, остальной цикл работает как обычно.
   */
  invokeCapability?: (capability: "git" | "qa", request: TaskRequest) => Promise<TaskResult>;
}

/** Решение модели на одном шаге: либо позвать инструмент, либо закончить. */
export interface StepDecision {
  tool?: string;
  input?: Record<string, unknown>;
  reason?: string;
  done?: boolean;
  summary?: string;
}

/** Одна запись в истории цикла — что позвали и что получилось. */
interface StepRecord {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: string;
}

const LOOP_SYSTEM_PROMPT = `Ты — исполнительное ядро AZRAIL. Ты решаешь, какой инструмент вызвать следующим, чтобы выполнить задачу владельца.

ОТВЕЧАЙ ТОЛЬКО валидным JSON, без пояснений и без markdown-обёрток.

Формат для вызова инструмента:
{"tool":"имя_инструмента","input":{...},"reason":"зачем этот шаг"}

Формат для завершения:
{"done":true,"summary":"что сделано"}

ПРАВИЛА:
- Зови только инструменты из списка доступных. Другого списка нет.
- Один шаг — один вызов. Не пытайся сделать всё сразу.
- Прежде чем менять файл, прочитай его: write_file затирает содержимое целиком.
- Если задача выполнена — верни done. Не делай лишних шагов ради видимости работы.
- Если задачу нельзя выполнить доступными инструментами — верни done с честным объяснением, почему. Не притворяйся, что сделал.
- Не выдумывай пути файлов: сначала list_files или search_files.`;

export class ExecutionEngine {
  constructor(private readonly env: Env) {}

  async executeTool(tool: ToolName, input: Record<string, unknown>, ctx: ExecutionContext): Promise<unknown> {
    const def = describeTools().find((t) => t.name === tool);
    if (!def || !def.available) throw new Error(`Инструмент "${tool}" недоступен в текущем окружении.`);

    switch (tool) {
      case "read_file":
        this.requireProject(ctx);
        return readFile(this.env, ctx.projectId!, String(input.path ?? ""));
      case "write_file":
        this.requireProject(ctx);
        return writeFile(this.env, ctx.projectId!, String(input.path ?? ""), String(input.content ?? ""));
      case "edit_file":
        this.requireProject(ctx);
        return editFile(this.env, ctx.projectId!, String(input.path ?? ""), String(input.search ?? ""), String(input.replacement ?? ""));
      case "list_files":
        this.requireProject(ctx);
        return listFiles(this.env, ctx.projectId!, Number(input.limit ?? 500));
      case "search_files": {
        const found = await searchFiles(
          this.env,
          ctx.projectId!,
          String(input.needle ?? ""),
          Number(input.limit ?? 50),
        );
        // Неполный просмотр говорится ВСЛУХ. Молча урезанный результат
        // модель прочитает как «в проекте такого нет» и построит на этом
        // следующий шаг — а на деле просто не всё просмотрено.
        if (!found.scannedAll) {
          return {
            ...found,
            note: `Просмотрено ${found.scanned} файлов, это не весь проект. Отсутствие совпадений не означает, что их нет.`,
          };
        }
        return found;
      }
      case "call_model":
        // Отдельный вызов модели внутри миссии: перевести, переписать,
        // объяснить. Своей политики маршрутизации не заводим — идёт через
        // тот же runModel, что и всё остальное.
        return extractText(
          (
            await runModel<{ response?: string }>(
              this.env,
              "chat",
              { messages: [{ role: "user", content: String(input.prompt ?? "") }] },
              { preferredModel: ctx.preferredModel },
            )
          ).output,
        );

      // ── Через агентов ─────────────────────────────────────────────
      // Заново поверх GitHub API это не переписывается: у Git Agent уже
      // есть проверка имени репозитория (assertRepo) и разбор ответов.
      // Второй путь к тому же означал бы вторую копию этих проверок и
      // будущее расхождение между ними.
      case "git_diff":
        return this.viaAgent(ctx, "git", {
          projectId: ctx.projectId,
          gitOp: { type: "diff", base: String(input.base ?? "main"), head: String(input.head ?? "") },
        });

      case "open_pr":
        return this.viaAgent(ctx, "git", {
          projectId: ctx.projectId,
          gitOp: {
            type: "open_pr",
            head: String(input.head ?? ""),
            base: String(input.base ?? "main"),
            title: String(input.title ?? "Изменения от AZRAIL"),
            body: input.body ? String(input.body) : undefined,
          },
        });

      case "sandbox_exec": {
        /* Произвольная команда в контейнере.
         *
         * Риск review не случайно: команда может сделать что угодно в
         * пределах песочницы. Изоляция снаружи (сеть по списку, нет
         * секретов, нет доступа к платформе) — а не доверие к тому, что
         * модель попросит.
         *
         * Успех определяет КОД ВОЗВРАТА, а не наличие вывода: команда
         * может напечатать много и упасть, и наоборот. */
        const cmd = String(input.command ?? "").trim();
        if (!cmd) throw new Error("command обязателен.");

        const res = await runInContainer(this.env, cmd, {
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        });

        // Таймаут отделён от ненулевого кода: причина разная, и лечится
        // это по-разному — «зависло» и «упало» требуют разных действий.
        if (res.timedOut) {
          throw new Error(`Команда не завершилась за отведённое время: ${cmd}`);
        }
        if (res.exitCode !== 0) {
          // Вывод уходит модели ЦЕЛИКОМ (в пределах обрезки): чинят по
          // тексту ошибки, и пересказ теряет ту деталь, по которой чинят.
          throw new Error(`Команда завершилась с кодом ${res.exitCode}:\n${res.output}`);
        }
        return { exitCode: 0, output: res.output };
      }

      case "sandbox_preview": {
        const box = getContainer(this.env);
        if (!box?.previewUrl) {
          throw new Error("Предпросмотр недоступен: контейнер не настроен или не умеет пробрасывать порт.");
        }
        const port = Number(input.port ?? 3000);
        const url = await box.previewUrl(port);
        if (!url) {
          // Отказ ЧЕСТНЫЙ: сервер не поднят — обычное дело, а не сбой.
          // Модель должна понять, что надо сначала его запустить.
          return { url: null, note: `На порту ${port} никто не слушает. Сначала запусти сервер через sandbox_exec.` };
        }
        return { url, port };
      }

      case "sandbox_test": {
        /* Прогон тестов с РАЗБОРОМ результата.
         *
         * Отличие от run_tests не в том, где выполняется, а в том, что
         * возвращается. run_tests отдаёт текст, который модель читает
         * глазами — и регулярно объявляет успехом прогон с падениями,
         * потому что внизу написано что-то ободряющее.
         *
         * Здесь итог считает КОД: {passed, failed, ok}. Именно этот
         * результат проверяющий берёт как окончательный, не спрашивая
         * модель.
         */
        const backend = detectBackend(this.env);
        if (backend === "none") {
          // Отказ ЧЕСТНЫЙ и с причиной: модель должна понять, что делать
          // дальше, а не получить «упало».
          throw new Error(
            `Прогон тестов недоступен (${describeBackend(backend)}). ` +
              `Задай GITHUB_TOKEN либо подключи контейнеры на платном плане.`,
          );
        }

        const res = await this.viaAgent(ctx, "qa", {
          projectId: ctx.projectId,
          qaOp: input.workflow
            ? { type: "trigger_tests", workflow: String(input.workflow), ref: input.ref ? String(input.ref) : undefined }
            : { type: "latest_run" },
        });

        const raw = typeof res === "string" ? res : JSON.stringify(res);
        const parsed = parseTestOutput(truncateOutput(raw));
        return {
          ...parsed,
          backend,
          // Сырой вывод оставляем обрезанным: чинят по тексту ошибки, и
          // пересказ своими словами теряет как раз ту деталь, по которой
          // чинят.
          output: truncateOutput(raw, 20, 60),
        };
      }

      case "run_tests":
        return this.viaAgent(ctx, "qa", {
          projectId: ctx.projectId,
          qaOp: input.runId
            ? { type: "check_run", runId: Number(input.runId) }
            : input.workflow
              ? { type: "trigger_tests", workflow: String(input.workflow), ref: input.ref ? String(input.ref) : undefined }
              : { type: "latest_run" },
        });

      default:
        throw new Error(`Инструмент "${tool}" зарегистрирован, но его execution adapter ещё не подключён.`);
    }
  }

  /**
   * Автономный цикл миссии.
   *
   * Модель на каждом шаге получает цель, список ДОСТУПНЫХ инструментов и
   * историю уже сделанного, и отвечает одним решением: позвать инструмент
   * или закончить. Движок исполняет, кладёт результат обратно в историю и
   * идёт на следующий круг.
   *
   * ГРАНИЦЫ, встроенные намеренно:
   *
   * 1. Инструменты риска "approval" цикл НЕ исполняет никогда. Не «спросит
   *    и выполнит» — просто не может: availableTools() их не показывает, а
   *    executeTool отказывает по флагу. Необратимое действие требует
   *    отдельного решения владельца, а не согласия внутри цикла.
   *
   * 2. maxIterations — жёсткий потолок, а не пожелание. Модель, зациклившаяся
   *    на одном файле, остановится по счётчику. Без него цикл крутился бы до
   *    исчерпания лимитов Worker'а.
   *
   * 3. Ошибка инструмента не роняет миссию — она возвращается модели текстом,
   *    чтобы та попробовала иначе. Но три ошибки подряд цикл прекращают:
   *    если три шага подряд провалились, дело не в невезении.
   */
  async runMission(request: TaskRequest, ctx: ExecutionContext): Promise<TaskResult> {
    const goal = (request.message ?? request.payload ?? "").trim();
    if (!goal) {
      return {
        status: "needs_input",
        agent: "execution-engine",
        summary: "Для выполнения миссии нужен запрос пользователя.",
        questions: ["Что именно нужно создать или изменить?"],
      };
    }
    if (!ctx.projectId) {
      // Без проекта у файловых инструментов нет рабочей папки — цикл
      // выродится в один call_model. Честнее сказать сразу.
      return {
        status: "needs_input",
        agent: "execution-engine",
        summary: "Не указан проект: без него у файловых инструментов нет рабочей папки.",
        questions: ["В каком проекте выполнять задачу?"],
      };
    }

    const tools = availableTools();
    const toolList = tools.map((t) => `- ${t.name} (${t.risk}): ${t.description}`).join("\n");
    const history: StepRecord[] = [];
    const maxIterations = Math.max(1, Math.min(ctx.maxIterations || 8, 20));
    let consecutiveFailures = 0;

    await this.note(ctx, "mission.started", { goal, maxIterations });

    // ── План строится ДО первого шага ──────────────────────────────
    // Пока контекст чистый и задача видна целиком. Позже, в середине
    // длинной истории вызовов, декомпозиция получается заметно хуже.
    //
    // Сбой планирования миссию НЕ останавливает: цикл умеет работать и
    // без плана, просто хуже держит цель. Терять работоспособность
    // ради надстройки неправильно.
    let plan: PlanStep[] = [];
    try {
      plan = await this.buildPlan(goal, toolList, maxIterations, ctx);
      if (plan.length) await this.note(ctx, "plan.ready", { steps: plan.length });
    } catch (err) {
      log("warn", "plan.build_failed", {
        missionId: ctx.missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let rejections = 0;

    /* ── Снимок рабочей области ДО работы ──────────────────────────
     * Миссия могла упасть на пятом шаге из восьми — и файлы, записанные
     * на первых четырёх, оставались. Проект в промежуточном состоянии,
     * и никто об этом не говорил.
     *
     * Снимок необязателен: новый проект без файлов — обычный случай, и
     * требовать там снимок было бы абсурдом. */
    let snapshot: Snapshot | null = null;
    let snapshotKey = "";
    if (ctx.projectId) {
      snapshot = await snapshotWorkspace(this.env, ctx.projectId, goal);
      if (snapshot) {
        const row = await this.env.AZRAIL_D1.prepare(
          `SELECT r2_object_key FROM project_versions WHERE id = ?`,
        )
          .bind(snapshot.versionId)
          .first<{ r2_object_key: string }>();
        snapshotKey = row?.r2_object_key ?? "";
        await this.note(ctx, "snapshot.taken", { files: snapshot.files });
      }
    }

    /* ── Замер тестов ДО правок ────────────────────────────────────
     * Без него нельзя отличить «я починил» от «оно и так работало» и,
     * что важнее, от «я сломал то, что работало». Замер необязателен:
     * если прогонять нечем, работаем как раньше. */
    let testsBefore: { passed: number; failed: number } | null = null;
    if (detectBackend(this.env) !== "none" && ctx.projectId) {
      try {
        const probe = await this.executeTool("sandbox_test", {}, ctx);
        const p = probe as { passed?: number; failed?: number; total?: number };
        if (typeof p?.passed === "number" && (p.total ?? 0) > 0) {
          testsBefore = { passed: p.passed, failed: p.failed ?? 0 };
          await this.note(ctx, "tests.baseline", { passed: p.passed, failed: p.failed ?? 0 });
        }
      } catch {
        // Прогонять нечем или упало — не повод отказываться от работы.
      }
    }

    for (let i = 0; i < maxIterations; i++) {
      let decision: StepDecision;
      try {
        decision = await this.decideNextStep(goal, toolList, history, i, maxIterations, ctx, plan);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.note(ctx, "mission.failed", { reason: `решение шага: ${msg}` });
        return {
          status: "failed",
          agent: "execution-engine",
          summary: "Не удалось получить следующий шаг от модели.",
          error: msg,
          data: { missionId: ctx.missionId, steps: history },
        };
      }

      if (decision.done || !decision.tool) {
        /* ── Проверка перед «готово» ──────────────────────────────
         *
         * Раньше здесь был безусловный возврат: модель сказала done —
         * значит done. Теперь результат смотрит проверяющий с ЧИСТЫМ
         * контекстом (см. core/checker.ts, там же честно написано,
         * почему это промежуточная мера до появления песочницы).
         *
         * Отклонение не бесконечно: после MAX_REJECTIONS попыток цикл
         * отдаёт needs_input, а не done. Бесконечный пинг-понг между
         * исполнителем и проверяющим сжёг бы шаги и всё равно не
         * сошёлся бы — а незакрытую задачу нельзя выдавать за
         * закрытую.
         */
        const verdict = await checkResult(this.env, goal, history, ctx.preferredModel);
        await this.recordCheck(ctx.missionId, rejections + 1, verdict.passed, verdict.reason);
        await this.note(ctx, verdict.passed ? "check.passed" : "check.rejected", {
          reason: verdict.reason,
          iteration: i,
        });

        if (!verdict.passed && rejections < CHECK_LIMITS.MAX_REJECTIONS) {
          rejections++;
          // Возражение уходит В ИСТОРИЮ как обычный факт: исполнитель
          // увидит его на следующем шаге и продолжит работу.
          history.push({
            tool: "check",
            input: {},
            ok: false,
            result: `Проверка не пройдена: ${verdict.reason}`,
          });
          continue;
        }

        if (!verdict.passed) {
          /* Откат: работа не доведена, а файлы уже записаны.
           *
           * Возвращаем рабочую область к снимку. Файлы, появившиеся за
           * миссию и отсутствовавшие в снимке, УДАЛЯЮТСЯ — иначе откат
           * неполон: остались бы половинчатые новые файлы, на которые
           * ничего не ссылается, и разбираться пришлось бы руками. */
          let rolledBack: { restored: number; removed: number } | null = null;
          if (snapshotKey && ctx.projectId) {
            rolledBack = await rollbackWorkspace(this.env, ctx.projectId, snapshotKey);
            if (rolledBack) {
              await this.note(ctx, "rollback.done", {
                reason: `Возвращено файлов: ${rolledBack.restored}, удалено новых: ${rolledBack.removed}`,
              });
            }
          }

          await this.note(ctx, "mission.needs_input", { reason: verdict.reason, steps: history.length });
          return {
            status: "needs_input",
            agent: "execution-engine",
            summary: `Задача не доведена до конца: ${verdict.reason}`,
            questions: ["Продолжить работу или уточнить требования?"],
            data: { missionId: ctx.missionId, steps: history, iterations: i, plan, check: verdict, rolledBack },
          };
        }

        /* Сравнение с замером ДО работы.
         *
         * Критерий строже очевидного: мало починить целевое, надо ещё
         * не сломать остальное. Агент, исправивший одно и сломавший
         * три, формально решил задачу — и именно этот случай надо
         * ловить, потому что сам он о нём не сообщит. */
        const testsNow = findTestEvidence(history);
        const comparison = compareTests(
          testsBefore,
          testsNow ? { passed: testsNow.passed, failed: testsNow.failed } : null,
        );
        if (comparison.regressed) {
          await this.note(ctx, "tests.regressed", { reason: comparison.summary });
          return {
            status: "needs_input",
            agent: "execution-engine",
            summary: comparison.summary,
            questions: ["Откатить изменения или продолжить исправление?"],
            data: { missionId: ctx.missionId, steps: history, iterations: i, plan, comparison },
          };
        }

        /* Рефлексия: опыт должен пережить миссию.
         *
         * Без неё выясненное теряется полностью — следующая миссия по
         * тому же проекту начинает с нуля и наступает на те же грабли.
         *
         * Записывается НЕ пересказ работы, а то, что пригодится потом:
         * какие шаги привели к результату. Пересказ «сделал то, потом
         * это» бесполезен — он и так есть в журнале событий.
         *
         * Сбой записи миссию не роняет: работа уже сделана. */
        await this.reflect(ctx, goal, history);

        await this.note(ctx, "mission.completed", { steps: history.length, summary: decision.summary });
        return {
          status: "done",
          agent: "execution-engine",
          summary: decision.summary ?? `Миссия завершена за ${history.length} шаг(ов).`,
          data: {
            missionId: ctx.missionId,
            steps: history,
            iterations: i,
            plan,
            check: verdict,
            tests: comparison.summary,
            progress: planProgress(plan),
          },
        };
      }

      /* Зацикливание: тот же инструмент с тем же входом трижды.
       *
       * Раньше цикл останавливали только три ОШИБКИ подряд. Повтор
       * УСПЕШНОГО действия не ловился вовсе: агент мог двадцать раз
       * прочитать один файл, сжечь весь бюджет и отчитаться «потолок
       * шагов» — хотя причина была видна на первом же повторе.
       *
       * Не обрываем, а СООБЩАЕМ модели: обрыв на повторе грубее, чем
       * нужно, — модель часто выходит из тупика ровно тогда, когда ей
       * прямо сказали, что она в нём. */
      const loop = detectLoop(
        history.map((h) => ({ tool: h.tool, input: h.input })),
        { tool: String(decision.tool), input: decision.input ?? {} },
      );
      if (loop.looping) {
        await this.note(ctx, "loop.detected", { tool: String(decision.tool), reason: loop.reason });
        history.push({ tool: "loop", input: {}, ok: false, result: loop.reason });
        continue;
      }

      // Модель могла назвать инструмент, которого нет или который недоступен.
      // Это не сбой миссии: возвращаем ей отказ текстом, пусть выберет другой.
      const known = tools.find((t) => t.name === decision.tool);
      if (!known) {
        /* Запрос на необратимое действие ЗАПИСЫВАЕТСЯ.
         *
         * Таблица approvals до сих пор создавалась и пустовала. Теперь у
         * неё есть смысл: в ней видно, что агент ХОТЕЛ сделать, но не
         * смог — открыть PR, удалить файл. Это ровно тот список, по
         * которому потом решают, что разрешить следующим.
         *
         * Инструмент при этом по-прежнему не исполняется: запись — не
         * разрешение. */
        const wanted = TOOL_REGISTRY.find((t) => t.name === decision.tool);
        if (wanted?.risk === "approval") {
          await this.recordApprovalRequest(ctx.missionId, String(decision.tool), decision.reason ?? "");
          await this.note(ctx, "approval.requested", { tool: String(decision.tool), reason: decision.reason });
        }

        history.push({
          tool: String(decision.tool),
          input: decision.input ?? {},
          ok: false,
          result: `Инструмент "${decision.tool}" недоступен. Доступны только: ${tools.map((t) => t.name).join(", ")}.`,
        });
        consecutiveFailures++;
        if (consecutiveFailures >= 3) break;
        continue;
      }

      const callId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      await this.note(ctx, "tool.started", { tool: known.name, reason: decision.reason, iteration: i });

      try {
        const output = await this.executeTool(known.name, decision.input ?? {}, { ...ctx, iteration: i });
        const rendered = this.renderResult(output);
        history.push({ tool: known.name, input: decision.input ?? {}, ok: true, result: rendered });
        consecutiveFailures = 0;
        // Шаг плана закрывается только по УСПЕШНОМУ вызову. На ошибке
        // план не двигается: иначе прогресс показывал бы движение там,
        // где система топчется на месте.
        if (plan.length) plan = await advancePlan(this.env, ctx.missionId, plan, decision.reason);
        await this.recordToolCall(ctx.missionId, callId, known.name, "done", decision.input, rendered, null, startedAt);
        await this.note(ctx, "tool.finished", { tool: known.name, iteration: i });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        history.push({ tool: known.name, input: decision.input ?? {}, ok: false, result: `Ошибка: ${msg}` });
        consecutiveFailures++;
        await this.recordToolCall(ctx.missionId, callId, known.name, "failed", decision.input, null, msg, startedAt);
        await this.note(ctx, "tool.failed", { tool: known.name, error: msg, iteration: i });

        if (consecutiveFailures >= 3) {
          await this.note(ctx, "mission.failed", { reason: "три ошибки подряд" });
          return {
            status: "failed",
            agent: "execution-engine",
            summary: "Три шага подряд закончились ошибкой — цикл остановлен, чтобы не тратить вызовы впустую.",
            error: msg,
            data: { missionId: ctx.missionId, steps: history },
          };
        }
      }
    }

    // Потолок исчерпан. Это НЕ "done": задача могла остаться недоделанной,
    // и выдавать её за выполненную нельзя.
    await this.note(ctx, "mission.exhausted", { steps: history.length });
    return {
      status: "needs_input",
      agent: "execution-engine",
      summary: `Потолок в ${maxIterations} шаг(ов) исчерпан, задача не закрыта. Ниже — что успел сделать.`,
      questions: ["Продолжить с этого места?"],
      data: { missionId: ctx.missionId, steps: history, exhausted: true },
    };
  }

  /** Один запрос к модели: что делать дальше. */
  private async decideNextStep(
    goal: string,
    toolList: string,
    history: StepRecord[],
    iteration: number,
    maxIterations: number,
    ctx: ExecutionContext,
    plan: PlanStep[] = [],
  ): Promise<StepDecision> {
    const historyBlock = renderHistory(history);

    const routed = await runModel<{ response?: string }>(
      this.env,
      "analyze_spec",
      {
        messages: [
          { role: "system", content: LOOP_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `ЗАДАЧА: ${goal}\n\n` +
              `ДОСТУПНЫЕ ИНСТРУМЕНТЫ:\n${toolList}\n\n` +
              `УЖЕ СДЕЛАНО:\n${historyBlock}\n\n` +
              // План идёт В КОНЕЦ, а не в начало. К концу длинного запроса
              // модель хуже всего помнит именно начало — поэтому цель
              // проговаривается последней, ближе всего к моменту решения.
              (plan.length ? `${renderPlan(plan)}\n\n` : "") +
              `Шаг ${iteration + 1} из ${maxIterations}. Верни JSON со следующим действием.`,
          },
        ],
      },
      {
        preferredModel: ctx.preferredModel,
        // Ответ без разбираемого JSON бесполезен: из него нельзя достать ни
        // инструмент, ни признак завершения. Проверка структурная и
        // бесплатная — маршрутизатор попробует другую модель, а не отдаст
        // цикл в разбор мусора.
        validate: (out) => (parseDecision(extractText(out)) ? true : "ответ не содержит валидного JSON-решения"),
      },
    );

    const parsed = parseDecision(extractText(routed.output));
    if (!parsed) throw new Error("модель не вернула валидный JSON-шаг");
    return parsed;
  }

  /**
   * Результат инструмента для модели — текстом и с обрезкой.
   * Целый файл на 5000 строк, положенный в историю, вытеснит из контекста
   * саму задачу, и на третьем шаге модель забудет, что делает.
   */
  private renderResult(output: unknown): string {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const LIMIT = 4000;
    return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…(обрезано, всего ${text.length} символов)` : text;
  }

  /** След вызова в D1. Не роняет миссию, если запись не удалась, но и не
   *  молчит: потерянный след — невидимая дыра в истории. */
  private async recordToolCall(
    missionId: string,
    id: string,
    tool: string,
    status: string,
    input: unknown,
    output: string | null,
    error: string | null,
    startedAt: string,
  ): Promise<void> {
    try {
      await this.env.AZRAIL_D1.prepare(
        `INSERT INTO tool_calls (id, mission_id, tool, status, input, output, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, missionId, tool, status, JSON.stringify(input ?? null), output, error, startedAt, new Date().toISOString())
        .run();
    } catch (err) {
      log("error", "execution.tool_call_write_failed", {
        missionId,
        tool,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Записать событие в D1 И показать его вживую. Показ не критичен —
   *  его сбой не должен ронять миссию, поэтому он отдельно в try/catch. */
  /**
   * Построить план миссии одним обращением к модели.
   *
   * Список инструментов даётся специально: план из шагов, которые нечем
   * выполнить, хуже отсутствия плана — он уводит исполнителя в тупик и
   * тратит шаги на попытки сделать невозможное.
   */
  private async buildPlan(
    goal: string,
    toolList: string,
    maxIterations: number,
    ctx: ExecutionContext,
  ): Promise<PlanStep[]> {
    const routed = await runModel<{ response?: string }>(
      this.env,
      "chat",
      {
        messages: [
          {
            role: "user",
            content:
              `Разбей задачу на последовательные шаги.\n\n` +
              `ЗАДАЧА: ${goal}\n\n` +
              `ДОСТУПНЫЕ ИНСТРУМЕНТЫ:\n${toolList}\n\n` +
              `Шагов должно быть не больше ${Math.min(maxIterations, 8)}. ` +
              `Каждый шаг — то, что выполнимо ПЕРЕЧИСЛЕННЫМИ выше инструментами. ` +
              `Не придумывай шагов, для которых инструментов нет.\n` +
              `Ответь строго JSON-массивом строк: ["шаг", "шаг"]`,
          },
        ],
      },
      { preferredModel: ctx.preferredModel },
    );

    const titles = parsePlan(extractText(routed.output));
    if (!titles.length) return [];
    return savePlan(this.env, ctx.missionId, titles);
  }

  /**
   * Записать вердикт проверки.
   *
   * Пишутся ВСЕ проверки, включая пройденные. Без отказов в данных
   * нельзя отличить «задачи были простые» от «проверяющий пропускает
   * всё подряд» — а второе означает, что проверка декоративная.
   */
  /**
   * Извлечь урок из завершённой миссии.
   *
   * Записывается ровно один факт — самый полезный. Десять фактов с
   * каждой миссии за месяц превращают память в шум, из которого модель
   * ничего не выберет, и она перестаёт работать как память.
   *
   * Категория "known_issue" для миссий с ошибками по пути, иначе
   * "architecture_decision": то, ЧТО помогло, полезнее того, что делали.
   */
  private async reflect(
    ctx: ExecutionContext,
    goal: string,
    history: { tool: string; ok: boolean; result: string }[],
  ): Promise<void> {
    if (!ctx.projectId || history.length < 2) return;

    const failures = history.filter((h) => !h.ok);
    const tools = [...new Set(history.filter((h) => h.ok).map((h) => h.tool))];

    try {
      await rememberFact(this.env, ctx.projectId, {
        category: failures.length ? "known_issue" : "architecture_decision",
        key: goal.slice(0, 80),
        value: failures.length
          ? `Решено за ${history.length} шаг(ов) через ${tools.join(", ")}. По пути мешало: ${failures[0].result.slice(0, 200)}`
          : `Решено за ${history.length} шаг(ов) через ${tools.join(", ")}.`,
      });
    } catch (err) {
      log("warn", "reflect.failed", {
        missionId: ctx.missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Записать запрос на необратимое действие.
   *
   * Статус остаётся "pending" и никем не меняется — сознательно. Это
   * пока журнал намерений, а не механизм одобрения: одобрять нечем,
   * интерфейса для решения нет. Но список того, что система пыталась
   * сделать и не смогла, ценен сам по себе — по нему видно, чего ей
   * реально не хватает, а не что кажется нужным со стороны.
   */
  private async recordApprovalRequest(missionId: string, tool: string, reason: string): Promise<void> {
    try {
      await this.env.AZRAIL_D1.prepare(
        `INSERT INTO approvals (id, mission_id, action, status) VALUES (?, ?, ?, 'pending')`,
      )
        .bind(crypto.randomUUID(), missionId, `${tool}: ${reason}`.slice(0, 500))
        .run();
    } catch (err) {
      log("warn", "approval.record_failed", {
        missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async recordCheck(missionId: string, attempt: number, passed: boolean, reason: string): Promise<void> {
    try {
      await this.env.AZRAIL_D1.prepare(
        `INSERT INTO mission_checks (id, mission_id, attempt, passed, reason) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), missionId, attempt, passed ? 1 : 0, reason.slice(0, 800))
        .run();
    } catch (err) {
      log("error", "check.record_failed", {
        missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async note(
    ctx: ExecutionContext,
    event: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    // Запись в журнал НЕ должна ронять миссию.
    //
    // Раньше этот await стоял голым, и любой сбой D1 выбрасывал исключение
    // наружу через runMission — миссия умирала целиком, уже успев записать
    // файлы. Хуже того: первое событие (mission.started) отправляется ДО
    // начала работы, поэтому при неприменённой схеме падала бы каждая
    // миссия, хотя сама работа выполнима.
    //
    // Ровно тот же класс ошибки мы уже чинили в rememberFact: сбой
    // вспомогательной записи подменял результат основной работы.
    // Журнал важен, но он вторичен по отношению к делу, которое описывает.
    try {
      await emitMissionEvent(this.env, ctx.missionId, event, data);
    } catch (err) {
      log("error", "execution.event_write_failed", {
        missionId: ctx.missionId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!ctx.onEvent) return;
    try {
      ctx.onEvent({
        event,
        tool: typeof data?.tool === "string" ? data.tool : undefined,
        reason: typeof data?.reason === "string" ? data.reason : undefined,
        iteration: typeof data?.iteration === "number" ? data.iteration : undefined,
        // Нужен интерфейсу, чтобы показать ЧЕСТНЫЙ процент: шаг из скольких.
        // Без него прогресс пришлось бы выдумывать — а зашитые проценты мы
        // уже видели в чужом макете и решили, что так нельзя.
        maxIterations: typeof data?.maxIterations === "number" ? data.maxIterations : undefined,
        // Число шагов плана — для строки «план составлен: N шагов».
        steps: typeof data?.steps === "number" ? data.steps : undefined,
        files: typeof data?.files === "number" ? data.files : undefined,
      });
    } catch (err) {
      log("warn", "execution.live_event_failed", {
        missionId: ctx.missionId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Вызов агента через Оркестратор.
   *
   * Требует ctx.invokeCapability — его прокидывает роут, у которого есть
   * ссылка на Durable Object. Без него инструмент честно отказывает, а не
   * падает с невнятной ошибкой: цикл может работать и без агентов, просто
   * с меньшим набором.
   *
   * Отказ агента (нет GITHUB_TOKEN, ветка не найдена) возвращается модели
   * ТЕКСТОМ, а не бросается: это нормальный ход миссии — пусть выберет
   * другой путь, а не роняет всю работу.
   */
  private async viaAgent(
    ctx: ExecutionContext,
    capability: "git" | "qa",
    request: TaskRequest,
  ): Promise<unknown> {
    if (!ctx.invokeCapability) {
      throw new Error(
        `Инструмент требует агента "${capability}", но вызов агентов в этом контексте не подключён.`,
      );
    }
    const res = await ctx.invokeCapability(capability, request);
    if (res.status === "failed") return `Агент ${capability} не смог: ${res.error ?? res.summary}`;
    if (res.status === "needs_input") {
      return `Агенту ${capability} не хватает данных: ${res.summary}` +
        (res.questions?.length ? ` (${res.questions.join("; ")})` : "");
    }
    return res.data ?? res.summary;
  }

  private requireProject(ctx: ExecutionContext): void {
    if (!ctx.projectId) throw new Error("projectId обязателен для workspace-инструмента.");
  }
}

/** Одна запись истории — что позвали и что получилось. */
export interface StepRecordView {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: string;
}

/**
 * История для модели: свежие шаги полностью, старые — свёрнуто.
 *
 * Раньше вся история уходила в запрос целиком. Каждый результат до 4000
 * символов, потолок 20 шагов — к концу цикла это до 80 000 символов в
 * КАЖДОМ запросе, и стоимость растёт квадратично: двадцатый шаг оплачивает
 * все девятнадцать предыдущих заново. Хуже денег то, что задача и список
 * инструментов тонут в этом объёме, и модель теряет исходную цель.
 *
 * Свежие шаги важнее старых: решение принимается по последнему состоянию.
 * От старых достаточно факта — что звали и получилось ли. Это не потеря:
 * файл, прочитанный на втором шаге, при необходимости читается заново, и
 * это дешевле, чем возить его копию в каждом запросе.
 *
 * ОШИБКИ старых шагов остаются читаемыми при любом возрасте: повторить уже
 * сделанную ошибку — самый частый способ потратить шаг впустую.
 */
export function renderHistory(history: StepRecordView[], fullTail = 4): string {
  if (!history.length) return "(шагов ещё не было)";
  return history
    .map((h, n) => {
      const head = `${n + 1}. ${h.tool}(${JSON.stringify(h.input)}) -> ${h.ok ? "ок" : "ОШИБКА"}`;
      if (n >= history.length - fullTail) return `${head}: ${h.result}`;
      if (!h.ok) return `${head}: ${h.result.slice(0, 200)}`;
      return `${head} (${h.result.length} символов, свёрнуто)`;
    })
    .join("\n");
}

/**
 * Разбор решения модели.
 *
 * Модели регулярно оборачивают JSON в ```json-блок вопреки инструкции — это
 * не повод ронять шаг, обёртка снимается. Но если валидного JSON нет вовсе,
 * возвращается null, и вызывающий решает, что делать: угадывать намерение по
 * прозе значило бы исполнять то, чего модель не просила.
 */
export function parseDecision(text: string): StepDecision | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  const attempt = (s: string): StepDecision | null => {
    try {
      const v = JSON.parse(s);
      if (!v || typeof v !== "object") return null;
      const d = v as StepDecision;
      // Пустой объект — не решение: ни инструмента, ни признака конца.
      if (!d.tool && d.done !== true) return null;
      return d;
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct) return direct;

  // JSON мог прийти внутри прозы — берём первый СБАЛАНСИРОВАННЫЙ объект.
  // Наивное "от первой { до последней }" склеивает два объекта подряд в одну
  // строку и разваливается на ней, а фигурная скобка внутри строкового
  // значения ломает простой счётчик — поэтому кавычки и экранирование
  // отслеживаются отдельно.
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return attempt(cleaned.slice(start, i + 1));
    }
  }
  return null;
}
