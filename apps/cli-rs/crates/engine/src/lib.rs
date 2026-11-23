#![forbid(unsafe_code)]

use lody_ports::{
    EnginePort, EpochKeyMaterial, HistoryPort, HistoryTurnRecord, LocalProjectId,
    LocalProjectRecord, PortError, PortErrorKind, PortResult, ProjectStorePort, QueuedDraftItem,
    SessionId, SessionMetaSnapshot, TurnId, WorkspaceId, WorkspaceSecurityMode,
};
use std::path::{Path, PathBuf};

fn not_wired(component: &str) -> PortError {
    PortError::new(
        PortErrorKind::Unavailable,
        format!("{component} is pending official Rust engine integration"),
    )
}

pub struct RepoEngineClient {
    socket_path: Option<PathBuf>,
}

impl RepoEngineClient {
    pub fn new(socket_path: Option<PathBuf>) -> Self {
        Self { socket_path }
    }

    pub fn socket_path(&self) -> Option<&PathBuf> {
        self.socket_path.as_ref()
    }
}

impl EnginePort for RepoEngineClient {
    fn is_connected(&self) -> bool {
        false
    }

    fn read_workspace_security_mode(
        &self,
        _workspace_id: &WorkspaceId,
    ) -> PortResult<WorkspaceSecurityMode> {
        Err(not_wired("loro-repo-rs workspace security mode"))
    }

    fn read_session_meta(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>> {
        Err(not_wired("loro-repo-rs session meta"))
    }

    fn upsert_session_meta(&self, _meta: &SessionMetaSnapshot) -> PortResult<()> {
        Err(not_wired("loro-repo-rs session meta"))
    }

    fn promote_next_queued_draft(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Option<QueuedDraftItem>> {
        Err(not_wired("loro-repo-rs messageQueue"))
    }

    fn set_message_queue_paused(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _paused: bool,
    ) -> PortResult<()> {
        Err(not_wired("loro-repo-rs messageQueue"))
    }

    fn install_workspace_epoch_keys(
        &self,
        _workspace_id: &WorkspaceId,
        _keys: &[EpochKeyMaterial],
    ) -> PortResult<()> {
        Err(not_wired("loro-repo-rs keyring"))
    }
}

#[derive(Default)]
pub struct FlockProjectStore;

impl ProjectStorePort for FlockProjectStore {
    fn register_project(&self, _name: &str, _root_path: &Path) -> PortResult<LocalProjectRecord> {
        Err(not_wired("Flock project catalog"))
    }

    fn get_project(&self, _project_id: &LocalProjectId) -> PortResult<Option<LocalProjectRecord>> {
        Err(not_wired("Flock project catalog"))
    }

    fn list_projects(&self) -> PortResult<Vec<LocalProjectRecord>> {
        Err(not_wired("Flock project catalog"))
    }
}

#[derive(Default)]
pub struct RoostHistoryStore;

impl HistoryPort for RoostHistoryStore {
    fn backend_name(&self) -> &'static str {
        "roost"
    }

    fn is_user_turn_durable(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _turn_id: &TurnId,
    ) -> PortResult<bool> {
        Err(not_wired("Roost session history"))
    }

    fn read_session_turns(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>> {
        Err(not_wired("Roost session history"))
    }

    fn upsert_turn_record(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _record: &HistoryTurnRecord,
    ) -> PortResult<()> {
        Err(not_wired("Roost session history"))
    }

    fn erase_workspace_turns(&self, _workspace_id: &WorkspaceId) -> PortResult<()> {
        Err(not_wired("Roost session history"))
    }
}
