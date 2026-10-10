# Streams sync failure diagnostics

Status: draft
Translation: current

[中文](streams-sync-diagnostics.zh.md)

## Scenario

When a workspace or session fails to synchronize, a code-only error such as
`Streams sync failed: internal_error` cannot distinguish a failed request from a
local cursor or CRDT fault. Lody should show the evidence available at the failing
boundary and record the same safe context in its existing local diagnostic sinks.

## Responsibilities

Streams records provenance where an operation fails. Repo carries its original
discriminator, validated context, explicit retryability and failure classification
through transport results, synchronization reports and diagnostic events. Lody
projects those documented scalar fields into technical error details and logs.
Caller wrappers and multi-transport reports must retain useful failure details.

The detail distinguishes network requests, deadlines, HTTP responses, local
storage, local CRDT operations and unknown provenance. It includes the observed
system error code, HTTP status/request ID, operation/stage and measured timeout
budget when supplied. A fetch failure or errno does not establish that the device
is offline or the backend is down. HTTP errors establish a response, not an outage.
Missing evidence remains unknown; message-text inference is forbidden.

Log records associate failures with the workspace, room, transport, phase,
duration and attempt supplied by the existing diagnostic event. They contain only
the safe projection, never entire exceptions, arbitrary messages, stacks, causes,
bodies, headers, provider objects, keys, tokens or URL queries. Existing localized
action labels surround the technical detail. Ordinary non-Streams errors retain
their existing formatting.

Diagnostic collection is passive: it does not change retries, transport selection,
durability or synchronization deadlines. Explicit `retryable: false` stays false.
Routine successful synchronization remains silent. Existing local-only composition
and disabled telemetry remain binding; diagnostics add no cloud requests.

## Evidence and limits

Implementation: [shared projection](../packages/shared/src/loro-sync-errors/index.ts),
[CLI composition](../apps/cli/src/lib/loro/streams-transport.ts),
[renderer composition](../packages/components/src/providers/workspace-streams-transport.ts).
Decision and validation: [owning note](../.agents/notes/implemented/bug-fix/2026-10-10-streams-sync-error-context.md).
Synthetic fault tests establish propagation and safe formatting; they cannot
attribute the original production incident without its underlying evidence.
