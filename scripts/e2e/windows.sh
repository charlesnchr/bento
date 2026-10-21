#!/bin/bash
# Windows module end-to-end regression with real input and frame assertions:
# every keyboard action (real hotkeys), the snap regions at the true screen
# edges (title-bar drags), modifier drags and clicks, layouts and stash, all on
# our own TextEdit document (/tmp/windows-qa.txt), against the worktree's Bento.
#
#   scripts/e2e/windows.sh               everything, in two sessions of ≤ 3 min:
#                                        "keys snap", then "drag misc panels import"
#   scripts/e2e/windows.sh <phase…>      one session; phases: keys snap drag misc panels import, and
#                                        spaces (moves our window to the next Space and back: switches
#                                        the visible Space, so it is never run by default)
#
# Takes its own GUI session (scripts/e2e/session start/end windows); set
# WINDOWS_E2E_IN_SESSION=1 if you already hold one. SKIP_BUILD=1 skips the build.
# Exits 0 when everything passed, 1 on failures, 75 if the user came back.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WHO=windows
HOME_DIR=/tmp/bento-e2e-windows
LOG="$HOME_DIR/bento.log"
DOC=/tmp/windows-qa.txt
PHASES="$*"

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  (cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|Build of product" | tail -3) || exit 1
fi
if [ $# -eq 0 ]; then
  overall=0
  for group in "keys snap" "drag misc panels import"; do
    # shellcheck disable=SC2086
    SKIP_BUILD=1 "$0" $group; st=$?
    [ "$st" = 75 ] && exit 75
    [ "$st" != 0 ] && overall=1
  done
  exit $overall
fi
[ -x "$ROOT/.build/debug/Bento" ] || { echo "no $ROOT/.build/debug/Bento" >&2; exit 1; }
for t in windows-e2e windows-click; do
  [ "/tmp/$t" -nt "$ROOT/scripts/e2e/$t.swift" ] || swiftc -O "$ROOT/scripts/e2e/$t.swift" -o "/tmp/$t" || exit 1
done
[ /tmp/bentoctl -nt "$ROOT/scripts/e2e/bentoctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/bentoctl.swift" -o /tmp/bentoctl || exit 1

# Another dev instance with the Windows module would also act on our `perform`
# notifications and modifier drags (instances with it disabled are harmless).
conflict() {
  for pid in $(pgrep -f "/debug/(Bento|DevWindows)$"); do
    home=$(ps -wwE -p "$pid" | tr ' ' '\n' | sed -n 's/^BENTO_HOME=//p' | head -1)
    [ "$home" = "$HOME_DIR" ] && continue
    windows_on=$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["general"]["enabledModules"].get("windows", True))
except Exception: print(True)' "${home:-/nonexistent}/config/config.json")
    if [ "$windows_on" != False ]; then echo "$(ps -o command= -p "$pid") (BENTO_HOME=${home:-?})"; return 0; fi
  done
  return 1
}
for _ in $(seq 1 120); do conflict >/dev/null || break; sleep 10; done
if c=$(conflict); then echo "another dev instance with the Windows module is still running: $c"; exit 1; fi

rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/config"
cat > "$HOME_DIR/config/config.json" <<'JSON'
{
  "general": {"enabledModules": {"shot": false, "tiling": false, "launcher": false, "clipboard": false, "notes": false, "windows": true}},
  "windows": {"importedFromRectangle": true}
}
JSON
: > "$DOC"
for i in $(seq 1 40); do echo "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda $i" >> "$DOC"; done

BPID=""
LAUNCHED_TEXTEDIT=0
STARTED_SESSION=0
cleanup() {
  [ -n "$BPID" ] && kill "$BPID" 2>/dev/null && wait "$BPID" 2>/dev/null
  # Close our document (unmodified) by its close button; never touch other documents.
  if [ -f "$DOC" ] && /tmp/bentoctl frame com.apple.TextEdit windows-qa >/dev/null 2>&1; then
    BENTO_LOG="$LOG" /tmp/windows-e2e cleanup >/dev/null 2>&1
  fi
  if [ "$LAUNCHED_TEXTEDIT" = 1 ] && [ -z "$(/tmp/bentoctl windows TextEdit 2>/dev/null)" ]; then
    osascript -e 'tell application id "com.apple.TextEdit" to quit' >/dev/null 2>&1
  fi
  [ "$STARTED_SESSION" = 1 ] && "$ROOT/scripts/e2e/session" end "$WHO"
}
trap cleanup EXIT

if [ "${WINDOWS_E2E_IN_SESSION:-0}" != 1 ]; then
  "$ROOT/scripts/e2e/session" start "$WHO" || exit 1
  STARTED_SESSION=1
fi
if c=$(conflict); then echo "another dev instance with the Windows module started meanwhile: $c"; exit 1; fi

BENTO_HOME="$HOME_DIR" BENTO_DEV=1 BENTO_LOG_EVENTS=1 "$ROOT/.build/debug/Bento" 2>"$LOG" &
BPID=$!
if pgrep -x TextEdit >/dev/null; then
  open -g -a TextEdit "$DOC"
else
  LAUNCHED_TEXTEDIT=1
  open -g -a TextEdit "$DOC" --args -ApplePersistenceIgnoreState YES
fi
for _ in $(seq 1 30); do /tmp/bentoctl frame com.apple.TextEdit windows-qa >/dev/null 2>&1 && break; sleep 0.2; done
sleep 1.5 # Bento: hotkeys, tap and config watcher up
kill -0 "$BPID" 2>/dev/null || { echo "Bento exited:"; cat "$LOG"; exit 1; }

BENTO_LOG="$LOG" BENTO_CONFIG="$HOME_DIR/config/config.json" BENTO_PID="$BPID" QA_TITLE=windows-qa \
  /tmp/windows-e2e $PHASES
status=$?
kill -0 "$BPID" 2>/dev/null || { echo "!! Bento died during the run (crash?)"; tail -20 "$LOG"; status=1; }
exit $status
