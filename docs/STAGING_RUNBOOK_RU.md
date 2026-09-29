# Staging runbook — AZRAIL / DARK MNMLL PULSE OS

Цель: проверить миграции и объединённый Pulse Shell на отдельной Cloudflare-среде, не используя production D1/KV/R2.

## 1. Создать отдельные ресурсы

Создать отдельные:
- Worker: `azrail-os-staging`;
- D1: `azrail-db-staging`;
- KV namespace для staging;
- R2 bucket: `azrail-artifacts-staging`.

Production IDs из `wrangler.toml` использовать запрещено.

## 2. Подготовить конфигурацию

```bash
cp wrangler.staging.example.toml wrangler.staging.toml
```

Заполнить только:
- `database_id = "..."`;
- `AZRAIL_KV id = "..."`.

Файл `wrangler.staging.toml` находится в `.gitignore` и не должен коммититься.

Staging по умолчанию использует `AZRAIL_FORCE_FREE="true"`: платные/сторонние model routes не должны включаться во время инфраструктурной проверки.

## 3. Проверить конфигурацию без deploy

```bash
npm run staging:check
```

Preflight откажется работать, если обнаружит production D1/KV/R2 или незаполненные placeholder IDs.

## 4. Установить staging secret

```bash
npx wrangler secret put AZRAIL_TOKEN --config wrangler.staging.toml
```

Не хранить secret в GitHub, TOML, frontend или localStorage.

## 5. D1 inspection

```bash
npm run staging:migrate:plan
```

Команда только читает remote schema и создаёт `.work/migration-plan.sql`. Изменений в D1 не делает.

Проверить, что план включает `020-pulse-presence.sql` и не содержит неожиданных destructive statements.

## 6. Применить D1 migration

Только после проверки плана:

```bash
npm run staging:migrate:apply
```

Скрипт сначала экспортирует D1 backup, затем применяет SQL и проверяет обязательные таблицы.

## 7. Deploy staging

```bash
npm run staging:deploy
```

Перед deploy повторно выполняются preflight и Wrangler dry-run.

## 8. Smoke test

```bash
AZRAIL_URL="https://<staging-worker>.workers.dev" \
AZRAIL_TOKEN="<staging-token>" \
npm run staging:smoke
```

Минимум должны пройти:
- unauthenticated /api/me → 401;
- прямой agent RPC → 404;
- authenticated /api/me → 200;
- /health → 200;
- /api/agents → 200.

После этого вручную проверить:
- /pulse.html;
- Create → Project → Mission → Result;
- AUTO/Studio routing;
- Projects Files/Memory/Versions/History;
- SYSTEM health/metrics/cost visibility;
- Globe presence heartbeat;
- mobile/reduced-motion.

## 9. Production gate

Production deploy запрещён, пока:
- GitHub Actions issue #9 не закрыт успешным runner;
- CI не зелёный;
- staging smoke test не зелёный;
- D1 backup существует;
- production migration plan просмотрен отдельно.
