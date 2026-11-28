#![forbid(unsafe_code)]

pub mod automation;
pub mod inbox;
pub mod pr_poller;
pub mod schedule;
pub mod session;
pub mod turn;
pub mod types;

pub use automation::{
    AUTOMATION_ACTION_MAX_ATTEMPTS, AUTOMATION_BASE_ERROR_BACKOFF_MS,
    AUTOMATION_MAX_CONSECUTIVE_ERRORS, AUTOMATION_MAX_ERROR_BACKOFF_MS,
    AUTOMATION_RECONCILE_CAP_MS, ContinuationGateDecision, ManagedRunExitOutcome,
    ManagedRunFormattedResult, ManagedRunSummaryInput, TargetSessionGate, WaitCheckInput,
    WaitTransitionDecision, automation_identity, compute_automation_error_backoff_ms,
    decide_continuation_gate, decide_wait_transition, evaluate_capacity_observation,
    format_managed_run_summary, next_supervisor_wake_deadline_ms, parse_github_pr_url,
    pull_request_checkpoint_id, workflow_checkpoint_id,
};
pub use inbox::{InboxAdmitOutcome, InboxEntry, InboxState};
pub use pr_poller::{
    PR_POLLER_BASE_COOLDOWN_MS, PR_POLLER_DEFAULT_CAPACITY, PR_POLLER_DEFAULT_REFILL_PER_SEC,
    PR_POLLER_MAX_COOLDOWN_MS, PollTargetCandidate, RepoCooldownState, TokenBucketConfig,
    TokenBucketState, TokenConsumeOutcome, record_repo_failure, select_due_targets_fairly,
    target_due_at_ms, try_consume_scope_token,
};
pub use schedule::{
    DerivedScheduleRunIds, KernelMisfirePolicy, KernelOverlapPolicy, KernelScheduleDestination,
    KernelScheduleTrigger, MisfireDisposition, PlannedSlotOutcome, SCHEDULE_MAX_DATE_MS,
    SCHEDULE_MIN_INTERVAL_MS, SCHEDULE_MISFIRE_GRACE_MS, SCHEDULE_RETRY_DELAYS_MS,
    ScheduleRetryInput, ScheduleRetryVerdict, ScheduleSlotEvaluation, SlotPlanningContext,
    canonical_schedule_json, decide_planned_slot_outcome, decide_schedule_retry,
    evaluate_schedule_slot, latest_schedule_slot, manual_schedule_run_key, next_schedule_slot,
    parse_rfc3339_millis, schedule_digest, schedule_own_session_id, schedule_run_ids,
    schedule_run_key, schedule_uuid_v8, sha256_hex_bytes, validate_iana_time_zone,
    validate_trigger,
};
pub use session::{KernelAction, KernelEvent, SessionPhase, SessionState, step};
pub use turn::{
    BufferedTurnOutput, ChildDelegationState, ChildRejectReason, GoalControlState,
    PendingPermissionRequest, RunningTurnState, SteerFlightState,
};
pub use types::{
    DelegatedReceipt, FailureClassification, FrozenTurnInvocation, Generation,
    LATE_STREAM_ACTIVITY_TTL_MS, MAX_BATCHED_RECEIPTS_PER_WAKE, MAX_CHILD_DELEGATION_DEPTH,
    MAX_GOAL_CONTINUATION_TURNS, MAX_STALE_ACP_RETRIES_PER_TURN, NativeSessionActivity,
    PresencePublishReason, RetainedTurn, SteerOutcome, SubmissionFence, TurnSourceKind,
    TurnTerminalReason, WarmAgentHandle, classify_turn_failure,
};
