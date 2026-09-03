#!/usr/bin/env bash
# device_check.sh — is there a real device or emulator to test on?
#
#   DEVICE: UP    <platform> <id>
#   DEVICE: DOWN  <platform> — <why> · unblock: <what to do>
#   DEVICE: SKIP  mobile is not an active surface
#
# Screenshots must come off a real device or emulator. A screenshot of a mock
# is not evidence of anything.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cfg() { python3 "$HERE/lib/ctx.py" "$1" 2>/dev/null || echo ""; }

PLATFORM="$(cfg mobile.platform)"
if [ -z "$PLATFORM" ]; then
  echo "DEVICE: SKIP  mobile.platform is not set in aiqa.config.yaml"
  exit 0
fi

case "$PLATFORM" in
  android|flutter)
    if ! command -v adb >/dev/null 2>&1; then
      echo "DEVICE: DOWN  android — adb not found · unblock: install Android platform-tools"
      exit 1
    fi
    LIST="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
    if [ -z "$LIST" ]; then
      echo "DEVICE: DOWN  android — no device attached · unblock: start an emulator (emulator -list-avds) or plug a phone in with USB debugging on"
      exit 1
    fi
    echo "DEVICE: UP    android $(echo "$LIST" | head -1)"
    ;;
  ios)
    if ! command -v xcrun >/dev/null 2>&1; then
      echo "DEVICE: DOWN  ios — xcrun not found · unblock: install Xcode command line tools"
      exit 1
    fi
    BOOTED="$(xcrun simctl list devices booted 2>/dev/null | grep -m1 Booted || true)"
    if [ -z "$BOOTED" ]; then
      echo "DEVICE: DOWN  ios — no booted simulator · unblock: xcrun simctl boot <device>, or open Simulator"
      exit 1
    fi
    echo "DEVICE: UP    ios $(echo "$BOOTED" | sed 's/^ *//')"
    ;;
  *)
    echo "DEVICE: DOWN  $PLATFORM — unsupported platform · unblock: set mobile.platform to ios, android or flutter"
    exit 1 ;;
esac
