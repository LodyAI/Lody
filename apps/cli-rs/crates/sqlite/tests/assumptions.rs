use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, HistoryBlock, HistoryPort, HistoryTurnRecord,
    InboxCategory, InboxStorePort, PortErrorKind, SessionId, TurnId, TurnTerminalOutcome, UserId,
    WorkspaceId,
};
use lody_sqlite::{SqliteDataLayout, SqliteStore};

#[test]
fn duplicate_admission_pause_gate_and_human_over_automation_priority_persist_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let ws = WorkspaceId("ws_1".to_string());
    let sid = SessionId("s_1".to_string());

    {
        let store = SqliteStore::open(SqliteDataLayout::new(dir.path())).unwrap();
        let auto = AdmittedTurnInput {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            turn_id: TurnId("t_auto".to_string()),
            category: InboxCategory::Automation,
            verified_requester: UserId("u_1".to_string()),
            prompt_text: "auto".to_string(),
            adapter_id: "codex".to_string(),
            custom_acp: None,
            signed_intent_verified: true,
        };
        assert_eq!(store.admit_turn(&auto).unwrap(), AdmissionVerdict::Admitted);
        assert_eq!(
            store.admit_turn(&auto).unwrap(),
            AdmissionVerdict::DuplicateIgnored
        );

        store.set_inbox_paused(&ws, &sid, true).unwrap();
        assert!(store.claim_next_runnable(&ws, &sid).unwrap().is_none());

        let human = AdmittedTurnInput {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            turn_id: TurnId("t_human".to_string()),
            category: InboxCategory::Human,
            verified_requester: UserId("u_1".to_string()),
            prompt_text: "human".to_string(),
            adapter_id: "claude".to_string(),
            custom_acp: None,
            signed_intent_verified: true,
        };
        assert_eq!(
            store.admit_turn(&human).unwrap(),
            AdmissionVerdict::Admitted
        );
    }

    let reopened = SqliteStore::open(SqliteDataLayout::new(dir.path())).unwrap();
    let first = reopened
        .claim_next_runnable(&ws, &sid)
        .unwrap()
        .expect("human unpaused inbox");
    assert_eq!(first.turn_id.0, "t_human");
    assert_eq!(first.adapter_id, "claude");

    let second = reopened
        .claim_next_runnable(&ws, &sid)
        .unwrap()
        .expect("automation runs after human");
    assert_eq!(second.turn_id.0, "t_auto");
    assert_eq!(second.adapter_id, "codex");
    assert!(reopened.claim_next_runnable(&ws, &sid).unwrap().is_none());
}

#[test]
fn identical_session_and_turn_ids_in_distinct_workspaces_never_overwrite_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(SqliteDataLayout::new(dir.path())).unwrap();
    let ws_a = WorkspaceId("ws_a".to_string());
    let ws_b = WorkspaceId("ws_b".to_string());
    let shared_sid = SessionId("shared_session".to_string());
    let shared_tid = TurnId("turn_1".to_string());

    store
        .upsert_turn_record(
            &ws_a,
            &shared_sid,
            &HistoryTurnRecord {
                turn_id: shared_tid.clone(),
                author_user_id: None,
                user_prompt: "prompt A".to_string(),
                assistant_blocks: vec![HistoryBlock::Text {
                    text: "answer A".to_string(),
                }],
                outcome: Some(TurnTerminalOutcome::Finished),
            },
        )
        .unwrap();

    store
        .upsert_turn_record(
            &ws_b,
            &shared_sid,
            &HistoryTurnRecord {
                turn_id: shared_tid,
                author_user_id: None,
                user_prompt: "prompt B".to_string(),
                assistant_blocks: vec![HistoryBlock::Text {
                    text: "answer B".to_string(),
                }],
                outcome: Some(TurnTerminalOutcome::Finished),
            },
        )
        .unwrap();

    let turns_a = store.read_session_turns(&ws_a, &shared_sid).unwrap();
    let turns_b = store.read_session_turns(&ws_b, &shared_sid).unwrap();
    assert_eq!(turns_a[0].user_prompt, "prompt A");
    assert_eq!(turns_b[0].user_prompt, "prompt B");

    let ambig = store
        .resolve_unique_workspace_for_session(&shared_sid)
        .unwrap_err();
    assert_eq!(ambig.kind, PortErrorKind::Conflict);
}
