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
fn reacquiring_existing_worktree_preserves_uncommitted_files_and_refuses_foreign_dir_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let repo_a = temp.path().join("repo-a");
    init_git_repo(&repo_a);

    let wt_root = temp.path().join("worktrees");
    let mgr = GitWorktreeManager::new(&wt_root);
    let pid = LocalProjectId("proj_1".to_string());
    let sid = SessionId("00000000-0000-4000-8000-000000000001".to_string());

    let lease1 = mgr.acquire_worktree(&pid, &repo_a, &sid, None).unwrap();
    let dirty_file = lease1.worktree_path.join("uncommitted.txt");
    fs::write(&dirty_file, "user work in progress").unwrap();

    let lease2 = mgr.acquire_worktree(&pid, &repo_a, &sid, None).unwrap();
    assert_eq!(lease2.worktree_path, lease1.worktree_path);
    assert_eq!(
        fs::read_to_string(&dirty_file).unwrap(),
        "user work in progress"
    );

    let sid_conflict = SessionId("00000000-0000-4000-8000-000000000002".to_string());
    let foreign_path = wt_root
        .join("proj_1")
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
