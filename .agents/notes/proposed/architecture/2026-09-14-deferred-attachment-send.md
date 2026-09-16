# Attachment draft lifetimes and PR boundaries

Status: proposed
Translation: current

[中文](2026-09-14-deferred-attachment-send.zh.md)

## Abstract

Attachments currently transfer on addition, and composer unmounting or failure handling can affect complete submission. The draft feature unifies creation and continuation: addition only validates/previews, an independent service takes over after Send, and every attachment must be ready before submission. Adopt pinned Effect 3.18.4 through four proposed PRs: extract submission boundaries, own resources, complete submission/delivery, then deliver all draft entry points together; the first three retain transfer on addition, at the cost of completing persistence, recovery, and exit boundaries before feature delivery. Original local paths, permanent zero upload, and related protocol/Daemon work remain separate follow-up work. Six probes establish partial cancellation/resource boundaries, including two using the actual store cache; this revision changes design only, without product implementation or acceptance.

## PR boundary

The [attachment draft Spec](../../../../specs/session-files.md) owns this PR. New conversations and continuations share takeover, preparation, retry, and cancellation contracts, while retaining distinct final creation/continuation adapters. Both require complete UI acceptance; testing a shared helper or landing alone is insufficient.

The [direct local-reference Spec](../../../../specs/local-attachment-references.md) separately preserves the follow-up design: original paths, generated local files, registration authority, new attachment protocols, Daemon/adapter/preview compatibility, and disabling backfill. None are implementation or acceptance gates for this PR. The current work delays existing upload/local handoff and preserves attachment types, fallback, backfill, materialization, and platform capabilities without claiming permanently upload-free local files.

This replaces the initial combined draft/local-reference implementation scope. The later PR plugs into the same preparation boundary instead of duplicating draft state machines. The split reduces this PR's implementation scope, without removing draft failure, cancellation, exit, or recovery requirements.

## Inspected source and tradeoffs

Baseline: `8c429a890037c5b21855ce7ef9f59e3677c25a38`.

- `session-chat-input-area.tsx` and landing hooks transfer on addition. Failed ordinary files are filtered while unsuccessful images block sending. This PR unifies both entry points around complete attachment readiness.
- `use-session-actions.ts` generates turn IDs per call; `HistoryWriter.append` has no ID deduplication, and initial meta/history writes run concurrently. Stable IDs need reconciliation and persistent handoff together.
- An in-memory manager supports in-page navigation but is insufficient for mobile-shell reclamation. Retain local recovery records, preserve drafts on save failure, and do not claim OS background transfer.
- Electron confirmation must still precede relay/CLI cleanup. This belongs to draft lifecycle and is not deferred with local-communication optimization.
- Reusing existing local handoff lets drafts ship independently. Its copying/backfill changes belong to the later PR; current UI must not imply they have disappeared.

Native mobile shells and private upload services outside this repository were not inspected. API reuse is an implementation direction, not completed integration acceptance.

## Effect proposal and tradeoffs

[Spec section 11](../../../../specs/session-files.md#11-effect-ts-integration-and-implementation-order) scopes adoption to workspace preparation, submission, and delivery. React/Jotai retain drafts and short takeover/focus tokens; CLI retains Agent/backfill ownership. Scopes follow release boundaries. Ref.modify is optional state-operation syntax; encapsulated ordinary variables also work. Ref is neither a cross-I/O transaction nor a cross-window lock.

Current call-chain findings refine the proposal:

- Mount-scoped useComposerSubmission also owns keyboard/focus; session-chat-input-area's success callback clears drafts and marks visual comments submitted. Split saved takeover from actual acceptance to avoid premature annotation changes, prolonged input locking, or focus theft. Preserve click-time mobile blur; data clearing waits for saving.
- session-detail.handleSendDraft couples child creation, tab promotion, navigation, and failure deletion while reading the current parent. Freeze parent/identity, recover promotion aliases, and never delete a written child on navigation failure. Landing is not the only creation entry.
- useSessionPreparation.handoffToSession only drops references/timers. First version stops warmup on attachment takeover and gives the service exact cancellation cleanup; actual send may cold-start. Preserve CLI TTL/compatible claim and attachment-free warmup reuse.
- workspace-writer-impl runs initial meta/history concurrently and ignores dispatch arguments. use-session-actions.requestSessionDispatch separately launches sync, full-input RPC, and a meta pointer write. Extract UI-independent submission and delivery ownership; old “durable accept unit” comments are not evidence.
- CLI SessionDispatchWatcher.offerRpcTurn ACK means stash/deduplicated receipt, not execution or persistence. RPC carries full input and can start execution early. TurnHistoryGate waits for user history before output writes, so ACK does not end history sync; preserve CLI execution/deduplication ownership.
- createSessionStore separates references from room sync leases; store-ref-tracker owns dispose/unload. Effect finalizers release only their borrow. Preparation/offline parking does not retain full history; late acquisition still needs release. acquireRelease masks acquisition by default, so unbounded acquisition is not controlled shutdown.
- waitUntilSynced(signal) can resolve on abort/detached, while transport-ready waiting does not yet forward cancellation. Distinguish success, skipped, interrupted, and uncertain outcomes; delivery borrows existing sync instead of creating per-message transports/reconnect loops.
- session-chat-interface captures MCP, Role, tool switches, resume, billing guards, presence, and direct locks in components. Freeze user choices and recheck runtime facts after extraction. Ordinary messages share FIFO; preserve unfinished-history queue barriers. Guide false mixes outcomes: authoritative no-active-turn differs from uncertainty.
- resolveWorkspaceRuntimeCacheIdentity isolates repo/cursors per window; another window's empty replica cannot prove rejection. Token refresh need not destroy the service, while account/topology changes require old-generation exit protection.
- Image cancellation, unowned multipart cleanup, noncancelable IPC, runtime/Electron shutdown still need changes. Main temporary files and CLI blobs/backfill keep existing ownership/semantics; upload-free local references remain a separate PR.

Use one ManagedRuntime with storage, transport, and submission dependency boundaries. Persistent handoff can compact into smaller delivery obligations instead of stopping delivery with upload Scope. The cost is defining actual persistence/sync receipts, original-replica recovery, and side-effect timing; replacing individual Promises is insufficient. Adapt coupled boundaries without rewriting unrelated reconnect/cache/Daemon systems.

## Staged adoption and rollback

[Spec section 11.6](../../../../specs/session-files.md#116-staged-adoption-and-acceptance) proposes three prerequisite PRs followed by one complete draft feature PR, each merged after its responsibility is complete:

1. Extract ordinary submission interfaces while preserving behavior. Baseline cases exercise actual input/configuration/routing; retain existing defects as counterexamples with an owning later fix.
2. Use Effect inside the service to fully own migrated uploads, cancellation, retries, borrows, and release. Components keep ordinary interfaces and transfer still starts on addition; exit cleanup ships with its resources.
3. Own submission/delivery of already-prepared messages, with identity, persistence receipts, uncertain-result reconciliation, cross-window recovery, and necessary exit flows. This explicitly improves reliability while retaining transfer timing.
4. Connect complete drafts for creation, children, and continuations together, including saving, failure, cancellation, ordering, warmup, and platform exit/recovery before enabling the feature.

Remove the previous owner when migrating a responsibility. Never run real uploads/writes twice or fall back to legacy sending after an uncertain result. Do not simultaneously upgrade Effect, rewrite underlying sync, or implement upload-free local references. The tradeoff is later visible feature delivery in exchange for independently checking behavior, cancellation, and resource ownership at each stage. After introducing recovery records, rollback requires a compatible version that can process them; stop takeover and finish or reliably retain in-flight work first. Deleting records or resending is not rollback. Do not ship the persistent stage before original-replica recovery and record compatibility are defined.

## Related decisions

- Preserve [workspace draft isolation](../../implemented/bug-fix/2026-09-11-workspace-window-composer-drafts.md) across new/existing conversation drafts and account/workspace boundaries.
- Preserve the [single history writer](../../implemented/architecture/2026-09-07-single-history-writer.md), without another history mutation path.
- Preserve folded text and pre-send expansion from the [context-copy decision](../../implemented/feature/2026-09-09-conversation-context-fallback.md). Automatic text-file conversion and image editing are excluded.

## Stack implementation status

PR 1: [#705](https://github.com/LodyAI/Lody/pull/705) — `refactor/attachment-submission-boundary` → `main`.

Layer 1 extracts `lib/session-submission.ts` from `use-session-actions.ts` and
keeps React bindings for billing admission, analytics, and observable atoms.
Creation, initial history, continuation, dispatch, and guide still use the same
writer and routing. It preserves transfer timing and acceptance behavior; no
persistent send service or draft product behavior is enabled by this layer.
The base includes main's composer paste-size ceiling (`6fde8b07`). Validation
uses the existing action/composer suites, with writer-call-only assertions
replaced by observable initial/continuation history checks.

Layer 1 validation: repository typechecking/lint pass; components 3,656 tests,
shared 1,194 tests, and Electron 112 tests pass. The full `pnpm check` run stops
at an unrelated CLI worktree-GC assertion comparing macOS `/var` and
`/private/var` aliases (other CLI cases: 2,791 passed). Its complete 11-test suite
passes with `TMPDIR=/private/tmp`; remaining i18n/import/platform/public-boundary
checks and docs check pass separately. `pnpm format` ran; unrelated formatting
was discarded. No packaged-device draft acceptance is claimed.

## Verification and limits

The [finite model](../../../../specs/models/session-files.model.ts) covers only the current draft scope: add/remove/replace/navigate/send gates for both entry points, paired attachment readiness, and two accepted same-session messages with at most one retry each. Acceptance and persistent handoff are separate; cancellation, obsolete callbacks, FIFO, and the old failed-file filtering counterexample remain. Upload-free local routing has been removed from this model.

Run `node --experimental-strip-types specs/models/session-files.model.ts` and `tsc --noEmit --strict --target ES2022 --module ESNext --lib ES2022,DOM --skipLibCheck specs/models/session-files.model.ts`. This model does not connect to actual UI, writers, disk, IPC, or Agents. Complete new-conversation/continuation acceptance follows A01–A18 and cannot be replaced by the model.

The [Effect probes](../../../../specs/models/session-files.effect-probe.mjs) use pinned 3.18.4 and pass six cases: noncooperative writes after interruption, signal-controlled transfer, awaited Scope cleanup, phase/generation checks, plus late-acquisition release and preservation of shared UI references through current store-ref-tracker.ts. The cache cases use synthetic stores, not real Loro/disk/network. Explicit gates and releaseIfIdle drive release without elapsed-time or scheduler guesses.

Reproduce with a temporary effect@3.18.4 installation (`npm install --prefix <temp> --ignore-scripts --no-audit --no-fund effect@3.18.4`). Copy specs/models/session-files.effect-probe.mjs and packages/components/src/providers/store-ref-tracker.ts retaining their repository-relative paths; run `node --experimental-strip-types --test <temp>/specs/models/session-files.effect-probe.mjs`. This establishes only those boundaries, not real XHR/IPC, writer durability, cross-window coordination, or E01–E12 acceptance. Official v3 sources and current code references are in the Spec.

The original design checkout had 20 broken links to uninitialized ACP submodules. The independent implementation checkout initializes the pinned submodules: document checks now have zero errors and no registered SHA-protected topics. The three action/composer suites pass 69 tests for layer 1; full repository verification and PR references are recorded with the stack status. Product draft behavior and device acceptance remain incomplete. Specs remain draft and this Note remains proposed.

## Layer 2 implementation

Layer 2 creates one workspace Effect resource owner for file preparation, image uploads, and send-path store borrows. React keeps Promise interfaces. Navigation does not cancel uploads; workspace disposal cancels and joins work before closing caches/transports. Noncancelable IPC must settle before dependency release. New and continuing conversations share file preparation; cancellation cannot trigger fallback upload, and multipart cleanup is awaited.

Deterministic tests cover parallel cancellation, late store acquisition, sibling isolation, actual XHR cancellation, and progress versus successful response. Transfer still starts on addition. Persistent submission and complete draft behavior remain the next two layers.

Layer 2 validation: `TMPDIR=/private/tmp NODE_ENV=test pnpm check` passes completely (components: 478 files, 3,661 tests). `pnpm format` and `pnpm run docs check` completed; docs have no errors. Packaged-device draft acceptance remains outstanding.
