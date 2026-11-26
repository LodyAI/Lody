#![forbid(unsafe_code)]

pub mod ipc;
pub mod mcp_http;
pub mod terminal;

use clap::{Parser, Subcommand};
pub use ipc::{
    DaemonRunMetadata, format_history_json, probe_live_daemon, query_live_daemon_machine_id,
    send_unix_http, serve_local_daemon,
};
use lody_app::{
    AppCommand, AppQuery, AppResponse, ApplicationService, MachineIdentityRestoreOutcome,
    PortError, PortErrorKind, PortResult, SessionId, TurnId, VerifiedPrincipal, WorkspaceId,
};
pub use mcp_http::{
    MCP_HTTP_MACHINE_ID_HEADER, MCP_HTTP_SESSION_ID_HEADER, MCP_HTTP_WORKDIR_B64_HEADER,
    MCP_HTTP_WORKSPACE_ID_HEADER, McpRequestContext, find_peer_uid_in_proc_net_tcp,
    ip_to_proc_net_hexes, parse_mcp_context_headers, start_mcp_http_server,
    timing_safe_token_equal,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
pub use terminal::{resolve_terminal_socket_path, start_local_terminal_server};

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
    Machine {
        #[command(subcommand)]
        action: MachineSubcommand,
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
enum MachineSubcommand {
    #[command(name = "restore-id")]
    RestoreId {
        machine_id: String,
        #[arg(long)]
        json: bool,
    },
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
    Scan {
        path: PathBuf,
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
    Diff {
        session_id: String,
        turn_id: String,
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
    MachineRestoreId {
        machine_id: String,
        json: bool,
    },
    ProjectAdd {
        path: PathBuf,
        json: bool,
    },
    ProjectList {
        json: bool,
    },
    ProjectScan {
        path: PathBuf,
        json: bool,
    },
    SessionHistory {
        session_id: String,
        offline: bool,
        json: bool,
    },
    SessionDiff {
        session_id: String,
        turn_id: String,
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
        Some(CliCommand::Machine { action }) => match action {
            MachineSubcommand::RestoreId { machine_id, json } => {
                Ok(DispatchPlan::OneShot(OneShotAction::MachineRestoreId {
                    machine_id,
                    json,
                }))
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
            ProjectSubcommand::Scan { path, json } => {
                Ok(DispatchPlan::OneShot(OneShotAction::ProjectScan {
                    path,
                    json,
                }))
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
            SessionSubcommand::Diff {
                session_id,
                turn_id,
                json,
            } => Ok(DispatchPlan::OneShot(OneShotAction::SessionDiff {
                session_id,
                turn_id,
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

pub fn format_restore_machine_id_output(
    outcome: &MachineIdentityRestoreOutcome,
    json_mode: bool,
) -> Result<String, String> {
    if json_mode {
        return serde_json::to_string_pretty(&json!({
            "ok": true,
            "changed": outcome.changed,
            "targetMachineId": outcome.target_machine_id.0,
            "previousMachineId": outcome.previous_machine_id.as_ref().map(|m| &m.0),
            "previousCredentialMachineId": outcome.previous_credential_machine_id.as_ref().map(|m| &m.0),
            "credentialsUpdated": outcome.credentials_updated,
            "anchorUpdated": outcome.anchor_updated,
            "backupDir": outcome.backup_dir,
        }))
        .map_err(|e| e.to_string());
    }

    if !outcome.changed {
        return Ok(format!(
            "Local machine ID is already {}. No changes were made.",
            outcome.target_machine_id.0
        ));
    }

    let mut lines = vec![format!(
        "Restored local machine ID to {}",
        outcome.target_machine_id.0
    )];
    if let Some(prev) = &outcome.previous_machine_id
        && prev != &outcome.target_machine_id
    {
        lines.push(format!("  Previous machine-id: {}", prev.0));
    }
    if let Some(prev_cred) = &outcome.previous_credential_machine_id
        && prev_cred != &outcome.target_machine_id
    {
        lines.push(format!("  Previous credentials machineId: {}", prev_cred.0));
    }
    lines.push(format!(
        "  credentials.json updated: {}",
        if outcome.credentials_updated {
            "yes"
        } else {
            "no (not present)"
        }
    ));
    lines.push(format!(
        "  backup anchor updated: {}",
        if outcome.anchor_updated { "yes" } else { "no" }
    ));
    if let Some(dir) = &outcome.backup_dir {
        lines.push(format!("  Backup saved to: {}", dir.display()));
    }
    lines.push(
        "Restart Lody (desktop app or `lody daemon start`) to reconnect with the restored identity."
            .to_string(),
    );
    Ok(lines.join("\n"))
}

pub fn format_restore_machine_id_error(message: &str, json_mode: bool) -> String {
    if json_mode {
        serde_json::to_string_pretty(&json!({
            "ok": false,
            "error": message,
        }))
        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
    } else {
        message.to_string()
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
    if matches!(action, OneShotAction::MachineRestoreId { .. }) {
        return None;
    }

    let meta = probe_live_daemon(data_dir)?;
    let control = Path::new(&meta.control_socket_path);
    let tok = meta.token.as_deref();

    match action {
        OneShotAction::ProjectAdd { path, .. } => {
            let machine_id =
                query_live_daemon_machine_id(&meta).unwrap_or_else(|| "local".to_string());
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
            let machine_id =
                query_live_daemon_machine_id(&meta).unwrap_or_else(|| "local".to_string());
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
        OneShotAction::SessionDiff {
            session_id,
            turn_id,
            ..
        } => {
            let res = send_unix_http(
                control,
                "POST",
                "/session-control",
                tok,
                Some(&json!({
                    "type": "session/turn_diff",
                    "sessionId": session_id,
                    "turnId": turn_id,
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
        OneShotAction::MachineRestoreId { machine_id, json } => {
            let resp = service.execute(
                &caller,
                AppCommand::RestoreMachineId {
                    target_machine_id: machine_id,
                    active_host_pid: None,
                },
            )?;
            if let AppResponse::MachineIdRestored(outcome) = resp {
                format_restore_machine_id_output(&outcome, json)
                    .map_err(|e| PortError::new(PortErrorKind::Internal, e))
            } else {
                Err(PortError::new(
                    PortErrorKind::Internal,
                    "unexpected response",
                ))
            }
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
        OneShotAction::ProjectScan { path, .. } => {
            let resp = service.query(&caller, AppQuery::ScanProjectFiles { root_path: path })?;
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
        OneShotAction::SessionDiff {
            session_id,
            turn_id,
            ..
        } => {
            let resp = service.query(
                &caller,
                AppQuery::GetTurnDiff {
                    workspace_id: WorkspaceId("local".to_string()),
                    session_id: SessionId(session_id),
                    turn_id: TurnId(turn_id),
                },
            )?;
            serde_json::to_string(&resp)
                .map_err(|e| PortError::new(PortErrorKind::Internal, e.to_string()))
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
