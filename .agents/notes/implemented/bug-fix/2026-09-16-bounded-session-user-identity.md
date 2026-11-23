# Bound session user identity lookup

Status: implemented
Translation: current

[中文](2026-09-16-bounded-session-user-identity.zh.md)

## Abstract

Repository turns could remain initializing indefinitely while waiting for a cloud user profile,
even when the machine owner used Electron locally. Owner turns now skip that query; the Session
reads Git configuration in the actual worktree, with neutral LodyAI as fallback. Other requesters
retain their own profile lookup with a 60-second deadline. This bounds profile waiting, not all
startup work; installed-app validation remains pending.

## Decision

Both MessageHandler and SessionManager preparations supply the authenticated machine owner to the
resolver. Compare with the frozen requester, not the Session creator or transport type. The owner
placeholder retains the requester id until existing Session binding reads worktree Git configuration.
Machine authorization and requester-bound GitHub credentials remain separate checks.

Effect limits non-owner queries to 60 seconds. Failed or timed-out requests return a placeholder and
evict only their own cache entry, allowing later retries. Late completion cannot publish a profile or
evict a newer request. CloudPort currently has no cancellation signal for this query, so the wait ends
but the underlying transport request may continue. No message is automatically resent.

This partially replaces the owner cloud-profile fallback in the
[earlier decision](../feature/2026-09-08-machine-owner-git-identity.md).
Only adding a timeout would still unnecessarily delay owner turns. The new intent is in the
[draft Spec](../../../../specs/git-commit-identity.md).

## Validation

The two focused suites passed 20 tests using fake timers: owner bypass, non-owner identity, exact
60-second deadline, retry, late results, and timer cleanup. Existing local build dependencies were
reused. A temporary Vitest alias loaded the current shared auth module directly because the shared
barrel imports an incompatible ACP submodule. Normal test configuration and full CLI typecheck remain
blocked by dependency/submodule mismatches. Formatting and diff whitespace checks passed. No installed
Electron app was rebuilt or replaced.
