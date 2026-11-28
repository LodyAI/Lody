#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::identity::{
    LocalProjectId, MachineId, SessionId, TurnId, UserId, WorkspaceId, WorkspaceSecurityMode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SCHEDULE_PROMPT_BYTES: usize = 32 * 1024;

pub fn validate_schedule_identifier(label: &str, raw: &str) -> PortResult<String> {
    let trimmed = raw.trim();
    let valid = !trimmed.is_empty()
        && trimmed.len() <= 50
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("{label} must be 1..=50 ASCII [a-zA-Z0-9_-] characters"),
        ));
    }
    Ok(trimmed.to_string())
}

pub fn validate_schedule_title(raw: &str) -> PortResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule title must be 1..=200 non-blank characters",
        ));
    }
    Ok(trimmed.to_string())
}

pub fn validate_schedule_prompt(raw: &str) -> PortResult<()> {
    if raw.trim().is_empty() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule prompt cannot be blank",
        ));
    }
    if raw.len() > MAX_SCHEDULE_PROMPT_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("schedule prompt exceeds {MAX_SCHEDULE_PROMPT_BYTES} bytes"),
        ));
    }
    Ok(())
}

pub fn validate_schedule_rule(rule: &Value) -> PortResult<()> {
    let Some(obj) = rule.as_object() else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule rule must be a structured named rule object, not a raw cron string",
        ));
    };
    if obj.is_empty() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "schedule rule object cannot be empty",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRunStatus {
    Idle,
    Preparing,
    Running,
    Settling,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnTerminalOutcome {
    Finished,
    Canceled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMetaSnapshot {
    pub workspace_id: WorkspaceId,
    pub session_id: SessionId,
    pub root_session_id: SessionId,
    pub owner_user_id: UserId,
    pub owner_machine_id: MachineId,
    pub deleted: bool,
    pub local_project_id: Option<LocalProjectId>,
    pub base_branch: Option<String>,
    pub title: Option<String>,
    pub status: SessionRunStatus,
    pub queue_paused: bool,
    pub queued_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedDraftItem {
    pub turn_id: TurnId,
    pub author_user_id: UserId,
    pub prompt_text: String,
    pub signature_hex: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryBlock {
    Text {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        status: String,
    },
    PermissionRequest {
        request_id: String,
        tool_call_id: String,
        resolved_option_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTurnRecord {
    pub turn_id: TurnId,
    pub author_user_id: Option<UserId>,
    pub user_prompt: String,
    pub assistant_blocks: Vec<HistoryBlock>,
    pub outcome: Option<TurnTerminalOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EpochKeyMaterial {
    pub epoch: u64,
    pub key_bytes: Vec<u8>,
}

pub trait EnginePort: Send + Sync {
    fn is_connected(&self) -> bool;
    fn read_workspace_security_mode(
        &self,
        workspace_id: &WorkspaceId,
    ) -> PortResult<WorkspaceSecurityMode>;
    fn read_session_meta(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>>;
    fn upsert_session_meta(&self, meta: &SessionMetaSnapshot) -> PortResult<()>;
    fn promote_next_queued_draft(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Option<QueuedDraftItem>>;
    fn set_message_queue_paused(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        paused: bool,
    ) -> PortResult<()>;
    fn install_workspace_epoch_keys(
        &self,
        workspace_id: &WorkspaceId,
        keys: &[EpochKeyMaterial],
    ) -> PortResult<()>;
}

pub trait HistoryPort: Send + Sync {
    fn backend_name(&self) -> &'static str;
    fn is_user_turn_durable(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> PortResult<bool>;
    fn read_session_turns(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>>;
    fn read_turns_by_session_id(
        &self,
        session_id: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>> {
        self.read_session_turns(&WorkspaceId("local".to_string()), session_id)
    }
    fn upsert_turn_record(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        record: &HistoryTurnRecord,
    ) -> PortResult<()>;
    fn erase_workspace_turns(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleMisfirePolicy {
    #[default]
    Skip,
    RunOnce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleOverlapPolicy {
    #[default]
    Skip,
    QueueOne,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleDestination {
    NewSession,
    OwnSession {
        epoch: u64,
    },
    ExistingSession {
        #[serde(rename = "sessionId")]
        session_id: SessionId,
    },
}

impl Default for ScheduleDestination {
    fn default() -> Self {
        Self::OwnSession { epoch: 0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRetryPolicy {
    pub max_attempts: u32,
    pub dispatch_max_age_ms: i64,
}

impl Default for ScheduleRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            dispatch_max_age_ms: 3_600_000,
        }
    }
}

fn default_schedule_machine_id() -> MachineId {
    MachineId("local".to_string())
}

fn default_schedule_activation_id() -> String {
    "act_default".to_string()
}

fn default_schedule_adapter_id() -> String {
    "codex".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub workspace_id: WorkspaceId,
    pub session_id: Option<SessionId>,
    pub author_user_id: UserId,
    #[serde(default = "default_schedule_machine_id")]
    pub machine_id: MachineId,
    pub title: String,
    pub rule: Value,
    pub prompt_text: String,
    pub enabled: bool,
    #[serde(default = "default_schedule_activation_id")]
    pub activation_id: String,
    #[serde(default)]
    pub active_from: i64,
    #[serde(default)]
    pub misfire_policy: ScheduleMisfirePolicy,
    #[serde(default)]
    pub overlap_policy: ScheduleOverlapPolicy,
    #[serde(default)]
    pub destination: ScheduleDestination,
    #[serde(default)]
    pub retry_policy: ScheduleRetryPolicy,
    #[serde(default = "default_schedule_adapter_id")]
    pub adapter_id: String,
    #[serde(default)]
    pub definition_fingerprint: String,
    pub content_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEditPatch {
    pub title: Option<String>,
    pub prompt_text: Option<String>,
    pub rule: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleProposalInput {
    pub workspace_id: WorkspaceId,
    pub invoking_session_id: SessionId,
    pub author: UserId,
    pub request_id: String,
    pub title: String,
    pub prompt_text: String,
    pub rule: Value,
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

pub trait ScheduleRepoPort: Send + Sync {
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
    fn propose_schedule(
        &self,
        input: &ScheduleProposalInput,
    ) -> PortResult<ScheduleProposalOutcome>;
    fn propose_schedule_edit(
        &self,
        workspace_id: &WorkspaceId,
        invoking_session_id: &SessionId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
        patch: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome>;
    fn pause_schedule(
        &self,
        workspace_id: &WorkspaceId,
        invoking_session_id: Option<&SessionId>,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
    ) -> PortResult<bool>;
}

#[derive(Default)]
pub struct UnavailableScheduleRepo;

impl ScheduleRepoPort for UnavailableScheduleRepo {
    fn list_schedules(
        &self,
        _workspace_id: &WorkspaceId,
        _query: Option<&str>,
        _limit: usize,
        _offset: usize,
    ) -> PortResult<Vec<ScheduleRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule repository unavailable",
        ))
    }

    fn get_schedule(
        &self,
        _workspace_id: &WorkspaceId,
        _schedule_id: &str,
    ) -> PortResult<Option<ScheduleRecord>> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule repository unavailable",
        ))
    }

    fn propose_schedule(
        &self,
        _input: &ScheduleProposalInput,
    ) -> PortResult<ScheduleProposalOutcome> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule repository unavailable",
        ))
    }

    fn propose_schedule_edit(
        &self,
        _workspace_id: &WorkspaceId,
        _invoking_session_id: &SessionId,
        _author: &UserId,
        _schedule_id: &str,
        _request_id: &str,
        _patch: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule repository unavailable",
        ))
    }

    fn pause_schedule(
        &self,
        _workspace_id: &WorkspaceId,
        _invoking_session_id: Option<&SessionId>,
        _author: &UserId,
        _schedule_id: &str,
        _request_id: &str,
    ) -> PortResult<bool> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "schedule repository unavailable",
        ))
    }
}
