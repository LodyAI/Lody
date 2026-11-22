#![forbid(unsafe_code)]

use crate::error::PortResult;
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
    pub default_branch: Option<String>,
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
        session_id: &SessionId,
        turn_id: &TurnId,
        workdir: &std::path::Path,
    ) -> PortResult<TurnDiffSummary>;
    fn read_turn_diff(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> PortResult<Option<TurnDiffSummary>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub workspace_id: WorkspaceId,
    pub session_id: Option<SessionId>,
    pub author_user_id: UserId,
    pub cron_expr: String,
    pub prompt_text: String,
    pub enabled: bool,
}

pub trait ScheduleStorePort: Send + Sync {
    fn list_schedules(&self, workspace_id: &WorkspaceId) -> PortResult<Vec<ScheduleRecord>>;
    fn upsert_schedule(&self, record: &ScheduleRecord) -> PortResult<()>;
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
