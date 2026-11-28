use lody_entry::{
    DaemonRunMetadata, find_peer_uid_in_proc_net_tcp, resolve_terminal_socket_path, send_unix_http,
};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn build_workspace_binary(pkg: &str, bin_stem: &str) -> PathBuf {
    let workspace_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root");
    let bin_name = if cfg!(windows) {
        format!("{bin_stem}.exe")
    } else {
        bin_stem.to_string()
    };
    let bin_path = workspace_dir.join("target").join("debug").join(bin_name);
    let status = Command::new(env!("CARGO"))
        .current_dir(&workspace_dir)
        .args(["build", "-p", pkg])
        .status()
        .expect("cargo build");
    assert!(status.success());
    bin_path
}

struct DaemonGuard {
    child: Child,
    data_dir: PathBuf,
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Some(meta) = DaemonRunMetadata::read(&self.data_dir) {
            let _ = send_unix_http(
                Path::new(&meta.control_socket_path),
                "POST",
                "/daemon-shutdown",
                meta.token.as_deref(),
                Some(&json!({})),
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn proc_net_tcp_four_tuple_rejects_different_loopback_ip_spoofing_same_port() {
    let table = concat!(
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
        "   0: 0200007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 12345\n",
        "   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 12346\n",
    );
    let peer_127_1 = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
    let peer_127_3 = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 3));
    let server = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));

    assert_eq!(
        find_peer_uid_in_proc_net_tcp(table, peer_127_1, 50000, server, 8080),
        Some(1000)
    );
    assert_eq!(
        find_peer_uid_in_proc_net_tcp(table, peer_127_3, 50000, server, 8080),
        None
    );
}

#[cfg(unix)]
#[test]
fn live_daemon_enforces_mcp_http_guards_delegates_child_and_caps_terminal_socket_buffer() {
    use std::os::unix::net::UnixStream;

    let lody_bin = build_workspace_binary("lody", "lody");
    let acp_bin = build_workspace_binary("lody-scripted-acp", "lody-scripted-acp");

    let sandbox = tempfile::tempdir().unwrap();
    let data_dir = sandbox.path().join("d");
    let home_dir = sandbox.path().join("h");
    fs::create_dir_all(&data_dir).unwrap();
    fs::create_dir_all(&home_dir).unwrap();

    let restore_out = Command::new(&lody_bin)
        .args(["machine", "restore-id", "machine-e2e-fixed", "--json"])
        .env("LODY_DATA_DIR", &data_dir)
        .env("HOME", &home_dir)
        .env("LODY_PLATFORM", "local")
        .output()
        .expect("run machine restore-id");
    assert!(restore_out.status.success());
    let restore_json: Value = serde_json::from_slice(&restore_out.stdout).unwrap();
    assert_eq!(restore_json["ok"], true);
    assert_eq!(restore_json["targetMachineId"], "machine-e2e-fixed");

    let event_log = sandbox.path().join("acp-events.jsonl");

    let child = Command::new(&lody_bin)
        .args(["daemon", "run"])
        .env("LODY_DATA_DIR", &data_dir)
        .env("HOME", &home_dir)
        .env("LODY_PLATFORM", "local")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lody daemon");
    let _guard = DaemonGuard {
        child,
        data_dir: data_dir.clone(),
    };

    let deadline = Instant::now() + Duration::from_secs(10);
    let meta = loop {
        if let Some(m) = lody_entry::probe_live_daemon(&data_dir) {
            break m;
        }
        assert!(Instant::now() < deadline, "daemon did not become ready");
        std::thread::yield_now();
    };

    let (probe_status, probe_body) = send_unix_http(
        Path::new(&meta.socket_path),
        "GET",
        "/state",
        meta.token.as_deref(),
        None,
    )
    .unwrap();
    assert_eq!(probe_status, 200);
    let probe_json: Value = serde_json::from_str(&probe_body).unwrap();
    assert_eq!(probe_json["machineId"], "machine-e2e-fixed");
    assert_eq!(
        probe_json["protocolCapabilities"]["localProjectFileSearch"],
        true
    );

    let (git_status_code, git_status_body) = send_unix_http(
        Path::new(&meta.control_socket_path),
        "POST",
        "/project-control",
        meta.token.as_deref(),
        Some(&json!({
            "type": "local-project/git-state",
            "machineId": "machine-e2e-fixed",
            "workspaceId": "local",
            "localProjectId": "proj-registered-1"
        })),
    )
    .unwrap();
    assert_eq!(git_status_code, 200);
    let git_status_json: Value = serde_json::from_str(&git_status_body).unwrap();
    assert_eq!(git_status_json["ok"], false);
    assert_eq!(git_status_json["type"], "local-project/git-state");
    assert_eq!(git_status_json["error"], "daemon_unavailable");

    let (mismatch_code, mismatch_body) = send_unix_http(
        Path::new(&meta.control_socket_path),
        "POST",
        "/project-control",
        meta.token.as_deref(),
        Some(&json!({
            "type": "local-project/git-state",
            "machineId": "foreign-machine",
            "workspaceId": "local",
            "localProjectId": "proj-registered-1"
        })),
    )
    .unwrap();
    assert_eq!(mismatch_code, 200);
    let mismatch_json: Value = serde_json::from_str(&mismatch_body).unwrap();
    assert_eq!(mismatch_json["ok"], false);
    assert_eq!(mismatch_json["error"], "machine_mismatch");

    let term_sock = resolve_terminal_socket_path(&data_dir, "lody-oss").unwrap();
    {
        let mut s = UnixStream::connect(&term_sock).expect("connect terminal.sock");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let oversized = "x".repeat(1024 * 1024 + 64);
        s.write_all(oversized.as_bytes()).unwrap();
        let _ = s.flush();
        let mut rdr = BufReader::new(s);
        let mut err_line = String::new();
        rdr.read_line(&mut err_line).unwrap();
        let parsed: Value = serde_json::from_str(&err_line).unwrap();
        assert_eq!(parsed["code"], "payload_too_large");
    }

    let (status, body) = send_unix_http(
        Path::new(&meta.control_socket_path),
        "POST",
        "/session-control",
        meta.token.as_deref(),
        Some(&json!({
            "type": "session/create",
            "workspaceId": "local",
            "sessionId": "parent-sess-1",
            "userTurnId": "turn-p1",
            "acpSessionConfig": {
                "cliType": "custom",
                "customAcp": {
                    "command": acp_bin,
                    "args": [&event_log],
                },
                "prompt": "[SCRIPTED:MCP_DELEGATE:[SCRIPTED:MCP_DELEGATE:forbidden-grandchild]]"
            }
        })),
    )
    .unwrap();
    assert_eq!(status, 200);
    assert!(body.contains("session/create_response"));

    let wait_until = Instant::now() + Duration::from_secs(10);
    let mut saw_accepted_child = false;
    let mut saw_rejected_grandchild = false;
    let mut saw_schedule_unavailable = false;
    let mut saw_parent_receipt_wakeup = false;

    while Instant::now() < wait_until {
        if let Ok(raw) = fs::read_to_string(&event_log) {
            let events: Vec<Value> = raw
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            saw_accepted_child = events.iter().any(|e| {
                e.get("event").and_then(Value::as_str) == Some("mcp-delegate")
                    && e.get("outcome")
                        .and_then(Value::as_str)
                        .is_some_and(|o| o.starts_with("accepted:"))
            });
            saw_rejected_grandchild = events.iter().any(|e| {
                e.get("event").and_then(Value::as_str) == Some("mcp-delegate")
                    && e.get("outcome")
                        .and_then(Value::as_str)
                        .is_some_and(|o| o.starts_with("rejected:"))
            });
            saw_schedule_unavailable = events.iter().any(|e| {
                e.get("event").and_then(Value::as_str) == Some("mcp-schedule")
                    && e.get("outcome")
                        .and_then(Value::as_str)
                        .is_some_and(|o| o.starts_with("rejected:") && o.contains("UNAVAILABLE"))
            });
            let parent_prompt_count = events
                .iter()
                .filter(|e| {
                    e.get("event").and_then(Value::as_str) == Some("prompt-end")
                        && e.get("mode").and_then(Value::as_str) == Some("reply")
                })
                .count();
            saw_parent_receipt_wakeup = parent_prompt_count >= 1;
            if saw_accepted_child
                && saw_rejected_grandchild
                && saw_schedule_unavailable
                && saw_parent_receipt_wakeup
            {
                break;
            }
        }
        std::thread::yield_now();
    }

    assert!(saw_accepted_child, "parent MCP delegation should succeed");
    assert!(
        saw_rejected_grandchild,
        "child depth=1 MCP delegation to grandchild must be rejected"
    );
    assert!(
        saw_schedule_unavailable,
        "lody_schedule must report UNAVAILABLE instead of fake local success while engine is unwired"
    );
    assert!(
        saw_parent_receipt_wakeup,
        "parent session must automatically wake with child completion receipt batch"
    );
}

#[cfg(unix)]
#[test]
fn live_daemon_mounts_mcp_stdio_fallback_and_serves_desktop_project_control_routes() {
    let lody_bin = build_workspace_binary("lody", "lody");
    let acp_bin = build_workspace_binary("lody-scripted-acp", "lody-scripted-acp");

    let sandbox = tempfile::tempdir().unwrap();
    let data_dir = sandbox.path().join("d-stdio");
    let home_dir = sandbox.path().join("h-stdio");
    let browse_base = home_dir.join("projects");
    fs::create_dir_all(&data_dir).unwrap();
    fs::create_dir_all(&browse_base).unwrap();

    let global_skill_dir = home_dir.join(".agents/skills/global-helper");
    fs::create_dir_all(&global_skill_dir).unwrap();
    fs::write(
        global_skill_dir.join("SKILL.md"),
        "---\nname: global-helper\ndescription: Global skill\n---\nGlobal skill body.\n",
    )
    .unwrap();

    let event_log = sandbox.path().join("stdio-acp-events.jsonl");

    let child = Command::new(&lody_bin)
        .args(["daemon", "run"])
        .env("LODY_DATA_DIR", &data_dir)
        .env("HOME", &home_dir)
        .env("LODY_PLATFORM", "local")
        .env("LODY_MCP_HTTP_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stdio-only lody daemon");
    let _guard = DaemonGuard {
        child,
        data_dir: data_dir.clone(),
    };

    let deadline = Instant::now() + Duration::from_secs(10);
    let meta = loop {
        if let Some(m) = lody_entry::probe_live_daemon(&data_dir) {
            break m;
        }
        assert!(
            Instant::now() < deadline,
            "stdio daemon did not become ready"
        );
        std::thread::yield_now();
    };
    let control_sock = Path::new(&meta.control_socket_path);
    let tok = meta.token.as_deref();

    let (_, roots_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({ "type": "local-project/list-roots" })),
    )
    .unwrap();
    let roots_json: Value = serde_json::from_str(&roots_body).unwrap();
    assert_eq!(roots_json["ok"], true);
    assert!(roots_json["result"]["homeDir"].as_str().is_some());

    let (_, mkdir_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({
            "type": "local-project/create-directory",
            "parentPath": browse_base,
            "name": "created-app",
        })),
    )
    .unwrap();
    let mkdir_json: Value = serde_json::from_str(&mkdir_body).unwrap();
    assert_eq!(mkdir_json["ok"], true);
    let created_path = PathBuf::from(mkdir_json["result"]["path"].as_str().unwrap());
    fs::write(created_path.join("hello.txt"), "hello desktop ipc\n").unwrap();

    let (_, dup_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({
            "type": "local-project/create-directory",
            "parentPath": browse_base,
            "name": "created-app",
        })),
    )
    .unwrap();
    let dup_json: Value = serde_json::from_str(&dup_body).unwrap();
    assert_eq!(dup_json["ok"], false);
    assert_eq!(dup_json["error"], "already_exists");

    let (_, browse_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({
            "type": "local-project/browse-dir",
            "absolutePath": browse_base,
        })),
    )
    .unwrap();
    let browse_json: Value = serde_json::from_str(&browse_body).unwrap();
    assert_eq!(browse_json["ok"], true);
    assert_eq!(browse_json["result"]["entries"][0]["name"], "created-app");

    let (_, prep_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({
            "type": "local-project/prepare-add",
            "rootPath": created_path,
            "inspect": true,
        })),
    )
    .unwrap();
    let prep_json: Value = serde_json::from_str(&prep_body).unwrap();
    assert_eq!(prep_json["ok"], true);
    assert!(
        prep_json["result"]["localProjectId"]
            .as_str()
            .unwrap()
            .starts_with("local-project-")
    );
    assert_eq!(prep_json["result"]["inspection"]["git"], false);

    let (_, read_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({
            "type": "local-project/read-file",
            "workspaceId": "local",
            "rootPath": created_path,
            "relativePath": "hello.txt",
        })),
    )
    .unwrap();
    let read_json: Value = serde_json::from_str(&read_body).unwrap();
    assert_eq!(read_json["ok"], true);
    assert_eq!(read_json["result"]["content"], "hello desktop ipc\n");

    let (_, gskills_body) = send_unix_http(
        control_sock,
        "POST",
        "/project-control",
        tok,
        Some(&json!({ "type": "local-project/list-global-skills" })),
    )
    .unwrap();
    let gskills_json: Value = serde_json::from_str(&gskills_body).unwrap();
    assert_eq!(gskills_json["ok"], true);
    assert_eq!(
        gskills_json["result"]["groups"][0]["skills"][0]["name"],
        "global-helper"
    );

    let (status, sess_body) = send_unix_http(
        control_sock,
        "POST",
        "/session-control",
        tok,
        Some(&json!({
            "type": "session/create",
            "workspaceId": "local",
            "sessionId": "stdio-parent-1",
            "userTurnId": "turn-stdio-1",
            "acpSessionConfig": {
                "cliType": "custom",
                "customAcp": {
                    "command": acp_bin,
                    "args": [&event_log],
                },
                "prompt": "[SCRIPTED:MCP_DELEGATE:[SCRIPTED:REPLY:child-via-mcp-stdio]]"
            }
        })),
    )
    .unwrap();
    assert_eq!(status, 200);
    assert!(sess_body.contains("session/create_response"));

    let wait_until = Instant::now() + Duration::from_secs(10);
    let mut saw_stdio_delegation = false;
    let mut saw_parent_wakeup = false;
    while Instant::now() < wait_until {
        if let Ok(raw) = fs::read_to_string(&event_log) {
            let events: Vec<Value> = raw
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            saw_stdio_delegation = events.iter().any(|e| {
                e.get("event").and_then(Value::as_str) == Some("mcp-delegate")
                    && e.get("outcome")
                        .and_then(Value::as_str)
                        .is_some_and(|o| o.starts_with("accepted:"))
            });
            let reply_ends = events
                .iter()
                .filter(|e| {
                    e.get("event").and_then(Value::as_str) == Some("prompt-end")
                        && e.get("mode").and_then(Value::as_str) == Some("reply")
                })
                .count();
            saw_parent_wakeup = reply_ends >= 2;
            if saw_stdio_delegation && saw_parent_wakeup {
                break;
            }
        }
        std::thread::yield_now();
    }
    assert!(
        saw_stdio_delegation,
        "LODY_MCP_HTTP_DISABLED=1 must fall back to lody mcp-stdio without StorageLease contention"
    );
    assert!(
        saw_parent_wakeup,
        "child delegated through lody mcp-stdio must wake parent with completion receipt"
    );

    let marker_file = home_dir.join("automation-ready.txt");
    let (auto_status, auto_reg_body) = send_unix_http(
        control_sock,
        "POST",
        "/automation-control",
        tok,
        Some(&json!({
            "machineId": meta.version,
            "workspaceId": "local",
            "requesterSessionId": "stdio-parent-1",
            "command": { "type": "list" }
        })),
    )
    .unwrap();
    assert_eq!(auto_status, 403);
    assert!(auto_reg_body.contains("AUTOMATION_MACHINE_MISMATCH"));

    let (_, state_body) =
        send_unix_http(Path::new(&meta.socket_path), "GET", "/state", tok, None).unwrap();
    let state_json: Value = serde_json::from_str(&state_body).unwrap();
    let live_machine_id = state_json["machineId"].as_str().unwrap().to_string();

    let (reg_status, reg_body) = send_unix_http(
        control_sock,
        "POST",
        "/automation-control",
        tok,
        Some(&json!({
            "machineId": live_machine_id,
            "workspaceId": "local",
            "requesterSessionId": "stdio-parent-1",
            "command": {
                "type": "register",
                "intervalMs": 1000,
                "reason": "resume when marker file appears",
                "program": "async ({ ctx }) => { const out = await ctx.exec('/bin/ls', ['automation-ready.txt']); if (out.exitCode === 0) { return { resumeText: '[MARK:resumed-by-quickjs-automation] [SCRIPTED:REPLY:done]', payload: { ok: true } }; } return false; }"
            }
        })),
    )
    .unwrap();
    assert_eq!(reg_status, 200);
    let reg_json: Value = serde_json::from_str(&reg_body).unwrap();
    assert_eq!(reg_json["ok"], true, "register response: {reg_body}");
    let registered_wait_id = reg_json["result"]["id"].as_str().unwrap().to_string();

    fs::write(&marker_file, "ready\n").unwrap();

    let auto_deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_automation_turn = false;
    while Instant::now() < auto_deadline {
        let (_, show_body) = send_unix_http(
            control_sock,
            "POST",
            "/automation-control",
            tok,
            Some(&json!({
                "machineId": live_machine_id,
                "workspaceId": "local",
                "requesterSessionId": "stdio-parent-1",
                "command": { "type": "show", "id": registered_wait_id }
            })),
        )
        .unwrap();
        if let Ok(show_val) = serde_json::from_str::<Value>(&show_body)
            && show_val["result"]["state"] == "matched"
            && show_val["result"]["continuation"]["state"] == "completed"
            && let Ok(raw_events) = fs::read_to_string(&event_log)
            && raw_events.contains("resumed-by-quickjs-automation")
        {
            saw_automation_turn = true;
            break;
        }
        std::thread::yield_now();
    }
    assert!(
        saw_automation_turn,
        "QuickJS automation condition must match in background supervisor and resume session turn"
    );
}
