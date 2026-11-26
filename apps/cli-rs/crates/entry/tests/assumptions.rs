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
            let parent_prompt_count = events
                .iter()
                .filter(|e| {
                    e.get("event").and_then(Value::as_str) == Some("prompt-end")
                        && e.get("mode").and_then(Value::as_str) == Some("reply")
                })
                .count();
            saw_parent_receipt_wakeup = parent_prompt_count >= 1;
            if saw_accepted_child && saw_rejected_grandchild && saw_parent_receipt_wakeup {
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
        saw_parent_receipt_wakeup,
        "parent session must automatically wake with child completion receipt batch"
    );
}
