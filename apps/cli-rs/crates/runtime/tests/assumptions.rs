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
    ended: Mutex<BTreeSet<(WorkspaceId, SessionId, TurnId)>>,
    paused: Mutex<BTreeSet<(WorkspaceId, SessionId)>>,
    queue: Mutex<HashMap<(WorkspaceId, SessionId), VecDeque<AdmittedTurnInput>>>,
    admitted_log: Mutex<Vec<AdmittedTurnInput>>,
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
        self.admitted_log
            .lock()
            .expect("admitted_log")
            .push(input.clone());
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
        ws: &WorkspaceId,
        sid: &SessionId,
        tid: &TurnId,
        stage: SubmissionStage,
    ) -> PortResult<()> {
        if matches!(stage, SubmissionStage::Settled | SubmissionStage::Retired) {
            self.ended
                .lock()
                .expect("ended")
                .insert((ws.clone(), sid.clone(), tid.clone()));
        }
        Ok(())
    }
    fn is_input_ended(&self, ws: &WorkspaceId, sid: &SessionId, tid: &TurnId) -> PortResult<bool> {
        Ok(self
            .ended
            .lock()
            .expect("ended")
            .contains(&(ws.clone(), sid.clone(), tid.clone())))
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
        self.ended
            .lock()
            .expect("ended")
            .retain(|(k_ws, _, _)| k_ws != ws);
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
            agent_config_id: None,
            agent_config_fingerprint: None,
            latest_user_msg_id: None,
            last_handled_user_msg_id: None,
            linked_pull_requests: Vec::new(),
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
            agent_config_id: None,
            agent_config_fingerprint: None,
            latest_user_msg_id: None,
            last_handled_user_msg_id: None,
            linked_pull_requests: Vec::new(),
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
            agent_config_id: None,
            agent_config_fingerprint: None,
            latest_user_msg_id: None,
            last_handled_user_msg_id: None,
            linked_pull_requests: Vec::new(),
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

#[path = "assumptions/schedulers.rs"]
mod schedulers;
