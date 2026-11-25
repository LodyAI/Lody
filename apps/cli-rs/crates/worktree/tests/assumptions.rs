use lody_ports::{
    LocalProjectId, PortErrorKind, SessionId, TurnDiffCompression, TurnDiffEventInput, WorktreePort,
};
use lody_worktree::{
    GitWorktreeManager, ReconstructedSnapshotPair, SqliteTurnDiffStore, TrackedLatestText,
    TurnDiffStoreConfig, scan_directory_parallel,
};
use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

fn init_git_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("README.md"), "init\n").unwrap();
    for args in [
        &["init", "--initial-branch=main"][..],
        &["add", "README.md"][..],
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@lody.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "init",
        ][..],
    ] {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
    }
}

#[test]
fn worktree_uses_repos_layout_retains_dirty_tree_on_release_and_removes_clean_tree() {
    let temp = tempfile::tempdir().unwrap();
    let repo_a = temp.path().join("repo-a");
    init_git_repo(&repo_a);

    let repos_root = temp.path().join("repos");
    let mgr = GitWorktreeManager::new(&repos_root);
    let pid = LocalProjectId("local-project-abc123".to_string());
    let dirty_sid = SessionId("00000000-0000-4000-8000-000000000001".to_string());

    let lease1 = mgr
        .acquire_worktree(&pid, &repo_a, &dirty_sid, None)
        .unwrap();
    assert_eq!(
        lease1.worktree_path,
        repos_root
            .join("local-project-abc123")
            .join("worktrees")
            .join("00000000-0000-4000-8000-000000000001")
    );
    let dirty_file = lease1.worktree_path.join("uncommitted.txt");
    fs::write(&dirty_file, "user work in progress").unwrap();

    let lease2 = mgr
        .acquire_worktree(&pid, &repo_a, &dirty_sid, None)
        .unwrap();
    assert_eq!(lease2.worktree_path, lease1.worktree_path);
    mgr.release_worktree(&lease2).unwrap();
    assert_eq!(
        fs::read_to_string(&dirty_file).unwrap(),
        "user work in progress"
    );

    let clean_sid = SessionId("00000000-0000-4000-8000-000000000003".to_string());
    let clean_lease = mgr
        .acquire_worktree(&pid, &repo_a, &clean_sid, None)
        .unwrap();
    mgr.release_worktree(&clean_lease).unwrap();
    assert!(!clean_lease.worktree_path.exists());

    let sid_conflict = SessionId("00000000-0000-4000-8000-000000000002".to_string());
    let foreign_path = repos_root
        .join("local-project-abc123")
        .join("worktrees")
        .join("00000000-0000-4000-8000-000000000002");
    fs::create_dir_all(&foreign_path).unwrap();
    let precious = foreign_path.join("precious.txt");
    fs::write(&precious, "never delete").unwrap();

    let err = mgr
        .acquire_worktree(&pid, &repo_a, &sid_conflict, None)
        .unwrap_err();
    assert_eq!(err.kind, PortErrorKind::Conflict);
    assert_eq!(fs::read_to_string(&precious).unwrap(), "never delete");
}

#[test]
fn turn_diff_store_preserves_refcounts_monotonic_head_proofs_and_refuses_foreign_sqlite() {
    let temp = tempfile::tempdir().unwrap();

    let foreign_db = temp.path().join("foreign.sqlite3");
    {
        let c = Connection::open(&foreign_db).unwrap();
        c.execute_batch("CREATE TABLE user_secrets(k TEXT PRIMARY KEY, v TEXT); INSERT INTO user_secrets VALUES ('a', 'keep');")
            .unwrap();
    }
    let refuse = SqliteTurnDiffStore::open(TurnDiffStoreConfig::new(&foreign_db));
    assert_eq!(refuse.err().map(|e| e.kind), Some(PortErrorKind::Conflict));
    {
        let c = Connection::open(&foreign_db).unwrap();
        let kept: String = c
            .query_row("SELECT v FROM user_secrets WHERE k = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "keep");
    }

    let db_path = temp.path().join("diff-store.sqlite3");
    let mut cfg = TurnDiffStoreConfig::new(&db_path);
    cfg.compression = TurnDiffCompression::Zstd;
    cfg.max_storage_bytes = 96 * 1024;
    cfg.gc_target_bytes = 64 * 1024;
    let store = SqliteTurnDiffStore::open(cfg).unwrap();

    let proof_older = store.allocate_head_proof().unwrap();
    let proof_newer = store.allocate_head_proof().unwrap();
    assert!(proof_newer > proof_older);

    let big_prefix: String = (0..6000)
        .map(|i| format!("line-{i:05}-shared-fastcdc\n"))
        .collect();
    let v1 = format!("{big_prefix}tail-v1\n");
    let v2 = format!("{big_prefix}tail-v2\n");

    store
        .record_turn(
            "s_1",
            "t_newer",
            Some("0002:t_newer"),
            2_000,
            2_000,
            &[TurnDiffEventInput {
                path: "src/main.rs".to_string(),
                old_text: Some(v1.clone()),
                new_text: Some(v2.clone()),
                new_is_current: true,
                head_proof: Some(proof_newer),
                additions: 1,
                deletions: 1,
            }],
        )
        .unwrap();

    store
        .record_turn(
            "s_1",
            "t_late_older",
            Some("0001:t_late_older"),
            1_000,
            2_100,
            &[TurnDiffEventInput {
                path: "src/main.rs".to_string(),
                old_text: None,
                new_text: Some(v1.clone()),
                new_is_current: true,
                head_proof: Some(proof_older),
                additions: 6001,
                deletions: 0,
            }],
        )
        .unwrap();

    assert_eq!(
        store.get_latest_text("s_1", "src/main.rs", None).unwrap(),
        TrackedLatestText::Tracked {
            text: Some(v2.clone())
        }
    );
    assert_eq!(
        store
            .get_turn_snapshot("s_1", "t_newer", "src/main.rs", 2_200, Some(1024))
            .unwrap(),
        ReconstructedSnapshotPair::TooLarge {
            raw_bytes: v1.len() + v2.len()
        }
    );

    let _ = store.gc(2_500).unwrap();
    let integrity = store.stats().unwrap();
    assert_eq!(integrity.invalid_snapshot_ref_counts, 0);
    assert_eq!(integrity.invalid_chunk_ref_counts, 0);
    assert_eq!(
        store.get_latest_text("s_1", "src/main.rs", None).unwrap(),
        TrackedLatestText::Tracked { text: Some(v2) }
    );
}

#[test]
fn parallel_scanner_enforces_entry_budget_and_prunes_untracked_caches_without_hiding_tracked_files()
{
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("scan-repo");
    init_git_repo(&repo);

    fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
    fs::write(repo.join("node_modules/pkg/index.js"), "untracked cache").unwrap();
    fs::create_dir_all(repo.join("dist")).unwrap();
    fs::write(repo.join("dist/tracked.js"), "tracked artifact").unwrap();
    let add_out = Command::new("git")
        .args(["add", "-f", "dist/tracked.js"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(add_out.status.success());

    for idx in 0..25 {
        fs::write(repo.join(format!("f_{idx:02}.rs")), "fn f() {}").unwrap();
    }

    let capped = scan_directory_parallel(&repo, 10, 100 * 1024).unwrap();
    assert_eq!(capped.entries.len(), 10);
    assert!(capped.truncated);

    let full = scan_directory_parallel(&repo, 1_000, 100 * 1024).unwrap();
    assert!(
        !full
            .entries
            .iter()
            .any(|e| e.relative_path.starts_with("node_modules"))
    );
    assert!(
        full.entries
            .iter()
            .any(|e| e.relative_path == "dist/tracked.js")
    );
}
