# Show finalization while execution remains busy

Status: implemented
Translation: current
PR: [ladydd/Lody#1](https://github.com/ladydd/Lody/pull/1)

[中文](2026-10-06-finalizing-status-label.zh.md)

## Abstract

Hiding the activity row after prompt completion makes a still-busy session appear
ready for immediate execution. The UI now labels the existing explicit finalizing
presence “Finalizing…”, with Chinese “收尾中…”. Execution ownership and submission
routing are unchanged. This explains the wait without introducing overlapping
turn finalization; it does not reduce finalization latency.

## Decision and scope

This revises the presentation in [PR #614](https://github.com/LodyAI/Lody/pull/614):
keep its optional presence phase and image-callback protection, but display the
phase instead of hiding it. History cannot select this label because history and
presence arrive independently, particularly during goal continuation.

Early release was considered separately. It would require frozen per-turn data
and protection against stale completion writes; merely hiding the label or
starting the next turn before cleanup does not supply those guarantees.
The existing [question-finalization decision](2026-09-12-turn-question-finalization.md)
remains applicable: required cleanup belongs to the owning turn.

Intent: [Spec](../../../../specs/session-finalization-status.md).

## Verification limits

The phase predicate regression is retained with updated terminology. Translation
keys and the diff are checked separately. This checkout has no installed package
dependencies; component tests and packaged Electron interaction are not verified.
