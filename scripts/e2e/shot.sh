#!/bin/bash
# Shot (capture) end-to-end regression against the full debug app, with real
# hotkeys. Every phase runs in its own short GUI session (docs/QA.md):
#   scripts/e2e/shot.sh [phase...]   phases: overlay modes windows scroll memory (default: all)
# Builds .build/debug/Bento first if it's missing (run `swift build --product
# Bento` yourself to test changes). Runs Bento with BENTO_HOME=/tmp/bento-e2e-shot
# (notes sync off), drives it with /tmp/shot-ctl (input is checked to target
# that process, our TextEdit document or our Finder window) and asserts on the
# clipboard, saved files, history, windows and the process staying alive. The
# user's clipboard is saved and restored around each phase.
# SHOT_E2E_CLIPBOARD=false runs without the clipboard module (to tell Shot's
# memory from clipboard history's).
# Exit status: 0 all passed, 1 failures, 75 the user came back (run again later).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
H=/tmp/bento-e2e-shot
OUT="$H/out"
BIN="$ROOT/.build/debug/Bento"
CTL=/tmp/shot-ctl
BCTL=/tmp/bentoctl
DOCNAME=shot-qa   # per phase: shot-qa-<phase> (set in setup)
DOC="/tmp/$DOCNAME.rtf"
FINDER_DIR="$H/shot-finder"
SESSION="$ROOT/scripts/e2e/session"
PID=""
TOTAL_FAIL=0

[ -x "$BIN" ] || swift build --package-path "$ROOT" --product Bento >/dev/null
[ "$CTL" -nt "$ROOT/scripts/e2e/shot-ctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/shot-ctl.swift" -o "$CTL"
mkdir -p "$H" "$OUT"

# ---------------------------------------------------------------- helpers

ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; echo "$*" >> "$H/failures"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
# checkc NAME 'condition' — a compound shell condition, evaluated here.
checkc() { local name="$1"; shift; if eval "$1"; then ok "$name"; else bad "$name"; fi; }
abort() { echo "  user is active: stopping this phase"; exit 75; }
# Input through shot-ctl, always pid-checked; exit 75 aborts the phase.
ctl() { "$CTL" "$@" --pid "$PID" --doc "$DOCNAME"; local rc=$?; [ $rc = 75 ] && abort; return $rc; }
key() { ctl key "$@"; }
alive() { kill -0 "$PID" 2>/dev/null; }
overlay_up() { "$CTL" wait "$PID" 1000 "${1:-4}"; }
overlay_gone() { "$CTL" gone "$PID" 1000 "${1:-3}"; }
marker() { printf 'shot-e2e-marker' | pbcopy; }
clip() { "$CTL" clip; }
# Waits until the clipboard no longer holds the marker, then prints it.
clip_wait() {
  for _ in $(seq 1 "${1:-40}"); do local c; c=$(clip); [ "$c" != "text shot-e2e-marker" ] && { echo "$c"; return 0; }; sleep 0.1; done
  echo "unchanged"; return 1
}
history_count() { find "$H/support/Captures" -name original.png 2>/dev/null | wc -l | tr -d ' '; }
win_count() { "$CTL" windows "$PID" | awk -v l="$1" '$2 == l' | wc -l | tr -d ' '; }
setting() { # setting <jq path> <json value> — live config edit (atomic replace)
  jq "$1 = $2" "$H/config/config.json" > "$H/config/tmp.json" && mv "$H/config/tmp.json" "$H/config/config.json"; sleep 0.7
}
front_doc() { "$BCTL" front com.apple.TextEdit "$DOCNAME" >/dev/null 2>&1; }
# Waits for the scrolling-capture progress panel (360x64) to appear and go away.
scroll_done() { "$CTL" wait "$PID" 25 3 360 64; "$CTL" gone "$PID" 25 "${1:-60}" 360 64; }
# Area capture of TextEdit-covered points with ⌘⇧2; prints the clipboard.
area() { marker; key cmd+shift+2; overlay_up || { echo "no overlay"; return 1; }; ctl drag "$@" || return 1; clip_wait; }

write_config() {
  rm -rf "$H/config"; mkdir -p "$H/config"
  cat > "$H/config/config.json" <<EOF
{
  "notes": { "sync": { "enabled": false, "server": "http://127.0.0.1:9", "tokenFile": "$H/no-token" } },
  "general": { "enabledModules": { "clipboard": ${SHOT_E2E_CLIPBOARD:-true} } },
  "shot": { "afterCapture": "copy", "playSound": false, "saveFolder": "$OUT", "adjustSelectionBeforeCapture": false,
            "scrollMode": "auto", "scrollMaxHeight": 20000, "delaySeconds": 3, "delayedTarget": "area", "windowShadow": true,
            "windowBackground": "transparent", "windowPadding": 0, "colorFormat": "hex", "showMagnifier": true },
  "shortcuts": {
    "shot.window": "ctrl+opt+cmd+f13", "shot.active-window": "ctrl+opt+cmd+f14", "shot.repeat-area": "ctrl+opt+cmd+f15",
    "shot.delayed": "ctrl+opt+cmd+f16", "shot.scrolling": "ctrl+opt+cmd+f17", "shot.scrolling-up": "ctrl+opt+cmd+f18",
    "shot.pin-area": "ctrl+opt+cmd+f19", "shot.color": "ctrl+opt+shift+f13"
  }
}
EOF
}

write_doc() {
  {
    printf '{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0\\fs40\n'
    for i in $(seq -w 1 "${1:-160}"); do printf 'Line %s quick brown fox %s\\par\n' "$i" "$i"; done
    printf '}\n'
  } > "$DOC"
}

# Closes our TextEdit documents. If TextEdit doesn't answer (stuck in a mouse
# tracking loop on our document after a lost mouse-up), release the button
# over our document and try again.
close_docs() {
  local script=(-e 'with timeout of 8 seconds' -e 'tell application "TextEdit" to close (every document whose name starts with "shot-qa") saving no' -e 'end timeout')
  osascript "${script[@]}" >/dev/null 2>&1 && return 0
  local at; at=$("$BCTL" windows TextEdit 2>/dev/null | awk '/shot-qa/ {print $3 + 60, $4 + 120; exit}')
  [ -n "$at" ] && { echo "  info  TextEdit not answering; releasing the mouse over our document"; "$BCTL" up $at; sleep 0.5; }
  osascript "${script[@]}" >/dev/null 2>&1
}
# TextEdit must answer Apple events (it doesn't while stuck tracking a mouse drag).
textedit_ok() { osascript -e 'with timeout of 4 seconds' -e 'tell application "TextEdit" to get name of front document' -e 'end timeout' >/dev/null 2>&1; }
# page_colour -> #RRGGBB of our document's page at (700, 650), from the
# window's own image (light or dark appearance).
page_colour() { snap_doc page; "$CTL" pixel "$H/doc-page.png" $(( (700 - 120) * 2 )) $(( (650 - 80) * 2 )); }
# near_hex A B: same colour within 3 per channel (display vs sRGB rounding).
near_hex() {
  local a="${1#\#}" b="${2#\#}" i
  [ ${#a} = 6 ] && [ ${#b} = 6 ] || return 1
  for i in 0 2 4; do
    local d=$(( 16#${a:$i:2} - 16#${b:$i:2} )); [ ${d#-} -le 3 ] || return 1
  done
}
snap_doc() {
  local w; w=$("$BCTL" windows TextEdit 2>/dev/null | awk -v n="$DOCNAME" 'index($0, n) {print $1; exit}')
  [ -n "$w" ] && screencapture -x -o -l "$w" "$H/doc-$1.png"
}

setup() {
  local phase="$1" lines="${2:-160}"
  DOCNAME="shot-qa-$phase"; DOC="/tmp/$DOCNAME.rtf"
  "$SESSION" start shot || exit 75
  STARTED=1
  START=$(date +%s)
  close_docs
  "$CTL" clip-save "$H/clip.plist" 2>/dev/null
  write_config
  rm -rf "$OUT"; mkdir -p "$OUT"
  rm -rf "$H/frames"
  BENTO_HOME="$H" BENTO_DEV=1 BENTO_SHOT_FRAMES="$H/frames" "$BIN" > "$H/bento-$phase.log" 2>&1 &
  PID=$!; disown "$PID"
  log stream --level debug --style compact --predicate "subsystem == \"com.charles.bento\" AND processID == $PID" > "$H/log-$phase.txt" 2>/dev/null &
  LOGPID=$!; disown "$LOGPID"
  write_doc "$lines"
  open -a TextEdit "$DOC"
  for _ in $(seq 1 40); do "$BCTL" frame com.apple.TextEdit "$DOCNAME" >/dev/null 2>&1 && break; sleep 0.25; done
  front_doc
  "$BCTL" setframe com.apple.TextEdit "$DOCNAME" 120 80 760 640 >/dev/null 2>&1
  sleep 1.2
  snap_doc "$phase-start" # as laid out (for debugging coordinates)
  alive || { bad "Bento started"; exit 1; }
  echo "phase $phase (pid $PID)"
}

cleanup() {
  # Interrupted while waiting for the GUI lock: the session (guard, lock,
  # installed Bento) belongs to someone else; touch nothing.
  [ -n "${STARTED:-}" ] || return 0
  snap_doc "${DOCNAME#shot-qa-}-end"
  textedit_ok || bad "TextEdit answers at the end of the phase (a mouse-up went missing)"
  [ -n "${PID:-}" ] && alive && kill "$PID" 2>/dev/null
  sleep 0.5
  [ -n "${LOGPID:-}" ] && kill "$LOGPID" 2>/dev/null
  close_docs
  [ -n "${FINDER_OPEN:-}" ] && "$CTL" axclose com.apple.finder shot-finder
  [ -f "$H/clip.plist" ] && "$CTL" clip-restore "$H/clip.plist" && rm -f "$H/clip.plist"
  if ls -t "$HOME/Library/Logs/DiagnosticReports/" 2>/dev/null | head -20 | grep -q '^Bento'; then
    local newest; newest=$(ls -t "$HOME/Library/Logs/DiagnosticReports/" | grep '^Bento' | head -1)
    [ "$(stat -f %m "$HOME/Library/Logs/DiagnosticReports/$newest")" -ge "${START:-0}" ] && bad "crash report $newest"
  fi
  "$SESSION" end shot
}

run_phase() {
  rm -f "$H/failures"
  ( trap cleanup EXIT; "phase_$1" )
  local rc=$?
  [ -f "$H/failures" ] && TOTAL_FAIL=$((TOTAL_FAIL + $(wc -l < "$H/failures")))
  return $rc
}

# ---------------------------------------------------------------- phases

# Overlay input on ⌘⇧2 (after capture: copy).
phase_overlay() {
  setup overlay
  local n0; n0=$(history_count)
  check "drag 200x120 pt -> 400x240 px" [ "$(area 300 300 500 420)" = "image 400x240" ]
  # (History is written right after the clipboard, on the next run-loop turn.)
  for _ in $(seq 1 30); do [ "$(history_count)" = $((n0 + 1)) ] && break; sleep 0.1; done
  check "history recorded" [ "$(history_count)" = $((n0 + 1)) ]

  marker; key cmd+shift+2; overlay_up; key escape
  check "Esc cancels" overlay_gone
  marker; key cmd+shift+2; overlay_up; ctl rclick 400 400
  check "right-click cancels" overlay_gone
  marker; key cmd+shift+2; overlay_up; ctl click 400 400; sleep 0.3
  check "0x0 click keeps the overlay" overlay_up 1
  ctl drag 400 400 401 401; sleep 0.3
  check "1x1 drag keeps the overlay" overlay_up 1
  key cmd+shift+2; sleep 0.5
  check "cmd-shift-2 again: one overlay, alive" [ "$(win_count 1000)" = 1 ]
  key escape; overlay_gone
  check "nothing captured by cancelled overlays" [ "$(clip)" = "text shot-e2e-marker" ]

  # Edges, not corners (hot corners).
  check "edge-touching selection (left edge)" [ "$(area 0 200 100 260)" = "image 200x120" ]
  local c; c=$(area 1412 400 1511 460)
  check "edge-touching selection (right edge) ($c)" [ "$c" = "image 198x120" ]
  c=$(area 600 0 700 60)
  check "edge-touching selection (top edge, over the menu bar) ($c)" [ "$c" = "image 200x120" ]

  # Space -> window mode, click TextEdit.
  marker; key cmd+shift+2; overlay_up; key space; ctl move 500 400; sleep 0.2; ctl click 500 400
  c=$(clip_wait 60)
  check "Space toggles window mode, window captured ($c)" [ "${c%% *}" = image ]
  # Space twice -> back to area mode.
  marker; key cmd+shift+2; overlay_up; key space space
  ctl drag 300 300 400 350
  check "Space twice returns to area mode" [ "$(clip_wait)" = "image 200x100" ]

  # Tab copies the colour under the pointer (TextEdit's page), overlay stays.
  local page; page=$(page_colour)
  marker; key cmd+shift+2; overlay_up; ctl move 700 650; sleep 0.2; key tab; sleep 0.3
  c=$(clip)
  checkc "Tab copies colour ($c, page $page), overlay stays" 'near_hex "${c#text }" "$page" && overlay_up 1'
  # Over the "L" of line 2: the darkest pixel around the pointer is text.
  ctl move 132 210; sleep 0.2; key shift+tab; sleep 0.3
  c=$(clip)
  checkc "Shift+Tab copies the text colour ($c)" '[ "${c:0:6}" = "text #" ] && [ "$c" != "text #FFFFFF" ]'
  key escape; overlay_gone

  # Keyboard selection: Return anchors, arrows extend (Shift = 10), Return captures.
  # (A real Shift press sends flagsChanged first; it must not force a square.)
  marker; key cmd+shift+2; overlay_up; ctl move 300 300; sleep 0.2
  key return; ctl flags shift; key shift+right shift+right shift+right; ctl flags ""
  key right right; ctl flags shift; key shift+down shift+down; ctl flags ""; key return
  check "keyboard selection 32x20 pt" [ "$(clip_wait)" = "image 64x40" ]

  # Adjustable selection: [ ] grow/shrink, arrows move, Return captures.
  setting .shot.adjustSelectionBeforeCapture true
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 0.3
  check "adjust mode keeps the selection" overlay_up 1
  key rightbracket rightbracket leftbracket left down cmd+right; sleep 0.2; key return
  check "[ ] arrows cmd-arrow adjust (203x122 pt)" [ "$(clip_wait)" = "image 406x244" ]
  setting .shot.adjustSelectionBeforeCapture false

  marker; key cmd+shift+1
  check "cmd-shift-1 fullscreen" [ "$(clip_wait 60)" = "image 3024x1964" ]

  # Copy text: lines 2-4 of the document (below the ruler).
  marker; key ctrl+opt+cmd+o; overlay_up; ctl drag 122 198 470 272
  c=$(clip_wait 80)
  checkc "ctrl-opt-cmd-O copies text ($c)" '[[ "$c" == "text Line 00"* ]]' 
  marker; key ctrl+opt+cmd+o; overlay_up; ctl drag 700 600 760 650; sleep 2
  check "OCR of a blank area leaves the clipboard" [ "$(clip)" = "text shot-e2e-marker" ]
  marker; key ctrl+opt+cmd+o; overlay_up; ctl drag 700 600 702 602; sleep 1.5
  check "OCR of a 2x2 pt selection, alive" alive
  check "Bento alive after overlay phase" alive
}

# After-capture modes, with the editor, pins, notes and clipboard panel.
phase_modes() {
  setup modes
  setting .shot.afterCapture '"save"'
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  check "save mode writes a PNG" [ "$(ls "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ')" = 1 ]
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  check "same-second name collision gets a new name" [ "$(ls "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ')" = 2 ]
  setting .shot.format '"jpeg"'; setting .shot.jpegQuality 80; setting .shot.downscaleRetina true
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  local j; j=$(ls "$OUT"/*.jpg 2>/dev/null | head -1)
  checkc "JPEG at 1x" '[ -n "$j" ] && [ "$("$CTL" imgsize "$j")" = "200x120" ]' 
  setting .shot.format '"png"'; setting .shot.downscaleRetina false
  setting .shot.saveFolder "\"$H/readonly/sub\""
  mkdir -p "$H/readonly"; chmod 555 "$H/readonly"
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  check "unwritable folder: no crash" alive
  chmod 755 "$H/readonly"
  setting .shot.saveFolder "\"$OUT/new/folder\""
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  check "missing folder is created" [ "$(ls "$OUT"/new/folder/*.png 2>/dev/null | wc -l | tr -d ' ')" = 1 ]

  setting .shot.afterCapture '"copyAndSave"'
  marker; key cmd+shift+2; overlay_up; ctl drag 300 300 500 420
  check "copy and save: clipboard" [ "$(clip_wait)" = "image 400x240" ]
  sleep 1
  check "copy and save: file" [ "$(ls "$OUT"/new/folder/*.png 2>/dev/null | wc -l | tr -d ' ')" = 2 ]

  setting .shot.afterCapture '"pin"'
  key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1
  check "pin mode shows a pin" [ "$(win_count 3)" -ge 1 ]
  key ctrl+opt+cmd+f19; overlay_up; ctl drag 300 450 400 500; sleep 1
  check "capture area to pin" [ "$(win_count 3)" -ge 2 ]

  setting .shot.afterCapture '"editor"'
  key cmd+shift+2; overlay_up; ctl drag 300 300 500 420; sleep 1.5
  local eds; eds=$(win_count 0)
  check "editor mode opens an editor ($eds)" [ "$eds" -ge 1 ]
  # Capture while the editor is open (and key).
  key cmd+shift+2
  check "overlay opens over the editor" overlay_up
  ctl drag 600 500 700 560; sleep 1.5
  check "second editor" [ "$(win_count 0)" -ge $((eds + 1)) ]
  marker; key escape; sleep 0.8
  check "Esc in the editor copies and closes" [ "$(clip_wait)" = "image 200x120" ]

  # Clipboard panel open, then capture.
  setting .shot.afterCapture '"copy"'
  front_doc; key cmd+shift+v; sleep 0.8
  local panels; panels=$("$CTL" windows "$PID" | awk '$2 == 3' | wc -l | tr -d ' ')
  check "clipboard panel shown" [ "$panels" -ge 1 ]
  marker; key cmd+shift+2; overlay_up
  check "overlay over the clipboard panel" overlay_up 1
  ctl drag 300 300 500 420
  check "capture with the clipboard panel open" [ "$(clip_wait)" = "image 400x240" ]
  check "Bento alive after modes phase" alive
}

# Window, active window, repeat, delayed, colour picker, ruler, own windows.
phase_windows() {
  setup windows
  mkdir -p "$FINDER_DIR"; open "$FINDER_DIR"; FINDER_OPEN=1
  for _ in $(seq 1 20); do "$BCTL" frame com.apple.finder shot-finder >/dev/null 2>&1 && break; sleep 0.25; done
  "$BCTL" setframe com.apple.finder shot-finder 920 120 520 420 >/dev/null 2>&1
  sleep 0.5; front_doc

  marker; key ctrl+opt+cmd+f13; overlay_up; ctl move 500 400; sleep 0.2; ctl click 500 400
  local c; c=$(clip_wait 60)
  check "window picker: TextEdit ($c)" [ "${c%% *}" = image ]
  "$CTL" clip-png "$H/textedit-window.png"
  # With the shadow, the window itself must stay 1:1 (760x640 pt at 2x).
  # (Dark windows have a translucent 1-2 px edge, hence the tolerance.)
  local ow oh; IFS=x read -r ow oh < <("$CTL" opaque "$H/textedit-window.png")
  checkc "window capture keeps the window at 1:1 (${ow}x${oh} of 1520x1280)" \
    '[ $((1520 - ow)) -ge 0 ] && [ $((1520 - ow)) -le 8 ] && [ $((1280 - oh)) -ge 0 ] && [ $((1280 - oh)) -le 8 ]'
  # Finder (translucent sidebar). Other apps' invisible floating windows over
  # it must not be picked instead: the capture must be this window, at 1:1.
  local fx fy fw fh; read -r fx fy fw fh < <("$BCTL" frame com.apple.finder shot-finder)
  front_doc
  marker; key ctrl+opt+cmd+f13; overlay_up; ctl move $((fx + fw / 2)) $((fy + fh / 2)); sleep 0.4; ctl click $((fx + fw / 2)) $((fy + fh / 2))
  c=$(clip_wait 60)
  "$CTL" clip-png "$H/finder-window.png"
  local fo; fo=$("$CTL" opaque "$H/finder-window.png")
  check "window picker: Finder $((fw * 2))x$((fh * 2)) px ($c, opaque $fo)" [ "$fo" = "$((fw * 2))x$((fh * 2))" ]
  rm -f "$H/finder-window.png"

  front_doc; marker; key ctrl+opt+cmd+f14
  c=$(clip_wait 60)
  check "active window: TextEdit ($c)" [ "${c%% *}" = image ]

  marker; area 300 300 460 380 >/dev/null
  marker; key ctrl+opt+cmd+f15
  check "repeat last area" [ "$(clip_wait 40)" = "image 320x160" ]

  # Bento's own notes window: window capture and area capture include it.
  front_doc; key ctrl+opt+n; sleep 1
  local nw; nw=$("$CTL" windows "$PID" | awk '($2 == 0 || $2 == 3) && $5 > 150 && $6 > 150' | head -1)
  if [ -n "$nw" ]; then
    set -- $nw; local nid=$1 nx=$3 ny=$4 nwid=$5 nh=$6
    marker; key ctrl+opt+cmd+f13; overlay_up; ctl move $((nx + nwid / 2)) $((ny + nh / 2)); sleep 0.4; ctl click $((nx + nwid / 2)) $((ny + nh / 2))
    c=$(clip_wait 60)
    "$CTL" clip-png "$H/notes-picked.png"
    local no; no=$("$CTL" opaque "$H/notes-picked.png")
    check "window picker: Bento notes window $((nwid * 2))x$((nh * 2)) px ($c, opaque $no)" [ "$no" = "$((nwid * 2))x$((nh * 2))" ]
    # Area = the window's frame; compare with the window's own pixels. A
    # system notification banner over it spoils the comparison: try twice.
    local d attempt
    for attempt in 1 2; do
      [ "$attempt" = 2 ] && sleep 6
      marker; key cmd+shift+2; overlay_up; ctl drag "$nx" "$ny" $((nx + nwid)) $((ny + nh)); clip_wait >/dev/null
      "$CTL" clip-png "$H/notes-area.png"
      screencapture -x -o -l "$nid" "$H/notes-window.png"
      d=$("$CTL" imgdiff "$H/notes-area.png" "$H/notes-window.png")
      awk -v d="$d" 'BEGIN { exit !(d < 6) }' && break
    done
    check "area capture shows the notes window, not what's behind it (diff $d)" awk -v d="$d" 'BEGIN { exit !(d < 6) }'
    front_doc; key ctrl+opt+n; sleep 0.5
  else
    bad "notes window opened"
  fi
  front_doc

  # Delayed capture: Esc cancels the countdown; otherwise the overlay opens.
  key ctrl+opt+cmd+f16
  check "countdown shown" "$CTL" wait "$PID" 25 2 132 112
  key escape
  check "Esc cancels the countdown" "$CTL" gone "$PID" 25 2 132 112
  sleep 3
  check "no overlay after cancelling" overlay_gone 0.2
  key ctrl+opt+cmd+f16
  check "delayed capture opens the overlay" overlay_up 6
  key escape; overlay_gone

  # Colour picker in every format (F cycles), Shift = text colour.
  # Format 0 is the page colour; the others must say the same colour.
  local page hex i; page=$(page_colour)
  for i in 0 1 2 3 4; do
    marker; key ctrl+opt+shift+f13; overlay_up; ctl move 700 650; sleep 0.15
    local k; for ((k = 0; k < i; k++)); do key f; done  # (BSD seq 1 0 counts down)
    ctl click 700 650
    c=$(clip_wait); c=${c#text }
    case $i in
      0) hex=$c; checkc "colour picker HEX: $c (page $page)" 'near_hex "$c" "$page"' ;;
      1) check "colour picker HEX without #: $c" [ "#$c" = "$hex" ] ;;
      2) check "colour picker rgb(): $c" [ "$c" = "rgb($((16#${hex:1:2})), $((16#${hex:3:2})), $((16#${hex:5:2})))" ] ;;
      3) checkc "colour picker hsl(): $c" '[[ "$c" == "hsl("*"%)" ]]' ;;
      4) checkc "colour picker oklch(): $c" '[[ "$c" == "oklch("*")" ]]' ;;
    esac
  done
  marker; key ctrl+opt+shift+f13; overlay_up; ctl move 132 210; sleep 0.15; ctl click 132 210 shift
  c=$(clip_wait); checkc "colour picker text colour (${c#text })" '[ "${c:0:6}" = "text #" ] && [ "$c" != "text #FFFFFF" ]' 

  # Ruler: hold Option over the page, screenshot our overlay region.
  key cmd+shift+2; overlay_up; ctl move 600 500; sleep 0.2; ctl flags opt; sleep 0.4
  screencapture -x -R 400,400,400,200 "$H/ruler.png"
  ctl flags ""; key escape; overlay_gone
  check "ruler drawn (pink pixels)" [ -s "$H/ruler.png" ]
  check "Bento alive after windows phase" alive
}

# Scrolling capture: down, up, manual, max height, nothing to scroll, memory peak.
# Long captures keep Bento's main thread busy for a few seconds afterwards
# (ShotEditor encodes PNGs for the clipboard and history), hence the long waits.
# stitched_lines FILE -> "<lines found> <first> <last> <missing>" for the
# "Line NNN" document, OCR'd in overlapping 900 px strips (Vision can't read
# a 14,000 px tall image in one go).
stitched_lines() {
  local hgt y=0; hgt=$("$CTL" imgsize "$1" | cut -dx -f2)
  : > "$H/ocr-lines.txt"
  while [ "$y" -lt "$hgt" ]; do
    "$CTL" crop "$1" "$y" 900 "$H/ocr-strip.png" && "$CTL" ocr "$H/ocr-strip.png" >> "$H/ocr-lines.txt"
    y=$((y + 800))
  done
  grep -oE 'Line [0-9]{3}' "$H/ocr-lines.txt" | awk '{print $2 + 0}' | sort -n -u > "$H/ocr-nums.txt"
  local first last count
  first=$(head -1 "$H/ocr-nums.txt"); last=$(tail -1 "$H/ocr-nums.txt"); count=$(wc -l < "$H/ocr-nums.txt" | tr -d ' ')
  echo "$count ${first:-0} ${last:-0} $(( ${last:-0} - ${first:-0} + 1 - count ))"
}
settle() { sleep "${1:-4}"; } # let Bento finish encoding before the next hotkey

phase_scroll() {
  setup scroll 300
  local rss0 peak=0 c first last missing
  rss0=$(ps -o rss= -p "$PID" | tr -d ' ')
  ( while kill -0 "$PID" 2>/dev/null; do ps -o rss= -p "$PID"; sleep 0.1; done ) > "$H/rss.txt" &
  local sampler=$!; disown $sampler

  marker; key ctrl+opt+cmd+f17; overlay_up 10; ctl drag 125 190 860 712
  scroll_done 60
  c=$(clip_wait 300); "$CTL" clip-png "$H/scroll-down.png"; snap_doc scroll-1
  local n; read -r n first last missing < <(stitched_lines "$H/scroll-down.png")
  checkc "scrolling capture down: lines $first-$last, $missing missing ($c)" \
    '[ "${c%% *}" = image ] && [ "$first" -le 2 ] && [ "$last" = 300 ] && [ "$missing" -le 2 ]'
  settle

  marker; key ctrl+opt+cmd+f18; overlay_up 10; ctl drag 125 190 860 712
  scroll_done 60
  c=$(clip_wait 300); "$CTL" clip-png "$H/scroll-up.png"; snap_doc scroll-2
  read -r n first last missing < <(stitched_lines "$H/scroll-up.png")
  checkc "scrolling capture up: lines $first-$last, $missing missing ($c)" \
    '[ "${c%% *}" = image ] && [ "$first" -le 2 ] && [ "$last" = 300 ] && [ "$missing" -le 2 ]'
  settle

  setting .shot.scrollMaxHeight 3000
  marker; key ctrl+opt+cmd+f17; overlay_up 10; ctl drag 125 190 860 712
  scroll_done 30
  c=$(clip_wait 100)
  check "max height stops at 3000 px ($c)" [ "$c" = "image 1470x3000" ]
  check "the limit is reported (progress panel and HUD)" grep -q "message=Reached the maximum height (3,000 px)" "$H/log-scroll.txt"
  setting .shot.scrollMaxHeight 20000

  # Nothing to scroll: the document's title bar.
  marker; key ctrl+opt+cmd+f17; overlay_up 10; ctl drag 300 84 700 108
  scroll_done 20
  c=$(clip_wait 100)
  check "content that doesn't scroll gives the visible area ($c)" [ "$c" = "image 800x48" ]

  # Manual: we scroll, Return finishes.
  setting .shot.scrollMode '"manual"'
  marker; key ctrl+opt+cmd+f17; overlay_up 10; ctl drag 125 190 860 712
  "$CTL" wait "$PID" 25 3 360 64
  for _ in 1 2 3 4 5 6; do "$CTL" scroll 500 400 -150 --doc "$DOCNAME" --pid "$PID"; [ $? = 75 ] && abort; sleep 0.35; done
  key return
  "$CTL" gone "$PID" 25 10 360 64
  c=$(clip_wait 200)
  checkc "manual scrolling capture ($c)" '[ "${c%% *}" = image ] && [ "${c##*x}" -gt 1100 ]'
  kill $sampler 2>/dev/null
  sleep 3
  echo "  info  heap in use: $(heap "$PID" 2>/dev/null | awk '/^All zones: .* bytes\)/ {print $5, $6}' | tr -d '()')"
  peak=$(sort -n "$H/rss.txt" | tail -1)
  footprint "$PID" 2>/dev/null | awk '/^ *[0-9.]+ [KMG]B/ && NR > 3' | head -5 | sed 's/^/        /'
  echo "  info  RSS start ${rss0} KB, peak ${peak} KB; phys_footprint now $(footprint "$PID" 2>/dev/null | awk '/phys_footprint:/ {print $2 $3}'), peak $(footprint "$PID" 2>/dev/null | awk '/phys_footprint_peak:/ {print $2 $3}')"
  check "Bento alive after scroll phase" alive
}

# 40 captures (footprint after 0/20/40: growth that stops is caches, steady
# growth a leak), then idle CPU. Drags stay in the left half: a system prompt
# may sit above everything on the right.
phase_memory() {
  setup memory
  marker; area 300 300 500 420 >/dev/null; sleep 2
  fp() { footprint "$PID" 2>/dev/null | awk '/phys_footprint:/ {print $2 $3; exit}'; }
  local f0 f20 f40 cpu i n=0
  f0=$(fp)
  for i in $(seq 1 40); do
    marker; key cmd+shift+2; overlay_up || break; ctl drag $((150 + i % 20 * 5)) 250 $((400 + i % 20 * 5)) 500 || break
    [ "$(clip_wait)" != unchanged ] && n=$((n + 1))
    [ "$i" = 20 ] && { sleep 3; f20=$(fp); }
  done
  check "40 captures in a row ($n)" [ "$n" = 40 ]
  sleep 3
  check "no overlay windows left behind" [ "$(win_count 1000)" = 0 ]
  f40=$(fp)
  echo "  info  heap in use: $(heap "$PID" 2>/dev/null | awk '/^All zones: .* bytes\)/ {print $5, $6}' | tr -d '()')"
  echo "  info  footprint after 1 capture: $f0, 21: $f20, 41: $f40; windows: $("$CTL" windows "$PID" | wc -l | tr -d ' ')"
  footprint "$PID" 2>/dev/null | awk '/^ *[0-9.]+ [KMG]B/ && NR > 3' | head -8 | sed 's/^/        /'
  sleep 5
  cpu=$(ps -o %cpu= -p "$PID" | tr -d ' ')
  echo "  info  idle CPU ${cpu}%"
  check "Bento alive after memory phase" alive
}

phases=("$@")
[ ${#phases[@]} -eq 0 ] && phases=(overlay modes windows scroll memory)
status=0
for p in "${phases[@]}"; do
  run_phase "$p"; rc=$?
  [ $rc = 75 ] && { echo "phase $p interrupted by the user; re-run: $0 $p"; status=75; break; }
done
echo "failures: $TOTAL_FAIL"
[ $status = 75 ] && exit 75
[ "$TOTAL_FAIL" = 0 ]
