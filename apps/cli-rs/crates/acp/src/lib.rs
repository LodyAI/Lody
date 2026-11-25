#![forbid(unsafe_code)]

pub mod pty;

use lody_ports::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpSessionPort, AcpSpawnSpec,
    ArtifactRegistryPort, InstalledArtifact, ManagedArtifactSource, PermissionDecision, PortError,
    PortErrorKind, PortResult, SteerVerdict,
};
pub use pty::PortablePtyManager;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifestEntry {
    executable_rel_path: String,
    sha256: String,
    download_url: Option<String>,
}

fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

pub struct ManagedArtifactInstaller {
    source: ManagedArtifactSource,
    install_root: PathBuf,
}

impl ManagedArtifactInstaller {
    pub fn new(source: ManagedArtifactSource) -> Self {
        Self::with_install_root(source, PathBuf::from(".lody-oss/runtimes"))
    }

    pub fn with_install_root(
        source: ManagedArtifactSource,
        install_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            source,
            install_root: install_root.into(),
        }
    }

    fn verify_existing_file(path: &Path, expected_sha256: &str) -> PortResult<bool> {
        let Ok(bytes) = fs::read(path) else {
            return Ok(false);
        };
        Ok(sha256_bytes_hex(&bytes).eq_ignore_ascii_case(expected_sha256))
    }

    fn mark_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
        }
        #[cfg(not(unix))]
        {
            let _ = path;
        }
    }

    fn fetch_remote_artifact(
        &self,
        base_url: &str,
        artifact_id: &str,
        version: &str,
    ) -> PortResult<InstalledArtifact> {
        let trimmed = base_url.trim_end_matches('/');
        let manifest_url = format!("{trimmed}/{artifact_id}/{version}/manifest.json");
        let install_dir = self.install_root.join(artifact_id).join(version);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        rt.block_on(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

            let resp = client
                .get(&manifest_url)
                .send()
                .await
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            if !resp.status().is_success() {
                return Err(PortError::new(
                    PortErrorKind::Unavailable,
                    format!("artifact manifest HTTP {}", resp.status()),
                ));
            }
            let manifest: ArtifactManifestEntry = resp
                .json()
                .await
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

            let dest = install_dir.join(&manifest.executable_rel_path);
            if Self::verify_existing_file(&dest, &manifest.sha256)? {
                return Ok(InstalledArtifact {
                    artifact_id: artifact_id.to_string(),
                    version: version.to_string(),
                    executable_path: dest,
                    sha256_hex: manifest.sha256.to_ascii_lowercase(),
                });
            }

            let dl_url = manifest.download_url.unwrap_or_else(|| {
                format!(
                    "{trimmed}/{artifact_id}/{version}/{}",
                    manifest.executable_rel_path
                )
            });
            let bin_resp = client
                .get(&dl_url)
                .send()
                .await
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            if !bin_resp.status().is_success() {
                return Err(PortError::new(
                    PortErrorKind::Unavailable,
                    format!("artifact binary HTTP {}", bin_resp.status()),
                ));
            }
            let bytes = bin_resp
                .bytes()
                .await
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            let actual_sha = sha256_bytes_hex(&bytes);
            if !actual_sha.eq_ignore_ascii_case(&manifest.sha256) {
                return Err(PortError::new(
                    PortErrorKind::Conflict,
                    format!(
                        "artifact '{artifact_id}' SHA-256 mismatch: expected {}, got {actual_sha}",
                        manifest.sha256
                    ),
                ));
            }

            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            }
            let tmp = dest.with_extension("download.tmp");
            fs::write(&tmp, &bytes)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
            Self::mark_executable(&tmp);
            fs::rename(&tmp, &dest)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

            Ok(InstalledArtifact {
                artifact_id: artifact_id.to_string(),
                version: version.to_string(),
                executable_path: dest,
                sha256_hex: actual_sha,
            })
        })
    }
}

impl ArtifactRegistryPort for ManagedArtifactInstaller {
    fn source(&self) -> &ManagedArtifactSource {
        &self.source
    }

    fn ensure_installed(&self, artifact_id: &str, version: &str) -> PortResult<InstalledArtifact> {
        match &self.source {
            ManagedArtifactSource::Disabled => {
                Err(PortError::capability_unavailable("managedRuntimeArtifacts"))
            }
            ManagedArtifactSource::OfflineBundle { bundle_dir } => {
                let version_dir = bundle_dir.join(artifact_id).join(version);
                let manifest_raw = fs::read_to_string(version_dir.join("manifest.json"))
                    .map_err(|e| PortError::new(PortErrorKind::NotFound, e.to_string()))?;
                let manifest: ArtifactManifestEntry = serde_json::from_str(&manifest_raw)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
                let exe_path = version_dir.join(&manifest.executable_rel_path);
                if !Self::verify_existing_file(&exe_path, &manifest.sha256)? {
                    return Err(PortError::new(
                        PortErrorKind::Conflict,
                        format!("offline bundle SHA-256 verification failed for '{artifact_id}'"),
                    ));
                }
                Ok(InstalledArtifact {
                    artifact_id: artifact_id.to_string(),
                    version: version.to_string(),
                    executable_path: exe_path,
                    sha256_hex: manifest.sha256.to_ascii_lowercase(),
                })
            }
            ManagedArtifactSource::PublicDefault { base_url }
            | ManagedArtifactSource::Mirror { base_url } => {
                self.fetch_remote_artifact(base_url, artifact_id, version)
            }
        }
    }
}

pub struct StdioAcpLauncher {
    max_concurrent_starts: usize,
    handshake_timeout: Duration,
}

impl StdioAcpLauncher {
    pub fn new(max_concurrent_starts: usize) -> Self {
        Self {
            max_concurrent_starts: max_concurrent_starts.max(1),
            handshake_timeout: Duration::from_secs(15),
        }
    }
}

impl Default for StdioAcpLauncher {
    fn default() -> Self {
        Self::new(4)
    }
}

impl AcpLauncherPort for StdioAcpLauncher {
    fn max_concurrent_starts(&self) -> usize {
        self.max_concurrent_starts
    }

    fn launch_session(
        &self,
        spec: &AcpSpawnSpec,
        sink: Arc<dyn AcpEventSink>,
    ) -> PortResult<Box<dyn AcpSessionPort>> {
        let session = StdioAcpSession::spawn(spec, sink, self.handshake_timeout)?;
        Ok(Box::new(session))
    }
}

struct SharedProcessState {
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending_rpc: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    pending_permissions: Mutex<HashMap<String, Value>>,
    active_prompt_id: AtomicU64,
    prompt_in_flight: AtomicBool,
    terminated: AtomicBool,
    next_rpc_id: AtomicU64,
}

impl SharedProcessState {
    fn write_json(&self, payload: &Value) -> PortResult<()> {
        let mut guard = self.stdin.lock().expect("acp stdin lock");
        let Some(stdin) = guard.as_mut() else {
            return Err(PortError::new(
                PortErrorKind::Unavailable,
                "acp stdin closed",
            ));
        };
        let encoded = serde_json::to_string(payload)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        writeln!(stdin, "{encoded}")
            .and_then(|()| stdin.flush())
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))
    }

    fn call_blocking(&self, method: &str, params: Value, timeout: Duration) -> PortResult<Value> {
        let req_id = self.next_rpc_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending_rpc
            .lock()
            .expect("pending_rpc lock")
            .insert(req_id, tx);
        if let Err(err) = self.write_json(&json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        })) {
            self.pending_rpc
                .lock()
                .expect("pending_rpc lock")
                .remove(&req_id);
            return Err(err);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(rpc_err)) => Err(PortError::new(PortErrorKind::Internal, rpc_err)),
            Err(_) => {
                self.pending_rpc
                    .lock()
                    .expect("pending_rpc lock")
                    .remove(&req_id);
                Err(PortError::new(
                    PortErrorKind::Timeout,
                    format!("acp '{method}' timed out"),
                ))
            }
        }
    }

    fn terminate_child(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.stdin.lock().expect("acp stdin lock").take();
        #[cfg(unix)]
        if self.pid > 0 {
            let neg_pgid = format!("-{}", self.pid);
            let _ = Command::new("kill")
                .args(["-KILL", &neg_pgid])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct StdioAcpSession {
    acp_session_id: String,
    shared: Arc<SharedProcessState>,
}

impl StdioAcpSession {
    fn spawn(
        spec: &AcpSpawnSpec,
        sink: Arc<dyn AcpEventSink>,
        handshake_timeout: Duration,
    ) -> PortResult<Self> {
        let mut cmd = Command::new(&spec.command);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| {
            PortError::new(
                PortErrorKind::Unavailable,
                format!("failed spawning acp {:?}: {e}", spec.command),
            )
        })?;

        let pid = child.id();
        let stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PortError::new(PortErrorKind::Internal, "missing acp stdin"));
            }
        };
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PortError::new(
                    PortErrorKind::Internal,
                    "missing acp stdout",
                ));
            }
        };

        let shared = Arc::new(SharedProcessState {
            pid,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            pending_rpc: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            active_prompt_id: AtomicU64::new(0),
            prompt_in_flight: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            next_rpc_id: AtomicU64::new(1),
        });

        let reader_shared = Arc::clone(&shared);
        thread::spawn(move || run_stdout_reader(stdout, reader_shared, sink));

        let handshake = (|| -> PortResult<String> {
            let _ = shared.call_blocking(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": { "name": "lody", "version": "0.1.0" }
                }),
                handshake_timeout,
            )?;

            let mcp_servers: Vec<Value> = spec
                .mcp_mounts
                .iter()
                .map(|m| {
                    let headers: Vec<Value> = m
                        .headers
                        .iter()
                        .map(|h| json!({ "name": h.name, "value": h.value }))
                        .collect();
                    json!({
                        "name": m.name,
                        "type": "http",
                        "url": m.transport_url,
                        "headers": headers,
                    })
                })
                .collect();

            let new_res = shared.call_blocking(
                "session/new",
                json!({
                    "cwd": spec.cwd,
                    "mcpServers": mcp_servers,
                }),
                handshake_timeout,
            )?;

            new_res
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::Internal,
                        format!("missing sessionId in session/new response: {new_res}"),
                    )
                })
                .map(ToOwned::to_owned)
        })();

        match handshake {
            Ok(acp_session_id) => Ok(Self {
                acp_session_id,
                shared,
            }),
            Err(err) => {
                shared.terminate_child();
                Err(err)
            }
        }
    }
}

impl Drop for StdioAcpSession {
    fn drop(&mut self) {
        self.shared.terminate_child();
    }
}

impl AcpSessionPort for StdioAcpSession {
    fn acp_session_id(&self) -> &str {
        &self.acp_session_id
    }

    fn send_prompt(&self, prompt_text: &str) -> PortResult<()> {
        let req_id = self.shared.next_rpc_id.fetch_add(1, Ordering::SeqCst);
        self.shared.active_prompt_id.store(req_id, Ordering::SeqCst);
        self.shared.prompt_in_flight.store(true, Ordering::SeqCst);
        let res = self.shared.write_json(&json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "session/prompt",
            "params": {
                "sessionId": self.acp_session_id,
                "prompt": [{ "type": "text", "text": prompt_text }]
            }
        }));
        if res.is_err() {
            self.shared.prompt_in_flight.store(false, Ordering::SeqCst);
        }
        res
    }

    fn steer(&self, _prompt_text: &str) -> PortResult<SteerVerdict> {
        Ok(SteerVerdict::NotApplied)
    }

    fn reply_permission(&self, decision: &PermissionDecision) -> PortResult<()> {
        let raw_id = self
            .shared
            .pending_permissions
            .lock()
            .expect("pending_permissions lock")
            .remove(&decision.request_id)
            .unwrap_or_else(|| json!(decision.request_id));

        let outcome = if decision.cancelled {
            json!({ "outcome": "cancelled" })
        } else {
            json!({
                "outcome": "selected",
                "optionId": decision.selected_option_id.clone().unwrap_or_else(|| "allow-once".to_string())
            })
        };

        self.shared.write_json(&json!({
            "jsonrpc": "2.0",
            "id": raw_id,
            "result": { "outcome": outcome }
        }))
    }

    fn cancel_turn(&self) -> PortResult<()> {
        let req_id = self.shared.next_rpc_id.fetch_add(1, Ordering::SeqCst);
        self.shared.write_json(&json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "session/cancel",
            "params": { "sessionId": self.acp_session_id }
        }))
    }

    fn terminate(&self) -> PortResult<()> {
        self.shared.terminate_child();
        Ok(())
    }
}

fn run_stdout_reader(
    stdout: std::process::ChildStdout,
    shared: Arc<SharedProcessState>,
    sink: Arc<dyn AcpEventSink>,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let is_response = msg.get("method").is_none()
            && (msg.get("result").is_some() || msg.get("error").is_some());
        if is_response {
            if let Some(id_num) = msg.get("id").and_then(Value::as_u64) {
                if let Some(tx) = shared
                    .pending_rpc
                    .lock()
                    .expect("pending_rpc lock")
                    .remove(&id_num)
                {
                    if let Some(err) = msg.get("error") {
                        let _ = tx.send(Err(err.to_string()));
                    } else {
                        let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                    }
                    continue;
                }

                if shared.active_prompt_id.load(Ordering::SeqCst) == id_num {
                    shared.prompt_in_flight.store(false, Ordering::SeqCst);
                    if let Some(err) = msg.get("error") {
                        sink.on_acp_event(AcpInboundEvent::ProcessExited {
                            exit_code: Some(-1),
                            prompt_was_in_flight: true,
                        });
                        let _ = err;
                    } else {
                        let stop_reason = msg
                            .get("result")
                            .and_then(|r| r.get("stopReason"))
                            .and_then(Value::as_str)
                            .unwrap_or("end_turn")
                            .to_string();
                        sink.on_acp_event(AcpInboundEvent::PromptFinished { stop_reason });
                    }
                }
            }
            continue;
        }

        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "session/update" => {
                if let Some(update) = params.get("update") {
                    dispatch_session_update(update, sink.as_ref());
                }
            }
            "session/request_permission" => {
                if let Some(raw_id) = msg.get("id").cloned() {
                    let req_id = raw_id
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| raw_id.to_string());
                    let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                    let tool_call_id = tool_call
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .unwrap_or("tool-1")
                        .to_string();
                    let title = tool_call
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Permission request")
                        .to_string();
                    shared
                        .pending_permissions
                        .lock()
                        .expect("pending_permissions lock")
                        .insert(req_id.clone(), raw_id);
                    sink.on_acp_event(AcpInboundEvent::PermissionRequest {
                        request_id: req_id,
                        tool_call_id,
                        title,
                    });
                }
            }
            _ => {}
        }
    }

    if shared.terminated.load(Ordering::SeqCst) {
        return;
    }
    let was_in_flight = shared.prompt_in_flight.swap(false, Ordering::SeqCst);
    let exit_code = shared
        .child
        .lock()
        .ok()
        .and_then(|mut c| c.wait().ok())
        .and_then(|s| s.code());
    sink.on_acp_event(AcpInboundEvent::ProcessExited {
        exit_code,
        prompt_was_in_flight: was_in_flight,
    });
}

fn dispatch_session_update(update: &Value, sink: &dyn AcpEventSink) {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
            {
                sink.on_acp_event(AcpInboundEvent::MessageChunk {
                    text: text.to_string(),
                });
            }
        }
        "tool_call" | "tool_call_update" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_string();
            sink.on_acp_event(AcpInboundEvent::ToolStatus {
                tool_call_id,
                title,
                status,
            });
        }
        _ => {}
    }
}
