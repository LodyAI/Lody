use lody_acp::{ManagedArtifactInstaller, PortablePtyManager, StdioAcpLauncher};
use lody_ports::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpSessionArchiveOutcome, AcpSpawnSpec,
    ArtifactRegistryPort, ManagedArtifactSource, PortErrorKind, PtyPort, SessionId,
    TERMINAL_MAX_PER_SESSION, TerminalOpenSpec,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, mpsc};
use std::time::Duration;

fn scripted_acp_binary() -> PathBuf {
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
    let status = Command::new(env!("CARGO"))
        .current_dir(&workspace_dir)
        .args(["build", "-p", "lody-scripted-acp"])
        .status()
        .expect("build lody-scripted-acp");
    assert!(status.success());
    bin_path
}

struct ChannelSink(mpsc::Sender<AcpInboundEvent>);
impl AcpEventSink for ChannelSink {
    fn on_acp_event(&self, event: AcpInboundEvent) {
        let _ = self.0.send(event);
    }
}

#[test]
fn explicit_termination_suppresses_spurious_crash_while_unexpected_exit_surfaces_in_flight_crash() {
    let launcher = StdioAcpLauncher::default();
    let bin = scripted_acp_binary();
    let temp = tempfile::tempdir().unwrap();

    let (tx1, rx1) = mpsc::channel();
    let spec = AcpSpawnSpec {
        adapter_id: "custom".to_string(),
        command: bin.clone(),
        args: Vec::new(),
        cwd: temp.path().to_path_buf(),
        env: BTreeMap::new(),
        mcp_mounts: Vec::new(),
    };
    let session1 = launcher
        .launch_session(&spec, Arc::new(ChannelSink(tx1)))
        .expect("launch clean session");
    session1.terminate().expect("explicit terminate");
    assert!(rx1.recv_timeout(Duration::from_millis(100)).is_err());

    let (tx2, rx2) = mpsc::channel();
    let session2 = launcher
        .launch_session(&spec, Arc::new(ChannelSink(tx2)))
        .expect("launch crashing session");
    session2
        .send_prompt("[SCRIPTED:CRASH]")
        .expect("send crash prompt");

    let mut saw_in_flight_crash = false;
    while let Ok(ev) = rx2.recv_timeout(Duration::from_secs(5)) {
        if let AcpInboundEvent::ProcessExited {
            prompt_was_in_flight: true,
            ..
        } = ev
        {
            saw_in_flight_crash = true;
            break;
        }
    }
    assert!(saw_in_flight_crash);

    let archive_outcome = launcher
        .set_session_archived(&spec, "native-sess-1", true)
        .expect("negotiate native sessionArchive without session/new");
    assert_eq!(archive_outcome, AcpSessionArchiveOutcome::Native);
}

#[test]
fn pty_cap_never_exceeds_max_per_session_and_offline_bundle_rejects_sha256_mismatch() {
    let temp = tempfile::tempdir().unwrap();
    let bundle_dir = temp.path().join("bundle");
    let pkg_dir = bundle_dir.join("claude-acp").join("1.0.0");
    fs::create_dir_all(&pkg_dir).unwrap();
    fs::write(pkg_dir.join("adapter.js"), "tampered binary").unwrap();
    fs::write(
        pkg_dir.join("manifest.json"),
        r#"{"executableRelPath":"adapter.js","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}"#,
    )
    .unwrap();

    let installer =
        ManagedArtifactInstaller::new(ManagedArtifactSource::OfflineBundle { bundle_dir });
    let err = installer
        .ensure_installed("claude-acp", "1.0.0")
        .unwrap_err();
    assert_eq!(err.kind, PortErrorKind::Conflict);

    #[cfg(unix)]
    {
        let pty = PortablePtyManager::new();
        let sid = SessionId("sess-pty-cap".to_string());
        for _ in 0..TERMINAL_MAX_PER_SESSION {
            pty.open_terminal(TerminalOpenSpec {
                session_id: sid.clone(),
                cwd: temp.path().to_path_buf(),
                cols: 80,
                rows: 24,
                shell_program: "/bin/sh".to_string(),
                shell_args: vec!["-c".to_string(), "read _line".to_string()],
                env: BTreeMap::new(),
            })
            .expect("within per-session PTY bound");
        }

        let ninth = pty
            .open_terminal(TerminalOpenSpec {
                session_id: sid.clone(),
                cwd: temp.path().to_path_buf(),
                cols: 80,
                rows: 24,
                shell_program: "/bin/sh".to_string(),
                shell_args: vec!["-c".to_string(), "read _line".to_string()],
                env: BTreeMap::new(),
            })
            .unwrap_err();
        assert_eq!(ninth.kind, PortErrorKind::Conflict);
        assert!(ninth.message.starts_with("terminal_limit_exceeded:"));

        pty.close_session_terminals(&sid);
        assert!(pty.list_session_terminals(&sid).is_empty());
    }
}
