#![forbid(unsafe_code)]

use crate::types::{
    FrozenTurnInvocation, Generation, MAX_CHILD_DELEGATION_DEPTH, MAX_GOAL_CONTINUATION_TURNS,
    MAX_STALE_ACP_RETRIES_PER_TURN, TurnSourceKind, WarmAgentHandle,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPermissionRequest {
    pub request_id: String,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BufferedTurnOutput {
    TextChunk {
        text: String,
    },
    ToolStatus {
        tool_call_id: String,
        title: String,
        status: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SteerFlightState {
    None,
    WaitingVerdict { replacement: FrozenTurnInvocation },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningTurnState {
    pub invocation: FrozenTurnInvocation,
    pub agent: WarmAgentHandle,
    pub generation: Generation,
    pub user_turn_durable: bool,
    pub produced_visible_output: bool,
    pub stale_acp_retries_used: u8,
    pub pending_permissions: BTreeMap<String, PendingPermissionRequest>,
    pub buffered_outputs: Vec<BufferedTurnOutput>,
    pub steer_flight: SteerFlightState,
}

impl RunningTurnState {
    pub fn new(
        invocation: FrozenTurnInvocation,
        agent: WarmAgentHandle,
        generation: Generation,
        user_turn_durable: bool,
        stale_acp_retries_used: u8,
    ) -> Self {
        Self {
            invocation,
            agent,
            generation,
            user_turn_durable,
            produced_visible_output: false,
            stale_acp_retries_used,
            pending_permissions: BTreeMap::new(),
            buffered_outputs: Vec::new(),
            steer_flight: SteerFlightState::None,
        }
    }

    pub fn can_retry_stale_acp_before_events(&self) -> bool {
        !self.produced_visible_output
            && self.pending_permissions.is_empty()
            && self.buffered_outputs.is_empty()
            && self.stale_acp_retries_used < MAX_STALE_ACP_RETRIES_PER_TURN
            && self.invocation.source.allows_stale_acp_pre_event_retry()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalControlState {
    pub goal_id: String,
    pub continuation_prompt: String,
    pub requester_user_id: String,
    pub adapter_id: String,
    pub mcp_selection_digest: String,
    pub max_turns: u32,
    pub executed_turns: u32,
    pub satisfied: bool,
}

impl GoalControlState {
    pub fn new(
        goal_id: String,
        continuation_prompt: String,
        requester_user_id: String,
        adapter_id: String,
        mcp_selection_digest: String,
        requested_max_turns: u32,
    ) -> Self {
        Self {
            goal_id,
            continuation_prompt,
            requester_user_id,
            adapter_id,
            mcp_selection_digest,
            max_turns: requested_max_turns.clamp(1, MAX_GOAL_CONTINUATION_TURNS),
            executed_turns: 0,
            satisfied: false,
        }
    }

    pub fn next_continuation_invocation(
        &mut self,
        workspace_encrypted: bool,
    ) -> Option<FrozenTurnInvocation> {
        if self.satisfied || self.executed_turns >= self.max_turns {
            return None;
        }
        self.executed_turns += 1;
        Some(FrozenTurnInvocation {
            turn_id: format!("goal-{}-step-{}", self.goal_id, self.executed_turns),
            requester_user_id: self.requester_user_id.clone(),
            prompt_text: self.continuation_prompt.clone(),
            source: TurnSourceKind::Human,
            adapter_id: self.adapter_id.clone(),
            mcp_selection_digest: self.mcp_selection_digest.clone(),
            signed_intent_verified: !workspace_encrypted || !self.requester_user_id.is_empty(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildRejectReason {
    MaxDepthExceeded,
    DuplicateChildId,
    CollaborationStopped,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildDelegationState {
    pub session_depth: u8,
    pub admitted_child_ids: BTreeSet<String>,
}

impl ChildDelegationState {
    pub fn with_depth(session_depth: u8) -> Self {
        Self {
            session_depth,
            admitted_child_ids: BTreeSet::new(),
        }
    }

    pub fn try_admit_child(&mut self, child_session_id: &str) -> Result<u8, ChildRejectReason> {
        if self.session_depth >= MAX_CHILD_DELEGATION_DEPTH {
            return Err(ChildRejectReason::MaxDepthExceeded);
        }
        if !self.admitted_child_ids.insert(child_session_id.to_string()) {
            return Err(ChildRejectReason::DuplicateChildId);
        }
        Ok(self.session_depth + 1)
    }
}
