#![forbid(unsafe_code)]

pub use lody_ports::{
    BackendProfile, CapabilitySet, CustomCommandSpec, DiffFileEntry, EntitlementStatus,
    HistoryBlock, HistoryTurnRecord, LocalProjectId, LocalProjectRecord, MachineId, McpHttpHeader,
    PermissionDecision, PlatformCapability, PortError, PortErrorKind, PortResult, ProfileId,
    ScannedFileEntry, ScannedFileIndex, SessionId, SessionMetaSnapshot, SteerVerdict,
    StorageLeaseMode, TERMINAL_MAX_PER_SESSION, TerminalAttachReplay, TerminalEventSink,
    TerminalOpenOutcome, TerminalOutboundEvent, TerminalSnapshot, TurnDiffSummary, TurnId,
    TurnTerminalOutcome, UserId, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHttpEndpointConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRuntimeStatus {
    pub session_id: SessionId,
    pub execution_state: String,
    pub phase: String,
    pub active_turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum AppCommand {
    ConfigureBackendProfile {
        profile: Box<BackendProfile>,
    },
    ClearBackendProfile,
    AttachWorkspace {
        workspace_id: WorkspaceId,
        security_mode: Option<WorkspaceSecurityMode>,
    },
    DetachWorkspace {
        workspace_id: WorkspaceId,
        erase_local_state: bool,
    },
    RegisterProject {
        name: String,
        root_path: PathBuf,
    },
    CreateSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
        local_project_id: Option<LocalProjectId>,
        use_worktree: bool,
        adapter_id: String,
        custom_acp: Option<CustomCommandSpec>,
        prompt: String,
    },
    SendChat {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
        custom_acp: Option<CustomCommandSpec>,
        prompt: String,
    },
    SteerTurn {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
        prompt: String,
    },
    CancelSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        pause_inbox: bool,
    },
    ReplyPermission {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        decision: PermissionDecision,
    },
    DelegateChildSession {
        workspace_id: WorkspaceId,
        parent_session_id: SessionId,
        child_session_id: SessionId,
        turn_id: TurnId,
        operation_id: Option<String>,
        adapter_id: String,
        custom_acp: Option<CustomCommandSpec>,
        prompt: String,
    },
    ArchiveSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
    },
    TerminalOpen {
        session_id: SessionId,
        cols: u16,
        rows: u16,
    },
    TerminalAttach {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    TerminalInput {
        terminal_id: String,
        data: String,
    },
    TerminalResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    TerminalClose {
        terminal_id: String,
    },
    TerminalCloseSession {
        session_id: SessionId,
    },
}

impl AppCommand {
    pub fn target_workspace(&self) -> Option<&WorkspaceId> {
        match self {
            Self::AttachWorkspace { workspace_id, .. }
            | Self::DetachWorkspace { workspace_id, .. }
            | Self::CreateSession { workspace_id, .. }
            | Self::SendChat { workspace_id, .. }
            | Self::SteerTurn { workspace_id, .. }
            | Self::CancelSession { workspace_id, .. }
            | Self::ReplyPermission { workspace_id, .. }
            | Self::DelegateChildSession { workspace_id, .. }
            | Self::ArchiveSession { workspace_id, .. } => Some(workspace_id),
            Self::ConfigureBackendProfile { .. }
            | Self::ClearBackendProfile
            | Self::RegisterProject { .. }
            | Self::TerminalOpen { .. }
            | Self::TerminalAttach { .. }
            | Self::TerminalInput { .. }
            | Self::TerminalResize { .. }
            | Self::TerminalClose { .. }
            | Self::TerminalCloseSession { .. } => None,
        }
    }

    pub fn requires_local_host_authority(&self) -> bool {
        matches!(
            self,
            Self::ConfigureBackendProfile { .. }
                | Self::ClearBackendProfile
                | Self::AttachWorkspace { .. }
                | Self::DetachWorkspace { .. }
                | Self::RegisterProject { .. }
                | Self::TerminalOpen { .. }
                | Self::TerminalAttach { .. }
                | Self::TerminalInput { .. }
                | Self::TerminalResize { .. }
                | Self::TerminalClose { .. }
                | Self::TerminalCloseSession { .. }
        )
    }

    pub fn is_new_remote_dispatch(&self, caller: &VerifiedPrincipal) -> bool {
        caller.is_remote()
            && matches!(
                self,
                Self::CreateSession { .. }
                    | Self::SendChat { .. }
                    | Self::SteerTurn { .. }
                    | Self::DelegateChildSession { .. }
            )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum AppQuery {
    DaemonStatus,
    ListAttachedWorkspaces,
    ListProjects,
    ListSessions {
        workspace_id: WorkspaceId,
    },
    GetSessionStatuses {
        workspace_id: WorkspaceId,
        session_ids: Vec<SessionId>,
    },
    GetSessionHistory {
        workspace_id: WorkspaceId,
        session_id: SessionId,
    },
    GetTurnDiff {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
    },
    ScanProjectFiles {
        root_path: PathBuf,
    },
    ListTerminals {
        session_id: SessionId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonStatusView {
    pub connected: bool,
    pub active_profile_id: ProfileId,
    pub server_origin: Option<String>,
    pub storage_lease_mode: StorageLeaseMode,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachedWorkspaceView {
    pub workspace_id: WorkspaceId,
    pub security_mode: WorkspaceSecurityMode,
    pub active_session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppResponse {
    DaemonStatus(DaemonStatusView),
    ProfileConfigured {
        profile_id: ProfileId,
    },
    ProfileCleared,
    WorkspaceAttached(AttachedWorkspaceView),
    WorkspaceDetached {
        workspace_id: WorkspaceId,
        drained_sessions: usize,
    },
    AttachedWorkspacesListed {
        workspaces: Vec<AttachedWorkspaceView>,
    },
    ProjectRegistered(LocalProjectRecord),
    ProjectsListed {
        projects: Vec<LocalProjectRecord>,
    },
    SessionAccepted {
        session_id: SessionId,
        turn_id: TurnId,
    },
    TurnSteered {
        session_id: SessionId,
        verdict: SteerVerdict,
    },
    SessionCancelled {
        session_id: SessionId,
    },
    PermissionReplied {
        session_id: SessionId,
        request_id: String,
    },
    SessionArchived {
        session_id: SessionId,
    },
    SessionsListed {
        sessions: Vec<SessionMetaSnapshot>,
    },
    SessionStatuses {
        statuses: Vec<SessionRuntimeStatus>,
    },
    SessionHistory {
        turns: Vec<HistoryTurnRecord>,
    },
    TurnDiff {
        diff: Option<TurnDiffSummary>,
    },
    ProjectFilesScanned {
        index: ScannedFileIndex,
    },
    TerminalsListed {
        session_id: SessionId,
        terminals: Vec<TerminalSnapshot>,
    },
    TerminalOpened(TerminalOpenOutcome),
    TerminalAttached(TerminalAttachReplay),
    TerminalAck,
}

pub fn enforce_command_policy(
    caller: &VerifiedPrincipal,
    cmd: &AppCommand,
    entitlement: Option<&EntitlementStatus>,
) -> PortResult<()> {
    if cmd.requires_local_host_authority() && caller.is_remote() {
        return Err(PortError::new(
            PortErrorKind::Forbidden,
            "host configuration, workspace mount control, local terminals, and local project registration require local host authority",
        ));
    }

    if cmd.is_new_remote_dispatch(caller)
        && let Some(EntitlementStatus::ExpiredReadOnly { reason }) = entitlement
    {
        return Err(PortError::entitlement_read_only(reason.clone()));
    }

    Ok(())
}

pub trait ApplicationService: Send + Sync {
    fn execute(&self, caller: &VerifiedPrincipal, cmd: AppCommand) -> PortResult<AppResponse>;
    fn query(&self, caller: &VerifiedPrincipal, query: AppQuery) -> PortResult<AppResponse>;
    fn set_mcp_http_endpoint(&self, _endpoint: McpHttpEndpointConfig) {}
    fn register_terminal_sink(&self, _sink_id: u64, _sink: Arc<dyn TerminalEventSink>) {}
    fn unregister_terminal_sink(&self, _sink_id: u64) {}
    fn drain_for_shutdown(&self) {}
}
