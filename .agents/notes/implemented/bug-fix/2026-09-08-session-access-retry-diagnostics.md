# Preserve transient machine-access failures across Session commands

Status: implemented
Translation: current
PR: not created

[中文](2026-09-08-session-access-retry-diagnostics.zh.md)

## Abstract

A temporary control-plane network failure aborted Session creation before the target Machine or
Agent was contacted, while the MCP boundary reported the failure as a permanent command or input
rejection and hid the underlying network cause. Command-side access checks now retry transport
failures within a bounded window and report exhausted failures as retryable with their nested cause.
Authorization stays fail-closed, and definitive denials still stop immediately.

## Decision and scope

- The access query is idempotent, so command validation retries only transport-shaped failures at
  250 ms, 1 second, and 2 seconds. Schema, identity, and other non-transport failures do not retry.
- The existing daemon dispatch loop remains independently interruptible and unbounded because it
  protects an already-durable user turn. Command validation is bounded because it sits before work
  is accepted or dispatched.
- Exhausted transport failures use `MACHINE_ACCESS_UNAVAILABLE` with `retryable: true` for MCP
  single and batch create/chat paths. A machine-access failure is no longer `COMMAND_REJECTED` or
  `INVALID_ITEM`.
- Diagnostics walk nested `cause` and `AggregateError.errors` values, retaining common network
  codes and messages. They do not include credentials or change the access request payload.
- Presence remains a separate signal. No online heartbeat bypasses or substitutes for the access
  query.

## Evidence and limits

Deterministic tests inject the delay function and cover recovery, immediate non-transport failure,
and exhausted nested `ECONNRESET` diagnostics. CLI typecheck, lint, formatting, and broader checks
are recorded in the change handoff. This does not prove recovery in a released desktop build or
identify the affected user's original proxy, DNS, or TLS failure.

See the [draft behavior contract](../../../../specs/session-access-verification.md).
