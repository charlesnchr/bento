//! bento-sync: single-user realtime sync server for Bento notes (and the other
//! collections of documents, e.g. todos).
//! See docs/SYNC_PROTOCOL.md for the wire contract.

pub mod store;
mod ws;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{Change, Note, NoteIn, PutOutcome, Store, DEFAULT_COLLECTION};
use tokio::sync::{broadcast, watch};

/// Max HTTP request body / WebSocket message. Larger than the 1 MB note body
/// limit to leave room for JSON escaping; the decoded body is checked exactly.
pub const MAX_REQUEST_BYTES: usize = 3 * 1024 * 1024;
const BROADCAST_CAPACITY: usize = 256;

/// A committed change, fanned out to every WebSocket connection.
pub(crate) struct Event {
    /// Connection id that made the change (0 = REST).
    origin: u64,
    seq: i64,
    collection: String,
    /// Pre-serialized `{"type":"note","note":…}` message.
    msg: String,
}

struct Inner {
    store: Mutex<Store>,
    events: broadcast::Sender<Arc<Event>>,
    token: Vec<u8>,
    next_conn: AtomicU64,
    active_conns: AtomicUsize,
    shutdown: watch::Receiver<bool>,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    pub fn new(store: Store, token: &str, shutdown: watch::Receiver<bool>) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        AppState(Arc::new(Inner {
            store: Mutex::new(store),
            events,
            token: token.as_bytes().to_vec(),
            next_conn: AtomicU64::new(1),
            active_conns: AtomicUsize::new(0),
            shutdown,
        }))
    }

    pub fn active_connections(&self) -> usize {
        self.0.active_conns.load(Ordering::Relaxed)
    }

    /// Run `f` against the store on the blocking pool.
    async fn with_store<T, F>(&self, f: F) -> Result<T, store::Error>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store, &broadcast::Sender<Arc<Event>>) -> Result<T, store::Error> + Send + 'static,
    {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut st = inner.store.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut st, &inner.events)
        })
        .await
        .unwrap_or_else(|e| Err(store::Error::Internal(format!("internal error: {e}"))))
    }

    /// Apply a change and, if accepted, broadcast it. The broadcast happens while
    /// the store lock is held, so events enter the channel in seq order and a
    /// snapshot taken under the same lock never misses or reorders an event.
    pub(crate) async fn put(&self, change: Change, origin: u64) -> Result<PutOutcome, store::Error> {
        self.with_store(move |st, events| {
            let out = st.put(change)?;
            if out.accepted {
                let msg = json!({"type": "note", "note": &out.note}).to_string();
                let collection = out.note.collection.clone();
                let _ = events.send(Arc::new(Event { origin, seq: out.note.seq, collection, msg }));
            }
            Ok(out)
        })
        .await
    }

    pub(crate) async fn changes_since(
        &self,
        since: i64,
        collections: Vec<String>,
    ) -> Result<(Vec<Note>, i64), store::Error> {
        self.with_store(move |st, _| st.changes_since(since, &collections)).await
    }

    async fn get_note(&self, id: String) -> Result<Option<Note>, store::Error> {
        self.with_store(move |st, _| st.get(&id)).await
    }

    fn check_token(&self, candidate: &[u8]) -> bool {
        constant_time_eq(&self.0.token, candidate)
    }
}

/// Constant-time comparison (only the length is observable).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_response(status: StatusCode, v: Value) -> Response {
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], v.to_string())
        .into_response()
}

fn error_response(e: store::Error) -> Response {
    let status = match &e {
        store::Error::BadRequest(_) => StatusCode::BAD_REQUEST,
        store::Error::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
        store::Error::Conflict(_) => StatusCode::CONFLICT,
        store::Error::Db(_) | store::Error::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    if status.is_server_error() {
        log(&format!("error: {e}"));
    }
    json_response(status, json!({"error": e.to_string()}))
}

pub fn log(msg: &str) {
    eprintln!("{msg}");
}

fn bad_request(msg: &str) -> Response {
    error_response(store::Error::BadRequest(msg.into()))
}

/// Bearer token from the Authorization header, or `?token=` for manual testing.
fn request_token(req: &Request) -> Option<&[u8]> {
    if let Some(v) = req.headers().get(header::AUTHORIZATION) {
        let v = v.as_bytes();
        if v.len() > 7 && v[..7].eq_ignore_ascii_case(b"bearer ") {
            return Some(v[7..].trim_ascii());
        }
        return None;
    }
    req.uri().query()?.split('&').find_map(|kv| kv.strip_prefix("token=")).map(str::as_bytes)
}

async fn auth(State(st): State<AppState>, req: Request, next: Next) -> Response {
    match request_token(&req) {
        Some(t) if st.check_token(t) => next.run(req).await,
        _ => {
            let mut r = json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
            r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            r
        }
    }
}

async fn health(State(st): State<AppState>) -> Response {
    match st.with_store(|s, _| s.latest_seq()).await {
        // `collections`: clients of other collections must not sync with a server that would
        // file their documents under notes.
        Ok(seq) => json_response(StatusCode::OK, json!({"ok": true, "seq": seq, "collections": true})),
        Err(e) => error_response(e),
    }
}

/// Response keys: `/v1/notes…` keeps the original `notes`/`note`, `/v1/c/…` uses `docs`/`doc`.
#[derive(Clone, Copy)]
struct Keys {
    list: &'static str,
    one: &'static str,
}

const NOTE_KEYS: Keys = Keys { list: "notes", one: "note" };
const DOC_KEYS: Keys = Keys { list: "docs", one: "doc" };

#[derive(Deserialize)]
struct SinceQuery {
    since: Option<String>,
}

async fn list_notes(State(st): State<AppState>, Query(q): Query<SinceQuery>) -> Response {
    list(st, DEFAULT_COLLECTION.into(), q, NOTE_KEYS).await
}

async fn list_docs(
    State(st): State<AppState>,
    Path(collection): Path<String>,
    Query(q): Query<SinceQuery>,
) -> Response {
    if !store::valid_collection(&collection) {
        return bad_request(store::INVALID_COLLECTION);
    }
    list(st, collection, q, DOC_KEYS).await
}

async fn list(st: AppState, collection: String, q: SinceQuery, keys: Keys) -> Response {
    let since = match q.since.as_deref().map(str::parse::<i64>) {
        None => 0,
        Some(Ok(n)) => n,
        Some(Err(_)) => return bad_request("since must be an integer"),
    };
    match st.changes_since(since, vec![collection]).await {
        Ok((notes, seq)) => json_response(StatusCode::OK, json!({keys.list: notes, "seq": seq})),
        Err(e) => error_response(e),
    }
}

fn put_response(out: PutOutcome, keys: Keys) -> Response {
    json_response(StatusCode::OK, json!({keys.one: out.note, "accepted": out.accepted}))
}

async fn put_note(State(st): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    put(st, DEFAULT_COLLECTION, &id, &body, NOTE_KEYS).await
}

async fn put_doc(
    State(st): State<AppState>,
    Path((collection, id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    put(st, &collection, &id, &body, DOC_KEYS).await
}

/// The body's `collection`, if any, must match the path's (400 otherwise).
async fn put(st: AppState, collection: &str, id: &str, body: &[u8], keys: Keys) -> Response {
    let input: NoteIn = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad_request(&format!("invalid JSON note: {e}")),
    };
    let change = match input.into_change(Some(id), Some(collection), "rest") {
        Ok(c) => c,
        Err(e) => return error_response(e),
    };
    match st.put(change, 0).await {
        Ok(out) => put_response(out, keys),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct DeleteQuery {
    updated_at: Option<String>,
    device: Option<String>,
}

async fn delete_note(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Response {
    delete(st, DEFAULT_COLLECTION, id, q, NOTE_KEYS).await
}

async fn delete_doc(
    State(st): State<AppState>,
    Path((collection, id)): Path<(String, String)>,
    Query(q): Query<DeleteQuery>,
) -> Response {
    delete(st, &collection, id, q, DOC_KEYS).await
}

async fn delete(st: AppState, collection: &str, id: String, q: DeleteQuery, keys: Keys) -> Response {
    let updated_at = match q.updated_at.as_deref().map(str::parse::<i64>) {
        None => now_ms(),
        Some(Ok(n)) => n,
        Some(Err(_)) => return bad_request("updated_at must be an integer (unix ms)"),
    };
    // Keep the stored meta on the tombstone; body is cleared. (An id stored in
    // another collection is refused by the put below.)
    let meta = match st.get_note(id.clone()).await {
        Ok(n) => n.map(|n| n.meta),
        Err(e) => return error_response(e),
    };
    let input = NoteIn {
        id: Some(id.clone()),
        body: Some(String::new()),
        updated_at: Some(updated_at),
        deleted: Some(true),
        device: q.device,
        meta,
        ..Default::default()
    };
    let change = match input.into_change(Some(&id), Some(collection), "rest") {
        Ok(c) => c,
        Err(e) => return error_response(e),
    };
    match st.put(change, 0).await {
        Ok(out) => put_response(out, keys),
        Err(e) => error_response(e),
    }
}

async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}))
}

pub fn router(state: AppState) -> Router {
    let authed = Router::new()
        .route("/v1/notes", get(list_notes))
        .route("/v1/notes/{id}", axum::routing::put(put_note).delete(delete_note))
        .route("/v1/c/{collection}", get(list_docs))
        .route("/v1/c/{collection}/{id}", axum::routing::put(put_doc).delete(delete_doc))
        .route("/v1/sync", get(ws::handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .route("/v1/health", get(health))
        .merge(authed)
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

/// Serve until `shutdown` resolves, then close WebSockets (1001) and wait up to
/// 3 s for them to finish.
pub async fn serve(
    listener: tokio::net::TcpListener,
    store: Store,
    token: &str,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let (stop_tx, stop_rx) = watch::channel(false);
    let state = AppState::new(store, token, stop_rx);
    let app = router(state.clone());
    let signal = async move {
        shutdown.await;
        let _ = stop_tx.send(true);
    };
    axum::serve(listener, app).with_graceful_shutdown(signal).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while state.active_connections() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}
