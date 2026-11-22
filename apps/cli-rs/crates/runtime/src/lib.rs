#![forbid(unsafe_code)]
#![deny(clippy::await_holding_lock)]

pub mod actor;

pub use actor::{ControlCommand, SessionHandle, SessionSpawnOptions, spawn_session_actor};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, CapabilitySet, DaemonStatusView,
    LocalProjectId, LocalProjectRecord, PortError, PortErrorKind, PortResult, ProfileId, SessionId,
    StorageLeaseMode, VerifiedPrincipal, WorkspaceId, enforce_command_policy,
};
use lody_kernel::{FrozenTurnInvocation, KernelEvent, TurnSourceKind};
use lody_ports::{
    AcpLauncherPort, ArtifactRegistryPort, BackendPort, DiffStorePort, EnginePort, HistoryPort,
    InboxStorePort, WorkspaceSecurityMode, WorktreePort,
};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::Semaphore;

const DEFAULT_SETTLING_TIMEOUT: Duration = Duration::from_secs(5);

pub struct DaemonDependencies {
    pub storage_lease_mode: StorageLeaseMode,
    pub engine: Arc<dyn EnginePort>,
    pub history: Arc<dyn HistoryPort>,
    pub inbox: Arc<dyn InboxStorePort>,
    pub diff_store: Arc<dyn DiffStorePort>,
    pub artifacts: Arc<dyn ArtifactRegistryPort>,
    pub acp: Arc<dyn AcpLauncherPort>,
    pub worktree: Arc<dyn WorktreePort>,
    pub backend: Option<Arc<dyn BackendPort>>,
}

pub struct DaemonRuntime {
    deps: Arc<DaemonDependencies>,
    acp_start_semaphore: Arc<Semaphore>,
    sessions: RwLock<HashMap<(WorkspaceId, SessionId), SessionHandle>>,
    projects: RwLock<HashMap<LocalProjectId, LocalProjectRecord>>,
    next_project_seq: RwLock<u64>,
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
            sessions: RwLock::new(HashMap::new()),
            projects: RwLock::new(HashMap::new()),
            next_project_seq: RwLock::new(0),
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
        self.sessions
            .read()
            .expect("sessions lock")
            .get(&(workspace_id.clone(), session_id.clone()))
            .cloned()
    }

    fn ensure_session_actor(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        depth: u8,
        local_project_id: Option<LocalProjectId>,
        use_worktree: bool,
    ) -> PortResult<SessionHandle> {
        let key = (workspace_id.clone(), session_id.clone());
        if let Some(existing) = self.sessions.read().expect("sessions lock").get(&key) {
            return Ok(existing.clone());
        }

        let mode = self
            .deps
            .engine
            .read_workspace_security_mode(workspace_id)?;
        let workspace_encrypted = matches!(mode, WorkspaceSecurityMode::Encrypted { .. });
        let project_root = local_project_id.as_ref().and_then(|pid| {
            self.projects
                .read()
                .expect("projects lock")
                .get(pid)
                .map(|rec| rec.root_path.clone())
        });

        let mut guard = self.sessions.write().expect("sessions lock");
        if let Some(existing) = guard.get(&key) {
            return Ok(existing.clone());
        }

        let handle = spawn_session_actor(
            SessionSpawnOptions {
                workspace_id: workspace_id.clone(),
                session_id: session_id.clone(),
                workspace_encrypted,
                depth,
                local_project_id,
                project_root,
                use_worktree,
                settling_timeout: self.settling_timeout,
            },
            Arc::clone(&self.deps),
            Arc::clone(&self.acp_start_semaphore),
        );
        guard.insert(key, handle.clone());
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
            AppCommand::RegisterProject { name, root_path } => {
                let id = {
                    let mut seq = self.next_project_seq.write().expect("project seq lock");
                    *seq += 1;
                    LocalProjectId(format!("proj_{}", *seq))
                };
                let rec = LocalProjectRecord {
                    project_id: id.clone(),
                    name,
                    root_path,
                    default_branch: None,
                };
                self.projects
                    .write()
                    .expect("projects lock")
                    .insert(id, rec.clone());
                Ok(AppResponse::ProjectRegistered(rec))
            }
            AppCommand::CreateSession {
                workspace_id,
                session_id,
                turn_id,
                local_project_id,
                use_worktree,
                adapter_id,
                prompt,
            } => {
                let handle = self.ensure_session_actor(
                    &workspace_id,
                    &session_id,
                    0,
                    local_project_id,
                    use_worktree,
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
                prompt,
            } => {
                let handle =
                    self.ensure_session_actor(&workspace_id, &session_id, 0, None, false)?;
                let invocation = Self::caller_invocation(caller, &turn_id.0, "default", prompt);
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
                let handle =
                    self.ensure_session_actor(&workspace_id, &child_session_id, 1, None, false)?;
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
                    .sessions
                    .write()
                    .expect("sessions lock")
                    .remove(&(workspace_id, session_id.clone()));
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
        let handles: Vec<SessionHandle> = {
            let mut guard = self.sessions.write().expect("sessions lock");
            guard.drain().map(|(_, h)| h).collect()
        };
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
            AppQuery::ListProjects => {
                let projects = self
                    .projects
                    .read()
                    .expect("projects lock")
                    .values()
                    .cloned()
                    .collect();
                Ok(AppResponse::ProjectsListed { projects })
            }
            AppQuery::ListSessions { .. } => Ok(AppResponse::SessionsListed {
                sessions: Vec::new(),
            }),
            AppQuery::GetSessionHistory {
                workspace_id,
                session_id,
            } => {
                let turns = self
                    .deps
                    .history
                    .read_session_turns(&workspace_id, &session_id)?;
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
