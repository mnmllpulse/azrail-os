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
- [ ] Добавить Pulse Globe как независимый модуль.
- [ ] Подключить Pulse Globe к UI без влияния на mission runtime.
- [ ] Ввести единый `/api/azrail/*` facade.
- [ ] Отделить transport DTO от внутренних типов агентов.
- [ ] Ввести Project как верхний объект пользовательской работы.
- [ ] Убрать ручной выбор нескольких оркестраторов из основного UX.

### P1 — интерфейс
- [ ] Канонизировать Ultimate visual tokens.
- [ ] AppShell / NavigationRail / HeroComposer.
- [ ] Главный путь: Create → Mission → Result.
- [ ] Studio/Labs/Projects как вторичные пространства.
- [ ] Advanced details для агентов, моделей, инструментов, логов и стоимости.

### P1 — Globe
- [ ] Three.js как локальная npm-зависимость для production-компонента.
- [ ] Медленное вращение.
- [ ] Три системных орбитальных кольца.
- [ ] Реальный presence API вместо синтетических значений.
- [ ] Lazy loading и reduced-motion.
- [ ] Mobile low-cost rendering profile.

### P1 — AZRAIL
- [ ] Один Orchestrator.
- [ ] Planner → Agents → Tools → Execute → Verify → Reflect → Repair → Checkpoint.
- [ ] Автовыбор агентов и студии по intent.
- [ ] Единый model registry / model policy.
- [ ] Sandbox execution и жёсткая verification boundary.

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
