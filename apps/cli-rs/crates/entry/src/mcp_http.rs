use crate::ipc::format_history_json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, McpHttpEndpointConfig, PortError,
    PortErrorKind, PortResult, SessionId, TurnId, VerifiedPrincipal, WorkspaceId,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::Notify;

pub const MCP_HTTP_SESSION_ID_HEADER: &str = "x-lody-mcp-session-id";
pub const MCP_HTTP_WORKSPACE_ID_HEADER: &str = "x-lody-mcp-workspace-id";
pub const MCP_HTTP_MACHINE_ID_HEADER: &str = "x-lody-mcp-machine-id";
pub const MCP_HTTP_WORKDIR_B64_HEADER: &str = "x-lody-mcp-workdir-b64";

struct McpHttpServerState {
    service: Arc<dyn ApplicationService>,
    token: String,
    version: String,
    next_seq: AtomicU64,
}

#[derive(Debug, Clone)]
pub struct McpRequestContext {
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
    pub machine_id: String,
    pub workdir: String,
}

fn generate_mcp_bearer_token(machine_id: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("lody-mcp-http:{}:{nanos}:{machine_id}", std::process::id());
    let digest = Sha256::digest(seed.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

pub fn timing_safe_token_equal(provided: &str, expected: &str) -> bool {
    let a = Sha256::digest(provided.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn ip_to_proc_net_hexes(addr: IpAddr) -> Vec<String> {
    match addr {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            let v4_le = format!(
                "{:02X}{:02X}{:02X}{:02X}",
                octets[3], octets[2], octets[1], octets[0]
            );
            let mapped_v6 = format!("0000000000000000FFFF0000{v4_le}");
            vec![v4_le, mapped_v6]
        }
        IpAddr::V6(v6) => {
            let octets = v6.octets();
            let mut out = String::with_capacity(32);
            for chunk in octets.as_chunks::<4>().0 {
                let _ = write!(
                    out,
                    "{:02X}{:02X}{:02X}{:02X}",
                    chunk[3], chunk[2], chunk[1], chunk[0]
                );
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                let o4 = v4.octets();
                let v4_hex = format!("{:02X}{:02X}{:02X}{:02X}", o4[3], o4[2], o4[1], o4[0]);
                return vec![out, v4_hex];
            }
            vec![out]
        }
    }
}

fn proc_addr_matches(proc_addr: &str, allowed_hexes: &[String], expected_port: u16) -> bool {
    let Some((hex_ip, hex_port)) = proc_addr.rsplit_once(':') else {
        return false;
    };
    let Ok(parsed_port) = u16::from_str_radix(hex_port, 16) else {
        return false;
    };
    if parsed_port != expected_port {
        return false;
    }
    allowed_hexes
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(hex_ip))
}

pub fn find_peer_uid_in_proc_net_tcp(
    content: &str,
    peer_addr: IpAddr,
    peer_port: u16,
    server_addr: IpAddr,
    server_port: u16,
) -> Option<u32> {
    let peer_hexes = ip_to_proc_net_hexes(peer_addr);
    let server_hexes = ip_to_proc_net_hexes(server_addr);
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= 7 {
            continue;
        }
        if fields[3] != "01" {
            continue;
        }
        if !proc_addr_matches(fields[1], &peer_hexes, peer_port) {
            continue;
        }
        if !proc_addr_matches(fields[2], &server_hexes, server_port) {
            continue;
        }
        if let Ok(uid) = fields[7].parse::<u32>() {
            return Some(uid);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn verify_linux_loopback_peer_uid(peer: SocketAddr, server: SocketAddr) -> bool {
    let Ok(status_raw) = std::fs::read_to_string("/proc/self/status") else {
        return false;
    };
    let Some(my_uid) = status_raw.lines().find_map(|line| {
        let rest = line.strip_prefix("Uid:")?;
        rest.split_whitespace().next()?.parse::<u32>().ok()
    }) else {
        return false;
    };
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(content) = std::fs::read_to_string(table) else {
            continue;
        };
        if let Some(peer_uid) = find_peer_uid_in_proc_net_tcp(
            &content,
            peer.ip(),
            peer.port(),
            server.ip(),
            server.port(),
        ) {
            return peer_uid == my_uid;
        }
    }
    false
}

fn single_header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn decode_workdir_b64(encoded: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| URL_SAFE.decode(encoded))
        .ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    (!decoded.is_empty() && !decoded.contains('\0')).then_some(decoded)
}

pub fn parse_mcp_context_headers(headers: &HeaderMap) -> Option<McpRequestContext> {
    let session_raw = single_header(headers, MCP_HTTP_SESSION_ID_HEADER)?;
    let workspace_raw = single_header(headers, MCP_HTTP_WORKSPACE_ID_HEADER)?;
    let machine_raw = single_header(headers, MCP_HTTP_MACHINE_ID_HEADER)?;
    let workdir_b64 = single_header(headers, MCP_HTTP_WORKDIR_B64_HEADER)?;
    let workdir = decode_workdir_b64(workdir_b64)?;

    Some(McpRequestContext {
        session_id: SessionId(session_raw.to_string()),
        workspace_id: WorkspaceId(workspace_raw.to_string()),
        machine_id: machine_raw.to_string(),
        workdir,
    })
}

fn jsonrpc_http_error(
    status: StatusCode,
    code: i32,
    message: &str,
    allow_post_only: bool,
) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "error": { "code": code, "message": message },
        "id": Value::Null,
    });
    if allow_post_only {
        (
            status,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::ALLOW, "POST"),
            ],
            body.to_string(),
        )
            .into_response()
    } else {
        (
            status,
            [(header::CONTENT_TYPE, "application/json")],
            body.to_string(),
        )
            .into_response()
    }
}

fn builtin_mcp_tool_definitions() -> Value {
    json!([
        {
            "name": "lody_help",
            "description": "Read documentation for a built-in Lody MCP command.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "lody_session_create",
            "description": "Delegate work to a child session in the current workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "operationId": { "type": "string", "minLength": 1 },
                    "prompt": { "type": "string", "minLength": 1 },
                    "adapterId": { "type": "string" },
                    "sessionId": { "type": "string" }
                },
                "required": ["prompt"],
                "additionalProperties": false
            }
        },
        {
            "name": "lody_session_chat",
            "description": "Send a turn or steer an active turn in a known session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string", "minLength": 1 },
                    "operationId": { "type": "string" },
                    "prompt": { "type": "string", "minLength": 1 },
                    "steerActiveTurn": { "type": "boolean" }
                },
                "required": ["sessionId", "prompt"],
                "additionalProperties": false
            }
        },
        {
            "name": "lody_session_cancel",
            "description": "Request stopping the current turn of a session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string", "minLength": 1 }
                },
                "required": ["sessionId"],
                "additionalProperties": false
            }
        },
        {
            "name": "lody_session_history",
            "description": "Read visible turns from a session.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "lody_session_status_many",
            "description": "Inspect live execution state for one or more sessions.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionIds": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 }
                    }
                },
                "required": ["sessionIds"],
                "additionalProperties": false
            }
        },
        {
            "name": "lody_catalog",
            "description": "Read-only workspace catalog listing.",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["projects", "machines"] }
                },
                "required": ["action"],
                "additionalProperties": false
            }
        }
    ])
}

fn mcp_tool_result(payload: &Value, is_error: bool) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string())
            }
        ],
        "isError": is_error,
    })
}

async fn execute_tool_call(
    st: &Arc<McpHttpServerState>,
    ctx: &McpRequestContext,
    tool_name: &str,
    args: &Value,
) -> Value {
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: None,
    };
    let service = Arc::clone(&st.service);

    match tool_name {
        "lody_help" => {
            let cmd = args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("index");
            mcp_tool_result(
                &json!({
                    "command": cmd,
                    "tools": builtin_mcp_tool_definitions(),
                }),
                false,
            )
        }
        "lody_session_create" => {
            let Some(prompt) = args
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return mcp_tool_result(&json!({ "error": "prompt is required" }), true);
            };
            let seq = st.next_seq.fetch_add(1, Ordering::SeqCst);
            let child_sid = args
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| SessionId(s.to_string()))
                .unwrap_or_else(|| SessionId(format!("child-{}-{seq}", ctx.session_id.0)));
            let op_id = args
                .get("operationId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("op-{}-{seq}", ctx.session_id.0));
            let turn_id = TurnId(format!("turn-{op_id}"));
            let adapter_id = args
                .get("adapterId")
                .and_then(Value::as_str)
                .unwrap_or("custom")
                .to_string();

            let cmd = AppCommand::DelegateChildSession {
                workspace_id: ctx.workspace_id.clone(),
                parent_session_id: ctx.session_id.clone(),
                child_session_id: child_sid.clone(),
                turn_id: turn_id.clone(),
                operation_id: Some(op_id.clone()),
                adapter_id,
                custom_acp: None,
                prompt: prompt.to_string(),
            };

            match tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await {
                Ok(Ok(_)) => mcp_tool_result(
                    &json!({
                        "accepted": true,
                        "operationId": op_id,
                        "sessionId": child_sid.0,
                        "turnId": turn_id.0,
                    }),
                    false,
                ),
                Ok(Err(err)) => mcp_tool_result(
                    &json!({
                        "accepted": false,
                        "code": format!("{:?}", err.kind),
                        "error": err.message,
                    }),
                    true,
                ),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        "lody_session_chat" => {
            let Some(target_sid) = args
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return mcp_tool_result(&json!({ "error": "sessionId is required" }), true);
            };
            let Some(prompt) = args
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return mcp_tool_result(&json!({ "error": "prompt is required" }), true);
            };
            let seq = st.next_seq.fetch_add(1, Ordering::SeqCst);
            let turn_id = TurnId(
                args.get("operationId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("mcp-chat-{seq}")),
            );
            let steer = args
                .get("steerActiveTurn")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let session_id = SessionId(target_sid.to_string());
            let cmd = if steer {
                AppCommand::SteerTurn {
                    workspace_id: ctx.workspace_id.clone(),
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    prompt: prompt.to_string(),
                }
            } else {
                AppCommand::SendChat {
                    workspace_id: ctx.workspace_id.clone(),
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    custom_acp: None,
                    prompt: prompt.to_string(),
                }
            };
            match tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await {
                Ok(Ok(resp)) => mcp_tool_result(
                    &json!({
                        "accepted": true,
                        "sessionId": session_id.0,
                        "turnId": turn_id.0,
                        "response": resp,
                    }),
                    false,
                ),
                Ok(Err(err)) => mcp_tool_result(&json!({ "error": err.message }), true),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        "lody_session_cancel" => {
            let Some(target_sid) = args.get("sessionId").and_then(Value::as_str) else {
                return mcp_tool_result(&json!({ "error": "sessionId is required" }), true);
            };
            let cmd = AppCommand::CancelSession {
                workspace_id: ctx.workspace_id.clone(),
                session_id: SessionId(target_sid.to_string()),
                pause_inbox: false,
            };
            match tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await {
                Ok(Ok(_)) => {
                    mcp_tool_result(&json!({ "ok": true, "sessionId": target_sid }), false)
                }
                Ok(Err(err)) => mcp_tool_result(&json!({ "error": err.message }), true),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        "lody_session_history" => {
            let target_sid = args
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && *s != "current")
                .unwrap_or(&ctx.session_id.0)
                .to_string();
            let q = AppQuery::GetSessionHistory {
                workspace_id: ctx.workspace_id.clone(),
                session_id: SessionId(target_sid.clone()),
            };
            match tokio::task::spawn_blocking(move || service.query(&caller, q)).await {
                Ok(Ok(AppResponse::SessionHistory { turns })) => {
                    mcp_tool_result(&format_history_json(&target_sid, &turns), false)
                }
                Ok(Ok(_)) => mcp_tool_result(&json!({ "error": "unexpected response" }), true),
                Ok(Err(err)) => mcp_tool_result(&json!({ "error": err.message }), true),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        "lody_session_status_many" => {
            let ids: Vec<SessionId> = args
                .get("sessionIds")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| SessionId(s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let machine_id = ctx.machine_id.clone();
            let q = AppQuery::GetSessionStatuses {
                workspace_id: ctx.workspace_id.clone(),
                session_ids: ids,
            };
            match tokio::task::spawn_blocking(move || service.query(&caller, q)).await {
                Ok(Ok(AppResponse::SessionStatuses { statuses })) => {
                    let items: Vec<Value> = statuses
                        .into_iter()
                        .map(|st| {
                            json!({
                                "sessionId": st.session_id.0,
                                "ok": true,
                                "value": {
                                    "execution": {
                                        "executionState": st.execution_state,
                                        "phase": st.phase,
                                        "activeTurnId": st.active_turn_id.map(|t| t.0),
                                    },
                                    "machine": { "state": "online", "machineId": machine_id }
                                }
                            })
                        })
                        .collect();
                    mcp_tool_result(&json!({ "items": items }), false)
                }
                Ok(Ok(_)) => mcp_tool_result(&json!({ "error": "unexpected response" }), true),
                Ok(Err(err)) => mcp_tool_result(&json!({ "error": err.message }), true),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        "lody_catalog" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("machines");
            if action == "machines" {
                return mcp_tool_result(
                    &json!({
                        "machines": [{
                            "machineId": ctx.machine_id,
                            "state": "online",
                        }]
                    }),
                    false,
                );
            }
            match tokio::task::spawn_blocking(move || {
                service.query(&caller, AppQuery::ListProjects)
            })
            .await
            {
                Ok(Ok(AppResponse::ProjectsListed { projects })) => {
                    mcp_tool_result(&json!({ "projects": projects }), false)
                }
                Ok(Ok(_)) => mcp_tool_result(&json!({ "error": "unexpected response" }), true),
                Ok(Err(err)) => mcp_tool_result(&json!({ "error": err.message }), true),
                Err(err) => mcp_tool_result(&json!({ "error": err.to_string() }), true),
            }
        }
        unknown => mcp_tool_result(
            &json!({ "error": format!("unknown Lody MCP tool '{unknown}'") }),
            true,
        ),
    }
}

async fn process_single_jsonrpc(
    st: &Arc<McpHttpServerState>,
    ctx: &McpRequestContext,
    req: Value,
) -> Option<Value> {
    let id_opt = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    let id = id_opt?;

    match method {
        "initialize" => {
            let proto = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-03-26");
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": proto,
                    "capabilities": {
                        "tools": { "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "lody",
                        "version": st.version,
                    }
                }
            }))
        }
        "ping" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {},
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": builtin_mcp_tool_definitions(),
            }
        })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": "missing tool name" }
                }));
            };
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let tool_res = execute_tool_call(st, ctx, name, &args).await;
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": tool_res,
            }))
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        })),
    }
}

async fn handle_mcp_endpoint(
    State((st, local_addr)): State<(Arc<McpHttpServerState>, SocketAddr)>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    method: Method,
    headers: HeaderMap,
    body: String,
) -> Response {
    if method == Method::GET || method == Method::HEAD {
        return jsonrpc_http_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed",
            true,
        );
    }
    if method != Method::POST {
        return jsonrpc_http_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed",
            true,
        );
    }

    let auth = single_header(&headers, "authorization").unwrap_or("");
    let Some(bearer) = auth.strip_prefix("Bearer ") else {
        return jsonrpc_http_error(StatusCode::UNAUTHORIZED, -32000, "Unauthorized", false);
    };
    if !timing_safe_token_equal(bearer, &st.token) {
        return jsonrpc_http_error(StatusCode::UNAUTHORIZED, -32000, "Unauthorized", false);
    }

    #[cfg(target_os = "linux")]
    if !verify_linux_loopback_peer_uid(peer_addr, local_addr) {
        return jsonrpc_http_error(StatusCode::FORBIDDEN, -32000, "Forbidden", false);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (peer_addr, local_addr);

    let Some(ctx) = parse_mcp_context_headers(&headers) else {
        return jsonrpc_http_error(
            StatusCode::BAD_REQUEST,
            -32000,
            "Missing or invalid Lody MCP session context headers",
            false,
        );
    };

    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return jsonrpc_http_error(StatusCode::BAD_REQUEST, -32700, "Parse error", false);
    };

    if let Some(batch) = parsed.as_array() {
        let mut replies = Vec::new();
        for item in batch {
            if let Some(r) = process_single_jsonrpc(&st, &ctx, item.clone()).await {
                replies.push(r);
            }
        }
        if replies.is_empty() {
            return StatusCode::ACCEPTED.into_response();
        }
        return (StatusCode::OK, Json(Value::Array(replies))).into_response();
    }

    match process_single_jsonrpc(&st, &ctx, parsed).await {
        Some(reply) => (StatusCode::OK, Json(reply)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

pub async fn start_mcp_http_server(
    service: Arc<dyn ApplicationService>,
    machine_id: &str,
    version: &str,
    shutdown: Arc<Notify>,
) -> PortResult<(McpHttpEndpointConfig, tokio::task::JoinHandle<()>)> {
    #[cfg(target_os = "linux")]
    if std::fs::File::open("/proc/net/tcp").is_err() {
        return Err(PortError::new(
            PortErrorKind::Unavailable,
            "cannot read /proc/net/tcp; refusing to serve MCP over TCP",
        ));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;

    let token = generate_mcp_bearer_token(machine_id);
    let endpoint = McpHttpEndpointConfig {
        url: format!("http://127.0.0.1:{}/mcp", local_addr.port()),
        token: token.clone(),
    };
    service.set_mcp_http_endpoint(endpoint.clone());

    let state = Arc::new(McpHttpServerState {
        service,
        token,
        version: version.to_string(),
        next_seq: AtomicU64::new(1),
    });

    let app = Router::new()
        .route("/mcp", any(handle_mcp_endpoint))
        .with_state((state, local_addr))
        .into_make_service_with_connect_info::<SocketAddr>();

    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown.notified().await;
            })
            .await;
    });

    Ok((endpoint, task))
}
