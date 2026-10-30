//! Runs the real server on an ephemeral port and exercises REST + WebSocket.

use bento_sync::store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "test-token-0123456789abcdef";
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Server {
    addr: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
    dir: PathBuf,
}

impl Server {
    async fn start(name: &str) -> Server {
        let dir = std::env::temp_dir().join(format!("bento-sync-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self::start_in(dir).await
    }

    async fn start_in(dir: PathBuf) -> Server {
        let store = Store::open(&dir.join("notes.db")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            bento_sync::serve(listener, store, TOKEN, async {
                let _ = rx.await;
            })
            .await
            .unwrap();
        });
        Server { addr, stop: Some(tx), task, dir }
    }

    async fn stop(mut self) -> PathBuf {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task).await.unwrap().unwrap();
        self.dir.clone()
    }
}

/// Minimal HTTP/1.1 client: returns (status, parsed JSON body).
async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let body = body.unwrap_or("");
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let status: u16 = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let (head, raw) = text.split_once("\r\n\r\n").unwrap();
    let raw = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(raw)
    } else {
        raw.to_string()
    };
    (status, serde_json::from_str(&raw).unwrap_or(Value::Null))
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    loop {
        let (len, rest) = s.split_once("\r\n").unwrap();
        let n = usize::from_str_radix(len.trim(), 16).unwrap();
        if n == 0 {
            return out;
        }
        out.push_str(&rest[..n]);
        s = &rest[n + 2..];
    }
}

async fn ws_connect(addr: SocketAddr, token: &str) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = format!("ws://{addr}/v1/sync").into_client_request().unwrap();
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws)
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// Next JSON text message (control frames skipped), with a timeout.
async fn recv(ws: &mut Ws) -> Value {
    try_recv(ws, Duration::from_secs(5)).await.expect("expected a message")
}

async fn try_recv(ws: &mut Ws, wait: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next()).await.ok()??.unwrap();
        if let Message::Text(t) = msg {
            return Some(serde_json::from_str(t.as_str()).unwrap());
        }
    }
}

async fn hello(ws: &mut Ws, since: i64) -> Value {
    send(ws, json!({"type": "hello", "since": since, "device": "test"})).await;
    let snap = recv(ws).await;
    assert_eq!(snap["type"], "snapshot", "{snap}");
    snap
}

fn note(id: &str, body: &str, updated_at: i64) -> Value {
    json!({"id": id, "body": body, "created_at": updated_at, "updated_at": updated_at,
           "deleted": false, "device": "dev", "meta": {"pinned": true}})
}

#[tokio::test]
async fn rest_and_websocket_sync() {
    let srv = Server::start("main").await;
    let a = srv.addr;

    // Health needs no auth.
    let (st, h) = http(a, "GET", "/v1/health", None, None).await;
    assert_eq!((st, h.clone()), (200, json!({"ok": true, "seq": 0, "collections": true, "blobs": true})));

    // Auth failures.
    assert_eq!(http(a, "GET", "/v1/notes", None, None).await.0, 401);
    assert_eq!(http(a, "GET", "/v1/notes", Some("wrong-token-wrong-token"), None).await.0, 401);
    assert_eq!(http(a, "GET", &format!("/v1/notes?token={TOKEN}"), None, None).await.0, 200);
    match ws_connect(a, "nope-nope-nope-nope").await {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 401),
        other => panic!("expected 401, got {:?}", other.map(|_| ())),
    }

    // Two WebSocket clients.
    let mut c1 = ws_connect(a, TOKEN).await.unwrap();
    let mut c2 = ws_connect(a, TOKEN).await.unwrap();
    assert_eq!(hello(&mut c1, 0).await, json!({"type": "snapshot", "notes": [], "seq": 0}));
    hello(&mut c2, 0).await;

    // Put on c1 -> ack on c1, note on c2, nothing else on c1.
    send(&mut c1, json!({"type": "put", "note": note("n1", "# One", 1000)})).await;
    assert_eq!(recv(&mut c1).await, json!({"type": "ack", "id": "n1", "seq": 1, "accepted": true}));
    let got = recv(&mut c2).await;
    assert_eq!(got["type"], "note");
    assert_eq!(got["note"]["id"], "n1");
    assert_eq!(got["note"]["body"], "# One");
    assert_eq!(got["note"]["seq"], 1);
    assert_eq!(got["note"]["meta"], json!({"pinned": true}));
    assert!(
        try_recv(&mut c1, Duration::from_millis(200)).await.is_none(),
        "sender must not get its own note"
    );

    // Stale WS put: ack accepted:false + stored note to the sender, nothing to c2.
    send(&mut c1, json!({"type": "put", "note": note("n1", "stale", 900)})).await;
    assert_eq!(recv(&mut c1).await, json!({"type": "ack", "id": "n1", "seq": 1, "accepted": false}));
    let stored = recv(&mut c1).await;
    assert_eq!(stored["type"], "note");
    assert_eq!(stored["note"]["body"], "# One");
    assert_eq!(stored["note"]["updated_at"], 1000);
    assert!(try_recv(&mut c2, Duration::from_millis(200)).await.is_none());

    // Stale REST put returns the stored note.
    let (st, r) =
        http(a, "PUT", "/v1/notes/n1", Some(TOKEN), Some(&note("n1", "old", 500).to_string())).await;
    assert_eq!(st, 200);
    assert_eq!(r["accepted"], false);
    assert_eq!(r["note"]["body"], "# One");
    assert_eq!(r["note"]["seq"], 1);

    // Tie is accepted; created_at kept from the first version.
    let mut tie = note("n1", "# One (tie)", 1000);
    tie["created_at"] = json!(5);
    send(&mut c2, json!({"type": "put", "note": tie})).await;
    assert_eq!(recv(&mut c2).await, json!({"type": "ack", "id": "n1", "seq": 2, "accepted": true}));
    let got = recv(&mut c1).await;
    assert_eq!(got["note"]["body"], "# One (tie)");
    assert_eq!(got["note"]["created_at"], 1000);

    // REST put is broadcast to every WebSocket.
    let (st, r) =
        http(a, "PUT", "/v1/notes/n2", Some(TOKEN), Some(&note("n2", "two", 2000).to_string())).await;
    assert_eq!((st, r["accepted"].clone(), r["note"]["seq"].clone()), (200, json!(true), json!(3)));
    assert_eq!(recv(&mut c1).await["note"]["id"], "n2");
    assert_eq!(recv(&mut c2).await["note"]["id"], "n2");

    // REST delete -> tombstone, broadcast.
    let (st, r) = http(a, "DELETE", "/v1/notes/n2?updated_at=3000", Some(TOKEN), None).await;
    assert_eq!(st, 200);
    assert_eq!(r["accepted"], true);
    assert_eq!(r["note"]["deleted"], true);
    assert_eq!(r["note"]["body"], "");
    assert_eq!(r["note"]["seq"], 4);
    assert_eq!(recv(&mut c1).await["note"]["deleted"], true);
    assert_eq!(recv(&mut c2).await["note"]["deleted"], true);
    // Stale delete is rejected.
    let (_, r) = http(a, "DELETE", "/v1/notes/n2?updated_at=10", Some(TOKEN), None).await;
    assert_eq!(r["accepted"], false);

    // A third client: hello since=2 gets only seq > 2, ascending, with latest seq.
    let mut c3 = ws_connect(a, TOKEN).await.unwrap();
    let snap = hello(&mut c3, 2).await;
    assert_eq!(snap["seq"], 4);
    let notes = snap["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0]["id"], "n2");
    assert_eq!(notes[0]["seq"], 4);
    assert_eq!(notes[0]["deleted"], true);

    // REST listing.
    let (_, l) = http(a, "GET", "/v1/notes?since=0", Some(TOKEN), None).await;
    assert_eq!(l["seq"], 4);
    let seqs: Vec<i64> = l["notes"].as_array().unwrap().iter().map(|n| n["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [2, 4]);
    assert_eq!(http(a, "GET", "/v1/health", None, None).await.1["seq"], 4);

    // App-level ping, bad messages.
    send(&mut c3, json!({"type": "ping"})).await;
    assert_eq!(recv(&mut c3).await, json!({"type": "pong"}));
    c3.send(Message::Text("not json".into())).await.unwrap();
    assert_eq!(recv(&mut c3).await["type"], "error");
    send(&mut c3, json!({"type": "put", "note": {"id": "x", "body": "no timestamp"}})).await;
    let e = recv(&mut c3).await;
    assert_eq!((e["type"].clone(), e["id"].clone()), (json!("error"), json!("x")));

    // Validation + size limits over REST.
    let (st, _) =
        http(a, "PUT", "/v1/notes/abc", Some(TOKEN), Some(&note("other", "x", 1).to_string())).await;
    assert_eq!(st, 400);
    let big = note("big", &"x".repeat(1024 * 1024 + 1), 1).to_string();
    assert_eq!(http(a, "PUT", "/v1/notes/big", Some(TOKEN), Some(&big)).await.0, 413);
    let mut bigmeta = note("bm", "x", 1);
    bigmeta["meta"] = json!({"k": "y".repeat(5000)});
    assert_eq!(http(a, "PUT", "/v1/notes/bm", Some(TOKEN), Some(&bigmeta.to_string())).await.0, 413);
    let huge = "z".repeat(bento_sync::MAX_REQUEST_BYTES + 10);
    assert_eq!(http(a, "PUT", "/v1/notes/h", Some(TOKEN), Some(&huge)).await.0, 413);
    // A full 1 MB body is fine.
    let max = note("max", &"x".repeat(1024 * 1024), 1).to_string();
    assert_eq!(http(a, "PUT", "/v1/notes/max", Some(TOKEN), Some(&max)).await.1["accepted"], true);
    assert_eq!(recv(&mut c1).await["note"]["id"], "max");

    // Clean shutdown closes sockets with 1001; data persists across restart.
    let dir = srv.stop().await;
    let mut closed = false;
    while let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(2), c2.next()).await {
        if let Ok(Message::Close(Some(f))) = m {
            assert_eq!(u16::from(f.code), 1001);
            closed = true;
            break;
        }
    }
    assert!(closed, "expected close frame on shutdown");

    let srv = Server::start_in(dir).await;
    assert_eq!(http(srv.addr, "GET", "/v1/health", None, None).await.1["seq"], 5);
    let (_, r) =
        http(srv.addr, "PUT", "/v1/notes/n3", Some(TOKEN), Some(&note("n3", "3", 1).to_string())).await;
    assert_eq!(r["note"]["seq"], 6);
    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn broadcasts_before_ack_and_no_gap_after_hello() {
    let srv = Server::start("order").await;
    let a = srv.addr;
    let mut c1 = ws_connect(a, TOKEN).await.unwrap();
    let mut c2 = ws_connect(a, TOKEN).await.unwrap();
    hello(&mut c1, 0).await;

    // c2 makes changes before its hello: they arrive in its snapshot, not as notes.
    send(&mut c2, json!({"type": "put", "note": note("p", "pre", 1)})).await;
    assert_eq!(recv(&mut c2).await["type"], "ack");
    http(a, "PUT", "/v1/notes/q", Some(TOKEN), Some(&note("q", "rest", 1).to_string())).await;
    let snap = hello(&mut c2, 0).await;
    assert_eq!(snap["seq"], 2);
    assert_eq!(snap["notes"].as_array().unwrap().len(), 2);
    assert!(try_recv(&mut c2, Duration::from_millis(200)).await.is_none(), "no duplicates after snapshot");

    // Many interleaved writers: every client sees strictly increasing seqs, and
    // any broadcast with seq < ack.seq arrives before that ack.
    for i in 0..20 {
        let id = format!("k{i}");
        send(&mut c1, json!({"type": "put", "note": note(&id, "a", 10 + i)})).await;
        let rid = format!("r{i}");
        http(a, "PUT", &format!("/v1/notes/{rid}"), Some(TOKEN), Some(&note(&rid, "b", 1).to_string())).await;
    }
    // c1 helloed at seq 0, so it also receives seqs 1 and 2 as notes first.
    let mut last = 0;
    let mut acks = 0;
    while acks < 20 {
        let m = recv(&mut c1).await;
        let seq = match m["type"].as_str().unwrap() {
            "ack" => {
                acks += 1;
                m["seq"].as_i64().unwrap()
            }
            "note" => m["note"]["seq"].as_i64().unwrap(),
            t => panic!("unexpected {t}"),
        };
        assert!(seq > last, "seq went from {last} to {seq}");
        last = seq;
    }
    let mut last2 = 2;
    for _ in 0..40 {
        let m = recv(&mut c2).await;
        let seq = m["note"]["seq"].as_i64().unwrap();
        assert!(seq > last2);
        last2 = seq;
    }
    assert_eq!(last2, 42);
    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A rejected put's ack and stored winner (seq S) come after every queued broadcast
/// with seq < S, so a client keeping last_seq = max(seen) never skips a change.
#[tokio::test]
async fn rejected_put_winner_after_earlier_broadcasts() {
    let srv = Server::start("reject-order").await;
    let a = srv.addr;
    let mut c1 = ws_connect(a, TOKEN).await.unwrap();
    hello(&mut c1, 0).await;
    http(a, "PUT", "/v1/notes/w", Some(TOKEN), Some(&note("w", "rest", 1000).to_string())).await;
    // REST writers run while c1's stale puts are handled, so broadcasts are queued
    // on c1's connection when the rejections are answered.
    let rounds = 60;
    let writers: Vec<_> = (0..rounds)
        .map(|i| {
            tokio::spawn(async move {
                let x = format!("x{i}");
                http(
                    a,
                    "PUT",
                    &format!("/v1/notes/{x}"),
                    Some(TOKEN),
                    Some(&note(&x, "other", 1).to_string()),
                )
                .await;
                http(a, "PUT", "/v1/notes/w", Some(TOKEN), Some(&note("w", "rest", 1001 + i).to_string()))
                    .await;
            })
        })
        .collect();
    for _ in 0..rounds {
        send(&mut c1, json!({"type": "put", "note": note("w", "stale", 1)})).await;
    }
    for w in writers {
        w.await.unwrap();
    }
    // Every seq below one a message carries must already have arrived as a note.
    let mut seen = std::collections::HashSet::new();
    let mut rejected = 0;
    while rejected < rounds {
        let m = recv(&mut c1).await;
        let seq = match m["type"].as_str().unwrap() {
            "ack" => {
                assert_eq!(m["accepted"], false);
                rejected += 1;
                m["seq"].as_i64().unwrap()
            }
            "note" => m["note"]["seq"].as_i64().unwrap(),
            t => panic!("unexpected {t}"),
        };
        if let Some(gap) = (1..seq).find(|k| !seen.contains(k)) {
            panic!("seq {seq} arrived before {gap}");
        }
        if m["type"] == "note" {
            seen.insert(seq);
        }
    }
    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

async fn hello_in(ws: &mut Ws, since: i64, collections: &[&str]) -> Value {
    send(ws, json!({"type": "hello", "since": since, "device": "test", "collections": collections})).await;
    let snap = recv(ws).await;
    assert_eq!(snap["type"], "snapshot", "{snap}");
    snap
}

fn doc(collection: &str, id: &str, body: &str, updated_at: i64) -> Value {
    let mut d = note(id, body, updated_at);
    d["collection"] = json!(collection);
    d
}

/// `(id, collection)` of every document in a list.
fn ids(docs: &Value) -> Vec<(String, String)> {
    docs.as_array()
        .unwrap()
        .iter()
        .map(|d| (d["id"].as_str().unwrap().into(), d["collection"].as_str().unwrap().into()))
        .collect()
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

async fn quiet(ws: &mut Ws) {
    if let Some(m) = try_recv(ws, Duration::from_millis(200)).await {
        panic!("unexpected message {m}");
    }
}

#[tokio::test]
async fn collections_are_isolated() {
    let srv = Server::start("coll").await;
    let a = srv.addr;
    let tok = Some(TOKEN);

    // An old client (no `collections`), a todos client and a mixed one (todos first).
    let mut old = ws_connect(a, TOKEN).await.unwrap();
    let mut todo = ws_connect(a, TOKEN).await.unwrap();
    let mut mixed = ws_connect(a, TOKEN).await.unwrap();
    hello(&mut old, 0).await;
    hello_in(&mut todo, 0, &["todos"]).await;
    hello_in(&mut mixed, 0, &["todos", "notes"]).await;

    // Old REST note -> old + mixed, carrying "collection".
    let (st, r) = http(a, "PUT", "/v1/notes/n1", tok, Some(&note("n1", "one", 1000).to_string())).await;
    assert_eq!(
        (st, r["accepted"].clone(), r["note"]["collection"].clone()),
        (200, json!(true), json!("notes"))
    );
    assert_eq!(recv(&mut old).await["note"]["collection"], "notes");
    assert_eq!(recv(&mut mixed).await["note"]["id"], "n1");
    quiet(&mut todo).await;

    // Todo WS put without note.collection -> the connection's first collection.
    send(&mut todo, json!({"type": "put", "note": note("t1", "{}", 1000)})).await;
    assert_eq!(recv(&mut todo).await, json!({"type": "ack", "id": "t1", "seq": 2, "accepted": true}));
    let got = recv(&mut mixed).await;
    assert_eq!((got["note"]["id"].clone(), got["note"]["collection"].clone()), (json!("t1"), json!("todos")));
    quiet(&mut old).await;

    // Mixed client: default collection is its first one (todos); explicit notes works too.
    send(&mut mixed, json!({"type": "put", "note": note("t2", "{}", 1000)})).await;
    assert_eq!(recv(&mut mixed).await["seq"], 3);
    assert_eq!(recv(&mut todo).await["note"]["id"], "t2");
    send(&mut mixed, json!({"type": "put", "note": doc("notes", "n2", "two", 1000)})).await;
    assert_eq!(recv(&mut mixed).await["seq"], 4);
    assert_eq!(recv(&mut old).await["note"]["id"], "n2");
    quiet(&mut todo).await;
    quiet(&mut old).await;

    // /v1/c REST: docs/doc keys; body collection optional but must match the path.
    let (st, r) =
        http(a, "PUT", "/v1/c/todos/t3", tok, Some(&note("t3", "{\"type\":\"task\"}", 1).to_string())).await;
    assert_eq!(st, 200);
    assert_eq!((r["accepted"].clone(), r["doc"]["collection"].clone()), (json!(true), json!("todos")));
    assert_eq!(r["doc"]["seq"], 5);
    assert!(r.get("note").is_none());
    assert_eq!(recv(&mut todo).await["note"]["id"], "t3");
    assert_eq!(recv(&mut mixed).await["note"]["id"], "t3");
    quiet(&mut old).await;
    let (st, r) = http(a, "PUT", "/v1/c/todos/t4", tok, Some(&doc("todos", "t4", "{}", 1).to_string())).await;
    assert_eq!((st, r["doc"]["seq"].clone()), (200, json!(6)));
    recv(&mut todo).await;
    recv(&mut mixed).await;
    let (st, r) = http(a, "DELETE", "/v1/c/todos/t4?updated_at=50", tok, None).await;
    assert_eq!(st, 200);
    assert_eq!((r["doc"]["deleted"].clone(), r["doc"]["seq"].clone()), (json!(true), json!(7)));
    assert_eq!(recv(&mut todo).await["note"]["deleted"], true);
    recv(&mut mixed).await;
    quiet(&mut old).await;
    for (path, body) in [
        ("/v1/c/todos/x", doc("notes", "x", "", 1)),
        ("/v1/notes/x", doc("todos", "x", "", 1)),
        ("/v1/c/Todos/x", note("x", "", 1)),
        ("/v1/c/todos/x", doc("", "x", "", 1)),
    ] {
        let (st, r) = http(a, "PUT", path, tok, Some(&body.to_string())).await;
        assert_eq!(st, 400, "{path} {body}: {r}");
    }
    assert_eq!(http(a, "GET", "/v1/c/BAD", tok, None).await.0, 400);
    assert_eq!(http(a, "GET", "/v1/c/todos", None, None).await.0, 401);

    // Ids are unique across collections: 409 over REST, error with id over WS.
    for (method, path, body) in [
        ("PUT", "/v1/c/todos/n1", Some(note("n1", "{}", 9999).to_string())),
        ("PUT", "/v1/notes/t1", Some(note("t1", "x", 9999).to_string())),
        ("DELETE", "/v1/c/todos/n1?updated_at=9999", None),
        ("DELETE", "/v1/notes/t1?updated_at=9999", None),
    ] {
        let (st, r) = http(a, method, path, tok, body.as_deref()).await;
        assert_eq!(st, 409, "{method} {path}: {r}");
        assert!(r["error"].as_str().unwrap().contains("already exists"), "{r}");
    }
    send(&mut old, json!({"type": "put", "note": note("t1", "x", 9999)})).await;
    let e = recv(&mut old).await;
    assert_eq!((e["type"].clone(), e["id"].clone()), (json!("error"), json!("t1")));
    send(&mut todo, json!({"type": "put", "note": note("n1", "{}", 9999)})).await;
    let e = recv(&mut todo).await;
    assert_eq!(e["id"], "n1");
    assert!(e["message"].as_str().unwrap().contains("already exists"), "{e}");
    quiet(&mut mixed).await;

    // A todo body that isn't a JSON object (here a raw newline inside a string) is refused
    // over REST and WS and never stored or broadcast; notes bodies stay free text.
    let raw = "{\"type\":\"task\",\"fields\":{\"description\":\"a\nb\"}}";
    let (st, r) = http(a, "PUT", "/v1/c/todos/bad", tok, Some(&note("bad", raw, 1).to_string())).await;
    assert_eq!(st, 400, "{r}");
    assert!(r["error"].as_str().unwrap().contains("JSON object"), "{r}");
    send(&mut todo, json!({"type": "put", "note": note("bad", raw, 1)})).await;
    let e = recv(&mut todo).await;
    assert_eq!((e["type"].clone(), e["id"].clone()), (json!("error"), json!("bad")));
    quiet(&mut mixed).await;

    // A put to a collection the connection didn't subscribe to: acked, never sent back to it.
    send(&mut old, json!({"type": "put", "note": doc("todos", "t5", "{}", 100)})).await;
    assert_eq!(recv(&mut old).await, json!({"type": "ack", "id": "t5", "seq": 8, "accepted": true}));
    assert_eq!(recv(&mut todo).await["note"]["id"], "t5");
    recv(&mut mixed).await;
    send(&mut old, json!({"type": "put", "note": doc("todos", "t5", "{}", 1)})).await;
    assert_eq!(recv(&mut old).await, json!({"type": "ack", "id": "t5", "seq": 8, "accepted": false}));
    quiet(&mut old).await;
    send(&mut old, json!({"type": "put", "note": doc("No!", "z", "", 1)})).await;
    let e = recv(&mut old).await;
    assert_eq!((e["type"].clone(), e["id"].clone()), (json!("error"), json!("z")));

    // Listings.
    let (_, l) = http(a, "GET", "/v1/notes?since=0", tok, None).await;
    assert_eq!(ids(&l["notes"]), pairs(&[("n1", "notes"), ("n2", "notes")]));
    assert_eq!(l["seq"], 8);
    assert!(l.get("docs").is_none());
    let (_, l) = http(a, "GET", "/v1/c/notes?since=0", tok, None).await;
    assert_eq!(ids(&l["docs"]), pairs(&[("n1", "notes"), ("n2", "notes")]));
    let (_, l) = http(a, "GET", "/v1/c/todos?since=3", tok, None).await;
    assert_eq!(ids(&l["docs"]), pairs(&[("t3", "todos"), ("t4", "todos"), ("t5", "todos")]));
    assert_eq!(l["seq"], 8);
    let (_, l) = http(a, "GET", "/v1/c/nothing-here", tok, None).await;
    assert_eq!(l, json!({"docs": [], "seq": 8}));

    // Snapshots are filtered too; seq is the global latest.
    let mut c = ws_connect(a, TOKEN).await.unwrap();
    let s = hello(&mut c, 0).await;
    assert_eq!((ids(&s["notes"]), s["seq"].clone()), (pairs(&[("n1", "notes"), ("n2", "notes")]), json!(8)));
    let s = hello_in(&mut c, 2, &["todos"]).await;
    assert_eq!(
        ids(&s["notes"]),
        pairs(&[("t2", "todos"), ("t3", "todos"), ("t4", "todos"), ("t5", "todos")])
    );
    let s = hello_in(&mut c, 0, &["notes", "todos", "notes"]).await;
    let seqs: Vec<i64> = s["notes"].as_array().unwrap().iter().map(|n| n["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [1, 2, 3, 4, 5, 7, 8]);

    // Invalid hellos are refused with an error (no snapshot) and change nothing.
    let nine: Vec<String> = (0..9).map(|i| format!("c{i}")).collect();
    for bad in [json!([]), json!(nine), json!(["todos", "Bad"]), json!("todos"), json!([1])] {
        send(&mut c, json!({"type": "hello", "since": 0, "collections": bad})).await;
        assert_eq!(recv(&mut c).await["type"], "error", "{bad}");
    }
    let s = hello_in(&mut c, 7, &["todos"]).await;
    assert_eq!(ids(&s["notes"]), pairs(&[("t5", "todos")]));

    // Before hello, puts default to notes.
    let mut pre = ws_connect(a, TOKEN).await.unwrap();
    send(&mut pre, json!({"type": "put", "note": note("p1", "pre", 1)})).await;
    assert_eq!(recv(&mut pre).await["seq"], 9);
    assert_eq!(recv(&mut old).await["note"]["collection"], "notes");
    quiet(&mut todo).await;

    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn ordering_with_collections() {
    let srv = Server::start("corder").await;
    let a = srv.addr;
    let mut todo = ws_connect(a, TOKEN).await.unwrap();
    let mut old = ws_connect(a, TOKEN).await.unwrap();
    let mut both = ws_connect(a, TOKEN).await.unwrap();
    hello_in(&mut todo, 0, &["todos"]).await;
    hello(&mut old, 0).await;
    hello_in(&mut both, 0, &["notes", "todos"]).await;

    // Interleaved writers in two collections. The todos client must still see
    // strictly increasing seqs (gaps where notes were written), with every todo
    // broadcast that precedes an ack arriving before it.
    for i in 0..20 {
        let k = format!("k{i}");
        send(&mut todo, json!({"type": "put", "note": note(&k, "{}", 1)})).await;
        let r = format!("r{i}");
        http(a, "PUT", &format!("/v1/notes/{r}"), Some(TOKEN), Some(&note(&r, "n", 1).to_string())).await;
        let s = format!("s{i}");
        http(a, "PUT", &format!("/v1/c/todos/{s}"), Some(TOKEN), Some(&note(&s, "{}", 1).to_string())).await;
    }
    let (mut last, mut acks, mut notes) = (0, 0, 0);
    while acks < 20 || notes < 20 {
        let m = recv(&mut todo).await;
        let seq = match m["type"].as_str().unwrap() {
            "ack" => {
                acks += 1;
                m["seq"].as_i64().unwrap()
            }
            "note" => {
                notes += 1;
                assert_eq!(m["note"]["collection"], "todos");
                assert!(m["note"]["id"].as_str().unwrap().starts_with('s'));
                m["note"]["seq"].as_i64().unwrap()
            }
            t => panic!("unexpected {t}"),
        };
        assert!(seq > last, "seq went from {last} to {seq}");
        last = seq;
    }
    quiet(&mut todo).await;

    let mut last = 0;
    for _ in 0..20 {
        let m = recv(&mut old).await;
        assert_eq!(m["note"]["collection"], "notes");
        let seq = m["note"]["seq"].as_i64().unwrap();
        assert!(seq > last);
        last = seq;
    }
    quiet(&mut old).await;

    let mut last = 0;
    for _ in 0..60 {
        let seq = recv(&mut both).await["note"]["seq"].as_i64().unwrap();
        assert!(seq > last);
        last = seq;
    }
    assert_eq!(last, 60);
    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// HTTP with a binary body: returns (status, lowercased head, body bytes).
async fn http_bytes(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\n{auth}Content-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).await.unwrap();
    // the server may answer (413) before reading a large body
    let _ = s.write_all(body).await;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf).await;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_ascii_lowercase();
    let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head, buf[split + 4..].to_vec())
}

#[tokio::test]
async fn blobs() {
    use bento_sync::store::{sha256_hex, MAX_BLOB_BYTES};
    let srv = Server::start("blobs").await;
    let a = srv.addr;
    let (_, health) = http(a, "GET", "/v1/health", None, None).await;
    assert_eq!(health["blobs"], true);

    let png: Vec<u8> = [&b"\x89PNG\r\n\x1a\n"[..], &[7u8; 5000]].concat();
    let hash = sha256_hex(&png);
    let path = format!("/v1/blobs/{hash}");

    // auth required for both
    assert_eq!(http_bytes(a, "PUT", &path, None, &png).await.0, 401);
    assert_eq!(http_bytes(a, "GET", &path, None, b"").await.0, 401);
    assert_eq!(http_bytes(a, "GET", &path, Some(TOKEN), b"").await.0, 404);
    assert_eq!(http_bytes(a, "HEAD", &path, Some(TOKEN), b"").await.0, 404);

    let (st, _, body) = http_bytes(a, "PUT", &path, Some(TOKEN), &png).await;
    assert_eq!(st, 200);
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v, json!({"hash": hash, "type": "image/png", "size": png.len(), "created": true}));
    let (st, _, body) = http_bytes(a, "PUT", &path, Some(TOKEN), &png).await;
    assert_eq!(st, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["created"], false);

    let (st, head, body) = http_bytes(a, "GET", &path, Some(TOKEN), b"").await;
    assert_eq!(st, 200);
    assert_eq!(body, png);
    assert!(head.contains("content-type: image/png"), "{head}");
    assert!(head.contains("immutable"), "{head}");
    assert!(head.contains("x-content-type-options: nosniff"), "{head}");
    let (st, _, body) = http_bytes(a, "HEAD", &path, Some(TOKEN), b"").await;
    assert_eq!((st, body.len()), (200, 0));

    // wrong hash, bad hash, not an image
    let other = format!("/v1/blobs/{}", sha256_hex(b"x"));
    assert_eq!(http_bytes(a, "PUT", &other, Some(TOKEN), &png).await.0, 400);
    assert_eq!(http_bytes(a, "PUT", "/v1/blobs/nothex", Some(TOKEN), &png).await.0, 400);
    assert_eq!(http_bytes(a, "GET", "/v1/blobs/nothex", Some(TOKEN), b"").await.0, 400);
    let html = b"<html>hi</html>";
    assert_eq!(
        http_bytes(a, "PUT", &format!("/v1/blobs/{}", sha256_hex(html)), Some(TOKEN), html).await.0,
        415
    );

    // the largest image is accepted (above the documents' request limit), one byte more is not
    let mut big = png.clone();
    big.resize(MAX_BLOB_BYTES, 1);
    let (st, _, _) =
        http_bytes(a, "PUT", &format!("/v1/blobs/{}", sha256_hex(&big)), Some(TOKEN), &big).await;
    assert_eq!(st, 200);
    big.push(1);
    let (st, _, _) =
        http_bytes(a, "PUT", &format!("/v1/blobs/{}", sha256_hex(&big)), Some(TOKEN), &big).await;
    assert_eq!(st, 413);

    // which ones the server is missing
    let unknown = sha256_hex(b"never uploaded");
    let q = json!({"hashes": [hash, unknown]}).to_string();
    let (st, v) = http(a, "POST", "/v1/blobs/missing", Some(TOKEN), Some(&q)).await;
    assert_eq!((st, v), (200, json!({"missing": [unknown]})));
    assert_eq!(http(a, "POST", "/v1/blobs/missing", None, Some(&q)).await.0, 401);
    assert_eq!(http(a, "POST", "/v1/blobs/missing", Some(TOKEN), Some(r#"{"hashes":["x"]}"#)).await.0, 400);
    let many = json!({"hashes": vec![unknown.clone(); bento_sync::MAX_MISSING_QUERY + 1]}).to_string();
    assert_eq!(http(a, "POST", "/v1/blobs/missing", Some(TOKEN), Some(&many)).await.0, 400);

    // a big one comes in several chunks, whole, with its length
    let mut photo = png.clone();
    photo.extend((0..700_000u32).map(|i| (i % 251) as u8));
    let photo_path = format!("/v1/blobs/{}", sha256_hex(&photo));
    assert_eq!(http_bytes(a, "PUT", &photo_path, Some(TOKEN), &photo).await.0, 200);
    let (st, head, body) = http_bytes(a, "GET", &photo_path, Some(TOKEN), b"").await;
    assert_eq!(st, 200);
    assert!(head.contains(&format!("content-length: {}", photo.len())), "{head}");
    assert_eq!(body, photo);

    // documents keep their own limit
    let doc = format!("{{\"updated_at\":1,\"body\":\"{}\"}}", "x".repeat(bento_sync::MAX_REQUEST_BYTES));
    assert_eq!(http(a, "PUT", "/v1/notes/n", Some(TOKEN), Some(&doc)).await.0, 413);

    // a blob survives a restart; storing one bumps no seq
    let dir = srv.stop().await;
    let srv = Server::start_in(dir).await;
    let (st, _, body) = http_bytes(srv.addr, "GET", &path, Some(TOKEN), b"").await;
    assert_eq!((st, body), (200, png));
    assert_eq!(http(srv.addr, "GET", "/v1/health", None, None).await.1["seq"], 0);
    let dir = srv.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}
