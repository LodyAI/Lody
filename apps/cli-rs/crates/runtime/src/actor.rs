use crate::DaemonDependencies;
use lody_kernel::{
    FrozenTurnInvocation, KernelAction, KernelEvent, SessionPhase, SessionState, SteerOutcome,
    TurnTerminalReason, WarmAgentHandle, step,
};
use lody_ports::{
    AcpSessionPort, AcpSpawnSpec, AdmittedTurnInput, HistoryBlock, HistoryTurnRecord,
    InboxCategory, LocalProjectId, PermissionDecision, PortError, PortErrorKind, PortResult,
    SessionId, SteerVerdict, SubmissionStage, TurnId, TurnTerminalOutcome, UserId, WorkspaceId,
    WorktreeLease,
};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Semaphore, mpsc, oneshot};

pub enum ControlCommand {
    Cancel {
        pause_inbox: bool,
        reply: oneshot::Sender<()>,
    },
    ReplyPermission {
        decision: PermissionDecision,
        reply: oneshot::Sender<()>,
    },
    Steer {
        invocation: FrozenTurnInvocation,
        reply: oneshot::Sender<PortResult<SteerVerdict>>,
    },
    Archive {
        reply: oneshot::Sender<PortResult<()>>,
    },
    InspectPhase {
        reply: oneshot::Sender<SessionPhase>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
pub struct SessionHandle {
    control_tx: mpsc::Sender<ControlCommand>,
    event_tx: mpsc::Sender<KernelEvent>,
}

impl SessionHandle {
    pub async fn send_event(&self, event: KernelEvent) -> PortResult<()> {
        self.event_tx
            .send(event)
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))
    }

    pub fn try_send_event(&self, event: KernelEvent) -> PortResult<()> {
        self.event_tx
            .try_send(event)
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session event queue full"))
    }

    pub async fn cancel(&self, pause_inbox: bool) -> PortResult<()> {
        let (tx, rx) = oneshot::channel();
        self.control_tx
            .send(ControlCommand::Cancel {
                pause_inbox,
                reply: tx,
            })
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))?;
        let _ = rx.await;
        Ok(())
    }

    pub async fn reply_permission(&self, decision: PermissionDecision) -> PortResult<()> {
        let (tx, rx) = oneshot::channel();
        self.control_tx
            .send(ControlCommand::ReplyPermission {
                decision,
                reply: tx,
            })
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))?;
        let _ = rx.await;
        Ok(())
    }

    pub async fn steer(&self, invocation: FrozenTurnInvocation) -> PortResult<SteerVerdict> {
        let (tx, rx) = oneshot::channel();
        self.control_tx
            .send(ControlCommand::Steer {
                invocation,
                reply: tx,
            })
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))?;
        rx.await.map_err(|_| {
            PortError::new(PortErrorKind::Unavailable, "session actor dropped reply")
        })?
    }

    pub async fn archive(&self) -> PortResult<()> {
        let (tx, rx) = oneshot::channel();
        self.control_tx
            .send(ControlCommand::Archive { reply: tx })
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))?;
        rx.await.map_err(|_| {
            PortError::new(PortErrorKind::Unavailable, "session actor dropped reply")
        })?
    }

    pub async fn inspect_phase(&self) -> PortResult<SessionPhase> {
        let (tx, rx) = oneshot::channel();
        self.control_tx
            .send(ControlCommand::InspectPhase { reply: tx })
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))?;
        rx.await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor dropped reply"))
    }

    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self
            .control_tx
            .send(ControlCommand::Shutdown { reply: tx })
            .await
            .is_ok()
        {
            let _ = rx.await;
        }
    }
}

pub struct SessionSpawnOptions {
    pub workspace_id: WorkspaceId,
    pub session_id: SessionId,
    pub workspace_encrypted: bool,
    pub depth: u8,
    pub local_project_id: Option<LocalProjectId>,
    pub project_root: Option<PathBuf>,
    pub use_worktree: bool,
    pub settling_timeout: Duration,
}

struct SessionActor {
    opts: SessionSpawnOptions,
    deps: Arc<DaemonDependencies>,
    acp_start_semaphore: Arc<Semaphore>,
    state: SessionState,
    live_agent: Option<(String, Box<dyn AcpSessionPort>)>,
    worktree_lease: Option<WorktreeLease>,
    turn_records: BTreeMap<String, HistoryTurnRecord>,
    control_rx: mpsc::Receiver<ControlCommand>,
    event_rx: mpsc::Receiver<KernelEvent>,
    next_agent_seq: u64,
}

pub fn spawn_session_actor(
    opts: SessionSpawnOptions,
    deps: Arc<DaemonDependencies>,
    acp_start_semaphore: Arc<Semaphore>,
) -> SessionHandle {
    let (control_tx, control_rx) = mpsc::channel(64);
    let (event_tx, event_rx) = mpsc::channel(512);
    let state = SessionState::new(
        opts.session_id.0.clone(),
        opts.workspace_encrypted,
        opts.depth,
    );

    let actor = SessionActor {
        opts,
        deps,
        acp_start_semaphore,
        state,
        live_agent: None,
        worktree_lease: None,
        turn_records: BTreeMap::new(),
        control_rx,
        event_rx,
        next_agent_seq: 0,
    };

    tokio::spawn(actor.run());
    SessionHandle {
        control_tx,
        event_tx,
    }
}

impl SessionActor {
    async fn run(mut self) {
        loop {
            tokio::select! {
                biased;
                ctrl = self.control_rx.recv() => {
                    match ctrl {
                        Some(cmd) => {
                            if self.handle_control(cmd).await {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                ev = self.event_rx.recv() => {
                    match ev {
                        Some(event) => self.process_event_loop(event).await,
                        None => break,
                    }
                }
            }
        }
        self.cleanup_resources();
    }

    async fn handle_control(&mut self, cmd: ControlCommand) -> bool {
        match cmd {
            ControlCommand::Cancel { pause_inbox, reply } => {
                let _ = self.deps.inbox.set_inbox_paused(
                    &self.opts.workspace_id,
                    &self.opts.session_id,
                    pause_inbox,
                );
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox })
                    .await;
                let _ = reply.send(());
                false
            }
            ControlCommand::ReplyPermission { decision, reply } => {
                self.process_event_loop(KernelEvent::UserRepliedPermission {
                    request_id: decision.request_id,
                    selected_option_id: decision.selected_option_id,
                    cancelled: decision.cancelled,
                })
                .await;
                let _ = reply.send(());
                false
            }
            ControlCommand::Steer { invocation, reply } => {
                let res = self.execute_steer(invocation).await;
                let _ = reply.send(res);
                false
            }
            ControlCommand::Archive { reply } => {
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox: true })
                    .await;
                let res = self.release_worktree_if_held();
                let _ = reply.send(res);
                true
            }
            ControlCommand::InspectPhase { reply } => {
                let _ = reply.send(self.state.phase.clone());
                false
            }
            ControlCommand::Shutdown { reply } => {
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox: false })
                    .await;
                self.cleanup_resources();
                let _ = reply.send(());
                true
            }
        }
    }

    async fn execute_steer(
        &mut self,
        invocation: FrozenTurnInvocation,
    ) -> PortResult<SteerVerdict> {
        let state = std::mem::replace(
            &mut self.state,
            SessionState::new(
                self.opts.session_id.0.clone(),
                self.opts.workspace_encrypted,
                self.opts.depth,
            ),
        );
        let (next_state, actions) = step(state, KernelEvent::RequestSteer { invocation });
        self.state = next_state;

        let mut verdict = SteerVerdict::NotApplied;
        let mut follow_ups = VecDeque::new();
        for action in actions {
            if let KernelAction::SendAgentSteer {
                generation,
                prompt_text,
                ..
            } = action
            {
                let res = match &self.live_agent {
                    Some((_, port)) => port.steer(&prompt_text),
                    None => Ok(SteerVerdict::NotApplied),
                };
                let (v, outcome) = match res {
                    Ok(SteerVerdict::Applied) => (SteerVerdict::Applied, SteerOutcome::Applied),
                    Ok(SteerVerdict::NotApplied) => {
                        (SteerVerdict::NotApplied, SteerOutcome::NotApplied)
                    }
                    Ok(SteerVerdict::Unknown) | Err(_) => {
                        (SteerVerdict::Unknown, SteerOutcome::Unknown)
                    }
                };
                verdict = v;
                follow_ups.push_back(KernelEvent::SteerVerdictReceived {
                    generation,
                    outcome,
                });
            } else {
                self.execute_single_action(action, &mut follow_ups).await;
            }
        }
        while let Some(ev) = follow_ups.pop_front() {
            self.process_event_loop(ev).await;
        }
        Ok(verdict)
    }

    async fn process_event_loop(&mut self, initial: KernelEvent) {
        let mut queue = VecDeque::from([initial]);
        while let Some(event) = queue.pop_front() {
            if let KernelEvent::SubmitInput { invocation } = &event {
                let _ = self.deps.inbox.admit_turn(&AdmittedTurnInput {
                    workspace_id: self.opts.workspace_id.clone(),
                    session_id: self.opts.session_id.clone(),
                    turn_id: TurnId(invocation.turn_id.clone()),
                    category: InboxCategory::Human,
                    verified_requester: UserId(invocation.requester_user_id.clone()),
                    prompt_text: invocation.prompt_text.clone(),
                });
                self.turn_records
                    .entry(invocation.turn_id.clone())
                    .or_insert_with(|| HistoryTurnRecord {
                        turn_id: TurnId(invocation.turn_id.clone()),
                        author_user_id: Some(UserId(invocation.requester_user_id.clone())),
                        user_prompt: invocation.prompt_text.clone(),
                        assistant_blocks: Vec::new(),
                        outcome: None,
                    });
                if self
                    .deps
                    .history
                    .is_user_turn_durable(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        &TurnId(invocation.turn_id.clone()),
                    )
                    .unwrap_or(false)
                {
                    self.state
                        .durable_user_turn_ids
                        .insert(invocation.turn_id.clone());
                }
            }

            let cur = std::mem::replace(
                &mut self.state,
                SessionState::new(
                    self.opts.session_id.0.clone(),
                    self.opts.workspace_encrypted,
                    self.opts.depth,
                ),
            );
            let (next_state, actions) = step(cur, event);
            self.state = next_state;

            for action in actions {
                self.execute_single_action(action, &mut queue).await;
            }
        }
    }

    async fn execute_single_action(
        &mut self,
        action: KernelAction,
        follow_ups: &mut VecDeque<KernelEvent>,
    ) {
        match action {
            KernelAction::PrepareNewAgent {
                adapter_id,
                mcp_selection_digest,
                generation,
                ..
            } => {
                let _permit = Arc::clone(&self.acp_start_semaphore).acquire_owned().await;
                let cwd = match self.ensure_working_directory() {
                    Ok(dir) => dir,
                    Err(err) => {
                        follow_ups.push_back(KernelEvent::AgentPrepareFailed {
                            generation,
                            code: err.message,
                        });
                        return;
                    }
                };
                let spec = AcpSpawnSpec {
                    adapter_id: adapter_id.clone(),
                    command: PathBuf::from(&adapter_id),
                    args: Vec::new(),
                    cwd,
                    env: BTreeMap::new(),
                    mcp_mounts: Vec::new(),
                };
                match self.deps.acp.launch_session(&spec) {
                    Ok(port) => {
                        self.next_agent_seq += 1;
                        let instance_id = format!("agent-{}", self.next_agent_seq);
                        let handle = WarmAgentHandle {
                            agent_instance_id: instance_id.clone(),
                            adapter_id,
                            mcp_selection_digest,
                            owner_user_id: self.state.default_requester_user_id.clone(),
                        };
                        self.live_agent = Some((instance_id, port));
                        follow_ups.push_back(KernelEvent::AgentPrepared {
                            generation,
                            agent: handle,
                        });
                    }
                    Err(err) => {
                        follow_ups.push_back(KernelEvent::AgentPrepareFailed {
                            generation,
                            code: err.message,
                        });
                    }
                }
            }
            KernelAction::ReuseWarmAgent {
                agent_instance_id,
                generation,
                ..
            } => {
                let handle = WarmAgentHandle {
                    agent_instance_id,
                    adapter_id: self.state.default_adapter_id.clone(),
                    mcp_selection_digest: self.state.default_mcp_selection_digest.clone(),
                    owner_user_id: self.state.default_requester_user_id.clone(),
                };
                follow_ups.push_back(KernelEvent::AgentPrepared {
                    generation,
                    agent: handle,
                });
            }
            KernelAction::RetireAgent { agent_instance_id }
            | KernelAction::DetachAgentBackgroundCleanup { agent_instance_id } => {
                if self
                    .live_agent
                    .as_ref()
                    .is_some_and(|(id, _)| id == &agent_instance_id)
                    && let Some((_, port)) = self.live_agent.take()
                {
                    let _ = port.terminate();
                }
            }
            KernelAction::StartAgentPrompt {
                turn_id,
                prompt_text,
                generation,
            } => {
                let _ = self.deps.inbox.update_submission_stage(
                    &self.opts.workspace_id,
                    &self.opts.session_id,
                    &TurnId(turn_id),
                    SubmissionStage::Submitted,
                );
                if let Some((_, port)) = &self.live_agent
                    && let Err(err) = port.send_prompt(&prompt_text)
                {
                    follow_ups.push_back(KernelEvent::AgentCrashed {
                        generation,
                        code: err.message,
                    });
                }
            }
            KernelAction::AppendAssistantOutput { turn_id, text } => {
                if let Some(rec) = self.turn_records.get_mut(&turn_id) {
                    if let Some(HistoryBlock::Text { text: prev }) = rec.assistant_blocks.last_mut()
                    {
                        prev.push_str(&text);
                    } else {
                        rec.assistant_blocks.push(HistoryBlock::Text { text });
                    }
                    let _ = self.deps.history.upsert_turn_record(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        rec,
                    );
                }
            }
            KernelAction::RecordToolStatus {
                turn_id,
                tool_call_id,
                title,
                status,
            } => {
                if let Some(rec) = self.turn_records.get_mut(&turn_id) {
                    rec.assistant_blocks.push(HistoryBlock::ToolCall {
                        tool_call_id,
                        title,
                        status,
                    });
                    let _ = self.deps.history.upsert_turn_record(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        rec,
                    );
                }
            }
            KernelAction::PublishPermissionPrompt {
                turn_id,
                request_id,
                tool_call_id,
            } => {
                if let Some(rec) = self.turn_records.get_mut(&turn_id) {
                    rec.assistant_blocks.push(HistoryBlock::PermissionRequest {
                        request_id,
                        tool_call_id,
                        resolved_option_id: None,
                    });
                    let _ = self.deps.history.upsert_turn_record(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        rec,
                    );
                }
            }
            KernelAction::ForwardPermissionReply {
                request_id,
                selected_option_id,
                cancelled,
                ..
            } => {
                if let Some((_, port)) = &self.live_agent {
                    let _ = port.reply_permission(&PermissionDecision {
                        request_id,
                        selected_option_id,
                        cancelled,
                        notes: None,
                    });
                }
            }
            KernelAction::InterruptAgent { .. } => {
                if let Some((_, port)) = &self.live_agent {
                    let _ = port.cancel_turn();
                }
            }
            KernelAction::BeginSettling {
                turn_id,
                generation,
                ..
            } => {
                let deps = Arc::clone(&self.deps);
                let session_id = self.opts.session_id.clone();
                let workdir = self.current_workdir();
                let timeout_dur = self.opts.settling_timeout;
                let res = tokio::time::timeout(timeout_dur, async move {
                    if let Some(dir) = workdir {
                        let _ = deps.diff_store.capture_turn_snapshot(
                            &session_id,
                            &TurnId(turn_id),
                            &dir,
                        );
                    }
                })
                .await;
                match res {
                    Ok(()) => follow_ups.push_back(KernelEvent::SettlingCompleted { generation }),
                    Err(_) => follow_ups.push_back(KernelEvent::SettlingTimedOut { generation }),
                }
            }
            KernelAction::FinalizeTurn { turn_id, reason } => {
                let outcome = match reason {
                    TurnTerminalReason::Completed => TurnTerminalOutcome::Finished,
                    TurnTerminalReason::Canceled => TurnTerminalOutcome::Canceled,
                    TurnTerminalReason::AgentFailed { .. }
                    | TurnTerminalReason::SilentNoOutput
                    | TurnTerminalReason::StartupInterruptedUnknown => TurnTerminalOutcome::Failed,
                };
                if let Some(rec) = self.turn_records.get_mut(&turn_id) {
                    rec.outcome = Some(outcome);
                    let _ = self.deps.history.upsert_turn_record(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        rec,
                    );
                }
                let _ = self.deps.inbox.update_submission_stage(
                    &self.opts.workspace_id,
                    &self.opts.session_id,
                    &TurnId(turn_id),
                    SubmissionStage::Settled,
                );
            }
            KernelAction::CancelPendingPermission { .. }
            | KernelAction::SendAgentSteer { .. }
            | KernelAction::SteerRejected { .. }
            | KernelAction::InputRejected { .. }
            | KernelAction::PrepareEditAndResendFork { .. }
            | KernelAction::ChildSessionAdmitted { .. }
            | KernelAction::ChildSessionRejected { .. } => {}
        }
    }

    fn ensure_working_directory(&mut self) -> PortResult<PathBuf> {
        if let Some(lease) = &self.worktree_lease {
            return Ok(lease.worktree_path.clone());
        }
        if self.opts.use_worktree
            && let (Some(pid), Some(root)) = (&self.opts.local_project_id, &self.opts.project_root)
        {
            let lease =
                self.deps
                    .worktree
                    .acquire_worktree(pid, root, &self.opts.session_id, None)?;
            let path = lease.worktree_path.clone();
            self.worktree_lease = Some(lease);
            return Ok(path);
        }
        Ok(self
            .opts
            .project_root
            .clone()
            .unwrap_or_else(|| PathBuf::from(".")))
    }

    fn current_workdir(&self) -> Option<PathBuf> {
        self.worktree_lease
            .as_ref()
            .map(|l| l.worktree_path.clone())
            .or_else(|| self.opts.project_root.clone())
    }

    fn release_worktree_if_held(&mut self) -> PortResult<()> {
        if let Some(lease) = self.worktree_lease.take() {
            self.deps.worktree.release_worktree(&lease)?;
        }
        Ok(())
    }

    fn cleanup_resources(&mut self) {
        if let Some((_, port)) = self.live_agent.take() {
            let _ = port.terminate();
        }
    }
}
