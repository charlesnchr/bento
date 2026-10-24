#!/bin/bash
# Run inside scripts/e2e/session, against a signed Bento.app with existing
# Accessibility permission. Uses isolated config, no input events or user data.
# Usage: scripts/e2e/launch.sh /path/to/Bento.app
set -euo pipefail
APP="${1:?signed Bento.app path required}"
APP="$(cd "$APP" && pwd -P)"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CTL=/tmp/bento-launch-ctl
H="$(mktemp -d /tmp/bento-launch-qa.XXXXXX)"
DIAG="$H/support/diagnostics.json"
PID=""
check_session() {
  test -f /tmp/bento-gui.lock/owner
  "$ROOT/scripts/e2e/session" check
}
test_pids() { ps -axo pid=,comm= | awk -v exe="$APP/Contents/MacOS/Bento" '{pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0 == exe) print pid}'; }
stop_test() {
  local pids
  pids="$(test_pids)"
  if [ -n "$pids" ]; then
    kill -TERM $pids
    for _ in $(seq 1 50); do
      [ -z "$(test_pids)" ] && break
      sleep 0.1
    done
    [ -z "$(test_pids)" ] || { echo 'test app did not terminate' >&2; return 1; }
  fi
  PID=""
  rm -f "$DIAG"
}
cleanup() { stop_test; echo "launch test artifacts: $H"; }
check_session
[ -z "$(test_pids)" ] || { echo 'test app is already running' >&2; exit 1; }
trap cleanup EXIT
swiftc -O "$ROOT/scripts/e2e/overview-ctl.swift" -o "$CTL"
mkdir -p "$H/config" "$H/support"
cat > "$H/config/config.json" <<'JSON'
{"general":{"checkForUpdates":false,"showMenuBarIcon":false,"enabledModules":{"shot":false,"windows":false,"tiling":false,"launcher":false,"clipboard":false,"notes":false,"todo":false,"menubar":false}},"windows":{"importedFromRectangle":true},"shortcuts":{}}
JSON
launch() {
  check_session
  open "$@" "$APP" --env BENTO_DEV=1 --env "BENTO_HOME=$H"
}
launch_background() {
  check_session
  open -n -g "$APP" --env BENTO_DEV=1 --env "BENTO_HOME=$H" --args --background
}
diag() {
  rm -f "$DIAG"
  "$CTL" url "$H" bento://debug/state
  for _ in $(seq 1 50); do
    check_session
    [ -s "$DIAG" ] && return
    sleep 0.1
  done
  echo 'no fresh diagnostics' >&2; return 1
}
ready() {
  for _ in $(seq 1 60); do
    check_session
    "$CTL" url "$H" bento://debug/state
    [ -s "$DIAG" ] && break
    sleep 0.1
  done
  diag
  PID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$DIAG")"
}
assert_window() {
  local expected="$1"
  diag
  cp "$DIAG" "$H/last-diagnostics.json"
  python3 - "$DIAG" "$expected" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['accessibility'], 'permission missing: launch visibility result would be invalid'
assert not d['statusItem'], 'test must have no menu-bar icon'
assert d['settingsWindow']['open'] == (sys.argv[2] == 'yes'), d['settingsWindow']
PY
  if [ "$expected" = yes ]; then
    "$CTL" windows "$PID" | grep -q 'Bento Settings'
  else
    ! "$CTL" windows "$PID" | grep -q 'Bento Settings'
  fi
}

launch -n
ready
assert_window yes
echo 'PASS: foreground cold launch opens Settings with the status icon disabled'
stop_test

launch_background
ready
assert_window no
launch
sleep 0.5
assert_window yes
echo 'PASS: explicit background launch stays quiet, normal reopen shows Settings'
stop_test

launch_background
ready
assert_window no
launch -n
sleep 1
ready
assert_window yes
[ "$(test_pids | wc -l | tr -d ' ')" = 1 ]
echo 'PASS: duplicate foreground launch leaves one visible survivor'
stop_test

check_session
open -n -g -a "$APP" bento://debug/state --env BENTO_DEV=1 --env "BENTO_HOME=$H"
for _ in $(seq 1 60); do
  check_session
  [ -s "$DIAG" ] && break
  sleep 0.1
done
[ -s "$DIAG" ] || { echo 'cold URL was not delivered' >&2; exit 1; }
ready
assert_window no
echo 'PASS: cold action URL stays quiet and reaches the running app'
