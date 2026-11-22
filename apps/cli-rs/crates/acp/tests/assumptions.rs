use lody_acp::StdioAcpLauncher;
use lody_ports::{AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpSpawnSpec};
use std::collections::BTreeMap;
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
    if !bin_path.exists() {
        let status = Command::new(env!("CARGO"))
            .current_dir(&workspace_dir)
            .args(["build", "-p", "lody-scripted-acp"])
            .status()
            .expect("build lody-scripted-acp");
        assert!(status.success());
    }
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
}
