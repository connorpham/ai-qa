#!/usr/bin/env bash
# app_check.sh — probe the app, never start it.
#
# A gate that boots your application is a gate that can hide a broken boot.
# This only asks "is it answering?" and prints ONE machine-quotable line:
#
#   APP: UP    <url> (<http status>) in <n>s · env: <name>
#   APP: DOWN  <url> — <what happened> · unblock: <what to do>
#   APP: SKIP  app.url is not configured
#
# The UP line IS the bring-up proof: quote it into the verify sheet. The env
# tag names which of the configured environments answered — the same name the
# report's ENVIRONMENT: line must carry.
#
#   bash .ai-qa/scripts/app_check.sh [--wait 60] [--url http://…] [--env stg]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/aiqa.config.yaml" ]; do ROOT="$(dirname "$ROOT")"; done

cfg() { python3 "$HERE/lib/ctx.py" "$1" 2>/dev/null || echo ""; }

WAIT=0
URL=""
# A health check answers "is it up NOW". Only a lane bringing the app up wants
# to wait for a boot, so doctor sets AIQA_PROBE_ONLY and the wait is capped —
# otherwise every doctor run on a laptop with the app off costs a full minute
# per surface that declares this probe.
PROBE_CAP="${AIQA_PROBE_ONLY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="${2:-0}"; shift 2 ;;
    --url)  URL="${2:-}";   shift 2 ;;
    --env)  export AIQA_ENV="${2:-}"; shift 2 ;;
    *) echo "app_check: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -n "$PROBE_CAP" ] && [ "$WAIT" -gt 5 ] 2>/dev/null; then WAIT=5; fi

# The environment resolves in ONE place (lib/ctx.py): $AIQA_ENV, else
# environments.default, else the legacy app.url. A chosen name with no block in
# the config resolves to an empty url — a declared unknown, never localhost.
ENV_NAME="$(cd "$ROOT" 2>/dev/null && cfg env.name)"
if [ -z "$URL" ]; then URL="$(cd "$ROOT" 2>/dev/null && cfg env.url)"; fi
HEALTH="$(cd "$ROOT" 2>/dev/null && cfg env.health)"
START="$(cd "$ROOT" 2>/dev/null && cfg app.start)"
ENV_TAG=""
if [ -n "$ENV_NAME" ]; then ENV_TAG=" · env: $ENV_NAME"; fi

if [ -z "$URL" ]; then
  if [ -n "$ENV_NAME" ]; then
    echo "APP: SKIP  environment '$ENV_NAME' has no url — set environments.$ENV_NAME.url"
    echo "           (or app.url) in aiqa.config.yaml. Every case needing a running app"
    echo "           is BLOCKED, not skipped — a run cannot fall back to localhost and"
    echo "           still claim it tested '$ENV_NAME'."
  else
    echo "APP: SKIP  app.url is not configured in aiqa.config.yaml"
    echo "           every case needing a running app is BLOCKED, not skipped —"
    echo "           ask the owner for the URL and set app.url."
  fi
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
  # curl already prints 000 when it never got a response, so the usual
  # `|| echo 000` fallback concatenates and yields "000000".
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET" 2>/dev/null)"
  STATUS="${STATUS:-000}"
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
    echo "APP: UP    $TARGET ($STATUS) in ${ELAPSED}s$ENV_TAG"
    exit 0 ;;
  000)
    echo "APP: DOWN  $TARGET — no answer after ${ELAPSED}s$ENV_TAG · unblock: start it with: ${START:-<app.start is not set>}"
    exit 1 ;;
  *)
    echo "APP: DOWN  $TARGET — HTTP $STATUS after ${ELAPSED}s$ENV_TAG · unblock: check the app log; ${START:-<app.start is not set>}"
    exit 1 ;;
esac
