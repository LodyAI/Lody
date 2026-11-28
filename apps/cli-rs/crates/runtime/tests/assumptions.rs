use lody_app::{
    AppCommand, AppQuery, AppResponse, MachineId, SessionId, TurnId, UserId, VerifiedPrincipal,
    WorkspaceId,
};
use lody_kernel::{Generation, KernelEvent, SessionPhase};
use lody_ports::{
    AcpEventSink, AcpLauncherPort, AcpSessionPort, AcpSpawnSpec, AdmissionVerdict,
    AdmittedTurnInput, ArtifactRegistryPort, DiffCaptureScope, DiffStorePort, EnginePort,
    EpochKeyMaterial, HistoryPort, HistoryTurnRecord, InboxStorePort, InstalledArtifact,
    LocalProjectId, LocalProjectRecord, ManagedArtifactSource, PermissionDecision, PortError,
    PortErrorKind, PortResult, ProjectStorePort, QueuedDraftItem, ScheduleEditPatch,
    ScheduleProposalInput, ScheduleProposalOutcome, ScheduleRecord, ScheduleRepoPort,
    SessionMetaSnapshot, SessionRunStatus, StaticMachineIdentity, SteerVerdict, StorageLeaseMode,
    SubmissionStage, TurnDiffSummary, TurnTerminalOutcome, UnavailableAutomationSandbox,
    UnavailableAutomationStore, UnavailablePrPollerStore, UnavailableScheduleLedger,
    UnavailableScheduleRepo, WorkspaceSecurityMode, WorktreeLease, WorktreePort,
};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use serde_json::json;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct TestEngine {
    sessions: Mutex<HashMap<(WorkspaceId, SessionId), SessionMetaSnapshot>>,
}
impl EnginePort for TestEngine {
    fn is_connected(&self) -> bool {
        true
    }
    fn read_workspace_security_mode(&self, _: &WorkspaceId) -> PortResult<WorkspaceSecurityMode> {
        Ok(WorkspaceSecurityMode::Plaintext)
    }
    fn read_session_meta(
        &self,
        ws: &WorkspaceId,
        sid: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>> {
        Ok(self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&(ws.clone(), sid.clone()))
            .cloned())
    }
    fn upsert_session_meta(&self, meta: &SessionMetaSnapshot) -> PortResult<()> {
        self.sessions.lock().expect("sessions lock").insert(
            (meta.workspace_id.clone(), meta.session_id.clone()),
            meta.clone(),
        );
        Ok(())
    }
    fn promote_next_queued_draft(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
    ) -> PortResult<Option<QueuedDraftItem>> {
        Ok(None)
    }
    fn set_message_queue_paused(&self, _: &WorkspaceId, _: &SessionId, _: bool) -> PortResult<()> {
        Ok(())
    }
    fn install_workspace_epoch_keys(
        &self,
        _: &WorkspaceId,
        _: &[EpochKeyMaterial],
    ) -> PortResult<()> {
        Ok(())
    }
}

#[derive(Default)]
struct RecordingScheduleRepo {
    proposals: Mutex<Vec<(SessionId, UserId, String)>>,
}
impl ScheduleRepoPort for RecordingScheduleRepo {
    fn list_schedules(
        &self,
        _: &WorkspaceId,
        _: Option<&str>,
        _: usize,
        _: usize,
    ) -> PortResult<Vec<ScheduleRecord>> {
        Ok(Vec::new())
    }
    fn get_schedule(&self, _: &WorkspaceId, _: &str) -> PortResult<Option<ScheduleRecord>> {
        Ok(None)
    }
    fn propose_schedule(
        &self,
        input: &ScheduleProposalInput,
    ) -> PortResult<ScheduleProposalOutcome> {
        self.proposals.lock().expect("proposals lock").push((
            input.invoking_session_id.clone(),
            input.author.clone(),
            input.request_id.clone(),
        ));
        Ok(ScheduleProposalOutcome {
            proposal_id: format!("prop:{}", input.request_id),
            schedule_id: None,
            request_id: input.request_id.clone(),
            base_revision: None,
            status: "pending".to_string(),
        })
    }
    fn propose_schedule_edit(
        &self,
        _: &WorkspaceId,
        invoking_session_id: &SessionId,
        author: &UserId,
        schedule_id: &str,
        request_id: &str,
        _: &ScheduleEditPatch,
    ) -> PortResult<ScheduleProposalOutcome> {
        self.proposals.lock().expect("proposals lock").push((
            invoking_session_id.clone(),
            author.clone(),
            request_id.to_string(),
        ));
        Ok(ScheduleProposalOutcome {
            proposal_id: format!("prop-edit:{request_id}"),
            schedule_id: Some(schedule_id.to_string()),
            request_id: request_id.to_string(),
            base_revision: Some(1),
            status: "pending".to_string(),
        })
    }
    fn pause_schedule(
        &self,
        _: &WorkspaceId,
        _: Option<&SessionId>,
        _: &UserId,
        _: &str,
        _: &str,
    ) -> PortResult<bool> {
        Ok(true)
    }
}

#[derive(Default)]
struct MemoryHistory {
    upsert_calls: AtomicUsize,
    turns: Mutex<HashMap<(WorkspaceId, SessionId), Vec<HistoryTurnRecord>>>,
}
impl HistoryPort for MemoryHistory {
    fn backend_name(&self) -> &'static str {
        "memory"
    }
    fn is_user_turn_durable(
        &self,
        ws: &WorkspaceId,
        sid: &SessionId,
        tid: &TurnId,
    ) -> PortResult<bool> {
        Ok(self
            .turns
            .lock()
            .expect("history lock")
            .get(&(ws.clone(), sid.clone()))
            .is_some_and(|list| list.iter().any(|r| &r.turn_id == tid)))
    }
    fn read_session_turns(
        &self,
        ws: &WorkspaceId,
        sid: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>> {
        Ok(self
            .turns
            .lock()
            .expect("history lock")
            .get(&(ws.clone(), sid.clone()))
            .cloned()
            .unwrap_or_default())
    }
    fn upsert_turn_record(
        &self,
        ws: &WorkspaceId,
        sid: &SessionId,
        record: &HistoryTurnRecord,
    ) -> PortResult<()> {
        let mut guard = self.turns.lock().expect("history lock");
        let list = guard.entry((ws.clone(), sid.clone())).or_default();
        if let Some(existing) = list.iter_mut().find(|r| r.turn_id == record.turn_id) {
            if existing.outcome.is_some() && record.outcome.is_none() {
                return Ok(());
            }
            self.upsert_calls.fetch_add(1, Ordering::SeqCst);
            *existing = record.clone();
        } else {
            self.upsert_calls.fetch_add(1, Ordering::SeqCst);
            list.push(record.clone());
        }
        Ok(())
    }
    fn erase_workspace_turns(&self, ws: &WorkspaceId) -> PortResult<()> {
        self.turns
            .lock()
            .expect("history lock")
            .retain(|(k_ws, _), _| k_ws != ws);
        Ok(())
    }
}

#[derive(Default)]
struct MemoryInbox {
    seen: Mutex<BTreeSet<(WorkspaceId, SessionId, TurnId)>>,
    paused: Mutex<BTreeSet<(WorkspaceId, SessionId)>>,
    queue: Mutex<HashMap<(WorkspaceId, SessionId), VecDeque<AdmittedTurnInput>>>,
}
impl InboxStorePort for MemoryInbox {
    fn store_name(&self) -> &'static str {
        "memory"
    }
    fn admit_turn(&self, input: &AdmittedTurnInput) -> PortResult<AdmissionVerdict> {
        let key = (
            input.workspace_id.clone(),
            input.session_id.clone(),
            input.turn_id.clone(),
        );
        if !self.seen.lock().expect("seen").insert(key) {
            return Ok(AdmissionVerdict::DuplicateIgnored);
        }
        let s_key = (input.workspace_id.clone(), input.session_id.clone());
        self.paused.lock().expect("paused").remove(&s_key);
        self.queue
            .lock()
            .expect("queue")
            .entry(s_key)
            .or_default()
            .push_back(input.clone());
        Ok(AdmissionVerdict::Admitted)
    }
    fn claim_next_runnable(
        &self,
        ws: &WorkspaceId,
        sid: &SessionId,
    ) -> PortResult<Option<AdmittedTurnInput>> {
        let s_key = (ws.clone(), sid.clone());
        if self.paused.lock().expect("paused").contains(&s_key) {
            return Ok(None);
        }
        Ok(self
            .queue
            .lock()
            .expect("queue")
            .get_mut(&s_key)
            .and_then(VecDeque::pop_front))
    }
    fn update_submission_stage(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
        _: &TurnId,
        _: SubmissionStage,
    ) -> PortResult<()> {
        Ok(())
    }
    fn set_inbox_paused(&self, ws: &WorkspaceId, sid: &SessionId, paused: bool) -> PortResult<()> {
        let s_key = (ws.clone(), sid.clone());
        if paused {
            self.paused.lock().expect("paused").insert(s_key);
        } else {
            self.paused.lock().expect("paused").remove(&s_key);
        }
        Ok(())
    }
    fn erase_workspace_inbox(&self, ws: &WorkspaceId) -> PortResult<()> {
        self.queue
            .lock()
            .expect("queue")
            .retain(|(k_ws, _), _| k_ws != ws);
        self.paused
            .lock()
            .expect("paused")
            .retain(|(k_ws, _)| k_ws != ws);
        Ok(())
    }
}

#[derive(Default)]
struct RecordingDiff {
    scopes: Mutex<Vec<(SessionId, DiffCaptureScope)>>,
}
impl DiffStorePort for RecordingDiff {
    fn capture_turn_snapshot(
        &self,
        _: &WorkspaceId,
        sid: &SessionId,
        tid: &TurnId,
        _: &Path,
        scope: &DiffCaptureScope,
        _: i64,
    ) -> PortResult<TurnDiffSummary> {
        self.scopes
            .lock()
            .expect("scopes lock")
            .push((sid.clone(), scope.clone()));
        Ok(TurnDiffSummary {
            session_id: sid.clone(),
            turn_id: tid.clone(),
            files: Vec::new(),
        })
    }
    fn read_turn_diff(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
        _: &TurnId,
        _: i64,
    ) -> PortResult<Option<TurnDiffSummary>> {
        Ok(None)
    }
}

struct NoopArtifacts(ManagedArtifactSource);
impl ArtifactRegistryPort for NoopArtifacts {
    fn source(&self) -> &ManagedArtifactSource {
        &self.0
    }
    fn ensure_installed(&self, _: &str, _: &str) -> PortResult<InstalledArtifact> {
        Err(PortError::new(PortErrorKind::Unavailable, "noop"))
    }
}

#[derive(Default)]
struct RecordingWorktree {
    acquired_bases: Mutex<Vec<Option<String>>>,
}
impl WorktreePort for RecordingWorktree {
    fn supports_git_worktree(&self) -> bool {
        true
    }
    fn acquire_worktree(
        &self,
        project_id: &LocalProjectId,
        project_root: &Path,
        session_id: &SessionId,
        base_branch: Option<&str>,
    ) -> PortResult<WorktreeLease> {
        let captured = base_branch.map(ToOwned::to_owned);
        self.acquired_bases
            .lock()
            .expect("acquired_bases lock")
            .push(captured.clone());
        Ok(WorktreeLease {
            session_id: session_id.clone(),
            project_id: project_id.clone(),
            branch_name: format!("session/{}", session_id.0),
            base_branch: captured,
            worktree_path: project_root.join("wt").join(&session_id.0),
        })
    }
    fn release_worktree(&self, _: &WorktreeLease) -> PortResult<()> {
        Ok(())
    }
}

struct FakeAcpSession {
    fail_on_prompt: bool,
    cancel_calls: Arc<AtomicUsize>,
}
impl AcpSessionPort for FakeAcpSession {
    fn acp_session_id(&self) -> &str {
        "acp_1"
    }
    fn send_prompt(&self, _: &str) -> PortResult<()> {
        if self.fail_on_prompt {
            return Err(PortError::new(PortErrorKind::Internal, "boom"));
        }
        Ok(())
    }
    fn steer(&self, _: &str) -> PortResult<SteerVerdict> {
        Ok(SteerVerdict::Applied)
    }
    fn reply_permission(&self, _: &PermissionDecision) -> PortResult<()> {
        Ok(())
    }
    fn cancel_turn(&self) -> PortResult<()> {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn terminate(&self) -> PortResult<()> {
        Ok(())
    }
}

struct FakeAcpLauncher {
    cancel_calls: Arc<AtomicUsize>,
}
impl AcpLauncherPort for FakeAcpLauncher {
    fn max_concurrent_starts(&self) -> usize {
        4
    }
    fn launch_session(
        &self,
        spec: &AcpSpawnSpec,
        _sink: Arc<dyn AcpEventSink>,
    ) -> PortResult<Box<dyn AcpSessionPort>> {
        Ok(Box::new(FakeAcpSession {
            fail_on_prompt: spec.adapter_id == "broken",
            cancel_calls: Arc::clone(&self.cancel_calls),
        }))
    }
}

struct FixedProjects;
impl ProjectStorePort for FixedProjects {
    fn register_project(&self, name: &str, root: &Path) -> PortResult<LocalProjectRecord> {
        Ok(LocalProjectRecord {
            project_id: LocalProjectId("p1".to_string()),
            name: name.to_string(),
            root_path: root.to_path_buf(),
            git_summary: None,
        })
    }
    fn get_project(&self, pid: &LocalProjectId) -> PortResult<Option<LocalProjectRecord>> {
        if pid.0 == "p1" {
            return Ok(Some(LocalProjectRecord {
                project_id: pid.clone(),
                name: "demo".to_string(),
                root_path: PathBuf::from("/tmp/demo-repo"),
                git_summary: None,
            }));
        }
        Ok(None)
    }
    fn list_projects(&self) -> PortResult<Vec<LocalProjectRecord>> {
        Ok(Vec::new())
    }
}

struct UnwiredEngine;
impl EnginePort for UnwiredEngine {
    fn is_connected(&self) -> bool {
        false
    }
    fn read_workspace_security_mode(&self, _: &WorkspaceId) -> PortResult<WorkspaceSecurityMode> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
    fn read_session_meta(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
    fn upsert_session_meta(&self, _: &SessionMetaSnapshot) -> PortResult<()> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
    fn promote_next_queued_draft(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
    ) -> PortResult<Option<QueuedDraftItem>> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
    fn set_message_queue_paused(&self, _: &WorkspaceId, _: &SessionId, _: bool) -> PortResult<()> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
    fn install_workspace_epoch_keys(
        &self,
        _: &WorkspaceId,
        _: &[EpochKeyMaterial],
    ) -> PortResult<()> {
        Err(PortError::new(PortErrorKind::Unavailable, "unwired"))
    }
}

fn build_test_runtime(
    cancel_calls: Arc<AtomicUsize>,
    history: Arc<MemoryHistory>,
) -> DaemonRuntime {
    let mid = MachineId("m_test".to_string());
    DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            machine_id: mid.clone(),
            identity: Arc::new(StaticMachineIdentity(mid)),
            default_cwd: PathBuf::from("."),
            shell_command: ("/bin/sh".to_string(), Vec::new()),
            agent_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            terminal_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            storage_lease: None,
            engine: Arc::new(TestEngine::default()),
            history,
            inbox: Arc::new(MemoryInbox::default()),
            projects: Arc::new(FixedProjects),
            schedule_repo: Arc::new(UnavailableScheduleRepo),
            schedule_ledger: Arc::new(UnavailableScheduleLedger),
            automation_store: Arc::new(UnavailableAutomationStore),
            automation_sandbox: Arc::new(UnavailableAutomationSandbox),
            pr_poller_store: Arc::new(UnavailablePrPollerStore),
            diff_store: Arc::new(RecordingDiff::default()),
            artifacts: Arc::new(NoopArtifacts(ManagedArtifactSource::Disabled)),
            acp: Arc::new(FakeAcpLauncher { cancel_calls }),
            pty: Arc::new(lody_ports::UnavailablePtyPort),
            worktree: Arc::new(RecordingWorktree::default()),
            backend: None,
        },
        Duration::from_millis(100),
    )
}

async fn wait_for_running_or_idle(handle: &lody_runtime::SessionHandle, want_running: bool) {
    for _ in 0..200 {
        let phase = handle.inspect_phase().await.expect("inspect phase");
        let ok = if want_running {
            matches!(phase, SessionPhase::Running(_))
        } else {
            matches!(phase, SessionPhase::Idle { .. })
        };
        if ok {
            return;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_cancel_preempts_backlog_coalesces_writes_and_isolates_sibling_failure() {
    let cancel_calls = Arc::new(AtomicUsize::new(0));
    let history = Arc::new(MemoryHistory::default());
    let runtime = build_test_runtime(Arc::clone(&cancel_calls), Arc::clone(&history));
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(1),
        account_id: None,
    };
    let ws = WorkspaceId("ws_1".to_string());

    let broken_sid = SessionId("s_broken".to_string());
    runtime
        .execute_async(
            &caller,
            AppCommand::CreateSession {
                workspace_id: ws.clone(),
                session_id: broken_sid.clone(),
                turn_id: TurnId("t_fail".to_string()),
                local_project_id: None,
                base_branch: None,
                use_worktree: false,
                adapter_id: "broken".to_string(),
                custom_acp: None,
                prompt: "crash".to_string(),
            },
        )
        .await
        .expect("broken session accepted");
    let broken_handle = runtime
        .session_handle(&ws, &broken_sid)
        .expect("broken handle");
    wait_for_running_or_idle(&broken_handle, false).await;

    let healthy_sid = SessionId("s_healthy".to_string());
    runtime
        .execute_async(
            &caller,
            AppCommand::CreateSession {
                workspace_id: ws.clone(),
                session_id: healthy_sid.clone(),
                turn_id: TurnId("t_stream".to_string()),
                local_project_id: None,
                base_branch: None,
                use_worktree: false,
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "stream".to_string(),
            },
        )
        .await
        .expect("healthy session accepted");

    let handle = runtime
        .session_handle(&ws, &healthy_sid)
        .expect("healthy handle");
    wait_for_running_or_idle(&handle, true).await;

    let writes_before_stream = history.upsert_calls.load(Ordering::SeqCst);
    for i in 0..300 {
        let _ = handle.try_send_event(KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: format!("c{i};"),
            observed_at_ms: 1000,
        });
    }

    runtime
        .execute_async(
            &caller,
            AppCommand::CancelSession {
                workspace_id: ws.clone(),
                session_id: healthy_sid.clone(),
                pause_inbox: true,
            },
        )
        .await
        .expect("cancel session");

    assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
    let stream_writes = history.upsert_calls.load(Ordering::SeqCst) - writes_before_stream;
    assert!(stream_writes < 10);

    let AppResponse::SessionHistory { turns } = runtime
        .query_async(
            &caller,
            AppQuery::GetSessionHistory {
                workspace_id: ws.clone(),
                session_id: healthy_sid,
            },
        )
        .await
        .expect("read healthy history")
    else {
        panic!("unexpected response");
    };
    assert_eq!(turns[0].outcome, Some(TurnTerminalOutcome::Canceled));

    let AppResponse::SessionHistory {
        turns: broken_turns,
    } = runtime
        .query_async(
            &caller,
            AppQuery::GetSessionHistory {
                workspace_id: ws,
                session_id: broken_sid,
            },
        )
        .await
        .expect("read broken history")
    else {
        panic!("unexpected response");
    };
    assert_eq!(broken_turns[0].outcome, Some(TurnTerminalOutcome::Failed));

    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detaching_and_erasing_one_workspace_preserves_sibling_workspace_and_rejects_encrypted_downgrade()
 {
    let runtime = build_test_runtime(
        Arc::new(AtomicUsize::new(0)),
        Arc::new(MemoryHistory::default()),
    );
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(1),
        account_id: None,
    };
    let ws_a = WorkspaceId("ws_encrypted_a".to_string());
    let ws_b = WorkspaceId("ws_plaintext_b".to_string());

    runtime
        .execute_async(
            &caller,
            AppCommand::AttachWorkspace {
                workspace_id: ws_a.clone(),
                security_mode: Some(WorkspaceSecurityMode::Encrypted {
                    genesis_hash: "gen_1".to_string(),
                }),
            },
        )
        .await
        .expect("attach ws_a");

    let downgrade_err = runtime
        .execute_async(
            &caller,
            AppCommand::AttachWorkspace {
                workspace_id: ws_a.clone(),
                security_mode: Some(WorkspaceSecurityMode::Plaintext),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(downgrade_err.kind, PortErrorKind::Conflict);

    for (ws, sid) in [(&ws_a, "s_a"), (&ws_b, "s_b")] {
        let session_id = SessionId((*sid).to_string());
        runtime
            .execute_async(
                &caller,
                AppCommand::CreateSession {
                    workspace_id: ws.clone(),
                    session_id: session_id.clone(),
                    turn_id: TurnId("t_1".to_string()),
                    local_project_id: None,
                    base_branch: None,
                    use_worktree: false,
                    adapter_id: "ok".to_string(),
                    custom_acp: None,
                    prompt: "hello".to_string(),
                },
            )
            .await
            .expect("create session");
        let h = runtime.session_handle(ws, &session_id).unwrap();
        wait_for_running_or_idle(&h, true).await;
    }

    let detach_resp = runtime
        .execute_async(
            &caller,
            AppCommand::DetachWorkspace {
                workspace_id: ws_a.clone(),
                erase_local_state: true,
            },
        )
        .await
        .expect("detach ws_a");
    assert_eq!(
        detach_resp,
        AppResponse::WorkspaceDetached {
            workspace_id: ws_a.clone(),
            drained_sessions: 1,
        }
    );
    assert!(
        runtime
            .session_handle(&ws_a, &SessionId("s_a".to_string()))
            .is_none()
    );
    assert!(
        runtime
            .session_handle(&ws_b, &SessionId("s_b".to_string()))
            .is_some()
    );

    let AppResponse::SessionHistory { turns: turns_a } = runtime
        .query_async(
            &caller,
            AppQuery::GetSessionHistory {
                workspace_id: ws_a,
                session_id: SessionId("s_a".to_string()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected history");
    };
    assert!(turns_a.is_empty());

    let AppResponse::SessionHistory { turns: turns_b } = runtime
        .query_async(
            &caller,
            AppQuery::GetSessionHistory {
                workspace_id: ws_b,
                session_id: SessionId("s_b".to_string()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected history");
    };
    assert_eq!(turns_b.len(), 1);

    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_delegation_rejects_when_stopped_or_over_depth_and_delivers_receipt_to_parent() {
    let history = Arc::new(MemoryHistory::default());
    let runtime = build_test_runtime(Arc::new(AtomicUsize::new(0)), Arc::clone(&history));
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(1),
        account_id: None,
    };
    let ws = WorkspaceId("ws_del".to_string());
    let parent_sid = SessionId("s_parent".to_string());

    runtime
        .execute_async(
            &caller,
            AppCommand::CreateSession {
                workspace_id: ws.clone(),
                session_id: parent_sid.clone(),
                turn_id: TurnId("t_parent_1".to_string()),
                local_project_id: None,
                base_branch: None,
                use_worktree: false,
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "parent".to_string(),
            },
        )
        .await
        .unwrap();
    let parent_handle = runtime.session_handle(&ws, &parent_sid).unwrap();
    wait_for_running_or_idle(&parent_handle, true).await;

    let mcp_parent = VerifiedPrincipal::AgentSession {
        workspace_id: ws.clone(),
        session_id: parent_sid.clone(),
        machine_id: MachineId("m_test".to_string()),
        account_id: None,
    };

    let child_sid = SessionId("s_child_1".to_string());
    runtime
        .execute_async(
            &mcp_parent,
            AppCommand::DelegateChildSession {
                workspace_id: ws.clone(),
                parent_session_id: parent_sid.clone(),
                child_session_id: child_sid.clone(),
                turn_id: TurnId("t_child_1".to_string()),
                operation_id: Some("op_child_1".to_string()),
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "child task".to_string(),
            },
        )
        .await
        .expect("depth-1 child delegation admitted");

    let mcp_child = VerifiedPrincipal::AgentSession {
        workspace_id: ws.clone(),
        session_id: child_sid.clone(),
        machine_id: MachineId("m_test".to_string()),
        account_id: None,
    };
    let grandchild_err = runtime
        .execute_async(
            &mcp_child,
            AppCommand::DelegateChildSession {
                workspace_id: ws.clone(),
                parent_session_id: child_sid.clone(),
                child_session_id: SessionId("s_grandchild".to_string()),
                turn_id: TurnId("t_gc".to_string()),
                operation_id: Some("op_gc".to_string()),
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "grandchild".to_string(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(grandchild_err.kind, PortErrorKind::Forbidden);

    parent_handle
        .send_event(KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "parent done".to_string(),
            observed_at_ms: 1000,
        })
        .await
        .unwrap();
    parent_handle
        .send_event(KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        })
        .await
        .unwrap();
    wait_for_running_or_idle(&parent_handle, false).await;

    let child_handle = runtime.session_handle(&ws, &child_sid).unwrap();
    wait_for_running_or_idle(&child_handle, true).await;
    child_handle
        .send_event(KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "child summary output".to_string(),
            observed_at_ms: 1000,
        })
        .await
        .unwrap();
    child_handle
        .send_event(KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        })
        .await
        .unwrap();

    wait_for_running_or_idle(&parent_handle, true).await;

    runtime
        .execute_async(
            &caller,
            AppCommand::CancelSession {
                workspace_id: ws.clone(),
                session_id: parent_sid.clone(),
                pause_inbox: true,
            },
        )
        .await
        .unwrap();

    let stopped_err = runtime
        .execute_async(
            &mcp_parent,
            AppCommand::DelegateChildSession {
                workspace_id: ws.clone(),
                parent_session_id: parent_sid.clone(),
                child_session_id: SessionId("s_child_blocked".to_string()),
                turn_id: TurnId("t_blocked".to_string()),
                operation_id: Some("op_blocked".to_string()),
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "blocked by stop".to_string(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(stopped_err.kind, PortErrorKind::Forbidden);

    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schedule_service_boundary_rejects_non_owners_and_unwired_engine_while_preserving_worktree_base()
 {
    let mid = MachineId("m_host".to_string());
    let unwired_runtime = DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            machine_id: mid.clone(),
            identity: Arc::new(StaticMachineIdentity(mid.clone())),
            default_cwd: PathBuf::from("."),
            shell_command: ("/bin/sh".to_string(), Vec::new()),
            agent_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            terminal_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            storage_lease: None,
            engine: Arc::new(UnwiredEngine),
            history: Arc::new(MemoryHistory::default()),
            inbox: Arc::new(MemoryInbox::default()),
            projects: Arc::new(FixedProjects),
            schedule_repo: Arc::new(UnavailableScheduleRepo),
            schedule_ledger: Arc::new(UnavailableScheduleLedger),
            automation_store: Arc::new(UnavailableAutomationStore),
            automation_sandbox: Arc::new(UnavailableAutomationSandbox),
            pr_poller_store: Arc::new(UnavailablePrPollerStore),
            diff_store: Arc::new(RecordingDiff::default()),
            artifacts: Arc::new(NoopArtifacts(ManagedArtifactSource::Disabled)),
            acp: Arc::new(FakeAcpLauncher {
                cancel_calls: Arc::new(AtomicUsize::new(0)),
            }),
            pty: Arc::new(lody_ports::UnavailablePtyPort),
            worktree: Arc::new(RecordingWorktree::default()),
            backend: None,
        },
        Duration::from_millis(100),
    );

    let ws = WorkspaceId("ws_sched".to_string());
    let sid = SessionId("sess_owner_1".to_string());
    let mcp_caller = VerifiedPrincipal::AgentSession {
        workspace_id: ws.clone(),
        session_id: sid.clone(),
        machine_id: mid.clone(),
        account_id: None,
    };

    let unwired_err = unwired_runtime
        .execute_async(
            &mcp_caller,
            AppCommand::ProposeSchedule {
                workspace_id: ws.clone(),
                invoking_session_id: sid.clone(),
                request_id: "req_1".to_string(),
                title: "Nightly".to_string(),
                prompt_text: "audit".to_string(),
                rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(unwired_err.kind, PortErrorKind::Unavailable);
    unwired_runtime.shutdown().await;

    let engine = Arc::new(TestEngine::default());
    let schedule_repo = Arc::new(RecordingScheduleRepo::default());
    let diff_store = Arc::new(RecordingDiff::default());
    let worktree = Arc::new(RecordingWorktree::default());
    let runtime = DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            machine_id: mid.clone(),
            identity: Arc::new(StaticMachineIdentity(mid.clone())),
            default_cwd: PathBuf::from("."),
            shell_command: ("/bin/sh".to_string(), Vec::new()),
            agent_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            terminal_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            storage_lease: None,
            engine: Arc::clone(&engine) as Arc<dyn EnginePort>,
            history: Arc::new(MemoryHistory::default()),
            inbox: Arc::new(MemoryInbox::default()),
            projects: Arc::new(FixedProjects),
            schedule_repo: Arc::clone(&schedule_repo) as Arc<dyn ScheduleRepoPort>,
            schedule_ledger: Arc::new(UnavailableScheduleLedger),
            automation_store: Arc::new(UnavailableAutomationStore),
            automation_sandbox: Arc::new(UnavailableAutomationSandbox),
            pr_poller_store: Arc::new(UnavailablePrPollerStore),
            diff_store: Arc::clone(&diff_store) as Arc<dyn DiffStorePort>,
            artifacts: Arc::new(NoopArtifacts(ManagedArtifactSource::Disabled)),
            acp: Arc::new(FakeAcpLauncher {
                cancel_calls: Arc::new(AtomicUsize::new(0)),
            }),
            pty: Arc::new(lody_ports::UnavailablePtyPort),
            worktree: Arc::clone(&worktree) as Arc<dyn WorktreePort>,
            backend: None,
        },
        Duration::from_millis(100),
    );

    assert_eq!(
        runtime
            .execute_async(
                &mcp_caller,
                AppCommand::ProposeSchedule {
                    workspace_id: ws.clone(),
                    invoking_session_id: sid.clone(),
                    request_id: "req_missing".to_string(),
                    title: "Nightly".to_string(),
                    prompt_text: "audit".to_string(),
                    rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
                },
            )
            .await
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );

    engine
        .upsert_session_meta(&SessionMetaSnapshot {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            root_session_id: sid.clone(),
            owner_user_id: UserId("u_alice".to_string()),
            owner_machine_id: mid.clone(),
            deleted: true,
            local_project_id: Some(LocalProjectId("p1".to_string())),
            base_branch: Some("release".to_string()),
            title: None,
            status: SessionRunStatus::Running,
            queue_paused: false,
            queued_count: 0,
        })
        .unwrap();

    assert_eq!(
        runtime
            .execute_async(
                &mcp_caller,
                AppCommand::ProposeSchedule {
                    workspace_id: ws.clone(),
                    invoking_session_id: sid.clone(),
                    request_id: "req_deleted".to_string(),
                    title: "Nightly".to_string(),
                    prompt_text: "audit".to_string(),
                    rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
                },
            )
            .await
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );

    engine
        .upsert_session_meta(&SessionMetaSnapshot {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            root_session_id: sid.clone(),
            owner_user_id: UserId("u_alice".to_string()),
            owner_machine_id: MachineId("m_other_machine".to_string()),
            deleted: false,
            local_project_id: Some(LocalProjectId("p1".to_string())),
            base_branch: Some("release".to_string()),
            title: None,
            status: SessionRunStatus::Running,
            queue_paused: false,
            queued_count: 0,
        })
        .unwrap();

    assert_eq!(
        runtime
            .execute_async(
                &mcp_caller,
                AppCommand::ProposeSchedule {
                    workspace_id: ws.clone(),
                    invoking_session_id: sid.clone(),
                    request_id: "req_wrong_machine".to_string(),
                    title: "Nightly".to_string(),
                    prompt_text: "audit".to_string(),
                    rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
                },
            )
            .await
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );

    engine
        .upsert_session_meta(&SessionMetaSnapshot {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            root_session_id: sid.clone(),
            owner_user_id: UserId("u_alice".to_string()),
            owner_machine_id: mid.clone(),
            deleted: false,
            local_project_id: Some(LocalProjectId("p1".to_string())),
            base_branch: Some("release".to_string()),
            title: None,
            status: SessionRunStatus::Running,
            queue_paused: false,
            queued_count: 0,
        })
        .unwrap();

    assert_eq!(
        runtime
            .execute_async(
                &mcp_caller,
                AppCommand::ProposeSchedule {
                    workspace_id: ws.clone(),
                    invoking_session_id: sid.clone(),
                    request_id: "req_raw_cron".to_string(),
                    title: "Nightly".to_string(),
                    prompt_text: "audit".to_string(),
                    rule: json!("0 2 * * *"),
                },
            )
            .await
            .unwrap_err()
            .kind,
        PortErrorKind::InvalidInput
    );

    runtime
        .execute_async(
            &mcp_caller,
            AppCommand::ProposeSchedule {
                workspace_id: ws.clone(),
                invoking_session_id: sid.clone(),
                request_id: "req_valid".to_string(),
                title: "Nightly".to_string(),
                prompt_text: "audit".to_string(),
                rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
            },
        )
        .await
        .expect("verified session owner proposal routed with real UserId");
    assert_eq!(
        schedule_repo.proposals.lock().unwrap().as_slice(),
        &[(
            sid.clone(),
            UserId("u_alice".to_string()),
            "req_valid".to_string()
        )]
    );

    let guest_host = VerifiedPrincipal::LocalHost {
        caller_pid: Some(9),
        account_id: Some(UserId("u_guest".to_string())),
    };
    runtime
        .execute_async(
            &guest_host,
            AppCommand::CreateSession {
                workspace_id: ws.clone(),
                session_id: sid.clone(),
                turn_id: TurnId("t_rel_1".to_string()),
                local_project_id: Some(LocalProjectId("p1".to_string())),
                base_branch: Some("release".to_string()),
                use_worktree: true,
                adapter_id: "ok".to_string(),
                custom_acp: None,
                prompt: "work on release".to_string(),
            },
        )
        .await
        .unwrap();
    let handle = runtime.session_handle(&ws, &sid).unwrap();
    wait_for_running_or_idle(&handle, true).await;

    assert_eq!(
        runtime
            .execute_async(
                &mcp_caller,
                AppCommand::ProposeSchedule {
                    workspace_id: ws.clone(),
                    invoking_session_id: sid.clone(),
                    request_id: "req_guest_mismatch".to_string(),
                    title: "Nightly".to_string(),
                    prompt_text: "audit".to_string(),
                    rule: json!({ "kind": "daily", "hour": 2, "minute": 0 }),
                },
            )
            .await
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );

    handle
        .send_event(KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "done".to_string(),
            observed_at_ms: 1000,
        })
        .await
        .unwrap();
    handle
        .send_event(KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        })
        .await
        .unwrap();
    wait_for_running_or_idle(&handle, false).await;

    assert_eq!(
        worktree.acquired_bases.lock().unwrap().as_slice(),
        &[Some("release".to_string())]
    );
    assert_eq!(
        diff_store.scopes.lock().unwrap().as_slice(),
        &[(
            sid,
            DiffCaptureScope::WorktreeBranch {
                base_branch: Some("release".to_string())
            }
        )]
    );

    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schedule_and_automation_runners_dispatch_due_slots_and_block_continuation_under_stop_barrier()
 {
    use lody_ports::{
        AutomationActivityCursor, AutomationActivityPage, AutomationHostOps, AutomationMatchResult,
        AutomationProgramContext, AutomationProgramEvaluation, AutomationReceiptPatch,
        AutomationReceiptRecord, AutomationReceiptState, AutomationRegistrationInput,
        AutomationRunExit, AutomationRunInput, AutomationSandboxPort, AutomationStorePort,
        AutomationWaitCompletion, AutomationWaitRecord, AutomationWaitState,
        AutomationWorkspaceScope, InboxCategory, ScheduleCursorRecord, ScheduleDestination,
        ScheduleLedgerPort, ScheduleLedgerRunRecord, ScheduleMisfirePolicy, ScheduleOverlapPolicy,
        ScheduleRetryPolicy, ScheduleRunState,
    };

    struct StaticScheduleRepo(Vec<ScheduleRecord>);
    impl ScheduleRepoPort for StaticScheduleRepo {
        fn list_schedules(
            &self,
            _: &WorkspaceId,
            _: Option<&str>,
            _: usize,
            _: usize,
        ) -> PortResult<Vec<ScheduleRecord>> {
            Ok(self.0.clone())
        }
        fn get_schedule(&self, _: &WorkspaceId, id: &str) -> PortResult<Option<ScheduleRecord>> {
            Ok(self.0.iter().find(|s| s.schedule_id == id).cloned())
        }
        fn propose_schedule(
            &self,
            _: &ScheduleProposalInput,
        ) -> PortResult<ScheduleProposalOutcome> {
            Err(PortError::new(PortErrorKind::Unavailable, "unused"))
        }
        fn propose_schedule_edit(
            &self,
            _: &WorkspaceId,
            _: &SessionId,
            _: &UserId,
            _: &str,
            _: &str,
            _: &ScheduleEditPatch,
        ) -> PortResult<ScheduleProposalOutcome> {
            Err(PortError::new(PortErrorKind::Unavailable, "unused"))
        }
        fn pause_schedule(
            &self,
            _: &WorkspaceId,
            _: Option<&SessionId>,
            _: &UserId,
            _: &str,
            _: &str,
        ) -> PortResult<bool> {
            Ok(false)
        }
    }

    #[derive(Default)]
    struct MemoryScheduleLedger {
        cursors: Mutex<HashMap<(WorkspaceId, String, String), ScheduleCursorRecord>>,
        runs: Mutex<HashMap<String, ScheduleLedgerRunRecord>>,
    }
    impl ScheduleLedgerPort for MemoryScheduleLedger {
        fn read_planning_cursor(
            &self,
            ws: &WorkspaceId,
            sid: &str,
            act: &str,
        ) -> PortResult<Option<ScheduleCursorRecord>> {
            Ok(self
                .cursors
                .lock()
                .unwrap()
                .get(&(ws.clone(), sid.to_string(), act.to_string()))
                .cloned())
        }
        fn commit_planned_slot(
            &self,
            cursor: &ScheduleCursorRecord,
            run: Option<&ScheduleLedgerRunRecord>,
        ) -> PortResult<()> {
            self.cursors.lock().unwrap().insert(
                (
                    cursor.workspace_id.clone(),
                    cursor.schedule_id.clone(),
                    cursor.activation_id.clone(),
                ),
                cursor.clone(),
            );
            if let Some(r) = run {
                self.runs
                    .lock()
                    .unwrap()
                    .insert(r.run_key.clone(), r.clone());
            }
            Ok(())
        }
        fn get_run(&self, key: &str) -> PortResult<Option<ScheduleLedgerRunRecord>> {
            Ok(self.runs.lock().unwrap().get(key).cloned())
        }
        fn unfinished_runs(&self, ws: &WorkspaceId) -> PortResult<Vec<ScheduleLedgerRunRecord>> {
            Ok(self
                .runs
                .lock()
                .unwrap()
                .values()
                .filter(|r| {
                    &r.workspace_id == ws
                        && matches!(
                            r.state,
                            ScheduleRunState::Pending
                                | ScheduleRunState::Prepared
                                | ScheduleRunState::Dispatched
                                | ScheduleRunState::RetryWait
                        )
                })
                .cloned()
                .collect())
        }
        fn transition_run(
            &self,
            key: &str,
            allowed: &[ScheduleRunState],
            next: ScheduleRunState,
            payload: &str,
        ) -> PortResult<()> {
            let mut guard = self.runs.lock().unwrap();
            let rec = guard
                .get_mut(key)
                .ok_or_else(|| PortError::new(PortErrorKind::NotFound, "missing"))?;
            if !allowed.contains(&rec.state) {
                return Err(PortError::new(PortErrorKind::Conflict, "state mismatch"));
            }
            rec.state = next;
            rec.payload_json = payload.to_string();
            Ok(())
        }
        fn has_consumed_complete_message(&self, _: &WorkspaceId, _: &str) -> PortResult<bool> {
            Ok(false)
        }
    }

    #[derive(Default)]
    struct MemoryAutomationStore {
        waits: Mutex<HashMap<String, AutomationWaitRecord>>,
        receipts: Mutex<HashMap<String, AutomationReceiptRecord>>,
    }
    impl AutomationStorePort for MemoryAutomationStore {
        fn workspace_run_logs_dir(&self, _: &AutomationWorkspaceScope) -> PathBuf {
            PathBuf::from("/tmp")
        }
        fn register_wait(
            &self,
            scope: &AutomationWorkspaceScope,
            sid: &SessionId,
            uid: &UserId,
            input: &AutomationRegistrationInput,
            now_ms: i64,
        ) -> PortResult<AutomationWaitRecord> {
            let mut guard = self.waits.lock().unwrap();
            let id = format!("w_{}", guard.len() + 1);
            let rec = AutomationWaitRecord {
                id: id.clone(),
                session_id: sid.clone(),
                workspace_id: scope.workspace_id.clone(),
                owner_user_id: uid.clone(),
                owner_machine_id: scope.machine_id.clone(),
                program: Some(input.program.clone()),
                run: None,
                reason: input.reason.clone(),
                interval_ms: input.interval_ms,
                expires_at: input.expires_at,
                created_at: now_ms,
                updated_at: now_ms,
                next_check_at: now_ms,
                checks: 0,
                consecutive_errors: 0,
                state: AutomationWaitState::Waiting,
                last_error: None,
                result: None,
                invocation_id: None,
                reads: None,
                evidence: None,
            };
            guard.insert(id, rec.clone());
            Ok(rec)
        }
        fn register_run(
            &self,
            _: &AutomationWorkspaceScope,
            _: &SessionId,
            _: &UserId,
            _: &AutomationRunInput,
            _: i64,
        ) -> PortResult<AutomationWaitRecord> {
            Err(PortError::new(PortErrorKind::Unavailable, "unused"))
        }
        fn get_wait(
            &self,
            _: &AutomationWorkspaceScope,
            id: &str,
        ) -> PortResult<Option<AutomationWaitRecord>> {
            Ok(self.waits.lock().unwrap().get(id).cloned())
        }
        fn list_waits(
            &self,
            _: &AutomationWorkspaceScope,
            _: Option<&UserId>,
            _: Option<&SessionId>,
        ) -> PortResult<Vec<AutomationWaitRecord>> {
            Ok(self.waits.lock().unwrap().values().cloned().collect())
        }
        fn due_waits(
            &self,
            _: &AutomationWorkspaceScope,
            now_ms: i64,
            _: usize,
        ) -> PortResult<Vec<AutomationWaitRecord>> {
            Ok(self
                .waits
                .lock()
                .unwrap()
                .values()
                .filter(|w| w.state == AutomationWaitState::Waiting && w.next_check_at <= now_ms)
                .cloned()
                .collect())
        }
        fn claim_wait(
            &self,
            _: &AutomationWorkspaceScope,
            id: &str,
            now_ms: i64,
        ) -> PortResult<Option<AutomationWaitRecord>> {
            let mut guard = self.waits.lock().unwrap();
            let Some(w) = guard.get_mut(id) else {
                return Ok(None);
            };
            if w.state != AutomationWaitState::Waiting {
                return Ok(None);
            }
            w.state = AutomationWaitState::Checking;
            w.checks += 1;
            w.updated_at = now_ms;
            Ok(Some(w.clone()))
        }
        fn claim_run_start(
            &self,
            _: &AutomationWorkspaceScope,
            _: &str,
            _: i64,
        ) -> PortResult<bool> {
            Ok(false)
        }
        fn record_run_pid(
            &self,
            _: &AutomationWorkspaceScope,
            _: &str,
            _: u32,
            _: i64,
        ) -> PortResult<()> {
            Ok(())
        }
        fn record_run_exit(
            &self,
            _: &AutomationWorkspaceScope,
            _: &str,
            _: &AutomationRunExit,
            _: i64,
        ) -> PortResult<Option<AutomationWaitRecord>> {
            Ok(None)
        }
        fn orphan_started_runs(&self, _: &AutomationWorkspaceScope, _: i64) -> PortResult<usize> {
            Ok(0)
        }
        fn finish_wait_not_ready(
            &self,
            _: &AutomationWorkspaceScope,
            comp: &AutomationWaitCompletion,
            next_at: i64,
        ) -> PortResult<()> {
            if let Some(w) = self.waits.lock().unwrap().get_mut(&comp.wait_id) {
                w.state = AutomationWaitState::Waiting;
                w.next_check_at = next_at;
            }
            Ok(())
        }
        fn finish_wait_matched(
            &self,
            _: &AutomationWorkspaceScope,
            comp: &AutomationWaitCompletion,
            res: &AutomationMatchResult,
        ) -> PortResult<Option<AutomationReceiptRecord>> {
            let mut guard = self.waits.lock().unwrap();
            let Some(w) = guard.get_mut(&comp.wait_id) else {
                return Ok(None);
            };
            let rcpt_id = format!("rcpt_{}", w.id);
            w.state = AutomationWaitState::Matched;
            w.result = Some(res.clone());
            w.invocation_id = Some(rcpt_id.clone());
            let rcpt = AutomationReceiptRecord {
                id: rcpt_id.clone(),
                delivery_id: format!("del_{}", w.id),
                state: AutomationReceiptState::Accepted,
                reason: None,
                rule: json!({ "ownerUserId": w.owner_user_id.0 }),
                event: json!({}),
                intent: json!({
                    "action": {
                        "parameters": {
                            "input": { "resumeText": res.resume_text }
                        }
                    }
                }),
                session_id: Some(w.session_id.clone()),
                turn_id: Some(TurnId(format!("turn_{rcpt_id}"))),
                attempts: 0,
                retry_at: Some(0),
                created_at: comp.now_ms,
                updated_at: comp.now_ms,
            };
            self.receipts.lock().unwrap().insert(rcpt_id, rcpt.clone());
            Ok(Some(rcpt))
        }
        fn finish_wait_error(
            &self,
            _: &AutomationWorkspaceScope,
            _: &str,
            _: &str,
            _: bool,
            _: i64,
            _: i64,
        ) -> PortResult<()> {
            Ok(())
        }
        fn expire_wait(&self, _: &AutomationWorkspaceScope, _: &str, _: i64) -> PortResult<()> {
            Ok(())
        }
        fn cancel_item(
            &self,
            _: &AutomationWorkspaceScope,
            _: &str,
            _: i64,
        ) -> PortResult<Option<serde_json::Value>> {
            Ok(None)
        }
        fn get_receipt(
            &self,
            _: &AutomationWorkspaceScope,
            id: &str,
        ) -> PortResult<Option<AutomationReceiptRecord>> {
            Ok(self.receipts.lock().unwrap().get(id).cloned())
        }
        fn actionable_receipts(
            &self,
            _: &AutomationWorkspaceScope,
            _: i64,
            _: usize,
        ) -> PortResult<Vec<AutomationReceiptRecord>> {
            Ok(self
                .receipts
                .lock()
                .unwrap()
                .values()
                .filter(|r| r.state == AutomationReceiptState::Accepted)
                .cloned()
                .collect())
        }
        fn update_receipt(
            &self,
            _: &AutomationWorkspaceScope,
            id: &str,
            patch: &AutomationReceiptPatch,
        ) -> PortResult<()> {
            if let Some(r) = self.receipts.lock().unwrap().get_mut(id) {
                r.state = patch.state;
                r.reason = patch.reason.clone();
                r.attempts = patch.attempts;
            }
            Ok(())
        }
        fn read_session_settings(
            &self,
            _: &AutomationWorkspaceScope,
            _: &SessionId,
        ) -> PortResult<serde_json::Value> {
            Ok(json!({}))
        }
        fn configure_session_settings(
            &self,
            _: &AutomationWorkspaceScope,
            _: &SessionId,
            _: &UserId,
            _: &serde_json::Value,
            _: i64,
        ) -> PortResult<serde_json::Value> {
            Ok(json!({}))
        }
        fn list_activities(
            &self,
            _: &AutomationWorkspaceScope,
            _: Option<&UserId>,
            _: Option<&SessionId>,
            _: usize,
            _: Option<&AutomationActivityCursor>,
        ) -> PortResult<AutomationActivityPage> {
            Ok(AutomationActivityPage {
                items: Vec::new(),
                next_cursor: None,
            })
        }
        fn next_due_at(&self, _: &AutomationWorkspaceScope) -> PortResult<Option<i64>> {
            Ok(None)
        }
        fn erase_workspace_store(&self, _: &AutomationWorkspaceScope) -> PortResult<()> {
            Ok(())
        }
    }

    struct DeterministicSandbox;
    impl AutomationSandboxPort for DeterministicSandbox {
        fn validate_program(&self, source: &str, _: &AutomationProgramContext) -> PortResult<()> {
            if source.contains("SYNTAX_ERR") {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_PROGRAM_MUST_BE_FUNCTION",
                ));
            }
            Ok(())
        }
        fn evaluate_program(
            &self,
            source: &str,
            _: &AutomationProgramContext,
            _: Arc<dyn AutomationHostOps>,
        ) -> PortResult<AutomationProgramEvaluation> {
            Ok(AutomationProgramEvaluation {
                matched: source.contains("MATCH").then(|| AutomationMatchResult {
                    resume_text: "Condition satisfied".to_string(),
                    payload: None,
                }),
                reads: vec!["session".to_string()],
                evidence: Vec::new(),
            })
        }
    }

    let mid = MachineId("m_sched_auto".to_string());
    let ws = WorkspaceId("ws_auto".to_string());
    let sid_sched = SessionId("sess_sched_target".to_string());
    let sid_stopped = SessionId("sess_stopped_target".to_string());
    let uid = UserId("u_alice".to_string());

    let engine = Arc::new(TestEngine::default());
    for target in [&sid_sched, &sid_stopped] {
        engine
            .upsert_session_meta(&SessionMetaSnapshot {
                workspace_id: ws.clone(),
                session_id: target.clone(),
                root_session_id: target.clone(),
                owner_user_id: uid.clone(),
                owner_machine_id: mid.clone(),
                deleted: false,
                local_project_id: None,
                base_branch: None,
                title: None,
                status: SessionRunStatus::Idle,
                queue_paused: target == &sid_stopped,
                queued_count: 0,
            })
            .unwrap();
    }

    let due_at_iso = "2099-04-08T09:00:00Z";
    let due_at_ms = lody_kernel::parse_rfc3339_millis(due_at_iso).unwrap();
    let sched_repo = Arc::new(StaticScheduleRepo(vec![ScheduleRecord {
        schedule_id: "sched_due_1".to_string(),
        workspace_id: ws.clone(),
        session_id: Some(sid_sched.clone()),
        author_user_id: uid.clone(),
        machine_id: mid.clone(),
        title: "Morning Check".to_string(),
        rule: json!({ "kind": "once", "at": due_at_iso }),
        prompt_text: "Run scheduled check".to_string(),
        enabled: true,
        activation_id: "act_v1".to_string(),
        active_from: due_at_ms - 60_000,
        misfire_policy: ScheduleMisfirePolicy::RunOnce,
        overlap_policy: ScheduleOverlapPolicy::Skip,
        destination: ScheduleDestination::ExistingSession {
            session_id: sid_sched.clone(),
        },
        retry_policy: ScheduleRetryPolicy::default(),
        adapter_id: "codex".to_string(),
        definition_fingerprint: "fp_1".to_string(),
        content_revision: 1,
    }]));
    let sched_ledger = Arc::new(MemoryScheduleLedger::default());
    let auto_store = Arc::new(MemoryAutomationStore::default());
    let inbox = Arc::new(MemoryInbox::default());

    let runtime = DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            machine_id: mid.clone(),
            identity: Arc::new(StaticMachineIdentity(mid.clone())),
            default_cwd: PathBuf::from("."),
            shell_command: ("/bin/sh".to_string(), Vec::new()),
            agent_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            terminal_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            storage_lease: None,
            engine: Arc::clone(&engine) as Arc<dyn EnginePort>,
            history: Arc::new(MemoryHistory::default()),
            inbox: Arc::clone(&inbox) as Arc<dyn InboxStorePort>,
            projects: Arc::new(FixedProjects),
            schedule_repo: sched_repo,
            schedule_ledger: Arc::clone(&sched_ledger) as Arc<dyn ScheduleLedgerPort>,
            automation_store: Arc::clone(&auto_store) as Arc<dyn AutomationStorePort>,
            automation_sandbox: Arc::new(DeterministicSandbox),
            pr_poller_store: Arc::new(UnavailablePrPollerStore),
            diff_store: Arc::new(RecordingDiff::default()),
            artifacts: Arc::new(NoopArtifacts(ManagedArtifactSource::Disabled)),
            acp: Arc::new(FakeAcpLauncher {
                cancel_calls: Arc::new(AtomicUsize::new(0)),
            }),
            pty: Arc::new(lody_ports::UnavailablePtyPort),
            worktree: Arc::new(RecordingWorktree::default()),
            backend: None,
        },
        Duration::from_millis(100),
    );

    let host_caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: Some(uid.clone()),
    };
    let agent_stopped_caller = VerifiedPrincipal::AgentSession {
        workspace_id: ws.clone(),
        session_id: sid_stopped.clone(),
        machine_id: mid.clone(),
        account_id: Some(uid.clone()),
    };
    let reg_resp = runtime
        .execute_async(
            &agent_stopped_caller,
            AppCommand::AutomationRegister {
                workspace_id: ws.clone(),
                invoking_session_id: Some(sid_stopped.clone()),
                target_session_id: None,
                registration: AutomationRegistrationInput {
                    program: "() => MATCH".to_string(),
                    reason: Some("test stop barrier".to_string()),
                    interval_ms: 5_000,
                    expires_at: None,
                },
            },
        )
        .await
        .unwrap();
    let AppResponse::AutomationResult { payload: reg_json } = reg_resp else {
        panic!("expected AutomationResult");
    };
    let wait_id = reg_json["id"].as_str().unwrap().to_string();

    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws.clone(),
                now_ms: Some(due_at_ms + 1_000),
            },
        )
        .await
        .unwrap();

    let sched_handle = runtime
        .session_handle(&ws, &sid_sched)
        .expect("scheduled turn spawned session actor");
    wait_for_running_or_idle(&sched_handle, true).await;
    assert_eq!(sched_ledger.unfinished_runs(&ws).unwrap().len(), 0);

    let show_resp = runtime
        .query_async(
            &agent_stopped_caller,
            AppQuery::AutomationShow {
                workspace_id: ws.clone(),
                invoking_session_id: Some(sid_stopped.clone()),
                item_id: wait_id,
            },
        )
        .await
        .unwrap();
    let AppResponse::AutomationResult { payload: show_json } = show_resp else {
        panic!("expected AutomationResult");
    };
    assert_eq!(show_json["state"], "matched");
    assert_eq!(show_json["continuation"]["state"], "blocked");
    assert_eq!(show_json["continuation"]["reason"], "target_stopped");
    assert!(
        inbox
            .claim_next_runnable(&ws, &sid_stopped)
            .unwrap()
            .is_none(),
        "blocked continuation must never enqueue into a Stopped session"
    );
    let _ = InboxCategory::Schedule;

    runtime.shutdown().await;
}
