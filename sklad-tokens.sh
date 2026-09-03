#!/usr/bin/env bash
# Управление токенами тенантов sklad-sync (многотенантность).
#
# Реестр — источник правды «кто есть кто» — лежит локально в
# ~/.config/sklad-sync/tokens, строки "tenantId: token" (опционально с
# модификатором "ro" в конце — "tenantId: token ro"). tenantId ([a-z0-9_-], до
# 64) — это метка склада и имя файла данных на сервере
# (/var/lib/sklad-sync/tenants/<tenantId>.json). Человеческое имя можно дописать
# комментарием (строка, начинающаяся с #) — сервер их игнорирует. На одну метку
# может быть несколько токенов (разные устройства, плюс read-only для
# «посмотреть без права правки») — у каждого своя строка.
#
# Read-only токен ("ro"): pull работает (видит все данные тенанта), push и
# wipe сервер отклоняет 403-м — см. backend/main.go.
#
# Скрипт правит реестр локально, зеркалит его в /etc/sklad-sync/tokens на VM
# (0600, owner sklad-sync) и рестартит сервис (tokens-файл читается при старте) —
# редеплой не нужен. Файл данных тенанта заводится лениво при первом синке.
#
# «Чей это токен?» — просто загляни в реестр:  grep <имя> ~/.config/sklad-sync/tokens
#
# Использование:
#   ./sklad-tokens.sh list                                       # показать тенантов и токены
#   ./sklad-tokens.sh add         <tenantId> [--label текст]     # создать тенанта + новый токен
#   ./sklad-tokens.sh add-token   <tenantId> [--ro] [--label текст]  # ещё один токен (--ro — только чтение)
#   ./sklad-tokens.sh rotate      <tenantId> [--label текст]     # сменить токен (склад сохраняется; только если токен один; без --label алиас сохраняется как был)
#   ./sklad-tokens.sh remove      <tenantId>        # отозвать ВСЕ токены тенанта (файл данных остаётся)
#   ./sklad-tokens.sh remove-token <token>          # отозвать один конкретный токен (напр. один read-only)
# --label текст — алиас токена (кому/на каком устройстве), пишется как "# текст"
#   в конце строки реестра — виден в list, сервер его игнорирует.
# --force — обойти guard_no_silent_drop (см. ниже) и всё равно перезаписать реестр на VM.
# Хост VM: env SKLAD_REMOTE (по умолчанию yury-timofeev@213.165.212.180).
#
# ⛔ Токены — секрет: реестр не коммитить (он и так вне репозитория).
set -euo pipefail

REMOTE="${SKLAD_REMOTE:-yury-timofeev@213.165.212.180}"
REG="${SKLAD_SYNC_TOKENS_FILE:-$HOME/.config/sklad-sync/tokens}"
FORCE="${FORCE:-0}"

gen_token() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40; }
valid_id()  { [[ "$1" =~ ^[a-z0-9_-]{1,64}$ ]]; }

ensure_reg() {
    mkdir -p "$(dirname "$REG")"; chmod 700 "$(dirname "$REG")"
    touch "$REG"; chmod 600 "$REG"
}

# Токен(ы) тенанта из реестра, по одному на строку (пусто, если нет). Комментарии
# игнорируются. Модификатор "ro" после токена в вывод не попадает.
id_token() {
    awk -F: -v id="$1" '
        /^[[:space:]]*#/ { next }
        {
            k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
            if (k==id) { rest=$2; gsub(/^[[:space:]]+|[[:space:]]+$/,"",rest); split(rest,a," "); print a[1] }
        }' "$REG"
}
# Read-only ли ЕДИНСТВЕННЫЙ токен тенанта ("1"/"0") — вызывать только когда
# id_count==1, иначе результат по последней совпавшей строке не однозначен.
id_readonly() {
    awk -F: -v id="$1" '
        /^[[:space:]]*#/ { next }
        {
            k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
            if (k==id) { rest=$2; gsub(/^[[:space:]]+|[[:space:]]+$/,"",rest); split(rest,a," "); print (a[2]=="ro") ? "1" : "0" }
        }' "$REG"
}
# Число строк (токенов) с данным tenantId.
id_count() {
    awk -F: -v id="$1" '
        /^[[:space:]]*#/ { next }
        { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k); if (k==id) c++ }
        END { print c+0 }' "$REG"
}
has_id()      { [ "$(id_count "$1")" -gt 0 ]; }
active_count() { grep -cvE '^[[:space:]]*(#|$)' "$REG" 2>/dev/null || echo 0; }

# Строка реестра для tenantId+токена: "id: token[ ro][  # label]". Чистая
# функция — используется и при выдаче токена, и в тестах.
token_line() {
    local id="$1" tok="$2" ro="$3" label="$4" comment=""
    [ -n "$label" ] && comment="  # $label"
    printf '%s: %s%s%s\n' "$id" "$tok" "$ro" "$comment"
}

# Текущий алиас (комментарий после "#") строки тенанта id в файле, пусто если
# нет. Используется rotate, чтобы не терять алиас при смене токена.
label_of() {
    local file="$1" id="$2"
    awk -F: -v id="$id" '
        /^[[:space:]]*#/ { next }
        { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
          if (k==id) { n=index($0,"#"); if (n>0) { print substr($0,n+1); exit } }
        }' "$file" | sed 's/^[[:space:]]*//'
}

# Уникальные tenantId'ы файла реестра, по одному на строку. Комментарии игнорируются.
ids_in_file() {
    awk -F: '
        /^[[:space:]]*#/ { next }
        { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k); if (k!="") print k }
    ' "$1" | sort -u
}

# tenantId'ы, которые есть в remote_file, но отсутствуют в local_file — то есть
# пропадут, если remote_file заменить содержимым local_file. Остальные
# аргументы — id'ы, которые эта команда и так намеренно убирает (remove/
# remove-token), их из результата исключаем.
dropped_ids() {
    local remote_file="$1" local_file="$2"; shift 2
    local expected="$*" local_ids id
    local_ids="$(ids_in_file "$local_file")"
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        grep -qxF "$id" <<<"$local_ids" && continue
        printf '%s\n' "$expected" | grep -qxF "$id" && continue
        printf '%s\n' "$id"
    done <<<"$(ids_in_file "$remote_file")"
}

# Не даёт зеркалировать локальный реестр на VM, если это молча сотрёт токены
# тенанта, о котором локальный реестр не знает (инцидент: локальный реестр на
# новой машине был пуст, add затёр на VM токен уже жившего там тенанта
# 'nastya'). $@ — id'ы, намеренно убираемые этой командой (remove/remove-token).
guard_no_silent_drop() {
    [ "$FORCE" = "1" ] && return 0
    local snap dropped
    snap="$(mktemp)"
    if ! ssh "$REMOTE" 'sudo -n cat /etc/sklad-sync/tokens 2>/dev/null' > "$snap" 2>/dev/null; then
        rm -f "$snap"
        return 0
    fi
    dropped="$(dropped_ids "$snap" "$REG" "$*")"
    rm -f "$snap"
    if [ -n "$dropped" ]; then
        echo "ОТКАЗ: на VM есть тенант(ы), которых нет в локальном реестре — зеркалирование их сотрёт:" >&2
        echo "$dropped" | sed 's/^/    /' >&2
        echo "Сверь локальный реестр с сервером или передай --force, чтобы всё равно перезаписать." >&2
        exit 1
    fi
}

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

# Диспетчер команд — только при прямом запуске. При `source` (так тесты
# переиспользуют ids_in_file/dropped_ids/guard_no_silent_drop) не выполняется,
# иначе `exit` из ветки `*)` убил бы процесс теста.
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

cmd="${1:-}"; shift || true
FORCE=0
LABEL=""
args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1; shift ;;
        --label) LABEL="${2:-}"; shift 2 ;;
        *) args+=("$1"); shift ;;
    esac
done
set -- "${args[@]}"
[[ "$LABEL" == *$'\n'* ]] && { echo "--label не должен содержать перенос строки" >&2; exit 1; }
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
        has_id "$id" && { echo "тенант '$id' уже есть — для смены токена: $0 rotate $id, для ещё одного: $0 add-token $id" >&2; exit 1; }
        tok="$(gen_token)"
        token_line "$id" "$tok" "" "$LABEL" >> "$REG"
        guard_no_silent_drop
        mirror_and_restart
        echo "==> Добавлен тенант '$id'. Токен (ввести в приложении: «Ещё» → «Синхронизация»):"
        echo "    $tok"
        ;;
    add-token)
        id="${1:?использование: $0 add-token <tenantId> [--ro] [--label текст]}"
        ro=""
        if [ "${2:-}" = "--ro" ]; then ro=" ro"; fi
        ensure_reg
        has_id "$id" || { echo "нет тенанта '$id' — сначала: $0 add $id" >&2; exit 1; }
        tok="$(gen_token)"
        token_line "$id" "$tok" "$ro" "$LABEL" >> "$REG"
        guard_no_silent_drop
        mirror_and_restart
        if [ -n "$ro" ]; then
            echo "==> Добавлен read-only токен тенанта '$id' (только чтение, без записи/wipe):"
        else
            echo "==> Добавлен дополнительный токен тенанта '$id':"
        fi
        echo "    $tok"
        ;;
    rotate)
        id="${1:?использование: $0 rotate <tenantId>}"
        ensure_reg
        has_id "$id" || { echo "нет тенанта '$id' (см. $0 list)" >&2; exit 1; }
        if [ "$(id_count "$id")" -gt 1 ]; then
            echo "у тенанта '$id' несколько токенов — rotate не знает, какой менять." >&2
            echo "Отзови нужный: $0 remove-token <token> и заведи новый: $0 add-token $id [--ro]" >&2
            exit 1
        fi
        ro_suffix=""
        [ "$(id_readonly "$id")" = "1" ] && ro_suffix=" ro"
        [ -z "$LABEL" ] && LABEL="$(label_of "$REG" "$id")"
        tok="$(gen_token)"
        newline="$(token_line "$id" "$tok" "$ro_suffix" "$LABEL")"
        tmp="$(mktemp)"
        awk -F: -v id="$id" -v newline="$newline" '
            /^[[:space:]]*#/ { print; next }
            { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
              if (k==id) print newline; else print }' "$REG" > "$tmp"
        mv "$tmp" "$REG"; chmod 600 "$REG"
        guard_no_silent_drop
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
        guard_no_silent_drop "$id"
        mirror_and_restart
        echo "==> Тенант '$id' отозван — ВСЕ его токены (включая read-only) больше не действуют."
        echo "    Файл данных на VM остался: /var/lib/sklad-sync/tenants/$id.json (удали вручную при необходимости)."
        ;;
    remove-token)
        tok="${1:?использование: $0 remove-token <token>}"
        ensure_reg
        # tenantId этого токена — если это был его последний токен, id пропадёт
        # из реестра; предупреждаем guard_no_silent_drop, что это ожидаемо.
        removed_id="$(awk -F: -v tok="$tok" '
            /^[[:space:]]*#/ { next }
            { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/,"",k)
              rest=$2; gsub(/^[[:space:]]+|[[:space:]]+$/,"",rest); split(rest,a," ")
              if (a[1]==tok) print k }' "$REG")"
        tmp="$(mktemp)"
        awk -F: -v tok="$tok" '
            /^[[:space:]]*#/ { print; next }
            {
                rest=$2; gsub(/^[[:space:]]+|[[:space:]]+$/,"",rest); split(rest,a," ")
                if (a[1]==tok) next
                print
            }' "$REG" > "$tmp"
        if cmp -s "$REG" "$tmp"; then
            rm -f "$tmp"
            echo "токен не найден в реестре" >&2
            exit 1
        fi
        if ! grep -qvE '^[[:space:]]*(#|$)' "$tmp"; then
            rm -f "$tmp"
            echo "отказ: это последний токен в реестре — сервер остался бы без токенов." >&2
            exit 1
        fi
        mv "$tmp" "$REG"; chmod 600 "$REG"
        guard_no_silent_drop "$removed_id"
        mirror_and_restart
        echo "==> Токен отозван."
        ;;
    *)
        echo "использование: $0 {list | add <tenantId> | add-token <tenantId> [--ro] | rotate <tenantId> | remove <tenantId> | remove-token <token>}" >&2
        exit 1
        ;;
esac
