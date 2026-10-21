#!/bin/bash
# Hover move/resize regression (Rectangle Pro style): hold the modifiers and
# move the pointer, no click; ⇧ pressed/released mid-gesture switches between
# move and resize. Runs the debug app in one GUI session (docs/QA.md) on our
# own TextEdit document and asserts window frames.
#   scripts/e2e/windows-hover.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WHO=windows-hover
B=com.apple.TextEdit
T=windows-hover-qa
DOC=/tmp/$T.txt
HOME_DIR=/tmp/bento-e2e-hover
CTL=/tmp/bentoctl
pass=0; fails=()

ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fails+=("$1"); echo "FAIL $1"; }

# Frame equality within 2 pt: expect "name" "x y w h"
expect() {
  local got; got=$($CTL frame $B $T 2>/dev/null)
  if python3 -c "import sys; g=list(map(int,'$got'.split())); w=list(map(int,'$2'.split())); sys.exit(0 if len(g)==4 and all(abs(a-b)<=2 for a,b in zip(g,w)) else 1)"; then
    ok "$1"
  else
    bad "$1: got ($got) want ($2)"
  fi
}

swift build --product Bento 2>&1 | grep -E "error" && exit 1
swiftc -O scripts/e2e/bentoctl.swift -o $CTL 2>/dev/null

scripts/e2e/session start $WHO || exit 1
APP=""
cleanup() {
  $CTL modifiers none >/dev/null 2>&1
  [ -n "$APP" ] && kill "$APP" 2>/dev/null
  osascript -e "tell application \"TextEdit\" to close (every document whose name is \"$T.txt\") saving no" >/dev/null 2>&1
  rm -f "$DOC"
  scripts/e2e/session end $WHO
}
trap cleanup EXIT

rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/config"
# Hover on and classic resize (the defaults), snapping off so frames are exact.
echo '{"windows":{"snapping":false,"dragHover":true}}' > "$HOME_DIR/config/config.json"
BENTO_HOME=$HOME_DIR BENTO_DEV=1 .build/debug/Bento > /tmp/bento-e2e-hover.log 2>&1 &
APP=$!
printf 'hover qa\n' > "$DOC"
open -a TextEdit "$DOC"
sleep 3

reset() {
  $CTL setframe $B $T 300 250 600 400
  $CTL front $B $T >/dev/null
  sleep 0.4
}
active() { scripts/e2e/session check >/dev/null || { echo "user came back: stopping"; exit 75; }; }

# 1. Hover move: ⌘⌥ + pointer moves (no button) carry the window along.
reset; active
$CTL modifiers cmd+opt
$CTL --expect $B hover 600 450 700 500 cmd+opt
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "hover move ⌘⌥ (+100,+50)" "400 300 600 400"

# 2. Hover resize: ⌘⌥⇧ near the bottom-right corner resizes from it.
reset; active
$CTL modifiers cmd+opt+shift
$CTL --expect $B hover 880 630 980 680 cmd+opt+shift
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "hover resize ⌘⌥⇧ from bottom-right (+100,+50)" "300 250 700 450"

# 3. One gesture, three segments: move, ⇧ → resize, release ⇧ → move.
reset; active
$CTL modifiers cmd+opt
$CTL --expect $B hover 880 630 780 630 cmd+opt          # move left 100   -> origin (200,250)
sleep 0.25
$CTL modifiers cmd+opt+shift                              # ⇧ down: resize from the corner under the pointer
sleep 0.2
$CTL --expect $B hover 780 630 830 680 cmd+opt+shift    # +50,+50 from bottom-right -> 650x450
sleep 0.25
$CTL modifiers cmd+opt                                    # ⇧ up: back to moving
sleep 0.2
$CTL --expect $B hover 830 680 830 730 cmd+opt          # down 50 -> origin (200,300)
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "move → ⇧ resize → release ⇧ move in one gesture" "200 300 650 450"

# 4. Classic (default): from the top-left quarter, moving left/up still shrinks
#    from the bottom-right corner (the top-left corner stays put).
reset; active
$CTL modifiers cmd+opt+shift
$CTL --expect $B hover 350 300 300 270 cmd+opt+shift
sleep 0.3; $CTL modifiers none; sleep 0.5
expect "classic resize: top-left stays, bottom-right shrinks (-50,-30)" "300 250 550 370"

# 4b. Live nearest edges (setting): starting at the centre and moving left, the
#     right edge follows for a few points, then the left edge takes over.
python3 - "$HOME_DIR/config/config.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d.setdefault("windows", {})["dragResizeStyle"] = "live"
json.dump(d, open(p, "w"), indent=2)
PY
sleep 1.5   # the app reloads the config file live
reset; active
$CTL modifiers cmd+opt+shift
$CTL --expect $B hover 600 450 450 450 cmd+opt+shift
sleep 0.3; $CTL modifiers none; sleep 0.5
got=$($CTL frame $B $T)
if python3 -c "import sys; x,y,w,h=map(int,'$got'.split()); sys.exit(0 if abs(x-158)<=4 and abs(x+w-892)<=4 and y==250 and h==400 else 1)"; then
  ok "live resize: edge flips as the pointer crosses the middle ($got)"
else
  bad "live resize edge flip: got ($got), want ~(158 250 734 400)"
fi
python3 - "$HOME_DIR/config/config.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["windows"]["dragResizeStyle"] = "classic"
json.dump(d, open(p, "w"), indent=2)
PY
sleep 1.5

# 5. Holding ⌘⌥ and releasing without moving changes nothing.
reset; active
$CTL modifiers cmd+opt; sleep 0.3; $CTL modifiers none; sleep 0.4
expect "⌘⌥ held without moving: no change" "300 250 600 400"

# 6. Modifiers released: further pointer moves don't drag.
reset; active
$CTL modifiers cmd+opt
$CTL --expect $B hover 600 450 650 450 cmd+opt
sleep 0.2; $CTL modifiers none; sleep 0.3
$CTL --expect $B hover 650 450 750 550 ""
sleep 0.4
expect "after releasing the modifiers the window stays" "350 250 600 400"

echo
echo "windows hover e2e: $pass passed, ${#fails[@]} failed"
for f in "${fails[@]}"; do echo "FAIL $f"; done
[ ${#fails[@]} -eq 0 ]
