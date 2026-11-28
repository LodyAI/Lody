#![forbid(unsafe_code)]

use crate::{SqliteDataLayout, map_sql_err, sha256_hex};
use lody_ports::{
    AutomationActivityCursor, AutomationActivityPage, AutomationMatchResult,
    AutomationReceiptPatch, AutomationReceiptRecord, AutomationReceiptState,
    AutomationRegistrationInput, AutomationRunExit, AutomationRunInput, AutomationStorePort,
    AutomationWaitCompletion, AutomationWaitRecord, AutomationWaitState, AutomationWorkspaceScope,
    PortError, PortErrorKind, PortResult, SessionId, TurnId, UserId,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const AUTOMATION_SCHEMA_VERSION: i32 = 4;

const BASE_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  type TEXT,
  source TEXT,
  subject TEXT,
  session_id TEXT,
  project_id TEXT,
  work_id TEXT,
  observed_at INTEGER
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  rule_id TEXT,
  owner_user_id TEXT,
  scope_session_id TEXT,
  event_source TEXT,
  event_id TEXT,
  event_work_id TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  scope_session_id TEXT,
  owner_user_id TEXT,
  rule_id TEXT,
  action_kind TEXT,
  event_type TEXT,
  event_source TEXT,
  event_id TEXT,
  correlation_key TEXT,
  policy TEXT,
  work_id TEXT,
  retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS capacity (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  session_id TEXT,
  owner_user_id TEXT,
  state TEXT,
  turn_id TEXT,
  invocation_id TEXT,
  updated_at INTEGER,
  binding_id TEXT,
  fingerprint TEXT,
  model_id TEXT
);
CREATE TABLE IF NOT EXISTS waits (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  next_check_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  owner_user_id TEXT,
  invocation_id TEXT,
  created_at INTEGER,
  due_at INTEGER,
  run_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS turn_observations (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  session_id TEXT,
  observed_at INTEGER
);
CREATE TABLE IF NOT EXISTS wait_reads (
  wait_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  PRIMARY KEY (wait_id, resource)
);
";

const SCHEMA_INDEXES_SQL: &str = "
CREATE INDEX IF NOT EXISTS turn_observations_due ON turn_observations(retry_at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, observed_at);
CREATE INDEX IF NOT EXISTS events_work ON events(work_id);
DROP INDEX IF EXISTS receipts_due;
CREATE INDEX IF NOT EXISTS receipts_due_active ON receipts(retry_at)
  WHERE state IN ('accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling');
CREATE INDEX IF NOT EXISTS receipts_updated ON receipts(updated_at);
DROP INDEX IF EXISTS receipts_delivery;
DROP INDEX IF EXISTS deliveries_state;
CREATE INDEX IF NOT EXISTS receipts_rule ON receipts(rule_id);
CREATE INDEX IF NOT EXISTS receipts_invocation ON receipts(rule_id, action_kind, correlation_key);
CREATE INDEX IF NOT EXISTS receipts_session ON receipts(session_id);
CREATE INDEX IF NOT EXISTS receipts_event ON receipts(event_source, event_id);
CREATE INDEX IF NOT EXISTS receipts_capacity ON receipts(event_type, policy, state);
CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(owner_user_id);
CREATE INDEX IF NOT EXISTS waits_due_at ON waits(state, due_at);
CREATE INDEX IF NOT EXISTS waits_owner ON waits(owner_user_id, session_id);
CREATE INDEX IF NOT EXISTS waits_session ON waits(session_id);
CREATE INDEX IF NOT EXISTS waits_run ON waits(state, run_pending);
CREATE INDEX IF NOT EXISTS wait_reads_resource ON wait_reads(resource, wait_id);
CREATE INDEX IF NOT EXISTS work_session ON work(session_id, state);
CREATE INDEX IF NOT EXISTS work_owner ON work(owner_user_id);
CREATE INDEX IF NOT EXISTS work_binding ON work(binding_id);
CREATE INDEX IF NOT EXISTS receipts_work ON receipts(work_id);
CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(event_source, event_id);
CREATE INDEX IF NOT EXISTS deliveries_work ON deliveries(event_work_id, rule_id);
CREATE INDEX IF NOT EXISTS deliveries_owner ON deliveries(owner_user_id);
CREATE INDEX IF NOT EXISTS turn_observations_owner ON turn_observations(user_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_session_updated ON deliveries(scope_session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_due ON receipts(retry_at, updated_at, id)
  WHERE state IN ('accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling');
CREATE INDEX IF NOT EXISTS idx_receipts_session_updated ON receipts(session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_owner_updated ON receipts(owner_user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_waits_session_created ON waits(session_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_waits_owner_created ON waits(owner_user_id, created_at DESC, id DESC);
";

pub fn automation_identity_json(parts: &[Value]) -> String {
    let serialized = serde_json::to_string(parts).unwrap_or_else(|_| "[]".to_string());
    sha256_hex(&serialized)
}

pub fn automation_workspace_storage_key(machine_id: &str, workspace_id: &str) -> String {
    automation_identity_json(&[json!(machine_id), json!(workspace_id)])
}

fn deterministic_uuid_v8(parts: &[Value]) -> String {
    let digest = automation_identity_json(parts);
    let mut chars: Vec<char> = digest.chars().take(32).collect();
    chars[12] = '8';
    let variant = chars[16].to_digit(16).unwrap_or(0);
    chars[16] = char::from_digit((variant & 0x3) | 0x8, 16).unwrap_or('8');
    let hex: String = chars.into_iter().collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn ensure_private_dir(dir: &Path) -> PortResult<()> {
    fs::create_dir_all(dir)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn restrict_private_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

fn table_has_column(tx: &Transaction<'_>, table: &str, column: &str) -> PortResult<bool> {
    let mut stmt = tx
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(map_sql_err)?;
    let mut rows = stmt.query([]).map_err(map_sql_err)?;
    while let Some(row) = rows.next().map_err(map_sql_err)? {
        let name: String = row.get(1).map_err(map_sql_err)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_column(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    definition: &str,
) -> PortResult<()> {
    if !table_has_column(tx, table, column)? {
        tx.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))
        .map_err(map_sql_err)?;
    }
    Ok(())
}

fn migrate_if_needed(conn: &mut Connection) -> PortResult<()> {
    let version: i32 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(map_sql_err)?;
    if version > AUTOMATION_SCHEMA_VERSION {
        return Err(PortError::new(
            PortErrorKind::Conflict,
            format!("AUTOMATION_DATABASE_VERSION_UNSUPPORTED:{version}"),
        ));
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sql_err)?;
    tx.execute_batch(BASE_SCHEMA_SQL).map_err(map_sql_err)?;
    if version > 0 && version < AUTOMATION_SCHEMA_VERSION {
        ensure_column(&tx, "events", "type", "TEXT")?;
        ensure_column(&tx, "events", "source", "TEXT")?;
        ensure_column(&tx, "events", "subject", "TEXT")?;
        ensure_column(&tx, "events", "session_id", "TEXT")?;
        ensure_column(&tx, "events", "project_id", "TEXT")?;
        ensure_column(&tx, "events", "work_id", "TEXT")?;
        ensure_column(&tx, "events", "observed_at", "INTEGER")?;

        ensure_column(&tx, "deliveries", "rule_id", "TEXT")?;
        ensure_column(&tx, "deliveries", "owner_user_id", "TEXT")?;
        ensure_column(&tx, "deliveries", "scope_session_id", "TEXT")?;
        ensure_column(&tx, "deliveries", "event_source", "TEXT")?;
        ensure_column(&tx, "deliveries", "event_id", "TEXT")?;
        ensure_column(&tx, "deliveries", "event_work_id", "TEXT")?;
        ensure_column(&tx, "deliveries", "updated_at", "INTEGER")?;

        ensure_column(&tx, "receipts", "session_id", "TEXT")?;
        ensure_column(&tx, "receipts", "scope_session_id", "TEXT")?;
        ensure_column(&tx, "receipts", "owner_user_id", "TEXT")?;
        ensure_column(&tx, "receipts", "rule_id", "TEXT")?;
        ensure_column(&tx, "receipts", "action_kind", "TEXT")?;
        ensure_column(&tx, "receipts", "event_type", "TEXT")?;
        ensure_column(&tx, "receipts", "event_source", "TEXT")?;
        ensure_column(&tx, "receipts", "event_id", "TEXT")?;
        ensure_column(&tx, "receipts", "correlation_key", "TEXT")?;
        ensure_column(&tx, "receipts", "policy", "TEXT")?;
        ensure_column(&tx, "receipts", "work_id", "TEXT")?;
        ensure_column(&tx, "receipts", "retry_at", "INTEGER NOT NULL DEFAULT 0")?;

        ensure_column(&tx, "work", "session_id", "TEXT")?;
        ensure_column(&tx, "work", "owner_user_id", "TEXT")?;
        ensure_column(&tx, "work", "state", "TEXT")?;
        ensure_column(&tx, "work", "turn_id", "TEXT")?;
        ensure_column(&tx, "work", "invocation_id", "TEXT")?;
        ensure_column(&tx, "work", "updated_at", "INTEGER")?;
        ensure_column(&tx, "work", "binding_id", "TEXT")?;
        ensure_column(&tx, "work", "fingerprint", "TEXT")?;
        ensure_column(&tx, "work", "model_id", "TEXT")?;

        ensure_column(&tx, "waits", "session_id", "TEXT")?;
        ensure_column(&tx, "waits", "owner_user_id", "TEXT")?;
        ensure_column(&tx, "waits", "invocation_id", "TEXT")?;
        ensure_column(&tx, "waits", "created_at", "INTEGER")?;
        ensure_column(&tx, "waits", "due_at", "INTEGER")?;
        ensure_column(&tx, "waits", "run_pending", "INTEGER NOT NULL DEFAULT 0")?;

        ensure_column(
            &tx,
            "turn_observations",
            "retry_at",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&tx, "turn_observations", "user_id", "TEXT")?;
        ensure_column(&tx, "turn_observations", "session_id", "TEXT")?;
        ensure_column(&tx, "turn_observations", "observed_at", "INTEGER")?;

        tx.execute_batch("DROP INDEX IF EXISTS waits_due;")
            .map_err(map_sql_err)?;
        backfill_legacy_query_columns(&tx)?;
    }
    tx.execute_batch(SCHEMA_INDEXES_SQL).map_err(map_sql_err)?;
    tx.execute_batch(&format!(
        "PRAGMA user_version = {AUTOMATION_SCHEMA_VERSION};"
    ))
    .map_err(map_sql_err)?;
    tx.commit().map_err(map_sql_err)?;
    Ok(())
}

fn backfill_legacy_query_columns(tx: &Transaction<'_>) -> PortResult<()> {
    let mut after = 0i64;
    loop {
        let batch: Vec<(i64, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, payload FROM events WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, payload) in &batch {
            after = *rowid;
            if let Ok(ev) = serde_json::from_str::<Value>(payload) {
                tx.execute(
                    "UPDATE events SET type = ?1, source = ?2, subject = ?3, session_id = ?4, project_id = ?5, work_id = ?6, observed_at = ?7 WHERE sequence = ?8",
                    params![
                        ev.get("type").and_then(Value::as_str),
                        ev.get("source").and_then(Value::as_str),
                        ev.get("subject").and_then(Value::as_str),
                        ev.pointer("/scope/sessionId").and_then(Value::as_str),
                        ev.pointer("/scope/projectId").and_then(Value::as_str),
                        ev.pointer("/data/workId").and_then(Value::as_str),
                        ev.get("observedAt").and_then(Value::as_i64),
                        rowid,
                    ],
                )
                .map_err(map_sql_err)?;
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    after = 0;
    loop {
        let batch: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, id, payload FROM receipts WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, id, payload) in &batch {
            after = *rowid;
            if let Ok(rcpt) = serde_json::from_str::<Value>(payload) {
                let sid = rcpt.get("sessionId").and_then(Value::as_str);
                let scope_sid = rcpt
                    .pointer("/rule/scope/sessionId")
                    .and_then(Value::as_str)
                    .or(sid);
                let corr = rcpt
                    .pointer("/event/correlationId")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        rcpt.pointer("/intent/correlationKey")
                            .and_then(Value::as_str)
                    })
                    .or_else(|| rcpt.get("deliveryId").and_then(Value::as_str));
                let policy = if rcpt.pointer("/rule/handler/kind").and_then(Value::as_str)
                    == Some("policy")
                {
                    rcpt.pointer("/rule/handler/policy").and_then(Value::as_str)
                } else {
                    None
                };
                tx.execute(
                    "UPDATE receipts SET session_id = ?1, scope_session_id = ?2, owner_user_id = ?3, rule_id = ?4, action_kind = ?5, event_type = ?6, event_source = ?7, event_id = ?8, correlation_key = ?9, policy = ?10, work_id = ?11, retry_at = ?12 WHERE id = ?13",
                    params![
                        sid,
                        scope_sid,
                        rcpt.pointer("/rule/ownerUserId").and_then(Value::as_str),
                        rcpt.pointer("/rule/id").and_then(Value::as_str),
                        rcpt.pointer("/intent/action/kind").and_then(Value::as_str),
                        rcpt.pointer("/event/type").and_then(Value::as_str),
                        rcpt.pointer("/event/source").and_then(Value::as_str),
                        rcpt.pointer("/event/id").and_then(Value::as_str),
                        corr,
                        policy,
                        rcpt.pointer("/event/data/workId").and_then(Value::as_str),
                        rcpt.get("retryAt").and_then(Value::as_i64).unwrap_or(0),
                        id,
                    ],
                )
                .map_err(map_sql_err)?;
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    after = 0;
    loop {
        let batch: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, id, payload FROM waits WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, id, payload) in &batch {
            after = *rowid;
            if let Ok(w) = serde_json::from_str::<Value>(payload) {
                let next_check = w.get("nextCheckAt").and_then(Value::as_i64).unwrap_or(0);
                let due_at = w
                    .get("expiresAt")
                    .and_then(Value::as_i64)
                    .map_or(next_check, |exp| next_check.min(exp));
                let run_pending = i64::from(w.get("run").is_some_and(|r| {
                    r.get("startedAt").is_some()
                        && !r.get("startedAt").unwrap().is_null()
                        && r.get("exit").is_none_or(Value::is_null)
                }));
                tx.execute(
                    "UPDATE waits SET session_id = ?1, owner_user_id = ?2, invocation_id = ?3, created_at = ?4, due_at = ?5, run_pending = ?6 WHERE id = ?7",
                    params![
                        w.get("sessionId").and_then(Value::as_str),
                        w.get("ownerUserId").and_then(Value::as_str),
                        w.get("invocationId").and_then(Value::as_str),
                        w.get("createdAt").and_then(Value::as_i64),
                        due_at,
                        run_pending,
                        id,
                    ],
                )
                .map_err(map_sql_err)?;
                if let Some(reads) = w.get("reads").and_then(Value::as_array) {
                    for res in reads.iter().filter_map(Value::as_str) {
                        tx.execute(
                            "INSERT OR IGNORE INTO wait_reads (wait_id, resource) VALUES (?1, ?2)",
                            params![id, res],
                        )
                        .map_err(map_sql_err)?;
                    }
                }
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    after = 0;
    loop {
        let batch: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, id, payload FROM work WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, id, payload) in &batch {
            after = *rowid;
            if let Ok(wk) = serde_json::from_str::<Value>(payload) {
                tx.execute(
                    "UPDATE work SET session_id = ?1, owner_user_id = ?2, state = ?3, turn_id = ?4, invocation_id = ?5, updated_at = ?6, binding_id = ?7, fingerprint = ?8, model_id = ?9 WHERE id = ?10",
                    params![
                        wk.get("sessionId").and_then(Value::as_str),
                        wk.get("ownerUserId").and_then(Value::as_str),
                        wk.get("state").and_then(Value::as_str),
                        wk.get("turnId").and_then(Value::as_str),
                        wk.get("invocationId").and_then(Value::as_str),
                        wk.get("updatedAt").and_then(Value::as_i64),
                        wk.get("bindingId").and_then(Value::as_str),
                        wk.get("fingerprint").and_then(Value::as_str),
                        wk.get("modelId").and_then(Value::as_str),
                        id,
                    ],
                )
                .map_err(map_sql_err)?;
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    after = 0;
    loop {
        let batch: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, id, payload FROM deliveries WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, id, payload) in &batch {
            after = *rowid;
            if let Ok(del) = serde_json::from_str::<Value>(payload) {
                tx.execute(
                    "UPDATE deliveries SET rule_id = ?1, owner_user_id = ?2, scope_session_id = ?3, event_source = ?4, event_id = ?5, event_work_id = ?6, updated_at = ?7 WHERE id = ?8",
                    params![
                        del.pointer("/rule/id").and_then(Value::as_str),
                        del.pointer("/rule/ownerUserId").and_then(Value::as_str),
                        del.pointer("/rule/scope/sessionId").and_then(Value::as_str),
                        del.pointer("/event/source").and_then(Value::as_str),
                        del.pointer("/event/id").and_then(Value::as_str),
                        del.pointer("/event/data/workId").and_then(Value::as_str),
                        del.get("updatedAt").and_then(Value::as_i64),
                        id,
                    ],
                )
                .map_err(map_sql_err)?;
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    after = 0;
    loop {
        let batch: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT rowid, id, payload FROM turn_observations WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 512")
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, id, payload) in &batch {
            after = *rowid;
            if let Ok(obs) = serde_json::from_str::<Value>(payload) {
                tx.execute(
                    "UPDATE turn_observations SET user_id = ?1, session_id = ?2, observed_at = ?3 WHERE id = ?4",
                    params![
                        obs.get("userId").and_then(Value::as_str),
                        obs.get("sessionId").and_then(Value::as_str),
                        obs.get("observedAt").and_then(Value::as_i64),
                        id,
                    ],
                )
                .map_err(map_sql_err)?;
            }
        }
        if batch.len() < 512 {
            break;
        }
    }

    Ok(())
}

fn wait_due_at(wait: &AutomationWaitRecord) -> i64 {
    match wait.expires_at {
        Some(exp) => wait.next_check_at.min(exp),
        None => wait.next_check_at,
    }
}

fn wait_run_pending(wait: &AutomationWaitRecord) -> i64 {
    let started_without_exit = wait
        .run
        .as_ref()
        .is_some_and(|r| r.started_at.is_some() && r.exit.is_none());
    i64::from(started_without_exit)
}

fn write_wait_tx(tx: &Transaction<'_>, wait: &AutomationWaitRecord) -> PortResult<()> {
    let payload = serde_json::to_string(wait)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
    tx.execute(
        "INSERT OR REPLACE INTO waits
         (id, state, next_check_at, payload, session_id, owner_user_id, invocation_id, created_at, due_at, run_pending)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &wait.id,
            wait.state.as_wire_str(),
            wait.next_check_at,
            payload,
            &wait.session_id.0,
            &wait.owner_user_id.0,
            wait.invocation_id.as_deref(),
            wait.created_at,
            wait_due_at(wait),
            wait_run_pending(wait),
        ],
    )
    .map_err(map_sql_err)?;
    tx.execute(
        "DELETE FROM wait_reads WHERE wait_id = ?1",
        params![&wait.id],
    )
    .map_err(map_sql_err)?;
    if let Some(reads) = &wait.reads {
        for resource in reads {
            tx.execute(
                "INSERT OR IGNORE INTO wait_reads (wait_id, resource) VALUES (?1, ?2)",
                params![&wait.id, resource],
            )
            .map_err(map_sql_err)?;
        }
    }
    Ok(())
}

fn read_wait_tx(tx: &Transaction<'_>, wait_id: &str) -> PortResult<Option<AutomationWaitRecord>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT payload FROM waits WHERE id = ?1",
            params![wait_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sql_err)?;
    raw.map(|s| {
        serde_json::from_str::<AutomationWaitRecord>(&s)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
    })
    .transpose()
}

fn write_receipt_tx(tx: &Transaction<'_>, receipt: &AutomationReceiptRecord) -> PortResult<()> {
    let payload = serde_json::to_string(receipt)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
    let scope_session_id = receipt
        .rule
        .pointer("/scope/sessionId")
        .and_then(Value::as_str);
    let owner_user_id = receipt.rule.get("ownerUserId").and_then(Value::as_str);
    let rule_id = receipt.rule.get("id").and_then(Value::as_str);
    let action_kind = receipt
        .intent
        .pointer("/action/kind")
        .and_then(Value::as_str);
    let event_type = receipt.event.get("type").and_then(Value::as_str);
    let event_source = receipt.event.get("source").and_then(Value::as_str);
    let event_id = receipt.event.get("id").and_then(Value::as_str);
    let correlation_key = receipt.intent.get("correlationKey").and_then(Value::as_str);
    let policy = receipt
        .rule
        .pointer("/handler/policy")
        .and_then(Value::as_str);
    let work_id = receipt
        .event
        .pointer("/data/workId")
        .and_then(Value::as_str);

    tx.execute(
        "INSERT OR REPLACE INTO receipts
         (id, delivery_id, state, updated_at, payload, session_id, scope_session_id,
          owner_user_id, rule_id, action_kind, event_type, event_source, event_id,
          correlation_key, policy, work_id, retry_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            &receipt.id,
            &receipt.delivery_id,
            receipt.state.as_wire_str(),
            receipt.updated_at,
            payload,
            receipt.session_id.as_ref().map(|s| s.0.as_str()),
            scope_session_id,
            owner_user_id,
            rule_id,
            action_kind,
            event_type,
            event_source,
            event_id,
            correlation_key,
            policy,
            work_id,
            receipt.retry_at.unwrap_or(0),
        ],
    )
    .map_err(map_sql_err)?;
    Ok(())
}

pub struct SqliteAutomationStore {
    layout: SqliteDataLayout,
    connections: Mutex<BTreeMap<String, Arc<Mutex<Connection>>>>,
}

impl SqliteAutomationStore {
    pub fn new(layout: SqliteDataLayout) -> Self {
        Self {
            layout,
            connections: Mutex::new(BTreeMap::new()),
        }
    }

    fn connection_for(
        &self,
        scope: &AutomationWorkspaceScope,
    ) -> PortResult<Arc<Mutex<Connection>>> {
        let storage_key =
            automation_workspace_storage_key(&scope.machine_id.0, &scope.workspace_id.0);
        let mut map = self
            .connections
            .lock()
            .expect("automation connections lock");
        if let Some(existing) = map.get(&storage_key) {
            return Ok(Arc::clone(existing));
        }
        let db_path = self.layout.automation_workspace_db(&storage_key);
        if let Some(parent) = db_path.parent() {
            ensure_private_dir(parent)?;
        }
        let mut conn = Connection::open(&db_path).map_err(map_sql_err)?;
        restrict_private_file(&db_path);
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(map_sql_err)?;
        migrate_if_needed(&mut conn)?;
        let handle = Arc::new(Mutex::new(conn));
        map.insert(storage_key, Arc::clone(&handle));
        Ok(handle)
    }

    fn allocate_wait_id(
        tx: &Transaction<'_>,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        now_ms: i64,
    ) -> PortResult<String> {
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM waits", [], |row| row.get(0))
            .map_err(map_sql_err)?;
        for salt in 0..1024 {
            let candidate = format!(
                "wait_{}",
                &automation_identity_json(&[
                    json!(&scope.machine_id.0),
                    json!(&scope.workspace_id.0),
                    json!(&session_id.0),
                    json!(now_ms),
                    json!(count + salt)
                ])[..24]
            );
            let exists: Option<i32> = tx
                .query_row(
                    "SELECT 1 FROM waits WHERE id = ?1 LIMIT 1",
                    params![&candidate],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_err)?;
            if exists.is_none() {
                return Ok(candidate);
            }
        }
        Err(PortError::new(
            PortErrorKind::Conflict,
            "failed to allocate unique wait id",
        ))
    }
}

impl AutomationStorePort for SqliteAutomationStore {
    fn workspace_run_logs_dir(&self, scope: &AutomationWorkspaceScope) -> PathBuf {
        self.layout
            .automation_run_logs_dir(&scope.machine_id.0, &scope.workspace_id.0)
    }

    fn register_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        owner_user_id: &UserId,
        input: &AutomationRegistrationInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let normalized_interval = input.interval_ms.max(1_000);
        let existing_payloads: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT payload FROM waits
                     WHERE owner_user_id = ?1 AND session_id = ?2
                     ORDER BY created_at DESC, id ASC",
                )
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![&owner_user_id.0, &session_id.0], |r| r.get(0))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        for raw in existing_payloads {
            let candidate: AutomationWaitRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            if !matches!(
                candidate.state,
                AutomationWaitState::Waiting
                    | AutomationWaitState::Checking
                    | AutomationWaitState::Matched
            ) {
                continue;
            }
            let receipt_terminal = if let Some(inv_id) = &candidate.invocation_id {
                let rcpt_state: Option<String> = tx
                    .query_row(
                        "SELECT state FROM receipts WHERE id = ?1",
                        params![inv_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(map_sql_err)?;
                matches!(
                    rcpt_state.as_deref(),
                    Some(
                        "completed" | "cancelled" | "dropped" | "failed" | "settled" | "superseded"
                    )
                )
            } else {
                false
            };
            if !receipt_terminal
                && candidate.program.as_deref() == Some(input.program.as_str())
                && candidate.interval_ms == normalized_interval
                && candidate.expires_at == input.expires_at
                && candidate.reason == input.reason
            {
                return Ok(candidate);
            }
        }

        let id = Self::allocate_wait_id(&tx, scope, session_id, now_ms)?;
        let wait = AutomationWaitRecord {
            id,
            session_id: session_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            owner_user_id: owner_user_id.clone(),
            owner_machine_id: scope.machine_id.clone(),
            program: Some(input.program.clone()),
            run: None,
            reason: input.reason.clone(),
            interval_ms: normalized_interval,
            expires_at: input.expires_at,
            created_at: now_ms,
            updated_at: now_ms,
            next_check_at: now_ms,
            checks: 0,
            consecutive_errors: 0,
            state: AutomationWaitState::Waiting,
            last_error: None,
            result: None,
            invocation_id: None,
            reads: None,
            evidence: None,
        };
        write_wait_tx(&tx, &wait)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(wait)
    }

    fn register_run(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        owner_user_id: &UserId,
        input: &AutomationRunInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        let logs_dir = self.workspace_run_logs_dir(scope);
        ensure_private_dir(&logs_dir)?;
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let existing_payloads: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT payload FROM waits
                     WHERE owner_user_id = ?1 AND session_id = ?2
                     ORDER BY created_at DESC, id ASC",
                )
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![&owner_user_id.0, &session_id.0], |r| r.get(0))
                .map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        for raw in existing_payloads {
            let candidate: AutomationWaitRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            if matches!(
                candidate.state,
                AutomationWaitState::Waiting | AutomationWaitState::Checking
            ) && let Some(existing_run) = &candidate.run
                && existing_run.exit.is_none()
                && existing_run.command == input.command
                && existing_run.args == input.args
                && existing_run.cwd == input.cwd
                && existing_run.env == input.env
            {
                return Ok(candidate);
            }
        }

        let id = Self::allocate_wait_id(&tx, scope, session_id, now_ms)?;
        let log_path = logs_dir.join(format!("{id}.log"));
        let default_reason = {
            let mut joined = input.command.clone();
            for arg in &input.args {
                joined.push(' ');
                joined.push_str(arg);
            }
            joined.chars().take(2_000).collect::<String>()
        };
        let wait = AutomationWaitRecord {
            id,
            session_id: session_id.clone(),
            workspace_id: scope.workspace_id.clone(),
            owner_user_id: owner_user_id.clone(),
            owner_machine_id: scope.machine_id.clone(),
            program: None,
            run: Some(lody_ports::AutomationManagedRun {
                command: input.command.clone(),
                args: input.args.clone(),
                cwd: input.cwd.clone(),
                env: input.env.clone(),
                log_path: log_path.to_string_lossy().to_string(),
                started_at: None,
                pid: None,
                exit: None,
            }),
            reason: Some(input.reason.clone().unwrap_or(default_reason)),
            interval_ms: 60_000,
            expires_at: None,
            created_at: now_ms,
            updated_at: now_ms,
            next_check_at: now_ms,
            checks: 0,
            consecutive_errors: 0,
            state: AutomationWaitState::Waiting,
            last_error: None,
            result: None,
            invocation_id: None,
            reads: None,
            evidence: None,
        };
        write_wait_tx(&tx, &wait)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(wait)
    }

    fn get_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload FROM waits WHERE id = ?1",
                params![wait_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        raw.map(|s| {
            serde_json::from_str::<AutomationWaitRecord>(&s)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        })
        .transpose()
    }

    fn list_waits(
        &self,
        scope: &AutomationWorkspaceScope,
        owner_user_id: Option<&UserId>,
        session_id: Option<&SessionId>,
    ) -> PortResult<Vec<AutomationWaitRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let payloads: Vec<String> = match (owner_user_id, session_id) {
            (Some(owner), Some(sid)) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT payload FROM waits
                         WHERE owner_user_id = ?1 AND session_id = ?2
                         ORDER BY created_at DESC, id DESC",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&owner.0, &sid.0], |r| r.get(0))
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (Some(owner), None) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT payload FROM waits
                         WHERE owner_user_id = ?1
                         ORDER BY created_at DESC, id DESC",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&owner.0], |r| r.get(0))
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (None, Some(sid)) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT payload FROM waits
                         WHERE session_id = ?1
                         ORDER BY created_at DESC, id DESC",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&sid.0], |r| r.get(0))
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (None, None) => {
                let mut stmt = conn
                    .prepare("SELECT payload FROM waits ORDER BY created_at DESC, id DESC")
                    .map_err(map_sql_err)?;
                let rows = stmt.query_map([], |r| r.get(0)).map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
        };
        let mut out = Vec::with_capacity(payloads.len());
        for raw in payloads {
            out.push(
                serde_json::from_str(&raw)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?,
            );
        }
        Ok(out)
    }

    fn due_waits(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
        limit: usize,
    ) -> PortResult<Vec<AutomationWaitRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let mut stmt = conn
            .prepare(
                "SELECT payload FROM waits
                 WHERE state IN ('waiting', 'checking') AND due_at IS NOT NULL AND due_at <= ?1
                 ORDER BY due_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![now_ms, limit.min(256) as i64], |r| {
                r.get::<_, String>(0)
            })
            .map_err(map_sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(map_sql_err)?;
            out.push(
                serde_json::from_str(&raw)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?,
            );
        }
        Ok(out)
    }

    fn claim_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let Some(mut wait) = read_wait_tx(&tx, wait_id)? else {
            return Ok(None);
        };
        if !matches!(
            wait.state,
            AutomationWaitState::Waiting | AutomationWaitState::Checking
        ) {
            return Ok(None);
        }
        wait.state = AutomationWaitState::Checking;
        wait.checks = wait.checks.saturating_add(1);
        wait.evidence = Some(Vec::new());
        wait.updated_at = now_ms;
        write_wait_tx(&tx, &wait)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(Some(wait))
    }

    fn claim_run_start(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<bool> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let Some(mut wait) = read_wait_tx(&tx, wait_id)? else {
            return Ok(false);
        };
        if wait.state != AutomationWaitState::Checking {
            return Ok(false);
        }
        let Some(run) = wait.run.as_mut() else {
            return Ok(false);
        };
        if run.started_at.is_some() || run.exit.is_some() {
            return Ok(false);
        }
        run.started_at = Some(now_ms);
        wait.updated_at = now_ms;
        write_wait_tx(&tx, &wait)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(true)
    }

    fn record_run_pid(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        pid: u32,
        now_ms: i64,
    ) -> PortResult<()> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        if let Some(mut wait) = read_wait_tx(&tx, wait_id)?
            && let Some(run) = wait.run.as_mut()
        {
            run.pid = Some(pid);
            wait.updated_at = now_ms;
            write_wait_tx(&tx, &wait)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn record_run_exit(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        exit: &AutomationRunExit,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let Some(mut wait) = read_wait_tx(&tx, wait_id)? else {
            return Ok(None);
        };
        if !matches!(
            wait.state,
            AutomationWaitState::Waiting | AutomationWaitState::Checking
        ) {
            return Ok(None);
        }
        let Some(run) = wait.run.as_mut() else {
            return Ok(None);
        };
        if run.exit.is_none() {
            run.exit = Some(exit.clone());
            wait.next_check_at = wait.next_check_at.min(now_ms);
            wait.updated_at = now_ms;
            write_wait_tx(&tx, &wait)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(Some(wait))
    }

    fn orphan_started_runs(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
    ) -> PortResult<usize> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM waits
                     WHERE state IN ('waiting', 'checking') AND run_pending = 1",
                )
                .map_err(map_sql_err)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(map_sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
        };
        let mut count = 0usize;
        for id in ids {
            if let Some(mut wait) = read_wait_tx(&tx, &id)? {
                wait.state = AutomationWaitState::Waiting;
                wait.next_check_at = now_ms;
                wait.updated_at = now_ms;
                write_wait_tx(&tx, &wait)?;
                count += 1;
            }
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(count)
    }

    fn finish_wait_not_ready(
        &self,
        scope: &AutomationWorkspaceScope,
        completion: &AutomationWaitCompletion,
        next_check_at: i64,
    ) -> PortResult<()> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        if let Some(mut wait) = read_wait_tx(&tx, &completion.wait_id)?
            && wait.state != AutomationWaitState::Cancelled
        {
            wait.state = AutomationWaitState::Waiting;
            wait.next_check_at = next_check_at;
            wait.consecutive_errors = 0;
            wait.last_error = None;
            wait.reads = Some(completion.reads.clone());
            wait.evidence = Some(completion.evidence.clone());
            wait.updated_at = completion.now_ms;
            write_wait_tx(&tx, &wait)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn finish_wait_matched(
        &self,
        scope: &AutomationWorkspaceScope,
        completion: &AutomationWaitCompletion,
        result: &AutomationMatchResult,
    ) -> PortResult<Option<AutomationReceiptRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let Some(mut wait) = read_wait_tx(&tx, &completion.wait_id)? else {
            return Ok(None);
        };
        if wait.state == AutomationWaitState::Cancelled {
            return Ok(None);
        }
        if wait.state == AutomationWaitState::Matched {
            if let Some(inv_id) = &wait.invocation_id {
                let raw: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM receipts WHERE id = ?1",
                        params![inv_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(map_sql_err)?;
                if let Some(s) = raw {
                    return serde_json::from_str(&s)
                        .map(Some)
                        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()));
                }
            }
            return Ok(None);
        }

        let rule_id = automation_identity_json(&[json!("condition-rule"), json!(&wait.id)]);
        let event_id = automation_identity_json(&[json!("condition-event"), json!(&wait.id)]);
        let delivery_id = automation_identity_json(&[json!("condition-delivery"), json!(&wait.id)]);
        let receipt_id = automation_identity_json(&[json!("condition-receipt"), json!(&wait.id)]);
        let turn_id = deterministic_uuid_v8(&[
            json!("lody.automation.v1"),
            json!("turn"),
            json!(&receipt_id),
        ]);

        let rule_json = json!({
            "id": rule_id,
            "revision": 1,
            "name": format!("condition:{}", wait.id),
            "ownerUserId": wait.owner_user_id.0,
            "ownerMachineId": wait.owner_machine_id.0,
            "scope": {
                "workspaceId": wait.workspace_id.0,
                "sessionId": wait.session_id.0
            },
            "selector": { "types": ["automation.condition.completed"] },
            "enabled": false,
            "handler": {
                "kind": "policy",
                "policy": "condition-wait",
                "options": { "waitId": wait.id }
            },
            "grants": {
                "actions": ["agent.invoke"],
                "sessionIds": [wait.session_id.0],
                "bindingIds": [],
                "agentRoleIds": [],
                "allowLinkedSession": false,
                "allowCapacityAttempt": false
            },
            "createdAt": wait.created_at,
            "updatedAt": completion.now_ms
        });
        tx.execute(
            "INSERT OR REPLACE INTO rules (id, payload) VALUES (?1, ?2)",
            params![&rule_id, rule_json.to_string()],
        )
        .map_err(map_sql_err)?;

        let event_json = json!({
            "id": event_id,
            "type": "automation.condition.completed",
            "source": "automation.wait",
            "subject": wait.id,
            "scope": {
                "workspaceId": wait.workspace_id.0,
                "sessionId": wait.session_id.0
            },
            "observedAt": completion.now_ms,
            "data": {
                "waitId": wait.id,
                "resumeText": result.resume_text,
                "payload": result.payload
            }
        });
        let event_key = format!("automation.wait:{event_id}");
        tx.execute(
            "INSERT OR IGNORE INTO events
             (event_key, payload, type, source, subject, session_id, project_id, work_id, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)",
            params![
                event_key,
                event_json.to_string(),
                "automation.condition.completed",
                "automation.wait",
                &wait.id,
                &wait.session_id.0,
                completion.now_ms,
            ],
        )
        .map_err(map_sql_err)?;

        let delivery_json = json!({
            "id": delivery_id,
            "state": "completed",
            "rule": rule_json,
            "event": event_json,
            "updatedAt": completion.now_ms
        });
        tx.execute(
            "INSERT OR REPLACE INTO deliveries
             (id, state, payload, rule_id, owner_user_id, scope_session_id, event_source, event_id, event_work_id, updated_at)
             VALUES (?1, 'completed', ?2, ?3, ?4, ?5, 'automation.wait', ?6, NULL, ?7)",
            params![
                &delivery_id,
                delivery_json.to_string(),
                &rule_id,
                &wait.owner_user_id.0,
                &wait.session_id.0,
                &event_id,
                completion.now_ms,
            ],
        )
        .map_err(map_sql_err)?;

        let intent_json = json!({
            "correlationKey": wait.id,
            "action": {
                "kind": "agent.invoke",
                "parameters": {
                    "target": {
                        "kind": "existing",
                        "sessionId": wait.session_id.0,
                        "onUnavailable": "blocked"
                    },
                    "input": {
                        "kind": "condition_result",
                        "resumeText": result.resume_text,
                        "payload": result.payload
                    },
                    "ifBusy": "enqueue"
                }
            }
        });

        let receipt = AutomationReceiptRecord {
            id: receipt_id.clone(),
            delivery_id,
            state: AutomationReceiptState::Accepted,
            reason: None,
            rule: rule_json,
            event: event_json,
            intent: intent_json,
            session_id: Some(wait.session_id.clone()),
            turn_id: Some(TurnId(turn_id)),
            attempts: 0,
            retry_at: Some(0),
            created_at: completion.now_ms,
            updated_at: completion.now_ms,
        };
        write_receipt_tx(&tx, &receipt)?;

        wait.state = AutomationWaitState::Matched;
        wait.result = Some(result.clone());
        wait.invocation_id = Some(receipt_id);
        wait.consecutive_errors = 0;
        wait.last_error = None;
        wait.reads = Some(completion.reads.clone());
        wait.evidence = Some(completion.evidence.clone());
        wait.updated_at = completion.now_ms;
        write_wait_tx(&tx, &wait)?;

        tx.commit().map_err(map_sql_err)?;
        Ok(Some(receipt))
    }

    fn finish_wait_error(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        error_msg: &str,
        failed: bool,
        next_check_at: i64,
        now_ms: i64,
    ) -> PortResult<()> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        if let Some(mut wait) = read_wait_tx(&tx, wait_id)?
            && !matches!(
                wait.state,
                AutomationWaitState::Cancelled | AutomationWaitState::Matched
            )
        {
            wait.consecutive_errors = wait.consecutive_errors.saturating_add(1);
            wait.last_error = Some(error_msg.chars().take(2_000).collect());
            wait.next_check_at = next_check_at;
            wait.state = if failed {
                AutomationWaitState::Failed
            } else {
                AutomationWaitState::Waiting
            };
            wait.updated_at = now_ms;
            write_wait_tx(&tx, &wait)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn expire_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<()> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        if let Some(mut wait) = read_wait_tx(&tx, wait_id)?
            && matches!(
                wait.state,
                AutomationWaitState::Waiting | AutomationWaitState::Checking
            )
        {
            wait.state = AutomationWaitState::Expired;
            wait.updated_at = now_ms;
            write_wait_tx(&tx, &wait)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn cancel_item(
        &self,
        scope: &AutomationWorkspaceScope,
        id: &str,
        now_ms: i64,
    ) -> PortResult<Option<Value>> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        if let Some(mut wait) = read_wait_tx(&tx, id)? {
            if matches!(
                wait.state,
                AutomationWaitState::Waiting | AutomationWaitState::Checking
            ) {
                wait.state = AutomationWaitState::Cancelled;
                wait.updated_at = now_ms;
                write_wait_tx(&tx, &wait)?;
            }
            if let Some(inv_id) = &wait.invocation_id
                && let Some(raw_rcpt) = tx
                    .query_row(
                        "SELECT payload FROM receipts WHERE id = ?1",
                        params![inv_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(map_sql_err)?
            {
                let mut receipt: AutomationReceiptRecord = serde_json::from_str(&raw_rcpt)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
                if !receipt.state.is_terminal() {
                    receipt.state = AutomationReceiptState::Cancelled;
                    receipt.reason = Some("cancelled_by_user".to_string());
                    receipt.updated_at = now_ms;
                    write_receipt_tx(&tx, &receipt)?;
                }
            }
            let out = serde_json::to_value(&wait)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            tx.commit().map_err(map_sql_err)?;
            return Ok(Some(out));
        }

        let raw_receipt: Option<String> = tx
            .query_row(
                "SELECT payload FROM receipts WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        if let Some(raw) = raw_receipt {
            let mut receipt: AutomationReceiptRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            if !receipt.state.is_terminal() {
                receipt.state = AutomationReceiptState::Cancelled;
                receipt.reason = Some("cancelled_by_user".to_string());
                receipt.updated_at = now_ms;
                write_receipt_tx(&tx, &receipt)?;
            }
            let out = serde_json::to_value(&receipt)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            tx.commit().map_err(map_sql_err)?;
            return Ok(Some(out));
        }

        Ok(None)
    }

    fn get_receipt(
        &self,
        scope: &AutomationWorkspaceScope,
        receipt_id: &str,
    ) -> PortResult<Option<AutomationReceiptRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload FROM receipts WHERE id = ?1",
                params![receipt_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        raw.map(|s| {
            serde_json::from_str::<AutomationReceiptRecord>(&s)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        })
        .transpose()
    }

    fn actionable_receipts(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
        limit: usize,
    ) -> PortResult<Vec<AutomationReceiptRecord>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let mut stmt = conn
            .prepare(
                "SELECT payload FROM receipts
                 WHERE state IN ('accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling')
                   AND state != 'blocked'
                   AND retry_at <= ?1
                 ORDER BY retry_at ASC, updated_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![now_ms, limit.min(256) as i64], |r| {
                r.get::<_, String>(0)
            })
            .map_err(map_sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(map_sql_err)?;
            out.push(
                serde_json::from_str(&raw)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?,
            );
        }
        Ok(out)
    }

    fn update_receipt(
        &self,
        scope: &AutomationWorkspaceScope,
        receipt_id: &str,
        patch: &AutomationReceiptPatch,
    ) -> PortResult<()> {
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let raw: Option<String> = tx
            .query_row(
                "SELECT payload FROM receipts WHERE id = ?1",
                params![receipt_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        if let Some(raw) = raw {
            let mut receipt: AutomationReceiptRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            receipt.state = patch.state;
            receipt.reason = patch.reason.clone();
            if patch.turn_id.is_some() {
                receipt.turn_id = patch.turn_id.clone();
            }
            receipt.attempts = patch.attempts;
            receipt.retry_at = patch.retry_at;
            receipt.updated_at = patch.now_ms;
            write_receipt_tx(&tx, &receipt)?;
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn read_session_settings(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
    ) -> PortResult<Value> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        read_session_settings_conn(&conn, &session_id.0)
    }

    fn configure_session_settings(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        user_id: &UserId,
        settings: &Value,
        now_ms: i64,
    ) -> PortResult<Value> {
        let Some(settings_obj) = settings.as_object() else {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "settings must be a JSON object",
            ));
        };
        let conn_arc = self.connection_for(scope)?;
        let mut conn = conn_arc.lock().expect("automation db lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let specs = [
            (
                "archiveAfterMerge",
                "archive-after-merge",
                vec!["github.pr.merged"],
                "session.archive",
                false,
                8,
            ),
            (
                "recoverCapacity",
                "recover-capacity",
                vec!["provider.quota.exhausted", "provider.model.overloaded"],
                "agent.invoke",
                true,
                8,
            ),
            (
                "compactWhenIdle",
                "compact-idle",
                vec!["session.turn.finalized"],
                "session.compact",
                false,
                8,
            ),
            (
                "autoDeliver",
                "auto-deliver",
                vec!["session.delivery.requested"],
                "agent.invoke",
                false,
                64,
            ),
        ];

        for (field, policy_name, events, action, allow_capacity, max_corr) in specs {
            let Some(val) = settings_obj.get(field) else {
                continue;
            };
            let rule_id = automation_identity_json(&[
                json!("session-policy"),
                json!(&session_id.0),
                json!(policy_name),
            ]);
            let prior_raw: Option<String> = tx
                .query_row(
                    "SELECT payload FROM rules WHERE id = ?1",
                    params![&rule_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_err)?;
            let prior_rev = prior_raw
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v.get("revision").and_then(Value::as_u64))
                .unwrap_or(0);
            let created_at = prior_raw
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v.get("createdAt").and_then(Value::as_i64))
                .unwrap_or(now_ms);
            let enabled = val != &Value::Bool(false);
            let options = if val.is_object() {
                val.clone()
            } else {
                json!({})
            };
            let rule_doc = json!({
                "id": rule_id,
                "revision": prior_rev + 1,
                "name": policy_name,
                "ownerUserId": user_id.0,
                "ownerMachineId": scope.machine_id.0,
                "scope": {
                    "workspaceId": scope.workspace_id.0,
                    "sessionId": session_id.0
                },
                "selector": { "types": events },
                "enabled": enabled,
                "handler": {
                    "kind": "policy",
                    "policy": policy_name,
                    "options": options
                },
                "grants": {
                    "actions": [action],
                    "sessionIds": [session_id.0],
                    "bindingIds": [],
                    "agentRoleIds": [],
                    "allowLinkedSession": false,
                    "allowCapacityAttempt": allow_capacity
                },
                "budget": {
                    "maxActionsPerEvent": 1,
                    "maxInvocationsPerCorrelation": max_corr,
                    "maxPendingActions": 128,
                    "maxDepth": 8
                },
                "createdAt": created_at,
                "updatedAt": now_ms
            });
            tx.execute(
                "INSERT OR REPLACE INTO rules (id, payload) VALUES (?1, ?2)",
                params![&rule_id, rule_doc.to_string()],
            )
            .map_err(map_sql_err)?;
        }

        tx.commit().map_err(map_sql_err)?;
        read_session_settings_conn(&conn, &session_id.0)
    }

    fn list_activities(
        &self,
        scope: &AutomationWorkspaceScope,
        owner_user_id: Option<&UserId>,
        session_id: Option<&SessionId>,
        limit: usize,
        before: Option<&AutomationActivityCursor>,
    ) -> PortResult<AutomationActivityPage> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let bounded = limit.clamp(1, 100);
        let fetch_limit = (bounded + 1) as i64;
        let payloads: Vec<(i64, String, String)> = match (session_id, owner_user_id, before) {
            (Some(sid), _, Some(cur)) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT updated_at, id, payload FROM receipts
                         WHERE session_id = ?1
                           AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
                         ORDER BY updated_at DESC, id DESC LIMIT ?4",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&sid.0, cur.updated_at, &cur.id, fetch_limit], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (Some(sid), _, None) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT updated_at, id, payload FROM receipts
                         WHERE session_id = ?1
                         ORDER BY updated_at DESC, id DESC LIMIT ?2",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&sid.0, fetch_limit], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (None, Some(owner), Some(cur)) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT updated_at, id, payload FROM receipts
                         WHERE owner_user_id = ?1
                           AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
                         ORDER BY updated_at DESC, id DESC LIMIT ?4",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(
                        params![&owner.0, cur.updated_at, &cur.id, fetch_limit],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (None, Some(owner), None) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT updated_at, id, payload FROM receipts
                         WHERE owner_user_id = ?1
                         ORDER BY updated_at DESC, id DESC LIMIT ?2",
                    )
                    .map_err(map_sql_err)?;
                let rows = stmt
                    .query_map(params![&owner.0, fetch_limit], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .map_err(map_sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(map_sql_err)?
            }
            (None, None, _) => Vec::new(),
        };

        let has_more = payloads.len() > bounded;
        let mut items = Vec::new();
        let mut last_cursor = None;
        for (updated_at, id, raw) in payloads.into_iter().take(bounded) {
            let rcpt: AutomationReceiptRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            items.push(json!({
                "kind": "action",
                "id": rcpt.id,
                "ruleId": rcpt.rule.get("id"),
                "ruleRevision": rcpt.rule.get("revision"),
                "scope": rcpt.rule.get("scope"),
                "state": rcpt.state,
                "reason": rcpt.reason,
                "event": {
                    "id": rcpt.event.get("id"),
                    "source": rcpt.event.get("source"),
                    "type": rcpt.event.get("type")
                },
                "intent": rcpt.intent,
                "sessionId": rcpt.session_id,
                "turnId": rcpt.turn_id,
                "attempts": rcpt.attempts,
                "retryAt": rcpt.retry_at,
                "createdAt": rcpt.created_at,
                "updatedAt": rcpt.updated_at
            }));
            last_cursor = Some(AutomationActivityCursor { updated_at, id });
        }
        Ok(AutomationActivityPage {
            items,
            next_cursor: if has_more { last_cursor } else { None },
        })
    }

    fn next_due_at(&self, scope: &AutomationWorkspaceScope) -> PortResult<Option<i64>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let accepted_delivery: Option<i32> = conn
            .query_row(
                "SELECT 1 FROM deliveries WHERE state = 'accepted' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        if accepted_delivery.is_some() {
            return Ok(Some(0));
        }
        let wait_due: Option<i64> = conn
            .query_row(
                "SELECT MIN(due_at) FROM waits WHERE state IN ('waiting', 'checking') AND due_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .map_err(map_sql_err)?;
        let rcpt_due: Option<i64> = conn
            .query_row(
                "SELECT MIN(retry_at) FROM receipts
                 WHERE state IN ('accepted','waiting','resolved','submitting','queued','running','blocked','unknown','cancelling')
                   AND state != 'blocked'",
                [],
                |r| r.get(0),
            )
            .map_err(map_sql_err)?;
        let obs_due: Option<i64> = conn
            .query_row("SELECT MIN(retry_at) FROM turn_observations", [], |r| {
                r.get(0)
            })
            .map_err(map_sql_err)?;
        Ok([wait_due, rcpt_due, obs_due].into_iter().flatten().min())
    }

    fn read_source_checkpoint(
        &self,
        scope: &AutomationWorkspaceScope,
        source_id: &str,
    ) -> PortResult<Option<Value>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload FROM sources WHERE id = ?1",
                params![source_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        raw.map(|s| {
            serde_json::from_str::<Value>(&s)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        })
        .transpose()
    }

    fn write_source_checkpoint(
        &self,
        scope: &AutomationWorkspaceScope,
        source_id: &str,
        checkpoint: &Value,
    ) -> PortResult<()> {
        let payload = serde_json::to_string(checkpoint)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        conn.execute(
            "INSERT OR REPLACE INTO sources (id, payload) VALUES (?1, ?2)",
            params![source_id, payload],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn read_capacity_snapshot(
        &self,
        scope: &AutomationWorkspaceScope,
        binding_id: &str,
    ) -> PortResult<Option<Value>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload FROM capacity WHERE id = ?1",
                params![binding_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        raw.map(|s| {
            serde_json::from_str::<Value>(&s)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        })
        .transpose()
    }

    fn write_capacity_snapshot(
        &self,
        scope: &AutomationWorkspaceScope,
        binding_id: &str,
        snapshot: &Value,
    ) -> PortResult<()> {
        let payload = serde_json::to_string(snapshot)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        conn.execute(
            "INSERT OR REPLACE INTO capacity (id, payload) VALUES (?1, ?2)",
            params![binding_id, payload],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn read_session_events(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        since_ms: i64,
        limit: usize,
    ) -> PortResult<Vec<Value>> {
        let conn_arc = self.connection_for(scope)?;
        let conn = conn_arc.lock().expect("automation db lock");
        let bounded = limit.clamp(1, 100) as i64;
        let mut stmt = conn
            .prepare(
                "SELECT payload FROM events
                 WHERE session_id = ?1 AND observed_at >= ?2
                 ORDER BY sequence ASC
                 LIMIT ?3",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![&session_id.0, since_ms.max(0), bounded], |r| {
                r.get::<_, String>(0)
            })
            .map_err(map_sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(map_sql_err)?;
            out.push(
                serde_json::from_str(&raw)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?,
            );
        }
        Ok(out)
    }

    fn erase_workspace_store(&self, scope: &AutomationWorkspaceScope) -> PortResult<()> {
        let storage_key =
            automation_workspace_storage_key(&scope.machine_id.0, &scope.workspace_id.0);
        {
            let mut map = self
                .connections
                .lock()
                .expect("automation connections lock");
            map.remove(&storage_key);
        }
        let db_path = self.layout.automation_workspace_db(&storage_key);
        for suffix in ["", "-wal", "-shm"] {
            let target = PathBuf::from(format!("{}{suffix}", db_path.display()));
            let _ = fs::remove_file(target);
        }
        let logs_dir = self.workspace_run_logs_dir(scope);
        let _ = fs::remove_dir_all(logs_dir);
        Ok(())
    }
}

fn read_session_settings_conn(conn: &Connection, session_id: &str) -> PortResult<Value> {
    let mut out = Map::new();
    let specs = [
        ("archiveAfterMerge", "archive-after-merge"),
        ("recoverCapacity", "recover-capacity"),
        ("compactWhenIdle", "compact-idle"),
        ("autoDeliver", "auto-deliver"),
    ];
    for (field, policy_name) in specs {
        let rule_id = automation_identity_json(&[
            json!("session-policy"),
            json!(session_id),
            json!(policy_name),
        ]);
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload FROM rules WHERE id = ?1",
                params![&rule_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        let Some(raw) = raw else {
            out.insert(field.to_string(), Value::Bool(false));
            continue;
        };
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        let enabled = parsed
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !enabled {
            out.insert(field.to_string(), Value::Bool(false));
            continue;
        }
        let options = parsed
            .pointer("/handler/options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if field == "compactWhenIdle" || field == "autoDeliver" {
            out.insert(field.to_string(), options);
        } else {
            out.insert(field.to_string(), Value::Bool(true));
        }
    }
    Ok(Value::Object(out))
}
