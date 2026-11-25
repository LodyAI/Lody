use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, InboxCategory, InboxStorePort, PortErrorKind, SessionId,
    StorageLeaseMode, StorageLeasePort, TurnId, UserId, WorkspaceId,
};
use lody_sqlite::{FileStorageLease, SqliteDataLayout, SqliteStore};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

#[test]
fn duplicate_admission_pause_gate_and_frozen_turn_config_persist_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let ws = WorkspaceId("ws_1".to_string());
    let sid = SessionId("00000000-0000-4000-8000-000000000010".to_string());

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
fn storage_lease_prevents_concurrent_owners_and_signals_storage_only_to_yield() {
    let dir = tempfile::tempdir().unwrap();
    let locks_dir = dir.path().join("locks");

    let storage_only = FileStorageLease::acquire(
        &locks_dir,
        StorageLeaseMode::StorageOnly,
        Duration::from_secs(1),
    )
    .expect("acquire storage-only lease");
    assert!(!storage_only.yield_requested());

    let locks_for_online = locks_dir.clone();
    let entered = Arc::new(Barrier::new(2));
    let entered_bg = Arc::clone(&entered);

    let online_join = thread::spawn(move || {
        entered_bg.wait();
        FileStorageLease::acquire(
            &locks_for_online,
            StorageLeaseMode::OnlineHost,
            Duration::from_secs(5),
        )
    });

    entered.wait();
    while !storage_only.yield_requested() {
        thread::yield_now();
    }
    assert!(storage_only.yield_requested());
    drop(storage_only);

    let online_lease = online_join
        .join()
        .expect("online thread")
        .expect("online host lease acquired after storage-only yield");
    assert_eq!(online_lease.mode(), StorageLeaseMode::OnlineHost);

    let dup_online = FileStorageLease::acquire(
        &locks_dir,
        StorageLeaseMode::OnlineHost,
        Duration::from_millis(50),
    );
    assert_eq!(
        dup_online.err().map(|e| e.kind),
        Some(PortErrorKind::Conflict)
    );

    let blocked_oneshot = FileStorageLease::acquire(
        &locks_dir,
        StorageLeaseMode::StorageOnly,
        Duration::from_millis(50),
    );
    assert_eq!(
        blocked_oneshot.err().map(|e| e.kind),
        Some(PortErrorKind::Conflict)
    );

    drop(online_lease);

    let after_release = FileStorageLease::acquire(
        &locks_dir,
        StorageLeaseMode::StorageOnly,
        Duration::from_secs(1),
    );
    assert!(after_release.is_ok());
}
