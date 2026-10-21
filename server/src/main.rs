use bento_sync::store::Store;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
bento-sync — realtime sync server for Bento notes

USAGE:
  bento-sync [serve]                 run the server
  bento-sync backup <dir> [--keep N] write a consistent copy of the DB to <dir>,
                                     keep the newest N backups (default 14)
  bento-sync purge <id>...           hard-delete notes (admin; e.g. test data)
  bento-sync --version

ENV:
  BENTO_SYNC_TOKEN       bearer token (or BENTO_SYNC_TOKEN_FILE=<path>, or the
                         systemd credential $CREDENTIALS_DIRECTORY/token)
  BENTO_SYNC_DB          SQLite path (default ./bento-sync.db)
  BENTO_SYNC_ADDR        listen address (default 127.0.0.1:8787)
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let res = match args.first().map(String::as_str) {
        None | Some("serve") => serve(),
        Some("backup") => backup(&args[1..]),
        Some("purge") => purge(&args[1..]),
        Some("-V" | "--version" | "version") => {
            println!("bento-sync {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("-h" | "--help" | "help") => {
            print!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("unknown command {other:?}\n\n{USAGE}")),
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bento-sync: {e}");
            ExitCode::FAILURE
        }
    }
}

fn db_path() -> PathBuf {
    std::env::var_os("BENTO_SYNC_DB").map(PathBuf::from).unwrap_or_else(|| "bento-sync.db".into())
}

fn load_token() -> Result<String, String> {
    let token = match std::env::var("BENTO_SYNC_TOKEN") {
        Ok(t) if !t.trim().is_empty() => t,
        _ => {
            // BENTO_SYNC_TOKEN_FILE, else a systemd credential named "token"
            // (LoadCredential=token:/etc/bento-sync/token).
            let path = std::env::var_os("BENTO_SYNC_TOKEN_FILE").map(PathBuf::from).or_else(|| {
                std::env::var_os("CREDENTIALS_DIRECTORY").map(|d| PathBuf::from(d).join("token"))
            });
            let Some(p) = path else {
                return Err("set BENTO_SYNC_TOKEN or BENTO_SYNC_TOKEN_FILE".into());
            };
            std::fs::read_to_string(&p).map_err(|e| format!("reading token file {}: {e}", p.display()))?
        }
    };
    let token = token.trim().to_string();
    if token.len() < 16 {
        return Err("token must be at least 16 characters".into());
    }
    if !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("token must be printable ASCII without spaces".into());
    }
    Ok(token)
}

fn open_store(path: &Path) -> Result<Store, String> {
    Store::open(path).map_err(|e| format!("opening {}: {e}", path.display()))
}

fn serve() -> Result<(), String> {
    let token = load_token()?;
    let db = db_path();
    let addr = std::env::var("BENTO_SYNC_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let store = open_store(&db)?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(4)
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(&addr).await.map_err(|e| format!("bind {addr}: {e}"))?;
        bento_sync::log(&format!(
            "bento-sync {} listening on {addr}, db {}",
            env!("CARGO_PKG_VERSION"),
            db.display()
        ));
        bento_sync::serve(listener, store, &token, shutdown_signal()).await.map_err(|e| e.to_string())?;
        bento_sync::log("bento-sync stopped");
        Ok(())
    })
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    bento_sync::log("shutdown signal received");
}

fn backup(args: &[String]) -> Result<(), String> {
    let mut dir: Option<PathBuf> = None;
    let mut keep: usize = 14;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--keep" => {
                keep = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|&k| k >= 1)
                    .ok_or("--keep needs a number >= 1")?;
            }
            d if dir.is_none() => dir = Some(PathBuf::from(d)),
            other => return Err(format!("unexpected argument {other:?}")),
        }
    }
    let dir = dir.ok_or("usage: bento-sync backup <dir> [--keep N]")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let db = db_path();
    if !db.exists() {
        return Err(format!("database {} does not exist", db.display()));
    }
    let store = open_store(&db)?;
    let name = format!("notes-{}.db", utc_stamp(bento_sync::now_ms() / 1000));
    let tmp = dir.join(format!(".{name}.tmp"));
    let dest = dir.join(&name);
    let _ = std::fs::remove_file(&tmp);
    store.backup_to(&tmp).map_err(|e| format!("backup failed: {e}"))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("rename: {e}"))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    println!("backup written: {} ({size} bytes)", dest.display());

    let mut backups: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("notes-") && n.ends_with(".db"))
        })
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    for old in &backups[..excess] {
        match std::fs::remove_file(old) {
            Ok(()) => println!("pruned {}", old.display()),
            Err(e) => eprintln!("could not prune {}: {e}", old.display()),
        }
    }
    Ok(())
}

fn purge(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("usage: bento-sync purge <id>...".into());
    }
    let mut store = open_store(&db_path())?;
    let n = store.purge(ids).map_err(|e| e.to_string())?;
    println!("purged {n} note(s)");
    Ok(())
}

/// `YYYYMMDD-HHMMSS` in UTC for a unix timestamp (no date crate needed).
fn utc_stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_stamp() {
        assert_eq!(super::utc_stamp(0), "19700101-000000");
        assert_eq!(super::utc_stamp(1_761_000_000), "20251020-224000");
        assert_eq!(super::utc_stamp(951_782_400), "20000229-000000");
    }
}
