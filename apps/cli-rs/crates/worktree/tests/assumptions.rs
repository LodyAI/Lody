use lody_ports::{LocalProjectId, PortErrorKind, SessionId, WorkspaceId, WorktreePort};
use lody_worktree::GitWorktreeManager;
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
fn reacquiring_existing_worktree_preserves_uncommitted_files_and_refuses_foreign_dir_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let repo_a = temp.path().join("repo-a");
    init_git_repo(&repo_a);

    let wt_root = temp.path().join("worktrees");
    let mgr = GitWorktreeManager::new(&wt_root);
    let ws_a = WorkspaceId("ws_a".to_string());
    let ws_b = WorkspaceId("ws_b".to_string());
    let pid = LocalProjectId("proj_1".to_string());
    let sid = SessionId("sess-1".to_string());

    let lease_a1 = mgr
        .acquire_worktree(&ws_a, &pid, &repo_a, &sid, None)
        .unwrap();
    let dirty_file = lease_a1.worktree_path.join("uncommitted.txt");
    fs::write(&dirty_file, "user work in progress").unwrap();

    let lease_a2 = mgr
        .acquire_worktree(&ws_a, &pid, &repo_a, &sid, None)
        .unwrap();
    assert_eq!(lease_a2.worktree_path, lease_a1.worktree_path);
    assert_eq!(
        fs::read_to_string(&dirty_file).unwrap(),
        "user work in progress"
    );

    let lease_b = mgr
        .acquire_worktree(&ws_b, &pid, &repo_a, &sid, None)
        .unwrap();
    assert_ne!(lease_b.worktree_path, lease_a1.worktree_path);
    mgr.release_worktree(&lease_b).unwrap();
    assert_eq!(
        fs::read_to_string(&dirty_file).unwrap(),
        "user work in progress"
    );

    let sid_conflict = SessionId("sess-foreign".to_string());
    let foreign_path = wt_root.join("ws_a").join("proj_1").join("sess-foreign");
    fs::create_dir_all(&foreign_path).unwrap();
    let precious = foreign_path.join("precious.txt");
    fs::write(&precious, "never delete").unwrap();

    let err = mgr
        .acquire_worktree(&ws_a, &pid, &repo_a, &sid_conflict, None)
        .unwrap_err();
    assert_eq!(err.kind, PortErrorKind::Conflict);
    assert_eq!(fs::read_to_string(&precious).unwrap(), "never delete");
}
