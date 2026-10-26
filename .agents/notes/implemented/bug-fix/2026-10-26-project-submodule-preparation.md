# Project submodule preparation must distinguish incomplete repositories

Status: implemented
Type: bug-fix
Translation: current

[中文](2026-10-26-project-submodule-preparation.zh.md)

## Abstract

Project startup previously treated every local repository as a complete object
reference and every `.gitmodules` path as an existing submodule. Valid partial
clones and residual configuration could therefore stop a conversation before its
agent started. The fix limits object borrowing to supported source layouts and
initializes actual index gitlinks. Archive now distinguishes unmaterialized empty
members from independent checkouts, preserves gitlinks for restoration and retains
unknown content. This is a source change; it does not deploy or restart the app.

## Responsibility and evidence

The owning design is the [Project group decision](../../proposed/architecture/2026-10-16-multi-repo-projects.md).
Source was inspected at `274d74a724de7bfb42c6ff0685c52c0abce7d487` and the
installed desktop implementation was checked for the same command construction.
Captured conversations and machine records are excluded from this note.

### Partial clones are not complete object references

`checkoutProjectSubmodule` in
[`project-submodules.ts`](../../../../apps/cli/src/session/worktree/project-submodules.ts)
previously added `--reference <repositoryPath> --dissociate` whenever `options.local` was true.
`materializeProjectSubmodule` in
[`worktree-manager.ts`](../../../../apps/cli/src/session/worktree/worktree-manager.ts)
derived that boolean from `source.kind === 'local-shared'`, without inspecting
promisor configuration or object completeness. Commit
`b4c39aabfe10550192fb7f1fe3382998ac5ad781` introduced this optimization.

A repository with `remote.origin.promisor=true` and
`remote.origin.partialclonefilter=blob:none` is a valid local copy with missing
objects. Lending its objects to an ordinary clone does not transfer its promisor
configuration. `--dissociate` only removes the dependency after a successful clone;
it does not make an incomplete reference complete before transfer and repacking.
See Git's [clone](https://git-scm.com/docs/git-clone) and
[partial-clone](https://git-scm.com/docs/partial-clone) documentation.

Synthetic local Git experiments compare no reference, a complete reference and a
blobless reference. A seeded text history is partially cloned without checkout;
the remote then receives ten more commits with shrinking text versions and is
repacked normally with `git gc --aggressive`. The same parent gitlink and native
Git command are used in all cases; file transport requires no network or broker.

| Reference | Submodule update | Integrity check |
| --- | --- | --- |
| None | Exit 0 | `fsck --full` exits 0 |
| Complete local copy | Exit 0 | `fsck --full` exits 0 |
| `blob:none` local copy | Both clone attempts fail with `pack has 10 unresolved deltas` and `invalid index-pack output` | Checkout never completes |

When reference and remote have the same tip, the incomplete reference instead
fails during dissociation with missing-blob/repack errors. Both cases establish
that the unconditional optimization changes successful checkout into failure.
The delta-pack case matches the reported error mechanism without relying on a
real server, proxy, concurrent Git command or damaged source repository.

### Configuration entries are not gitlinks

`initializeMissingProjectSubmodules` previously read paths from `.gitmodules`, checked for a
child `.git`, and passed every missing path explicitly to `git submodule update`.
It never intersected the configuration with actual `160000` entries in the Git
index. A synthetic repository with a residual `protocol` entry and no corresponding
gitlink reproduces exit 1 and `pathspec 'protocol' did not match any file(s) known
to git`. The Project materializer awaits this operation before starting ACP, so
the failure stops the whole conversation.

### Empty directories are not initialized checkouts

[`project-worktree-archive.ts`](../../../../apps/cli/src/session/worktree/project-worktree-archive.ts)
previously checked directory existence and containment before backing up selected submodules.
It did not establish that the directory itself was a Git checkout. After clone
failure, the directory can exist without `.git`. The first backup command,
`symbolic-ref`, discovers the parent repository and reads its branch; the next
`add -A` fails with `in unpopulated submodule`. A synthetic parent/submodule fixture
reproduces both observations. Repeating GC repeats the same failure rather than
recovering the incomplete startup.

## Repair and ownership

- Skip object borrowing for partial clones, shallow clones and linked worktrees.
  Inspect any promisor remote and legacy partial-clone configuration through the
  existing native Git capability. Keep ordinary clone behavior rather
  than hydrating or rewriting the user's source repository. A broader check for
  incomplete alternate chains can be considered separately; do not call every
  repository corruption a supported partial clone.
- Initialize only actual submodule gitlinks. Ignore residual configuration entries
  without swallowing fetch, authentication or checkout errors for real submodules.
- Before backup, establish that each member is its own checkout. Distinguish a
  never-materialized empty directory from an unknown directory containing work;
  do not delete or back up unknown content through parent Git discovery.
- A missing child must retain a real parent index gitlink before it can be treated
  as unmaterialized. Recreate its empty placeholder within verified group paths
  before parent backup, so `git add -A` cannot accidentally commit removal of the
  gitlink. Explicit index removal and escaped ancestors remain errors.

The trigger is local source inspection, member initialization or archived-owner
cleanup. The existing Project owner retains its lease until all started mutations
settle; native Git commands keep their process scopes and failure Causes. No new
owner, global fence, retry loop, credential fallback or automatic replay is added.
Absent members with saved branches still verify their durable store before cleanup;
unknown nonempty or incomplete checkouts retain the group for inspection. Successful
archive publishes branch receipts before deinitialization, and restoration reuses
those receipts and parent gitlinks.

The reference check extends an existing native Effect workflow. Manager mutation,
setup and GC still have unfinished Promise dependencies in the migration ledger,
so this fix keeps their existing owner and registered Legacy Git boundary. It does
not claim a broader lifecycle migration or change its dependency ledger.

## Validation and limits

The owning real-Git suite now covers partial-source checkout without hydration,
linked/shallow sources, stale configuration beside a real submodule, failed clone
archive and restore, missing backup receipts, incomplete checkouts, unknown content,
explicit gitlink removal and escaped ancestors. Replacing the three production
files with the pre-fix source makes the four primary regression cases fail with
their respective Git errors. Six related real-Git suites pass 130 cases, including
39 in the owning suite. Full workspace types, lint and formatting pass. The full
`pnpm check` reaches workspace tests and stops on eleven E2EE HTTP tests because
the sandbox denies loopback listening; that entire eleven-test file passes when
rerun outside the sandbox. This does not establish a green complete test run.
Documentation check passes with the pinned ACP sources present; the original
working checkout retains its 84 pre-existing missing-submodule link errors.
Tests use a temporary standalone copy with the locked dependencies and exact
submodule source revisions, without real Git remotes or application restart.
Existing user repositories and conversations are not modified. Live desktop
acceptance was not performed.
