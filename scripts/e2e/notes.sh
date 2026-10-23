#!/bin/bash
# End-to-end tests for Notes: the real app (debug build) against a local bento-sync.
#
#   scripts/e2e/notes.sh sync    headless sync suite: two app instances + a local server.
#                                No windows, no input, nothing on screen.
#   scripts/e2e/notes.sh gui     window, ⌃⌥N, typing, in-window shortcuts, quit mid-typing,
#                                frame restore, full screen, live typing between two
#                                instances. Runs in two short GUI sessions
#                                (scripts/e2e/session start/end notes); types only into its
#                                own instances (bentoctl --expect).
#   scripts/e2e/notes.sh all     both
#
# Data safety: every instance has its own BENTO_HOME under $WORK, syncs with a local
# bento-sync on a free port (temp DB, random token). The live server and the user's notes
# are never touched (isolated instances also refuse bento.radian.dk by themselves).
# Instances run from a copy of the binary inside a tiny .app with their own bundle id, so
# bentoctl --expect can verify that keystrokes go to them and nowhere else.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/config.sh"
WORK=${NOTES_E2E_WORK:-/tmp/bento-e2e-notes}
SRV="$ROOT/server/target/debug/bento-sync"
BIN="$ROOT/.build/debug/Bento"
CTL=/tmp/bentoctl
PASSES=0; FAILS=0; FAILED=()
SERVER_PID=""

log() { printf '%s\n' "$*"; }
ok() { PASSES=$((PASSES + 1)); log "  ✓ $*"; }
bad() { FAILS=$((FAILS + 1)); FAILED+=("$*"); log "  ✗ $*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
# eventually <seconds> <description> <command...>
eventually() {
  local t=$1 d=$2; shift 2
  local end=$(( $(date +%s) + t ))
  while :; do
    if "$@" >/dev/null 2>&1; then ok "$d"; return 0; fi
    [ "$(date +%s)" -ge "$end" ] && { bad "$d (after ${t}s)"; return 1; }
    sleep 0.3
  done
}

# ---------------------------------------------------------------- setup

build() {
  log "building app and server…"
  (cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|Compiling|Build" | tail -3) || exit 1
  (cd "$ROOT/server" && cargo build -q 2>&1 | tail -3) || exit 1
  [ -x "$SRV" ] && [ -x "$BIN" ] || { log "build failed"; exit 1; }
}

prepare() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  TOKEN="e2e-$(openssl rand -hex 16)"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  cat > "$WORK/perform.swift" <<'EOF'
import Foundation
DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.perform"),
    object: CommandLine.arguments[1], userInfo: nil, deliverImmediately: true)
EOF
  swiftc -O "$WORK/perform.swift" -o "$WORK/perform" 2>/dev/null || exit 1
  write_q
}

# q.py: exact reads of the app DBs and the server (bodies with newlines, convergence).
write_q() {
  cat > "$WORK/q.py" <<'EOF'
import json, sqlite3, sys, urllib.request, hashlib
def db(name):
    c = sqlite3.connect(f"{sys.argv[2]}/{name}/support/Notes/notes.sqlite", timeout=5)
    c.row_factory = sqlite3.Row
    return c
def rows(name):
    try:
        return {r["id"]: dict(r) for r in db(name).execute("select * from notes")}
    except Exception:
        return {}
def server():
    req = urllib.request.Request(f"http://127.0.0.1:{sys.argv[3]}/v1/notes?since=0", headers={"Authorization": "Bearer " + sys.argv[4]})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return {n["id"]: n for n in json.load(opener.open(req, timeout=5))["notes"]}
cmd = sys.argv[1]
if cmd == "body":      # body <work> <port> <token> <instance|server> <id>
    src, nid = sys.argv[5], sys.argv[6]
    n = (server() if src == "server" else rows(src)).get(nid)
    sys.stdout.write("<missing>" if n is None else n["body"])
elif cmd == "field":   # field <work> <port> <token> <instance> <id> <column>
    n = rows(sys.argv[5]).get(sys.argv[6]); print("" if n is None else n[sys.argv[7]])
elif cmd == "sha":     # sha <work> <port> <token> <instance|server> <id>
    src, nid = sys.argv[5], sys.argv[6]
    n = (server() if src == "server" else rows(src)).get(nid)
    print("missing" if n is None else hashlib.sha256(n["body"].encode()).hexdigest())
elif cmd == "count":   # count <work> <port> <token> <instance> <sql where>
    print(db(sys.argv[5]).execute("select count(*) from notes where " + sys.argv[6]).fetchone()[0])
elif cmd == "converged":  # converged <work> <port> <token> <instance>...: same notes everywhere, nothing dirty
    s = server(); ok = True
    for name in sys.argv[5:]:
        r = rows(name)
        dirty = [i for i, n in r.items() if n["dirty"]]
        if dirty: print(name, "dirty:", dirty[:5]); ok = False
        for i, n in s.items():
            m = r.get(i)
            if m is None: print(name, "missing", i); ok = False; continue
            if m["body"] != n["body"] or bool(m["deleted"]) != bool(n["deleted"]) or json.loads(m["meta"] or "{}") != (n.get("meta") or {}):
                print(name, "differs", i, repr(m["body"][:40]), repr(n["body"][:40])); ok = False
        extra = [i for i, n in r.items() if i not in s and (n["body"] or n["dirty"])]
        if extra: print(name, "not on server:", extra[:5]); ok = False
    sys.exit(0 if ok else 1)
elif cmd == "json":    # json <file> <python expression over d>
    d = json.load(open(sys.argv[2])); print(eval(sys.argv[3]))
EOF
}

q() { python3 "$WORK/q.py" "$1" "$WORK" "$PORT" "$TOKEN" "${@:2}"; }
body_is() { [ "$(q body "$1" "$2"; echo x)" = "$(printf '%b' "$3")x" ]; }
contains() { q body "$1" "$2" | grep -qF -- "$3"; }
converged() { q converged "$@"; }
dumpq() { python3 "$WORK/q.py" json "$WORK/$1/dump.json" "$2"; }

start_server() {
  BENTO_SYNC_TOKEN="$TOKEN" BENTO_SYNC_DB="$WORK/server.db" BENTO_SYNC_ADDR="127.0.0.1:$PORT" "$SRV" >> "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/health" | grep -q '"ok"' && return 0; sleep 0.1; done
  log "server did not start"; return 1
}
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
kill_server() { [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
hellos() { grep -c "hello device=\"[^\"]*(dev $1)\"" "$WORK/server.log" 2>/dev/null || true; }

# home <name> [gui]: config + token for an isolated instance (headless: no hotkeys, no menu bar)
home() {
  local n=$1 mode=${2:-headless} h="$WORK/$1"
  mkdir -p "$h/config"
  printf '%s' "$TOKEN" > "$h/config/sync-token"; chmod 600 "$h/config/sync-token"
  local modules='{"shot":false,"windows":false,"tiling":false,"launcher":false,"clipboard":false,"notes":true}'
  local shortcuts='{"notes.toggle":"","notes.new":"","notes.search":""}'
  if [ "$mode" = gui ]; then shortcuts='{}'; fi
  if [ "$mode" = gui-b ]; then shortcuts='{"notes.toggle":"","notes.new":"","notes.search":""}'; fi
  cat > "$h/config/config.json" <<EOF
{"general": {"enabledModules": $modules, "showMenuBarIcon": false},
 "shortcuts": $shortcuts,
 "notes": {"confirmDelete": true, "sync": {"enabled": true, "server": "http://127.0.0.1:$PORT", "tokenFile": "$h/config/sync-token"}}}
EOF
  # a copy of the binary in its own bundle (unique bundle id for bentoctl --expect)
  local app="$WORK/$n.app"
  mkdir -p "$app/Contents/MacOS"
  cp "$BIN" "$app/Contents/MacOS/Bento"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.charles.bento.e2e.notes-$n</string>
<key>CFBundleName</key><string>BentoE2E-$n</string>
<key>CFBundleExecutable</key><string>Bento</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
}
bid() { echo "com.charles.bento.e2e.notes-$1"; }

launch() {
  local n=$1
  BENTO_HOME="$WORK/$n" BENTO_DEV=1 "$WORK/$n.app/Contents/MacOS/Bento" >> "$WORK/$n.log" 2>&1 &
  echo $! > "$WORK/$n.pid"
  sleep 1.2
}
pid() { cat "$WORK/$1.pid" 2>/dev/null; }
alive() { kill -0 "$(pid "$1")" 2>/dev/null; }
quit_app() { # normal quit (NSApp.terminate): flushes pending edits
  local n=$1
  alive "$n" || return 0
  dbg_nowait "$n" quit
  for _ in $(seq 1 50); do alive "$n" || return 0; sleep 0.1; done
  kill "$(pid "$n")" 2>/dev/null; sleep 0.5
}
kill_all() {
  for f in "$WORK"/*.pid; do [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done
  stop_server
}

# dbg <name> <command>...: run a NotesDebug script in one instance and wait for its dump
dbg() {
  local n=$1; shift
  rm -f "$WORK"/*/debug.txt "$WORK/$n/dump.json"
  printf '%s\n' "$@" dump > "$WORK/$n/debug.txt"
  "$WORK/perform" notes.debug
  for _ in $(seq 1 600); do [ -s "$WORK/$n/dump.json" ] && break; sleep 0.1; done
  rm -f "$WORK/$n/debug.txt"
  [ -s "$WORK/$n/dump.json" ] || { log "    (no dump from $n)"; return 1; }
}
dbg_nowait() {
  local n=$1; shift
  rm -f "$WORK"/*/debug.txt
  printf '%s\n' "$@" > "$WORK/$n/debug.txt"
  "$WORK/perform" notes.debug
  sleep 0.5
  rm -f "$WORK/$n/debug.txt"
}
state_is() { dbg "$1" && dumpq "$1" "d['syncState']" | grep -q "$2"; }
cputime() { ps -o cputime= -p "$(pid "$1")" | awk -F'[:.]' '{ printf "%d\n", ($1 * 60 + $2) * 100 + $3 }'; } # centiseconds

# ---------------------------------------------------------------- headless sync suite

sync_suite() {
  log "== sync (headless) =="
  start_server || return 1
  home a; home b
  launch a; launch b
  eventually 15 "both instances connect" bash -c "[ \$(grep -c 'hello device' '$WORK/server.log') -ge 2 ]"

  log "- propagation"
  dbg a 'put n1|# First\nfrom A'
  eventually 10 "A → B" body_is b n1 '# First\nfrom A'
  dbg b 'put n1|# First\nfrom A\nand B'
  eventually 10 "B → A" body_is a n1 '# First\nfrom A\nand B'

  log "- rapid edits (60 appends, 50 ms apart)"
  dbg a 'put n2|# Rapid' >/dev/null
  local cmds=(); for i in $(seq 1 60); do cmds+=("append n2| r$i"); done
  dbg a "${cmds[@]}"
  eventually 15 "rapid edits converge" converged a b
  check "B has every edit" contains b n2 " r60"

  log "- large notes"
  python3 -c 'import sys; s=("# Big\n" + "lorem ipsum dolor sit amet ✓ 日本\n" * 40000); b=s.encode(); open(sys.argv[1],"w").write(b[:1000000].decode("utf-8","ignore"))' "$WORK/big.txt"
  python3 -c 'import sys; open(sys.argv[1],"w").write("# Too big\n" + "x" * 1100000)' "$WORK/huge.txt"
  dbg a "put-file big $WORK/big.txt" "put-file huge $WORK/huge.txt" 'put small|# Small after huge'
  eventually 20 "~1 MB note syncs intact" bash -c "[ \"\$(python3 '$WORK/q.py' sha '$WORK' $PORT $TOKEN b big)\" = \"\$(python3 '$WORK/q.py' sha '$WORK' $PORT $TOKEN a big)\" ]"
  eventually 10 "a note after the oversized one still syncs" body_is b small '# Small after huge'
  check "oversized note is kept locally" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a huge dirty)\" = 1 ]"
  check "oversized note never reached the server" body_is server huge '<missing>'
  dbg a >/dev/null
  check "status says it is too large" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['blocked']\" | grep -qx 1"
  dbg a "put-file huge $WORK/big.txt" >/dev/null
  eventually 15 "it syncs once small enough" bash -c "[ \"\$(python3 '$WORK/q.py' sha '$WORK' $PORT $TOKEN b huge)\" = \"\$(python3 '$WORK/q.py' sha '$WORK' $PORT $TOKEN a big)\" ]"

  log "- graceful server restart"
  local h0; h0=$(hellos a)
  stop_server
  dbg a 'put n4|# Edited while the server restarts'
  start_server
  eventually 20 "A reconnects after restart" bash -c "[ \$(grep -c 'hello device=\"[^\"]*(dev a)\"' '$WORK/server.log') -gt $h0 ]"
  eventually 10 "edit made during the restart arrives" body_is b n4 '# Edited while the server restarts'

  log "- server killed (SIGKILL) while A is typing"
  dbg a 'put n5|# Killed'
  cmds=(); for i in $(seq 1 80); do cmds+=("append n5| k$i"); done
  dbg a "${cmds[@]}" >/dev/null &
  local dpid=$!
  sleep 1.5; kill_server; sleep 2; start_server
  wait "$dpid"
  eventually 30 "converges after the kill" converged a b
  check "no edit lost (k1…k80 in order)" bash -c "python3 '$WORK/q.py' body '$WORK' $PORT $TOKEN b n5 | python3 -c 'import sys; b=sys.stdin.read(); sys.exit(0 if b == \"# Killed\" + \"\".join(\" k%d\" % i for i in range(1,81)) else 1)'"

  log "- offline queue survives an app restart"
  stop_server
  dbg a 'put n6|# Queued offline' 'append n1|\nedited offline' >/dev/null
  quit_app a
  check "quit flushed the edit to disk (dirty)" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a n6 dirty)\" = 1 ]"
  launch a
  start_server
  eventually 25 "queued edits reach B after restart" body_is b n6 '# Queued offline'
  eventually 10 "…all of them" contains b n1 "edited offline"

  log "- concurrent offline edits (LWW + conflicted copy)"
  dbg a 'put n8|# Shared\nbase' >/dev/null
  eventually 10 "shared note on both" body_is b n8 '# Shared\nbase'
  stop_server
  dbg a 'put n8|# Shared\nedited on A' >/dev/null
  sleep 1.1
  dbg b 'put n8|# Shared\nedited on B' >/dev/null
  start_server
  eventually 25 "converges" converged a b
  check "newest edit wins" body_is a n8 '# Shared\nedited on B'
  check "the other edit is kept as a conflicted copy" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN a \"body like '# Shared (conflicted copy%' and body like '%edited on A' and deleted = 0\")\" = 1 ]"
  check "…on both Macs" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN b \"body like '# Shared (conflicted copy%' and body like '%edited on A'\")\" = 1 ]"

  log "- trash, restore, delete permanently"
  dbg a 'trash n1' >/dev/null
  eventually 10 "trash propagates" bash -c "python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN b n1 meta | grep -q trashedAt"
  dbg b 'restore n1' >/dev/null
  eventually 10 "restore propagates" bash -c "! python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a n1 meta | grep -q trashedAt"
  dbg a 'purge n2' >/dev/null
  eventually 10 "permanent delete propagates" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN b n2 deleted)\" = 1 ]"
  check "tombstone has no body" body_is b n2 ''

  log "- server restored from an older backup (seq goes back)"
  "$SRV" backup "$WORK/backup" >/dev/null 2>&1 || BENTO_SYNC_DB="$WORK/server.db" "$SRV" backup "$WORK/backup" >/dev/null 2>&1
  local bk; bk=$(ls -t "$WORK"/backup/*.db 2>/dev/null | head -1)
  dbg a 'put n7|# After the backup' 'append n4| (after backup)' >/dev/null
  dbg b 'put n9|# Also after the backup' >/dev/null
  eventually 15 "in sync before the restore" converged a b
  if [ -n "$bk" ]; then
    stop_server
    rm -f "$WORK/server.db" "$WORK/server.db-wal" "$WORK/server.db-shm"
    cp "$bk" "$WORK/server.db"
    start_server
    eventually 30 "clients resend what the restored server lost" body_is server n7 '# After the backup'
    eventually 20 "converges after the restore" converged a b
    check "…including B's note" body_is server n9 '# Also after the backup'
    check "no spurious conflicted copies" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN a \"body like '%conflicted copy%'\")\" = 1 ]"
  else
    bad "server backup command failed"
  fi

  log "- 1013 (client too far behind)"
  kill -STOP "$(pid b)"
  python3 - "$PORT" "$TOKEN" <<'EOF'
import json, sys, urllib.request, concurrent.futures
port, token = sys.argv[1], sys.argv[2]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
body = "# Flood\n" + ("flood " * 11000)
def put(i):
    data = json.dumps({"id": f"flood-{i}", "body": body + str(i), "updated_at": 1_000_000 + i}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/notes/flood-{i}", data=data, method="PUT",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    opener.open(req, timeout=20).read()
with concurrent.futures.ThreadPoolExecutor(8) as ex:
    list(ex.map(put, range(600)))
EOF
  sleep 1
  kill -CONT "$(pid b)"
  eventually 30 "server dropped the lagging client (1013)" grep -q "lagged" "$WORK/server.log"
  eventually 40 "B catches up after reconnecting" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN b \"id like 'flood-%'\")\" = 600 ]"
  eventually 20 "converges after the flood" converged a b

  log "- wrong / missing token"
  quit_app b
  printf 'wrong-token-0123456789' > "$WORK/b/config/sync-token"
  launch b
  eventually 15 "wrong token: B says Token rejected" state_is b unauthorized
  dbg a 'put n11|# While B was rejected' >/dev/null
  printf '%s' "$TOKEN" > "$WORK/b/config/sync-token"
  eventually 45 "B re-reads the token and catches up" body_is b n11 '# While B was rejected'
  quit_app b
  rm -f "$WORK/b/config/sync-token"
  launch b
  eventually 15 "missing token: B says No sync token" state_is b noToken
  printf '%s' "$TOKEN" > "$WORK/b/config/sync-token"
  eventually 40 "B picks the token up" state_is b connected

  log "- server unreachable at launch"
  quit_app a
  stop_server
  launch a
  eventually 15 "A starts offline" state_is a offline
  dbg a 'put n12|# Written before the server came up' >/dev/null
  start_server
  eventually 40 "A connects once the server is up" body_is b n12 '# Written before the server came up'

  log "- crash safety (SIGKILL while typing)"
  dbg a 'put n13|# Crash'
  cmds=(); for i in $(seq 1 40); do cmds+=("append n13| c$i"); done
  dbg a "${cmds[@]}" >/dev/null &
  dpid=$!
  sleep 1.2; kill -9 "$(pid a)"; wait "$dpid" 2>/dev/null
  check "DB intact after SIGKILL" bash -c "[ \"\$(sqlite3 '$WORK/a/support/Notes/notes.sqlite' 'pragma integrity_check')\" = ok ]"
  check "what reached disk is a clean prefix of the typing" bash -c "python3 '$WORK/q.py' body '$WORK' $PORT $TOKEN a n13 | python3 -c 'import sys; b=sys.stdin.read(); full=\"# Crash\" + \"\".join(\" c%d\" % i for i in range(1,41)); sys.exit(0 if full.startswith(b) and b.startswith(\"# Crash\") else 1)'"
  launch a
  eventually 25 "converges after the crash" converged a b

  log "- idle cost"
  sleep 3
  local ca cb; ca=$(cputime a); cb=$(cputime b); sleep 20
  local da=$(( $(cputime a) - ca )) db=$(( $(cputime b) - cb ))
  log "    CPU over 20 s idle (connected, window hidden): A $((da * 10)) ms, B $((db * 10)) ms"
  check "idle CPU ~0 (< 200 ms per 20 s)" bash -c "[ $da -lt 20 ] && [ $db -lt 20 ]"
  kill_all
}

# ---------------------------------------------------------------- GUI suite (real input)

keyname() { # one character -> bentoctl key combo
  case "$1" in
    [a-z0-9]) echo "$1" ;;
    [A-Z]) echo "shift+$(echo "$1" | tr '[:upper:]' '[:lower:]')" ;;
    ' ') echo space ;; '#') echo shift+3 ;; '-') echo minus ;; '*') echo shift+8 ;; '.') echo period ;;
    ',') echo comma ;; '/') echo slash ;; '[') echo leftbracket ;; ']') echo rightbracket ;; '>') echo shift+period ;;
    '_') echo shift+minus ;; ':') echo shift+semicolon ;; '`') echo grave ;; '!') echo shift+1 ;;
    *) echo "" ;;
  esac
}
# type_into <bundle id> <text> (\n = return, \t = tab)
type_into() {
  local b=$1 text=$2 keys=() i c
  text=${text//\\n/$'\n'}; text=${text//\\t/$'\t'}
  for ((i = 0; i < ${#text}; i++)); do
    c=${text:i:1}
    if [ "$c" = $'\n' ]; then keys+=(return); elif [ "$c" = $'\t' ]; then keys+=(tab); else keys+=("$(keyname "$c")"); fi
  done
  "$CTL" key "${keys[@]}" --expect "$b"
}
# press/click: exit 75 (user came back) stops the session; a refused input (target not ours)
# is a test failure, never a reason to send input elsewhere
press() { local b=$1; shift; "$CTL" key "$@" --expect "$b"; local rc=$?; [ $rc = 75 ] && return 75; [ $rc != 0 ] && bad "keys refused: $*"; return 0; }
click() { local b=$1; shift; "$CTL" click "$@" --expect "$b"; local rc=$?; [ $rc = 75 ] && return 75; [ $rc != 0 ] && bad "click refused: $*"; return 0; }
# aframe <instance>: AX-style frame "x y w h" of its notes window (largest on-screen window)
aframe() {
  local o
  for o in "BentoE2E-$1" Bento; do
    "$CTL" windows "$o" 2>/dev/null | awk '$5 >= 300 && $6 >= 140 {printf "%d %d %d %d %d\n", $5 * $6, $3, $4, $5, $6}' | sort -rn | head -1 | cut -d' ' -f2- | grep . && return 0
  done
  return 1
}
guarded() { "$ROOT/scripts/e2e/session" check >/dev/null || { log "user became active: stopping"; return 75; }; }
frontmost() { "$CTL" frontmost; }
gui_cleanup() {
  for n in a b; do alive "$n" && kill "$(pid "$n")" 2>/dev/null; done
  osascript -e 'tell application "TextEdit" to close (every document whose path is "/tmp/notes-qa.txt") saving no' >/dev/null 2>&1
  stop_server
}
close_scratch() {
  osascript -e 'tell application "TextEdit" to close (every document whose path is "/tmp/notes-qa.txt") saving no' >/dev/null 2>&1
}

other_instances() {
  ps -axo pid,command | grep -E "/(Bento|DevNotes)$" | grep -v "$WORK/" | grep -vF "$INSTALLED_APP_REAL/" | grep -v grep
}

gui_session_1() {
  log "== GUI 1: hotkey, typing, shortcuts, quit mid-typing =="
  local A; A=$(bid a)
  if other_instances >/dev/null; then log "    warning: other Bento dev instances may own ⌃⌥N:"; other_instances | sed 's/^/      /'; fi
  launch a
  printf 'Notes QA scratch document\n' > /tmp/notes-qa.txt
  open -a TextEdit /tmp/notes-qa.txt; sleep 1.5
  "$CTL" front com.apple.TextEdit notes-qa >/dev/null
  check "TextEdit (own scratch doc) frontmost" bash -c "[ \"\$($CTL frontmost)\" = com.apple.TextEdit ]"

  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 0.8
  check "⌃⌥N shows and focuses the notes window" bash -c "[ \"\$($CTL frontmost)\" = $A ]"
  dbg a >/dev/null
  check "window visible and key" bash -c "[ \"\$(python3 '$WORK/q.py' json '$WORK/a/dump.json' \"(d['visible'], d['key'])\")\" = '(True, True)' ]"
  check "float on top (floating level)" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['level']\" | grep -qx 3"

  guarded || return 75
  type_into "$A" '# Hello\n- one\ntwo' || return 75
  sleep 0.4; dbg a >/dev/null
  check "typed markdown: heading, list continuation" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'] == '# Hello\\n- one\\n- two'\" | grep -qx True"
  press "$A" cmd+a delete || return 75
  type_into "$A" '- [ ] first\nsecond\n\tnested\nthird' || return 75
  sleep 0.3; dbg a >/dev/null
  check "task list continuation + Tab indent" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'] == '- [ ] first\\n- [ ] second\\n    - [ ] nested\\n    - [ ] third'\" | grep -qx True"
  press "$A" return return return || return 75
  sleep 0.2; dbg a >/dev/null
  check "Return on empty items: outdent, then end the list" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'].endswith('    - [ ] third\\n')\" | grep -qx True"

  guarded || return 75
  type_into "$A" 'word' || return 75
  press "$A" shift+opt+left cmd+b || return 75; sleep 0.2; dbg a >/dev/null
  check "⌘B bolds the selected word" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'].endswith('\\n**word**')\" | grep -qx True"
  press "$A" cmd+z || return 75; sleep 0.2; dbg a >/dev/null
  check "⌘Z undoes the formatting" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'].endswith('\\nword')\" | grep -qx True"
  press "$A" cmd+shift+z || return 75; sleep 0.2; dbg a >/dev/null
  check "⇧⌘Z redoes it" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'].endswith('\\n**word**')\" | grep -qx True"
  local first; first=$(dumpq a "d['currentID']")

  guarded || return 75
  press "$A" cmd+n || return 75
  type_into "$A" 'Second note' || return 75
  press "$A" cmd+p || return 75; sleep 0.4
  type_into "$A" 'first' || return 75; sleep 0.3
  press "$A" return || return 75; sleep 0.4; dbg a >/dev/null
  check "⌘N, ⌘P search + ↩ opens the first note" bash -c "[ \"\$(python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['currentID']\")\" = '$first' ]"
  press "$A" cmd+leftbracket || return 75; sleep 0.3; dbg a >/dev/null
  check "⌘[ goes back to the second note" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['header']\" | grep -qx 'Second note'"
  press "$A" cmd+rightbracket || return 75; sleep 0.3; dbg a >/dev/null
  check "⌘] goes forward again" bash -c "[ \"\$(python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['currentID']\")\" = '$first' ]"
  press "$A" cmd+shift+p || return 75; sleep 0.3; dbg a >/dev/null
  check "⇧⌘P pins" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"[n['pinned'] for n in d['notes'] if n['id'] == d['currentID']][0]\" | grep -qx True"
  press "$A" cmd+d || return 75; sleep 0.3
  press "$A" ctrl+x || return 75; sleep 0.6
  press "$A" return || return 75; sleep 0.4; dbg a >/dev/null
  check "⌘D duplicates, ⌃X + ↩ moves it to Recently Deleted" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"sum(1 for n in d['notes'] if n['trashed'])\" | grep -qx 1"

  guarded || return 75
  press "$A" escape || return 75; sleep 0.5; dbg a >/dev/null
  check "Esc hides the window" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['visible']\" | grep -qx False"
  check "…and focus goes back to TextEdit" bash -c "[ \"\$($CTL frontmost)\" = com.apple.TextEdit ]"
  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 0.6
  "$CTL" front com.apple.TextEdit notes-qa >/dev/null; sleep 0.4
  dbg a >/dev/null
  check "click away: still visible (floats), not key" bash -c "[ \"\$(python3 '$WORK/q.py' json '$WORK/a/dump.json' \"(d['visible'], d['key'])\")\" = '(True, False)' ]"
  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 0.6
  check "⌃⌥N on a visible, unfocused window focuses it" bash -c "[ \"\$($CTL frontmost)\" = $A ]"
  press "$A" ctrl+opt+n || return 75; sleep 0.6; dbg a >/dev/null
  check "⌃⌥N on the focused window hides it" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['visible']\" | grep -qx False"

  log "- quit mid-typing"
  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 0.6
  press "$A" cmd+n || return 75
  type_into "$A" 'Typed right before quit' || return 75
  press "$A" cmd+q || return 75
  for _ in $(seq 1 30); do alive a || break; sleep 0.1; done
  check "⌘Q quits" bash -c "! kill -0 $(pid a) 2>/dev/null"
  check "the last keystrokes were saved" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN a \"body = 'Typed right before quit'\")\" = 1 ]"
}

gui_session_2() {
  log "== GUI 2: frame restore, full screen, footer, paste, long note, live typing =="
  local A B; A=$(bid a); B=$(bid b)
  [ -f "$WORK/a/support/Notes/notes.sqlite" ] || { launch a; quit_app a; }
  sqlite3 "$WORK/a/support/Notes/notes.sqlite" "insert or replace into kv (key, value) values ('window.frame', '{{6000, 4000}, {400, 450}}')"
  python3 - "$WORK/a/support/Notes/notes.sqlite" <<'EOF2'
import random, sqlite3, sys, time
c = sqlite3.connect(sys.argv[1]); now = int(time.time() * 1000); random.seed(1)
words = "milk eggs bread project meeting idea plan travel budget review notes code swift rust design".split()
for i in range(500):
    body = "# Seed %d %s\n" % (i, random.choice(words)) + "\n".join("- [ ] %s %d" % (random.choice(words), j) for j in range(20))
    t = now - i * 60000
    c.execute("insert or replace into notes (id, body, created_at, updated_at, dirty, opened_at) values (?, ?, ?, ?, 0, ?)", ("seed-%d" % i, body, t, t, t))
c.commit()
EOF2
  launch a
  open -a TextEdit /tmp/notes-qa.txt; sleep 1
  "$CTL" front com.apple.TextEdit notes-qa >/dev/null
  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 0.8
  local f; f=$(aframe a)
  log "    window frame after an off-screen saved frame: $f"
  check "off-screen saved frame comes back on screen" bash -c "python3 -c 'import sys; x,y,w,h=map(int,sys.argv[1:5]); sys.exit(0 if 0<=x<4000 and 0<=y<3000 else 1)' $f"

  guarded || return 75
  # footer: click the status text to cycle words / characters
  dbg a 'cmd newNote' 'type Footer test words' >/dev/null
  local before; before=$(dumpq a "d['footer']")
  read -r fx fy fw fh <<< "$f"
  click "$A" $((fx + fw / 2)) $((fy + fh - 15)) || return 75; sleep 0.3; dbg a >/dev/null
  local after; after=$(dumpq a "d['footer']")
  log "    footer: '$before' → '$after'"
  check "clicking the footer switches words ↔ characters" bash -c "[ '$before' != '$after' ] && echo '$after' | grep -q Character"
  press "$A" cmd+opt+comma || return 75; sleep 0.3; dbg a >/dev/null
  check "⌥⌘, shows the format bar" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['settings']['showFormatBar']\" | grep -qx True"
  press "$A" cmd+opt+comma || return 75

  # auto-size: ⇧⌘/ fits the short note, more lines make it taller
  press "$A" cmd+shift+slash || return 75; sleep 0.3
  local h0; h0=$(aframe a | awk '{print $4}')
  dbg a 'type \nline\nline\nline\nline\nline\nline\nline\nline' >/dev/null
  local h1; h1=$(aframe a | awk '{print $4}')
  log "    auto-size: height $h0 → $h1"
  check "auto-size grows with the content" bash -c "[ ${h1:-0} -gt ${h0:-0} ]"
  press "$A" cmd+shift+slash || return 75

  log "- checkbox click"
  dbg a 'cmd newNote' 'type - [ ] click me\nafter' >/dev/null
  local box; box=$(dumpq a "d['checkboxes'][0] if d['checkboxes'] else ''")
  if [ -n "$box" ]; then
    local cx cy
    read -r cx cy <<< "$(python3 -c 'import re,sys; n=[float(v) for v in re.findall(r"[-0-9.]+", sys.argv[1])]; h=float(sys.argv[2]); print(int(n[0]+n[2]/2), int(h-(n[1]+n[3]/2)))' "$box" "$("$CTL" screens | head -1 | awk '{print $5}')")"
    click "$A" "$cx" "$cy" || return 75; sleep 0.3; dbg a >/dev/null
    check "clicking the checkbox ticks the task" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body'].startswith('- [x] click me')\" | grep -qx True"
  else
    bad "no checkbox rect in dump"
  fi

  log "- paste (private pasteboard, never the user's clipboard)"
  printf '{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0 Rich {\\b bold} text\\par second line}' > "$WORK/p.rtf"
  printf '<p>Html <b>bold</b></p><ul><li>item</li></ul>' > "$WORK/p.html"
  python3 -c 'import sys; open(sys.argv[1],"w").write(("pasted line\r\n") * 30000)' "$WORK/p.txt"
  python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))' "$WORK/p.png"
  dbg a 'cmd newNote' "paste-file $WORK/p.rtf public.rtf" 'type \n' "paste-file $WORK/p.html public.html" 'type \n' "paste-file $WORK/p.png public.png" >/dev/null
  check "RTF and HTML paste as plain text, an image pastes nothing" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"d['body']\" | python3 -c 'import sys; b=sys.stdin.read(); sys.exit(0 if b.startswith(\"Rich bold text\nsecond line\nHtml bold\") and \"item\" in b else 1)'"
  dbg a 'cmd newNote' "paste-file $WORK/p.txt public.utf8-plain-text" >/dev/null
  check "large paste (390 KB, CRLF) lands with \\n line ends" bash -c "python3 '$WORK/q.py' json '$WORK/a/dump.json' \"(len(d['body']), chr(13) in d['body'])\" | grep -qx '(360000, False)'"

  log "- browse 500 notes"
  dbg a 'bench-browse milk' >/dev/null
  log "    open Browse: $(dumpq a "round(d['bench']['openMs'])") ms, filter 'milk': $(dumpq a "round(d['bench']['filterMs'])") ms, rows $(dumpq a "d['bench']['rows']")"
  check "searching 500+ notes stays under 100 ms (debug build)" bash -c "python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) < 100 else 1)' $(dumpq a "d['bench']['filterMs']")"
  press "$A" escape || return 75; sleep 0.2

  log "- very long note (100k characters)"
  python3 -c 'import sys; L=["## Section %d" % i if i%7==0 else ("- [ ] task %d with **bold** and `code`" % i if i%3 else "Plain text line %d with a [link](https://example.com) and emoji 😀 日本語 مرحبا" % i) for i in range(1800)]; open(sys.argv[1],"w").write("\n".join(L))' "$WORK/long.md"
  dbg a "put-file long $WORK/long.md" 'bench-open long' >/dev/null
  log "    open 100k note: $(dumpq a "round(d['bench']['openMs'])") ms"
  dbg a 'caret end' 'bench-type 40' >/dev/null
  local mean max; mean=$(dumpq a "round(d['bench']['meanMs'], 1)"); max=$(dumpq a "round(d['bench']['maxMs'], 1)")
  log "    typing at the end of a 100k note: mean $mean ms, worst $max ms per keystroke (debug build)"
  check "typing in a 100k note stays under 16 ms per key (debug build)" bash -c "python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) < 16 else 1)' $mean"
  dbg a 'select 5000 0' 'bench-type 40' >/dev/null
  mean=$(dumpq a "round(d['bench']['meanMs'], 1)")
  log "    typing near the top (caret scrolled into view): mean $mean ms per keystroke"
  check "typing near the top of a 100k note stays under 16 ms per key" bash -c "python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) < 16 else 1)' $mean"

  log "- live typing between two instances"
  guarded || return 75
  launch b
  eventually 15 "B connects" bash -c "grep -q 'hello device=\"[^\"]*(dev b)\"' '$WORK/server.log'"
  dbg a 'cmd newNote' 'type # Live\nshared line' >/dev/null
  local live; live=$(dumpq a "d['currentID']")
  eventually 10 "B gets A's new note" body_is b "$live" '# Live\nshared line'
  dbg b 'open' "open-title Live" 'select 14 0' >/dev/null   # B's caret before "line"
  "$CTL" front "$A" Live >/dev/null; sleep 0.3
  press "$A" cmd+up || return 75                            # A's caret to the heading text
  type_into "$A" 'Top ' || return 75
  eventually 10 "B gets A's typing while B has the note open" bash -c "python3 '$WORK/q.py' body '$WORK' $PORT $TOKEN b '$live' | grep -q '^# Top Live'"
  sleep 0.5; dbg b >/dev/null
  check "B's editor shows it" bash -c "python3 '$WORK/q.py' json '$WORK/b/dump.json' \"d['body'].startswith('# Top Live')\" | grep -qx True"
  check "B's caret stayed before \"line\" (shifted by the 4 inserted characters)" bash -c "[ \"\$(python3 '$WORK/q.py' json '$WORK/b/dump.json' \"d['selection']\")\" = '[18, 0]' ]"

  log "- opening over a full-screen app"
  press "$A" escape || return 75
  dbg b 'hide' >/dev/null
  "$CTL" front com.apple.TextEdit notes-qa >/dev/null; sleep 0.3
  press com.apple.TextEdit ctrl+cmd+f || return 75; sleep 2.5
  press com.apple.TextEdit ctrl+opt+n || return 75; sleep 1
  check "⌃⌥N over full-screen TextEdit focuses notes" bash -c "[ \"\$($CTL frontmost)\" = $A ]"
  check "the notes window is on screen there" bash -c "$CTL windows BentoE2E-a | grep -q . || $CTL windows Bento | grep -q ."
  press "$A" escape || return 75; sleep 0.5
  "$CTL" front com.apple.TextEdit notes-qa >/dev/null; sleep 0.3
  press com.apple.TextEdit ctrl+cmd+f || return 75; sleep 2.5
}

gui_suite() {
  [ -x "$CTL" ] || swiftc -O "$ROOT/scripts/e2e/bentoctl.swift" -o "$CTL"
  start_server || return 1
  home a gui; home b gui-b
  local rc=0
  if [ "${1:-}" != 2 ]; then
    "$ROOT/scripts/e2e/session" start notes
    gui_session_1 || rc=$?
    for n in a b; do alive "$n" && kill "$(pid "$n")" 2>/dev/null; done
    close_scratch
    "$ROOT/scripts/e2e/session" end notes
    [ "$rc" = 75 ] && { log "GUI session 1 interrupted by the user"; return 75; }
  fi
  "$ROOT/scripts/e2e/session" start notes
  gui_session_2 || rc=$?
  gui_cleanup
  "$ROOT/scripts/e2e/session" end notes
  [ "$rc" = 75 ] && { log "GUI session 2 interrupted by the user"; return 75; }
  return 0
}

# ---------------------------------------------------------------- main

trap 'kill_all 2>/dev/null' EXIT
mode=${1:-all}
build
prepare
case "$mode" in
  sync) sync_suite ;;
  gui) gui_suite ;;
  gui2) gui_suite 2 ;;
  all) sync_suite; prepare; gui_suite ;;
  *) log "usage: $0 sync|gui|all"; exit 2 ;;
esac
log ""
log "notes e2e: $PASSES passed, $FAILS failed"
for f in "${FAILED[@]+"${FAILED[@]}"}"; do log "  failed: $f"; done
kill_all 2>/dev/null
rm -f /tmp/notes-qa.txt
# keep instance homes, DBs and logs only when something failed
if [ "$FAILS" -eq 0 ]; then rm -rf "$WORK"; else log "logs and databases kept in $WORK"; fi
[ "$FAILS" -eq 0 ]
