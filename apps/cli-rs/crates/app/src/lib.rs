#![forbid(unsafe_code)]

pub use lody_ports::{
    AnchorSyncStatus, AutomationActivityCursor, AutomationActivityPage,
    AutomationRegistrationInput, AutomationRunInput, AutomationWaitRecord, BackendProfile,
    BranchListPage, BranchListQuery, BrowseDirectoryEntry, BrowseDirectoryPage,
    BrowseDirectoryQuery, BrowseEntryHints, BrowseRootsInfo, CapabilitySet, CheckoutBranchOutcome,
    CustomCommandSpec, DiffCaptureScope, DiffFileEntry, DirectoryChildEntry, DirectoryListPage,
    EntitlementStatus, FileSearchResult, HistoryBlock, HistoryTurnRecord, LocalProjectGitSummary,
    LocalProjectId, LocalProjectRecord, MAX_SCHEDULE_PROMPT_BYTES, MachineId,
    MachineIdentityRestoreOutcome, McpEnvVar, McpHttpHeader, McpServerMount, McpServerTransport,
    PermissionDecision, PlatformCapability, PortError, PortErrorKind, PortResult,
    PreparedProjectAdd, ProfileId, ProjectFileReadResult, ProjectSkillEntry,
    ProjectSkillGroupEntry, ProjectSkillsListing, ScannedFileEntry, ScannedFileIndex,
    ScheduleEditPatch, ScheduleProposalOutcome, ScheduleRecord, SessionId, SessionMetaSnapshot,
    SteerVerdict, StorageLeaseMode, TERMINAL_MAX_PER_SESSION, TerminalAttachReplay,
    TerminalEventSink, TerminalOpenOutcome, TerminalOutboundEvent, TerminalSnapshot,
    TurnDiffSummary, TurnId, TurnTerminalOutcome, UserId, VerifiedPrincipal, WorkspaceId,
    WorkspaceSecurityMode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    RestoreMachineId {
        target_machine_id: String,
        active_host_pid: Option<u32>,
    },
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
    CreateLocalDirectory {
        parent_path: PathBuf,
        name: String,
    },
    CheckoutProjectBranch {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        branch_name: String,
    },
    CreateSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
        local_project_id: Option<LocalProjectId>,
        base_branch: Option<String>,
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
    ProposeSchedule {
        workspace_id: WorkspaceId,
        invoking_session_id: SessionId,
        request_id: String,
        title: String,
        prompt_text: String,
        rule: Value,
    },
    ProposeScheduleEdit {
        workspace_id: WorkspaceId,
        invoking_session_id: SessionId,
        schedule_id: String,
        request_id: String,
        patch: ScheduleEditPatch,
    },
    PauseSchedule {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        schedule_id: String,
        request_id: String,
    },
    AutomationRegister {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
        registration: AutomationRegistrationInput,
    },
    AutomationRun {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
        run_spec: AutomationRunInput,
    },
    AutomationConfigure {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
        settings: Value,
    },
    AutomationCancel {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        item_id: String,
    },
    TickWorkspaceSchedulers {
        workspace_id: WorkspaceId,
        now_ms: Option<i64>,
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
            | Self::ArchiveSession { workspace_id, .. }
            | Self::ProposeSchedule { workspace_id, .. }
            | Self::ProposeScheduleEdit { workspace_id, .. }
            | Self::PauseSchedule { workspace_id, .. }
            | Self::AutomationRegister { workspace_id, .. }
            | Self::AutomationRun { workspace_id, .. }
            | Self::AutomationConfigure { workspace_id, .. }
            | Self::AutomationCancel { workspace_id, .. }
            | Self::TickWorkspaceSchedulers { workspace_id, .. }
            | Self::CheckoutProjectBranch { workspace_id, .. } => Some(workspace_id),
            Self::ConfigureBackendProfile { .. }
            | Self::ClearBackendProfile
            | Self::RestoreMachineId { .. }
            | Self::RegisterProject { .. }
            | Self::CreateLocalDirectory { .. }
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
                | Self::RestoreMachineId { .. }
                | Self::AttachWorkspace { .. }
                | Self::DetachWorkspace { .. }
                | Self::RegisterProject { .. }
                | Self::CreateLocalDirectory { .. }
                | Self::CheckoutProjectBranch { .. }
                | Self::TickWorkspaceSchedulers { .. }
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
                    | Self::ProposeSchedule { .. }
                    | Self::ProposeScheduleEdit { .. }
                    | Self::AutomationRegister { .. }
                    | Self::AutomationRun { .. }
                    | Self::AutomationConfigure { .. }
            )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "query", rename_all = "snake_case")]
pub enum AppQuery {
    DaemonStatus,
    MachineIdentity,
    ListAttachedWorkspaces,
    ListProjects,
    PrepareProjectAdd {
        root_path: PathBuf,
        inspect: bool,
    },
    ListBrowseRoots {
        home_dir: PathBuf,
    },
    BrowseLocalDirectory {
        home_dir: PathBuf,
        browse_query: BrowseDirectoryQuery,
    },
    InspectProjectGitSummary {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
    },
    ListProjectBranches {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        branch_query: BranchListQuery,
    },
    SearchProjectFiles {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        search_query: String,
        limit: usize,
    },
    ListProjectFiles {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        max_files: usize,
    },
    ListProjectDirectory {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        relative_path: String,
        limit: usize,
    },
    ReadProjectFile {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        relative_path: String,
        max_bytes: usize,
    },
    ListProjectSkills {
        workspace_id: WorkspaceId,
        local_project_id: Option<LocalProjectId>,
        root_path: Option<PathBuf>,
        skill_dirs: Vec<String>,
        known_fingerprint: Option<String>,
    },
    ListGlobalSkills {
        home_dir: PathBuf,
        known_fingerprint: Option<String>,
    },
    ListWorktreeFiles {
        workspace_id: WorkspaceId,
        repo_key: String,
        session_id: SessionId,
        max_files: usize,
    },
    ReadWorktreeFile {
        workspace_id: WorkspaceId,
        repo_key: String,
        session_id: SessionId,
        relative_path: String,
        max_bytes: usize,
    },
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
    ListSchedules {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        filter_query: Option<String>,
        limit: usize,
        offset: usize,
    },
    GetSchedule {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        schedule_id: String,
    },
    AutomationSettings {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
    },
    AutomationList {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
    },
    AutomationShow {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        item_id: String,
    },
    AutomationActivities {
        workspace_id: WorkspaceId,
        invoking_session_id: Option<SessionId>,
        target_session_id: Option<SessionId>,
        limit: usize,
        before: Option<AutomationActivityCursor>,
    },
    ListTerminals {
        session_id: SessionId,
    },
}

impl AppQuery {
    pub fn target_workspace(&self) -> Option<&WorkspaceId> {
        match self {
            Self::InspectProjectGitSummary { workspace_id, .. }
            | Self::ListProjectBranches { workspace_id, .. }
            | Self::SearchProjectFiles { workspace_id, .. }
            | Self::ListProjectFiles { workspace_id, .. }
            | Self::ListProjectDirectory { workspace_id, .. }
            | Self::ReadProjectFile { workspace_id, .. }
            | Self::ListProjectSkills { workspace_id, .. }
            | Self::ListWorktreeFiles { workspace_id, .. }
            | Self::ReadWorktreeFile { workspace_id, .. }
            | Self::ListSessions { workspace_id }
            | Self::GetSessionStatuses { workspace_id, .. }
            | Self::GetSessionHistory { workspace_id, .. }
            | Self::GetTurnDiff { workspace_id, .. }
            | Self::ListSchedules { workspace_id, .. }
            | Self::GetSchedule { workspace_id, .. }
            | Self::AutomationSettings { workspace_id, .. }
            | Self::AutomationList { workspace_id, .. }
            | Self::AutomationShow { workspace_id, .. }
            | Self::AutomationActivities { workspace_id, .. } => Some(workspace_id),
            Self::DaemonStatus
            | Self::MachineIdentity
            | Self::ListAttachedWorkspaces
            | Self::ListProjects
            | Self::PrepareProjectAdd { .. }
            | Self::ListBrowseRoots { .. }
            | Self::BrowseLocalDirectory { .. }
            | Self::ListGlobalSkills { .. }
            | Self::ScanProjectFiles { .. }
            | Self::ListTerminals { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonStatusView {
    pub machine_id: MachineId,
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
    MachineIdentity {
        machine_id: MachineId,
    },
    MachineIdRestored(MachineIdentityRestoreOutcome),
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
    ProjectAddPrepared(PreparedProjectAdd),
    BrowseRootsListed(BrowseRootsInfo),
    LocalDirectoryBrowsed(BrowseDirectoryPage),
    LocalDirectoryCreated {
        path: PathBuf,
    },
    ProjectsListed {
        projects: Vec<LocalProjectRecord>,
    },
    ProjectGitSummary(LocalProjectGitSummary),
    ProjectBranchesListed(BranchListPage),
    ProjectBranchCheckedOut(CheckoutBranchOutcome),
    ProjectFilesSearched(FileSearchResult),
    ProjectFilesListed(FileSearchResult),
    ProjectDirectoryListed(DirectoryListPage),
    ProjectFileRead {
        file: Option<ProjectFileReadResult>,
    },
    ProjectSkillsListed(ProjectSkillsListing),
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
    SchedulesListed {
        schedules: Vec<ScheduleRecord>,
    },
    ScheduleRead {
        schedule: Option<ScheduleRecord>,
    },
    ScheduleProposed(ScheduleProposalOutcome),
    SchedulePaused {
        schedule_id: String,
        changed: bool,
    },
    AutomationResult {
        payload: Value,
    },
    SchedulersTicked {
        next_wake_ms: Option<i64>,
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
    if cmd.requires_local_host_authority() && !caller.has_local_host_authority() {
        return Err(PortError::new(
            PortErrorKind::Forbidden,
            "host configuration, machine identity restore, workspace mount control, local terminals, and local project registration require local host authority",
        ));
    }

    if let VerifiedPrincipal::AgentSession {
        workspace_id: caller_ws,
        session_id: caller_sid,
        ..
    } = caller
    {
        if let Some(target_ws) = cmd.target_workspace()
            && target_ws != caller_ws
        {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "agent session principal cannot execute commands in another workspace",
            ));
        }

        match cmd {
            AppCommand::DelegateChildSession {
                parent_session_id, ..
            } if parent_session_id != caller_sid => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "agent session principal can only delegate from its own invoking session",
                ));
            }
            AppCommand::ProposeSchedule {
                invoking_session_id,
                ..
            }
            | AppCommand::ProposeScheduleEdit {
                invoking_session_id,
                ..
            } if invoking_session_id != caller_sid => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            AppCommand::PauseSchedule {
                invoking_session_id,
                ..
            } if invoking_session_id.as_ref() != Some(caller_sid) => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            AppCommand::AutomationRegister {
                invoking_session_id,
                ..
            }
            | AppCommand::AutomationRun {
                invoking_session_id,
                ..
            }
            | AppCommand::AutomationConfigure {
                invoking_session_id,
                ..
            }
            | AppCommand::AutomationCancel {
                invoking_session_id,
                ..
            } if invoking_session_id.as_ref() != Some(caller_sid) => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "AUTOMATION_PERMISSION_DENIED",
                ));
            }
            _ => {}
        }
    }

    if cmd.is_new_remote_dispatch(caller)
        && let Some(EntitlementStatus::ExpiredReadOnly { reason }) = entitlement
    {
        return Err(PortError::entitlement_read_only(reason.clone()));
    }

    Ok(())
}

pub fn enforce_query_policy(caller: &VerifiedPrincipal, query: &AppQuery) -> PortResult<()> {
    if let VerifiedPrincipal::AgentSession {
        workspace_id: caller_ws,
        session_id: caller_sid,
        ..
    } = caller
    {
        if let Some(target_ws) = query.target_workspace()
            && target_ws.0 != "*"
            && target_ws != caller_ws
        {
            return Err(PortError::new(
                PortErrorKind::Forbidden,
                "agent session principal cannot query another workspace",
            ));
        }

        match query {
            AppQuery::PrepareProjectAdd { .. }
            | AppQuery::ListBrowseRoots { .. }
            | AppQuery::BrowseLocalDirectory { .. }
            | AppQuery::ListGlobalSkills { .. } => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "host filesystem browse queries require local host or workspace member authority",
                ));
            }
            AppQuery::ListSchedules {
                invoking_session_id,
                ..
            }
            | AppQuery::GetSchedule {
                invoking_session_id,
                ..
            } if invoking_session_id.as_ref() != Some(caller_sid) => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            AppQuery::AutomationSettings {
                invoking_session_id,
                ..
            }
            | AppQuery::AutomationList {
                invoking_session_id,
                ..
            }
            | AppQuery::AutomationShow {
                invoking_session_id,
                ..
            }
            | AppQuery::AutomationActivities {
                invoking_session_id,
                ..
            } if invoking_session_id.as_ref() != Some(caller_sid) => {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "AUTOMATION_PERMISSION_DENIED",
                ));
            }
            _ => {}
        }
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
