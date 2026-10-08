# AZRAIL Workbench — состояние staging, 8 октября 2026

## Созданные ресурсы

В Cloudflare account `bd152b38c981856eca68a275982f2070` подготовлены отдельные ресурсы:

| Ресурс | Имя / идентификатор |
| --- | --- |
| Опубликованный Worker | `azrail-pulse-staging` |
| D1 | `azrail-db-staging`, `509b9a03-444d-4bd7-9081-19651ea9b50f` |
| KV | `AZRAIL_KV_STAGING`, `4b1b2455cfaf4fc3aa766ea2af5da0e2` |
| R2 | `azrail-artifacts-staging` |
| Access OIDC application | `AZRAIL Workbench Staging`, `39ae47c1-a25f-4fc7-801c-75ed2b0f09b9` |
| Origin | `https://azrail-pulse-staging.mnmllpulse.workers.dev` |

D1 перед инициализацией проверена через `sqlite_master`: пользовательских таблиц не было. К пустой базе применены 86 SQL statements из `schema.sql`; повторное чтение подтвердило таблицы проектов, сессий, плагинов, модельных настроек, версий и артефактов. Данные production не копировались.

OIDC использует существующий Cloudflare One-time PIN, authorization code + PKCE, точный callback `/auth/callback`, scopes `openid profile email`. Разрешён публичный PKCE client; `OIDC_CLIENT_SECRET` не нужен. Issuer и RS256 JWKS подтверждены через реальный discovery endpoint. Access allow policy разрешает вход только на один email, явно указанный владельцем в этой сессии; адрес не публикуется в репозитории. Реальный вход пользователя пока не проверен.

Заполненный конфиг находится локально в `wrangler.staging.local.toml` и исключён из Git. Коммитируемый `wrangler.staging.toml` остаётся переносимым шаблоном. Инструкция: [STAGING_RU.md](STAGING_RU.md).

## Изменения подготовки

- Guard принимает `--config` и проверяет именно выбранный файл.
- Перед любой remote-миграцией TOML/JSON экспорт D1 обязательно сохраняется в приватный R2 выбранного окружения. Ошибка экспорта или загрузки останавливает изменение схемы.
- Сохранены настройки Vitest Node/globals из прежней основной ветки. Worker и UI проходят отдельную строгую проверку типов.
- Из актуального GitHub перенесены корректные production resource IDs в production-конфиги; исправление `html_handling = none` сохранено.

## GitHub 1.4.1

На момент проверки `main` указывает на `12e904e092e4803b7fdef7571f561e1931bfea87`. История полностью заменена новым корневым коммитом `6979326`; старый импорт и Workbench сохранены локально. Основная ветка и работающий `azrail-os` этой работой не обновлялись.

В 1.4.1 добавлены UI входа по токену, просмотра старых версий и backup. Backend-исправлений относительно импортированного baseline нет. Токен-вход конфликтует с её же `AUTH_MODE=oidc`: сервер отклоняет bearer-токен. Его нельзя переносить как рабочий способ входа. Workbench использует OIDC и полные снимки проекта с backup перед восстановлением. Отдельные операции старого backup UI требуют переноса с сохранением project scope, а token-mode — явного серверного описания поддерживаемых способов входа и проверки авторизованных скачиваний.

## Ограничения приёмки

Этот профиль принудительно использует Free routing, без Sandbox binding и без OpenAI API key. Он не подтверждает работу платных моделей или контейнерного исполнения. Следующий обязательный этап после допуска тестировщиков: реальный OIDC login, проверка изоляции двух аккаунтов, save/restore проекта и отказ превышения бюджета.

## Публикация и фактическая проверка

Worker опубликован через стандартный Cloudflare Workers API и Assets Direct Upload. Deployment ID: `6ee75b49e9334e4d9daf6e3bad8e8d03`. 8 октября включён отдельный workers.dev URL и cron `*/10 * * * *`; preview URLs отключены. Worker bindings повторно прочитаны из Cloudflare: D1/KV/R2 соответствуют изолированным ресурсам в таблице выше.

Проверка живого HTTPS-сайта:

- `/` и `/app.html`: HTTP 200, без цикла редиректов, с CSP.
- CSS/JS интерфейса: HTTP 200.
- `/auth/status`: `configured: true`, `account: null` без сессии.
- `/api/workbench/projects` и `/api/me`: HTTP 401 без сессии.
- `/auth/login`: HTTP 302 на правильный Access issuer, PKCE S256, точный callback и state cookie.
- Переход по authorization URL: HTTP 200, форма Cloudflare Access с email input. Код на email не запрашивался.

Cloudflare Browser Integrity отклоняет стандартный Python User-Agent с 1010; запросы с браузерным User-Agent проходят. Это наблюдение относится к HTTP-клиенту проверки, а не к результату выполнения приложения.

`npm run check`: **1296 тестов в 67 файлах**, TypeScript и UI build успешны. Staging guard, обычный и minified Wrangler dry-run успешны. Подробности: `docs/verification-workbench/staging-check.txt`, `staging-build.txt`, `staging-http.json`.

Для завершения пользовательской приёмки владелец должен открыть тестовый адрес, нажать вход и самостоятельно ввести полученный одноразовый код. Авторизованные сценарии staging ещё не подтверждены; прежние проверки редактора/save/restore выполнялись в локальном Wrangler.

## Скриншот конфигурации владельца

8 октября исходный `wrangler.json` прочитан напрямую через GitHub connector. Ключи `binding`, `durable_objects`, `migrations` и имя `Orchestrator` в файле остаются английскими; русские подписи на мобильном скриншоте относятся к переводу страницы браузером. D1/KV/R2 IDs исходника совпадают с production bindings. Исправлять их из-за перевода страницы не требуется.

После публикации staging повторно проверен Worker `azrail-os`: его etag остался `97a645c58651a08d1a653e7467dd8c48da0331413e656c3400c0c77dd67a9309`, время последнего обновления — `2026-10-07T20:08:48.306375Z`. Эта работа production не обновляла.
