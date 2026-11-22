#![forbid(unsafe_code)]

use lody_ports::{
    EnginePort, EpochKeyMaterial, HistoryPort, HistoryTurnRecord, PortError, PortErrorKind,
    PortResult, QueuedDraftItem, SessionId, SessionMetaSnapshot, TurnId, WorkspaceId,
    WorkspaceSecurityMode,
};
use std::path::PathBuf;

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
        self.socket_path.is_some()
    }

    fn read_workspace_security_mode(
        &self,
        _workspace_id: &WorkspaceId,
    ) -> PortResult<WorkspaceSecurityMode> {
        Ok(WorkspaceSecurityMode::Plaintext)
    }

    fn read_session_meta(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Option<SessionMetaSnapshot>> {
        Ok(None)
    }

    fn upsert_session_meta(&self, _meta: &SessionMetaSnapshot) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "loro-repo-engine client not yet wired",
        ))
    }

    fn promote_next_queued_draft(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Option<QueuedDraftItem>> {
        Ok(None)
    }

    fn set_message_queue_paused(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _paused: bool,
    ) -> PortResult<()> {
        Ok(())
    }

    fn install_workspace_epoch_keys(
        &self,
        _workspace_id: &WorkspaceId,
        _keys: &[EpochKeyMaterial],
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "loro-repo-engine keyring channel not yet wired",
        ))
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
        Ok(true)
    }

    fn read_session_turns(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
    ) -> PortResult<Vec<HistoryTurnRecord>> {
        Ok(Vec::new())
    }

    fn upsert_turn_record(
        &self,
        _workspace_id: &WorkspaceId,
        _session_id: &SessionId,
        _record: &HistoryTurnRecord,
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "roost history store not yet wired",
        ))
    }
}
