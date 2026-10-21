#!/bin/bash
# Platform e2e (BentoCore, BentoShell, Launcher) against the real full app
# (.build/debug/Bento, all modules linked), driven through AX and real key events.
#   scripts/e2e/platform.sh headless   no GUI session: no windows, HUDs or input (config, registry, lifecycle)
#   scripts/e2e/platform.sh recorder   shortcut recorder flows                     (own GUI session)
#   scripts/e2e/platform.sh launcher   App Hotkeys end to end                      (own GUI session)
#   scripts/e2e/platform.sh shell      settings window, menu, URLs, toggles, config (own GUI session)
#   scripts/e2e/platform.sh all        headless + every GUI phase
# Builds the app first. Exits non-zero on failure, 75 if the user came back
# (session ended early). Kills its Bento and quits test apps it launched.
# Input only goes to the Bento under test (by pid, when frontmost) or to test
# apps it launched itself (Calculator if it wasn't running, PlatformTest.app).
set -u
ROOT="${BENTO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
WHO=platform
H=/tmp/bento-e2e-platform
CFG=$H/config/config.json
DIAG=$H/support/diagnostics.json
BIN="$ROOT/.build/debug/Bento"
CTL=/tmp/platform-ctl
SESSION="$ROOT/scripts/e2e/session"
ART=$H.artifacts   # screenshots/AX dumps of failures (kept across phases)
mkdir -p "$ART"
TESTAPP_ID=com.charles.bento.e2e.testapp
pass=0; fails=0; PID=""; IN_SESSION=0; LAUNCHED_APPS=(); LAST_EXIT=""

(cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error:|complete" | tail -3)
[ -x "$BIN" ] || { echo "build failed" >&2; exit 2; }
# Run a private copy, so rebuilding while a session waits for the user can't
# swap the binary under the test (the name stays "Bento" for the input guard).
mkdir -p /tmp/bento-e2e-platform-bin && cp "$BIN" /tmp/bento-e2e-platform-bin/Bento.new && mv -f /tmp/bento-e2e-platform-bin/Bento.new /tmp/bento-e2e-platform-bin/Bento && BIN=/tmp/bento-e2e-platform-bin/Bento
[ "$CTL" -nt "$ROOT/scripts/e2e/platform-ctl.swift" ] || swiftc -O "$ROOT/scripts/e2e/platform-ctl.swift" -o "$CTL" || exit 2
command -v jq >/dev/null || { echo "needs jq" >&2; exit 2; }

ok()  { pass=$((pass+1)); echo "  ok   $*"; }
bad() { fails=$((fails+1)); echo "  FAIL $*"; }
check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi }
eq() { local desc="$1" want="$2" got="$3"; if [ "$want" = "$got" ]; then ok "$desc"; else bad "$desc (want '$want', got '$got')"; fi }

quit_test_apps() {
  for b in "${LAUNCHED_APPS[@]:-}"; do [ -n "$b" ] && osascript -e "tell application id \"$b\" to quit" >/dev/null 2>&1; done
  LAUNCHED_APPS=()
}
cleanup() {
  stop_bento
  quit_test_apps
  if [ $IN_SESSION = 1 ]; then "$SESSION" end "$WHO"; IN_SESSION=0; fi
}
abort() { echo "user input detected: stopping"; cleanup; summary; exit 75; }
trap 'cleanup; exit 130' INT TERM

# Driver wrapper: exit 75 (the user came back) aborts the whole run.
c() { "$CTL" "$@"; local rc=$?; [ $rc = 75 ] && abort; return $rc; }
begin_session() { "$SESSION" start "$WHO" || exit 1; IN_SESSION=1; }
end_session() { stop_bento; quit_test_apps; "$SESSION" end "$WHO"; IN_SESSION=0; }

cfg() { jq -r "$1" "$CFG" 2>/dev/null; }
set_cfg() { local tmp; tmp=$(mktemp "$H/cfg.XXXX"); jq "$1" "$CFG" > "$tmp" && mv "$tmp" "$CFG"; }  # atomic, like an editor
d() { jq -r "$1" "$DIAG" 2>/dev/null; }
diag() {
  rm -f "$DIAG"
  "$CTL" url "$H" "bento://debug/state"
  for _ in $(seq 1 40); do [ -s "$DIAG" ] && return 0; sleep 0.05; done
  return 1
}
url() { "$CTL" url "$H" "$1"; }
alive() { [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; }
val() { "$CTL" value "$PID" "$1" 2>/dev/null; }
frontbid() { "$CTL" frontmost | cut -d' ' -f2; }
front_is() { [ "$(frontbid)" = "$1" ]; }
app_hidden() { [ "$("$CTL" appstate "$1" | cut -d' ' -f2)" = true ]; }
hud_shows() { "$CTL" count "$PID" "role=AXStaticText value~=$1" | grep -qv '^0$'; }
wait_for() { local secs=$1; shift; for _ in $(seq 1 $((secs * 10))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }

start_bento() {
  BENTO_HOME=$H BENTO_DEV=1 "$BIN" >>"$H/bento.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do diag && return 0; sleep 0.1; done
  bad "Bento started"; return 1
}
# SIGTERM is handled as a normal quit: exit status 0 means a clean shutdown.
stop_bento() {
  [ -z "$PID" ] && return 0
  if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID" 2>/dev/null; fi
  wait "$PID" 2>/dev/null; LAST_EXIT=$?
  PID=""
}

base_config() {  # $1 = enabledModules JSON, $2 = launcher entries JSON, $3 = showMenuBarIcon
  mkdir -p "$H/config" "$H/support"
  cat > "$CFG" <<EOF
{
  "general": { "enabledModules": $1, "showMenuBarIcon": ${3:-false} },
  "launcher": { "entries": $2 },
  "notes": { "sync": { "enabled": false, "server": "http://127.0.0.1:9", "tokenFile": "$H/no-token" } },
  "windows": { "importedFromRectangle": true },
  "shortcuts": {}
}
EOF
}
ONLY_LAUNCHER='{"shot":false,"windows":false,"tiling":false,"launcher":true,"clipboard":false,"notes":false}'

open_settings() {  # $1 = page
  url "bento://settings/$1"
  c wait "$PID" "role=AXWindow title=Bento_Settings" 5 >/dev/null || { bad "settings window opened"; return 1; }
  sleep 0.5
  c front "$PID" >/dev/null
}

# ---------------------------------------------------------------------------
phase_headless() {
  echo "== headless (no windows, no input)"
  rm -rf "$H"; mkdir -p "$H"
  # Obscure combinations so the global registration never collides with real use.
  base_config "$ONLY_LAUNCHER" "[
    {\"key\":\"qa-cmd\",\"kind\":\"command\",\"target\":\"touch $H/fired-cmd\",\"shortcut\":\"hyper+f17\"},
    {\"target\":\"Calculator\",\"shortcut\":\"hyper+f18\"},
    {\"target\":\"Calculator\",\"shortcut\":\"hyper+f19\"},
    {\"target\":\"No Such App QA\",\"shortcut\":7},
    42
  ]"
  start_bento || return
  eq "launcher running" true "$(d '.modules.launcher.running')"
  eq "lenient entries: 4 valid of 5" 4 "$(d '.modules.launcher.state.entries')"
  eq "duplicate entries get distinct ids" "launcher.calculator launcher.calculator-2" "$(d '[.actions[].id | select(startswith("launcher.calculator"))] | join(" ")')"
  eq "no duplicate action ids" 0 "$(d '.registry.duplicates | length')"
  eq "bad entry kept in file for the user to fix" 7 "$(cfg '.launcher.entries[3].shortcut')"
  eq "registrations match bound actions" "$(d '.registry.registered')" "$(d '.registry.hotkeyEntries')"

  url "bento://action/launcher.qa-cmd"
  check "bento://action runs a command entry" wait_for 3 test -f "$H/fired-cmd"
  url "bento://bogus/x"; url "bento://settings-not/x"
  check "unknown URL hosts are ignored" alive

  # Reload storm: many external edits in a row.
  local before; diag; before=$(d '.registry.reloads')
  for i in $(seq 1 15); do set_cfg ".launcher.entries[0].shortcut = \"hyper+f$(( (i % 2) + 18 ))\""; done
  set_cfg '.launcher.entries[0].shortcut = "hyper+f16"'
  sleep 1.5; diag
  check "16 external edits applied" test "$(d '.registry.reloads')" -gt "$before"
  eq "last edit wins" "hyper+f16" "$(d '.actions[] | select(.id == "launcher.qa-cmd") | .shortcut')"
  eq "edited binding registered" false "$(d '.actions[] | select(.id == "launcher.qa-cmd") | .failed')"
  eq "no leaked registrations after storm" "$(d '.registry.registered')" "$(d '.registry.hotkeyEntries')"
  eq "watcher still attached" true "$(d '.config.watching')"

  # Module toggles: start/stop must be idempotent and leave nothing behind.
  for _ in $(seq 1 10); do
    set_cfg '.general.enabledModules.launcher = false'; sleep 0.25
    set_cfg '.general.enabledModules.launcher = true'; sleep 0.25
  done
  set_cfg '.general.enabledModules.launcher = false'; sleep 0.6; diag
  eq "launcher stopped" false "$(d '.modules.launcher.running')"
  eq "stopped launcher keeps no observer" false "$(d '.modules.launcher.state.observing')"
  eq "no hotkeys while launcher is off" 0 "$(d '.registry.hotkeyEntries')"
  set_cfg '.general.enabledModules.launcher = true'; sleep 0.6; diag
  eq "launcher restarted" true "$(d '.modules.launcher.state.started')"
  eq "hotkeys back after re-enable" "$(d '.registry.registered')" "$(d '.registry.hotkeyEntries')"
  check "hotkeys registered again" test "$(d '.registry.registered')" -ge 2

  # Shutdown on SIGTERM flushes and exits cleanly; restart doesn't rewrite the file.
  stop_bento
  eq "SIGTERM: clean exit" 0 "$LAST_EXIT"
  local sum1 sum2
  start_bento; stop_bento
  sum1=$(shasum "$CFG" | cut -c1-40)
  start_bento; sleep 1; stop_bento
  sum2=$(shasum "$CFG" | cut -c1-40)
  eq "no materialize churn on restart" "$sum1" "$sum2"

  # A minimal file gets every option written out, even when quit right away.
  echo '{"general":{"enabledModules":'"$ONLY_LAUNCHER"',"showMenuBarIcon":false},"notes":{"sync":{"enabled":false}}}' > "$CFG"
  BENTO_HOME=$H BENTO_DEV=1 "$BIN" >>"$H/bento.log" 2>&1 & PID=$!
  sleep 0.25; stop_bento
  eq "materialized section flushed on quit" "[]" "$(cfg '.launcher.entries | tostring')"

  # Dev URLs are addressed per instance (other agents' dev instances ignore ours).
  start_bento
  rm -f "$H/fired-cmd"
  "$CTL" url /tmp/some-other-bento-home "bento://action/launcher.qa-cmd"; sleep 0.5
  check "other BENTO_HOME doesn't reach this instance" test ! -f "$H/fired-cmd"
  stop_bento
}

# ---------------------------------------------------------------------------
phase_recorder() {
  echo "== recorder (GUI session)"
  rm -rf "$H"; mkdir -p "$H"
  base_config '{"shot":false,"windows":true,"tiling":false,"launcher":true,"clipboard":false,"notes":false}' "[
    {\"key\":\"qa-a\",\"kind\":\"command\",\"target\":\"touch $H/fired-a\",\"shortcut\":\"ctrl+opt+cmd+7\"},
    {\"key\":\"qa-b\",\"kind\":\"command\",\"target\":\"touch $H/fired-b\",\"shortcut\":\"ctrl+opt+cmd+8\"}
  ]"
  begin_session
  start_bento || { end_session; return; }
  open_settings launcher || { end_session; return; }
  local RA="id=recorder:launcher.qa-a" RB="id=recorder:launcher.qa-b"

  c key "$PID" ctrl+opt+cmd+7
  check "hotkey fires while settings are open" wait_for 3 test -f "$H/fired-a"

  c press "$PID" "$RA"; sleep 0.2
  eq "AXPress starts recording" "Recording" "$(val "$RA")"
  diag; eq "hotkeys suspended while recording" true "$(d '.registry.hotkeysSuspended')"
  c key "$PID" a shift+a 5 shift+5 lcmd lshift lopt lctrl
  eq "plain, Shift-only and bare modifier keys rejected" "Recording" "$(val "$RA")"
  rm -f "$H/fired-b"
  c key "$PID" ctrl+opt+cmd+8; sleep 0.5
  eq "records the combination" "⌃⌥⌘8" "$(val "$RA")"
  eq "stored in the entry" "ctrl+opt+cmd+8" "$(cfg '.launcher.entries[0].shortcut')"
  eq "taken from the action that had it" "null" "$(cfg '.launcher.entries[1].shortcut')"
  eq "other recorder shows it's gone" "Record Shortcut" "$(val "$RB")"
  check "HUD says where it came from" hud_shows "Removed_from"
  check "its old hotkey didn't fire while recording" test ! -f "$H/fired-b"
  diag; eq "hotkeys resumed after recording" false "$(d '.registry.hotkeysSuspended')"
  rm -f "$H/fired-a"; c key "$PID" ctrl+opt+cmd+8
  check "new binding fires" wait_for 3 test -f "$H/fired-a"

  c press "$PID" "$RA"; c key "$PID" escape; sleep 0.3
  eq "Esc cancels and keeps the binding" "⌃⌥⌘8" "$(val "$RA")"
  local spec k disp conf
  for spec in "ctrl+opt+cmd+up|⌃⌥⌘↑|ctrl+opt+cmd+up" "f13|F13|f13" "opt+cmd+9|⌥⌘9|opt+cmd+9" \
              "ctrl+shift+f6|⌃⇧F6|ctrl+shift+f6" "cmd+shift+k|⇧⌘K|cmd+shift+k" "ctrl+opt+shift+cmd+slash|⌃⌥⇧⌘/|hyper+slash"; do
    IFS='|' read -r k disp conf <<<"$spec"
    c press "$PID" "$RA"; c key "$PID" "$k"; sleep 0.4
    eq "records $k" "$disp" "$(val "$RA")"
    eq "stores $k" "$conf" "$(cfg '.launcher.entries[0].shortcut')"
  done
  c press "$PID" "$RA"; c key "$PID" delete; sleep 0.4
  eq "Delete clears" "Record Shortcut" "$(val "$RA")"
  eq "cleared in the file" "null" "$(cfg '.launcher.entries[0].shortcut')"
  c press "$PID" "$RA"; c key "$PID" ctrl+opt+cmd+7; sleep 0.4
  eq "recorded before clicking ⓧ" "⌃⌥⌘7" "$(val "$RA")"
  c clickel "$PID" "$RA" 14; sleep 0.4
  eq "the ⓧ button clears" "Record Shortcut" "$(val "$RA")"
  if [ "$(val "$RA")" != "Record Shortcut" ]; then
    screencapture -x -l "$("$CTL" cgwindows "$PID" | awk '$2==0 {print $1; exit}')" "$ART/x-click.png" 2>/dev/null
    [ "$(val "$RA")" = Recording ] && c key "$PID" escape
  fi
  local before
  c press "$PID" "$RA"; c key "$PID" ctrl+opt+cmd+7; sleep 0.4
  before=$(val "$RA")
  c press "$PID" "$RA"; sleep 0.2
  c clickel "$PID" "role=AXHeading desc=Hotkeys"; sleep 0.3
  eq "clicking elsewhere ends recording (binding kept)" "$before" "$(val "$RA")"
  diag; eq "hotkeys resumed after clicking elsewhere" false "$(d '.registry.hotkeysSuspended')"
  c press "$PID" "$RA"; c press "$PID" "$RB"; sleep 0.2
  eq "starting another recorder ends the first" "$before" "$(val "$RA")"
  eq "and the second one records" "Recording" "$(val "$RB")"
  c key "$PID" escape; sleep 0.2
  diag; eq "one suspension, balanced" false "$(d '.registry.hotkeysSuspended')"

  # A combination macOS itself uses (never fires) is shown as unavailable.
  local sys; sys=$("$CTL" syscombo)
  set_cfg ".launcher.entries[0].shortcut = \"$sys\""; sleep 0.8
  diag
  eq "macOS shortcut ($sys) marked unavailable" true "$(d '.actions[] | select(.id == "launcher.qa-a") | .failed')"
  check "recorder explains it" bash -c "'$CTL' attr $PID '$RA' AXHelp | grep -q macOS"
  check "row says unavailable" "$CTL" wait "$PID" "role=AXStaticText value~=shortcut_unavailable" 2
  # Another app's hotkey can't be detected (RegisterEventHotKey accepts the same
  # combination in two processes) and its keystroke never reaches the recorder:
  # the recorder must just keep waiting, and Esc must still cancel.
  "$CTL" hold ctrl+opt+cmd+f14 20 > "$ART/hold.log" 2>&1 & local HOLD=$!
  sleep 0.6
  c press "$PID" "$RA"; c key "$PID" ctrl+opt+cmd+f14; sleep 0.5
  eq "a combo another app holds never reaches the recorder" "Recording" "$(val "$RA")"
  c key "$PID" escape; sleep 0.3
  diag; eq "Esc still cancels; hotkeys resumed" false "$(d '.registry.hotkeysSuspended')"
  kill $HOLD 2>/dev/null; wait $HOLD 2>/dev/null

  # Rapid re-recording.
  local i
  for i in 1 2 3 4 5; do c press "$PID" "$RA"; c key "$PID" "ctrl+opt+cmd+$i"; done
  sleep 0.6
  eq "rapid re-recording keeps the last combo" "⌃⌥⌘5" "$(val "$RA")"
  diag
  eq "no suspension leaked" false "$(d '.registry.hotkeysSuspended')"
  eq "registrations consistent" "$(d '.registry.registered')" "$(d '.registry.hotkeyEntries')"
  rm -f "$H/fired-a"; c key "$PID" ctrl+opt+cmd+5
  check "last recorded combo fires" wait_for 3 test -f "$H/fired-a"

  # Shortcuts page: a combo used by another module's action moves (with HUD); reset; search.
  open_settings shortcuts || { end_session; return; }
  local RM="id=recorder:windows.maximize" RL="id=recorder:windows.left-half"
  eq "default shown" "⌃⌥←" "$(val "$RL")"
  c press "$PID" "$RM"; c key "$PID" ctrl+opt+left; sleep 0.5
  eq "maximize took ⌃⌥←" "⌃⌥←" "$(val "$RM")"
  eq "left half lost it" "Record Shortcut" "$(val "$RL")"
  eq "override stored" "ctrl+opt+left" "$(cfg '.shortcuts["windows.maximize"]')"
  eq "explicit unbind stored" "" "$(cfg '.shortcuts["windows.left-half"]')"
  c press "$PID" "id=reset:windows.left-half"; sleep 0.5
  eq "reset restores the default" "⌃⌥←" "$(val "$RL")"
  eq "reset takes it back from maximize" "Record Shortcut" "$(val "$RM")"
  c press "$PID" "id=reset:windows.maximize"; sleep 0.5
  eq "maximize reset to its default" "⌃⌥↩" "$(val "$RM")"
  eq "no overrides left" "{}" "$(cfg '.shortcuts | tostring')"
  local total filtered
  total=$("$CTL" count "$PID" "id~=recorder:")
  c setvalue "$PID" "subrole=AXSearchField" "left half"; sleep 0.8
  filtered=$("$CTL" count "$PID" "id~=recorder:")
  check "search filters rows ($total -> $filtered)" test "$filtered" -lt "$total" -a "$filtered" -ge 1
  c setvalue "$PID" "subrole=AXSearchField" "⌃⌥←"; sleep 0.8
  check "search matches shortcut symbols" "$CTL" wait "$PID" "$RL" 1
  c setvalue "$PID" "subrole=AXSearchField" ""; sleep 0.8
  eq "clearing search restores rows" "$total" "$("$CTL" count "$PID" "id~=recorder:")"

  # Closing the window while recording resumes hotkeys and drops the Dock icon.
  c press "$PID" "$RA"; sleep 0.2
  diag; eq "recording before close" true "$(d '.registry.hotkeysSuspended')"
  c press "$PID" "subrole=AXCloseButton"; sleep 1
  diag
  eq "hotkeys resumed after closing mid-recording" false "$(d '.registry.hotkeysSuspended')"
  eq "settings window released" false "$(d '.settingsWindow.open')"
  eq "Dock presence released" 0 "$(d '.dockPresence')"
  eq "no Dock icon left" accessory "$(d '.activationPolicy')"
  check "Bento still running" alive
  end_session
  eq "clean exit" 0 "$LAST_EXIT"
}

# ---------------------------------------------------------------------------
build_testapp() {
  local app="$H/PlatformTest.app"
  mkdir -p "$app/Contents/MacOS"
  swiftc -O "$ROOT/scripts/e2e/platform-testapp.swift" -o "$app/Contents/MacOS/PlatformTest" 2>/dev/null || return 1
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$TESTAPP_ID</string>
  <key>CFBundleName</key><string>PlatformTest</string>
  <key>CFBundleExecutable</key><string>PlatformTest</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
}

phase_launcher() {
  echo "== launcher (GUI session)"
  rm -rf "$H"; mkdir -p "$H"
  build_testapp || { bad "build test app"; return; }
  base_config "$ONLY_LAUNCHER" "[{\"key\":\"qa-cmd\",\"kind\":\"command\",\"target\":\"touch $H/fired-cmd\",\"shortcut\":\"ctrl+opt+cmd+0\"}]"
  begin_session
  if ! pgrep -xq Calculator; then open -g -a Calculator; LAUNCHED_APPS+=(com.apple.calculator); fi
  wait_for 8 pgrep -xq Calculator
  start_bento || { end_session; return; }
  open_settings launcher || { end_session; return; }

  # Add → Running App → Calculator, then record its hotkey in the row.
  c press "$PID" "id=launcher.add"; sleep 0.6
  c press "$PID" "role=AXMenuItem title=Running_App"; sleep 0.6
  c press "$PID" "role=AXMenuItem id=menuAction: title=Calculator"; sleep 0.8
  local KEY RC
  KEY=$(cfg '[.launcher.entries[] | select(.target == "com.apple.calculator")][0].key')
  check "Add → Running App adds Calculator by bundle id" test -n "$KEY" -a "$KEY" != null
  RC="id=recorder:launcher.$KEY"
  c wait "$PID" "$RC" 3 >/dev/null
  c front "$PID" >/dev/null
  c press "$PID" "$RC"; c key "$PID" ctrl+opt+cmd+6; sleep 0.5
  eq "hotkey recorded in the row" "ctrl+opt+cmd+6" "$(cfg "[.launcher.entries[] | select(.key == \"$KEY\")][0].shortcut")"

  # Toggle (default): launch/focus, hide when frontmost, show again.
  c key "$PID" ctrl+opt+cmd+6
  check "hotkey brings Calculator to the front" wait_for 5 front_is com.apple.calculator
  c keyto com.apple.calculator ctrl+opt+cmd+6
  check "pressing it again hides Calculator" wait_for 3 app_hidden com.apple.calculator
  c front "$PID" >/dev/null
  c key "$PID" ctrl+opt+cmd+6
  check "and brings it back" wait_for 5 front_is com.apple.calculator
  # Focus: pressing while frontmost keeps it (behaviour changed by editing the file).
  set_cfg "(.launcher.entries[] | select(.key == \"$KEY\") | .behavior) = \"focus\""; sleep 0.8
  c keyto com.apple.calculator ctrl+opt+cmd+6; sleep 0.8
  eq "focus keeps it frontmost" com.apple.calculator "$(frontbid)"
  eq "focus doesn't hide" false "$("$CTL" appstate com.apple.calculator | cut -d' ' -f2)"

  # Cycle through the windows of a test app (path entry, launched by the hotkey).
  set_cfg ".launcher.entries += [{\"key\":\"qa-cycle\",\"target\":\"$H/PlatformTest.app\",\"behavior\":\"cycle\",\"shortcut\":\"ctrl+opt+cmd+9\"}]"; sleep 0.8
  c front "$PID" >/dev/null
  LAUNCHED_APPS+=("$TESTAPP_ID")
  c key "$PID" ctrl+opt+cmd+9
  check "hotkey launches the test app" wait_for 8 front_is "$TESTAPP_ID"
  sleep 1.2
  local titles="" t
  for _ in 1 2 3; do
    c keyto "$TESTAPP_ID" ctrl+opt+cmd+9; sleep 0.7
    t=$("$CTL" focusedtitle "$TESTAPP_ID"); titles="$titles$t|"
  done
  eq "cycle walks through all three windows ($titles)" 3 "$(echo "$titles" | tr '|' '\n' | grep -v '^$' | sort -u | wc -l | tr -d ' ')"
  set_cfg '(.launcher.entries[] | select(.key == "qa-cycle") | .behavior) = "toggle"'; sleep 0.8
  c keyto "$TESTAPP_ID" ctrl+opt+cmd+9
  check "toggle hides the test app" wait_for 3 app_hidden "$TESTAPP_ID"
  c front "$PID" >/dev/null

  # Missing app / missing path → HUD; duplicates both work; a bad hand edit is skipped.
  set_cfg ".launcher.entries += [
    {\"target\":\"No Such App QA\",\"shortcut\":\"ctrl+opt+cmd+5\"},
    {\"kind\":\"path\",\"target\":\"$H/missing-file\",\"shortcut\":\"ctrl+opt+cmd+4\"},
    {\"kind\":\"command\",\"target\":\"touch $H/fired-dup\",\"shortcut\":\"ctrl+opt+cmd+3\"},
    {\"kind\":\"command\",\"target\":\"touch $H/fired-dup\",\"shortcut\":\"ctrl+opt+cmd+2\"},
    {\"target\":\"Bad\",\"shortcut\":12}, \"junk\"]"; sleep 0.8
  c key "$PID" ctrl+opt+cmd+5; sleep 0.3
  check "missing app: HUD" hud_shows "Can't_find_No_Such_App"
  check "missing app: still running" alive
  c key "$PID" ctrl+opt+cmd+4; sleep 0.3
  check "missing path: HUD" hud_shows "Can't_find_missing-file"
  c key "$PID" ctrl+opt+cmd+3
  check "duplicate entry 1 fires" wait_for 3 test -f "$H/fired-dup"
  rm -f "$H/fired-dup"
  c key "$PID" ctrl+opt+cmd+2
  check "duplicate entry 2 fires" wait_for 3 test -f "$H/fired-dup"
  diag
  eq "duplicates registered under distinct ids" 2 "$(d '[.actions[] | select(.id | startswith("launcher.touch-")) | select(.failed == false)] | length')"
  eq "malformed entries skipped" 8 "$(d '.modules.launcher.state.entries')"

  # Add → URL… sheet (validated; not opened).
  c press "$PID" "id=launcher.add"; sleep 0.5
  c press "$PID" "role=AXMenuItem id=menuAction: title=URL…"; sleep 0.8
  "$CTL" tree "$PID" 40 > "$ART/url-sheet.txt" 2>/dev/null
  local ADDQ="role=AXButton title=Add"
  [ "$("$CTL" count "$PID" "$ADDQ")" = 0 ] && ADDQ="role=AXButton desc=Add"
  c type "$PID" "not a url"; sleep 0.3
  eq "invalid URL can't be added" 0 "$("$CTL" attr "$PID" "$ADDQ" AXEnabled)"
  c key "$PID" return; sleep 0.3
  eq "Return doesn't add an invalid URL" 0 "$(cfg '[.launcher.entries[] | select(.kind == "url")] | length')"
  c setvalue "$PID" "role=AXTextField" "example.com"; sleep 0.3
  c press "$PID" "$ADDQ"; sleep 0.6
  eq "URL entry added" url "$(cfg '[.launcher.entries[] | select(.target == "example.com")][0].kind')"

  # Add → Application… (open panel, driven by typing a path), then remove the row.
  c front "$PID" >/dev/null
  c press "$PID" "id=launcher.add"; sleep 0.5
  # The panel runs modally inside the menu action, so this AX call times out; that's expected.
  "$CTL" press "$PID" "role=AXMenuItem id=menuAction: title=Application…" >/dev/null 2>&1; sleep 1.5
  c type "$PID" "/System/Applications/Chess.app"; sleep 1.2
  c key "$PID" return; sleep 1.2
  c key "$PID" return; sleep 1.2
  local CK
  CK=$(cfg '[.launcher.entries[] | select(.target == "com.apple.Chess")][0].key')
  if [ -n "$CK" ] && [ "$CK" != null ]; then
    ok "Add → Application… adds Chess"
    c front "$PID" >/dev/null
    c press "$PID" "id=remove:launcher.$CK"; sleep 0.6
    eq "the row's remove button deletes it" 0 "$(cfg '[.launcher.entries[] | select(.target == "com.apple.Chess")] | length')"
  else
    screencapture -x -l "$("$CTL" cgwindows "$PID" | awk '$2==0 {print $1}' | tail -1)" "$ART/openpanel.png" 2>/dev/null
    bad "Add → Application… adds Chess (see $ART/openpanel.png)"
    c key "$PID" escape; sleep 0.3; c key "$PID" escape
  fi
  check "Bento still running" alive
  end_session
  eq "clean exit" 0 "$LAST_EXIT"
}

# ---------------------------------------------------------------------------
phase_shell() {
  echo "== shell (GUI session)"
  rm -rf "$H"; mkdir -p "$H"
  # The real app: every module at its default (Tiling off), status item on.
  base_config '{}' "[{\"key\":\"qa-cmd\",\"kind\":\"command\",\"target\":\"touch $H/fired-cmd\",\"shortcut\":\"ctrl+opt+cmd+0\"}]" true
  begin_session
  start_bento || { end_session; return; }
  local m
  for m in shot windows launcher clipboard notes; do eq "$m running" true "$(d ".modules.$m.running")"; done
  eq "tiling off by default" false "$(d '.modules.tiling.running')"
  echo "  info: shortcuts unavailable on this machine: $(d '.failed | join(", ")')"
  eq "status item shown" true "$(d '.statusItem')"

  # Status menu.
  c press "$PID" "in=extras role=AXMenuBarItem"; sleep 0.6
  check "status menu lists Settings…" "$CTL" wait "$PID" "in=extras role=AXMenuItem title=Settings…" 2
  check "status menu lists module submenus" "$CTL" wait "$PID" "in=extras role=AXMenuItem title=Windows" 2
  c press "$PID" "in=extras role=AXMenuItem title=Settings…"
  check "Settings… opens the window" "$CTL" wait "$PID" "role=AXWindow title=Bento_Settings" 5
  diag; eq "Dock icon while settings are open" regular "$(d '.activationPolicy')"
  check "permissions view shows Granted" "$CTL" wait "$PID" "role=AXStaticText value=Granted" 3
  eq "launch at login disabled for dev builds" 0 "$("$CTL" attr "$PID" "id=launch-at-login" AXEnabled)"
  eq "no login item for a dev binary" unavailable "$(d '.launchAtLogin')"

  # Deep links.
  url "bento://settings/launcher"; check "bento://settings/launcher" "$CTL" wait "$PID" "id=launcher.add" 3
  url "bento://settings/shortcuts"; check "bento://settings/shortcuts" "$CTL" wait "$PID" "subrole=AXSearchField" 3
  url "bento://settings/bogus"; check "unknown page falls back to General" "$CTL" wait "$PID" "id=launch-at-login" 3

  # Module switches in the UI, repeatedly.
  c front "$PID" >/dev/null
  local regs i
  diag; regs=$(d '.registry.registered')
  for i in 1 2 3; do c press "$PID" "id=module-toggle:windows"; sleep 0.5; c press "$PID" "id=module-toggle:windows"; sleep 0.5; done
  diag
  eq "windows running after UI toggles" true "$(d '.modules.windows.running')"
  eq "windows drag tap back" true "$(d '.modules.windows.state.dragTap')"
  # Every module off/on through the file, 8 times.
  for i in $(seq 1 8); do
    set_cfg '.general.enabledModules = {"shot":false,"windows":false,"launcher":false,"clipboard":false,"notes":false}'; sleep 0.5
    set_cfg '.general.enabledModules = {}'; sleep 0.5
  done
  set_cfg '.general.enabledModules = {"shot":false,"windows":false,"launcher":false,"clipboard":false,"notes":false}'; sleep 0.8; diag
  eq "all modules stopped" "false false false false false" "$(d '[.modules.shot.running, .modules.windows.running, .modules.launcher.running, .modules.clipboard.running, .modules.notes.running] | map(tostring) | join(" ")')"
  eq "no hotkeys left with every module off" 0 "$(d '.registry.hotkeyEntries')"
  eq "windows event tap removed" false "$(d '.modules.windows.state.dragTap')"
  set_cfg '.general.enabledModules = {}'; sleep 1; diag
  eq "same registrations after 8 off/on cycles" "$regs" "$(d '.registry.registered')"
  eq "no leaked hotkeys" "$(d '.registry.registered')" "$(d '.registry.hotkeyEntries')"

  # Settings window open/close: memory released, Dock icon gone.
  c press "$PID" "subrole=AXCloseButton"; sleep 0.8
  local rss0 rss1 opened
  rss0=$(ps -o rss= -p "$PID" | tr -d ' ')
  diag; opened=$(d '.settingsWindow.opened')
  for i in $(seq 1 10); do
    url "bento://settings/shortcuts"
    "$CTL" wait "$PID" "role=AXWindow title=Bento_Settings" 4 >/dev/null
    sleep 0.3
    c press "$PID" "subrole=AXCloseButton"
    "$CTL" gone "$PID" "role=AXWindow title=Bento_Settings" 3 >/dev/null
  done
  sleep 1; diag
  eq "10 more windows opened" $((opened + 10)) "$(d '.settingsWindow.opened')"
  eq "every window closed" "$(d '.settingsWindow.opened')" "$(d '.settingsWindow.closed')"
  eq "Dock presence balanced" 0 "$(d '.dockPresence')"
  eq "no Dock icon left" accessory "$(d '.activationPolicy')"
  rss1=$(ps -o rss= -p "$PID" | tr -d ' ')
  echo "  info: RSS before ${rss0} KB, after 10 open/close ${rss1} KB"
  check "memory stays bounded (< +40 MB)" test $((rss1 - rss0)) -lt 40960
  local live
  live=$(heap "$PID" 2>/dev/null | grep -cE "SettingsRootView|ShortcutsPane|LauncherSettingsView")
  eq "settings views released (heap)" 0 "$live"

  # URLs.
  url "bento://action/launcher.qa-cmd"
  check "bento://action/<id>" wait_for 3 test -f "$H/fired-cmd"
  url "bento://action/launcher.nope"; sleep 0.4
  check "unknown action: HUD" hud_shows "Unknown_action"
  check "bento://debug/state" diag

  # Config file problems while running: never overwritten, reported, recovered.
  cp "$CFG" "$H/good.json"
  printf '{ "general": { "enabledModules": ' > "$CFG"
  sleep 0.8; diag
  check "invalid JSON reported" test -n "$(d '.config.problem')"
  check "invalid JSON: HUD" hud_shows "not_valid_JSON"
  eq "invalid file left untouched" '{ "general": { "enabledModules": ' "$(cat "$CFG")"
  eq "modules keep running" true "$(d '.modules.windows.running')"
  cp "$H/good.json" "$CFG.tmp" && mv "$CFG.tmp" "$CFG"; sleep 0.8; diag
  eq "fixed file picked up" "" "$(d '.config.problem')"
  set_cfg '.windows.windowGap = "wide"'; sleep 0.8; diag
  eq "a wrong type keeps the module running" true "$(d '.modules.windows.running')"
  eq "wrong value kept in the file for the user" wide "$(cfg '.windows.windowGap')"
  python3 -c "import json;d=json.load(open('$CFG'));d['pad']='x'*(9<<20);json.dump(d,open('$CFG.tmp','w'))" && mv "$CFG.tmp" "$CFG"
  sleep 1; diag
  check "huge file refused" bash -c "jq -r '.config.problem' '$DIAG' | grep -q 'too large'"
  cp "$H/good.json" "$CFG.tmp" && mv "$CFG.tmp" "$CFG"; sleep 0.8; diag
  eq "recovered after huge file" "" "$(d '.config.problem')"

  # Single instance: a second copy with the same bundle id exits at once.
  local SI="$H/si/Bento.app" first second
  mkdir -p "$SI/Contents/MacOS" "$H/si1/config"
  cp "$BIN" "$SI/Contents/MacOS/Bento"
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.charles.bento.e2e.single</string><key>CFBundleExecutable</key><string>Bento</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>' > "$SI/Contents/Info.plist"
  echo '{"general":{"enabledModules":{"shot":false,"windows":false,"tiling":false,"launcher":false,"clipboard":false,"notes":false},"showMenuBarIcon":false}}' > "$H/si1/config/config.json"
  BENTO_HOME=$H/si1 BENTO_DEV=1 "$SI/Contents/MacOS/Bento" >/dev/null 2>&1 & first=$!
  sleep 2
  BENTO_HOME=$H/si1 BENTO_DEV=1 "$SI/Contents/MacOS/Bento" >/dev/null 2>&1 & second=$!
  check "second instance exits" wait_for 5 bash -c "! kill -0 $second 2>/dev/null"
  check "first instance keeps running" kill -0 $first
  kill -TERM $first $second 2>/dev/null; wait $first $second 2>/dev/null

  # Quit from the status menu: clean exit.
  c press "$PID" "in=extras role=AXMenuBarItem"; sleep 0.6
  c press "$PID" "in=extras role=AXMenuItem title=Quit_Bento"
  check "Quit Bento quits" wait_for 5 bash -c "! kill -0 $PID 2>/dev/null"
  wait "$PID" 2>/dev/null; LAST_EXIT=$?; PID=""
  eq "clean exit from the menu" 0 "$LAST_EXIT"
  end_session
}

# ---------------------------------------------------------------------------
summary() {
  echo
  echo "platform e2e: $pass passed, $fails failed"
  [ $fails = 0 ]
}

case "${1:-all}" in
  headless) phase_headless ;;
  recorder) phase_recorder ;;
  launcher) phase_launcher ;;
  shell) phase_shell ;;
  all) phase_headless; phase_recorder; phase_launcher; phase_shell ;;
  *) echo "usage: $0 headless|recorder|launcher|shell|all" >&2; exit 2 ;;
esac
cleanup
summary
