#![forbid(unsafe_code)]
#![deny(clippy::await_holding_lock)]

pub mod actor;
pub mod automation_runner;
pub mod schedule_runner;
pub mod workspace;

pub use actor::{
    ChildAdmissionGrant, ControlCommand, ParentDelegationTarget, SessionHandle,
    SessionSpawnOptions, spawn_session_actor,
};
use automation_runner::{
    ManagedRunRegistry, resolve_contained_workdir, tick_workspace_automations,
};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, AttachedWorkspaceView, CapabilitySet,
    CustomCommandSpec, DaemonStatusView, HistoryTurnRecord, LocalProjectId, MachineId,
    McpHttpEndpointConfig, PortError, PortErrorKind, PortResult, PreparedProjectAdd, ProfileId,
    ScheduleEditPatch, SessionId, SessionRuntimeStatus, StorageLeaseMode, TerminalEventSink,
    TurnId, UserId, VerifiedPrincipal, WorkspaceId, WorkspaceSecurityMode, enforce_command_policy,
    enforce_query_policy,
};
use lody_kernel::{
    ChildRejectReason, FrozenTurnInvocation, SessionPhase, TurnSourceKind,
    next_supervisor_wake_deadline_ms,
};
use lody_ports::{
    AcpLauncherPort, AdmittedTurnInput, ArtifactRegistryPort, AutomationProgramContext,
    AutomationSandboxPort, AutomationStorePort, AutomationWaitRecord, AutomationWorkspaceScope,
    BackendPort, DiffStorePort, EnginePort, HistoryPort, InboxCategory, InboxStorePort,
    MachineIdentityPort, McpServerMount, PrPollerStorePort, ProjectStorePort, PtyPort,
    ScheduleLedgerPort, ScheduleProposalInput, ScheduleRepoPort, SessionRunStatus,
    StorageLeasePort, TerminalOpenSpec, WorktreePort, validate_schedule_identifier,
    validate_schedule_prompt, validate_schedule_rule, validate_schedule_title,
};
use schedule_runner::tick_workspace_schedules;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, Semaphore};
pub use workspace::{DetachDisposition, DrainedSupervisor, FleetWorkspaceTable, WorkspaceMount};

const DEFAULT_SETTLING_TIMEOUT: Duration = Duration::from_secs(5);

pub type AgentEnvBuilder = dyn Fn(&Path) -> BTreeMap<String, String> + Send + Sync;
pub type TerminalEnvBuilder = dyn Fn(&str) -> BTreeMap<String, String> + Send + Sync;
pub type McpStdioMountBuilder =
    dyn Fn(&SessionId, &WorkspaceId, &MachineId, &Path) -> Option<McpServerMount> + Send + Sync;

pub struct DaemonDependencies {
    pub machine_id: MachineId,
    pub identity: Arc<dyn MachineIdentityPort>,
    pub default_cwd: PathBuf,
    pub shell_command: (String, Vec<String>),
    pub agent_env_builder: Arc<AgentEnvBuilder>,
    pub terminal_env_builder: Arc<TerminalEnvBuilder>,
    pub storage_lease_mode: StorageLeaseMode,
    pub storage_lease: Option<Arc<dyn StorageLeasePort>>,
    pub engine: Arc<dyn EnginePort>,
    pub history: Arc<dyn HistoryPort>,
    pub inbox: Arc<dyn InboxStorePort>,
    pub projects: Arc<dyn ProjectStorePort>,
    pub schedule_repo: Arc<dyn ScheduleRepoPort>,
    pub schedule_ledger: Arc<dyn ScheduleLedgerPort>,
    pub automation_store: Arc<dyn AutomationStorePort>,
    pub automation_sandbox: Arc<dyn AutomationSandboxPort>,
    pub pr_poller_store: Arc<dyn PrPollerStorePort>,
    pub diff_store: Arc<dyn DiffStorePort>,
    pub artifacts: Arc<dyn ArtifactRegistryPort>,
    pub acp: Arc<dyn AcpLauncherPort>,
    pub pty: Arc<dyn PtyPort>,
    pub worktree: Arc<dyn WorktreePort>,
    pub backend: Option<Arc<dyn BackendPort>>,
}

#[derive(Clone)]
pub struct DaemonRuntime {
    deps: Arc<DaemonDependencies>,
    mcp_endpoint: Arc<RwLock<Option<McpHttpEndpointConfig>>>,
    mcp_stdio_mount_builder: Option<Arc<McpStdioMountBuilder>>,
    acp_start_semaphore: Arc<Semaphore>,
    workspaces: Arc<RwLock<FleetWorkspaceTable>>,
    settling_timeout: Duration,
    owned_tokio: Option<Arc<tokio::runtime::Runtime>>,
}

fn current_epoch_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn current_epoch_ms_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn ignore_unwired(res: PortResult<()>) -> PortResult<()> {
    match res {
        Ok(()) => Ok(()),
        Err(err) if err.kind == PortErrorKind::Unavailable => Ok(()),
        Err(err) => Err(err),
    }
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
                .map(Arc::new)
        });
        Self {
            deps: Arc::new(deps),
            mcp_endpoint: Arc::new(RwLock::new(None)),
            mcp_stdio_mount_builder: None,
            acp_start_semaphore: Arc::new(Semaphore::new(max_starts)),
            workspaces: Arc::new(RwLock::new(FleetWorkspaceTable::default())),
            settling_timeout,
            owned_tokio,
        }
    }

    pub fn with_mcp_stdio_mount_builder(mut self, builder: Arc<McpStdioMountBuilder>) -> Self {
        self.mcp_stdio_mount_builder = Some(builder);
        self
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

    pub async fn is_session_gc_protected(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        now_ms: u64,
    ) -> bool {
        let Some(handle) = self.session_handle(workspace_id, session_id) else {
            return false;
        };
        let Ok((phase, live_out_of_turn)) = handle.inspect_status(now_ms).await else {
            return false;
        };
        !matches!(phase, SessionPhase::Idle { .. }) || live_out_of_turn
    }

    fn resolve_project_root_for_query(
        &self,
        local_project_id: Option<&LocalProjectId>,
        explicit_root: Option<PathBuf>,
    ) -> PortResult<PathBuf> {
        if let Some(root) = explicit_root {
            return Ok(root);
        }
        if let Some(pid) = local_project_id {
            match self.deps.projects.get_project(pid) {
                Ok(Some(rec)) => return Ok(rec.root_path),
                Ok(None) => {
                    return Err(PortError::new(
                        PortErrorKind::NotFound,
                        format!("local project '{}' not found", pid.0),
                    ));
                }
                Err(err) => return Err(err),
            }
        }
        Err(PortError::new(
            PortErrorKind::InvalidInput,
            "missing localProjectId or rootPath",
        ))
    }

    pub(crate) fn resolve_workspace_mode(
        &self,
        workspace_id: &WorkspaceId,
    ) -> PortResult<WorkspaceSecurityMode> {
        match self.deps.engine.read_workspace_security_mode(workspace_id) {
            Ok(mode) => Ok(mode),
            Err(err)
                if err.kind == PortErrorKind::Unavailable
                    && !self.deps.engine.is_connected()
                    && workspace_id.0 == "local" =>
            {
                Ok(WorkspaceSecurityMode::Plaintext)
            }
            Err(err) => Err(err),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_host_admitted_turn(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        turn_id: &TurnId,
        category: InboxCategory,
        verified_requester: UserId,
        prompt_text: String,
        adapter_id: String,
    ) -> PortResult<AdmittedTurnInput> {
        let mode = self.resolve_workspace_mode(workspace_id)?;
        match mode {
            WorkspaceSecurityMode::Unknown => Err(PortError::new(
                PortErrorKind::Unavailable,
                "WORKSPACE_SECURITY_MODE_UNKNOWN",
            )),
            WorkspaceSecurityMode::Plaintext => Ok(AdmittedTurnInput {
                workspace_id: workspace_id.clone(),
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                category,
                verified_requester,
                prompt_text,
                adapter_id,
                custom_acp: None,
                signed_intent_verified: true,
                signature_hex: None,
            }),
            WorkspaceSecurityMode::Encrypted { .. } => {
                let signed = self
                    .deps
                    .engine
                    .sign_machine_turn_intent(&lody_ports::MachineSignTurnRequest {
                        workspace_id: workspace_id.clone(),
                        session_id: session_id.clone(),
                        target_machine_id: self.deps.machine_id.clone(),
                        turn_id: turn_id.clone(),
                        prompt_text: prompt_text.clone(),
                        adapter_id: adapter_id.clone(),
                    })
                    .map_err(|_| {
                        PortError::new(
                            PortErrorKind::Unavailable,
                            "E2EE_MACHINE_SIGNING_UNAVAILABLE",
                        )
                    })?;
                if signed.signature_hex.trim().is_empty() {
                    return Err(PortError::new(
                        PortErrorKind::Unavailable,
                        "E2EE_MACHINE_SIGNING_UNAVAILABLE",
                    ));
                }
                Ok(AdmittedTurnInput {
                    workspace_id: workspace_id.clone(),
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    category,
                    verified_requester,
                    prompt_text,
                    adapter_id,
                    custom_acp: None,
                    signed_intent_verified: true,
                    signature_hex: Some(signed.signature_hex),
                })
            }
        }
    }

    pub fn attach_workspace(
        &self,
        workspace_id: &WorkspaceId,
        explicit_mode: Option<WorkspaceSecurityMode>,
    ) -> PortResult<AttachedWorkspaceView> {
        let mode = match explicit_mode {
            Some(m) => m,
            None => self.resolve_workspace_mode(workspace_id)?,
        };
        let view = self
            .workspaces
            .write()
            .expect("workspaces lock")
            .attach_or_update(workspace_id, mode)?;
        self.ensure_workspace_supervisor(workspace_id);
        Ok(view)
    }

    fn ensure_workspace_supervisor(&self, workspace_id: &WorkspaceId) {
        if self.deps.storage_lease_mode != StorageLeaseMode::OnlineHost
            || tokio::runtime::Handle::try_current().is_err()
        {
            return;
        }
        let mut guard = self.workspaces.write().expect("workspaces lock");
        let Some(mount) = guard.get_mount_mut(workspace_id) else {
            return;
        };
        if mount.supervisor_task.is_some() {
            return;
        }
        let wake_notify = Arc::clone(&mount.supervisor_wake);
        let mut shutdown_rx = mount.supervisor_shutdown_rx.clone();
        let managed_runs = Arc::clone(&mount.managed_runs);
        let active_checks = Arc::clone(&mount.active_automation_checks);
        let rt_clone = self.clone();
        let ws_clone = workspace_id.clone();

        let task = tokio::spawn(async move {
            let mut startup_reconciled = false;
            loop {
                if *shutdown_rx.borrow_and_update() {
                    break;
                }
                let now_ms = current_epoch_ms_i64();
                let sched_next = tick_workspace_schedules(&rt_clone, &ws_clone, now_ms)
                    .await
                    .ok()
                    .flatten();
                if *shutdown_rx.borrow_and_update() {
                    break;
                }
                let auto_next = tick_workspace_automations(
                    &rt_clone,
                    &ws_clone,
                    &managed_runs,
                    &active_checks,
                    &wake_notify,
                    &mut startup_reconciled,
                    now_ms,
                )
                .await
                .ok()
                .flatten();
                if *shutdown_rx.borrow_and_update() {
                    break;
                }
                let combined = match (sched_next, auto_next) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                let after_ms = current_epoch_ms_i64();
                let deadline_ms = next_supervisor_wake_deadline_ms(after_ms, combined);
                let sleep_dur = Duration::from_millis((deadline_ms - after_ms).max(10) as u64);

                tokio::select! {
                    biased;
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow_and_update() {
                            break;
                        }
                    }
                    _ = wake_notify.notified() => {}
                    _ = tokio::time::sleep(sleep_dur) => {}
                }
            }
        });
        mount.supervisor_task = Some(task);
    }

    fn wake_workspace_supervisor(&self, workspace_id: &WorkspaceId) {
        if let Ok(mode) = self.resolve_workspace_mode(workspace_id) {
            let mut guard = self.workspaces.write().expect("workspaces lock");
            let _ = guard.get_or_insert_mount(workspace_id, mode);
        }
        self.ensure_workspace_supervisor(workspace_id);
        let wake_opt = self
            .workspaces
            .read()
            .expect("workspaces lock")
            .get_mount(workspace_id)
            .map(|m| Arc::clone(&m.supervisor_wake));
        if let Some(wake) = wake_opt {
            wake.notify_one();
        }
    }

    #[allow(clippy::type_complexity)]
    fn managed_runs_for_workspace(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Option<(
        Arc<ManagedRunRegistry>,
        Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
        Arc<Notify>,
    )> {
        if let Ok(mode) = self.resolve_workspace_mode(workspace_id) {
            let mut guard = self.workspaces.write().expect("workspaces lock");
            let _ = guard.get_or_insert_mount(workspace_id, mode);
        }
        self.workspaces
            .read()
            .expect("workspaces lock")
            .get_mount(workspace_id)
            .map(|m| {
                (
                    Arc::clone(&m.managed_runs),
                    Arc::clone(&m.active_automation_checks),
                    Arc::clone(&m.supervisor_wake),
                )
            })
    }

    fn erase_local_workspace_stores(&self, workspace_id: &WorkspaceId) -> PortResult<()> {
        self.deps.inbox.erase_workspace_inbox(workspace_id)?;
        self.deps.diff_store.erase_workspace_diffs(workspace_id)?;
        ignore_unwired(
            self.deps
                .schedule_ledger
                .erase_workspace_ledger(workspace_id),
        )?;
        ignore_unwired(self.deps.automation_store.erase_workspace_store(
            &AutomationWorkspaceScope {
                machine_id: self.deps.machine_id.clone(),
                workspace_id: workspace_id.clone(),
            },
        ))?;
        ignore_unwired(
            self.deps
                .pr_poller_store
                .clear_workspace_state(workspace_id),
        )?;
        ignore_unwired(self.deps.history.erase_workspace_turns(workspace_id))
    }

    pub async fn detach_workspace(
        &self,
        workspace_id: &WorkspaceId,
        erase_local_state: bool,
    ) -> PortResult<usize> {
        let disposition = self
            .workspaces
            .write()
            .expect("workspaces lock")
            .begin_detach(workspace_id);

        match disposition {
            DetachDisposition::Absent => {
                if erase_local_state {
                    self.erase_local_workspace_stores(workspace_id)?;
                }
                Ok(0)
            }
            DetachDisposition::JoinedInFlight(notify) => {
                notify.notified().await;
                Ok(0)
            }
            DetachDisposition::Started {
                session_ids,
                sessions,
                supervisor,
                notify,
            } => {
                let drained = sessions.len();
                supervisor.managed_runs.stop_all();
                let _ = supervisor.shutdown_tx.send(true);
                if let Some(task) = supervisor.task {
                    let _ = task.await;
                }
                for sid in &session_ids {
                    self.deps.pty.close_session_terminals(sid);
                }
                for handle in sessions {
                    handle.shutdown().await;
                }

                let erase_res = if erase_local_state {
                    self.erase_local_workspace_stores(workspace_id)
                } else {
                    Ok(())
                };

                self.workspaces
                    .write()
                    .expect("workspaces lock")
                    .finish_detach(workspace_id);
                notify.notify_waiters();

                erase_res?;
                Ok(drained)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_session_actor(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        depth: u8,
        local_project_id: Option<LocalProjectId>,
        explicit_project_root: Option<PathBuf>,
        explicit_base_branch: Option<String>,
        use_worktree: bool,
        custom_acp: Option<CustomCommandSpec>,
        parent_delegation: Option<ParentDelegationTarget>,
    ) -> PortResult<SessionHandle> {
        if let Some(existing) = self.session_handle(workspace_id, session_id) {
            return Ok(existing);
        }

        let engine_mode = self.resolve_workspace_mode(workspace_id)?;
        let project_root = match explicit_project_root {
            Some(explicit) => Some(explicit),
            None => match &local_project_id {
                Some(pid) => match self.deps.projects.get_project(pid) {
                    Ok(opt) => opt.map(|r| r.root_path),
                    Err(err) if err.kind == PortErrorKind::Unavailable => None,
                    Err(err) => return Err(err),
                },
                None => None,
            },
        };

        let base_branch = explicit_base_branch
            .and_then(|b| {
                let trimmed = b.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            })
            .or_else(|| {
                if !use_worktree {
                    return None;
                }
                self.deps
                    .engine
                    .read_session_meta(workspace_id, session_id)
                    .ok()
                    .flatten()
                    .and_then(|m| m.base_branch)
            });

        let mut guard = self.workspaces.write().expect("workspaces lock");
        let mount = guard.get_or_insert_mount(workspace_id, engine_mode)?;
        if let Some(existing) = mount.sessions.get(session_id) {
            return Ok(existing.clone());
        }

        let workspace_encrypted =
            matches!(mount.security_mode, WorkspaceSecurityMode::Encrypted { .. });
        let supervisor_wake = Some(Arc::clone(&mount.supervisor_wake));
        let handle = spawn_session_actor(
            SessionSpawnOptions {
                workspace_id: workspace_id.clone(),
                session_id: session_id.clone(),
                workspace_encrypted,
                depth,
                local_project_id,
                project_root,
                base_branch,
                use_worktree,
                custom_acp,
                parent_delegation,
                settling_timeout: self.settling_timeout,
                supervisor_wake,
            },
            Arc::clone(&self.deps),
            Arc::clone(&self.mcp_endpoint),
            self.mcp_stdio_mount_builder.clone(),
            Arc::clone(&self.acp_start_semaphore),
        );
        mount.sessions.insert(session_id.clone(), handle.clone());
        drop(guard);
        self.ensure_workspace_supervisor(workspace_id);
        Ok(handle)
    }

    async fn resolve_session_dispatch_requester(
        &self,
        caller: &VerifiedPrincipal,
    ) -> PortResult<UserId> {
        match caller {
            VerifiedPrincipal::AgentSession {
                workspace_id,
                session_id,
                machine_id,
                account_id,
            } => {
                if machine_id != &self.deps.machine_id {
                    return Err(PortError::new(
                        PortErrorKind::Forbidden,
                        "agent session machineId does not match this host",
                    ));
                }
                if let Some(uid) = account_id {
                    return Ok(uid.clone());
                }
                if let Some(handle) = self.session_handle(workspace_id, session_id)
                    && let Ok(Some(uid)) = handle.inspect_driving_user().await
                {
                    return Ok(uid);
                }
                if let Ok(Some(meta)) = self.deps.engine.read_session_meta(workspace_id, session_id)
                    && !meta.deleted
                    && &meta.workspace_id == workspace_id
                    && meta.owner_machine_id == self.deps.machine_id
                {
                    return Ok(meta.owner_user_id);
                }
                Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "invoking agent session is not active on this host",
                ))
            }
            _ => Ok(caller
                .effective_user_id()
                .cloned()
                .unwrap_or_else(|| UserId("local-host".to_string()))),
        }
    }

    async fn authorize_schedule_caller(
        &self,
        caller: &VerifiedPrincipal,
        workspace_id: &WorkspaceId,
        invoking_session_id: Option<&SessionId>,
    ) -> PortResult<UserId> {
        let effective_session_id = match caller {
            VerifiedPrincipal::AgentSession {
                session_id,
                machine_id,
                ..
            } => {
                if machine_id != &self.deps.machine_id {
                    return Err(PortError::new(
                        PortErrorKind::Forbidden,
                        "Schedule tools require the invoking Session owner",
                    ));
                }
                Some(session_id)
            }
            _ => invoking_session_id,
        };

        if let Some(sid) = effective_session_id {
            let meta_opt = self.deps.engine.read_session_meta(workspace_id, sid)?;
            let Some(meta) = meta_opt else {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            };
            if meta.deleted
                || &meta.workspace_id != workspace_id
                || meta.owner_machine_id != self.deps.machine_id
            {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            if let Some(caller_uid) = caller.effective_user_id()
                && caller_uid != &meta.owner_user_id
            {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            if let Some(handle) = self.session_handle(workspace_id, sid)
                && let Ok(Some(driving_uid)) = handle.inspect_driving_user().await
                && driving_uid != meta.owner_user_id
            {
                return Err(PortError::new(
                    PortErrorKind::Forbidden,
                    "Schedule tools require the invoking Session owner",
                ));
            }
            return Ok(meta.owner_user_id);
        }

        caller.effective_user_id().cloned().ok_or_else(|| {
            PortError::new(
                PortErrorKind::Unauthorized,
                "Schedule commands require a verified user identity",
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn admit_turn_and_wake(
        &self,
        caller: &VerifiedPrincipal,
        workspace_id: WorkspaceId,
        session_id: SessionId,
        turn_id: TurnId,
        depth: u8,
        local_project_id: Option<LocalProjectId>,
        explicit_project_root: Option<PathBuf>,
        explicit_base_branch: Option<String>,
        use_worktree: bool,
        adapter_id: String,
        custom_acp: Option<CustomCommandSpec>,
        parent_delegation: Option<ParentDelegationTarget>,
        prompt: String,
    ) -> PortResult<AppResponse> {
        let requester = self.resolve_session_dispatch_requester(caller).await?;
        let signed_intent_verified = matches!(
            caller,
            VerifiedPrincipal::LocalHost { .. }
                | VerifiedPrincipal::AgentSession { .. }
                | VerifiedPrincipal::EncryptedMember { .. }
        );
        let _ = self.deps.inbox.admit_turn(&AdmittedTurnInput {
            workspace_id: workspace_id.clone(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            category: InboxCategory::Human,
            verified_requester: requester.clone(),
            prompt_text: prompt.clone(),
            adapter_id,
            custom_acp: custom_acp.clone(),
            signed_intent_verified,
            signature_hex: None,
        })?;

        match self
            .deps
            .history
            .is_user_turn_durable(&workspace_id, &session_id, &turn_id)
        {
            Ok(false) => {
                ignore_unwired(self.deps.history.upsert_turn_record(
                    &workspace_id,
                    &session_id,
                    &HistoryTurnRecord {
                        turn_id: turn_id.clone(),
                        author_user_id: Some(requester),
                        user_prompt: prompt,
                        assistant_blocks: Vec::new(),
                        outcome: None,
                    },
                ))?;
            }
            Ok(true) => {}
            Err(err) if err.kind == PortErrorKind::Unavailable => {}
            Err(err) => return Err(err),
        }

        let handle = self.ensure_session_actor(
            &workspace_id,
            &session_id,
            depth,
            local_project_id,
            explicit_project_root,
            explicit_base_branch,
            use_worktree,
            custom_acp,
            parent_delegation,
        )?;
        handle.wake_inbox().await?;

        Ok(AppResponse::SessionAccepted {
            session_id,
            turn_id,
        })
    }

    async fn resolve_terminal_cwd(&self, session_id: &SessionId) -> PathBuf {
        let handle_opt = self
            .workspaces
            .read()
            .expect("workspaces lock")
            .find_session_by_id(session_id)
            .map(|(_, h)| h);
        if let Some(handle) = handle_opt
            && let Ok(Some(dir)) = handle.inspect_workdir().await
        {
            return dir;
        }
        self.deps.default_cwd.clone()
    }

    pub(crate) async fn resolve_automation_session_workdir(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
    ) -> Option<PathBuf> {
        if let Some(handle) = self.session_handle(workspace_id, session_id)
            && let Ok(Some(dir)) = handle.inspect_workdir().await
        {
            return Some(dir);
        }
        if let Ok(Some(meta)) = self.deps.engine.read_session_meta(workspace_id, session_id)
            && let Some(pid) = &meta.local_project_id
            && let Ok(Some(proj)) = self.deps.projects.get_project(pid)
        {
            return Some(proj.root_path);
        }
        Some(self.deps.default_cwd.clone())
    }

    pub(crate) async fn build_automation_session_snapshot(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        now_ms: i64,
    ) -> Value {
        if let Some(handle) = self.session_handle(workspace_id, session_id)
            && let Ok((phase, live_out_of_turn)) = handle.inspect_status(now_ms.max(0) as u64).await
        {
            let (exec_state, phase_str) = match phase {
                SessionPhase::Idle { .. } if live_out_of_turn => ("busy", "running"),
                SessionPhase::Idle { .. } => ("idle", "idle"),
                SessionPhase::Preparing { .. } | SessionPhase::EditAndResendBarrier { .. } => {
                    ("busy", "initializing")
                }
                SessionPhase::Running(ref r) => {
                    if r.pending_permissions.is_empty() {
                        ("busy", "running")
                    } else {
                        ("busy", "waiting_permission")
                    }
                }
                SessionPhase::Settling { .. } => ("busy", "settling"),
            };
            return json!({
                "sessionId": session_id.0,
                "workspaceId": workspace_id.0,
                "executionState": exec_state,
                "phase": phase_str,
                "now": now_ms,
            });
        }
        json!({
            "sessionId": session_id.0,
            "workspaceId": workspace_id.0,
            "executionState": "idle",
            "phase": "idle",
            "now": now_ms,
        })
    }

    async fn verify_owned_automation_session(
        &self,
        workspace_id: &WorkspaceId,
        session_id: &SessionId,
        principal_uid: &UserId,
    ) -> PortResult<()> {
        match self.deps.engine.read_session_meta(workspace_id, session_id) {
            Ok(Some(meta)) => {
                if meta.deleted
                    || &meta.workspace_id != workspace_id
                    || meta.owner_machine_id != self.deps.machine_id
                {
                    return Err(PortError::new(
                        PortErrorKind::NotFound,
                        "AUTOMATION_SESSION_UNAVAILABLE",
                    ));
                }
                if meta.status == SessionRunStatus::Archived {
                    return Err(PortError::new(
                        PortErrorKind::Conflict,
                        "AUTOMATION_SESSION_ARCHIVED",
                    ));
                }
                if &meta.owner_user_id != principal_uid {
                    return Err(PortError::new(
                        PortErrorKind::Forbidden,
                        "AUTOMATION_PERMISSION_DENIED",
                    ));
                }
                Ok(())
            }
            Ok(None) => {
                if !self.deps.engine.is_connected()
                    && self.session_handle(workspace_id, session_id).is_some()
                {
                    return Ok(());
                }
                Err(PortError::new(
                    PortErrorKind::NotFound,
                    "AUTOMATION_SESSION_UNAVAILABLE",
                ))
            }
            Err(err)
                if err.kind == PortErrorKind::Unavailable && !self.deps.engine.is_connected() =>
            {
                if self.session_handle(workspace_id, session_id).is_some() {
                    Ok(())
                } else {
                    Err(PortError::new(
                        PortErrorKind::NotFound,
                        "AUTOMATION_SESSION_UNAVAILABLE",
                    ))
                }
            }
            Err(err) => Err(err),
        }
    }

    async fn authorize_automation_context(
        &self,
        caller: &VerifiedPrincipal,
        workspace_id: &WorkspaceId,
        invoking_session_id: Option<&SessionId>,
        target_session_id: Option<&SessionId>,
        require_target: bool,
    ) -> PortResult<(UserId, Option<SessionId>)> {
        let requester = self.resolve_session_dispatch_requester(caller).await?;
        let effective_invoking = match caller {
            VerifiedPrincipal::AgentSession { session_id, .. } => Some(session_id),
            _ => invoking_session_id,
        };
        let resolved_target = target_session_id.or(effective_invoking).cloned();
        if let Some(ref sid) = resolved_target {
            self.verify_owned_automation_session(workspace_id, sid, &requester)
                .await?;
        } else if require_target {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "AUTOMATION_SESSION_REQUIRED",
            ));
        }
        Ok((requester, resolved_target))
    }

    fn public_wait_json(
        &self,
        scope: &AutomationWorkspaceScope,
        wait: &AutomationWaitRecord,
    ) -> PortResult<Value> {
        let mut val = serde_json::to_value(wait)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        if let Some(inv_id) = &wait.invocation_id
            && let Some(receipt) = self.deps.automation_store.get_receipt(scope, inv_id)?
            && let Some(obj) = val.as_object_mut()
        {
            obj.insert(
                "continuation".to_string(),
                json!({
                    "id": receipt.id,
                    "state": receipt.state,
                    "reason": receipt.reason,
                    "turnId": receipt.turn_id,
                    "attempts": receipt.attempts,
                    "retryAt": receipt.retry_at,
                }),
            );
        }
        Ok(val)
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
            AppCommand::RestoreMachineId {
                target_machine_id,
                active_host_pid,
            } => {
                let outcome = self
                    .deps
                    .identity
                    .restore_local_machine_id(&target_machine_id, active_host_pid)?;
                Ok(AppResponse::MachineIdRestored(outcome))
            }
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
                let git_summary = self.deps.worktree.inspect_git_summary(&root_path);
                let mut rec = self.deps.projects.register_project(&name, &root_path)?;
                if rec.git_summary.is_none() {
                    rec.git_summary = Some(git_summary);
                }
                Ok(AppResponse::ProjectRegistered(rec))
            }
            AppCommand::CreateLocalDirectory { parent_path, name } => {
                let path = self.deps.worktree.create_directory(&parent_path, &name)?;
                Ok(AppResponse::LocalDirectoryCreated { path })
            }
            AppCommand::CheckoutProjectBranch {
                local_project_id,
                root_path,
                branch_name,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let out = self
                    .deps
                    .worktree
                    .checkout_branch(&resolved_root, &branch_name);
                Ok(AppResponse::ProjectBranchCheckedOut(out))
            }
            AppCommand::CreateSession {
                workspace_id,
                session_id,
                turn_id,
                local_project_id,
                base_branch,
                use_worktree,
                adapter_id,
                custom_acp,
                prompt,
            } => {
                self.admit_turn_and_wake(
                    caller,
                    workspace_id,
                    session_id,
                    turn_id,
                    0,
                    local_project_id,
                    None,
                    base_branch,
                    use_worktree,
                    adapter_id,
                    custom_acp,
                    None,
                    prompt,
                )
                .await
            }
            AppCommand::SendChat {
                workspace_id,
                session_id,
                turn_id,
                custom_acp,
                prompt,
            } => {
                let adapter_id = if custom_acp.is_some() {
                    "custom".to_string()
                } else {
                    "default".to_string()
                };
                self.admit_turn_and_wake(
                    caller,
                    workspace_id,
                    session_id,
                    turn_id,
                    0,
                    None,
                    None,
                    None,
                    false,
                    adapter_id,
                    custom_acp,
                    None,
                    prompt,
                )
                .await
            }
            AppCommand::SteerTurn {
                workspace_id,
                session_id,
                turn_id,
                prompt,
            } => {
                let requester = self.resolve_session_dispatch_requester(caller).await?;
                let handle = self
                    .session_handle(&workspace_id, &session_id)
                    .ok_or_else(|| PortError::new(PortErrorKind::NotFound, "session not active"))?;
                let signed_intent_verified = matches!(
                    caller,
                    VerifiedPrincipal::LocalHost { .. }
                        | VerifiedPrincipal::AgentSession { .. }
                        | VerifiedPrincipal::EncryptedMember { .. }
                );
                let invocation = FrozenTurnInvocation {
                    turn_id: turn_id.0,
                    requester_user_id: requester.0,
                    prompt_text: prompt,
                    source: TurnSourceKind::Human,
                    adapter_id: "default".to_string(),
                    mcp_selection_digest: "default".to_string(),
                    signed_intent_verified,
                };
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
                let _ = self.resolve_session_dispatch_requester(caller).await?;
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
                parent_session_id,
                child_session_id,
                turn_id,
                operation_id,
                adapter_id,
                custom_acp,
                prompt,
            } => {
                let parent_handle = self
                    .session_handle(&workspace_id, &parent_session_id)
                    .ok_or_else(|| {
                        PortError::new(
                            PortErrorKind::NotFound,
                            format!("parent session '{}' is not active", parent_session_id.0),
                        )
                    })?;

                let grant = match parent_handle
                    .admit_child_delegation(child_session_id.0.clone())
                    .await?
                {
                    Ok(g) => g,
                    Err(ChildRejectReason::MaxDepthExceeded) => {
                        return Err(PortError::new(
                            PortErrorKind::Forbidden,
                            "child session delegation exceeded MAX_CHILD_DELEGATION_DEPTH",
                        ));
                    }
                    Err(ChildRejectReason::CollaborationStopped) => {
                        return Err(PortError::new(
                            PortErrorKind::Forbidden,
                            "collaborationStopped barrier blocks child delegation",
                        ));
                    }
                    Err(ChildRejectReason::DuplicateChildId) => {
                        return Err(PortError::new(
                            PortErrorKind::Conflict,
                            format!("duplicate child session id '{}'", child_session_id.0),
                        ));
                    }
                };

                let effective_custom = custom_acp.or(grant.inherited_custom_acp);
                let resolved_op_id =
                    operation_id.unwrap_or_else(|| format!("op:{}", child_session_id.0));
                let target = ParentDelegationTarget {
                    parent_handle,
                    parent_session_id,
                    operation_id: resolved_op_id,
                    source_turn_id: grant.active_turn_id,
                };

                self.admit_turn_and_wake(
                    caller,
                    workspace_id,
                    child_session_id,
                    turn_id,
                    grant.child_depth,
                    None,
                    grant.inherited_project_root,
                    None,
                    false,
                    adapter_id,
                    effective_custom,
                    Some(target),
                    prompt,
                )
                .await
            }
            AppCommand::ArchiveSession {
                workspace_id,
                session_id,
            } => {
                self.deps.pty.close_session_terminals(&session_id);
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
            AppCommand::ProposeSchedule {
                workspace_id,
                invoking_session_id,
                request_id,
                title,
                prompt_text,
                rule,
            } => {
                let author = self
                    .authorize_schedule_caller(caller, &workspace_id, Some(&invoking_session_id))
                    .await?;
                let valid_req = validate_schedule_identifier("requestId", &request_id)?;
                let valid_title = validate_schedule_title(&title)?;
                validate_schedule_prompt(&prompt_text)?;
                validate_schedule_rule(&rule)?;
                let out = self
                    .deps
                    .schedule_repo
                    .propose_schedule(&ScheduleProposalInput {
                        workspace_id,
                        invoking_session_id,
                        author,
                        request_id: valid_req,
                        title: valid_title,
                        prompt_text,
                        rule,
                    })?;
                Ok(AppResponse::ScheduleProposed(out))
            }
            AppCommand::ProposeScheduleEdit {
                workspace_id,
                invoking_session_id,
                schedule_id,
                request_id,
                patch,
            } => {
                let author = self
                    .authorize_schedule_caller(caller, &workspace_id, Some(&invoking_session_id))
                    .await?;
                let valid_sched = validate_schedule_identifier("scheduleId", &schedule_id)?;
                let valid_req = validate_schedule_identifier("requestId", &request_id)?;
                let normalized_title = match &patch.title {
                    Some(t) => Some(validate_schedule_title(t)?),
                    None => None,
                };
                if let Some(p) = &patch.prompt_text {
                    validate_schedule_prompt(p)?;
                }
                if let Some(r) = &patch.rule {
                    validate_schedule_rule(r)?;
                }
                if normalized_title.is_none() && patch.prompt_text.is_none() && patch.rule.is_none()
                {
                    return Err(PortError::new(
                        PortErrorKind::InvalidInput,
                        "propose_edit requires at least one of title, prompt, or rule",
                    ));
                }
                let normalized_patch = ScheduleEditPatch {
                    title: normalized_title,
                    prompt_text: patch.prompt_text,
                    rule: patch.rule,
                };
                let out = self.deps.schedule_repo.propose_schedule_edit(
                    &workspace_id,
                    &invoking_session_id,
                    &author,
                    &valid_sched,
                    &valid_req,
                    &normalized_patch,
                )?;
                Ok(AppResponse::ScheduleProposed(out))
            }
            AppCommand::PauseSchedule {
                workspace_id,
                invoking_session_id,
                schedule_id,
                request_id,
            } => {
                let author = self
                    .authorize_schedule_caller(caller, &workspace_id, invoking_session_id.as_ref())
                    .await?;
                let valid_sched = validate_schedule_identifier("scheduleId", &schedule_id)?;
                let valid_req = validate_schedule_identifier("requestId", &request_id)?;
                let changed = self.deps.schedule_repo.pause_schedule(
                    &workspace_id,
                    invoking_session_id.as_ref(),
                    &author,
                    &valid_sched,
                    &valid_req,
                )?;
                Ok(AppResponse::SchedulePaused {
                    schedule_id: valid_sched,
                    changed,
                })
            }
            AppCommand::AutomationRegister {
                workspace_id,
                invoking_session_id,
                target_session_id,
                registration,
            } => {
                let now_ms = current_epoch_ms_i64();
                let (principal_uid, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        true,
                    )
                    .await?;
                let session_id = sid_opt.expect("require_target enforced");
                if registration.expires_at.is_some_and(|exp| exp <= now_ms) {
                    return Err(PortError::new(
                        PortErrorKind::InvalidInput,
                        "AUTOMATION_ALREADY_EXPIRED",
                    ));
                }
                let prog_ctx = AutomationProgramContext {
                    session_id: session_id.clone(),
                    workspace_id: workspace_id.clone(),
                    now_ms,
                };
                let sandbox = Arc::clone(&self.deps.automation_sandbox);
                let prog_src = registration.program.clone();
                tokio::task::spawn_blocking(move || sandbox.validate_program(&prog_src, &prog_ctx))
                    .await
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))??;

                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id: workspace_id.clone(),
                };
                let wait = self.deps.automation_store.register_wait(
                    &scope,
                    &session_id,
                    &principal_uid,
                    &registration,
                    now_ms,
                )?;
                let payload = self.public_wait_json(&scope, &wait)?;
                self.wake_workspace_supervisor(&workspace_id);
                Ok(AppResponse::AutomationResult { payload })
            }
            AppCommand::AutomationRun {
                workspace_id,
                invoking_session_id,
                target_session_id,
                run_spec,
            } => {
                let now_ms = current_epoch_ms_i64();
                let (principal_uid, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        true,
                    )
                    .await?;
                let session_id = sid_opt.expect("require_target enforced");
                let root = self
                    .resolve_automation_session_workdir(&workspace_id, &session_id)
                    .await
                    .ok_or_else(|| {
                        PortError::new(
                            PortErrorKind::Unavailable,
                            "AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE",
                        )
                    })?;
                let _ = resolve_contained_workdir(&root, run_spec.cwd.as_deref())?;
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id: workspace_id.clone(),
                };
                let wait = self.deps.automation_store.register_run(
                    &scope,
                    &session_id,
                    &principal_uid,
                    &run_spec,
                    now_ms,
                )?;
                let payload = self.public_wait_json(&scope, &wait)?;
                self.wake_workspace_supervisor(&workspace_id);
                Ok(AppResponse::AutomationResult { payload })
            }
            AppCommand::AutomationConfigure {
                workspace_id,
                invoking_session_id,
                target_session_id,
                settings,
            } => {
                let now_ms = current_epoch_ms_i64();
                let (principal_uid, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        true,
                    )
                    .await?;
                let session_id = sid_opt.expect("require_target enforced");
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id: workspace_id.clone(),
                };
                let payload = self.deps.automation_store.configure_session_settings(
                    &scope,
                    &session_id,
                    &principal_uid,
                    &settings,
                    now_ms,
                )?;
                self.wake_workspace_supervisor(&workspace_id);
                Ok(AppResponse::AutomationResult { payload })
            }
            AppCommand::AutomationCancel {
                workspace_id,
                invoking_session_id: _,
                item_id,
            } => {
                let now_ms = current_epoch_ms_i64();
                let principal_uid = self.resolve_session_dispatch_requester(caller).await?;
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id: workspace_id.clone(),
                };
                if let Some(wait) = self.deps.automation_store.get_wait(&scope, &item_id)? {
                    if wait.owner_machine_id != self.deps.machine_id {
                        return Err(PortError::new(
                            PortErrorKind::NotFound,
                            "AUTOMATION_NOT_FOUND",
                        ));
                    }
                    self.verify_owned_automation_session(
                        &workspace_id,
                        &wait.session_id,
                        &principal_uid,
                    )
                    .await?;
                    let _ = self
                        .deps
                        .automation_store
                        .cancel_item(&scope, &wait.id, now_ms)?;
                    if wait.run.is_some()
                        && let Some((runs, _, _)) = self.managed_runs_for_workspace(&workspace_id)
                    {
                        runs.stop(&wait.id);
                    }
                    let updated = self
                        .deps
                        .automation_store
                        .get_wait(&scope, &wait.id)?
                        .unwrap_or(wait);
                    let payload = self.public_wait_json(&scope, &updated)?;
                    self.wake_workspace_supervisor(&workspace_id);
                    return Ok(AppResponse::AutomationResult { payload });
                }
                if let Some(receipt) = self.deps.automation_store.get_receipt(&scope, &item_id)? {
                    if let Some(ref sid) = receipt.session_id {
                        self.verify_owned_automation_session(&workspace_id, sid, &principal_uid)
                            .await?;
                    }
                    let payload = self
                        .deps
                        .automation_store
                        .cancel_item(&scope, &item_id, now_ms)?
                        .unwrap_or(Value::Null);
                    self.wake_workspace_supervisor(&workspace_id);
                    return Ok(AppResponse::AutomationResult { payload });
                }
                Err(PortError::new(
                    PortErrorKind::NotFound,
                    "AUTOMATION_NOT_FOUND",
                ))
            }
            AppCommand::TickWorkspaceSchedulers {
                workspace_id,
                now_ms,
            } => {
                let effective_now = now_ms.unwrap_or_else(current_epoch_ms_i64);
                let sched_next =
                    tick_workspace_schedules(self, &workspace_id, effective_now).await?;
                let auto_next = if let Some((runs, active_checks, wake)) =
                    self.managed_runs_for_workspace(&workspace_id)
                {
                    let mut reconciled = false;
                    tick_workspace_automations(
                        self,
                        &workspace_id,
                        &runs,
                        &active_checks,
                        &wake,
                        &mut reconciled,
                        effective_now,
                    )
                    .await?
                } else {
                    None
                };
                let next_wake_ms = match (sched_next, auto_next) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                Ok(AppResponse::SchedulersTicked { next_wake_ms })
            }
            AppCommand::TerminalOpen {
                session_id,
                cols,
                rows,
            } => {
                let cwd = self.resolve_terminal_cwd(&session_id).await;
                let (shell_program, shell_args) = self.deps.shell_command.clone();
                let env = (self.deps.terminal_env_builder)(&session_id.0);
                let out = self.deps.pty.open_terminal(TerminalOpenSpec {
                    session_id,
                    cwd,
                    cols,
                    rows,
                    shell_program,
                    shell_args,
                    env,
                })?;
                Ok(AppResponse::TerminalOpened(out))
            }
            AppCommand::TerminalAttach {
                terminal_id,
                cols,
                rows,
            } => {
                let replay = self.deps.pty.attach_terminal(&terminal_id, cols, rows)?;
                Ok(AppResponse::TerminalAttached(replay))
            }
            AppCommand::TerminalInput { terminal_id, data } => {
                self.deps.pty.write_terminal_input(&terminal_id, &data)?;
                Ok(AppResponse::TerminalAck)
            }
            AppCommand::TerminalResize {
                terminal_id,
                cols,
                rows,
            } => {
                self.deps.pty.resize_terminal(&terminal_id, cols, rows)?;
                Ok(AppResponse::TerminalAck)
            }
            AppCommand::TerminalClose { terminal_id } => {
                self.deps.pty.close_terminal(&terminal_id)?;
                Ok(AppResponse::TerminalAck)
            }
            AppCommand::TerminalCloseSession { session_id } => {
                self.deps.pty.close_session_terminals(&session_id);
                Ok(AppResponse::TerminalAck)
            }
        }
    }

    pub async fn query_async(
        &self,
        caller: &VerifiedPrincipal,
        query: AppQuery,
    ) -> PortResult<AppResponse> {
        enforce_query_policy(caller, &query)?;

        match query {
            AppQuery::GetSessionStatuses {
                workspace_id,
                session_ids,
            } => {
                let now_ms = current_epoch_ms_u64();
                let mut statuses = Vec::with_capacity(session_ids.len());
                for sid in session_ids {
                    if let Some(handle) = self.session_handle(&workspace_id, &sid)
                        && let Ok((phase, live_out_of_turn)) = handle.inspect_status(now_ms).await
                    {
                        let (exec_state, phase_str, active_turn_id) = match phase {
                            SessionPhase::Idle { .. } if live_out_of_turn => {
                                ("busy", "running", None)
                            }
                            SessionPhase::Idle { .. } => ("idle", "idle", None),
                            SessionPhase::Preparing { invocation, .. } => {
                                ("busy", "initializing", Some(TurnId(invocation.turn_id)))
                            }
                            SessionPhase::Running(running) => {
                                let p = if running.pending_permissions.is_empty() {
                                    "running"
                                } else {
                                    "waiting_permission"
                                };
                                ("busy", p, Some(TurnId(running.invocation.turn_id)))
                            }
                            SessionPhase::Settling { invocation, .. } => {
                                ("busy", "settling", Some(TurnId(invocation.turn_id)))
                            }
                            SessionPhase::EditAndResendBarrier {
                                replacement_invocation,
                                ..
                            } => (
                                "busy",
                                "initializing",
                                Some(TurnId(replacement_invocation.turn_id)),
                            ),
                        };
                        statuses.push(SessionRuntimeStatus {
                            session_id: sid,
                            execution_state: exec_state.to_string(),
                            phase: phase_str.to_string(),
                            active_turn_id,
                        });
                    } else {
                        statuses.push(SessionRuntimeStatus {
                            session_id: sid,
                            execution_state: "idle".to_string(),
                            phase: "idle".to_string(),
                            active_turn_id: None,
                        });
                    }
                }
                Ok(AppResponse::SessionStatuses { statuses })
            }
            AppQuery::ListSchedules {
                workspace_id,
                invoking_session_id,
                filter_query,
                limit,
                offset,
            } => {
                let _author = self
                    .authorize_schedule_caller(caller, &workspace_id, invoking_session_id.as_ref())
                    .await?;
                let schedules = self.deps.schedule_repo.list_schedules(
                    &workspace_id,
                    filter_query.as_deref(),
                    limit,
                    offset,
                )?;
                Ok(AppResponse::SchedulesListed { schedules })
            }
            AppQuery::GetSchedule {
                workspace_id,
                invoking_session_id,
                schedule_id,
            } => {
                let _author = self
                    .authorize_schedule_caller(caller, &workspace_id, invoking_session_id.as_ref())
                    .await?;
                let valid_id = validate_schedule_identifier("scheduleId", &schedule_id)?;
                let schedule = self
                    .deps
                    .schedule_repo
                    .get_schedule(&workspace_id, &valid_id)?;
                Ok(AppResponse::ScheduleRead { schedule })
            }
            AppQuery::AutomationSettings {
                workspace_id,
                invoking_session_id,
                target_session_id,
            } => {
                let (_, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        true,
                    )
                    .await?;
                let session_id = sid_opt.expect("require_target enforced");
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id,
                };
                let payload = self
                    .deps
                    .automation_store
                    .read_session_settings(&scope, &session_id)?;
                Ok(AppResponse::AutomationResult { payload })
            }
            AppQuery::AutomationList {
                workspace_id,
                invoking_session_id,
                target_session_id,
            } => {
                let (principal_uid, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        false,
                    )
                    .await?;
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id,
                };
                let owner_filter = sid_opt.is_none().then_some(&principal_uid);
                let waits = self.deps.automation_store.list_waits(
                    &scope,
                    owner_filter,
                    sid_opt.as_ref(),
                )?;
                let mut items = Vec::with_capacity(waits.len());
                for w in &waits {
                    items.push(self.public_wait_json(&scope, w)?);
                }
                Ok(AppResponse::AutomationResult {
                    payload: Value::Array(items),
                })
            }
            AppQuery::AutomationShow {
                workspace_id,
                invoking_session_id: _,
                item_id,
            } => {
                let principal_uid = self.resolve_session_dispatch_requester(caller).await?;
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id: workspace_id.clone(),
                };
                let Some(wait) = self.deps.automation_store.get_wait(&scope, &item_id)? else {
                    return Err(PortError::new(
                        PortErrorKind::NotFound,
                        "AUTOMATION_NOT_FOUND",
                    ));
                };
                if wait.owner_machine_id != self.deps.machine_id {
                    return Err(PortError::new(
                        PortErrorKind::NotFound,
                        "AUTOMATION_NOT_FOUND",
                    ));
                }
                self.verify_owned_automation_session(
                    &workspace_id,
                    &wait.session_id,
                    &principal_uid,
                )
                .await?;
                let payload = self.public_wait_json(&scope, &wait)?;
                Ok(AppResponse::AutomationResult { payload })
            }
            AppQuery::AutomationActivities {
                workspace_id,
                invoking_session_id,
                target_session_id,
                limit,
                before,
            } => {
                let (principal_uid, sid_opt) = self
                    .authorize_automation_context(
                        caller,
                        &workspace_id,
                        invoking_session_id.as_ref(),
                        target_session_id.as_ref(),
                        false,
                    )
                    .await?;
                let scope = AutomationWorkspaceScope {
                    machine_id: self.deps.machine_id.clone(),
                    workspace_id,
                };
                let owner_filter = sid_opt.is_none().then_some(&principal_uid);
                let page = self.deps.automation_store.list_activities(
                    &scope,
                    owner_filter,
                    sid_opt.as_ref(),
                    limit,
                    before.as_ref(),
                )?;
                let payload = serde_json::to_value(&page)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
                Ok(AppResponse::AutomationResult { payload })
            }
            AppQuery::ListWorktreeFiles {
                workspace_id,
                repo_key,
                session_id,
                max_files,
            } => {
                let wt_root = match self.session_handle(&workspace_id, &session_id) {
                    Some(h) => match h.inspect_workdir().await {
                        Ok(Some(dir)) => dir,
                        _ => self
                            .deps
                            .worktree
                            .resolve_session_worktree_path(&repo_key, &session_id)?,
                    },
                    None => self
                        .deps
                        .worktree
                        .resolve_session_worktree_path(&repo_key, &session_id)?,
                };
                let res = self.deps.worktree.list_project_files(&wt_root, max_files)?;
                Ok(AppResponse::ProjectFilesListed(res))
            }
            AppQuery::ReadWorktreeFile {
                workspace_id,
                repo_key,
                session_id,
                relative_path,
                max_bytes,
            } => {
                let wt_root_opt = match self.session_handle(&workspace_id, &session_id) {
                    Some(h) => match h.inspect_workdir().await {
                        Ok(Some(dir)) => Some(dir),
                        _ => self
                            .deps
                            .worktree
                            .resolve_session_worktree_path(&repo_key, &session_id)
                            .ok(),
                    },
                    None => self
                        .deps
                        .worktree
                        .resolve_session_worktree_path(&repo_key, &session_id)
                        .ok(),
                };
                let file = match wt_root_opt {
                    Some(wt_root) => self.deps.worktree.read_project_file(
                        &wt_root,
                        &relative_path,
                        max_bytes,
                        false,
                    )?,
                    None => None,
                };
                Ok(AppResponse::ProjectFileRead { file })
            }
            other => self.query_sync(caller, other),
        }
    }

    pub async fn shutdown(&self) {
        self.deps.pty.close_all_terminals();
        let (handles, supervisors) = self
            .workspaces
            .write()
            .expect("workspaces lock")
            .drain_all();
        for sup in supervisors {
            sup.managed_runs.stop_all();
            let _ = sup.shutdown_tx.send(true);
            if let Some(task) = sup.task {
                let _ = task.await;
            }
        }
        for handle in handles {
            handle.shutdown().await;
        }
    }

    fn query_sync(&self, caller: &VerifiedPrincipal, query: AppQuery) -> PortResult<AppResponse> {
        enforce_query_policy(caller, &query)?;

        match query {
            AppQuery::DaemonStatus => {
                let (active_profile_id, server_origin) = match &self.deps.backend {
                    Some(backend) => (
                        backend.profile().profile_id.clone(),
                        Some(backend.profile().server_origin.clone()),
                    ),
                    None => (ProfileId::local_default(), None),
                };
                let lease_mode = self
                    .deps
                    .storage_lease
                    .as_ref()
                    .map_or(self.deps.storage_lease_mode, |l| l.mode());
                Ok(AppResponse::DaemonStatus(DaemonStatusView {
                    machine_id: self.deps.machine_id.clone(),
                    connected: self.is_connected_composition(),
                    active_profile_id,
                    server_origin,
                    storage_lease_mode: lease_mode,
                    capabilities: self.capabilities(),
                }))
            }
            AppQuery::MachineIdentity => Ok(AppResponse::MachineIdentity {
                machine_id: self.deps.machine_id.clone(),
            }),
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
            AppQuery::PrepareProjectAdd { root_path, inspect } => {
                let (local_project_id, name, canonical_root) =
                    self.deps.worktree.prepare_project_root(&root_path)?;
                let already_registered = match self.deps.projects.list_projects() {
                    Ok(list) => list.iter().any(|p| p.project_id == local_project_id),
                    Err(err) if err.kind == PortErrorKind::Unavailable => false,
                    Err(err) => return Err(err),
                };
                let inspection =
                    inspect.then(|| self.deps.worktree.inspect_git_summary(&canonical_root));
                Ok(AppResponse::ProjectAddPrepared(PreparedProjectAdd {
                    local_project_id,
                    name,
                    root_path: canonical_root.to_string_lossy().into_owned(),
                    already_registered,
                    inspection,
                }))
            }
            AppQuery::ListBrowseRoots { home_dir } => {
                let info = self.deps.worktree.list_browse_roots(&home_dir)?;
                Ok(AppResponse::BrowseRootsListed(info))
            }
            AppQuery::BrowseLocalDirectory {
                home_dir,
                browse_query: mut query,
            } => {
                if query.registered_projects.is_empty()
                    && let Ok(projects) = self.deps.projects.list_projects()
                {
                    for p in projects {
                        query
                            .registered_projects
                            .insert(p.project_id.0, p.root_path);
                    }
                }
                let page = self.deps.worktree.browse_directory(&home_dir, &query)?;
                Ok(AppResponse::LocalDirectoryBrowsed(page))
            }
            AppQuery::InspectProjectGitSummary {
                local_project_id,
                root_path,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let summary = self.deps.worktree.inspect_git_summary(&resolved_root);
                Ok(AppResponse::ProjectGitSummary(summary))
            }
            AppQuery::ListProjectBranches {
                local_project_id,
                root_path,
                branch_query,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let page = self
                    .deps
                    .worktree
                    .list_branches(&resolved_root, &branch_query)?;
                Ok(AppResponse::ProjectBranchesListed(page))
            }
            AppQuery::SearchProjectFiles {
                local_project_id,
                root_path,
                search_query,
                limit,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let res = self.deps.worktree.search_project_files(
                    &resolved_root,
                    &search_query,
                    limit,
                )?;
                Ok(AppResponse::ProjectFilesSearched(res))
            }
            AppQuery::ListProjectFiles {
                local_project_id,
                root_path,
                max_files,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let res = self
                    .deps
                    .worktree
                    .list_project_files(&resolved_root, max_files)?;
                Ok(AppResponse::ProjectFilesListed(res))
            }
            AppQuery::ListProjectDirectory {
                local_project_id,
                root_path,
                relative_path,
                limit,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let page = self.deps.worktree.list_project_directory(
                    &resolved_root,
                    &relative_path,
                    limit,
                )?;
                Ok(AppResponse::ProjectDirectoryListed(page))
            }
            AppQuery::ReadProjectFile {
                local_project_id,
                root_path,
                relative_path,
                max_bytes,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let file = self.deps.worktree.read_project_file(
                    &resolved_root,
                    &relative_path,
                    max_bytes,
                    true,
                )?;
                Ok(AppResponse::ProjectFileRead { file })
            }
            AppQuery::ListProjectSkills {
                local_project_id,
                root_path,
                skill_dirs,
                known_fingerprint,
                ..
            } => {
                let resolved_root =
                    self.resolve_project_root_for_query(local_project_id.as_ref(), root_path)?;
                let listing = self.deps.worktree.list_project_skills(
                    &resolved_root,
                    &skill_dirs,
                    known_fingerprint.as_deref(),
                )?;
                Ok(AppResponse::ProjectSkillsListed(listing))
            }
            AppQuery::ListGlobalSkills {
                home_dir,
                known_fingerprint,
            } => {
                let listing = self
                    .deps
                    .worktree
                    .list_global_skills(&home_dir, known_fingerprint.as_deref())?;
                Ok(AppResponse::ProjectSkillsListed(listing))
            }
            AppQuery::ListWorktreeFiles {
                repo_key,
                session_id,
                max_files,
                ..
            } => {
                let wt_root = self
                    .deps
                    .worktree
                    .resolve_session_worktree_path(&repo_key, &session_id)?;
                let res = self.deps.worktree.list_project_files(&wt_root, max_files)?;
                Ok(AppResponse::ProjectFilesListed(res))
            }
            AppQuery::ReadWorktreeFile {
                repo_key,
                session_id,
                relative_path,
                max_bytes,
                ..
            } => {
                let file = match self
                    .deps
                    .worktree
                    .resolve_session_worktree_path(&repo_key, &session_id)
                {
                    Ok(wt_root) => self.deps.worktree.read_project_file(
                        &wt_root,
                        &relative_path,
                        max_bytes,
                        false,
                    )?,
                    Err(_) => None,
                };
                Ok(AppResponse::ProjectFileRead { file })
            }
            AppQuery::ListSessions { .. } => Ok(AppResponse::SessionsListed {
                sessions: Vec::new(),
            }),
            AppQuery::GetSessionStatuses { session_ids, .. } => {
                let statuses = session_ids
                    .into_iter()
                    .map(|session_id| SessionRuntimeStatus {
                        session_id,
                        execution_state: "idle".to_string(),
                        phase: "idle".to_string(),
                        active_turn_id: None,
                    })
                    .collect();
                Ok(AppResponse::SessionStatuses { statuses })
            }
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
                workspace_id,
                session_id,
                turn_id,
            } => {
                let diff = self.deps.diff_store.read_turn_diff(
                    &workspace_id,
                    &session_id,
                    &turn_id,
                    current_epoch_ms_i64(),
                )?;
                Ok(AppResponse::TurnDiff { diff })
            }
            AppQuery::ScanProjectFiles { root_path } => {
                let index = self.deps.worktree.scan_project_files(&root_path)?;
                Ok(AppResponse::ProjectFilesScanned { index })
            }
            AppQuery::ListSchedules {
                workspace_id,
                invoking_session_id,
                filter_query,
                limit,
                offset,
            } => {
                if invoking_session_id.is_some()
                    || matches!(caller, VerifiedPrincipal::AgentSession { .. })
                {
                    return Err(PortError::new(
                        PortErrorKind::Internal,
                        "session-bound schedule queries require async runtime execution",
                    ));
                }
                let _uid = caller.effective_user_id().ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::Unauthorized,
                        "Schedule commands require a verified user identity",
                    )
                })?;
                let schedules = self.deps.schedule_repo.list_schedules(
                    &workspace_id,
                    filter_query.as_deref(),
                    limit,
                    offset,
                )?;
                Ok(AppResponse::SchedulesListed { schedules })
            }
            AppQuery::GetSchedule {
                workspace_id,
                invoking_session_id,
                schedule_id,
            } => {
                if invoking_session_id.is_some()
                    || matches!(caller, VerifiedPrincipal::AgentSession { .. })
                {
                    return Err(PortError::new(
                        PortErrorKind::Internal,
                        "session-bound schedule queries require async runtime execution",
                    ));
                }
                let _uid = caller.effective_user_id().ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::Unauthorized,
                        "Schedule commands require a verified user identity",
                    )
                })?;
                let valid_id = validate_schedule_identifier("scheduleId", &schedule_id)?;
                let schedule = self
                    .deps
                    .schedule_repo
                    .get_schedule(&workspace_id, &valid_id)?;
                Ok(AppResponse::ScheduleRead { schedule })
            }
            AppQuery::AutomationSettings { .. }
            | AppQuery::AutomationList { .. }
            | AppQuery::AutomationShow { .. }
            | AppQuery::AutomationActivities { .. } => Err(PortError::new(
                PortErrorKind::Internal,
                "automation queries require async runtime execution",
            )),
            AppQuery::ListTerminals { session_id } => {
                let terminals = self.deps.pty.list_session_terminals(&session_id);
                Ok(AppResponse::TerminalsListed {
                    session_id,
                    terminals,
                })
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
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            tokio::task::block_in_place(|| handle.block_on(self.query_async(caller, query)))
        } else if let Some(rt) = &self.owned_tokio {
            rt.block_on(self.query_async(caller, query))
        } else {
            self.query_sync(caller, query)
        }
    }

    fn set_mcp_http_endpoint(&self, endpoint: McpHttpEndpointConfig) {
        *self.mcp_endpoint.write().expect("mcp endpoint lock") = Some(endpoint);
    }

    fn register_terminal_sink(&self, sink_id: u64, sink: Arc<dyn TerminalEventSink>) {
        self.deps.pty.register_sink(sink_id, sink);
    }

    fn unregister_terminal_sink(&self, sink_id: u64) {
        self.deps.pty.unregister_sink(sink_id);
    }

    fn drain_for_shutdown(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            tokio::task::block_in_place(|| handle.block_on(self.shutdown()));
        } else if let Some(rt) = &self.owned_tokio {
            rt.block_on(self.shutdown());
        }
    }
}
