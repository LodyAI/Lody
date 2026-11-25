use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, PortError, PortErrorKind, PortResult,
    SessionId, TerminalEventSink, TerminalOutboundEvent, VerifiedPrincipal,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc};
use tokio::task::AbortHandle;

const MAX_TERMINAL_LINE_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 103;

static NEXT_TERMINAL_SINK_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    #[serde(rename_all = "camelCase")]
    List {
        request_id: Option<String>,
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Open {
        request_id: Option<String>,
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    Attach {
        request_id: Option<String>,
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    Input {
        request_id: Option<String>,
        terminal_id: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        request_id: Option<String>,
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    Close {
        request_id: Option<String>,
        terminal_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CloseSession {
        request_id: Option<String>,
        session_id: String,
    },
}

struct SocketSinkForwarder {
    tx: mpsc::UnboundedSender<TerminalOutboundEvent>,
}

impl TerminalEventSink for SocketSinkForwarder {
    fn on_terminal_event(&self, event: TerminalOutboundEvent) {
        let _ = self.tx.send(event);
    }
}

#[derive(Default)]
struct ConnectionReplayState {
    subscribed: HashSet<String>,
    replaying: HashSet<String>,
    replay_buffers: HashMap<String, Vec<Value>>,
}

pub fn resolve_terminal_socket_path(data_dir: &Path, namespace: &str) -> io::Result<PathBuf> {
    let run_dir = data_dir.join("run");
    fs::create_dir_all(&run_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&run_dir, fs::Permissions::from_mode(0o700));
    }
    let primary = run_dir.join(format!("{namespace}-terminal.sock"));
    if primary.to_string_lossy().len() <= MAX_UNIX_SOCKET_PATH_BYTES {
        return Ok(primary);
    }
    let mut hasher = DefaultHasher::new();
    data_dir.hash(&mut hasher);
    let h = hasher.finish();
    Ok(std::env::temp_dir().join(format!("lody-{h:x}-t.sock")))
}

fn classify_terminal_error(err: &PortError) -> (&'static str, String) {
    let msg = err.message.clone();
    for prefix in [
        "session_not_found",
        "session_archived",
        "session_deleted",
        "session_machine_mismatch",
        "session_parent_cycle",
        "session_ambiguous",
        "terminal_not_found",
        "terminal_limit_exceeded",
        "workdir_unavailable",
    ] {
        if msg.starts_with(prefix) {
            return (prefix, msg);
        }
    }
    if msg.contains("workdir") || msg.contains("directory") || msg.contains("ENOENT") {
        return ("workdir_unavailable", msg);
    }
    ("terminal_error", msg)
}

fn event_terminal_id(ev: &TerminalOutboundEvent) -> &str {
    match ev {
        TerminalOutboundEvent::Data { terminal_id, .. }
        | TerminalOutboundEvent::Title { terminal_id, .. }
        | TerminalOutboundEvent::Exit { terminal_id, .. } => terminal_id,
    }
}

fn outbound_event_to_json(ev: &TerminalOutboundEvent) -> Value {
    serde_json::to_value(ev).unwrap_or_else(
        |_| json!({ "type": "error", "code": "terminal_error", "message": "serialize failed" }),
    )
}

fn build_error_frame(
    request_id: Option<&str>,
    terminal_id: Option<&str>,
    code: &str,
    message: &str,
) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".to_string(), Value::String("error".to_string()));
    if let Some(req_id) = request_id {
        obj.insert("requestId".to_string(), Value::String(req_id.to_string()));
    }
    if let Some(tid) = terminal_id {
        obj.insert("terminalId".to_string(), Value::String(tid.to_string()));
    }
    obj.insert("code".to_string(), Value::String(code.to_string()));
    obj.insert("message".to_string(), Value::String(message.to_string()));
    Value::Object(obj)
}

fn decode_utf8_stream_chunk(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_len = err.valid_up_to();
                if valid_len > 0 {
                    if let Ok(prefix) = std::str::from_utf8(&pending[..valid_len]) {
                        out.push_str(prefix);
                    }
                    pending.drain(..valid_len);
                }
                match err.error_len() {
                    Some(bad_len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..bad_len);
                    }
                    None => break,
                }
            }
        }
    }
    out
}

async fn write_ndjson_frame<W: AsyncWriteExt + Unpin>(writer: &mut W, frame: &Value) -> bool {
    let Ok(mut encoded) = serde_json::to_vec(frame) else {
        return true;
    };
    encoded.push(b'\n');
    writer.write_all(&encoded).await.is_ok() && writer.flush().await.is_ok()
}

async fn handle_client_message<W: AsyncWriteExt + Unpin>(
    service: &Arc<dyn ApplicationService>,
    state: &mut ConnectionReplayState,
    writer: &mut W,
    msg: TerminalClientMessage,
) -> bool {
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: None,
    };

    match msg {
        TerminalClientMessage::List {
            request_id,
            session_id,
        } => {
            if session_id.is_empty() {
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(
                        request_id.as_deref(),
                        None,
                        "invalid_request",
                        "sessionId must be non-empty",
                    ),
                )
                .await;
            }
            let svc = Arc::clone(service);
            let sid = SessionId(session_id.clone());
            let res = tokio::task::spawn_blocking(move || {
                svc.query(&caller, AppQuery::ListTerminals { session_id: sid })
            })
            .await;
            match res {
                Ok(Ok(AppResponse::TerminalsListed { terminals, .. })) => {
                    let mut frame = json!({
                        "type": "terminals",
                        "sessionId": session_id,
                        "terminals": terminals,
                    });
                    if let Some(req_id) = request_id {
                        frame["requestId"] = Value::String(req_id);
                    }
                    write_ndjson_frame(writer, &frame).await
                }
                Ok(Err(err)) => {
                    let (code, message) = classify_terminal_error(&err);
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(request_id.as_deref(), None, code, &message),
                    )
                    .await
                }
                _ => {
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(
                            request_id.as_deref(),
                            None,
                            "terminal_error",
                            "unexpected response",
                        ),
                    )
                    .await
                }
            }
        }
        TerminalClientMessage::Open {
            request_id,
            session_id,
            cols,
            rows,
        } => {
            if session_id.is_empty() || cols == 0 || rows == 0 {
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(
                        request_id.as_deref(),
                        None,
                        "invalid_request",
                        "sessionId, cols, and rows must be positive",
                    ),
                )
                .await;
            }
            let svc = Arc::clone(service);
            let cmd = AppCommand::TerminalOpen {
                session_id: SessionId(session_id),
                cols,
                rows,
            };
            let res = tokio::task::spawn_blocking(move || svc.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(AppResponse::TerminalOpened(opened))) => {
                    let mut frame = json!({
                        "type": "opened",
                        "terminalId": opened.terminal_id,
                        "cwd": opened.cwd,
                    });
                    if let Some(req_id) = request_id {
                        frame["requestId"] = Value::String(req_id);
                    }
                    write_ndjson_frame(writer, &frame).await
                }
                Ok(Err(err)) => {
                    let (code, message) = classify_terminal_error(&err);
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(request_id.as_deref(), None, code, &message),
                    )
                    .await
                }
                _ => {
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(
                            request_id.as_deref(),
                            None,
                            "terminal_error",
                            "unexpected response",
                        ),
                    )
                    .await
                }
            }
        }
        TerminalClientMessage::Attach {
            request_id,
            terminal_id,
            cols,
            rows,
        } => {
            if terminal_id.is_empty() || cols == 0 || rows == 0 {
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(
                        request_id.as_deref(),
                        Some(&terminal_id),
                        "invalid_request",
                        "terminalId, cols, and rows must be positive",
                    ),
                )
                .await;
            }
            state.subscribed.insert(terminal_id.clone());
            state.replaying.insert(terminal_id.clone());
            state.replay_buffers.insert(terminal_id.clone(), Vec::new());

            let svc = Arc::clone(service);
            let tid_for_cmd = terminal_id.clone();
            let res = tokio::task::spawn_blocking(move || {
                svc.execute(
                    &caller,
                    AppCommand::TerminalAttach {
                        terminal_id: tid_for_cmd,
                        cols,
                        rows,
                    },
                )
            })
            .await;

            match res {
                Ok(Ok(AppResponse::TerminalAttached(replay))) => {
                    if !write_ndjson_frame(
                        writer,
                        &json!({
                            "type": "title",
                            "terminalId": terminal_id,
                            "title": replay.title,
                        }),
                    )
                    .await
                    {
                        return false;
                    }
                    if !replay.scrollback.is_empty()
                        && !write_ndjson_frame(
                            writer,
                            &json!({
                                "type": "data",
                                "terminalId": terminal_id,
                                "data": replay.scrollback,
                                "replay": true,
                            }),
                        )
                        .await
                    {
                        return false;
                    }
                    state.replaying.remove(&terminal_id);
                    if let Some(buffered) = state.replay_buffers.remove(&terminal_id) {
                        for ev in buffered {
                            let is_exit = ev.get("type").and_then(Value::as_str) == Some("exit");
                            if !write_ndjson_frame(writer, &ev).await {
                                return false;
                            }
                            if is_exit {
                                state.subscribed.remove(&terminal_id);
                            }
                        }
                    }
                    true
                }
                Ok(Err(err)) => {
                    state.replaying.remove(&terminal_id);
                    state.replay_buffers.remove(&terminal_id);
                    state.subscribed.remove(&terminal_id);
                    let (code, message) = classify_terminal_error(&err);
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(
                            request_id.as_deref(),
                            Some(&terminal_id),
                            code,
                            &message,
                        ),
                    )
                    .await
                }
                _ => {
                    state.replaying.remove(&terminal_id);
                    state.replay_buffers.remove(&terminal_id);
                    state.subscribed.remove(&terminal_id);
                    write_ndjson_frame(
                        writer,
                        &build_error_frame(
                            request_id.as_deref(),
                            Some(&terminal_id),
                            "terminal_error",
                            "unexpected response",
                        ),
                    )
                    .await
                }
            }
        }
        TerminalClientMessage::Input {
            request_id,
            terminal_id,
            data,
        } => {
            let svc = Arc::clone(service);
            let tid_for_cmd = terminal_id.clone();
            let res = tokio::task::spawn_blocking(move || {
                svc.execute(
                    &caller,
                    AppCommand::TerminalInput {
                        terminal_id: tid_for_cmd,
                        data,
                    },
                )
            })
            .await;
            if let Ok(Err(err)) = res {
                let (code, message) = classify_terminal_error(&err);
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(request_id.as_deref(), Some(&terminal_id), code, &message),
                )
                .await;
            }
            true
        }
        TerminalClientMessage::Resize {
            request_id,
            terminal_id,
            cols,
            rows,
        } => {
            if cols == 0 || rows == 0 {
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(
                        request_id.as_deref(),
                        Some(&terminal_id),
                        "invalid_request",
                        "cols and rows must be positive",
                    ),
                )
                .await;
            }
            let svc = Arc::clone(service);
            let tid_for_cmd = terminal_id.clone();
            let res = tokio::task::spawn_blocking(move || {
                svc.execute(
                    &caller,
                    AppCommand::TerminalResize {
                        terminal_id: tid_for_cmd,
                        cols,
                        rows,
                    },
                )
            })
            .await;
            if let Ok(Err(err)) = res {
                let (code, message) = classify_terminal_error(&err);
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(request_id.as_deref(), Some(&terminal_id), code, &message),
                )
                .await;
            }
            true
        }
        TerminalClientMessage::Close {
            request_id,
            terminal_id,
        } => {
            let svc = Arc::clone(service);
            let tid_for_cmd = terminal_id.clone();
            let res = tokio::task::spawn_blocking(move || {
                svc.execute(
                    &caller,
                    AppCommand::TerminalClose {
                        terminal_id: tid_for_cmd,
                    },
                )
            })
            .await;
            if let Ok(Err(err)) = res {
                let (code, message) = classify_terminal_error(&err);
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(request_id.as_deref(), Some(&terminal_id), code, &message),
                )
                .await;
            }
            true
        }
        TerminalClientMessage::CloseSession {
            request_id,
            session_id,
        } => {
            if session_id.is_empty() {
                return write_ndjson_frame(
                    writer,
                    &build_error_frame(
                        request_id.as_deref(),
                        None,
                        "invalid_request",
                        "sessionId must be non-empty",
                    ),
                )
                .await;
            }
            let svc = Arc::clone(service);
            let _ = tokio::task::spawn_blocking(move || {
                svc.execute(
                    &caller,
                    AppCommand::TerminalCloseSession {
                        session_id: SessionId(session_id),
                    },
                )
            })
            .await;
            true
        }
    }
}

#[cfg(unix)]
async fn run_single_terminal_connection(
    stream: tokio::net::UnixStream,
    service: Arc<dyn ApplicationService>,
) {
    let sink_id = NEXT_TERMINAL_SINK_ID.fetch_add(1, Ordering::SeqCst);
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<TerminalOutboundEvent>();
    service.register_terminal_sink(sink_id, Arc::new(SocketSinkForwarder { tx: ev_tx }));

    let (mut reader, mut writer) = stream.into_split();
    let mut state = ConnectionReplayState::default();
    let mut read_buf = [0u8; 4096];
    let mut utf8_pending = Vec::with_capacity(4);
    let mut line_buffer = String::new();

    loop {
        tokio::select! {
            biased;
            maybe_ev = ev_rx.recv() => {
                let Some(ev) = maybe_ev else { break };
                let tid = event_terminal_id(&ev).to_string();
                if !state.subscribed.contains(&tid) {
                    continue;
                }
                let frame = outbound_event_to_json(&ev);
                if state.replaying.contains(&tid) {
                    state.replay_buffers.entry(tid).or_default().push(frame);
                    continue;
                }
                let is_exit = matches!(ev, TerminalOutboundEvent::Exit { .. });
                if !write_ndjson_frame(&mut writer, &frame).await {
                    break;
                }
                if is_exit {
                    state.subscribed.remove(&tid);
                }
            }
            read_res = reader.read(&mut read_buf) => {
                let Ok(n) = read_res else { break };
                if n == 0 {
                    break;
                }
                line_buffer.push_str(&decode_utf8_stream_chunk(&mut utf8_pending, &read_buf[..n]));
                if line_buffer.len() > MAX_TERMINAL_LINE_BUFFER_BYTES {
                    let _ = write_ndjson_frame(
                        &mut writer,
                        &build_error_frame(
                            None,
                            None,
                            "payload_too_large",
                            "Terminal socket payload exceeded buffer limit",
                        ),
                    )
                    .await;
                    break;
                }

                let mut keep_open = true;
                while let Some(newline_pos) = line_buffer.find('\n') {
                    let line = line_buffer[..newline_pos].trim().to_string();
                    line_buffer.drain(..=newline_pos);
                    if line.is_empty() {
                        continue;
                    }
                    let raw_val: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(err) => {
                            if !write_ndjson_frame(
                                &mut writer,
                                &build_error_frame(None, None, "invalid_json", &err.to_string()),
                            )
                            .await
                            {
                                keep_open = false;
                                break;
                            }
                            continue;
                        }
                    };
                    let req_id_hint = raw_val
                        .get("requestId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    let parsed: TerminalClientMessage = match serde_json::from_value(raw_val) {
                        Ok(m) => m,
                        Err(err) => {
                            if !write_ndjson_frame(
                                &mut writer,
                                &build_error_frame(
                                    req_id_hint.as_deref(),
                                    None,
                                    "invalid_request",
                                    &err.to_string(),
                                ),
                            )
                            .await
                            {
                                keep_open = false;
                                break;
                            }
                            continue;
                        }
                    };
                    if !handle_client_message(&service, &mut state, &mut writer, parsed).await {
                        keep_open = false;
                        break;
                    }
                }
                if !keep_open {
                    break;
                }
            }
        }
    }

    service.unregister_terminal_sink(sink_id);
}

#[cfg(unix)]
pub async fn start_local_terminal_server(
    data_dir: &Path,
    namespace: &str,
    service: Arc<dyn ApplicationService>,
    shutdown: Arc<Notify>,
) -> PortResult<(PathBuf, tokio::task::JoinHandle<()>)> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let socket_path = resolve_terminal_socket_path(data_dir, namespace)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let _ = fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));

    let sock_for_cleanup = socket_path.clone();
    let task = tokio::spawn(async move {
        let active_clients: Arc<Mutex<HashMap<u64, AbortHandle>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut conn_seq = 0u64;

        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    break;
                }
                accept_res = listener.accept() => {
                    let Ok((stream, _)) = accept_res else { continue };
                    conn_seq += 1;
                    let cid = conn_seq;
                    let svc = Arc::clone(&service);
                    let clients_map = Arc::clone(&active_clients);
                    let join = tokio::spawn(async move {
                        run_single_terminal_connection(stream, svc).await;
                        clients_map.lock().expect("clients lock").remove(&cid);
                    });
                    active_clients
                        .lock()
                        .expect("clients lock")
                        .insert(cid, join.abort_handle());
                }
            }
        }

        let handles: Vec<AbortHandle> = active_clients
            .lock()
            .expect("clients lock")
            .drain()
            .map(|(_, h)| h)
            .collect();
        for h in handles {
            h.abort();
        }
        let _ = fs::remove_file(&sock_for_cleanup);
    });

    Ok((socket_path, task))
}
