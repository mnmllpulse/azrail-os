# DARK MNMLL PULSE OS × AZRAIL — план объединения

Статус: integration branch.  
Ветка: `integration/pulse-os-unification`.

## Архитектурное решение

Пользователь получает одно приложение, но runtime остаётся разделённым:

1. **Pulse Shell** — интерфейс, проекты, файлы, студии, глобус, сессии и навигация.
2. **AZRAIL Core** — Orchestrator, агенты, model router, execution engine, sandbox, verification и memory.
3. **Canonical Protocol** — стабильный контракт между UI и AZRAIL Core.
4. **Cloudflare** — Workers, D1, R2, KV, Durable Objects, Workers AI / AI Gateway.

Не допускается прямое копирование двух entrypoint-файлов в один монолит.

## Порядок реализации

### P0 — фундамент
- [x] Создать integration-ветку от актуального main.
- [x] Зафиксировать canonical mission protocol.
- [x] Добавить Pulse Globe как независимый модуль.
- [x] Подключить Pulse Globe к UI без влияния на mission runtime.
- [x] Ввести единый `/api/azrail/*` facade.
- [x] Отделить transport DTO от внутренних типов агентов.
- [x] Ввести Project как верхний объект пользовательской работы.
- [x] Убрать ручной выбор нескольких оркестраторов из основного UX.

### P1 — интерфейс
- [x] Канонизировать Ultimate visual tokens.
- [x] AppShell / NavigationRail / HeroComposer.
- [x] Главный путь: Create → Mission → Result.
- [x] Studio/Labs/Projects как вторичные пространства.
- [x] Advanced details для runtime, моделей, стоимости, разрешений и observability.

### P1 — Globe
- [x] Three.js как локальная npm-зависимость для production-компонента.
- [x] Медленное вращение.
- [x] Три системных орбитальных кольца.
- [x] Реальный presence API вместо синтетических значений.
- [x] Lazy loading и reduced-motion.
- [x] Mobile low-cost rendering profile.

### P1 — AZRAIL
- [x] Один Orchestrator.
- [x] Planner → Agents → Tools → Execute → Verify → Reflect → Repair → Checkpoint.
- [x] Автовыбор routing/context через единый Composer; agent selection остаётся Orchestrator responsibility.
- [x] Единый model registry / model policy.
- [x] Sandbox execution и жёсткая verification boundary.

### P2 — консолидация
- [x] Перенести старые панели под Advanced/Legacy.
- [x] Убрать старые orchestrator-панели из primary navigation; физическая cleanup-миграция остаётся отдельным этапом.
- [x] Единые Projects/Files/Memory через Project Workspace API.
- [x] Observability, usage и cost controls.
- [ ] Production smoke tests и staged deploy — runbook/commands готовы, Cloudflare account context ещё не подключён.

## UX-принцип

Главный экран обязан отвечать на один вопрос:

> Что создать?

Пользователь описывает результат. Система сама определяет intent, агентов, модели, инструменты и verification pipeline.

## Запрещённые архитектурные анти-паттерны

- второй параллельный model router;
- несколько независимых orchestrator runtime;
- секреты в frontend/localStorage;
- прямой доступ UI к внутренним Durable Object RPC;
- объединение двух D1 без миграционного плана;
- тяжёлый 3D bundle в initial load;
- декоративные метрики, не подтверждённые runtime-данными.


## Текущий статус

Интеграция разбита на два PR, чтобы не смешивать архитектурный фундамент и productionization Globe.

- PR #1: protocol, Project-first foundation, Pulse Shell, routing profiles — уже merged.
- PR #2: local Three.js bundle, privacy-preserving live presence, D1 migration, CI — draft до зелёных проверок.

Следующий блок после PR #2: единые Files/Memory/Projects UI, затем Studios consolidation и перенос Legacy в Advanced.


## Visual source of truth

Canonical Canva v2: `DAHWmV1b58E`  
Reference: `docs/UI_CANONICAL_REFERENCE_RU.md`

Canva задаёт визуальную иерархию. GitHub остаётся runtime/architecture source of truth.
