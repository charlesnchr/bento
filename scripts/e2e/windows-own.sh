#!/bin/bash
# The Windows module on Bento's own windows, with real input: the real
# keyboard shortcuts, ⌘⌥ press and hover drags, and drag-to-snap by the title
# bar, on the Todo window and on Settings, like any other app's window. Runs
# the debug app in one GUI session (docs/QA.md) and reads frames from the
# window list.
#   scripts/e2e/windows-own.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WHO=windows-own
HOME_DIR=/tmp/bento-e2e-windows-own
CTL=/tmp/bentoctl
PERFORM=/tmp/bento-e2e-perform
pass=0; fails=()

ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fails+=("$1"); echo "FAIL $1"; }

# A Bento window's frame "x y w h" by title (normal layer).
frame() { $CTL windows Bento | awk -v t="$1" '$2 == 0 && index($0, t) { printf "%d %d %d %d\n", $3, $4, $5, $6; exit }'; }
expect() { # name title "x y w h"
  local got; got=$(frame "$2")
  if python3 -c "import sys; g=list(map(int,'$got'.split())); w=list(map(int,'$3'.split())); sys.exit(0 if len(g)==4 and all(abs(a-b)<=2 for a,b in zip(g,w)) else 1)"; then
    ok "$1"
  else
    bad "$1: got ($got) want ($3)"
  fi
}

swift build --product Bento >/tmp/bento-e2e-windows-own-build.log 2>&1 || { grep -E "error:" /tmp/bento-e2e-windows-own-build.log; exit 1; }
swiftc -O scripts/e2e/bentoctl.swift -o $CTL 2>/dev/null
cat > /tmp/bento-e2e-perform.swift <<'SWIFT'
import Foundation
DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.perform"),
    object: CommandLine.arguments[1], userInfo: nil, deliverImmediately: true)
SWIFT
swiftc -O /tmp/bento-e2e-perform.swift -o $PERFORM 2>/dev/null || exit 1

scripts/e2e/session start $WHO || exit 1
APP=""
cleanup() {
  $CTL modifiers none >/dev/null 2>&1
  [ -n "$APP" ] && kill "$APP" 2>/dev/null
  scripts/e2e/session end $WHO
}
trap cleanup EXIT
active() { scripts/e2e/session check >/dev/null || { echo "user came back: stopping"; exit 75; }; }

launch() { # extra env…
  [ -n "$APP" ] && { kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; }
  rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/config"
  # Like the user's setup: Windows and Tiling (manager off) on.
  cat > "$HOME_DIR/config/config.json" <<'JSON'
{"general": {"enabledModules": {"shot": false, "tiling": true, "launcher": false, "clipboard": false, "notes": false, "windows": true, "todo": true}, "showMenuBarIcon": false},
 "windows": {"importedFromRectangle": true, "snapping": true, "showHUD": false, "dragHover": true},
 "tiling": {"managerOn": false, "onlyApps": ["com.apple.TextEdit"]}}
JSON
  env "$@" BENTO_HOME=$HOME_DIR BENTO_DEV=1 BENTO_LOG_EVENTS=1 .build/debug/Bento >> /tmp/bento-e2e-windows-own.log 2>&1 &
  APP=$!
  sleep 3
}
: > /tmp/bento-e2e-windows-own.log

read -r _ FX FY FW FH _ VX VY VW VH <<< "$($CTL screens | head -1)"
HALF=$((VW / 2))
LEFT="$VX $VY $HALF $VH"; RIGHT="$((VX + VW - HALF)) $VY $HALF $VH"; FULL="$VX $VY $VW $VH"

# Moves the frontmost window to a known, unsnapped frame through Bento itself
# (Center keeps the size; a reopened window may be anywhere).
centre() { $PERFORM windows.center; sleep 0.6; }

# Shortcuts, as the user presses them, with a Bento window frontmost.
keys() { # title
  local t=$1 start
  # Restore goes back to the frame from before Bento first moved the window.
  start=$(frame "$t")
  centre
  active
  $CTL key ctrl+opt+left --expect-pid $APP; sleep 0.6
  expect "⌃⌥← left half on $t" "$t" "$LEFT"
  $CTL key ctrl+opt+right --expect-pid $APP; sleep 0.6
  expect "⌃⌥→ right half on $t" "$t" "$RIGHT"
  $CTL key ctrl+opt+return --expect-pid $APP; sleep 0.6
  expect "⌃⌥↩ maximize on $t" "$t" "$FULL"
  $CTL key ctrl+opt+delete --expect-pid $APP; sleep 0.6
  expect "⌃⌥⌫ restore on $t" "$t" "$start"
}

# --- Todo window
launch
$PERFORM todo.toggle; sleep 1.5
[ -n "$(frame Todo)" ] || { bad "todo window did not open"; exit 1; }
keys Todo

# ⌘⌥ press drag and hover move.
active
centre
read -r X Y W H <<< "$(frame Todo)"; CX=$((X + W / 2)); CY=$((Y + H / 2))
$CTL drag $CX $CY $((CX + 60)) $((CY + 40)) cmd+opt --expect-pid $APP; sleep 0.5
expect "⌘⌥ press drag moves the Todo window" Todo "$((X + 60)) $((Y + 40)) $W $H"
X=$((X + 60)); Y=$((Y + 40)); CX=$((CX + 60)); CY=$((CY + 40))
active
$CTL modifiers cmd+opt
$CTL hover $CX $CY $((CX - 60)) $((CY - 40)) cmd+opt --expect-pid $APP
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "⌘⌥ hover moves the Todo window" Todo "$((X - 60)) $((Y - 40)) $W $H"

# Title-bar drag to the left screen edge snaps.
active
read -r X Y W H <<< "$(frame Todo)"
$CTL drag $((X + W / 2)) $((Y + 12)) $((FX + 1)) $((FY + FH / 2)) --expect-pid $APP; sleep 0.8
expect "title-bar drag to the left edge snaps Todo to the left half" Todo "$LEFT"

# --- Settings window
launch BENTO_SHOW_SETTINGS=1
sleep 1
if [ -n "$(frame "Bento Settings")" ]; then keys "Bento Settings"; else bad "settings window did not open"; fi

echo
echo "windows own e2e: $pass passed, ${#fails[@]} failed"
for f in ${fails[@]+"${fails[@]}"}; do echo "FAIL $f"; done
[ ${#fails[@]} -eq 0 ]
