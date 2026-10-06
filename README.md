# AZRAIL × MNMLL PULSE OS — Unified 1.4.0

Глобус удалён. Девять действующих модулей студий открываются на отдельных страницах. Исправлены черновики, гонки при смене экранов, освобождение медиа, повторные отправки и обработка ошибок. CSV, Ableton и расходы получили таблицы и скачивание отчёта; Pulse Lab показывает диагностику.

Полный аудит, список недостающих функций/кнопок и порядок доработок: [docs/AUDIT_1.4_RU.md](docs/AUDIT_1.4_RU.md).

**Проверено:** 1181 тест / 57 наборов, TypeScript, UI build, Free/Paid Worker dry-run и реальные локальные сценарии в Chromium. `npm audit` сообщил 0 известных уязвимостей. Боевой вход, AI, OAuth, контейнеры и счёт Cloudflare проверяются после настройки в вашем аккаунте.

## Быстрый просмотр

Распакуйте архив и откройте корневой **index.html**. CSS и JS встроены; внешние ресурсы не нужны. Локально доступны музыкальный эскиз WAV/MIDI, видео WebM при поддержке MediaRecorder, аудиоанализ, CSV и диагностика браузера. Для AI и серверных проектов нужен вход в развёрнутое приложение.

`ui/app.html` — исходный шаблон. `site/` — собранный интерфейс для Cloudflare. Работайте с `ui/`, затем пересобирайте.

## Страницы

| Модуль | URL |
|---|---|
| Сайты и приложения | `/studios/web` |
| Изображения | `/studios/image` |
| Музыка | `/studios/music` |
| Видео | `/studios/video` |
| Аудиоанализ | `/studios/audio` |
| Ableton | `/studios/als` |
| Данные | `/studios/data` |
| Расходы | `/studios/ledger` |
| Pulse Lab | `/studios/lab` |

В автономном файле адреса используют hash: `#/studios/music`. Есть Back/Forward, reload, открытие ссылки в новой вкладке и страница «Не найдено». Каталог студий и рабочий экран разделены. Web Studio содержит собственную форму миссии.

## Проверка

Нужен Node.js 24.

```sh
npm ci
npm run check
npm run build:check
npx wrangler deploy --dry-run --config wrangler.paid.json --outdir .work/paid-worker --containers-rollout=none
```

`npm run build` пересобирает `site/` и автономный preview. `npm run check` также проверяет старые совместимые контракты ядра. Новой SQL-миграции в 1.4 нет.

## Развёртывание и существующий GitHub

Порядок установки: [DEPLOY_RU.md](DEPLOY_RU.md). Стандартный профиль — `wrangler.json`, Free без Containers. Paid выбирается явно. В шаблонах resource IDs заполнены нулями; provisioning и настройка OIDC обязательны.

В `mnmllpulse/azrail-os/main` другая поставка с собственными `build:pulse` и staging-скриптами. Сопоставляйте изменения в отдельной ветке. Источник этого релиза — предоставленный ZIP, а не полная замена существующего main. Source patch: [docs/verification/v1.4.0/CHANGES.patch](docs/verification/v1.4.0/CHANGES.patch).

Read-only smoke: `npm run smoke`. Для OIDC передайте `AZRAIL_URL` и `AZRAIL_SESSION_COOKIE` своей действующей сессии через runtime environment. Для token mode используется `AZRAIL_TOKEN`. Скрипт выводит статусы, не значения секретов.

## Границы текущей версии

Серверные черновики музыки/изображения/видео сохраняются с revision; локальные параметры переживают навигацию и reload той же вкладки. Web Studio хранит локальный черновик запроса, миссия сохраняется сервером. Локальное Undo не откатывает файлы проекта или внешние действия.

Музыка — алгоритмический эскиз F minor. Видео — 8 секунд WebM. Аудиоанализ — PCM и выборочная FFT; LUFS/true peak/BPM не измеряются. ALS пока не извлекает тональность, размер и клипы. Ресурсный журнал не заменяет фактический счёт Cloudflare.

Десять дополнительных студий в `references/pulse-source` требуют переноса и реального backend. Их список и критерии готовности приведены в аудите. Исторические документы и интерфейсы остаются в архиве для сопоставления; production собирается из `ui/` и `src/`.

Проверки и скриншоты: [docs/verification/v1.4.0](docs/verification/v1.4.0), резюме — [VERIFICATION.json](VERIFICATION.json).
## Внутренний API и модули

Модули ядра: `execution-engine` — цикл исполнения; `tool-registry` — доступные инструменты; `workspace` — файлы R2; `chat-store` — диалоги; `event-store` — журнал событий.

Основные маршруты ядра (каждый проверяет доступ; группа admin имеет дополнительные ограничения):

- `/api/admin/accounts`
- `/api/admin/accounts/revoke`
- `/api/admin/billing`
- `/api/admin/ownership`
- `/api/admin/permissions`
- `/api/admin/routing-settings`
- `/api/agents`
- `/api/backups`
- `/api/backups/restore`
- `/api/bench`
- `/api/chat`
- `/api/conversations`
- `/api/me`
- `/api/metrics`
- `/api/mission`
- `/api/mission/cancel`
- `/api/mission/hint`
- `/api/mission/recover`
- `/api/model-catalog`
- `/api/models`
- `/api/polish`
- `/api/routing-settings`
- `/api/selftest`
- `/api/stream`
- `/api/stream/ticket`
- `/api/task`
- `/api/tools`
- `/api/upload`

Новые студийные API: `/api/studio/projects`, `/api/studio/project-zip`, `/api/studio/artifacts`, `/api/studio/image`, `/api/studio/voice`, `/api/studio/als`, `/api/studio/ledger`, `/api/studio/capabilities`. Подключения: `/api/connectors`; черновики: `/api/studio/drafts/:studio`; стиль: `/api/studio/design-contract?projectId=...`. OIDC: `/auth/login`, `/auth/callback`, `/auth/status`, `/auth/logout`.
