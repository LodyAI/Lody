#![forbid(unsafe_code)]

use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, InboxStorePort, PortError, PortErrorKind, PortResult,
    SessionId, SubmissionStage, TurnId, WorkspaceId,
};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SqliteDataLayout {
    pub data_dir: PathBuf,
}

impl SqliteDataLayout {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn operations_db(&self) -> PathBuf {
        self.data_dir.join("operations.sqlite3")
    }

    pub fn schedules_db(&self) -> PathBuf {
        self.data_dir.join("schedules.sqlite")
    }

    pub fn pr_poller_db(&self) -> PathBuf {
        self.data_dir.join("pr-poller-state.sqlite3")
    }

    pub fn automation_workspace_db(&self, workspace_storage_key: &str) -> PathBuf {
        self.data_dir
            .join("automations")
            .join(format!("{workspace_storage_key}.sqlite"))
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

pub struct SqliteInboxStore {
    layout: SqliteDataLayout,
}

impl SqliteInboxStore {
    pub fn new(layout: SqliteDataLayout) -> Self {
        Self { layout }
    }

    pub fn layout(&self) -> &SqliteDataLayout {
        &self.layout
    }
}

impl InboxStorePort for SqliteInboxStore {
    fn store_name(&self) -> &'static str {
        "operations.sqlite3"
    }

    fn admit_turn(&self, _input: &AdmittedTurnInput) -> PortResult<AdmissionVerdict> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "sqlite inbox store not yet wired",
        ))
    }

    fn claim_next_runnable(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Option<AdmittedTurnInput>> {
        Ok(None)
    }

    fn update_submission_stage(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _turn_id: &TurnId,
        _stage: SubmissionStage,
    ) -> PortResult<()> {
        Ok(())
    }

    fn set_inbox_paused(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _paused: bool,
    ) -> PortResult<()> {
        Ok(())
    }
}
