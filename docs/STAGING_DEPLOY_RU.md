# AZRAIL OS — безопасный staging deploy

## Целевая Wrangler-модель

Cloudflare рекомендует для постоянных окружений использовать Wrangler environments. После того как staging D1/KV/R2 реально созданы и их IDs известны, канонический вариант должен быть перенесён в основной Wrangler source of truth под `[env.staging]`, а команды — использовать `--env staging`.

Пока Cloudflare account context не подключён к рабочему процессу, в репозитории используется `wrangler.staging.toml.example`: это bootstrap-шаблон, который специально не содержит production IDs и не делает основной `wrangler.toml` невалидным placeholders.

После появления staging IDs:
1. перенести staging bindings в `[env.staging]`;
2. проверить, что bindings/vars объявлены явно — они не наследуются автоматически;
3. заменить staging npm-команды на `wrangler ... --env staging`;
4. удалить отдельный локальный staging config после успешной миграции.

Цель: развернуть отдельный Cloudflare Worker без использования production D1/KV/R2.

## 0. Принцип

Staging не использует production resource IDs. По умолчанию:

- Worker: `azrail-os-staging`
- D1: `azrail-db-staging`
- KV: отдельный staging namespace
- R2: `azrail-artifacts-staging`
- third-party models: OFF
- `AZRAIL_FORCE_FREE=true`
- metering: `observe`
- containers: OFF
- cron: OFF

## 1. Проверка аккаунта

```bash
npx wrangler whoami
```

## 2. Создать staging resources

```bash
npx wrangler d1 create azrail-db-staging
npx wrangler kv namespace create AZRAIL_KV_STAGING
npx wrangler r2 bucket create azrail-artifacts-staging
```

D1 и KV вернут IDs. Не использовать значения из production `wrangler.toml`.

## 3. Создать реальный staging config

```bash
cp wrangler.staging.toml.example wrangler.staging.toml
```

Вставить только staging D1/KV IDs.

## 4. Fail-closed проверка

```bash
npm run staging:check
```

Проверка останавливает процесс, если:

- остались placeholders;
- Worker/D1/R2 имеют не-staging имена;
- D1/KV/R2 совпадают с production;
- включён AI Gateway;
- включены containers или cron;
- включён wildcard CORS.

## 5. Схема D1 ДО Worker deploy

```bash
npx wrangler d1 execute AZRAIL_D1 --remote --config wrangler.staging.toml --file=./schema.sql
```

После этого применить миграционный plan только если staging DB обновляется с более старой версии.

## 6. Staging secret

```bash
npx wrangler secret put AZRAIL_TOKEN --config wrangler.staging.toml
```

Использовать отдельный staging token. Production token сюда не копировать.

## 7. Dry run

```bash
npm run staging:dry-run
```

Dry run не заменяет D1 migration и не доказывает доступность runtime bindings.

## 8. Deploy

Bootstrap-вариант до переноса в Wrangler environment:

```bash
npm run staging:deploy
```

Целевой вариант после добавления `[env.staging]` в основной Wrangler config:

```bash
npx wrangler deploy --env staging
```

После первого deploy записать фактический staging URL. Если API вызывается только из UI того же Worker, same-origin запросы работают без cross-origin CORS.

## 9. Smoke

Проверить минимум:

1. `/health`;
2. загрузку `/pulse.html`;
3. авторизацию staging token;
4. создание Project;
5. запуск короткой mission;
6. polling mission status;
7. Project Workspace;
8. `/api/azrail/observability`;
9. presence heartbeat → Globe marker;
10. отсутствие доступа к production D1/KV/R2.

## 10. Promotion

Staging никогда не продвигается копированием staging resource IDs в production. Продвигается код; production bindings остаются production bindings.
