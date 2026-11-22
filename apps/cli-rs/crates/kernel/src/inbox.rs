#![forbid(unsafe_code)]

use crate::types::{
    DelegatedReceipt, FrozenTurnInvocation, MAX_BATCHED_RECEIPTS_PER_WAKE, SubmissionFence,
    TurnSourceKind,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxEntry {
    pub invocation: FrozenTurnInvocation,
    pub fence: SubmissionFence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxAdmitOutcome {
    Admitted,
    DuplicateIgnored,
    RejectedRetiredId,
    RejectedUnsignedEncryptedInput,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxState {
    pub paused: bool,
    pub sealed_for_identity_recovery: bool,
    pub next_batch_seq: u64,
    pub known_turn_ids: BTreeSet<String>,
    pub retired_turn_ids: BTreeSet<String>,
    pub seen_receipt_keys: BTreeSet<String>,
    pub entries: VecDeque<InboxEntry>,
    pub pending_receipts: VecDeque<DelegatedReceipt>,
}

impl InboxState {
    pub fn admit(
        &mut self,
        invocation: FrozenTurnInvocation,
        workspace_encrypted: bool,
    ) -> InboxAdmitOutcome {
        if workspace_encrypted && !invocation.signed_intent_verified {
            return InboxAdmitOutcome::RejectedUnsignedEncryptedInput;
        }
        if self.retired_turn_ids.contains(&invocation.turn_id) {
            return InboxAdmitOutcome::RejectedRetiredId;
        }
        if !self.known_turn_ids.insert(invocation.turn_id.clone()) {
            return InboxAdmitOutcome::DuplicateIgnored;
        }
        if invocation.source.clears_inbox_pause() {
            self.paused = false;
        }
        self.entries.push_back(InboxEntry {
            invocation,
            fence: SubmissionFence::Prepared,
        });
        InboxAdmitOutcome::Admitted
    }

    pub fn push_receipt(&mut self, requester_session_id: &str, receipt: DelegatedReceipt) -> bool {
        let dedup_key = format!("{requester_session_id}:{}", receipt.operation_id);
        if !self.seen_receipt_keys.insert(dedup_key) {
            return false;
        }
        self.pending_receipts.push_back(receipt);
        true
    }

    pub fn has_runnable_human_entry(&self) -> bool {
        self.entries.iter().any(|entry| {
            entry.fence == SubmissionFence::Prepared && entry.invocation.source.is_human_priority()
        })
    }

    pub fn admit_and_claim_immediately(&mut self, invocation: FrozenTurnInvocation) {
        self.known_turn_ids.insert(invocation.turn_id.clone());
        if invocation.source.clears_inbox_pause() {
            self.paused = false;
        }
        self.entries.push_front(InboxEntry {
            invocation,
            fence: SubmissionFence::Submitting,
        });
    }

    pub fn claim_next_for_execution(
        &mut self,
        default_requester_user_id: &str,
        default_adapter_id: &str,
        default_mcp_digest: &str,
        workspace_encrypted: bool,
    ) -> Option<FrozenTurnInvocation> {
        if self.sealed_for_identity_recovery || self.paused {
            return None;
        }

        if let Some(idx) = self.entries.iter().position(|e| {
            e.fence == SubmissionFence::Prepared && e.invocation.source.is_human_priority()
        }) {
            self.entries[idx].fence = SubmissionFence::Submitting;
            return Some(self.entries[idx].invocation.clone());
        }

        if !self.pending_receipts.is_empty() {
            let take_count = self
                .pending_receipts
                .len()
                .min(MAX_BATCHED_RECEIPTS_PER_WAKE);
            let mut batch_lines = Vec::with_capacity(take_count);
            for _ in 0..take_count {
                if let Some(r) = self.pending_receipts.pop_front() {
                    batch_lines.push(format!(
                        "[operation={} session={} ok={}] {}",
                        r.operation_id, r.child_session_id, r.succeeded, r.summary_preview
                    ));
                }
            }
            self.next_batch_seq += 1;
            let turn_id = format!("inbox-receipt-batch-{}", self.next_batch_seq);
            self.known_turn_ids.insert(turn_id.clone());
            let invocation = FrozenTurnInvocation {
                turn_id,
                requester_user_id: default_requester_user_id.to_string(),
                prompt_text: batch_lines.join("\n"),
                source: TurnSourceKind::DelegatedReceiptBatch,
                adapter_id: default_adapter_id.to_string(),
                mcp_selection_digest: default_mcp_digest.to_string(),
                signed_intent_verified: !workspace_encrypted
                    || !default_requester_user_id.is_empty(),
            };
            self.entries.push_back(InboxEntry {
                invocation: invocation.clone(),
                fence: SubmissionFence::Submitting,
            });
            return Some(invocation);
        }

        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| e.fence == SubmissionFence::Prepared)
        {
            self.entries[idx].fence = SubmissionFence::Submitting;
            return Some(self.entries[idx].invocation.clone());
        }

        None
    }

    pub fn mark_submitted(&mut self, turn_id: &str) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.invocation.turn_id == turn_id)
        {
            entry.fence = SubmissionFence::Submitted;
        }
    }

    pub fn settle_and_retire(&mut self, turn_id: &str) {
        self.retired_turn_ids.insert(turn_id.to_string());
        self.entries.retain(|e| e.invocation.turn_id != turn_id);
    }

    pub fn mark_uncertain_and_retire(&mut self, turn_id: &str) {
        self.retired_turn_ids.insert(turn_id.to_string());
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|e| e.invocation.turn_id == turn_id)
        {
            entry.fence = SubmissionFence::Unknown;
        }
        self.entries.retain(|e| e.invocation.turn_id != turn_id);
    }

    pub fn withdraw_if_prepared(&mut self, turn_id: &str) -> bool {
        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| e.invocation.turn_id == turn_id && e.fence == SubmissionFence::Prepared)
        {
            self.entries.remove(idx);
            self.retired_turn_ids.insert(turn_id.to_string());
            return true;
        }
        false
    }

    pub fn recover_after_crash(&mut self) -> Vec<String> {
        let mut retired_uncertain = Vec::new();
        for entry in &mut self.entries {
            if entry.fence.crossed_transport_fence() {
                entry.fence = SubmissionFence::Unknown;
                self.retired_turn_ids
                    .insert(entry.invocation.turn_id.clone());
                retired_uncertain.push(entry.invocation.turn_id.clone());
            }
        }
        self.entries
            .retain(|e| e.fence == SubmissionFence::Prepared);
        retired_uncertain
    }
}
