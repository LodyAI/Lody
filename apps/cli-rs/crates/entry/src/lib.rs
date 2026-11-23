#![forbid(unsafe_code)]

pub mod ipc;

use clap::{Parser, Subcommand};
pub use ipc::{
    DaemonRunMetadata, ensure_machine_id, format_history_json, probe_live_daemon, send_unix_http,
    serve_local_daemon,
};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, PortError, PortErrorKind, PortResult,
    SessionId, VerifiedPrincipal, WorkspaceId,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Parser)]
#[command(name = "lody", disable_version_flag = true)]
struct CliRoot {
    #[arg(short = 'V', long = "version")]
    version: bool,
    #[command(subcommand)]
    command: Option<CliCommand>,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    Version,
    Status,
    McpStdio,
    Daemon {
        #[command(subcommand)]
        action: Option<DaemonSubcommand>,
    },
    Project {
        #[command(subcommand)]
        action: ProjectSubcommand,
    },
    Session {
        #[command(subcommand)]
        action: SessionSubcommand,
    },
}

#[derive(Debug, Subcommand)]
enum DaemonSubcommand {
    Start {
        #[arg(long = "skip-auth-check")]
        skip_auth_check: bool,
    },
    Run,
    #[command(name = "start-foreground")]
    StartForeground,
    Runner,
    Stop,
    Status,
}

#[derive(Debug, Subcommand)]
enum ProjectSubcommand {
    Add {
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum SessionSubcommand {
    History {
        session_id: String,
        #[arg(long)]
        offline: bool,
        #[arg(long)]
        json: bool,
    },
    Archive {
        session_id: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchPlan {
    PrintVersion,
    StartDaemonBackground,
    RunDaemonForeground,
    StopDaemon,
    OneShot(OneShotAction),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OneShotAction {
    Status,
    McpStdio,
    ProjectAdd {
        path: PathBuf,
        json: bool,
    },
    ProjectList {
        json: bool,
    },
    SessionHistory {
        session_id: String,
        offline: bool,
        json: bool,
    },
    SessionArchive {
        session_id: String,
        json: bool,
    },
}

pub fn parse_cli_args(args: &[String]) -> Result<DispatchPlan, String> {
    let mut full = Vec::with_capacity(args.len() + 1);
    full.push("lody".to_string());
    full.extend(args.iter().cloned());

    let parsed = CliRoot::try_parse_from(full).map_err(|e| e.to_string())?;
    if parsed.version {
        return Ok(DispatchPlan::PrintVersion);
    }

    match parsed.command {
        None | Some(CliCommand::Status) => Ok(DispatchPlan::OneShot(OneShotAction::Status)),
        Some(CliCommand::Version) => Ok(DispatchPlan::PrintVersion),
        Some(CliCommand::McpStdio) => Ok(DispatchPlan::OneShot(OneShotAction::McpStdio)),
        Some(CliCommand::Daemon { action }) => match action {
            Some(DaemonSubcommand::Start { .. }) => Ok(DispatchPlan::StartDaemonBackground),
            Some(
                DaemonSubcommand::Run
                | DaemonSubcommand::StartForeground
                | DaemonSubcommand::Runner,
            ) => Ok(DispatchPlan::RunDaemonForeground),
            Some(DaemonSubcommand::Stop) => Ok(DispatchPlan::StopDaemon),
            Some(DaemonSubcommand::Status) | None => {
                Ok(DispatchPlan::OneShot(OneShotAction::Status))
            }
        },
        Some(CliCommand::Project { action }) => match action {
            ProjectSubcommand::Add { path, json } => {
                Ok(DispatchPlan::OneShot(OneShotAction::ProjectAdd {
                    path,
                    json,
                }))
            }
            ProjectSubcommand::List { json } => {
                Ok(DispatchPlan::OneShot(OneShotAction::ProjectList { json }))
            }
        },
        Some(CliCommand::Session { action }) => match action {
            SessionSubcommand::History {
                session_id,
                offline,
                json,
            } => Ok(DispatchPlan::OneShot(OneShotAction::SessionHistory {
                session_id,
                offline,
                json,
            })),
            SessionSubcommand::Archive { session_id, json } => {
                Ok(DispatchPlan::OneShot(OneShotAction::SessionArchive {
                    session_id,
                    json,
                }))
            }
        },
    }
}

pub fn start_daemon_detached(data_dir: &Path) -> Result<(), String> {
    if probe_live_daemon(data_dir).is_some() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("resolve current_exe: {e}"))?;
    Command::new(exe)
        .args(["daemon", "run"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn daemon run: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if probe_live_daemon(data_dir).is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    Err("timed out waiting for background lody daemon readiness".to_string())
}

pub fn stop_running_daemon(data_dir: &Path) -> Result<(), String> {
    let Some(meta) = DaemonRunMetadata::read(data_dir) else {
        return Ok(());
    };
    let _ = send_unix_http(
        Path::new(&meta.control_socket_path),
        "POST",
        "/daemon-shutdown",
        meta.token.as_deref(),
        Some(&json!({})),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !DaemonRunMetadata::file_path(data_dir).exists() && probe_live_daemon(data_dir).is_none()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("timed out waiting for running lody daemon to stop".to_string())
}

pub fn try_execute_via_live_daemon(
    data_dir: &Path,
    action: &OneShotAction,
) -> Option<Result<String, String>> {
    let meta = probe_live_daemon(data_dir)?;
    let control = Path::new(&meta.control_socket_path);
    let tok = meta.token.as_deref();

    match action {
        OneShotAction::ProjectAdd { path, .. } => {
            let machine_id = ensure_machine_id(data_dir).unwrap_or_else(|_| "local".to_string());
            let res = send_unix_http(
                control,
                "POST",
                "/project-control",
                tok,
                Some(&json!({
                    "type": "local-project/add",
                    "machineId": machine_id,
                    "rootPath": path,
                })),
            );
            Some(res.map(|(_, body)| body).map_err(|e| e.to_string()))
        }
        OneShotAction::ProjectList { .. } => {
            let machine_id = ensure_machine_id(data_dir).unwrap_or_else(|_| "local".to_string());
            let res = send_unix_http(
                control,
                "POST",
                "/project-control",
                tok,
                Some(&json!({
                    "type": "local-project/list",
                    "machineId": machine_id,
                })),
            );
            Some(res.map(|(_, body)| body).map_err(|e| e.to_string()))
        }
        OneShotAction::SessionHistory { session_id, .. } => {
            let res = send_unix_http(
                control,
                "POST",
                "/session-control",
                tok,
                Some(&json!({
                    "type": "session/history",
                    "sessionId": session_id,
                })),
            );
            Some(match res {
                Ok((_, body)) => extract_first_ndjson_response(&body),
                Err(e) => Err(e.to_string()),
            })
        }
        OneShotAction::SessionArchive { session_id, .. } => {
            let res = send_unix_http(
                control,
                "POST",
                "/session-control",
                tok,
                Some(&json!({
                    "type": "session/archive",
                    "sessionId": session_id,
                })),
            );
            Some(match res {
                Ok((_, body)) => extract_first_ndjson_response(&body),
                Err(e) => Err(e.to_string()),
            })
        }
        _ => None,
    }
}

fn extract_first_ndjson_response(body: &str) -> Result<String, String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        match frame.get("kind").and_then(Value::as_str) {
            Some("response") => {
                if let Some(resp) = frame.get("response") {
                    return serde_json::to_string(resp).map_err(|e| e.to_string());
                }
            }
            Some("error") => {
                let err = frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("ipc error");
                return Err(err.to_string());
            }
            _ => {}
        }
    }
    Err("missing response frame from daemon".to_string())
}

pub fn execute_offline_oneshot(
    service: &dyn ApplicationService,
    action: OneShotAction,
) -> PortResult<String> {
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(std::process::id()),
        account_id: None,
    };
    match action {
        OneShotAction::Status | OneShotAction::McpStdio => {
            let resp = service.query(&caller, AppQuery::DaemonStatus)?;
            Ok(format!("{resp:?}"))
        }
        OneShotAction::ProjectAdd { path, .. } => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "project".to_string());
            let resp = service.execute(
                &caller,
                AppCommand::RegisterProject {
                    name,
                    root_path: path,
                },
            )?;
            if let AppResponse::ProjectRegistered(rec) = resp {
                serde_json::to_string(&json!({
                    "ok": true,
                    "type": "local-project/add",
                    "result": {
                        "localProjectId": rec.project_id.0,
                        "name": rec.name,
                        "rootPath": rec.root_path,
                        "workspaceIds": ["local"],
                    }
                }))
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
            } else {
                Err(PortError::new(
                    PortErrorKind::Internal,
                    "unexpected response",
                ))
            }
        }
        OneShotAction::ProjectList { .. } => {
            let resp = service.query(&caller, AppQuery::ListProjects)?;
            serde_json::to_string(&resp)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        }
        OneShotAction::SessionHistory { session_id, .. } => {
            let resp = service.query(
                &caller,
                AppQuery::GetSessionHistory {
                    workspace_id: WorkspaceId("*".to_string()),
                    session_id: SessionId(session_id.clone()),
                },
            )?;
            if let AppResponse::SessionHistory { turns } = resp {
                let val = format_history_json(&session_id, &turns);
                serde_json::to_string(&val)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
            } else {
                Err(PortError::new(
                    PortErrorKind::Internal,
                    "unexpected history response",
                ))
            }
        }
        OneShotAction::SessionArchive { session_id, .. } => {
            let _ = service.execute(
                &caller,
                AppCommand::ArchiveSession {
                    workspace_id: WorkspaceId("local".to_string()),
                    session_id: SessionId(session_id.clone()),
                },
            )?;
            serde_json::to_string(&json!({
                "ok": true,
                "sessionId": session_id,
            }))
            .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
        }
    }
}
