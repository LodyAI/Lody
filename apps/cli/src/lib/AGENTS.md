# CLI library

`CLAUDE.md` aliases this file. Index:
[README.md](README.md). Scoped rules: [acp](acp/AGENTS.md),
[code-collab](code-collab/AGENTS.md), [file-preview](file-preview/AGENTS.md),
[loro](loro/AGENTS.md), [pr-poller](pr-poller/AGENTS.md).

**Before dispatch/sync read context/message-flow.md; before catalog/Fleet changes read [E2EE rules](e2ee/AGENTS.md).** WS/DO is deprecated; do not extend it.

## Composition and transports

- Daemon commands borrow its replica; command cleanup failures never fence.
- GitHub auth: conversation-owner personal → matching-owner machine → repo App,
  once per source. Failures advance without a policy RPC; local context grants
  machine eligibility. Never persist managed tokens or replay uncertain writes.
  Checkout/LFS share the pinned helper context. Contract: [identity fallback](../../../../specs/github-identity-fallback.md).

- `cloud-cli-port.ts` is the sole official-build composition root for cloud clients and
  endpoint-derived adapters. Daemon runtime modules must not construct cloud SDK
  clients or read `LODY_AUTH_URL` / `LODY_AUTH_SITE_URL` / `LODY_SERVER_URL`. The local
  port has null optional capabilities and does no cloud I/O: unavailable operations
  fail at their public boundary, and only contractually
  best-effort background effects may skip. Both halves are enforced by
  `scripts/check-platform-boundaries.mjs` + `tests/local-platform-zero-cloud.test.ts`.
- Client-visible RPC references come from public `@lody/cloud-api`; generated server
  declarations and private workspace packages are forbidden. Prime the token provider
  before reading `getGatewayBaseUrl()`, and never let runtime transports or Machine RPC
  require `LODY_LORO_STREAMS_BASE_URL` as a parallel hidden composition path.
- `cloud-pr-association.ts`: use `authSiteUrl`, not `authBaseUrl` (internal proxy).
  Six failures/workspace/repo, no eviction; reset on client recreation. Log once.
- Local control negotiates NDJSON or legacy buffered JSON, preserving intermediate
  replies. `MachineRuntime` may collect responses but forwards each as sent. Cancel
  parked history watches before shutdown drain; preserve shared writers.
- Route every remote bridge attach/detach/revoke through `machine-runtime.ts`
  `runBridgeTransition` and keep long waits OUT of transition bodies: attach is
  deliberately short, so a queued detach/revoke stays prompt. Backfill enable/disable
  flips its authorization generation inside the queued body (S5: a revoked workspace
  must never keep backfill enabled).
- **Dual-author (no write intents)**: the renderer direct-authors user/UI durable
  writes against its own repo over its own Streams connection; the CLI authors only
  agent-produced data. The v4-v6 write-intent envelope (`WorkspaceWriteIntentAuthor`,
  `intent`/`intent-ack` frames, CLI preview-comment mirror) is REMOVED; never
  reintroduce a proxy-authoring path (invariants in `specs/local-first-two-plane.md`).
  Local dispatch triggers off the renderer-authored `latestUserMsgId` doc-meta write
  plus the local Machine RPC fast path.

- INVARIANT: agent PATH merges keep the session's `gh` shim dir first
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-26-gh-shim-broker-and-path.md)).

## Local Loro data plane

Read [loro/AGENTS.md](loro/AGENTS.md) before enumerating rooms, publishing presence,
writing machine Flock rows, or reacting to reconnection. Before changing
`local-loro-data-plane-server.ts` (protocol v7, push, peer-scoped) read its
[rules and design](../../../../.agents/docs/cli-lib-local-loro-data-plane.md): named
`LoroDocumentManager` options, scheduler and bulk-writer limits, sender-enforced
framing, the RAW-chunk `createJsonLineSplitter` requirement, renderer room lifetime.
The room engine remains explicitly Legacy; outbound work uses the single native
process writer facade, and cleanup awaits its release receipt. Two are never negotiable: a renderer joining a Session Doc room must not call
`getOrCreateSessionDoc` or retain a live cloud room, and the CLI's cloud room status is
never pushed to renderers as local room health.

## Sessions and turns

- `session-gc-manager.ts`: `evaluateMemoryPressure` returns TWO verdicts, `evict` and
  `block`, sharing no threshold. Probes fail OPEN; `null` Windows commit growth
  never becomes `0`. Sweeps never force the cached commit probe; never act on a
  cached sample once pressure appears; re-check briefly before failing a turn; bound
  evictions per call. The threshold is a safety MARGIN, not "what a turn needs".
  [Per-OS signals](../../../../.agents/docs/cli-lib-memory-pressure.md). Idle counts
  native work: never clean `running`, cap background waits. Post-turn output resets
  it only for `sessionActivity` agents.
- **Session attachments**: before changing preparation, transfer, materialization,
  or backfill, read the [lifecycle rules](../../../../.agents/docs/cli-lib-session-files.md).
  CLI/MCP input preparation must finish before history/dispatch; recovery uses frozen
  references, never source paths. [Input contract](../../../../specs/cli-session-attachments.md).
  Keep ACP `resource_link` file URIs, workspace-contained agent output, and
  MessageHandler-owned authorization-generation/AbortController backfill fencing.
- [acp/AGENTS.md](acp/AGENTS.md) specifies ACP buffering/flush in `message-handler.ts`,
  turn-evidence persistence, shutdown ordering, the non-expiring late-ACP target in
  `session-transient-store.ts`, and the `awaitTurnHistoryGate` requirement for
  turn-scoped history LIST writes. Read it before changing any of them. The
  `replay-prompt-builder` resume fallback is in `context/hotspots.md`.

## Projects, providers, tasks

- Builtin Codex/DeepSeek local-project history import is read-only: require
  `_meta.lody.sessionHistory` v1 and call the Core-defined history method; never fall
  back to `loadSession`, which resumes the thread. Publish an imported Session only
  after history and its cursor are durable; legacy `metadata_only` shells stay
  selectable so a later import finishes hydration.
- Imported history keeps source hashes/ids separate from its stored-content baseline.
  Bind the baseline to the doc cursor, not metadata; compare existing content exactly,
  never sanitize it to hide edits. Write history and capture its baseline without an
  async gap, before publishing meta. Legacy history without a baseline is not migrated.
- History import validates the selected Provider machine/id/type; never fall back
  from a missing selection. Legacy requests use the sole same-type Provider. Catalogs
  are Provider-scoped; replay/import keys stay stable. Bind an earlier unbound import only when the selected Provider
  lists its source; never replace a binding or merge another account's native ID.
  Refresh loads through the import's own binding. Every import write records the
  load-reported selection on the last imported user turn via `applyAcpRuntimeConfigPatch`.
- Local-project deletion retains registrations referenced by Projects or group runs;
  disable standalone display without archiving their Sessions. Catalog read/sync
  failure keeps the command queued. Otherwise archive all unarchived machine/project
  Sessions via existence/metadata indexes before removing the row; archive failure
  retains the command. Explicit cleanup covers only Lody-created Session worktrees:
  inspect before submission and deletion, never force-delete or backup-commit dirty
  worktrees, record deleted/kept/failed results, and complete with visible results
  even on cleanup failure. Never delete the original project directory.
- Before changing `provider-setup-manager.ts`, read its
  [rules](../../../../.agents/docs/cli-lib-provider-setup.md): row ownership and the
  single publish commit, cancellation, when the queue may start in cloud versus OSS
  local mode, and the rule that a setup row never carries authorization URLs, codes,
  tokens, or raw provider output.
- **A `file-preview/` preview must never activate Code Collab**: no workspace watch, no
  All Changes recompute, no Flock publish.
