#!/usr/bin/env bash
# Снимок данных sklad-sync. Ставится на VM как /opt/sklad-sync/backup.sh и
# запускается юнитом sklad-sync-backup.service (таймер — раз в сутки), а также
# вручную из restore-sklad.sh перед перезаписью данных.
#
# Сервер пишет файл данных через tmp+rename, поэтому копия снимается на живом
# сервисе: читатель всегда видит целую версию.
set -euo pipefail

SRC=/var/lib/sklad-sync/sklad-sync.json
DEST_DIR=/var/backups/sklad-sync
KEEP_DAYS=30

if [ ! -f "$SRC" ]; then
    echo "нет $SRC — бэкапить нечего"
    exit 0
fi

OUT="$DEST_DIR/sklad-sync-$(date -u +%Y%m%d-%H%M%S).json.gz"

# gzip -n: без имени и времени в заголовке. Пишем в .part и переименовываем —
# прерванный на полпути таймер не оставит огрызок.
gzip -nc "$SRC" > "$OUT.part"
mv "$OUT.part" "$OUT"
chmod 0640 "$OUT"

find "$DEST_DIR" -maxdepth 1 -name 'sklad-sync-*.json.gz' -mtime "+$KEEP_DAYS" -delete

echo "OK: $OUT"
