# AZRAIL OS — безопасный staging

## Цель

Поднять отдельный persistent staging Worker без доступа к production D1/KV/R2 и без платных third-party model routes.

Cloudflare рекомендует Wrangler environments для постоянных staging/dev окружений. Пока staging resource IDs ещё не созданы и Cloudflare account context не подключён к этому workflow, репозиторий хранит только bootstrap-шаблон wrangler.staging.toml.example. После получения реальных staging IDs конфигурацию следует перенести в канонический [env.staging] основного Wrangler config.

Важно: bindings и vars для named environments задаются явно; нельзя рассчитывать, что D1/KV/R2/vars автоматически наследуются из production.

## Baseline

- Worker: azrail-os-staging
- D1: azrail-db-staging
- KV: отдельный staging namespace
- R2: azrail-artifacts-staging
- Workers AI: safe/free baseline
- third-party paid routing: OFF
- AI Gateway: OFF
- containers: OFF
- cron: OFF
- wildcard CORS: запрещён
- staging token: отдельный secret

## 1. Проверить Cloudflare identity

    npx wrangler whoami

## 2. Создать отдельные staging resources

    npx wrangler d1 create azrail-db-staging
    npx wrangler kv namespace create AZRAIL_KV_STAGING
    npx wrangler r2 bucket create azrail-artifacts-staging

Не копировать production IDs из wrangler.toml.

## 3. Создать локальный staging config

    cp wrangler.staging.toml.example wrangler.staging.toml

Вставить только новые staging D1/KV IDs. Файл wrangler.staging.toml не коммитится.

## 4. Fail-closed проверка

    npm run staging:check

Проверка останавливает процесс, если:
- остались placeholders;
- staging использует production D1/KV/R2;
- включены AI Gateway, containers или cron;
- wildcard CORS включён;
- token записан прямо в config;
- staging config совпадает с example/production.

## 5. Инициализировать staging D1

Перед Worker deploy:

    npx wrangler d1 execute AZRAIL_D1 --remote --config wrangler.staging.toml --file=./schema.sql

Если staging база уже существовала на старой схеме, применить только проверенный migration plan.

## 6. Добавить отдельный staging secret

    npx wrangler secret put AZRAIL_TOKEN --config wrangler.staging.toml

Production token не копировать.

## 7. Dry run

    npm run staging:dry-run

Dry run проверяет сборку/config, но не доказывает доступность runtime bindings.

## 8. Deploy — только после dry run и migration

    npm run staging:deploy

На bootstrap этапе staging публикуется в отдельный *.workers.dev Worker. Production route/custom domain не затрагивается.

После появления реальных staging IDs целевая конфигурация должна перейти в [env.staging], а команды — на:

    npx wrangler deploy --env staging

## 9. Smoke checklist

1. GET /health
2. загрузка /pulse.html
3. staging token через /api/azrail/me
4. создание Project через /api/azrail/projects
5. запуск короткой mission через /api/azrail/mission
6. polling mission status
7. Project Workspace
8. /api/azrail/metrics?projectId=...
9. /api/azrail/routing-settings
10. presence heartbeat → Globe marker
11. подтверждение, что staging bindings не совпадают с production

Команда read-only smoke после deploy:

    AZRAIL_URL=https://<staging-worker>.workers.dev AZRAIL_TOKEN=<staging-token> npm run smoke

Если уже есть staging Project и нужно проверить ownership-protected metrics:

    AZRAIL_URL=https://<staging-worker>.workers.dev AZRAIL_TOKEN=<staging-token> AZRAIL_PROJECT_ID=<project-id> npm run smoke

Smoke не создаёт миссии и не пишет presence — это отдельные ручные/интеграционные проверки.

## 10. Promotion

Продвигается код, а не staging resource IDs. Production D1/KV/R2 остаются неизменными.
