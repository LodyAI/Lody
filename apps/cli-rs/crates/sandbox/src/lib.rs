#![forbid(unsafe_code)]

use lody_ports::{
    AutomationEvidenceEntry, AutomationHostOps, AutomationMatchResult, AutomationProgramContext,
    AutomationProgramEvaluation, AutomationSandboxPort, PortError, PortErrorKind, PortResult,
};
use reqwest::Url;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use rquickjs::{Context, Function, Promise, Runtime};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SANDBOX_MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
pub const SANDBOX_MAX_STACK_BYTES: usize = 512 * 1024;
pub const SANDBOX_EVAL_TIMEOUT: Duration = Duration::from_secs(30);
pub const SANDBOX_VALIDATE_TIMEOUT: Duration = Duration::from_secs(2);
pub const SANDBOX_MAX_PROGRAM_BYTES: usize = 64 * 1024;
pub const SANDBOX_MAX_TOOL_CALLS: usize = 32;
pub const SANDBOX_MAX_TOOL_IO_BYTES: usize = 128 * 1024;
pub const SANDBOX_MAX_FETCH_BODY_BYTES: usize = 64 * 1024;
pub const SANDBOX_MAX_RESULT_BYTES: usize = 64 * 1024;
pub const SANDBOX_MAX_RESUME_TEXT_BYTES: usize = 32 * 1024;
pub const SANDBOX_MAX_EVIDENCE_ITEMS: usize = 32;

#[derive(Debug, Clone)]
pub struct QuickJsAutomationSandbox {
    memory_limit_bytes: usize,
    eval_timeout: Duration,
    validate_timeout: Duration,
}

impl Default for QuickJsAutomationSandbox {
    fn default() -> Self {
        Self {
            memory_limit_bytes: SANDBOX_MEMORY_LIMIT_BYTES,
            eval_timeout: SANDBOX_EVAL_TIMEOUT,
            validate_timeout: SANDBOX_VALIDATE_TIMEOUT,
        }
    }
}

impl QuickJsAutomationSandbox {
    pub fn with_limits(
        memory_limit_bytes: usize,
        eval_timeout: Duration,
        validate_timeout: Duration,
    ) -> Self {
        Self {
            memory_limit_bytes,
            eval_timeout,
            validate_timeout,
        }
    }

    fn build_runtime(&self, timeout: Duration) -> PortResult<(Runtime, Arc<Mutex<bool>>)> {
        let rt = Runtime::new()
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("quickjs init: {e}")))?;
        rt.set_memory_limit(self.memory_limit_bytes);
        rt.set_max_stack_size(SANDBOX_MAX_STACK_BYTES);
        let timed_out = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&timed_out);
        let deadline = Instant::now() + timeout;
        rt.set_interrupt_handler(Some(Box::new(move || {
            if Instant::now() >= deadline {
                if let Ok(mut guard) = flag.lock() {
                    *guard = true;
                }
                return true;
            }
            false
        })));
        Ok((rt, timed_out))
    }
}

pub fn resolve_contained_cwd(root: &Path, relative_cwd: Option<&str>) -> PortResult<PathBuf> {
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

fn validate_program_size(source: &str) -> PortResult<()> {
    if source.trim().is_empty() || source.len() > SANDBOX_MAX_PROGRAM_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_PROGRAM_INVALID_LENGTH",
        ));
    }
    Ok(())
}

fn extract_js_error<T>(
    ctx: &rquickjs::Ctx<'_>,
    res: Result<T, rquickjs::Error>,
    timed_out: bool,
) -> PortResult<T> {
    match res {
        Ok(v) => Ok(v),
        Err(rquickjs::Error::Exception) => {
            if timed_out {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_PROGRAM_TIMEOUT",
                ));
            }
            let caught = ctx.catch();
            let msg = if let Some(exc) = caught.as_exception() {
                exc.message()
                    .unwrap_or_else(|| "JavaScript exception".to_string())
            } else {
                format!("{caught:?}")
            };
            Err(PortError::new(PortErrorKind::InvalidInput, msg))
        }
        Err(other) => {
            if timed_out {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_PROGRAM_TIMEOUT",
                ));
            }
            Err(PortError::new(
                PortErrorKind::InvalidInput,
                format!("AUTOMATION_PROGRAM_ERROR:{other}"),
            ))
        }
    }
}

fn execute_bounded_fetch(request: &Value, timeout: Duration) -> PortResult<Value> {
    let encoded = serde_json::to_string(request)
        .map_err(|e| PortError::new(PortErrorKind::InvalidInput, e.to_string()))?;
    if encoded.len() > SANDBOX_MAX_TOOL_IO_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_TOOL_INPUT_TOO_LARGE",
        ));
    }
    let Some(obj) = request.as_object() else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_FETCH_INVALID_INPUT",
        ));
    };
    let Some(url_str) = obj.get("url").and_then(Value::as_str) else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_FETCH_INVALID_URL",
        ));
    };
    if url_str.len() > 8_192 {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_FETCH_INVALID_URL",
        ));
    }
    let parsed_url = Url::parse(url_str)
        .map_err(|_| PortError::new(PortErrorKind::InvalidInput, "AUTOMATION_FETCH_INVALID_URL"))?;
    let scheme = parsed_url.scheme();
    if (scheme != "http" && scheme != "https")
        || !parsed_url.username().is_empty()
        || parsed_url.password().is_some()
    {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_FETCH_INVALID_URL",
        ));
    }

    let options = obj.get("options").and_then(Value::as_object);
    let method_str = options
        .and_then(|o| o.get("method"))
        .and_then(Value::as_str)
        .unwrap_or("GET");
    if method_str != "GET" && method_str != "HEAD" {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_FETCH_METHOD_NOT_ALLOWED",
        ));
    }

    let mut headers = HeaderMap::new();
    if let Some(hdrs) = options
        .and_then(|o| o.get("headers"))
        .and_then(Value::as_object)
    {
        for (raw_name, raw_val) in hdrs {
            let lower = raw_name.to_ascii_lowercase();
            if lower != "accept" && lower != "accept-language" {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_FETCH_HEADER_NOT_ALLOWED",
                ));
            }
            let Some(val_str) = raw_val.as_str() else {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_FETCH_HEADER_NOT_ALLOWED",
                ));
            };
            let h_name = HeaderName::from_bytes(lower.as_bytes()).map_err(|_| {
                PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_FETCH_HEADER_NOT_ALLOWED",
                )
            })?;
            let h_val = HeaderValue::from_str(val_str).map_err(|_| {
                PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_FETCH_HEADER_NOT_ALLOWED",
                )
            })?;
            headers.insert(h_name, h_val);
        }
    }

    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .default_headers(headers)
        .build()
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

    let req = if method_str == "HEAD" {
        client.head(parsed_url)
    } else {
        client.get(parsed_url)
    };
    let mut resp = req
        .send()
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

    let mut body_bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = resp
            .read(&mut chunk)
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        if n == 0 {
            break;
        }
        if body_bytes.len() + n > SANDBOX_MAX_FETCH_BODY_BYTES {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "AUTOMATION_FETCH_BODY_TOO_LARGE",
            ));
        }
        body_bytes.extend_from_slice(&chunk[..n]);
    }

    let mut filtered_headers = serde_json::Map::new();
    for allowed in [
        "content-type",
        "content-length",
        "cache-control",
        "etag",
        "last-modified",
    ] {
        if let Some(val) = resp.headers().get(allowed)
            && let Ok(s) = val.to_str()
        {
            filtered_headers.insert(allowed.to_string(), Value::String(s.to_string()));
        }
    }

    Ok(json!({
        "ok": resp.status().is_success(),
        "status": resp.status().as_u16(),
        "url": resp.url().as_str(),
        "headers": filtered_headers,
        "body": String::from_utf8_lossy(&body_bytes)
    }))
}

#[cfg(unix)]
fn terminate_process_group_sync(pgid: u32) {
    if pgid == 0 {
        return;
    }
    let neg = format!("-{pgid}");
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &neg])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &neg])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn terminate_process_group_sync(_pgid: u32) {}

fn execute_bounded_command(
    request: &Value,
    session_workdir: Option<&Path>,
    command_env: &BTreeMap<String, String>,
    deadline: Instant,
) -> PortResult<Value> {
    let Some(root) = session_workdir else {
        return Err(PortError::new(
            PortErrorKind::Unavailable,
            "AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE",
        ));
    };
    let Some(obj) = request.as_object() else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_INVALID_COMMAND",
        ));
    };
    let Some(cmd_name) = obj.get("command").and_then(Value::as_str) else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_INVALID_COMMAND",
        ));
    };
    if cmd_name.is_empty() || cmd_name.contains('\0') {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_INVALID_COMMAND",
        ));
    }
    let mut args = Vec::new();
    if let Some(raw_args) = obj.get("args") {
        let Some(arr) = raw_args.as_array() else {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "AUTOMATION_EXEC_INVALID_COMMAND",
            ));
        };
        for item in arr {
            let Some(s) = item.as_str() else {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_EXEC_INVALID_COMMAND",
                ));
            };
            if s.contains('\0') {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_EXEC_INVALID_COMMAND",
                ));
            }
            args.push(s.to_string());
        }
    }
    let rel_cwd = match obj.get("cwd") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "AUTOMATION_EXEC_INVALID_CWD",
            ));
        }
    };
    let resolved_cwd = resolve_contained_cwd(root, rel_cwd)?;

    let mut cmd = Command::new(cmd_name);
    cmd.args(&args)
        .current_dir(resolved_cwd)
        .env_clear()
        .envs(command_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        PortError::new(
            PortErrorKind::InvalidInput,
            format!("AUTOMATION_EXEC_FAILED:{e}"),
        )
    })?;
    let pgid = child.id();

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let (out_tx, out_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let res = (|| -> Result<Vec<u8>, &'static str> {
            let mut buf = Vec::new();
            if let Some(mut r) = stdout_pipe.take() {
                let mut chunk = [0u8; 4096];
                loop {
                    let n = r.read(&mut chunk).map_err(|_| "AUTOMATION_EXEC_IO_ERROR")?;
                    if n == 0 {
                        break;
                    }
                    if buf.len() + n > SANDBOX_MAX_TOOL_IO_BYTES {
                        return Err("AUTOMATION_EXEC_OUTPUT_TOO_LARGE");
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
            Ok(buf)
        })();
        let _ = out_tx.send(res);
    });

    let (err_tx, err_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let res = (|| -> Result<Vec<u8>, &'static str> {
            let mut buf = Vec::new();
            if let Some(mut r) = stderr_pipe.take() {
                let mut chunk = [0u8; 4096];
                loop {
                    let n = r.read(&mut chunk).map_err(|_| "AUTOMATION_EXEC_IO_ERROR")?;
                    if n == 0 {
                        break;
                    }
                    if buf.len() + n > SANDBOX_MAX_TOOL_IO_BYTES {
                        return Err("AUTOMATION_EXEC_OUTPUT_TOO_LARGE");
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
            Ok(buf)
        })();
        let _ = err_tx.send(res);
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                terminate_process_group_sync(pgid);
                break st;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    terminate_process_group_sync(pgid);
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(PortError::new(
                        PortErrorKind::InvalidInput,
                        "AUTOMATION_PROGRAM_TIMEOUT",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                terminate_process_group_sync(pgid);
                let _ = child.kill();
                return Err(PortError::new(PortErrorKind::Internal, e.to_string()));
            }
        }
    };

    let drain_wait = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(1))
        .max(Duration::from_millis(50));
    let stdout_bytes = out_rx
        .recv_timeout(drain_wait)
        .unwrap_or(Ok(Vec::new()))
        .map_err(|code| PortError::new(PortErrorKind::InvalidInput, code))?;
    let stderr_bytes = err_rx
        .recv_timeout(drain_wait)
        .unwrap_or(Ok(Vec::new()))
        .map_err(|code| PortError::new(PortErrorKind::InvalidInput, code))?;

    if stdout_bytes.len() + stderr_bytes.len() > SANDBOX_MAX_TOOL_IO_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_OUTPUT_TOO_LARGE",
        ));
    }

    let result = json!({
        "exitCode": status.code(),
        "signal": Option::<String>::None,
        "stdout": String::from_utf8_lossy(&stdout_bytes),
        "stderr": String::from_utf8_lossy(&stderr_bytes)
    });
    let encoded = serde_json::to_string(&result)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
    if encoded.len() > SANDBOX_MAX_TOOL_IO_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_EXEC_OUTPUT_TOO_LARGE",
        ));
    }
    Ok(result)
}

fn parse_and_validate_result(raw_json: &str) -> PortResult<Option<AutomationMatchResult>> {
    if raw_json.len() > SANDBOX_MAX_RESULT_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "Automation result exceeds 64 KiB",
        ));
    }
    let val: Value = serde_json::from_str(raw_json).map_err(|_| {
        PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_INVALID_RESULT_JSON",
        )
    })?;
    if val == Value::Bool(false) {
        return Ok(None);
    }
    let Some(obj) = val.as_object() else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_INVALID_RESULT_SHAPE",
        ));
    };
    for key in obj.keys() {
        if key != "resumeText" && key != "payload" {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                format!("AUTOMATION_RESULT_UNEXPECTED_KEY:{key}"),
            ));
        }
    }
    let Some(resume_raw) = obj.get("resumeText").and_then(Value::as_str) else {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_RESULT_MISSING_RESUME_TEXT",
        ));
    };
    let trimmed = resume_raw.trim();
    if trimmed.is_empty() || trimmed.len() > SANDBOX_MAX_RESUME_TEXT_BYTES {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            "AUTOMATION_RESULT_INVALID_RESUME_TEXT",
        ));
    }
    let payload = obj.get("payload").cloned();
    Ok(Some(AutomationMatchResult {
        resume_text: trimmed.to_string(),
        payload,
    }))
}

#[derive(Default)]
struct EvalTelemetry {
    tool_calls: usize,
    reads: BTreeSet<String>,
    evidence: Vec<AutomationEvidenceEntry>,
}

impl AutomationSandboxPort for QuickJsAutomationSandbox {
    fn validate_program(
        &self,
        source: &str,
        _context: &AutomationProgramContext,
    ) -> PortResult<()> {
        validate_program_size(source)?;
        let (rt, timed_out) = self.build_runtime(self.validate_timeout)?;
        let ctx = Context::full(&rt)
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("quickjs ctx: {e}")))?;
        let wrapped = format!("(\n{source}\n)");
        ctx.with(|qctx| {
            qctx.globals()
                .set("__lodyProgramSource", wrapped)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
            let eval_res: Result<String, rquickjs::Error> = qctx.eval(
                r#"
                (() => {
                  const fn = (0, eval)(__lodyProgramSource);
                  return typeof fn;
                })()
                "#,
            );
            let is_timeout = *timed_out.lock().expect("timeout lock");
            let kind = extract_js_error(&qctx, eval_res, is_timeout)?;
            if kind != "function" {
                return Err(PortError::new(
                    PortErrorKind::InvalidInput,
                    "AUTOMATION_PROGRAM_MUST_BE_FUNCTION",
                ));
            }
            Ok(())
        })
    }

    fn evaluate_program(
        &self,
        source: &str,
        context: &AutomationProgramContext,
        host_ops: Arc<dyn AutomationHostOps>,
    ) -> PortResult<AutomationProgramEvaluation> {
        validate_program_size(source)?;
        let eval_deadline = Instant::now() + self.eval_timeout;
        let (rt, timed_out) = self.build_runtime(self.eval_timeout)?;
        let ctx = Context::full(&rt)
            .map_err(|e| PortError::new(PortErrorKind::Internal, format!("quickjs ctx: {e}")))?;

        let telemetry = Arc::new(Mutex::new(EvalTelemetry::default()));
        let telemetry_for_host = Arc::clone(&telemetry);

        let raw_outcome: PortResult<String> = std::thread::scope(|s| {
            s.spawn(|| {
                ctx.with(|qctx| -> PortResult<String> {
                    let bridge = Function::new(
                        qctx.clone(),
                        move |op: String, arg1_json: String, arg2_json: String| -> String {
                            let step = (|| -> PortResult<Value> {
                                {
                                    let mut guard =
                                        telemetry_for_host.lock().expect("telemetry lock");
                                    if guard.tool_calls >= SANDBOX_MAX_TOOL_CALLS {
                                        return Err(PortError::new(
                                            PortErrorKind::InvalidInput,
                                            "AUTOMATION_TOOL_CALL_LIMIT_EXCEEDED",
                                        ));
                                    }
                                    guard.tool_calls += 1;
                                }
                                if arg1_json.len().saturating_add(arg2_json.len())
                                    > SANDBOX_MAX_TOOL_IO_BYTES
                                {
                                    return Err(PortError::new(
                                        PortErrorKind::InvalidInput,
                                        "AUTOMATION_TOOL_INPUT_TOO_LARGE",
                                    ));
                                }
                                let a1: Value = serde_json::from_str(&arg1_json).map_err(|e| {
                                    PortError::new(PortErrorKind::InvalidInput, e.to_string())
                                })?;
                                let a2: Value = serde_json::from_str(&arg2_json).map_err(|e| {
                                    PortError::new(PortErrorKind::InvalidInput, e.to_string())
                                })?;

                                let output = match op.as_str() {
                                    "read" => {
                                        let Some(resource) = a1.as_str() else {
                                            return Err(PortError::new(
                                                PortErrorKind::InvalidInput,
                                                "AUTOMATION_UNKNOWN_READ_RESOURCE",
                                            ));
                                        };
                                        {
                                            let mut guard =
                                                telemetry_for_host.lock().expect("telemetry lock");
                                            guard.reads.insert(resource.to_string());
                                        }
                                        let obs = host_ops.read_resource(resource, &a2)?;
                                        if !obs.evidence.is_empty() {
                                            let mut guard =
                                                telemetry_for_host.lock().expect("telemetry lock");
                                            for item in obs.evidence {
                                                if guard.evidence.len() >= SANDBOX_MAX_EVIDENCE_ITEMS
                                                {
                                                    break;
                                                }
                                                let exists = guard.evidence.iter().any(|e| {
                                                    e.source_id == item.source_id
                                                        && e.revision == item.revision
                                                        && e.pr_url == item.pr_url
                                                });
                                                if !exists {
                                                    guard.evidence.push(item);
                                                }
                                            }
                                        }
                                        json!({
                                            "value": obs.value,
                                            "observedAt": obs.observed_at
                                        })
                                    }
                                    "fetch" => {
                                        let req_val = json!({
                                            "url": a1,
                                            "options": if a2.is_null() { json!({}) } else { a2 }
                                        });
                                        if let Some(overridden) = host_ops.override_fetch(&req_val)
                                        {
                                            overridden?
                                        } else {
                                            let remaining = eval_deadline
                                                .saturating_duration_since(Instant::now())
                                                .max(Duration::from_millis(50));
                                            execute_bounded_fetch(&req_val, remaining)?
                                        }
                                    }
                                    "exec" => {
                                        let workdir = host_ops.session_workdir();
                                        let env_map = host_ops.command_env();
                                        execute_bounded_command(
                                            &a1,
                                            workdir.as_deref(),
                                            &env_map,
                                            eval_deadline,
                                        )?
                                    }
                                    _ => {
                                        return Err(PortError::new(
                                            PortErrorKind::InvalidInput,
                                            "AUTOMATION_UNKNOWN_HOST_OP",
                                        ));
                                    }
                                };

                                let out_str = serde_json::to_string(&output).map_err(|e| {
                                    PortError::new(PortErrorKind::Internal, e.to_string())
                                })?;
                                if out_str.len() > SANDBOX_MAX_TOOL_IO_BYTES {
                                    return Err(PortError::new(
                                        PortErrorKind::InvalidInput,
                                        "AUTOMATION_TOOL_OUTPUT_TOO_LARGE",
                                    ));
                                }
                                Ok(output)
                            })();

                            match step {
                                Ok(val) => json!({ "ok": true, "value": val }).to_string(),
                                Err(err) => {
                                    json!({ "ok": false, "error": err.message }).to_string()
                                }
                            }
                        },
                    )
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

                    let globals = qctx.globals();
                    globals
                        .set("__lodyHostBridge", bridge)
                        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
                    globals
                        .set("__lodyProgramSource", format!("(\n{source}\n)"))
                        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
                    globals
                        .set(
                            "__lodyContextMeta",
                            serde_json::to_string(context).map_err(|e| {
                                PortError::new(PortErrorKind::Internal, e.to_string())
                            })?,
                        )
                        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

                    let eval_promise: Result<Promise<'_>, rquickjs::Error> = qctx.eval(
                        r#"
                        (() => {
                          const callBridge = __lodyHostBridge;
                          delete globalThis.__lodyHostBridge;
                          const rawSource = __lodyProgramSource;
                          delete globalThis.__lodyProgramSource;
                          const meta = JSON.parse(__lodyContextMeta);
                          delete globalThis.__lodyContextMeta;

                          const invoke = (op, a, b) => Promise.resolve().then(() => {
                            const raw = callBridge(
                              op,
                              JSON.stringify(a === undefined ? null : a),
                              JSON.stringify(b === undefined ? null : b)
                            );
                            const parsed = JSON.parse(raw);
                            if (parsed.ok) return parsed.value;
                            throw new Error(parsed.error || "Host call failed");
                          });

                          const wrapFetchResult = (res) => {
                            const bodyStr = typeof res.body === "string" ? res.body : "";
                            return Object.freeze({
                              ok: Boolean(res.ok),
                              status: res.status ?? 0,
                              headers: res.headers ?? {},
                              url: res.url ?? "",
                              body: bodyStr,
                              text: async () => bodyStr,
                              json: async () => JSON.parse(bodyStr),
                            });
                          };

                          const normalizeExecArgs = (first, args, options) => {
                            if (typeof first === "object" && first !== null && !Array.isArray(first)) {
                              return first;
                            }
                            return {
                              command: first,
                              ...(args === undefined ? {} : { args }),
                              ...(options && options.cwd !== undefined ? { cwd: options.cwd } : {})
                            };
                          };

                          const ctx = Object.freeze({
                            sessionId: meta.sessionId,
                            workspaceId: meta.workspaceId,
                            now: meta.now,
                            read: (resource, query) => invoke("read", resource, query ?? {}),
                            fetch: (url, options) => invoke("fetch", url, options ?? {}).then(wrapFetchResult),
                            exec: (first, args, options) => invoke("exec", normalizeExecArgs(first, args, options), null),
                          });

                          return Promise.resolve()
                            .then(() => {
                              const fn = (0, eval)(rawSource);
                              if (typeof fn !== "function") {
                                throw new Error("AUTOMATION_PROGRAM_MUST_BE_FUNCTION");
                              }
                              return fn(Object.freeze({ ctx }));
                            })
                            .then(
                              (val) => {
                                if (val === undefined) {
                                  return JSON.stringify({
                                    settled: true,
                                    ok: false,
                                    json: "",
                                    error: "AUTOMATION_INVALID_RESULT_UNDEFINED"
                                  });
                                }
                                return JSON.stringify({
                                  settled: true,
                                  ok: true,
                                  json: JSON.stringify(val),
                                  error: ""
                                });
                              },
                              (err) => JSON.stringify({
                                settled: true,
                                ok: false,
                                json: "",
                                error: err && err.message ? String(err.message) : String(err)
                              })
                            );
                        })()
                        "#,
                    );
                    let is_timeout = *timed_out.lock().expect("timeout lock");
                    let promise = extract_js_error(&qctx, eval_promise, is_timeout)?;
                    let finish_res = promise.finish::<String>();
                    let is_timeout = *timed_out.lock().expect("timeout lock");
                    extract_js_error(&qctx, finish_res, is_timeout)
                })
            })
            .join()
            .map_err(|_| PortError::new(PortErrorKind::Internal, "sandbox worker panicked"))?
        });

        let outcome_str = raw_outcome?;
        let outcome_val: Value = serde_json::from_str(&outcome_str)
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
        let settled = outcome_val
            .get("settled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !settled {
            return Err(PortError::new(
                PortErrorKind::InvalidInput,
                "AUTOMATION_PROGRAM_DID_NOT_SETTLE",
            ));
        }
        let ok = outcome_val
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !ok {
            let err_msg = outcome_val
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("AUTOMATION_PROGRAM_FAILED");
            return Err(PortError::new(PortErrorKind::InvalidInput, err_msg));
        }
        let result_json = outcome_val
            .get("json")
            .and_then(Value::as_str)
            .unwrap_or("");
        let matched = parse_and_validate_result(result_json)?;
        let guard = telemetry.lock().expect("telemetry lock");
        Ok(AutomationProgramEvaluation {
            matched,
            reads: guard.reads.iter().cloned().collect(),
            evidence: guard.evidence.clone(),
        })
    }
}
