#!/bin/bash
# Modifier move/resize on Bento's own windows (the sticky notes panel): press
# drag and hover, move and resize. Runs the debug app in one GUI session
# (docs/QA.md) and reads the panel's frame from the window list.
#   scripts/e2e/windows-notes.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WHO=windows-notes
HOME_DIR=/tmp/bento-e2e-windows-notes
CTL=/tmp/bentoctl
PERFORM=/tmp/bento-e2e-perform
pass=0; fails=()

ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fails+=("$1"); echo "FAIL $1"; }

# The notes panel's frame "x y w h" (CG window list: same coordinates as AX;
# layer 3 = floating, the panel floats on top).
frame() { $CTL windows Bento | awk '$2 == 3 && $5 > 200 && $6 > 100 { printf "%d %d %d %d\n", $3, $4, $5, $6; exit }'; }
expect() {
  local got; got=$(frame)
  if python3 -c "import sys; g=list(map(int,'$got'.split())); w=list(map(int,'$2'.split())); sys.exit(0 if len(g)==4 and all(abs(a-b)<=2 for a,b in zip(g,w)) else 1)"; then
    ok "$1"
  else
    bad "$1: got ($got) want ($2)"
  fi
}

swift build --product Bento >/tmp/bento-e2e-windows-notes-build.log 2>&1 || { grep -E "error:" /tmp/bento-e2e-windows-notes-build.log; exit 1; }
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

rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/config"
# Snapping off so frames are exact; notes on top so nothing covers the panel.
cat > "$HOME_DIR/config/config.json" <<'JSON'
{"general": {"enabledModules": {"shot": false, "tiling": false, "launcher": false, "clipboard": false, "windows": true, "notes": true}, "showMenuBarIcon": false},
 "windows": {"snapping": false, "dragHover": true},
 "notes": {"floatOnTop": true}}
JSON
BENTO_HOME=$HOME_DIR BENTO_DEV=1 BENTO_LOG_EVENTS=1 .build/debug/Bento > /tmp/bento-e2e-windows-notes.log 2>&1 &
APP=$!
sleep 3
$PERFORM notes.toggle
sleep 1.5
active() { scripts/e2e/session check >/dev/null || { echo "user came back: stopping"; exit 75; }; }

start=$(frame)
[ -n "$start" ] || { bad "notes panel did not open"; exit 1; }
read -r X Y W H <<< "$start"
echo "panel at $start"
# A point in the middle of the editor.
CX=$((X + W / 2)); CY=$((Y + H / 2))

# 1. Press drag ⌘⌥ moves the panel.
active
$CTL drag $CX $CY $((CX + 80)) $((CY + 40)) cmd+opt
sleep 0.5
expect "press drag ⌘⌥ moves the notes panel (+80,+40)" "$((X + 80)) $((Y + 40)) $W $H"
X=$((X + 80)); Y=$((Y + 40)); CX=$((CX + 80)); CY=$((CY + 40))

# 2. Hover ⌘⌥ moves it back.
active
$CTL modifiers cmd+opt
$CTL hover $CX $CY $((CX - 80)) $((CY - 40)) cmd+opt
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "hover ⌘⌥ moves the notes panel (-80,-40)" "$((X - 80)) $((Y - 40)) $W $H"
X=$((X - 80)); Y=$((Y - 40)); CX=$((CX - 80)); CY=$((CY - 40))

# 3. Hover ⌘⌥⇧ resizes from the bottom-right corner.
active
$CTL modifiers cmd+opt+shift
$CTL hover $CX $CY $((CX + 60)) $((CY + 30)) cmd+opt+shift
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "hover ⌘⌥⇧ resizes the notes panel (+60,+30)" "$X $Y $((W + 60)) $((H + 30))"

echo
echo "windows notes e2e: $pass passed, ${#fails[@]} failed"
for f in "${fails[@]}"; do echo "FAIL $f"; done
[ ${#fails[@]} -eq 0 ]
