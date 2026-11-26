#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::execution::{CustomCommandSpec, LocalProjectGitSummary};
use crate::identity::{LocalProjectId, SessionId, TurnId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageLeaseMode {
    StorageOnly,
    OnlineHost,
}

pub trait StorageLeasePort: Send + Sync {
    fn mode(&self) -> StorageLeaseMode;
    fn yield_requested(&self) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxCategory {
    Human,
    DelegatedReceiptBatch,
    Automation,
    Schedule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionStage {
    Prepared,
    Submitting,
    Submitted,
    Unknown,
    Settled,
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdmittedTurnInput {
    pub workspace_id: WorkspaceId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub category: InboxCategory,
    pub verified_requester: UserId,
    pub prompt_text: String,
    pub adapter_id: String,
    pub custom_acp: Option<CustomCommandSpec>,
    pub signed_intent_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegatedResultRecord {
    pub workspace_id: WorkspaceId,
    pub parent_session_id: SessionId,
    pub user_id: UserId,
    pub operation_id: String,
    pub child_session_id: SessionId,
    pub source_turn_id: Option<TurnId>,
    pub chain_depth: u8,
    pub succeeded: bool,
    pub summary_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionVerdict {
    Admitted,
    DuplicateIgnored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalProjectRecord {
    pub project_id: LocalProjectId,
    pub name: String,
    pub root_path: PathBuf,
    pub git_summary: Option<LocalProjectGitSummary>,
}

pub trait ProjectStorePort: Send + Sync {
    fn register_project(
        &self,
        name: &str,
        root_path: &std::path::Path,
    ) -> PortResult<LocalProjectRecord>;
    fn get_project(&self, project_id: &LocalProjectId) -> PortResult<Option<LocalProjectRecord>>;
    fn list_projects(&self) -> PortResult<Vec<LocalProjectRecord>>;
}

pub trait InboxStorePort: Send + Sync {
    fn store_name(&self) -> &'static str;
    fn admit_turn(&self, input: &AdmittedTurnInput) -> PortResult<AdmissionVerdict>;
    fn claim_next_runnable(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Option<AdmittedTurnInput>>;
    fn update_submission_stage(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        stage: SubmissionStage,
    ) -> PortResult<()>;
    fn set_inbox_paused(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        paused: bool,
    ) -> PortResult<()>;
    fn is_input_ended(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _turn_id: &TurnId,
    ) -> PortResult<bool> {
        Ok(false)
    }
    fn find_ended_active_claims(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Vec<TurnId>> {
        Ok(Vec::new())
    }
    fn record_delegated_result(&self, _record: &DelegatedResultRecord) -> PortResult<bool> {
        Ok(true)
    }
    fn erase_workspace_inbox(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnDiffCompression {
    Gzip,
    Zstd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum DiffCaptureScope {
    WorktreeBranch { base_branch: Option<String> },
    UncommittedOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnDiffEventInput {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub new_is_current: bool,
    pub head_proof: Option<i64>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFileEntry {
    pub relative_path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnDiffSummary {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub files: Vec<DiffFileEntry>,
}

pub trait DiffStorePort: Send + Sync {
    fn capture_turn_snapshot(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        workdir: &std::path::Path,
        scope: &DiffCaptureScope,
        now_ms: i64,
    ) -> PortResult<TurnDiffSummary>;
    fn read_turn_diff(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        now_ms: i64,
    ) -> PortResult<Option<TurnDiffSummary>>;
    fn erase_workspace_diffs(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleRunState {
    Pending,
    Prepared,
    Dispatched,
    RetryWait,
    Finished,
    Failed,
    Skipped,
}

impl ScheduleRunState {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Prepared => "prepared",
            Self::Dispatched => "dispatched",
            Self::RetryWait => "retry_wait",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    pub fn from_wire_str(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(Self::Pending),
            "prepared" => Some(Self::Prepared),
            "dispatched" => Some(Self::Dispatched),
            "retry_wait" => Some(Self::RetryWait),
            "finished" => Some(Self::Finished),
            "failed" => Some(Self::Failed),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCursorRecord {
    pub workspace_id: WorkspaceId,
    pub schedule_id: String,
    pub activation_id: String,
    pub fingerprint: String,
    pub last_slot: Option<i64>,
    pub next_slot: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleLedgerRunRecord {
    pub run_key: String,
    pub workspace_id: WorkspaceId,
    pub schedule_id: String,
    pub state: ScheduleRunState,
    pub planned_at: i64,
    pub payload_json: String,
}

pub trait ScheduleLedgerPort: Send + Sync {
    fn read_planning_cursor(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
        activation_id: &str,
    ) -> PortResult<Option<ScheduleCursorRecord>>;
    fn commit_planned_slot(
        &self,
        cursor: &ScheduleCursorRecord,
        run: Option<&ScheduleLedgerRunRecord>,
    ) -> PortResult<()>;
    fn get_run(&self, run_key: &str) -> PortResult<Option<ScheduleLedgerRunRecord>>;
    fn unfinished_runs(
        &self,
        workspace_id: &WorkspaceId,
    ) -> PortResult<Vec<ScheduleLedgerRunRecord>>;
    fn transition_run(
        &self,
        run_key: &str,
        allowed_from: &[ScheduleRunState],
        next_state: ScheduleRunState,
        updated_payload_json: &str,
    ) -> PortResult<()>;
    fn has_consumed_complete_message(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
    ) -> PortResult<bool>;
    fn erase_workspace_ledger(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Default)]
pub struct UnavailableScheduleLedger;

impl ScheduleLedgerPort for UnavailableScheduleLedger {
    fn read_planning_cursor(
        &self,
        _workspace_id: &WorkspaceId,
        _schedule_id: &str,
        _activation_id: &str,
    ) -> PortResult<Option<ScheduleCursorRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }

    fn commit_planned_slot(
        &self,
        _cursor: &ScheduleCursorRecord,
        _run: Option<&ScheduleLedgerRunRecord>,
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }

    fn get_run(&self, _run_key: &str) -> PortResult<Option<ScheduleLedgerRunRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }

    fn unfinished_runs(
        &self,
        _workspace_id: &WorkspaceId,
    ) -> PortResult<Vec<ScheduleLedgerRunRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }

    fn transition_run(
        &self,
        _run_key: &str,
        _allowed_from: &[ScheduleRunState],
        _next_state: ScheduleRunState,
        _updated_payload_json: &str,
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }

    fn has_consumed_complete_message(
        &self,
        _workspace_id: &WorkspaceId,
        _schedule_id: &str,
    ) -> PortResult<bool> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule ledger unavailable",
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationProgramRecord {
    pub automation_id: String,
    pub workspace_id: WorkspaceId,
    pub author_user_id: UserId,
    pub script_source: String,
    pub enabled: bool,
}

pub trait AutomationStorePort: Send + Sync {
    fn list_programs(&self, workspace_id: &WorkspaceId)
    -> PortResult<Vec<AutomationProgramRecord>>;
    fn erase_workspace_store(&self, workspace_id: &WorkspaceId) -> PortResult<()>;
}
