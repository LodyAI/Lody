# Managed and self-managed Pi providers side by side

Status: proposed
Translation: current

[中文](2026-09-22-managed-and-self-managed-pi.zh.md)

## Abstract

The original Pi migration replaced a legacy `pi-acp` provider in place, which also
replaced its launch behavior and left existing sessions bound to the new provider
identity. This proposal adds a separate managed Pi provider on the selected machine
and leaves the self-managed provider and its session bindings unchanged. A stable
managed-provider ID makes retries idempotent, while separate Pi profiles remain an
explicit user configuration rather than an isolation guarantee.

## Proposed decision

Replace the landing migration action with an add action. It creates one `builtin/pi`
row for the selected machine only when that row is absent. It does not update the
legacy row, copy its command or environment, switch the current provider selection,
or rewrite Session metadata. Startup auto-registration continues to defer Pi while a
legacy provider exists, so adding managed Pi remains an explicit choice.

The managed row uses a deterministic per-machine ID. The write is insert-if-absent:
repeated clicks, retries after an uncertain response, and concurrent clients converge
on one row without overwriting later edits. An existing builtin Pi configuration wins.

Custom Provider remains the recovery path for users who already lost their legacy
row. Its existing command test verifies the configured ACP entry point. The UI explains
that self-managed Pi needs an ACP-compatible adapter and that the plain `pi` command is
not an ACP server.

## Boundaries and trade-offs

Provider IDs isolate launch configuration and Session bindings, but do not isolate
Pi's profile directory. Users may set `PI_CODING_AGENT_DIR` on one provider; Lody does
not move credentials or configuration and does not claim filesystem isolation. The
managed runtime still cannot resume legacy `pi-acp` native session IDs.

This proposal partially replaces the in-place migration decision recorded in
[Managed Pi ACP and confirmed provider migration](../../implemented/feature/2026-09-17-builtin-pi.md).
The runtime packaging, capability negotiation, and legacy session limits remain.

## Evidence and verification plan

- Issue: [LodyAI/Lody#832](https://github.com/LodyAI/Lody/issues/832)
- Intent: [builtin Pi draft Spec](../../../../specs/builtin-pi.md)
- Implementation: `packages/shared/src/pi-provider-migration.ts`,
  `packages/components/src/atoms/agents.ts`, and
  `packages/components/src/components/chat/chat-landing.tsx`
- Verify the provider construction contract, insert-if-absent persistence, existing
  auto-registration coverage, component type checks, localization, and docs checks.
