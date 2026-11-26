#![forbid(unsafe_code)]

pub mod pty;

use lody_ports::{
    AcpEventSink, AcpInboundEvent, AcpLauncherPort, AcpNativeActivity, AcpSessionArchiveMode,
    AcpSessionArchiveOutcome, AcpSessionPort, AcpSpawnSpec, ArtifactRegistryPort,
    InstalledArtifact, ManagedArtifactSource, PermissionDecision, PortError, PortErrorKind,
    PortResult, SteerVerdict,
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
    proxy_url: Option<String>,
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
            proxy_url: None,
        }
    }

    pub fn with_proxy_url(mut self, proxy_url: Option<String>) -> Self {
        self.proxy_url = proxy_url;
        self
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
        let proxy_url = self.proxy_url.clone();

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

        rt.block_on(async move {
            let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
            if let Some(proxy_raw) = proxy_url
                && let Ok(proxy) = reqwest::Proxy::all(&proxy_raw)
            {
                builder = builder.proxy(proxy);
            }
            let client = builder
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

struct NoopAcpEventSink;
impl AcpEventSink for NoopAcpEventSink {
    fn on_acp_event(&self, _event: AcpInboundEvent) {}
}

fn parse_lody_extension_capabilities(init_res: &Value) -> (bool, Option<AcpSessionArchiveMode>) {
    let Some(lody) = init_res
        .get("agentCapabilities")
        .and_then(|c| c.get("_meta"))
        .and_then(|m| m.get("lody"))
    else {
        return (false, None);
    };

    let session_activity = lody
        .get("sessionActivity")
        .and_then(|v| v.get("version"))
        .and_then(Value::as_u64)
        == Some(1);

    let archive_mode = lody.get("sessionArchive").and_then(|sa| {
        if sa.get("version").and_then(Value::as_u64) != Some(1) {
            return None;
        }
        match sa.get("mode").and_then(Value::as_str)? {
            "native" => Some(AcpSessionArchiveMode::Native),
            "title-marker" => Some(AcpSessionArchiveMode::TitleMarker),
            _ => None,
        }
    });

    (session_activity, archive_mode)
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
        Self::new(2)
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

    fn set_session_archived(
        &self,
        spec: &AcpSpawnSpec,
        native_session_id: &str,
        archived: bool,
    ) -> PortResult<AcpSessionArchiveOutcome> {
        let temp_dir = tempfile::Builder::new()
            .prefix("lody-session-archive-")
            .tempdir()
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

        let isolated_spec = AcpSpawnSpec {
            adapter_id: spec.adapter_id.clone(),
            command: spec.command.clone(),
            args: spec.args.clone(),
            cwd: temp_dir.path().to_path_buf(),
            env: spec.env.clone(),
            mcp_mounts: Vec::new(),
        };

        let shared = spawn_acp_process(&isolated_spec, Arc::new(NoopAcpEventSink))?;
        let outcome = (|| -> PortResult<AcpSessionArchiveOutcome> {
            let init_res = shared.call_blocking(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "terminal": false,
                        "fs": { "readTextFile": false, "writeTextFile": false }
                    },
                    "clientInfo": { "name": "lody", "version": "0.1.0" }
                }),
                self.handshake_timeout,
            )?;
            let (_, archive_mode) = parse_lody_extension_capabilities(&init_res);
            let Some(mode) = archive_mode else {
                return Ok(AcpSessionArchiveOutcome::Unsupported);
            };
            let method = if archived {
                "_lody/session/archive"
            } else {
                "_lody/session/unarchive"
            };
            let _ = shared.call_blocking(
                method,
                json!({ "sessionId": native_session_id }),
                self.handshake_timeout,
            )?;
            Ok(match mode {
                AcpSessionArchiveMode::Native => AcpSessionArchiveOutcome::Native,
                AcpSessionArchiveMode::TitleMarker => AcpSessionArchiveOutcome::TitleMarker,
            })
        })();

        shared.terminate_child();
        outcome
    }
}

struct SharedProcessState {
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending_rpc: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    pending_permissions: Mutex<HashMap<String, Value>>,
    init_rpc_id: AtomicU64,
    session_new_rpc_id: AtomicU64,
    advertises_session_activity: AtomicBool,
    current_acp_session_id: Mutex<Option<String>>,
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
        self.call_blocking_tracked(method, params, timeout, None)
    }

    fn call_blocking_tracked(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        tracked_id_slot: Option<&AtomicU64>,
    ) -> PortResult<Value> {
        let req_id = self.next_rpc_id.fetch_add(1, Ordering::SeqCst);
        if let Some(slot) = tracked_id_slot {
            slot.store(req_id, Ordering::SeqCst);
        }
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

fn spawn_acp_process(
    spec: &AcpSpawnSpec,
    sink: Arc<dyn AcpEventSink>,
) -> PortResult<Arc<SharedProcessState>> {
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
        init_rpc_id: AtomicU64::new(0),
        session_new_rpc_id: AtomicU64::new(0),
        advertises_session_activity: AtomicBool::new(false),
        current_acp_session_id: Mutex::new(None),
        active_prompt_id: AtomicU64::new(0),
        prompt_in_flight: AtomicBool::new(false),
        terminated: AtomicBool::new(false),
        next_rpc_id: AtomicU64::new(1),
    });

    let reader_shared = Arc::clone(&shared);
    thread::spawn(move || run_stdout_reader(stdout, reader_shared, sink));
    Ok(shared)
}

pub struct StdioAcpSession {
    acp_session_id: String,
    advertises_session_activity: bool,
    shared: Arc<SharedProcessState>,
}

impl StdioAcpSession {
    fn spawn(
        spec: &AcpSpawnSpec,
        sink: Arc<dyn AcpEventSink>,
        handshake_timeout: Duration,
    ) -> PortResult<Self> {
        let shared = spawn_acp_process(spec, sink)?;

        let handshake = (|| -> PortResult<(String, bool)> {
            let init_res = shared.call_blocking_tracked(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": { "name": "lody", "version": "0.1.0" }
                }),
                handshake_timeout,
                Some(&shared.init_rpc_id),
            )?;
            let (advertises_activity, _) = parse_lody_extension_capabilities(&init_res);
            shared
                .advertises_session_activity
                .store(advertises_activity, Ordering::SeqCst);

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

            let new_res = shared.call_blocking_tracked(
                "session/new",
                json!({
                    "cwd": spec.cwd,
                    "mcpServers": mcp_servers,
                }),
                handshake_timeout,
                Some(&shared.session_new_rpc_id),
            )?;

            let sid = new_res
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::Internal,
                        format!("missing sessionId in session/new response: {new_res}"),
                    )
                })
                .map(ToOwned::to_owned)?;
            *shared
                .current_acp_session_id
                .lock()
                .expect("current_acp_session_id lock") = Some(sid.clone());
            Ok((sid, advertises_activity))
        })();

        match handshake {
            Ok((acp_session_id, advertises_session_activity)) => Ok(Self {
                acp_session_id,
                advertises_session_activity,
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

    fn advertises_session_activity(&self) -> bool {
        self.advertises_session_activity
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

fn parse_session_activity_update(
    params: &Value,
    expected_session_id: &str,
) -> Option<AcpNativeActivity> {
    if params.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let session_id = params.get("sessionId").and_then(Value::as_str)?;
    if session_id.is_empty() || session_id != expected_session_id {
        return None;
    }
    let background_task_count = params.get("backgroundTaskCount").and_then(Value::as_u64)?;
    match params.get("state").and_then(Value::as_str)? {
        "running" | "requires_action" => Some(AcpNativeActivity::Running),
        "idle" if background_task_count > 0 => Some(AcpNativeActivity::Background),
        "idle" => Some(AcpNativeActivity::Idle),
        _ => None,
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
                if msg.get("error").is_none()
                    && let Some(res_val) = msg.get("result")
                {
                    if id_num != 0 && shared.init_rpc_id.load(Ordering::SeqCst) == id_num {
                        let (advertises, _) = parse_lody_extension_capabilities(res_val);
                        shared
                            .advertises_session_activity
                            .store(advertises, Ordering::SeqCst);
                    } else if id_num != 0
                        && shared.session_new_rpc_id.load(Ordering::SeqCst) == id_num
                        && let Some(sid) = res_val.get("sessionId").and_then(Value::as_str)
                    {
                        *shared
                            .current_acp_session_id
                            .lock()
                            .expect("current_acp_session_id lock") = Some(sid.to_string());
                    }
                }

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
        let normalized_method = method.strip_prefix('_').unwrap_or(method);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match normalized_method {
            "session/update" => {
                if let Some(update) = params.get("update") {
                    dispatch_session_update(update, sink.as_ref());
                }
            }
            "lody/session/activity_update" => {
                if shared.advertises_session_activity.load(Ordering::SeqCst) {
                    let current_sid = shared
                        .current_acp_session_id
                        .lock()
                        .expect("current_acp_session_id lock")
                        .clone();
                    if let Some(expected_sid) = current_sid
                        && let Some(activity) =
                            parse_session_activity_update(&params, &expected_sid)
                    {
                        sink.on_acp_event(AcpInboundEvent::SessionActivity { activity });
                    }
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
