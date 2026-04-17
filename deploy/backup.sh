#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/maveran}"
UPLOADS_DIR="${UPLOADS_DIR:-/var/www/maveran/uploads}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL zorunlu" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

pg_dump "$DATABASE_URL" | gzip -9 > "$BACKUP_ROOT/db-$STAMP.sql.gz"

if [[ -d "$UPLOADS_DIR" ]]; then
  tar -C "$(dirname "$UPLOADS_DIR")" -czf "$BACKUP_ROOT/uploads-$STAMP.tar.gz" "$(basename "$UPLOADS_DIR")"
fi

find "$BACKUP_ROOT" -type f \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' \) -mtime +"$RETENTION_DAYS" -delete

echo "Backup tamamlandi: $BACKUP_ROOT ($STAMP)"
