#![forbid(unsafe_code)]

use crate::error::PortResult;
use crate::identity::{
    LocalProjectId, MachineId, SessionId, TurnId, UserId, WorkspaceId, WorkspaceSecurityMode,
};
use serde::{Deserialize, Serialize};

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
    pub owner_machine_id: MachineId,
    pub local_project_id: Option<LocalProjectId>,
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
}
