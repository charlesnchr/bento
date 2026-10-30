//! SQLite storage + the last-writer-wins / seq logic.
//!
//! All mutations run inside a transaction. `global_seq` lives in the `meta`
//! table and is bumped by exactly one for every accepted change, so `seq`
//! values are strictly increasing and unique across all notes.
//!
//! Every note belongs to one collection (`notes`, `todos`, …). Ids are unique
//! across collections; `seq` is one global counter shared by all of them.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_META_BYTES: usize = 4 * 1024;
pub const MAX_ID_BYTES: usize = 128;
pub const MAX_DEVICE_BYTES: usize = 128;
pub const MAX_COLLECTION_BYTES: usize = 32;
/// The collection of everything that predates collections and of every request that names none.
pub const DEFAULT_COLLECTION: &str = "notes";
/// Largest image blob (bytes).
pub const MAX_BLOB_BYTES: usize = 10 * 1024 * 1024;
const SCHEMA_VERSION: i64 = 3;

/// A note as stored and sent by the server.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub id: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: bool,
    pub seq: i64,
    pub device: String,
    pub meta: Value,
    pub collection: String,
}

/// A note as sent by a client (`seq` and any unknown fields are ignored).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NoteIn {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub deleted: Option<bool>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub collection: Option<String>,
}

/// A validated incoming change, ready to be applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub id: String,
    pub body: String,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    pub deleted: bool,
    pub device: String,
    pub meta: Value,
    pub collection: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PutOutcome {
    /// The accepted note (with its new seq) or, if rejected, the stored winner.
    pub note: Note,
    pub accepted: bool,
}

#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    TooLarge(String),
    /// The id already exists in a different collection.
    Conflict(String),
    /// A blob that isn't an image.
    Unsupported(String),
    Internal(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadRequest(m)
            | Error::TooLarge(m)
            | Error::Conflict(m)
            | Error::Unsupported(m)
            | Error::Internal(m) => f.write_str(m),
            Error::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e)
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// `[a-z][a-z0-9_-]{0,31}`
pub fn valid_collection(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_COLLECTION_BYTES
        && b[0].is_ascii_lowercase()
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
}

pub const INVALID_COLLECTION: &str = "invalid collection (1-32 chars: a-z, then a-z 0-9 - _)";

impl NoteIn {
    /// Validate a client note. `path_id` / `path_collection` come from the URL
    /// (REST) if any and must match the body's; without either, the body's
    /// collection or `notes` is used. `fallback_device` is used when the note
    /// carries no device name.
    pub fn into_change(
        self,
        path_id: Option<&str>,
        path_collection: Option<&str>,
        fallback_device: &str,
    ) -> Result<Change, Error> {
        let id = match (path_id, self.id.as_deref()) {
            (Some(p), Some(b)) if p != b => {
                return Err(Error::BadRequest(format!("id mismatch: path {p:?} vs body {b:?}")))
            }
            (Some(p), _) => p.to_string(),
            (None, Some(b)) => b.to_string(),
            (None, None) => return Err(Error::BadRequest("note.id is required".into())),
        };
        if !valid_id(&id) {
            return Err(Error::BadRequest("invalid id (1-128 chars of A-Z a-z 0-9 - _ . :)".into()));
        }
        let collection = match (path_collection, self.collection) {
            (Some(p), Some(b)) if p != b => {
                return Err(Error::BadRequest(format!("collection mismatch: path {p:?} vs body {b:?}")))
            }
            (Some(p), _) => p.to_string(),
            (None, Some(b)) => b,
            (None, None) => DEFAULT_COLLECTION.to_string(),
        };
        if !valid_collection(&collection) {
            return Err(Error::BadRequest(INVALID_COLLECTION.into()));
        }
        let updated_at =
            self.updated_at.ok_or_else(|| Error::BadRequest("note.updated_at is required".into()))?;
        if updated_at < 0 || self.created_at.is_some_and(|c| c < 0) {
            return Err(Error::BadRequest("timestamps must be >= 0 (unix ms)".into()));
        }
        let deleted = self.deleted.unwrap_or(false);
        let body = if deleted { String::new() } else { self.body.unwrap_or_default() };
        if body.len() > MAX_BODY_BYTES {
            return Err(Error::TooLarge(format!("body exceeds {MAX_BODY_BYTES} bytes")));
        }
        let meta = match self.meta {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(m @ Value::Object(_)) => m,
            Some(_) => return Err(Error::BadRequest("meta must be a JSON object".into())),
        };
        if meta.to_string().len() > MAX_META_BYTES {
            return Err(Error::TooLarge(format!("meta exceeds {MAX_META_BYTES} bytes")));
        }
        let device = match self.device {
            Some(d) if !d.is_empty() => d,
            _ => fallback_device.to_string(),
        };
        if device.len() > MAX_DEVICE_BYTES {
            return Err(Error::BadRequest(format!("device exceeds {MAX_DEVICE_BYTES} bytes")));
        }
        Ok(Change { id, body, created_at: self.created_at, updated_at, deleted, device, meta, collection })
    }
}

/// The conflict rule: a put is accepted iff there is no stored version or
/// `incoming.updated_at >= stored.updated_at` (ties are accepted).
pub fn lww_accepts(stored_updated_at: Option<i64>, incoming_updated_at: i64) -> bool {
    match stored_updated_at {
        None => true,
        Some(s) => incoming_updated_at >= s,
    }
}

pub struct Store {
    conn: Connection,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL UNIQUE,
    device      TEXT NOT NULL DEFAULT '',
    meta        TEXT NOT NULL DEFAULT '{}',
    collection  TEXT NOT NULL DEFAULT 'notes'
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO meta (key, value) VALUES ('global_seq', 0);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', 1);
CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT PRIMARY KEY NOT NULL,
    type        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL
) STRICT;
";

const NOTE_COLS: &str = "id, body, created_at, updated_at, deleted, seq, device, meta, collection";

fn row_to_note(r: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let meta: String = r.get(7)?;
    Ok(Note {
        id: r.get(0)?,
        body: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        deleted: r.get::<_, i64>(4)? != 0,
        seq: r.get(5)?,
        device: r.get(6)?,
        meta: serde_json::from_str(&meta).unwrap_or_else(|_| Value::Object(Map::new())),
        collection: r.get(8)?,
    })
}

fn get_note(tx: &Transaction<'_>, id: &str) -> rusqlite::Result<Option<Note>> {
    tx.query_row(&format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"), [id], row_to_note).optional()
}

fn global_seq(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT value FROM meta WHERE key = 'global_seq'", [], |r| r.get(0))
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, Error> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, Error> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // WAL is a no-op (returns "memory") for in-memory databases.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -2000;",
        )?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Create or upgrade the schema. One IMMEDIATE transaction, so it is
    /// idempotent and safe while another process (e.g. the running server) has
    /// the DB open: the check and the upgrade happen under the write lock.
    fn migrate(&mut self) -> Result<(), Error> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        let has_collection: bool = tx.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name = 'collection'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        // v1 -> v2: collections. A v1 table gets the column with ADD COLUMN, which
        // fills existing rows with the default 'notes'. Binaries from before v2 keep
        // working on a migrated DB (they name their columns explicitly).
        if !has_collection {
            tx.execute_batch("ALTER TABLE notes ADD COLUMN collection TEXT NOT NULL DEFAULT 'notes'")?;
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS notes_collection_seq ON notes (collection, seq)")?;
        // v2 -> v3: the `blobs` table (images), created by SCHEMA above.
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'schema_version' AND value < ?1",
            [SCHEMA_VERSION],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, Error> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))?)
    }

    pub fn latest_seq(&self) -> Result<i64, Error> {
        Ok(global_seq(&self.conn)?)
    }

    /// All notes (incl. tombstones) of `collections` with `seq > since`, ascending,
    /// plus the latest (global) seq. Read in one transaction so the pair is consistent.
    pub fn changes_since<S: AsRef<str>>(
        &mut self,
        since: i64,
        collections: &[S],
    ) -> Result<(Vec<Note>, i64), Error> {
        let tx = self.conn.transaction()?;
        let notes = if collections.is_empty() {
            Vec::new()
        } else {
            let marks = vec!["?"; collections.len()].join(", ");
            let mut st = tx.prepare_cached(&format!(
                "SELECT {NOTE_COLS} FROM notes WHERE seq > ? AND collection IN ({marks}) ORDER BY seq ASC"
            ))?;
            let args = std::iter::once(rusqlite::types::Value::Integer(since))
                .chain(collections.iter().map(|c| rusqlite::types::Value::Text(c.as_ref().to_string())));
            let rows = st.query_map(rusqlite::params_from_iter(args), row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let seq = global_seq(&tx)?;
        tx.commit()?;
        Ok((notes, seq))
    }

    pub fn get(&mut self, id: &str) -> Result<Option<Note>, Error> {
        let tx = self.conn.transaction()?;
        let n = get_note(&tx, id)?;
        tx.commit()?;
        Ok(n)
    }

    /// Apply a change under the LWW rule. An id stored in a different collection
    /// is refused with `Error::Conflict`.
    pub fn put(&mut self, c: Change) -> Result<PutOutcome, Error> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let stored = get_note(&tx, &c.id)?;
        if let Some(s) = stored.as_ref().filter(|s| s.collection != c.collection) {
            return Err(Error::Conflict(format!(
                "id {:?} already exists in collection {:?}",
                s.id, s.collection
            )));
        }
        if !lww_accepts(stored.as_ref().map(|s| s.updated_at), c.updated_at) {
            // Nothing written; dropping the transaction rolls it back.
            return Ok(PutOutcome { note: stored.expect("rejected implies stored"), accepted: false });
        }
        let seq: i64 = tx.query_row(
            "UPDATE meta SET value = value + 1 WHERE key = 'global_seq' RETURNING value",
            [],
            |r| r.get(0),
        )?;
        let created_at = match &stored {
            Some(s) => s.created_at,
            None => c.created_at.unwrap_or(c.updated_at),
        };
        let note = Note {
            id: c.id,
            body: c.body,
            created_at,
            updated_at: c.updated_at,
            deleted: c.deleted,
            seq,
            device: c.device,
            meta: c.meta,
            collection: c.collection,
        };
        tx.execute(
            "INSERT INTO notes (id, body, created_at, updated_at, deleted, seq, device, meta, collection)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                body = excluded.body, updated_at = excluded.updated_at,
                deleted = excluded.deleted, seq = excluded.seq,
                device = excluded.device, meta = excluded.meta",
            params![
                note.id,
                note.body,
                note.created_at,
                note.updated_at,
                note.deleted as i64,
                note.seq,
                note.device,
                note.meta.to_string(),
                note.collection
            ],
        )?;
        tx.commit()?;
        Ok(PutOutcome { note, accepted: true })
    }

    /// Hard-delete rows (admin use only, e.g. removing test data). Does not touch seq.
    pub fn purge(&mut self, ids: &[String]) -> Result<usize, Error> {
        let tx = self.conn.transaction()?;
        let mut n = 0;
        for id in ids {
            n += tx.execute("DELETE FROM notes WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(n)
    }

    /// Write a consistent, compacted copy of the database to `dest` (must not exist).
    pub fn backup_to(&self, dest: &Path) -> Result<(), Error> {
        let dest =
            dest.to_str().ok_or_else(|| Error::BadRequest("backup path must be valid UTF-8".into()))?;
        self.conn.execute("VACUUM INTO ?1", [dest])?;
        Ok(())
    }
}

/// An image stored by its content: `hash` is the lowercase hex SHA-256 of `data`.
#[derive(Debug, Clone, PartialEq)]
pub struct Blob {
    pub hash: String,
    /// MIME type, from the bytes (see `image_type`).
    pub mime: String,
    pub data: Vec<u8>,
}

/// 64 lowercase hex digits.
pub fn valid_blob_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// The image format of `data` from its first bytes: PNG, JPEG, GIF, WebP or HEIC/HEIF.
/// Anything else isn't stored, so the server only ever serves images.
pub fn image_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.len() >= 12 && &data[4..8] == b"ftyp" {
        match &data[8..12] {
            b"heic" | b"heix" | b"heim" | b"heis" => Some("image/heic"),
            b"mif1" | b"msf1" => Some("image/heif"),
            _ => None,
        }
    } else {
        None
    }
}

/// `bento-image:<hash>` references in a note body (see docs/SYNC_PROTOCOL.md, Images).
pub fn image_refs(body: &str) -> impl Iterator<Item = &str> {
    body.match_indices(IMAGE_SCHEME).filter_map(move |(i, m)| {
        let h = body.get(i + m.len()..i + m.len() + 64)?;
        valid_blob_hash(h).then_some(h)
    })
}

pub const IMAGE_SCHEME: &str = "bento-image:";

impl Store {
    /// Stores an image under the SHA-256 of its bytes, which must equal `hash`. Storing
    /// one that exists is a no-op; returns whether it was new.
    pub fn put_blob(&mut self, hash: &str, data: &[u8], now: i64) -> Result<(Blob, bool), Error> {
        if !valid_blob_hash(hash) {
            return Err(Error::BadRequest("invalid blob hash (64 lowercase hex digits of SHA-256)".into()));
        }
        if data.len() > MAX_BLOB_BYTES {
            return Err(Error::TooLarge(format!("blob exceeds {MAX_BLOB_BYTES} bytes")));
        }
        let mime = image_type(data)
            .ok_or_else(|| Error::Unsupported("not an image (PNG, JPEG, GIF, WebP or HEIC)".into()))?;
        if sha256_hex(data) != hash {
            return Err(Error::BadRequest("blob hash does not match its SHA-256".into()));
        }
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO blobs (hash, type, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, mime, data.len() as i64, data, now],
        )?;
        Ok((Blob { hash: hash.into(), mime: mime.into(), data: data.to_vec() }, n > 0))
    }

    pub fn get_blob(&self, hash: &str) -> Result<Option<Blob>, Error> {
        Ok(self
            .conn
            .query_row("SELECT hash, type, data FROM blobs WHERE hash = ?1", [hash], |r| {
                Ok(Blob { hash: r.get(0)?, mime: r.get(1)?, data: r.get(2)? })
            })
            .optional()?)
    }

    /// Deletes blobs stored before `before` (ms) that no document's body refers to (admin;
    /// trashed notes keep their text, so their images stay). Returns (count, bytes).
    pub fn gc_blobs(&mut self, before: i64) -> Result<(usize, i64), Error> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut used = std::collections::HashSet::new();
        {
            let mut st = tx.prepare("SELECT body FROM notes WHERE deleted = 0 AND instr(body, ?1) > 0")?;
            let mut rows = st.query([IMAGE_SCHEME])?;
            while let Some(r) = rows.next()? {
                let body: String = r.get(0)?;
                used.extend(image_refs(&body).map(str::to_string));
            }
        }
        let old: Vec<(String, i64)> = {
            let mut st = tx.prepare("SELECT hash, size FROM blobs WHERE created_at < ?1")?;
            let rows = st.query_map([before], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let (mut n, mut bytes) = (0, 0);
        for (hash, size) in old.into_iter().filter(|(h, _)| !used.contains(h)) {
            n += tx.execute("DELETE FROM blobs WHERE hash = ?1", [&hash])?;
            bytes += size;
        }
        tx.commit()?;
        Ok((n, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(id: &str, body: &str, updated_at: i64) -> Change {
        NoteIn {
            id: Some(id.into()),
            body: Some(body.into()),
            created_at: Some(updated_at),
            updated_at: Some(updated_at),
            ..Default::default()
        }
        .into_change(None, None, "test")
        .unwrap()
    }

    #[test]
    fn lww_rule() {
        assert!(lww_accepts(None, 0));
        assert!(lww_accepts(Some(100), 101));
        assert!(lww_accepts(Some(100), 100), "ties are accepted");
        assert!(!lww_accepts(Some(100), 99));
    }

    #[test]
    fn seq_strictly_increases_and_rejects_do_not_bump() {
        let mut s = Store::open_in_memory().unwrap();
        assert_eq!(s.latest_seq().unwrap(), 0);
        let a = s.put(change("a", "one", 1000)).unwrap();
        assert!(a.accepted);
        assert_eq!(a.note.seq, 1);
        let b = s.put(change("b", "bee", 5)).unwrap();
        assert_eq!(b.note.seq, 2);
        // Stale put on a: rejected, returns stored, seq unchanged.
        let r = s.put(change("a", "stale", 999)).unwrap();
        assert!(!r.accepted);
        assert_eq!(r.note.body, "one");
        assert_eq!(r.note.seq, 1);
        assert_eq!(s.latest_seq().unwrap(), 2);
        // Tie accepted.
        let t = s.put(change("a", "tie", 1000)).unwrap();
        assert!(t.accepted);
        assert_eq!(t.note.seq, 3);
        assert_eq!(t.note.body, "tie");
        // Newer accepted.
        let n = s.put(change("a", "newer", 2000)).unwrap();
        assert_eq!(n.note.seq, 4);
        assert_eq!(s.latest_seq().unwrap(), 4);
    }

    #[test]
    fn created_at_kept_from_first_version() {
        let mut s = Store::open_in_memory().unwrap();
        s.put(change("a", "v1", 1000)).unwrap();
        let mut c = change("a", "v2", 3000);
        c.created_at = Some(2500);
        let o = s.put(c).unwrap();
        assert_eq!(o.note.created_at, 1000);
        assert_eq!(o.note.updated_at, 3000);
    }

    #[test]
    fn created_at_defaults_to_updated_at() {
        let mut s = Store::open_in_memory().unwrap();
        let mut c = change("a", "v1", 1234);
        c.created_at = None;
        assert_eq!(s.put(c).unwrap().note.created_at, 1234);
    }

    #[test]
    fn tombstone_clears_body_and_is_listed() {
        let mut s = Store::open_in_memory().unwrap();
        s.put(change("a", "text", 1000)).unwrap();
        let del = NoteIn {
            id: Some("a".into()),
            body: Some("ignored".into()),
            updated_at: Some(2000),
            deleted: Some(true),
            ..Default::default()
        }
        .into_change(None, None, "x")
        .unwrap();
        let o = s.put(del).unwrap();
        assert!(o.accepted && o.note.deleted);
        assert_eq!(o.note.body, "");
        let (notes, seq) = s.changes_since(1, &["notes"]).unwrap();
        assert_eq!(seq, 2);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].deleted);
        // A stale un-delete is rejected.
        assert!(!s.put(change("a", "revive", 1500)).unwrap().accepted);
    }

    #[test]
    fn changes_since_is_ascending_and_filtered() {
        let mut s = Store::open_in_memory().unwrap();
        for (i, id) in ["x", "y", "z"].iter().enumerate() {
            s.put(change(id, "b", i as i64)).unwrap();
        }
        s.put(change("x", "b2", 10)).unwrap(); // x moves to seq 4
        let (all, seq) = s.changes_since(0, &["notes"]).unwrap();
        assert_eq!(seq, 4);
        assert_eq!(all.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["y", "z", "x"]);
        assert_eq!(all.iter().map(|n| n.seq).collect::<Vec<_>>(), [2, 3, 4]);
        let (some, _) = s.changes_since(3, &["notes"]).unwrap();
        assert_eq!(some.len(), 1);
        assert_eq!(some[0].id, "x");
        assert!(s.changes_since(4, &["notes"]).unwrap().0.is_empty());
    }

    #[test]
    fn seq_survives_reopen_and_meta_roundtrips() {
        let dir = std::env::temp_dir().join(format!("bento-sync-unit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);
        {
            let mut s = Store::open(&path).unwrap();
            let mut c = change("a", "v", 1);
            c.meta = json!({"pinned": true, "color": "yellow"});
            s.put(c).unwrap();
            s.put(change("b", "v", 1)).unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.latest_seq().unwrap(), 2);
        assert_eq!(s.put(change("c", "v", 1)).unwrap().note.seq, 3);
        assert_eq!(s.get("a").unwrap().unwrap().meta, json!({"pinned": true, "color": "yellow"}));
        let bak = dir.join("bak.db");
        let _ = std::fs::remove_file(&bak);
        s.backup_to(&bak).unwrap();
        let mut b = Store::open(&bak).unwrap();
        assert_eq!(b.changes_since(0, &["notes"]).unwrap().0.len(), 3);
        drop(b);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation() {
        let ok = NoteIn { id: Some("A-1".into()), updated_at: Some(1), ..Default::default() };
        assert_eq!(ok.clone().into_change(None, None, "dev").unwrap().device, "dev");
        assert!(matches!(ok.clone().into_change(Some("B"), None, "d"), Err(Error::BadRequest(_))));
        assert_eq!(ok.clone().into_change(Some("A-1"), None, "d").unwrap().id, "A-1");
        let no_ts = NoteIn { id: Some("a".into()), ..Default::default() };
        assert!(matches!(no_ts.into_change(None, None, "d"), Err(Error::BadRequest(_))));
        let bad_id = NoteIn { id: Some("a/b".into()), updated_at: Some(1), ..Default::default() };
        assert!(matches!(bad_id.into_change(None, None, "d"), Err(Error::BadRequest(_))));
        let big = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            body: Some("x".repeat(MAX_BODY_BYTES + 1)),
            ..Default::default()
        };
        assert!(matches!(big.into_change(None, None, "d"), Err(Error::TooLarge(_))));
        let max = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            body: Some("x".repeat(MAX_BODY_BYTES)),
            ..Default::default()
        };
        assert!(max.into_change(None, None, "d").is_ok());
        let big_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(json!({ "k": "x".repeat(MAX_META_BYTES) })),
            ..Default::default()
        };
        assert!(matches!(big_meta.into_change(None, None, "d"), Err(Error::TooLarge(_))));
        let arr_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(json!([1])),
            ..Default::default()
        };
        assert!(matches!(arr_meta.into_change(None, None, "d"), Err(Error::BadRequest(_))));
        let null_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(Value::Null),
            ..Default::default()
        };
        assert_eq!(null_meta.into_change(None, None, "d").unwrap().meta, json!({}));
    }

    fn doc(collection: &str, id: &str, body: &str, updated_at: i64) -> Change {
        Change { collection: collection.into(), ..change(id, body, updated_at) }
    }

    fn temp_db(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bento-sync-unit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("t.db")
    }

    /// The schema exactly as v1 binaries created it, with two rows.
    const V1_SCHEMA: &str = r#"
        CREATE TABLE IF NOT EXISTS notes (
            id          TEXT PRIMARY KEY NOT NULL,
            body        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            deleted     INTEGER NOT NULL DEFAULT 0,
            seq         INTEGER NOT NULL UNIQUE,
            device      TEXT NOT NULL DEFAULT '',
            meta        TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY NOT NULL,
            value INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO meta (key, value) VALUES ('global_seq', 0);
        INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', 1);
        INSERT INTO notes (id, body, created_at, updated_at, deleted, seq, device, meta)
            VALUES ('a', 'alpha', 10, 10, 0, 1, 'mac', '{"pinned":true}'),
                   ('b', '', 20, 30, 1, 2, 'mac', '{}');
        UPDATE meta SET value = 2 WHERE key = 'global_seq';
    "#;

    #[test]
    fn migrates_v1_db_with_rows() {
        let path = temp_db("migrate");
        // A v1 database, kept open by a "running v1 server" during the migration.
        let v1 = Connection::open(&path).unwrap();
        v1.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0)).unwrap();
        v1.execute_batch(V1_SCHEMA).unwrap();

        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), 3);
        assert_eq!(s.latest_seq().unwrap(), 2);
        let (notes, seq) = s.changes_since(0, &["notes"]).unwrap();
        assert_eq!(seq, 2);
        let got: Vec<_> = notes.iter().map(|n| (n.id.as_str(), n.collection.as_str())).collect();
        assert_eq!(got, [("a", "notes"), ("b", "notes")]);
        assert_eq!(notes[0].meta, json!({"pinned": true}));
        assert!(notes[1].deleted);
        assert!(s.changes_since(0, &["todos"]).unwrap().0.is_empty());
        let idx: i64 = s
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'notes_collection_seq'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
        assert_eq!(s.put(doc("todos", "t", "{}", 5)).unwrap().note.seq, 3);

        // A v1 binary still works on the migrated DB (rollback); its rows land in `notes`.
        v1.execute_batch(
            "UPDATE meta SET value = 4 WHERE key = 'global_seq';
             INSERT INTO notes (id, body, created_at, updated_at, deleted, seq, device, meta)
             VALUES ('old', 'from v1', 1, 1, 0, 4, 'old', '{}');",
        )
        .unwrap();
        drop(v1);
        assert_eq!(s.get("old").unwrap().unwrap().collection, "notes");
        drop(s);

        // Idempotent: reopening changes nothing.
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), 3);
        assert_eq!(s.latest_seq().unwrap(), 4);
        assert_eq!(s.changes_since(0, &["notes", "todos"]).unwrap().0.len(), 4);
        drop(s);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn fresh_db_is_v3() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.schema_version().unwrap(), 3);
    }

    #[test]
    fn collection_validation() {
        for ok in ["notes", "todos", "a", "a-b_c9", &"x".repeat(32)] {
            assert!(valid_collection(ok), "{ok}");
        }
        for bad in ["", "Notes", "1abc", "-a", "_a", "a b", "a.b", "a/b", "é", &"x".repeat(33)] {
            assert!(!valid_collection(bad), "{bad}");
        }
        let n = NoteIn { id: Some("a".into()), updated_at: Some(1), ..Default::default() };
        assert_eq!(n.clone().into_change(None, None, "d").unwrap().collection, "notes");
        assert_eq!(n.clone().into_change(None, Some("todos"), "d").unwrap().collection, "todos");
        let t = NoteIn { collection: Some("todos".into()), ..n.clone() };
        assert_eq!(t.clone().into_change(None, None, "d").unwrap().collection, "todos");
        assert_eq!(t.clone().into_change(Some("a"), Some("todos"), "d").unwrap().collection, "todos");
        assert!(matches!(t.into_change(None, Some("notes"), "d"), Err(Error::BadRequest(_))));
        let bad = NoteIn { collection: Some("To Do".into()), ..n.clone() };
        assert!(matches!(bad.into_change(None, None, "d"), Err(Error::BadRequest(_))));
        let empty = NoteIn { collection: Some(String::new()), ..n.clone() };
        assert!(matches!(empty.into_change(None, None, "d"), Err(Error::BadRequest(_))));
        assert!(matches!(n.into_change(None, Some("BAD"), "d"), Err(Error::BadRequest(_))));
    }

    #[test]
    fn id_conflict_across_collections() {
        let mut s = Store::open_in_memory().unwrap();
        s.put(change("a", "note", 1000)).unwrap();
        // Refused whatever the timestamps say; nothing written, seq unchanged.
        assert!(matches!(s.put(doc("todos", "a", "task", 5000)), Err(Error::Conflict(_))));
        assert!(matches!(s.put(doc("todos", "a", "task", 1)), Err(Error::Conflict(_))));
        let stored = s.get("a").unwrap().unwrap();
        assert_eq!((stored.body.as_str(), stored.collection.as_str(), stored.seq), ("note", "notes", 1));
        assert_eq!(s.latest_seq().unwrap(), 1);
        // Same collection still follows LWW.
        assert!(s.put(change("a", "newer", 2000)).unwrap().accepted);
    }

    #[test]
    fn changes_since_filters_collections() {
        let mut s = Store::open_in_memory().unwrap();
        s.put(change("n1", "a", 1)).unwrap(); // 1
        s.put(doc("todos", "t1", "b", 1)).unwrap(); // 2
        s.put(doc("other", "o1", "c", 1)).unwrap(); // 3
        s.put(change("n2", "d", 1)).unwrap(); // 4
        s.put(doc("todos", "t2", "e", 1)).unwrap(); // 5
        let ids = |s: &mut Store, since, cs: &[&str]| {
            let (v, seq) = s.changes_since(since, cs).unwrap();
            assert_eq!(seq, 5, "latest seq is global");
            v.into_iter().map(|n| n.id).collect::<Vec<_>>()
        };
        assert_eq!(ids(&mut s, 0, &["notes"]), ["n1", "n2"]);
        assert_eq!(ids(&mut s, 0, &["todos"]), ["t1", "t2"]);
        assert_eq!(ids(&mut s, 0, &["todos", "notes"]), ["n1", "t1", "n2", "t2"]);
        assert_eq!(ids(&mut s, 2, &["notes", "todos"]), ["n2", "t2"]);
        assert!(ids(&mut s, 0, &["nope"]).is_empty());
        assert!(ids(&mut s, 0, &[]).is_empty());
        assert_eq!(s.changes_since(0, &["todos"]).unwrap().0[0].collection, "todos");
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR rest";

    #[test]
    fn image_types() {
        assert_eq!(image_type(PNG), Some("image/png"));
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"\0\0\0\x18ftypheic\0\0"), Some("image/heic"));
        assert_eq!(image_type(b"\0\0\0\x18ftypmif1\0\0"), Some("image/heif"));
        assert_eq!(image_type(b"\0\0\0\x18ftypisom\0\0"), None);
        assert_eq!(image_type(b"<html>"), None);
        assert_eq!(image_type(b""), None);
    }

    #[test]
    fn blobs_are_content_addressed() {
        let mut s = Store::open_in_memory().unwrap();
        let h = sha256_hex(PNG);
        assert_eq!(h.len(), 64);
        assert!(s.get_blob(&h).unwrap().is_none());
        let (b, new) = s.put_blob(&h, PNG, 10).unwrap();
        assert!(new);
        assert_eq!((b.mime.as_str(), b.data.as_slice()), ("image/png", PNG));
        assert!(!s.put_blob(&h, PNG, 20).unwrap().1, "storing it again is a no-op");
        assert_eq!(s.get_blob(&h).unwrap().unwrap(), b);
        // blobs don't touch the documents' seq
        assert_eq!(s.latest_seq().unwrap(), 0);

        let wrong = sha256_hex(b"other");
        assert!(matches!(s.put_blob(&wrong, PNG, 1), Err(Error::BadRequest(_))));
        assert!(matches!(s.put_blob(&h.to_uppercase(), PNG, 1), Err(Error::BadRequest(_))));
        assert!(matches!(s.put_blob("abc", PNG, 1), Err(Error::BadRequest(_))));
        let html = b"<html></html>";
        assert!(matches!(s.put_blob(&sha256_hex(html), html, 1), Err(Error::Unsupported(_))));
        let mut big = PNG.to_vec();
        big.resize(MAX_BLOB_BYTES + 1, 0);
        assert!(matches!(s.put_blob(&sha256_hex(&big), &big, 1), Err(Error::TooLarge(_))));
    }

    #[test]
    fn image_refs_in_bodies() {
        let a = "a".repeat(64);
        let b = "0123456789abcdef".repeat(4);
        let body = format!(
            "# T\n![](bento-image:{a})\ntext ![cat](bento-image:{b}) bento-image:short\nbento-image:{}",
            "A".repeat(64)
        );
        assert_eq!(image_refs(&body).collect::<Vec<_>>(), [a.as_str(), b.as_str()]);
        assert_eq!(image_refs("bento-image:").count(), 0);
        assert_eq!(image_refs("é bento-image:ab").count(), 0);
    }

    #[test]
    fn gc_keeps_referenced_and_recent_blobs() {
        let mut s = Store::open_in_memory().unwrap();
        let png = |tag: &str| [PNG, tag.as_bytes()].concat();
        let (used, trashed, gone, recent, deleted) =
            (png("used"), png("trashed"), png("gone"), png("recent"), png("deleted"));
        for (data, at) in [(&used, 1), (&trashed, 1), (&gone, 1), (&recent, 100), (&deleted, 1)] {
            s.put_blob(&sha256_hex(data), data, at).unwrap();
        }
        s.put(change("n1", &format!("x\n![](bento-image:{})", sha256_hex(&used)), 5)).unwrap();
        let mut t = change("n2", &format!("![](bento-image:{})", sha256_hex(&trashed)), 5);
        t.meta = json!({"trashedAt": 5});
        s.put(t).unwrap();
        s.put(change("n3", &format!("![](bento-image:{})", sha256_hex(&deleted)), 5)).unwrap();
        let mut del = change("n3", "", 6);
        del.deleted = true;
        s.put(del).unwrap();
        // a todo mentioning one counts too
        s.put(doc("todos", "t1", &format!("{{\"x\":\"bento-image:{}\"}}", sha256_hex(&used)), 5)).unwrap();

        let (n, bytes) = s.gc_blobs(50).unwrap();
        assert_eq!((n, bytes), (2, (gone.len() + deleted.len()) as i64));
        let kept = |s: &Store, d: &[u8]| s.get_blob(&sha256_hex(d)).unwrap().is_some();
        assert!(kept(&s, &used) && kept(&s, &trashed) && kept(&s, &recent));
        assert!(!kept(&s, &gone) && !kept(&s, &deleted));
        assert_eq!(s.gc_blobs(50).unwrap(), (0, 0));
    }
}
