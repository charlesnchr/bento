#!/bin/bash
# ShotEditor end-to-end regression (docs/QA.md). Builds and runs the real debug
# app (all modules) under its own BENTO_HOME, drives it with real input inside
# GUI sessions (one per phase) and asserts on its files, windows, memory and
# the pasteboard.
#
#   scripts/e2e/editor.sh [phase...]     default: capture history big tiny leak
#   BENTO_BIN=/other/build/Bento scripts/e2e/editor.sh big    compare another build
#
# capture  ⌘⇧2 capture of a TextEdit doc, OCR, every tool by key + mouse, select /
#          move / restyle / delete, undo/redo with crop, zoom, Esc copy-and-close
#          (PNG + lazy TIFF, point size), reopen last, ⌘S, ⇧⌘S, ⌘P pins (opacity,
#          scale, double-click to edit), closing mid text edit, ⌘Q then relaunch
# history  220 captures plus damaged ones, Quick Look, delete, open, retention
#          pruning, reopen last when the newest original is missing
# big      15 000 px and 40 000 px tall captures: memory, zoom extremes, copy
# tiny     1×1 px capture: zoom, copy, pin
# leak     20 editors opened and closed: memory back near baseline, no editors left
#
# Exits non-zero when a check fails. The user's clipboard is saved and restored;
# test captures moved to the Trash by the delete test are removed from it.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WHO=editor
H=/tmp/bento-e2e-editor
CTL=/tmp/editor-ctl
BCTL=/tmp/bentoctl
QA=/tmp/editor-qa.rtfd
FIX=/tmp/editor-e2e-fixtures
CAPS="$H/support/Captures"
FAILFILE=/tmp/editor-e2e-fails
PB_SAVE=/tmp/editor-e2e-clipboard.plist
BENTO_PID=""
BIN="${BENTO_BIN:-$ROOT/.build/debug/Bento}"

log() { echo "[editor-e2e $(date +%H:%M:%S)] $*"; }
fail() { log "FAIL $*"; echo "$*" >> "$FAILFILE"; }
ok() { log "ok   $*"; }
# check "description" command...  (records a failure instead of aborting)
check() { local d="$1"; shift; if "$@"; then ok "$d"; else fail "$d"; fi; }
expect_eq() { if [ "$3" = "$2" ]; then ok "$1"; else fail "$1 (want '$2', got '$3')"; fi; }

# Input goes through editor-ctl (pid-targeted, refuses while the user is active):
# the whole phase stops with 75 the moment the user touches anything.
owns_lock() { [ "$(cat /tmp/bento-gui.lock/owner 2>/dev/null)" = "$WHO" ]; }
ctl() {
  # Another session may have broken the lock (gui-lock's stale-lock race): never
  # keep driving the screen without it.
  owns_lock || { log "GUI lock is not ours any more; stopping this phase"; exit 75; }
  "$CTL" "$@"; local rc=$?
  [ $rc -eq 75 ] && { log "user is active; stopping this phase"; exit 75; }
  return $rc
}
key() { ctl key "$BENTO_PID" "$@"; sleep 0.25; }
perform() { "$ROOT/scripts/perform" "$1" >/dev/null 2>&1; sleep "${2:-0.8}"; }
alive() { kill -0 "$BENTO_PID" 2>/dev/null; }
footprint() { "$CTL" footprint "$BENTO_PID"; }
now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "import time; print(round(time.time() - $1, 2))"; }
lt() { python3 -c "import sys; sys.exit(0 if $1 < $2 else 1)"; }

build() {
  log "building"
  (cd "$ROOT" && swift build --product Bento 2>&1 | tail -1) || exit 1
  [ "$CTL" -nt "$ROOT/scripts/e2e/editor-ctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/editor-ctl.swift" -o "$CTL" || exit 1
  mkdir -p "$FIX"
  [ -f "$FIX/big.png" ] || "$CTL" mkimage "$FIX/big.png" 2880 15000 2
  [ -f "$FIX/huge.png" ] || "$CTL" mkimage "$FIX/huge.png" 2880 40000 2
  [ -f "$FIX/mid.png" ] || "$CTL" mkimage "$FIX/mid.png" 1200 800 2
  [ -f "$FIX/tiny.png" ] || "$CTL" mkimage "$FIX/tiny.png" 1 1 2
}

write_config() {
  local clipboard="${1:-false}"
  mkdir -p "$H/config" "$H/saves"
  # Only the modules this test needs; Notes must never sync a test instance.
  cat > "$H/config/config.json" <<EOF
{
  "general": { "enabledModules": { "notes": false, "windows": false, "tiling": false, "launcher": false, "clipboard": $clipboard, "shot": true } },
  "notes": { "sync": { "enabled": false, "server": "http://127.0.0.1:9", "tokenFile": "/nonexistent" } },
  "shot": { "saveFolder": "$H/saves", "playSound": false, "afterCapture": "editor" },
  "editor": { "escAction": "copy", "historyRetentionDays": 30, "defaultTool": "select", "closeAfterSave": false }
}
EOF
  # Tool size/style memory of the raw binary (its defaults domain is "Bento", not the installed app's).
  defaults delete Bento ShotEditor.toolStyles >/dev/null 2>&1
  defaults delete Bento ShotEditor.toolSizes >/dev/null 2>&1
}

launch() {
  BENTO_HOME="$H" BENTO_DEV=1 "$BIN" >> "$H/bento.log" 2>&1 &
  BENTO_PID=$!
  sleep 2.5
  alive || { fail "Bento did not start"; exit 1; }
  log "Bento pid $BENTO_PID, footprint $(footprint) MB"
}

# AppleScript to TextEdit with a hard time limit: a TextEdit stuck in a modal
# alert must not hang the session (and the GUI lock) for minutes.
te() { timeout 8 osascript -e 'with timeout of 5 seconds' -e "tell application \"TextEdit\" to $1" -e 'end timeout' 2>/dev/null; }

open_textedit() {
  # Never rewrite the file under an open document ("changed by another
  # application" alerts): close leftovers first.
  close_textedit
  # RTFD, so an image dropped on it becomes an attachment without a
  # "convert to RTFD?" alert (drag-out check).
  rm -rf "$QA"
  printf 'Bento editor QA\nThe quick brown fox jumps over the lazy dog\n0001  first cell    second cell\nLine four ends here\n' \
    | textutil -stdin -convert rtfd -font Menlo -fontsize 14 -output "$QA"
  open -a TextEdit "$QA"; sleep 1.2
  "$BCTL" setframe com.apple.TextEdit editor-qa 200 150 700 420 >/dev/null 2>&1
  "$BCTL" front com.apple.TextEdit editor-qa >/dev/null
}

close_textedit() {
  pgrep -x TextEdit >/dev/null || return 0
  # (TextEdit reports /private/tmp paths; match by name.)
  te 'close (every document whose name starts with "editor-qa.") saving no' >/dev/null
  te 'close (every document whose path contains "BentoDrag") saving no' >/dev/null
}

# Newest capture folder and Python expressions on its document (`d`).
newest() { ls -1d "$CAPS"/*/ 2>/dev/null | sort | tail -1; }
doc() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$(newest)document.json" "$1"; }
kinds() { doc '",".join(a["kind"] for a in d["annotations"])'; }
count() { doc 'len(d["annotations"])'; }

# Editor window geometry (CG points): WID WX WY WW WH.
# Moves it off anything covering it (e.g. a system alert) so no click lands on another app.
editor_frame() {
  ctl wait-window "$BENTO_PID" "${1:-Screenshot}" "${2:-8}" >/dev/null || return 1
  local f; f=$(ctl unblock "$BENTO_PID" "${1:-Screenshot}") || return 1
  read -r WID WX WY WW WH <<< "$f"
}
# Pin geometry (PX PY PW PH) and an uncovered point on it (QX QY).
pin_frame() {
  local pin; pin=$(ctl windows "$BENTO_PID" | awk '$2 == 3' | head -1)
  [ -n "$pin" ] || return 1
  read -r _ _ _ PX PY PW PH _ <<< "$pin"
  read -r QX QY <<< "$(ctl spot "$BENTO_PID" "$PX" "$PY" "$PW" "$PH")"
  [ -n "$QX" ]
}
# Status bar texts: canvas size ("610 × 290 ..."), zoom ("100%").
status_size() { ctl texts "$BENTO_PID" Screenshot | grep -m1 -E '^(Selection )?[0-9]+ × [0-9]+' | sed 's/^Selection //' | awk '{print $1, $3}'; }
zoom_label() { ctl texts "$BENTO_PID" Screenshot | grep -m1 -E '^[0-9]+%$'; }
# Canvas origin on screen at the current zoom (canvas centred under the 40 pt
# toolbar, above the 26 pt status bar). Sets CX CY (centre) and OX OY.
canvas_geometry() {
  local z w h; read -r w h <<< "$(status_size)"; z=$(zoom_label | tr -d '%')
  CX=$((WX + WW / 2)); CY=$((WY + 40 + (WH - 40 - 26) / 2))
  OX=$(python3 -c "print(int($CX - $w * $z / 200))"); OY=$(python3 -c "print(int($CY - $h * $z / 200))")
}
# Screen point of an image point at 100%: at X Y -> SX SY
at() { SX=$((OX + $1)); SY=$((OY + $2)); }
draw() { # draw <tool-key> x1 y1 x2 y2 (image points, 100%)
  key "$1"; at "$2" "$3"; local a=$SX b=$SY; at "$4" "$5"; ctl drag "$BENTO_PID" $a $b $SX $SY; sleep 0.15
}
autosaved() { sleep 2.6; }

pb_save() { "$CTL" pb-save "$PB_SAVE" 2>/dev/null; }
pb_restore() { [ -f "$PB_SAVE" ] && "$CTL" pb-restore "$PB_SAVE" 2>/dev/null; rm -f "$PB_SAVE"; }

# MARK: - Phases

phase_capture() {
  open_textedit
  # A real ⌘⇧2 into Bento's global hotkey (TextEdit is frontmost, so a missed
  # hotkey can only reach my own document), then a real drag on the frozen screen.
  owns_lock || exit 75
  "$BCTL" key cmd+shift+2 --expect com.apple.TextEdit >/dev/null; local rc=$?
  [ $rc -eq 75 ] && exit 75
  [ $rc -ne 0 ] && { fail "⌘⇧2 not posted"; return; }
  sleep 1.2
  ctl drag "$BENTO_PID" 210 180 820 470
  editor_frame || { fail "⌘⇧2 + drag did not open the editor"; return; }
  ok "⌘⇧2 capture opened the editor"
  local dir; dir=$(newest)
  check "capture stored in history" test -f "${dir}document.json"
  sleep 0.5; check "original PNG written" test -f "${dir}original.png"
  expect_eq "capture size" "610 290" "$(status_size)"
  canvas_geometry

  # OCR first, while the text is unobstructed: lines in order, table cells on one line.
  key cmd+shift+t; sleep 3
  local text; text=$("$CTL" pb-string)
  log "OCR text: $(echo "$text" | tr '\n' '|')"
  check "OCR finds the text" grep -qi "quick brown fox" <<< "$text"
  # (The capture's left edge may clip the first digit of "0001".)
  check "OCR keeps table cells on one line" grep -qiE "01 +first cell +second cell" <<< "$text"

  # Every tool by its key, drawn with the mouse.
  draw a 40 40 160 90; draw r 200 40 300 100; draw o 320 40 400 100; draw l 420 40 520 90
  draw d 40 120 140 160; draw h 160 130 300 130; draw b 320 120 400 170; draw e 420 120 500 170
  draw s 40 190 140 260; draw m 200 210 230 210; draw u 300 200 400 200
  key c; at 450 220; ctl click "$BENTO_PID" $SX $SY; at 500 220; ctl click "$BENTO_PID" $SX $SY
  key t; at 520 260; ctl click "$BENTO_PID" $SX $SY; sleep 0.2; ctl type "$BENTO_PID" "Hello QA"; key escape
  autosaved
  expect_eq "every tool created its annotation" \
    "arrow,rect,oval,line,freehand,highlight,blur,erase,spotlight,magnifier,ruler,counter,counter,text" "$(kinds)"
  expect_eq "text annotation content" "Hello QA" "$(doc 'd["annotations"][-1]["text"]')"
  expect_eq "counters numbered" "1,2" "$(doc '",".join(str(a["number"]) for a in d["annotations"] if a["kind"]=="counter")')"
  check "editor still alive after all tools" alive

  # Select the rectangle (click its edge away from the handles), restyle it by
  # pressing its tool key again, move it, delete it, undo/redo.
  local rx='[a["p1"][0] for a in d["annotations"] if a["kind"]=="rect"][0]' x0
  x0=$(doc "$rx")
  key v; at 225 40; ctl click "$BENTO_PID" $SX $SY
  key r; key r
  at 225 40; local a=$SX b=$SY; at 245 60; ctl drag "$BENTO_PID" $a $b $SX $SY
  autosaved
  expect_eq "R again restyles the selected rectangle" "1" "$(doc '[a["style"] for a in d["annotations"] if a["kind"]=="rect"][0]')"
  expect_eq "rectangle moved by 20 pt" "20.0" "$(python3 -c "print(float($(doc "$rx") - $x0))")"
  key delete; autosaved
  expect_eq "⌫ deletes the selection" "13" "$(count)"
  key cmd+z; key cmd+z; autosaved
  expect_eq "⌘Z twice: back and unmoved" "14 0.0" "$(count) $(python3 -c "print(float($(doc "$rx") - $x0))")"
  key cmd+shift+z; autosaved
  expect_eq "⇧⌘Z redoes the move" "20.0" "$(python3 -c "print(float($(doc "$rx") - $x0))")"

  # Crop with annotations, undo/redo across it.
  key v; at 20 20; a=$SX; b=$SY; at 580 280; ctl drag "$BENTO_PID" $a $b $SX $SY; key return; autosaved
  expect_eq "↩ crops to the selection" "[560.0, 260.0]" "$(doc '[float(v) for v in d["crop"][1]]')"
  key cmd+z; autosaved; expect_eq "⌘Z removes the crop" "None" "$(doc 'd.get("crop")')"
  key cmd+shift+z; autosaved; expect_eq "⇧⌘Z restores the crop" "[560.0, 260.0]" "$(doc '[float(v) for v in d["crop"][1]]')"
  # Undo crop and move, then a new edit: nothing left to redo.
  key cmd+z; key cmd+z; draw o 540 120 600 170; key cmd+shift+z; autosaved
  expect_eq "a new edit clears redo" "None 15" "$(doc 'd.get("crop")') $(count)"
  key cmd+0; canvas_geometry
  key v; at 20 20; a=$SX; b=$SY; at 580 280; ctl drag "$BENTO_PID" $a $b $SX $SY; key return

  # Zoom: in to the maximum, out to the minimum, fit, 100%.
  for _ in $(seq 1 25); do ctl key "$BENTO_PID" cmd+equal; done; sleep 0.3
  expect_eq "⌘+ stops at 3200%" "3200%" "$(zoom_label)"
  for _ in $(seq 1 40); do ctl key "$BENTO_PID" cmd+minus; done; sleep 0.3
  expect_eq "⌘− stops at 5%" "5%" "$(zoom_label)"
  key cmd+0; expect_eq "⌘0 is 100%" "100%" "$(zoom_label)"
  key cmd+1
  local fit; fit=$(python3 -c "print(round(min($WW / 560, ($WH - 66) / 260) * 98))")
  check "⌘1 fits the canvas (~$fit%)" lt "$(python3 -c "print(abs($(zoom_label | tr -d '%') - $fit))")" 4
  check "editor alive after zooming" alive

  # Esc: copy and close. PNG at 2x with 1x point size, TIFF made on demand.
  key escape
  ctl wait-gone "$BENTO_PID" Screenshot 5 || fail "Esc did not close the editor"
  local pb; pb=$("$CTL" pb-info)
  log "$(echo "$pb" | tr '\n' ' ')"
  check "Esc copied a 2x PNG of the crop" grep -q "png: 1120 520 points: 560 260" <<< "$pb"
  check "lazy TIFF provided on request" grep -q "tiff: 1120 520 points: 560 260" <<< "$pb"

  # Reopen last: annotations and crop are still editable.
  perform shot.reopen-last
  editor_frame || { fail "Reopen Last Capture did not open the editor"; return; }
  expect_eq "reopened with the crop" "560 260" "$(status_size)"
  "$CTL" pb-text "-"; key cmd+c; sleep 0.4
  check "⌘C copies without closing" grep -q "png: 1120 520 points: 560 260" <<< "$("$CTL" pb-info)"
  check "editor still open after ⌘C" ctl wait-window "$BENTO_PID" Screenshot 1
  canvas_geometry
  # ⌘S saves into the configured folder.
  key cmd+s; sleep 1.8 # (lets the "Saved" HUD fade out)
  local saved; saved=$(ls "$H/saves"/*.png 2>/dev/null | head -1)
  check "⌘S saved a PNG" test -n "$saved"
  [ -n "$saved" ] && expect_eq "saved PNG size" "1120 520" "$(sips -g pixelWidth -g pixelHeight "$saved" | awk '/pixel/ {printf "%s ", $2}' | sed 's/ $//')"
  # Drag out: the toolbar's drag handle (right-aligned, 49 pt from the edge) onto
  # my TextEdit document, above the editor window.
  local before_txt after_txt
  before_txt=$(te 'get text of (first document whose name is "editor-qa.rtfd")')
  ctl drag "$BENTO_PID" $((WX + WW - 49)) $((WY + 20)) 400 250 "" 700; sleep 1.2
  check "drag out wrote the flattened PNG" test -n "$(find "${TMPDIR%/}/BentoDrag" -name '*.png' -newer /tmp/editor-e2e-start 2>/dev/null | head -1)"
  after_txt=$(te 'get text of (first document whose name is "editor-qa.rtfd")')
  check "the drop reached my TextEdit document" test "$after_txt" != "$before_txt"
  perform shot.reopen-last 0.6; editor_frame || { fail "editor lost after drag out"; return; }
  # ⇧⌘S shows the save sheet; Esc cancels it and keeps the editor.
  local nwin; nwin=$(ctl windows "$BENTO_PID" | wc -l | tr -d ' ')
  key cmd+shift+s; sleep 1.2
  check "⇧⌘S opens a save sheet" test "$(ctl windows "$BENTO_PID" | wc -l | tr -d ' ')" -gt "$nwin"
  key escape; sleep 0.6
  check "editor still open after cancelling Save As" ctl wait-window "$BENTO_PID" Screenshot 2

  # ⌘P: pin replaces the editor; opacity keys, scaling, double-click re-edits.
  key cmd+p; sleep 0.8
  ctl wait-gone "$BENTO_PID" Screenshot 3 || fail "⌘P did not close the editor"
  check "⌘P made a floating pin" pin_frame
  expect_eq "pin has the capture's point size" "560 260" "$PW $PH"
  # Pins don't activate Bento (focus went back to TextEdit), so their keys go
  # straight into Bento's process.
  ctl click "$BENTO_PID" $QX $QY
  ctl keypid "$BENTO_PID" 5; sleep 0.3
  expect_eq "5 sets 50% opacity" "0.50" "$(ctl windows "$BENTO_PID" | awk '$2 == 3 {print $3; exit}')"
  ctl keypid "$BENTO_PID" 0; sleep 0.2
  ctl scroll "$BENTO_PID" $QX $QY 5; sleep 0.4
  check "scrolling scales the pin up" test "$(ctl windows "$BENTO_PID" | awk '$2 == 3 {print $6; exit}')" -gt "$PW"
  ctl keypid "$BENTO_PID" cmd+0; sleep 0.2
  pin_frame; ctl dblclick "$BENTO_PID" $QX $QY; sleep 1
  check "double-clicking the pin reopens the editor" editor_frame
  check "pin closed after double-click" test -z "$(ctl windows "$BENTO_PID" | awk '$2 == 3')"
  expect_eq "re-edit keeps annotations" "15" "$(count)"

  # Two pins at once, Esc closes the focused one.
  key cmd+p; sleep 0.6; perform shot.reopen-last; editor_frame && key cmd+p; sleep 0.6
  expect_eq "two pins" "2" "$(ctl windows "$BENTO_PID" | awk '$2 == 3' | wc -l | tr -d ' ')"
  ctl keypid "$BENTO_PID" escape; sleep 0.4
  expect_eq "Esc closes one pin" "1" "$(ctl windows "$BENTO_PID" | awk '$2 == 3' | wc -l | tr -d ' ')"
  pin_frame && ctl click "$BENTO_PID" $QX $QY; ctl keypid "$BENTO_PID" cmd+w; sleep 0.4
  expect_eq "⌘W closes the other" "0" "$(ctl windows "$BENTO_PID" | awk '$2 == 3' | wc -l | tr -d ' ')"

  # Closing the window in the middle of typing keeps the text.
  perform shot.reopen-last; editor_frame || { fail "reopen for mid-edit test"; return; }
  canvas_geometry
  key t; at 300 240; ctl click "$BENTO_PID" $SX $SY; sleep 0.2; ctl type "$BENTO_PID" "Mid edit"; key cmd+w
  ctl wait-gone "$BENTO_PID" Screenshot 3 || fail "⌘W while typing did not close"
  expect_eq "text typed before ⌘W was saved" "Mid edit" "$(doc 'd["annotations"][-1]["text"]')"

  # Quit right after an edit (within the 2 s autosave delay), relaunch, reopen.
  perform shot.reopen-last; editor_frame || { fail "reopen before quit"; return; }
  canvas_geometry
  draw r 100 100 200 200
  key cmd+q; sleep 1.5
  check "⌘Q quit Bento" bash -c "! kill -0 $BENTO_PID 2>/dev/null"
  expect_eq "edit made just before quitting was saved" "17" "$(count)"
  launch
  perform shot.reopen-last
  editor_frame || { fail "Reopen Last after relaunch did not open the editor"; return; }
  expect_eq "after relaunch: crop kept" "560 260" "$(status_size)"
  key cmd+w
}

# Seeded before launch, so retention pruning (on first use) sees them.
pre_history() {
  mkdir -p "$CAPS"
  "$CTL" seed-history "$CAPS" 220 25
  "$CTL" seed-history "$CAPS/../old" 6 80 # 6 captures 13-80 days old
  mv "$CAPS"/../old/* "$CAPS"/; rmdir "$CAPS/../old"
  local old; old=$(ls "$CAPS" | sort | head -3 | tr '\n' ' ')
  # Damaged entries: truncated, junk, empty document; newest one without its original.
  local d
  for name in 20991230-000000-trnc 20991231-000000-junk 20991229-000000-empt; do mkdir -p "$CAPS/$name"; done
  head -c 120 "$(ls -d "$CAPS"/*/ | head -1)document.json" > "$CAPS/20991230-000000-trnc/document.json"
  echo "garbage" > "$CAPS/20991231-000000-junk/document.json"
  : > "$CAPS/20991229-000000-empt/document.json"
  d=$(ls -d "$CAPS"/2*/ | grep -v 2099 | sort | tail -1)
  cp -R "$d" "$CAPS/20991228-000000-nimg"; rm "$CAPS/20991228-000000-nimg/original.png"
  sed -i '' 's/"created":"[^"]*"/"created":"2099-12-28T00:00:00Z"/; s/"id":"[^"]*"/"id":"20991228-000000-nimg"/' "$CAPS/20991228-000000-nimg/document.json"
  log "seeded $(ls "$CAPS" | wc -l | tr -d ' ') folders"
  echo "$old" > "$H/old-ids"
}

phase_history() {
  local old; old=$(cat "$H/old-ids")
  local t0; t0=$(now)
  perform shot.history 0.2
  ctl wait-window "$BENTO_PID" "Capture History" 10 >/dev/null || { fail "history window did not open"; return; }
  log "history window with 220+ captures opened in $(since "$t0") s, footprint $(footprint) MB"
  sleep 1
  for o in $old; do check "retention pruned $o (older than 30 days)" test ! -d "$CAPS/$o"; done
  check "damaged entries are left alone on disk" test -d "$CAPS/20991231-000000-junk"
  # The newest valid entry has no original: Reopen Last falls back to the next one.
  perform shot.reopen-last
  check "Reopen Last skips the newest capture whose original is missing" editor_frame
  key cmd+w; ctl wait-gone "$BENTO_PID" Screenshot 3
  perform shot.history 0.6
  # Keyboard: first item selected; Space previews (Quick Look panel), Space closes it.
  local before; before=$(ctl windows "$BENTO_PID" | wc -l | tr -d ' ')
  key space; sleep 1.5
  check "Space opens Quick Look" test "$(ctl windows "$BENTO_PID" | wc -l | tr -d ' ')" -gt "$before"
  key space; sleep 0.8
  # Move to the next item, open it with ↩.
  key right; key return; sleep 1
  check "↩ in history opens the selected capture" editor_frame
  key cmd+w; ctl wait-gone "$BENTO_PID" Screenshot 3
  # ⌘⌫ moves the selected capture to the Trash.
  perform shot.history 0.6
  ls "$CAPS" | sort > "$H/before-delete"
  key cmd+delete; sleep 1
  local gone; gone=$(ls "$CAPS" | sort | comm -23 "$H/before-delete" -)
  expect_eq "⌘⌫ removes exactly one capture" "1" "$(echo "$gone" | grep -c .)"
  # Take the test capture back out of the user's Trash (only that folder).
  for g in $gone; do
    case "$g" in 2*-*-*) check "deleted capture is in the Trash" test -d ~/.Trash/"$g"; rm -rf ~/.Trash/"$g" ;; esac
  done
  key cmd+w
  check "Bento alive after history tests" alive
}

phase_big() {
  local t0
  "$CTL" pb-image "$FIX/big.png"
  local base; base=$(footprint)
  t0=$(now); perform shot.open-clipboard 0.1
  ctl wait-window "$BENTO_PID" Screenshot 20 >/dev/null || { fail "15 000 px capture did not open"; return; }
  log "15 000 px capture opened in $(since "$t0") s"
  editor_frame Screenshot 5 || { fail "15 000 px editor window not usable"; return; }
  sleep 3; local open; open=$(footprint); log "footprint open: $open MB (before: $base MB)"
  expect_eq "15 000 px canvas size" "1440 7500" "$(status_size)"
  key cmd+0; canvas_geometry
  ctl scroll "$BENTO_PID" $CX $CY -300 >/dev/null
  key r; ctl drag "$BENTO_PID" $((CX - 100)) $((CY - 60)) $((CX + 100)) $((CY + 60))
  for _ in $(seq 1 4); do ctl key "$BENTO_PID" cmd+equal; done
  sleep 2; local zoomed; zoomed=$(footprint); log "footprint at 244% with an annotation: $zoomed MB"
  check "drawing + zooming on a 15 000 px capture stays under +150 MB" lt "$zoomed" "$open + 150"
  for _ in $(seq 1 25); do ctl key "$BENTO_PID" cmd+equal; done
  expect_eq "max zoom on 15 000 px" "3200%" "$(zoom_label)"
  for _ in $(seq 1 40); do ctl key "$BENTO_PID" cmd+minus; done
  expect_eq "min zoom on 15 000 px" "5%" "$(zoom_label)"
  t0=$(now); key escape
  ctl wait-gone "$BENTO_PID" Screenshot 20 || fail "Esc did not close the big editor"
  local took; took=$(since "$t0"); log "Esc copy+close took $took s"
  check "Esc on 15 000 px closes within 3 s" lt "$took" 3
  local pb; pb=$("$CTL" pb-info); log "$(echo "$pb" | tr '\n' ' ')"
  check "big copy: PNG 2880×15000 at 1440×7500 pt" grep -q "png: 2880 15000 points: 1440 7500" <<< "$pb"
  check "big copy: TIFF on request" grep -q "tiff: 2880 15000 points: 1440 7500" <<< "$pb"
  sleep 3; local closed; closed=$(footprint); log "footprint after close (+TIFF request): $closed MB"
  check "memory released after closing the big editor (< open)" lt "$closed" "$open"

  "$CTL" pb-image "$FIX/huge.png"
  perform shot.open-clipboard 0.1
  editor_frame Screenshot 30 || { fail "40 000 px capture did not open"; return; }
  sleep 2; log "footprint 40 000 px open: $(footprint) MB"
  key cmd+0; canvas_geometry
  for _ in $(seq 1 30); do ctl scroll "$BENTO_PID" $CX $CY -200 >/dev/null; done; sleep 1
  screencapture -x -o -l "$WID" /tmp/editor-e2e-huge-bottom.png
  log "screenshot of the bottom of the 40 000 px capture: /tmp/editor-e2e-huge-bottom.png"
  key cmd+w; ctl wait-gone "$BENTO_PID" Screenshot 20 || fail "40 000 px editor did not close"
  check "Bento alive after big captures" alive
}

phase_tiny() {
  "$CTL" pb-image "$FIX/tiny.png"
  perform shot.open-clipboard 0.5
  editor_frame || { fail "1×1 capture did not open"; return; }
  for _ in $(seq 1 30); do ctl key "$BENTO_PID" cmd+equal; done
  expect_eq "1×1 zooms to 3200%" "3200%" "$(zoom_label)"
  canvas_geometry
  key r; ctl drag "$BENTO_PID" $((CX - 5)) $((CY - 5)) $((CX + 5)) $((CY + 5))
  # A shape with a shadow at 3200% used to stall every redraw for seconds.
  local t0; t0=$(now); zoom_label >/dev/null
  local lat; lat=$(since "$t0"); log "UI round trip at 3200% with a shape: $lat s"
  check "editor stays responsive at 3200% with a shape (< 1 s)" lt "$lat" 1
  key v; ctl drag "$BENTO_PID" $((CX - 5)) $((CY - 5)) $((CX + 5)) $((CY + 5)); key return
  key cmd+shift+t; sleep 1.5
  check "OCR on 1×1 doesn't crash" alive
  key escape
  if ! ctl wait-gone "$BENTO_PID" Screenshot 3; then
    fail "Esc did not close the 1×1 editor"
    log "windows: $(ctl windows "$BENTO_PID" | tr '\n' '|') texts: $(ctl texts "$BENTO_PID" Screenshot | tr '\n' '|')"
    screencapture -x -o -l "$WID" /tmp/editor-e2e-tiny-esc.png
    key escape; ctl wait-gone "$BENTO_PID" Screenshot 3 || key cmd+w
  fi
  check "1×1 copy" grep -q "png: 1 1" <<< "$("$CTL" pb-info)"
  perform shot.reopen-last; editor_frame || { fail "reopen 1×1"; return; }
  key cmd+p; sleep 0.8
  PW=0; PH=0; pin_frame
  check "1×1 pin is at least 32×32 pt" test "${PW:-0}" -ge 32 -a "${PH:-0}" -ge 32
  # A new pin is key; click it first only if no other app's window covers it.
  [ -n "${QX:-}" ] && ctl click "$BENTO_PID" $QX $QY
  ctl keypid "$BENTO_PID" escape; sleep 0.4
  check "1×1 pin closes with Esc" test -z "$(ctl windows "$BENTO_PID" | awk '$2 == 3')"
}

phase_leak() {
  "$CTL" pb-image "$FIX/mid.png"
  perform shot.open-clipboard 0.5
  editor_frame || { fail "editor did not open"; return; }
  key cmd+w; ctl wait-gone "$BENTO_PID" Screenshot 3
  perform shot.reopen-last 0.5; editor_frame && key cmd+w; sleep 2
  local base; base=$(footprint); log "baseline after 2 editors: $base MB"
  for i in $(seq 1 20); do
    perform shot.reopen-last 0.4
    editor_frame Screenshot 5 >/dev/null || { fail "reopen $i"; return; }
    canvas_geometry; draw a $((20 + i)) 20 $((120 + i)) 80
    key cmd+w; ctl wait-gone "$BENTO_PID" Screenshot 5
  done
  sleep 3; local end; end=$(footprint); log "after 20 more editors: $end MB"
  check "20 editors opened/closed: memory within +40 MB of baseline" lt "$end" "$base + 40"
  local live; live=$(heap "$BENTO_PID" 2>/dev/null | awk '/ EditorController / {print $1; exit}')
  expect_eq "no EditorController left alive" "" "$live"
}

# Older build comparison helper: same steps as `big`, just numbers.
phase_perf() { phase_big; }

# MARK: - Runner

run_phase() {
  local p="$1" tries=0 rc
  while :; do
    "$ROOT/scripts/e2e/session" start "$WHO" || exit 1
    pb_save
    # The Clipboard module (it reads every copy) only where its interplay is under
    # test; elsewhere it would skew memory measurements.
    rm -rf "$H"; if [ "$p" = capture ]; then write_config true; else write_config false; fi
    touch /tmp/editor-e2e-start
    if owns_lock; then
      ( if type "pre_$p" >/dev/null 2>&1; then "pre_$p"; fi
        launch; "phase_$p"; alive || fail "$p: Bento is not running at the end of the phase" ); rc=$?
    else
      log "session started without holding the GUI lock"; rc=75
    fi
    pkill -f "^$BIN$" 2>/dev/null; sleep 0.5
    cp "$H/bento.log" "/tmp/editor-e2e-$p.log" 2>/dev/null
    close_textedit
    pb_restore
    "$ROOT/scripts/e2e/session" end "$WHO"
    if [ $rc -eq 75 ]; then
      tries=$((tries + 1)); [ $tries -ge 3 ] && { fail "$p: user kept interrupting"; break; }
      log "retrying $p later"; sleep 60; continue
    fi
    [ $rc -ne 0 ] && fail "$p exited with $rc"
    grep -q "Fatal error\|CONTINUATION MISUSE" "$H/bento.log" 2>/dev/null && fail "$p: Bento crashed: $(grep -m1 'Fatal error\|MISUSE' "$H/bento.log")"
    for r in $(find ~/Library/Logs/DiagnosticReports -name 'Bento*.ips' -newer /tmp/editor-e2e-start 2>/dev/null); do
      grep -q "$BIN" "$r" && fail "$p: crash report $r"
    done
    break
  done
}

main() {
  rm -f "$FAILFILE"
  build
  local phases=("$@"); [ ${#phases[@]} -eq 0 ] && phases=(capture history big tiny leak)
  for p in "${phases[@]}"; do log "== phase $p"; run_phase "$p"; done
  if [ -s "$FAILFILE" ]; then log "$(wc -l < "$FAILFILE" | tr -d ' ') check(s) failed:"; cat "$FAILFILE"; exit 1; fi
  log "all checks passed"
}
main "$@"
exit $?
