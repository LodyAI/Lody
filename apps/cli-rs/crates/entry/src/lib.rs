#![forbid(unsafe_code)]

use lody_app::{AppQuery, AppResponse, ApplicationService, PortResult, VerifiedPrincipal};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryMode {
    Daemon,
    DaemonRunner,
    McpStdio,
    Status,
    Version,
}

pub fn parse_entry_mode(args: &[String]) -> Result<EntryMode, String> {
    match args.first().map(String::as_str) {
        None | Some("status") => Ok(EntryMode::Status),
        Some("--version") | Some("-V") | Some("version") => Ok(EntryMode::Version),
        Some("daemon") => match args.get(1).map(String::as_str) {
            Some("run") | Some("start-foreground") => Ok(EntryMode::Daemon),
            Some("runner") => Ok(EntryMode::DaemonRunner),
            Some("status") | None => Ok(EntryMode::Status),
            Some(other) => Err(format!("unsupported daemon subcommand: {other}")),
        },
        Some("mcp-stdio") => Ok(EntryMode::McpStdio),
        Some(other) => Err(format!("unsupported command: {other}")),
    }
}

pub fn run_local_status(service: &dyn ApplicationService) -> PortResult<AppResponse> {
    let caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(std::process::id()),
        account_id: None,
    };
    service.query(&caller, AppQuery::DaemonStatus)
}
