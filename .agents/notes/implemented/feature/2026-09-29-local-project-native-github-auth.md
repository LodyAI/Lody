# Native GitHub authentication for local projects

Status: implemented
Translation: current

[中文](2026-09-29-local-project-native-github-auth.zh.md)

## Abstract

Local projects were enrolled in Lody's command credential broker even when users
expected their existing Git and GitHub login to apply. Local directories and their
worktrees now skip managed credential preparation, including when a GitHub remote
is known. Refresh only rotates already enrolled sessions, so another managed
session in the same workspace cannot enroll a local session later. Managed GitHub
projects retain the existing policy; already running agent processes need to be
recreated to receive the new launch environment.

## Decision and evidence

This narrows the scope of [per-command GitHub credentials](../architecture/2026-09-26-github-command-credentials.md);
it does not change their target-repository selection. `project.kind` is the source
of truth, rather than the presence of GitHub metadata or `useWorktree`. An early
return in `SessionManager.prepareGitHubRepoSessionConfig` covers cold and
speculative startup. The existing local host-worktree path already skips broker
auth. `GitCredentialBroker.refreshSessionContext` only rotates registered contexts.
This preserves native token variables, helper configuration, SSH and shell setup,
rather than routing local commands through managed preference/fallback checks.

The existing session-manager suite now covers both local project modes with GitHub
metadata, native environment preservation and a requester change while another
managed session exists. Its managed-context test verifies token rotation using a
real broker. Test execution is currently blocked by missing checkout dependencies
(`vitest` is unavailable); no live GitHub/keychain validation is claimed.
See the [updated draft Spec](../../../../specs/github-command-credentials.md).

PR: [#1117](https://github.com/LodyAI/Lody/pull/1117).
