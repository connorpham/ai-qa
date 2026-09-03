#!/usr/bin/env bash
# app_check.sh — probe the app, never start it.
#
# A gate that boots your application is a gate that can hide a broken boot.
# This only asks "is it answering?" and prints ONE machine-quotable line:
#
#   APP: UP    <url> (<http status>) in <n>s
#   APP: DOWN  <url> — <what happened> · unblock: <what to do>
#   APP: SKIP  app.url is not configured
#
# The UP line IS the bring-up proof: quote it into the verify sheet.
#
#   bash .ai-qa/scripts/app_check.sh [--wait 60] [--url http://…]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/aiqa.config.yaml" ]; do ROOT="$(dirname "$ROOT")"; done

cfg() { python3 "$HERE/lib/ctx.py" "$1" 2>/dev/null || echo ""; }

WAIT=0
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="${2:-0}"; shift 2 ;;
    --url)  URL="${2:-}";   shift 2 ;;
    *) echo "app_check: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$URL" ]; then URL="$(cd "$ROOT" 2>/dev/null && cfg app.url)"; fi
HEALTH="$(cd "$ROOT" 2>/dev/null && cfg app.health)"
START="$(cd "$ROOT" 2>/dev/null && cfg app.start)"

if [ -z "$URL" ]; then
  echo "APP: SKIP  app.url is not configured in aiqa.config.yaml"
  echo "           every case needing a running app is BLOCKED, not skipped —"
  echo "           ask the owner for the URL and set app.url."
  exit 0
fi

TARGET="$URL"
if [ -n "$HEALTH" ]; then
  TARGET="${URL%/}/${HEALTH#/}"
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "APP: DOWN  $TARGET — curl is not installed · unblock: install curl, or probe by hand"
  exit 1
fi

START_TS=$(date +%s)
DEADLINE=$(( START_TS + WAIT ))
STATUS=""
while : ; do
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET" 2>/dev/null || echo 000)"
  # 2xx/3xx answer, and 401/403 too: an app demanding credentials is UP.
  case "$STATUS" in
    2*|3*|401|403) break ;;
  esac
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  sleep 2
done
ELAPSED=$(( $(date +%s) - START_TS ))

case "$STATUS" in
  2*|3*|401|403)
    echo "APP: UP    $TARGET ($STATUS) in ${ELAPSED}s"
    exit 0 ;;
  000)
    echo "APP: DOWN  $TARGET — no answer after ${ELAPSED}s · unblock: start it with: ${START:-<app.start is not set>}"
    exit 1 ;;
  *)
    echo "APP: DOWN  $TARGET — HTTP $STATUS after ${ELAPSED}s · unblock: check the app log; ${START:-<app.start is not set>}"
    exit 1 ;;
esac
