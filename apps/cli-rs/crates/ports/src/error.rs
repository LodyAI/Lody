#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortErrorKind {
    InvalidInput,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    CapabilityUnavailable,
    EntitlementReadOnly,
    Timeout,
    Unavailable,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortError {
    pub kind: PortErrorKind,
    pub message: String,
}

impl PortError {
    pub fn new(kind: PortErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn capability_unavailable(feature: &str) -> Self {
        Self::new(
            PortErrorKind::CapabilityUnavailable,
            format!("capability '{feature}' is not configured on this host or backend profile"),
        )
    }

    pub fn entitlement_read_only(reason: impl Into<String>) -> Self {
        Self::new(PortErrorKind::EntitlementReadOnly, reason)
    }
}

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for PortError {}

pub type PortResult<T> = Result<T, PortError>;
