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
- [ ] Убрать ручной выбор нескольких оркестраторов из основного UX.

### P1 — интерфейс
- [x] Канонизировать Ultimate visual tokens.
- [ ] AppShell / NavigationRail / HeroComposer.
- [x] Главный путь: Create → Mission → Result.
- [ ] Studio/Labs/Projects как вторичные пространства.
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
- [ ] Автовыбор агентов и студии по intent.
- [x] Единый model registry / model policy.
- [x] Sandbox execution и жёсткая verification boundary.

### P2 — консолидация
- [ ] Перенести старые панели под Advanced/Legacy.
- [ ] Устранить дубли UI и старые orchestrator-панели.
- [ ] Единые Projects/Files/Memory.
- [ ] Observability, usage и cost controls.
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

Интеграция разбита на два PR, чтобы не смешивать архитектурный фундамент и productionization Globe.

- PR #1: protocol, Project-first foundation, Pulse Shell, routing profiles — уже merged.
- PR #2: local Three.js bundle, privacy-preserving live presence, D1 migration, CI — draft до зелёных проверок.

Следующий блок после PR #2: единые Files/Memory/Projects UI, затем Studios consolidation и перенос Legacy в Advanced.
