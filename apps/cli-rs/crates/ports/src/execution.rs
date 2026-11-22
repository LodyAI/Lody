#![forbid(unsafe_code)]

use crate::error::PortResult;
use crate::identity::{LocalProjectId, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
pub struct McpServerMount {
    pub name: String,
    pub transport_url: String,
    pub bearer_token: Option<String>,
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
    fn launch_session(&self, spec: &AcpSpawnSpec) -> PortResult<Box<dyn AcpSessionPort>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeLease {
    pub session_id: SessionId,
    pub project_id: LocalProjectId,
    pub branch_name: String,
    pub worktree_path: PathBuf,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtySpawnSpec {
    pub pty_id: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

pub trait PtyPort: Send + Sync {
    fn open_pty(&self, spec: &PtySpawnSpec) -> PortResult<()>;
    fn resize_pty(&self, pty_id: &str, cols: u16, rows: u16) -> PortResult<()>;
    fn close_pty(&self, pty_id: &str) -> PortResult<()>;
}
