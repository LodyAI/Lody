use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, InboxCategory, InboxStorePort, MAX_SCHEDULE_PROMPT_BYTES,
    MachineId, MachineIdentityPort, PortErrorKind, ScheduleEditPatch, ScheduleRecord,
    ScheduleStorePort, SessionId, StorageLeaseMode, StorageLeasePort, SubmissionStage, TurnId,
    UserId, WorkspaceId,
};
use lody_sqlite::{
    FileStorageLease, HardwareProbeResult, LocalMachineIdentityStore, MachineIdentityConfig,
    SqliteDataLayout, SqliteScheduleStore, SqliteStore, resolve_linux_machine_id,
};
use std::fs;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

#[test]
fn duplicate_admission_pause_gate_and_ended_claim_reconciliation_persist_across_reopen() {
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

        let ended_orphan = AdmittedTurnInput {
            workspace_id: ws.clone(),
            session_id: sid.clone(),
            turn_id: TurnId("t_ended_orphan".to_string()),
            category: InboxCategory::Human,
            verified_requester: UserId("u_1".to_string()),
            prompt_text: "interrupted".to_string(),
            adapter_id: "codex".to_string(),
            custom_acp: None,
            signed_intent_verified: true,
        };
        assert_eq!(
            store.admit_turn(&ended_orphan).unwrap(),
            AdmissionVerdict::Admitted
        );
        store
            .update_submission_stage(
                &ws,
                &sid,
                &TurnId("t_ended_orphan".to_string()),
                SubmissionStage::Settled,
            )
            .unwrap();
        assert!(
            store
                .is_input_ended(&ws, &sid, &TurnId("t_ended_orphan".to_string()))
                .unwrap()
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

#[test]
fn machine_identity_isolates_custom_data_dir_skips_containers_and_refuses_restore_with_live_host() {
    assert_eq!(
        resolve_linux_machine_id(
            |_| Some("abcdef1234567890".to_string()),
            |marker| marker == "/.dockerenv"
        ),
        None
    );

    let temp = tempfile::tempdir().unwrap();
    let default_data = temp.path().join("default-data");
    let custom_data = temp.path().join("custom-data");
    let anchor_dir = temp.path().join("state-anchor");

    let default_store = LocalMachineIdentityStore::with_probe(
        MachineIdentityConfig {
            data_dir: default_data.clone(),
            is_default_data_dir: true,
            namespace: "lody-oss".to_string(),
            user_identity: "alice".to_string(),
            state_anchor_dir: Some(anchor_dir.clone()),
            platform: "darwin",
        },
        Arc::new(|| HardwareProbeResult::Ok("11111111-2222-3333-4444-555555555555".to_string())),
    );
    assert!(default_store.read_existing_machine_id().is_none());

    let id_initial = default_store.get_or_create_machine_id().unwrap();
    assert!(anchor_dir.join("machine-identity.json").exists());

    let custom_store = LocalMachineIdentityStore::with_probe(
        MachineIdentityConfig {
            data_dir: custom_data,
            is_default_data_dir: false,
            namespace: "lody-oss".to_string(),
            user_identity: "alice".to_string(),
            state_anchor_dir: Some(anchor_dir.clone()),
            platform: "darwin",
        },
        Arc::new(|| HardwareProbeResult::Ok("11111111-2222-3333-4444-555555555555".to_string())),
    );
    let custom_id = custom_store.get_or_create_machine_id().unwrap();
    assert_ne!(custom_id, id_initial);

    fs::remove_dir_all(&default_data).unwrap();
    let recovered = default_store.get_or_create_machine_id().unwrap();
    assert_eq!(recovered, id_initial);

    let live_err = default_store
        .restore_local_machine_id("restored-machine-99", Some(4242))
        .unwrap_err();
    assert_eq!(live_err.kind, PortErrorKind::Conflict);

    fs::write(
        default_data.join("credentials.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "version": 3,
            "token": "tok_secret",
            "user": { "id": "u_1", "email": "alice@example.com" },
            "machine": { "machineId": id_initial.0, "machineName": "Mac" }
        }))
        .unwrap(),
    )
    .unwrap();

    let outcome = default_store
        .restore_local_machine_id("restored-machine-99", None)
        .unwrap();
    assert!(outcome.changed);
    assert!(outcome.credentials_updated);
    assert!(outcome.anchor_updated);
    assert!(outcome.backup_dir.is_some());
    assert_eq!(
        default_store.read_existing_machine_id(),
        Some(MachineId("restored-machine-99".to_string()))
    );
}

#[test]
fn schedule_edit_proposals_enforce_prompt_ceiling_ownership_and_full_prompt_reads() {
    let temp = tempfile::tempdir().unwrap();
    let store = SqliteScheduleStore::open(&temp.path().join("schedules.sqlite")).unwrap();
    let ws = WorkspaceId("ws_sched".to_string());
    let owner = UserId("u_owner".to_string());
    let other = UserId("u_other".to_string());

    let long_prompt = "p".repeat(20_000);
    store
        .upsert_schedule(&ScheduleRecord {
            schedule_id: "sched_1".to_string(),
            workspace_id: ws.clone(),
            session_id: None,
            author_user_id: owner.clone(),
            title: "Nightly audit".to_string(),
            cron_expr: "0 2 * * *".to_string(),
            prompt_text: long_prompt.clone(),
            enabled: true,
            content_revision: 1,
        })
        .unwrap();

    let full = store
        .get_schedule(&ws, "sched_1")
        .unwrap()
        .expect("schedule exists");
    assert_eq!(full.prompt_text.len(), 20_000);

    let noop = store
        .propose_schedule_edit(
            &ws,
            &owner,
            "sched_1",
            "req_noop",
            &ScheduleEditPatch {
                title: Some("Nightly audit".to_string()),
                prompt_text: None,
                cron_expr: None,
            },
        )
        .unwrap_err();
    assert_eq!(noop.kind, PortErrorKind::InvalidInput);

    let too_large = store
        .propose_schedule_edit(
            &ws,
            &owner,
            "sched_1",
            "req_big",
            &ScheduleEditPatch {
                title: None,
                prompt_text: Some("x".repeat(MAX_SCHEDULE_PROMPT_BYTES + 1)),
                cron_expr: None,
            },
        )
        .unwrap_err();
    assert_eq!(too_large.kind, PortErrorKind::InvalidInput);

    let non_owner = store
        .propose_schedule_edit(
            &ws,
            &other,
            "sched_1",
            "req_foreign",
            &ScheduleEditPatch {
                title: Some("Hijack".to_string()),
                prompt_text: None,
                cron_expr: None,
            },
        )
        .unwrap_err();
    assert_eq!(non_owner.kind, PortErrorKind::Forbidden);

    let p1 = store
        .propose_schedule_edit(
            &ws,
            &owner,
            "sched_1",
            "req_ok",
            &ScheduleEditPatch {
                title: Some("Updated nightly audit".to_string()),
                prompt_text: None,
                cron_expr: None,
            },
        )
        .unwrap();
    assert_eq!(p1.base_revision, Some(1));
}
