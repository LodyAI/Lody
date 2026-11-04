# DSH session forks

Status: implemented
Translation: current

Provider PR: [acp-extension-dsh #27](https://github.com/LodyAI/acp-extension-dsh/pull/27)

[中文](2026-10-06-dsh-session-fork.zh.md)

## Abstract

The DSH ACP adapter now exposes ordinary forks and exact ended-turn forks using
Core's existing version 1 metadata and the pinned Harness 0.1.5-rc.2 event log.
Native prefixes seed independent root Agents, preserving historical configuration
and using target cwd/MCP settings; success waits for native durability. No Harness
upgrade is needed. ACP boundary tests and a native event-store probe pass, while
cuts inside unfinished turns and ACP load/resume remain outside this change.

## Source evidence

Examined adapter `fbc54496b2770b8bf4e756636238459d064ffc12`, Harness release
[`fb2c4b9e`](https://github.com/deepseek-ai/deepseek-harness/tree/fb2c4b9e698e30edb738bca4cf0618587db7d203)
(`dsh-v0.1.5-rc.2`), and upstream
[`5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)
(`0.2.1-alpha.1`). Release artifacts were also inspected.

- Pinned `packages/core/session/src/index.ts`: `sessions.fork(source, boundary?,
  childSessionId?)` copies an inclusive event prefix from a live Session and
  rejects `OPEN_TURN`. Earlier closed turns remain valid while the parent runs.
- Pinned `packages/api/session-controller/src/commands.ts`: `sessionQuery.observeSession`
  reads live or persisted history, and `agents.create({ seed, inheritedEventCount,
  meta, setup })` creates an independent root Agent with fork lineage. This is
  the appropriate pattern for an ACP process that does not own the source runtime.
  Its UI-oriented `atSeq` rounds to a following turn end and falls back to the
  latest closed turn for out-of-range anchors; do not reuse those semantics for
  an exact ACP boundary.
- Session logs are append-only. Compaction replaces the model-visible surface
  without deleting original events. Prefix reconstruction can recover the
  pre-compaction surface when those raw events remain readable.
- Upstream `packages/core/session/src/fork.ts` adds `buildForkSeed`, which marks
  inherited history and synthesizes missing tool results and step/turn closers
  for an open cut. Pinned 0.1.5-rc.2 has no equivalent public helper and rejects
  such cuts. Do not copy this new storage/lifecycle behavior into the adapter.
- `subagent-fork-in-process` selects the latest closed-turn prefix for delegated
  work. It is not an independent ACP session fork interface.

## Implemented adapter responsibility

1. Publish stable native turn markers through Core `_meta.lody.turnId`, matching
   the prompt-owned root output. Resolve requested markers against the observed
   native log and copy through the exact matching `turn/end`; reject unknown,
   malformed, or unfinished targets. Do not infer boundaries from rendered text,
   tool steps, or historical Lody entries that have no native marker.
2. Define untargeted fork during an active turn explicitly: reject it;
   allow an explicit earlier closed-turn target without cancelling the parent.
   A stopped/failed turn with a durable `turn/end` is structurally closed too.
3. Read one native observation and seed a new root Agent. Preserve lineage and
   the selected prefix, use the requested target cwd/MCP servers, and share the
   existing session setup, question, tool, usage, and disposal machinery. Restore
   model/reasoning/permission/preset state at the chosen prefix rather than
   inheriting later settings accidentally. Never replay transcript as a prompt.
4. Wait for native durability via `sessions.flush(child)` before reporting a
   durable fork, and release runtime/MCP resources on failure. A failed checkpoint error includes
   the child ID: Harness has no public stored-artifact deletion API. Seeded creation alone
   does not prove disk durability. Verify cold loading/continuation separately;
   the current adapter exposes neither `loadSession` nor `resumeSession`.
5. Advertise standard ACP fork and Core `forkAtTurn`; bump capability-source
   profile revision to v15 so host probes refresh the changed capabilities. Git worktrees and project-file rollback remain host concerns.

The [Grok fork decision](../../implemented/feature/2026-09-24-grok-session-fork.md)
supplies the existing host contract; this change adds DSH translation only.
The [DSH fork Spec](../../../../specs/deepseek-harness-session-fork.md) remains draft.

## Verification and limits

- Adapter build and all 41 unit tests pass. Four added ACP boundary cases cover
  cold-source full/targeted copies, historical model/reasoning/preset selection,
  target cwd/MCP, child continuation output with native turn metadata, source
  preservation, malformed/missing/unfinished targets, setup and flush failures,
  resource release, and deterministic child/source-prompt durability barriers.
  Harness checkpoints before requests/tools, not final `turn/end`; prompt
  settlement now flushes the ended prefix for immediate cross-process forks.
- `DSH_TEST_RUNTIME_ROOT=<pinned node_modules> node --test scripts/session-fork-smoke.mjs`
  passes against published Harness 0.1.5-rc.2. The adapter's own prefix builder
  feeds the native SessionStore; checks cover full/targeted copies, compaction
  surface replacement before/after cuts, source isolation, independent child
  appends, serialized restoration, and earlier cuts while the source is active.
  Fixtures are synthetic; no model, credentials, or user data are used.
- Actual compaction-model execution, model continuation, JSONL/zstd disk restart,
  attachment lifetime, and cross-process concurrent persistence remain unverified.
  The native probe restores serialized Session data rather than starting a daemon.
- Root desktop build cannot run in this nested checkout without its workspace
  dependencies (`rimraf` is missing). Adapter checks run from its isolated install.
