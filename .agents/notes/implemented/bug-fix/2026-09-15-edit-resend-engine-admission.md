# Edit-and-resend fails closed on engine prompt occupancy

Status: implemented
Translation: current

[中文](2026-09-15-edit-resend-engine-admission.zh.md)

## Abstract

A review identified a state-shape hazard in which an engine-opened turn can occupy the ACP prompt slot without exposing a client-owned `activeTurnId`. The existing edit-and-resend flow used the latter as its cancellation gate, so it could be unsafe if a provider exposed that combination. The implementation adds an explicit `engineTurnActive` execution field and fails closed before preparation, before commit, and after persistence, closing any prepared replacement and compensating local history/meta on a late detection. Repository reachability review found that current edit-and-resend rejects builtin Kimi before provider work, while the known autonomous-turn producer is Kimi; this therefore hardens the protocol boundary and future provider compatibility rather than proving a current Kimi edit-and-resend P1.

## Decision

- `SessionExecutionSnapshot` distinguishes engine occupancy from client ownership. `hasActiveTurn` remains the generalized ACP-slot busy signal; `activeTurnId` remains a cancellable client owner.
- Edit-and-resend checks the explicit engine flag at the initial, post-prepare, pre-commit, and post-persist fences. It never cancels an engine owner or adopts a replacement after the marker is observed.
- A marker detected after the local history/meta commit uses the existing one-use history rollback receipt, restores the prior metadata fields, persists the compensation, and closes the detached replacement. This is fail-closed compensation, not a transaction.

## Evidence and limits

- The execution service already exposed the relevant engine-only shape: `hasActiveTurn: true` with no `activeTurnId`; the new test makes the explicit field observable.
- `SessionEditAndResendService` currently allows only builtin Codex and Claude, while repository evidence identifies Kimi ACP server as the autonomous-turn marker producer. The review's state transition is valid at the interface boundary, but its current product-path reachability is not established.
- The in-process rewrite barrier blocks local dispatch/steer/queue promotion but cannot stop a provider-side engine admission. A marker can still arrive during preparation or persistence, so the implementation detects and compensates rather than claiming atomicity.
- Compensation can still encounter concurrent document changes; the history receipt rejects unsafe range changes, and metadata restoration is best effort. A versioned ACP admission lease or execution-level rewrite lease is a separate architecture change.

## Follow-ups

- Revisit the overloaded snapshot shape with a discriminated `SessionPromptOccupancy` model.
- Specify and enforce provider engine-admission serialization, including the transient store's single engine-owner slot.
- Align `turnOrigin` and `auto:` predicates across history apply, fork/editable-tail, and UI consumers.
- Validate live behavior with a managed runtime carrying the Kimi start/end markers.

## Verification

- Focused CLI suites: `session-edit-and-resend-service.test.ts` and `tests/session-execution-service.test.ts` — 138 passed.
- CLI TypeScript check remains blocked by pre-existing missing exports in `acp-extension-dsh/profile` and missing `fzstd` declarations; no new `SessionExecutionSnapshot` error appeared.
- Formatting required one test-file write; final checks are recorded in the task report.

Spec: [session-history-writes.md](../../../../specs/session-history-writes.md)
