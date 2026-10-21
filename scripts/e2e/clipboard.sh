#!/bin/bash
# Clipboard regression tests against the real Bento app (debug build, raw binary).
#
#   scripts/e2e/clipboard.sh stress   Headless, safe while the user works: only the clipboard module, no
#                                     hotkeys, no menu bar icon, recording a private named pasteboard
#                                     (never the user's clipboard). Every capture type, concealed/transient,
#                                     dedupe, 100 copies/s, 10 MB text, 8k images, OCR queue, kill -9
#                                     mid-write, missing image, corrupt DB, 2,000 items with retention/size
#                                     caps/pins, idle CPU and memory.
#   scripts/e2e/clipboard.sh gui      GUI session (scripts/e2e/session): the full app with real hotkeys,
#                                     every panel keyboard flow, pasting into our own TextEdit document
#                                     (/tmp/clipboard-qa.txt) and into Bento's Notes window, rapid
#                                     open/close, missing image, 10 MB text, 8k image. Saves and restores
#                                     the user's clipboard; test copies are marked transient.
#   scripts/e2e/clipboard.sh scale    GUI session: 2,000 seeded items; panel open/search timings, paging
#                                     through the list (lazy thumbnails), memory after browsing.
# Exits non-zero on failure. Logs: /tmp/bento-e2e-clipboard*/.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-gui}"
PBT=/tmp/clipboard-pb
CTL=/tmp/bentoctl
BIN="${BENTO_BIN:-$ROOT/.build/debug/Bento}" # BENTO_BIN: test another build (skips building)
FAILS=0
APP=""

say()  { printf '%s\n' "$*"; }
ok()   { say "  ok    $*"; }
bad()  { say "  FAIL  $*"; FAILS=$((FAILS + 1)); }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
eq()   { [ "$1" = "$2" ] || { say "        got '$1', want '$2'"; return 1; }; }
le()   { [ "$1" -le "$2" ] 2>/dev/null || { say "        got $1, want <= $2"; return 1; }; }
ge()   { [ "$1" -ge "$2" ] 2>/dev/null || { say "        got $1, want >= $2"; return 1; }; }
q()    { sqlite3 -readonly "$DB" "$1" 2>/dev/null; }
alive() { [ -n "$APP" ] && kill -0 "$APP" 2>/dev/null; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# wait_q <sql> <expected> [timeout-s]
wait_q() {
  local end=$(( $(date +%s) + ${3:-10} ))
  while [ "$(date +%s)" -le "$end" ]; do [ "$(q "$1")" = "$2" ] && return 0; sleep 0.2; done
  say "        waited for [$1] = '$2', last '$(q "$1")'"; return 1
}

# Image/thumbnail files that no row references.
orphan_files() {
  local refs; refs=$(q "SELECT image_file FROM items WHERE image_file IS NOT NULL UNION SELECT thumb_file FROM items WHERE thumb_file IS NOT NULL")
  { ls "$IMG"; ls "$HOMEDIR/support/Clipboard/thumbs"; } | sort -u | comm -23 - <(printf '%s\n' "$refs" | sort -u) | grep -c .
}

footprint_mb() { footprint "$APP" 2>/dev/null | awk '/phys_footprint:/ {v=$2; u=$3; if (u ~ /KB/) v/=1024; if (u ~ /GB/) v*=1024; printf "%d", v; exit}'; }
cpu_seconds() { ps -o time= -p "$APP" | awk -F: '{ if (NF == 3) print $1*3600 + $2*60 + $3; else print $1*60 + $2 }'; }
# cpu_percent <seconds>: average CPU over an interval
cpu_percent() {
  local a b; a=$(cpu_seconds); sleep "$1"; b=$(cpu_seconds)
  python3 -c "print(round(($b - $a) / $1 * 100, 2))"
}

build() {
  if [ -n "${BENTO_BIN:-}" ]; then say "using $BIN"; else
    say "building…"
    (cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|Build of product") || exit 1
  fi
  [ "$PBT" -nt "$ROOT/scripts/e2e/clipboard-pb.swift" ] || swiftc -O "$ROOT/scripts/e2e/clipboard-pb.swift" -o "$PBT" || exit 1
  [ "$CTL" -nt "$ROOT/scripts/e2e/bentoctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/bentoctl.swift" -o "$CTL" || exit 1
}

# fresh_home <dir> <stress|gui>
fresh_home() {
  HOMEDIR="$1"; DB="$HOMEDIR/support/Clipboard/history.sqlite"; IMG="$HOMEDIR/support/Clipboard/images"
  rm -rf "$HOMEDIR"; mkdir -p "$HOMEDIR/config"
  local general='{}' shortcuts='{}'
  if [ "$2" = stress ]; then
    general='{"enabledModules": {"shot": false, "windows": false, "tiling": false, "launcher": false, "notes": false, "clipboard": true}, "showMenuBarIcon": false}'
    shortcuts='{"clipboard.show": ""}'
  fi
  # Notes sync must never reach the real server (it holds the user's notes).
  cat > "$HOMEDIR/config/config.json" <<EOF
{ "general": $general, "shortcuts": $shortcuts,
  "notes": { "sync": { "enabled": false, "server": "http://127.0.0.1:9", "tokenFile": "$HOMEDIR/no-token" } } }
EOF
}

launch() {
  env BENTO_HOME="$HOMEDIR" BENTO_DEV=1 "$@" "$BIN" >>"$HOMEDIR/app.log" 2>&1 &
  APP=$!
  for _ in $(seq 1 60); do [ -f "$DB" ] && break; sleep 0.25; done
  sleep 1
}
stop_app() { [ -n "$APP" ] && { kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; }; APP=""; }

set_config() { # set_config <python expression on dict c>
  python3 - "$HOMEDIR/config/config.json" "$1" <<'EOF'
import json, sys
p, expr = sys.argv[1], sys.argv[2]
c = json.load(open(p))
c.setdefault("clipboard", {})
exec(expr)
json.dump(c, open(p, "w"), indent=2)
EOF
}

# ---------------------------------------------------------------------------------------------------
stress() {
  build
  fresh_home /tmp/bento-e2e-clipboard-stress stress
  PBN="com.charles.bento.qa.stress-$$"
  W() { "$PBT" --pb "$PBN" "$@" >/dev/null; }
  launch BENTO_CLIPBOARD_PASTEBOARD="$PBN"
  check "app running" alive

  say "capture: every type"
  W write text "plain hello"; sleep 1.1
  W write rtf "rich red bold"; sleep 1.1
  W write html "html bold"; sleep 1.1
  W write link "https://www.apple.com/mac/" "Mac - Apple"; sleep 1.1
  W write color "#0A84FF"; sleep 1.1
  W write files /etc/hosts /etc/passwd; sleep 1.1
  W write png 640 480; sleep 1.1
  W write tiff 300 200; sleep 1.1
  W write gif 4; sleep 1.1
  W write concealed "secret-pw"; sleep 1.1
  W write typeless; sleep 1.1
  W write empty; sleep 1.1
  W write promised; sleep 1
  W write text "plain hello"; sleep 1.5
  check "kinds" eq "$(q "SELECT group_concat(kind || ':' || n, ' ') FROM (SELECT kind, COUNT(*) n FROM items GROUP BY kind ORDER BY kind)")" "color:1 file:1 image:3 link:1 text:3"
  check "dedupe bumps copy count" eq "$(q "SELECT copy_count FROM items WHERE title = 'plain hello'")" "2"
  check "concealed not recorded" eq "$(q "SELECT COUNT(*) FROM items WHERE text LIKE '%secret%'")" "0"
  check "rich text keeps RTF" eq "$(q "SELECT rtf IS NOT NULL FROM items WHERE title = 'rich red bold'")" "1"
  check "HTML kept" eq "$(q "SELECT html IS NOT NULL FROM items WHERE title = 'html bold'")" "1"
  check "link title" eq "$(q "SELECT link_title FROM items WHERE kind = 'link'")" "Mac - Apple"
  check "files" eq "$(q "SELECT title FROM items WHERE kind = 'file'")" "2 Files: hosts, passwd"
  check "TIFF stored as PNG" eq "$(q "SELECT image_type FROM items WHERE title = 'Image (300×200)'")" "public.png"
  check "GIF kept as GIF" eq "$(q "SELECT image_type FROM items WHERE title = 'Image (120×80)'")" "com.compuserve.gif"
  check "source app recorded" eq "$(q "SELECT COUNT(*) FROM items WHERE source_app IS NULL")" "0"
  check "OCR finishes" wait_q "SELECT COUNT(*) FROM items WHERE kind = 'image' AND ocr_done = 0" "0" 40
  check "OCR finds text" eq "$(q "SELECT COUNT(*) FROM items WHERE ocr_text LIKE '%Bento QA%'")" "3"

  say "volume: 100 copies in ~1.5 s"
  local before; before=$(q "SELECT COUNT(*) FROM items")
  W burst 100 5 "burst item"; sleep 1.5
  local n; n=$(q "SELECT COUNT(*) FROM items WHERE title LIKE 'burst item%'")
  check "coalesced to a few captures ($n)" le "$n" 8
  check "final state recorded" eq "$(q "SELECT COUNT(*) FROM items WHERE title = 'burst item 99'")" "1"
  check "still running" alive

  say "volume: 10 MB text"
  local big="$HOMEDIR/big.txt"
  yes "Bento QA huge text line with some words" | head -c 10485760 > "$big"
  local m0 t0 t1; m0=$(footprint_mb); t0=$(now_ms)
  W write textfile "$big"
  check "10 MiB text recorded" wait_q "SELECT COUNT(*) FROM items WHERE byte_size = 10485760" "1" 15
  t1=$(now_ms); say "        captured in $((t1 - t0)) ms (incl. ≤1 s poll); footprint ${m0} -> $(footprint_mb) MB"
  printf 'x' >> "$big"
  W write textfile "$big"; sleep 2
  check "10 MiB + 1 byte skipped" eq "$(q "SELECT COUNT(*) FROM items WHERE byte_size > 10485760")" "0"

  say "volume: images"
  m0=$(footprint_mb); t0=$(now_ms)
  W write png 8192 8192
  check "8192x8192 PNG recorded" wait_q "SELECT COUNT(*) FROM items WHERE width = 8192 AND height = 8192" "1" 20
  t1=$(now_ms)
  say "        stored in $((t1 - t0)) ms (incl. ≤1 s poll)"
  check "8k OCR finishes" wait_q "SELECT ocr_done FROM items WHERE width = 8192" "1" 60
  sleep 3; local after8k; after8k=$(footprint_mb)
  say "        footprint ${m0} -> ${after8k} MB after storing + OCR (peak $(footprint "$APP" 2>/dev/null | awk '/phys_footprint_peak:/ {print $2, $3}'))"
  check "memory returns after 8k image (<= 120 MB)" le "${after8k:-999}" 120
  W write png 4600 4600 noise; sleep 4
  check "~60 MiB image skipped (limit 50 MB)" eq "$(q "SELECT COUNT(*) FROM items WHERE width = 4600")" "0"
  W write png 2600 2600 noise
  check "27 MiB noise image recorded" wait_q "SELECT COUNT(*) FROM items WHERE width = 2600" "1" 30
  check "OCR queue drains" wait_q "SELECT COUNT(*) FROM items WHERE kind = 'image' AND ocr_done = 0" "0" 60
  local orphans; orphans=$(orphan_files)
  check "no stray image files" eq "$orphans" "0"

  say "idle"
  sleep 3
  local idle; idle=$(cpu_percent 20)
  say "        idle CPU over 20 s: ${idle}%  footprint $(footprint_mb) MB"
  check "idle CPU < 0.5%" python3 -c "import sys; sys.exit(0 if $idle < 0.5 else 1)"

  say "robustness: missing image file"
  local victim; victim=$(q "SELECT image_file FROM items WHERE title = 'Image (640×480)'")
  rm -f "$IMG/$victim"
  sqlite3 "$DB" "UPDATE items SET ocr_done = 0 WHERE image_file = '$victim'"
  W write png 320 240; sleep 1
  check "OCR skips the missing file" wait_q "SELECT ocr_done FROM items WHERE image_file = '$victim'" "1" 30
  check "still running" alive

  say "robustness: kill -9 while images are being written"
  ( for i in 1 2 3 4 5 6; do "$PBT" --pb "$PBN" write png 3000 2000 >/dev/null; sleep 0.45; done ) &
  local writer=$!
  sleep 2.2; kill -9 "$APP"; wait "$APP" 2>/dev/null; APP=""
  wait "$writer" 2>/dev/null
  check "integrity after kill" eq "$(sqlite3 "$DB" "PRAGMA integrity_check")" "ok"
  launch BENTO_CLIPBOARD_PASTEBOARD="$PBN"
  check "relaunched" alive
  orphans=$(orphan_files)
  check "orphans removed at launch" eq "$orphans" "0"
  W write text "after kill"; sleep 1.2
  check "records after relaunch" eq "$(q "SELECT COUNT(*) FROM items WHERE title = 'after kill'")" "1"

  say "robustness: corrupt database"
  stop_app
  printf 'this is not a database, it has been overwritten by something' | dd of="$DB" bs=1 seek=0 conv=notrunc 2>/dev/null
  launch BENTO_CLIPBOARD_PASTEBOARD="$PBN"
  check "starts with a corrupt DB" alive
  check "corrupt file kept aside" ge "$(ls "$HOMEDIR/support/Clipboard" | grep -c '^history.corrupt-')" 1
  W write text "after corruption"; sleep 1.2
  check "records after corruption" eq "$(q "SELECT COUNT(*) FROM items WHERE title = 'after corruption'")" "1"
  check "old images cleaned up" eq "$(ls "$IMG" | wc -l | tr -d ' ')" "0"

  say "scale: 2,000 items (retention 30 days, 200 images pending OCR, 3 old pins)"
  stop_app
  rm -f "$DB" "$DB-wal" "$DB-shm"; rm -rf "$IMG"/* "$HOMEDIR/support/Clipboard/thumbs"/*
  launch BENTO_CLIPBOARD_PASTEBOARD="$PBN"; stop_app # creates the schema
  "$PBT" seed "$DB" "$IMG" "$HOMEDIR/support/Clipboard/thumbs" 2000 10 >/dev/null
  # Items are ~25 min apart (not exactly, so none sits on the 30-day boundary), so ~270 are older than 30 days; pin three of those.
  sqlite3 "$DB" "UPDATE items SET last_copied = strftime('%s','now') - (id - 1) * 1501.0, first_copied = strftime('%s','now') - (id - 1) * 1501.0;
                 UPDATE items SET pinned = 1, pinned_at = strftime('%s','now') WHERE id IN (1950, 1960, 1970);"
  local expect_kept; expect_kept=$(sqlite3 "$DB" "SELECT COUNT(*) FROM items WHERE pinned = 1 OR last_copied >= strftime('%s','now') - 30 * 86400")
  t0=$(now_ms)
  launch BENTO_CLIPBOARD_PASTEBOARD="$PBN"
  check "retention prunes at launch" wait_q "SELECT COUNT(*) FROM items" "$expect_kept" 10
  say "        launch + prune of $((2000 - expect_kept)) items: $(( $(now_ms) - t0 )) ms (incl. 1 s settle)"
  check "old pins kept" eq "$(q "SELECT COUNT(*) FROM items WHERE pinned = 1")" "3"
  orphans=$(orphan_files)
  check "pruned items' images deleted" eq "$orphans" "0"
  # LIKE search over all rows, the shape the panel uses
  local qt; qt=$( { time -p sqlite3 -readonly "$DB" "SELECT id FROM items WHERE (title LIKE '%smørrebrød%' OR text LIKE '%smørrebrød%' OR ocr_text LIKE '%smørrebrød%' OR link_title LIKE '%smørrebrød%' OR source_app LIKE '%smørrebrød%') ORDER BY pinned DESC, CASE WHEN pinned = 1 THEN pinned_at END ASC, last_copied DESC LIMIT 120" >/dev/null; } 2>&1 | awk '/real/ {print $2}')
  say "        search query over $(q "SELECT COUNT(*) FROM items") rows (sqlite3 CLI, incl. startup): ${qt}s"
  say "        OCR backlog: $(q "SELECT COUNT(*) FROM items WHERE kind = 'image' AND ocr_done = 0") images (starts 10 s after launch)"
  local c; c=$(cpu_percent 20)
  say "        CPU while working through the OCR backlog: ${c}% (background QoS)"
  check "OCR backlog progresses" python3 -c "import sys; sys.exit(0 if int('$(q "SELECT COUNT(*) FROM items WHERE kind = 'image' AND ocr_done = 1")') > 5 else 1)"

  say "scale: caps (live config changes)"
  set_config 'c["clipboard"]["maxItems"] = 100'
  check "item cap" wait_q "SELECT COUNT(*) FROM items WHERE pinned = 0" "100" 5
  check "pins survive the cap" eq "$(q "SELECT COUNT(*) FROM items WHERE pinned = 1")" "3"
  set_config 'c["clipboard"]["maxStorageMB"] = 1; c["clipboard"]["maxItems"] = 2000'
  sleep 1.5
  check "size cap (unpinned <= 1 MiB)" le "$(q "SELECT COALESCE(SUM(byte_size), 0) FROM items WHERE pinned = 0")" 1048576
  check "pins survive the size cap" eq "$(q "SELECT COUNT(*) FROM items WHERE pinned = 1")" "3"
  orphans=$(orphan_files)
  check "capped items' images deleted" eq "$orphans" "0"
  say "        DB $(du -h "$DB" | cut -f1), images $(du -sh "$IMG" | cut -f1), footprint $(footprint_mb) MB"

  stop_app
  "$PBT" release "$PBN"
}

# ---------------------------------------------------------------------------------------------------
# GUI session helpers
DOC=/tmp/clipboard-qa.txt
DOCNAME=clipboard-qa.txt
SAVED=/tmp/clipboard-qa-saved-pasteboard.plist
SESSION=0

end_session() {
  stop_app
  as5 -e "tell application \"TextEdit\" to close (every document whose name is \"$DOCNAME\") saving no" >/dev/null 2>&1
  [ -f "$SAVED" ] && "$PBT" restore "$SAVED" >/dev/null && rm -f "$SAVED"
  [ "$SESSION" = 1 ] && "$ROOT/scripts/e2e/session" end clipboard
  SESSION=0
}

abort_if_user() { # bentoctl/clipboard-pb exit 75 = the user is back
  if [ "$1" = 75 ] || [ -f /tmp/bento-user-active ]; then
    say "user input detected: stopping (retry later)"; end_session; exit 75
  fi
}
K() { "$CTL" key "$@" --expect com.apple.TextEdit >/dev/null; local r=$?; abort_if_user $r; [ $r = 0 ] || { say "        key $* refused"; return 1; }; }
KB() { "$PBT" key --expect-pid "$APP" "$@" >/dev/null; local r=$?; abort_if_user $r; [ $r = 0 ] || { say "        key $* refused"; return 1; }; }
G() { "$PBT" write "$@" >/dev/null; } # general pasteboard, transient + dev markers
as5() { perl -e 'alarm 5; exec @ARGV' osascript "$@"; } # AppleScript with a 5 s limit (a stuck TextEdit must not hold the session)
doc_text() { as5 -e "tell application \"TextEdit\" to get text of (first document whose name is \"$DOCNAME\")" 2>/dev/null; }
doc_clear() { as5 -e "tell application \"TextEdit\" to set text of (first document whose name is \"$DOCNAME\") to \"\"" >/dev/null 2>&1; }
front_doc() { "$CTL" front com.apple.TextEdit "$DOCNAME" >/dev/null 2>&1; sleep 0.2; }
panel_open() { "$CTL" windows Bento 2>/dev/null | grep -q "Clipboard History"; }
panel_id() { "$CTL" windows Bento 2>/dev/null | awk '/Clipboard History/ {print $1; exit}'; }
wait_panel() { # wait_panel open|closed
  for _ in $(seq 1 30); do
    if [ "$1" = open ]; then panel_open && return 0; else panel_open || return 0; fi
    sleep 0.1
  done
  say "        panel did not become $1"; return 1
}
open_panel() { front_doc; K cmd+shift+v && wait_panel open; sleep 0.3; }
pb_string() { "$PBT" info | sed -n 's/^string //p'; }
pb_types() { "$PBT" info | sed -n 's/^types //p'; }
wait_doc() { # wait_doc <expected>
  for _ in $(seq 1 30); do [ "$(doc_text)" = "$1" ] && return 0; sleep 0.1; done
  say "        doc is '$(doc_text | head -c 80)', want '$1'"; return 1
}

start_gui() {
  build
  "$ROOT/scripts/e2e/session" start clipboard || exit 1
  SESSION=1
  trap 'end_session' EXIT
  trap 'end_session; exit 130' INT TERM
  "$PBT" save "$SAVED" >/dev/null
  printf '' > "$DOC"
  open -a TextEdit "$DOC"
  for _ in $(seq 1 40); do "$CTL" frame com.apple.TextEdit "$DOCNAME" >/dev/null 2>&1 && break; sleep 0.25; done
}

gui() {
  fresh_home /tmp/bento-e2e-clipboard gui
  start_gui
  launch
  check "app running" alive
  log stream --level debug --process "$APP" --predicate 'category == "clipboard"' > "$HOMEDIR/timings.log" 2>/dev/null &
  local logger=$!

  say "copy a known sequence"
  G text "QA-alpha"; sleep 1.1
  G link "https://example.com/qa-link" "QA Link"; sleep 1.1
  G color "#FF8800"; sleep 1.1
  G rtf "QA-rich"; sleep 1.1
  G text "QA-beta"; sleep 1.1
  G text "QA-gamma"; sleep 1.2
  check "6 items recorded" eq "$(q "SELECT COUNT(*) FROM items")" "6"
  # order now: gamma beta rich color link alpha

  say "↵ pastes the top item into TextEdit"
  doc_clear; open_panel
  K return; check "pasted QA-gamma" wait_doc "QA-gamma"; check "panel closed" wait_panel closed

  say "↓ ↵"
  doc_clear; open_panel; K down return
  check "pasted QA-beta" wait_doc "QA-beta"       # beta gamma rich color link alpha

  say "⌃N ⌃N ⌃P ↵"
  doc_clear; open_panel; K ctrl+n ctrl+n ctrl+p return
  check "pasted QA-gamma" wait_doc "QA-gamma"     # gamma beta rich color link alpha

  say "⌘3 pastes the third row (rich text keeps RTF)"
  doc_clear; open_panel; K cmd+3
  check "pasted QA-rich" wait_doc "QA-rich"       # rich gamma beta color link alpha
  check "pasteboard has RTF" bash -c "\"$PBT\" info | grep -q 'public.rtf'"

  say "⌘↵ copies without pasting"
  doc_clear; open_panel; K down down cmd+return
  check "panel closed" wait_panel closed
  sleep 0.4
  check "doc untouched" eq "$(doc_text)" ""
  check "clipboard holds QA-beta" eq "$(pb_string)" "QA-beta" # beta rich gamma color link alpha

  say "⇧↵ pastes rich text as plain text"
  doc_clear; open_panel; K down shift+return
  check "pasted QA-rich" wait_doc "QA-rich"       # rich beta gamma color link alpha
  check "no RTF on the pasteboard" bash -c "! \"$PBT\" info | grep -q 'public.rtf'"

  say "typing searches"
  doc_clear; open_panel; K a l p h a; sleep 0.3; K return
  check "pasted QA-alpha" wait_doc "QA-alpha"     # alpha rich beta gamma color link

  say "⌘P cycles the filter (All → Text → Images → Links)"
  doc_clear; open_panel; K cmd+p cmd+p cmd+p; sleep 0.2; K return
  check "pasted the link" wait_doc "https://example.com/qa-link" # link alpha rich beta gamma color

  say "⇧⌘P pins"
  open_panel; K down cmd+shift+p; sleep 0.3
  check "QA-alpha pinned" eq "$(q "SELECT pinned FROM items WHERE title = 'QA-alpha'")" "1"
  K escape; check "Esc closes" wait_panel closed  # alpha* link rich beta gamma color

  say "⌘⌫ and ⌃X delete"
  open_panel; K down cmd+delete; sleep 0.3; K ctrl+x; sleep 0.3; K escape
  check "link and rich deleted" eq "$(q "SELECT COUNT(*) FROM items WHERE title IN ('QA Link', 'QA-rich')")" "0"
  # alpha* beta gamma color

  say "deleting the last row"
  doc_clear; open_panel; K cmd+down cmd+delete; sleep 0.3; K return
  check "colour deleted" eq "$(q "SELECT COUNT(*) FROM items WHERE kind = 'color'")" "0"
  check "selection moved to the new last row" wait_doc "QA-gamma" # alpha* gamma beta

  say "zero results: every key is harmless"
  local count; count=$(q "SELECT COUNT(*) FROM items")
  doc_clear; open_panel; K z z z q; sleep 0.3; K return cmd+1 ctrl+x cmd+shift+p down up cmd+k; sleep 0.4; K escape; sleep 0.3
  K escape; sleep 0.3
  check "first Esc clears the search (panel stays open)" panel_open
  K escape
  check "second Esc closes" wait_panel closed
  check "nothing deleted" eq "$(q "SELECT COUNT(*) FROM items")" "$count"
  check "doc untouched" eq "$(doc_text)" ""
  check "still running" alive

  say "⌘⌫ with search text edits the search instead of deleting"
  doc_clear; open_panel; K g a m; sleep 0.3; K cmd+delete; sleep 0.3
  check "nothing deleted" eq "$(q "SELECT COUNT(*) FROM items")" "$count"
  K return
  check "search cleared: ↵ pasted the first row (pinned QA-alpha)" wait_doc "QA-alpha"

  say "⌘K opens the actions menu; Esc closes menu, then panel"
  open_panel; K cmd+k; sleep 0.5
  check "menu open" bash -c "\"$CTL\" windows Bento | awk '\$2 >= 101' | grep -q ."
  K escape; sleep 0.3
  check "panel still open after closing the menu" panel_open
  K escape; check "panel closed" wait_panel closed

  say "rapid open/close"
  local m0 m1; front_doc; m0=$(footprint_mb)
  for _ in 1 2 3 4; do K cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v cmd+shift+v; done
  sleep 0.5
  check "ends closed after 40 toggles" wait_panel closed
  check "still running" alive
  sleep 1; m1=$(footprint_mb); say "        footprint ${m0} -> ${m1} MB after 40 toggles"

  say "missing image file"
  G png 900 600; check "image recorded" wait_q "SELECT COUNT(*) FROM items WHERE width = 900" "1" 10
  rm -f "$IMG/$(q "SELECT image_file FROM items WHERE width = 900")"
  # rows: QA-alpha (pinned), the image, …
  doc_clear; open_panel; K down; sleep 0.6
  screencapture -x -o -l "$(panel_id)" "$HOMEDIR/missing-image.png" 2>/dev/null && say "        screenshot: $HOMEDIR/missing-image.png"
  K return; sleep 0.5
  check "panel stays open (nothing to paste)" panel_open
  check "doc untouched" eq "$(doc_text)" ""
  K escape; wait_panel closed
  check "still running" alive

  say "10 MB text: selecting it does not block the panel"
  yes "Bento QA huge text line with some words" | head -c 10000000 > "$HOMEDIR/big.txt"
  G textfile "$HOMEDIR/big.txt"; check "big text recorded" wait_q "SELECT COUNT(*) FROM items WHERE byte_size = 10000000" "1" 15
  open_panel; local t0; t0=$(now_ms); K down escape; wait_panel closed; local t1; t1=$(now_ms)
  say "        ↓ (select 10 MB item) + Esc → closed in $((t1 - t0)) ms"
  check "panel responsive with 10 MB item (< 800 ms)" le $((t1 - t0)) 800

  say "8k image preview"
  m0=$(footprint_mb)
  G png 8192 8192; check "8k image recorded" wait_q "SELECT COUNT(*) FROM items WHERE width = 8192" "1" 30
  open_panel; K down; sleep 2.5
  screencapture -x -o -l "$(panel_id)" "$HOMEDIR/8k-preview.png" 2>/dev/null
  m1=$(footprint_mb); K escape; wait_panel closed; sleep 2
  say "        footprint ${m0} -> ${m1} (panel open) -> $(footprint_mb) MB (closed)"

  say "paste into Bento's own Notes window"
  doc_clear; front_doc; K ctrl+opt+n; sleep 1.2
  if [ "$("$PBT" frontpid)" = "$APP" ]; then
    KB cmd+a delete; sleep 0.3   # empty the note we just opened (our own instance)
    KB cmd+shift+v; wait_panel open; sleep 0.3
    KB return; sleep 1.5
    if [ -n "${BENTO_BIN:-}" ] || grep -q "func pastePlain" "$ROOT/Sources/Notes/NoteTextView.swift"; then
      check "pasted into the note" bash -c "sqlite3 -readonly '$HOMEDIR/support/Notes/notes.sqlite' \"SELECT body FROM notes WHERE deleted = 0\" | grep -q 'QA-alpha'"
    else
      say "  skip  pasted into the note (Notes' own ⌘V does nothing before the Notes fix 814eb7f)"
    fi
    check "not into TextEdit" eq "$(doc_text)" ""
    check "Bento still frontmost" eq "$("$PBT" frontpid)" "$APP"
    KB escape 2>/dev/null; sleep 0.3
  else
    bad "notes window did not take focus (front pid $("$PBT" frontpid))"
  fi

  kill "$logger" 2>/dev/null
  local shows; shows=$(grep -o 'panel shown in [0-9.]*' "$HOMEDIR/timings.log" | awk '{print $4}' | sort -n | tail -1)
  local slow; slow=$(grep -o 'rows: [0-9]* in [0-9.]*' "$HOMEDIR/timings.log" | awk '{print $4}' | sort -n | tail -1)
  say "        slowest panel show ${shows:-?} ms, slowest list query ${slow:-?} ms"
  end_session
}

scale() {
  fresh_home /tmp/bento-e2e-clipboard-scale gui
  # Build and seed before taking the session, so the session stays short.
  build
  env BENTO_HOME="$HOMEDIR" BENTO_DEV=1 BENTO_CLIPBOARD_PASTEBOARD="com.charles.bento.qa.scale-$$" "$BIN" >>"$HOMEDIR/app.log" 2>&1 &
  APP=$!; for _ in $(seq 1 60); do [ -f "$DB" ] && break; sleep 0.25; done; sleep 1; stop_app
  "$PBT" seed "$DB" "$IMG" "$HOMEDIR/support/Clipboard/thumbs" 2000 8 >/dev/null
  sqlite3 "$DB" "UPDATE items SET ocr_done = 1"  # OCR backlog is covered by 'stress'
  start_gui
  launch
  log stream --level debug --process "$APP" --predicate 'category == "clipboard"' > "$HOMEDIR/timings.log" 2>/dev/null &
  local logger=$!
  sleep 1
  check "2,000 items" eq "$(q "SELECT COUNT(*) FROM items")" "2000"
  local m0; m0=$(footprint_mb)

  say "browse: page through ~450 rows (lazy thumbnails, more pages load), twice"
  local cycle m1 open_mb=()
  for cycle in 1 2; do
    open_panel
    for _ in $(seq 1 5); do K pagedown pagedown pagedown pagedown pagedown pagedown pagedown pagedown pagedown pagedown; sleep 0.3; done
    K cmd+down; sleep 0.8; K cmd+down; sleep 0.8; K cmd+down; sleep 0.8
    m1=$(footprint_mb)
    if [ "$cycle" = 1 ]; then # where the memory goes while browsing (our instance only)
      footprint "$APP" > "$HOMEDIR/footprint-browsing.txt" 2>&1
      heap -s -H "$APP" 2>/dev/null | head -60 > "$HOMEDIR/heap-browsing.txt"
    fi
    K escape; wait_panel closed; sleep 1.5
    open_mb+=("$m1"); eval "closed_$cycle=$(footprint_mb)"
    check "still running" alive
  done
  say "        footprint ${m0} -> ${open_mb[0]} (browsing) -> ${closed_1} (closed) -> ${open_mb[1]} (browsing again) -> ${closed_2} MB (closed)"
  check "memory stable across browse cycles (second <= first + 10 MB)" le "${closed_2:-999}" $(( ${closed_1:-0} + 10 ))

  say "search 2,000 items"
  doc_clear; open_panel
  K f o x t r o t space h o t e l; sleep 0.5
  K return
  check "pasted a search hit" bash -c "\"$0\" _doc_has foxtrot"
  wait_panel closed

  say "open/close timing with 2,000 items"
  for _ in 1 2 3 4 5; do open_panel; K escape; wait_panel closed; done
  kill "$logger" 2>/dev/null
  say "        panel show ms: $(grep -o 'panel shown in [0-9.]*' "$HOMEDIR/timings.log" | awk '{print $4}' | tr '\n' ' ')"
  say "        list query ms (max): $(grep -o 'rows: [0-9]* in [0-9.]*' "$HOMEDIR/timings.log" | awk '{print $4}' | sort -n | tail -1)"
  say "        search query ms: $(grep 'query [1-9]' "$HOMEDIR/timings.log" | grep -o 'in [0-9.]* ms' | awk '{print $2}' | tr '\n' ' ')"
  local worst; worst=$(grep -o 'rows: [0-9]* in [0-9.]*' "$HOMEDIR/timings.log" | awk '{print int($4)}' | sort -n | tail -1)
  check "every list query < 50 ms" le "${worst:-999}" 50
  end_session
}

case "$MODE" in
  stress) stress ;;
  gui) gui ;;
  scale) scale ;;
  _doc_has) doc_text | grep -q "$2"; exit $? ;;
  *) say "usage: $0 stress|gui|scale"; exit 2 ;;
esac
say ""
[ "$FAILS" = 0 ] && say "clipboard e2e ($MODE): all checks passed" || say "clipboard e2e ($MODE): $FAILS check(s) FAILED"
[ "$FAILS" = 0 ]
