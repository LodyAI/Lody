#![forbid(unsafe_code)]

use crate::map_sql_err;
use lody_ports::{
    PortError, PortErrorKind, PortResult, PrPollerRepoCooldown, PrPollerScopeBucket,
    PrPollerStorePort, WorkspaceId,
};
use rusqlite::{Connection, ErrorCode, OptionalExtension, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const PR_POLLER_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS scopes (
  scope TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  frozen_until_ms INTEGER
);
CREATE TABLE IF NOT EXISTS repo_cooldowns (
  key TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL,
  next_retry_at_ms INTEGER NOT NULL,
  last_error_kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  key TEXT PRIMARY KEY,
  last_success_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_fingerprints (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);
";

fn open_and_init(path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    let check: String = conn.query_row("PRAGMA quick_check(1);", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some(check),
        ));
    }
    conn.execute_batch(PR_POLLER_SCHEMA_SQL)?;
    Ok(conn)
}

fn is_corrupt_error(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(inner, _)
            if matches!(inner.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

pub struct SqlitePrPollerStore {
    conn: Mutex<Connection>,
}

impl SqlitePrPollerStore {
    pub fn open(db_path: impl AsRef<Path>) -> PortResult<Self> {
        let db_path = db_path.as_ref();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let conn = match open_and_init(db_path) {
            Ok(c) => c,
            Err(err) if is_corrupt_error(&err) => {
                for suffix in ["", "-wal", "-shm"] {
                    let candidate = PathBuf::from(format!("{}{suffix}", db_path.display()));
                    let _ = fs::remove_file(candidate);
                }
                open_and_init(db_path).map_err(map_sql_err)?
            }
            Err(err) => return Err(map_sql_err(err)),
        };
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

impl PrPollerStorePort for SqlitePrPollerStore {
    fn read_scope(&self, scope: &str) -> PortResult<Option<PrPollerScopeBucket>> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.query_row(
            "SELECT tokens, updated_at_ms, frozen_until_ms FROM scopes WHERE scope = ?1",
            params![scope],
            |row| {
                Ok(PrPollerScopeBucket {
                    tokens: row.get(0)?,
                    updated_at_ms: row.get(1)?,
                    frozen_until_ms: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn write_scope(&self, scope: &str, bucket: &PrPollerScopeBucket) -> PortResult<()> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute(
            "INSERT INTO scopes (scope, tokens, updated_at_ms, frozen_until_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope) DO UPDATE SET
               tokens = excluded.tokens,
               updated_at_ms = excluded.updated_at_ms,
               frozen_until_ms = excluded.frozen_until_ms",
            params![
                scope,
                bucket.tokens,
                bucket.updated_at_ms,
                bucket.frozen_until_ms
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn read_repo_cooldown(&self, key: &str) -> PortResult<Option<PrPollerRepoCooldown>> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.query_row(
            "SELECT consecutive_failures, next_retry_at_ms, last_error_kind
             FROM repo_cooldowns WHERE key = ?1",
            params![key],
            |row| {
                Ok(PrPollerRepoCooldown {
                    consecutive_failures: row.get::<_, i64>(0)?.max(0) as u32,
                    next_retry_at_ms: row.get(1)?,
                    last_error_kind: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn write_repo_cooldown(&self, key: &str, cooldown: &PrPollerRepoCooldown) -> PortResult<()> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute(
            "INSERT INTO repo_cooldowns (key, consecutive_failures, next_retry_at_ms, last_error_kind)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET
               consecutive_failures = excluded.consecutive_failures,
               next_retry_at_ms = excluded.next_retry_at_ms,
               last_error_kind = excluded.last_error_kind",
            params![
                key,
                i64::from(cooldown.consecutive_failures),
                cooldown.next_retry_at_ms,
                &cooldown.last_error_kind,
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn clear_repo_cooldown(&self, key: &str) -> PortResult<()> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute("DELETE FROM repo_cooldowns WHERE key = ?1", params![key])
            .map_err(map_sql_err)?;
        Ok(())
    }

    fn read_target_last_success(&self, key: &str) -> PortResult<Option<i64>> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.query_row(
            "SELECT last_success_at_ms FROM targets WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn write_target_last_success(&self, key: &str, at_ms: i64) -> PortResult<()> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute(
            "INSERT INTO targets (key, last_success_at_ms)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET last_success_at_ms = excluded.last_success_at_ms",
            params![key, at_ms],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn read_discovery_fingerprint(&self, key: &str) -> PortResult<Option<String>> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.query_row(
            "SELECT fingerprint FROM discovery_fingerprints WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn write_discovery_fingerprint(&self, key: &str, fingerprint: &str) -> PortResult<()> {
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute(
            "INSERT INTO discovery_fingerprints (key, fingerprint)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint",
            params![key, fingerprint],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn clear_workspace_state(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let prefix = format!("{}:%", workspace_id.0);
        let conn = self.conn.lock().expect("pr poller sqlite lock");
        conn.execute("DELETE FROM targets WHERE key LIKE ?1", params![&prefix])
            .map_err(map_sql_err)?;
        conn.execute(
            "DELETE FROM discovery_fingerprints WHERE key LIKE ?1",
            params![&prefix],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }
}
