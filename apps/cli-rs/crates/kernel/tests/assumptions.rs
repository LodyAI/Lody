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

#[test]
fn schedule_planner_enforces_dst_skip_misfire_overlap_and_single_capacity_deferral() {
    use lody_kernel::{
        KernelMisfirePolicy, KernelOverlapPolicy, KernelScheduleDestination, KernelScheduleTrigger,
        MisfireDisposition, PlannedSlotOutcome, ScheduleRetryInput, ScheduleRetryVerdict,
        SlotPlanningContext, decide_planned_slot_outcome, decide_schedule_retry,
        evaluate_schedule_slot, next_schedule_slot, parse_rfc3339_millis, schedule_run_ids,
        schedule_run_key,
    };

    let dst_cron = KernelScheduleTrigger::Cron {
        expression: "30 2 * * *".to_string(),
        time_zone: "America/New_York".to_string(),
    };
    let before_spring_forward = parse_rfc3339_millis("2026-03-08T06:00:00Z").expect("ts");
    let next_slot = next_schedule_slot(&dst_cron, before_spring_forward, before_spring_forward)
        .expect("cron eval")
        .expect("next slot");
    let expected_march_9 = parse_rfc3339_millis("2026-03-09T06:30:00Z").expect("march 9");
    assert_eq!(next_slot, expected_march_9);

    let dom_or_dow = KernelScheduleTrigger::Cron {
        expression: "0 9 15 * MON".to_string(),
        time_zone: "UTC".to_string(),
    };
    let start_sun = parse_rfc3339_millis("2026-03-08T00:00:00Z").expect("sun");
    let mon_march_9 = parse_rfc3339_millis("2026-03-09T09:00:00Z").expect("mon");
    assert_eq!(
        next_schedule_slot(&dom_or_dow, start_sun, start_sun).expect("eval"),
        Some(mon_march_9)
    );

    let interval = KernelScheduleTrigger::Interval {
        every_ms: 300_000,
        anchor_at: "2026-04-08T09:00:00Z".to_string(),
    };
    let anchor = parse_rfc3339_millis("2026-04-08T09:00:00Z").expect("anchor");
    let late_now = anchor + 300_000 + 180_000;
    let skip_eval = evaluate_schedule_slot(&interval, KernelMisfirePolicy::Skip, anchor, late_now)
        .expect("skip eval");
    assert_eq!(skip_eval.latest_slot_ms, Some(anchor + 300_000));
    assert_eq!(
        skip_eval.misfire_disposition,
        Some(MisfireDisposition::Skip)
    );
    assert_eq!(
        decide_planned_slot_outcome(SlotPlanningContext {
            misfire_disposition: MisfireDisposition::Skip,
            overlap_policy: KernelOverlapPolicy::QueueOne,
            has_unfinished_auto_run: false,
            has_capacity_deferred_run: false,
        }),
        PlannedSlotOutcome::RecordSkipped {
            error_code: "MISFIRE",
        }
    );

    assert_eq!(
        decide_planned_slot_outcome(SlotPlanningContext {
            misfire_disposition: MisfireDisposition::Run,
            overlap_policy: KernelOverlapPolicy::Skip,
            has_unfinished_auto_run: true,
            has_capacity_deferred_run: false,
        }),
        PlannedSlotOutcome::RecordSkipped {
            error_code: "OVERLAP",
        }
    );
    assert_eq!(
        decide_planned_slot_outcome(SlotPlanningContext {
            misfire_disposition: MisfireDisposition::Run,
            overlap_policy: KernelOverlapPolicy::QueueOne,
            has_unfinished_auto_run: true,
            has_capacity_deferred_run: false,
        }),
        PlannedSlotOutcome::EnqueuePending {
            supersede_pending_auto_runs: true,
        }
    );

    assert_eq!(
        decide_schedule_retry(ScheduleRetryInput {
            attempts: 1,
            max_attempts: 3,
            planned_at_ms: 1_000,
            dispatch_max_age_ms: 3_600_000,
            now_ms: 5_000,
            is_capacity_exhausted: true,
            capacity_reset_at_ms: Some(90_000),
            other_run_already_deferred_for_capacity: false,
        }),
        ScheduleRetryVerdict::DeferForCapacity {
            next_attempt_at_ms: 90_000,
        }
    );
    assert_eq!(
        decide_schedule_retry(ScheduleRetryInput {
            attempts: 1,
            max_attempts: 3,
            planned_at_ms: 1_000,
            dispatch_max_age_ms: 3_600_000,
            now_ms: 5_000,
            is_capacity_exhausted: true,
            capacity_reset_at_ms: Some(90_000),
            other_run_already_deferred_for_capacity: true,
        }),
        ScheduleRetryVerdict::SkipDuplicateCapacityDeferral
    );

    let key = schedule_run_key("sch_1", "act_1", anchor);
    let own_ids_a = schedule_run_ids(
        &key,
        "sch_1",
        &KernelScheduleDestination::OwnSession { epoch: 2 },
    );
    let own_ids_b = schedule_run_ids(
        &schedule_run_key("sch_1", "act_1", anchor + 300_000),
        "sch_1",
        &KernelScheduleDestination::OwnSession { epoch: 2 },
    );
    assert_eq!(own_ids_a.session_id, own_ids_b.session_id);
    assert_ne!(own_ids_a.user_turn_id, own_ids_b.user_turn_id);
}

#[test]
fn automation_and_pr_poller_rules_enforce_error_caps_stop_barrier_and_lane_fairness() {
    use lody_kernel::{
        AUTOMATION_MAX_CONSECUTIVE_ERRORS, ContinuationGateDecision, ManagedRunExitOutcome,
        ManagedRunSummaryInput, PollTargetCandidate, TargetSessionGate, TokenBucketConfig,
        TokenConsumeOutcome, WaitCheckInput, WaitTransitionDecision, decide_continuation_gate,
        decide_wait_transition, format_managed_run_summary, select_due_targets_fairly,
        try_consume_scope_token,
    };

    for prior in 0..(AUTOMATION_MAX_CONSECUTIVE_ERRORS - 1) {
        let decision = decide_wait_transition(
            10_000,
            5_000,
            None,
            prior,
            WaitCheckInput::CheckFailed {
                error_message: "boom".to_string(),
            },
        );
        assert!(matches!(
            decision,
            WaitTransitionDecision::RescheduleWaiting {
                consecutive_errors,
                ..
            } if consecutive_errors == prior + 1
        ));
    }
    let fifth_failure = decide_wait_transition(
        10_000,
        5_000,
        None,
        AUTOMATION_MAX_CONSECUTIVE_ERRORS - 1,
        WaitCheckInput::CheckFailed {
            error_message: "boom".to_string(),
        },
    );
    assert!(matches!(
        fifth_failure,
        WaitTransitionDecision::FinalizeFailed {
            consecutive_errors: 5,
            ..
        }
    ));

    assert_eq!(
        decide_continuation_gate(TargetSessionGate::CollaborationStopped, 0, 20_000),
        ContinuationGateDecision::Block {
            reason: "target_stopped",
        }
    );

    let interrupted = format_managed_run_summary(&ManagedRunSummaryInput {
        command: "cargo".to_string(),
        args: vec!["test".to_string()],
        cwd: Some("apps/cli-rs".to_string()),
        log_path: "/tmp/w1.log".to_string(),
        started_at_ms: Some(1_000),
        pid: Some(4242),
        ended_at_ms: 6_000,
        outcome: ManagedRunExitOutcome::Interrupted,
        exit_code: None,
        signal: None,
        error: None,
        tail: String::new(),
        log_truncated: false,
    });
    assert!(interrupted.resume_text.contains("did not run it again"));
    assert!(interrupted.resume_text.contains("(pid 4242)"));

    let candidates = vec![
        PollTargetCandidate {
            target_key: "repo_a#1".to_string(),
            repo_lane: "repo_a".to_string(),
            last_success_at_ms: Some(1_000),
            last_attempt_at_ms: None,
            interval_ms: 1_000,
            attempt_floor_ms: 500,
            repo_cooldown_until_ms: None,
        },
        PollTargetCandidate {
            target_key: "repo_a#2".to_string(),
            repo_lane: "repo_a".to_string(),
            last_success_at_ms: Some(1_100),
            last_attempt_at_ms: None,
            interval_ms: 1_000,
            attempt_floor_ms: 500,
            repo_cooldown_until_ms: None,
        },
        PollTargetCandidate {
            target_key: "repo_b#9".to_string(),
            repo_lane: "repo_b".to_string(),
            last_success_at_ms: Some(1_500),
            last_attempt_at_ms: None,
            interval_ms: 1_000,
            attempt_floor_ms: 500,
            repo_cooldown_until_ms: None,
        },
    ];
    assert_eq!(
        select_due_targets_fairly(&candidates, 5_000, 2),
        vec!["repo_a#1".to_string(), "repo_b#9".to_string()]
    );

    let cfg = TokenBucketConfig {
        capacity: 2.0,
        refill_per_sec: 1.0,
    };
    let TokenConsumeOutcome::Granted { next_state: s1 } =
        try_consume_scope_token(None, cfg, 2.0, 1_000)
    else {
        panic!("expected initial grant");
    };
    let TokenConsumeOutcome::Throttled { retry_at_ms, .. } =
        try_consume_scope_token(Some(&s1), cfg, 1.0, 1_200)
    else {
        panic!("expected throttle");
    };
    assert!(retry_at_ms >= 2_000);
}
