use super::*;
use lody_kernel::{pull_request_checkpoint_id, workflow_checkpoint_id};
use lody_ports::{
    AutomationActivityCursor, AutomationActivityPage, AutomationHostOps, AutomationManagedRun,
    AutomationMatchResult, AutomationProgramContext, AutomationProgramEvaluation,
    AutomationReceiptPatch, AutomationReceiptRecord, AutomationReceiptState,
    AutomationRegistrationInput, AutomationRunExit, AutomationRunInput, AutomationSandboxPort,
    AutomationStorePort, AutomationWaitCompletion, AutomationWaitRecord, AutomationWaitState,
    AutomationWorkspaceScope, InboxCategory, MachineSignTurnRequest, MachineSignedTurnIntent,
    ScheduleCursorRecord, ScheduleDestination, ScheduleLedgerPort, ScheduleLedgerRunRecord,
    ScheduleMisfirePolicy, ScheduleOverlapPolicy, ScheduleRetryPolicy, ScheduleRunState,
    SessionPullRequestLink,
};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

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
    fn propose_schedule(&self, _: &ScheduleProposalInput) -> PortResult<ScheduleProposalOutcome> {
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
        c: &ScheduleCursorRecord,
        run: Option<&ScheduleLedgerRunRecord>,
    ) -> PortResult<()> {
        self.cursors.lock().unwrap().insert(
            (
                c.workspace_id.clone(),
                c.schedule_id.clone(),
                c.activation_id.clone(),
            ),
            c.clone(),
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
                    && !matches!(
                        r.state,
                        ScheduleRunState::Finished
                            | ScheduleRunState::Failed
                            | ScheduleRunState::Skipped
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
        let mut g = self.runs.lock().unwrap();
        let rec = g
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

struct MemoryAutomationStore {
    logs_dir: PathBuf,
    waits: Mutex<HashMap<String, AutomationWaitRecord>>,
    receipts: Mutex<HashMap<String, AutomationReceiptRecord>>,
    sources: Mutex<HashMap<String, Value>>,
    capacity: Mutex<HashMap<String, Value>>,
}
impl Default for MemoryAutomationStore {
    fn default() -> Self {
        Self::with_logs_dir(PathBuf::from("/tmp"))
    }
}
impl MemoryAutomationStore {
    fn with_logs_dir(logs_dir: PathBuf) -> Self {
        Self {
            logs_dir,
            waits: Mutex::new(HashMap::new()),
            receipts: Mutex::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
            capacity: Mutex::new(HashMap::new()),
        }
    }
}
impl AutomationStorePort for MemoryAutomationStore {
    fn workspace_run_logs_dir(&self, _: &AutomationWorkspaceScope) -> PathBuf {
        self.logs_dir.clone()
    }
    fn register_wait(
        &self,
        scope: &AutomationWorkspaceScope,
        sid: &SessionId,
        uid: &UserId,
        input: &AutomationRegistrationInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        let mut g = self.waits.lock().unwrap();
        let id = format!("w_{}", g.len() + 1);
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
        g.insert(id, rec.clone());
        Ok(rec)
    }
    fn register_run(
        &self,
        scope: &AutomationWorkspaceScope,
        sid: &SessionId,
        uid: &UserId,
        input: &AutomationRunInput,
        now_ms: i64,
    ) -> PortResult<AutomationWaitRecord> {
        let mut g = self.waits.lock().unwrap();
        let id = format!("r_{}", g.len() + 1);
        let log_path = self.logs_dir.join(format!("{id}.log"));
        let rec = AutomationWaitRecord {
            id: id.clone(),
            session_id: sid.clone(),
            workspace_id: scope.workspace_id.clone(),
            owner_user_id: uid.clone(),
            owner_machine_id: scope.machine_id.clone(),
            program: None,
            run: Some(AutomationManagedRun {
                command: input.command.clone(),
                args: input.args.clone(),
                cwd: input.cwd.clone(),
                env: input.env.clone(),
                log_path: log_path.to_string_lossy().into_owned(),
                started_at: None,
                pid: None,
                exit: None,
            }),
            reason: input.reason.clone(),
            interval_ms: 60_000,
            expires_at: None,
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
        g.insert(id, rec.clone());
        Ok(rec)
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
            .filter(|w| {
                matches!(
                    w.state,
                    AutomationWaitState::Waiting | AutomationWaitState::Checking
                ) && w.next_check_at <= now_ms
            })
            .cloned()
            .collect())
    }
    fn claim_wait(
        &self,
        _: &AutomationWorkspaceScope,
        id: &str,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        let mut g = self.waits.lock().unwrap();
        let Some(w) = g.get_mut(id) else {
            return Ok(None);
        };
        if !matches!(
            w.state,
            AutomationWaitState::Waiting | AutomationWaitState::Checking
        ) {
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
        id: &str,
        now_ms: i64,
    ) -> PortResult<bool> {
        let mut g = self.waits.lock().unwrap();
        let Some(run) = g.get_mut(id).and_then(|w| w.run.as_mut()) else {
            return Ok(false);
        };
        if run.started_at.is_some() {
            return Ok(false);
        }
        run.started_at = Some(now_ms);
        Ok(true)
    }
    fn record_run_pid(
        &self,
        _: &AutomationWorkspaceScope,
        id: &str,
        pid: u32,
        _: i64,
    ) -> PortResult<()> {
        if let Some(run) = self
            .waits
            .lock()
            .unwrap()
            .get_mut(id)
            .and_then(|w| w.run.as_mut())
        {
            run.pid = Some(pid);
        }
        Ok(())
    }
    fn record_run_exit(
        &self,
        _: &AutomationWorkspaceScope,
        id: &str,
        exit: &AutomationRunExit,
        now_ms: i64,
    ) -> PortResult<Option<AutomationWaitRecord>> {
        let mut g = self.waits.lock().unwrap();
        let Some(w) = g.get_mut(id) else {
            return Ok(None);
        };
        if let Some(run) = w.run.as_mut() {
            run.exit = Some(exit.clone());
        }
        w.state = AutomationWaitState::Waiting;
        w.next_check_at = now_ms;
        Ok(Some(w.clone()))
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
            w.reads = Some(comp.reads.clone());
            w.evidence = Some(comp.evidence.clone());
        }
        Ok(())
    }
    fn finish_wait_matched(
        &self,
        _: &AutomationWorkspaceScope,
        comp: &AutomationWaitCompletion,
        res: &AutomationMatchResult,
    ) -> PortResult<Option<AutomationReceiptRecord>> {
        let mut g = self.waits.lock().unwrap();
        let Some(w) = g.get_mut(&comp.wait_id) else {
            return Ok(None);
        };
        let rcpt_id = format!("rcpt_{}", w.id);
        w.state = AutomationWaitState::Matched;
        w.result = Some(res.clone());
        w.invocation_id = Some(rcpt_id.clone());
        w.reads = Some(comp.reads.clone());
        w.evidence = Some(comp.evidence.clone());
        let rcpt = AutomationReceiptRecord {
            id: rcpt_id.clone(),
            delivery_id: format!("del_{}", w.id),
            state: AutomationReceiptState::Accepted,
            reason: None,
            rule: json!({ "ownerUserId": w.owner_user_id.0 }),
            event: json!({}),
            intent: json!({
                "action": { "parameters": { "input": { "resumeText": res.resume_text } } }
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
        id: &str,
        now_ms: i64,
    ) -> PortResult<Option<Value>> {
        if let Some(w) = self.waits.lock().unwrap().get_mut(id) {
            w.state = AutomationWaitState::Cancelled;
            w.updated_at = now_ms;
            return Ok(Some(serde_json::to_value(w.clone()).unwrap()));
        }
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
        now_ms: i64,
        _: usize,
    ) -> PortResult<Vec<AutomationReceiptRecord>> {
        Ok(self
            .receipts
            .lock()
            .unwrap()
            .values()
            .filter(|r| {
                matches!(
                    r.state,
                    AutomationReceiptState::Accepted | AutomationReceiptState::Waiting
                ) && r.retry_at.unwrap_or(0) <= now_ms
            })
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
            r.turn_id = patch.turn_id.clone();
            r.attempts = patch.attempts;
            r.retry_at = patch.retry_at;
            r.updated_at = patch.now_ms;
        }
        Ok(())
    }
    fn read_session_settings(
        &self,
        _: &AutomationWorkspaceScope,
        _: &SessionId,
    ) -> PortResult<Value> {
        Ok(json!({}))
    }
    fn configure_session_settings(
        &self,
        _: &AutomationWorkspaceScope,
        _: &SessionId,
        _: &UserId,
        _: &Value,
        _: i64,
    ) -> PortResult<Value> {
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
    fn read_source_checkpoint(
        &self,
        _: &AutomationWorkspaceScope,
        source_id: &str,
    ) -> PortResult<Option<Value>> {
        Ok(self.sources.lock().unwrap().get(source_id).cloned())
    }
    fn write_source_checkpoint(
        &self,
        _: &AutomationWorkspaceScope,
        source_id: &str,
        checkpoint: &Value,
    ) -> PortResult<()> {
        self.sources
            .lock()
            .unwrap()
            .insert(source_id.to_string(), checkpoint.clone());
        Ok(())
    }
    fn read_capacity_snapshot(
        &self,
        _: &AutomationWorkspaceScope,
        binding_id: &str,
    ) -> PortResult<Option<Value>> {
        Ok(self.capacity.lock().unwrap().get(binding_id).cloned())
    }
    fn write_capacity_snapshot(
        &self,
        _: &AutomationWorkspaceScope,
        binding_id: &str,
        snapshot: &Value,
    ) -> PortResult<()> {
        self.capacity
            .lock()
            .unwrap()
            .insert(binding_id.to_string(), snapshot.clone());
        Ok(())
    }
    fn erase_workspace_store(&self, _: &AutomationWorkspaceScope) -> PortResult<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schedule_and_automation_runners_dispatch_due_slots_and_block_continuation_under_stop_barrier()
 {
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
                agent_config_id: None,
                agent_config_fingerprint: None,
                latest_user_msg_id: None,
                last_handled_user_msg_id: None,
                linked_pull_requests: Vec::new(),
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
    let in_flight = sched_ledger.unfinished_runs(&ws).unwrap();
    assert_eq!(in_flight.len(), 1);
    assert_eq!(in_flight[0].state, ScheduleRunState::Dispatched);

    sched_handle
        .send_event(KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        })
        .await
        .unwrap();
    wait_for_running_or_idle(&sched_handle, false).await;
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws.clone(),
                now_ms: Some(due_at_ms + 2_000),
            },
        )
        .await
        .unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn encrypted_signing_gate_process_containment_real_reads_and_supervisor_detach() {
    struct ConfigurableEncryptedEngine {
        mode: WorkspaceSecurityMode,
        online: AtomicBool,
        signing_enabled: AtomicBool,
        sched_auth: Mutex<PortResult<bool>>,
        sessions: Mutex<HashMap<(WorkspaceId, SessionId), SessionMetaSnapshot>>,
    }

    impl EnginePort for ConfigurableEncryptedEngine {
        fn is_connected(&self) -> bool {
            self.online.load(Ordering::SeqCst)
        }
        fn read_workspace_security_mode(
            &self,
            _: &WorkspaceId,
        ) -> PortResult<WorkspaceSecurityMode> {
            Ok(self.mode.clone())
        }
        fn read_session_meta(
            &self,
            ws: &WorkspaceId,
            sid: &SessionId,
        ) -> PortResult<Option<SessionMetaSnapshot>> {
            if !self.online.load(Ordering::SeqCst) {
                return Err(PortError::new(PortErrorKind::Unavailable, "engine offline"));
            }
            Ok(self
                .sessions
                .lock()
                .unwrap()
                .get(&(ws.clone(), sid.clone()))
                .cloned())
        }
        fn upsert_session_meta(&self, meta: &SessionMetaSnapshot) -> PortResult<()> {
            self.sessions.lock().unwrap().insert(
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
        fn set_message_queue_paused(
            &self,
            _: &WorkspaceId,
            _: &SessionId,
            _: bool,
        ) -> PortResult<()> {
            Ok(())
        }
        fn install_workspace_epoch_keys(
            &self,
            _: &WorkspaceId,
            _: &[EpochKeyMaterial],
        ) -> PortResult<()> {
            Ok(())
        }
        fn sign_machine_turn_intent(
            &self,
            req: &MachineSignTurnRequest,
        ) -> PortResult<MachineSignedTurnIntent> {
            if !self.signing_enabled.load(Ordering::SeqCst) {
                return Err(PortError::capability_unavailable("machine_signing"));
            }
            Ok(MachineSignedTurnIntent {
                signature_hex: format!("sig_{}", req.turn_id.0),
                signer_device_id: "dev_host_1".to_string(),
            })
        }
        fn verify_schedule_authorization(
            &self,
            _: &WorkspaceId,
            _: &str,
            _: &str,
        ) -> PortResult<bool> {
            self.sched_auth.lock().unwrap().clone()
        }
    }

    struct HostReadingSandbox;
    impl AutomationSandboxPort for HostReadingSandbox {
        fn validate_program(&self, _: &str, _: &AutomationProgramContext) -> PortResult<()> {
            Ok(())
        }
        fn evaluate_program(
            &self,
            _: &str,
            _: &AutomationProgramContext,
            host_ops: Arc<dyn AutomationHostOps>,
        ) -> PortResult<AutomationProgramEvaluation> {
            let cap = host_ops.read_resource("provider.capacity", &json!({}))?;
            let wf = host_ops.read_resource("github.workflowRuns", &json!({}))?;
            let prs = host_ops.read_resource("github.pullRequests", &json!({}))?;
            assert_eq!(prs.value.as_array().map(Vec::len), Some(1));
            let matched = if cap.value.get("status").and_then(Value::as_str) == Some("yes")
                && wf.value.get("status").and_then(Value::as_str) == Some("observed")
            {
                Some(AutomationMatchResult {
                    resume_text: "CI green and capacity ready".to_string(),
                    payload: None,
                })
            } else {
                assert_eq!(
                    cap.value.get("status").and_then(Value::as_str),
                    Some("unknown")
                );
                assert_eq!(
                    wf.value.get("status").and_then(Value::as_str),
                    Some("unknown")
                );
                None
            };
            Ok(AutomationProgramEvaluation {
                matched,
                reads: vec![
                    "provider.capacity".to_string(),
                    "github.workflowRuns".to_string(),
                    "github.pullRequests".to_string(),
                ],
                evidence: wf.evidence,
            })
        }
    }

    struct BlockingScheduleRepo {
        schedules: Vec<ScheduleRecord>,
        block_first_pass: AtomicBool,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl ScheduleRepoPort for BlockingScheduleRepo {
        fn list_schedules(
            &self,
            _: &WorkspaceId,
            _: Option<&str>,
            _: usize,
            _: usize,
        ) -> PortResult<Vec<ScheduleRecord>> {
            if self.block_first_pass.swap(false, Ordering::SeqCst) {
                self.entered.notify_waiters();
                let rel = Arc::clone(&self.release);
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(rel.notified());
                });
            }
            Ok(self.schedules.clone())
        }
        fn get_schedule(&self, _: &WorkspaceId, id: &str) -> PortResult<Option<ScheduleRecord>> {
            Ok(self.schedules.iter().find(|s| s.schedule_id == id).cloned())
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

    let temp = tempfile::tempdir().unwrap();
    let mid = MachineId("m_e2ee_1".to_string());
    let ws_enc = WorkspaceId("ws_encrypted".to_string());
    let sid_enc = SessionId("00000000-0000-4000-8000-000000000701".to_string());
    let sid_sched = SessionId("00000000-0000-4000-8000-000000000702".to_string());
    let uid = UserId("u_enc_owner".to_string());

    let logs_dir = temp.path().join("run-logs");
    std::fs::create_dir_all(&logs_dir).unwrap();
    let sched_ledger = Arc::new(MemoryScheduleLedger::default());
    let auto_store = Arc::new(MemoryAutomationStore::with_logs_dir(logs_dir));
    let inbox = Arc::new(MemoryInbox::default());

    let pr_url = "https://github.com/lodyai/lody/pull/88".to_string();
    let engine = Arc::new(ConfigurableEncryptedEngine {
        mode: WorkspaceSecurityMode::Encrypted {
            genesis_hash: "gen_hash_1".to_string(),
        },
        online: AtomicBool::new(true),
        signing_enabled: AtomicBool::new(false),
        sched_auth: Mutex::new(Err(PortError::new(
            PortErrorKind::Unavailable,
            "auth offline",
        ))),
        sessions: Mutex::new(HashMap::new()),
    });
    for target in [&sid_enc, &sid_sched] {
        engine
            .upsert_session_meta(&SessionMetaSnapshot {
                workspace_id: ws_enc.clone(),
                session_id: target.clone(),
                root_session_id: target.clone(),
                owner_user_id: uid.clone(),
                owner_machine_id: mid.clone(),
                deleted: false,
                local_project_id: None,
                base_branch: None,
                title: None,
                status: SessionRunStatus::Idle,
                queue_paused: false,
                queued_count: 0,
                agent_config_id: Some("cfg_claude".to_string()),
                agent_config_fingerprint: Some("fp_cfg_1".to_string()),
                latest_user_msg_id: None,
                last_handled_user_msg_id: None,
                linked_pull_requests: vec![SessionPullRequestLink {
                    url: pr_url.clone(),
                    status: "open".to_string(),
                }],
            })
            .unwrap();
    }

    let base_slot_iso = "2099-05-01T00:00:00Z";
    let base_slot_ms = lody_kernel::parse_rfc3339_millis(base_slot_iso).unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let sched_repo = Arc::new(BlockingScheduleRepo {
        schedules: vec![ScheduleRecord {
            schedule_id: "sched_enc_interval".to_string(),
            workspace_id: ws_enc.clone(),
            session_id: Some(sid_sched.clone()),
            author_user_id: uid.clone(),
            machine_id: mid.clone(),
            title: "Encrypted Interval".to_string(),
            rule: json!({ "kind": "interval", "everyMs": 60_000, "anchorAt": base_slot_iso }),
            prompt_text: "Signed scheduled prompt".to_string(),
            enabled: true,
            activation_id: "act_enc_1".to_string(),
            active_from: base_slot_ms - 60_000,
            misfire_policy: ScheduleMisfirePolicy::RunOnce,
            overlap_policy: ScheduleOverlapPolicy::Skip,
            destination: ScheduleDestination::ExistingSession {
                session_id: sid_sched.clone(),
            },
            retry_policy: ScheduleRetryPolicy::default(),
            adapter_id: "codex".to_string(),
            definition_fingerprint: "fp_sched_enc_1".to_string(),
            content_revision: 1,
        }],
        block_first_pass: AtomicBool::new(false),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    });

    let workdir_root = temp.path().join("project_workdir");
    std::fs::create_dir_all(&workdir_root).unwrap();

    let runtime = DaemonRuntime::with_settling_timeout(
        DaemonDependencies {
            machine_id: mid.clone(),
            identity: Arc::new(StaticMachineIdentity(mid.clone())),
            default_cwd: workdir_root.clone(),
            shell_command: ("/bin/sh".to_string(), Vec::new()),
            agent_env_builder: Arc::new(|_| std::collections::BTreeMap::new()),
            terminal_env_builder: Arc::new(|_| {
                std::collections::BTreeMap::from([(
                    "PATH".to_string(),
                    "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
                )])
            }),
            storage_lease_mode: StorageLeaseMode::OnlineHost,
            storage_lease: None,
            engine: Arc::clone(&engine) as Arc<dyn EnginePort>,
            history: Arc::new(MemoryHistory::default()),
            inbox: Arc::clone(&inbox) as Arc<dyn InboxStorePort>,
            projects: Arc::new(FixedProjects),
            schedule_repo: Arc::clone(&sched_repo) as Arc<dyn ScheduleRepoPort>,
            schedule_ledger: Arc::clone(&sched_ledger) as Arc<dyn ScheduleLedgerPort>,
            automation_store: Arc::clone(&auto_store) as Arc<dyn AutomationStorePort>,
            automation_sandbox: Arc::new(HostReadingSandbox),
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
    let agent_caller = VerifiedPrincipal::AgentSession {
        workspace_id: ws_enc.clone(),
        session_id: sid_enc.clone(),
        machine_id: mid.clone(),
        account_id: Some(uid.clone()),
    };

    let scope = AutomationWorkspaceScope {
        machine_id: mid.clone(),
        workspace_id: ws_enc.clone(),
    };
    let obs_wait = auto_store
        .register_wait(
            &scope,
            &sid_enc,
            &uid,
            &AutomationRegistrationInput {
                program: "async () => false".to_string(),
                reason: Some("wait for real CI + capacity".to_string()),
                interval_ms: 5_000,
                expires_at: None,
            },
            base_slot_ms,
        )
        .unwrap();

    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(base_slot_ms + 100),
            },
        )
        .await
        .unwrap();

    let unobs = auto_store.get_wait(&scope, &obs_wait.id).unwrap().unwrap();
    assert_eq!(
        unobs.state,
        AutomationWaitState::Waiting,
        "missing capacity & workflow checkpoints must report unknown and keep wait pending"
    );
    assert!(inbox.admitted_log.lock().unwrap().is_empty());
    let unfinished_auth = sched_ledger.unfinished_runs(&ws_enc).unwrap();
    assert_eq!(unfinished_auth.len(), 1);
    assert_eq!(unfinished_auth[0].state, ScheduleRunState::RetryWait);
    assert!(unfinished_auth[0].payload_json.contains("AUTH_UNAVAILABLE"));

    let t_obs = base_slot_ms + 16_000;
    auto_store
        .write_capacity_snapshot(
            &scope,
            "cfg_claude",
            &json!({
                "bindingId": "cfg_claude",
                "fingerprint": "fp_cfg_1",
                "observedAt": t_obs,
                "validUntil": t_obs + 120_000,
                "authentication": "valid",
                "billing": "valid",
                "source": "probe",
                "windows": [{
                    "name": "5h",
                    "usedPercent": 25.0,
                    "observedAt": t_obs,
                    "validUntil": t_obs + 120_000
                }]
            }),
        )
        .unwrap();
    let pr_cp = pull_request_checkpoint_id(&sid_enc.0, &pr_url);
    auto_store
        .write_source_checkpoint(
            &scope,
            &pr_cp,
            &json!({
                "revision": "rev_pr_88",
                "observedAt": t_obs,
                "data": {
                    "url": pr_url,
                    "repository": "lodyai/lody",
                    "prNumber": 88,
                    "state": "open",
                    "merged": false,
                    "headSha": "abc1234",
                    "updatedAt": t_obs
                }
            }),
        )
        .unwrap();
    let wf_cp = workflow_checkpoint_id(&sid_enc.0, "lodyai/lody", "abc1234");
    auto_store
        .write_source_checkpoint(
            &scope,
            &wf_cp,
            &json!({
                "revision": "rev_ci_1",
                "observedAt": t_obs,
                "data": {
                    "repository": "lodyai/lody",
                    "headSha": "abc1234",
                    "gap": null,
                    "runs": [{ "name": "ci", "conclusion": "success" }]
                }
            }),
        )
        .unwrap();

    *engine.sched_auth.lock().unwrap() = Ok(true);
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(t_obs),
            },
        )
        .await
        .unwrap();
    let matched_wait = auto_store.get_wait(&scope, &obs_wait.id).unwrap().unwrap();
    assert_eq!(matched_wait.state, AutomationWaitState::Matched);
    assert_eq!(matched_wait.evidence.as_ref().map(Vec::len), Some(1));
    let rcpt_id = matched_wait.invocation_id.unwrap();
    let rcpt_unsigned = auto_store.get_receipt(&scope, &rcpt_id).unwrap().unwrap();
    assert_eq!(rcpt_unsigned.state, AutomationReceiptState::Waiting);
    assert_eq!(rcpt_unsigned.reason.as_deref(), Some("signing_unavailable"));
    let sched_unsigned = sched_ledger.unfinished_runs(&ws_enc).unwrap();
    assert_eq!(sched_unsigned[0].state, ScheduleRunState::RetryWait);
    assert!(
        sched_unsigned[0]
            .payload_json
            .contains("E2EE_MACHINE_SIGNING_UNAVAILABLE")
    );
    assert!(
        inbox.admitted_log.lock().unwrap().is_empty(),
        "missing machine signing key must block both Automation and Schedule admissions"
    );

    engine.online.store(false, Ordering::SeqCst);
    engine.signing_enabled.store(true, Ordering::SeqCst);
    let t_offline = base_slot_ms + 32_000;
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(t_offline),
            },
        )
        .await
        .unwrap();
    let rcpt_offline = auto_store.get_receipt(&scope, &rcpt_id).unwrap().unwrap();
    assert_eq!(rcpt_offline.state, AutomationReceiptState::Waiting);
    assert_eq!(rcpt_offline.reason.as_deref(), Some("session_unavailable"));
    assert_eq!(
        inbox.admitted_log.lock().unwrap().len(),
        1,
        "offline engine must block Automation session gate even when machine signing key is present"
    );

    engine.online.store(true, Ordering::SeqCst);
    let t_signed = base_slot_ms + 48_000;
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(t_signed),
            },
        )
        .await
        .unwrap();
    let admitted = inbox.admitted_log.lock().unwrap().clone();
    assert_eq!(admitted.len(), 2);
    for item in &admitted {
        assert!(item.signed_intent_verified);
        assert!(
            item.signature_hex
                .as_deref()
                .is_some_and(|s| s.starts_with("sig_"))
        );
    }

    let sched_dispatched = sched_ledger.unfinished_runs(&ws_enc).unwrap();
    assert_eq!(sched_dispatched.len(), 1);
    assert_eq!(sched_dispatched[0].state, ScheduleRunState::Dispatched);

    let next_slot_ms = base_slot_ms + 60_000;
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(next_slot_ms + 500),
            },
        )
        .await
        .unwrap();
    let second_slot_key =
        lody_kernel::schedule_run_key("sched_enc_interval", "act_enc_1", next_slot_ms);
    let second_slot_rec = sched_ledger
        .get_run(&second_slot_key)
        .unwrap()
        .expect("overlapping slot recorded");
    assert_eq!(
        second_slot_rec.state,
        ScheduleRunState::Skipped,
        "while turn 1 is still running, run 1 must stay Dispatched and cause overlap skip"
    );

    let sched_handle = runtime.session_handle(&ws_enc, &sid_sched).unwrap();
    wait_for_running_or_idle(&sched_handle, true).await;
    sched_handle
        .send_event(KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        })
        .await
        .unwrap();
    wait_for_running_or_idle(&sched_handle, false).await;
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(next_slot_ms + 2_000),
            },
        )
        .await
        .unwrap();
    assert!(sched_ledger.unfinished_runs(&ws_enc).unwrap().is_empty());

    let leak_pid_file = workdir_root.join("bg_holder.pid");
    let drain_run = auto_store
        .register_run(
            &scope,
            &sid_enc,
            &uid,
            &AutomationRunInput {
                command: "/bin/sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    format!(
                        "sleep 30 & echo $! > '{}' && echo parent-done",
                        leak_pid_file.display()
                    ),
                ],
                cwd: None,
                env: None,
                reason: Some("pipe drain bound test".to_string()),
            },
            next_slot_ms + 3_000,
        )
        .unwrap();
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(next_slot_ms + 3_000),
            },
        )
        .await
        .unwrap();

    let drain_deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut recorded_exit = None;
    while std::time::Instant::now() < drain_deadline {
        if let Some(w) = auto_store.get_wait(&scope, &drain_run.id).unwrap()
            && let Some(r) = w.run
            && r.exit.is_some()
        {
            recorded_exit = r.exit;
            break;
        }
        tokio::task::yield_now().await;
    }
    let exit_info =
        recorded_exit.expect("managed run must record exit without waiting 30s on inherited pipe");
    assert!(exit_info.tail.contains("parent-done"));
    if let Ok(raw_pid) = std::fs::read_to_string(&leak_pid_file)
        && let Ok(bg_pid) = raw_pid.trim().parse::<u32>()
    {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", &bg_pid.to_string()])
            .status();
    }

    let child_pid_file = workdir_root.join("cancel_child.pid");
    let cancel_run = auto_store
        .register_run(
            &scope,
            &sid_enc,
            &uid,
            &AutomationRunInput {
                command: "/bin/sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    format!("sleep 30 & echo $! > '{}'; wait", child_pid_file.display()),
                ],
                cwd: None,
                env: None,
                reason: Some("process group cancel test".to_string()),
            },
            next_slot_ms + 4_000,
        )
        .unwrap();
    runtime
        .execute_async(
            &host_caller,
            AppCommand::TickWorkspaceSchedulers {
                workspace_id: ws_enc.clone(),
                now_ms: Some(next_slot_ms + 4_000),
            },
        )
        .await
        .unwrap();
    let spawn_deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut sub_pid: Option<u32> = None;
    while std::time::Instant::now() < spawn_deadline {
        if let Ok(raw) = std::fs::read_to_string(&child_pid_file)
            && let Ok(parsed) = raw.trim().parse::<u32>()
        {
            sub_pid = Some(parsed);
            break;
        }
        tokio::task::yield_now().await;
    }
    let descendant_pid = sub_pid.expect("descendant spawned");
    runtime
        .execute_async(
            &agent_caller,
            AppCommand::AutomationCancel {
                workspace_id: ws_enc.clone(),
                invoking_session_id: Some(sid_enc.clone()),
                item_id: cancel_run.id.clone(),
            },
        )
        .await
        .unwrap();
    let kill_deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut descendant_gone = false;
    while std::time::Instant::now() < kill_deadline {
        let probe = std::process::Command::new("/bin/kill")
            .args(["-0", &descendant_pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status();
        if probe.is_ok_and(|st| !st.success()) {
            descendant_gone = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        descendant_gone,
        "cancelling a managed run must terminate its descendant process group"
    );

    let ws_detach = WorkspaceId("ws_mid_pass_detach".to_string());
    sched_repo.block_first_pass.store(true, Ordering::SeqCst);
    let entered_waiter = entered.notified();
    runtime
        .attach_workspace(&ws_detach, Some(WorkspaceSecurityMode::Plaintext))
        .unwrap();
    entered_waiter.await;

    let rt_for_detach = runtime.clone();
    let ws_for_detach = ws_detach.clone();
    let detach_task =
        tokio::spawn(async move { rt_for_detach.detach_workspace(&ws_for_detach, false).await });
    tokio::task::yield_now().await;
    release.notify_waiters();

    let detach_res = tokio::time::timeout(Duration::from_secs(2), detach_task)
        .await
        .expect("detach signaled mid-pass must not lose shutdown notification or hang")
        .unwrap();
    assert!(detach_res.is_ok());

    runtime.shutdown().await;
}
