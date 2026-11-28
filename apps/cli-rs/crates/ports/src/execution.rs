#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use crate::identity::{LocalProjectId, SessionId, WorkspaceId};
use crate::storage::{AutomationEvidenceEntry, AutomationMatchResult, AutomationReadObservation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
pub struct McpEnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpServerTransport {
    Http {
        url: String,
        bearer_token: Option<String>,
        headers: Vec<McpHttpHeader>,
    },
    Stdio {
        command: PathBuf,
        args: Vec<String>,
        env: Vec<McpEnvVar>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerMount {
    pub name: String,
    pub transport: McpServerTransport,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpNativeActivity {
    Idle,
    Running,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcpSessionArchiveMode {
    Native,
    TitleMarker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcpSessionArchiveOutcome {
    Native,
    TitleMarker,
    Unsupported,
    Superseded,
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
    SessionActivity {
        activity: AcpNativeActivity,
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
    fn advertises_session_activity(&self) -> bool {
        false
    }
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
    fn set_session_archived(
        &self,
        _spec: &AcpSpawnSpec,
        _native_session_id: &str,
        _archived: bool,
    ) -> PortResult<AcpSessionArchiveOutcome> {
        Ok(AcpSessionArchiveOutcome::Unsupported)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeLease {
    pub session_id: SessionId,
    pub project_id: LocalProjectId,
    pub branch_name: String,
    pub base_branch: Option<String>,
    pub worktree_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectGitSummary {
    pub git: bool,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub github_repo_full_name: Option<String>,
}

impl LocalProjectGitSummary {
    pub fn non_git() -> Self {
        Self {
            git: false,
            current_branch: None,
            default_branch: None,
            github_repo_full_name: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchListQuery {
    pub query: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchListPage {
    pub git: bool,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub pinned_branches: Vec<String>,
    pub branches: Vec<String>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub paths: Vec<String>,
    pub truncated: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProjectAdd {
    pub local_project_id: LocalProjectId,
    pub name: String,
    pub root_path: String,
    pub already_registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<LocalProjectGitSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRootsInfo {
    pub platform: String,
    pub path_separator: String,
    pub home_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drives: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectoryQuery {
    pub absolute_path: Option<PathBuf>,
    pub show_hidden: bool,
    pub limit: usize,
    pub cursor: Option<String>,
    pub registered_projects: BTreeMap<String, PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseEntryHints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectoryEntry {
    pub name: String,
    pub absolute_path: String,
    pub is_symlink: bool,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hints: Option<BrowseEntryHints>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectoryPage {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<BrowseDirectoryEntry>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryChildEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryListPage {
    pub entries: Vec<DirectoryChildEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFileReadResult {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutBranchOutcome {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absolute_path: Option<String>,
    pub is_symlink: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillGroupEntry {
    pub scope: String,
    pub dir: String,
    pub skills: Vec<ProjectSkillEntry>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_external_symlinks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillsListing {
    pub groups: Vec<ProjectSkillGroupEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unchanged: Option<bool>,
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
    fn inspect_git_summary(&self, _root: &Path) -> LocalProjectGitSummary {
        LocalProjectGitSummary::non_git()
    }
    fn list_branches(&self, _root: &Path, _query: &BranchListQuery) -> PortResult<BranchListPage> {
        Ok(BranchListPage {
            git: false,
            current_branch: None,
            default_branch: None,
            pinned_branches: Vec::new(),
            branches: Vec::new(),
            truncated: false,
            next_cursor: None,
            total_count: 0,
        })
    }
    fn search_project_files(
        &self,
        _root: &Path,
        _query: &str,
        _limit: usize,
    ) -> PortResult<FileSearchResult> {
        Ok(FileSearchResult {
            paths: Vec::new(),
            truncated: false,
        })
    }
    fn scan_project_files(&self, _root: &Path) -> PortResult<ScannedFileIndex> {
        Ok(ScannedFileIndex {
            entries: Vec::new(),
            truncated: false,
            estimated_bytes: 2,
        })
    }
    fn prepare_project_root(&self, _root: &Path) -> PortResult<(LocalProjectId, String, PathBuf)> {
        Err(PortError::capability_unavailable("localProjectPrepare"))
    }
    fn list_browse_roots(&self, _home_dir: &Path) -> PortResult<BrowseRootsInfo> {
        Err(PortError::capability_unavailable("localProjectBrowse"))
    }
    fn browse_directory(
        &self,
        _home_dir: &Path,
        _query: &BrowseDirectoryQuery,
    ) -> PortResult<BrowseDirectoryPage> {
        Err(PortError::capability_unavailable("localProjectBrowse"))
    }
    fn create_directory(&self, _parent_path: &Path, _name: &str) -> PortResult<PathBuf> {
        Err(PortError::capability_unavailable(
            "localProjectCreateDirectory",
        ))
    }
    fn list_project_files(&self, _root: &Path, _max_files: usize) -> PortResult<FileSearchResult> {
        Ok(FileSearchResult {
            paths: Vec::new(),
            truncated: false,
        })
    }
    fn list_project_directory(
        &self,
        _root: &Path,
        _relative_path: &str,
        _limit: usize,
    ) -> PortResult<DirectoryListPage> {
        Ok(DirectoryListPage {
            entries: Vec::new(),
            truncated: false,
        })
    }
    fn read_project_file(
        &self,
        _root: &Path,
        _relative_path: &str,
        _max_bytes: usize,
        _allow_binary_images: bool,
    ) -> PortResult<Option<ProjectFileReadResult>> {
        Ok(None)
    }
    fn checkout_branch(&self, _root: &Path, _branch_name: &str) -> CheckoutBranchOutcome {
        CheckoutBranchOutcome {
            success: false,
            current_branch: None,
            error: Some("Branch checkout unavailable".to_string()),
        }
    }
    fn list_project_skills(
        &self,
        _root: &Path,
        _skill_dirs: &[String],
        _known_fingerprint: Option<&str>,
    ) -> PortResult<ProjectSkillsListing> {
        Ok(ProjectSkillsListing {
            groups: Vec::new(),
            content_fingerprint: None,
            unchanged: None,
        })
    }
    fn list_global_skills(
        &self,
        _home_dir: &Path,
        _known_fingerprint: Option<&str>,
    ) -> PortResult<ProjectSkillsListing> {
        Ok(ProjectSkillsListing {
            groups: Vec::new(),
            content_fingerprint: None,
            unchanged: None,
        })
    }
    fn resolve_session_worktree_path(
        &self,
        _repo_key: &str,
        _session_id: &SessionId,
    ) -> PortResult<PathBuf> {
        Err(PortError::new(
            PortErrorKind::NotFound,
            "Session worktree path not found.",
        ))
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationProgramContext {
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
    #[serde(rename = "now")]
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationProgramEvaluation {
    pub matched: Option<AutomationMatchResult>,
    pub reads: Vec<String>,
    pub evidence: Vec<AutomationEvidenceEntry>,
}

pub trait AutomationHostOps: Send + Sync {
    fn read_resource(
        &self,
        resource: &str,
        parameters: &Value,
    ) -> PortResult<AutomationReadObservation>;
    fn session_workdir(&self) -> Option<PathBuf>;
    fn command_env(&self) -> BTreeMap<String, String>;
    fn override_fetch(&self, _request: &Value) -> Option<PortResult<Value>> {
        None
    }
}

pub trait AutomationSandboxPort: Send + Sync {
    fn validate_program(&self, source: &str, context: &AutomationProgramContext) -> PortResult<()>;
    fn evaluate_program(
        &self,
        source: &str,
        context: &AutomationProgramContext,
        host_ops: Arc<dyn AutomationHostOps>,
    ) -> PortResult<AutomationProgramEvaluation>;
}

#[derive(Default)]
pub struct UnavailableAutomationSandbox;

impl AutomationSandboxPort for UnavailableAutomationSandbox {
    fn validate_program(
        &self,
        _source: &str,
        _context: &AutomationProgramContext,
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation sandbox unavailable",
        ))
    }

    fn evaluate_program(
        &self,
        _source: &str,
        _context: &AutomationProgramContext,
        _host_ops: Arc<dyn AutomationHostOps>,
    ) -> PortResult<AutomationProgramEvaluation> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "automation sandbox unavailable",
        ))
    }
}
