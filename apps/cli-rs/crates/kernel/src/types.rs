#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

pub const MAX_CHILD_DELEGATION_DEPTH: u8 = 1;
pub const MAX_BATCHED_RECEIPTS_PER_WAKE: usize = 64;
pub const MAX_GOAL_CONTINUATION_TURNS: u32 = 32;
pub const MAX_STALE_ACP_RETRIES_PER_TURN: u8 = 1;
pub const LATE_STREAM_ACTIVITY_TTL_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Generation(pub u64);

impl Generation {
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSourceKind {
    Human,
    AgentDelegationChat,
    DelegatedReceiptBatch,
    Schedule,
    HostAutomation,
}

impl TurnSourceKind {
    pub fn clears_inbox_pause(self) -> bool {
        matches!(self, Self::Human | Self::AgentDelegationChat)
    }

    pub fn is_human_priority(self) -> bool {
        matches!(self, Self::Human | Self::AgentDelegationChat)
    }

    pub fn allows_stale_acp_pre_event_retry(self) -> bool {
        !matches!(self, Self::DelegatedReceiptBatch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionFence {
    Prepared,
    Submitting,
    Submitted,
    Unknown,
    Settled,
    Withdrawn,
}

impl SubmissionFence {
    pub fn crossed_transport_fence(self) -> bool {
        matches!(self, Self::Submitting | Self::Submitted | Self::Unknown)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteerOutcome {
    Applied,
    NotApplied,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSessionActivity {
    Unsupported,
    Idle,
    Running,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresencePublishReason {
    TurnStarted,
    StaleAcpRecovery,
    LateStreamActivity,
    NativeWorkRunning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    ContextOverflow,
    UsageLimit,
    Cancelled,
    PermissionDenied,
    AgentCrash,
    SilentNoOutput,
    ModelError,
    Unknown,
}

pub fn classify_turn_failure(
    reason_code: Option<&str>,
    message: Option<&str>,
) -> FailureClassification {
    if let Some(code) = reason_code.map(str::trim).filter(|c| !c.is_empty()) {
        match code {
            "context_overflow" | "context_length_exceeded" | "prompt_too_long" => {
                return FailureClassification::ContextOverflow;
            }
            "usage_limit" | "rate_limit" | "quota_exceeded" | "insufficient_quota" => {
                return FailureClassification::UsageLimit;
            }
            "cancelled" | "canceled" | "user_cancelled" => {
                return FailureClassification::Cancelled;
            }
            "permission_denied" | "unauthorized" | "forbidden" => {
                return FailureClassification::PermissionDenied;
            }
            "agent_crash" | "agent_disconnected" | "process_exited" => {
                return FailureClassification::AgentCrash;
            }
            "silent_no_output" | "agent_no_output" => {
                return FailureClassification::SilentNoOutput;
            }
            other if other != "model_error" && !other.starts_with("acp_") => {
                return FailureClassification::Unknown;
            }
            _ => {}
        }
    }

    let lower = message.unwrap_or("").to_ascii_lowercase();
    if lower.contains("context length")
        || lower.contains("context window")
        || lower.contains("prompt is too long")
        || lower.contains("maximum context")
    {
        return FailureClassification::ContextOverflow;
    }
    if lower.contains("rate limit")
        || lower.contains("usage limit")
        || lower.contains("quota exceeded")
        || lower.contains("too many requests")
    {
        return FailureClassification::UsageLimit;
    }
    if lower.contains("permission denied") || lower.contains("not authorized") {
        return FailureClassification::PermissionDenied;
    }
    if reason_code.is_some_and(|c| !c.trim().is_empty()) {
        return FailureClassification::ModelError;
    }
    FailureClassification::Unknown
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum TurnTerminalReason {
    Completed,
    Canceled,
    AgentFailed { code: String },
    SilentNoOutput,
    StartupInterruptedUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrozenTurnInvocation {
    pub turn_id: String,
    pub requester_user_id: String,
    pub prompt_text: String,
    pub source: TurnSourceKind,
    pub adapter_id: String,
    pub mcp_selection_digest: String,
    pub signed_intent_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegatedReceipt {
    pub operation_id: String,
    pub child_session_id: String,
    pub summary_preview: String,
    pub succeeded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarmAgentHandle {
    pub agent_instance_id: String,
    pub adapter_id: String,
    pub mcp_selection_digest: String,
    pub owner_user_id: String,
    pub advertises_session_activity: bool,
}

impl WarmAgentHandle {
    pub fn compatible_with(&self, invocation: &FrozenTurnInvocation) -> bool {
        self.adapter_id == invocation.adapter_id
            && self.mcp_selection_digest == invocation.mcp_selection_digest
            && self.owner_user_id == invocation.requester_user_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetainedTurn {
    pub invocation: FrozenTurnInvocation,
    pub generation: Generation,
    pub late_activity_until_ms: Option<u64>,
}
