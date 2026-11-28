#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::execution::{CustomCommandSpec, LocalProjectGitSummary};
use crate::identity::{LocalProjectId, MachineId, SessionId, TurnId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_hex: Option<String>,
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
    Claimed,
    SessionPrepared,
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
            Self::Claimed => "claimed",
            Self::SessionPrepared => "session_prepared",
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
            "claimed" => Some(Self::Claimed),
            "session_prepared" => Some(Self::SessionPrepared),
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
pub struct AutomationWorkspaceScope {
    pub machine_id: MachineId,
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationWaitState {
    Waiting,
    Checking,
    Matched,
    Cancelled,
    Expired,
    Failed,
}

impl AutomationWaitState {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Checking => "checking",
            Self::Matched => "matched",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }

    pub fn from_wire_str(raw: &str) -> Option<Self> {
        match raw {
            "waiting" => Some(Self::Waiting),
            "checking" => Some(Self::Checking),
            "matched" => Some(Self::Matched),
            "cancelled" => Some(Self::Cancelled),
            "expired" => Some(Self::Expired),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunOutcome {
    Exited,
    SpawnFailed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunExit {
    pub ended_at: i64,
    pub outcome: AutomationRunOutcome,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub tail: String,
    pub log_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationManagedRun {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    pub log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<AutomationRunExit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationMatchResult {
    pub resume_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationEvidenceEntry {
    pub source_id: String,
    pub revision: String,
    pub session_id: String,
    pub pr_url: String,
    pub repository: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationReadObservation {
    pub value: Value,
    pub observed_at: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<AutomationEvidenceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWaitRecord {
    pub id: String,
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
    pub owner_user_id: UserId,
    pub owner_machine_id: MachineId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<AutomationManagedRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub interval_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_check_at: i64,
    pub checks: u64,
    pub consecutive_errors: u32,
    pub state: AutomationWaitState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<AutomationMatchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reads: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Vec<AutomationEvidenceEntry>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRegistrationInput {
    pub program: String,
    pub reason: Option<String>,
    pub interval_ms: i64,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunInput {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationReceiptState {
    Accepted,
    Waiting,
    Resolved,
    Submitting,
    Queued,
    Running,
    Blocked,
    Unknown,
    Cancelling,
    Completed,
    Cancelled,
    Dropped,
    Failed,
}

impl AutomationReceiptState {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Waiting => "waiting",
            Self::Resolved => "resolved",
            Self::Submitting => "submitting",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Blocked => "blocked",
            Self::Unknown => "unknown",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Dropped => "dropped",
            Self::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Cancelled | Self::Dropped | Self::Failed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationReceiptRecord {
    pub id: String,
    pub delivery_id: String,
    pub state: AutomationReceiptState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub rule: Value,
    pub event: Value,
    pub intent: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationReceiptPatch {
    pub state: AutomationReceiptState,
    pub reason: Option<String>,
    pub turn_id: Option<TurnId>,
    pub attempts: u32,
    pub retry_at: Option<i64>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationWaitCompletion {
    pub wait_id: String,
    pub reads: Vec<String>,
    pub evidence: Vec<AutomationEvidenceEntry>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationActivityCursor {
    pub updated_at: i64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationActivityPage {
    pub items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<AutomationActivityCursor>,
}

pub trait AutomationStorePort: Send + Sync {
    fn workspace_run_logs_dir(&self, scope: &AutomationWorkspaceScope) -> PathBuf;
    fn register_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        owner_user_id: &UserId,
        input: &AutomationRegistrationInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord>;
    fn register_run(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        owner_user_id: &UserId,
        input: &AutomationRunInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord>;
    fn get_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
    ) -> PortResult<Option<AutomationWaitRecord>>;
    fn list_waits(
        &self,
        scope: &AutomationWorkspaceScope,
        owner_user_id: Option<&UserId>,
        session_id: Option<&SessionId>,
    ) -> PortResult<Vec<AutomationWaitRecord>>;
    fn due_waits(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
        limit: usize,
    ) -> PortResult<Vec<AutomationWaitRecord>>;
    fn claim_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>>;
    fn claim_run_start(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<bool>;
    fn record_run_pid(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        pid: u32,
        now_ms: i64,
    ) -> PortResult<()>;
    fn record_run_exit(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        exit: &AutomationRunExit,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>>;
    fn orphan_started_runs(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
    ) -> PortResult<usize>;
    fn finish_wait_not_ready(
        &self,
        scope: &AutomationWorkspaceScope,
        completion: &AutomationWaitCompletion,
        next_check_at: i64,
    ) -> PortResult<()>;
    fn finish_wait_matched(
        &self,
        scope: &AutomationWorkspaceScope,
        completion: &AutomationWaitCompletion,
        result: &AutomationMatchResult,
    ) -> PortResult<Option<AutomationReceiptRecord>>;
    fn finish_wait_error(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        error_msg: &str,
        failed: bool,
        next_check_at: i64,
        now_ms: i64,
    ) -> PortResult<()>;
    fn expire_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        wait_id: &str,
        now_ms: i64,
    ) -> PortResult<()>;
    fn cancel_item(
        &self,
        scope: &AutomationWorkspaceScope,
        id: &str,
        now_ms: i64,
    ) -> PortResult<Option<Value>>;
    fn get_receipt(
        &self,
        scope: &AutomationWorkspaceScope,
        receipt_id: &str,
    ) -> PortResult<Option<AutomationReceiptRecord>>;
    fn actionable_receipts(
        &self,
        scope: &AutomationWorkspaceScope,
        now_ms: i64,
        limit: usize,
    ) -> PortResult<Vec<AutomationReceiptRecord>>;
    fn update_receipt(
        &self,
        scope: &AutomationWorkspaceScope,
        receipt_id: &str,
        patch: &AutomationReceiptPatch,
    ) -> PortResult<()>;
    fn read_session_settings(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
    ) -> PortResult<Value>;
    fn configure_session_settings(
        &self,
        scope: &AutomationWorkspaceScope,
        session_id: &SessionId,
        user_id: &UserId,
        settings: &Value,
        now_ms: i64,
    ) -> PortResult<Value>;
    fn list_activities(
        &self,
        scope: &AutomationWorkspaceScope,
        owner_user_id: Option<&UserId>,
        session_id: Option<&SessionId>,
        limit: usize,
        before: Option<&AutomationActivityCursor>,
    ) -> PortResult<AutomationActivityPage>;
    fn next_due_at(&self, scope: &AutomationWorkspaceScope) -> PortResult<Option<i64>>;
    fn read_source_checkpoint(
        &self,
        _scope: &AutomationWorkspaceScope,
        _source_id: &str,
    ) -> PortResult<Option<Value>> {
        Ok(None)
    }
    fn write_source_checkpoint(
        &self,
        _scope: &AutomationWorkspaceScope,
        _source_id: &str,
        _checkpoint: &Value,
    ) -> PortResult<()> {
        Ok(())
    }
    fn read_capacity_snapshot(
        &self,
        _scope: &AutomationWorkspaceScope,
        _binding_id: &str,
    ) -> PortResult<Option<Value>> {
        Ok(None)
    }
    fn write_capacity_snapshot(
        &self,
        _scope: &AutomationWorkspaceScope,
        _binding_id: &str,
        _snapshot: &Value,
    ) -> PortResult<()> {
        Ok(())
    }
    fn read_session_events(
        &self,
        _scope: &AutomationWorkspaceScope,
        _session_id: &SessionId,
        _since_ms: i64,
        _limit: usize,
    ) -> PortResult<Vec<Value>> {
        Ok(Vec::new())
    }
    fn erase_workspace_store(&self, scope: &AutomationWorkspaceScope) -> PortResult<()>;
}

#[derive(Default)]
pub struct UnavailableAutomationStore;

impl AutomationStorePort for UnavailableAutomationStore {
    fn workspace_run_logs_dir(&self, _scope: &AutomationWorkspaceScope) -> PathBuf {
        PathBuf::new()
    }
    fn register_wait(
        &self,
        _scope: &AutomationWorkspaceScope,
        _session_id: &SessionId,
        _owner_user_id: &UserId,
        _input: &AutomationRegistrationInput,
        _now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn register_run(
        &self,
        _scope: &AutomationWorkspaceScope,
        _session_id: &SessionId,
        _owner_user_id: &UserId,
        _input: &AutomationRunInput,
        _now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn get_wait(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn list_waits(
        &self,
        _scope: &AutomationWorkspaceScope,
        _owner_user_id: Option<&UserId>,
        _session_id: Option<&SessionId>,
    ) -> PortResult<Vec<AutomationWaitRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn due_waits(
        &self,
        _scope: &AutomationWorkspaceScope,
        _now_ms: i64,
        _limit: usize,
    ) -> PortResult<Vec<AutomationWaitRecord>> {
        Ok(Vec::new())
    }
    fn claim_wait(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        Ok(None)
    }
    fn claim_run_start(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _now_ms: i64,
    ) -> PortResult<bool> {
        Ok(false)
    }
    fn record_run_pid(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _pid: u32,
        _now_ms: i64,
    ) -> PortResult<()> {
        Ok(())
    }
    fn record_run_exit(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _exit: &AutomationRunExit,
        _now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        Ok(None)
    }
    fn orphan_started_runs(
        &self,
        _scope: &AutomationWorkspaceScope,
        _now_ms: i64,
    ) -> PortResult<usize> {
        Ok(0)
    }
    fn finish_wait_not_ready(
        &self,
        _scope: &AutomationWorkspaceScope,
        _completion: &AutomationWaitCompletion,
        _next_check_at: i64,
    ) -> PortResult<()> {
        Ok(())
    }
    fn finish_wait_matched(
        &self,
        _scope: &AutomationWorkspaceScope,
        _completion: &AutomationWaitCompletion,
        _result: &AutomationMatchResult,
    ) -> PortResult<Option<AutomationReceiptRecord>> {
        Ok(None)
    }
    fn finish_wait_error(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _error_msg: &str,
        _failed: bool,
        _next_check_at: i64,
        _now_ms: i64,
    ) -> PortResult<()> {
        Ok(())
    }
    fn expire_wait(
        &self,
        _scope: &AutomationWorkspaceScope,
        _wait_id: &str,
        _now_ms: i64,
    ) -> PortResult<()> {
        Ok(())
    }
    fn cancel_item(
        &self,
        _scope: &AutomationWorkspaceScope,
        _id: &str,
        _now_ms: i64,
    ) -> PortResult<Option<Value>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn get_receipt(
        &self,
        _scope: &AutomationWorkspaceScope,
        _receipt_id: &str,
    ) -> PortResult<Option<AutomationReceiptRecord>> {
        Ok(None)
    }
    fn actionable_receipts(
        &self,
        _scope: &AutomationWorkspaceScope,
        _now_ms: i64,
        _limit: usize,
    ) -> PortResult<Vec<AutomationReceiptRecord>> {
        Ok(Vec::new())
    }
    fn update_receipt(
        &self,
        _scope: &AutomationWorkspaceScope,
        _receipt_id: &str,
        _patch: &AutomationReceiptPatch,
    ) -> PortResult<()> {
        Ok(())
    }
    fn read_session_settings(
        &self,
        _scope: &AutomationWorkspaceScope,
        _session_id: &SessionId,
    ) -> PortResult<Value> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn configure_session_settings(
        &self,
        _scope: &AutomationWorkspaceScope,
        _session_id: &SessionId,
        _user_id: &UserId,
        _settings: &Value,
        _now_ms: i64,
    ) -> PortResult<Value> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn list_activities(
        &self,
        _scope: &AutomationWorkspaceScope,
        _owner_user_id: Option<&UserId>,
        _session_id: Option<&SessionId>,
        _limit: usize,
        _before: Option<&AutomationActivityCursor>,
    ) -> PortResult<AutomationActivityPage> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation store unavailable",
        ))
    }
    fn next_due_at(&self, _scope: &AutomationWorkspaceScope) -> PortResult<Option<i64>> {
        Ok(None)
    }
    fn erase_workspace_store(&self, _scope: &AutomationWorkspaceScope) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPollerScopeBucket {
    pub tokens: f64,
    pub updated_at_ms: i64,
    pub frozen_until_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPollerRepoCooldown {
    pub consecutive_failures: u32,
    pub next_retry_at_ms: i64,
    pub last_error_kind: String,
}

pub trait PrPollerStorePort: Send + Sync {
    fn read_scope(&self, scope: &str) -> PortResult<Option<PrPollerScopeBucket>>;
    fn write_scope(&self, scope: &str, bucket: &PrPollerScopeBucket) -> PortResult<()>;
    fn read_repo_cooldown(&self, key: &str) -> PortResult<Option<PrPollerRepoCooldown>>;
    fn write_repo_cooldown(&self, key: &str, cooldown: &PrPollerRepoCooldown) -> PortResult<()>;
    fn clear_repo_cooldown(&self, key: &str) -> PortResult<()>;
    fn read_target_last_success(&self, key: &str) -> PortResult<Option<i64>>;
    fn write_target_last_success(&self, key: &str, at_ms: i64) -> PortResult<()>;
    fn read_discovery_fingerprint(&self, key: &str) -> PortResult<Option<String>>;
    fn write_discovery_fingerprint(&self, key: &str, fingerprint: &str) -> PortResult<()>;
    fn clear_workspace_state(&self, workspace_id: &WorkspaceId) -> PortResult<()>;
}

#[derive(Default)]
pub struct UnavailablePrPollerStore;

impl PrPollerStorePort for UnavailablePrPollerStore {
    fn read_scope(&self, _scope: &str) -> PortResult<Option<PrPollerScopeBucket>> {
        Ok(None)
    }
    fn write_scope(&self, _scope: &str, _bucket: &PrPollerScopeBucket) -> PortResult<()> {
        Ok(())
    }
    fn read_repo_cooldown(&self, _key: &str) -> PortResult<Option<PrPollerRepoCooldown>> {
        Ok(None)
    }
    fn write_repo_cooldown(&self, _key: &str, _cooldown: &PrPollerRepoCooldown) -> PortResult<()> {
        Ok(())
    }
    fn clear_repo_cooldown(&self, _key: &str) -> PortResult<()> {
        Ok(())
    }
    fn read_target_last_success(&self, _key: &str) -> PortResult<Option<i64>> {
        Ok(None)
    }
    fn write_target_last_success(&self, _key: &str, _at_ms: i64) -> PortResult<()> {
        Ok(())
    }
    fn read_discovery_fingerprint(&self, _key: &str) -> PortResult<Option<String>> {
        Ok(None)
    }
    fn write_discovery_fingerprint(&self, _key: &str, _fingerprint: &str) -> PortResult<()> {
        Ok(())
    }
    fn clear_workspace_state(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Ok(())
    }
}
