use crate::DaemonDependencies;
use lody_kernel::{
    FrozenTurnInvocation, Generation, KernelAction, KernelEvent, SessionPhase, SessionState,
    SteerOutcome, TurnSourceKind, TurnTerminalReason, WarmAgentHandle, step,
};
use lody_ports::{
    AcpEventSink, AcpInboundEvent, AcpSessionPort, AcpSpawnSpec, AdmittedTurnInput,
    CustomCommandSpec, HistoryBlock, HistoryTurnRecord, InboxCategory, LocalProjectId,
    McpServerMount, PermissionDecision, PortError, PortErrorKind, PortResult, SessionId,
    SteerVerdict, SubmissionStage, TurnId, TurnTerminalOutcome, UserId, WorkspaceId, WorktreeLease,
};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;

const STREAM_FLUSH_BYTES: usize = 4096;
const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(150);

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

enum ActorEvent {
    WakeInbox,
    Kernel(KernelEvent),
    PrepareCompleted {
        generation: Generation,
        adapter_id: String,
        mcp_selection_digest: String,
        active_generation: Arc<AtomicU64>,
        result: PortResult<Box<dyn AcpSessionPort>>,
    },
}

#[derive(Clone)]
pub struct SessionHandle {
    control_tx: mpsc::Sender<ControlCommand>,
    event_tx: mpsc::Sender<ActorEvent>,
}

impl SessionHandle {
    pub async fn wake_inbox(&self) -> PortResult<()> {
        self.event_tx
            .send(ActorEvent::WakeInbox)
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))
    }

    pub async fn send_event(&self, event: KernelEvent) -> PortResult<()> {
        self.event_tx
            .send(ActorEvent::Kernel(event))
            .await
            .map_err(|_| PortError::new(PortErrorKind::Unavailable, "session actor closed"))
    }

    pub fn try_send_event(&self, event: KernelEvent) -> PortResult<()> {
        self.event_tx
            .try_send(ActorEvent::Kernel(event))
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

struct ActorAcpSink {
    event_tx: mpsc::Sender<ActorEvent>,
    active_generation: Arc<AtomicU64>,
}

impl AcpEventSink for ActorAcpSink {
    fn on_acp_event(&self, event: AcpInboundEvent) {
        let generation = Generation(self.active_generation.load(Ordering::SeqCst));
        let mapped = match event {
            AcpInboundEvent::MessageChunk { text } => {
                Some(KernelEvent::AgentOutputChunk { generation, text })
            }
            AcpInboundEvent::ToolStatus {
                tool_call_id,
                title,
                status,
            } => Some(KernelEvent::AgentToolStatus {
                generation,
                tool_call_id,
                title,
                status,
            }),
            AcpInboundEvent::PermissionRequest {
                request_id,
                tool_call_id,
                ..
            } => Some(KernelEvent::AgentRequestedPermission {
                generation,
                request_id,
                tool_call_id,
            }),
            AcpInboundEvent::PromptFinished { stop_reason } => (stop_reason != "cancelled")
                .then_some(KernelEvent::AgentPromptFinished { generation }),
            AcpInboundEvent::ProcessExited {
                exit_code,
                prompt_was_in_flight,
            } => prompt_was_in_flight.then(|| KernelEvent::AgentCrashed {
                generation,
                code: format!("exit_{}", exit_code.unwrap_or(-1)),
            }),
        };
        if let Some(ev) = mapped {
            let _ = self.event_tx.blocking_send(ActorEvent::Kernel(ev));
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
    pub custom_acp: Option<CustomCommandSpec>,
    pub settling_timeout: Duration,
}

struct LiveAgentSlot {
    instance_id: String,
    active_generation: Arc<AtomicU64>,
    port: Box<dyn AcpSessionPort>,
}

struct ActiveTurnBuffer {
    record: HistoryTurnRecord,
    dirty: bool,
    unflushed_bytes: usize,
}

struct SessionActor {
    opts: SessionSpawnOptions,
    deps: Arc<DaemonDependencies>,
    acp_start_semaphore: Arc<Semaphore>,
    state: SessionState,
    live_agent: Option<LiveAgentSlot>,
    prepare_abort: Option<AbortHandle>,
    worktree_lease: Option<WorktreeLease>,
    active_turn: Option<ActiveTurnBuffer>,
    event_tx: mpsc::Sender<ActorEvent>,
    control_rx: mpsc::Receiver<ControlCommand>,
    event_rx: mpsc::Receiver<ActorEvent>,
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
        prepare_abort: None,
        worktree_lease: None,
        active_turn: None,
        event_tx: event_tx.clone(),
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
    fn has_dirty_turn(&self) -> bool {
        self.active_turn.as_ref().is_some_and(|b| b.dirty)
    }

    fn flush_active_turn(&mut self) -> bool {
        let Some(buf) = &mut self.active_turn else {
            return true;
        };
        if !buf.dirty {
            return true;
        }
        if self
            .deps
            .history
            .upsert_turn_record(&self.opts.workspace_id, &self.opts.session_id, &buf.record)
            .is_ok()
        {
            buf.dirty = false;
            buf.unflushed_bytes = 0;
            return true;
        }
        false
    }

    fn abort_pending_prepare(&mut self) {
        if let Some(abort) = self.prepare_abort.take() {
            abort.abort();
        }
    }

    async fn run(mut self) {
        let mut flush_interval = tokio::time::interval(STREAM_FLUSH_INTERVAL);
        flush_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let _ = flush_interval.tick().await;

        loop {
            let dirty = self.has_dirty_turn();
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
                        Some(actor_ev) => self.handle_actor_event(actor_ev).await,
                        None => break,
                    }
                }
                _ = flush_interval.tick(), if dirty => {
                    let _ = self.flush_active_turn();
                }
            }
        }
        let _ = self.flush_active_turn();
        self.cleanup_resources();
    }

    async fn handle_actor_event(&mut self, actor_ev: ActorEvent) {
        match actor_ev {
            ActorEvent::WakeInbox => {
                self.maybe_claim_from_durable_inbox().await;
            }
            ActorEvent::Kernel(ev) => {
                self.process_event_loop(ev).await;
                self.maybe_claim_from_durable_inbox().await;
            }
            ActorEvent::PrepareCompleted {
                generation,
                adapter_id,
                mcp_selection_digest,
                active_generation,
                result,
            } => {
                self.prepare_abort = None;
                let expected = matches!(
                    &self.state.phase,
                    SessionPhase::Preparing { generation: g, .. } if *g == generation
                );
                if !expected {
                    if let Ok(stale_port) = result {
                        let _ = stale_port.terminate();
                    }
                    return;
                }
                match result {
                    Ok(port) => {
                        self.next_agent_seq += 1;
                        let instance_id = format!("agent-{}", self.next_agent_seq);
                        let handle = WarmAgentHandle {
                            agent_instance_id: instance_id.clone(),
                            adapter_id,
                            mcp_selection_digest,
                            owner_user_id: self.state.default_requester_user_id.clone(),
                        };
                        self.live_agent = Some(LiveAgentSlot {
                            instance_id,
                            active_generation,
                            port,
                        });
                        self.process_event_loop(KernelEvent::AgentPrepared {
                            generation,
                            agent: handle,
                        })
                        .await;
                    }
                    Err(err) => {
                        self.process_event_loop(KernelEvent::AgentPrepareFailed {
                            generation,
                            code: err.message,
                        })
                        .await;
                    }
                }
                self.maybe_claim_from_durable_inbox().await;
            }
        }
    }

    async fn maybe_claim_from_durable_inbox(&mut self) {
        if !matches!(self.state.phase, SessionPhase::Idle { .. }) || self.has_dirty_turn() {
            return;
        }
        let Ok(Some(admitted)) = self
            .deps
            .inbox
            .claim_next_runnable(&self.opts.workspace_id, &self.opts.session_id)
        else {
            return;
        };

        if let Some(custom) = admitted.custom_acp.clone() {
            self.opts.custom_acp = Some(custom);
        }

        self.active_turn = Some(ActiveTurnBuffer {
            record: HistoryTurnRecord {
                turn_id: admitted.turn_id.clone(),
                author_user_id: Some(admitted.verified_requester.clone()),
                user_prompt: admitted.prompt_text.clone(),
                assistant_blocks: Vec::new(),
                outcome: None,
            },
            dirty: false,
            unflushed_bytes: 0,
        });

        if self
            .deps
            .history
            .is_user_turn_durable(
                &self.opts.workspace_id,
                &self.opts.session_id,
                &admitted.turn_id,
            )
            .unwrap_or(false)
        {
            self.state
                .durable_user_turn_ids
                .insert(admitted.turn_id.0.clone());
        }

        let source = match admitted.category {
            InboxCategory::Human => TurnSourceKind::Human,
            InboxCategory::DelegatedReceiptBatch => TurnSourceKind::DelegatedReceiptBatch,
            InboxCategory::Schedule => TurnSourceKind::Schedule,
            InboxCategory::Automation => TurnSourceKind::HostAutomation,
        };
        let invocation = FrozenTurnInvocation {
            turn_id: admitted.turn_id.0,
            requester_user_id: admitted.verified_requester.0,
            prompt_text: admitted.prompt_text,
            source,
            adapter_id: admitted.adapter_id,
            mcp_selection_digest: "default".to_string(),
            signed_intent_verified: admitted.signed_intent_verified,
        };
        self.process_event_loop(KernelEvent::SubmitInput { invocation })
            .await;
    }

    async fn handle_control(&mut self, cmd: ControlCommand) -> bool {
        match cmd {
            ControlCommand::Cancel { pause_inbox, reply } => {
                self.abort_pending_prepare();
                let _ = self.deps.inbox.set_inbox_paused(
                    &self.opts.workspace_id,
                    &self.opts.session_id,
                    pause_inbox,
                );
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox })
                    .await;
                let _ = self.flush_active_turn();
                self.maybe_claim_from_durable_inbox().await;
                let _ = reply.send(());
                false
            }
            ControlCommand::ReplyPermission { decision, reply } => {
                if let Some(buf) = &mut self.active_turn {
                    for block in &mut buf.record.assistant_blocks {
                        if let HistoryBlock::PermissionRequest {
                            request_id,
                            resolved_option_id,
                            ..
                        } = block
                            && request_id == &decision.request_id
                        {
                            *resolved_option_id = decision.selected_option_id.clone();
                            buf.dirty = true;
                        }
                    }
                }
                let _ = self.flush_active_turn();
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
                self.abort_pending_prepare();
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox: true })
                    .await;
                let _ = self.flush_active_turn();
                self.cleanup_resources();
                let res = self.release_worktree_if_held();
                let _ = reply.send(res);
                true
            }
            ControlCommand::InspectPhase { reply } => {
                let _ = reply.send(self.state.phase.clone());
                false
            }
            ControlCommand::Shutdown { reply } => {
                self.abort_pending_prepare();
                self.process_event_loop(KernelEvent::CancelRequested { pause_inbox: false })
                    .await;
                let _ = self.flush_active_turn();
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
        let cur = std::mem::replace(
            &mut self.state,
            SessionState::new(
                self.opts.session_id.0.clone(),
                self.opts.workspace_encrypted,
                self.opts.depth,
            ),
        );
        let (next_state, actions) = step(cur, KernelEvent::RequestSteer { invocation });
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
                    Some(slot) => slot.port.steer(&prompt_text),
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
            if let KernelEvent::SubmitInput { invocation } = &event
                && self
                    .active_turn
                    .as_ref()
                    .is_none_or(|b| b.record.turn_id.0 != invocation.turn_id)
            {
                let _ = self.deps.inbox.admit_turn(&AdmittedTurnInput {
                    workspace_id: self.opts.workspace_id.clone(),
                    session_id: self.opts.session_id.clone(),
                    turn_id: TurnId(invocation.turn_id.clone()),
                    category: InboxCategory::Human,
                    verified_requester: UserId(invocation.requester_user_id.clone()),
                    prompt_text: invocation.prompt_text.clone(),
                    adapter_id: invocation.adapter_id.clone(),
                    custom_acp: self.opts.custom_acp.clone(),
                    signed_intent_verified: invocation.signed_intent_verified,
                });
                let rec = HistoryTurnRecord {
                    turn_id: TurnId(invocation.turn_id.clone()),
                    author_user_id: Some(UserId(invocation.requester_user_id.clone())),
                    user_prompt: invocation.prompt_text.clone(),
                    assistant_blocks: Vec::new(),
                    outcome: None,
                };
                let _ = self.deps.history.upsert_turn_record(
                    &self.opts.workspace_id,
                    &self.opts.session_id,
                    &rec,
                );
                self.active_turn = Some(ActiveTurnBuffer {
                    record: rec,
                    dirty: false,
                    unflushed_bytes: 0,
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
                self.abort_pending_prepare();
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
                let (command, args) = match &self.opts.custom_acp {
                    Some(custom) => (custom.command.clone(), custom.args.clone()),
                    None => (PathBuf::from(&adapter_id), Vec::new()),
                };
                let spec = AcpSpawnSpec {
                    adapter_id: adapter_id.clone(),
                    command,
                    args,
                    cwd,
                    env: BTreeMap::new(),
                    mcp_mounts: vec![McpServerMount {
                        name: "lody".to_string(),
                        transport_url: "http://127.0.0.1:0/mcp".to_string(),
                        bearer_token: None,
                    }],
                };
                let active_generation = Arc::new(AtomicU64::new(generation.0));
                let sink = Arc::new(ActorAcpSink {
                    event_tx: self.event_tx.clone(),
                    active_generation: Arc::clone(&active_generation),
                });
                let sem = Arc::clone(&self.acp_start_semaphore);
                let deps = Arc::clone(&self.deps);
                let tx = self.event_tx.clone();
                let task = tokio::spawn(async move {
                    let permit = sem.acquire_owned().await;
                    let result = tokio::task::spawn_blocking(move || {
                        let _held_permit = permit;
                        deps.acp.launch_session(&spec, sink)
                    })
                    .await
                    .unwrap_or_else(|e| {
                        Err(PortError::new(PortErrorKind::Internal, e.to_string()))
                    });
                    let _ = tx
                        .send(ActorEvent::PrepareCompleted {
                            generation,
                            adapter_id,
                            mcp_selection_digest,
                            active_generation,
                            result,
                        })
                        .await;
                });
                self.prepare_abort = Some(task.abort_handle());
            }
            KernelAction::ReuseWarmAgent {
                agent_instance_id,
                generation,
                ..
            } => {
                if let Some(slot) = &self.live_agent {
                    slot.active_generation.store(generation.0, Ordering::SeqCst);
                }
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
                    .is_some_and(|slot| slot.instance_id == agent_instance_id)
                    && let Some(slot) = self.live_agent.take()
                {
                    let _ = slot.port.terminate();
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
                if let Some(slot) = &self.live_agent
                    && let Err(err) = slot.port.send_prompt(&prompt_text)
                {
                    follow_ups.push_back(KernelEvent::AgentCrashed {
                        generation,
                        code: err.message,
                    });
                }
            }
            KernelAction::AppendAssistantOutput { turn_id, text } => {
                let should_flush = if let Some(buf) = &mut self.active_turn
                    && buf.record.turn_id.0 == turn_id
                {
                    buf.unflushed_bytes += text.len();
                    if let Some(HistoryBlock::Text { text: prev }) =
                        buf.record.assistant_blocks.last_mut()
                    {
                        prev.push_str(&text);
                    } else {
                        buf.record
                            .assistant_blocks
                            .push(HistoryBlock::Text { text });
                    }
                    buf.dirty = true;
                    buf.unflushed_bytes >= STREAM_FLUSH_BYTES
                } else {
                    false
                };
                if should_flush {
                    let _ = self.flush_active_turn();
                }
            }
            KernelAction::RecordToolStatus {
                turn_id,
                tool_call_id,
                title,
                status,
            } => {
                if let Some(buf) = &mut self.active_turn
                    && buf.record.turn_id.0 == turn_id
                {
                    if let Some(HistoryBlock::ToolCall {
                        status: existing_status,
                        ..
                    }) = buf.record.assistant_blocks.iter_mut().find(|b| {
                        matches!(b, HistoryBlock::ToolCall { tool_call_id: id, .. } if id == &tool_call_id)
                    }) {
                        *existing_status = status;
                    } else {
                        buf.record.assistant_blocks.push(HistoryBlock::ToolCall {
                            tool_call_id,
                            title,
                            status,
                        });
                    }
                    buf.dirty = true;
                }
            }
            KernelAction::PublishPermissionPrompt {
                turn_id,
                request_id,
                tool_call_id,
            } => {
                if let Some(buf) = &mut self.active_turn
                    && buf.record.turn_id.0 == turn_id
                {
                    buf.record
                        .assistant_blocks
                        .push(HistoryBlock::PermissionRequest {
                            request_id,
                            tool_call_id,
                            resolved_option_id: None,
                        });
                    buf.dirty = true;
                }
                let _ = self.flush_active_turn();
            }
            KernelAction::ForwardPermissionReply {
                request_id,
                selected_option_id,
                cancelled,
                ..
            } => {
                if let Some(slot) = &self.live_agent {
                    let _ = slot.port.reply_permission(&PermissionDecision {
                        request_id,
                        selected_option_id,
                        cancelled,
                        notes: None,
                    });
                }
            }
            KernelAction::InterruptAgent { .. } => {
                if let Some(slot) = &self.live_agent {
                    let _ = slot.port.cancel_turn();
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
                if let Some(buf) = &mut self.active_turn
                    && buf.record.turn_id.0 == turn_id
                {
                    buf.record.outcome = Some(outcome);
                    buf.dirty = true;
                }
                if self.flush_active_turn() {
                    let _ = self.deps.inbox.update_submission_stage(
                        &self.opts.workspace_id,
                        &self.opts.session_id,
                        &TurnId(turn_id),
                        SubmissionStage::Settled,
                    );
                }
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
            let lease = self.deps.worktree.acquire_worktree(
                &self.opts.workspace_id,
                pid,
                root,
                &self.opts.session_id,
                None,
            )?;
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
        self.abort_pending_prepare();
        if let Some(slot) = self.live_agent.take() {
            let _ = slot.port.terminate();
        }
    }
}
