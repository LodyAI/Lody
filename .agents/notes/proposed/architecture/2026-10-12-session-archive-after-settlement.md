# Defer Session archive until execution settles

Status: proposed
Translation: current

[中文](2026-10-12-session-archive-after-settlement.zh.md)

Upstream: [LodyAI/Lody#1521](https://github.com/LodyAI/Lody/issues/1521).

## Abstract

Archive previously wrote `isArchived` immediately, causing the daemon to terminate running work. Waiting for worktree cleanup did not mean waiting for conversation completion. The implementation separates durable archive intent from archived state, waiting for the whole group including queued work and output finalization. Manual confirmation retains immediate archive; PR auto-archive always waits. Behavioral coverage passes, but missing tooling and public ACP submodules block full repository validation, so this record remains proposed pending validation and review.

## Implementation and decisions

All manual entry points use one Cancel / Archive immediately / Archive when finished dialog, consolidating the old sidebar two-click and shortcut-only confirmations. Always confirming avoids treating unavailable live presence as idle. Batch archive creates one deduplicated target union. Pending acceptance keeps the route open; immediate archive retains held-send cancellation, teardown and terminal closure.

`SessionArchiveCoordinator` runs on owning daemons. Waiting targets attest readiness; preparation acquires the existing rewrite barrier and rechecks work before generation-scoped acknowledgement. The root owner persists a recoverable commit decision; target owners apply `isArchived`, reusing existing teardown and worktree GC. A separate cancellation request-id tombstone survives stale whole-request writes. New descendants discovered before commitment join the request and restart preparation. Offline owners cannot attest idle, and all participating machines must advertise `deferredSessionArchive`.

Readiness checks active/pending execution, dispatch offers, output/usage persistence, every backend queue row, the shared pending-activation predicate, active Goals and known renderer-held sends. Explicit target Goal checks reuse the persistent Goal resolver; historical documents are not scanned to discover candidates. Held-send IDs retire only after delivery or explicit cancellation. The pending icon uses a static Lucide-style archive box and clock because the pinned catalog lacks one; it occupies a lifecycle action area beside Working/Waiting, with cancellation and immediate override actions. Stories render the real icon and dialog, with English/Chinese strings.

PR auto-archive retains startup/restore baselines, owner/capability/settings gating, and retries failed writes with bounded backoff. Changed PR URL/status evidence cancels the request. CLI archive defaults to waiting and supports `--immediate` / `--cancel-pending`; MCP exposes `wait` / `immediate` / `cancel`, returning promptly even for its own active turn.

## Alternatives and limits

Renderer-only waiting cannot survive closed windows. `status: idle` is not completion because finalization and promotion can outlive it. Unsupported daemons never silently fall back to interrupting archive.

Metadata writes are recoverable, not a transaction across disconnected replicas. The group barrier covers known synchronized targets; unknown offline input and descendants created after commitment are outside atomic membership guarantees. Each owner rechecks late work before its archived write and lets late activation drain. Losing a renderer during attachment preparation leaves known blockers unresolved; cancel the request rather than infer completion. Blocked queue rows remain pending until completed or explicitly removed. Prepared-send writers reject new input once the archive fence is published. Local-project removal keeps its separate immediate behavior; worktree retention/cleanup policy is unchanged.

The existing relations and worktree lifecycle Specs remain draft and describe the new admission boundary. No new Spec was created. Implementation PR: [LodyAI/Lody#1522](https://github.com/LodyAI/Lody/pull/1522).

## Validation

Coordinator tests cover full-group waiting, all queue states, promotion/finalization gaps, active Goals/unknown metadata, attachment blockers across restart, offline owners, fence rechecks, cancellation tombstones, new descendants, PR invalidation and partial commit recovery. UI tests cover real dialog buttons, confirmation-before-write, immediate archive, durable wait/cancel and existing sidebar behavior. Shared types and translation keys pass. Components/CLI type checks remain affected by missing dependencies. `pnpm check` stops at missing `corepack`; public-boundary/docs checks report missing public ACP submodules. These are verification limits, not passing full-suite results.

Final targeted run: 112 tests passed across five suites. Chromium verified the real dialog at desktop and 375px widths and exercised immediate selection. Changed-file lint/format, translation keys, platform boundary and CLI process boundary checks pass. Restore tombstones a partial archive before unarchiving, preventing replay. Docs report 82 existing broken ACP-submodule links and no new document errors.
