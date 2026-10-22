#!/bin/bash
# End-to-end tests for Todo: the real app (debug build) against a local bento-sync.
#
#   scripts/e2e/todo.sh sync    headless: two instances + a local server; REST puts reach both,
#                               notes never show up as todos, stale versions are healed,
#                               reconnect after a server restart. No windows, no input.
#   scripts/e2e/todo.sh gui     one GUI session (scripts/e2e/session start/end todo): real
#                               Todoist keys into instance A (bentoctl --expect), every change
#                               checked in A's database and in instance B through sync.
#   scripts/e2e/todo.sh all     both
#
# Data safety: every instance has its own BENTO_HOME under $WORK and syncs with a local
# bento-sync on a free port (temp DB, random token). The live server is never touched.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK=${TODO_E2E_WORK:-/tmp/bento-e2e-todo}
SRV="$ROOT/server/target/debug/bento-sync"
BIN="$ROOT/.build/debug/Bento"
CTL=/tmp/bentoctl
PASSES=0; FAILS=0; FAILED=()
SERVER_PID=""

log() { printf '%s\n' "$*"; }
ok() { PASSES=$((PASSES + 1)); log "  ✓ $*"; }
bad() { FAILS=$((FAILS + 1)); FAILED+=("$*"); log "  ✗ $*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
eventually() { # eventually <seconds> <description> <command...>
  local t=$1 d=$2; shift 2
  local end=$(( $(date +%s) + t ))
  while :; do
    if "$@" >/dev/null 2>&1; then ok "$d"; return 0; fi
    [ "$(date +%s)" -ge "$end" ] && { bad "$d (after ${t}s)"; "$@" 2>&1 | head -5 | sed 's/^/      /'; return 1; }
    sleep 0.3
  done
}

# ---------------------------------------------------------------- setup

build() {
  log "building app and server…"
  (cd "$ROOT" && swift build --product Bento 2>&1 | grep -E "error|Build" | tail -3) || exit 1
  (cd "$ROOT/server" && cargo build -q 2>&1 | tail -3) || exit 1
  [ -x "$SRV" ] && [ -x "$BIN" ] || { log "build failed"; exit 1; }
}

prepare() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  TOKEN="e2e-$(openssl rand -hex 16)"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  # url <home> <bento:// url>: addressed to one dev instance by its BENTO_HOME
  cat > "$WORK/url.swift" <<'EOF'
import Foundation
DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.url"),
    object: CommandLine.arguments[1], userInfo: ["url": CommandLine.arguments[2]], deliverImmediately: true)
EOF
  swiftc -O "$WORK/url.swift" -o "$WORK/url" 2>/dev/null || exit 1
  write_q
}

write_q() {
  cat > "$WORK/q.py" <<'EOF'
import json, sqlite3, sys, urllib.request
work, port, token = sys.argv[2], sys.argv[3], sys.argv[4]
def docs(name):
    try:
        c = sqlite3.connect(f"{work}/{name}/support/Todo/todo.sqlite", timeout=5)
        c.row_factory = sqlite3.Row
        out = {}
        for r in c.execute("select * from docs"):
            d = dict(r)
            d["b"] = json.loads(d["body"]) if d["body"] else {}
            out[d["id"]] = d
        return out
    except Exception:
        return {}
def server(coll="todos"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/c/{coll}?since=0", headers={"Authorization": "Bearer " + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    out = {}
    for n in json.load(opener.open(req, timeout=5))["docs"]:
        n["b"] = json.loads(n["body"]) if n["body"] else {}
        out[n["id"]] = n
    return out
def tasks(name, title=None):
    return [d for d in docs(name).values() if not d["deleted"] and d["b"].get("type") == "task"
            and (title is None or d["b"]["fields"].get("title") == title)]
cmd = sys.argv[1]
if cmd == "field":      # field <inst> <title> <field>  -> JSON of the field of the live task with that title
    t = tasks(sys.argv[5], sys.argv[6])
    print(json.dumps(t[0]["b"]["fields"].get(sys.argv[7]) if t else "<missing>", sort_keys=True))
elif cmd == "count":    # count <inst> <title>
    print(len(tasks(sys.argv[5], sys.argv[6])))
elif cmd == "ntasks":   # ntasks <inst>
    print(len(tasks(sys.argv[5])))
elif cmd == "project":  # project <inst> <name> -> id
    p = [d for d in docs(sys.argv[5]).values() if not d["deleted"] and d["b"].get("type") == "project" and d["b"]["fields"].get("name") == sys.argv[6]]
    print(p[0]["id"] if p else "<missing>")
elif cmd == "has":      # has <inst> <id>
    sys.exit(0 if sys.argv[6] in docs(sys.argv[5]) else 1)
elif cmd == "deleted":  # deleted <inst> <id>
    d = docs(sys.argv[5]).get(sys.argv[6]); sys.exit(0 if d and d["deleted"] else 1)
elif cmd == "id":       # id <inst> <title>
    t = tasks(sys.argv[5], sys.argv[6]); print(t[0]["id"] if t else "<missing>")
elif cmd == "converged":  # converged <inst>...: same live fields everywhere as on the server, nothing dirty
    s = server(); ok = True
    for name in sys.argv[5:]:
        r = docs(name)
        dirty = [i for i, d in r.items() if d["dirty"]]
        if dirty: print(name, "dirty:", dirty[:5]); ok = False
        for i, n in s.items():
            m = r.get(i)
            if m is None: print(name, "missing", i); ok = False; continue
            if bool(m["deleted"]) != bool(n["deleted"]) or (not n["deleted"] and m["b"].get("fields") != n["b"].get("fields")):
                print(name, "differs", i, m["b"].get("fields"), n["b"].get("fields")); ok = False
    sys.exit(0 if ok else 1)
elif cmd == "servertitle":  # servertitle <id>
    print(server()[sys.argv[5]]["b"]["fields"]["title"])
EOF
}
# doc <id> <title> <field clock ms> <updated_at ms>: a put body for a task (priority 2, label x)
doc() {
  python3 - "$@" <<'PY'
import json, sys
i, title, clock, upd = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
fields = {"title": title, "project": None, "labels": ["x"], "priority": 2, "due": None, "completed_at": None, "order": 1}
body = {"type": "task", "fields": fields, "clocks": {k: clock for k in fields}}
print(json.dumps({"id": i, "body": json.dumps(body), "updated_at": upd, "created_at": clock}))
PY
}
q() { python3 "$WORK/q.py" "$1" "$WORK" "$PORT" "$TOKEN" "${@:2}"; }
field_is() { [ "$(q field "$1" "$2" "$3")" = "$4" ]; }
converged() { q converged "$@"; }

start_server() {
  BENTO_SYNC_TOKEN="$TOKEN" BENTO_SYNC_DB="$WORK/server.db" BENTO_SYNC_ADDR="127.0.0.1:$PORT" "$SRV" >> "$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -s --noproxy '*' "http://127.0.0.1:$PORT/v1/health" | grep -q '"ok"' && return 0; sleep 0.1; done
  log "server did not start"; return 1
}
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }
api() { # api <method> <path> [json]
  curl -s --noproxy '*' -X "$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "http://127.0.0.1:$PORT$2" ${3:+-d "$3"}
}

# home <name> [gui]: config + token + own .app bundle (unique bundle id for bentoctl --expect)
home() {
  local n=$1 mode=${2:-headless} h="$WORK/$1"
  mkdir -p "$h/config"
  printf '%s' "$TOKEN" > "$h/config/sync-token"; chmod 600 "$h/config/sync-token"
  local shortcuts='{"todo.toggle":"","todo.quick-add":""}'
  [ "$mode" = gui ] && shortcuts='{"todo.toggle":"","todo.quick-add":""}'
  cat > "$h/config/config.json" <<EOF
{"general": {"enabledModules": {"shot":false,"windows":false,"tiling":false,"launcher":false,"clipboard":false,"notes":false,"todo":true}, "showMenuBarIcon": false},
 "shortcuts": $shortcuts,
 "todo": {"homeView": "inbox", "sync": {"enabled": true, "server": "http://127.0.0.1:$PORT", "tokenFile": "$h/config/sync-token"}}}
EOF
  local app="$WORK/$n.app"
  mkdir -p "$app/Contents/MacOS"
  cp "$BIN" "$app/Contents/MacOS/Bento"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.charles.bento.e2e.todo-$n</string>
<key>CFBundleName</key><string>BentoE2E-$n</string>
<key>CFBundleExecutable</key><string>Bento</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
}
bid() { echo "com.charles.bento.e2e.todo-$1"; }
launch() {
  local n=$1
  BENTO_HOME="$WORK/$n" BENTO_DEV=1 "$WORK/$n.app/Contents/MacOS/Bento" >> "$WORK/$n.log" 2>&1 &
  echo $! > "$WORK/$n.pid"
  sleep 1.2
}
pid() { cat "$WORK/$1.pid" 2>/dev/null; }
alive() { kill -0 "$(pid "$1")" 2>/dev/null; }
action() { "$WORK/url" "$WORK/$1" "bento://action/$2"; sleep 0.6; }
kill_all() {
  for f in "$WORK"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  sleep 0.5
  stop_server
}
cputime() { ps -o cputime= -p "$(pid "$1")" | awk -F'[:.]' '{ printf "%d\n", ($1 * 60 + $2) * 100 + $3 }'; }
date_in() { python3 -c "import datetime,sys; print((datetime.date.today()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }
next_weekday() { python3 -c "import datetime,sys; t=datetime.date.today(); d=(int(sys.argv[1])-t.weekday()-1)%7+1; print((t+datetime.timedelta(days=d)).isoformat())" "$1"; }

# ---------------------------------------------------------------- headless sync suite

suite_sync() {
  log "== sync suite"
  prepare; start_server
  home a; home b
  launch a; launch b
  local now; now=$(python3 -c 'import time; print(int(time.time()*1000))')

  log "- a task put over REST reaches both instances"
  api PUT /v1/c/todos/rest-1 "$(doc rest-1 'From REST' "$now" "$now")" >/dev/null
  eventually 10 "A has it" field_is a "From REST" priority 2
  eventually 10 "B has it" field_is b "From REST" priority 2

  log "- notes never show up as todos"
  api PUT /v1/notes/note-1 "{\"id\":\"note-1\",\"body\":\"# a note\",\"updated_at\":$now}" >/dev/null
  sleep 1.5
  check "A has no note-1" bash -c "! python3 '$WORK/q.py' has '$WORK' $PORT $TOKEN a note-1"
  check "B has no note-1" bash -c "! python3 '$WORK/q.py' has '$WORK' $PORT $TOKEN b note-1"

  log "- a stale version (older title clock, newer stamp) is healed by the clients"
  local newer=$((now + 5000)) stale=$((now + 9000))
  api PUT /v1/c/todos/rest-1 "$(doc rest-1 'Newest title' "$newer" "$newer")" >/dev/null
  eventually 10 "B sees the new title" field_is b "Newest title" priority 2
  api PUT /v1/c/todos/rest-1 "$(doc rest-1 'Stale title' "$now" "$stale")" >/dev/null
  eventually 10 "server is healed back to the newest title" bash -c "[ \"\$(python3 '$WORK/q.py' servertitle '$WORK' $PORT $TOKEN rest-1)\" = 'Newest title' ]"
  eventually 10 "everything converges" converged a b

  log "- a delete over REST removes it everywhere"
  api DELETE "/v1/c/todos/rest-1?updated_at=$((now + 20000))" >/dev/null
  eventually 10 "A tombstoned" q deleted a rest-1
  eventually 10 "B tombstoned" q deleted b rest-1

  log "- reconnect after a server restart"
  stop_server; sleep 2
  start_server
  api PUT /v1/c/todos/rest-2 "$(doc rest-2 'After restart' "$((now + 30000))" "$((now + 30000))")" >/dev/null
  eventually 70 "A gets a task put after the restart" bash -c "[ \"\$(python3 '$WORK/q.py' count '$WORK' $PORT $TOKEN a 'After restart')\" = 1 ]"

  log "- a server without collections (pre-todo bento-sync) is never synced with"
  local oldport; oldport=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  python3 - "$oldport" "$WORK/old.log" <<'PY' &
import http.server, sys
log = open(sys.argv[2], "a", buffering=1)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        log.write(self.path + "\n")
        body = b'{"ok":true,"seq":0}'
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
  local oldpid=$!
  home c
  sed -i '' "s#http://127.0.0.1:$PORT#http://127.0.0.1:$oldport#" "$WORK/c/config/config.json"
  launch c
  sleep 3
  check "asked the old server for /v1/health" grep -q "^/v1/health" "$WORK/old.log"
  check "never opened /v1/sync or REST on it" bash -c "! grep -qv '^/v1/health' '$WORK/old.log'"
  { kill "$(pid c)" "$oldpid"; wait "$oldpid"; } 2>/dev/null

  log "- idle cost"
  sleep 3
  local ca cb; ca=$(cputime a); cb=$(cputime b); sleep 15
  local da=$(( $(cputime a) - ca )) db=$(( $(cputime b) - cb ))
  log "    CPU over 15 s idle: A $((da * 10)) ms, B $((db * 10)) ms"
  check "idle CPU ~0 (< 150 ms per 15 s)" bash -c "[ $da -lt 15 ] && [ $db -lt 15 ]"
  kill_all
}

# ---------------------------------------------------------------- GUI suite (real input)

keyname() {
  case "$1" in
    [a-z0-9]) echo "$1" ;;
    [A-Z]) echo "shift+$(echo "$1" | tr '[:upper:]' '[:lower:]')" ;;
    ' ') echo space ;; '#') echo shift+3 ;; '@') echo shift+2 ;; '-') echo minus ;; '.') echo period ;;
    ',') echo comma ;; '/') echo slash ;; ':') echo shift+semicolon ;; '?') echo shift+slash ;;
    *) echo "" ;;
  esac
}
type_into() { # type_into <bundle id> <text>
  local b=$1 text=$2 keys=() i
  for ((i = 0; i < ${#text}; i++)); do keys+=("$(keyname "${text:i:1}")"); done
  "$CTL" key "${keys[@]}" --expect "$b"
}
press() { local b=$1; shift; "$CTL" key "$@" --expect "$b"; local rc=$?; [ $rc = 75 ] && return 75; [ $rc != 0 ] && bad "keys refused: $*"; return 0; }
guarded() { "$ROOT/scripts/e2e/session" check >/dev/null || { log "user became active: stopping"; return 75; }; }
shot() { # shot <name>: screenshot of instance A's todo window
  local id; id=$("$CTL" windows "BentoE2E-a" 2>/dev/null | awk '$5 >= 500 && $6 >= 300 {print $1; exit}')
  [ -n "$id" ] && screencapture -x -o -l "$id" "$WORK/shot-$1.png" && log "    screenshot: $WORK/shot-$1.png"
}

gui_session() {
  local A; A=$(bid a)
  log "- window opens on the toggle action and takes keys"
  action a todo.toggle
  sleep 0.8
  eventually 5 "A is frontmost" bash -c "[ \"\$($CTL frontmost)\" = '$A' ]" || return 1
  guarded || return 75

  log "- ⌥P creates a project"
  press "$A" opt+p; sleep 0.4
  type_into "$A" "Errands"; press "$A" return; sleep 0.6
  eventually 5 "project Errands in A" bash -c "[ \"\$(python3 '$WORK/q.py' project '$WORK' $PORT $TOKEN a Errands)\" != '<missing>' ]"
  eventually 8 "project Errands synced to B" bash -c "[ \"\$(python3 '$WORK/q.py' project '$WORK' $PORT $TOKEN b Errands)\" != '<missing>' ]"
  local pid_errands; pid_errands=$(q project a Errands)
  guarded || return 75

  log "- a + quick-add syntax adds a task to the current project"
  press "$A" a; sleep 0.4
  type_into "$A" "Buy milk tomorrow p1 @shop"; sleep 0.3
  shot editor
  press "$A" return; sleep 0.3
  type_into "$A" "Second task"; press "$A" return; sleep 0.3
  press "$A" escape; sleep 0.4
  eventually 5 "task in A with priority 1" field_is a "Buy milk" priority 1
  check "due tomorrow" field_is a "Buy milk" due "{\"date\": \"$(date_in 1)\"}"
  check "label shop" field_is a "Buy milk" labels '["shop"]'
  check "in project Errands" field_is a "Buy milk" project "\"$pid_errands\""
  check "Return kept adding: second task in Errands" field_is a "Second task" project "\"$pid_errands\""
  eventually 8 "B has the task with the same fields" field_is b "Buy milk" priority 1
  shot project
  guarded || return 75

  log "- e completes, z undoes"
  press "$A" k k; sleep 0.2   # top task
  press "$A" e; sleep 0.6
  eventually 5 "completed in A" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a 'Buy milk' completed_at)\" != null ]"
  eventually 8 "completed in B" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN b 'Buy milk' completed_at)\" != null ]"
  press "$A" z; sleep 0.6
  eventually 5 "undone in A" field_is a "Buy milk" completed_at null
  eventually 8 "undone in B" field_is b "Buy milk" completed_at null
  guarded || return 75

  log "- t schedules with natural language, 3 sets priority, v moves, l labels"
  press "$A" k k; sleep 0.2
  press "$A" t; sleep 0.4
  type_into "$A" "fri"; sleep 0.3
  shot schedule
  press "$A" return; sleep 0.5
  eventually 5 "due Friday" field_is a "Buy milk" due "{\"date\": \"$(next_weekday 4)\"}"
  press "$A" 3; sleep 0.4
  eventually 5 "priority 3" field_is a "Buy milk" priority 3
  press "$A" l; sleep 0.4
  type_into "$A" "home"; press "$A" return; press "$A" escape; sleep 0.5
  eventually 5 "label home added" field_is a "Buy milk" labels '["shop", "home"]'
  press "$A" v; sleep 0.4
  type_into "$A" "inbox"; press "$A" return; sleep 0.5
  eventually 5 "moved to Inbox" field_is a "Buy milk" project null
  eventually 8 "B agrees on all of it" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN b 'Buy milk' priority)\" = 3 ] && [ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN b 'Buy milk' project)\" = null ]"
  guarded || return 75

  log "- g i, q quick add, Enter edits"
  press "$A" g i; sleep 0.5
  press "$A" q; sleep 0.6
  type_into "$A" "Call mom today #Errands"; sleep 0.3
  shot quickadd
  press "$A" return; sleep 0.6
  eventually 5 "quick add: due today" field_is a "Call mom" due "{\"date\": \"$(date_in 0)\"}"
  check "quick add: project from #Errands" field_is a "Call mom" project "\"$pid_errands\""
  press "$A" g t; sleep 0.5
  shot today
  eventually 3 "A frontmost after quick add" bash -c "[ \"\$($CTL frontmost)\" = '$A' ]"
  guarded || return 75

  log "- x selects, bulk priority, ⌘⌫ deletes, z restores (in Upcoming, where both tasks show)"
  press "$A" g u; sleep 0.5
  press "$A" k k k k; sleep 0.2
  press "$A" x j x; sleep 0.2
  press "$A" 2; sleep 0.5
  eventually 5 "both selected tasks got priority 2" bash -c "[ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a 'Call mom' priority)\" = 2 ] && [ \"\$(python3 '$WORK/q.py' field '$WORK' $PORT $TOKEN a 'Buy milk' priority)\" = 2 ]"
  local id_mom; id_mom=$(q id a "Call mom")
  press "$A" escape; sleep 0.2   # clears the selection (doesn't close: something was selected)
  check "Esc with a selection keeps the window" bash -c "[ \"\$($CTL frontmost)\" = '$A' ]"
  press "$A" k k k; sleep 0.2
  press "$A" cmd+delete; sleep 0.6
  local gone=0
  q deleted a "$id_mom" && gone=1
  if [ $gone = 0 ]; then press "$A" j cmd+delete; sleep 0.6; fi
  eventually 5 "a task was deleted in A" bash -c "[ \"\$(python3 '$WORK/q.py' ntasks '$WORK' $PORT $TOKEN a)\" = 2 ]"
  eventually 8 "and in B" bash -c "[ \"\$(python3 '$WORK/q.py' ntasks '$WORK' $PORT $TOKEN b)\" = 2 ]"
  press "$A" z; sleep 0.6
  eventually 5 "undo restored it" bash -c "[ \"\$(python3 '$WORK/q.py' ntasks '$WORK' $PORT $TOKEN a)\" = 3 ]"
  eventually 8 "restored in B" bash -c "[ \"\$(python3 '$WORK/q.py' ntasks '$WORK' $PORT $TOKEN b)\" = 3 ]"
  guarded || return 75

  log "- ? shows the shortcuts, Esc closes the window"
  press "$A" shift+slash; sleep 0.5
  shot help
  press "$A" escape; sleep 0.3
  press "$A" escape; sleep 0.6
  check "window hidden" bash -c "! $CTL windows BentoE2E-a 2>/dev/null | awk '\$5 >= 500' | grep -q ."
  eventually 10 "everything converged" converged a b
}

suite_gui() {
  log "== GUI suite"
  prepare; start_server
  home a gui; home b
  "$ROOT/scripts/e2e/session" start todo || return 1
  launch a; launch b
  gui_session; local rc=$?
  for n in a b; do alive "$n" && kill "$(pid "$n")" 2>/dev/null; done
  stop_server
  "$ROOT/scripts/e2e/session" end todo
  [ $rc = 75 ] && bad "session interrupted by the user (rerun later)"
}

# ---------------------------------------------------------------- main

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0  # sourced: just the helpers

trap 'kill_all 2>/dev/null' EXIT
build
case "${1:-all}" in
  sync) suite_sync ;;
  gui) suite_gui ;;
  all) suite_sync; suite_gui ;;
  *) echo "usage: $0 sync|gui|all" >&2; exit 2 ;;
esac
log ""
log "$PASSES passed, $FAILS failed"
[ $FAILS = 0 ] || { printf '  - %s\n' "${FAILED[@]}"; exit 1; }
