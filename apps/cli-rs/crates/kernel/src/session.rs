#![forbid(unsafe_code)]

use crate::inbox::{InboxAdmitOutcome, InboxState};
use crate::turn::{
    BufferedTurnOutput, ChildDelegationState, ChildRejectReason, GoalControlState,
    PendingPermissionRequest, RunningTurnState, SteerFlightState,
};
use crate::types::{
    DelegatedReceipt, FrozenTurnInvocation, Generation, LATE_STREAM_ACTIVITY_TTL_MS,
    NativeSessionActivity, PresencePublishReason, RetainedTurn, SteerOutcome, TurnTerminalReason,
    WarmAgentHandle,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionPhase {
    Idle {
        retained_turn: Option<RetainedTurn>,
        warm_agent: Option<WarmAgentHandle>,
    },
    Preparing {
        invocation: FrozenTurnInvocation,
        generation: Generation,
        user_turn_durable: bool,
        stale_acp_retries_used: u8,
        prior_warm_agent: Option<WarmAgentHandle>,
    },
    Running(Box<RunningTurnState>),
    Settling {
        invocation: FrozenTurnInvocation,
        agent: WarmAgentHandle,
        generation: Generation,
        reason: TurnTerminalReason,
    },
    EditAndResendBarrier {
        target_turn_id: String,
        replacement_invocation: FrozenTurnInvocation,
        prior_warm_agent: Option<WarmAgentHandle>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub workspace_encrypted: bool,
    pub default_requester_user_id: String,
    pub default_adapter_id: String,
    pub default_mcp_selection_digest: String,
    pub next_generation: Generation,
    pub last_observed_clock_ms: u64,
    pub native_activity: NativeSessionActivity,
    pub durable_user_turn_ids: BTreeSet<String>,
    pub inbox: InboxState,
    pub goal: Option<GoalControlState>,
    pub child_delegation: ChildDelegationState,
    pub phase: SessionPhase,
}

impl SessionState {
    pub fn new(session_id: impl Into<String>, workspace_encrypted: bool, depth: u8) -> Self {
        Self {
            session_id: session_id.into(),
            workspace_encrypted,
            default_requester_user_id: String::new(),
            default_adapter_id: "default".to_string(),
            default_mcp_selection_digest: String::new(),
            next_generation: Generation(1),
            last_observed_clock_ms: 0,
            native_activity: NativeSessionActivity::Unsupported,
            durable_user_turn_ids: BTreeSet::new(),
            inbox: InboxState::default(),
            goal: None,
            child_delegation: ChildDelegationState::with_depth(depth),
            phase: SessionPhase::Idle {
                retained_turn: None,
                warm_agent: None,
            },
        }
    }

    pub fn has_live_out_of_turn_work(&self, now_ms: u64) -> bool {
        let SessionPhase::Idle {
            retained_turn,
            warm_agent: Some(_),
        } = &self.phase
        else {
            return false;
        };
        match self.native_activity {
            NativeSessionActivity::Running | NativeSessionActivity::Background => true,
            NativeSessionActivity::Idle => false,
            NativeSessionActivity::Unsupported => retained_turn
                .as_ref()
                .and_then(|r| r.late_activity_until_ms)
                .is_some_and(|until| now_ms < until),
        }
    }

    pub fn is_gc_protected(&self, now_ms: u64) -> bool {
        !matches!(self.phase, SessionPhase::Idle { .. }) || self.has_live_out_of_turn_work(now_ms)
    }

    fn allocate_generation(&mut self) -> Generation {
        let current = self.next_generation;
        self.next_generation = current.next();
        current
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum KernelEvent {
    SubmitInput {
        invocation: FrozenTurnInvocation,
    },
    EnqueueDelegationReceipt {
        receipt: DelegatedReceipt,
    },
    ReconcileEndedInboxClaim {
        turn_id: String,
    },
    UserTurnBecameDurable {
        turn_id: String,
    },
    AgentPrepared {
        generation: Generation,
        agent: WarmAgentHandle,
    },
    AgentPrepareFailed {
        generation: Generation,
        code: String,
    },
    AgentDisconnectedBeforeEvents {
        generation: Generation,
    },
    AgentOutputChunk {
        generation: Generation,
        text: String,
        observed_at_ms: u64,
    },
    AgentNativeActivityUpdated {
        generation: Generation,
        activity: NativeSessionActivity,
    },
    AdvanceClock {
        now_ms: u64,
    },
    AgentToolStatus {
        generation: Generation,
        tool_call_id: String,
        title: String,
        status: String,
    },
    AgentRequestedPermission {
        generation: Generation,
        request_id: String,
        tool_call_id: String,
    },
    UserRepliedPermission {
        request_id: String,
        selected_option_id: Option<String>,
        cancelled: bool,
    },
    RequestSteer {
        invocation: FrozenTurnInvocation,
    },
    SteerVerdictReceived {
        generation: Generation,
        outcome: SteerOutcome,
    },
    AgentPromptFinished {
        generation: Generation,
    },
    AgentCrashed {
        generation: Generation,
        code: String,
    },
    SettlingCompleted {
        generation: Generation,
    },
    SettlingTimedOut {
        generation: Generation,
    },
    CancelRequested {
        pause_inbox: bool,
    },
    BeginEditAndResend {
        target_turn_id: String,
        replacement_invocation: FrozenTurnInvocation,
    },
    EditAndResendCommitted,
    ConfigureGoal {
        goal: GoalControlState,
    },
    MarkGoalSatisfied,
    RequestChildSessionCreate {
        child_session_id: String,
    },
    SetIdentityRecoverySeal {
        sealed: bool,
    },
    RecoverAfterCrash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum KernelAction {
    InputRejected {
        turn_id: String,
        outcome: InboxAdmitOutcome,
    },
    PrepareNewAgent {
        turn_id: String,
        adapter_id: String,
        mcp_selection_digest: String,
        generation: Generation,
    },
    ReuseWarmAgent {
        turn_id: String,
        agent_instance_id: String,
        generation: Generation,
    },
    RetireAgent {
        agent_instance_id: String,
    },
    DetachAgentBackgroundCleanup {
        agent_instance_id: String,
    },
    PublishRunningPresence {
        reason: PresencePublishReason,
    },
    ClearRunningPresence,
    StartAgentPrompt {
        turn_id: String,
        prompt_text: String,
        generation: Generation,
    },
    AppendAssistantOutput {
        turn_id: String,
        text: String,
    },
    RecordToolStatus {
        turn_id: String,
        tool_call_id: String,
        title: String,
        status: String,
    },
    PublishPermissionPrompt {
        turn_id: String,
        request_id: String,
        tool_call_id: String,
    },
    ForwardPermissionReply {
        generation: Generation,
        request_id: String,
        selected_option_id: Option<String>,
        cancelled: bool,
    },
    CancelPendingPermission {
        turn_id: String,
        request_id: String,
    },
    SendAgentSteer {
        generation: Generation,
        steer_turn_id: String,
        prompt_text: String,
    },
    SteerRejected {
        steer_turn_id: String,
        reason: &'static str,
    },
    InterruptAgent {
        generation: Generation,
    },
    BeginSettling {
        turn_id: String,
        generation: Generation,
        reason: TurnTerminalReason,
    },
    FinalizeTurn {
        turn_id: String,
        reason: TurnTerminalReason,
    },
    PrepareEditAndResendFork {
        target_turn_id: String,
    },
    ChildSessionAdmitted {
        child_session_id: String,
        child_depth: u8,
    },
    ChildSessionRejected {
        child_session_id: String,
        reason: ChildRejectReason,
    },
}

fn begin_invocation_from_idle(
    state: &mut SessionState,
    warm_agent: Option<WarmAgentHandle>,
    invocation: FrozenTurnInvocation,
    actions: &mut Vec<KernelAction>,
) {
    state.default_requester_user_id = invocation.requester_user_id.clone();
    state.default_adapter_id = invocation.adapter_id.clone();
    state.default_mcp_selection_digest = invocation.mcp_selection_digest.clone();

    let generation = state.allocate_generation();
    let user_turn_durable = state.durable_user_turn_ids.contains(&invocation.turn_id);

    match warm_agent {
        Some(agent) if agent.compatible_with(&invocation) => {
            let agent_id = agent.agent_instance_id.clone();
            state.phase = SessionPhase::Preparing {
                invocation: invocation.clone(),
                generation,
                user_turn_durable,
                stale_acp_retries_used: 0,
                prior_warm_agent: Some(agent),
            };
            actions.push(KernelAction::ReuseWarmAgent {
                turn_id: invocation.turn_id,
                agent_instance_id: agent_id,
                generation,
            });
        }
        Some(incompatible) => {
            state.native_activity = NativeSessionActivity::Unsupported;
            actions.push(KernelAction::RetireAgent {
                agent_instance_id: incompatible.agent_instance_id,
            });
            state.phase = SessionPhase::Preparing {
                invocation: invocation.clone(),
                generation,
                user_turn_durable,
                stale_acp_retries_used: 0,
                prior_warm_agent: None,
            };
            actions.push(KernelAction::PrepareNewAgent {
                turn_id: invocation.turn_id,
                adapter_id: invocation.adapter_id,
                mcp_selection_digest: invocation.mcp_selection_digest,
                generation,
            });
        }
        None => {
            state.native_activity = NativeSessionActivity::Unsupported;
            state.phase = SessionPhase::Preparing {
                invocation: invocation.clone(),
                generation,
                user_turn_durable,
                stale_acp_retries_used: 0,
                prior_warm_agent: None,
            };
            actions.push(KernelAction::PrepareNewAgent {
                turn_id: invocation.turn_id,
                adapter_id: invocation.adapter_id,
                mcp_selection_digest: invocation.mcp_selection_digest,
                generation,
            });
        }
    }
}

fn take_phase(phase: &mut SessionPhase) -> SessionPhase {
    std::mem::replace(
        phase,
        SessionPhase::Idle {
            retained_turn: None,
            warm_agent: None,
        },
    )
}

fn maybe_dispatch_when_idle(state: &mut SessionState, actions: &mut Vec<KernelAction>) {
    if !matches!(state.phase, SessionPhase::Idle { .. }) {
        return;
    }

    if state.has_live_out_of_turn_work(state.last_observed_clock_ms)
        && !state.inbox.has_runnable_human_entry()
    {
        return;
    }

    if let Some(next) = state.inbox.claim_next_for_execution(
        &state.default_requester_user_id,
        &state.default_adapter_id,
        &state.default_mcp_selection_digest,
        state.workspace_encrypted,
    ) {
        let warm = match take_phase(&mut state.phase) {
            SessionPhase::Idle { warm_agent, .. } => warm_agent,
            _ => None,
        };
        begin_invocation_from_idle(state, warm, next, actions);
        return;
    }

    if !state.inbox.paused
        && !state.inbox.sealed_for_identity_recovery
        && let Some(goal) = state.goal.as_mut()
        && let Some(goal_turn) = goal.next_continuation_invocation(state.workspace_encrypted)
    {
        state
            .durable_user_turn_ids
            .insert(goal_turn.turn_id.clone());
        let _ = state.inbox.admit(goal_turn, state.workspace_encrypted);
        if let Some(claimed) = state.inbox.claim_next_for_execution(
            &state.default_requester_user_id,
            &state.default_adapter_id,
            &state.default_mcp_selection_digest,
            state.workspace_encrypted,
        ) {
            let warm = match take_phase(&mut state.phase) {
                SessionPhase::Idle { warm_agent, .. } => warm_agent,
                _ => None,
            };
            begin_invocation_from_idle(state, warm, claimed, actions);
        }
    }
}

fn flush_buffered_outputs(running: &mut RunningTurnState, actions: &mut Vec<KernelAction>) {
    for item in running.buffered_outputs.drain(..) {
        match item {
            BufferedTurnOutput::TextChunk { text } => {
                actions.push(KernelAction::AppendAssistantOutput {
                    turn_id: running.invocation.turn_id.clone(),
                    text,
                });
            }
            BufferedTurnOutput::ToolStatus {
                tool_call_id,
                title,
                status,
            } => {
                actions.push(KernelAction::RecordToolStatus {
                    turn_id: running.invocation.turn_id.clone(),
                    tool_call_id,
                    title,
                    status,
                });
            }
        }
    }
}

pub fn step(mut state: SessionState, event: KernelEvent) -> (SessionState, Vec<KernelAction>) {
    let mut actions = Vec::new();

    match event {
        KernelEvent::SubmitInput { invocation } => {
            let turn_id = invocation.turn_id.clone();
            let outcome = state.inbox.admit(invocation, state.workspace_encrypted);
            if matches!(
                outcome,
                InboxAdmitOutcome::RejectedRetiredId
                    | InboxAdmitOutcome::RejectedUnsignedEncryptedInput
            ) {
                actions.push(KernelAction::InputRejected { turn_id, outcome });
                return (state, actions);
            }
            maybe_dispatch_when_idle(&mut state, &mut actions);
        }
        KernelEvent::EnqueueDelegationReceipt { receipt } => {
            if state.inbox.push_receipt(&state.session_id, receipt) {
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
        }
        KernelEvent::ReconcileEndedInboxClaim { turn_id } => {
            if state.inbox.settle_ended_claim(&turn_id) {
                actions.push(KernelAction::FinalizeTurn {
                    turn_id,
                    reason: TurnTerminalReason::StartupInterruptedUnknown,
                });
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
        }
        KernelEvent::UserTurnBecameDurable { turn_id } => {
            state.durable_user_turn_ids.insert(turn_id.clone());
            match &mut state.phase {
                SessionPhase::Preparing {
                    invocation,
                    user_turn_durable,
                    ..
                } if invocation.turn_id == turn_id => {
                    *user_turn_durable = true;
                }
                SessionPhase::Running(running) if running.invocation.turn_id == turn_id => {
                    running.user_turn_durable = true;
                    flush_buffered_outputs(running, &mut actions);
                }
                _ => {}
            }
        }
        KernelEvent::AgentPrepared { generation, agent } => match take_phase(&mut state.phase) {
            SessionPhase::Preparing {
                invocation,
                generation: expected_gen,
                user_turn_durable,
                stale_acp_retries_used,
                prior_warm_agent,
            } if expected_gen == generation => {
                state.native_activity = if !agent.advertises_session_activity {
                    NativeSessionActivity::Unsupported
                } else if prior_warm_agent.is_some()
                    && !matches!(state.native_activity, NativeSessionActivity::Unsupported)
                {
                    state.native_activity
                } else {
                    NativeSessionActivity::Idle
                };
                state.inbox.mark_submitted(&invocation.turn_id);
                let prompt_text = invocation.prompt_text.clone();
                let turn_id = invocation.turn_id.clone();
                let presence_reason = if stale_acp_retries_used > 0 {
                    PresencePublishReason::StaleAcpRecovery
                } else {
                    PresencePublishReason::TurnStarted
                };
                state.phase = SessionPhase::Running(Box::new(RunningTurnState::new(
                    invocation,
                    agent,
                    generation,
                    user_turn_durable,
                    stale_acp_retries_used,
                )));
                actions.push(KernelAction::PublishRunningPresence {
                    reason: presence_reason,
                });
                actions.push(KernelAction::StartAgentPrompt {
                    turn_id,
                    prompt_text,
                    generation,
                });
            }
            other => state.phase = other,
        },
        KernelEvent::AgentPrepareFailed { generation, code } => {
            match take_phase(&mut state.phase) {
                SessionPhase::Preparing {
                    invocation,
                    generation: expected_gen,
                    prior_warm_agent,
                    ..
                } if expected_gen == generation => {
                    state.native_activity = NativeSessionActivity::Unsupported;
                    if let Some(old) = prior_warm_agent {
                        actions.push(KernelAction::DetachAgentBackgroundCleanup {
                            agent_instance_id: old.agent_instance_id,
                        });
                    }
                    state.inbox.settle_and_retire(&invocation.turn_id);
                    let reason = TurnTerminalReason::AgentFailed { code };
                    actions.push(KernelAction::FinalizeTurn {
                        turn_id: invocation.turn_id,
                        reason,
                    });
                    actions.push(KernelAction::ClearRunningPresence);
                    maybe_dispatch_when_idle(&mut state, &mut actions);
                }
                other => state.phase = other,
            }
        }
        KernelEvent::AgentDisconnectedBeforeEvents { generation } => {
            match take_phase(&mut state.phase) {
                SessionPhase::Running(running) if running.generation == generation => {
                    let can_retry = running.can_retry_stale_acp_before_events();
                    let RunningTurnState {
                        invocation,
                        agent,
                        user_turn_durable,
                        stale_acp_retries_used,
                        ..
                    } = *running;
                    state.native_activity = NativeSessionActivity::Unsupported;
                    actions.push(KernelAction::DetachAgentBackgroundCleanup {
                        agent_instance_id: agent.agent_instance_id.clone(),
                    });
                    if can_retry {
                        let next_gen = state.allocate_generation();
                        let turn_id = invocation.turn_id.clone();
                        let adapter_id = invocation.adapter_id.clone();
                        let mcp_selection_digest = invocation.mcp_selection_digest.clone();
                        state.phase = SessionPhase::Preparing {
                            invocation,
                            generation: next_gen,
                            user_turn_durable,
                            stale_acp_retries_used: stale_acp_retries_used + 1,
                            prior_warm_agent: None,
                        };
                        actions.push(KernelAction::PrepareNewAgent {
                            turn_id,
                            adapter_id,
                            mcp_selection_digest,
                            generation: next_gen,
                        });
                    } else {
                        let reason = TurnTerminalReason::AgentFailed {
                            code: "agent_disconnected".to_string(),
                        };
                        let turn_id = invocation.turn_id.clone();
                        state.phase = SessionPhase::Settling {
                            invocation,
                            agent,
                            generation,
                            reason: reason.clone(),
                        };
                        actions.push(KernelAction::BeginSettling {
                            turn_id,
                            generation,
                            reason,
                        });
                    }
                }
                other => state.phase = other,
            }
        }
        KernelEvent::AgentOutputChunk {
            generation,
            text,
            observed_at_ms,
        } => {
            state.last_observed_clock_ms = state.last_observed_clock_ms.max(observed_at_ms);
            match &mut state.phase {
                SessionPhase::Running(running) if running.generation == generation => {
                    if !text.is_empty() {
                        running.produced_visible_output = true;
                    }
                    if running.user_turn_durable {
                        actions.push(KernelAction::AppendAssistantOutput {
                            turn_id: running.invocation.turn_id.clone(),
                            text,
                        });
                    } else {
                        running
                            .buffered_outputs
                            .push(BufferedTurnOutput::TextChunk { text });
                    }
                }
                SessionPhase::Idle {
                    retained_turn: Some(retained),
                    warm_agent,
                } if retained.generation == generation => {
                    let non_empty = !text.is_empty();
                    let turn_id = retained.invocation.turn_id.clone();
                    if non_empty
                        && warm_agent.is_some()
                        && state.native_activity == NativeSessionActivity::Unsupported
                    {
                        retained.late_activity_until_ms = Some(
                            state
                                .last_observed_clock_ms
                                .saturating_add(LATE_STREAM_ACTIVITY_TTL_MS),
                        );
                        actions.push(KernelAction::PublishRunningPresence {
                            reason: PresencePublishReason::LateStreamActivity,
                        });
                    }
                    actions.push(KernelAction::AppendAssistantOutput { turn_id, text });
                }
                _ => {}
            }
        }
        KernelEvent::AgentNativeActivityUpdated {
            generation,
            activity,
        } => {
            let matches_gen = match &state.phase {
                SessionPhase::Running(r) => r.generation == generation,
                SessionPhase::Settling { generation: g, .. } => *g == generation,
                SessionPhase::Idle {
                    retained_turn: Some(r),
                    warm_agent: Some(_),
                } => r.generation == generation,
                SessionPhase::Idle {
                    warm_agent: Some(_),
                    ..
                } => true,
                _ => false,
            };
            if matches_gen {
                state.native_activity = activity;
                if let SessionPhase::Idle { retained_turn, .. } = &mut state.phase {
                    match activity {
                        NativeSessionActivity::Running | NativeSessionActivity::Background => {
                            if let Some(r) = retained_turn {
                                r.late_activity_until_ms = None;
                            }
                            actions.push(KernelAction::PublishRunningPresence {
                                reason: PresencePublishReason::NativeWorkRunning,
                            });
                        }
                        NativeSessionActivity::Idle => {
                            if let Some(r) = retained_turn {
                                r.late_activity_until_ms = None;
                            }
                            actions.push(KernelAction::ClearRunningPresence);
                            maybe_dispatch_when_idle(&mut state, &mut actions);
                        }
                        NativeSessionActivity::Unsupported => {}
                    }
                }
            }
        }
        KernelEvent::AdvanceClock { now_ms } => {
            state.last_observed_clock_ms = state.last_observed_clock_ms.max(now_ms);
            let mut expired = false;
            if let SessionPhase::Idle {
                retained_turn: Some(retained),
                ..
            } = &mut state.phase
                && let Some(until) = retained.late_activity_until_ms
                && state.last_observed_clock_ms >= until
            {
                retained.late_activity_until_ms = None;
                expired = true;
            }
            if expired {
                if !state.has_live_out_of_turn_work(state.last_observed_clock_ms) {
                    actions.push(KernelAction::ClearRunningPresence);
                }
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
        }
        KernelEvent::AgentToolStatus {
            generation,
            tool_call_id,
            title,
            status,
        } => {
            if let SessionPhase::Running(running) = &mut state.phase
                && running.generation == generation
            {
                running.produced_visible_output = true;
                if running.user_turn_durable {
                    actions.push(KernelAction::RecordToolStatus {
                        turn_id: running.invocation.turn_id.clone(),
                        tool_call_id,
                        title,
                        status,
                    });
                } else {
                    running
                        .buffered_outputs
                        .push(BufferedTurnOutput::ToolStatus {
                            tool_call_id,
                            title,
                            status,
                        });
                }
            }
        }
        KernelEvent::AgentRequestedPermission {
            generation,
            request_id,
            tool_call_id,
        } => {
            if let SessionPhase::Running(running) = &mut state.phase
                && running.generation == generation
            {
                running.pending_permissions.insert(
                    request_id.clone(),
                    PendingPermissionRequest {
                        request_id: request_id.clone(),
                        tool_call_id: tool_call_id.clone(),
                    },
                );
                actions.push(KernelAction::PublishPermissionPrompt {
                    turn_id: running.invocation.turn_id.clone(),
                    request_id,
                    tool_call_id,
                });
            }
        }
        KernelEvent::UserRepliedPermission {
            request_id,
            selected_option_id,
            cancelled,
        } => {
            if let SessionPhase::Running(running) = &mut state.phase
                && running.pending_permissions.remove(&request_id).is_some()
            {
                actions.push(KernelAction::ForwardPermissionReply {
                    generation: running.generation,
                    request_id,
                    selected_option_id,
                    cancelled,
                });
            }
        }
        KernelEvent::RequestSteer { invocation } => {
            if state.workspace_encrypted && !invocation.signed_intent_verified {
                actions.push(KernelAction::InputRejected {
                    turn_id: invocation.turn_id,
                    outcome: InboxAdmitOutcome::RejectedUnsignedEncryptedInput,
                });
                return (state, actions);
            }
            match &mut state.phase {
                SessionPhase::Running(running) => {
                    if invocation.mcp_selection_digest != running.invocation.mcp_selection_digest {
                        let _ = state.inbox.admit(invocation, state.workspace_encrypted);
                        return (state, actions);
                    }
                    if !matches!(running.steer_flight, SteerFlightState::None) {
                        actions.push(KernelAction::SteerRejected {
                            steer_turn_id: invocation.turn_id,
                            reason: "steer_already_in_flight",
                        });
                        return (state, actions);
                    }
                    let steer_turn_id = invocation.turn_id.clone();
                    let prompt_text = invocation.prompt_text.clone();
                    let generation = running.generation;
                    running.steer_flight = SteerFlightState::WaitingVerdict {
                        replacement: invocation,
                    };
                    actions.push(KernelAction::SendAgentSteer {
                        generation,
                        steer_turn_id,
                        prompt_text,
                    });
                }
                _ => {
                    actions.push(KernelAction::SteerRejected {
                        steer_turn_id: invocation.turn_id,
                        reason: "session_not_running",
                    });
                }
            }
        }
        KernelEvent::SteerVerdictReceived {
            generation,
            outcome,
        } => {
            if let SessionPhase::Running(running) = &mut state.phase
                && running.generation == generation
                && let SteerFlightState::WaitingVerdict { replacement } =
                    std::mem::replace(&mut running.steer_flight, SteerFlightState::None)
            {
                match outcome {
                    SteerOutcome::Applied => {
                        state.inbox.settle_and_retire(&running.invocation.turn_id);
                        state
                            .inbox
                            .known_turn_ids
                            .insert(replacement.turn_id.clone());
                        running.user_turn_durable =
                            state.durable_user_turn_ids.contains(&replacement.turn_id);
                        running.invocation = replacement;
                    }
                    SteerOutcome::NotApplied => {
                        let _ = state.inbox.admit(replacement, state.workspace_encrypted);
                    }
                    SteerOutcome::Unknown => {
                        state.inbox.mark_uncertain_and_retire(&replacement.turn_id);
                    }
                }
            }
        }
        KernelEvent::AgentPromptFinished { generation } => match take_phase(&mut state.phase) {
            SessionPhase::Running(mut running) if running.generation == generation => {
                if running.user_turn_durable {
                    flush_buffered_outputs(&mut running, &mut actions);
                }
                let reason = if running.produced_visible_output {
                    TurnTerminalReason::Completed
                } else {
                    TurnTerminalReason::SilentNoOutput
                };
                let RunningTurnState {
                    invocation, agent, ..
                } = *running;
                let turn_id = invocation.turn_id.clone();
                state.phase = SessionPhase::Settling {
                    invocation,
                    agent,
                    generation,
                    reason: reason.clone(),
                };
                actions.push(KernelAction::BeginSettling {
                    turn_id,
                    generation,
                    reason,
                });
            }
            other => state.phase = other,
        },
        KernelEvent::AgentCrashed { generation, code } => match take_phase(&mut state.phase) {
            SessionPhase::Running(running) if running.generation == generation => {
                let RunningTurnState {
                    invocation,
                    agent,
                    pending_permissions,
                    steer_flight,
                    ..
                } = *running;
                state.native_activity = NativeSessionActivity::Unsupported;
                for req_id in pending_permissions.into_keys() {
                    actions.push(KernelAction::CancelPendingPermission {
                        turn_id: invocation.turn_id.clone(),
                        request_id: req_id,
                    });
                }
                if let SteerFlightState::WaitingVerdict { replacement } = steer_flight {
                    state.inbox.mark_uncertain_and_retire(&replacement.turn_id);
                }
                actions.push(KernelAction::DetachAgentBackgroundCleanup {
                    agent_instance_id: agent.agent_instance_id.clone(),
                });
                let reason = TurnTerminalReason::AgentFailed { code };
                let turn_id = invocation.turn_id.clone();
                state.phase = SessionPhase::Settling {
                    invocation,
                    agent,
                    generation,
                    reason: reason.clone(),
                };
                actions.push(KernelAction::BeginSettling {
                    turn_id,
                    generation,
                    reason,
                });
            }
            other => state.phase = other,
        },
        KernelEvent::CancelRequested { pause_inbox } => {
            state.inbox.paused |= pause_inbox;
            if matches!(
                state.native_activity,
                NativeSessionActivity::Running | NativeSessionActivity::Background
            ) {
                state.native_activity = NativeSessionActivity::Idle;
            }
            match take_phase(&mut state.phase) {
                SessionPhase::Idle {
                    mut retained_turn,
                    warm_agent,
                } => {
                    if let Some(r) = &mut retained_turn {
                        r.late_activity_until_ms = None;
                    }
                    actions.push(KernelAction::ClearRunningPresence);
                    state.phase = SessionPhase::Idle {
                        retained_turn,
                        warm_agent,
                    };
                }
                SessionPhase::Preparing {
                    invocation,
                    generation,
                    prior_warm_agent,
                    ..
                } => {
                    actions.push(KernelAction::InterruptAgent { generation });
                    if let Some(old) = prior_warm_agent {
                        actions.push(KernelAction::DetachAgentBackgroundCleanup {
                            agent_instance_id: old.agent_instance_id,
                        });
                    }
                    state.inbox.settle_and_retire(&invocation.turn_id);
                    actions.push(KernelAction::FinalizeTurn {
                        turn_id: invocation.turn_id,
                        reason: TurnTerminalReason::Canceled,
                    });
                    actions.push(KernelAction::ClearRunningPresence);
                    maybe_dispatch_when_idle(&mut state, &mut actions);
                }
                SessionPhase::Running(running) => {
                    let RunningTurnState {
                        invocation,
                        agent,
                        generation,
                        pending_permissions,
                        steer_flight,
                        ..
                    } = *running;
                    for req_id in pending_permissions.into_keys() {
                        actions.push(KernelAction::CancelPendingPermission {
                            turn_id: invocation.turn_id.clone(),
                            request_id: req_id,
                        });
                    }
                    if let SteerFlightState::WaitingVerdict { replacement } = steer_flight {
                        state.inbox.mark_uncertain_and_retire(&replacement.turn_id);
                    }
                    let turn_id = invocation.turn_id.clone();
                    actions.push(KernelAction::InterruptAgent { generation });
                    state.phase = SessionPhase::Settling {
                        invocation,
                        agent,
                        generation,
                        reason: TurnTerminalReason::Canceled,
                    };
                    actions.push(KernelAction::BeginSettling {
                        turn_id,
                        generation,
                        reason: TurnTerminalReason::Canceled,
                    });
                }
                other => state.phase = other,
            }
        }
        KernelEvent::SettlingCompleted { generation } => match take_phase(&mut state.phase) {
            SessionPhase::Settling {
                invocation,
                agent,
                generation: expected_gen,
                reason,
            } if expected_gen == generation => {
                state.inbox.settle_and_retire(&invocation.turn_id);
                let turn_id = invocation.turn_id.clone();
                let retained_turn =
                    matches!(reason, TurnTerminalReason::Completed).then_some(RetainedTurn {
                        invocation,
                        generation,
                        late_activity_until_ms: None,
                    });
                let warm_agent = if matches!(reason, TurnTerminalReason::AgentFailed { .. }) {
                    state.native_activity = NativeSessionActivity::Unsupported;
                    None
                } else {
                    Some(agent)
                };
                actions.push(KernelAction::FinalizeTurn { turn_id, reason });
                state.phase = SessionPhase::Idle {
                    retained_turn,
                    warm_agent,
                };
                if state.has_live_out_of_turn_work(state.last_observed_clock_ms) {
                    actions.push(KernelAction::PublishRunningPresence {
                        reason: PresencePublishReason::NativeWorkRunning,
                    });
                } else {
                    actions.push(KernelAction::ClearRunningPresence);
                }
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
            other => state.phase = other,
        },
        KernelEvent::SettlingTimedOut { generation } => match take_phase(&mut state.phase) {
            SessionPhase::Settling {
                invocation,
                agent,
                generation: expected_gen,
                reason,
            } if expected_gen == generation => {
                state.native_activity = NativeSessionActivity::Unsupported;
                state.inbox.settle_and_retire(&invocation.turn_id);
                actions.push(KernelAction::DetachAgentBackgroundCleanup {
                    agent_instance_id: agent.agent_instance_id,
                });
                actions.push(KernelAction::FinalizeTurn {
                    turn_id: invocation.turn_id,
                    reason,
                });
                actions.push(KernelAction::ClearRunningPresence);
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
            other => state.phase = other,
        },
        KernelEvent::BeginEditAndResend {
            target_turn_id,
            replacement_invocation,
        } => {
            if state.workspace_encrypted && !replacement_invocation.signed_intent_verified {
                actions.push(KernelAction::InputRejected {
                    turn_id: replacement_invocation.turn_id,
                    outcome: InboxAdmitOutcome::RejectedUnsignedEncryptedInput,
                });
                return (state, actions);
            }
            let prior_warm = match take_phase(&mut state.phase) {
                SessionPhase::Idle { warm_agent, .. } => warm_agent,
                SessionPhase::Preparing {
                    invocation,
                    generation,
                    prior_warm_agent,
                    ..
                } => {
                    actions.push(KernelAction::InterruptAgent { generation });
                    state.inbox.settle_and_retire(&invocation.turn_id);
                    prior_warm_agent
                }
                SessionPhase::Running(running) => {
                    let RunningTurnState {
                        invocation,
                        agent,
                        generation,
                        ..
                    } = *running;
                    actions.push(KernelAction::InterruptAgent { generation });
                    state.inbox.settle_and_retire(&invocation.turn_id);
                    Some(agent)
                }
                SessionPhase::Settling { agent, .. } => Some(agent),
                SessionPhase::EditAndResendBarrier {
                    prior_warm_agent, ..
                } => prior_warm_agent,
            };
            actions.push(KernelAction::PrepareEditAndResendFork {
                target_turn_id: target_turn_id.clone(),
            });
            state.phase = SessionPhase::EditAndResendBarrier {
                target_turn_id,
                replacement_invocation,
                prior_warm_agent: prior_warm,
            };
        }
        KernelEvent::EditAndResendCommitted => match take_phase(&mut state.phase) {
            SessionPhase::EditAndResendBarrier {
                replacement_invocation,
                prior_warm_agent,
                ..
            } => {
                state
                    .durable_user_turn_ids
                    .insert(replacement_invocation.turn_id.clone());
                state
                    .inbox
                    .admit_and_claim_immediately(replacement_invocation.clone());
                begin_invocation_from_idle(
                    &mut state,
                    prior_warm_agent,
                    replacement_invocation,
                    &mut actions,
                );
            }
            other => state.phase = other,
        },
        KernelEvent::ConfigureGoal { goal } => {
            state.goal = Some(goal);
            maybe_dispatch_when_idle(&mut state, &mut actions);
        }
        KernelEvent::MarkGoalSatisfied => {
            if let Some(goal) = &mut state.goal {
                goal.satisfied = true;
            }
        }
        KernelEvent::RequestChildSessionCreate { child_session_id } => {
            if state.inbox.paused {
                actions.push(KernelAction::ChildSessionRejected {
                    child_session_id,
                    reason: ChildRejectReason::CollaborationStopped,
                });
            } else {
                match state.child_delegation.try_admit_child(&child_session_id) {
                    Ok(child_depth) => {
                        actions.push(KernelAction::ChildSessionAdmitted {
                            child_session_id,
                            child_depth,
                        });
                    }
                    Err(reason) => {
                        actions.push(KernelAction::ChildSessionRejected {
                            child_session_id,
                            reason,
                        });
                    }
                }
            }
        }
        KernelEvent::SetIdentityRecoverySeal { sealed } => {
            state.inbox.sealed_for_identity_recovery = sealed;
            if !sealed {
                maybe_dispatch_when_idle(&mut state, &mut actions);
            }
        }
        KernelEvent::RecoverAfterCrash => {
            state.native_activity = NativeSessionActivity::Unsupported;
            let retired_ids = state.inbox.recover_after_crash();
            for turn_id in retired_ids {
                actions.push(KernelAction::FinalizeTurn {
                    turn_id,
                    reason: TurnTerminalReason::StartupInterruptedUnknown,
                });
            }
            actions.push(KernelAction::ClearRunningPresence);
            state.phase = SessionPhase::Idle {
                retained_turn: None,
                warm_agent: None,
            };
            maybe_dispatch_when_idle(&mut state, &mut actions);
        }
    }

    (state, actions)
}
