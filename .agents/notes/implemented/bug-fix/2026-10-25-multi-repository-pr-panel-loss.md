# Independent PR association and lifecycle ownership

Status: implemented
Translation: current

[中文](2026-10-25-multi-repository-pr-panel-loss.zh.md)

## Abstract

A whole-array status writer could remove another repository's PR association,
closing its detail panel and removing its action. The adopted solution separates
machine-owned association membership/order from per-PR lifecycle observations.
Shared readers merge independent machine and webhook records by GitHub revision;
renderers and turn completion no longer publish captured association arrays.
Hosted lifecycle summaries can therefore update while the machine is offline,
without granting status observations authority to create associations.

## Ownership and convergence

The reconciler is the sole automatic list publisher, preserving its fresh-owner,
branch revalidation, quota, retry and success-after-effects contracts. Hosted
linkage is independent of publication. CI and mergeability remain machine-owned.
The public contract is [local GitHub observation](../../../../specs/local-github-pr-observation.md).

The shared lifecycle policy canonicalizes repository/PR identity and plans one
`prLifecycle:<source>:<url>` field containing `{s,u}`: status and provider revision
milliseconds, under 50 bytes. Sources are fixed (`machine`, `webhook`); this is two
registers per observed PR, not an event log. Flat fields match Repo's metadata
storage and prevent one repository update from replacing another's record.

Machine publication uses ordinary `upsertDocMeta`, preserving local durability and
upload events. Blind webhook publication uses a fresh Flock with a provider-stamped
clock and deterministic status tie-break peer. Importing a fabricated remote delta
into the machine would incorrectly bypass local-update upload subscriptions, so it
is not a publication mechanism. Independent source fields also avoid mixing local
HLC clocks with provider revisions.

Readers choose the greatest GitHub revision, then prefer a live machine snapshot
on an equal-revision source tie. Webhook-only ties prefer terminal states
(`merged > closed > open > draft`). GitHub's second-resolution revision does not
prove within-second ordering; this is a deterministic ambiguity policy, not an
exact event chronology. Later provider revisions can reopen a closed PR.

Orphan observations do not create membership or existence. Registers remain until
session purge: a local-clock deletion could otherwise fence a later valid provider
revision. The record count grows with associated PR identities, never poll count.

## Terminal discovery reactivation

A context-only discovery fingerprint could indefinitely hide a second PR created
on the same branch after the first became terminal once other list writers were
removed. Terminal sleep now requires a successful checkpoint for repository,
branch and the latest owner/child `lastMessageAt`. Child activity is folded before
projection; each project repository has its own checkpoint. The existing turn
completion metadata update wakes discovery without a scheduler callback.

The dispatched target captures the activity snapshot. Only successful query and
owner effects commit that snapshot, never newer activity read during writeback.
Thus activity during a request still needs another discovery under normal quota
and attempt gates. Checkpoints remain in the existing durable fingerprint store
when target success state is pruned. Versioned encoding invalidates old context-only
records for one catch-up query; no database migration or new state owner is needed.
No activity means no recurring terminal queries. PRs created entirely outside Lody
without a metadata activity/context change still need a later activity signal.

## Consumers and compatibility

Sidebar equality compares resolved statuses, suppressing revision-only renders.
Repository rows, PR actions, archived rows, task mappings, counts, notifications,
MCP summaries, diff-stat policy and poll targets use the same resolver. Live PR
panel details stay view-local; same-number PRs across repositories cannot share a
status write. No UI cache retains removed membership to conceal a bad writer.

The array retains `{url,status}` as a compatibility projection. Older readers remain
usable but offline lifecycle freshness requires new readers. Active old renderers
must upgrade because their captured-array writers cannot be neutralized by a new
reader. Hosted adapters must stop initial-association publication, keep unversioned
queued calls harmless, and publish versioned webhook observations separately.
The hosted counterpart is maintained outside this public repository.

A machine-only solution would sacrifice offline summary updates. Replacing the
entire association model with per-PR entities would require a broader ordering and
deletion migration. Rebuilding from hosted link tables would omit independently
observed local PRs. None is needed for this separation.

## Validation and limits

Behavioral coverage includes actual hosted handler/Flock merges, out-of-order
provider revisions, same-number repositories, invisible orphan observations,
workspace deletion, legacy calls, terminal-branch reactivation after restart,
child and project-member activity, activity during discovery, legacy checkpoint
invalidation, one-time lifecycle bootstrap, stale polling
results, real Repo local publication/remote hydration, and sidebar-only updates.
Relevant component, shared, CLI and hosted suites and package type checks are run
in isolated checkouts. No captured user records, logs or conversations are included.
No production deployment or rebuilt installed-desktop verification is claimed.

The existing poller lifecycle and published Promise Repo boundary are retained;
no new Effect service, recovery owner, clock loop or migration unit is introduced.
This extends the [multi-repository design](../../proposed/architecture/2026-10-16-multi-repo-projects.md)
without changing its broader project/worktree contract.
