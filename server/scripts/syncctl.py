#!/usr/bin/env python3
"""syncctl - poke a bento-sync server from the command line (Python 3 stdlib only).

Examples:
  syncctl.py health
  syncctl.py list --since 0
  syncctl.py put --body '# Hello\n\nfrom syncctl'          # new note, random UUID
  syncctl.py put 6F1C... --body 'edited' --meta '{"pinned":true}'
  syncctl.py delete 6F1C...
  syncctl.py watch --since 0                              # WebSocket: print every message
  syncctl.py ws-put --body 'via websocket'
  syncctl.py roundtrip                                    # two WebSockets, put/ack/note/stale/delete
  syncctl.py --collection todos list                      # another collection (REST /v1/c/todos, WS hello collections)

Server:  --server, else $BENTO_SYNC_SERVER, else notes.sync.server in ~/.config/bento/config.json
Token:   $BENTO_SYNC_TOKEN or --token-file (default ~/.config/bento/sync-token)
Proxy:   --proxy host:port, else $https_proxy / macOS system proxy (urllib.getproxies), --no-proxy to disable
"""

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def now_ms():
    return int(time.time() * 1000)


def die(msg, code=1):
    print(f"syncctl: {msg}", file=sys.stderr)
    sys.exit(code)


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


class Ctx:
    def __init__(self, args):
        self.server = args.server.rstrip("/")
        self.timeout = args.timeout
        self.args = args
        self._token = None
        u = urllib.parse.urlsplit(self.server)
        if u.scheme not in ("http", "https"):
            die("--server must be http(s)://host[:port]")
        self.secure = u.scheme == "https"
        self.host = u.hostname
        self.port = u.port or (443 if self.secure else 80)
        self.proxy = self._pick_proxy(args)
        self.collection = args.collection
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", self.collection):
            die("--collection must match [a-z][a-z0-9_-]{0,31}")
        # `notes` keeps the original endpoints (and response keys) old servers understand.
        if self.collection == "notes":
            self.base, self.list_key, self.doc_key = "/v1/notes", "notes", "note"
        else:
            self.base, self.list_key, self.doc_key = f"/v1/c/{self.collection}", "docs", "doc"

    @property
    def token(self):
        if self._token is None:
            env = os.environ.get("BENTO_SYNC_TOKEN", "").strip()
            if env:
                self._token = env
            else:
                path = os.path.expanduser(self.args.token_file)
                try:
                    with open(path) as f:
                        self._token = f.read().strip()
                except OSError as e:
                    die(f"cannot read token file {path}: {e}")
        return self._token

    def _pick_proxy(self, args):
        if args.no_proxy:
            return None
        if args.proxy:
            p = args.proxy if "://" in args.proxy else "http://" + args.proxy
        else:
            proxies = urllib.request.getproxies()
            if urllib.request.proxy_bypass(self.host):
                return None
            p = proxies.get("https" if self.secure else "http")
        if not p:
            return None
        pu = urllib.parse.urlsplit(p if "://" in p else "http://" + p)
        return (pu.hostname, pu.port or 8080)

    # ---- REST -------------------------------------------------------------
    def rest(self, method, path, body=None, auth=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.server + path, data=data, method=method)
        if auth:
            req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        proxies = {}
        if self.proxy:
            p = "http://%s:%d" % self.proxy
            proxies = {"http": p, "https": p}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
        try:
            with opener.open(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw.decode(errors="replace")

    def ws(self):
        return WebSocket(self)


class WSClosed(Exception):
    pass


class WebSocket:
    """Minimal RFC 6455 client: TLS, HTTP CONNECT proxy, ping/pong, fragmentation."""

    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        t = ctx.timeout
        if ctx.proxy:
            sock = socket.create_connection(ctx.proxy, timeout=t)
            target = f"{ctx.host}:{ctx.port}"
            sock.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
            head, _ = self._read_head(sock, b"")
            if head.split()[1:2] != ["200"]:
                raise ConnectionError(f"proxy CONNECT failed: {head.splitlines()[0]}")
        else:
            sock = socket.create_connection((ctx.host, ctx.port), timeout=t)
        if ctx.secure:
            tls = ssl.create_default_context()
            tls.set_alpn_protocols(["http/1.1"])
            sock = tls.wrap_socket(sock, server_hostname=ctx.host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /v1/sync HTTP/1.1\r\nHost: {ctx.host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"Authorization: Bearer {ctx.token}\r\nUser-Agent: syncctl\r\n\r\n"
        )
        sock.sendall(req.encode())
        head, rest = self._read_head(sock, b"")
        status = head.split()[1] if len(head.split()) > 1 else "?"
        if status != "101":
            raise ConnectionError(f"WebSocket upgrade refused: {head.splitlines()[0]}")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if accept.lower() not in head.lower():
            raise ConnectionError("bad Sec-WebSocket-Accept")
        self.sock = sock
        self.buf = rest

    @staticmethod
    def _read_head(sock, buf):
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("connection closed during handshake")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        return head.decode(errors="replace"), rest

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self.buf)))
            if not chunk:
                raise WSClosed("connection closed")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def _send_frame(self, opcode, payload: bytes):
        n = len(payload)
        hdr = bytearray([0x80 | opcode])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack("!H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack("!Q", n)
        mask = os.urandom(4)
        hdr += mask
        if n:
            m = (mask * (n // 4 + 1))[:n]
            payload = (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
        self.sock.sendall(bytes(hdr) + payload)

    def send(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def recv(self, timeout=None):
        """Next JSON message, or None on timeout. Answers pings automatically."""
        self.sock.settimeout(timeout if timeout is not None else self.ctx.timeout)
        frags, first_op = [], None
        try:
            while True:
                b0, b1 = self._read(2)
                op, fin, n = b0 & 0x0F, b0 & 0x80, b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", self._read(8))[0]
                mask = self._read(4) if b1 & 0x80 else None
                payload = self._read(n)
                if mask:
                    payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
                if op == 0x9:  # ping
                    self._send_frame(0xA, payload)
                    continue
                if op == 0xA:  # pong
                    continue
                if op == 0x8:  # close
                    code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                    try:
                        self._send_frame(0x8, payload[:2])
                    except OSError:
                        pass
                    raise WSClosed(f"closed by server (code {code}, {payload[2:].decode(errors='replace')!r})")
                if op in (0x1, 0x2):
                    first_op, frags = op, [payload]
                elif op == 0x0:
                    frags.append(payload)
                if fin and first_op is not None:
                    return json.loads(b"".join(frags).decode())
        except (socket.timeout, TimeoutError):
            return None

    def expect(self, pred, what, timeout=None):
        deadline = time.time() + (timeout or self.ctx.timeout)
        while time.time() < deadline:
            m = self.recv(max(0.05, deadline - time.time()))
            if m is None:
                break
            if pred(m):
                return m
        raise AssertionError(f"timed out waiting for {what}")

    def hello(self, since=0, device="syncctl"):
        self.send({"type": "hello", "since": since, "device": device, "collections": [self.ctx.collection]})
        return self.expect(lambda m: m.get("type") == "snapshot", "snapshot")

    def close(self):
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
            self.sock.close()
        except OSError:
            pass


def title(body):
    if (body or "").startswith("{"):  # todo documents: JSON with fields.title / fields.name
        try:
            f = json.loads(body).get("fields", {})
            return str(f.get("title") or f.get("name") or "")[:60]
        except (ValueError, AttributeError):
            pass
    for line in (body or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line[:60]
    return ""


def summarize(notes):
    for n in notes:
        flag = "deleted" if n.get("deleted") else title(n.get("body"))
        print(f"{n['seq']:>6}  {n['id']:<38} upd={n['updated_at']}  dev={n.get('device','')!s:<14} {flag}")


def read_body(args):
    if args.file:
        with open(args.file) as f:
            return f.read()
    body = args.body or ""
    # `\n` in a note typed on the command line means a line break. Other collections' bodies
    # are JSON, whose `\n` escapes must stay escaped: unescaped, clients can't read the body.
    return body.replace("\\n", "\n") if args.collection == "notes" else body


def note_from_args(args, nid):
    ts = args.updated_at or now_ms()
    note = {
        "id": nid,
        "body": read_body(args),
        "created_at": ts,
        "updated_at": ts,
        "deleted": False,
        "device": args.device,
        "meta": json.loads(args.meta) if args.meta else {},
    }
    if args.collection != "notes":
        note["collection"] = args.collection
    return note


def cmd_health(ctx, args):
    st, body = ctx.rest("GET", "/v1/health", auth=False)
    out(body)
    return 0 if st == 200 else 1


def cmd_list(ctx, args):
    st, body = ctx.rest("GET", f"{ctx.base}?since={args.since}")
    if st != 200:
        out(body)
        return 1
    if args.json:
        out(body)
    else:
        docs = body[ctx.list_key]
        summarize(docs)
        print(f"latest seq: {body['seq']}  ({len(docs)} {ctx.collection})")
    return 0


def cmd_put(ctx, args):
    nid = args.id or str(uuid.uuid4()).upper()
    st, body = ctx.rest("PUT", f"{ctx.base}/{nid}", note_from_args(args, nid))
    out(body)
    return 0 if st == 200 else 1


def cmd_delete(ctx, args):
    q = f"?updated_at={args.updated_at or now_ms()}&device={urllib.parse.quote(args.device)}"
    st, body = ctx.rest("DELETE", f"{ctx.base}/{args.id}{q}")
    out(body)
    return 0 if st == 200 else 1


def cmd_watch(ctx, args):
    ws = ctx.ws()
    snap = ws.hello(args.since, args.device)
    print(json.dumps({"type": "snapshot", "count": len(snap["notes"]), "seq": snap["seq"]}))
    if args.verbose:
        summarize(snap["notes"])
    try:
        while True:
            m = ws.recv(3600)
            if m is not None:
                print(json.dumps(m, ensure_ascii=False)[:2000], flush=True)
    except KeyboardInterrupt:
        ws.close()
    except WSClosed as e:
        print(f"[{e}]")
    return 0


def cmd_ws_put(ctx, args):
    nid = args.id or str(uuid.uuid4()).upper()
    ws = ctx.ws()
    ws.hello(0, args.device)
    ws.send({"type": "put", "note": note_from_args(args, nid)})
    ack = ws.expect(lambda m: m.get("type") in ("ack", "error"), "ack")
    out(ack)
    if ack.get("type") == "ack" and not ack.get("accepted"):
        out(ws.expect(lambda m: m.get("type") == "note", "stored note"))
    ws.close()
    return 0 if ack.get("accepted") else 1


def cmd_roundtrip(ctx, args):
    """Two WebSocket clients: put on A -> ack on A + note on B; stale put; tombstone."""
    nid = "synctest-" + uuid.uuid4().hex[:12]
    t0 = time.time()
    a, b = ctx.ws(), ctx.ws()
    print(f"connected 2 websockets in {1000*(time.time()-t0):.0f} ms via "
          f"{'proxy %s:%d' % ctx.proxy if ctx.proxy else 'direct'}")
    sa, sb = a.hello(0, "syncctl-A"), b.hello(0, "syncctl-B")
    print(f"hello: snapshot A={len(sa['notes'])} notes, B={len(sb['notes'])} notes, seq={sa['seq']}")
    ts = now_ms()
    note = {"id": nid, "body": "# syncctl roundtrip", "created_at": ts, "updated_at": ts,
            "deleted": False, "device": "syncctl-A", "meta": {}}
    t1 = time.time()
    a.send({"type": "put", "note": note})
    ack = a.expect(lambda m: m.get("type") == "ack" and m.get("id") == nid, "ack on A")
    got = b.expect(lambda m: m.get("type") == "note" and m["note"]["id"] == nid, "note on B")
    assert ack["accepted"] is True and got["note"]["seq"] == ack["seq"], (ack, got)
    print(f"put on A -> ack seq={ack['seq']} on A, note on B in {1000*(time.time()-t1):.0f} ms")
    stale = dict(note, body="stale", updated_at=ts - 1)
    a.send({"type": "put", "note": stale})
    nack = a.expect(lambda m: m.get("type") == "ack" and m.get("id") == nid, "stale ack")
    back = a.expect(lambda m: m.get("type") == "note" and m["note"]["id"] == nid, "stored note")
    assert nack["accepted"] is False and back["note"]["body"] == "# syncctl roundtrip"
    print("stale put -> accepted:false + stored note returned")
    a.send({"type": "ping"})
    a.expect(lambda m: m.get("type") == "pong", "pong")
    tomb = dict(note, body="", deleted=True, updated_at=ts + 1)
    a.send({"type": "put", "note": tomb})
    a.expect(lambda m: m.get("type") == "ack" and m.get("id") == nid and m["accepted"], "delete ack")
    gone = b.expect(lambda m: m.get("type") == "note" and m["note"]["id"] == nid, "tombstone on B")
    assert gone["note"]["deleted"] is True
    print(f"tombstone propagated (test note id {nid})")
    a.close()
    b.close()
    print("ROUNDTRIP OK")
    return 0


def configured_server():
    """$BENTO_SYNC_SERVER, else the server Bento itself uses (notes.sync.server)."""
    if os.environ.get("BENTO_SYNC_SERVER"):
        return os.environ["BENTO_SYNC_SERVER"]
    try:
        with open(os.path.expanduser("~/.config/bento/config.json")) as f:
            return json.load(f)["notes"]["sync"]["server"].strip() or None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--server", default=configured_server())
    p.add_argument("--token-file", default="~/.config/bento/sync-token")
    p.add_argument("--proxy", help="HTTP proxy host:port (default: env / macOS system proxy)")
    p.add_argument("--no-proxy", action="store_true")
    p.add_argument("--timeout", type=float, default=10.0)
    p.add_argument("--device", default="syncctl")
    p.add_argument("--collection", default="notes", help="collection to use (default: notes)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("health")
    s = sub.add_parser("list")
    s.add_argument("--since", type=int, default=0)
    s.add_argument("--json", action="store_true")
    for name in ("put", "ws-put"):
        s = sub.add_parser(name)
        s.add_argument("id", nargs="?")
        s.add_argument("--body")
        s.add_argument("--file")
        s.add_argument("--updated-at", type=int)
        s.add_argument("--meta", help="JSON object")
    s = sub.add_parser("delete")
    s.add_argument("id")
    s.add_argument("--updated-at", type=int)
    s = sub.add_parser("watch")
    s.add_argument("--since", type=int, default=0)
    s.add_argument("-v", "--verbose", action="store_true")
    sub.add_parser("roundtrip")
    args = p.parse_args()
    if not args.server:
        p.error("no server: pass --server, set $BENTO_SYNC_SERVER, or set notes.sync.server in Bento")
    ctx = Ctx(args)
    fn = {"health": cmd_health, "list": cmd_list, "put": cmd_put, "ws-put": cmd_ws_put,
          "delete": cmd_delete, "watch": cmd_watch, "roundtrip": cmd_roundtrip}[args.cmd]
    try:
        sys.exit(fn(ctx, args))
    except (ConnectionError, OSError, WSClosed, AssertionError) as e:
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
