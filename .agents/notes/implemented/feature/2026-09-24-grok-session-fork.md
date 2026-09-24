# Bridge Grok session forks through Core

Status: implemented
Translation: current

[中文](2026-09-24-grok-session-fork.zh.md)

Provider PR: [acp-extension-grok #21](https://github.com/LodyAI/acp-extension-grok/pull/21)

## Abstract

Grok's standard ACP capability response omits fork, while its native private
interface can copy whole sessions or an inclusive historical prompt prefix.
The adapter now bridges Core's standard fork and versioned turn selection to
that interface, discovers the source working directory, and attaches the child
without replay. Native prompt markers provide restart-stable, branch-local turn
coordinates while live user echoes remain hidden from the host. Protocol tests
and isolated native disk-copy probes pass; authenticated continuation and
cross-compaction forks still need end-to-end validation.

## Decision and evidence

This corrects the initial investigation's inference that an absent standard ACP
fork capability meant the runtime had no fork implementation. Upstream
[`f0e3be1` fork.rs](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/fork.rs)
accepts `targetPromptIndex` through `x.ai/session/fork`. Its `/fork --at` command
is disabled even though the lower-level implementation supports the parameter.

The [Spec](../../../../specs/grok-session-fork.md) retains
[Core's existing contract](../../../../packages/acp-extension-core/README.md):
`session/fork`, `_meta.lody.forkAtTurn`, and emitted `_meta.lody.turnId`. No Core
or host production changes are required. Native `promptIndex` becomes an opaque
`grok-prompt:<index>` token; no process-local lookup table or inferred counter is
needed after restart. Unmarked legacy turns stay without a selectable boundary.
External rewinds may reuse coordinates, so these IDs describe current branch history.

The adapter enables native user echoes internally, consumes live user text, and
emits a Core session-info boundary before assistant output. Replayed user text
and unrelated metadata survive. Each new prompt clears its previous boundary;
unmarked mid-turn echoes do not erase a known current boundary.

For each fork the adapter walks standard `session/list` pages to find the source
cwd. The requested cwd is the destination, including worktree destinations.
After native copy succeeds, `session/resume` attaches the new ID with target MCP
servers and startup permissions, avoiding duplicate history replay. The source
is never reloaded or cancelled. A copy or lookup error returns the original RPC
ID. Attach failure also returns the persisted child ID for recovery rather than
silently losing it or pretending the fork succeeded.

Directly forwarding `session/fork` cannot work because Grok does not implement
that standard method. Replaying text would discard native context and was not
used. Storage copying remains entirely Grok-owned; the adapter does not recreate
its compaction or persistence implementation. Existing
[streaming fork affordance guidance](../bug-fix/2026-09-11-streaming-fork-affordance.md)
is unchanged; this change only supplies provider capabilities and turn markers.

## Verification and limits

- All 82 adapter tests pass, including full/targeted conversion, source lookup
  pagination, inclusive zero index, concurrent requests, reverse-request ID
  isolation, permission startup, malformed targets, failures, replay markers,
  restart-stable boundaries, and delayed model snapshot settlement.
- Adapter build/typecheck scripts pass (JavaScript syntax checks).
- `GROK_PATH=<binary> node scripts/probe-session-fork.mjs` passes on official
  Grok 1.0.34 and 1.0.40. It uses isolated `GROK_HOME` and synthetic fixtures, no
  authentication or model prompts. It checks discovery, full and inclusive
  0/1-prefix copies, cross-cwd operation, child identities, model-context and
  replay files, and byte-identical source files.
- Authenticated child continuation, copying while persistence is in flight,
  and historical boundaries across compaction remain unverified end to end.
  The adapter delegates their persistence semantics to the pinned runtime.
- Root `pnpm check` and `pnpm format` were attempted but fail because this
  nested checkout lacks dependencies including `tsgo` and `oxfmt`. No desktop
  UI run was performed. The root documentation check still reports
  pre-existing broken links into other uninitialized ACP submodules; no
  protected content topic is registered for this change.

## Ablation of PR-local redundancy

Starting from adapter `58cff15`, each candidate was applied alone, run through
`node scripts/test.mjs` with the original 82 tests unchanged, and restored before
the next experiment. Passing tests alone did not justify deleting protocol guards.

| Isolated change | Result | Decision |
| --- | --- | --- |
| Remove `turnBySession` writes | 80/82; live/replay boundaries and next-turn attribution fail | Retain |
| Remove repeated-cursor check | 81/82; missing-source discovery keeps requesting a repeated page | Retain |
| Remove speculative nested `result.result` fallback | 82/82 | Remove; source and native probes confirm direct response objects |
| Remove duplicate child-ID callback argument | 82/82 | Derive it from the resume request's session ID |
| Replace duplicate regex/range validation with canonical turn-ID round trip | 82/82 | Reuse the same formatter that emits IDs |
| Remove the fork-specific request-ID allocator | 82/82 | Share `runtimeRequest` with context/billing requests |

The combined changes also pass all 82 tests, syntax checks, and both native
runtime probes. A deterministic comparison of the original and simplified
validators produced identical acceptance/error codes for 269 inputs, including
wrong prefixes, numeric aliases, range limits, non-strings and 200 canonical IDs.
The existing invalid-input tests now also cover exponent/whitespace/negative-zero
aliases and an undocumented nested native response. No tests were removed or
weakened. Native persistence/continuation limits above remain unchanged.
