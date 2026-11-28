use crate::map_sql_err;
use lody_ports::{
    PortError, PortErrorKind, PortResult, ScheduleCursorRecord, ScheduleLedgerPort,
    ScheduleLedgerRunRecord, ScheduleRunState, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

const SCHEDULE_LEDGER_USER_VERSION: i64 = 1;

fn set_private_permissions(db_path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = db_path.parent() {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
        let _ = fs::set_permissions(db_path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = db_path;
    }
}

fn verify_no_foreign_schedule_tables(tx: &rusqlite::Transaction<'_>) -> PortResult<()> {
    let mut stmt = tx
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .map_err(map_sql_err)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(map_sql_err)?;
    let mut tables = BTreeSet::new();
    for item in rows {
        tables.insert(item.map_err(map_sql_err)?);
    }
    for name in &tables {
        if name != "schedule_cursors" && name != "schedule_runs" {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                format!("unrecognized table '{name}' in schedules.sqlite"),
            ));
        }
    }
    Ok(())
}

pub struct SqliteScheduleLedgerStore {
    conn: Mutex<Connection>,
}

impl SqliteScheduleLedgerStore {
    pub fn open(db_path: &Path) -> PortResult<Self> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        let mut conn = Connection::open(db_path).map_err(map_sql_err)?;
        set_private_permissions(db_path);
        conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
            .map_err(map_sql_err)?;

        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let version: i64 = tx
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(map_sql_err)?;
        if version > SCHEDULE_LEDGER_USER_VERSION {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                "Schedule database requires a newer CLI",
            ));
        }

        verify_no_foreign_schedule_tables(&tx)?;

        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS schedule_cursors (
                 workspace_id TEXT NOT NULL,
                 schedule_id TEXT NOT NULL,
                 activation_id TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 last_slot INTEGER,
                 next_slot INTEGER,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (workspace_id, schedule_id, activation_id)
             );
             CREATE TABLE IF NOT EXISTS schedule_runs (
                 run_key TEXT PRIMARY KEY,
                 workspace_id TEXT NOT NULL,
                 schedule_id TEXT NOT NULL,
                 state TEXT NOT NULL,
                 planned_at INTEGER NOT NULL,
                 payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS schedule_runs_workspace_state
                 ON schedule_runs(workspace_id, state);
             CREATE INDEX IF NOT EXISTS schedule_runs_history
                 ON schedule_runs(workspace_id, schedule_id, planned_at DESC);
             PRAGMA user_version = 1;",
        )
        .map_err(map_sql_err)?;

        tx.commit().map_err(map_sql_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

impl ScheduleLedgerPort for SqliteScheduleLedgerStore {
    fn read_planning_cursor(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
        activation_id: &str,
    ) -> PortResult<Option<ScheduleCursorRecord>> {
        let conn = self.conn.lock().expect("schedule ledger lock");
        conn.query_row(
            "SELECT fingerprint, last_slot, next_slot, updated_at
             FROM schedule_cursors
             WHERE workspace_id = ?1 AND schedule_id = ?2 AND activation_id = ?3",
            params![&workspace_id.0, schedule_id, activation_id],
            |r| {
                Ok(ScheduleCursorRecord {
                    workspace_id: workspace_id.clone(),
                    schedule_id: schedule_id.to_string(),
                    activation_id: activation_id.to_string(),
                    fingerprint: r.get(0)?,
                    last_slot: r.get(1)?,
                    next_slot: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(map_sql_err)
    }

    fn commit_planned_slot(
        &self,
        cursor: &ScheduleCursorRecord,
        run: Option<&ScheduleLedgerRunRecord>,
    ) -> PortResult<()> {
        let mut conn = self.conn.lock().expect("schedule ledger lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        if let Some(existing_fp) = tx
            .query_row(
                "SELECT fingerprint FROM schedule_cursors
                 WHERE workspace_id = ?1 AND schedule_id = ?2 AND activation_id = ?3",
                params![
                    &cursor.workspace_id.0,
                    &cursor.schedule_id,
                    &cursor.activation_id
                ],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(map_sql_err)?
            && existing_fp != cursor.fingerprint
        {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                "Activation fingerprint changed without a new activation",
            ));
        }

        if let Some(run_rec) = run {
            tx.execute(
                "INSERT OR IGNORE INTO schedule_runs
                 (run_key, workspace_id, schedule_id, state, planned_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &run_rec.run_key,
                    &run_rec.workspace_id.0,
                    &run_rec.schedule_id,
                    run_rec.state.as_wire_str(),
                    run_rec.planned_at,
                    &run_rec.payload_json,
                ],
            )
            .map_err(map_sql_err)?;
        }

        tx.execute(
            "INSERT INTO schedule_cursors
             (workspace_id, schedule_id, activation_id, fingerprint, last_slot, next_slot, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(workspace_id, schedule_id, activation_id) DO UPDATE SET
               last_slot = excluded.last_slot,
               next_slot = excluded.next_slot,
               updated_at = excluded.updated_at",
            params![
                &cursor.workspace_id.0,
                &cursor.schedule_id,
                &cursor.activation_id,
                &cursor.fingerprint,
                cursor.last_slot,
                cursor.next_slot,
                cursor.updated_at,
            ],
        )
        .map_err(map_sql_err)?;

        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn get_run(&self, run_key: &str) -> PortResult<Option<ScheduleLedgerRunRecord>> {
        let conn = self.conn.lock().expect("schedule ledger lock");
        let row: Option<(String, String, String, i64, String)> = conn
            .query_row(
                "SELECT workspace_id, schedule_id, state, planned_at, payload
                 FROM schedule_runs WHERE run_key = ?1",
                params![run_key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(map_sql_err)?;

        let Some((ws, sched_id, state_raw, planned_at, payload_json)) = row else {
            return Ok(None);
        };
        let state = ScheduleRunState::from_wire_str(&state_raw).ok_or_else(|| {
            PortError::new(
                PortErrorKind::Internal,
                format!("unknown schedule run state '{state_raw}'"),
            )
        })?;
        Ok(Some(ScheduleLedgerRunRecord {
            run_key: run_key.to_string(),
            workspace_id: WorkspaceId(ws),
            schedule_id: sched_id,
            state,
            planned_at,
            payload_json,
        }))
    }

    fn unfinished_runs(
        &self,
        workspace_id: &WorkspaceId,
    ) -> PortResult<Vec<ScheduleLedgerRunRecord>> {
        let conn = self.conn.lock().expect("schedule ledger lock");
        let mut stmt = conn
            .prepare(
                "SELECT run_key, schedule_id, state, planned_at, payload
                 FROM schedule_runs
                 WHERE workspace_id = ?1 AND state NOT IN ('finished', 'failed', 'skipped')
                 ORDER BY planned_at ASC, run_key ASC",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![&workspace_id.0], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(map_sql_err)?;

        let mut out = Vec::new();
        for item in rows {
            let (run_key, schedule_id, state_raw, planned_at, payload_json) =
                item.map_err(map_sql_err)?;
            let state = ScheduleRunState::from_wire_str(&state_raw).ok_or_else(|| {
                PortError::new(
                    PortErrorKind::Internal,
                    format!("unknown schedule run state '{state_raw}'"),
                )
            })?;
            out.push(ScheduleLedgerRunRecord {
                run_key,
                workspace_id: workspace_id.clone(),
                schedule_id,
                state,
                planned_at,
                payload_json,
            });
        }
        Ok(out)
    }

    fn transition_run(
        &self,
        run_key: &str,
        allowed_from: &[ScheduleRunState],
        next_state: ScheduleRunState,
        updated_payload_json: &str,
    ) -> PortResult<()> {
        let mut conn = self.conn.lock().expect("schedule ledger lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let current_raw: Option<String> = tx
            .query_row(
                "SELECT state FROM schedule_runs WHERE run_key = ?1",
                params![run_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;

        let Some(raw) = current_raw else {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                "Schedule run state changed",
            ));
        };
        let Some(current) = ScheduleRunState::from_wire_str(&raw) else {
            return Err(PortError::new(
                PortErrorKind::Internal,
                format!("unknown schedule run state '{raw}'"),
            ));
        };
        if !allowed_from.contains(&current) {
            return Err(PortError::new(
                PortErrorKind::Conflict,
                "Schedule run state changed",
            ));
        };

        tx.execute(
            "UPDATE schedule_runs SET state = ?1, payload = ?2 WHERE run_key = ?3",
            params![next_state.as_wire_str(), updated_payload_json, run_key],
        )
        .map_err(map_sql_err)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }

    fn has_consumed_complete_message(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
    ) -> PortResult<bool> {
        let conn = self.conn.lock().expect("schedule ledger lock");
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM schedule_runs
                 WHERE workspace_id = ?1 AND schedule_id = ?2
                   AND state IN ('dispatched', 'finished')
                   AND json_extract(payload, '$.message') IS NOT NULL
                 LIMIT 1",
                params![&workspace_id.0, schedule_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        Ok(found.is_some())
    }

    fn erase_workspace_ledger(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let mut conn = self.conn.lock().expect("schedule ledger lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        tx.execute(
            "DELETE FROM schedule_cursors WHERE workspace_id = ?1",
            params![&workspace_id.0],
        )
        .map_err(map_sql_err)?;
        tx.execute(
            "DELETE FROM schedule_runs WHERE workspace_id = ?1",
            params![&workspace_id.0],
        )
        .map_err(map_sql_err)?;
        tx.commit().map_err(map_sql_err)?;
        Ok(())
    }
}
