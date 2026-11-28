use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, BranchListQuery, BrowseDirectoryQuery,
    CustomCommandSpec, HistoryBlock, HistoryTurnRecord, LocalProjectId, PermissionDecision,
    PortError, PortErrorKind, PortResult, SessionId, TurnId, TurnTerminalOutcome, UserId,
    VerifiedPrincipal, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::fmt::Write as _;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

pub const IPC_TOKEN_HEADER: &str = "x-lody-ipc-token";
pub const LOCAL_CONTROL_HEADER: &str = "x-lody-local-control";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRunMetadata {
    pub pid: u32,
    pub socket_path: String,
    pub control_socket_path: String,
    pub version: String,
    pub started_at: String,
    pub token: Option<String>,
}

impl DaemonRunMetadata {
    pub fn file_path(data_dir: &Path) -> PathBuf {
        data_dir.join("run").join("daemon.json")
    }

    pub fn read(data_dir: &Path) -> Option<Self> {
        let raw = fs::read_to_string(Self::file_path(data_dir)).ok()?;
        serde_json::from_str(&raw).ok()
    }
}

fn hash_path(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

fn resolve_socket_paths(data_dir: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let run_dir = data_dir.join("run");
    fs::create_dir_all(&run_dir)?;
    let probe = run_dir.join("p.sock");
    let control = run_dir.join("c.sock");
    if probe.to_string_lossy().len() <= 96 && control.to_string_lossy().len() <= 96 {
        return Ok((probe, control));
    }
    let short_hash = hash_path(data_dir);
    let tmp = std::env::temp_dir();
    Ok((
        tmp.join(format!("lody-{short_hash:x}-p.sock")),
        tmp.join(format!("lody-{short_hash:x}-c.sock")),
    ))
}

fn generate_ipc_token(data_dir: &Path) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!(
        "lody-ipc:{}:{nanos}:{}",
        std::process::id(),
        data_dir.to_string_lossy()
    );
    let digest = Sha256::digest(seed.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

struct ServerState {
    service: Arc<dyn ApplicationService>,
    mcp_dispatcher: Arc<crate::mcp_http::McpDispatcher>,
    machine_id: String,
    home_dir: String,
    version: String,
    token: String,
    shutdown: Arc<Notify>,
}

fn check_token(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, String)> {
    let supplied = headers
        .get(IPC_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if supplied != expected {
        return Err((StatusCode::UNAUTHORIZED, "invalid ipc token".to_string()));
    }
    Ok(())
}

pub fn format_history_json(session_id: &str, turns: &[HistoryTurnRecord]) -> Value {
    let mut entries = Vec::with_capacity(turns.len() * 2);
    for turn in turns {
        let user_status = match turn.outcome {
            None => "pending",
            Some(TurnTerminalOutcome::Finished) => "handled",
            Some(TurnTerminalOutcome::Canceled) => "canceled",
            Some(TurnTerminalOutcome::Failed) => "failed",
        };
        entries.push(json!({
            "id": turn.turn_id.0,
            "role": "user",
            "status": user_status,
            "items": [
                { "type": "text", "text": turn.user_prompt }
            ]
        }));

        if !turn.assistant_blocks.is_empty()
            || matches!(turn.outcome, Some(TurnTerminalOutcome::Finished))
        {
            let items: Vec<Value> = turn
                .assistant_blocks
                .iter()
                .map(|block| match block {
                    HistoryBlock::Text { text } => json!({
                        "type": "text",
                        "text": text,
                    }),
                    HistoryBlock::ToolCall {
                        tool_call_id,
                        title,
                        status,
                    } => json!({
                        "type": "tool_call",
                        "toolCallId": tool_call_id,
                        "title": title,
                        "status": status,
                    }),
                    HistoryBlock::PermissionRequest {
                        request_id,
                        tool_call_id,
                        resolved_option_id,
                    } => json!({
                        "type": "permission_request",
                        "permissionRequestId": request_id,
                        "toolCallId": tool_call_id,
                        "resolvedOptionId": resolved_option_id,
                    }),
                })
                .collect();
            entries.push(json!({
                "id": format!("assistant:{}", turn.turn_id.0),
                "role": "assistant",
                "finished": matches!(turn.outcome, Some(TurnTerminalOutcome::Finished)),
                "items": items,
            }));
        }
    }
    json!({
        "sessionId": session_id,
        "items": entries,
    })
}

fn parse_custom_acp(cfg: Option<&Value>) -> Option<CustomCommandSpec> {
    let custom = cfg?.get("customAcp")?;
    let command = PathBuf::from(custom.get("command")?.as_str()?);
    let args = custom
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Some(CustomCommandSpec { command, args })
}

fn ndjson_frames(responses: &[Value]) -> impl IntoResponse {
    let mut body = String::new();
    for resp in responses {
        if let Ok(line) = serde_json::to_string(&json!({
            "kind": "response",
            "response": resp,
        })) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    body.push_str("{\"kind\":\"complete\"}\n");
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body)
}

fn ndjson_error(msg: &str) -> impl IntoResponse {
    let line = serde_json::to_string(&json!({
        "kind": "error",
        "error": msg,
    }))
    .unwrap_or_else(|_| "{\"kind\":\"error\",\"error\":\"internal\"}".to_string());
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        format!("{line}\n"),
    )
}

async fn handle_healthz(State(st): State<Arc<ServerState>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "machineId": st.machine_id,
        "pid": std::process::id(),
        "cliVersion": st.version,
        "homeDir": st.home_dir,
        "protocolCapabilities": {
            "localProjectFileSearch": true,
            "localProjectBranchPagination": true,
        }
    }))
}

async fn handle_probe_state(State(st): State<Arc<ServerState>>) -> Json<Value> {
    Json(json!({
        "schemaVersion": 1,
        "phase": "running",
        "startupStage": "ready",
        "machineId": st.machine_id,
        "pid": std::process::id(),
        "updatedAtMs": current_epoch_ms(),
        "issues": [],
        "protocolCapabilities": {
            "localProjectFileSearch": true,
            "localProjectBranchPagination": true,
        }
    }))
}

async fn handle_daemon_shutdown(
    State(st): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    check_token(&headers, &st.token)?;
    st.shutdown.notify_waiters();
    Ok(Json(json!({ "ok": true })))
}

fn map_project_control_error(err: &PortError) -> (&'static str, String) {
    if let Some(stripped) = err.message.strip_prefix("path_invalid:") {
        return ("path_invalid", stripped.trim().to_string());
    }
    let code = match err.kind {
        PortErrorKind::InvalidInput => "invalid_request",
        PortErrorKind::Unauthorized
        | PortErrorKind::Forbidden
        | PortErrorKind::EntitlementReadOnly => "access_denied",
        PortErrorKind::NotFound => "local_project_not_found",
        PortErrorKind::Conflict => "already_exists",
        PortErrorKind::Unavailable
        | PortErrorKind::CapabilityUnavailable
        | PortErrorKind::Timeout => "daemon_unavailable",
        PortErrorKind::Internal => "execution_failed",
    };
    (code, err.message.clone())
}

fn project_control_err_json(kind: &str, err: &PortError) -> Json<Value> {
    let (code, message) = map_project_control_error(err);
    Json(json!({
        "ok": false,
        "type": kind,
        "error": code,
        "message": message,
    }))
}

fn extract_project_scope(
    payload: &Value,
) -> (WorkspaceId, Option<LocalProjectId>, Option<PathBuf>) {
    let workspace_id = WorkspaceId(
        payload
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string(),
    );
    let local_project_id = payload
        .get("localProjectId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| LocalProjectId(s.to_string()));
    let root_path = payload
        .get("rootPath")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    (workspace_id, local_project_id, root_path)
}

async fn handle_project_control(
    State(st): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    check_token(&headers, &st.token)?;
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: None,
    };
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(req_machine_id) = payload
        .get("machineId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        && req_machine_id != st.machine_id
    {
        return Ok(Json(json!({
            "ok": false,
            "type": kind,
            "error": "machine_mismatch",
            "message": format!("Requested machineId '{req_machine_id}' does not match local daemon '{}'.", st.machine_id),
        })));
    }
    let service = Arc::clone(&st.service);

    match kind.as_str() {
        "local-project/add" | "project/add" => {
            let root_str = payload
                .get("rootPath")
                .and_then(Value::as_str)
                .ok_or_else(|| (StatusCode::BAD_REQUEST, "missing rootPath".to_string()))?
                .to_string();
            let root_path = PathBuf::from(&root_str);
            let name = root_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "project".to_string());
            let resp = tokio::task::spawn_blocking(move || {
                service.execute(&caller, AppCommand::RegisterProject { name, root_path })
            })
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            if let AppResponse::ProjectRegistered(rec) = resp {
                Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/add",
                    "result": {
                        "localProjectId": rec.project_id.0,
                        "name": rec.name,
                        "rootPath": rec.root_path,
                        "workspaceIds": ["local"],
                    }
                })))
            } else {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                ))
            }
        }
        "local-project/prepare-add" => {
            let Some(root_str) = payload
                .get("rootPath")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/prepare-add",
                    "error": "invalid_request",
                    "message": "rootPath is required",
                })));
            };
            let inspect = payload
                .get("inspect")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let q = AppQuery::PrepareProjectAdd {
                root_path: PathBuf::from(root_str),
                inspect,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectAddPrepared(prep)) => {
                    let mut res_obj = json!({
                        "localProjectId": prep.local_project_id.0,
                        "name": prep.name,
                        "rootPath": prep.root_path,
                        "alreadyRegistered": prep.already_registered,
                    });
                    if let Some(insp) = prep.inspection {
                        let insp_val = if insp.git {
                            json!({
                                "git": true,
                                "currentBranch": insp.current_branch,
                                "defaultBranch": insp.default_branch,
                                "githubRepoFullName": insp.github_repo_full_name,
                            })
                        } else {
                            json!({ "git": false })
                        };
                        res_obj["inspection"] = insp_val;
                    }
                    Ok(Json(json!({
                        "ok": true,
                        "type": "local-project/prepare-add",
                        "result": res_obj,
                    })))
                }
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/prepare-add", &err)),
            }
        }
        "local-project/list-roots" => {
            let home_dir = PathBuf::from(&st.home_dir);
            let q = AppQuery::ListBrowseRoots { home_dir };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::BrowseRootsListed(info)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/list-roots",
                    "result": info,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/list-roots", &err)),
            }
        }
        "local-project/browse-dir" => {
            let home_dir = PathBuf::from(&st.home_dir);
            let absolute_path = payload
                .get("absolutePath")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from);
            let show_hidden = payload
                .get("showHidden")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let cursor = payload
                .get("cursor")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let mut registered_projects = BTreeMap::new();
            if let Some(reg_map) = payload.get("registeredProjects").and_then(Value::as_object) {
                for (pid, pval) in reg_map {
                    if let Some(pstr) = pval.as_str().filter(|s| !s.trim().is_empty()) {
                        registered_projects.insert(pid.clone(), PathBuf::from(pstr));
                    }
                }
            }
            let q = AppQuery::BrowseLocalDirectory {
                home_dir,
                browse_query: BrowseDirectoryQuery {
                    absolute_path,
                    show_hidden,
                    limit,
                    cursor,
                    registered_projects,
                },
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::LocalDirectoryBrowsed(page)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/browse-dir",
                    "result": page,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/browse-dir", &err)),
            }
        }
        "local-project/create-directory" => {
            let Some(parent_str) = payload.get("parentPath").and_then(Value::as_str) else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/create-directory",
                    "error": "invalid_request",
                    "message": "parentPath is required",
                })));
            };
            let Some(name_str) = payload.get("name").and_then(Value::as_str) else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/create-directory",
                    "error": "invalid_request",
                    "message": "name is required",
                })));
            };
            let cmd = AppCommand::CreateLocalDirectory {
                parent_path: PathBuf::from(parent_str),
                name: name_str.to_string(),
            };
            let resp = tokio::task::spawn_blocking(move || service.execute(&caller, cmd))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::LocalDirectoryCreated { path }) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/create-directory",
                    "result": { "path": path },
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json(
                    "local-project/create-directory",
                    &err,
                )),
            }
        }
        "local-project/list-branches" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(50);
            let branch_query = BranchListQuery {
                query: payload
                    .get("query")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                limit,
                cursor: payload
                    .get("cursor")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            };
            let q = AppQuery::ListProjectBranches {
                workspace_id,
                local_project_id,
                root_path,
                branch_query,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectBranchesListed(page)) => {
                    let result = if page.git {
                        json!(page)
                    } else {
                        json!({ "git": false })
                    };
                    Ok(Json(json!({
                        "ok": true,
                        "type": "local-project/list-branches",
                        "result": result,
                    })))
                }
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json(
                    "local-project/list-branches",
                    &err,
                )),
            }
        }
        "local-project/search-files" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let search_query = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(50);
            let q = AppQuery::SearchProjectFiles {
                workspace_id,
                local_project_id,
                root_path,
                search_query,
                limit,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectFilesSearched(res)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/search-files",
                    "result": res,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/search-files", &err)),
            }
        }
        "local-project/list-files" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let max_files = payload
                .get("maxFiles")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let q = AppQuery::ListProjectFiles {
                workspace_id,
                local_project_id,
                root_path,
                max_files,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectFilesListed(res)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/list-files",
                    "result": res,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/list-files", &err)),
            }
        }
        "local-project/list-dir" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let relative_path = payload
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let q = AppQuery::ListProjectDirectory {
                workspace_id,
                local_project_id,
                root_path,
                relative_path,
                limit,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectDirectoryListed(page)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/list-dir",
                    "result": page,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/list-dir", &err)),
            }
        }
        "local-project/read-file" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let Some(relative_path) = payload
                .get("relativePath")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/read-file",
                    "error": "invalid_request",
                    "message": "relativePath is required",
                })));
            };
            let max_bytes = payload
                .get("maxBytes")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let q = AppQuery::ReadProjectFile {
                workspace_id,
                local_project_id,
                root_path,
                relative_path,
                max_bytes,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectFileRead { file }) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/read-file",
                    "result": file,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/read-file", &err)),
            }
        }
        "local-project/checkout-branch" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let Some(branch_name) = payload
                .get("branchName")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/checkout-branch",
                    "error": "invalid_request",
                    "message": "branchName is required",
                })));
            };
            let cmd = AppCommand::CheckoutProjectBranch {
                workspace_id,
                local_project_id,
                root_path,
                branch_name,
            };
            let resp = tokio::task::spawn_blocking(move || service.execute(&caller, cmd))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectBranchCheckedOut(out)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/checkout-branch",
                    "result": out,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json(
                    "local-project/checkout-branch",
                    &err,
                )),
            }
        }
        "local-project/list-skills" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let Some(skill_dirs_arr) = payload.get("skillDirs").and_then(Value::as_array) else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "local-project/list-skills",
                    "error": "invalid_request",
                    "message": "skillDirs is required",
                })));
            };
            let skill_dirs: Vec<String> = skill_dirs_arr
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect();
            let known_fingerprint = payload
                .get("knownFingerprint")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned);
            let q = AppQuery::ListProjectSkills {
                workspace_id,
                local_project_id,
                root_path,
                skill_dirs,
                known_fingerprint,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectSkillsListed(listing)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/list-skills",
                    "result": listing,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/list-skills", &err)),
            }
        }
        "local-project/list-global-skills" => {
            let home_dir = PathBuf::from(&st.home_dir);
            let known_fingerprint = payload
                .get("knownFingerprint")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned);
            let q = AppQuery::ListGlobalSkills {
                home_dir,
                known_fingerprint,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectSkillsListed(listing)) => Ok(Json(json!({
                    "ok": true,
                    "type": "local-project/list-global-skills",
                    "result": listing,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json(
                    "local-project/list-global-skills",
                    &err,
                )),
            }
        }
        "worktree/list-files" => {
            let workspace_id = WorkspaceId(
                payload
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .unwrap_or("local")
                    .to_string(),
            );
            let Some(repo_key) = payload
                .get("repoKey")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "worktree/list-files",
                    "error": "invalid_request",
                    "message": "repoKey is required",
                })));
            };
            let Some(sid_str) = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "worktree/list-files",
                    "error": "invalid_request",
                    "message": "sessionId is required",
                })));
            };
            let max_files = payload
                .get("maxFiles")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let q = AppQuery::ListWorktreeFiles {
                workspace_id,
                repo_key,
                session_id: SessionId(sid_str.to_string()),
                max_files,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectFilesListed(res)) => Ok(Json(json!({
                    "ok": true,
                    "type": "worktree/list-files",
                    "result": res,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("worktree/list-files", &err)),
            }
        }
        "worktree/read-file" => {
            let workspace_id = WorkspaceId(
                payload
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .unwrap_or("local")
                    .to_string(),
            );
            let Some(repo_key) = payload
                .get("repoKey")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "worktree/read-file",
                    "error": "invalid_request",
                    "message": "repoKey is required",
                })));
            };
            let Some(sid_str) = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "worktree/read-file",
                    "error": "invalid_request",
                    "message": "sessionId is required",
                })));
            };
            let Some(relative_path) = payload
                .get("relativePath")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(ToOwned::to_owned)
            else {
                return Ok(Json(json!({
                    "ok": false,
                    "type": "worktree/read-file",
                    "error": "invalid_request",
                    "message": "relativePath is required",
                })));
            };
            let max_bytes = payload
                .get("maxBytes")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let q = AppQuery::ReadWorktreeFile {
                workspace_id,
                repo_key,
                session_id: SessionId(sid_str.to_string()),
                relative_path,
                max_bytes,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectFileRead { file }) => Ok(Json(json!({
                    "ok": true,
                    "type": "worktree/read-file",
                    "result": file,
                }))),
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("worktree/read-file", &err)),
            }
        }
        "local-project/git-state" => {
            let (workspace_id, local_project_id, root_path) = extract_project_scope(&payload);
            let q = AppQuery::InspectProjectGitSummary {
                workspace_id,
                local_project_id,
                root_path,
            };
            let resp = tokio::task::spawn_blocking(move || service.query(&caller, q))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectGitSummary(summary)) => {
                    let result = if summary.git {
                        let mut branches = Vec::new();
                        if let Some(ref cur) = summary.current_branch {
                            branches.push(cur.clone());
                        }
                        if let Some(ref def) = summary.default_branch
                            && !branches.contains(def)
                        {
                            branches.push(def.clone());
                        }
                        json!({
                            "git": true,
                            "branches": branches,
                            "currentBranch": summary.current_branch,
                            "defaultBranch": summary.default_branch,
                            "githubRepoFullName": summary.github_repo_full_name,
                        })
                    } else {
                        json!({ "git": false })
                    };
                    Ok(Json(json!({
                        "ok": true,
                        "type": "local-project/git-state",
                        "result": result,
                    })))
                }
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/git-state", &err)),
            }
        }
        "local-project/list" | "" => {
            let resp =
                tokio::task::spawn_blocking(move || service.query(&caller, AppQuery::ListProjects))
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            match resp {
                Ok(AppResponse::ProjectsListed { projects }) => {
                    let projects_json: Vec<Value> = projects
                        .into_iter()
                        .map(|p| {
                            json!({
                                "localProjectId": p.project_id.0,
                                "name": p.name,
                                "rootPath": p.root_path,
                            })
                        })
                        .collect();
                    Ok(Json(json!({
                        "ok": true,
                        "type": "local-project/list",
                        "result": {
                            "workspaces": [
                                {
                                    "workspaceId": "local",
                                    "workspaceName": "Local Workspace",
                                    "projects": projects_json,
                                }
                            ]
                        }
                    })))
                }
                Ok(_) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected response".to_string(),
                )),
                Err(err) => Ok(project_control_err_json("local-project/list", &err)),
            }
        }
        other => Ok(Json(json!({
            "ok": false,
            "type": other,
            "error": "invalid_request",
            "message": format!("Unsupported project-control request type '{other}'"),
        }))),
    }
}

async fn handle_session_control(
    State(st): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    if let Err((code, msg)) = check_token(&headers, &st.token) {
        return (
            code,
            [(header::CONTENT_TYPE, "application/json")],
            json!({ "error": msg }).to_string(),
        )
            .into_response();
    }

    let req_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let workspace_id = WorkspaceId(
        payload
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string(),
    );
    let session_id_str = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session_id = SessionId(session_id_str.clone());
    let user_id = payload
        .get("userId")
        .and_then(Value::as_str)
        .map(|s| UserId(s.to_string()));
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: user_id,
    };
    let service = Arc::clone(&st.service);

    match req_type.as_str() {
        "session/create" => {
            let turn_id = TurnId(
                payload
                    .get("userTurnId")
                    .and_then(Value::as_str)
                    .unwrap_or("turn-1")
                    .to_string(),
            );
            let acp_cfg = payload.get("acpSessionConfig");
            let prompt = acp_cfg
                .and_then(|c| c.get("prompt"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let adapter_id = acp_cfg
                .and_then(|c| c.get("cliType"))
                .and_then(Value::as_str)
                .unwrap_or("custom")
                .to_string();
            let custom_acp = parse_custom_acp(acp_cfg);
            let local_project_id = payload
                .get("project")
                .and_then(|p| p.get("localProjectId"))
                .and_then(Value::as_str)
                .map(|s| LocalProjectId(s.to_string()));
            let base_branch = payload
                .get("project")
                .and_then(|p| p.get("branch"))
                .and_then(Value::as_str)
                .or_else(|| payload.get("baseBranch").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            let use_worktree = payload
                .get("project")
                .and_then(|p| p.get("useWorktree"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let cmd = AppCommand::CreateSession {
                workspace_id,
                session_id,
                turn_id,
                local_project_id,
                base_branch,
                use_worktree,
                adapter_id,
                custom_acp,
                prompt,
            };
            let res = tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(_)) => ndjson_frames(&[
                    json!({ "type": "session/create_ack", "sessionId": session_id_str }),
                    json!({ "type": "session/create_response", "sessionId": session_id_str, "success": true }),
                ])
                .into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/chat" => {
            let turn_id = TurnId(
                payload
                    .get("userTurnId")
                    .and_then(Value::as_str)
                    .unwrap_or("turn-chat")
                    .to_string(),
            );
            let acp_cfg = payload.get("acpSessionConfig");
            let prompt = acp_cfg
                .and_then(|c| c.get("prompt"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let custom_acp = parse_custom_acp(acp_cfg);
            let cmd = AppCommand::SendChat {
                workspace_id,
                session_id,
                turn_id,
                custom_acp,
                prompt,
            };
            let res = tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(_)) => ndjson_frames(&[
                    json!({ "type": "session/chat_ack", "sessionId": session_id_str }),
                    json!({ "type": "session/chat_response", "sessionId": session_id_str, "success": true }),
                ])
                .into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/cancel" => {
            let pause_inbox = payload
                .get("pauseInbox")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let cmd = AppCommand::CancelSession {
                workspace_id,
                session_id,
                pause_inbox,
            };
            let res = tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(_)) => ndjson_frames(&[json!({
                    "type": "session/cancel_response",
                    "sessionId": session_id_str,
                    "success": true
                })])
                .into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/permission_response" => {
            let request_id = payload
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let outcome_obj = payload.get("outcome");
            let cancelled = outcome_obj
                .and_then(|o| o.get("outcome"))
                .and_then(Value::as_str)
                == Some("cancelled");
            let selected_option_id = outcome_obj
                .and_then(|o| o.get("optionId"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let cmd = AppCommand::ReplyPermission {
                workspace_id,
                session_id,
                decision: PermissionDecision {
                    request_id,
                    selected_option_id,
                    cancelled,
                    notes: None,
                },
            };
            let res = tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(_)) => ndjson_frames(&[json!({
                    "type": "session/permission_ack",
                    "sessionId": session_id_str,
                    "success": true
                })])
                .into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/archive" => {
            let cmd = AppCommand::ArchiveSession {
                workspace_id,
                session_id,
            };
            let res = tokio::task::spawn_blocking(move || service.execute(&caller, cmd)).await;
            match res {
                Ok(Ok(_)) => ndjson_frames(&[json!({
                    "type": "session/archive_response",
                    "sessionId": session_id_str,
                    "success": true
                })])
                .into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/history" => {
            let q = AppQuery::GetSessionHistory {
                workspace_id: WorkspaceId("*".to_string()),
                session_id,
            };
            let res = tokio::task::spawn_blocking(move || service.query(&caller, q)).await;
            match res {
                Ok(Ok(AppResponse::SessionHistory { turns })) => {
                    let hist = format_history_json(&session_id_str, &turns);
                    ndjson_frames(&[hist]).into_response()
                }
                Ok(Ok(_)) => ndjson_error("unexpected query response").into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        "session/turn_diff" => {
            let turn_id = TurnId(
                payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
            let q = AppQuery::GetTurnDiff {
                workspace_id,
                session_id,
                turn_id,
            };
            let res = tokio::task::spawn_blocking(move || service.query(&caller, q)).await;
            match res {
                Ok(Ok(AppResponse::TurnDiff { diff })) => ndjson_frames(&[json!({
                    "type": "session/turn_diff_response",
                    "sessionId": session_id_str,
                    "diff": diff,
                })])
                .into_response(),
                Ok(Ok(_)) => ndjson_error("unexpected query response").into_response(),
                Ok(Err(e)) => ndjson_error(&e.to_string()).into_response(),
                Err(e) => ndjson_error(&e.to_string()).into_response(),
            }
        }
        other => {
            ndjson_error(&format!("unsupported session control type '{other}'")).into_response()
        }
    }
}

async fn handle_mcp_control(
    State(st): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    if check_token(&headers, &st.token).is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "application/json")],
            json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "Unauthorized" },
                "id": Value::Null,
            })
            .to_string(),
        )
            .into_response();
    }
    let Some(ctx) = crate::mcp_http::parse_mcp_context_headers(&headers) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "Missing or invalid Lody MCP session context headers" },
                "id": Value::Null,
            })
            .to_string(),
        )
            .into_response();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            json!({
                "jsonrpc": "2.0",
                "error": { "code": -32700, "message": "Parse error" },
                "id": Value::Null,
            })
            .to_string(),
        )
            .into_response();
    };
    match st.mcp_dispatcher.dispatch_jsonrpc(&ctx, parsed).await {
        Some(reply) => (StatusCode::OK, Json(reply)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn handle_automation_control(
    State(st): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    if let Err((code, msg)) = check_token(&headers, &st.token) {
        return (
            code,
            Json(json!({
                "ok": false,
                "error": msg,
            })),
        )
            .into_response();
    }
    let req_machine = payload
        .get("machineId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !req_machine.is_empty() && req_machine != st.machine_id {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "ok": false,
                "error": "AUTOMATION_MACHINE_MISMATCH",
            })),
        )
            .into_response();
    }
    let Some(ws_str) = payload
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "workspaceId is required",
            })),
        )
            .into_response();
    };
    let requester_sid = payload
        .get("requesterSessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| SessionId(s.to_string()));
    let Some(command_val) = payload.get("command") else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "command is required",
            })),
        )
            .into_response();
    };
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: None,
        account_id: None,
    };
    let workspace_id = WorkspaceId(ws_str.to_string());
    match crate::mcp_http::dispatch_automation_command(
        Arc::clone(&st.service),
        caller,
        &workspace_id,
        requester_sid.as_ref(),
        command_val,
    )
    .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "result": result,
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::OK,
            Json(json!({
                "ok": false,
                "error": err.message,
            })),
        )
            .into_response(),
    }
}

#[cfg(unix)]
pub async fn serve_local_daemon(
    data_dir: &Path,
    home_dir: &Path,
    namespace: &str,
    version: &str,
    enable_mcp_http: bool,
    service: Arc<dyn ApplicationService>,
) -> PortResult<()> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    if probe_live_daemon(data_dir).is_some() {
        return Err(PortError::new(
            PortErrorKind::Conflict,
            "a live lody daemon already owns this data directory",
        ));
    }

    let my_pid = std::process::id();
    let host_caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(my_pid),
        account_id: None,
    };
    let svc_for_id = Arc::clone(&service);
    let machine_id = match tokio::task::spawn_blocking(move || {
        svc_for_id.query(&host_caller, AppQuery::MachineIdentity)
    })
    .await
    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))??
    {
        AppResponse::MachineIdentity { machine_id } => machine_id.0,
        _ => "local".to_string(),
    };

    let (probe_path, control_path) = resolve_socket_paths(data_dir)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let _ = fs::remove_file(&probe_path);
    let _ = fs::remove_file(&control_path);

    let probe_listener = UnixListener::bind(&probe_path)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let control_listener = UnixListener::bind(&control_path)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let _ = fs::set_permissions(&probe_path, fs::Permissions::from_mode(0o600));
    let _ = fs::set_permissions(&control_path, fs::Permissions::from_mode(0o600));

    let shutdown = Arc::new(Notify::new());
    let mcp_task = if enable_mcp_http {
        let (_mcp_ep, task) = crate::mcp_http::start_mcp_http_server(
            Arc::clone(&service),
            &machine_id,
            version,
            Arc::clone(&shutdown),
        )
        .await?;
        Some(task)
    } else {
        None
    };

    let (_term_sock, term_task) = crate::terminal::start_local_terminal_server(
        data_dir,
        namespace,
        Arc::clone(&service),
        Arc::clone(&shutdown),
    )
    .await?;

    let token = generate_ipc_token(data_dir);
    let meta = DaemonRunMetadata {
        pid: my_pid,
        socket_path: probe_path.to_string_lossy().into_owned(),
        control_socket_path: control_path.to_string_lossy().into_owned(),
        version: version.to_string(),
        started_at: "2026-11-22T00:00:00Z".to_string(),
        token: Some(token.clone()),
    };
    let run_file = DaemonRunMetadata::file_path(data_dir);
    let tmp_file = run_file.with_extension("json.tmp");
    let raw_meta = serde_json::to_vec_pretty(&meta)
        .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))?;
    fs::write(&tmp_file, raw_meta)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
    let _ = fs::set_permissions(&tmp_file, fs::Permissions::from_mode(0o600));
    fs::rename(&tmp_file, &run_file)
        .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

    let mcp_dispatcher = Arc::new(crate::mcp_http::McpDispatcher::new(
        Arc::clone(&service),
        version,
    ));
    let shared = Arc::new(ServerState {
        service,
        mcp_dispatcher,
        machine_id,
        home_dir: home_dir.to_string_lossy().into_owned(),
        version: version.to_string(),
        token,
        shutdown: Arc::clone(&shutdown),
    });

    let probe_app = Router::new()
        .route("/healthz", get(handle_healthz))
        .route("/state", get(handle_probe_state))
        .with_state(Arc::clone(&shared));

    let control_app = Router::new()
        .route("/daemon-shutdown", post(handle_daemon_shutdown))
        .route("/project-control", post(handle_project_control))
        .route("/session-control", post(handle_session_control))
        .route("/mcp-control", post(handle_mcp_control))
        .route("/automation-control", post(handle_automation_control))
        .with_state(Arc::clone(&shared));

    let probe_shutdown = Arc::clone(&shutdown);
    let control_shutdown = Arc::clone(&shutdown);
    let ctrl_c_shutdown = Arc::clone(&shutdown);

    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            ctrl_c_shutdown.notify_waiters();
        }
    });

    let probe_srv = axum::serve(probe_listener, probe_app).with_graceful_shutdown(async move {
        probe_shutdown.notified().await;
    });
    let control_srv =
        axum::serve(control_listener, control_app).with_graceful_shutdown(async move {
            control_shutdown.notified().await;
        });

    let _ = tokio::join!(probe_srv, control_srv, term_task);
    if let Some(task) = mcp_task {
        let _ = task.await;
    }

    let svc_for_drain = Arc::clone(&shared.service);
    let _ = tokio::task::spawn_blocking(move || svc_for_drain.drain_for_shutdown()).await;

    if DaemonRunMetadata::read(data_dir).is_some_and(|m| m.pid == my_pid) {
        let _ = fs::remove_file(&run_file);
        let _ = fs::remove_file(&probe_path);
        let _ = fs::remove_file(&control_path);
    }
    Ok(())
}

#[cfg(not(unix))]
pub async fn serve_local_daemon(
    _data_dir: &Path,
    _home_dir: &Path,
    _namespace: &str,
    _version: &str,
    _enable_mcp_http: bool,
    _service: Arc<dyn ApplicationService>,
) -> PortResult<()> {
    Err(PortError::new(
        PortErrorKind::Unavailable,
        "local daemon server currently requires Unix domain sockets",
    ))
}

#[cfg(unix)]
pub fn send_unix_http(
    socket_path: &Path,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> io::Result<(u16, String)> {
    send_unix_http_with_headers(socket_path, method, path, token, &[], body)
}

#[cfg(unix)]
pub fn send_unix_http_with_headers(
    socket_path: &Path,
    method: &str,
    path: &str,
    token: Option<&str>,
    extra_headers: &[(String, String)],
    body: Option<&Value>,
) -> io::Result<(u16, String)> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;

    let payload = match body {
        Some(v) => serde_json::to_vec(v)?,
        None => Vec::new(),
    };

    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{LOCAL_CONTROL_HEADER}: 1\r\n"
    );
    if let Some(tok) = token {
        req.push_str(&format!("{IPC_TOKEN_HEADER}: {tok}\r\n"));
    }
    for (hk, hv) in extra_headers {
        req.push_str(&format!("{hk}: {hv}\r\n"));
    }
    if body.is_some() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    req.push_str("\r\n");

    stream.write_all(req.as_bytes())?;
    if !payload.is_empty() {
        stream.write_all(&payload)?;
    }
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);

    let mut chunked = false;
    let mut content_len: Option<usize> = None;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let trimmed = h.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            } else if k.trim().eq_ignore_ascii_case("content-length") {
                content_len = v.trim().parse::<usize>().ok();
            }
        }
    }

    let bytes = if chunked {
        let mut acc = Vec::new();
        loop {
            let mut sz_line = String::new();
            reader.read_line(&mut sz_line)?;
            let hex = sz_line.trim().split(';').next().unwrap_or("0");
            let n = usize::from_str_radix(hex, 16).unwrap_or(0);
            if n == 0 {
                break;
            }
            let mut buf = vec![0u8; n];
            reader.read_exact(&mut buf)?;
            acc.extend_from_slice(&buf);
            let mut crlf = [0u8; 2];
            let _ = reader.read_exact(&mut crlf);
        }
        acc
    } else if let Some(n) = content_len {
        let mut buf = vec![0u8; n];
        reader.read_exact(&mut buf)?;
        buf
    } else {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        buf
    };

    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(not(unix))]
pub fn send_unix_http(
    _socket_path: &Path,
    _method: &str,
    _path: &str,
    _token: Option<&str>,
    _body: Option<&Value>,
) -> io::Result<(u16, String)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unix sockets unavailable",
    ))
}

#[cfg(not(unix))]
pub fn send_unix_http_with_headers(
    _socket_path: &Path,
    _method: &str,
    _path: &str,
    _token: Option<&str>,
    _extra_headers: &[(String, String)],
    _body: Option<&Value>,
) -> io::Result<(u16, String)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unix sockets unavailable",
    ))
}

pub fn probe_live_daemon(data_dir: &Path) -> Option<DaemonRunMetadata> {
    let meta = DaemonRunMetadata::read(data_dir)?;
    let (status, _) = send_unix_http(
        Path::new(&meta.socket_path),
        "GET",
        "/state",
        meta.token.as_deref(),
        None,
    )
    .ok()?;
    (status == 200).then_some(meta)
}

pub fn query_live_daemon_machine_id(meta: &DaemonRunMetadata) -> Option<String> {
    let (status, body) = send_unix_http(
        Path::new(&meta.socket_path),
        "GET",
        "/state",
        meta.token.as_deref(),
        None,
    )
    .ok()?;
    if status != 200 {
        return None;
    }
    let parsed: Value = serde_json::from_str(&body).ok()?;
    parsed
        .get("machineId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
