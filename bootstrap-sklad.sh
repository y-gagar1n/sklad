#!/usr/bin/env bash
# Разовая настройка секретов sklad-sync на VM.
#
# Кладёт в /etc/sklad-sync/env (mode 0600, owner sklad-sync):
#   SKLAD_SYNC_TOKEN=<токен доступа>
#   SKLAD_ACME_DOMAIN=<домен для авто-сертификата Let's Encrypt>
#   SKLAD_CORS_ORIGIN=<origin фронта на GitHub Pages для CORS>
#
# Токен читается из ~/.config/sklad-sync/token (или env SKLAD_SYNC_TOKEN).
# Домен — из ~/.config/sklad-sync/domain (или env SKLAD_ACME_DOMAIN), иначе
# выводится из IP хоста как <a-b-c-d>.sslip.io (валидный Let's Encrypt без покупки
# домена). В режиме авто-сертификата cert/key не нужны.
# CORS-origin — из ~/.config/sklad-sync/cors (или env SKLAD_CORS_ORIGIN), иначе
# https://y-gagar1n.github.io (фронт на GitHub Pages). Пусто — сервер разрешит
# любой origin; авторизация всё равно по токену.
#
# Использование: ./bootstrap-sklad.sh [user@host]
# Запускать при первом деплое или ротации токена.
set -euo pipefail

REMOTE="${1:-yury-timofeev@213.165.212.180}"
HOST="${REMOTE#*@}"
SECRETS_DIR="${SKLAD_SYNC_SECRETS_DIR:-$HOME/.config/sklad-sync}"

# Токен: файл, env или генерируем случайный (и сохраняем в файл).
TOKEN="${SKLAD_SYNC_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$SECRETS_DIR/token" ]; then
    TOKEN="$(cat "$SECRETS_DIR/token")"
fi
if [ -z "$TOKEN" ]; then
    mkdir -p "$SECRETS_DIR"
    TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
    printf '%s\n' "$TOKEN" > "$SECRETS_DIR/token"
    chmod 0600 "$SECRETS_DIR/token"
    echo "==> Сгенерирован новый токен, сохранён в $SECRETS_DIR/token"
fi

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
echo "==> Токен доступа: $TOKEN"
echo "    (введёшь его в приложении: «Ещё» → «Синхронизация»)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
{
    printf 'SKLAD_SYNC_TOKEN=%s\n' "$TOKEN"
    printf 'SKLAD_ACME_DOMAIN=%s\n' "$DOMAIN"
    printf 'SKLAD_CORS_ORIGIN=%s\n' "$CORS_ORIGIN"
} > "$STAGE/env"

scp -q "$STAGE/env" "$REMOTE:/tmp/sklad-sync.env"

ssh "$REMOTE" 'bash -s' <<'REMOTE_EOF'
set -euo pipefail
chmod 0600 /tmp/sklad-sync.env
if ! id sklad-sync >/dev/null 2>&1; then
    sudo useradd --system --home-dir /var/lib/sklad-sync \
        --shell /usr/sbin/nologin sklad-sync
fi
sudo install -d -o root -g root -m 0755 /etc/sklad-sync
sudo install -o sklad-sync -g sklad-sync -m 0600 /tmp/sklad-sync.env /etc/sklad-sync/env
rm -f /tmp/sklad-sync.env
echo "OK: /etc/sklad-sync/env на месте"
REMOTE_EOF

echo "==> Готово. Дальше: ./deploy-sklad.sh $REMOTE"
