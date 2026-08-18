#!/usr/bin/env bash
# Разовая настройка секретов sklad-sync на VM (многотенантность).
#
# Кладёт на VM:
#   /etc/sklad-sync/env    (0600) — SKLAD_ACME_DOMAIN, SKLAD_CORS_ORIGIN
#   /etc/sklad-sync/tokens (0600) — реестр "tenantId: token" (соответствия
#                                   токен→склад; сервер читает его -tokens-file)
#
# Реестр токенов — источник правды «кто есть кто» — лежит локально в
# ~/.config/sklad-sync/tokens. Если он пуст, заводим первого тенанта `default`
# (мигрируя старый одиночный ~/.config/sklad-sync/token, иначе генерим новый).
# Дальше добавлять/ротировать/удалять пользователей — ./sklad-tokens.sh
# (правит реестр, зеркалит на VM, рестартит сервис; редеплой не нужен).
#
# Домен — из ~/.config/sklad-sync/domain или env SKLAD_ACME_DOMAIN, иначе из IP
# хоста как <a-b-c-d>.sslip.io (валидный Let's Encrypt без покупки домена).
# CORS-origin — из ~/.config/sklad-sync/cors или env SKLAD_CORS_ORIGIN, иначе
# https://y-gagar1n.github.io (фронт на GitHub Pages). Пусто — любой origin
# (авторизация всё равно по bearer-токену).
#
# Использование: ./bootstrap-sklad.sh [user@host]
# Запускать при первом деплое. Ротация/добавление токенов — через sklad-tokens.sh.
set -euo pipefail

REMOTE="${1:-yury-timofeev@213.165.212.180}"
HOST="${REMOTE#*@}"
SECRETS_DIR="${SKLAD_SYNC_SECRETS_DIR:-$HOME/.config/sklad-sync}"
REG="$SECRETS_DIR/tokens"

gen_token() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40; }

mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"

# Реестр токенов: если нет активных строк — заводим первого тенанта `default`.
if ! grep -qvE '^[[:space:]]*(#|$)' "$REG" 2>/dev/null; then
    TOKEN=""
    if [ -f "$SECRETS_DIR/token" ]; then     # миграция старого одиночного токена
        TOKEN="$(cat "$SECRETS_DIR/token")"
        echo "==> Переношу старый токен в реестр как тенант 'default'"
    fi
    if [ -z "$TOKEN" ]; then
        TOKEN="$(gen_token)"
        echo "==> Сгенерирован токен тенанта 'default'"
    fi
    printf 'default: %s\n' "$TOKEN" > "$REG"
fi
chmod 600 "$REG"

# Домен: файл, env или из IP → sslip.io.
DOMAIN="${SKLAD_ACME_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$SECRETS_DIR/domain" ]; then
    DOMAIN="$(cat "$SECRETS_DIR/domain")"
fi
if [ -z "$DOMAIN" ]; then
    if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        DOMAIN="${HOST//./-}.sslip.io"
    else
        DOMAIN="$HOST"
    fi
fi

# CORS-origin: файл, env или дефолт — фронт на GitHub Pages.
CORS_ORIGIN="${SKLAD_CORS_ORIGIN:-}"
if [ -z "$CORS_ORIGIN" ] && [ -f "$SECRETS_DIR/cors" ]; then
    CORS_ORIGIN="$(cat "$SECRETS_DIR/cors")"
fi
if [ -z "$CORS_ORIGIN" ]; then
    CORS_ORIGIN="https://y-gagar1n.github.io"
fi

echo "==> Домен авто-сертификата: $DOMAIN"
echo "==> CORS-origin фронта: $CORS_ORIGIN"
echo "==> Тенанты (реестр $REG):"
grep -vE '^[[:space:]]*(#|$)' "$REG" | sed 's/^/    /'
echo "    (токен вводится в приложении: «Ещё» → «Синхронизация»)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
{
    printf 'SKLAD_ACME_DOMAIN=%s\n' "$DOMAIN"
    printf 'SKLAD_CORS_ORIGIN=%s\n' "$CORS_ORIGIN"
} > "$STAGE/env"
cp "$REG" "$STAGE/tokens"

scp -q "$STAGE/env"    "$REMOTE:/tmp/sklad-sync.env"
scp -q "$STAGE/tokens" "$REMOTE:/tmp/sklad-sync.tokens"

ssh "$REMOTE" 'bash -s' <<'REMOTE_EOF'
set -euo pipefail
chmod 0600 /tmp/sklad-sync.env /tmp/sklad-sync.tokens
if ! id sklad-sync >/dev/null 2>&1; then
    sudo useradd --system --home-dir /var/lib/sklad-sync \
        --shell /usr/sbin/nologin sklad-sync
fi
sudo install -d -o root -g root -m 0755 /etc/sklad-sync
sudo install -o sklad-sync -g sklad-sync -m 0600 /tmp/sklad-sync.env    /etc/sklad-sync/env
sudo install -o sklad-sync -g sklad-sync -m 0600 /tmp/sklad-sync.tokens /etc/sklad-sync/tokens
rm -f /tmp/sklad-sync.env /tmp/sklad-sync.tokens
echo "OK: /etc/sklad-sync/{env,tokens} на месте"
REMOTE_EOF

echo "==> Готово. Дальше: ./deploy-sklad.sh $REMOTE"
echo "    Управление пользователями: ./sklad-tokens.sh {list|add <id>|rotate <id>|remove <id>}"
