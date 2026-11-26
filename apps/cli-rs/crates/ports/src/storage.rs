#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::execution::{CustomCommandSpec, LocalProjectGitSummary};
use crate::identity::{LocalProjectId, SessionId, TurnId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_SCHEDULE_PROMPT_BYTES: usize = 32 * 1024;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub workspace_id: WorkspaceId,
    pub session_id: Option<SessionId>,
    pub author_user_id: UserId,
    pub title: String,
    pub cron_expr: String,
    pub prompt_text: String,
    pub enabled: bool,
    pub content_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEditPatch {
    pub title: Option<String>,
    pub prompt_text: Option<String>,
    pub cron_expr: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleProposalOutcome {
    pub proposal_id: String,
    pub schedule_id: Option<String>,
    pub request_id: String,
    pub base_revision: Option<u64>,
    pub status: String,
}

pub trait ScheduleStorePort: Send + Sync {
    fn list_schedules(
        &self,
        workspace_id: &WorkspaceId,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> PortResult<Vec<ScheduleRecord>>;
    fn get_schedule(
        &self,
        workspace_id: &WorkspaceId,
        schedule_id: &str,
    ) -> PortResult<Option<ScheduleRecord>>;
    fn upsert_schedule(&self, record: &ScheduleRecord) -> PortResult<()>;
    fn propose_schedule(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        request_id: &str,
        title: &str,
        prompt_text: &str,
        cron_expr: &str,
    ) -> PortResult<ScheduleProposalOutcome>;
    fn propose_schedule_edit(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
        patch: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome>;
    fn pause_schedule(
        &self,
        workspace_id: &WorkspaceId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
    ) -> PortResult<bool>;
}

#[derive(Default)]
pub struct UnavailableScheduleStore;

impl ScheduleStorePort for UnavailableScheduleStore {
    fn list_schedules(
        &self,
        _workspace_id: &WorkspaceId,
        _query: Option<&str>,
        _limit: usize,
        _offset: usize,
    ) -> PortResult<Vec<ScheduleRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
        ))
    }

    fn get_schedule(
        &self,
        _workspace_id: &WorkspaceId,
        _schedule_id: &str,
    ) -> PortResult<Option<ScheduleRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
        ))
    }

    fn upsert_schedule(&self, _record: &ScheduleRecord) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
        ))
    }

    fn propose_schedule(
        &self,
        _workspace_id: &WorkspaceId,
        _author: &UserId,
        _request_id: &str,
        _title: &str,
        _prompt_text: &str,
        _cron_expr: &str,
    ) -> PortResult<ScheduleProposalOutcome> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
        ))
    }

    fn propose_schedule_edit(
        &self,
        _workspace_id: &WorkspaceId,
        _author: &UserId,
        _schedule_id: &str,
        _request_id: &str,
        _patch: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
        ))
    }

    fn pause_schedule(
        &self,
        _workspace_id: &WorkspaceId,
        _author: &UserId,
        _schedule_id: &str,
        _request_id: &str,
    ) -> PortResult<bool> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule store unavailable",
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
