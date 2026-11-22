use lody_app::{
    AppCommand, AppQuery, AppResponse, SessionId, TurnId, VerifiedPrincipal, WorkspaceId,
};
use lody_kernel::{Generation, KernelEvent};
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
use std::collections::HashMap;
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
    turns: Mutex<HashMap<(WorkspaceId, SessionId), Vec<HistoryTurnRecord>>>,
}
impl HistoryPort for MemoryHistory {
    fn backend_name(&self) -> &'static str {
        "memory"
    }
    fn is_user_turn_durable(&self, _: &WorkspaceId, _: &SessionId, _: &TurnId) -> PortResult<bool> {
        Ok(true)
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
            *existing = record.clone();
        } else {
            list.push(record.clone());
        }
        Ok(())
    }
}

struct NoopInbox;
impl InboxStorePort for NoopInbox {
    fn store_name(&self) -> &'static str {
        "noop"
    }
    fn admit_turn(&self, _: &AdmittedTurnInput) -> PortResult<AdmissionVerdict> {
        Ok(AdmissionVerdict::Admitted)
    }
    fn claim_next_runnable(
        &self,
        _: &WorkspaceId,
        _: &SessionId,
    ) -> PortResult<Option<AdmittedTurnInput>> {
        Ok(None)
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
    fn set_inbox_paused(&self, _: &WorkspaceId, _: &SessionId, _: bool) -> PortResult<()> {
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

fn build_test_runtime(cancel_calls: Arc<AtomicUsize>) -> DaemonRuntime {
    DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            engine: Arc::new(TestEngine),
            history: Arc::new(MemoryHistory::default()),
            inbox: Arc::new(NoopInbox),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_cancel_preempts_backlog_of_streamed_chunks_and_sibling_failure_stays_isolated() {
    let cancel_calls = Arc::new(AtomicUsize::new(0));
    let runtime = build_test_runtime(Arc::clone(&cancel_calls));
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
    let _ = broken_handle.inspect_phase().await.expect("broken settled");

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
    let _ = handle.inspect_phase().await.expect("initial turn running");

    for i in 0..400 {
        let _ = handle.try_send_event(KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: format!("chunk-{i};"),
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
    let _ = handle.inspect_phase().await.expect("actor responsive");

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
                session_id: SessionId("s_broken".to_string()),
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
