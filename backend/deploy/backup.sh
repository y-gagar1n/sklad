#!/usr/bin/env bash
# Снимок данных sklad-sync. Ставится на VM как /opt/sklad-sync/backup.sh и
# запускается юнитом sklad-sync-backup.service (таймер — раз в сутки); можно
# дёрнуть вручную (sudo systemctl start sklad-sync-backup.service).
#
# Многотенантность: у каждого тенанта свой файл <data-dir>/<id>.json, поэтому
# снимаем весь каталог tenants/ одним tar.gz. Каждый файл сервер пишет через
# tmp+rename (атомарно), так что отдельные файлы в архиве всегда целые; временные
# *.tmp исключаем. Восстановление одного тенанта = достать его <id>.json из архива.
set -euo pipefail

SRC_DIR=/var/lib/sklad-sync/tenants
DEST_DIR=/var/backups/sklad-sync
KEEP_DAYS=30

# Каталога нет или он пуст (ни одного синка ещё не было) — бэкапить нечего.
if [ ! -d "$SRC_DIR" ] || [ -z "$(ls -A "$SRC_DIR" 2>/dev/null)" ]; then
    echo "нет данных в $SRC_DIR — бэкапить нечего"
    exit 0
fi

OUT="$DEST_DIR/sklad-sync-$(date -u +%Y%m%d-%H%M%S).tar.gz"

# Пишем в .part и переименовываем — прерванный на полпути таймер не оставит огрызок.
tar --exclude='*.tmp' -czf "$OUT.part" -C "$(dirname "$SRC_DIR")" "$(basename "$SRC_DIR")"
mv "$OUT.part" "$OUT"
chmod 0640 "$OUT"

find "$DEST_DIR" -maxdepth 1 -name 'sklad-sync-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "OK: $OUT"
