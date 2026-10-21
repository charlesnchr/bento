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
    assert_eq!((st, h.clone()), (200, json!({"ok": true, "seq": 0})));

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
