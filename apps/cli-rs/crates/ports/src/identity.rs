#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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
    pub fn is_remote(&self) -> bool {
        !matches!(self, Self::LocalHost { .. })
    }

    pub fn effective_user_id(&self) -> Option<&UserId> {
        match self {
            Self::LocalHost { account_id, .. } => account_id.as_ref(),
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
