# Separate ordinary chat state from onboarding analytics

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1361

[中文](2026-10-09-onboarding-analytics-boundaries.zh.md)

## Abstract

Ordinary Chat Landing emitted onboarding project and agent events on restored
state and selection changes, contaminating the meaning of the onboarding funnel.
Remove those three listeners instead of renaming them into new recurring traffic.
Keep completion start, navigation success and durable completion distinct, with
attempt correlation and durations for durable completion and persistence failure.
Source inspection establishes the boundary defect, but no raw production evidence
establishes its contribution to reported aggregate volumes.

## Decision and evidence

`useFireOnKeyChange` only compared the last selection key; it did not identify
onboarding or distinguish restoration from a user action. The project-source
listener was once per mounted component/key, not once per onboarding flow.
All three listeners lived in ordinary Chat Landing; desktop onboarding has its own
screens and flow-scoped provider. Removing them avoids inventing an onboarding
flag in a surface which does not own setup. Existing chat and session events stay.

`enterDesktopProduct` starts persistence and navigation independently. Navigation
may succeed while persistence is pending or fails; persistence can succeed before
navigation fails. Therefore the three stage events are not duplicates. Preserve
them and document which one is the durable funnel numerator in the
[Spec](../../../../specs/onboarding-analytics.md). Attempts are numbered per route
mount, not globally. A reload can reuse the flow id while restarting the counter.

Audit also found legacy `account_ready` and `cli_ready` in the workspace auth route;
those belong to the separate auth/app workstream and are intentionally unchanged.
The [blueprint proposal](../../proposed/feature/2026-09-26-blueprint-onboarding.md)
is not the production flow and does not supersede this contract.

## Validation and limits

The owning completion suite replaces mock-count-only checks with resulting
product/resume state assertions, both resolution orders, unavailable IPC,
synchronous throws, rejections, negative persistence results, late failure and
navigation retry. Route-level cases verify concurrent-trigger coalescing, retry
attempt numbers and separate entry/durable/persistence-failure durations. Existing
analytics tests cover local telemetry gating and flow identity. See the PR for executed checks and environment limitations. No captured
user content or production event details are committed; no measured volume reduction
is claimed. No telemetry capability or cloud composition is enabled.

Executed: 16 targeted onboarding tests, repository typecheck/lint,
`pnpm check:quick`, `pnpm format`, route generation and `pnpm run docs check` pass.
`pnpm check` stops at the unchanged CLI recursive SSH clone test with
`context_unreadable`; an isolated rerun reproduces it (5 passed, 1 failed).
The remaining full-suite checks are not claimed as passed. No Electron E2E run.
