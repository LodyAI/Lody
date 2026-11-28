#![forbid(unsafe_code)]

use crate::schedule::sha256_hex_bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AUTOMATION_MAX_CONSECUTIVE_ERRORS: u32 = 5;
pub const AUTOMATION_MAX_ERROR_BACKOFF_MS: i64 = 300_000;
pub const AUTOMATION_BASE_ERROR_BACKOFF_MS: i64 = 1_000;
pub const AUTOMATION_RECONCILE_CAP_MS: i64 = 15_000;
pub const AUTOMATION_ACTION_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaitCheckInput {
    NotReady,
    Matched {
        resume_text: String,
        payload: Option<Value>,
    },
    CheckFailed {
        error_message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaitTransitionDecision {
    Expire,
    RescheduleWaiting {
        next_check_at_ms: i64,
        consecutive_errors: u32,
        last_error: Option<String>,
    },
    FinalizeMatched {
        resume_text: String,
        payload: Option<Value>,
    },
    FinalizeFailed {
        consecutive_errors: u32,
        last_error: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetSessionGate {
    Ready,
    CollaborationStopped,
    ArchivedOrDeleted,
    PermissionDenied,
    PermissionUnconfirmed,
    TemporarilyUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContinuationGateDecision {
    DispatchTurn,
    Block {
        reason: &'static str,
    },
    Drop {
        reason: &'static str,
    },
    RetryLater {
        attempts: u32,
        retry_at_ms: i64,
        reason: &'static str,
    },
    FailPermanent {
        attempts: u32,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRunExitOutcome {
    Exited,
    SpawnFailed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedRunSummaryInput {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub log_path: String,
    pub started_at_ms: Option<i64>,
    pub pid: Option<u32>,
    pub ended_at_ms: i64,
    pub outcome: ManagedRunExitOutcome,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub error: Option<String>,
    pub tail: String,
    pub log_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedRunFormattedResult {
    pub resume_text: String,
    pub payload: Value,
}

pub fn automation_identity(parts: &[&str]) -> String {
    let json = serde_json::to_string(parts).unwrap_or_else(|_| "[]".to_string());
    sha256_hex_bytes(json.as_bytes())
}

pub fn pull_request_checkpoint_id(session_id: &str, url: &str) -> String {
    automation_identity(&["github.pr", session_id, url])
}

pub fn workflow_checkpoint_id(session_id: &str, repository: &str, head_sha: &str) -> String {
    let lower = repository.to_ascii_lowercase();
    automation_identity(&["github.workflow", session_id, &lower, head_sha])
}

pub fn parse_github_pr_url(url: &str) -> Option<(String, u64)> {
    let trimmed = url.trim().split(['?', '#']).next()?;
    let rest = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))?;
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 4 || parts[2] != "pull" {
        return None;
    }
    let pr_number = parts[3].parse::<u64>().ok()?;
    Some((format!("{}/{}", parts[0], parts[1]), pr_number))
}

pub fn evaluate_capacity_observation(
    snapshot: Option<&Value>,
    binding_id: Option<&str>,
    binding_fingerprint: Option<&str>,
    now_ms: i64,
) -> (Value, i64) {
    let Some(binding_id) = binding_id.filter(|s| !s.is_empty()) else {
        return (
            serde_json::json!({ "status": "unknown", "reason": "capacity_unobserved" }),
            now_ms,
        );
    };
    let Some(snap) = snapshot.and_then(Value::as_object) else {
        return (
            serde_json::json!({ "status": "unknown", "reason": "capacity_unobserved" }),
            now_ms,
        );
    };
    let observed_at = snap
        .get("observedAt")
        .and_then(Value::as_i64)
        .unwrap_or(now_ms);
    let snap_binding = snap.get("bindingId").and_then(Value::as_str).unwrap_or("");
    let snap_fp = snap.get("fingerprint").and_then(Value::as_str);
    let valid_until = snap.get("validUntil").and_then(Value::as_i64).unwrap_or(0);
    let auth = snap
        .get("authentication")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let billing = snap
        .get("billing")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let windows_val = snap
        .get("windows")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let windows = windows_val.as_array().cloned().unwrap_or_default();

    let (status, reason) = if snap_binding != binding_id
        || binding_fingerprint.is_some_and(|fp| snap_fp != Some(fp))
    {
        ("unknown", "capacity_binding_unobserved")
    } else if auth == "invalid" || billing == "invalid" {
        ("no", "capacity_account_unavailable")
    } else if observed_at > now_ms || valid_until <= now_ms {
        ("unknown", "capacity_observation_stale")
    } else if windows.iter().any(|w| {
        let w_obs = w
            .get("observedAt")
            .and_then(Value::as_i64)
            .unwrap_or(observed_at);
        let w_valid = w
            .get("validUntil")
            .and_then(Value::as_i64)
            .unwrap_or(valid_until);
        w_obs > now_ms || w_valid <= now_ms
    }) {
        ("unknown", "capacity_window_stale")
    } else if windows.iter().any(|w| {
        w.get("usedPercent")
            .and_then(Value::as_f64)
            .is_some_and(|pct| pct >= 100.0)
    }) {
        ("no", "capacity_exhausted")
    } else if windows.is_empty()
        || snap.get("source").and_then(Value::as_str) == Some("exhaustion")
        || auth != "valid"
        || billing != "valid"
        || windows.iter().any(|w| {
            w.get("usedPercent")
                .and_then(Value::as_f64)
                .is_none_or(|pct| !pct.is_finite() || pct < 0.0)
        })
    {
        ("unknown", "capacity_evidence_incomplete")
    } else {
        ("yes", "capacity_available")
    };

    (
        serde_json::json!({
            "status": status,
            "reason": reason,
            "windows": windows_val,
            "authentication": auth,
            "billing": billing,
            "validUntil": valid_until,
        }),
        observed_at.max(0),
    )
}

pub fn compute_automation_error_backoff_ms(interval_ms: i64, consecutive_errors: u32) -> i64 {
    let shift = consecutive_errors.min(20);
    let exp = AUTOMATION_BASE_ERROR_BACKOFF_MS.saturating_mul(1i64 << shift);
    exp.min(AUTOMATION_MAX_ERROR_BACKOFF_MS)
        .max(interval_ms.max(1_000))
}

pub fn decide_wait_transition(
    now_ms: i64,
    interval_ms: i64,
    expires_at_ms: Option<i64>,
    prior_consecutive_errors: u32,
    check: WaitCheckInput,
) -> WaitTransitionDecision {
    if expires_at_ms.is_some_and(|exp| exp <= now_ms) {
        return WaitTransitionDecision::Expire;
    }
    match check {
        WaitCheckInput::NotReady => WaitTransitionDecision::RescheduleWaiting {
            next_check_at_ms: now_ms.saturating_add(interval_ms.max(1_000)),
            consecutive_errors: 0,
            last_error: None,
        },
        WaitCheckInput::Matched {
            resume_text,
            payload,
        } => WaitTransitionDecision::FinalizeMatched {
            resume_text,
            payload,
        },
        WaitCheckInput::CheckFailed { error_message } => {
            let errors = prior_consecutive_errors.saturating_add(1);
            let bounded_err: String = error_message.chars().take(2_000).collect();
            if errors >= AUTOMATION_MAX_CONSECUTIVE_ERRORS {
                WaitTransitionDecision::FinalizeFailed {
                    consecutive_errors: errors,
                    last_error: bounded_err,
                }
            } else {
                let backoff = compute_automation_error_backoff_ms(interval_ms, errors);
                WaitTransitionDecision::RescheduleWaiting {
                    next_check_at_ms: now_ms.saturating_add(backoff),
                    consecutive_errors: errors,
                    last_error: Some(bounded_err),
                }
            }
        }
    }
}

pub fn decide_continuation_gate(
    gate: TargetSessionGate,
    prior_attempts: u32,
    now_ms: i64,
) -> ContinuationGateDecision {
    match gate {
        TargetSessionGate::Ready => ContinuationGateDecision::DispatchTurn,
        TargetSessionGate::CollaborationStopped => ContinuationGateDecision::Block {
            reason: "target_stopped",
        },
        TargetSessionGate::PermissionDenied => ContinuationGateDecision::Block {
            reason: "permission_denied",
        },
        TargetSessionGate::ArchivedOrDeleted => ContinuationGateDecision::Drop {
            reason: "target_archived",
        },
        TargetSessionGate::PermissionUnconfirmed => {
            retry_or_fail(prior_attempts, now_ms, "permission_unconfirmed")
        }
        TargetSessionGate::TemporarilyUnavailable => {
            retry_or_fail(prior_attempts, now_ms, "session_unavailable")
        }
    }
}

fn retry_or_fail(
    prior_attempts: u32,
    now_ms: i64,
    reason: &'static str,
) -> ContinuationGateDecision {
    let attempts = prior_attempts.saturating_add(1);
    if attempts >= AUTOMATION_ACTION_MAX_ATTEMPTS {
        ContinuationGateDecision::FailPermanent { attempts, reason }
    } else {
        let backoff = compute_automation_error_backoff_ms(5_000, attempts);
        ContinuationGateDecision::RetryLater {
            attempts,
            retry_at_ms: now_ms.saturating_add(backoff),
            reason,
        }
    }
}

pub fn next_supervisor_wake_deadline_ms(now_ms: i64, earliest_due_ms: Option<i64>) -> i64 {
    let cap = now_ms.saturating_add(AUTOMATION_RECONCILE_CAP_MS);
    match earliest_due_ms {
        Some(due) => due.max(now_ms).min(cap),
        None => cap,
    }
}

fn format_duration_ms(ms: i64) -> String {
    let seconds = ((ms.max(0) + 500) / 1_000) as u64;
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let rest = seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m {rest}s")
    } else if minutes > 0 {
        format!("{minutes}m {rest}s")
    } else {
        format!("{rest}s")
    }
}

pub fn format_managed_run_summary(input: &ManagedRunSummaryInput) -> ManagedRunFormattedResult {
    let mut joined = input.command.clone();
    for arg in &input.args {
        joined.push(' ');
        joined.push_str(arg);
    }
    let command: String = joined.chars().take(1_000).collect();
    let duration_ms = input
        .started_at_ms
        .map(|started| input.ended_at_ms.saturating_sub(started));
    let after = duration_ms
        .map(|d| format!(" after {}", format_duration_ms(d)))
        .unwrap_or_default();
    let outcome_str = match input.outcome {
        ManagedRunExitOutcome::SpawnFailed => format!(
            "could not start: {}",
            input.error.as_deref().unwrap_or("unknown error")
        ),
        ManagedRunExitOutcome::Interrupted => {
            let pid_suffix = input.pid.map(|p| format!(" (pid {p})")).unwrap_or_default();
            format!(
                "stopped being observed{after}: Lody stopped or restarted before the exit was seen. Lody did not run it again; it may have been terminated or may still be running{pid_suffix}"
            )
        }
        ManagedRunExitOutcome::Exited => {
            if let Some(sig) = &input.signal {
                format!("was terminated by {sig}{after}")
            } else {
                let code_text = input
                    .exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                format!("exited with code {code_text}{after}")
            }
        }
    };
    let resume_text = format!(
        "The Lody-managed command `{command}` {outcome_str}. Output log: {}",
        input.log_path
    );
    let outcome_wire = match input.outcome {
        ManagedRunExitOutcome::Exited => "exited",
        ManagedRunExitOutcome::SpawnFailed => "spawn_failed",
        ManagedRunExitOutcome::Interrupted => "interrupted",
    };
    let mut obj = serde_json::Map::new();
    obj.insert("command".to_string(), Value::String(command));
    if let Some(cwd) = &input.cwd {
        obj.insert("cwd".to_string(), Value::String(cwd.clone()));
    }
    obj.insert(
        "outcome".to_string(),
        Value::String(outcome_wire.to_string()),
    );
    obj.insert(
        "exitCode".to_string(),
        input
            .exit_code
            .map(|c| Value::Number(c.into()))
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "signal".to_string(),
        input
            .signal
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    if let Some(d) = duration_ms {
        obj.insert("durationMs".to_string(), Value::Number(d.into()));
    }
    obj.insert("logPath".to_string(), Value::String(input.log_path.clone()));
    obj.insert("logTruncated".to_string(), Value::Bool(input.log_truncated));
    obj.insert("outputTail".to_string(), Value::String(input.tail.clone()));

    ManagedRunFormattedResult {
        resume_text,
        payload: Value::Object(obj),
    }
}
