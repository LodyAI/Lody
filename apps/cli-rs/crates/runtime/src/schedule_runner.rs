#![forbid(unsafe_code)]

use crate::{DaemonRuntime, ignore_unwired};
use lody_app::{HistoryTurnRecord, PortErrorKind, PortResult, SessionId, TurnId, WorkspaceId};
use lody_kernel::{
    KernelMisfirePolicy, KernelOverlapPolicy, KernelScheduleDestination, KernelScheduleTrigger,
    PlannedSlotOutcome, ScheduleRetryInput, ScheduleRetryVerdict, SlotPlanningContext,
    decide_planned_slot_outcome, decide_schedule_retry, evaluate_schedule_slot, schedule_run_ids,
    schedule_run_key,
};
use lody_ports::{
    InboxCategory, ScheduleCursorRecord, ScheduleDestination, ScheduleLedgerRunRecord,
    ScheduleMisfirePolicy, ScheduleOverlapPolicy, ScheduleRecord, ScheduleRunState,
    StorageLeaseMode, WorkspaceSecurityMode,
};
use serde_json::{Value, json};

const DISPATCHED_RECONCILE_INTERVAL_MS: i64 = 5_000;
const AUTH_RETRY_DELAY_MS: i64 = 15_000;

fn map_misfire(policy: ScheduleMisfirePolicy) -> KernelMisfirePolicy {
    match policy {
        ScheduleMisfirePolicy::Skip => KernelMisfirePolicy::Skip,
        ScheduleMisfirePolicy::RunOnce => KernelMisfirePolicy::RunOnce,
    }
}

fn map_overlap(policy: ScheduleOverlapPolicy) -> KernelOverlapPolicy {
    match policy {
        ScheduleOverlapPolicy::Skip => KernelOverlapPolicy::Skip,
        ScheduleOverlapPolicy::QueueOne => KernelOverlapPolicy::QueueOne,
    }
}

fn map_destination(dest: &ScheduleDestination) -> KernelScheduleDestination {
    match dest {
        ScheduleDestination::NewSession => KernelScheduleDestination::NewSession,
        ScheduleDestination::OwnSession { epoch } => {
            KernelScheduleDestination::OwnSession { epoch: *epoch }
        }
        ScheduleDestination::ExistingSession { session_id } => {
            KernelScheduleDestination::ExistingSession {
                session_id: session_id.0.clone(),
            }
        }
    }
}

fn schedule_matches_record(a: &ScheduleRecord, b: &ScheduleRecord) -> bool {
    a.enabled
        && b.enabled
        && a.machine_id == b.machine_id
        && a.author_user_id == b.author_user_id
        && a.activation_id == b.activation_id
        && a.definition_fingerprint == b.definition_fingerprint
}

fn is_manual_run(payload: &Value) -> bool {
    payload
        .get("manual")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn is_capacity_deferred(run: &ScheduleLedgerRunRecord, payload: &Value) -> bool {
    run.state == ScheduleRunState::RetryWait
        && payload.get("errorCode").and_then(Value::as_str) == Some("CAPACITY_EXHAUSTED")
}

fn resolve_run_target_ids(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    run: &ScheduleLedgerRunRecord,
    payload: &Value,
) -> Option<(SessionId, TurnId)> {
    if let (Some(sid), Some(tid)) = (
        payload
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty()),
        payload
            .get("userTurnId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty()),
    ) {
        return Some((SessionId(sid.to_string()), TurnId(tid.to_string())));
    }
    let sched = runtime
        .deps
        .schedule_repo
        .get_schedule(workspace_id, &run.schedule_id)
        .ok()
        .flatten()?;
    let dest = sched
        .session_id
        .as_ref()
        .map(|sid| KernelScheduleDestination::ExistingSession {
            session_id: sid.0.clone(),
        })
        .unwrap_or_else(|| map_destination(&sched.destination));
    let ids = schedule_run_ids(&run.run_key, &sched.schedule_id, &dest);
    Some((SessionId(ids.session_id), TurnId(ids.user_turn_id)))
}

fn is_scheduled_turn_settled(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    session_id: &SessionId,
    turn_id: &TurnId,
) -> PortResult<bool> {
    if runtime
        .deps
        .inbox
        .is_input_ended(workspace_id, session_id, turn_id)?
    {
        return Ok(true);
    }
    if let Ok(turns) = runtime
        .deps
        .history
        .read_session_turns(workspace_id, session_id)
        && turns
            .iter()
            .any(|t| &t.turn_id == turn_id && t.outcome.is_some())
    {
        return Ok(true);
    }
    Ok(false)
}

fn reconcile_dispatched_and_in_flight_runs(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    now_ms: i64,
    record_wake: &mut impl FnMut(Option<i64>),
) -> PortResult<bool> {
    let initial = match runtime.deps.schedule_ledger.unfinished_runs(workspace_id) {
        Ok(rows) => rows,
        Err(err) if err.kind == PortErrorKind::Unavailable => return Ok(false),
        Err(err) => return Err(err),
    };

    for run in &initial {
        let mut payload: Value =
            serde_json::from_str(&run.payload_json).unwrap_or_else(|_| json!({}));
        match run.state {
            ScheduleRunState::Claimed | ScheduleRunState::SessionPrepared => {
                if let Some((sid, tid)) =
                    resolve_run_target_ids(runtime, workspace_id, run, &payload)
                {
                    let settled = is_scheduled_turn_settled(runtime, workspace_id, &sid, &tid)?;
                    let durable = runtime
                        .deps
                        .history
                        .is_user_turn_durable(workspace_id, &sid, &tid)
                        .unwrap_or(false);
                    if settled || durable {
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::Claimed, ScheduleRunState::SessionPrepared],
                            ScheduleRunState::Dispatched,
                            &mut payload,
                            None,
                            now_ms,
                        )?;
                        if settled {
                            mark_run_state(
                                runtime,
                                &run.run_key,
                                &[ScheduleRunState::Dispatched],
                                ScheduleRunState::Finished,
                                &mut payload,
                                None,
                                now_ms,
                            )?;
                        } else {
                            record_wake(Some(
                                now_ms.saturating_add(DISPATCHED_RECONCILE_INTERVAL_MS),
                            ));
                        }
                    }
                }
            }
            ScheduleRunState::Dispatched => {
                if let Some((sid, tid)) =
                    resolve_run_target_ids(runtime, workspace_id, run, &payload)
                {
                    if is_scheduled_turn_settled(runtime, workspace_id, &sid, &tid)? {
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::Dispatched],
                            ScheduleRunState::Finished,
                            &mut payload,
                            None,
                            now_ms,
                        )?;
                    } else {
                        record_wake(Some(
                            now_ms.saturating_add(DISPATCHED_RECONCILE_INTERVAL_MS),
                        ));
                    }
                } else {
                    record_wake(Some(
                        now_ms.saturating_add(DISPATCHED_RECONCILE_INTERVAL_MS),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(true)
}

pub async fn tick_workspace_schedules(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    now_ms: i64,
) -> PortResult<Option<i64>> {
    if runtime.deps.storage_lease_mode != StorageLeaseMode::OnlineHost {
        return Ok(None);
    }

    let mut earliest_wake: Option<i64> = None;
    let mut record_wake = |candidate: Option<i64>| {
        if let Some(ts) = candidate {
            earliest_wake = Some(match earliest_wake {
                Some(cur) => cur.min(ts),
                None => ts,
            });
        }
    };

    if !reconcile_dispatched_and_in_flight_runs(runtime, workspace_id, now_ms, &mut record_wake)? {
        return Ok(None);
    }

    let schedules = match runtime
        .deps
        .schedule_repo
        .list_schedules(workspace_id, None, 1_000, 0)
    {
        Ok(list) => list,
        Err(err) if err.kind == PortErrorKind::Unavailable => return Ok(earliest_wake),
        Err(err) => return Err(err),
    };

    let unfinished = match runtime.deps.schedule_ledger.unfinished_runs(workspace_id) {
        Ok(rows) => rows,
        Err(err) if err.kind == PortErrorKind::Unavailable => return Ok(earliest_wake),
        Err(err) => return Err(err),
    };

    for schedule in &schedules {
        if !schedule.enabled || schedule.machine_id != runtime.deps.machine_id {
            continue;
        }
        let Ok(trigger) = serde_json::from_value::<KernelScheduleTrigger>(schedule.rule.clone())
        else {
            continue;
        };
        let cursor = runtime.deps.schedule_ledger.read_planning_cursor(
            workspace_id,
            &schedule.schedule_id,
            &schedule.activation_id,
        )?;
        let Ok(eval) = evaluate_schedule_slot(
            &trigger,
            map_misfire(schedule.misfire_policy),
            schedule.active_from,
            now_ms,
        ) else {
            continue;
        };
        record_wake(eval.next_slot_ms);

        let prior_last_slot = cursor.as_ref().and_then(|c| c.last_slot);
        let new_due_slot = eval
            .latest_slot_ms
            .filter(|slot| prior_last_slot.is_none_or(|last| *slot > last));

        if let Some(slot_ms) = new_due_slot {
            let mut has_unfinished_auto = false;
            let mut has_capacity_deferred = false;
            let mut pending_auto_runs = Vec::new();
            for existing in unfinished
                .iter()
                .filter(|r| r.schedule_id == schedule.schedule_id)
            {
                let payload: Value =
                    serde_json::from_str(&existing.payload_json).unwrap_or_else(|_| json!({}));
                if !is_manual_run(&payload) {
                    has_unfinished_auto = true;
                    if is_capacity_deferred(existing, &payload) {
                        has_capacity_deferred = true;
                    }
                    if existing.state == ScheduleRunState::Pending {
                        pending_auto_runs.push((existing.run_key.clone(), payload));
                    }
                }
            }

            let disposition = eval
                .misfire_disposition
                .unwrap_or(lody_kernel::MisfireDisposition::Run);
            let outcome = decide_planned_slot_outcome(SlotPlanningContext {
                misfire_disposition: disposition,
                overlap_policy: map_overlap(schedule.overlap_policy),
                has_unfinished_auto_run: has_unfinished_auto,
                has_capacity_deferred_run: has_capacity_deferred,
            });

            if matches!(
                outcome,
                PlannedSlotOutcome::EnqueuePending {
                    supersede_pending_auto_runs: true
                }
            ) {
                for (old_key, mut old_payload) in pending_auto_runs {
                    if let Some(obj) = old_payload.as_object_mut() {
                        obj.insert("state".to_string(), Value::String("skipped".to_string()));
                        obj.insert(
                            "errorCode".to_string(),
                            Value::String("SUPERSEDED".to_string()),
                        );
                        obj.insert("updatedAt".to_string(), json!(now_ms));
                    }
                    let _ = runtime.deps.schedule_ledger.transition_run(
                        &old_key,
                        &[ScheduleRunState::Pending],
                        ScheduleRunState::Skipped,
                        &old_payload.to_string(),
                    );
                }
            }

            let run_key = schedule_run_key(&schedule.schedule_id, &schedule.activation_id, slot_ms);
            let (initial_state, err_code) = match outcome {
                PlannedSlotOutcome::EnqueuePending { .. } => (ScheduleRunState::Pending, None),
                PlannedSlotOutcome::RecordSkipped { error_code } => {
                    (ScheduleRunState::Skipped, Some(error_code))
                }
            };
            let run_payload = json!({
                "runKey": run_key,
                "scheduleId": schedule.schedule_id,
                "activationId": schedule.activation_id,
                "definitionFingerprint": schedule.definition_fingerprint,
                "scheduledFor": slot_ms,
                "plannedAt": now_ms,
                "updatedAt": now_ms,
                "state": initial_state.as_wire_str(),
                "attempts": 0,
                "nextAttemptAt": now_ms,
                "manual": false,
                "errorCode": err_code,
            });
            let new_cursor = ScheduleCursorRecord {
                workspace_id: workspace_id.clone(),
                schedule_id: schedule.schedule_id.clone(),
                activation_id: schedule.activation_id.clone(),
                fingerprint: schedule.definition_fingerprint.clone(),
                last_slot: Some(slot_ms),
                next_slot: eval.next_slot_ms,
                updated_at: now_ms,
            };
            let run_rec = ScheduleLedgerRunRecord {
                run_key,
                workspace_id: workspace_id.clone(),
                schedule_id: schedule.schedule_id.clone(),
                state: initial_state,
                planned_at: now_ms,
                payload_json: run_payload.to_string(),
            };
            let _ = runtime
                .deps
                .schedule_ledger
                .commit_planned_slot(&new_cursor, Some(&run_rec));
        } else if cursor
            .as_ref()
            .is_none_or(|c| c.next_slot != eval.next_slot_ms)
        {
            let new_cursor = ScheduleCursorRecord {
                workspace_id: workspace_id.clone(),
                schedule_id: schedule.schedule_id.clone(),
                activation_id: schedule.activation_id.clone(),
                fingerprint: schedule.definition_fingerprint.clone(),
                last_slot: prior_last_slot,
                next_slot: eval.next_slot_ms,
                updated_at: now_ms,
            };
            let _ = runtime
                .deps
                .schedule_ledger
                .commit_planned_slot(&new_cursor, None);
        }
    }

    let pre_dispatch_states = [
        ScheduleRunState::Pending,
        ScheduleRunState::RetryWait,
        ScheduleRunState::Claimed,
        ScheduleRunState::SessionPrepared,
    ];
    let active_runs = runtime.deps.schedule_ledger.unfinished_runs(workspace_id)?;
    for run in &active_runs {
        if !pre_dispatch_states.contains(&run.state) {
            continue;
        }
        let mut payload: Value =
            serde_json::from_str(&run.payload_json).unwrap_or_else(|_| json!({}));
        if matches!(
            run.state,
            ScheduleRunState::Pending | ScheduleRunState::RetryWait
        ) {
            let next_attempt_at = payload
                .get("nextAttemptAt")
                .and_then(Value::as_i64)
                .unwrap_or(run.planned_at);
            if next_attempt_at > now_ms {
                record_wake(Some(next_attempt_at));
                continue;
            }
        }

        let live_schedule = runtime
            .deps
            .schedule_repo
            .get_schedule(workspace_id, &run.schedule_id)?;
        let expected_act = payload
            .get("activationId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let expected_fp = payload
            .get("definitionFingerprint")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(schedule) = live_schedule.filter(|s| {
            s.enabled
                && s.machine_id == runtime.deps.machine_id
                && s.activation_id == expected_act
                && s.definition_fingerprint == expected_fp
        }) else {
            mark_run_state(
                runtime,
                &run.run_key,
                &pre_dispatch_states,
                ScheduleRunState::Skipped,
                &mut payload,
                Some("DEFINITION_CHANGED_OR_DISABLED"),
                now_ms,
            )?;
            continue;
        };

        if now_ms.saturating_sub(run.planned_at) >= schedule.retry_policy.dispatch_max_age_ms {
            mark_run_state(
                runtime,
                &run.run_key,
                &pre_dispatch_states,
                ScheduleRunState::Skipped,
                &mut payload,
                Some("DISPATCH_EXPIRED"),
                now_ms,
            )?;
            continue;
        }

        if payload.get("message").is_some()
            && runtime
                .deps
                .schedule_ledger
                .has_consumed_complete_message(workspace_id, &schedule.schedule_id)?
        {
            mark_run_state(
                runtime,
                &run.run_key,
                &pre_dispatch_states,
                ScheduleRunState::Skipped,
                &mut payload,
                Some("MESSAGE_ALREADY_CONSUMED"),
                now_ms,
            )?;
            continue;
        }

        let ws_mode = match runtime.resolve_workspace_mode(workspace_id) {
            Ok(WorkspaceSecurityMode::Unknown) | Err(_) => {
                let retry_at = now_ms.saturating_add(AUTH_RETRY_DELAY_MS);
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("nextAttemptAt".to_string(), json!(retry_at));
                }
                record_wake(Some(retry_at));
                mark_run_state(
                    runtime,
                    &run.run_key,
                    &pre_dispatch_states,
                    ScheduleRunState::RetryWait,
                    &mut payload,
                    Some("AUTH_UNAVAILABLE"),
                    now_ms,
                )?;
                continue;
            }
            Ok(mode) => mode,
        };
        if matches!(ws_mode, WorkspaceSecurityMode::Encrypted { .. }) {
            match runtime.deps.engine.verify_schedule_authorization(
                workspace_id,
                &schedule.schedule_id,
                &schedule.definition_fingerprint,
            ) {
                Ok(true) => {}
                Ok(false) => {
                    mark_run_state(
                        runtime,
                        &run.run_key,
                        &pre_dispatch_states,
                        ScheduleRunState::Skipped,
                        &mut payload,
                        Some("AUTHORIZATION_INVALID"),
                        now_ms,
                    )?;
                    continue;
                }
                Err(_) => {
                    let retry_at = now_ms.saturating_add(AUTH_RETRY_DELAY_MS);
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("nextAttemptAt".to_string(), json!(retry_at));
                    }
                    record_wake(Some(retry_at));
                    mark_run_state(
                        runtime,
                        &run.run_key,
                        &pre_dispatch_states,
                        ScheduleRunState::RetryWait,
                        &mut payload,
                        Some("AUTH_UNAVAILABLE"),
                        now_ms,
                    )?;
                    continue;
                }
            }
        }

        let dest = schedule
            .session_id
            .as_ref()
            .map(|sid| KernelScheduleDestination::ExistingSession {
                session_id: sid.0.clone(),
            })
            .unwrap_or_else(|| map_destination(&schedule.destination));
        let ids = schedule_run_ids(&run.run_key, &schedule.schedule_id, &dest);
        let target_session_id = SessionId(ids.session_id);
        let turn_id = TurnId(ids.user_turn_id);

        let prior_attempts = payload.get("attempts").and_then(Value::as_u64).unwrap_or(0) as u32;
        let attempts = if matches!(
            run.state,
            ScheduleRunState::Pending | ScheduleRunState::RetryWait
        ) {
            prior_attempts.saturating_add(1)
        } else {
            prior_attempts.max(1)
        };

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("attempts".to_string(), json!(attempts));
            obj.insert(
                "sessionId".to_string(),
                Value::String(target_session_id.0.clone()),
            );
            obj.insert("userTurnId".to_string(), Value::String(turn_id.0.clone()));
        }

        if run.state != ScheduleRunState::SessionPrepared {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert(
                    "state".to_string(),
                    Value::String(ScheduleRunState::Claimed.as_wire_str().to_string()),
                );
                obj.insert("updatedAt".to_string(), json!(now_ms));
            }
            if runtime
                .deps
                .schedule_ledger
                .transition_run(
                    &run.run_key,
                    &[
                        ScheduleRunState::Pending,
                        ScheduleRunState::RetryWait,
                        ScheduleRunState::Claimed,
                    ],
                    ScheduleRunState::Claimed,
                    &payload.to_string(),
                )
                .is_err()
            {
                continue;
            }
        }

        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "state".to_string(),
                Value::String(ScheduleRunState::SessionPrepared.as_wire_str().to_string()),
            );
            obj.insert("updatedAt".to_string(), json!(now_ms));
        }
        if runtime
            .deps
            .schedule_ledger
            .transition_run(
                &run.run_key,
                &[ScheduleRunState::Claimed, ScheduleRunState::SessionPrepared],
                ScheduleRunState::SessionPrepared,
                &payload.to_string(),
            )
            .is_err()
        {
            continue;
        }

        let recheck = runtime
            .deps
            .schedule_repo
            .get_schedule(workspace_id, &run.schedule_id)?;
        if !recheck.is_some_and(|latest| schedule_matches_record(&schedule, &latest)) {
            mark_run_state(
                runtime,
                &run.run_key,
                &[ScheduleRunState::SessionPrepared],
                ScheduleRunState::Skipped,
                &mut payload,
                Some("DEFINITION_CHANGED_AFTER_PREPARE"),
                now_ms,
            )?;
            continue;
        }

        let dispatch_res = dispatch_scheduled_turn(
            runtime,
            workspace_id,
            &schedule,
            &target_session_id,
            &turn_id,
        )
        .await;

        match dispatch_res {
            Ok(()) => {
                mark_run_state(
                    runtime,
                    &run.run_key,
                    &[ScheduleRunState::SessionPrepared],
                    ScheduleRunState::Dispatched,
                    &mut payload,
                    None,
                    now_ms,
                )?;
                record_wake(Some(
                    now_ms.saturating_add(DISPATCHED_RECONCILE_INTERVAL_MS),
                ));
            }
            Err(err) => {
                if err.message.contains("E2EE_MACHINE_SIGNING_UNAVAILABLE") {
                    let retry_at = now_ms.saturating_add(AUTH_RETRY_DELAY_MS);
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("nextAttemptAt".to_string(), json!(retry_at));
                    }
                    record_wake(Some(retry_at));
                    mark_run_state(
                        runtime,
                        &run.run_key,
                        &[ScheduleRunState::SessionPrepared],
                        ScheduleRunState::RetryWait,
                        &mut payload,
                        Some("E2EE_MACHINE_SIGNING_UNAVAILABLE"),
                        now_ms,
                    )?;
                    continue;
                }
                let is_cap = err.message.contains("CAPACITY_EXHAUSTED");
                let other_cap = active_runs.iter().any(|other| {
                    other.run_key != run.run_key
                        && other.schedule_id == run.schedule_id
                        && serde_json::from_str::<Value>(&other.payload_json)
                            .ok()
                            .is_some_and(|p| is_capacity_deferred(other, &p))
                });
                let verdict = decide_schedule_retry(ScheduleRetryInput {
                    attempts,
                    max_attempts: schedule.retry_policy.max_attempts,
                    planned_at_ms: run.planned_at,
                    dispatch_max_age_ms: schedule.retry_policy.dispatch_max_age_ms,
                    now_ms,
                    is_capacity_exhausted: is_cap,
                    capacity_reset_at_ms: None,
                    other_run_already_deferred_for_capacity: other_cap,
                });
                match verdict {
                    ScheduleRetryVerdict::ExpireDispatch => {
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::SessionPrepared],
                            ScheduleRunState::Skipped,
                            &mut payload,
                            Some("DISPATCH_EXPIRED"),
                            now_ms,
                        )?;
                    }
                    ScheduleRetryVerdict::SkipDuplicateCapacityDeferral => {
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::SessionPrepared],
                            ScheduleRunState::Skipped,
                            &mut payload,
                            Some("CAPACITY_DEFERRED"),
                            now_ms,
                        )?;
                    }
                    ScheduleRetryVerdict::DeferForCapacity { next_attempt_at_ms } => {
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("nextAttemptAt".to_string(), json!(next_attempt_at_ms));
                        }
                        record_wake(Some(next_attempt_at_ms));
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::SessionPrepared],
                            ScheduleRunState::RetryWait,
                            &mut payload,
                            Some("CAPACITY_EXHAUSTED"),
                            now_ms,
                        )?;
                    }
                    ScheduleRetryVerdict::RetryAfter { next_attempt_at_ms } => {
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("nextAttemptAt".to_string(), json!(next_attempt_at_ms));
                        }
                        record_wake(Some(next_attempt_at_ms));
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::SessionPrepared],
                            ScheduleRunState::RetryWait,
                            &mut payload,
                            Some(&err.message),
                            now_ms,
                        )?;
                    }
                    ScheduleRetryVerdict::FailPermanent => {
                        mark_run_state(
                            runtime,
                            &run.run_key,
                            &[ScheduleRunState::SessionPrepared],
                            ScheduleRunState::Failed,
                            &mut payload,
                            Some(&err.message),
                            now_ms,
                        )?;
                    }
                }
            }
        }
    }

    Ok(earliest_wake)
}

fn mark_run_state(
    runtime: &DaemonRuntime,
    run_key: &str,
    allowed_from: &[ScheduleRunState],
    next_state: ScheduleRunState,
    payload: &mut Value,
    error_code: Option<&str>,
    now_ms: i64,
) -> PortResult<()> {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "state".to_string(),
            Value::String(next_state.as_wire_str().to_string()),
        );
        obj.insert("updatedAt".to_string(), json!(now_ms));
        match error_code {
            Some(code) => {
                obj.insert("errorCode".to_string(), Value::String(code.to_string()));
            }
            None => {
                obj.remove("errorCode");
            }
        }
    }
    let _ = runtime.deps.schedule_ledger.transition_run(
        run_key,
        allowed_from,
        next_state,
        &payload.to_string(),
    );
    Ok(())
}

async fn dispatch_scheduled_turn(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    schedule: &ScheduleRecord,
    session_id: &SessionId,
    turn_id: &TurnId,
) -> PortResult<()> {
    let admitted = runtime.prepare_host_admitted_turn(
        workspace_id,
        session_id,
        turn_id,
        InboxCategory::Schedule,
        schedule.author_user_id.clone(),
        schedule.prompt_text.clone(),
        schedule.adapter_id.clone(),
    )?;
    let _ = runtime.deps.inbox.admit_turn(&admitted)?;

    if let Ok(false) = runtime
        .deps
        .history
        .is_user_turn_durable(workspace_id, session_id, turn_id)
    {
        ignore_unwired(runtime.deps.history.upsert_turn_record(
            workspace_id,
            session_id,
            &HistoryTurnRecord {
                turn_id: turn_id.clone(),
                author_user_id: Some(schedule.author_user_id.clone()),
                user_prompt: schedule.prompt_text.clone(),
                assistant_blocks: Vec::new(),
                outcome: None,
            },
        ))?;
    }

    let handle = runtime.ensure_session_actor(
        workspace_id,
        session_id,
        0,
        None,
        None,
        None,
        false,
        None,
        None,
    )?;
    handle.wake_inbox().await
}
