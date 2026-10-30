# bento-sync

Tiny realtime sync server for Bento's floating notes and todos. Rust (tokio + axum + rusqlite),
one static ~2 MB binary, SQLite in WAL mode, ~3 MB RSS idle.
The wire contract is **[docs/SYNC_PROTOCOL.md](../docs/SYNC_PROTOCOL.md)**.
Documents live in **collections** (`notes`, `todos`, …) that share one table, one id
space and one global `seq`; clients that predate collections only ever see `notes`.

Deployed behind nginx (→ `127.0.0.1:8787`) on a small Linux box by `scripts/deploy-server.sh`;
Bento has no server by default (set `notes.sync.server` / `todo.sync.server`).

```
server/
  src/store.rs        SQLite schema + migrations, validation, LWW + seq logic (unit tests)
  src/lib.rs          axum router, auth, REST handlers (/v1/notes, /v1/c/<collection>, /v1/blobs), serve()/graceful shutdown
  src/ws.rs           /v1/sync WebSocket connection loop (per-connection collection filter)
  src/main.rs         CLI: serve | backup | purge | gc-blobs
  tests/integration.rs  real server on an ephemeral port: REST + WebSocket clients, collections
  scripts/syncctl.py  stdlib-only CLI client (REST + WebSocket, TLS, proxies)
  deploy/             systemd units, nginx site templates (@DOMAIN@), remote install script
../scripts/deploy-server.sh   build + deploy (idempotent)
```

## Build & test

```sh
cd server
cargo test                       # unit + integration tests
BENTO_SYNC_TOKEN=devtoken-0123456789 BENTO_SYNC_DB=/tmp/notes.db cargo run   # 127.0.0.1:8787
```

Config (env):

| Var | Default | |
|---|---|---|
| `BENTO_SYNC_TOKEN` | – | bearer token (≥16 printable chars) |
| `BENTO_SYNC_TOKEN_FILE` | – | read the token from a file instead; falls back to `$CREDENTIALS_DIRECTORY/token` (systemd `LoadCredential=`) |
| `BENTO_SYNC_DB` | `./bento-sync.db` | SQLite path (WAL; `-wal`/`-shm` files live next to it) |
| `BENTO_SYNC_ADDR` | `127.0.0.1:8787` | listen address |

Release binary for the server (static aarch64 musl):

```sh
brew install zig && cargo install --locked cargo-zigbuild
rustup target add aarch64-unknown-linux-musl
cargo zigbuild --release --target aarch64-unknown-linux-musl
# -> target/aarch64-unknown-linux-musl/release/bento-sync (statically linked)
```

## Poking the server: `scripts/syncctl.py`

Python 3 stdlib only. Reads `~/.config/bento/sync-token` (or `$BENTO_SYNC_TOKEN`);
server from `--server`, else `$BENTO_SYNC_SERVER`, else Bento's own `notes.sync.server`.

```sh
scripts/syncctl.py health
scripts/syncctl.py list --since 0 [--json]
scripts/syncctl.py put [ID] --body '# Title\n\ntext' [--meta '{"pinned":true}'] [--updated-at MS]
scripts/syncctl.py delete ID [--updated-at MS]
scripts/syncctl.py ws-put [ID] --body '…'      # put over WebSocket, prints ack (+ stored note)
scripts/syncctl.py watch --since 0 -v          # stream every WebSocket message
scripts/syncctl.py roundtrip                   # 2 sockets: put→ack+note, stale put, tombstone
scripts/syncctl.py --server http://127.0.0.1:8787 --no-proxy health
scripts/syncctl.py --collection todos list     # any command on another collection
```

`--collection` (default `notes`) applies to list/put/delete/ws-put/watch/roundtrip:
REST goes to `/v1/c/<collection>` (`/v1/notes` for `notes`), WebSocket `hello` sends
`collections: [<collection>]`.

`roundtrip` leaves a `synctest-…` tombstone; remove test rows with `bento-sync purge` (below).

## Deploy

**Deploy order:** deploy the server before (or with) a Bento build that has the Todo
module. Todo clients only sync once `/v1/health` reports `"collections": true`;
until then they show “server needs an update” and keep tasks local.

Set the server's public name first, in the environment or the untracked
`scripts/config.local.sh`: `: "${BENTO_SYNC_DOMAIN:=sync.example.com}"`.

```sh
scripts/deploy-server.sh                 # cargo test, cross-build, upload, install, verify
scripts/deploy-server.sh --skip-tests
scripts/deploy-server.sh --only-token --token-to local --token-to macbook   # copy token to clients
```

It builds with cargo-zigbuild (falls back to Docker `rust:alpine` if zigbuild is
missing), uploads to a temp dir on `hetzner` (removed afterwards), and runs
`deploy/remote-install.sh` as root, which idempotently:

* checks port 8787 is free or already bento-sync's;
* creates the system user `bento-sync`, `/opt/bento-sync/`, `/etc/bento-sync/`;
* generates `/etc/bento-sync/token` (`openssl rand -hex 32`, root 0600) **only if missing**;
* atomically replaces `/opt/bento-sync/bento-sync`, installs the units, restarts, waits for `/v1/health`;
* on first run, gets the certificate (`certbot certonly --nginx`, existing account,
  `--deploy-hook "systemctl reload nginx"`), then writes
  `/etc/nginx/sites-available/$BENTO_SYNC_DOMAIN` (+ `sites-enabled` symlink), runs
  `nginx -t` and reloads (restores the previous site file if the test fails);
* checks `https://$BENTO_SYNC_DOMAIN/v1/health` through nginx.

On the server:

| What | Where |
|---|---|
| binary | `/opt/bento-sync/bento-sync` |
| data | `/var/lib/bento-sync/notes.db` (owned by `bento-sync`, 0700 dir) |
| backups | `/var/lib/bento-sync/backups/notes-YYYYMMDD-HHMMSS.db` (newest 14) |
| token | `/etc/bento-sync/token` (root 0600, passed via `LoadCredential=`) |
| units | `bento-sync.service`, `bento-sync-backup.service` + `.timer` (daily ~03:30 UTC) |
| nginx | `/etc/nginx/sites-available/$BENTO_SYNC_DOMAIN`, log `/var/log/nginx/bento.access.log` (no query strings) |

The service runs with `NoNewPrivileges`, `ProtectSystem=strict`,
`ReadWritePaths=/var/lib/bento-sync`, no capabilities, syscall filter,
`MemoryMax=64M`, `Restart=always` (`systemd-analyze security`: 1.4 "OK").

Ops: `systemctl status bento-sync`, `journalctl -u bento-sync -f` (one line per
WebSocket connect/hello/disconnect), `scripts/syncctl.py health`.

## Rotate the token

```sh
ssh hetzner '(umask 077; openssl rand -hex 32 > /etc/bento-sync/token) && systemctl restart bento-sync'
scripts/deploy-server.sh --only-token --token-to local --token-to macbook
```

Clients with the old token get 401 until their token file is updated (the app
should re-read the file on 401).

## Backup & restore

Backups are `VACUUM INTO` snapshots (consistent while the server runs). Manual backup:

```sh
ssh hetzner systemctl start bento-sync-backup.service
ssh hetzner ls -la /var/lib/bento-sync/backups
```

Restore:

```sh
ssh hetzner 'set -e; systemctl stop bento-sync
  cd /var/lib/bento-sync && mv notes.db notes.db.broken && rm -f notes.db-wal notes.db-shm
  install -o bento-sync -g bento-sync -m 600 backups/notes-YYYYMMDD-HHMMSS.db notes.db
  systemctl start bento-sync'
```

After a restore `seq` may go backwards. Clients whose `last_seq` is above the
restored seq should do a full resync (`hello` with `since: 0`). The server doesn't
detect this itself.

Remove specific documents of any collection (e.g. test data) without touching seq:

```sh
ssh hetzner 'runuser -u bento-sync -- env BENTO_SYNC_DB=/var/lib/bento-sync/notes.db \
  /opt/bento-sync/bento-sync purge synctest-abc123 …'
```

Delete images that no document refers to any more (uploaded over 30 days ago, so an
upload whose note hasn't arrived yet is safe; trashed notes keep theirs). Not run
automatically: images are small next to the disk.

```sh
ssh hetzner 'runuser -u bento-sync -- env BENTO_SYNC_DB=/var/lib/bento-sync/notes.db \
  /opt/bento-sync/bento-sync gc-blobs --days 30'
```

## Behaviour details (within the protocol)

* **Ordering.** Changes are broadcast while the DB lock is held, so each WebSocket
  sees notes and acks in strictly increasing `seq` order. Before acking a put with
  seq N (a rejected put: the stored winner's seq), queued broadcasts with seq < N are sent first. A client that keeps
  `last_seq = max(seen seq)` therefore never skips a change.
* **Collections.** `hello.collections` (default `["notes"]`, 1–8 valid names,
  duplicates ignored; otherwise an `error` and no snapshot) filters the snapshot
  and the forwarded broadcasts. The filter is applied last, when an event would be
  sent, so events of other collections are dropped without affecting the ordering
  rules above (a client just sees gaps in `seq`). Every connection still receives
  every event internally, so the lag limit below counts all collections. A put's
  collection is `note.collection`, else the connection's first collection (`notes`
  before hello). A put to a collection the connection didn't subscribe to is acked
  but nothing of it is sent back, not even the stored winner when it's rejected.
  A re-`hello` may change the collections.
* **Id conflicts.** Ids are unique across collections; a put (or DELETE) for an id
  stored in another collection is refused before the LWW check: REST 409, WS
  `error` with `id`. Nothing is written and seq doesn't move.
* **REST**: `/v1/notes…` is `/v1/c/notes…` with the original keys (`notes`/`note`);
  `/v1/c/<collection>…` answers with `docs`/`doc`. A body `collection` must match the
  path, and an invalid collection name in the path is a 400.
* **Before `hello`** a connection gets no `note` broadcasts: the snapshot already
  contains them, and events with `seq <= snapshot.seq` are skipped after it. Puts
  before `hello` are allowed.
* **Rejected put:** `ack` carries the *stored* note's seq and `accepted:false`,
  followed by `{"type":"note","note":<stored>}` to the sender only.
* **Validation:** `id` 1–128 chars `[A-Za-z0-9-_.:]` (UUIDs), `collection`
  `[a-z][a-z0-9_-]{0,31}` (absent/`null` → default, see above), `updated_at` required,
  `created_at` defaults to `updated_at`, `body` ≤ 1 MiB (413), `meta` must be an
  object ≤ 4 KiB serialized (413; `null`/absent → `{}`), `device` defaults to the
  hello device (WS) or `"rest"`. `deleted:true` forces `body:""`. Request/WS message
  cap 3 MiB to allow for JSON escaping. Unknown fields (incl. `seq`) are ignored.
  WS errors are `{"type":"error","message":…}`, plus `"id"` when the failing put had one.
* **DELETE** `updated_at` is optional (defaults to server time); `?device=` optional;
  the tombstone keeps the stored `meta`.
* **Liveness:** WebSocket ping every 30 s; a connection with no inbound traffic for
  95 s is dropped. If a connection falls >256 events behind, it gets an `error` and
  close code 1013 and should reconnect with `hello`. On shutdown, sockets get close
  code 1001.
* **Blobs** (images) live in the `blobs` table of the same DB, so backups include them.
  `PUT /v1/blobs/<sha256>` checks the hash and that the bytes are PNG, JPEG, GIF, WebP
  or HEIC/HEIF (415 otherwise; the stored type comes from the bytes, not the request),
  up to 10 MiB (413; that route's request cap). Storing one again is a no-op. Blobs
  have no seq and aren't broadcast: the note that refers to one is.
* **REST errors** are JSON `{"error": "..."}` with 400/401/404/409/413/415/500.
* **Schema.** `meta.schema_version` is 3 (v3 adds the `blobs` table, created on
  open; older binaries ignore it). v2 was collections. Opening a v1 DB (server
  start, `backup`, `purge`) adds `notes.collection TEXT NOT NULL DEFAULT 'notes'`
  (existing rows become `notes`) and the `(collection, seq)` index, in one
  `BEGIN IMMEDIATE` transaction, so it's idempotent and safe while another process
  has the DB open. **Don't roll back to a v1 binary once todos exist**: it still
  runs on a migrated DB but doesn't filter, so it serves every todo to Notes clients,
  which keep them as notes. (Todo clients re-check `/v1/health` on every reconnect
  and stop syncing with a server that has no collections.)
