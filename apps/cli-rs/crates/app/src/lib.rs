#![forbid(unsafe_code)]

pub use lody_ports::{
    BackendProfile, CapabilitySet, EntitlementStatus, HistoryTurnRecord, LocalProjectId,
    LocalProjectRecord, MachineId, PermissionDecision, PlatformCapability, PortError,
    PortErrorKind, PortResult, ProfileId, SessionId, SessionMetaSnapshot, SteerVerdict,
    StorageLeaseMode, TurnDiffSummary, TurnId, UserId, VerifiedPrincipal, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum AppCommand {
    ConfigureBackendProfile {
        profile: Box<BackendProfile>,
    },
    ClearBackendProfile,
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
        prompt: String,
    },
    SendChat {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
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
        adapter_id: String,
        prompt: String,
    },
    ArchiveSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
    },
}

impl AppCommand {
    pub fn target_workspace(&self) -> Option<&WorkspaceId> {
        match self {
            Self::CreateSession { workspace_id, .. }
            | Self::SendChat { workspace_id, .. }
            | Self::SteerTurn { workspace_id, .. }
            | Self::CancelSession { workspace_id, .. }
            | Self::ReplyPermission { workspace_id, .. }
            | Self::DelegateChildSession { workspace_id, .. }
            | Self::ArchiveSession { workspace_id, .. } => Some(workspace_id),
            Self::ConfigureBackendProfile { .. }
            | Self::ClearBackendProfile
            | Self::RegisterProject { .. } => None,
        }
    }

    pub fn requires_local_host_authority(&self) -> bool {
        matches!(
            self,
            Self::ConfigureBackendProfile { .. }
                | Self::ClearBackendProfile
                | Self::RegisterProject { .. }
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
    ListProjects,
    ListSessions {
        workspace_id: WorkspaceId,
    },
    GetSessionHistory {
        workspace_id: WorkspaceId,
        session_id: SessionId,
    },
    GetTurnDiff {
        session_id: SessionId,
        turn_id: TurnId,
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
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppResponse {
    DaemonStatus(DaemonStatusView),
    ProfileConfigured {
        profile_id: ProfileId,
    },
    ProfileCleared,
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
    SessionHistory {
        turns: Vec<HistoryTurnRecord>,
    },
    TurnDiff {
        diff: Option<TurnDiffSummary>,
    },
}

pub fn enforce_command_policy(
    caller: &VerifiedPrincipal,
    cmd: &AppCommand,
    entitlement: Option<&EntitlementStatus>,
) -> PortResult<()> {
    if cmd.requires_local_host_authority() && caller.is_remote() {
        return Err(PortError::new(
            PortErrorKind::Forbidden,
            "host configuration and local project registration require local host authority",
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
}
