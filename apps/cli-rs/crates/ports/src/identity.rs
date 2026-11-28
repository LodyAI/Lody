#![forbid(unsafe_code)]

use crate::error::{PortError, PortErrorKind, PortResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;

pub const MAX_MACHINE_ID_LENGTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ProfileId(pub String);

impl ProfileId {
    pub fn local_default() -> Self {
        Self("local".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct MachineId(pub String);

pub fn parse_machine_id(raw: &str) -> PortResult<MachineId> {
    let trimmed = raw.trim();
    let valid_chars = trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    if trimmed.is_empty() || trimmed.len() > MAX_MACHINE_ID_LENGTH || !valid_chars {
        return Err(PortError::new(
            PortErrorKind::InvalidInput,
            format!(
                "Invalid machine ID \"{raw}\". Expected 1-{MAX_MACHINE_ID_LENGTH} characters matching [A-Za-z0-9._:-]."
            ),
        ));
    }
    Ok(MachineId(trimmed.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorSyncStatus {
    Unchanged,
    Updated,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentityRestoreOutcome {
    pub changed: bool,
    pub target_machine_id: MachineId,
    pub previous_machine_id: Option<MachineId>,
    pub previous_credential_machine_id: Option<MachineId>,
    pub credentials_updated: bool,
    pub anchor_updated: bool,
    pub backup_dir: Option<PathBuf>,
}

pub trait MachineIdentityPort: Send + Sync {
    fn read_existing_machine_id(&self) -> Option<MachineId>;
    fn get_or_create_machine_id(&self) -> PortResult<MachineId>;
    fn persist_machine_id(
        &self,
        machine_id: &MachineId,
        force_refresh_anchor: bool,
    ) -> PortResult<AnchorSyncStatus>;
    fn restore_local_machine_id(
        &self,
        target: &str,
        active_host_pid: Option<u32>,
    ) -> PortResult<MachineIdentityRestoreOutcome>;
}

pub struct StaticMachineIdentity(pub MachineId);

impl MachineIdentityPort for StaticMachineIdentity {
    fn read_existing_machine_id(&self) -> Option<MachineId> {
        Some(self.0.clone())
    }

    fn get_or_create_machine_id(&self) -> PortResult<MachineId> {
        Ok(self.0.clone())
    }

    fn persist_machine_id(
        &self,
        _machine_id: &MachineId,
        _force_refresh_anchor: bool,
    ) -> PortResult<AnchorSyncStatus> {
        Ok(AnchorSyncStatus::Skipped)
    }

    fn restore_local_machine_id(
        &self,
        target: &str,
        _active_host_pid: Option<u32>,
    ) -> PortResult<MachineIdentityRestoreOutcome> {
        let parsed = parse_machine_id(target)?;
        let changed = parsed != self.0;
        Ok(MachineIdentityRestoreOutcome {
            changed,
            target_machine_id: parsed,
            previous_machine_id: Some(self.0.clone()),
            previous_credential_machine_id: None,
            credentials_updated: false,
            anchor_updated: false,
            backup_dir: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TurnId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct UserId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct LocalProjectId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum WorkspaceSecurityMode {
    Unknown,
    Plaintext,
    Encrypted { genesis_hash: String },
}

impl WorkspaceSecurityMode {
    pub fn allows_plaintext_network_egress(&self) -> bool {
        matches!(self, Self::Plaintext)
    }

    pub fn validate_transition(&self, next: &Self) -> Result<(), &'static str> {
        match (self, next) {
            (Self::Encrypted { .. }, Self::Plaintext | Self::Unknown) => {
                Err("retained encrypted workspace rejects security mode downgrade")
            }
            (Self::Encrypted { genesis_hash: a }, Self::Encrypted { genesis_hash: b })
                if a != b =>
            {
                Err("retained encrypted workspace genesis hash mismatch")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerifiedPrincipal {
    LocalHost {
        caller_pid: Option<u32>,
        account_id: Option<UserId>,
    },
    AgentSession {
        workspace_id: WorkspaceId,
        session_id: SessionId,
        machine_id: MachineId,
        account_id: Option<UserId>,
    },
    ConnectedMember {
        profile_id: ProfileId,
        user_id: UserId,
    },
    EncryptedMember {
        profile_id: ProfileId,
        account_id: UserId,
        execution_user_id: UserId,
        device_pubkey_hex: String,
    },
}

impl VerifiedPrincipal {
    pub fn has_local_host_authority(&self) -> bool {
        matches!(self, Self::LocalHost { .. })
    }

    pub fn is_remote(&self) -> bool {
        matches!(
            self,
            Self::ConnectedMember { .. } | Self::EncryptedMember { .. }
        )
    }

    pub fn effective_user_id(&self) -> Option<&UserId> {
        match self {
            Self::LocalHost { account_id, .. } | Self::AgentSession { account_id, .. } => {
                account_id.as_ref()
            }
            Self::ConnectedMember { user_id, .. } => Some(user_id),
            Self::EncryptedMember {
                execution_user_id, ..
            } => Some(execution_user_id),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformCapability {
    CloudSync,
    CloudAccount,
    MultiWorkspace,
    Billing,
    UsageAnalytics,
    TeamSharing,
    ScmIntegration,
    RemoteMachines,
    Notifications,
    BugReport,
    RemotePreview,
    Telemetry,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitySet {
    capabilities: BTreeSet<PlatformCapability>,
}

impl CapabilitySet {
    pub fn local_only() -> Self {
        Self::default()
    }

    pub fn new(iter: impl IntoIterator<Item = PlatformCapability>) -> Self {
        iter.into_iter().collect()
    }

    pub fn has(&self, capability: PlatformCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn list(&self) -> impl Iterator<Item = PlatformCapability> + '_ {
        self.capabilities.iter().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }
}

impl FromIterator<PlatformCapability> for CapabilitySet {
    fn from_iter<T: IntoIterator<Item = PlatformCapability>>(iter: T) -> Self {
        Self {
            capabilities: iter.into_iter().collect(),
        }
    }
}
