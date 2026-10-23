# Preserve native Git identity and signing

Status: implemented
Translation: current

[中文](2026-10-23-native-git-identity.zh.md)

## Abstract

Lody exported a machine-wide identity into owner sessions, overriding repository
identities and conditional includes. Owner commands now use native Git configuration
and environment; member commands retain requester attribution and disable automatic
signing. Turn overrides are applied to new command environments without rewriting
repository configuration. Existing ACP processes still retain their launch policy,
so this does not complete live attribution changes inside adapter-owned processes.

## Decision

This addresses [#1840](https://github.com/LodyAI/Lody/issues/1840) and replaces the
owner identity selection described in the
[bounded lookup note](2026-09-16-bounded-session-user-identity.md).
The [identity Spec](../../../../specs/git-commit-identity.md) remains draft.
Owners receive no synthesized fallback: missing identity follows native Git errors
and configuration. Forks cannot reuse a cached owner identity from another directory.
Member profile lookup and its neutral fallback remain unchanged.

Session stores member attribution outside launch configuration. After shell, agent
and credential environment merging, it sets both author and committer and appends
disabled commit/tag signing plus an empty signing key. Returning to the owner
therefore restores native settings without guessing which user settings to delete.
This is independent of conversation-owner network credentials and covers native
local projects. Explicit Git flags can still enable signing; this is no key sandbox.

The obsolete credential-policy lookup and its retry/deadline facade are removed.
Creation retains its cancellation check before binding identity; continued turns
derive ownership synchronously from the frozen requester. No resource ownership,
restart, cancellation or recovery protocol is added. The remaining logic is pure
selection and environment construction, so no native Effect migration is needed.

Deleting the managed bare repository's entire `[user]` section was rejected: it
also removes signing keys and `useConfigOnly`, and repository location does not
prove that those values are stale. Both managed and local repository config stay
intact. Automatic cleanup would need evidence identifying Lody-owned legacy values.

## Verification and limits

The Session environment regressions failed before the fix and pass after it.
Real Git commits cover repository and conditional-include identities, linked
worktrees, explicit owner environment, missing identity, member fallback, unsigned
commit/tag creation, and member-to-owner transitions in native and managed modes.
ACP spawn capture confirms initial attribution and the retained launch snapshot.
The seven focused suites pass 421 tests, including startup without a policy response,
cancellation before launch, and replacement after retirement. Repository `pnpm check`,
`pnpm format` and `pnpm run docs check` pass; the full CLI suite has 4514 passing
tests and 4 skips. No installed application or running daemon has been replaced.
