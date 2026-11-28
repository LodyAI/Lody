#![forbid(unsafe_code)]

pub mod automation;
pub mod identity;
pub mod lease;
pub mod pr_poller;
pub mod schedule;

pub use automation::{
    AUTOMATION_SCHEMA_VERSION, SqliteAutomationStore, automation_identity_json,
    automation_workspace_storage_key,
};
pub use identity::{
    HardwareProbeFn, HardwareProbeResult, LocalMachineIdentityStore, MachineIdentityConfig,
    compute_host_fingerprint_hash, derive_deterministic_machine_id, generate_random_uuid_v4,
    hmac_sha256, normalize_hardware_id, parse_macos_platform_uuid, parse_windows_machine_guid,
    resolve_linux_machine_id,
};
pub use lease::FileStorageLease;
use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, CustomCommandSpec, DelegatedResultRecord, InboxCategory,
    InboxStorePort, PortError, PortErrorKind, PortResult, SessionId, SubmissionStage, TurnId,
    UserId, WorkspaceId,
};
pub use pr_poller::SqlitePrPollerStore;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
pub use schedule::SqliteScheduleLedgerStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[derive(Debug, Clone)]
pub struct SqliteDataLayout {
    pub data_dir: PathBuf,
    pub machine_id: String,
}

impl SqliteDataLayout {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self::with_machine_id(data_dir, "local")
    }

    pub fn with_machine_id(data_dir: impl Into<PathBuf>, machine_id: impl Into<String>) -> Self {
        Self {
            data_dir: data_dir.into(),
            machine_id: machine_id.into(),
        }
    }

    pub fn operations_db(&self) -> PathBuf {
        let machine_key = &sha256_hex(&self.machine_id)[..24];
        self.data_dir
            .join("orchestration")
            .join(machine_key)
            .join("operations.sqlite3")
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

    pub fn automation_db_for_workspace(&self, machine_id: &str, workspace_id: &str) -> PathBuf {
        let key = automation_workspace_storage_key(machine_id, workspace_id);
        self.automation_workspace_db(&key)
    }

    pub fn automation_run_logs_dir(&self, machine_id: &str, workspace_id: &str) -> PathBuf {
        let key = automation_workspace_storage_key(machine_id, workspace_id);
        self.data_dir.join("automations").join("runs").join(key)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredBatchConfig {
    prompt_text: String,
    adapter_id: String,
    custom_acp: Option<CustomCommandSpec>,
    signed_intent_verified: bool,
}

pub struct SqliteStore {
    layout: SqliteDataLayout,
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(layout: SqliteDataLayout) -> PortResult<Self> {
        let db_path = layout.operations_db();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        let conn = Connection::open(&db_path).map_err(map_sql_err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS inbox_recoveries(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, snapshot_token TEXT NOT NULL,
                 execution_id TEXT, recovered_at TEXT NOT NULL,
                 PRIMARY KEY(workspace_id,session_id,snapshot_token));
             CREATE TABLE IF NOT EXISTS inbox_stops(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, cancel_id TEXT NOT NULL,
                 execution_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL,
                 PRIMARY KEY(workspace_id,session_id,cancel_id));
             CREATE TABLE IF NOT EXISTS inbox_resources(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 execution_id TEXT NOT NULL, identity_json TEXT, state TEXT NOT NULL DEFAULT 'active',
                 cause TEXT, generation INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(workspace_id,session_id,execution_id));
             CREATE TABLE IF NOT EXISTS inbox_modes(
                 workspace_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                 protocol INTEGER NOT NULL CHECK(protocol=2));
             CREATE TABLE IF NOT EXISTS inbox_sessions(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 revision INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
                 blocked INTEGER NOT NULL DEFAULT 0, active_execution TEXT, active_input TEXT, config_json TEXT,
                 PRIMARY KEY(workspace_id,session_id,user_id));
             CREATE TABLE IF NOT EXISTS inbox_results(
                 sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 user_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
                 source_turn_id TEXT, created_at TEXT, completed_at TEXT, chain_depth INTEGER NOT NULL,
                 completion_json TEXT NOT NULL, automatic_eligible INTEGER NOT NULL DEFAULT 1,
                 claim TEXT, consumed INTEGER NOT NULL DEFAULT 0, consumed_at TEXT,
                 UNIQUE(session_id,operation_id));
             CREATE TABLE IF NOT EXISTS inbox_inputs(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 input_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
                 canceled INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
                 cancellation_reason TEXT,
                 PRIMARY KEY(workspace_id,session_id,input_id));
             CREATE TABLE IF NOT EXISTS inbox_releases(
                 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
                 execution_id TEXT NOT NULL, outcome TEXT NOT NULL, watermark INTEGER NOT NULL,
                 PRIMARY KEY(workspace_id,session_id,execution_id));
             CREATE TABLE IF NOT EXISTS inbox_intents(
                 intent_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 user_id TEXT NOT NULL, execution_id TEXT NOT NULL, watermark INTEGER NOT NULL,
                 input_json TEXT NOT NULL, batch_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
                 UNIQUE(workspace_id,session_id,execution_id));
             CREATE TABLE IF NOT EXISTS inbox_batches(
                 batch_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 user_id TEXT NOT NULL, input_id TEXT NOT NULL, kind TEXT NOT NULL,
                 config_json TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT NOT NULL,
                 watermark INTEGER NOT NULL, member_count INTEGER NOT NULL CHECK(member_count>0),
                 chain_depth INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'prepared', cause TEXT);
             CREATE UNIQUE INDEX IF NOT EXISTS inbox_live_input
                 ON inbox_batches(workspace_id,session_id,input_id)
                 WHERE state IN ('prepared','submitting','submitted','unknown');
             CREATE TABLE IF NOT EXISTS inbox_members(
                 batch_id TEXT NOT NULL REFERENCES inbox_batches(batch_id),
                 sequence INTEGER NOT NULL REFERENCES inbox_results(sequence),
                 PRIMARY KEY(batch_id,sequence));",
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

pub(crate) fn map_sql_err(err: rusqlite::Error) -> PortError {
    PortError::new(PortErrorKind::Internal, err.to_string())
}

fn category_to_wire(cat: InboxCategory) -> &'static str {
    match cat {
        InboxCategory::Human => "human",
        InboxCategory::DelegatedReceiptBatch => "task",
        InboxCategory::Schedule => "automatic",
        InboxCategory::Automation => "automation",
    }
}

fn category_from_wire(raw: &str) -> InboxCategory {
    match raw {
        "task" => InboxCategory::DelegatedReceiptBatch,
        "automatic" => InboxCategory::Schedule,
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
        SubmissionStage::Retired => "superseded",
    }
}

impl InboxStorePort for SqliteStore {
    fn store_name(&self) -> &'static str {
        "operations.sqlite3"
    }

    fn admit_turn(&self, input: &AdmittedTurnInput) -> PortResult<AdmissionVerdict> {
        let cfg = StoredBatchConfig {
            prompt_text: input.prompt_text.clone(),
            adapter_id: input.adapter_id.clone(),
            custom_acp: input.custom_acp.clone(),
            signed_intent_verified: input.signed_intent_verified,
        };
        let cfg_json = serde_json::to_string(&cfg)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;

        let kind_str = category_to_wire(input.category);
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO inbox_inputs
                 (workspace_id, session_id, user_id, input_id, kind, revision, canceled, finished)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 0)",
                params![
                    &input.workspace_id.0,
                    &input.session_id.0,
                    &input.verified_requester.0,
                    &input.turn_id.0,
                    kind_str,
                ],
            )
            .map_err(map_sql_err)?;

        if inserted > 0 {
            let batch_id = format!(
                "batch:{}:{}:{}",
                input.workspace_id.0, input.session_id.0, input.turn_id.0
            );
            tx.execute(
                "INSERT OR IGNORE INTO inbox_batches
                 (batch_id, workspace_id, session_id, user_id, input_id, kind, config_json,
                  revision, owner, watermark, member_count, chain_depth, state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 'lodyd', 0, 1, 0, 'prepared')",
                params![
                    &batch_id,
                    &input.workspace_id.0,
                    &input.session_id.0,
                    &input.verified_requester.0,
                    &input.turn_id.0,
                    kind_str,
                    &cfg_json,
                ],
            )
            .map_err(map_sql_err)?;
        }

        if inserted > 0 && matches!(input.category, InboxCategory::Human) {
            tx.execute(
                "UPDATE inbox_sessions SET paused = 0 WHERE workspace_id = ?1 AND session_id = ?2",
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

        tx.execute(
            "UPDATE inbox_batches
             SET state = 'settled'
             WHERE workspace_id = ?1 AND session_id = ?2 AND state = 'prepared'
               AND EXISTS (
                 SELECT 1 FROM inbox_inputs i
                 WHERE i.workspace_id = inbox_batches.workspace_id
                   AND i.session_id = inbox_batches.session_id
                   AND i.input_id = inbox_batches.input_id
                   AND (i.canceled != 0 OR i.finished != 0)
               )",
            params![&workspace_id.0, &session_id.0],
        )
        .map_err(map_sql_err)?;

        let paused: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(paused), 0) FROM inbox_sessions
                 WHERE workspace_id = ?1 AND session_id = ?2",
                params![&workspace_id.0, &session_id.0],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?
            .unwrap_or(0);

        if paused != 0 {
            tx.commit().map_err(map_sql_err)?;
            return Ok(None);
        }

        let row: Option<(String, String, String, String, String)> = tx
            .query_row(
                "SELECT batch_id, input_id, kind, user_id, config_json
                 FROM inbox_batches
                 WHERE workspace_id = ?1 AND session_id = ?2 AND state = 'prepared'
                 ORDER BY CASE kind
                     WHEN 'human' THEN 0
                     WHEN 'task' THEN 1
                     WHEN 'automatic' THEN 2
                     ELSE 3
                 END ASC, rowid ASC
                 LIMIT 1",
                params![&workspace_id.0, &session_id.0],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(map_sql_err)?;

        let Some((batch_id, turn_id, kind_raw, requester, cfg_json)) = row else {
            tx.commit().map_err(map_sql_err)?;
            return Ok(None);
        };

        tx.execute(
            "UPDATE inbox_batches SET state = 'submitting' WHERE batch_id = ?1",
            params![&batch_id],
        )
        .map_err(map_sql_err)?;

        tx.commit().map_err(map_sql_err)?;

        let cfg: StoredBatchConfig = serde_json::from_str(&cfg_json)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        Ok(Some(AdmittedTurnInput {
            workspace_id: workspace_id.clone(),
            session_id: session_id.clone(),
            turn_id: TurnId(turn_id),
            category: category_from_wire(&kind_raw),
            verified_requester: UserId(requester),
            prompt_text: cfg.prompt_text,
            adapter_id: cfg.adapter_id,
            custom_acp: cfg.custom_acp,
            signed_intent_verified: cfg.signed_intent_verified,
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
            "UPDATE inbox_batches SET state = ?1
             WHERE workspace_id = ?2 AND session_id = ?3 AND input_id = ?4",
            params![
                stage_to_wire(stage),
                &workspace_id.0,
                &session_id.0,
                &turn_id.0
            ],
        )
        .map_err(map_sql_err)?;
        if matches!(stage, SubmissionStage::Settled) {
            conn.execute(
                "UPDATE inbox_inputs SET finished = 1
                 WHERE workspace_id = ?1 AND session_id = ?2 AND input_id = ?3",
                params![&workspace_id.0, &session_id.0, &turn_id.0],
            )
            .map_err(map_sql_err)?;
        }
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
            "INSERT INTO inbox_sessions (workspace_id, session_id, user_id, paused)
             VALUES (?1, ?2, 'host', ?3)
             ON CONFLICT(workspace_id, session_id, user_id) DO UPDATE SET paused = excluded.paused",
            params![&workspace_id.0, &session_id.0, i64::from(paused)],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    fn is_input_ended(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> PortResult<bool> {
        let conn = self.conn.lock().expect("sqlite lock");
        let ended: Option<i64> = conn
            .query_row(
                "SELECT (canceled != 0 OR finished != 0)
                 FROM inbox_inputs
                 WHERE workspace_id = ?1 AND session_id = ?2 AND input_id = ?3",
                params![&workspace_id.0, &session_id.0, &turn_id.0],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_sql_err)?;
        Ok(ended.unwrap_or(0) != 0)
    }

    fn find_ended_active_claims(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Vec<TurnId>> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        let mut out = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT b.input_id
                     FROM inbox_batches b
                     JOIN inbox_inputs i
                       ON i.workspace_id = b.workspace_id
                      AND i.session_id = b.session_id
                      AND i.input_id = b.input_id
                     WHERE b.workspace_id = ?1
                       AND b.session_id = ?2
                       AND b.state IN ('prepared', 'submitting', 'submitted')
                       AND (i.canceled != 0 OR i.finished != 0)",
                )
                .map_err(map_sql_err)?;
            let rows = stmt
                .query_map(params![&workspace_id.0, &session_id.0], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(map_sql_err)?;
            for item in rows {
                out.push(TurnId(item.map_err(map_sql_err)?));
            }
        }
        if !out.is_empty() {
            for tid in &out {
                tx.execute(
                    "UPDATE inbox_batches SET state = 'settled'
                     WHERE workspace_id = ?1 AND session_id = ?2 AND input_id = ?3",
                    params![&workspace_id.0, &session_id.0, &tid.0],
                )
                .map_err(map_sql_err)?;
            }
        }
        tx.commit().map_err(map_sql_err)?;
        Ok(out)
    }

    fn record_delegated_result(&self, record: &DelegatedResultRecord) -> PortResult<bool> {
        let completion_json = serde_json::to_string(&serde_json::json!({
            "childSessionId": record.child_session_id.0,
            "succeeded": record.succeeded,
            "summaryPreview": record.summary_preview,
        }))
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        let conn = self.conn.lock().expect("sqlite lock");
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO inbox_results
                 (workspace_id, session_id, user_id, operation_id, operation_kind, source_turn_id,
                  chain_depth, completion_json, automatic_eligible, consumed)
                 VALUES (?1, ?2, ?3, ?4, 'session_create', ?5, ?6, ?7, 1, 0)",
                params![
                    &record.workspace_id.0,
                    &record.parent_session_id.0,
                    &record.user_id.0,
                    &record.operation_id,
                    record.source_turn_id.as_ref().map(|t| t.0.as_str()),
                    i64::from(record.chain_depth),
                    &completion_json,
                ],
            )
            .map_err(map_sql_err)?;
        Ok(inserted > 0)
    }

    fn erase_workspace_inbox(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sql_err)?;
        for table in [
            "inbox_members",
            "inbox_batches",
            "inbox_intents",
            "inbox_releases",
            "inbox_inputs",
            "inbox_results",
            "inbox_sessions",
            "inbox_resources",
            "inbox_stops",
            "inbox_recoveries",
        ] {
            if table == "inbox_members" {
                tx.execute(
                    "DELETE FROM inbox_members WHERE batch_id IN
                     (SELECT batch_id FROM inbox_batches WHERE workspace_id = ?1)",
                    params![&workspace_id.0],
                )
                .map_err(map_sql_err)?;
            } else {
                let sql = format!("DELETE FROM {table} WHERE workspace_id = ?1");
                tx.execute(&sql, params![&workspace_id.0])
                    .map_err(map_sql_err)?;
            }
        }
        tx.commit().map_err(map_sql_err)?;
        let auto_db = self.layout.automation_workspace_db(&workspace_id.0);
        if auto_db.exists() {
            let _ = fs::remove_file(auto_db);
        }
        Ok(())
    }
}
