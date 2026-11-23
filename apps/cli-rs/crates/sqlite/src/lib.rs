#![forbid(unsafe_code)]

use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, HistoryPort, HistoryTurnRecord, InboxCategory,
    InboxStorePort, LocalProjectId, LocalProjectRecord, PortError, PortErrorKind, PortResult,
    ProjectStorePort, SessionId, SubmissionStage, TurnId, UserId, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct SqliteDataLayout {
    pub data_dir: PathBuf,
}

impl SqliteDataLayout {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn operations_db(&self) -> PathBuf {
        self.data_dir.join("operations.sqlite3")
    }

    pub fn schedules_db(&self) -> PathBuf {
        self.data_dir.join("schedules.sqlite")
    }

    pub fn pr_poller_db(&self) -> PathBuf {
        self.data_dir.join("pr-poller-state.sqlite3")
    }

    pub fn automation_workspace_db(&self, workspace_storage_key: &str) -> PathBuf {
        self.data_dir
            .join("automations")
            .join(format!("{workspace_storage_key}.sqlite"))
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

pub struct SqliteStore {
    layout: SqliteDataLayout,
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(layout: SqliteDataLayout) -> PortResult<Self> {
        fs::create_dir_all(layout.data_dir())
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        let db_path = layout.operations_db();
        let conn = Connection::open(&db_path).map_err(map_sql_err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS lody_inbox_turns (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 turn_id TEXT NOT NULL,
                 category TEXT NOT NULL,
                 priority INTEGER NOT NULL,
                 verified_requester TEXT NOT NULL,
                 prompt_text TEXT NOT NULL,
                 stage TEXT NOT NULL,
                 UNIQUE(workspace_id, session_id, turn_id)
             );
             CREATE TABLE IF NOT EXISTS lody_inbox_session_flags (
                 workspace_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 paused INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(workspace_id, session_id)
             );
             CREATE TABLE IF NOT EXISTS lody_local_projects (
                 project_id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 root_path TEXT NOT NULL UNIQUE,
                 default_branch TEXT
             );
             CREATE TABLE IF NOT EXISTS lody_session_turns (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 turn_id TEXT NOT NULL,
                 record_json TEXT NOT NULL,
                 UNIQUE(workspace_id, session_id, turn_id)
             );",
        )
        .map_err(map_sql_err)?;

        Ok(Self {
            layout,
            conn: Mutex::new(conn),
        })
    }

    pub fn layout(&self) -> &SqliteDataLayout {
        &self.layout
    }
}

pub type SqliteInboxStore = SqliteStore;

fn map_sql_err(err: rusqlite::Error) -> PortError {
    PortError::new(PortErrorKind::Internal, err.to_string())
}

fn category_to_wire(cat: InboxCategory) -> (&'static str, i64) {
    match cat {
        InboxCategory::Human => ("human", 0),
        InboxCategory::DelegatedReceiptBatch => ("delegated_receipt_batch", 1),
        InboxCategory::Schedule => ("schedule", 2),
        InboxCategory::Automation => ("automation", 3),
    }
}

fn category_from_wire(raw: &str) -> InboxCategory {
    match raw {
        "delegated_receipt_batch" => InboxCategory::DelegatedReceiptBatch,
        "schedule" => InboxCategory::Schedule,
        "automation" => InboxCategory::Automation,
        _ => InboxCategory::Human,
    }
}

fn stage_to_wire(stage: SubmissionStage) -> &'static str {
    match stage {
        SubmissionStage::Prepared => "prepared",
        SubmissionStage::Submitting => "submitting",
        SubmissionStage::Submitted => "submitted",
        SubmissionStage::Unknown => "unknown",
        SubmissionStage::Settled => "settled",
        SubmissionStage::Retired => "retired",
    }
}

impl InboxStorePort for SqliteStore {
    fn store_name(&self) -> &'static str {
        "operations.sqlite3"
    }

    fn admit_turn(&self, input: &AdmittedTurnInput) -> PortResult<AdmissionVerdict> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let (cat_str, priority) = category_to_wire(input.category);
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO lody_inbox_turns
                 (workspace_id, session_id, turn_id, category, priority, verified_requester, prompt_text, stage)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared')",
                params![
                    &input.workspace_id.0,
                    &input.session_id.0,
                    &input.turn_id.0,
                    cat_str,
                    priority,
                    &input.verified_requester.0,
                    &input.prompt_text,
                ],
            )
            .map_err(map_sql_err)?;

        if inserted > 0 && matches!(input.category, InboxCategory::Human) {
            tx.execute(
                "INSERT INTO lody_inbox_session_flags (workspace_id, session_id, paused)
                 VALUES (?1, ?2, 0)
                 ON CONFLICT(workspace_id, session_id) DO UPDATE SET paused = 0",
                params![&input.workspace_id.0, &input.session_id.0],
            )
            .map_err(map_sql_err)?;
        }

        tx.commit().map_err(map_sql_err)?;
        Ok(if inserted > 0 {
            AdmissionVerdict::Admitted
        } else {
            AdmissionVerdict::DuplicateIgnored
        })
    }

    fn claim_next_runnable(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Option<AdmittedTurnInput>> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let paused: i64 = tx
            .query_row(
                "SELECT paused FROM lody_inbox_session_flags WHERE workspace_id = ?1 AND session_id = ?2",
                params![&workspace_id.0, &session_id.0],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?
            .unwrap_or(0);

        if paused != 0 {
            return Ok(None);
        }

        let row: Option<(i64, String, String, String, String)> = tx
            .query_row(
                "SELECT seq, turn_id, category, verified_requester, prompt_text
                 FROM lody_inbox_turns
                 WHERE workspace_id = ?1 AND session_id = ?2 AND stage = 'prepared'
                 ORDER BY priority ASC, seq ASC
                 LIMIT 1",
                params![&workspace_id.0, &session_id.0],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(map_sql_err)?;

        let Some((seq, turn_id, cat_raw, requester, prompt_text)) = row else {
            return Ok(None);
        };

        tx.execute(
            "UPDATE lody_inbox_turns SET stage = 'submitting' WHERE seq = ?1",
            params![seq],
        )
        .map_err(map_sql_err)?;

        tx.commit().map_err(map_sql_err)?;

        Ok(Some(AdmittedTurnInput {
            workspace_id: workspace_id.clone(),
            session_id: session_id.clone(),
            turn_id: TurnId(turn_id),
            category: category_from_wire(&cat_raw),
            verified_requester: UserId(requester),
            prompt_text,
        }))
    }

    fn update_submission_stage(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        stage: SubmissionStage,
    ) -> PortResult<()> {
        let conn = self.conn.lock().expect("sqlite lock");
        conn.execute(
            "UPDATE lody_inbox_turns SET stage = ?1
             WHERE workspace_id = ?2 AND session_id = ?3 AND turn_id = ?4",
            params![
                stage_to_wire(stage),
                &workspace_id.0,
                &session_id.0,
                &turn_id.0
            ],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn set_inbox_paused(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        paused: bool,
    ) -> PortResult<()> {
        let conn = self.conn.lock().expect("sqlite lock");
        conn.execute(
            "INSERT INTO lody_inbox_session_flags (workspace_id, session_id, paused)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace_id, session_id) DO UPDATE SET paused = excluded.paused",
            params![&workspace_id.0, &session_id.0, i64::from(paused)],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn erase_workspace_inbox(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        tx.execute(
            "DELETE FROM lody_inbox_turns WHERE workspace_id = ?1",
            params![&workspace_id.0],
        )
        .map_err(map_sql_err)?;
        tx.execute(
            "DELETE FROM lody_inbox_session_flags WHERE workspace_id = ?1",
            params![&workspace_id.0],
        )
        .map_err(map_sql_err)?;
        tx.commit().map_err(map_sql_err)?;
        let auto_db = self.layout.automation_workspace_db(&workspace_id.0);
        if auto_db.exists() {
            let _ = fs::remove_file(auto_db);
        }
        Ok(())
    }
}

impl ProjectStorePort for SqliteStore {
    fn register_project(&self, name: &str, root_path: &Path) -> PortResult<LocalProjectRecord> {
        let canonical = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());
        let root_str = canonical.to_string_lossy();
        let conn = self.conn.lock().expect("sqlite lock");

        if let Some((existing_id, existing_name, branch)) = conn
            .query_row(
                "SELECT project_id, name, default_branch FROM lody_local_projects WHERE root_path = ?1",
                params![root_str.as_ref()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
            )
            .optional()
            .map_err(map_sql_err)?
        {
            return Ok(LocalProjectRecord {
                project_id: LocalProjectId(existing_id),
                name: existing_name,
                root_path: canonical,
                default_branch: branch,
            });
        }

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lody_local_projects", [], |r| r.get(0))
            .map_err(map_sql_err)?;
        let project_id = format!("proj_{}", count + 1);
        conn.execute(
            "INSERT INTO lody_local_projects (project_id, name, root_path, default_branch)
             VALUES (?1, ?2, ?3, ?4)",
            params![&project_id, name, root_str.as_ref(), Option::<String>::None],
        )
        .map_err(map_sql_err)?;

        Ok(LocalProjectRecord {
            project_id: LocalProjectId(project_id),
            name: name.to_string(),
            root_path: canonical,
            default_branch: None,
        })
    }

    fn get_project(&self, project_id: &LocalProjectId) -> PortResult<Option<LocalProjectRecord>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let row = conn
            .query_row(
                "SELECT project_id, name, root_path, default_branch FROM lody_local_projects WHERE project_id = ?1",
                params![&project_id.0],
                |r| {
                    Ok(LocalProjectRecord {
                        project_id: LocalProjectId(r.get(0)?),
                        name: r.get(1)?,
                        root_path: PathBuf::from(r.get::<_, String>(2)?),
                        default_branch: r.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(map_sql_err)?;
        Ok(row)
    }

    fn list_projects(&self) -> PortResult<Vec<LocalProjectRecord>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn
            .prepare(
                "SELECT project_id, name, root_path, default_branch FROM lody_local_projects ORDER BY rowid ASC",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(LocalProjectRecord {
                    project_id: LocalProjectId(r.get(0)?),
                    name: r.get(1)?,
                    root_path: PathBuf::from(r.get::<_, String>(2)?),
                    default_branch: r.get(3)?,
                })
            })
            .map_err(map_sql_err)?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(map_sql_err)?);
        }
        Ok(out)
    }
}

impl HistoryPort for SqliteStore {
    fn backend_name(&self) -> &'static str {
        "sqlite-local"
    }

    fn is_user_turn_durable(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> PortResult<bool> {
        let conn = self.conn.lock().expect("sqlite lock");
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM lody_session_turns
                 WHERE workspace_id = ?1 AND session_id = ?2 AND turn_id = ?3",
                params![&workspace_id.0, &session_id.0, &turn_id.0],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        Ok(exists.is_some())
    }

    fn read_session_turns(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn
            .prepare(
                "SELECT record_json FROM lody_session_turns
                 WHERE workspace_id = ?1 AND session_id = ?2
                 ORDER BY seq ASC",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![&workspace_id.0, &session_id.0], |r| {
                r.get::<_, String>(0)
            })
            .map_err(map_sql_err)?;
        let mut turns = Vec::new();
        for row in rows {
            let raw = row.map_err(map_sql_err)?;
            let parsed: HistoryTurnRecord = serde_json::from_str(&raw)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            turns.push(parsed);
        }
        Ok(turns)
    }

    fn resolve_unique_workspace_for_session(
        &self,
        session_id: &SessionId,
    ) -> PortResult<Option<WorkspaceId>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT workspace_id FROM lody_session_turns WHERE session_id = ?1 LIMIT 2",
            )
            .map_err(map_sql_err)?;
        let rows = stmt
            .query_map(params![&session_id.0], |r| r.get::<_, String>(0))
            .map_err(map_sql_err)?;
        let mut workspaces = Vec::new();
        for item in rows {
            workspaces.push(item.map_err(map_sql_err)?);
        }
        match workspaces.len() {
            0 => Ok(None),
            1 => Ok(workspaces.into_iter().next().map(WorkspaceId)),
            _ => Err(PortError::new(
                PortErrorKind::Conflict,
                format!(
                    "session '{}' exists in multiple workspaces; specify workspace_id",
                    session_id.0
                ),
            )),
        }
    }

    fn upsert_turn_record(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        record: &HistoryTurnRecord,
    ) -> PortResult<()> {
        let json = serde_json::to_string(record)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        let conn = self.conn.lock().expect("sqlite lock");
        conn.execute(
            "INSERT INTO lody_session_turns (workspace_id, session_id, turn_id, record_json)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace_id, session_id, turn_id) DO UPDATE SET record_json = excluded.record_json",
            params![&workspace_id.0, &session_id.0, &record.turn_id.0, &json],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn erase_workspace_turns(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let conn = self.conn.lock().expect("sqlite lock");
        conn.execute(
            "DELETE FROM lody_session_turns WHERE workspace_id = ?1",
            params![&workspace_id.0],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }
}
