use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectBusinessSummary {
    pub name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnBusinessSummary {
    pub role: String,
    pub status: Option<String>,
    pub finished: Option<bool>,
    pub visible_text: String,
    pub tool_statuses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBusinessSummary {
    pub session_status: Option<String>,
    pub archived: bool,
    pub turns: Vec<TurnBusinessSummary>,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessOutcome {
    pub scenario: String,
    pub projects: Vec<ProjectBusinessSummary>,
    pub sessions: Vec<SessionBusinessSummary>,
}

pub fn assert_business_equivalent(baseline: &BusinessOutcome, candidate: &BusinessOutcome) {
    if baseline != candidate {
        let left = serde_json::to_string_pretty(baseline).unwrap_or_default();
        let right = serde_json::to_string_pretty(candidate).unwrap_or_default();
        panic!(
            "Business behavior mismatch in scenario '{}':\n--- BASELINE ---\n{}\n--- CANDIDATE ---\n{}",
            baseline.scenario, left, right
        );
    }
}

pub fn normalize_history_payload(
    history_json: &Value,
    session_status: Option<String>,
    archived: bool,
    mut changed_files: Vec<String>,
) -> SessionBusinessSummary {
    changed_files.sort();
    changed_files.dedup();

    let entries = history_json
        .get("items")
        .or_else(|| history_json.get("history"))
        .or_else(|| history_json.get("turns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let turns = entries
        .iter()
        .filter_map(normalize_turn_entry)
        .collect::<Vec<_>>();

    SessionBusinessSummary {
        session_status,
        archived,
        turns,
        changed_files,
    }
}

fn normalize_turn_entry(entry: &Value) -> Option<TurnBusinessSummary> {
    let role = entry.get("role").and_then(Value::as_str)?.to_string();
    let status = entry
        .get("status")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let finished = entry.get("finished").and_then(Value::as_bool);

    let mut text_parts = Vec::new();
    let mut tool_statuses = Vec::new();

    if let Some(direct_text) = entry.get("text").and_then(Value::as_str)
        && !direct_text.trim().is_empty()
    {
        text_parts.push(direct_text.trim().to_string());
    }

    if let Some(items) = entry.get("items").and_then(Value::as_array) {
        for item in items {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
            match item_type {
                "text" | "agent_message" | "user_message" => {
                    if let Some(t) = item.get("text").and_then(Value::as_str)
                        && !t.trim().is_empty()
                    {
                        text_parts.push(t.trim().to_string());
                    }
                }
                "tool_call" | "tool" => {
                    if let Some(st) = item.get("status").and_then(Value::as_str) {
                        tool_statuses.push(st.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    Some(TurnBusinessSummary {
        role,
        status,
        finished,
        visible_text: scrub_volatile_directive_paths(&text_parts.join("\n")),
        tool_statuses,
    })
}

fn scrub_volatile_directive_paths(input: &str) -> String {
    let prefix = "[SCRIPTED:HOLD:";
    let Some(start) = input.find(prefix) else {
        return input.to_string();
    };
    let after = &input[start + prefix.len()..];
    let Some(end) = after.find(']') else {
        return input.to_string();
    };
    let mut out = String::with_capacity(input.len());
    out.push_str(&input[..start]);
    out.push_str("[SCRIPTED:HOLD:<BARRIER>]");
    out.push_str(&after[end + 1..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_chunk_boundaries_and_ignores_volatile_ids() {
        let node_payload = json!({
            "sessionId": "uuid-node-111",
            "items": [
                {
                    "id": "turn-a",
                    "role": "user",
                    "status": "handled",
                    "timestamp": "2026-11-22T00:00:01Z",
                    "items": [{ "type": "text", "text": "Fix the bug" }]
                },
                {
                    "id": "assistant:turn-a",
                    "role": "assistant",
                    "finished": true,
                    "endedAt": 1700000002000u64,
                    "items": [
                        { "type": "tool_call", "toolCallId": "tc-random-1", "status": "completed" },
                        { "type": "text", "text": "All fixed." }
                    ]
                }
            ]
        });

        let rust_payload = json!({
            "sessionId": "uuid-rust-999",
            "items": [
                {
                    "id": "turn-b",
                    "role": "user",
                    "status": "handled",
                    "timestamp": "2026-11-22T09:30:00Z",
                    "items": [{ "type": "text", "text": "Fix the bug" }]
                },
                {
                    "id": "assistant:turn-b",
                    "role": "assistant",
                    "finished": true,
                    "endedAt": 1700009999000u64,
                    "items": [
                        { "type": "tool_call", "toolCallId": "tc-random-2", "status": "completed" },
                        { "type": "text", "text": "All fixed." }
                    ]
                }
            ]
        });

        let left = BusinessOutcome {
            scenario: "basic_turn".to_string(),
            projects: vec![ProjectBusinessSummary {
                name: "synthetic-repo".to_string(),
                exists: true,
            }],
            sessions: vec![normalize_history_payload(
                &node_payload,
                Some("idle".to_string()),
                false,
                vec!["src/lib.rs".to_string()],
            )],
        };
        let right = BusinessOutcome {
            scenario: "basic_turn".to_string(),
            projects: vec![ProjectBusinessSummary {
                name: "synthetic-repo".to_string(),
                exists: true,
            }],
            sessions: vec![normalize_history_payload(
                &rust_payload,
                Some("idle".to_string()),
                false,
                vec!["src/lib.rs".to_string()],
            )],
        };

        assert_business_equivalent(&left, &right);
    }
}
