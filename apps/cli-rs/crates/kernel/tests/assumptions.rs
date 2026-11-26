use lody_kernel::{
    ChildRejectReason, DelegatedReceipt, FailureClassification, FrozenTurnInvocation, Generation,
    GoalControlState, InboxAdmitOutcome, KernelAction, KernelEvent, LATE_STREAM_ACTIVITY_TTL_MS,
    MAX_BATCHED_RECEIPTS_PER_WAKE, MAX_CHILD_DELEGATION_DEPTH, MAX_GOAL_CONTINUATION_TURNS,
    NativeSessionActivity, PresencePublishReason, SessionPhase, SessionState, SteerOutcome,
    TurnSourceKind, TurnTerminalReason, WarmAgentHandle, classify_turn_failure, step,
};

fn human_turn(id: &str, prompt: &str) -> FrozenTurnInvocation {
    FrozenTurnInvocation {
        turn_id: id.to_string(),
        requester_user_id: "u_1".to_string(),
        prompt_text: prompt.to_string(),
        source: TurnSourceKind::Human,
        adapter_id: "codex".to_string(),
        mcp_selection_digest: "mcp_v1".to_string(),
        signed_intent_verified: true,
    }
}

fn automation_turn(id: &str) -> FrozenTurnInvocation {
    FrozenTurnInvocation {
        turn_id: id.to_string(),
        requester_user_id: "u_1".to_string(),
        prompt_text: "auto".to_string(),
        source: TurnSourceKind::HostAutomation,
        adapter_id: "codex".to_string(),
        mcp_selection_digest: "mcp_v1".to_string(),
        signed_intent_verified: true,
    }
}

fn agent_handle(id: &str) -> WarmAgentHandle {
    WarmAgentHandle {
        agent_instance_id: id.to_string(),
        adapter_id: "codex".to_string(),
        mcp_selection_digest: "mcp_v1".to_string(),
        owner_user_id: "u_1".to_string(),
        advertises_session_activity: false,
    }
}

#[test]
fn assumed_bounds_cap_child_depth_goal_turns_receipt_batch_and_stale_retries() {
    let root = SessionState::new("s_root", false, 0);
    let (_, a_ok) = step(
        root,
        KernelEvent::RequestChildSessionCreate {
            child_session_id: "s_child".to_string(),
        },
    );
    assert_eq!(
        a_ok,
        vec![KernelAction::ChildSessionAdmitted {
            child_session_id: "s_child".to_string(),
            child_depth: MAX_CHILD_DELEGATION_DEPTH,
        }]
    );

    let child = SessionState::new("s_child", false, MAX_CHILD_DELEGATION_DEPTH);
    let (_, a_reject) = step(
        child,
        KernelEvent::RequestChildSessionCreate {
            child_session_id: "s_grandchild".to_string(),
        },
    );
    assert_eq!(
        a_reject,
        vec![KernelAction::ChildSessionRejected {
            child_session_id: "s_grandchild".to_string(),
            reason: ChildRejectReason::MaxDepthExceeded,
        }]
    );

    let mut goal = GoalControlState::new(
        "g1".to_string(),
        "continue".to_string(),
        "u_1".to_string(),
        "codex".to_string(),
        "mcp_v1".to_string(),
        999,
    );
    assert_eq!(goal.max_turns, MAX_GOAL_CONTINUATION_TURNS);
    for _ in 0..MAX_GOAL_CONTINUATION_TURNS {
        assert!(goal.next_continuation_invocation(false).is_some());
    }
    assert!(goal.next_continuation_invocation(false).is_none());

    let mut batch_state = SessionState::new("s_batch", false, 0);
    batch_state.default_requester_user_id = "u_1".to_string();
    for idx in 0..(MAX_BATCHED_RECEIPTS_PER_WAKE + 10) {
        batch_state.inbox.push_receipt(
            "s_batch",
            DelegatedReceipt {
                operation_id: format!("op_{idx}"),
                child_session_id: "c".to_string(),
                summary_preview: "done".to_string(),
                succeeded: true,
            },
        );
    }
    let claimed = batch_state
        .inbox
        .claim_next_for_execution("u_1", "codex", "mcp_v1", false)
        .expect("coalesced batch");
    assert_eq!(
        claimed.prompt_text.lines().count(),
        MAX_BATCHED_RECEIPTS_PER_WAKE
    );
    assert_eq!(batch_state.inbox.pending_receipts.len(), 10);

    let s0 = SessionState::new("s_retry", false, 0);
    let (s1, _) = step(
        s0,
        KernelEvent::SubmitInput {
            invocation: human_turn("t1", "hi"),
        },
    );
    let (s2, _) = step(
        s1,
        KernelEvent::AgentPrepared {
            generation: Generation(1),
            agent: agent_handle("a1"),
        },
    );
    let (s3, retry_actions) = step(
        s2,
        KernelEvent::AgentDisconnectedBeforeEvents {
            generation: Generation(1),
        },
    );
    assert!(retry_actions.iter().any(|a| matches!(
        a,
        KernelAction::PrepareNewAgent {
            generation: Generation(2),
            ..
        }
    )));
    let (s4, recovery_prepare_actions) = step(
        s3,
        KernelEvent::AgentPrepared {
            generation: Generation(2),
            agent: agent_handle("a2"),
        },
    );
    assert!(
        recovery_prepare_actions.contains(&KernelAction::PublishRunningPresence {
            reason: PresencePublishReason::StaleAcpRecovery,
        })
    );
    let (s5, second_disconnect_actions) = step(
        s4,
        KernelEvent::AgentDisconnectedBeforeEvents {
            generation: Generation(2),
        },
    );
    assert!(matches!(s5.phase, SessionPhase::Settling { .. }));
    assert!(
        !second_disconnect_actions
            .iter()
            .any(|a| matches!(a, KernelAction::PrepareNewAgent { .. }))
    );
}

#[test]
fn mutual_exclusion_pause_blocks_pre_queued_turns_and_automation_yields_to_human() {
    let s0 = SessionState::new("s_pause", false, 0);
    let (s1, _) = step(
        s0,
        KernelEvent::SubmitInput {
            invocation: human_turn("t1", "first"),
        },
    );
    let (s2, _) = step(
        s1,
        KernelEvent::AgentPrepared {
            generation: Generation(1),
            agent: agent_handle("a1"),
        },
    );
    let (s3, _) = step(
        s2,
        KernelEvent::SubmitInput {
            invocation: human_turn("t2_queued", "second"),
        },
    );
    let (s4, _) = step(s3, KernelEvent::CancelRequested { pause_inbox: true });
    let (s5, post_cancel_actions) = step(
        s4,
        KernelEvent::SettlingCompleted {
            generation: Generation(1),
        },
    );
    assert!(s5.inbox.paused);
    assert!(matches!(s5.phase, SessionPhase::Idle { .. }));
    assert!(!post_cancel_actions.iter().any(|a| matches!(
        a,
        KernelAction::PrepareNewAgent { .. } | KernelAction::ReuseWarmAgent { .. }
    )));

    let (s6, auto_while_paused_actions) = step(
        s5,
        KernelEvent::SubmitInput {
            invocation: automation_turn("t_auto"),
        },
    );
    assert!(s6.inbox.paused);
    assert!(auto_while_paused_actions.is_empty());

    let (s7, unpause_actions) = step(
        s6,
        KernelEvent::SubmitInput {
            invocation: human_turn("t3_fresh", "unpause"),
        },
    );
    assert!(!s7.inbox.paused);
    assert!(unpause_actions.iter().any(|a| matches!(
        a,
        KernelAction::ReuseWarmAgent { turn_id, .. } if turn_id == "t2_queued"
    )));
}

#[test]
fn mutual_exclusion_post_fence_uncertainty_barrier_and_unsigned_encrypted_inputs_never_execute() {
    let enc = SessionState::new("s_enc", true, 0);
    let mut unsigned = human_turn("t_unsigned", "spoof");
    unsigned.signed_intent_verified = false;
    let (enc_after, enc_actions) = step(
        enc,
        KernelEvent::SubmitInput {
            invocation: unsigned,
        },
    );
    assert!(matches!(enc_after.phase, SessionPhase::Idle { .. }));
    assert_eq!(
        enc_actions,
        vec![KernelAction::InputRejected {
            turn_id: "t_unsigned".to_string(),
            outcome: InboxAdmitOutcome::RejectedUnsignedEncryptedInput,
        }]
    );

    let s0 = SessionState::new("s_fence", false, 0);
    let (s1, _) = step(
        s0,
        KernelEvent::SubmitInput {
            invocation: human_turn("t_inflight", "run"),
        },
    );
    let (s2, _) = step(
        s1,
        KernelEvent::SubmitInput {
            invocation: human_turn("t_prepared", "wait"),
        },
    );
    let (s3, crash_actions) = step(s2, KernelEvent::RecoverAfterCrash);
    assert!(crash_actions.contains(&KernelAction::FinalizeTurn {
        turn_id: "t_inflight".to_string(),
        reason: TurnTerminalReason::StartupInterruptedUnknown,
    }));
    let (_, re_admit_actions) = step(
        s3.clone(),
        KernelEvent::SubmitInput {
            invocation: human_turn("t_inflight", "run"),
        },
    );
    assert_eq!(
        re_admit_actions,
        vec![KernelAction::InputRejected {
            turn_id: "t_inflight".to_string(),
            outcome: InboxAdmitOutcome::RejectedRetiredId,
        }]
    );
    assert!(matches!(
        &s3.phase,
        SessionPhase::Preparing { invocation, .. } if invocation.turn_id == "t_prepared"
    ));

    let (s4, _) = step(
        s3,
        KernelEvent::AgentPrepared {
            generation: Generation(2),
            agent: agent_handle("a1"),
        },
    );
    let (s5, _) = step(
        s4,
        KernelEvent::RequestSteer {
            invocation: human_turn("t_steer_uncertain", "steer"),
        },
    );
    let (s6, _) = step(
        s5,
        KernelEvent::SteerVerdictReceived {
            generation: Generation(2),
            outcome: SteerOutcome::Unknown,
        },
    );
    assert!(s6.inbox.retired_turn_ids.contains("t_steer_uncertain"));
    assert!(
        s6.inbox
            .entries
            .iter()
            .all(|e| e.invocation.turn_id != "t_steer_uncertain")
    );

    let (s7, _) = step(
        s6,
        KernelEvent::BeginEditAndResend {
            target_turn_id: "t_prepared".to_string(),
            replacement_invocation: human_turn("t_edited", "edited"),
        },
    );
    let (s8, barrier_submit_actions) = step(
        s7,
        KernelEvent::SubmitInput {
            invocation: human_turn("t_during_barrier", "later"),
        },
    );
    assert!(barrier_submit_actions.is_empty());
    let (_, barrier_steer_actions) = step(
        s8.clone(),
        KernelEvent::RequestSteer {
            invocation: human_turn("t_bad_steer", "nope"),
        },
    );
    assert!(matches!(
        barrier_steer_actions.as_slice(),
        [KernelAction::SteerRejected { .. }]
    ));
    let (s9, commit_actions) = step(s8, KernelEvent::EditAndResendCommitted);
    assert!(matches!(
        &s9.phase,
        SessionPhase::Preparing { invocation, .. } if invocation.turn_id == "t_edited"
    ));
    assert_eq!(s9.inbox.entries.len(), 2);
    assert!(!commit_actions.is_empty());
}

#[test]
fn network_independent_history_gate_and_stuck_settling_never_block_local_progress() {
    let s0 = SessionState::new("s_offline", false, 0);
    let (s1, _) = step(
        s0,
        KernelEvent::SubmitInput {
            invocation: human_turn("t1", "offline work"),
        },
    );
    let (s2, _) = step(
        s1,
        KernelEvent::AgentPrepared {
            generation: Generation(1),
            agent: agent_handle("a1"),
        },
    );
    let (s3, pre_durable_actions) = step(
        s2,
        KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "part-1".to_string(),
            observed_at_ms: 100,
        },
    );
    assert!(pre_durable_actions.is_empty());

    let (s4, durable_flush_actions) = step(
        s3,
        KernelEvent::UserTurnBecameDurable {
            turn_id: "t1".to_string(),
        },
    );
    assert_eq!(
        durable_flush_actions,
        vec![KernelAction::AppendAssistantOutput {
            turn_id: "t1".to_string(),
            text: "part-1".to_string(),
        }]
    );

    let (s5, _) = step(
        s4,
        KernelEvent::SubmitInput {
            invocation: human_turn("t2", "next offline work"),
        },
    );
    let (s6, _) = step(
        s5,
        KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        },
    );
    let (s7, timeout_actions) = step(
        s6,
        KernelEvent::SettlingTimedOut {
            generation: Generation(1),
        },
    );
    assert!(
        timeout_actions.contains(&KernelAction::DetachAgentBackgroundCleanup {
            agent_instance_id: "a1".to_string(),
        })
    );
    assert!(matches!(
        &s7.phase,
        SessionPhase::Preparing { invocation, .. } if invocation.turn_id == "t2"
    ));
}

#[test]
fn late_stream_lease_expires_at_ttl_wakes_blocked_automation_and_silent_turn_ignores_banner_text() {
    assert_eq!(
        classify_turn_failure(
            Some("agent_no_output"),
            Some("Agent produced no output before context window check")
        ),
        FailureClassification::SilentNoOutput
    );
    assert_eq!(
        classify_turn_failure(Some("model_error"), Some("Prompt is too long for model")),
        FailureClassification::ContextOverflow
    );

    let mut s = SessionState::new("s_late", false, 0);
    s.durable_user_turn_ids.insert("t1".to_string());
    let (s, _) = step(
        s,
        KernelEvent::SubmitInput {
            invocation: human_turn("t1", "hello"),
        },
    );
    let (s, _) = step(
        s,
        KernelEvent::AgentPrepared {
            generation: Generation(1),
            agent: agent_handle("a1"),
        },
    );
    let (s, _) = step(
        s,
        KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "initial".to_string(),
            observed_at_ms: 1_000,
        },
    );
    let (s, _) = step(
        s,
        KernelEvent::AgentPromptFinished {
            generation: Generation(1),
        },
    );
    let (s, _) = step(
        s,
        KernelEvent::SettlingCompleted {
            generation: Generation(1),
        },
    );
    assert!(!s.is_gc_protected(1_500));

    let (s, late_actions) = step(
        s,
        KernelEvent::AgentOutputChunk {
            generation: Generation(1),
            text: "post-end-turn chunk".to_string(),
            observed_at_ms: 2_000,
        },
    );
    assert!(
        late_actions.contains(&KernelAction::PublishRunningPresence {
            reason: PresencePublishReason::LateStreamActivity,
        })
    );
    assert!(s.is_gc_protected(2_000 + LATE_STREAM_ACTIVITY_TTL_MS - 1));

    let (s, queued_auto_actions) = step(
        s,
        KernelEvent::SubmitInput {
            invocation: automation_turn("t_auto_blocked"),
        },
    );
    assert!(queued_auto_actions.is_empty());

    let (s, wake_actions) = step(
        s,
        KernelEvent::AdvanceClock {
            now_ms: 2_000 + LATE_STREAM_ACTIVITY_TTL_MS,
        },
    );
    assert!(wake_actions.contains(&KernelAction::ClearRunningPresence));
    assert!(wake_actions.iter().any(|a| matches!(
        a,
        KernelAction::ReuseWarmAgent { turn_id, .. } if turn_id == "t_auto_blocked"
    )));
    assert!(s.is_gc_protected(2_000 + LATE_STREAM_ACTIVITY_TTL_MS));

    let (s_reconciled, ended_actions) = step(
        SessionState::new("s_ended", false, 0),
        KernelEvent::ReconcileEndedInboxClaim {
            turn_id: "t_orphaned_claim".to_string(),
        },
    );
    assert!(ended_actions.contains(&KernelAction::FinalizeTurn {
        turn_id: "t_orphaned_claim".to_string(),
        reason: TurnTerminalReason::StartupInterruptedUnknown,
    }));
    let (_, retry_orphaned) = step(
        s_reconciled,
        KernelEvent::SubmitInput {
            invocation: human_turn("t_orphaned_claim", "replay"),
        },
    );
    assert_eq!(
        retry_orphaned,
        vec![KernelAction::InputRejected {
            turn_id: "t_orphaned_claim".to_string(),
            outcome: InboxAdmitOutcome::RejectedRetiredId,
        }]
    );
    let _ = NativeSessionActivity::Idle;
}
