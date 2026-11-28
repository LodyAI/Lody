use lody_conformance::{
    LocalIpcClient, TargetBinary, run_all_business_scenarios, run_differential_suite,
    run_shared_data_dir_handoff,
};
use lody_scripted_acp::RecordedAcpEvent;
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

fn scripted_acp_binary() -> PathBuf {
    static BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        let workspace_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("workspace root");
        let bin_name = if cfg!(windows) {
            "lody-scripted-acp.exe"
        } else {
            "lody-scripted-acp"
        };
        let bin_path = workspace_dir.join("target").join("debug").join(bin_name);
        if !bin_path.exists() {
            let status = Command::new(env!("CARGO"))
                .current_dir(&workspace_dir)
                .args(["build", "-p", "lody-scripted-acp"])
                .status()
                .expect("build lody-scripted-acp");
            assert!(status.success(), "building lody-scripted-acp failed");
        }
        assert!(bin_path.exists(), "expected binary at {:?}", bin_path);
        bin_path
    })
    .clone()
}

#[test]
fn scripted_acp_binary_handles_permission_and_barrier_hold_over_process_stdio() {
    let bin = scripted_acp_binary();
    let temp = tempfile::tempdir().unwrap();
    let event_log = temp.path().join("acp-events.jsonl");
    let barrier = temp.path().join("hold-barrier");

    let mut child = Command::new(&bin)
        .arg(&event_log)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn lody-scripted-acp");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } })
    )
    .unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let init_resp: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init_resp["id"], 1);

    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": temp.path(), "mcpServers": [{ "name": "lody" }] } })
    )
    .unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let new_resp: Value = serde_json::from_str(&line).unwrap();
    let session_id = new_resp["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "[SCRIPTED:PERMISSION:Approve edit]" }]
            }
        })
    )
    .unwrap();
    stdin.flush().unwrap();

    loop {
        line.clear();
        stdout.read_line(&mut line).unwrap();
        let msg: Value = serde_json::from_str(&line).unwrap();
        if msg.get("method").and_then(Value::as_str) == Some("session/request_permission") {
            let req_id = msg.get("id").cloned().unwrap();
            writeln!(
                stdin,
                "{}",
                json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } }
                })
            )
            .unwrap();
            stdin.flush().unwrap();
        } else if msg.get("id") == Some(&json!(3)) {
            assert_eq!(msg["result"]["stopReason"], "end_turn");
            break;
        }
    }

    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": format!("[SCRIPTED:HOLD:{}]", barrier.display()) }]
            }
        })
    )
    .unwrap();
    stdin.flush().unwrap();

    while !barrier.join("entered").exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        })
    )
    .unwrap();
    stdin.flush().unwrap();

    loop {
        line.clear();
        stdout.read_line(&mut line).unwrap();
        let msg: Value = serde_json::from_str(&line).unwrap();
        if msg.get("id") == Some(&json!(4)) {
            assert_eq!(msg["result"]["stopReason"], "cancelled");
            break;
        }
    }

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());

    let recorded: Vec<RecordedAcpEvent> = fs::read_to_string(&event_log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        recorded
            .iter()
            .any(|e| e.event == "permission-outcome" && e.outcome.as_deref() == Some("allow-once"))
    );
    assert!(recorded.iter().any(|e| e.event == "session-cancel"));
}

#[cfg(unix)]
#[test]
fn local_ipc_client_speaks_http_and_ndjson_over_unix_socket() {
    use lody_conformance::DaemonRunFile;
    use std::os::unix::net::UnixListener;

    let dir = tempfile::tempdir().unwrap();
    let probe_path = dir.path().join("probe.sock");
    let control_path = dir.path().join("control.sock");

    let probe_listener = UnixListener::bind(&probe_path).unwrap();
    let control_listener = UnixListener::bind(&control_path).unwrap();

    let probe_thread = std::thread::spawn(move || {
        let (mut stream, _) = probe_listener.accept().unwrap();
        let mut reader = BufReader::new(&mut stream);
        let mut req_line = String::new();
        reader.read_line(&mut req_line).unwrap();
        assert!(req_line.starts_with("GET /healthz "));
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).unwrap();
            if h.trim().is_empty() {
                break;
            }
        }
        let body =
            r#"{"ok":true,"machineId":"m-1","pid":123,"cliVersion":"0.1.0","homeDir":"/tmp"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });

    let control_thread = std::thread::spawn(move || {
        let (mut stream, _) = control_listener.accept().unwrap();
        let mut reader = BufReader::new(&mut stream);
        let mut saw_token = false;
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).unwrap();
            if h.to_ascii_lowercase()
                .starts_with("x-lody-ipc-token: secret-token")
            {
                saw_token = true;
            }
            if h.trim().is_empty() {
                break;
            }
        }
        assert!(saw_token);
        let ndjson = concat!(
            "{\"kind\":\"response\",\"response\":{\"type\":\"session/create_ack\",\"sessionId\":\"s-1\"}}\n",
            "{\"kind\":\"response\",\"response\":{\"type\":\"session/create_response\",\"sessionId\":\"s-1\",\"success\":true}}\n",
            "{\"kind\":\"complete\"}\n"
        );
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\n\r\n{}",
            ndjson.len(),
            ndjson
        )
        .unwrap();
    });

    let run_file = DaemonRunFile {
        pid: 123,
        socket_path: probe_path.to_string_lossy().into_owned(),
        control_socket_path: control_path.to_string_lossy().into_owned(),
        version: "0.1.0".to_string(),
        started_at: "2026-11-22T00:00:00Z".to_string(),
        token: Some("secret-token".to_string()),
        data_plane_socket_path: None,
    };
    let client = LocalIpcClient::from_run_file(&run_file);
    let health = client.probe_health().unwrap();
    assert_eq!(health["machineId"], "m-1");

    let frames = client
        .session_control(&json!({ "type": "session/create", "sessionId": "s-1" }))
        .unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1]["success"], true);

    probe_thread.join().unwrap();
    control_thread.join().unwrap();
}

#[test]
fn runs_live_target_and_optional_differential_conformance_when_configured() {
    let bin = scripted_acp_binary();
    let cfg = lody_env::ConformanceEnv::from_process();

    if let Some(single) = TargetBinary::parse_opt(cfg.single_bin.as_deref()) {
        let outcomes = run_all_business_scenarios(&single, &bin)
            .expect("single-target business conformance suite failed");
        assert_eq!(outcomes.len(), 6);
    }

    if let (Some(baseline), Some(candidate)) = (
        TargetBinary::parse_opt(cfg.baseline_bin.as_deref()),
        TargetBinary::parse_opt(cfg.candidate_bin.as_deref()),
    ) {
        run_differential_suite(&baseline, &candidate, &bin)
            .expect("A/B differential business conformance failed");
        run_shared_data_dir_handoff(&baseline, &candidate, &bin)
            .expect("shared LODY_DATA_DIR Node->Rust->Node handoff failed");
    }
}
