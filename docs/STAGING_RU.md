# AZRAIL Unified — проверка staging

Staging проверяет активное приложение из `ui/`: проекты, редактор, инструменты, модельные настройки, артефакты, вход и восстановление миссий. Используются `src/unified.free.ts`, каталог `site/` и те же проверки OIDC, CSP, владельца проекта и бюджета, что в основном Unified-приложении.

Старые Pulse Shell, Globe, региональный presence и интерфейсные профили `preferredMode`/`preferredStudio` сохранены в репозитории как прежние компоненты, но не входят в первый Unified-релиз. Presence API возвращает 404; запрос с прежними профилями получает 400 `routing_profile_deprecated`. Вместо них используются настройки модели проекта. Совместимые `/api/azrail/*` маршруты нормализуются перед авторизацией и идемпотентностью. Старые HTML-адреса `/index.html` и `/ultimate.html` открывают Unified-приложение.

## Подготовка отдельного окружения

Нужны отдельные ресурсы:

- Worker `azrail-pulse-staging`;
- D1 `azrail-db-staging`;
- KV namespace staging;
- R2 `azrail-artifacts-staging`;
- HTTPS origin staging и отдельный OIDC client с callback `https://<staging-host>/auth/callback`.

`wrangler.staging.toml` остаётся незаполненным шаблоном. Скопируйте его в `wrangler.staging.local.toml` в корне репозитория и исключите локальный файл из Git. В локальной копии замените все `REPLACE_*`: D1 ID, KV ID, origin, OIDC issuer и client ID. Файл остаётся в корне, чтобы относительные пути `main` и `assets.directory` у Wrangler указывали на исходники и `site/` этого проекта.

`PUBLIC_ORIGINS` содержит ровно origin без завершающего слеша. Issuer должен совпадать с issuer провайдера. Приложение поддерживает Authorization Code + PKCE S256 и проверяет state, nonce, issuer, audience и подпись ID token. Публичный OIDC client с разрешённым PKCE без client secret не требует `OIDC_CLIENT_SECRET`. Для confidential client провайдер должен поддерживать `client_secret_post`, а секрет хранится как Worker secret `OIDC_CLIENT_SECRET`. Bootstrap-токен `AZRAIL_TOKEN` для этого профиля не используется.

Для Cloudflare Access подходит отдельное Generic OIDC SaaS-приложение с точным callback `https://<staging-host>/auth/callback`, scopes `openid profile email` и политикой доступа для явно выбранных email тестировщиков. При использовании публичного клиента включите `authorization_code_with_pkce` и `allow_pkce_without_client_secret`. Issuer берётся из созданного приложения; типичный адрес — `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`. До настройки allowlist вход должен оставаться закрытым. Удаление email из Access запрещает следующий вход, но не отменяет уже выданную AZRAIL-сессию сроком до 12 часов; для немедленного отзыва отключите аккаунт или удалите его серверные сессии.

Для MCP задавайте отдельные разрешённые staging-подключения и staging-секреты. `INTEGRATION_KEY` — постоянный ключ шифрования данного окружения; его нельзя менять без миграции сохранённых подключений. Конфигурация не содержит production credentials.

## Локальная проверка изоляции

```bash
set -e
azrail_staging_config=wrangler.staging.local.toml
node scripts/check-staging.mjs --config "$azrail_staging_config"
npm run check
npx wrangler deploy --dry-run --config "$azrail_staging_config" --outdir .work/staging
```

Guard сравнивает D1/KV/R2 и Worker name с `wrangler.json`, профилями `deploy/free.json`/`deploy/paid.json`, сохранённым production `wrangler.toml` и `wrangler.generated.json`, если он существует. Проверяется и отличие origin. Guard проверяет файлы конфигурации, а не фактическое состояние аккаунта Cloudflare; фактические production ID должны быть в одном из этих файлов.

Незаполненные значения, повторное использование production-хранилища, старый entry point, отключённые проверки, открытый секрет или container binding останавливают команду. Этот отказ ожидаем в исходном шаблоне. Guard поддерживает ограниченный синтаксис текущего TOML; неизвестную или дублирующуюся запись нужно исправить явно.

Этот блок проверяет локальную конфигурацию, собирает UI, проверяет TypeScript и тесты, затем запускает Wrangler dry-run с тем же файлом. Он не публикует Worker и не выполняет AI-запросы. Команды `npm run build:staging`, `db:migrate:staging:*` и `deploy:staging` по-прежнему используют шаблон `wrangler.staging.toml` и до его заполнения намеренно отказывают; для локального конфига используйте явные команды из этого документа. Передача `--config` в составной npm-скрипт не гарантирует, что guard и Wrangler получат один файл.

## База данных

```bash
set -e
azrail_staging_config=wrangler.staging.local.toml
node scripts/check-staging.mjs --config "$azrail_staging_config"
node scripts/migrate.mjs --remote --config "$azrail_staging_config"
```

Команда читает удалённую staging D1 и создаёт `.work/migration-plan.sql`. Проверьте выбранный config, назначения миграций и сохранность данных. Затем:

```bash
set -e
azrail_staging_config=wrangler.staging.local.toml
node scripts/check-staging.mjs --config "$azrail_staging_config"
node scripts/migrate.mjs --remote --apply --config "$azrail_staging_config"
```

Перед изменением скрипт экспортирует D1 в локальный файл резервной копии, затем для удалённого окружения копирует его в `ops/backups/d1-before-<timestamp>.sql` выбранного `AZRAIL_R2`. Это одинаково работает для TOML и JSON. Bucket должен оставаться приватным: без публичного `r2.dev` и custom domain. Ошибка экспорта или загрузки R2 останавливает применение схемы. Все команды D1 и R2 используют один переданный `--config`; хранилище production не подставляется автоматически. После миграции скрипт проверяет необходимые таблицы Unified/workbench. Не используйте миграцию для удаления прежних данных Pulse.

## Публикация staging

После заполнения OIDC-конфигурации, добавления секретов, миграции и успешных локальных проверок:

```bash
set -e
azrail_staging_config=wrangler.staging.local.toml
node scripts/check-staging.mjs --config "$azrail_staging_config"
npm run build:ui
npx wrangler deploy --config "$azrail_staging_config"
```

Это изменяет только staging Worker, указанный в конфигурации. Production-публикация в этот сценарий не входит.

Wrangler требует отдельной CLI-авторизации Cloudflare. Подключённый коннектор Cloudflare не означает, что CLI уже получил credentials. Значения секретов нельзя помещать в Git, TOML или логи. Для автоматизации используйте отдельное окружение staging и ручной workflow с этой же последовательностью, отдельной concurrency и credentials соответствующего аккаунта. Не запускайте `deploy:ci` для staging: он использует общий provisioning и production-профиль. Если GitHub credential не разрешает изменение workflow-файлов, используйте описанный ручной запуск; не добавляйте production push-триггер как обход ограничения.

## Сценарий приёмки

1. Корень открывает Unified; CSP применяется ко всем ресурсам приложения.
2. Вход завершается через OIDC; запрос без сессии получает 401. Выход немедленно отзывает сессию.
3. Два аккаунта не видят чужие проекты, файлы, память, затраты, артефакты и подключённые действия.
4. Создание проекта, редактура, конфликт версии, сохранение и повторное открытие сохраняют данные.
5. Настройки плагинов действительно ограничивают доступные инструменты проекта; отзыв права блокирует новые вызовы.
6. Canonical/alias mission URL с одним ключом повтора не создают две миссии. Потеря соединения не приводит к автоматическому повторному внешнему эффекту.
7. Предпросмотр статического проекта изолирован. Недоступный runtime отображается явно.
8. Старое вложение не переносится в новый проект; сохранение уже созданного изображения не создаёт копию.
9. Лимиты и расходы показывают реальные записи. Проверяется отказ до превышения допустимого бюджета.
10. После обновления сохраняются предыдущие проекты и несортированные артефакты.

Профиль намеренно не подключает контейнеры и принудительно использует бесплатные модели. Это не означает отсутствия затрат инфраструктуры Cloudflare. Полную приёмку сборки/тестов в контейнере, private runtime preview и платного модельного адаптера нужно выполнить в отдельном согласованном окружении с реальным runtime, лимитами и учётом расходов. Dry-run и локальные заглушки такую проверку не заменяют.
