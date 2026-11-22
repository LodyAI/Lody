use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, InboxCategory, InboxStorePort, SessionId, TurnId, UserId,
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

    let second = reopened
        .claim_next_runnable(&ws, &sid)
        .unwrap()
        .expect("automation runs after human");
    assert_eq!(second.turn_id.0, "t_auto");
    assert!(reopened.claim_next_runnable(&ws, &sid).unwrap().is_none());
}
