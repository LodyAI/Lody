# Readable names for new worktree branches

Status: proposed
Translation: current

[中文](2026-09-27-readable-worktree-branches.zh.md)

## Abstract

Issue #289 reports that opaque worktree branch names make session work hard to
identify and publish. The proposed path keeps the initial ID branch until the
first accepted title arrives, then renames only a new, unchanged and unpublished
branch while reconciling Git with Session metadata. The reference implementation
now has a durable one-time rename intent and checks the current Git branch,
HEAD and remote publication before acting. The design remains proposed while
the issue's UX feedback and contribution handoff are outstanding.

## Decision and alternatives

Passing `SessionConfig.title` to the branch allocator alone is insufficient:
the title is optional, speculative worktree creation precedes the durable
Session, and Provider-generated titles arrive after initialization. Deriving a
name from initial prompt text would cross the preparation contract that keeps
draft text out of its RPC and could put sensitive text in a public branch name.
Renaming every existing `lody/<id>` branch on title change would affect old
Sessions and branches that users may have pushed. A one-time new-session marker
with an expected branch and HEAD provides a narrow eligibility boundary.

The proposal in [the draft Spec](../../../../specs/readable-worktree-branches.md)
defers naming until a title is accepted, then fails closed if the branch or
publication state has changed. It requires an actual Git ref and SessionMeta
reconciliation path; a slug helper by itself has no user-visible value.

## Evidence and status

- [Issue #289](https://github.com/LodyAI/Lody/issues/289) has no maintainer
  discussion or alternate implementation at the time of this proposal.
- Current [worktree creation](../../../../apps/cli/src/session/worktree/worktree-manager.ts)
  allocates before title generation; [ACP title Spec](../../../../specs/acp-session-titles.md)
  documents the later Provider event.
- The reference branch now includes a bounded ASCII slug, a one-time intent in
  `SessionMeta`, and a Git rename guarded by the repository lock. A focused
  local Git test covers an untouched branch, moved HEAD, a published ref,
  collision suffix, and an unusable title. A SessionManager test covers both
  speculative adoption eligibility and recovery after Git rename. Title callback
  ordering still needs integration coverage before this is ready for an upstream PR.
- No upstream PR exists. The fork PR context-handoff requirement remains a
  separate entry gate; this note does not claim user publication or approval.
