#!/usr/bin/env bash
# Управление токенами тенантов sklad-sync (многотенантность).
#
# Реестр — источник правды «кто есть кто» — лежит локально в
# ~/.config/sklad-sync/tokens, строки "tenantId: token". tenantId ([a-z0-9_-],
# до 64) — это метка склада и имя файла данных на сервере
# (/var/lib/sklad-sync/tenants/<tenantId>.json). Человеческое имя можно дописать
# комментарием (строка, начинающаяся с #) — сервер их игнорирует.
#
# Скрипт правит реестр локально, зеркалит его в /etc/sklad-sync/tokens на VM
# (0600, owner sklad-sync) и рестартит сервис (tokens-файл читается при старте) —
# редеплой не нужен. Файл данных тенанта заводится лениво при первом синке.
#
# «Чей это токен?» — просто загляни в реестр:  grep <имя> ~/.config/sklad-sync/tokens
#
# Использование:
#   ./sklad-tokens.sh list                # показать тенантов и токены
#   ./sklad-tokens.sh add    <tenantId>   # создать тенанта + новый токен
#   ./sklad-tokens.sh rotate <tenantId>   # сменить токен (склад сохраняется)
#   ./sklad-tokens.sh remove <tenantId>   # отозвать доступ (файл данных остаётся)
# Хост VM: env SKLAD_REMOTE (по умолчанию yury-timofeev@213.165.212.180).
#
# ⛔ Токены — секрет: реестр не коммитить (он и так вне репозитория).
set -euo pipefail

REMOTE="${SKLAD_REMOTE:-yury-timofeev@213.165.212.180}"
REG="${SKLAD_SYNC_TOKENS_FILE:-$HOME/.config/sklad-sync/tokens}"

gen_token() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40; }
valid_id()  { [[ "$1" =~ ^[a-z0-9_-]{1,64}$ ]]; }

ensure_reg() {
    mkdir -p "$(dirname "$REG")"; chmod 700 "$(dirname "$REG")"
    touch "$REG"; chmod 600 "$REG"
}

# Токен тенанта из реестра (пусто, если нет). Комментарии игнорируются.
id_token() {
    awk -F: -v id="$1" '
        /^[[:space:]]*#/ { next }
        {
            k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
            if (k==id) { t=$2; gsub(/^[[:space:]]+|[[:space:]]+$/,"",t); print t }
        }' "$REG"
}
has_id()      { [ -n "$(id_token "$1")" ]; }
active_count() { grep -cvE '^[[:space:]]*(#|$)' "$REG" 2>/dev/null || echo 0; }

mirror_and_restart() {
    echo "==> Зеркалю реестр на $REMOTE:/etc/sklad-sync/tokens и рестартю сервис"
    local remotetmp="/tmp/sklad-tokens.$$"
    scp -q "$REG" "$REMOTE:$remotetmp"
    ssh "$REMOTE" "bash -s -- $remotetmp" <<'REMOTE_EOF'
set -euo pipefail
remotetmp="$1"
sudo install -d -o root -g root -m 0755 /etc/sklad-sync
sudo install -o sklad-sync -g sklad-sync -m 0600 "$remotetmp" /etc/sklad-sync/tokens
rm -f "$remotetmp"
sudo systemctl restart sklad-sync.service
sleep 1
if sudo systemctl is-active --quiet sklad-sync.service; then
    echo "OK: sklad-sync active"
else
    echo "ОШИБКА: sklad-sync не поднялся — проверь /etc/sklad-sync/tokens" >&2
    sudo systemctl --no-pager --lines=10 status sklad-sync.service >&2 || true
    exit 1
fi
REMOTE_EOF
}

cmd="${1:-}"; shift || true
case "$cmd" in
    list)
        ensure_reg
        echo "Тенанты (реестр $REG):"
        if [ "$(active_count)" -gt 0 ]; then
            grep -vE '^[[:space:]]*(#|$)' "$REG" | sed 's/^/    /'
        else
            echo "    (пусто)"
        fi
        ;;
    add)
        id="${1:?использование: $0 add <tenantId>}"
        valid_id "$id" || { echo "tenantId должен быть [a-z0-9_-], до 64 символов" >&2; exit 1; }
        ensure_reg
        has_id "$id" && { echo "тенант '$id' уже есть — для смены токена: $0 rotate $id" >&2; exit 1; }
        tok="$(gen_token)"
        printf '%s: %s\n' "$id" "$tok" >> "$REG"
        mirror_and_restart
        echo "==> Добавлен тенант '$id'. Токен (ввести в приложении: «Ещё» → «Синхронизация»):"
        echo "    $tok"
        ;;
    rotate)
        id="${1:?использование: $0 rotate <tenantId>}"
        ensure_reg
        has_id "$id" || { echo "нет тенанта '$id' (см. $0 list)" >&2; exit 1; }
        tok="$(gen_token)"
        tmp="$(mktemp)"
        awk -F: -v id="$id" -v tok="$tok" '
            /^[[:space:]]*#/ { print; next }
            { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
              if (k==id) print id": "tok; else print }' "$REG" > "$tmp"
        mv "$tmp" "$REG"; chmod 600 "$REG"
        mirror_and_restart
        echo "==> Токен тенанта '$id' обновлён; старый больше не действует. Новый токен:"
        echo "    $tok"
        ;;
    remove)
        id="${1:?использование: $0 remove <tenantId>}"
        ensure_reg
        has_id "$id" || { echo "нет тенанта '$id' (см. $0 list)" >&2; exit 1; }
        tmp="$(mktemp)"
        awk -F: -v id="$id" '
            /^[[:space:]]*#/ { print; next }
            { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
              if (k!=id) print }' "$REG" > "$tmp"
        # Нельзя оставить сервер без токенов — он не стартует.
        if ! grep -qvE '^[[:space:]]*(#|$)' "$tmp"; then
            rm -f "$tmp"
            echo "отказ: '$id' — последний тенант, реестр стал бы пустым (сервер не стартует)." >&2
            echo "Сначала заведи другого: $0 add <id>." >&2
            exit 1
        fi
        mv "$tmp" "$REG"; chmod 600 "$REG"
        mirror_and_restart
        echo "==> Тенант '$id' отозван — токен больше не действует."
        echo "    Файл данных на VM остался: /var/lib/sklad-sync/tenants/$id.json (удали вручную при необходимости)."
        ;;
    *)
        echo "использование: $0 {list | add <tenantId> | rotate <tenantId> | remove <tenantId>}" >&2
        exit 1
        ;;
esac
