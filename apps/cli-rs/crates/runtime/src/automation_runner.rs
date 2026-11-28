#![forbid(unsafe_code)]

use crate::{DaemonDependencies, DaemonRuntime, current_epoch_ms_i64, ignore_unwired};
use lody_app::{
    HistoryTurnRecord, PortError, PortErrorKind, PortResult, SessionId, StorageLeaseMode, TurnId,
    WorkspaceId,
};
use lody_kernel::{
    ContinuationGateDecision, ManagedRunExitOutcome, ManagedRunSummaryInput, TargetSessionGate,
    WaitCheckInput, WaitTransitionDecision, decide_continuation_gate, decide_wait_transition,
    evaluate_capacity_observation, format_managed_run_summary, parse_github_pr_url,
    pull_request_checkpoint_id, workflow_checkpoint_id,
};
use lody_ports::{
    AutomationEvidenceEntry, AutomationHostOps, AutomationMatchResult, AutomationProgramContext,
    AutomationReadObservation, AutomationReceiptPatch, AutomationReceiptState, AutomationRunExit,
    AutomationRunOutcome, AutomationWaitCompletion, AutomationWaitRecord, AutomationWorkspaceScope,
    InboxCategory, SessionMetaSnapshot, SessionRunStatus, WorkspaceSecurityMode,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Notify, watch};

pub const MANAGED_RUN_LOG_LIMIT_BYTES: usize = 16 * 1024 * 1024;
pub const MANAGED_RUN_TAIL_BYTES: usize = 4 * 1024;
const MANAGED_RUN_LOG_RETENTION_MS: i64 = 7 * 24 * 60 * 60_000;
const POST_EXIT_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const WORKFLOW_OBSERVATION_FRESHNESS_MS: i64 = 120_000;
const SIGNING_RETRY_DELAY_MS: i64 = 15_000;

#[derive(Default)]
pub struct ManagedRunRegistry {
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
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

#[cfg(unix)]
async fn terminate_process_group(pgid: Option<u32>) {
    let Some(pid) = pgid.filter(|p| *p > 0) else {
        return;
    };
    let neg = format!("-{pid}");
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &neg])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &neg])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[cfg(not(unix))]
async fn terminate_process_group(_pgid: Option<u32>) {}

impl ManagedRunRegistry {
    pub fn is_live(&self, wait_id: &str) -> bool {
        self.active
            .lock()
            .expect("managed runs lock")
            .contains_key(wait_id)
    }

    pub fn stop(&self, wait_id: &str) {
        if let Some(cancel_tx) = self
            .active
            .lock()
            .expect("managed runs lock")
            .remove(wait_id)
        {
            let _ = cancel_tx.send(true);
        }
    }

    pub fn stop_all(&self) {
        let handles: Vec<watch::Sender<bool>> = self
            .active
            .lock()
            .expect("managed runs lock")
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for cancel_tx in handles {
            let _ = cancel_tx.send(true);
        }
    }

    pub fn spawn_managed_run(
        self: &Arc<Self>,
        deps: Arc<DaemonDependencies>,
        wake_notify: Arc<Notify>,
        spec: ManagedRunLaunchSpec,
    ) {
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        {
            let mut guard = self.active.lock().expect("managed runs lock");
            if guard.contains_key(&spec.wait_id) {
                return;
            }
            guard.insert(spec.wait_id.clone(), cancel_tx);
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

            if *cancel_rx.borrow_and_update() {
                registry
                    .active
                    .lock()
                    .expect("managed runs lock")
                    .remove(&wait_id);
                return;
            }

            let mut cmd = Command::new(&spec.command);
            cmd.args(&spec.args)
                .current_dir(&spec.cwd)
                .env_clear()
                .envs(&spec.env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(unix)]
            {
                cmd.process_group(0);
            }

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

            let child_pid = child.id();
            if let Some(pid) = child_pid {
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
            let mut stdout_task = tokio::spawn(async move {
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
            let mut stderr_task = tokio::spawn(async move {
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

            let wait_outcome = if *cancel_rx.borrow_and_update() {
                None
            } else {
                tokio::select! {
                    biased;
                    changed = cancel_rx.changed() => {
                        if changed.is_ok() && *cancel_rx.borrow_and_update() {
                            None
                        } else {
                            Some(child.wait().await)
                        }
                    }
                    status_res = child.wait() => Some(status_res),
                }
            };

            match wait_outcome {
                Some(status_res) => {
                    if tokio::time::timeout(POST_EXIT_PIPE_DRAIN_TIMEOUT, &mut stdout_task)
                        .await
                        .is_err()
                    {
                        stdout_task.abort();
                    }
                    if tokio::time::timeout(POST_EXIT_PIPE_DRAIN_TIMEOUT, &mut stderr_task)
                        .await
                        .is_err()
                    {
                        stderr_task.abort();
                    }
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
                    terminate_process_group(child_pid).await;
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

struct ActiveCheckGuard {
    set: Arc<Mutex<HashSet<String>>>,
    wait_id: String,
}

impl Drop for ActiveCheckGuard {
    fn drop(&mut self) {
        self.set
            .lock()
            .expect("active checks lock")
            .remove(&self.wait_id);
    }
}

struct RuntimeAutomationHostOps {
    deps: Arc<DaemonDependencies>,
    scope: AutomationWorkspaceScope,
    session_id: SessionId,
    now_ms: i64,
    workdir: Option<PathBuf>,
    command_env: BTreeMap<String, String>,
    session_meta: Option<SessionMetaSnapshot>,
    session_read_json: Value,
    session_group_json: Value,
}

fn ensure_empty_read_params(resource: &str, query: &Value) -> PortResult<()> {
    match query {
        Value::Null => Ok(()),
        Value::Object(map) if map.is_empty() => Ok(()),
        _ => Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!("AUTOMATION_INVALID_READ_PARAMETERS:{resource}"),
        )),
    }
}

fn parse_events_read_params(query: &Value) -> PortResult<(Option<i64>, usize)> {
    match query {
        Value::Null => Ok((None, 50)),
        Value::Object(map) => {
            let mut since = None;
            let mut limit = 50usize;
            for (k, v) in map {
                match k.as_str() {
                    "since" => {
                        if !v.is_null() {
                            let ts = v.as_i64().filter(|n| *n >= 0).ok_or_else(|| {
                                PortError::new(
                                    PortErrorKind::InvalidInput,
                                    "AUTOMATION_INVALID_READ_PARAMETERS:events",
                                )
                            })?;
                            since = Some(ts);
                        }
                    }
                    "limit" => {
                        if !v.is_null() {
                            let raw =
                                v.as_u64()
                                    .filter(|n| (1..=100).contains(n))
                                    .ok_or_else(|| {
                                        PortError::new(
                                            PortErrorKind::InvalidInput,
                                            "AUTOMATION_INVALID_READ_PARAMETERS:events",
                                        )
                                    })?;
                            limit = raw as usize;
                        }
                    }
                    _ => {
                        return Err(PortError::new(
                            PortErrorKind::InvalidInput,
                            "AUTOMATION_INVALID_READ_PARAMETERS:events",
                        ));
                    }
                }
            }
            Ok((since, limit))
        }
        _ => Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_INVALID_READ_PARAMETERS:events",
        )),
    }
}

struct UnwrappedCheckpoint<'a> {
    data: &'a serde_json::Map<String, Value>,
    observed_at: Option<i64>,
    revision: Option<&'a str>,
}

fn unwrap_source_checkpoint(cp: &Value) -> Option<UnwrappedCheckpoint<'_>> {
    let outer = cp.as_object()?;
    let data = outer
        .get("data")
        .and_then(Value::as_object)
        .unwrap_or(outer);
    let observed_at = outer
        .get("observedAt")
        .and_then(Value::as_i64)
        .or_else(|| data.get("updatedAt").and_then(Value::as_i64));
    let revision = outer
        .get("revision")
        .and_then(Value::as_str)
        .or_else(|| data.get("revision").and_then(Value::as_str));
    Some(UnwrappedCheckpoint {
        data,
        observed_at,
        revision,
    })
}

impl RuntimeAutomationHostOps {
    fn read_pull_requests(&self) -> PortResult<AutomationReadObservation> {
        let links = self
            .session_meta
            .as_ref()
            .map(|m| m.linked_pull_requests.as_slice())
            .unwrap_or(&[]);
        let mut out = Vec::with_capacity(links.len());
        let mut oldest_observed_at: Option<i64> = None;

        for link in links {
            let parsed = parse_github_pr_url(&link.url);
            let cp_id = pull_request_checkpoint_id(&self.session_id.0, &link.url);
            let cp = self
                .deps
                .automation_store
                .read_source_checkpoint(&self.scope, &cp_id)?;
            let unwrapped = cp.as_ref().and_then(unwrap_source_checkpoint);
            let cp_obj = unwrapped.as_ref().map(|u| u.data);
            let observed_ts = unwrapped.as_ref().and_then(|u| u.observed_at);
            let updated_at = cp_obj
                .and_then(|o| o.get("updatedAt"))
                .and_then(Value::as_i64)
                .or(observed_ts);
            if let Some(ts) = observed_ts.or(updated_at) {
                oldest_observed_at = Some(oldest_observed_at.map_or(ts, |cur| cur.min(ts)));
            }
            let repository = cp_obj
                .and_then(|o| o.get("repository"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| parsed.as_ref().map(|(r, _)| r.clone()));
            let pr_number = cp_obj
                .and_then(|o| o.get("prNumber"))
                .and_then(Value::as_u64)
                .or_else(|| parsed.as_ref().map(|(_, n)| *n));
            let state = cp_obj
                .and_then(|o| o.get("state"))
                .and_then(Value::as_str)
                .unwrap_or(link.status.as_str());
            let merged = cp_obj
                .and_then(|o| o.get("merged"))
                .and_then(Value::as_bool)
                .unwrap_or(link.status == "merged");
            let head_sha = cp_obj
                .and_then(|o| o.get("headSha"))
                .and_then(Value::as_str);

            out.push(json!({
                "url": link.url,
                "linkStatus": link.status,
                "repository": repository,
                "prNumber": pr_number,
                "state": state,
                "merged": merged,
                "headSha": head_sha,
                "updatedAt": updated_at,
            }));
        }

        Ok(AutomationReadObservation {
            value: Value::Array(out),
            observed_at: oldest_observed_at.unwrap_or(self.now_ms),
            evidence: Vec::new(),
        })
    }

    fn read_workflow_runs(&self) -> PortResult<AutomationReadObservation> {
        let links = self
            .session_meta
            .as_ref()
            .map(|m| m.linked_pull_requests.as_slice())
            .unwrap_or(&[]);
        let open_links: Vec<_> = links.iter().filter(|l| l.status == "open").collect();
        if open_links.is_empty() {
            return Ok(AutomationReadObservation {
                value: json!({
                    "status": "unknown",
                    "reason": "no_linked_pull_request",
                }),
                observed_at: self.now_ms,
                evidence: Vec::new(),
            });
        }

        let mut pull_requests = Vec::new();
        let mut evidence = Vec::new();
        let mut oldest_observed_at = self.now_ms;

        for link in open_links {
            let Some((parsed_repo, parsed_num)) = parse_github_pr_url(&link.url) else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                });
            };
            let pr_cp_id = pull_request_checkpoint_id(&self.session_id.0, &link.url);
            let Some(pr_cp) = self
                .deps
                .automation_store
                .read_source_checkpoint(&self.scope, &pr_cp_id)?
            else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                });
            };
            let Some(UnwrappedCheckpoint {
                data: pr_obj,
                observed_at: Some(pr_updated_at),
                ..
            }) = unwrap_source_checkpoint(&pr_cp)
            else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                });
            };
            if self.now_ms.saturating_sub(pr_updated_at) > WORKFLOW_OBSERVATION_FRESHNESS_MS {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: pr_updated_at,
                    evidence: Vec::new(),
                });
            }
            let pr_state = pr_obj
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("open");
            let pr_merged = pr_obj
                .get("merged")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if pr_merged || pr_state != "open" {
                continue;
            }
            let Some(head_sha) = pr_obj
                .get("headSha")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: pr_updated_at,
                    evidence: Vec::new(),
                });
            };
            let repository = pr_obj
                .get("repository")
                .and_then(Value::as_str)
                .unwrap_or(parsed_repo.as_str());
            let pr_number = pr_obj
                .get("prNumber")
                .and_then(Value::as_u64)
                .unwrap_or(parsed_num);

            let wf_source_id = workflow_checkpoint_id(&self.session_id.0, repository, head_sha);
            let Some(wf_cp) = self
                .deps
                .automation_store
                .read_source_checkpoint(&self.scope, &wf_source_id)?
            else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: pr_updated_at,
                    evidence: Vec::new(),
                });
            };
            let Some(UnwrappedCheckpoint {
                data: wf_obj,
                observed_at: Some(wf_updated_at),
                revision: wf_rev,
            }) = unwrap_source_checkpoint(&wf_cp)
            else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: pr_updated_at,
                    evidence: Vec::new(),
                });
            };
            if self.now_ms.saturating_sub(wf_updated_at) > WORKFLOW_OBSERVATION_FRESHNESS_MS {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: wf_updated_at,
                    evidence: Vec::new(),
                });
            }
            if wf_obj.get("headSha").and_then(Value::as_str) != Some(head_sha) {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: wf_updated_at,
                    evidence: Vec::new(),
                });
            }
            if wf_obj.get("gap").is_some_and(|g| !g.is_null()) {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "workflow_coverage_incomplete",
                    }),
                    observed_at: wf_updated_at,
                    evidence: Vec::new(),
                });
            }
            let Some(runs) = wf_obj.get("runs").and_then(Value::as_array) else {
                return Ok(AutomationReadObservation {
                    value: json!({
                        "status": "unknown",
                        "reason": "current_ci_evidence_unavailable",
                    }),
                    observed_at: wf_updated_at,
                    evidence: Vec::new(),
                });
            };
            let revision = wf_rev
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("{head_sha}:{wf_updated_at}"));

            oldest_observed_at = oldest_observed_at.min(pr_updated_at).min(wf_updated_at);
            evidence.push(AutomationEvidenceEntry {
                source_id: wf_source_id,
                revision,
                session_id: self.session_id.0.clone(),
                pr_url: link.url.clone(),
                repository: repository.to_string(),
                head_sha: head_sha.to_string(),
            });
            pull_requests.push(json!({
                "url": link.url,
                "repository": repository,
                "prNumber": pr_number,
                "headSha": head_sha,
                "runs": runs,
            }));
        }

        if pull_requests.is_empty() {
            return Ok(AutomationReadObservation {
                value: json!({
                    "status": "unknown",
                    "reason": "no_linked_pull_request",
                }),
                observed_at: self.now_ms,
                evidence: Vec::new(),
            });
        }

        Ok(AutomationReadObservation {
            value: json!({
                "status": "observed",
                "pullRequests": pull_requests,
            }),
            observed_at: oldest_observed_at,
            evidence,
        })
    }
}

impl AutomationHostOps for RuntimeAutomationHostOps {
    fn read_resource(
        &self,
        resource: &str,
        query: &Value,
    ) -> PortResult<AutomationReadObservation> {
        match resource {
            "session" => {
                ensure_empty_read_params(resource, query)?;
                Ok(AutomationReadObservation {
                    value: self.session_read_json.clone(),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                })
            }
            "session.group" => {
                ensure_empty_read_params(resource, query)?;
                Ok(AutomationReadObservation {
                    value: self.session_group_json.clone(),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                })
            }
            "events" => {
                let (since, limit) = parse_events_read_params(query)?;
                let items = self.deps.automation_store.read_session_events(
                    &self.scope,
                    &self.session_id,
                    since.unwrap_or(0),
                    limit,
                )?;
                Ok(AutomationReadObservation {
                    value: Value::Array(items),
                    observed_at: self.now_ms,
                    evidence: Vec::new(),
                })
            }
            "provider.capacity" => {
                ensure_empty_read_params(resource, query)?;
                let binding_id = self
                    .session_meta
                    .as_ref()
                    .and_then(|m| m.agent_config_id.as_deref());
                let binding_fp = self
                    .session_meta
                    .as_ref()
                    .and_then(|m| m.agent_config_fingerprint.as_deref());
                let snap = match binding_id {
                    Some(bid) if !bid.is_empty() => self
                        .deps
                        .automation_store
                        .read_capacity_snapshot(&self.scope, bid)?,
                    _ => None,
                };
                let (val, observed_at) = evaluate_capacity_observation(
                    snap.as_ref(),
                    binding_id,
                    binding_fp,
                    self.now_ms,
                );
                Ok(AutomationReadObservation {
                    value: val,
                    observed_at,
                    evidence: Vec::new(),
                })
            }
            "github.pullRequests" => {
                ensure_empty_read_params(resource, query)?;
                self.read_pull_requests()
            }
            "github.workflowRuns" => {
                ensure_empty_read_params(resource, query)?;
                self.read_workflow_runs()
            }
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

async fn build_session_read_views(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    session_id: &SessionId,
    now_ms: i64,
) -> (Option<SessionMetaSnapshot>, Value, Value) {
    let meta_opt = runtime
        .deps
        .engine
        .read_session_meta(workspace_id, session_id)
        .ok()
        .flatten();
    let status_json = runtime
        .build_automation_session_snapshot(workspace_id, session_id, now_ms)
        .await;
    let exec_state = status_json
        .get("executionState")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let phase_str = status_json
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("idle");

    let live_paused = match runtime.session_handle(workspace_id, session_id) {
        Some(handle) => handle.inspect_inbox_paused().await.unwrap_or(false),
        None => false,
    };
    let archived = meta_opt
        .as_ref()
        .is_some_and(|m| m.deleted || m.status == SessionRunStatus::Archived);
    let stopped = live_paused || meta_opt.as_ref().is_some_and(|m| m.queue_paused);
    let latest_input = meta_opt
        .as_ref()
        .and_then(|m| m.latest_user_msg_id.as_ref())
        .map(|t| Value::String(t.0.clone()))
        .unwrap_or(Value::Null);
    let last_handled = meta_opt
        .as_ref()
        .and_then(|m| m.last_handled_user_msg_id.as_ref())
        .map(|t| Value::String(t.0.clone()))
        .unwrap_or(Value::Null);

    let session_read = json!({
        "id": session_id.0,
        "latestInputId": latest_input,
        "lastHandledInputId": last_handled,
        "archived": archived,
        "stopped": stopped,
        "executionState": exec_state,
        "phase": phase_str,
    });

    let root_id = meta_opt
        .as_ref()
        .map(|m| m.root_session_id.0.clone())
        .unwrap_or_else(|| session_id.0.clone());
    let queued_pending = meta_opt
        .as_ref()
        .is_some_and(|m| !m.queue_paused && m.queued_count > 0);
    let settled = exec_state == "idle" && !queued_pending;
    let mut group_obj = serde_json::Map::new();
    group_obj.insert("rootSessionId".to_string(), Value::String(root_id));
    group_obj.insert("settled".to_string(), Value::Bool(settled));
    if !settled {
        let reason = if exec_state != "idle" {
            "turn_running"
        } else {
            "queued_input_pending"
        };
        group_obj.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    group_obj.insert(
        "sessions".to_string(),
        Value::Array(vec![session_read.clone()]),
    );

    (meta_opt, session_read, Value::Object(group_obj))
}

#[allow(clippy::too_many_arguments)]
pub async fn tick_workspace_automations(
    runtime: &DaemonRuntime,
    workspace_id: &WorkspaceId,
    managed_runs: &Arc<ManagedRunRegistry>,
    active_checks: &Arc<Mutex<HashSet<String>>>,
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
        {
            let mut guard = active_checks.lock().expect("active checks lock");
            if !guard.insert(candidate.id.clone()) {
                continue;
            }
        }
        let _active_guard = ActiveCheckGuard {
            set: Arc::clone(active_checks),
            wait_id: candidate.id.clone(),
        };

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
        let (session_meta, session_read_json, session_group_json) =
            build_session_read_views(runtime, workspace_id, &claimed.session_id, now_ms).await;
        let command_env = build_sanitized_automation_env(&runtime.deps, &claimed.session_id, None);
        let host_ops: Arc<dyn AutomationHostOps> = Arc::new(RuntimeAutomationHostOps {
            deps: Arc::clone(&runtime.deps),
            scope: scope.clone(),
            session_id: claimed.session_id.clone(),
            now_ms,
            workdir,
            command_env,
            session_meta,
            session_read_json,
            session_group_json,
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

        let Some(owner_uid_str) = receipt
            .rule
            .get("ownerUserId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            runtime.deps.automation_store.update_receipt(
                scope,
                &receipt.id,
                &AutomationReceiptPatch {
                    state: AutomationReceiptState::Blocked,
                    reason: Some("permission_denied".to_string()),
                    turn_id: receipt.turn_id.clone(),
                    attempts: receipt.attempts.saturating_add(1),
                    retry_at: None,
                    now_ms,
                },
            )?;
            continue;
        };
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
                let admitted = match runtime.prepare_host_admitted_turn(
                    &scope.workspace_id,
                    &target_sid,
                    &turn_id,
                    InboxCategory::Automation,
                    owner_uid.clone(),
                    resume_text.clone(),
                    "default".to_string(),
                ) {
                    Ok(input) => input,
                    Err(_) => {
                        runtime.deps.automation_store.update_receipt(
                            scope,
                            &receipt.id,
                            &AutomationReceiptPatch {
                                state: AutomationReceiptState::Waiting,
                                reason: Some("signing_unavailable".to_string()),
                                turn_id: Some(turn_id),
                                attempts: receipt.attempts.saturating_add(1),
                                retry_at: Some(now_ms.saturating_add(SIGNING_RETRY_DELAY_MS)),
                                now_ms,
                            },
                        )?;
                        continue;
                    }
                };

                let _ = runtime.deps.inbox.admit_turn(&admitted)?;

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
    let Ok(mode) = runtime.resolve_workspace_mode(workspace_id) else {
        return TargetSessionGate::TemporarilyUnavailable;
    };

    match runtime
        .deps
        .engine
        .read_session_meta(workspace_id, session_id)
    {
        Ok(Some(meta)) => {
            if meta.deleted || meta.status == SessionRunStatus::Archived {
                return TargetSessionGate::ArchivedOrDeleted;
            }
            if &meta.workspace_id != workspace_id
                || meta.owner_machine_id != runtime.deps.machine_id
                || &meta.owner_user_id != owner_user_id
            {
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
            if !matches!(mode, WorkspaceSecurityMode::Plaintext) || workspace_id.0 != "local" {
                return TargetSessionGate::TemporarilyUnavailable;
            }
            let Some(handle) = runtime.session_handle(workspace_id, session_id) else {
                return TargetSessionGate::TemporarilyUnavailable;
            };
            match handle.inspect_driving_user().await {
                Ok(Some(ref uid)) if uid == owner_user_id => {}
                Ok(Some(_)) => return TargetSessionGate::PermissionDenied,
                _ => return TargetSessionGate::TemporarilyUnavailable,
            }
        }
        Err(err)
            if err.kind == PortErrorKind::Unavailable
                && !runtime.deps.engine.is_connected()
                && matches!(mode, WorkspaceSecurityMode::Plaintext)
                && workspace_id.0 == "local" =>
        {
            let Some(handle) = runtime.session_handle(workspace_id, session_id) else {
                return TargetSessionGate::TemporarilyUnavailable;
            };
            match handle.inspect_driving_user().await {
                Ok(Some(ref uid)) if uid == owner_user_id => {}
                Ok(Some(_)) => return TargetSessionGate::PermissionDenied,
                _ => return TargetSessionGate::TemporarilyUnavailable,
            }
        }
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
