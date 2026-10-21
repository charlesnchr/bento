#!/bin/bash
# Tiling end-to-end regression on the real, full app (every module, Windows included).
#   scripts/e2e/tiling.sh [phase ...]     phases: commands live windows edge toggle (default: all)
# Each phase runs in its own short GUI session (scripts/e2e/session). Tiling is limited
# to TextEdit (`tiling.onlyApps`) and, through BENTO_TILING_TITLE_FILTER (dev builds
# only), to the documents this script opens: /tmp/tiling-qa-*.txt. Other TextEdit
# documents are never tiled, moved or closed. Exit 0 = passed, 1 = failed,
# 75 = the user came back (retry later).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WHO=tiling
BH=/tmp/bento-e2e-tiling
CTL=/tmp/tiling-ctl
BCTL=/tmp/bentoctl
TE=com.apple.TextEdit
PHASES=("$@")
[ ${#PHASES[@]} -eq 0 ] && PHASES=(commands live windows edge toggle)

FAILS=0
PID=
EXTRA_PID=
IN_SESSION=0
START_TS=$(date +%s)

log() { echo "[tiling-e2e] $*"; }
fail() { log "FAIL: $*"; FAILS=$((FAILS + 1)); dump; }
ok() { log "ok: $*"; }
dump() { [ -n "$PID" ] && { "$ROOT/scripts/perform" tiling.debug-dump >/dev/null 2>&1; sleep 0.4; sed 's/^/    /' "$BH/support/tiling/state.txt" 2>/dev/null; $CTL frames | sed 's/^/    frame /'; }; }

guard_check() {
  if ! "$ROOT/scripts/e2e/session" check >/dev/null; then
    log "user is active, stopping"; cleanup; exit 75
  fi
}
alive() { kill -0 "$PID" 2>/dev/null || { log "FAIL: Bento (pid $PID) died"; FAILS=$((FAILS + 1)); cleanup; exit 1; }; }

key() { # key <combo> [sleep]
  guard_check
  if [ "$($BCTL frontmost)" != "$TE" ]; then $CTL focus "tiling-qa" ; fi
  $BCTL key "$1" --expect $TE >/dev/null || { local rc=$?; [ $rc -eq 75 ] && { cleanup; exit 75; }; fail "key $1 (rc $rc)"; }
  sleep "${2:-0.6}"
}
focus() { guard_check; $CTL focus "$1"; sleep 0.3; }
frame() { $CTL frames | awk -v t="$1" 'index($1, t) == 1 { print $2, $3, $4, $5; exit }'; }
check() { $CTL settle 3 >/dev/null; $CTL check "$@" >/dev/null 2>/tmp/tiling-e2e-check || { fail "check $* -> $(cat /tmp/tiling-e2e-check)"; return 1; }; }
near() { # near "x y w h" "x y w h" [tolerance]: frames equal within a few points (apps round sizes)
  python3 -I -c 'import sys; a, b, t = sys.argv[1].split(), sys.argv[2].split(), float(sys.argv[3]); sys.exit(0 if len(a) == len(b) == 4 and all(abs(float(x) - float(y)) <= t for x, y in zip(a, b)) else 1)' "$1" "$2" "${3:-2}"
}
cpu_seconds() { ps -o time= -p "$1" | awk -F'[:.]' '{ print $1 * 60 + $2 + $3 / 100 }'; }

open_docs() { # open_docs <first> <last> [extra-instance]
  local files=()
  for i in $(seq "$1" "$2"); do
    local f="/tmp/tiling-qa-$i.txt"
    [ -f "$f" ] || echo "Bento tiling QA document $i" > "$f"
    files+=("$f")
  done
  if [ "${3:-}" = extra ]; then
    open -n -g -a TextEdit "${files[@]}" --args -ApplePersistenceIgnoreState YES
  else
    open -g -a TextEdit "${files[@]}"
  fi
}

set_config() { # set_config <python expression on d>
  python3 -I - "$BH/config/config.json" "$1" <<'EOF'
import json, sys
p, expr = sys.argv[1], sys.argv[2]
try: d = json.load(open(p))
except Exception: d = {}
exec(expr)
json.dump(d, open(p + ".tmp", "w"), indent=2)
import os; os.replace(p + ".tmp", p)
EOF
}

start_bento() {
  rm -rf "$BH"; mkdir -p "$BH/config"
  set_config 'd["general"] = {"enabledModules": {"tiling": True, "windows": True}, "showMenuBarIcon": True}
d["tiling"] = {"managerOn": False, "onlyApps": ["com.apple.TextEdit"]}
d["notes"] = {"sync": {"enabled": False, "server": "http://127.0.0.1:9", "tokenFile": "'"$BH"'/no-token"}}'
  BENTO_HOME=$BH BENTO_DEV=1 BENTO_TILING_TITLE_FILTER=tiling-qa "$ROOT/.build/debug/Bento" >"$BH.log" 2>&1 &
  PID=$!
  sleep 2.5
  alive
}

begin() { # begin <phase>
  log "== phase $1: waiting for an idle user"
  "$ROOT/scripts/e2e/session" start $WHO || exit 1
  IN_SESSION=1
  start_bento
}

close_docs() {
  osascript -e 'tell application "TextEdit" to close (every document whose name starts with "tiling-qa") saving no' >/dev/null 2>&1
  [ -n "$EXTRA_PID" ] && { $CTL quit "$EXTRA_PID" >/dev/null 2>&1; EXTRA_PID=; }
}

cleanup() {
  close_docs
  [ -n "$PID" ] && { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=; }
  if [ "$TE_WAS_RUNNING" = 0 ] && [ -z "$($CTL foreign)" ]; then
    osascript -e 'tell application "TextEdit" to quit saving no' >/dev/null 2>&1
  fi
  [ $IN_SESSION = 1 ] && { "$ROOT/scripts/e2e/session" end $WHO; IN_SESSION=0; }
}

finish() { # finish <phase>
  alive
  cleanup
  log "== phase $1 done"
}

trap 'cleanup; exit 130' INT TERM

# ---------------------------------------------------------------- phases

phase_commands() {
  begin commands
  open_docs 1 3
  $CTL wait 3 8 || fail "documents did not open"
  focus tiling-qa-1
  key ctrl+opt+cmd+t 1.2
  check 3 && ok "toggle on tiles 3 windows"
  focus tiling-qa-2
  open_docs 4 4
  $CTL wait 4 6 >/dev/null; check 4 && ok "new window joins the layout"

  # Focus: the focused window changes, nothing moves.
  local before; before=$($CTL frames)
  focus tiling-qa-1
  local start; start=$($CTL focused)
  key ctrl+opt+cmd+l; local f1; f1=$($CTL focused)
  [ "$f1" != "$start" ] && [ "$f1" != "-" ] && ok "focus right: $start -> $f1" || fail "focus right did not change focus ($start -> $f1)"
  key ctrl+opt+cmd+h; [ "$($CTL focused)" = "$start" ] && ok "focus left returns" || fail "focus left: $($CTL focused)"
  [ "$before" = "$($CTL frames)" ] || fail "focus moved windows"

  # Move (swap with the neighbour on the right).
  focus tiling-qa-1
  local a1 b1; a1=$(frame tiling-qa-1)
  key hyper+l 0.8
  b1=$(frame tiling-qa-1)
  [ "$a1" != "$b1" ] && check 4 && ok "move right swaps ($a1 -> $b1)" || fail "move right ($a1 -> $b1)"
  key hyper+h 0.8
  [ "$(frame tiling-qa-1)" = "$a1" ] && ok "move left swaps back" || fail "move left: $(frame tiling-qa-1) vs $a1"

  # Resize, balance.
  local w0 w1 w2; w0=$(frame tiling-qa-1 | awk '{print $3}')
  key ctrl+opt+cmd+equal; w1=$(frame tiling-qa-1 | awk '{print $3}')
  [ "$w1" -gt "$w0" ] && check 4 && ok "grow $w0 -> $w1" || fail "grow $w0 -> $w1"
  key ctrl+opt+cmd+minus; key ctrl+opt+cmd+minus; w2=$(frame tiling-qa-1 | awk '{print $3}')
  [ "$w2" -lt "$w0" ] && ok "shrink -> $w2" || fail "shrink $w0 -> $w2"
  key ctrl+opt+cmd+b; check 4 && ok "balance"

  # Layout cycle: tiles -> master-stack -> columns -> rows -> monocle -> tiles.
  read -r ax ay aw ah <<<"$($CTL area)"
  local AX=$((ax + 8)) AY=$((ay + 8)) AW=$((aw - 16)) AH=$((ah - 16))
  key ctrl+opt+cmd+space 0.9; check 4 && ok "master-stack tiles"
  [ "$($CTL frames | awk -v x=$AX -v h=$AH '$2 == x && $5 == h' | wc -l | tr -d ' ')" = 1 ] && ok "master-stack has one full-height master" || fail "master-stack geometry"
  key ctrl+opt+cmd+space 0.9; check 4 && ok "columns tile"
  [ "$($CTL frames | awk -v h=$AH '$5 == h' | wc -l | tr -d ' ')" = 4 ] && ok "columns are full height" || fail "columns geometry"
  key ctrl+opt+cmd+space 0.9; check 4 --loose
  [ "$($CTL frames | awk -v w=$AW '$4 == w' | wc -l | tr -d ' ')" = 4 ] && ok "rows are full width" || fail "rows geometry"
  key ctrl+opt+cmd+space 0.9
  [ "$($CTL frames | awk -v x=$AX -v y=$AY -v w=$AW -v h=$AH '$2 == x && $3 == y && $4 == w && $5 == h' | wc -l | tr -d ' ')" = 4 ] && ok "monocle fills the area" || fail "monocle geometry"
  key ctrl+opt+cmd+l; ok "monocle focus cycles to $($CTL focused)"
  key ctrl+opt+cmd+space 0.9; check 4 && ok "back to tiles"

  # Split direction, promote.
  focus tiling-qa-2
  local s0; s0=$($CTL frames)
  key ctrl+opt+cmd+e 0.8; check 4 && [ "$s0" != "$($CTL frames)" ] && ok "toggle split" || fail "toggle split changed nothing"
  key ctrl+opt+cmd+e 0.8
  focus tiling-qa-3
  key ctrl+opt+cmd+return 0.8; check 4 && ok "promote"

  # Float and unfloat.
  focus tiling-qa-4
  key ctrl+opt+cmd+f 1
  check 3 --except tiling-qa-4 && ok "float: the other 3 retile"
  sleep 1; local fl; fl=$(frame tiling-qa-4)
  key ctrl+opt+cmd+f 1; check 4 && ok "unfloat: 4 tiled again (floated at $fl)"

  # Next display (single display: nothing moves), retile.
  local n0; n0=$($CTL frames)
  key ctrl+opt+cmd+n; [ "$n0" = "$($CTL frames)" ] && ok "next display is a no-op on one display" || fail "next display moved windows"
  key ctrl+opt+cmd+r 1; check 4 && ok "retile"
  finish commands
}

phase_live() {
  begin live
  open_docs 1 3
  $CTL wait 3 8 || fail "documents did not open"
  focus tiling-qa-1
  key ctrl+opt+cmd+t 1.2
  check 3 && ok "on"

  # Rapid open/close.
  open_docs 4 6
  $CTL wait 6 6 >/dev/null || true
  { $CTL close tiling-qa-5; sleep 0.1; $CTL close tiling-qa-2; open_docs 5 5; sleep 0.1; $CTL close tiling-qa-6
    $CTL wait 4 6 >/dev/null || true; sleep 0.3; $CTL close tiling-qa-5; } 2>/dev/null
  $CTL wait 4 6 >/dev/null; check 4 && ok "rapid open/close settles with 4 tiled"

  # Minimize / unminimize.
  $CTL minimize tiling-qa-4 1; sleep 1.2; check 3 && ok "minimized window leaves the layout"
  $CTL minimize tiling-qa-4 0; sleep 1.2; check 4 && ok "unminimized window rejoins"

  # A user resize (drag the right edge) moves the split.
  focus tiling-qa-1
  read -r x y w h <<<"$(frame tiling-qa-1)"
  local ex=$((x + w - 1)) ey=$((y + h / 2))
  guard_check
  $BCTL drag $ex $ey $((ex + 120)) $ey --expect $TE >/dev/null || fail "resize drag refused"
  sleep 1; check 4 && ok "user resize keeps the tiling"
  local nw; nw=$(frame tiling-qa-1 | awk '{print $3}')
  [ "$nw" -gt $((w + 60)) ] && ok "user resize updated the ratio ($w -> $nw)" || fail "user resize not kept ($w -> $nw)"

  # A user move onto another window swaps them; dropped elsewhere it snaps back.
  read -r x y w h <<<"$(frame tiling-qa-1)"
  local t1 t3; t1="$x $y $w $h"; t3=$(frame tiling-qa-3)
  read -r x3 y3 w3 h3 <<<"$t3"
  guard_check
  $BCTL drag $((x + w * 3 / 4)) $((y + 12)) $((x3 + w3 / 2)) $((y3 + h3 / 2)) --expect $TE >/dev/null || fail "move drag refused"
  sleep 1.2
  [ "$(frame tiling-qa-1)" = "$t3" ] && [ "$(frame tiling-qa-3)" = "$t1" ] && ok "drop onto a window swaps" || fail "drop swap: 1=$(frame tiling-qa-1) 3=$(frame tiling-qa-3)"
  read -r x y w h <<<"$(frame tiling-qa-1)"
  local home="$x $y $w $h"
  guard_check
  $BCTL drag $((x + w * 3 / 4)) $((y + 12)) $((x + w * 3 / 4 + 40)) $((y + 52)) --expect $TE >/dev/null
  sleep 1.2
  [ "$(frame tiling-qa-1)" = "$home" ] && ok "small drag snaps back" || fail "snap back: $(frame tiling-qa-1) vs $home"

  # An app quitting while tiled (a separate TextEdit process with only our documents).
  local before; before=$($CTL pids)
  open_docs 7 8 extra
  sleep 2.5
  for p in $($CTL pids); do [[ " $before " == *" $p "* ]] || EXTRA_PID=$p; done
  if [ -n "$EXTRA_PID" ]; then
    $CTL wait 6 6 >/dev/null; check 6 && ok "second TextEdit process tiled (6 windows)"
    $CTL hide "$EXTRA_PID" 1; sleep 1.2; check 4 && ok "hidden app leaves the layout"
    $CTL hide "$EXTRA_PID" 0; sleep 1.5; check 6 && ok "unhidden app rejoins"
    $CTL quit "$EXTRA_PID"; EXTRA_PID=; sleep 1.5; check 4 && ok "quitting app: the rest retile"
  else
    fail "no second TextEdit process"
  fi
  finish live
}

phase_windows() {
  begin windows
  open_docs 1 4
  $CTL wait 4 8 || fail "documents did not open"
  focus tiling-qa-1
  key ctrl+opt+cmd+t 1.2
  check 4 && ok "on"

  # Rectangle-style keyboard command floats the window; the rest retile; no fight.
  focus tiling-qa-2
  key ctrl+opt+left 1.5
  read -r ax ay aw ah <<<"$($CTL area)"
  local f2; f2=$(frame tiling-qa-2)
  near "$f2" "$ax $ay $((aw / 2)) $ah" && ok "left half applied ($f2)" || fail "left half not kept: $f2"
  check 3 --except tiling-qa-2 && ok "others retile around the placed window"
  sleep 1; [ "$(frame tiling-qa-2)" = "$f2" ] && ok "placed window is not snapped back" || fail "placed window moved: $(frame tiling-qa-2)"
  key ctrl+opt+cmd+f 1; check 4 && ok "toggle float re-tiles it"

  # Modifier-drag (cmd+opt) on a tiled window: no fight while the mouse rests
  # mid-drag, and the window floats where it was dropped.
  read -r x y w h <<<"$(frame tiling-qa-3)"
  local cx=$((x + w / 2)) cy=$((y + h / 2))
  guard_check
  $BCTL down $cx $cy cmd+opt --expect $TE >/dev/null || fail "cmd+opt drag refused"
  $BCTL move $((cx - 150)) $((cy + 60)) cmd+opt >/dev/null
  sleep 0.8
  local mid; mid=$(frame tiling-qa-3)
  $BCTL up $((cx - 150)) $((cy + 60)) cmd+opt >/dev/null
  near "$mid" "$((x - 150)) $((y + 60)) $w $h" && ok "no snap back while the drag rests" || fail "modifier-drag fought mid-drag: $mid"
  sleep 1.2
  local f3; f3=$(frame tiling-qa-3)
  near "$f3" "$((x - 150)) $((y + 60)) $w $h" && ok "modifier-drag kept ($f3)" || fail "modifier-drag not kept: $f3 (from $x $y $w $h)"
  check 3 --except tiling-qa-3 && ok "others retile after the modifier-drag"
  sleep 1; [ "$(frame tiling-qa-3)" = "$f3" ] && ok "dragged window stays" || fail "dragged window moved: $(frame tiling-qa-3)"
  focus tiling-qa-3; key ctrl+opt+cmd+f 1; check 4 && ok "re-tiled"

  # Title-bar drag into the left snap area: Windows snaps it, tiling floats it.
  read -r x y w h <<<"$(frame tiling-qa-4)"
  guard_check
  $BCTL drag $((x + w * 3 / 4)) $((y + 12)) 2 400 --expect $TE >/dev/null || fail "snap drag refused"
  sleep 1.5
  local f4; f4=$(frame tiling-qa-4)
  near "$f4" "$ax $ay $((aw / 2)) $ah" && ok "snap to left half kept ($f4)" || fail "snap: $f4"
  check 3 --except tiling-qa-4 && ok "others retile after the snap"
  finish windows
}

phase_edge() {
  begin edge
  open_docs 1 8
  $CTL wait 8 10 || fail "documents did not open"
  focus tiling-qa-1
  key ctrl+opt+cmd+t 1.5
  check 8 --loose && ok "8 windows tiled (loose)"
  check 8 && ok "8 windows tile without overlap"
  key ctrl+opt+cmd+space 1; key ctrl+opt+cmd+space 1; key ctrl+opt+cmd+space 1.2
  check 8 --loose && ok "8 rows (minimum heights) do not break anything"
  local r1; r1=$($CTL frames); sleep 1.5
  [ "$r1" = "$($CTL frames)" ] && ok "no fight with minimum sizes" || fail "windows keep moving in rows"
  key ctrl+opt+cmd+space 1; key ctrl+opt+cmd+space 1
  check 8 && ok "back to tiles"
  for i in 8 7 6 5; do $CTL close tiling-qa-$i; done
  $CTL wait 4 6 >/dev/null; check 4 && ok "closing 4 windows retiles"

  # Save As sheet on a tiled window: nothing moves, the sheet is left alone.
  focus tiling-qa-2
  local s0; s0=$($CTL frames)
  key cmd+opt+shift+s 1.5
  [ "$s0" = "$($CTL frames)" ] && ok "Save As sheet leaves the layout alone" || fail "sheet moved windows"
  $BCTL key escape --expect $TE >/dev/null; sleep 0.8

  # Native full screen: leaves the layout, comes back on exit.
  $CTL fullscreen tiling-qa-3 1; sleep 3
  alive
  $CTL fullscreen tiling-qa-3 0; sleep 3
  check 4 && ok "full screen round trip retiles"
  finish edge
}

phase_toggle() {
  begin toggle
  open_docs 1 3
  $CTL wait 3 8 || fail "documents did not open"
  focus tiling-qa-1
  key ctrl+opt+cmd+t 1.2
  check 3 && ok "on"
  # Idle CPU while on.
  local c0 c1; c0=$(cpu_seconds $PID); sleep 8; c1=$(cpu_seconds $PID)
  python3 -I -c "import sys; sys.exit(0 if $c1 - $c0 < 0.15 else 1)" && ok "idle CPU while on: $(python3 -I -c "print(round($c1 - $c0, 2))") s in 8 s" || fail "idle CPU while on: $c0 -> $c1"

  # Off: nothing moves, nothing observes.
  key ctrl+opt+cmd+t 1
  $BCTL setframe $TE tiling-qa-1 200 200 500 400; sleep 1.2
  [ "$(frame tiling-qa-1)" = "200 200 500 400" ] && ok "off: moved window stays put" || fail "off: window moved to $(frame tiling-qa-1)"
  "$ROOT/scripts/perform" tiling.debug-dump; sleep 0.4
  grep -q "live app observers: 0" "$BH/support/tiling/state.txt" && ok "off: no AX observers alive" || fail "off: $(cat $BH/support/tiling/state.txt)"

  # Rapid toggling while windows move.
  for i in 1 2 3 4 5 6; do
    key ctrl+opt+cmd+t 0.15
    $BCTL setframe $TE tiling-qa-2 $((100 + i * 20)) 300 400 300
  done
  sleep 1.5; alive
  "$ROOT/scripts/perform" tiling.debug-dump; sleep 0.4
  grep -q "live app observers: 0" "$BH/support/tiling/state.txt" && ok "rapid toggling ends off with no observers" || fail "after toggling: $(head -3 $BH/support/tiling/state.txt)"
  local c2 c3; c2=$(cpu_seconds $PID); sleep 4; c3=$(cpu_seconds $PID)
  python3 -I -c "import sys; sys.exit(0 if $c3 - $c2 < 0.1 else 1)" && ok "idle CPU while off" || fail "idle CPU while off: $c2 -> $c3"
  key ctrl+opt+cmd+t 1.2; check 3 && ok "on again after rapid toggling"

  # Disable / enable the module while the manager is on.
  set_config 'd["general"]["enabledModules"]["tiling"] = False'; sleep 1.2; alive
  $BCTL setframe $TE tiling-qa-1 150 150 500 400; sleep 1.2
  [ "$(frame tiling-qa-1)" = "150 150 500 400" ] && ok "module disabled: nothing tiles" || fail "module disabled but window moved: $(frame tiling-qa-1)"
  set_config 'd["general"]["enabledModules"]["tiling"] = True'; sleep 1.8; alive
  check 3 && ok "module re-enabled: manager resumes"
  finish toggle
}

# ---------------------------------------------------------------- main

TE_WAS_RUNNING=0
pgrep -xq TextEdit && TE_WAS_RUNNING=1
touch /tmp/tiling-e2e-start
# Per-display layouts persist in the user defaults of the raw binary ("Bento" domain).
defaults delete Bento BentoTilingDisplayLayouts >/dev/null 2>&1
log "building"
(cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|warning: unre|Compiling|Build complete" | tail -3) || exit 1
[ $CTL -nt "$ROOT/scripts/e2e/tiling-ctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/tiling-ctl.swift" -o $CTL || exit 1
for p in "${PHASES[@]}"; do
  "phase_$p"
done
log "done: $FAILS failure(s) in $(( $(date +%s) - START_TS )) s"
rm -rf "$BH" /tmp/tiling-qa-*.txt
CRASH=$(find ~/Library/Logs/DiagnosticReports -name 'Bento*' -newer /tmp/tiling-e2e-start 2>/dev/null | head -1)
[ -n "$CRASH" ] && { log "FAIL: crash report $CRASH"; FAILS=$((FAILS + 1)); }
[ $FAILS -eq 0 ]
