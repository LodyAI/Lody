# Readable branches for new worktree Sessions

Status: draft
Translation: current

[中文](readable-worktree-branches.zh.md)

A newly created worktree Session currently starts on an opaque branch such as
`lody/<session-id>`. A title often arrives only after the worktree and Provider
have started. For new Sessions, Lody should replace that temporary name with a
bounded, readable name derived from the first accepted Session title when doing
so cannot disrupt work already published or a branch chosen by the user.

## Responsibilities

- Worktree creation remains independent of title generation. Speculative
  preparation must not receive draft prompt text or a prompt-derived name. The
  initial branch remains the current session-ID fallback.
- At creation or adoption, the owning machine records a durable, one-time
  rename intent: the exact initial branch and HEAD. Existing Sessions have no
  such intent and must never be renamed by this feature.
- When the first accepted title is available, the owning machine derives a
  lowercase ASCII slug from that title, with a short session-ID suffix and a
  bounded branch length. Empty or unusable slugs retain the initial branch.
  Later title changes do not rename the branch again.
- Before renaming, verify that the worktree is still on the recorded branch,
  its HEAD has not moved, and the branch has no upstream, published remote ref,
  or linked pull request. Uncertain publication state keeps the original name.
  Allocate a unique Git-valid name under the repository lock, including local
  ref namespace conflicts, and never attach to another Session's branch.
- Git and Session metadata cannot be changed atomically. Persist the intent
  before the Git operation; after a successful rename, publish the actual
  branch to `SessionMeta.branchName`. Recovery reconciles an unfinished intent
  against the worktree's actual branch before restore or cleanup uses metadata.
  A failed attempt keeps the original branch and does not retry indefinitely.

This changes only new worktree Sessions. Direct local checkouts, child Tabs,
restored worktrees, and existing Session branches retain their current behavior.
The title is never copied from the initial prompt merely to name a branch: a
branch may later be pushed to a public remote.

## Acceptance cases

Repository-backed tests must exercise both speculative adoption and cold
creation, Provider-generated and explicit titles, duplicate titles, non-ASCII
and empty titles, a user-renamed branch, moved HEAD, a published branch, and
recovery after Git rename but before metadata publication. The visible Session
branch, actual Git HEAD ref, and later restore target must agree in each case.

## Evidence and open design review

- [Request #289](https://github.com/LodyAI/Lody/issues/289) asks for readable,
  unique new-session branches and an empty/non-ASCII fallback.
- [Worktree allocation](../apps/cli/src/session/worktree/worktree-manager.ts)
  creates the branch before the Session runs; [speculative preparation](../apps/cli/src/session/worktree/speculative-worktree.ts)
  may do so before the durable Session is claimed.
- [Title ownership](acp-session-titles.md) allows Provider titles only after
  initialization; [branch observation](workspace-branch-state.md) and
  [worktree lifecycle](session-worktree-lifecycle.md) already depend on the
  real Git branch matching durable Session metadata.

The reference implementation checks the local upstream, remote-tracking refs,
and remote heads before renaming; it records an attempted target before Git
changes the ref, then reconciles the actual branch into Session metadata. A
local Git test covers an untouched branch, moved HEAD, published ref, collision
suffix, and unusable title. SessionManager tests cover speculative adoption and
recovery after Git rename. Title callback ordering still needs integration
coverage. This draft is not an approved behavior guarantee.
