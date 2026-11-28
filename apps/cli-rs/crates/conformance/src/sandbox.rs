use crate::ipc::{DaemonRunFile, LocalIpcClient};
use lody_scripted_acp::RecordedAcpEvent;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

#[derive(Debug, Clone)]
pub struct TargetBinary {
    pub program: String,
    pub prefix_args: Vec<String>,
}

impl TargetBinary {
    pub fn parse(spec: &str) -> Option<Self> {
        let parts: Vec<String> = spec
            .split_whitespace()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        let (program, prefix_args) = parts.split_first()?;
        Some(Self {
            program: program.clone(),
            prefix_args: prefix_args.to_vec(),
        })
    }

    pub fn parse_opt(spec: Option<&str>) -> Option<Self> {
        spec.and_then(Self::parse)
    }
}

#[derive(Debug, Clone)]
pub struct CliOutput {
    pub status_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    pub fn parse_json(&self) -> Result<Value, String> {
        serde_json::from_str(&self.stdout).map_err(|e| {
            format!(
                "invalid JSON on stdout (exit={}): {e}\nstdout={}\nstderr={}",
                self.status_code, self.stdout, self.stderr
            )
        })
    }
}

pub struct ConformanceSandbox {
    _temp: TempDir,
    pub home_dir: PathBuf,
    pub data_dir: PathBuf,
    pub project_dir: PathBuf,
    pub acp_event_log: PathBuf,
    pub scripted_acp_bin: PathBuf,
    active_target: Option<TargetBinary>,
}

impl ConformanceSandbox {
    pub fn new(scripted_acp_bin: PathBuf) -> io::Result<Self> {
        let temp = tempfile::Builder::new()
            .prefix("lody-conformance-")
            .tempdir()?;
        let home_dir = temp.path().join("home");
        let data_dir = temp.path().join("lody-data");
        let project_dir = temp.path().join("synthetic-repo");
        let acp_event_log = temp.path().join("scripted-acp-events.jsonl");

        fs::create_dir_all(&home_dir)?;
        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(&project_dir)?;
        fs::write(
            project_dir.join("README.md"),
            "# Synthetic Conformance Project\n",
        )?;

        run_git(&project_dir, &["init", "--initial-branch=main"])?;
        run_git(&project_dir, &["add", "README.md"])?;
        run_git(
            &project_dir,
            &[
                "-c",
                "user.name=Lody Conformance",
                "-c",
                "user.email=conformance@lody.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-m",
                "chore: init synthetic project",
            ],
        )?;

        Ok(Self {
            _temp: temp,
            home_dir,
            data_dir,
            project_dir,
            acp_event_log,
            scripted_acp_bin,
            active_target: None,
        })
    }

    pub fn create_barrier_dir(&self, name: &str) -> io::Result<PathBuf> {
        let path = self._temp.path().join("barriers").join(name);
        fs::create_dir_all(&path)?;
        Ok(path)
    }

    pub fn wait_for_barrier(&self, barrier_dir: &Path, timeout: Duration) -> io::Result<()> {
        let entered = barrier_dir.join("entered");
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if entered.exists() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("timed out waiting for scripted ACP barrier {:?}", entered),
        ))
    }

    pub fn release_barrier(&self, barrier_dir: &Path, note: &str) -> io::Result<()> {
        fs::write(barrier_dir.join("release"), note.as_bytes())
    }

    pub fn read_acp_events(&self) -> Vec<RecordedAcpEvent> {
        let Ok(raw) = fs::read_to_string(&self.acp_event_log) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<RecordedAcpEvent>(l).ok())
            .collect()
    }

    pub fn run_cli(&self, target: &TargetBinary, args: &[&str]) -> io::Result<CliOutput> {
        let mut cmd = Command::new(&target.program);
        cmd.args(&target.prefix_args)
            .args(args)
            .current_dir(&self.project_dir)
            .env(lody_env::keys::HOME, &self.home_dir)
            .env(lody_env::keys::LODY_DATA_DIR, &self.data_dir)
            .env(lody_env::keys::LODY_PLATFORM, "local")
            .env(lody_env::keys::NO_COLOR, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let Output {
            status,
            stdout,
            stderr,
        } = cmd.output()?;
        Ok(CliOutput {
            status_code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    pub fn start_daemon(&mut self, target: &TargetBinary) -> Result<LocalIpcClient, String> {
        let out = self
            .run_cli(target, &["daemon", "start", "--skip-auth-check"])
            .map_err(|e| format!("failed to spawn daemon start: {e}"))?;
        if out.status_code != 0 {
            return Err(format!(
                "daemon start exited with {}: stdout={} stderr={}",
                out.status_code, out.stdout, out.stderr
            ));
        }
        self.active_target = Some(target.clone());
        self.wait_until_daemon_ready(Duration::from_secs(20))
    }

    pub fn stop_daemon(&mut self) -> Result<(), String> {
        let Some(target) = self.active_target.take() else {
            return Ok(());
        };
        let out = self
            .run_cli(&target, &["daemon", "stop"])
            .map_err(|e| format!("failed to invoke daemon stop: {e}"))?;
        if out.status_code != 0 {
            return Err(format!(
                "daemon stop exited with {}: stdout={} stderr={}",
                out.status_code, out.stdout, out.stderr
            ));
        }
        Ok(())
    }

    pub fn ipc_client(&self) -> Result<LocalIpcClient, String> {
        let run_file = DaemonRunFile::read_from_data_dir(&self.data_dir)
            .map_err(|e| format!("failed reading daemon.json: {e}"))?;
        Ok(LocalIpcClient::from_run_file(&run_file))
    }

    fn wait_until_daemon_ready(&self, timeout: Duration) -> Result<LocalIpcClient, String> {
        let deadline = Instant::now() + timeout;
        let mut last_err = String::from("daemon.json not yet written");
        while Instant::now() < deadline {
            match DaemonRunFile::read_from_data_dir(&self.data_dir) {
                Ok(run_file) => {
                    let client = LocalIpcClient::from_run_file(&run_file);
                    match client.probe_state() {
                        Ok(state) => {
                            let stage = state.get("startupStage").and_then(Value::as_str);
                            let phase = state.get("phase").and_then(Value::as_str);
                            if stage == Some("ready") || phase == Some("running") {
                                return Ok(client);
                            }
                            last_err = format!("daemon probe not ready: {state}");
                        }
                        Err(e) => last_err = format!("probe_state failed: {e}"),
                    }
                }
                Err(e) => last_err = format!("read daemon.json: {e}"),
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!(
            "timed out waiting for daemon readiness: {last_err}"
        ))
    }
}

impl Drop for ConformanceSandbox {
    fn drop(&mut self) {
        let _ = self.stop_daemon();
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> io::Result<()> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}
