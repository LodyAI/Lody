#![forbid(unsafe_code)]

use lody_ports::{
    BackendPort, BackendProfile, ControlPlanePort, EntitlementPort, EntitlementStatus,
    MachineAccessCheck, MachineAccessDecision, MachineId, PortError, PortErrorKind, PortResult,
    SessionId, StreamsSyncToken, WorkspaceId,
};

pub struct HttpControlPlaneClient {
    server_origin: String,
}

impl HttpControlPlaneClient {
    pub fn new(server_origin: impl Into<String>) -> Self {
        Self {
            server_origin: server_origin.into(),
        }
    }

    pub fn server_origin(&self) -> &str {
        &self.server_origin
    }
}

impl ControlPlanePort for HttpControlPlaneClient {
    fn verify_machine_access(
        &self,
        _check: &MachineAccessCheck,
    ) -> PortResult<MachineAccessDecision> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "control-plane HTTP client not yet wired",
        ))
    }

    fn register_machine(
        &self,
        _workspace_id: &WorkspaceId,
        _machine_id: &MachineId,
    ) -> PortResult<()> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "control-plane machine registration not yet wired",
        ))
    }

    fn mint_streams_sync_token(&self, _workspace_id: &WorkspaceId) -> PortResult<StreamsSyncToken> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "control-plane streams token issuer not yet wired",
        ))
    }

    fn verify_session_history_read(
        &self,
        _workspace_id: &WorkspaceId,
        _machine_id: &MachineId,
        _session_id: &SessionId,
        _request_token: &str,
    ) -> PortResult<bool> {
        Err(PortError::new(
            PortErrorKind::Unavailable,
            "control-plane history read verifier not yet wired",
        ))
    }
}

pub struct ConnectedBackend {
    profile: BackendProfile,
    control_plane: HttpControlPlaneClient,
}

impl ConnectedBackend {
    pub fn new(profile: BackendProfile) -> Self {
        let control_plane = HttpControlPlaneClient::new(profile.discovery.control_api_url.clone());
        Self {
            profile,
            control_plane,
        }
    }
}

impl EntitlementPort for ConnectedBackend {
    fn workspace_entitlement(&self, _workspace_id: &WorkspaceId) -> PortResult<EntitlementStatus> {
        Ok(EntitlementStatus::Active)
    }
}

impl BackendPort for ConnectedBackend {
    fn profile(&self) -> &BackendProfile {
        &self.profile
    }

    fn control_plane(&self) -> &dyn ControlPlanePort {
        &self.control_plane
    }

    fn entitlement(&self) -> Option<&dyn EntitlementPort> {
        Some(self)
    }
}
