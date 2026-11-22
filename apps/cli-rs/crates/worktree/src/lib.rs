#![forbid(unsafe_code)]

use lody_ports::{
    DiffStorePort, LocalProjectId, PortError, PortErrorKind, PortResult, SessionId,
    TurnDiffSummary, TurnId, WorktreeLease, WorktreePort,
};
use std::path::Path;

#[derive(Default)]
pub struct GitWorktreeManager;

impl WorktreePort for GitWorktreeManager {
    fn supports_git_worktree(&self) -> bool {
        true
    }

    fn acquire_worktree(
        &self,
        _project_id: &LocalProjectId,
        _project_root: &Path,
        _session_id: &SessionId,
        _base_branch: Option<&str>,
    ) -> PortResult<WorktreeLease> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "git worktree manager not yet wired",
        ))
    }

    fn release_worktree(&self, _lease: &WorktreeLease) -> PortResult<()> {
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
