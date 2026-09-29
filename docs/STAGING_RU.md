# AZRAIL / DARK MNMLL PULSE OS — Staging Runbook

Цель staging — проверить новый Pulse Shell, Globe, Project Workspace, Studio routing и миграции без доступа к production D1/KV/R2.

## 0. Жёсткие правила

- staging НЕ использует production D1;
- staging НЕ использует production KV;
- staging НЕ использует production R2;
- `AZRAIL_FORCE_FREE = "true"`;
- staging не подключает `AZRAIL_SANDBOX`/containers;
- production deploy не выполняется из этого runbook;
- сначала inspection, затем migration apply, затем deploy.

## 1. Создать отдельные Cloudflare-ресурсы

Нужны три ресурса:

- D1: `azrail-db-staging`
- KV: отдельный staging namespace
- R2: `azrail-artifacts-staging`

После создания заменить в `wrangler.staging.toml`:

- `REPLACE_STAGING_D1_ID`
- `REPLACE_STAGING_KV_ID`
- `REPLACE_STAGING_ORIGIN`

До замены guard намеренно останавливает сборку.

## 2. Проверить изоляцию

```bash
npm run staging:check
```

Проверка сравнивает staging и production D1/KV/R2 и запрещает Sandbox/container binding.

## 3. Сначала построить план миграции

```bash
npm run db:migrate:staging:plan
```

Команда читает удалённую staging D1 и создаёт `.work/migration-plan.sql`, но НЕ изменяет базу.

## 4. Применить staging migration

```bash
npm run db:migrate:staging:apply
```

Перед изменением скрипт экспортирует D1 backup. После применения проверяет обязательные таблицы, включая `pulse_presence`.

## 5. Добавить staging access secret

В staging Worker добавить отдельный `AZRAIL_TOKEN`. Production token не использовать.

## 6. Dry-run

```bash
npm run build:staging
```

Команда проверяет staging isolation, собирает Ultimate/Pulse Globe и выполняет Wrangler dry-run.

## 7. Deploy staging

Только после успешных предыдущих шагов:

```bash
npm run deploy:staging
```

## 8. Smoke checklist

1. `/` открывает Pulse, не legacy Dashboard.
2. Globe вращается медленно; reduced-motion останавливает автоматическое вращение.
3. STUDIO и LABS используют один Composer и один AZRAIL runtime.
4. PROJECTS показывает Files / Memory / Versions / History.
5. CREATE создаёт Project при необходимости и запускает одну миссию.
6. AUTO routing возвращает реальный `studio` и `routingMode`.
7. SYSTEM показывает реальные `/me`, `/routing-settings`, `/metrics`.
8. `/ultimate.html` и `/index.html` остаются доступны как Advanced/Legacy.
9. Presence использует только региональную точность.
10. Production D1/R2/KV не изменились.

## 9. Production gate

Production запрещён, пока не пройдены: typecheck, tests, UI builds, Wrangler dry-run, staging smoke, review D1 migration и проверяемая CI-среда.
