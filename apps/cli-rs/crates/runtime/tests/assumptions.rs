use lody_app::{
    AppCommand, AppQuery, AppResponse, SessionId, TurnId, VerifiedPrincipal, WorkspaceId,
};
use lody_kernel::{Generation, KernelEvent, SessionPhase};
use lody_ports::{
    AcpEventSink, AcpLauncherPort, AcpSessionPort, AcpSpawnSpec, AdmissionVerdict,
    AdmittedTurnInput, ArtifactRegistryPort, DiffStorePort, EnginePort, EpochKeyMaterial,
    HistoryPort, HistoryTurnRecord, InboxStorePort, InstalledArtifact, LocalProjectId,
    LocalProjectRecord, ManagedArtifactSource, PermissionDecision, PortError, PortErrorKind,
    PortResult, ProjectStorePort, QueuedDraftItem, SessionMetaSnapshot, SteerVerdict,
    StorageLeaseMode, SubmissionStage, TurnDiffSummary, TurnTerminalOutcome, WorkspaceSecurityMode,
    WorktreeLease, WorktreePort,
};
use lody_runtime::{DaemonDependencies, DaemonRuntime};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct TestEngine;
impl EnginePort for TestEngine {
    fn is_connected(&self) -> bool {
        true
    }
    fn read_workspace_security_mode(&self, _: &WorkspaceId) -> PortResult<WorkspaceSecurityMode> {
        Ok(WorkspaceSecurityMode::Plaintext)
    }
    fn read_session_meta(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>> {
        Ok(None)
    }
    fn upsert_session_meta(&self, _: &SessionMetaSnapshot) -> PortResult<()> {
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

struct NoopDiff;
impl DiffStorePort for NoopDiff {
    fn capture_turn_snapshot(
        &self,
        sid: &SessionId,
        tid: &TurnId,
        _: &Path,
    ) -> PortResult<TurnDiffSummary> {
        Ok(TurnDiffSummary {
            session_id: sid.clone(),
            turn_id: tid.clone(),
            files: Vec::new(),
        })
    }
    fn read_turn_diff(&self, _: &SessionId, _: &TurnId) -> PortResult<Option<TurnDiffSummary>> {
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

struct NoopWorktree;
impl WorktreePort for NoopWorktree {
    fn supports_git_worktree(&self) -> bool {
        false
    }
    fn acquire_worktree(
        &self,
        _: &WorkspaceId,
        _: &LocalProjectId,
        _: &Path,
        _: &SessionId,
        _: Option<&str>,
    ) -> PortResult<WorktreeLease> {
        Err(PortError::new(PortErrorKind::Unavailable, "noop"))
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

struct NoopProjects;
impl ProjectStorePort for NoopProjects {
    fn register_project(&self, name: &str, root: &Path) -> PortResult<LocalProjectRecord> {
        Ok(LocalProjectRecord {
            project_id: LocalProjectId("p1".to_string()),
            name: name.to_string(),
            root_path: root.to_path_buf(),
            default_branch: None,
        })
    }
    fn get_project(&self, _: &LocalProjectId) -> PortResult<Option<LocalProjectRecord>> {
        Ok(None)
    }
    fn list_projects(&self) -> PortResult<Vec<LocalProjectRecord>> {
        Ok(Vec::new())
    }
}

fn build_test_runtime(
    cancel_calls: Arc<AtomicUsize>,
    history: Arc<MemoryHistory>,
) -> DaemonRuntime {
    DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            engine: Arc::new(TestEngine),
            history,
            inbox: Arc::new(MemoryInbox::default()),
            projects: Arc::new(NoopProjects),
            diff_store: Arc::new(NoopDiff),
            artifacts: Arc::new(NoopArtifacts(ManagedArtifactSource::Disabled)),
            acp: Arc::new(FakeAcpLauncher { cancel_calls }),
            worktree: Arc::new(NoopWorktree),
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
