#!/bin/bash
# Keyboard overview (⌃⌥/) end-to-end regression on the real, full app.
#   scripts/e2e/overview.sh [phase ...]    phases: keys menu dark permissions (default: all)
# keys: launch hint, opening by hotkey/action, search, arrows, Return runs the action on the app
#       underneath (Left Half on this script's TextEdit document), toggle, Esc, ⌘, / ⌘E / ⇧⌘, and the
#       section links into the right Settings page, teardown on close. Screenshots (light) and checks.
# menu: Keyboard Shortcuts… in the menu bar menu shows ⌃⌥/ and opens the panel.
# dark: the panel in dark mode (screenshots). permissions: an instance without this shell's
#       Accessibility/Screen Recording grants: the header warns and its button opens Settings.
# Each phase runs in its own short GUI session (scripts/e2e/session). E2E_EXTERNAL_SESSION=1: the
# caller holds the GUI lock and runs the input guard instead (the installed Bento may keep running:
# the panel opens through dev notifications, and with OVERVIEW_REAL_HOTKEY=1 through ⌃⌥/ when the
# installed app doesn't own it). Input only goes to the test's TextEdit document /tmp/overview-qa.txt
# and the Bento under test. Screenshots: $OVERVIEW_SHOTS (default /tmp/bento-overview-shots).
# Exit 0 = passed, 1 = failed, 75 = the user came back (retry later).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WHO=overview
BH=/tmp/bento-e2e-overview
CTL=/tmp/overview-ctl
BCTL=/tmp/bentoctl
TE=com.apple.TextEdit
DOC=/tmp/overview-qa.txt
BIN="${BENTO_BIN:-$ROOT/.build/debug/Bento}"
SHOTS="${OVERVIEW_SHOTS:-/tmp/bento-overview-shots}"
DIAG="$BH/support/diagnostics.json"
PHASES=("$@")
[ ${#PHASES[@]} -eq 0 ] && PHASES=(keys menu dark permissions)

FAILS=0
PID=
IN_SESSION=0

log() { echo "[overview-e2e] $*"; }
fail() { log "FAIL: $*"; FAILS=$((FAILS + 1)); }
ok() { log "ok: $*"; }

guard_check() {
  if ! "$ROOT/scripts/e2e/session" check >/dev/null; then
    log "user is active, stopping"; cleanup; exit 75
  fi
}
alive() { kill -0 "$PID" 2>/dev/null || { log "FAIL: Bento (pid $PID) died"; FAILS=$((FAILS + 1)); cleanup; exit 1; }; }

# key <combo> [te|bento] [sleep]: te = the overview panel over TextEdit (it doesn't activate
# Bento, so TextEdit stays frontmost), bento = a Bento window that activated the app (Settings).
key() {
  guard_check
  local rc
  if [ "${2:-te}" = bento ]; then
    $BCTL key "$1" --expect-pid "$PID" >/dev/null; rc=$?
  else
    [ "$($BCTL frontmost)" = "$TE" ] || { $BCTL front $TE overview-qa >/dev/null; sleep 0.3; }
    $BCTL key "$1" --expect $TE >/dev/null; rc=$?
  fi
  [ $rc -eq 75 ] && { cleanup; exit 75; }
  [ $rc -ne 0 ] && fail "key $1 (rc $rc)"
  sleep "${3:-0.35}"
}
type_text() { local s="$1" c; for ((i = 0; i < ${#s}; i++)); do c="${s:i:1}"; [ "$c" = " " ] && c=space; key "$c" te 0.12; done; sleep 0.3; }

diag() {
  rm -f "$DIAG"
  $CTL url "$BH" "bento://debug/state"
  for _ in $(seq 1 30); do [ -s "$DIAG" ] && return 0; sleep 0.1; done
  fail "no diagnostics"; return 1
}
q() { python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); o = d["keyboardOverview"]; s = d["settingsWindow"]; r = eval(sys.argv[2]); print(str(r).lower() if isinstance(r, bool) else r)' "$DIAG" "$1"; }
expect() { # expect <python expr on o (overview) / s (settings)> <wanted> <label>
  diag || return 1
  local got; got="$(q "$1")"
  if [ "$got" = "$2" ]; then ok "$3"; else fail "$3: $1 = '$got', wanted '$2'"; fi
}

set_shortcut() { # set_shortcut <action-id> <shortcut>: edit the config file like a user would (applies live)
  python3 -I - "$BH/config/config.json" "$1" "$2" <<'EOF2'
import json, sys
p, i, sc = sys.argv[1:]
d = json.load(open(p))
d.setdefault("shortcuts", {})[i] = sc
open(p, "w").write(json.dumps(d, indent=2))
EOF2
  sleep 1.2
}

shot() { # shot <title> <file>: screenshot of the process's window with that title
  local id; id="$($CTL windows "$PID" | awk -v t="$1" '{ title = ""; for (i = 7; i <= NF; i++) title = title (i > 7 ? " " : "") $i } title == t { print $1; exit }')"
  [ -n "$id" ] || { fail "no window '$1' to screenshot"; return 1; }
  screencapture -x -o -l "$id" "$SHOTS/$2" && log "screenshot $SHOTS/$2"
}

open_overview() {
  [ "$($BCTL frontmost)" = "$TE" ] || { $BCTL front $TE overview-qa >/dev/null; sleep 0.4; }
  if [ "${OVERVIEW_REAL_HOTKEY:-0}" = 1 ]; then key ctrl+opt+slash te 0.6; else $CTL perform bento.keyboard-overview; sleep 0.6; fi
}

launch() { # launch [appearance] [disclaimed] [config-json]
  rm -rf "$BH"; mkdir -p "$BH/config"
  [ -n "${3:-}" ] && echo "$3" > "$BH/config/config.json"
  if [ "${2:-}" = disclaimed ]; then
    PID=$($CTL spawn-disclaimed "$BH/log.txt" /usr/bin/env BENTO_HOME="$BH" BENTO_DEV=1 BENTO_APPEARANCE="${1:-light}" "$BIN")
  else
    BENTO_HOME="$BH" BENTO_DEV=1 BENTO_APPEARANCE="${1:-light}" "$BIN" >"$BH/log.txt" 2>&1 &
    PID=$!
  fi
  for _ in $(seq 1 40); do [ -f "$BH/support/diagnostics.json" ] || $CTL url "$BH" "bento://debug/state"; [ -s "$BH/support/diagnostics.json" ] && break; sleep 0.25; done
  sleep 0.5
  alive
}

begin() {
  log "== phase $1"
  if [ -z "${E2E_EXTERNAL_SESSION:-}" ]; then
    "$ROOT/scripts/e2e/session" start $WHO || exit 1
    IN_SESSION=1
  fi
  guard_check
}

cleanup() {
  [ -n "$PID" ] && { kill "$PID" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done; PID=; }
  osascript -e "tell application \"TextEdit\" to close (every document whose name is \"$(basename "$DOC")\") saving no" >/dev/null 2>&1
  if [ "$TE_WAS_RUNNING" = 0 ]; then
    [ "$(osascript -e 'tell application "TextEdit" to count documents' 2>/dev/null)" = 0 ] && osascript -e 'tell application "TextEdit" to quit' >/dev/null 2>&1
  fi
  [ $IN_SESSION = 1 ] && { "$ROOT/scripts/e2e/session" end $WHO; IN_SESSION=0; }
}

finish() { alive; cleanup; log "== phase $1 done"; }

open_doc() {
  [ -f "$DOC" ] || echo "Bento keyboard overview QA document" > "$DOC"
  open -a TextEdit "$DOC"
  for _ in $(seq 1 20); do $BCTL frame $TE overview-qa >/dev/null 2>&1 && break; sleep 0.25; done
  $BCTL front $TE overview-qa >/dev/null; sleep 0.4
}

trap 'cleanup; exit 130' INT TERM

# ---------------------------------------------------------------- phases

phase_keys() {
  begin keys
  # The launch hint shows once (the raw binary's defaults domain is "Bento").
  defaults delete Bento KeyboardOverviewSeen >/dev/null 2>&1
  open_doc
  launch light
  expect 'o["opened"] == 0 and not o["modelAlive"]' true "nothing exists before the first open"
  local hud=
  for _ in $(seq 1 30); do hud="$($CTL windows "$PID" | awk '$2 > 1000 { print $1; exit }')"; [ -n "$hud" ] && break; sleep 0.15; done
  if [ -n "$hud" ]; then ok "launch hint shown"; screencapture -x -o -l "$hud" "$SHOTS/overview-hint.png"; else fail "no launch hint"; fi
  expect 'o["hintSeen"]' true "hint remembered"

  open_overview
  expect 'o["open"] and o["query"] == "" and o["selected"] == o["listed"][0]' true "opens with the first action selected"
  expect 'o["listed"][0]' shot.area "first action: Capture Area (modules in order, shortcuts first)"
  expect '"windows.left-half" in o["listed"] and "bento.keyboard-overview" in o["listed"]' true "lists module and app actions"
  sleep 0.3; shot "Keyboard Shortcuts" overview-light.png

  type_text left
  expect 'o["query"]' left "search field focused on open: typing filters"
  expect '"windows.left-half" in o["listed"] and all("left" in i or i.startswith("windows.") or i.startswith("tiling.") for i in o["listed"])' true "“left” finds Left Half"
  shot "Keyboard Shortcuts" overview-light-search.png
  key down; expect 'o["selected"] == o["listed"][1]' true "↓ selects the next action"
  key up; expect 'o["selected"] == o["listed"][0]' true "↑ goes back"
  key escape; expect 'o["open"] and o["query"] == ""' true "Esc clears the search first"

  type_text "left half"
  expect 'o["selected"]' windows.left-half "“left half” selects Left Half"
  local before vis
  before="$($BCTL frame $TE overview-qa)"
  key return te 0.9
  expect 'o["open"]' false "↩ closes the panel"
  local after; after="$($BCTL frame $TE overview-qa)"
  # Left-aligned on some display's visible frame.
  vis="$($BCTL screens | awk '{ print $7 }')"
  if [ "$after" != "$before" ] && echo "$vis" | awk -v x="${after%% *}" '{ if (x - $1 <= 2 && $1 - x <= 2) f = 1 } END { exit !f }'; then
    ok "↩ ran Left Half on the TextEdit document underneath ($before -> $after)"
  else
    fail "Left Half didn't apply to TextEdit: $before -> $after (visible x: $(echo $vis))"
  fi
  # shellcheck disable=SC2086
  $BCTL setframe $TE overview-qa $before >/dev/null
  sleep 0.6
  expect 'o["modelAlive"]' false "closed panel is released"

  if [ "${OVERVIEW_REAL_HOTKEY:-0}" = 1 ]; then
    key ctrl+opt+slash te 0.6; expect 'o["open"]' true "⌃⌥/ opens it"
    key ctrl+opt+slash te 0.6; expect 'o["open"]' false "⌃⌥/ again closes it"
  fi

  open_overview; key escape; expect 'o["open"]' false "Esc closes"

  # Live: a shortcut edited in the config file shows up in the open panel, with its problem.
  open_overview; type_text "capture window"
  expect 'o["listed"]' "['shot.window', 'shot.active-window']" "unbound actions in module order"
  set_shortcut shot.active-window cmd+shift+2
  expect 'o["listed"]' "['shot.active-window', 'shot.window']" "a shortcut changed in the config shows up live (bound first)"
  expect '"shot.active-window" in o["problems"]' true "… with why it isn't active (taken by Capture Area)"
  shot "Keyboard Shortcuts" overview-light-live-conflict.png
  key escape; type_text keyboard
  expect 'o["listed"]' "['bento.keyboard-overview']" "the app's own section"
  shot "Keyboard Shortcuts" overview-light-bento.png
  key escape; key escape

  open_overview; key cmd+comma te 1.2
  expect 'not o["open"] and s["open"] and s["page"] == "general"' true "⌘, opens Settings (General)"
  shot "Bento Settings" settings-general.png
  key cmd+w bento 0.8

  open_overview; type_text "left half"; key cmd+e te 1.4
  expect 's["open"] and s["page"] == "shortcuts"' true "⌘E opens Settings → Shortcuts"
  local filter; filter="$($CTL search-value "$PID" "Bento Settings")"
  [ "$filter" = "Left Half" ] && ok "… filtered to “Left Half”" || fail "Shortcuts filter is '$filter'"
  shot "Bento Settings" settings-shortcuts-filtered.png
  key cmd+w bento 0.8

  open_overview; type_text "left half"; key cmd+shift+comma te 1.2
  expect 's["open"] and s["page"] == "module(\"windows\")"' true "⇧⌘, opens the selected action's module settings"
  key cmd+w bento 0.8

  open_overview; type_text clipboard
  $CTL press "$PID" "Clipboard Settings" || fail "no Clipboard Settings link"
  sleep 1.2
  expect 'not o["open"] and s["page"] == "module(\"clipboard\")"' true "a section's Settings link opens that module"
  key cmd+w bento 0.8

  open_overview; type_text tiling
  expect 'o["listed"]' "[]" "an off module is listed by name only"
  $CTL press "$PID" "Turn On in Settings" || fail "no Turn On link for the off Tiling module"
  sleep 1.2
  expect 's["page"] == "module(\"tiling\")"' true "an off module links to its page"
  key cmd+w bento 0.8
  sleep 0.5
  expect 'not o["open"] and o["opened"] == o["closed"] and not o["modelAlive"]' true "every open was torn down"
  finish keys
}

phase_menu() {
  begin menu
  open_doc
  launch light
  local sc; sc="$($CTL menu "$PID" "Keyboard Shortcuts…")" || fail "no Keyboard Shortcuts… in the menu bar menu"
  [ "$sc" = "⌃⌥/" ] && ok "menu item shows ⌃⌥/" || fail "menu item shortcut is '$sc'"
  sleep 0.8
  expect 'o["open"]' true "Keyboard Shortcuts… opens the panel"
  key escape
  expect 'o["open"]' false "Esc closes it"
  finish menu
}

phase_dark() {
  begin dark
  open_doc
  launch dark
  open_overview
  expect 'o["open"]' true "opens (dark)"
  sleep 0.3; shot "Keyboard Shortcuts" overview-dark.png
  type_text window
  shot "Keyboard Shortcuts" overview-dark-search.png
  key escape; key escape
  finish dark
}

phase_permissions() {
  begin permissions
  open_doc
  # Windows off: its modifier-drag event tap isn't wanted without Accessibility.
  launch light disclaimed '{"general": {"enabledModules": {"windows": false}}}'
  # Without Accessibility the app opens Settings at launch; close it so the panel's link is what opens it.
  sleep 1
  diag && [ "$(q 's["open"]')" = true ] && key cmd+w bento 0.6
  $BCTL front $TE overview-qa >/dev/null; sleep 0.4
  open_overview
  expect 'o["open"]' true "opens without permissions"
  shot "Keyboard Shortcuts" overview-no-permissions.png
  $CTL press "$PID" "Grant in Settings…" || fail "no Grant in Settings… button"
  sleep 1.2
  expect 'not o["open"] and s["open"] and s["page"] == "general"' true "the permissions button opens Settings (General)"
  key cmd+w bento 0.6
  finish permissions
}

# ---------------------------------------------------------------- main

TE_WAS_RUNNING=0
pgrep -xq TextEdit && TE_WAS_RUNNING=1
HINT_BEFORE="$(defaults read Bento KeyboardOverviewSeen 2>/dev/null || true)"
mkdir -p "$SHOTS"
if [ -z "${BENTO_BIN:-}" ]; then
  log "building"
  (cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|Build complete" | tail -3) || exit 1
fi
[ $CTL -nt "$ROOT/scripts/e2e/overview-ctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/overview-ctl.swift" -o $CTL || exit 1
[ $BCTL -nt "$ROOT/scripts/e2e/bentoctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/bentoctl.swift" -o $BCTL || exit 1

for p in "${PHASES[@]}"; do "phase_$p"; done
# Leave the dev defaults as found.
[ -z "$HINT_BEFORE" ] && defaults delete Bento KeyboardOverviewSeen >/dev/null 2>&1
[ $FAILS -eq 0 ] && { log "PASSED"; exit 0; } || { log "FAILED ($FAILS)"; exit 1; }
