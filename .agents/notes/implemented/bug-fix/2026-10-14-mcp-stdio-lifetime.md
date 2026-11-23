# Keep the stdio MCP application alive

Status: implemented
Translation: current

PR: [#1559](https://github.com/LodyAI/Lody/pull/1559)

[中文](2026-10-14-mcp-stdio-lifetime.zh.md)

## Abstract

The stdio MCP command returned after connecting, so the CLI closed its shared
application runtime while the transport continued accepting requests. Later workspace
creation could fail with `Presence application owner unavailable`. A scoped Effect
connection now keeps the command alive until transport/input termination or a process
signal, then releases SDK subscriptions. The change covers host lifetime only;
arbitrary tool-handler Promise cancellation and HTTP ownership remain unchanged.

## Cause and responsibility

The application entry already binds Presence for internal subcommands. The defect
is premature release, not a missing binding in a separate process. This repairs the
consumer lifetime of the [workspace Presence owner](../architecture/2026-10-12-effect-workspace-presence.md).
`connect()` means listener installation, not service completion.

- Trigger: the internal stdio command creates a fresh SDK server and connection.
- Owner: the command's Effect-provided Layer owns transport and event subscriptions;
  the outer CLI continues owning the shared application runtime.
- Cancellation: stdin EOF/close, SDK close, SIGINT/SIGTERM end the wait; stream errors
  fail it. Fiber interruption also releases subscriptions. SDK close aborts request
  signals; arbitrary Promise handlers are not claimed joined or migrated.
- Handoff: listeners precede SDK startup. The pinned SDK installs and removes stdio
  listeners synchronously behind Promise APIs, with no network or drain wait.
  Startup is uninterruptible only for that short installation, preventing late
  acquisition after release. The SDK's close callback and request-abort behavior
  remain intact.
- Recovery: every invocation creates a fresh connection. Startup/input errors and
  cleanup defects retain their combined Cause through the command's AggregateError.
  There is no automatic retry or owner rebinding.

A Promise waiting for EOF would fix the immediate symptom, but Effect Scope and
Deferred make interruption, event ownership and error composition explicit without
migrating tool implementations or adding another application runtime.

## Verification

Ten deterministic tests use the real SDK and in-memory Node streams. They cover a
protocol handshake and tool call borrowing the actual application runtime, EOF,
both termination signals, fiber interruption, partial startup failure, input failure,
SDK close, cancellation notification to an in-flight tool, already destroyed input,
and combined startup/cleanup failures. No network, real sleeps or production sessions
are used. Removing the post-connect Deferred wait makes the handshake regression
fail immediately with "MCP command ended before the client finished"; the wait was
restored afterward.

The lifecycle and existing MCP suites pass 60 tests. Workspace typechecks, ordinary
and Effect lint, formatting, docs check (zero errors, no SHA-protected topics), i18n
and all seven boundary guards pass. Full `pnpm check` stops in CLI tests: 4,196 pass,
one fails, four skip. The unchanged recursive native SSH submodule credential test
reports `context_unreadable`; its isolated retry repeats the same failure (23 other
cases pass). No green full-repository check or deployed nightly acceptance is claimed.
The native host boundary has scoped rules and behavioral tests, not a dedicated
static execution guard. Arbitrary tool Promise ownership remains outside this unit.
