//! `GET /v1/sync` WebSocket handler.
//!
//! One task per connection multiplexes: client messages, broadcast events from
//! other connections, a 30 s ping timer and server shutdown.
//!
//! Ordering guarantees:
//! * Broadcasts are only forwarded after `hello`; anything committed before the
//!   snapshot is in the snapshot (events with `seq <= snapshot.seq` are skipped).
//! * Before acking a put with seq N, queued broadcasts with seq < N are
//!   forwarded first, so a client that tracks `last_seq` never skips a change
//!   and every connection sees seqs (notes and acks) in increasing order.
//!
//! Collections: `hello.collections` (default `["notes"]`) filters the snapshot
//! and the forwarded broadcasts. The filter is applied when an event is
//! forwarded, after the seq checks above, so events of other collections are
//! simply dropped and don't affect ordering (seqs of one collection have gaps).

use crate::store::{valid_collection, NoteIn, PutOutcome, DEFAULT_COLLECTION, INVALID_COLLECTION};
use crate::{log, AppState, Event, MAX_REQUEST_BYTES};
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::broadcast::Receiver;
use tokio::time::{interval_at, Instant};

const PING_EVERY: Duration = Duration::from_secs(30);
/// Close the connection if nothing (not even a pong) arrived for this long.
const IDLE_TIMEOUT: Duration = Duration::from_secs(95);
const MAX_COLLECTIONS: usize = 8;

pub async fn handler(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_REQUEST_BYTES)
        .max_frame_size(MAX_REQUEST_BYTES)
        .on_upgrade(move |socket| connection(st, socket))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    Hello {
        #[serde(default)]
        since: Option<i64>,
        #[serde(default)]
        device: Option<String>,
        #[serde(default)]
        collections: Option<Vec<String>>,
    },
    Put {
        note: NoteIn,
    },
    Ping,
}

struct Conn {
    id: u64,
    st: AppState,
    socket: WebSocket,
    rx: Receiver<Arc<Event>>,
    /// `None` until hello (broadcasts are dropped); then broadcasts with
    /// `seq <= floor` are skipped because the snapshot already contained them.
    floor: Option<i64>,
    device: String,
    /// What the connection receives (snapshot + broadcasts); the first one is
    /// the default for puts without `note.collection`. `["notes"]` until hello.
    collections: Vec<String>,
}

/// Why the loop ended.
enum End {
    Closed,
    Error,
    Lagged,
}

async fn connection(st: AppState, socket: WebSocket) {
    let inner = st.0.clone();
    inner.active_conns.fetch_add(1, Ordering::Relaxed);
    let id = inner.next_conn.fetch_add(1, Ordering::Relaxed);
    let mut shutdown = inner.shutdown.clone();
    let mut c = Conn {
        id,
        rx: inner.events.subscribe(),
        st,
        socket,
        floor: None,
        device: String::new(),
        collections: vec![DEFAULT_COLLECTION.to_string()],
    };
    log(&format!("ws#{id}: connected"));
    let mut ping = interval_at(Instant::now() + PING_EVERY, PING_EVERY);
    let mut last_seen = Instant::now();

    let end = loop {
        tokio::select! {
            msg = c.socket.recv() => {
                last_seen = Instant::now();
                match msg {
                    None => break End::Closed,
                    Some(Ok(Message::Close(_))) => {
                        // Flush the close reply tungstenite queued for us.
                        let _ = c.socket.send(Message::Close(None)).await;
                        break End::Closed;
                    }
                    Some(Err(_)) => break End::Error,
                    Some(Ok(Message::Text(t))) => {
                        if let Err(e) = c.on_text(t.as_str()).await { break e; }
                    }
                    Some(Ok(Message::Binary(b))) => {
                        let r = match std::str::from_utf8(&b) {
                            Ok(t) => c.on_text(t).await,
                            Err(_) => c.send_error("binary frames must be UTF-8 JSON", None).await,
                        };
                        if let Err(e) = r { break e; }
                    }
                    // Pongs to our pings are queued automatically by tungstenite.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                }
            }
            ev = c.rx.recv() => {
                let r = match ev {
                    Ok(ev) => c.forward(&ev).await,
                    Err(RecvError::Lagged(_)) => Err(End::Lagged),
                    Err(RecvError::Closed) => Err(End::Closed),
                };
                if let Err(e) = r { break e; }
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE_TIMEOUT {
                    break End::Error;
                }
                if c.socket.send(Message::Ping(Default::default())).await.is_err() {
                    break End::Error;
                }
            }
            _ = shutdown.changed() => {
                let _ = c.socket.send(close(1001, "server shutting down")).await;
                break End::Closed;
            }
        }
    };

    if let End::Lagged = end {
        // We dropped events for this client; make it reconnect and resync via hello.
        let _ = c.send_error("too far behind; reconnect and send hello", None).await;
        let _ = c.socket.send(close(1013, "lagged")).await;
    }
    let why = match end {
        End::Closed => "closed",
        End::Error => "error/timeout",
        End::Lagged => "lagged",
    };
    log(&format!("ws#{id}: disconnected ({why})"));
    inner.active_conns.fetch_sub(1, Ordering::Relaxed);
}

fn close(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static(reason) }))
}

impl Conn {
    async fn send_json(&mut self, v: Value) -> Result<(), End> {
        self.send_text(v.to_string()).await
    }

    async fn send_text(&mut self, s: String) -> Result<(), End> {
        self.socket.send(Message::Text(s.into())).await.map_err(|_| End::Error)
    }

    async fn send_error(&mut self, message: &str, id: Option<&str>) -> Result<(), End> {
        let mut v = json!({"type": "error", "message": message});
        if let Some(id) = id {
            v["id"] = json!(id);
        }
        self.send_json(v).await
    }

    async fn forward(&mut self, ev: &Event) -> Result<(), End> {
        // Before hello nothing is forwarded (the snapshot will contain it).
        let Some(floor) = self.floor else { return Ok(()) };
        if ev.origin != self.id && ev.seq > floor && self.subscribed(&ev.collection) {
            self.send_text(ev.msg.clone()).await?;
        }
        Ok(())
    }

    fn subscribed(&self, collection: &str) -> bool {
        self.collections.iter().any(|c| c == collection)
    }

    /// Forward queued broadcasts with `seq < before`. Returns the first queued
    /// event with a higher seq (to be forwarded after the ack), if any.
    async fn drain_before(&mut self, before: i64) -> Result<Option<Arc<Event>>, End> {
        loop {
            match self.rx.try_recv() {
                Ok(ev) if ev.seq < before => self.forward(&ev).await?,
                Ok(ev) => return Ok(Some(ev)),
                Err(TryRecvError::Empty) => return Ok(None),
                Err(TryRecvError::Lagged(_)) => return Err(End::Lagged),
                Err(TryRecvError::Closed) => return Err(End::Closed),
            }
        }
    }

    async fn on_text(&mut self, text: &str) -> Result<(), End> {
        let msg: ClientMsg = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => return self.send_error(&format!("invalid message: {e}"), None).await,
        };
        match msg {
            ClientMsg::Ping => self.send_json(json!({"type": "pong"})).await,
            ClientMsg::Hello { since, device, collections } => {
                if let Some(cs) = collections {
                    if cs.is_empty() || cs.len() > MAX_COLLECTIONS {
                        let msg = format!("hello.collections needs 1-{MAX_COLLECTIONS} names");
                        return self.send_error(&msg, None).await;
                    }
                    if !cs.iter().all(|c| valid_collection(c)) {
                        return self.send_error(INVALID_COLLECTION, None).await;
                    }
                    self.collections.clear();
                    for c in cs {
                        if !self.subscribed(&c) {
                            self.collections.push(c);
                        }
                    }
                }
                if let Some(d) = device {
                    self.device = d.chars().take(64).collect();
                }
                let since = since.unwrap_or(0);
                match self.st.changes_since(since, self.collections.clone()).await {
                    Ok((notes, seq)) => {
                        log(&format!(
                            "ws#{}: hello device={:?} collections={:?} since={since} -> {} notes, seq {seq}",
                            self.id,
                            self.device,
                            self.collections,
                            notes.len()
                        ));
                        // Everything up to `seq` is in the snapshot; skip those events.
                        self.floor = Some(self.floor.map_or(seq, |f| f.max(seq)));
                        self.send_json(json!({"type": "snapshot", "notes": notes, "seq": seq})).await
                    }
                    Err(e) => self.send_error(&e.to_string(), None).await,
                }
            }
            ClientMsg::Put { mut note } => {
                let id_hint = note.id.clone();
                if note.collection.is_none() {
                    note.collection = Some(self.collections[0].clone());
                }
                let fallback = if self.device.is_empty() { "unknown" } else { &self.device };
                let change = match note.into_change(None, None, fallback) {
                    Ok(c) => c,
                    Err(e) => return self.send_error(&e.to_string(), id_hint.as_deref()).await,
                };
                let out: PutOutcome = match self.st.put(change, self.id).await {
                    Ok(o) => o,
                    Err(e) => return self.send_error(&e.to_string(), id_hint.as_deref()).await,
                };
                // Changes committed before this one go out before the ack, later
                // ones after it, so each connection sees seqs in increasing order.
                let later = if out.accepted { self.drain_before(out.note.seq).await? } else { None };
                self.send_json(json!({
                    "type": "ack",
                    "id": out.note.id,
                    "seq": out.note.seq,
                    "accepted": out.accepted,
                }))
                .await?;
                // Documents of collections this connection didn't subscribe to are
                // never sent to it, not even the stored winner of a rejected put.
                if !out.accepted && self.subscribed(&out.note.collection) {
                    self.send_json(json!({"type": "note", "note": out.note})).await?;
                }
                if let Some(ev) = later {
                    self.forward(&ev).await?;
                }
                Ok(())
            }
        }
    }
}
