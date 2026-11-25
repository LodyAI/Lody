#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::identity::{LocalProjectId, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TERMINAL_MAX_PER_SESSION: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ManagedArtifactSource {
    PublicDefault { base_url: String },
    Mirror { base_url: String },
    OfflineBundle { bundle_dir: PathBuf },
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledArtifact {
    pub artifact_id: String,
    pub version: String,
    pub executable_path: PathBuf,
    pub sha256_hex: String,
}

pub trait ArtifactRegistryPort: Send + Sync {
    fn source(&self) -> &ManagedArtifactSource;
    fn ensure_installed(&self, artifact_id: &str, version: &str) -> PortResult<InstalledArtifact>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerMount {
    pub name: String,
    pub transport_url: String,
    pub bearer_token: Option<String>,
    pub headers: Vec<McpHttpHeader>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomCommandSpec {
    pub command: PathBuf,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpSpawnSpec {
    pub adapter_id: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub mcp_mounts: Vec<McpServerMount>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteerVerdict {
    Applied,
    NotApplied,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub request_id: String,
    pub selected_option_id: Option<String>,
    pub cancelled: bool,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpInboundEvent {
    MessageChunk {
        text: String,
    },
    ToolStatus {
        tool_call_id: String,
        title: String,
        status: String,
    },
    PermissionRequest {
        request_id: String,
        tool_call_id: String,
        title: String,
    },
    PromptFinished {
        stop_reason: String,
    },
    ProcessExited {
        exit_code: Option<i32>,
        prompt_was_in_flight: bool,
    },
}

pub trait AcpEventSink: Send + Sync {
    fn on_acp_event(&self, event: AcpInboundEvent);
}

pub trait AcpSessionPort: Send + Sync {
    fn acp_session_id(&self) -> &str;
    fn send_prompt(&self, prompt_text: &str) -> PortResult<()>;
    fn steer(&self, prompt_text: &str) -> PortResult<SteerVerdict>;
    fn reply_permission(&self, decision: &PermissionDecision) -> PortResult<()>;
    fn cancel_turn(&self) -> PortResult<()>;
    fn terminate(&self) -> PortResult<()>;
}

pub trait AcpLauncherPort: Send + Sync {
    fn max_concurrent_starts(&self) -> usize;
    fn launch_session(
        &self,
        spec: &AcpSpawnSpec,
        sink: Arc<dyn AcpEventSink>,
    ) -> PortResult<Box<dyn AcpSessionPort>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeLease {
    pub session_id: SessionId,
    pub project_id: LocalProjectId,
    pub branch_name: String,
    pub worktree_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedFileEntry {
    pub relative_path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedFileIndex {
    pub entries: Vec<ScannedFileEntry>,
    pub truncated: bool,
    pub estimated_bytes: usize,
}

pub trait WorktreePort: Send + Sync {
    fn supports_git_worktree(&self) -> bool;
    fn acquire_worktree(
        &self,
        project_id: &LocalProjectId,
        project_root: &Path,
        session_id: &SessionId,
        base_branch: Option<&str>,
    ) -> PortResult<WorktreeLease>;
    fn release_worktree(&self, lease: &WorktreeLease) -> PortResult<()>;
    fn scan_project_files(&self, _root: &Path) -> PortResult<ScannedFileIndex> {
        Ok(ScannedFileIndex {
            entries: Vec::new(),
            truncated: false,
            estimated_bytes: 2,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub terminal_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOpenSpec {
    pub session_id: SessionId,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub shell_program: String,
    pub shell_args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenOutcome {
    pub terminal_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAttachReplay {
    pub title: String,
    pub scrollback: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalOutboundEvent {
    #[serde(rename_all = "camelCase")]
    Data {
        terminal_id: String,
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        replay: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Title { terminal_id: String, title: String },
    #[serde(rename_all = "camelCase")]
    Exit {
        terminal_id: String,
        exit_code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
}

pub trait TerminalEventSink: Send + Sync {
    fn on_terminal_event(&self, event: TerminalOutboundEvent);
}

pub trait PtyPort: Send + Sync {
    fn list_session_terminals(&self, session_id: &SessionId) -> Vec<TerminalSnapshot>;
    fn open_terminal(&self, spec: TerminalOpenSpec) -> PortResult<TerminalOpenOutcome>;
    fn attach_terminal(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> PortResult<TerminalAttachReplay>;
    fn write_terminal_input(&self, terminal_id: &str, data: &str) -> PortResult<()>;
    fn resize_terminal(&self, terminal_id: &str, cols: u16, rows: u16) -> PortResult<()>;
    fn close_terminal(&self, terminal_id: &str) -> PortResult<()>;
    fn close_session_terminals(&self, session_id: &SessionId);
    fn close_all_terminals(&self);
    fn register_sink(&self, sink_id: u64, sink: Arc<dyn TerminalEventSink>);
    fn unregister_sink(&self, sink_id: u64);
}

#[derive(Default)]
pub struct UnavailablePtyPort;

impl PtyPort for UnavailablePtyPort {
    fn list_session_terminals(&self, _session_id: &SessionId) -> Vec<TerminalSnapshot> {
        Vec::new()
    }

    fn open_terminal(&self, _spec: TerminalOpenSpec) -> PortResult<TerminalOpenOutcome> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "terminal_error: PTY service unavailable",
        ))
    }

    fn attach_terminal(
        &self,
        _terminal_id: &str,
        _cols: u16,
        _rows: u16,
    ) -> PortResult<TerminalAttachReplay> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "terminal_error: PTY service unavailable",
        ))
    }

    fn write_terminal_input(&self, _terminal_id: &str, _data: &str) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "terminal_error: PTY service unavailable",
        ))
    }

    fn resize_terminal(&self, _terminal_id: &str, _cols: u16, _rows: u16) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "terminal_error: PTY service unavailable",
        ))
    }

    fn close_terminal(&self, _terminal_id: &str) -> PortResult<()> {
        Ok(())
    }

    fn close_session_terminals(&self, _session_id: &SessionId) {}

    fn close_all_terminals(&self) {}

    fn register_sink(&self, _sink_id: u64, _sink: Arc<dyn TerminalEventSink>) {}

    fn unregister_sink(&self, _sink_id: u64) {}
}
