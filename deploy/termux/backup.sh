#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
PROJECT_DIR="${STUDY_RIVALS_DIR:-$HOME/Study-Rivals}"
BACKUP_DIR="$PROJECT_DIR/backups"
mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
sqlite3 "$PROJECT_DIR/data/study-rivals.db" ".backup '$BACKUP_DIR/study-rivals-$stamp.db'"
find "$BACKUP_DIR" -type f -name 'study-rivals-*.db' -mtime +14 -delete
echo "$BACKUP_DIR/study-rivals-$stamp.db"
