# Shortcut token retry diagnostics

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2836

[中文](2026-11-17-shortcut-token-retry-diagnostics.zh.md)

## Abstract

A failing Shortcut token action and its authorization query produced separate server
exceptions, and repeated attempts multiplied ingestion. V2 returns fixed handled
failure results; the Shortcut provider owns one report per resource/access failure
code and phase until a token succeeds. Failures remain visible and authentication
refusals notify the existing supervisor. Unknown platform faults and legacy clients
retain their existing reporting behavior.

## Ownership and compatibility

The provider effect owns the account, auth session, workspace and operation lifetime.
Temporary auth-session absence during refetch keeps the last confirmed same-account owner. Retirement fences late completions; a late earlier success cannot clear a newer
failure. Counts stay in memory and are never analytics events, authorization caches,
repo metadata or persistent state. Distinct failure codes/phases/statuses and other
operations retain their first diagnosis. Success clears only that operation's counts.

Handled rejections carry a dedicated error type so the deferred reporter, SDK
`before_send`, and React boundary cannot report them again. Auth errors retain the
existing ConvexError name/symbol/data contract. The Streams auth-provider cause is preserved through refresh so its handled identity is not lost in a generic wrapper. Only fixed failure codes appear in
the first diagnostic, including in restricted telemetry scopes. This extends the
[privacy projection](2026-10-29-workspace-telemetry-privacy.md), not its authorization.

Deploy the additive backend V2 endpoint before shipping the client. V1's successful
token and throwing contracts remain intact. A new client negotiates V1 only for the
explicit missing-V2 error; this capability choice never caches access. Old clients
and old-backend compatibility still incur their original exception volume. A
backend-only time/fingerprint cache was rejected because unauthenticated requests
have no trustworthy retry identity and independent failures must remain visible.

Only wholly handled Shortcut cause chains skip boundary/deferred capture. Mixed or foreign causes retain their independent fixed boundary diagnostic, without consuming the boundary episode for an earlier handled token failure. The browser harness keeps Shortcut/boundary script-SDK probes separate from the sync-stuck ESM fixture.

## Evidence and limits

The finite model checks 78,125 traces over five events at depth seven; implementation
checks exercise 100 attempts, owner retirement, independent failures, auth recovery,
legacy negotiation, and post-exchange revocation. The real locked browser SDK sends
to a loopback receiver to count ingested exceptions. Local handler checks do not
prove hosted Convex integration delivery. Handler-external timeouts and deeper
component failures can still be automatically collected; no global suppression or
production configuration is changed. No failed write is automatically replayed.
