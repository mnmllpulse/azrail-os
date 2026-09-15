#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════
#  AZRAIL — заливка в GitHub из Termux
#
#  Запуск:  bash push-to-github.sh
#
#  Скрипт НИЧЕГО не пушит, пока не проверит:
#    - что нет секретов в файлах
#    - что node_modules и .env не попадут в коммит
#    - что ты подтвердил список файлов глазами
# ═══════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { echo -e "\n${GREEN}▸ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
die()  { echo -e "\n${RED}✗ $1${NC}\n"; exit 1; }

# ─── 1. Проверка окружения ──────────────────────────────────────
say "Проверяю, что установлено"
command -v git >/dev/null || die "git не установлен. Выполни: pkg install git"
echo "  git: $(git --version)"

# ─── 2. Мы в правильной папке? ──────────────────────────────────
say "Проверяю папку проекта"
[ -f "wrangler.toml" ] || die "Здесь нет wrangler.toml. Перейди в папку azrail-os и запусти скрипт оттуда."
[ -f "package.json" ] || die "Здесь нет package.json."
echo "  папка: $(pwd)"

# ─── 3. Защита от заливки лишнего ───────────────────────────────
say "Проверяю, что лишнее не уйдёт в GitHub"
[ -f ".gitignore" ] || die ".gitignore отсутствует — без него в репозиторий уедет node_modules."
for p in node_modules .env .wrangler; do
  grep -q "$p" .gitignore || die ".gitignore не покрывает '$p'. Останови и добавь его туда."
done
echo "  .gitignore на месте, node_modules / .env / .wrangler исключены"

if [ -f ".env" ]; then
  warn ".env существует в папке — он НЕ будет закоммичен (исключён в .gitignore), но проверь, что ты не переименовывал его."
fi

# ─── 4. Поиск секретов перед пушем ──────────────────────────────
say "Ищу случайно оставленные ключи в файлах"
# Второй grep (-v) режет ровно ДВЕ конкретные строки-плейсхолдера из
# tests/logic.test.ts — официальный пример-ключ AWS (AKIAIOSFODNN7EXAMPLE,
# он в документации самого AWS) и тестовую Anthropic-строку. Не файлы
# целиком: настоящий ключ, случайно попавший в тест, всё ещё поймается —
# фильтр смотрит на ЗНАЧЕНИЕ, а не на путь.
LEAKS=$(grep -rInE 'AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9_-]{20}|BEGIN (RSA |EC )?PRIVATE KEY' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
  --exclude='*.example' --exclude='push-to-github.sh' . 2>/dev/null \
  | grep -vE 'AKIAIOSFODNN7EXAMPLE|sk-ant-api03-abcdefghijklmnop12345' || true)
if [ -n "$LEAKS" ]; then
  echo "$LEAKS"
  die "Найдены похожие на ключи строки. Убери их ПЕРЕД пушем — из истории git удалять сложно."
fi
echo "  ключей не найдено"

# ─── 5. Настройки репозитория ───────────────────────────────────
say "Настройки GitHub"
read -p "  Твой GitHub-логин: " GH_USER
[ -z "$GH_USER" ] && die "Логин не может быть пустым."

read -p "  Название репозитория [azrail-os]: " GH_REPO
GH_REPO=${GH_REPO:-azrail-os}

read -p "  Ветка [main]: " GH_BRANCH
GH_BRANCH=${GH_BRANCH:-main}

echo
warn "Дальше нужен Personal Access Token (не пароль от GitHub — пароли отключены)."
warn "Где взять: github.com → Settings → Developer settings →"
warn "  Personal access tokens → Tokens (classic) → Generate new token"
warn "  Права: поставь галочку 'repo'"
echo
read -s -p "  Вставь токен (при вводе не отображается): " GH_TOKEN
echo
[ -z "$GH_TOKEN" ] && die "Токен не может быть пустым."

# ─── 6. Инициализация git ───────────────────────────────────────
say "Готовлю git"
if [ ! -d ".git" ]; then
  git init -q
  echo "  репозиторий создан"
else
  echo "  репозиторий уже существует, использую его"
fi

git config user.name  >/dev/null 2>&1 || git config user.name  "$GH_USER"
git config user.email >/dev/null 2>&1 || git config user.email "$GH_USER@users.noreply.github.com"

# Токен НЕ сохраняется в .git/config: подставляется только в момент push.
REMOTE_URL="https://github.com/${GH_USER}/${GH_REPO}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi
echo "  origin: $REMOTE_URL"

# ─── 7. Что именно уйдёт ────────────────────────────────────────
say "Файлы, которые уйдут в GitHub"
git add -A
git status --short | head -40
COUNT=$(git status --short | wc -l)
echo "  всего изменений: $COUNT"

if [ "$COUNT" -eq 0 ]; then
  echo -e "\n${GREEN}Нечего коммитить — всё уже залито.${NC}\n"
  exit 0
fi

if git status --short | grep -qE 'node_modules|\.env$'; then
  die "В список попало node_modules или .env. Останови и проверь .gitignore."
fi

echo
read -p "  Всё верно? Заливаем? (y/n): " CONFIRM
[ "$CONFIRM" != "y" ] && die "Отменено. Ничего не отправлено."

# ─── 8. Коммит и пуш ────────────────────────────────────────────
say "Коммичу"
read -p "  Сообщение коммита [AZRAIL: обновление]: " MSG
MSG=${MSG:-"AZRAIL: обновление"}
git commit -q -m "$MSG" || die "Коммит не прошёл."

git branch -M "$GH_BRANCH"

say "Отправляю в GitHub"
PUSH_URL="https://${GH_USER}:${GH_TOKEN}@github.com/${GH_USER}/${GH_REPO}.git"

# Код возврата берётся у git push, а НЕ у grep.
# Было: `if git push ... | grep -v ...; then` — в конвейере $? принадлежит
# последней команде. При неудачном пуше grep печатал текст ошибки, возвращал
# 0, и скрипт рапортовал успех. Деплоился вчерашний код, причина не видна.
set -o pipefail
git push -u "$PUSH_URL" "$GH_BRANCH" 2>&1 | grep -viE "$GH_TOKEN"
PUSH_STATUS=${PIPESTATUS[0]}
set +o pipefail
if [ "$PUSH_STATUS" -eq 0 ]; then
  # Возвращаем remote без токена, чтобы он не осел в .git/config
  git remote set-url origin "$REMOTE_URL"
  echo
  echo -e "${GREEN}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}  Готово. Репозиторий:${NC}"
  echo -e "${GREEN}  https://github.com/${GH_USER}/${GH_REPO}${NC}"
  echo -e "${GREEN}═══════════════════════════════════════${NC}"
  echo
  echo "  Дальше — связать с Cloudflare:"
  echo "   1. dash.cloudflare.com → Workers & Pages → azrail-os"
  echo "   2. Settings → Build → Connect to Git"
  echo "   3. Выбрать репозиторий ${GH_REPO}, ветку ${GH_BRANCH}"
  echo "   4. Build command оставить пустым, deploy command: npx wrangler deploy"
  echo
else
  git remote set-url origin "$REMOTE_URL"
  die "Push не прошёл. Частые причины:
   - репозиторий ${GH_REPO} не создан на github.com (создай пустой, без README)
   - у токена нет права 'repo'
   - токен истёк"
fi
