use crate::ipc::LocalIpcClient;
use crate::sandbox::{ConformanceSandbox, TargetBinary};
use crate::summary::{
    BusinessOutcome, ProjectBusinessSummary, SessionBusinessSummary, assert_business_equivalent,
    normalize_history_payload,
};
use serde_json::{Value, json};
use std::path::Path;
use std::time::{Duration, Instant};

pub fn run_all_business_scenarios(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<Vec<BusinessOutcome>, String> {
    Ok(vec![
        scenario_project_and_multi_turn_conversation(target, scripted_acp_bin)?,
        scenario_stop_active_turn_and_preserve_paused_queue(target, scripted_acp_bin)?,
        scenario_permission_allow_and_reject(target, scripted_acp_bin)?,
        scenario_crash_containment(target, scripted_acp_bin)?,
        scenario_worktree_isolated_edit_and_archive(target, scripted_acp_bin)?,
        scenario_builtin_mcp_mount(target, scripted_acp_bin)?,
    ])
}

pub fn run_differential_suite(
    baseline: &TargetBinary,
    candidate: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<(), String> {
    let baseline_outcomes = run_all_business_scenarios(baseline, scripted_acp_bin)?;
    let candidate_outcomes = run_all_business_scenarios(candidate, scripted_acp_bin)?;
    for (left, right) in baseline_outcomes.iter().zip(candidate_outcomes.iter()) {
        assert_business_equivalent(left, right);
    }
    Ok(())
}

pub fn run_shared_data_dir_handoff(
    node_target: &TargetBinary,
    rust_target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<SessionBusinessSummary, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;

    let ipc_a = sandbox.start_daemon(node_target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc_a)?;
    let project_id = register_project(&sandbox, node_target)?;

    let session_id = "00000000-0000-4000-8000-000000000101";
    create_custom_acp_session(
        &ipc_a,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        Some(&project_id),
        false,
        "turn-handoff-1",
        "[SCRIPTED:REPLY:Reply from Node turn 1] [MARK:handoff-1]",
    )?;
    let _ = wait_for_settled_turn(&sandbox, node_target, session_id, 1)?;
    sandbox.stop_daemon()?;

    let ipc_b = sandbox.start_daemon(rust_target)?;
    send_custom_acp_chat(
        &ipc_b,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        "turn-handoff-2",
        "[SCRIPTED:REPLY:Reply from Rust turn 2] [MARK:handoff-2]",
    )?;
    let _ = wait_for_settled_turn(&sandbox, rust_target, session_id, 2)?;
    sandbox.stop_daemon()?;

    let _ipc_c = sandbox.start_daemon(node_target)?;
    let history = read_session_history_cli(&sandbox, node_target, session_id)?;
    let summary = normalize_history_payload(&history, Some("idle".to_string()), false, Vec::new());
    if summary.turns.len() < 4 {
        return Err(format!(
            "expected 4 entries (2 user + 2 assistant) after Node->Rust->Node handoff, got: {:?}",
            summary
        ));
    }
    Ok(summary)
}

pub fn scenario_project_and_multi_turn_conversation(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;
    let project_id = register_project(&sandbox, target)?;

    let session_id = "00000000-0000-4000-8000-000000000001";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        Some(&project_id),
        false,
        "turn-1",
        "[SCRIPTED:REPLY:First turn answer] [MARK:turn-1]",
    )?;
    let _ = wait_for_settled_turn(&sandbox, target, session_id, 1)?;

    send_custom_acp_chat(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        "turn-2",
        "[SCRIPTED:REPLY:Second turn answer] [MARK:turn-2]",
    )?;
    let history = wait_for_settled_turn(&sandbox, target, session_id, 2)?;
    let summary = normalize_history_payload(&history, Some("idle".to_string()), false, Vec::new());

    Ok(BusinessOutcome {
        scenario: "project_and_multi_turn_conversation".to_string(),
        projects: vec![ProjectBusinessSummary {
            name: "synthetic-repo".to_string(),
            exists: true,
        }],
        sessions: vec![summary],
    })
}

pub fn scenario_stop_active_turn_and_preserve_paused_queue(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;
    let barrier = sandbox
        .create_barrier_dir("hold-stop")
        .map_err(|e| format!("barrier: {e}"))?;

    let session_id = "00000000-0000-4000-8000-000000000002";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        None,
        false,
        "turn-hold-1",
        &format!("[SCRIPTED:HOLD:{}] [MARK:hold-1]", barrier.display()),
    )?;

    sandbox
        .wait_for_barrier(&barrier, Duration::from_secs(15))
        .map_err(|e| format!("wait barrier: {e}"))?;

    let cancel_res = ipc
        .session_control(&json!({
            "type": "session/cancel",
            "sessionId": session_id,
            "machineId": machine_id,
            "workspaceId": workspace_id,
            "turnId": "assistant:turn-hold-1",
            "cancelId": "00000000-0000-4000-8000-000000000999",
            "pauseInbox": true
        }))
        .map_err(|e| format!("session/cancel failed: {e}"))?;
    if cancel_res.is_empty() {
        return Err("expected cancel_response from control socket".to_string());
    }

    let history = wait_for_turn_terminal_status(&sandbox, target, session_id, "canceled")?;
    let summary =
        normalize_history_payload(&history, Some("canceled".to_string()), false, Vec::new());

    Ok(BusinessOutcome {
        scenario: "stop_active_turn".to_string(),
        projects: Vec::new(),
        sessions: vec![summary],
    })
}

pub fn scenario_permission_allow_and_reject(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;

    let session_id = "00000000-0000-4000-8000-000000000006";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        None,
        false,
        "turn-perm-1",
        "[SCRIPTED:PERMISSION:Approve edit] [MARK:perm-1]",
    )?;

    let req_id = wait_for_pending_permission_request(&sandbox, target, session_id)?;
    let _ = ipc
        .session_control(&json!({
            "type": "session/permission_response",
            "sessionId": session_id,
            "requestId": req_id,
            "outcome": { "outcome": "selected", "optionId": "allow-once" }
        }))
        .map_err(|e| format!("permission_response IPC failed: {e}"))?;

    let history = wait_for_settled_turn(&sandbox, target, session_id, 1)?;
    let summary = normalize_history_payload(&history, Some("idle".to_string()), false, Vec::new());

    Ok(BusinessOutcome {
        scenario: "permission_allow_and_reject".to_string(),
        projects: Vec::new(),
        sessions: vec![summary],
    })
}

pub fn scenario_crash_containment(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;

    let session_id = "00000000-0000-4000-8000-000000000003";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        None,
        false,
        "turn-crash-1",
        "[SCRIPTED:CRASH] [MARK:crash-1]",
    )?;

    let history = wait_for_turn_terminal_status(&sandbox, target, session_id, "failed")?;
    let health = ipc
        .probe_health()
        .map_err(|e| format!("daemon died on agent crash: {e}"))?;
    if health.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!("daemon unhealthy after agent crash: {health}"));
    }

    let summary =
        normalize_history_payload(&history, Some("failed".to_string()), false, Vec::new());
    Ok(BusinessOutcome {
        scenario: "crash_containment".to_string(),
        projects: Vec::new(),
        sessions: vec![summary],
    })
}

pub fn scenario_worktree_isolated_edit_and_archive(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;
    let project_id = register_project(&sandbox, target)?;

    let session_id = "00000000-0000-4000-8000-000000000004";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        Some(&project_id),
        true,
        "turn-wt-1",
        "[SCRIPTED:EDIT:feature.txt:isolated worktree change] [MARK:wt-1]",
    )?;

    let history = wait_for_settled_turn(&sandbox, target, session_id, 1)?;
    let root_untouched = !sandbox.project_dir.join("feature.txt").exists();
    if !root_untouched {
        return Err("worktree session leaked edits into original project root".to_string());
    }

    let archive_out = sandbox
        .run_cli(target, &["session", "archive", session_id, "--json"])
        .map_err(|e| format!("session archive invoke: {e}"))?;
    if archive_out.status_code != 0 {
        return Err(format!(
            "session archive failed: stdout={} stderr={}",
            archive_out.stdout, archive_out.stderr
        ));
    }

    let summary = normalize_history_payload(
        &history,
        Some("idle".to_string()),
        true,
        vec!["feature.txt".to_string()],
    );

    Ok(BusinessOutcome {
        scenario: "worktree_isolated_edit_and_archive".to_string(),
        projects: vec![ProjectBusinessSummary {
            name: "synthetic-repo".to_string(),
            exists: true,
        }],
        sessions: vec![summary],
    })
}

pub fn scenario_builtin_mcp_mount(
    target: &TargetBinary,
    scripted_acp_bin: &Path,
) -> Result<BusinessOutcome, String> {
    let mut sandbox = ConformanceSandbox::new(scripted_acp_bin.to_path_buf())
        .map_err(|e| format!("sandbox init: {e}"))?;
    let ipc = sandbox.start_daemon(target)?;
    let (workspace_id, machine_id) = discover_local_identity(&sandbox, &ipc)?;

    let session_id = "00000000-0000-4000-8000-000000000005";
    create_custom_acp_session(
        &ipc,
        &sandbox,
        &workspace_id,
        &machine_id,
        session_id,
        None,
        false,
        "turn-mcp-1",
        "[SCRIPTED:MCP_INFO] [MARK:mcp-1]",
    )?;

    let history = wait_for_settled_turn(&sandbox, target, session_id, 1)?;
    let summary = normalize_history_payload(&history, Some("idle".to_string()), false, Vec::new());

    Ok(BusinessOutcome {
        scenario: "builtin_mcp_mount".to_string(),
        projects: Vec::new(),
        sessions: vec![summary],
    })
}

fn discover_local_identity(
    sandbox: &ConformanceSandbox,
    ipc: &LocalIpcClient,
) -> Result<(String, String), String> {
    let health = ipc
        .probe_health()
        .map_err(|e| format!("probe_health: {e}"))?;
    let machine_id = health
        .get("machineId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing machineId in health: {health}"))?
        .to_string();

    let catalog_path = sandbox.data_dir.join("workspace-catalog.json");
    let raw = std::fs::read_to_string(&catalog_path)
        .map_err(|e| format!("failed reading {:?}: {e}", catalog_path))?;
    let catalog: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid workspace-catalog.json: {e}"))?;
    let workspace_id = catalog
        .get("workspaces")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|w| w.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no local workspace in catalog: {catalog}"))?
        .to_string();

    Ok((workspace_id, machine_id))
}

fn register_project(sandbox: &ConformanceSandbox, target: &TargetBinary) -> Result<String, String> {
    let repo_str = sandbox.project_dir.to_string_lossy().into_owned();
    let out = sandbox
        .run_cli(target, &["project", "add", &repo_str, "--json"])
        .map_err(|e| format!("project add invoke: {e}"))?;
    if out.status_code != 0 {
        return Err(format!(
            "project add failed ({}): {} {}",
            out.status_code, out.stdout, out.stderr
        ));
    }
    let parsed = out.parse_json()?;
    parsed
        .get("result")
        .and_then(|r| r.get("localProjectId").or_else(|| r.get("id")))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing localProjectId in project add output: {parsed}"))
}

#[allow(clippy::too_many_arguments)]
fn create_custom_acp_session(
    ipc: &LocalIpcClient,
    sandbox: &ConformanceSandbox,
    workspace_id: &str,
    machine_id: &str,
    session_id: &str,
    local_project_id: Option<&str>,
    use_worktree: bool,
    user_turn_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let mut req = json!({
        "type": "session/create",
        "sessionId": session_id,
        "machineId": machine_id,
        "workspaceId": workspace_id,
        "userTurnId": user_turn_id,
        "userId": "local:owner",
        "userName": "Local Owner",
        "userEmail": "local@lody.invalid",
        "acpSessionConfig": {
            "prompt": prompt,
            "cliType": "custom",
            "agentType": "scripted-conformance",
            "customAcp": {
                "command": sandbox.scripted_acp_bin.to_string_lossy(),
                "args": [sandbox.acp_event_log.to_string_lossy()]
            }
        }
    });
    if let Some(pid) = local_project_id {
        req["project"] = json!({
            "kind": "local",
            "localProjectId": pid,
            "useWorktree": use_worktree
        });
    }
    let responses = ipc
        .session_control(&req)
        .map_err(|e| format!("session/create IPC failed: {e}"))?;
    if responses.is_empty() {
        return Err("session/create returned no IPC frames".to_string());
    }
    Ok(())
}

fn send_custom_acp_chat(
    ipc: &LocalIpcClient,
    sandbox: &ConformanceSandbox,
    workspace_id: &str,
    machine_id: &str,
    session_id: &str,
    user_turn_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let req = json!({
        "type": "session/chat",
        "sessionId": session_id,
        "machineId": machine_id,
        "workspaceId": workspace_id,
        "userTurnId": user_turn_id,
        "userId": "local:owner",
        "userName": "Local Owner",
        "userEmail": "local@lody.invalid",
        "acpSessionConfig": {
            "prompt": prompt,
            "cliType": "custom",
            "agentType": "scripted-conformance",
            "customAcp": {
                "command": sandbox.scripted_acp_bin.to_string_lossy(),
                "args": [sandbox.acp_event_log.to_string_lossy()]
            }
        }
    });
    let responses = ipc
        .session_control(&req)
        .map_err(|e| format!("session/chat IPC failed: {e}"))?;
    if responses.is_empty() {
        return Err("session/chat returned no IPC frames".to_string());
    }
    Ok(())
}

fn read_session_history_cli(
    sandbox: &ConformanceSandbox,
    target: &TargetBinary,
    session_id: &str,
) -> Result<Value, String> {
    let out = sandbox
        .run_cli(
            target,
            &["session", "history", session_id, "--offline", "--json"],
        )
        .map_err(|e| format!("session history invoke: {e}"))?;
    if out.status_code != 0 {
        return Err(format!(
            "session history failed ({}): {} {}",
            out.status_code, out.stdout, out.stderr
        ));
    }
    out.parse_json()
}

fn wait_for_settled_turn(
    sandbox: &ConformanceSandbox,
    target: &TargetBinary,
    session_id: &str,
    expected_completed_turns: usize,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = json!({});
    while Instant::now() < deadline {
        if let Ok(hist) = read_session_history_cli(sandbox, target, session_id) {
            let summary = normalize_history_payload(&hist, None, false, Vec::new());
            let completed_assistants = summary
                .turns
                .iter()
                .filter(|t| t.role == "assistant" && t.finished == Some(true))
                .count();
            if completed_assistants >= expected_completed_turns {
                return Ok(hist);
            }
            last = hist;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "timed out waiting for {expected_completed_turns} settled assistant turns in {session_id}; last={last}"
    ))
}

fn wait_for_turn_terminal_status(
    sandbox: &ConformanceSandbox,
    target: &TargetBinary,
    session_id: &str,
    expected_user_status: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = json!({});
    while Instant::now() < deadline {
        if let Ok(hist) = read_session_history_cli(sandbox, target, session_id) {
            let summary = normalize_history_payload(&hist, None, false, Vec::new());
            if summary
                .turns
                .iter()
                .any(|t| t.role == "user" && t.status.as_deref() == Some(expected_user_status))
            {
                return Ok(hist);
            }
            last = hist;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "timed out waiting for user turn status '{expected_user_status}' in {session_id}; last={last}"
    ))
}

fn wait_for_pending_permission_request(
    sandbox: &ConformanceSandbox,
    target: &TargetBinary,
    session_id: &str,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(hist) = read_session_history_cli(sandbox, target, session_id)
            && let Some(entries) = hist.get("items").and_then(Value::as_array)
        {
            for entry in entries {
                if let Some(items) = entry.get("items").and_then(Value::as_array) {
                    for item in items {
                        if let Some(req_id) = item
                            .get("permissionRequestId")
                            .or_else(|| item.get("requestId"))
                            .and_then(Value::as_str)
                        {
                            return Ok(req_id.to_string());
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "timed out waiting for pending permission request in {session_id}"
    ))
}
