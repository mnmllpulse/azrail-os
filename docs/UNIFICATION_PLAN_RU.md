# DARK MNMLL PULSE OS × AZRAIL — план объединения

Статус: post-merge hardening.  
Основная интеграция смержена в `main`; дальнейшая стабилизация идёт через `hardening/post-merge-stabilization`.

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
- [ ] AppShell / NavigationRail / HeroComposer.
- [x] Главный путь: Create → Mission → Result.
- [x] Studio/Labs/Projects как вторичные пространства.
- [ ] Advanced details для агентов, моделей, инструментов, логов и стоимости.

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
- [x] Автовыбор агентов и студии по intent.
- [x] Единый model registry / model policy.
- [x] Sandbox execution и жёсткая verification boundary.

### P2 — консолидация
- [x] Перенести старые панели под Advanced/Legacy.
- [x] Устранить дубли UI и старые orchestrator-панели из основного UX.
- [x] Единые Projects/Files/Memory.
- [x] Read-only SYSTEM observability, usage и cost visibility.
- [ ] Production smoke tests и staged deploy.

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

- PR #1 — merged: protocol, Project-first foundation, Pulse Shell.
- PR #2 — merged: production Globe, live presence, Projects/Files/Memory, Studio/Labs routing, CI workflow.
- PR #3 — merged: idempotency admission hotfix.
- GitHub Actions остаётся инфраструктурным blocker: jobs получают `runner_id: 0`, `runner_name: ""`, `steps: []`. Отслеживается в issue #9.
- Следующий обязательный рубеж: восстановить runner → зелёный CI → D1 migration на staging → smoke tests → production.
- После стабилизации: React-компонентизация AppShell/NavigationRail/HeroComposer и финальный visual polish.
