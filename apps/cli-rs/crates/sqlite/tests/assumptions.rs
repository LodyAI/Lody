use lody_ports::{
    AdmissionVerdict, AdmittedTurnInput, InboxCategory, InboxStorePort, MachineId,
    MachineIdentityPort, PortErrorKind, ScheduleCursorRecord, ScheduleLedgerPort,
    ScheduleLedgerRunRecord, ScheduleRunState, SessionId, StorageLeaseMode, StorageLeasePort,
    SubmissionStage, TurnId, UserId, WorkspaceId,
};
use lody_sqlite::{
    FileStorageLease, HardwareProbeResult, LocalMachineIdentityStore, MachineIdentityConfig,
    SqliteDataLayout, SqliteScheduleLedgerStore, SqliteStore, resolve_linux_machine_id,
};
use rusqlite::Connection;
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
            signature_hex: None,
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
            signature_hex: None,
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
            signature_hex: None,
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
fn schedule_ledger_matches_node_schema_rejects_future_versions_and_tracks_once_message_consumption()
{
    let temp = tempfile::tempdir().unwrap();

    let future_db = temp.path().join("future-schedules.sqlite");
    {
        let conn = Connection::open(&future_db).unwrap();
        conn.execute_batch("PRAGMA user_version = 2;").unwrap();
    }
    assert_eq!(
        SqliteScheduleLedgerStore::open(&future_db)
            .err()
            .map(|e| e.kind),
        Some(PortErrorKind::Conflict)
    );

    let foreign_db = temp.path().join("foreign-schedules.sqlite");
    {
        let conn = Connection::open(&foreign_db).unwrap();
        conn.execute_batch("CREATE TABLE schedules (schedule_id TEXT PRIMARY KEY);")
            .unwrap();
    }
    assert_eq!(
        SqliteScheduleLedgerStore::open(&foreign_db)
            .err()
            .map(|e| e.kind),
        Some(PortErrorKind::Conflict)
    );

    let shared_db = temp.path().join("schedules.sqlite");
    {
        let conn = Connection::open(&shared_db).unwrap();
        conn.execute_batch(
            "CREATE TABLE schedule_cursors (
               workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL, activation_id TEXT NOT NULL,
               fingerprint TEXT NOT NULL, last_slot INTEGER, next_slot INTEGER, updated_at INTEGER NOT NULL,
               PRIMARY KEY (workspace_id, schedule_id, activation_id)
             );
             CREATE TABLE schedule_runs (
               run_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
               state TEXT NOT NULL, planned_at INTEGER NOT NULL, payload TEXT NOT NULL
             );
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }

    let ledger = SqliteScheduleLedgerStore::open(&shared_db).unwrap();
    let ws = WorkspaceId("ws_sched".to_string());
    let cursor = ScheduleCursorRecord {
        workspace_id: ws.clone(),
        schedule_id: "sched_once".to_string(),
        activation_id: "act_1".to_string(),
        fingerprint: "fp_v1".to_string(),
        last_slot: Some(1_000),
        next_slot: None,
        updated_at: 1_000,
    };
    let run = ScheduleLedgerRunRecord {
        run_key: "sched_once:act_1:1000".to_string(),
        workspace_id: ws.clone(),
        schedule_id: "sched_once".to_string(),
        state: ScheduleRunState::Pending,
        planned_at: 1_000,
        payload_json:
            r#"{"runKey":"sched_once:act_1:1000","state":"pending","message":{"version":1}}"#
                .to_string(),
    };
    ledger.commit_planned_slot(&cursor, Some(&run)).unwrap();

    let drift = ScheduleCursorRecord {
        fingerprint: "fp_mutated_without_new_activation".to_string(),
        ..cursor.clone()
    };
    assert_eq!(
        ledger.commit_planned_slot(&drift, None).unwrap_err().kind,
        PortErrorKind::Conflict
    );

    assert!(
        !ledger
            .has_consumed_complete_message(&ws, "sched_once")
            .unwrap()
    );
    ledger
        .transition_run(
            &run.run_key,
            &[ScheduleRunState::Pending],
            ScheduleRunState::Dispatched,
            r#"{"runKey":"sched_once:act_1:1000","state":"dispatched","message":{"version":1}}"#,
        )
        .unwrap();
    assert!(
        ledger
            .has_consumed_complete_message(&ws, "sched_once")
            .unwrap()
    );

    {
        let conn = Connection::open(&shared_db).unwrap();
        conn.execute(
            "INSERT INTO schedule_runs (run_key, workspace_id, schedule_id, state, planned_at, payload)
             VALUES (?1, ?2, ?3, 'claimed', 2000, ?4)",
            rusqlite::params![
                "sched_node:act_1:2000",
                &ws.0,
                "sched_node",
                r#"{"runKey":"sched_node:act_1:2000","state":"claimed","sessionId":"s_1","userTurnId":"t_1"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO schedule_runs (run_key, workspace_id, schedule_id, state, planned_at, payload)
             VALUES (?1, ?2, ?3, 'session_prepared', 3000, ?4)",
            rusqlite::params![
                "sched_node:act_1:3000",
                &ws.0,
                "sched_node",
                r#"{"runKey":"sched_node:act_1:3000","state":"session_prepared","sessionId":"s_2","userTurnId":"t_2"}"#
            ],
        )
        .unwrap();
    }
    let cross_engine_unfinished = ledger.unfinished_runs(&ws).unwrap();
    assert!(
        cross_engine_unfinished
            .iter()
            .any(|r| r.run_key == "sched_node:act_1:2000" && r.state == ScheduleRunState::Claimed)
    );
    assert!(cross_engine_unfinished.iter().any(|r| {
        r.run_key == "sched_node:act_1:3000" && r.state == ScheduleRunState::SessionPrepared
    }));
}

#[test]
fn automation_and_pr_poller_stores_match_node_v4_layout_recover_orphan_runs_and_heal_corrupt_poller()
 {
    use lody_ports::{
        AutomationMatchResult, AutomationRegistrationInput, AutomationRunInput,
        AutomationStorePort, AutomationWaitCompletion, AutomationWaitState,
        AutomationWorkspaceScope, PrPollerRepoCooldown, PrPollerScopeBucket, PrPollerStorePort,
    };
    use lody_sqlite::{
        AUTOMATION_SCHEMA_VERSION, SqliteAutomationStore, SqlitePrPollerStore,
        automation_workspace_storage_key, sha256_hex,
    };

    let temp = tempfile::tempdir().unwrap();
    let layout = SqliteDataLayout::with_machine_id(temp.path(), "mach_1");
    let scope = AutomationWorkspaceScope {
        machine_id: MachineId("mach_1".to_string()),
        workspace_id: WorkspaceId("ws_alpha".to_string()),
    };

    let expected_key = sha256_hex(r#"["mach_1","ws_alpha"]"#);
    assert_eq!(
        automation_workspace_storage_key("mach_1", "ws_alpha"),
        expected_key
    );

    let future_scope = AutomationWorkspaceScope {
        machine_id: MachineId("mach_1".to_string()),
        workspace_id: WorkspaceId("ws_future".to_string()),
    };
    let future_path = layout.automation_db_for_workspace("mach_1", "ws_future");
    fs::create_dir_all(future_path.parent().unwrap()).unwrap();
    {
        let conn = Connection::open(&future_path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
    }

    let store = SqliteAutomationStore::new(layout.clone());
    assert_eq!(
        store.next_due_at(&future_scope).unwrap_err().kind,
        PortErrorKind::Conflict
    );

    let sid = SessionId("00000000-0000-4000-8000-000000000099".to_string());
    let uid = UserId("u_owner".to_string());
    let wait = store
        .register_wait(
            &scope,
            &sid,
            &uid,
            &AutomationRegistrationInput {
                program: "async () => false".to_string(),
                reason: Some("wait for CI".to_string()),
                interval_ms: 5_000,
                expires_at: Some(90_000),
            },
            1_000,
        )
        .unwrap();
    assert!(
        layout
            .automation_db_for_workspace("mach_1", "ws_alpha")
            .exists()
    );
    let db_conn =
        Connection::open(layout.automation_db_for_workspace("mach_1", "ws_alpha")).unwrap();
    let v: i32 = db_conn
        .query_row("PRAGMA user_version;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, AUTOMATION_SCHEMA_VERSION);

    assert_eq!(store.due_waits(&scope, 1_000, 10).unwrap().len(), 1);
    let claimed = store.claim_wait(&scope, &wait.id, 1_000).unwrap().unwrap();
    assert_eq!(claimed.state, AutomationWaitState::Checking);
    assert_eq!(claimed.checks, 1);

    let receipt = store
        .finish_wait_matched(
            &scope,
            &AutomationWaitCompletion {
                wait_id: wait.id.clone(),
                reads: vec!["github.pullRequests".to_string()],
                evidence: Vec::new(),
                now_ms: 2_000,
            },
            &AutomationMatchResult {
                resume_text: "CI passed".to_string(),
                payload: Some(serde_json::json!({ "green": true })),
            },
        )
        .unwrap()
        .expect("matched receipt");
    assert_eq!(receipt.session_id.as_ref(), Some(&sid));
    assert_eq!(
        store.actionable_receipts(&scope, 2_000, 10).unwrap().len(),
        1
    );

    let run_wait = store
        .register_run(
            &scope,
            &sid,
            &uid,
            &AutomationRunInput {
                command: "cargo".to_string(),
                args: vec!["test".to_string()],
                cwd: None,
                env: None,
                reason: Some("long suite".to_string()),
            },
            3_000,
        )
        .unwrap();
    let _ = store.claim_wait(&scope, &run_wait.id, 3_050).unwrap();
    assert!(store.claim_run_start(&scope, &run_wait.id, 3_100).unwrap());
    assert!(!store.claim_run_start(&scope, &run_wait.id, 3_200).unwrap());
    store
        .record_run_pid(&scope, &run_wait.id, 7777, 3_150)
        .unwrap();

    let reopened = SqliteAutomationStore::new(layout.clone());
    assert_eq!(reopened.orphan_started_runs(&scope, 9_000).unwrap(), 1);
    let recovered = reopened.get_wait(&scope, &run_wait.id).unwrap().unwrap();
    assert_eq!(recovered.state, AutomationWaitState::Waiting);
    assert_eq!(recovered.next_check_at, 9_000);
    assert_eq!(recovered.run.unwrap().pid, Some(7777));

    let poller_path = layout.pr_poller_db();
    fs::write(&poller_path, b"not a valid sqlite3 header at all!").unwrap();
    let poller = SqlitePrPollerStore::open(&poller_path).expect("corrupt poller heals on open");
    poller
        .write_scope(
            "github:tok_1",
            &PrPollerScopeBucket {
                tokens: 24.5,
                updated_at_ms: 5_000,
                frozen_until_ms: None,
            },
        )
        .unwrap();
    poller
        .write_repo_cooldown(
            "github:tok_1:lodyai/lody",
            &PrPollerRepoCooldown {
                consecutive_failures: 2,
                next_retry_at_ms: 35_000,
                last_error_kind: "rate_limited".to_string(),
            },
        )
        .unwrap();
    poller
        .write_target_last_success("ws_alpha:pr:42", 5_500)
        .unwrap();
    assert_eq!(
        poller.read_target_last_success("ws_alpha:pr:42").unwrap(),
        Some(5_500)
    );
    poller
        .clear_workspace_state(&WorkspaceId("ws_alpha".to_string()))
        .unwrap();
    assert_eq!(
        poller.read_target_last_success("ws_alpha:pr:42").unwrap(),
        None
    );

    let v2_scope = AutomationWorkspaceScope {
        machine_id: MachineId("mach_1".to_string()),
        workspace_id: WorkspaceId("ws_v2_legacy".to_string()),
    };
    let v2_path = layout.automation_db_for_workspace("mach_1", "ws_v2_legacy");
    fs::create_dir_all(v2_path.parent().unwrap()).unwrap();
    {
        let conn = Connection::open(&v2_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
            CREATE TABLE deliveries (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE receipts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE work (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE waits (id TEXT PRIMARY KEY, state TEXT NOT NULL, next_check_at INTEGER NOT NULL, payload TEXT NOT NULL);
            PRAGMA user_version = 2;
            "#,
        )
        .unwrap();
        let legacy_wait = serde_json::json!({
            "id": "w_legacy_due",
            "sessionId": sid.0,
            "workspaceId": "ws_v2_legacy",
            "ownerUserId": uid.0,
            "ownerMachineId": "mach_1",
            "program": "async () => false",
            "intervalMs": 5000,
            "createdAt": 1000,
            "updatedAt": 1000,
            "nextCheckAt": 1500,
            "checks": 0,
            "consecutiveErrors": 0,
            "state": "waiting",
            "reads": ["github.pullRequests"]
        });
        conn.execute(
            "INSERT INTO waits (id, state, next_check_at, payload) VALUES ('w_legacy_due', 'waiting', 1500, ?1)",
            rusqlite::params![legacy_wait.to_string()],
        )
        .unwrap();
        let legacy_receipt = serde_json::json!({
            "id": "rcpt_legacy_1",
            "deliveryId": "del_legacy_1",
            "state": "accepted",
            "rule": { "id": "r_1", "ownerUserId": uid.0 },
            "event": { "id": "ev_1", "type": "wait.matched", "source": "wait" },
            "intent": { "action": { "kind": "session.continue" } },
            "sessionId": sid.0,
            "attempts": 0,
            "retryAt": 1500,
            "createdAt": 1500,
            "updatedAt": 1500
        });
        conn.execute(
            "INSERT INTO receipts (id, delivery_id, state, updated_at, payload) VALUES ('rcpt_legacy_1', 'del_legacy_1', 'accepted', 1500, ?1)",
            rusqlite::params![legacy_receipt.to_string()],
        )
        .unwrap();
    }
    let upgraded_store = SqliteAutomationStore::new(layout.clone());
    let migrated_due = upgraded_store.due_waits(&v2_scope, 2_000, 10).unwrap();
    assert_eq!(migrated_due.len(), 1);
    assert_eq!(migrated_due[0].id, "w_legacy_due");
    assert_eq!(
        upgraded_store
            .actionable_receipts(&v2_scope, 2_000, 10)
            .unwrap()
            .len(),
        1
    );
    let v2_conn = Connection::open(&v2_path).unwrap();
    let migrated_ver: i32 = v2_conn
        .query_row("PRAGMA user_version;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(migrated_ver, AUTOMATION_SCHEMA_VERSION);

    let mid_check_wait = upgraded_store
        .register_wait(
            &v2_scope,
            &sid,
            &uid,
            &AutomationRegistrationInput {
                program: "async () => ({ resumeText: 'ok' })".to_string(),
                reason: Some("mid-check crash test".to_string()),
                interval_ms: 5_000,
                expires_at: None,
            },
            3_000,
        )
        .unwrap();
    let claimed_once = upgraded_store
        .claim_wait(&v2_scope, &mid_check_wait.id, 3_000)
        .unwrap()
        .unwrap();
    assert_eq!(claimed_once.state, AutomationWaitState::Checking);
    assert_eq!(claimed_once.checks, 1);

    let restarted_store = SqliteAutomationStore::new(layout.clone());
    let due_after_crash = restarted_store.due_waits(&v2_scope, 3_500, 10).unwrap();
    assert!(due_after_crash.iter().any(|w| w.id == mid_check_wait.id));
    let reclaimed = restarted_store
        .claim_wait(&v2_scope, &mid_check_wait.id, 3_500)
        .unwrap()
        .expect("interrupted checking wait must be reclaimable after restart");
    assert_eq!(reclaimed.state, AutomationWaitState::Checking);
    assert_eq!(reclaimed.checks, 2);

    let dup_run_input = AutomationRunInput {
        command: "pnpm".to_string(),
        args: vec![
            "test".to_string(),
            "--filter".to_string(),
            "cli".to_string(),
        ],
        cwd: Some("apps/cli".to_string()),
        env: Some(std::collections::BTreeMap::from([(
            "CI".to_string(),
            "1".to_string(),
        )])),
        reason: Some("idempotent retry".to_string()),
    };
    let run_first = restarted_store
        .register_run(&v2_scope, &sid, &uid, &dup_run_input, 4_000)
        .unwrap();
    let run_retry = restarted_store
        .register_run(&v2_scope, &sid, &uid, &dup_run_input, 4_050)
        .unwrap();
    assert_eq!(
        run_first.id, run_retry.id,
        "retrying lody_automation run must reuse unfinished run"
    );
    let _ = restarted_store
        .claim_wait(&v2_scope, &run_first.id, 4_100)
        .unwrap()
        .unwrap();
    assert!(
        restarted_store
            .claim_run_start(&v2_scope, &run_first.id, 4_100)
            .unwrap()
    );
    assert!(
        !restarted_store
            .claim_run_start(&v2_scope, &run_retry.id, 4_150)
            .unwrap()
    );
}
