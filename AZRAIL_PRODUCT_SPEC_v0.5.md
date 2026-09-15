# AZRAIL PRODUCT SPEC v0.5

> **Это ЗАМЫСЕЛ, а не отчёт о сделанном.** Отметки ниже добавлены при
> сверке с кодом: ✅ работает, ⏳ частично, ❌ не начато. Без них документ
> читается как описание готового продукта — и именно так его прочтёт любой,
> кто откроет папку через полгода.

## Goal
Turn AZRAIL from an API-oriented prototype into a real mission workspace.

## Primary user journey
Create → Clarify → Plan → Execute → Verify → Preview → Deliver.

## Chat capabilities
✅ Attach files (+ drag-and-drop) · ✅ voice input · ✅ prompt polish ·
✅ model selection · ✅ send/stop · ✅ copy · ✅ regenerate ·
✅ response versions · ✅ TTS
❌ web search — инструмента нет вообще
❌ edit/branch — `parent_message_id` в схеме есть, интерфейса нет
❌ feedback (лайк/дизлайк) — таблицы под оценки нет
⏳ save-to-memory — агенты пишут, ручного сохранения из чата нет

## Code/artifact capabilities
✅ copy · ✅ preview (HTML в изолированном iframe) · ✅ download (файл и ZIP) ·
✅ rollback (`project_versions`) · ✅ test (`run_tests` через QA Agent) ·
✅ compare (`git_diff` через Git Agent)
❌ run — sandbox не подключён, нужен платный план Workers
⏳ fix/apply — правка есть (`edit_file`), отдельного цикла «почини» нет

## Core runtime
✅ Execution Loop (`core/execution-engine.ts`) · ✅ Tool Registry ·
✅ Workspace (R2) · ✅ Event Stream (D1 + WebSocket) · ✅ Memory ·
⏳ Recovery — три ошибки подряд останавливают цикл; отката нет
❌ Quality Gate — отдельной проверки перед «готово» нет
❌ Approval Engine — таблица `approvals` создана и ПУСТУЕТ: цикл к
   approval-инструментам не допущен вовсе, одобрять пока нечего

## Safety model
SAFE actions may run automatically. REVIEW actions modify the workspace. APPROVAL actions require explicit user confirmation.

## Truthfulness
UI must distinguish real runtime values from demo/mock values.

Соблюдается и проверяется тестами: инструменты без адаптера помечены
`available: false`; прогресс миссии считается от реального номера шага;
незакрытая миссия не показывается стопроцентной; лента событий не печатает
придуманную активность по таймеру.

Оговорка про «Done только после quality gate» пока НЕ выполняется —
Quality Gate не построен. Сейчас `done` означает «модель сочла задачу
решённой», и это слабее обещанного.
