#![forbid(unsafe_code)]

use lody_ports::{
    DiffStorePort, LocalProjectId, PortError, PortErrorKind, PortResult, SessionId,
    TurnDiffSummary, TurnId, WorktreeLease, WorktreePort,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub struct GitWorktreeManager {
    worktrees_root: PathBuf,
}

impl GitWorktreeManager {
    pub fn new(worktrees_root: impl Into<PathBuf>) -> Self {
        Self {
            worktrees_root: worktrees_root.into(),
        }
    }
}

impl Default for GitWorktreeManager {
    fn default() -> Self {
        Self::new(".lody-oss/worktrees")
    }
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
        let sanitized_sid: String = session_id
            .0
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let branch_name = format!("lody/session-{sanitized_sid}");
        let worktree_path = self.worktrees_root.join(&project_id.0).join(&sanitized_sid);

        if let Some(parent) = worktree_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| PortError::new(PortErrorKind::Unavailable, e.to_string()))?;
        }
        if worktree_path.exists() {
            let _ = fs::remove_dir_all(&worktree_path);
        }

        let wt_str = worktree_path.to_string_lossy();
        let mut cmd = Command::new("git");
        cmd.arg("worktree")
            .arg("add")
            .arg("-B")
            .arg(&branch_name)
            .arg(wt_str.as_ref());
        if let Some(base) = base_branch {
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
            worktree_path,
        })
    }

    fn release_worktree(&self, lease: &WorktreeLease) -> PortResult<()> {
        if lease.worktree_path.exists() {
            let wt_str = lease.worktree_path.to_string_lossy();
            let _ = Command::new("git")
                .args(["worktree", "remove", "--force", wt_str.as_ref()])
                .current_dir(&lease.worktree_path)
                .stdin(Stdio::null())
                .output();
            if lease.worktree_path.exists() {
                let _ = fs::remove_dir_all(&lease.worktree_path);
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct LocalTurnDiffStore;

impl DiffStorePort for LocalTurnDiffStore {
    fn capture_turn_snapshot(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        _workdir: &Path,
    ) -> PortResult<TurnDiffSummary> {
        Ok(TurnDiffSummary {
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            files: Vec::new(),
        })
    }

    fn read_turn_diff(
        &self,
        _session_id: &SessionId,
        _turn_id: &TurnId,
    ) -> PortResult<Option<TurnDiffSummary>> {
        Ok(None)
    }
}
