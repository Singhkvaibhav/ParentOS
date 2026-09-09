#!/usr/bin/env bash
#
# Database backup with verification and retention.
#
# The failure this guards against is the classic one: backups that run
# nightly for a year, are never restored, and turn out to be empty or
# truncated on the day they're needed. So this script VERIFIES each dump
# after writing it rather than trusting a zero exit code from pg_dump.
#
# Usage:
#   ./scripts/backup.sh                 # write a backup, verify, prune old ones
#   BACKUP_DIR=/mnt/backups ./scripts/backup.sh
#
# Intended to run from cron or a scheduled container task. Exits non-zero
# on any failure so the scheduler can alert - a backup job that fails
# silently is indistinguishable from one that never ran.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/parentos}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="${BACKUP_DIR}/parentos-${timestamp}.dump"

mkdir -p "$BACKUP_DIR"

log() { printf '{"level":"info","event":"backup","detail":"%s","time":"%s"}\n' "$1" "$(date -u +%FT%TZ)"; }
fail() { printf '{"level":"error","event":"backup_failed","detail":"%s","time":"%s"}\n' "$1" "$(date -u +%FT%TZ)" >&2; exit 1; }

log "starting backup to ${outfile}"

# Custom format (-Fc): compressed, and restorable selectively with
# pg_restore, which matters when you need one table back rather than the
# whole database during an incident.
if ! pg_dump --dbname="$DATABASE_URL" --format=custom --file="$outfile" 2>/tmp/pg_dump_err; then
  fail "pg_dump failed: $(tr -d '\n' < /tmp/pg_dump_err)"
fi

# --- Verification -------------------------------------------------------
#
# A dump file existing proves nothing. pg_restore --list reads the archive
# table of contents, so a truncated or corrupt file fails here rather than
# during a real restore at 3am.
if ! pg_restore --list "$outfile" > /tmp/backup_toc 2>/dev/null; then
  rm -f "$outfile"
  fail "dump is unreadable by pg_restore - removed rather than kept as a false reassurance"
fi

# An archive that restores cleanly but contains no tables is the other
# silent failure: pointing at an empty database and backing that up
# faithfully for months.
table_count="$(grep -c 'TABLE DATA' /tmp/backup_toc || true)"
if [ "$table_count" -lt 1 ]; then
  rm -f "$outfile"
  fail "dump contains no table data - refusing to keep an empty backup"
fi

size="$(stat -c %s "$outfile")"
log "backup verified: ${size} bytes, ${table_count} tables with data"

# --- Retention ----------------------------------------------------------
#
# Pruned only AFTER the new backup is verified, so a failing backup job can
# never delete the last known-good one.
deleted="$(find "$BACKUP_DIR" -name 'parentos-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
log "retention: removed ${deleted} backup(s) older than ${RETENTION_DAYS} days"

remaining="$(find "$BACKUP_DIR" -name 'parentos-*.dump' -type f | wc -l)"
log "backup complete: ${remaining} backup(s) retained"
