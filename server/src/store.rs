//! SQLite storage + the last-writer-wins / seq logic.
//!
//! All mutations run inside a transaction. `global_seq` lives in the `meta`
//! table and is bumped by exactly one for every accepted change, so `seq`
//! values are strictly increasing and unique across all notes.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_META_BYTES: usize = 4 * 1024;
pub const MAX_ID_BYTES: usize = 128;
pub const MAX_DEVICE_BYTES: usize = 128;

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
    Internal(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadRequest(m) | Error::TooLarge(m) | Error::Internal(m) => f.write_str(m),
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

impl NoteIn {
    /// Validate a client note. `path_id` is the id from the URL (REST) if any;
    /// `fallback_device` is used when the note carries no device name.
    pub fn into_change(self, path_id: Option<&str>, fallback_device: &str) -> Result<Change, Error> {
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
        Ok(Change { id, body, created_at: self.created_at, updated_at, deleted, device, meta })
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
    meta        TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO meta (key, value) VALUES ('global_seq', 0);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', 1);
";

const NOTE_COLS: &str = "id, body, created_at, updated_at, deleted, seq, device, meta";

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
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    pub fn latest_seq(&self) -> Result<i64, Error> {
        Ok(global_seq(&self.conn)?)
    }

    /// All notes (incl. tombstones) with `seq > since`, ascending, plus the latest seq.
    /// Read in one transaction so the pair is consistent.
    pub fn changes_since(&mut self, since: i64) -> Result<(Vec<Note>, i64), Error> {
        let tx = self.conn.transaction()?;
        let notes = {
            let mut st =
                tx.prepare_cached(&format!("SELECT {NOTE_COLS} FROM notes WHERE seq > ?1 ORDER BY seq ASC"))?;
            let rows = st.query_map([since], row_to_note)?;
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

    /// Apply a change under the LWW rule.
    pub fn put(&mut self, c: Change) -> Result<PutOutcome, Error> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let stored = get_note(&tx, &c.id)?;
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
        };
        tx.execute(
            "INSERT INTO notes (id, body, created_at, updated_at, deleted, seq, device, meta)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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
                note.meta.to_string()
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
        .into_change(None, "test")
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
        .into_change(None, "x")
        .unwrap();
        let o = s.put(del).unwrap();
        assert!(o.accepted && o.note.deleted);
        assert_eq!(o.note.body, "");
        let (notes, seq) = s.changes_since(1).unwrap();
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
        let (all, seq) = s.changes_since(0).unwrap();
        assert_eq!(seq, 4);
        assert_eq!(all.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["y", "z", "x"]);
        assert_eq!(all.iter().map(|n| n.seq).collect::<Vec<_>>(), [2, 3, 4]);
        let (some, _) = s.changes_since(3).unwrap();
        assert_eq!(some.len(), 1);
        assert_eq!(some[0].id, "x");
        assert!(s.changes_since(4).unwrap().0.is_empty());
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
        assert_eq!(b.changes_since(0).unwrap().0.len(), 3);
        drop(b);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation() {
        let ok = NoteIn { id: Some("A-1".into()), updated_at: Some(1), ..Default::default() };
        assert_eq!(ok.clone().into_change(None, "dev").unwrap().device, "dev");
        assert!(matches!(ok.clone().into_change(Some("B"), "d"), Err(Error::BadRequest(_))));
        assert_eq!(ok.clone().into_change(Some("A-1"), "d").unwrap().id, "A-1");
        let no_ts = NoteIn { id: Some("a".into()), ..Default::default() };
        assert!(matches!(no_ts.into_change(None, "d"), Err(Error::BadRequest(_))));
        let bad_id = NoteIn { id: Some("a/b".into()), updated_at: Some(1), ..Default::default() };
        assert!(matches!(bad_id.into_change(None, "d"), Err(Error::BadRequest(_))));
        let big = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            body: Some("x".repeat(MAX_BODY_BYTES + 1)),
            ..Default::default()
        };
        assert!(matches!(big.into_change(None, "d"), Err(Error::TooLarge(_))));
        let max = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            body: Some("x".repeat(MAX_BODY_BYTES)),
            ..Default::default()
        };
        assert!(max.into_change(None, "d").is_ok());
        let big_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(json!({ "k": "x".repeat(MAX_META_BYTES) })),
            ..Default::default()
        };
        assert!(matches!(big_meta.into_change(None, "d"), Err(Error::TooLarge(_))));
        let arr_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(json!([1])),
            ..Default::default()
        };
        assert!(matches!(arr_meta.into_change(None, "d"), Err(Error::BadRequest(_))));
        let null_meta = NoteIn {
            id: Some("a".into()),
            updated_at: Some(1),
            meta: Some(Value::Null),
            ..Default::default()
        };
        assert_eq!(null_meta.into_change(None, "d").unwrap().meta, json!({}));
    }
}
