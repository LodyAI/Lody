#![forbid(unsafe_code)]

use crate::{DaemonDependencies, DaemonRuntime, current_epoch_ms_i64, ignore_unwired};
use lody_app::{
    HistoryTurnRecord, PortError, PortErrorKind, PortResult, SessionId, StorageLeaseMode, TurnId,
    WorkspaceId,
};
use lody_kernel::{
    ContinuationGateDecision, ManagedRunExitOutcome, ManagedRunSummaryInput, TargetSessionGate,
    WaitCheckInput, WaitTransitionDecision, decide_continuation_gate, decide_wait_transition,
    format_managed_run_summary,
};
use lody_ports::{
    AdmittedTurnInput, AutomationHostOps, AutomationMatchResult, AutomationProgramContext,
    AutomationReceiptPatch, AutomationReceiptState, AutomationRunExit, AutomationRunOutcome,
    AutomationWaitCompletion, AutomationWaitRecord, AutomationWorkspaceScope, InboxCategory,
    SessionRunStatus,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Notify;

pub const MANAGED_RUN_LOG_LIMIT_BYTES: usize = 16 * 1024 * 1024;
pub const MANAGED_RUN_TAIL_BYTES: usize = 4 * 1024;
const MANAGED_RUN_LOG_RETENTION_MS: i64 = 7 * 24 * 60 * 60_000;

#[derive(Default)]
pub struct ManagedRunRegistry {
    active: Mutex<HashMap<String, Arc<Notify>>>,
}

pub struct ManagedRunLaunchSpec {
    pub scope: AutomationWorkspaceScope,
    pub wait_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub log_path: PathBuf,
}

impl ManagedRunRegistry {
    pub fn is_live(&self, wait_id: &str) -> bool {
        self.active
            .lock()
            .expect("managed runs lock")
            .contains_key(wait_id)
    }

    pub fn stop(&self, wait_id: &str) {
        if let Some(cancel) = self
            .active
            .lock()
            .expect("managed runs lock")
            .remove(wait_id)
        {
            cancel.notify_waiters();
        }
    }

    pub fn stop_all(&self) {
        let handles: Vec<Arc<Notify>> = self
            .active
            .lock()
            .expect("managed runs lock")
            .drain()
            .map(|(_, n)| n)
            .collect();
        for cancel in handles {
            cancel.notify_waiters();
        }
    }

    pub fn spawn_managed_run(
        self: &Arc<Self>,
        deps: Arc<DaemonDependencies>,
        wake_notify: Arc<Notify>,
        spec: ManagedRunLaunchSpec,
    ) {
        let cancel_notify = Arc::new(Notify::new());
        {
            let mut guard = self.active.lock().expect("managed runs lock");
            if guard.contains_key(&spec.wait_id) {
                return;
            }
            guard.insert(spec.wait_id.clone(), Arc::clone(&cancel_notify));
        }

        let registry = Arc::clone(self);
        tokio::spawn(async move {
            let wait_id = spec.wait_id.clone();
            let scope = spec.scope.clone();
            let now_start = current_epoch_ms_i64();
            if let Some(parent) = spec.log_path.parent() {
                let _ = fs::create_dir_all(parent);
                prune_old_logs(parent, now_start);
            }

            let mut log_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&spec.log_path)
                .ok();

            let mut cmd = Command::new(&spec.command);
            cmd.args(&spec.args)
                .current_dir(&spec.cwd)
                .env_clear()
                .envs(&spec.env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(err) => {
                    registry
                        .active
                        .lock()
                        .expect("managed runs lock")
                        .remove(&wait_id);
                    let _ = deps.automation_store.record_run_exit(
                        &scope,
                        &wait_id,
                        &AutomationRunExit {
                            ended_at: current_epoch_ms_i64(),
                            outcome: AutomationRunOutcome::SpawnFailed,
                            exit_code: None,
                            signal: None,
                            error: Some(err.to_string().chars().take(2_000).collect()),
                            tail: String::new(),
                            log_truncated: false,
                        },
                        current_epoch_ms_i64(),
                    );
                    wake_notify.notify_one();
                    return;
                }
            };

            if let Some(pid) = child.id() {
                let _ = deps.automation_store.record_run_pid(
                    &scope,
                    &wait_id,
                    pid,
                    current_epoch_ms_i64(),
                );
            }

            let mut stdout = child.stdout.take();
            let mut stderr = child.stderr.take();
            let shared_buf = Arc::new(Mutex::new((Vec::<u8>::new(), 0usize, false)));

            let out_buf = Arc::clone(&shared_buf);
            let log_clone_a = spec.log_path.clone();
            let stdout_task = tokio::spawn(async move {
                if let Some(mut r) = stdout.take() {
                    let mut chunk = [0u8; 4096];
                    while let Ok(n) = r.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        append_run_output(&out_buf, &log_clone_a, &chunk[..n]);
                    }
                }
            });

            let err_buf = Arc::clone(&shared_buf);
            let log_clone_b = spec.log_path.clone();
            let stderr_task = tokio::spawn(async move {
                if let Some(mut r) = stderr.take() {
                    let mut chunk = [0u8; 4096];
                    while let Ok(n) = r.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        append_run_output(&err_buf, &log_clone_b, &chunk[..n]);
                    }
                }
            });

            let wait_outcome = tokio::select! {
                _ = cancel_notify.notified() => None,
                status_res = child.wait() => Some(status_res),
            };

            match wait_outcome {
                Some(status_res) => {
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    let _ = log_file.as_mut().map(Write::flush);
                    registry
                        .active
                        .lock()
                        .expect("managed runs lock")
                        .remove(&wait_id);
                    let ended_at = current_epoch_ms_i64();
                    let (tail_bytes, _, truncated) = shared_buf.lock().expect("run buf").clone();
                    let tail = String::from_utf8_lossy(&tail_bytes)
                        .trim_start_matches('\u{fffd}')
                        .to_string();
                    let exit = match status_res {
                        Ok(st) => AutomationRunExit {
                            ended_at,
                            outcome: AutomationRunOutcome::Exited,
                            exit_code: st.code(),
                            signal: extract_unix_signal(&st),
                            error: None,
                            tail,
                            log_truncated: truncated,
                        },
                        Err(err) => AutomationRunExit {
                            ended_at,
                            outcome: AutomationRunOutcome::SpawnFailed,
                            exit_code: None,
                            signal: None,
                            error: Some(err.to_string()),
                            tail,
                            log_truncated: truncated,
                        },
                    };
                    let _ = deps
                        .automation_store
                        .record_run_exit(&scope, &wait_id, &exit, ended_at);
                    wake_notify.notify_one();
                }
                None => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    stdout_task.abort();
                    stderr_task.abort();
                    registry
                        .active
                        .lock()
                        .expect("managed runs lock")
                        .remove(&wait_id);
                }
            }
        });
    }
}

#[cfg(unix)]
fn extract_unix_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|sig| format!("SIG{sig}"))
}

#[cfg(not(unix))]
fn extract_unix_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

fn append_run_output(state: &Arc<Mutex<(Vec<u8>, usize, bool)>>, log_path: &Path, chunk: &[u8]) {
    let mut guard = state.lock().expect("run buf lock");
    guard.0.extend_from_slice(chunk);
    if guard.0.len() > MANAGED_RUN_TAIL_BYTES {
        let drop_len = guard.0.len() - MANAGED_RUN_TAIL_BYTES;
        guard.0.drain(0..drop_len);
    }
    if guard.2 {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        if guard.1 + chunk.len() > MANAGED_RUN_LOG_LIMIT_BYTES {
            guard.2 = true;
            let _ = writeln!(
                file,
                "\n[Lody: log limit of {MANAGED_RUN_LOG_LIMIT_BYTES} bytes reached]"
            );
        } else {
            guard.1 += chunk.len();
            let _ = file.write_all(chunk);
        }
    }
}

fn prune_old_logs(dir: &Path, now_ms: i64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        if let Ok(meta) = entry.metadata()
            && let Ok(modified) = meta.modified()
            && let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH)
        {
            let mtime_ms = i64::try_from(dur.as_millis()).unwrap_or(now_ms);
            if now_ms.saturating_sub(mtime_ms) > MANAGED_RUN_LOG_RETENTION_MS {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub fn resolve_contained_workdir(root: &Path, relative_cwd: Option<&str>) -> PortResult<PathBuf> {
    let rel = relative_cwd.unwrap_or(".");
    if Path::new(rel).is_absolute() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_INVALID_CWD",
        ));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| PortError::new(PortErrorKind::InvalidInput, "AUTOMATION_EXEC_INVALID_CWD"))?;
    let candidate = canonical_root
        .join(rel)
        .canonicalize()
        .map_err(|_| PortError::new(PortErrorKind::InvalidInput, "AUTOMATION_EXEC_INVALID_CWD"))?;
    if !candidate.starts_with(&canonical_root) || !candidate.is_dir() {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_INVALID_CWD",
        ));
    }
    Ok(candidate)
}

struct RuntimeAutomationHostOps {
    deps: Arc<DaemonDependencies>,
    workspace_id: WorkspaceId,
    session_id: SessionId,
    workdir: Option<PathBuf>,
    command_env: BTreeMap<String, String>,
    session_status_json: Value,
}

impl AutomationHostOps for RuntimeAutomationHostOps {
    fn read_resource(&self, resource: &str, _query: &Value) -> PortResult<Value> {
        match resource {
            "session" => Ok(self.session_status_json.clone()),
            "session.group" => Ok(json!({
                "rootSessionId": self.session_id.0,
                "settled": self.session_status_json.get("executionState").and_then(Value::as_str) == Some("idle"),
                "sessions": [self.session_status_json]
            })),
            "events" => Ok(json!([])),
            "provider.capacity" => Ok(json!({ "available": true })),
            "github.pullRequests" => Ok(json!([])),
            "github.workflowRuns" => Ok(json!([])),
            other => Err(PortError::new(
                PortErrorKind::InvalidInput,
                format!("AUTOMATION_UNKNOWN_READ_RESOURCE:{other}"),
            )),
        }
    }

    fn session_workdir(&self) -> Option<PathBuf> {
        self.workdir.clone()
    }

    fn command_env(&self) -> BTreeMap<String, String> {
        let _ = (&self.deps, &self.workspace_id);
        self.command_env.clone()
    }
}

pub fn build_sanitized_automation_env(
    deps: &DaemonDependencies,
    session_id: &SessionId,
    extra: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, String> {
    let base = (deps.terminal_env_builder)(&session_id.0);
    let mut env = BTreeMap::new();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "TMPDIR",
        "TEMP",
        "TMP",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        if let Some(val) = base.get(key) {
            env.insert(key.to_string(), val.clone());
        }
    }
    if let Some(overrides) = extra {
        for (k, v) in overrides {
            env.insert(k.clone(), v.clone());
        }
    }
    env
}

pub async fn tick_workspace_automations(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    managed_runs: &Arc<ManagedRunRegistry>,
    wake_notify: &Arc<Notify>,
    startup_reconciled: &mut bool,
    now_ms: i64,
) -> PortResult<Option<i64>> {
    if runtime.deps.storage_lease_mode != StorageLeaseMode::OnlineHost {
        return Ok(None);
    }
    let scope = AutomationWorkspaceScope {
        machine_id: runtime.deps.machine_id.clone(),
        workspace_id: workspace_id.clone(),
    };
    if !*startup_reconciled {
        match runtime
            .deps
            .automation_store
            .orphan_started_runs(&scope, now_ms)
        {
            Ok(_) => *startup_reconciled = true,
            Err(err) if err.kind == PortErrorKind::Unavailable => return Ok(None),
            Err(err) => return Err(err),
        }
    }

    let due = match runtime.deps.automation_store.due_waits(&scope, now_ms, 32) {
        Ok(rows) => rows,
        Err(err) if err.kind == PortErrorKind::Unavailable => return Ok(None),
        Err(err) => return Err(err),
    };

    for candidate in due {
        let Some(claimed) =
            runtime
                .deps
                .automation_store
                .claim_wait(&scope, &candidate.id, now_ms)?
        else {
            continue;
        };

        if claimed.expires_at.is_some_and(|exp| exp <= now_ms) {
            runtime
                .deps
                .automation_store
                .expire_wait(&scope, &claimed.id, now_ms)?;
            continue;
        }

        if claimed.run.is_some() {
            evaluate_claimed_managed_run(
                runtime,
                &scope,
                &claimed,
                managed_runs,
                wake_notify,
                now_ms,
            )
            .await?;
            continue;
        }

        let Some(program) = claimed.program.clone() else {
            runtime
                .deps
                .automation_store
                .expire_wait(&scope, &claimed.id, now_ms)?;
            continue;
        };

        let workdir = runtime
            .resolve_automation_session_workdir(workspace_id, &claimed.session_id)
            .await;
        let session_status_json = runtime
            .build_automation_session_snapshot(workspace_id, &claimed.session_id, now_ms)
            .await;
        let command_env = build_sanitized_automation_env(&runtime.deps, &claimed.session_id, None);
        let host_ops: Arc<dyn AutomationHostOps> = Arc::new(RuntimeAutomationHostOps {
            deps: Arc::clone(&runtime.deps),
            workspace_id: workspace_id.clone(),
            session_id: claimed.session_id.clone(),
            workdir,
            command_env,
            session_status_json,
        });
        let eval_ctx = AutomationProgramContext {
            session_id: claimed.session_id.clone(),
            workspace_id: workspace_id.clone(),
            now_ms,
        };
        let sandbox = Arc::clone(&runtime.deps.automation_sandbox);
        let eval_res = tokio::task::spawn_blocking(move || {
            sandbox.evaluate_program(&program, &eval_ctx, host_ops)
        })
        .await
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        let (check_input, reads, evidence) = match eval_res {
            Ok(eval) => match eval.matched {
                Some(m) => (
                    WaitCheckInput::Matched {
                        resume_text: m.resume_text,
                        payload: m.payload,
                    },
                    eval.reads,
                    eval.evidence,
                ),
                None => (WaitCheckInput::NotReady, eval.reads, eval.evidence),
            },
            Err(err) => (
                WaitCheckInput::CheckFailed {
                    error_message: err.message,
                },
                Vec::new(),
                Vec::new(),
            ),
        };

        let completion = AutomationWaitCompletion {
            wait_id: claimed.id.clone(),
            reads,
            evidence,
            now_ms,
        };
        let decision = decide_wait_transition(
            now_ms,
            claimed.interval_ms,
            claimed.expires_at,
            claimed.consecutive_errors,
            check_input,
        );
        match decision {
            WaitTransitionDecision::Expire => {
                runtime
                    .deps
                    .automation_store
                    .expire_wait(&scope, &claimed.id, now_ms)?;
            }
            WaitTransitionDecision::RescheduleWaiting {
                next_check_at_ms,
                last_error: None,
                ..
            } => {
                runtime.deps.automation_store.finish_wait_not_ready(
                    &scope,
                    &completion,
                    next_check_at_ms,
                )?;
            }
            WaitTransitionDecision::RescheduleWaiting {
                next_check_at_ms,
                last_error: Some(err_msg),
                ..
            } => {
                runtime.deps.automation_store.finish_wait_error(
                    &scope,
                    &claimed.id,
                    &err_msg,
                    false,
                    next_check_at_ms,
                    now_ms,
                )?;
            }
            WaitTransitionDecision::FinalizeFailed { last_error, .. } => {
                runtime.deps.automation_store.finish_wait_error(
                    &scope,
                    &claimed.id,
                    &last_error,
                    true,
                    now_ms,
                    now_ms,
                )?;
            }
            WaitTransitionDecision::FinalizeMatched {
                resume_text,
                payload,
            } => {
                let _ = runtime.deps.automation_store.finish_wait_matched(
                    &scope,
                    &completion,
                    &AutomationMatchResult {
                        resume_text,
                        payload,
                    },
                )?;
            }
        }
    }

    dispatch_actionable_receipts(runtime, &scope, now_ms).await?;
    runtime.deps.automation_store.next_due_at(&scope)
}

async fn evaluate_claimed_managed_run(
    runtime: &DaemonRuntime,
    scope: &AutomationWorkspaceScope,
    claimed: &AutomationWaitRecord,
    managed_runs: &Arc<ManagedRunRegistry>,
    wake_notify: &Arc<Notify>,
    now_ms: i64,
) -> PortResult<()> {
    let latest = runtime
        .deps
        .automation_store
        .get_wait(scope, &claimed.id)?
        .unwrap_or_else(|| claimed.clone());
    let Some(run) = latest.run.clone() else {
        return Ok(());
    };

    if let Some(exit) = &run.exit {
        let summary = format_managed_run_summary(&ManagedRunSummaryInput {
            command: run.command.clone(),
            args: run.args.clone(),
            cwd: run.cwd.clone(),
            log_path: run.log_path.clone(),
            started_at_ms: run.started_at,
            pid: run.pid,
            ended_at_ms: exit.ended_at,
            outcome: match exit.outcome {
                AutomationRunOutcome::Exited => ManagedRunExitOutcome::Exited,
                AutomationRunOutcome::SpawnFailed => ManagedRunExitOutcome::SpawnFailed,
                AutomationRunOutcome::Interrupted => ManagedRunExitOutcome::Interrupted,
            },
            exit_code: exit.exit_code,
            signal: exit.signal.clone(),
            error: exit.error.clone(),
            tail: exit.tail.clone(),
            log_truncated: exit.log_truncated,
        });
        let _ = runtime.deps.automation_store.finish_wait_matched(
            scope,
            &AutomationWaitCompletion {
                wait_id: claimed.id.clone(),
                reads: Vec::new(),
                evidence: Vec::new(),
                now_ms,
            },
            &AutomationMatchResult {
                resume_text: summary.resume_text,
                payload: Some(summary.payload),
            },
        )?;
        return Ok(());
    }

    if managed_runs.is_live(&claimed.id) {
        runtime.deps.automation_store.finish_wait_not_ready(
            scope,
            &AutomationWaitCompletion {
                wait_id: claimed.id.clone(),
                reads: Vec::new(),
                evidence: Vec::new(),
                now_ms,
            },
            now_ms.saturating_add(60_000),
        )?;
        return Ok(());
    }

    if run.started_at.is_some() {
        let interrupted_exit = AutomationRunExit {
            ended_at: now_ms,
            outcome: AutomationRunOutcome::Interrupted,
            exit_code: None,
            signal: None,
            error: None,
            tail: String::new(),
            log_truncated: false,
        };
        let _ = runtime.deps.automation_store.record_run_exit(
            scope,
            &claimed.id,
            &interrupted_exit,
            now_ms,
        )?;
        let summary = format_managed_run_summary(&ManagedRunSummaryInput {
            command: run.command.clone(),
            args: run.args.clone(),
            cwd: run.cwd.clone(),
            log_path: run.log_path.clone(),
            started_at_ms: run.started_at,
            pid: run.pid,
            ended_at_ms: now_ms,
            outcome: ManagedRunExitOutcome::Interrupted,
            exit_code: None,
            signal: None,
            error: None,
            tail: String::new(),
            log_truncated: false,
        });
        let _ = runtime.deps.automation_store.finish_wait_matched(
            scope,
            &AutomationWaitCompletion {
                wait_id: claimed.id.clone(),
                reads: Vec::new(),
                evidence: Vec::new(),
                now_ms,
            },
            &AutomationMatchResult {
                resume_text: summary.resume_text,
                payload: Some(summary.payload),
            },
        )?;
        return Ok(());
    }

    if !runtime
        .deps
        .automation_store
        .claim_run_start(scope, &claimed.id, now_ms)?
    {
        runtime.deps.automation_store.finish_wait_not_ready(
            scope,
            &AutomationWaitCompletion {
                wait_id: claimed.id.clone(),
                reads: Vec::new(),
                evidence: Vec::new(),
                now_ms,
            },
            now_ms.saturating_add(60_000),
        )?;
        return Ok(());
    }

    let root_opt = runtime
        .resolve_automation_session_workdir(&scope.workspace_id, &claimed.session_id)
        .await;
    let resolved_cwd = match root_opt {
        Some(root) => resolve_contained_workdir(&root, run.cwd.as_deref()),
        None => Err(PortError::new(
            PortErrorKind::Unavailable,
            "AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE",
        )),
    };

    match resolved_cwd {
        Ok(cwd) => {
            let env = build_sanitized_automation_env(
                &runtime.deps,
                &claimed.session_id,
                run.env.as_ref(),
            );
            managed_runs.spawn_managed_run(
                Arc::clone(&runtime.deps),
                Arc::clone(wake_notify),
                ManagedRunLaunchSpec {
                    scope: scope.clone(),
                    wait_id: claimed.id.clone(),
                    command: run.command.clone(),
                    args: run.args.clone(),
                    cwd,
                    env,
                    log_path: PathBuf::from(&run.log_path),
                },
            );
            runtime.deps.automation_store.finish_wait_not_ready(
                scope,
                &AutomationWaitCompletion {
                    wait_id: claimed.id.clone(),
                    reads: Vec::new(),
                    evidence: Vec::new(),
                    now_ms,
                },
                now_ms.saturating_add(60_000),
            )?;
        }
        Err(err) => {
            let failed_exit = AutomationRunExit {
                ended_at: now_ms,
                outcome: AutomationRunOutcome::SpawnFailed,
                exit_code: None,
                signal: None,
                error: Some(err.message.clone()),
                tail: String::new(),
                log_truncated: false,
            };
            let _ = runtime.deps.automation_store.record_run_exit(
                scope,
                &claimed.id,
                &failed_exit,
                now_ms,
            )?;
            let summary = format_managed_run_summary(&ManagedRunSummaryInput {
                command: run.command,
                args: run.args,
                cwd: run.cwd,
                log_path: run.log_path,
                started_at_ms: Some(now_ms),
                pid: None,
                ended_at_ms: now_ms,
                outcome: ManagedRunExitOutcome::SpawnFailed,
                exit_code: None,
                signal: None,
                error: Some(err.message),
                tail: String::new(),
                log_truncated: false,
            });
            let _ = runtime.deps.automation_store.finish_wait_matched(
                scope,
                &AutomationWaitCompletion {
                    wait_id: claimed.id.clone(),
                    reads: Vec::new(),
                    evidence: Vec::new(),
                    now_ms,
                },
                &AutomationMatchResult {
                    resume_text: summary.resume_text,
                    payload: Some(summary.payload),
                },
            )?;
        }
    }
    Ok(())
}

async fn dispatch_actionable_receipts(
    runtime: &DaemonRuntime,
    scope: &AutomationWorkspaceScope,
    now_ms: i64,
) -> PortResult<()> {
    let receipts = runtime
        .deps
        .automation_store
        .actionable_receipts(scope, now_ms, 32)?;
    for receipt in receipts {
        let Some(target_sid) = receipt.session_id.clone() else {
            runtime.deps.automation_store.update_receipt(
                scope,
                &receipt.id,
                &AutomationReceiptPatch {
                    state: AutomationReceiptState::Dropped,
                    reason: Some("missing_target_session".to_string()),
                    turn_id: None,
                    attempts: receipt.attempts.saturating_add(1),
                    retry_at: None,
                    now_ms,
                },
            )?;
            continue;
        };

        let owner_uid_str = receipt
            .rule
            .get("ownerUserId")
            .and_then(Value::as_str)
            .unwrap_or("local-host");
        let owner_uid = lody_app::UserId(owner_uid_str.to_string());
        let gate =
            inspect_target_session_gate(runtime, &scope.workspace_id, &target_sid, &owner_uid)
                .await;

        match decide_continuation_gate(gate, receipt.attempts, now_ms) {
            ContinuationGateDecision::Block { reason } => {
                runtime.deps.automation_store.update_receipt(
                    scope,
                    &receipt.id,
                    &AutomationReceiptPatch {
                        state: AutomationReceiptState::Blocked,
                        reason: Some(reason.to_string()),
                        turn_id: receipt.turn_id.clone(),
                        attempts: receipt.attempts,
                        retry_at: None,
                        now_ms,
                    },
                )?;
            }
            ContinuationGateDecision::Drop { reason } => {
                runtime.deps.automation_store.update_receipt(
                    scope,
                    &receipt.id,
                    &AutomationReceiptPatch {
                        state: AutomationReceiptState::Dropped,
                        reason: Some(reason.to_string()),
                        turn_id: receipt.turn_id.clone(),
                        attempts: receipt.attempts,
                        retry_at: None,
                        now_ms,
                    },
                )?;
            }
            ContinuationGateDecision::RetryLater {
                attempts,
                retry_at_ms,
                reason,
            } => {
                runtime.deps.automation_store.update_receipt(
                    scope,
                    &receipt.id,
                    &AutomationReceiptPatch {
                        state: AutomationReceiptState::Waiting,
                        reason: Some(reason.to_string()),
                        turn_id: receipt.turn_id.clone(),
                        attempts,
                        retry_at: Some(retry_at_ms),
                        now_ms,
                    },
                )?;
            }
            ContinuationGateDecision::FailPermanent { attempts, reason } => {
                runtime.deps.automation_store.update_receipt(
                    scope,
                    &receipt.id,
                    &AutomationReceiptPatch {
                        state: AutomationReceiptState::Failed,
                        reason: Some(reason.to_string()),
                        turn_id: receipt.turn_id.clone(),
                        attempts,
                        retry_at: None,
                        now_ms,
                    },
                )?;
            }
            ContinuationGateDecision::DispatchTurn => {
                let resume_text = receipt
                    .intent
                    .pointer("/action/parameters/input/resumeText")
                    .and_then(Value::as_str)
                    .unwrap_or("Automation condition matched.")
                    .to_string();
                let turn_id = receipt
                    .turn_id
                    .clone()
                    .unwrap_or_else(|| TurnId(format!("auto_{}", receipt.id)));
                let _ = runtime.deps.inbox.admit_turn(&AdmittedTurnInput {
                    workspace_id: scope.workspace_id.clone(),
                    session_id: target_sid.clone(),
                    turn_id: turn_id.clone(),
                    category: InboxCategory::Automation,
                    verified_requester: owner_uid.clone(),
                    prompt_text: resume_text.clone(),
                    adapter_id: "default".to_string(),
                    custom_acp: None,
                    signed_intent_verified: true,
                })?;

                if let Ok(false) = runtime.deps.history.is_user_turn_durable(
                    &scope.workspace_id,
                    &target_sid,
                    &turn_id,
                ) {
                    ignore_unwired(runtime.deps.history.upsert_turn_record(
                        &scope.workspace_id,
                        &target_sid,
                        &HistoryTurnRecord {
                            turn_id: turn_id.clone(),
                            author_user_id: Some(owner_uid),
                            user_prompt: resume_text,
                            assistant_blocks: Vec::new(),
                            outcome: None,
                        },
                    ))?;
                }

                let handle = runtime.ensure_session_actor(
                    &scope.workspace_id,
                    &target_sid,
                    0,
                    None,
                    None,
                    None,
                    false,
                    None,
                    None,
                )?;
                handle.wake_inbox().await?;

                runtime.deps.automation_store.update_receipt(
                    scope,
                    &receipt.id,
                    &AutomationReceiptPatch {
                        state: AutomationReceiptState::Completed,
                        reason: None,
                        turn_id: Some(turn_id),
                        attempts: receipt.attempts.saturating_add(1),
                        retry_at: None,
                        now_ms,
                    },
                )?;
            }
        }
    }
    Ok(())
}

async fn inspect_target_session_gate(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    session_id: &SessionId,
    owner_user_id: &lody_app::UserId,
) -> TargetSessionGate {
    match runtime
        .deps
        .engine
        .read_session_meta(workspace_id, session_id)
    {
        Ok(Some(meta)) => {
            if meta.deleted || meta.status == SessionRunStatus::Archived {
                return TargetSessionGate::ArchivedOrDeleted;
            }
            if meta.owner_machine_id != runtime.deps.machine_id {
                return TargetSessionGate::PermissionDenied;
            }
            if &meta.owner_user_id != owner_user_id {
                return TargetSessionGate::PermissionDenied;
            }
            if meta.queue_paused {
                return TargetSessionGate::CollaborationStopped;
            }
        }
        Ok(None) => {
            if runtime.deps.engine.is_connected() {
                return TargetSessionGate::ArchivedOrDeleted;
            }
        }
        Err(err)
            if err.kind == PortErrorKind::Unavailable && !runtime.deps.engine.is_connected() => {}
        Err(_) => return TargetSessionGate::TemporarilyUnavailable,
    }

    if let Some(handle) = runtime.session_handle(workspace_id, session_id)
        && let Ok(paused) = handle.inspect_inbox_paused().await
        && paused
    {
        return TargetSessionGate::CollaborationStopped;
    }

    TargetSessionGate::Ready
}
