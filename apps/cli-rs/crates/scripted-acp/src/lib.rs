use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordedAcpEvent {
    pub pid: u32,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionState {
    cwd: PathBuf,
    mcp_servers: Value,
    revision: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptDirective {
    Title,
    Reply {
        text: String,
    },
    EditFile {
        relative_path: String,
        content: String,
    },
    Permission {
        title: String,
    },
    Hold {
        barrier_dir: PathBuf,
    },
    McpInfo,
    McpDelegate {
        child_prompt: String,
    },
    Crash,
}

pub fn parse_prompt_directive(prompt_text: &str) -> PromptDirective {
    if prompt_text.contains("You generate titles for coding sessions.") {
        return PromptDirective::Title;
    }
    let Some(directive) = extract_last_tag(prompt_text, "[SCRIPTED:") else {
        return PromptDirective::Reply {
            text: format!("Echo: {}", prompt_text.lines().last().unwrap_or("").trim()),
        };
    };
    if let Some(rest) = directive.strip_prefix("REPLY:") {
        return PromptDirective::Reply {
            text: rest.to_string(),
        };
    }
    if let Some(rest) = directive.strip_prefix("EDIT:") {
        let mut parts = rest.splitn(2, ':');
        let relative_path = parts.next().unwrap_or("edited.txt").to_string();
        let content = parts.next().unwrap_or("updated\n").to_string();
        return PromptDirective::EditFile {
            relative_path,
            content,
        };
    }
    if let Some(rest) = directive.strip_prefix("PERMISSION:") {
        return PromptDirective::Permission {
            title: rest.to_string(),
        };
    }
    if directive == "PERMISSION" {
        return PromptDirective::Permission {
            title: "Run synthetic tool".to_string(),
        };
    }
    if let Some(rest) = directive.strip_prefix("HOLD:") {
        return PromptDirective::Hold {
            barrier_dir: PathBuf::from(rest),
        };
    }
    if directive == "MCP_INFO" {
        return PromptDirective::McpInfo;
    }
    if let Some(rest) = directive.strip_prefix("MCP_DELEGATE:") {
        return PromptDirective::McpDelegate {
            child_prompt: rest.to_string(),
        };
    }
    if directive == "CRASH" {
        return PromptDirective::Crash;
    }
    PromptDirective::Reply {
        text: format!("Handled directive: {directive}"),
    }
}

pub fn extract_marker(prompt_text: &str) -> Option<String> {
    extract_last_tag(prompt_text, "[MARK:")
}

fn extract_last_tag(text: &str, prefix: &str) -> Option<String> {
    let mut found = None;
    let mut rest = text;
    while let Some(start) = rest.find(prefix) {
        let after = &rest[start + prefix.len()..];
        let mut depth = 1usize;
        let mut end_idx = None;
        for (idx, ch) in after.char_indices() {
            if ch == '[' {
                depth += 1;
            } else if ch == ']' {
                depth -= 1;
                if depth == 0 {
                    end_idx = Some(idx);
                    break;
                }
            }
        }
        if let Some(end) = end_idx {
            found = Some(after[..end].to_string());
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
    found
}

fn extract_prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

struct EventRecorder {
    path: Option<PathBuf>,
}

impl EventRecorder {
    fn record(&self, event: RecordedAcpEvent) {
        let Some(path) = &self.path else { return };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path)
            && let Ok(line) = serde_json::to_string(&event)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn send_json<W: Write>(writer: &Arc<Mutex<W>>, payload: &Value) -> io::Result<()> {
    let mut guard = writer.lock().unwrap();
    let serialized = serde_json::to_string(payload)?;
    writeln!(guard, "{serialized}")?;
    guard.flush()
}

fn emit_text_chunk<W: Write>(
    writer: &Arc<Mutex<W>>,
    session_id: &str,
    text: &str,
) -> io::Result<()> {
    send_json(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }
        }),
    )
}

pub fn run_stdio_loop<R, W>(
    reader: R,
    writer: W,
    event_log_path: Option<PathBuf>,
) -> io::Result<i32>
where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    let pid = std::process::id();
    let recorder = Arc::new(EventRecorder {
        path: event_log_path,
    });
    recorder.record(RecordedAcpEvent {
        pid,
        event: "process-start".to_string(),
        session_id: None,
        mode: None,
        marker: None,
        outcome: None,
        stop_reason: None,
    });

    let writer = Arc::new(Mutex::new(writer));
    let sessions: Arc<Mutex<HashMap<String, SessionState>>> = Arc::new(Mutex::new(HashMap::new()));
    let pending_client_replies: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let cancel_flags: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));

    let (req_tx, req_rx) = mpsc::channel::<Value>();
    let replies_for_reader = Arc::clone(&pending_client_replies);
    let cancels_for_reader = Arc::clone(&cancel_flags);
    let recorder_for_reader = Arc::clone(&recorder);

    thread::spawn(move || {
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
                if let Some(id_val) = msg.get("id")
                    && let Some(tx) = replies_for_reader
                        .lock()
                        .unwrap()
                        .remove(&id_val.to_string())
                {
                    let _ = tx.send(msg);
                }
                continue;
            }
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            if method == "session/cancel" || method == "$/cancel_request" {
                if let Some(sid) = msg
                    .get("params")
                    .and_then(|p| p.get("sessionId"))
                    .and_then(Value::as_str)
                {
                    cancels_for_reader
                        .lock()
                        .unwrap()
                        .insert(sid.to_string(), true);
                    recorder_for_reader.record(RecordedAcpEvent {
                        pid,
                        event: "session-cancel".to_string(),
                        session_id: Some(sid.to_string()),
                        mode: None,
                        marker: None,
                        outcome: None,
                        stop_reason: None,
                    });
                }
                if let Some(id) = msg.get("id").cloned() {
                    let _ = req_tx.send(json!({ "__cancel_ack_id": id }));
                }
                continue;
            }
            if req_tx.send(msg).is_err() {
                break;
            }
        }
    });

    let mut session_seq = 0usize;
    let mut outbound_req_seq = 0usize;
    let exit_code = process_requests(
        req_rx,
        &writer,
        &sessions,
        &pending_client_replies,
        &cancel_flags,
        &recorder,
        pid,
        &mut session_seq,
        &mut outbound_req_seq,
    )?;
    Ok(exit_code)
}

#[allow(clippy::too_many_arguments)]
fn process_requests<W: Write>(
    req_rx: Receiver<Value>,
    writer: &Arc<Mutex<W>>,
    sessions: &Arc<Mutex<HashMap<String, SessionState>>>,
    pending_client_replies: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    cancel_flags: &Arc<Mutex<HashMap<String, bool>>>,
    recorder: &Arc<EventRecorder>,
    pid: u32,
    session_seq: &mut usize,
    outbound_req_seq: &mut usize,
) -> io::Result<i32> {
    while let Ok(msg) = req_rx.recv() {
        if let Some(ack_id) = msg.get("__cancel_ack_id") {
            send_json(
                writer,
                &json!({ "jsonrpc": "2.0", "id": ack_id, "result": {} }),
            )?;
            continue;
        }
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        match method {
            "initialize" => {
                recorder.record(RecordedAcpEvent {
                    pid,
                    event: "initialize".to_string(),
                    session_id: None,
                    mode: None,
                    marker: None,
                    outcome: None,
                    stop_reason: None,
                });
                let protocol_version = params
                    .get("protocolVersion")
                    .cloned()
                    .unwrap_or_else(|| json!(1));
                send_json(
                    writer,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "protocolVersion": protocol_version,
                            "agentCapabilities": {
                                "loadSession": true,
                                "mcpCapabilities": { "http": true }
                            },
                            "agentInfo": {
                                "name": "lody-scripted-acp",
                                "version": "0.1.0"
                            }
                        }
                    }),
                )?;
            }
            "session/new" => {
                *session_seq += 1;
                let session_id = format!("scripted-session-{pid}-{}", *session_seq);
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                let mcp_servers = params
                    .get("mcpServers")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                sessions.lock().unwrap().insert(
                    session_id.clone(),
                    SessionState {
                        cwd,
                        mcp_servers,
                        revision: 0,
                    },
                );
                recorder.record(RecordedAcpEvent {
                    pid,
                    event: "session-new".to_string(),
                    session_id: Some(session_id.clone()),
                    mode: None,
                    marker: None,
                    outcome: None,
                    stop_reason: None,
                });
                send_json(
                    writer,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "sessionId": session_id }
                    }),
                )?;
            }
            "session/load" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("scripted-loaded")
                    .to_string();
                let cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                let mcp_servers = params
                    .get("mcpServers")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                sessions
                    .lock()
                    .unwrap()
                    .entry(session_id.clone())
                    .or_insert(SessionState {
                        cwd,
                        mcp_servers,
                        revision: 0,
                    });
                recorder.record(RecordedAcpEvent {
                    pid,
                    event: "session-load".to_string(),
                    session_id: Some(session_id),
                    mode: None,
                    marker: None,
                    outcome: None,
                    stop_reason: None,
                });
                send_json(writer, &json!({ "jsonrpc": "2.0", "id": id, "result": {} }))?;
            }
            "session/set_mode" | "session/set_model" | "session/set_config_option" => {
                send_json(writer, &json!({ "jsonrpc": "2.0", "id": id, "result": {} }))?;
            }
            "session/prompt" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cancel_flags
                    .lock()
                    .unwrap()
                    .insert(session_id.clone(), false);
                let text = extract_prompt_text(&params);
                let marker = extract_marker(&text);
                let directive = parse_prompt_directive(&text);
                let mode_name = match &directive {
                    PromptDirective::Title => "title",
                    PromptDirective::Reply { .. } => "reply",
                    PromptDirective::EditFile { .. } => "edit",
                    PromptDirective::Permission { .. } => "permission",
                    PromptDirective::Hold { .. } => "hold",
                    PromptDirective::McpInfo => "mcp-info",
                    PromptDirective::McpDelegate { .. } => "mcp-delegate",
                    PromptDirective::Crash => "crash",
                };
                recorder.record(RecordedAcpEvent {
                    pid,
                    event: "prompt-start".to_string(),
                    session_id: Some(session_id.clone()),
                    mode: Some(mode_name.to_string()),
                    marker: marker.clone(),
                    outcome: None,
                    stop_reason: None,
                });

                match directive {
                    PromptDirective::Crash => {
                        emit_text_chunk(writer, &session_id, "Crash triggered.")?;
                        recorder.record(RecordedAcpEvent {
                            pid,
                            event: "process-crash".to_string(),
                            session_id: Some(session_id),
                            mode: Some("crash".to_string()),
                            marker,
                            outcome: None,
                            stop_reason: None,
                        });
                        return Ok(1);
                    }
                    PromptDirective::Title => {
                        emit_text_chunk(writer, &session_id, "Synthetic Session Title")?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "title",
                            marker,
                            "end_turn",
                        )?;
                    }
                    PromptDirective::Reply { text: reply } => {
                        emit_text_chunk(writer, &session_id, &reply)?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "reply",
                            marker,
                            "end_turn",
                        )?;
                    }
                    PromptDirective::EditFile {
                        relative_path,
                        content,
                    } => {
                        let target = {
                            let mut guard = sessions.lock().unwrap();
                            let Some(state) = guard.get_mut(&session_id) else {
                                send_error(writer, &id, -32602, "Unknown session")?;
                                continue;
                            };
                            state.revision += 1;
                            state.cwd.join(&relative_path)
                        };
                        if let Some(parent) = target.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::write(&target, content.replace("\\n", "\n"))?;
                        emit_text_chunk(writer, &session_id, &format!("Edited {relative_path}"))?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "edit",
                            marker,
                            "end_turn",
                        )?;
                    }
                    PromptDirective::McpInfo => {
                        let count = sessions
                            .lock()
                            .unwrap()
                            .get(&session_id)
                            .and_then(|s| s.mcp_servers.as_array().map(Vec::len))
                            .unwrap_or(0);
                        emit_text_chunk(
                            writer,
                            &session_id,
                            &format!("MCP servers mounted: {count}"),
                        )?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "mcp-info",
                            marker,
                            "end_turn",
                        )?;
                    }
                    PromptDirective::McpDelegate { child_prompt } => {
                        let mcp_entry = sessions
                            .lock()
                            .unwrap()
                            .get(&session_id)
                            .and_then(|s| s.mcp_servers.as_array()?.first().cloned());
                        let outcome_str = match mcp_entry {
                            Some(entry) => {
                                invoke_loopback_mcp_session_create(&entry, &child_prompt)
                            }
                            None => "err:no_mcp_server".to_string(),
                        };
                        recorder.record(RecordedAcpEvent {
                            pid,
                            event: "mcp-delegate".to_string(),
                            session_id: Some(session_id.clone()),
                            mode: Some("mcp-delegate".to_string()),
                            marker: marker.clone(),
                            outcome: Some(outcome_str.clone()),
                            stop_reason: None,
                        });
                        emit_text_chunk(
                            writer,
                            &session_id,
                            &format!("MCP delegate result: {outcome_str}"),
                        )?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "mcp-delegate",
                            marker,
                            "end_turn",
                        )?;
                    }
                    PromptDirective::Permission { title } => {
                        *outbound_req_seq += 1;
                        let req_id = format!("perm-req-{}", *outbound_req_seq);
                        let tool_call_id = format!("tool-call-{}", *outbound_req_seq);
                        send_json(
                            writer,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "session/update",
                                "params": {
                                    "sessionId": session_id,
                                    "update": {
                                        "sessionUpdate": "tool_call",
                                        "toolCallId": tool_call_id,
                                        "title": title,
                                        "kind": "edit",
                                        "status": "pending"
                                    }
                                }
                            }),
                        )?;
                        let (reply_tx, reply_rx) = mpsc::channel();
                        let req_key = json!(req_id).to_string();
                        pending_client_replies
                            .lock()
                            .unwrap()
                            .insert(req_key.clone(), reply_tx);
                        send_json(
                            writer,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": req_id,
                                "method": "session/request_permission",
                                "params": {
                                    "sessionId": session_id,
                                    "toolCall": {
                                        "toolCallId": tool_call_id,
                                        "title": title,
                                        "kind": "edit",
                                        "status": "pending"
                                    },
                                    "options": [
                                        { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                                        { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
                                    ]
                                }
                            }),
                        )?;
                        let outcome =
                            wait_for_permission_or_cancel(&reply_rx, cancel_flags, &session_id);
                        pending_client_replies.lock().unwrap().remove(&req_key);
                        recorder.record(RecordedAcpEvent {
                            pid,
                            event: "permission-outcome".to_string(),
                            session_id: Some(session_id.clone()),
                            mode: Some("permission".to_string()),
                            marker: marker.clone(),
                            outcome: Some(outcome.clone()),
                            stop_reason: None,
                        });
                        let (tool_status, stop_reason) = match outcome.as_str() {
                            "allow-once" => ("completed", "end_turn"),
                            "cancelled" => ("failed", "cancelled"),
                            _ => ("failed", "end_turn"),
                        };
                        send_json(
                            writer,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "session/update",
                                "params": {
                                    "sessionId": session_id,
                                    "update": {
                                        "sessionUpdate": "tool_call_update",
                                        "toolCallId": tool_call_id,
                                        "status": tool_status
                                    }
                                }
                            }),
                        )?;
                        emit_text_chunk(
                            writer,
                            &session_id,
                            &format!("Permission outcome: {outcome}"),
                        )?;
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "permission",
                            marker,
                            stop_reason,
                        )?;
                    }
                    PromptDirective::Hold { barrier_dir } => {
                        fs::create_dir_all(&barrier_dir)?;
                        emit_text_chunk(writer, &session_id, "Hold started.")?;
                        fs::write(barrier_dir.join("entered"), session_id.as_bytes())?;
                        let release_path = barrier_dir.join("release");
                        let stop_reason =
                            wait_for_release_or_cancel(&release_path, cancel_flags, &session_id);
                        if stop_reason == "end_turn" {
                            let suffix = fs::read_to_string(&release_path).unwrap_or_default();
                            let reply = if suffix.trim().is_empty() {
                                "Hold released.".to_string()
                            } else {
                                format!("Hold released: {}", suffix.trim())
                            };
                            emit_text_chunk(writer, &session_id, &reply)?;
                        }
                        finish_prompt(
                            writer,
                            recorder,
                            pid,
                            &id,
                            &session_id,
                            "hold",
                            marker,
                            stop_reason,
                        )?;
                    }
                }
            }
            _ => {
                send_error(
                    writer,
                    &id,
                    -32601,
                    &format!("Unsupported method: {method}"),
                )?;
            }
        }
    }
    Ok(0)
}

fn wait_for_permission_or_cancel(
    reply_rx: &Receiver<Value>,
    cancel_flags: &Arc<Mutex<HashMap<String, bool>>>,
    session_id: &str,
) -> String {
    loop {
        if cancel_flags
            .lock()
            .unwrap()
            .get(session_id)
            .copied()
            .unwrap_or(false)
        {
            return "cancelled".to_string();
        }
        if let Ok(reply) = reply_rx.recv_timeout(Duration::from_millis(20)) {
            let selected = reply
                .get("result")
                .and_then(|r| r.get("outcome"))
                .and_then(|o| {
                    if o.get("outcome").and_then(Value::as_str) == Some("selected") {
                        o.get("optionId").and_then(Value::as_str)
                    } else {
                        Some("cancelled")
                    }
                })
                .unwrap_or("cancelled");
            return selected.to_string();
        }
    }
}

fn wait_for_release_or_cancel(
    release_path: &Path,
    cancel_flags: &Arc<Mutex<HashMap<String, bool>>>,
    session_id: &str,
) -> &'static str {
    loop {
        if cancel_flags
            .lock()
            .unwrap()
            .get(session_id)
            .copied()
            .unwrap_or(false)
        {
            return "cancelled";
        }
        if release_path.exists() {
            return "end_turn";
        }
        thread::sleep(Duration::from_millis(15));
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_prompt<W: Write>(
    writer: &Arc<Mutex<W>>,
    recorder: &Arc<EventRecorder>,
    pid: u32,
    id: &Value,
    session_id: &str,
    mode: &str,
    marker: Option<String>,
    stop_reason: &str,
) -> io::Result<()> {
    recorder.record(RecordedAcpEvent {
        pid,
        event: "prompt-end".to_string(),
        session_id: Some(session_id.to_string()),
        mode: Some(mode.to_string()),
        marker,
        outcome: None,
        stop_reason: Some(stop_reason.to_string()),
    });
    send_json(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "stopReason": stop_reason }
        }),
    )
}

fn send_error<W: Write>(
    writer: &Arc<Mutex<W>>,
    id: &Value,
    code: i32,
    message: &str,
) -> io::Result<()> {
    send_json(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }),
    )
}

fn invoke_loopback_mcp_session_create(mcp_entry: &Value, child_prompt: &str) -> String {
    use std::io::Read as _;
    use std::net::TcpStream;

    let Some(url) = mcp_entry.get("url").and_then(Value::as_str) else {
        return "err:missing_url".to_string();
    };
    let rest = url.strip_prefix("http://").unwrap_or(url);
    let (host_port, path) = match rest.split_once('/') {
        Some((hp, p)) => (hp, format!("/{p}")),
        None => (rest, "/mcp".to_string()),
    };

    let Ok(mut stream) = TcpStream::connect(host_port) else {
        return "err:connect_failed".to_string();
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "lody_session_create",
            "arguments": {
                "prompt": child_prompt,
            }
        }
    }))
    .unwrap_or_default();

    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(headers) = mcp_entry.get("headers").and_then(Value::as_array) {
        for h in headers {
            if let (Some(k), Some(v)) = (
                h.get("name").and_then(Value::as_str),
                h.get("value").and_then(Value::as_str),
            ) {
                req.push_str(&format!("{k}: {v}\r\n"));
            }
        }
    }
    req.push_str("\r\n");

    if stream.write_all(req.as_bytes()).is_err() || stream.write_all(&body).is_err() {
        return "err:write_failed".to_string();
    }
    let _ = stream.flush();

    let mut resp_bytes = Vec::new();
    let _ = stream.read_to_end(&mut resp_bytes);
    let resp_str = String::from_utf8_lossy(&resp_bytes);
    let Some((_, payload_part)) = resp_str.split_once("\r\n\r\n") else {
        return "err:invalid_http".to_string();
    };
    let Ok(rpc_json) = serde_json::from_str::<Value>(payload_part.trim()) else {
        return format!("err:non_json:{}", payload_part.trim());
    };
    let is_err = rpc_json
        .get("result")
        .and_then(|r| r.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let text = rpc_json
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if is_err {
        format!("rejected:{text}")
    } else {
        format!("accepted:{text}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn parses_newest_scripted_directive_and_marker() {
        let prompt = "Prior context [SCRIPTED:REPLY:old] [MARK:m1]\nUser: [SCRIPTED:EDIT:src/lib.rs:pub fn ok() {}] [MARK:m2]";
        assert_eq!(extract_marker(prompt).as_deref(), Some("m2"));
        assert_eq!(
            parse_prompt_directive(prompt),
            PromptDirective::EditFile {
                relative_path: "src/lib.rs".to_string(),
                content: "pub fn ok() {}".to_string(),
            }
        );
    }

    #[test]
    fn executes_initialize_new_session_and_edit_over_stdio() {
        let dir = tempfile::tempdir().unwrap();
        let event_log = dir.path().join("events.jsonl");
        let workdir = dir.path().join("repo");
        fs::create_dir_all(&workdir).unwrap();

        let input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": workdir, "mcpServers": [] } }),
        ]
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n")
            + "\n";

        let out_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct SharedVec(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedVec {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let code = run_stdio_loop(
            BufReader::new(io::Cursor::new(input.into_bytes())),
            SharedVec(Arc::clone(&out_buf)),
            Some(event_log.clone()),
        )
        .unwrap();
        assert_eq!(code, 0);

        let lines: Vec<Value> = String::from_utf8(out_buf.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        let session_id = lines[1]["result"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let out_buf2: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let turn_input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "session/load", "params": { "sessionId": session_id, "cwd": workdir } }),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": "[SCRIPTED:EDIT:hello.txt:hello world] [MARK:t1]" }]
                }
            }),
        ]
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n")
            + "\n";

        let code2 = run_stdio_loop(
            BufReader::new(io::Cursor::new(turn_input.into_bytes())),
            SharedVec(Arc::clone(&out_buf2)),
            Some(event_log),
        )
        .unwrap();
        assert_eq!(code2, 0);
        assert_eq!(
            fs::read_to_string(workdir.join("hello.txt")).unwrap(),
            "hello world"
        );
    }
}
