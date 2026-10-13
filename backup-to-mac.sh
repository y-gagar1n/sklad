#!/usr/bin/env bash
# Копия бэкапов sklad-sync с VM на этот Mac.
#
# На VM суточный таймер кладёт снимки в /var/backups/sklad-sync (хранятся 30
# дней). Но они лежат на той же машине, что и данные: потеря VM уносит и их
# (так уже было с 213.165.212.180). Этот скрипт забирает архивы к себе.
#
#   ./backup-to-mac.sh            # забрать новые архивы сейчас
#   ./backup-to-mac.sh install    # ставить ежедневный запуск через launchd
#   ./backup-to-mac.sh uninstall  # убрать ежедневный запуск
#
# Куда: env SKLAD_MAC_BACKUP_DIR (по умолчанию ~/Backups/sklad-sync), хранится
# KEEP_DAYS дней (дольше, чем на VM). Лог — <куда>/backup.log.
# Хост VM: env SKLAD_REMOTE (по умолчанию root@164.92.247.191), ключ — env
# SKLAD_SSH_KEY (по умолчанию ~/.ssh/id_ed25519).
#
# ⛔ В архивах — данные складов. Каталог бэкапов не класть в репозиторий.
set -euo pipefail

REMOTE="${SKLAD_REMOTE:-root@164.92.247.191}"
SSH_KEY="${SKLAD_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DEST="${SKLAD_MAC_BACKUP_DIR:-$HOME/Backups/sklad-sync}"
KEEP_DAYS=365
LABEL="com.yury-timofeev.sklad-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

install_agent() {
    mkdir -p "$DEST" "$(dirname "$PLIST")"
    # Раз в сутки в 09:00 по времени Mac (снимок на VM делается около полуночи
    # UTC). Если Mac в это время спал, launchd запустит при пробуждении.
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SELF</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$DEST/backup.log</string>
  <key>StandardErrorPath</key><string>$DEST/backup.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "OK: ежедневный запуск установлен ($PLIST)"
}

case "${1:-run}" in
    install) install_agent; exit 0 ;;
    uninstall)
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
        rm -f "$PLIST"
        echo "OK: ежедневный запуск убран (архивы в $DEST остались)"
        exit 0 ;;
    run) ;;
    *) echo "использование: $0 [install|uninstall]" >&2; exit 2 ;;
esac

mkdir -p "$DEST"
chmod 700 "$DEST"
echo "== $(date '+%Y-%m-%d %H:%M:%S') забираю бэкапы с $REMOTE"

SSH="ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -i $SSH_KEY"
# Без --delete: на Mac архивы живут дольше, чем на VM.
rsync -a -e "$SSH" "$REMOTE:/var/backups/sklad-sync/sklad-sync-*.tar.gz" "$DEST/"

# Самый свежий архив должен читаться — иначе копия бесполезна.
LATEST="$(ls -1t "$DEST"/sklad-sync-*.tar.gz 2>/dev/null | head -1)"
if [ -z "$LATEST" ]; then
    echo "ОШИБКА: на Mac нет ни одного архива" >&2
    exit 1
fi
tar -tzf "$LATEST" >/dev/null
echo "свежий: $(basename "$LATEST") ($(tar -tzf "$LATEST" | grep -c '\.json$') файлов складов)"

find "$DEST" -maxdepth 1 -name 'sklad-sync-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "всего архивов на Mac: $(ls -1 "$DEST"/sklad-sync-*.tar.gz | wc -l | tr -d ' ')"
