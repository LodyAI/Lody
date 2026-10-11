# Session preparation retirement barrier

Status: implemented
Translation: current

[中文](2026-10-09-session-preparation-retirement.zh.md)

## Abstract

Cancelling a preparation removed its lease before asynchronous cleanup finished.
A cold Session could then reuse the worktree and lose it to the old preparation's
late cleanup, failing before its first prompt. Retain a per-Session retirement
barrier until creation and disposal settle, and join it before cold startup or
replacement preparation. This trades some cold-start latency for workspace safety;
a creator or disposer that never settles still requires the caller's existing
initialization cancellation/deadline handling.

## Decision

`SessionPreparationService` owns both available leases and retiring resources.
Expiry publishes retirement before abort listeners run. Claim misses and discard
return that barrier even after the lease has disappeared. Replacement startup
joins same-Session retirement and the replaced requester's lease; a different
requester cannot overwrite an active lease for the same Session. Shutdown also
joins retired resources whose creation has not returned yet. Readiness rejection
handlers are installed even for late resources disposed without starting.

The Session manager already awaits missed-claim/discard cleanup before cold
creation, so the fix belongs in the service rather than another directory-exists
check. An existence check alone cannot prevent a later deletion. Marker ownership
locking remains a separate protection; this barrier orders runtime disposal and
workspace creation within the daemon.

```text
cancel / expiry / failure
  -> remove available lease + publish retirement
  -> await late creation -> dispose resource -> release retirement
  -> cold creation or replacement may use the workspace
```

This implements the [preparation handoff contract](../../../../specs/session-worktree-lifecycle.md#preparation-handoff)
and does not change archive/restore retention, cross-process marker ownership,
or repair already broken resident Sessions in an installed app.

## Verification and limits

The owning service suite uses explicit promise gates, fake TTL timers and temporary
directories. It checks cancellation, startup/readiness failure, incompatibility,
late resource publication, repeated replacement, shutdown, ownership and capacity,
and confirms cold-created files survive all old cleanup. The cancellation regression
fails against the original service because its cleanup barrier is missing.

Validation uses existing local Vitest tooling with an isolated config because this
checkout has no dependency installation and its ACP submodules are uninitialized.
Targeted strict TypeScript checking maps the shared Session ID to its actual source.
All 16 service tests, scoped strict type checking, lint and formatting pass. Root
`pnpm check` and `pnpm format` were attempted but fail on missing installed tooling
(`tsgo` / `oxfmt`). Full CLI/desktop integration and installed-app acceptance are not verified. The
repository documentation check already reports broken links into absent submodules;
these are outside this change. No captured user transcript or log is stored here.
