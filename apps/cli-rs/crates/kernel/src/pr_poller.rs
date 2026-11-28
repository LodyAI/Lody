#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

pub const PR_POLLER_DEFAULT_CAPACITY: f64 = 30.0;
pub const PR_POLLER_DEFAULT_REFILL_PER_SEC: f64 = 0.5;
pub const PR_POLLER_BASE_COOLDOWN_MS: i64 = 15_000;
pub const PR_POLLER_MAX_COOLDOWN_MS: i64 = 900_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenBucketState {
    pub tokens: f64,
    pub updated_at_ms: i64,
    pub frozen_until_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TokenBucketConfig {
    pub capacity: f64,
    pub refill_per_sec: f64,
}

impl Default for TokenBucketConfig {
    fn default() -> Self {
        Self {
            capacity: PR_POLLER_DEFAULT_CAPACITY,
            refill_per_sec: PR_POLLER_DEFAULT_REFILL_PER_SEC,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TokenConsumeOutcome {
    Granted {
        next_state: TokenBucketState,
    },
    Throttled {
        next_state: TokenBucketState,
        retry_at_ms: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoCooldownState {
    pub consecutive_failures: u32,
    pub next_retry_at_ms: i64,
    pub last_error_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PollTargetCandidate {
    pub target_key: String,
    pub repo_lane: String,
    pub last_success_at_ms: Option<i64>,
    pub last_attempt_at_ms: Option<i64>,
    pub interval_ms: i64,
    pub attempt_floor_ms: i64,
    pub repo_cooldown_until_ms: Option<i64>,
}

pub fn try_consume_scope_token(
    prior: Option<&TokenBucketState>,
    cfg: TokenBucketConfig,
    cost: f64,
    now_ms: i64,
) -> TokenConsumeOutcome {
    let base = match prior {
        Some(existing) => {
            let elapsed_sec = ((now_ms.saturating_sub(existing.updated_at_ms)) as f64) / 1000.0;
            let refilled = (existing.tokens + elapsed_sec * cfg.refill_per_sec).min(cfg.capacity);
            let frozen_until_ms = existing.frozen_until_ms.filter(|until| *until > now_ms);
            TokenBucketState {
                tokens: refilled,
                updated_at_ms: now_ms,
                frozen_until_ms,
            }
        }
        None => TokenBucketState {
            tokens: cfg.capacity,
            updated_at_ms: now_ms,
            frozen_until_ms: None,
        },
    };

    if let Some(frozen_until) = base.frozen_until_ms {
        return TokenConsumeOutcome::Throttled {
            next_state: base,
            retry_at_ms: frozen_until,
        };
    }

    let needed = cost.max(0.0);
    if base.tokens >= needed {
        TokenConsumeOutcome::Granted {
            next_state: TokenBucketState {
                tokens: base.tokens - needed,
                updated_at_ms: now_ms,
                frozen_until_ms: None,
            },
        }
    } else {
        let deficit = needed - base.tokens;
        let wait_ms = if cfg.refill_per_sec > 0.0 {
            ((deficit / cfg.refill_per_sec) * 1000.0).ceil() as i64
        } else {
            60_000
        };
        TokenConsumeOutcome::Throttled {
            next_state: base,
            retry_at_ms: now_ms.saturating_add(wait_ms.max(1_000)),
        }
    }
}

pub fn record_repo_failure(
    prior: Option<&RepoCooldownState>,
    error_kind: &str,
    now_ms: i64,
    explicit_retry_at_ms: Option<i64>,
) -> RepoCooldownState {
    let failures = prior
        .map(|p| p.consecutive_failures.saturating_add(1))
        .unwrap_or(1);
    let shift = failures.saturating_sub(1).min(16);
    let computed_backoff = PR_POLLER_BASE_COOLDOWN_MS
        .saturating_mul(1i64 << shift)
        .min(PR_POLLER_MAX_COOLDOWN_MS);
    let next_retry_at_ms = explicit_retry_at_ms
        .filter(|at| *at > now_ms)
        .unwrap_or_else(|| now_ms.saturating_add(computed_backoff));
    RepoCooldownState {
        consecutive_failures: failures,
        next_retry_at_ms,
        last_error_kind: error_kind.to_string(),
    }
}

pub fn target_due_at_ms(target: &PollTargetCandidate) -> i64 {
    let by_success = target
        .last_success_at_ms
        .map(|t| t.saturating_add(target.interval_ms))
        .unwrap_or(0);
    let by_attempt = target
        .last_attempt_at_ms
        .map(|t| t.saturating_add(target.attempt_floor_ms))
        .unwrap_or(0);
    let by_cooldown = target.repo_cooldown_until_ms.unwrap_or(0);
    by_success.max(by_attempt).max(by_cooldown)
}

pub fn select_due_targets_fairly(
    candidates: &[PollTargetCandidate],
    now_ms: i64,
    max_batch: usize,
) -> Vec<String> {
    if max_batch == 0 {
        return Vec::new();
    }
    let mut by_lane: std::collections::BTreeMap<&str, Vec<(i64, &str)>> =
        std::collections::BTreeMap::new();
    for candidate in candidates {
        let due = target_due_at_ms(candidate);
        if due <= now_ms {
            by_lane
                .entry(candidate.repo_lane.as_str())
                .or_default()
                .push((due, candidate.target_key.as_str()));
        }
    }
    for queue in by_lane.values_mut() {
        queue.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    }
    let mut selected = Vec::new();
    let mut cursor_per_lane: std::collections::BTreeMap<&str, usize> =
        by_lane.keys().map(|lane| (*lane, 0usize)).collect();
    while selected.len() < max_batch {
        let mut progressed = false;
        for (lane, queue) in &by_lane {
            if selected.len() >= max_batch {
                break;
            }
            let idx = cursor_per_lane.get_mut(lane).expect("lane cursor");
            if *idx < queue.len() {
                selected.push(queue[*idx].1.to_string());
                *idx += 1;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    selected
}
