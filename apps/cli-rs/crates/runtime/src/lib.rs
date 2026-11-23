#![forbid(unsafe_code)]
#![deny(clippy::await_holding_lock)]

pub mod actor;
pub mod workspace;

pub use actor::{ControlCommand, SessionHandle, SessionSpawnOptions, spawn_session_actor};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, AttachedWorkspaceView, CapabilitySet,
    CustomCommandSpec, DaemonStatusView, LocalProjectId, PortError, PortErrorKind, PortResult,
    ProfileId, SessionId, StorageLeaseMode, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode,
    enforce_command_policy,
};
use lody_kernel::{FrozenTurnInvocation, KernelEvent, TurnSourceKind};
use lody_ports::{
    AcpLauncherPort, ArtifactRegistryPort, BackendPort, DiffStorePort, EnginePort, HistoryPort,
    InboxStorePort, ProjectStorePort, WorktreePort,
};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::Semaphore;
pub use workspace::{FleetWorkspaceTable, WorkspaceMount};

const DEFAULT_SETTLING_TIMEOUT: Duration = Duration::from_secs(5);

pub struct DaemonDependencies {
    pub storage_lease_mode: StorageLeaseMode,
    pub engine: Arc<dyn EnginePort>,
    pub history: Arc<dyn HistoryPort>,
    pub inbox: Arc<dyn InboxStorePort>,
    pub projects: Arc<dyn ProjectStorePort>,
    pub diff_store: Arc<dyn DiffStorePort>,
    pub artifacts: Arc<dyn ArtifactRegistryPort>,
    pub acp: Arc<dyn AcpLauncherPort>,
    pub worktree: Arc<dyn WorktreePort>,
    pub backend: Option<Arc<dyn BackendPort>>,
}

pub struct DaemonRuntime {
    deps: Arc<DaemonDependencies>,
    acp_start_semaphore: Arc<Semaphore>,
    workspaces: RwLock<FleetWorkspaceTable>,
    settling_timeout: Duration,
    owned_tokio: Option<tokio::runtime::Runtime>,
}

impl DaemonRuntime {
    pub fn new(deps: DaemonDependencies) -> Self {
        Self::with_settling_timeout(deps, DEFAULT_SETTLING_TIMEOUT)
    }

    pub fn with_settling_timeout(deps: DaemonDependencies, settling_timeout: Duration) -> Self {
        let max_starts = deps.acp.max_concurrent_starts().max(1);
        let owned_tokio = tokio::runtime::Handle::try_current().err().and_then(|_| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .ok()
        });
        Self {
            deps: Arc::new(deps),
            acp_start_semaphore: Arc::new(Semaphore::new(max_starts)),
            workspaces: RwLock::new(FleetWorkspaceTable::default()),
            settling_timeout,
            owned_tokio,
        }
    }

    pub fn is_connected_composition(&self) -> bool {
        self.deps.backend.is_some()
    }

    pub fn capabilities(&self) -> CapabilitySet {
        match &self.deps.backend {
            Some(backend) => backend.capabilities().clone(),
            None => CapabilitySet::local_only(),
        }
    }

    pub fn session_handle(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> Option<SessionHandle> {
        self.workspaces
            .read()
            .expect("workspaces lock")
            .get_session(workspace_id, session_id)
    }

    pub fn attach_workspace(
        &self,
        workspace_id: &WorkspaceId,
        explicit_mode: Option<WorkspaceSecurityMode>,
    ) -> PortResult<AttachedWorkspaceView> {
        let mode = match explicit_mode {
            Some(m) => m,
            None => self
                .deps
                .engine
                .read_workspace_security_mode(workspace_id)?,
        };
        self.workspaces
            .write()
            .expect("workspaces lock")
            .attach_or_update(workspace_id, mode)
    }

    pub async fn detach_workspace(
        &self,
        workspace_id: &WorkspaceId,
        erase_local_state: bool,
    ) -> PortResult<usize> {
        let handles = self
            .workspaces
            .write()
            .expect("workspaces lock")
            .begin_detach(workspace_id)
            .unwrap_or_default();

        let drained = handles.len();
        for handle in handles {
            handle.shutdown().await;
        }

        self.workspaces
            .write()
            .expect("workspaces lock")
            .finish_detach(workspace_id);

        if erase_local_state {
            self.deps.inbox.erase_workspace_inbox(workspace_id)?;
            self.deps.history.erase_workspace_turns(workspace_id)?;
        }

        Ok(drained)
    }

    fn ensure_session_actor(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        depth: u8,
        local_project_id: Option<LocalProjectId>,
        use_worktree: bool,
        custom_acp: Option<CustomCommandSpec>,
    ) -> PortResult<SessionHandle> {
        if let Some(existing) = self.session_handle(workspace_id, session_id) {
            return Ok(existing);
        }

        let engine_mode = self
            .deps
            .engine
            .read_workspace_security_mode(workspace_id)?;
        let project_root = match &local_project_id {
            Some(pid) => self.deps.projects.get_project(pid)?.map(|r| r.root_path),
            None => None,
        };

        let mut guard = self.workspaces.write().expect("workspaces lock");
        let mount = guard.get_or_insert_mount(workspace_id, engine_mode)?;
        if let Some(existing) = mount.sessions.get(session_id) {
            return Ok(existing.clone());
        }

        let workspace_encrypted =
            matches!(mount.security_mode, WorkspaceSecurityMode::Encrypted { .. });
        let handle = spawn_session_actor(
            SessionSpawnOptions {
                workspace_id: workspace_id.clone(),
                session_id: session_id.clone(),
                workspace_encrypted,
                depth,
                local_project_id,
                project_root,
                use_worktree,
                custom_acp,
                settling_timeout: self.settling_timeout,
            },
            Arc::clone(&self.deps),
            Arc::clone(&self.acp_start_semaphore),
        );
        mount.sessions.insert(session_id.clone(), handle.clone());
        Ok(handle)
    }

    fn caller_invocation(
        caller: &VerifiedPrincipal,
        turn_id: &str,
        adapter_id: &str,
        prompt: String,
    ) -> FrozenTurnInvocation {
        let requester_user_id = caller
            .effective_user_id()
            .map(|u| u.0.clone())
            .unwrap_or_else(|| "local-host".to_string());
        let signed_intent_verified = matches!(
            caller,
            VerifiedPrincipal::LocalHost { .. } | VerifiedPrincipal::EncryptedMember { .. }
        );
        FrozenTurnInvocation {
            turn_id: turn_id.to_string(),
            requester_user_id,
            prompt_text: prompt,
            source: TurnSourceKind::Human,
            adapter_id: adapter_id.to_string(),
            mcp_selection_digest: "default".to_string(),
            signed_intent_verified,
        }
    }

    pub async fn execute_async(
        &self,
        caller: &VerifiedPrincipal,
        cmd: AppCommand,
    ) -> PortResult<AppResponse> {
        let entitlement = match (&self.deps.backend, cmd.target_workspace()) {
            (Some(backend), Some(ws_id)) => match backend.entitlement() {
                Some(entitlement_port) => Some(entitlement_port.workspace_entitlement(ws_id)?),
                None => None,
            },
            _ => None,
        };
        enforce_command_policy(caller, &cmd, entitlement.as_ref())?;

        match cmd {
            AppCommand::ConfigureBackendProfile { profile } => Ok(AppResponse::ProfileConfigured {
                profile_id: profile.profile_id,
            }),
            AppCommand::ClearBackendProfile => Ok(AppResponse::ProfileCleared),
            AppCommand::AttachWorkspace {
                workspace_id,
                security_mode,
            } => {
                let view = self.attach_workspace(&workspace_id, security_mode)?;
                Ok(AppResponse::WorkspaceAttached(view))
            }
            AppCommand::DetachWorkspace {
                workspace_id,
                erase_local_state,
            } => {
                let drained_sessions = self
                    .detach_workspace(&workspace_id, erase_local_state)
                    .await?;
                Ok(AppResponse::WorkspaceDetached {
                    workspace_id,
                    drained_sessions,
                })
            }
            AppCommand::RegisterProject { name, root_path } => {
                let rec = self.deps.projects.register_project(&name, &root_path)?;
                Ok(AppResponse::ProjectRegistered(rec))
            }
            AppCommand::CreateSession {
                workspace_id,
                session_id,
                turn_id,
                local_project_id,
                use_worktree,
                adapter_id,
                custom_acp,
                prompt,
            } => {
                let handle = self.ensure_session_actor(
                    &workspace_id,
                    &session_id,
                    0,
                    local_project_id,
                    use_worktree,
                    custom_acp,
                )?;
                let invocation = Self::caller_invocation(caller, &turn_id.0, &adapter_id, prompt);
                handle
                    .send_event(KernelEvent::SubmitInput { invocation })
                    .await?;
                Ok(AppResponse::SessionAccepted {
                    session_id,
                    turn_id,
                })
            }
            AppCommand::SendChat {
                workspace_id,
                session_id,
                turn_id,
                custom_acp,
                prompt,
            } => {
                let adapter_id = if custom_acp.is_some() {
                    "custom"
                } else {
                    "default"
                };
                let handle = self.ensure_session_actor(
                    &workspace_id,
                    &session_id,
                    0,
                    None,
                    false,
                    custom_acp.clone(),
                )?;
                if let Some(spec) = custom_acp {
                    handle.set_custom_acp(spec).await?;
                }
                let invocation = Self::caller_invocation(caller, &turn_id.0, adapter_id, prompt);
                handle
                    .send_event(KernelEvent::SubmitInput { invocation })
                    .await?;
                Ok(AppResponse::SessionAccepted {
                    session_id,
                    turn_id,
                })
            }
            AppCommand::SteerTurn {
                workspace_id,
                session_id,
                turn_id,
                prompt,
            } => {
                let handle = self
                    .session_handle(&workspace_id, &session_id)
                    .ok_or_else(|| PortError::new(PortErrorKind::NotFound, "session not active"))?;
                let invocation = Self::caller_invocation(caller, &turn_id.0, "default", prompt);
                let verdict = handle.steer(invocation).await?;
                Ok(AppResponse::TurnSteered {
                    session_id,
                    verdict,
                })
            }
            AppCommand::CancelSession {
                workspace_id,
                session_id,
                pause_inbox,
            } => {
                if let Some(handle) = self.session_handle(&workspace_id, &session_id) {
                    handle.cancel(pause_inbox).await?;
                } else {
                    self.deps
                        .inbox
                        .set_inbox_paused(&workspace_id, &session_id, pause_inbox)?;
                }
                Ok(AppResponse::SessionCancelled { session_id })
            }
            AppCommand::ReplyPermission {
                workspace_id,
                session_id,
                decision,
            } => {
                let request_id = decision.request_id.clone();
                if let Some(handle) = self.session_handle(&workspace_id, &session_id) {
                    handle.reply_permission(decision).await?;
                }
                Ok(AppResponse::PermissionReplied {
                    session_id,
                    request_id,
                })
            }
            AppCommand::DelegateChildSession {
                workspace_id,
                child_session_id,
                turn_id,
                adapter_id,
                prompt,
                ..
            } => {
                let handle = self.ensure_session_actor(
                    &workspace_id,
                    &child_session_id,
                    1,
                    None,
                    false,
                    None,
                )?;
                let mut invocation =
                    Self::caller_invocation(caller, &turn_id.0, &adapter_id, prompt);
                invocation.source = TurnSourceKind::AgentDelegationChat;
                handle
                    .send_event(KernelEvent::SubmitInput { invocation })
                    .await?;
                Ok(AppResponse::SessionAccepted {
                    session_id: child_session_id,
                    turn_id,
                })
            }
            AppCommand::ArchiveSession {
                workspace_id,
                session_id,
            } => {
                let removed = self
                    .workspaces
                    .write()
                    .expect("workspaces lock")
                    .remove_session(&workspace_id, &session_id);
                if let Some(handle) = removed {
                    handle.archive().await?;
                }
                Ok(AppResponse::SessionArchived { session_id })
            }
        }
    }

    pub async fn query_async(
        &self,
        caller: &VerifiedPrincipal,
        query: AppQuery,
    ) -> PortResult<AppResponse> {
        self.query_sync(caller, query)
    }

    pub async fn shutdown(&self) {
        let handles = self
            .workspaces
            .write()
            .expect("workspaces lock")
            .drain_all();
        for handle in handles {
            handle.shutdown().await;
        }
    }

    fn query_sync(&self, _caller: &VerifiedPrincipal, query: AppQuery) -> PortResult<AppResponse> {
        match query {
            AppQuery::DaemonStatus => {
                let (active_profile_id, server_origin) = match &self.deps.backend {
                    Some(backend) => (
                        backend.profile().profile_id.clone(),
                        Some(backend.profile().server_origin.clone()),
                    ),
                    None => (ProfileId::local_default(), None),
                };
                Ok(AppResponse::DaemonStatus(DaemonStatusView {
                    connected: self.is_connected_composition(),
                    active_profile_id,
                    server_origin,
                    storage_lease_mode: self.deps.storage_lease_mode,
                    capabilities: self.capabilities(),
                }))
            }
            AppQuery::ListAttachedWorkspaces => {
                let workspaces = self
                    .workspaces
                    .read()
                    .expect("workspaces lock")
                    .list_views();
                Ok(AppResponse::AttachedWorkspacesListed { workspaces })
            }
            AppQuery::ListProjects => {
                let projects = self.deps.projects.list_projects()?;
                Ok(AppResponse::ProjectsListed { projects })
            }
            AppQuery::ListSessions { .. } => Ok(AppResponse::SessionsListed {
                sessions: Vec::new(),
            }),
            AppQuery::GetSessionHistory {
                workspace_id,
                session_id,
            } => {
                let turns = if workspace_id.0.is_empty() || workspace_id.0 == "*" {
                    self.deps.history.read_turns_by_session_id(&session_id)?
                } else {
                    self.deps
                        .history
                        .read_session_turns(&workspace_id, &session_id)?
                };
                Ok(AppResponse::SessionHistory { turns })
            }
            AppQuery::GetTurnDiff {
                session_id,
                turn_id,
            } => {
                let diff = self.deps.diff_store.read_turn_diff(&session_id, &turn_id)?;
                Ok(AppResponse::TurnDiff { diff })
            }
        }
    }
}

impl ApplicationService for DaemonRuntime {
    fn execute(&self, caller: &VerifiedPrincipal, cmd: AppCommand) -> PortResult<AppResponse> {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            tokio::task::block_in_place(|| handle.block_on(self.execute_async(caller, cmd)))
        } else if let Some(rt) = &self.owned_tokio {
            rt.block_on(self.execute_async(caller, cmd))
        } else {
            Err(PortError::new(
                PortErrorKind::Internal,
                "tokio runtime unavailable",
            ))
        }
    }

    fn query(&self, caller: &VerifiedPrincipal, query: AppQuery) -> PortResult<AppResponse> {
        self.query_sync(caller, query)
    }
}
