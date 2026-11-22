#![forbid(unsafe_code)]

use crate::error::PortResult;
use crate::identity::{
    CapabilitySet, LocalProjectId, MachineId, ProfileId, SessionId, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethodDescriptor {
    OidcDevicePkce {
        client_id: String,
        scopes: Vec<String>,
    },
    BrowserTokenExchange,
    PersonalAccessToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrohRelaySet {
    pub urls: Vec<String>,
    pub bearer_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WellKnownDiscoveryDocument {
    pub schema_version: u32,
    pub instance_id: String,
    pub control_api_url: String,
    pub auth_issuer_url: String,
    pub auth_methods: Vec<AuthMethodDescriptor>,
    pub streams_sync_url: Option<String>,
    pub blob_service_url: Option<String>,
    pub artifact_mirror_url: Option<String>,
    pub preview_tunnel_url: Option<String>,
    pub iroh_relays: Option<IrohRelaySet>,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendNetworkPolicy {
    pub custom_ca_bundle_path: Option<PathBuf>,
    pub https_proxy: Option<String>,
    pub no_proxy: Vec<String>,
    pub connect_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendProfile {
    pub profile_id: ProfileId,
    pub server_origin: String,
    pub discovery: WellKnownDiscoveryDocument,
    pub network: BackendNetworkPolicy,
}

impl BackendProfile {
    pub fn isolated_data_dir(&self, base_data_dir: &Path) -> PathBuf {
        base_data_dir.join("profiles").join(&self.profile_id.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAccessCheck {
    pub workspace_id: WorkspaceId,
    pub requester_user_id: UserId,
    pub machine_id: Option<MachineId>,
    pub local_project_id: Option<LocalProjectId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MachineAccessDecision {
    Allowed,
    Denied { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamsSyncToken {
    pub token: String,
    pub sync_url: String,
    pub expires_at_epoch_ms: u64,
}

pub trait ControlPlanePort: Send + Sync {
    fn verify_machine_access(
        &self,
        check: &MachineAccessCheck,
    ) -> PortResult<MachineAccessDecision>;
    fn register_machine(
        &self,
        workspace_id: &WorkspaceId,
        machine_id: &MachineId,
    ) -> PortResult<()>;
    fn mint_streams_sync_token(&self, workspace_id: &WorkspaceId) -> PortResult<StreamsSyncToken>;
    fn verify_session_history_read(
        &self,
        workspace_id: &WorkspaceId,
        machine_id: &MachineId,
        session_id: &SessionId,
        request_token: &str,
    ) -> PortResult<bool>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobUploadRequest {
    pub workspace_id: WorkspaceId,
    pub sha256_hex: String,
    pub content_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum NegotiatedUploadPlan {
    SingleStreamPut {
        upload_url: String,
        headers: BTreeMap<String, String>,
    },
    PresignedMultipart {
        upload_id: String,
        part_size_bytes: u64,
        part_urls: Vec<String>,
        complete_url: String,
    },
    GatewayStagedChunks {
        stage_url: String,
        chunk_size_bytes: u64,
        commit_url: String,
    },
}

pub trait BlobTransferPort: Send + Sync {
    fn negotiate_upload(&self, req: &BlobUploadRequest) -> PortResult<NegotiatedUploadPlan>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "vendor", rename_all = "snake_case")]
pub enum ScmProviderKind {
    GitHubCloud,
    GitHubEnterprise { base_url: String },
    GitLab { base_url: String },
    Gitea { base_url: String },
    GenericGit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScmRepoCredential {
    pub provider: ScmProviderKind,
    pub token: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestAssociation {
    pub workspace_id: WorkspaceId,
    pub session_id: SessionId,
    pub repo_full_name: String,
    pub pr_number: u64,
    pub pr_url: String,
    pub branch: String,
    pub status: String,
}

pub trait ScmProviderPort: Send + Sync {
    fn provider_kind(&self) -> &ScmProviderKind;
    fn issue_repo_write_token(
        &self,
        workspace_id: &WorkspaceId,
        repo_full_name: &str,
        requester: &UserId,
        machine_id: &MachineId,
    ) -> PortResult<ScmRepoCredential>;
    fn associate_pull_request(&self, association: &PullRequestAssociation) -> PortResult<bool>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

pub trait TunnelProviderPort: Send + Sync {
    fn verify_preview_control(
        &self,
        workspace_id: &WorkspaceId,
        machine_id: &MachineId,
        request_token: &str,
    ) -> PortResult<UserId>;
    fn issue_ice_servers(&self, check: &MachineAccessCheck) -> PortResult<Vec<IceServerConfig>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EntitlementStatus {
    Active,
    GracePeriod { remaining_secs: u64, notice: String },
    ExpiredReadOnly { reason: String },
}

impl EntitlementStatus {
    pub fn allows_remote_collaboration_dispatch(&self) -> bool {
        matches!(self, Self::Active | Self::GracePeriod { .. })
    }

    pub fn allows_local_read_and_export(&self) -> bool {
        true
    }
}

pub trait EntitlementPort: Send + Sync {
    fn workspace_entitlement(&self, workspace_id: &WorkspaceId) -> PortResult<EntitlementStatus>;
}

pub trait E2eeControlPort: Send + Sync {
    fn mint_encrypted_content_token(
        &self,
        workspace_id: &WorkspaceId,
        credential: &str,
    ) -> PortResult<StreamsSyncToken>;
    fn iroh_relays(&self) -> Option<&IrohRelaySet>;
}

pub trait BackendPort: Send + Sync {
    fn profile(&self) -> &BackendProfile;
    fn capabilities(&self) -> &CapabilitySet {
        &self.profile().discovery.capabilities
    }
    fn control_plane(&self) -> &dyn ControlPlanePort;
    fn blob_transfer(&self) -> Option<&dyn BlobTransferPort> {
        None
    }
    fn scm_provider(&self) -> Option<&dyn ScmProviderPort> {
        None
    }
    fn tunnel_provider(&self) -> Option<&dyn TunnelProviderPort> {
        None
    }
    fn entitlement(&self) -> Option<&dyn EntitlementPort> {
        None
    }
    fn e2ee_control(&self) -> Option<&dyn E2eeControlPort> {
        None
    }
}
