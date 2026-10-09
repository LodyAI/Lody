# One interpretation of frozen turn execution input

Status: implemented
Translation: current

[中文](2026-10-08-frozen-turn-execution-input.zh.md)

## Abstract

Issue [#1332](https://github.com/LodyAI/Lody/issues/1332) exposed different text
sources for first execution and retry: create sent the composed Config/Role/task
prompt, while continue preferred raw task blocks. A shared execution-input resolver
now owns that interpretation across create, continue and steer. It uses frozen text
and preserves structured attachments without changing authored history or storage
format. Persisted-turn regression tests verify failed-start retries; actual provider
integration and packaged desktop interaction remain unverified.

## Decision and responsibilities

`inputConfig.prompt` owns effective execution text, including instructions composed
when the turn was accepted. `inputBlocks` own authored content and structured
attachments. `resolveSessionExecutionInputBlocks` in shared session input code
combines frozen text with images, files, comments and visual annotations. Explicit
empty text preserves attachments but does not revive raw task text; absent legacy
prompt retains normalized blocks. Dispatch already resolves legacy history fallback.
Raw text spans stay with their original text, never with composed execution text.

All execution-service entry points use this resolver, including stale-session
recovery rebuilding a continue prompt. Create still adds its runtime context, and
continue may prepend history replay. The daemon owns attachment materialization;
these runtime concerns do not change the accepted task or re-read a Role catalog.
Role id/revision/snapshot and other frozen configuration pass through unchanged.
The generic input normalizer remains unchanged for display/editing and queue/RPC
history construction.

This enforces the [orchestration contract](../../../../specs/session-orchestration.md)
and extends the [local orchestration decision](2026-09-29-local-session-orchestration.md).
A Role-only continue patch would leave steer divergent. Rewriting raw history would
lose the authored representation; globally changing normalization would mix execution
policy into display/editing. A third persisted execution-block field would duplicate
existing data and require a mixed-version migration without solving an additional
need here. Future interleaved text/media semantics may justify a separate contract.

## Verification

- Shared session-input tests cover composed instructions, all structured block types,
  raw spans, idempotent resolution, legacy input and explicit empty/attachment-only input.
- Execution tests persist a turn in a real Loro-backed SessionDocument, fail its first
  provider call, instantiate a fresh executor and retry through create, continue and
  missing-session restore. Actual provider-port requests retain each Config/Role/task
  instruction once, the file reference and frozen Role metadata; history stays raw.
- The existing steer handoff test now observes composed instructions at the provider
  port as well as invocation ownership. The shallow file-builder call-count test was
  replaced by the persisted-turn regression matrix.
- Replacing only the execution service with the original HEAD implementation makes
  continue, restore and steer regressions fail; create remains passing. Restoring the
  fix passes the execution/dispatch suites (270 tests). Shared input tests pass (27).
  Shared and CLI source type checks pass.

Tests substitute attachment I/O and provider transport. They do not establish real
model responses or catalog-edit UI behavior. Frozen semantic input is asserted;
whole provider requests need not be byte-identical because runtime context and local
attachment paths may differ. No schema migration or catalog rewrite is required.

Pre-PR `pnpm format` and documentation checks passed. Full `pnpm check` passed
workspace type checks and lint but stopped at the unrelated native recursive SSH
submodule fixture (`github-git-transport.test.ts`): the Lody Git wrapper reports
`context_unreadable`, reproduced in an isolated rerun. CLI totals were 3512 passed,
1 failed and 4 skipped; the full test pipeline did not complete. i18n, code-collab,
platform and public-boundary checks passed separately.
