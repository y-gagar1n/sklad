#!/usr/bin/env bash
# Тесты на чистые функции sklad-tokens.sh:
# - dropped_ids() — не было в момент инцидента, когда mirror_and_restart затёр
#   на VM токен тенанта 'nastya', которого не было в локальном (только что
#   созданном) реестре. dropped_ids должна ловить именно такую ситуацию.
# - token_line()/label_of() — формат строки реестра с алиасом токена и его
#   чтение обратно (нужно для rotate, чтобы не терять алиас при смене токена).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Импортируем функции, не выполняя диспетчер команд (см. guard-строку в самом
# sklad-tokens.sh: `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0`).
source ./sklad-tokens.sh

check() {
    local desc="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        echo "ok - $desc"
    else
        echo "FAIL - $desc: получили [$got], ожидали [$want]"
        fail=1
    fi
}

# 1) Ровно инцидент: на VM есть 'nastya', в локальном реестре — только
#    новый 'nastya_chechukova'. dropped_ids обязана вернуть 'nastya'.
remote1="$tmpdir/remote1"; local1="$tmpdir/local1"
printf 'nastya: sometoken123\n' > "$remote1"
printf 'nastya_chechukova: othertoken456\n' > "$local1"
check "инцидент: remote-only тенант обнаружен" "$(dropped_ids "$remote1" "$local1")" "nastya"

# 2) Локальный реестр содержит все id с VM (плюс, может, новые) — ничего не дропается.
remote2="$tmpdir/remote2"; local2="$tmpdir/local2"
printf 'nastya: sometoken123\n' > "$remote2"
printf 'nastya: sometoken123\nnastya_chechukova: othertoken456\n' > "$local2"
check "локальный реестр в курсе про remote-тенанта — ничего не дропается" "$(dropped_ids "$remote2" "$local2")" ""

# 3) Намеренное удаление (remove <id>): id передан в expected — не считается дропом.
remote3="$tmpdir/remote3"; local3="$tmpdir/local3"
printf 'nastya: sometoken123\nbob: tok2\n' > "$remote3"
printf 'bob: tok2\n' > "$local3"
check "remove nastya: явно ожидаемый id не считается дропом" "$(dropped_ids "$remote3" "$local3" "nastya")" ""

# 4) Несколько тенантов пропало разом — обе строки в выводе.
remote4="$tmpdir/remote4"; local4="$tmpdir/local4"
printf 'a: t1\nb: t2\nc: t3\n' > "$remote4"
printf 'c: t3\n' > "$local4"
check "несколько потерянных тенантов" "$(dropped_ids "$remote4" "$local4" | sort | tr '\n' ',')" "a,b,"

# 5) Пустой remote (первый деплой) — дропов нет.
remote5="$tmpdir/remote5"; local5="$tmpdir/local5"
: > "$remote5"
printf 'nastya: sometoken123\n' > "$local5"
check "пустой remote (первый деплой) — без дропов" "$(dropped_ids "$remote5" "$local5")" ""

# 6) token_line: без алиаса — как раньше, без "# ...".
check "token_line без алиаса" "$(token_line "nastya" "TOK" "" "")" "nastya: TOK"

# 7) token_line: с ro и алиасом.
check "token_line ro + алиас" "$(token_line "nastya" "TOK" " ro" "Настя, телефон")" "nastya: TOK ro  # Настя, телефон"

# 8) label_of: достаёт алиас существующей строки тенанта.
reg8="$tmpdir/reg8"
printf 'nastya: TOK1  # Настя, телефон\nbob: TOK2\n' > "$reg8"
check "label_of находит алиас" "$(label_of "$reg8" "nastya")" "Настя, телефон"
check "label_of пусто, если алиаса нет" "$(label_of "$reg8" "bob")" ""

exit $fail
