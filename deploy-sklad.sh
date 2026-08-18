#!/usr/bin/env bash
# Деплой sklad-sync (сервер синка + раздача веб-приложения) на VM.
#
# Что делает:
#   1. Кросс-компилит бинарь под linux/amd64 из ./backend.
#   2. Собирает статику веб-приложения в public.tar.gz.
#   3. Заливает бинарь, статику, systemd-юниты и backup.sh на VM.
#   4. На VM (sudo без пароля): создаёт пользователя sklad-sync, каталоги
#      /opt/sklad-sync, /var/lib/sklad-sync (+ acme-кэш), /var/backups/sklad-sync,
#      ставит юниты, перезапускает сервис, включает суточный таймер бэкапа.
#
# Секреты (токен + домен для авто-сертификата) НЕ катятся автоматически — они
# лежат в /etc/sklad-sync/env и кладутся один раз через ./bootstrap-sklad.sh.
#
# ИЗОЛЯЦИЯ: скрипт трогает ТОЛЬКО пути sklad-sync. todo-sync (порт 8080,
# /var/lib/todo-sync) и agent-site (порт 80) не затрагиваются. Порт сервиса —
# 443 (HTTPS, валидный Let's Encrypt). Перед стартом проверяем, что 443 не занят
# чужим процессом.
#
# Использование: ./deploy-sklad.sh [user@host]
set -euo pipefail

REMOTE="${1:-yury-timofeev@213.165.212.180}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "==> Cross-compile linux/amd64"
( cd "$REPO_ROOT/backend" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' -o "$BUILD_DIR/sklad-sync" . )

echo "==> Pack web app (public.tar.gz)"
tar -C "$REPO_ROOT" -czf "$BUILD_DIR/public.tar.gz" \
    index.html manifest.webmanifest sw.js assets icons

echo "==> Upload artefacts to $REMOTE"
scp -q "$BUILD_DIR/sklad-sync" \
    "$BUILD_DIR/public.tar.gz" \
    "$REPO_ROOT/backend/deploy/sklad-sync.service" \
    "$REPO_ROOT/backend/deploy/sklad-sync-backup.service" \
    "$REPO_ROOT/backend/deploy/sklad-sync-backup.timer" \
    "$REPO_ROOT/backend/deploy/backup.sh" \
    "$REMOTE:/tmp/"

echo "==> Install & (re)start service"
ssh "$REMOTE" 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

# Системный пользователь без shell и без /home.
if ! id sklad-sync >/dev/null 2>&1; then
    sudo useradd --system --home-dir /var/lib/sklad-sync \
        --shell /usr/sbin/nologin sklad-sync
fi

sudo install -d -o sklad-sync -g sklad-sync -m 0755 /opt/sklad-sync
sudo install -d -o sklad-sync -g sklad-sync -m 0755 /opt/sklad-sync/public
sudo install -d -o sklad-sync -g sklad-sync -m 0750 /var/lib/sklad-sync
sudo install -d -o sklad-sync -g sklad-sync -m 0700 /var/lib/sklad-sync/acme
sudo install -d -o sklad-sync -g sklad-sync -m 0750 /var/backups/sklad-sync

# Требуем, чтобы секреты уже лежали: без токена сервис не стартует.
if [ ! -f /etc/sklad-sync/env ]; then
    echo "ERROR: /etc/sklad-sync/env отсутствует. Прогони bootstrap-sklad.sh перед первым деплоем." >&2
    exit 1
fi

# Порт 443 не должен быть занят ЧУЖИМ процессом (наш sklad-sync — можно).
if sudo ss -ltnpH 'sport = :443' 2>/dev/null | grep -q . ; then
    if ! sudo ss -ltnpH 'sport = :443' 2>/dev/null | grep -q 'sklad-sync' ; then
        echo "ERROR: порт 443 занят другим сервисом — не трогаю его:" >&2
        sudo ss -ltnp 'sport = :443' >&2 || true
        exit 1
    fi
fi

# Бинарь и backup.sh — атомарно (install перезаписывает даже занятый файл).
sudo install -o root -g root -m 0755 /tmp/sklad-sync /opt/sklad-sync/sklad-sync
sudo install -o root -g root -m 0755 /tmp/backup.sh   /opt/sklad-sync/backup.sh
rm -f /tmp/sklad-sync /tmp/backup.sh

# Статика: полностью пересобираем каталог public.
sudo rm -rf /opt/sklad-sync/public
sudo install -d -o sklad-sync -g sklad-sync -m 0755 /opt/sklad-sync/public
sudo tar -C /opt/sklad-sync/public -xzf /tmp/public.tar.gz
sudo chown -R sklad-sync:sklad-sync /opt/sklad-sync/public
rm -f /tmp/public.tar.gz

# Юниты обновляем только при изменениях.
units_changed=0
for unit in sklad-sync.service sklad-sync-backup.service sklad-sync-backup.timer; do
    if ! sudo cmp -s "/tmp/$unit" "/etc/systemd/system/$unit" 2>/dev/null; then
        sudo install -o root -g root -m 0644 "/tmp/$unit" "/etc/systemd/system/$unit"
        units_changed=1
    fi
    rm -f "/tmp/$unit"
done
if [ "$units_changed" = 1 ]; then
    sudo systemctl daemon-reload
fi

# Фаервол (если ufw активен) — открыть 443. Облачные security groups — вручную.
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q 'Status: active'; then
    sudo ufw allow 443/tcp || true
fi

sudo systemctl enable --now sklad-sync.service
sudo systemctl restart sklad-sync.service
sudo systemctl enable --now sklad-sync-backup.timer

sleep 1
sudo systemctl --no-pager --lines=5 status sklad-sync.service || true

DOMAIN=$(sudo sh -c '. /etc/sklad-sync/env; printf %s "${SKLAD_ACME_DOMAIN:-}"')
echo "--- health (https://$DOMAIN/health, первый серт может выпускаться ~10с) ---"
ok=0
for i in $(seq 1 15); do
    if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
done
if [ "$ok" = 1 ]; then
    echo "OK: https://$DOMAIN/health отвечает"
else
    echo "ВНИМАНИЕ: health по https не ответил с самой VM (возможно hairpin-NAT/фаервол)."
    echo "Проверь с телефона/ноута: https://$DOMAIN/  Сервис активен:"
    sudo systemctl is-active sklad-sync.service || true
fi
REMOTE_EOF

echo "==> Done."
