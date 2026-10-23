#!/bin/bash
# Menu bar module end-to-end test, against the real menu bar (one GUI session).
#   scripts/e2e/menubar.sh
#
# Uses three throwaway status items X Y Z (menubar-items.swift) and the DevMenuBar
# harness, isolated under /tmp/bento-e2e-menubar: hides and shows the sections,
# arranges and reorders items through profiles (real ⌘-drags), clicks a hidden item
# from its shortcut action, the Bento Bar and search (each item logs when its menu
# opens), crowds the menu bar to check notch overflow, measures idle CPU, and puts
# everything back.
#
# Safety: only the test items are moved. The menu bar is recorded first and must be
# exactly the same at the end (window ids, names, positions). The installed Bento
# keeps running: nothing here needs its hotkeys (actions go through scripts/perform),
# and its icon is part of the menu bar under test. Screenshots of the status item
# area (right of the notch) go to /tmp/menubar-e2e/.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export BENTO_HOME=/tmp/bento-e2e-menubar
export BENTO_INSTALL_DIR=/nonexistent   # session start/end leave the installed Bento alone
OUT=/tmp/menubar-e2e
QALOG=$OUT/menus.log
TOOL=/tmp/menubar-items
HARNESS="$ROOT/.build-menubar/debug/DevMenuBar"
WHO=menubar-e2e
PASSES=0; FAILS=0

log() { printf '%s\n' "$*"; }
ok() { PASSES=$((PASSES + 1)); log "  ✓ $*"; }
bad() { FAILS=$((FAILS + 1)); log "  ✗ $*"; }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', want '$3'"; fi; }
eventually() { # eventually <seconds> <description> <command...>
  local t=$1 d=$2; shift 2
  local end=$(( $(date +%s) + t ))
  while :; do
    if "$@" >/dev/null 2>&1; then ok "$d"; return 0; fi
    [ "$(date +%s)" -ge "$end" ] && { bad "$d (after ${t}s)"; return 1; }
    sleep 0.25
  done
}

# ---------------------------------------------------------------- setup

log "building…"
( cd "$ROOT" && swift build --scratch-path .build-menubar --product DevMenuBar 2>&1 | grep -E "error:" ) && exit 1
[ "$TOOL" -nt "$ROOT/scripts/e2e/menubar-items.swift" ] || swiftc -O "$ROOT/scripts/e2e/menubar-items.swift" -o "$TOOL" || exit 1
rm -rf "$BENTO_HOME" "$OUT"; mkdir -p "$BENTO_HOME/config" "$OUT"
P=menubar-items   # the test items' key prefix (no bundle id: the executable name)
cat > "$BENTO_HOME/config/config.json" <<JSON
{"general": {"enabledModules": {"menubar": true}, "showMenuBarIcon": false},
 "menubar": {"bar": "never", "autoRehide": false, "rehideOnClickOutside": true, "keepItemsInPlace": false,
   "itemHotkeys": {"$P/BentoQAX": "hyper+f12"},
   "profiles": [
     {"id": "a", "name": "QA Arrange", "layout": {"hidden": ["$P/BentoQAX", "$P/BentoQAY"], "alwaysHidden": ["$P/BentoQAZ"]}},
     {"id": "s", "name": "QA Swap", "layout": {"hidden": ["$P/BentoQAY", "$P/BentoQAX"], "alwaysHidden": ["$P/BentoQAZ"]}},
     {"id": "b", "name": "QA Back", "layout": {"visible": ["$P/BentoQAZ", "$P/BentoQAY", "$P/BentoQAX"]}}]}}
JSON
# Fresh positions: new status items appear at the left end of the menu bar.
defaults delete DevMenuBar >/dev/null 2>&1; defaults delete menubar-items >/dev/null 2>&1

state() { # state <jq filter on the module's diagnostics>
  rm -f "$BENTO_HOME/support/diagnostics.json"
  "$TOOL" url "$BENTO_HOME" "bento://debug/state"
  for _ in $(seq 1 60); do [ -s "$BENTO_HOME/support/diagnostics.json" ] && break; sleep 0.05; done
  jq -r ".modules.menubar.state | $1" "$BENTO_HOME/support/diagnostics.json" 2>/dev/null
}
section() { state ".items[] | select(.key == \"$P/BentoQA$1\") | .section"; }
onscreen() { local x; x=$(state ".items[] | select(.key == \"$P/BentoQA$1\") | .x"); [ "${x%.*}" -ge 0 ] 2>/dev/null && echo yes || echo no; }
qaorder() { state "[.items[] | select(.key | startswith(\"$P/BentoQA\")) | .key | ltrimstr(\"$P/BentoQA\")] | join(\"\")"; }
perform() { "$TOOL" perform "$1"; }
arranged() { # wait for an arrangement to finish
  sleep 0.5
  for _ in $(seq 1 80); do [ "$(state .arranging)" = false ] && return 0; sleep 0.25; done
}
opened() { grep -q "^open $1$" "$QALOG"; }
is_hidden() { [ "$(state .visibility)" = hidden ]; }
# Screenshots cover the status items only: right of the notch (or the right half).
AREA=$(swift -e 'import AppKit; let s = NSScreen.screens[0]; let x = Int(s.auxiliaryTopRightArea?.minX ?? s.frame.width * 0.5); print(x, Int(s.frame.width) - x)' 2>/dev/null)
shot() { screencapture -x -R"${AREA% *},0,${AREA#* },${2:-34}" "$OUT/$1.png"; }
check() { "$ROOT/scripts/e2e/session" check >/dev/null || { log "user came back: stopping"; exit 75; }; }

finish() {
  local code=$?
  [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "${HPID:-0}" 2>/dev/null || break; sleep 0.2; done
  [ -n "${HPID:-}" ] && kill -9 "$HPID" 2>/dev/null
  [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null
  [ -n "${QPID:-}" ] && kill "$QPID" 2>/dev/null
  sleep 1.5
  "$TOOL" order > "$OUT/after.txt"
  expect "no test items or separators left" "$(grep -cE ' (BentoQA|BentoDevMenuBar)' "$OUT/after.txt")" 0
  if diff -q "$OUT/before.txt" "$OUT/after.txt" >/dev/null; then ok "menu bar exactly as before"
  else bad "menu bar differs from before:"; diff "$OUT/before.txt" "$OUT/after.txt"; fi
  shot 99-after
  [ -n "${POINTER:-}" ] && "$TOOL" warp $POINTER
  defaults delete DevMenuBar >/dev/null 2>&1; defaults delete menubar-items >/dev/null 2>&1
  "$ROOT/scripts/e2e/session" end $WHO
  log ""; log "$PASSES passed, $FAILS failed"
  [ "$code" = 75 ] && exit 75
  [ "$FAILS" = 0 ]
  exit $?
}

"$ROOT/scripts/e2e/session" start $WHO || exit 1
trap finish EXIT
trap 'exit 130' INT TERM
"$TOOL" order > "$OUT/before.txt"
# A pointer resting on the menu bar (rightly) keeps shown items from hiding:
# park it mid-screen for the run, put it back at the end.
POINTER=$("$TOOL" pointer)
MID=$(swift -e 'import AppKit; let f = NSScreen.screens[0].frame; print(Int(f.midX), Int(f.midY))' 2>/dev/null)
park() { "$TOOL" warp $MID; }
park
shot 00-before

# ---------------------------------------------------------------- run

"$TOOL" items "$QALOG" X Y Z & QPID=$!
echo "$QPID" >> /tmp/bento-e2e-pids
sleep 1
"$HARNESS" 2>>"$OUT/harness.log" & HPID=$!
echo "$HPID" >> /tmp/bento-e2e-pids
hidden_ready() { [ "$(state '"\(.visibility) \(.controls.hiddenExpanded)"')" = "hidden true" ]; }
eventually 10 "harness started, separators in place, hidden" hidden_ready; check
for i in X Y Z; do expect "$i starts visible" "$(section $i)" visible; done
expect "no item taken for Bento's own icon" "$(state '[.items[] | select(.role == "bentoIcon")] | length')" 0
shot 01-start

log "arrange: X, Y hidden; Z always hidden"
perform menubar.profile-qa-arrange; arranged; check
expect "arranged without error" "$(state .lastError)" ""
expect "X hidden" "$(section X)" hidden
expect "Y hidden" "$(section Y)" hidden
expect "Z always hidden" "$(section Z)" alwaysHidden
expect "X off-screen while hidden" "$(onscreen X)" no
shot 02-arranged

log "show, show all, hide"
perform menubar.toggle-hidden; sleep 0.8; check
expect "shown" "$(state .visibility)" shown
expect "X on screen when shown" "$(onscreen X)" yes
expect "Z still off-screen" "$(onscreen Z)" no
shot 03-shown
perform menubar.show-all; sleep 0.8; check
expect "Z on screen with Show All" "$(onscreen Z)" yes
shot 04-shown-all
perform menubar.toggle-hidden; sleep 0.8; check
expect "hidden again" "$(state .visibility)" hidden
expect "Y off-screen again" "$(onscreen Y)" no

log "reorder two items: Y before X"
perform menubar.profile-qa-swap; arranged; check
expect "swapped without error" "$(state .lastError)" ""
expect "order Z Y X" "$(qaorder)" ZYX

log "click hidden X from its shortcut action"
: > "$QALOG"
perform menubar.click-menubar-items-bentoqax
eventually 5 "X's menu opened" opened X; check
eventually 6 "hidden again once the menu closed" is_hidden
expect "nothing left moved into view" "$(state .temporarilyShown)" 0

log "real shortcut and chevron"
"$TOOL" url "$BENTO_HOME" "bento://settings/menubar"; sleep 2; check   # activates the harness for typing
WID=$(/tmp/bentoctl windows DevMenuBar | awk '/Bento Settings/ {print $1; exit}')
[ -n "$WID" ] && screencapture -x -o -l "$WID" "$OUT/05-settings.png"
expect "⌃⌥⌘M registered" "$(jq -r '.actions[] | select(.id == "menubar.toggle-hidden") | .failed' "$BENTO_HOME/support/diagnostics.json")" false
/tmp/bentoctl key ctrl+opt+cmd+m --expect-pid "$HPID" || bad "couldn't type into the harness"
sleep 0.8; expect "⌃⌥⌘M shows the hidden items" "$(state .visibility)" shown
/tmp/bentoctl key ctrl+opt+cmd+m --expect-pid "$HPID" >/dev/null 2>&1; sleep 0.8
expect "⌃⌥⌘M hides them again" "$(state .visibility)" hidden
CHEV=$(state '.items[] | select(.role | contains("toggle")) | "\((.x + .width / 2) | floor) 16"')
if /tmp/bentoctl click $CHEV --expect-pid "$HPID" 2>"$OUT/click.err"; then
  sleep 0.8; expect "clicking the chevron shows them" "$(state .visibility)" shown
  /tmp/bentoctl click $CHEV --expect-pid "$HPID" >/dev/null 2>&1; sleep 0.8
  expect "clicking it again hides them" "$(state .visibility)" hidden
  park   # off the menu bar again, or nothing hides
else
  log "  - chevron click skipped: $(cat "$OUT/click.err")"
fi

log "Bento Bar"
: > "$QALOG"
perform menubar.bar; sleep 1.2; check
expect "bar open" "$(state .bar.open)" true
expect "bar lists the hidden items" "$(state "[.bar.items[] | select(startswith(\"$P/\")) | ltrimstr(\"$P/BentoQA\")] | join(\"\")")" YX
shot 06-bar 90
SEL=$(state '.bar.selected | ltrimstr("menubar-items/BentoQA")')
/tmp/bentoctl key return --expect-pid "$HPID" || bad "couldn't type into the harness"
eventually 5 "Return in the bar opened $SEL's menu" opened "$SEL"; check
eventually 6 "hidden again after the bar's click" is_hidden

log "search"
: > "$QALOG"
perform menubar.search; sleep 1.2; check
/tmp/bentoctl key z --expect-pid "$HPID" || bad "couldn't type into the harness"
sleep 0.6
expect "search picks Z for 'z'" "$(state .search.selected)" "$P/BentoQAZ"
SWID=$(/tmp/bentoctl windows DevMenuBar | awk '/Search Menu Bar/ {print $1; exit}')
[ -n "$SWID" ] && screencapture -x -o -l "$SWID" "$OUT/07-search.png"
/tmp/bentoctl key return --expect-pid "$HPID" || bad "couldn't type into the harness"
eventually 5 "Return in search opened Z's menu" opened Z; check
eventually 6 "hidden again after search" is_hidden
settled() { [ "$(state '"\(.temporarilyShown) \(.arranging)"')" = "0 false" ]; }
eventually 4 "nothing left moved into view" settled
expect "Z always hidden again" "$(section Z)" alwaysHidden

log "hide again after a delay"
setconf() { jq "$1" "$BENTO_HOME/config/config.json" > "$OUT/c.json" && mv "$OUT/c.json" "$BENTO_HOME/config/config.json"; sleep 1; }
setconf '.menubar.autoRehide = true | .menubar.rehideDelay = 2'
perform menubar.toggle-hidden; sleep 0.6
expect "shown" "$(state .visibility)" shown
eventually 6 "hidden again by the timer" is_hidden
setconf '.menubar.autoRehide = false'

log "show when an icon changes"
setconf ".menubar.showOnChange = [\"$P/BentoQAX\"] | .menubar.showOnChangeDuration = 3"
sleep 3   # the first look records the icon
kill -USR1 "$QPID"
is_shown() { [ "$(state .visibility)" = shown ]; }
eventually 6 "X shown after its icon changed" is_shown
eventually 8 "hidden again after the alert" is_hidden
setconf '.menubar.showOnChange = []'

log "idle CPU (20 s, hidden)"
is_hidden || perform menubar.toggle-hidden
sleep 2
T0=$(ps -o cputime= -p "$HPID" | awk -F: '{print $(NF-1)*60 + $NF}')
sleep 20
T1=$(ps -o cputime= -p "$HPID" | awk -F: '{print $(NF-1)*60 + $NF}')
CPU=$(echo "$T0 $T1" | awk '{printf "%.2f", $2 - $1}')
log "    cpu time over 20 s: ${CPU} s"
[ "$(echo "$CPU < 0.2" | bc)" = 1 ] && ok "idle CPU ~0 (${CPU} s in 20 s)" || bad "idle CPU too high: ${CPU} s in 20 s"
check

log "back to the original order"
perform menubar.profile-qa-back; arranged; check
expect "restored without error" "$(state .lastError)" ""
for i in X Y Z; do expect "$i visible" "$(section $i)" visible; done
expect "order Z Y X" "$(qaorder)" ZYX
shot 10-back

log "notch overflow (three wide items; new items start in Always Hidden)"
setbar() { jq ".menubar.bar = \"$1\"" "$BENTO_HOME/config/config.json" > "$OUT/c.json" && mv "$OUT/c.json" "$BENTO_HOME/config/config.json"; sleep 1; }
setbar whenCrowded
"$TOOL" items "$OUT/wide.log" "Overflow-test-item-one" "Overflow-test-item-two" "Overflow-test-item-three" & WPID=$!
echo "$WPID" >> /tmp/bento-e2e-pids
sleep 2; check
perform menubar.show-all; sleep 1.5; check
expect "Show All opens the Bento Bar when the items don't fit" "$(state .bar.open)" true
# Parked since they appeared, so known by their accessibility titles only.
expect "the bar lists the wide items" "$(state '[.bar.labels[] | select(startswith("Overflow-test-item"))] | length')" 3
shot 11-bar-crowded 90
perform menubar.bar; sleep 0.5
setbar never
perform menubar.show-all; sleep 1.5; check
OVER=$(state '.overflow | length')
[ "${OVER:-0}" -gt 0 ] && ok "overflow detected in the menu bar ($OVER item(s) behind the notch)" || bad "no overflow detected with a crowded menu bar"
shot 12-crowded
perform menubar.toggle-hidden; sleep 0.8
kill "$WPID" 2>/dev/null; WPID=""; sleep 1.5; check
expect "hidden at the end" "$(state .visibility)" hidden
