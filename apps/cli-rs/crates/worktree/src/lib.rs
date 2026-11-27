#![forbid(unsafe_code)]

pub mod git_meta;
pub mod project_fs;
pub mod scan;
pub mod turn_diff;

pub use git_meta::{
    inspect_git_summary, list_branches, parse_github_repo_full_name, rank_project_file_paths,
    score_local_project_file_path, search_project_files,
};
use lody_ports::{
    BranchListPage, BranchListQuery, BrowseDirectoryPage, BrowseDirectoryQuery, BrowseRootsInfo,
    CheckoutBranchOutcome, DirectoryListPage, FileSearchResult, LocalProjectGitSummary,
    LocalProjectId, PortError, PortErrorKind, PortResult, ProjectFileReadResult,
    ProjectSkillsListing, ScannedFileIndex, SessionId, WorktreeLease, WorktreePort,
};
pub use project_fs::{
    DEFAULT_BROWSE_DIR_LIMIT, DEFAULT_LIST_DIR_LIMIT, DEFAULT_PROJECT_MAX_FILES,
    DEFAULT_READ_FILE_MAX_BYTES, HARD_BROWSE_DIR_LIMIT, HARD_LIST_DIR_LIMIT,
    HARD_PROJECT_MAX_FILES, HARD_READ_FILE_MAX_BYTES, browse_directory, checkout_branch,
    create_directory, list_browse_roots, list_global_skills, list_project_directory,
    list_project_files, list_project_skills, prepare_project_root, read_project_file,
    resolve_session_worktree_path, validate_directory_name,
};
pub use scan::{
    CODE_COLLAB_IGNORED_DIRECTORY_NAMES, CODE_COLLAB_MAX_INDEX_BYTES,
    CODE_COLLAB_MAX_INDEX_ENTRIES, collect_project_file_paths, is_ignored_directory_name,
    scan_directory_parallel,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
pub use turn_diff::{
    CODEC_GZIP, CODEC_RAW, CODEC_ZSTD, LocalTurnDiffStore, ReconstructedSnapshotPair,
    SqliteTurnDiffStore, TURN_DIFF_APPLICATION_ID, TURN_DIFF_SCHEMA_VERSION, TrackedLatestText,
    TurnDiffGcStats, TurnDiffIntegrityStats, TurnDiffStoreConfig, compress_chunk,
    compute_line_diff_counts, decompress_chunk, git_diff_base_ref_candidates,
    safe_workspace_segment, workspace_diff_db_path,
};

pub struct GitWorktreeManager {
    repos_root: PathBuf,
}

impl GitWorktreeManager {
    pub fn new(repos_root: impl Into<PathBuf>) -> Self {
        Self {
            repos_root: repos_root.into(),
        }
    }
}

impl Default for GitWorktreeManager {
    fn default() -> Self {
        Self::new(".lody-oss/repos")
    }
}

fn verify_existing_worktree_belongs_to_repo(worktree_path: &Path, project_root: &Path) -> bool {
    let Ok(expected_git_dir) = fs::canonicalize(project_root.join(".git")) else {
        return false;
    };
    let Ok(out) = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(worktree_path)
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let reported = String::from_utf8_lossy(&out.stdout);
    let reported_trimmed = reported.trim();
    let resolved = Path::new(reported_trimmed);
    let candidate = if resolved.is_absolute() {
        resolved.to_path_buf()
    } else {
        worktree_path.join(resolved)
    };
    fs::canonicalize(candidate).is_ok_and(|actual| actual == expected_git_dir)
}

fn is_worktree_dirty(worktree_path: &Path) -> bool {
    let Ok(out) = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .current_dir(worktree_path)
        .stdin(Stdio::null())
        .output()
    else {
        return true;
    };
    if !out.status.success() {
        return true;
    }
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}

fn resolve_default_worktree_base(project_root: &Path) -> Option<String> {
    let summary = inspect_git_summary(project_root);
    if let Some(branch) = summary.current_branch.filter(|b| !b.trim().is_empty()) {
        return Some(branch);
    }
    let out = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD^{commit}"])
        .current_dir(project_root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?;
    let trimmed = sha.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

impl WorktreePort for GitWorktreeManager {
    fn supports_git_worktree(&self) -> bool {
        true
    }

    fn acquire_worktree(
        &self,
        project_id: &LocalProjectId,
        project_root: &Path,
        session_id: &SessionId,
        base_branch: Option<&str>,
    ) -> PortResult<WorktreeLease> {
        let normalized_base = base_branch
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        let sanitized_sid: String = session_id
            .0
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let branch_name = format!("session/{sanitized_sid}");
        let worktree_path = self
            .repos_root
            .join(&project_id.0)
            .join("worktrees")
            .join(&sanitized_sid);

        if worktree_path.exists() {
            if verify_existing_worktree_belongs_to_repo(&worktree_path, project_root) {
                return Ok(WorktreeLease {
                    session_id: session_id.clone(),
                    project_id: project_id.clone(),
                    branch_name,
                    base_branch: normalized_base,
                    worktree_path,
                });
            }
            return Err(PortError::new(
                PortErrorKind::Conflict,
                format!(
                    "existing worktree directory {:?} does not belong to project {:?}",
                    worktree_path, project_root
                ),
            ));
        }

        let effective_base =
            normalized_base.or_else(|| resolve_default_worktree_base(project_root));

        if let Some(parent) = worktree_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }

        let wt_str = worktree_path.to_string_lossy();
        let mut cmd = Command::new("git");
        cmd.arg("worktree")
            .arg("add")
            .arg("-B")
            .arg(&branch_name)
            .arg(wt_str.as_ref());
        if let Some(ref base) = effective_base {
            cmd.arg(base);
        }
        let out = cmd
            .current_dir(project_root)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;

        if !out.status.success() {
            return Err(PortError::new(
                PortErrorKind::Internal,
                format!(
                    "git worktree add failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            ));
        }

        Ok(WorktreeLease {
            session_id: session_id.clone(),
            project_id: project_id.clone(),
            branch_name,
            base_branch: effective_base,
            worktree_path,
        })
    }

    fn release_worktree(&self, lease: &WorktreeLease) -> PortResult<()> {
        if !lease.worktree_path.exists() || is_worktree_dirty(&lease.worktree_path) {
            return Ok(());
        }
        let wt_str = lease.worktree_path.to_string_lossy();
        let _ = Command::new("git")
            .args(["worktree", "remove", "--force", wt_str.as_ref()])
            .current_dir(&lease.worktree_path)
            .stdin(Stdio::null())
            .output();
        if lease.worktree_path.exists() {
            let _ = fs::remove_dir_all(&lease.worktree_path);
        }
        Ok(())
    }

    fn inspect_git_summary(&self, root: &Path) -> LocalProjectGitSummary {
        inspect_git_summary(root)
    }

    fn list_branches(&self, root: &Path, query: &BranchListQuery) -> PortResult<BranchListPage> {
        list_branches(root, query)
    }

    fn search_project_files(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
    ) -> PortResult<FileSearchResult> {
        search_project_files(root, query, limit)
    }

    fn scan_project_files(&self, root: &Path) -> PortResult<ScannedFileIndex> {
        scan_directory_parallel(
            root,
            CODE_COLLAB_MAX_INDEX_ENTRIES,
            CODE_COLLAB_MAX_INDEX_BYTES,
        )
    }

    fn prepare_project_root(&self, root: &Path) -> PortResult<(LocalProjectId, String, PathBuf)> {
        prepare_project_root(root)
    }

    fn list_browse_roots(&self, home_dir: &Path) -> PortResult<BrowseRootsInfo> {
        list_browse_roots(home_dir)
    }

    fn browse_directory(
        &self,
        home_dir: &Path,
        query: &BrowseDirectoryQuery,
    ) -> PortResult<BrowseDirectoryPage> {
        browse_directory(home_dir, query)
    }

    fn create_directory(&self, parent_path: &Path, name: &str) -> PortResult<PathBuf> {
        create_directory(parent_path, name)
    }

    fn list_project_files(&self, root: &Path, max_files: usize) -> PortResult<FileSearchResult> {
        list_project_files(root, max_files)
    }

    fn list_project_directory(
        &self,
        root: &Path,
        relative_path: &str,
        limit: usize,
    ) -> PortResult<DirectoryListPage> {
        list_project_directory(root, relative_path, limit)
    }

    fn read_project_file(
        &self,
        root: &Path,
        relative_path: &str,
        max_bytes: usize,
        allow_binary_images: bool,
    ) -> PortResult<Option<ProjectFileReadResult>> {
        read_project_file(root, relative_path, max_bytes, allow_binary_images)
    }

    fn checkout_branch(&self, root: &Path, branch_name: &str) -> CheckoutBranchOutcome {
        checkout_branch(root, branch_name)
    }

    fn list_project_skills(
        &self,
        root: &Path,
        skill_dirs: &[String],
        known_fingerprint: Option<&str>,
    ) -> PortResult<ProjectSkillsListing> {
        list_project_skills(root, skill_dirs, known_fingerprint)
    }

    fn list_global_skills(
        &self,
        home_dir: &Path,
        known_fingerprint: Option<&str>,
    ) -> PortResult<ProjectSkillsListing> {
        list_global_skills(home_dir, known_fingerprint)
    }

    fn resolve_session_worktree_path(
        &self,
        repo_key: &str,
        session_id: &SessionId,
    ) -> PortResult<PathBuf> {
        resolve_session_worktree_path(&self.repos_root, repo_key, session_id)
    }
}
