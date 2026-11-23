use lody_ports::{LocalProjectId, PortErrorKind, SessionId, WorktreePort};
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
