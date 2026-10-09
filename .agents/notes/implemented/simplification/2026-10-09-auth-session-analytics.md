# Remove redundant auth and session request events

Status: implemented
Translation: current

[中文](2026-10-09-auth-session-analytics.zh.md)

## Abstract

Auth readiness sent two consecutive events with the same properties, and session
controls recorded both request intent and a later handler result. This change keeps
canonical cross-client activity and session outcomes while removing four redundant
request/readiness events. Failures and blocked operations remain observable, and
stop/reorder results carry helper duration. This reduces emitted events on the
inspected paths; no production volume or reliability improvement has been measured.

## Decision and evidence

The [draft contract](../../../../specs/auth-session-analytics.md) owns the event
mapping and migration limits. This extends the success-oriented approach in the
[feature usage note](../feature/2026-09-24-new-feature-usage-analytics.md) without
changing that note's unrelated event inventory.

`_auth.tsx` passed the identical object to `capturePostHogActiveUser` and
`app/auth_ready`; retain the former because CLI also uses `app/active`.
The detail menu delegates search opening to the conversation, which already emits
`search_opened` behind its open-state guard. Remove only the menu request capture.
Stop and reorder retain their catch paths and UI feedback. The stop helper launches
RPC without awaiting it and awaits the cancel-pointer write; deleted sessions return
early. Reorder likewise returns for same/missing items before attempting its write.
Do not reinterpret either success event as a stronger distributed outcome.

Keeping request events would preserve an independent attempt denominator, including
requests that never settle; that cost is deliberately traded for fewer events.
Removing failures based on an aggregate 100% success rate was rejected because
runtime availability, storage, and asynchronous work can still fail. No production
incident, ingestion duplication rate, or dashboard migration is established here.

## Verification

The change is limited to capture calls and result timing; control flow and platform
composition remain unchanged. The existing search, machine RPC, PostHog analytics/provider, and deferred
PostHog suites pass (5 files, 80 tests). Route regeneration leaves the route tree
unchanged; formatting and the public-boundary check pass. Full `pnpm check` passed typecheck/lint but stopped at the unchanged CLI
recursive SSH fixture test (`context_unreadable`), also reproduced alone; no capture-call-only or source-string test is added.
