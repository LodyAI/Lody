# Interrupt pending input exactly once

Status: implemented
Translation: current
PR: [#693](https://github.com/LodyAI/Lody/pull/693)

[中文](2026-09-14-interrupt-pending-input-exactly-once.zh.md)

## Abstract

Stopping a turn could not safely decide whether a concurrently submitted steer had entered the
provider, so replay risk and lost input were coupled to generic cancellation state. The fix makes
the adapter return a three-state delivery outcome and gives cancellation an explicit pending-input
policy. User Stop promotes only a proven `not-applied` steer; internal cancellations and unknown
delivery preserve it. Durable Session hold, Goal hold, Operation hold, and Resume are deliberately
outside this decision.

## Decision

`AgentClient.steerPrompt` resolves delivery as `applied`, `not-applied`, or `unknown`. Codex's
explicit adapter `failed` response and a synchronous pre-write failure are proof of
`not-applied`; connection and process failures are not. `SessionExecutionService` never examines
provider exception types to reclassify delivery. The Codex adapter therefore returns `failed`
only for a proven refusal; unexpected adapter failures reject the request and remain `unknown`
([adapter PR #43](https://github.com/LodyAI/acp-extension-codex/pull/43)).

`cancelSession` defaults to `pendingInput: 'preserve'`. User-facing Stop paths opt into
`'promote'`; Edit & Resend and access revocation stay on `'preserve'`. A promoted user turn uses
the existing ordinary dispatch pointer and history status, so there is no second execution path.
Late `applied` and `unknown` outcomes never publish that pointer.

Foreground ACP run configuration receives the owner Effect's `AbortSignal`. Configuration code
checks it between mutations and before persisting the runtime patch, preventing an interrupted
turn from issuing a later mutation after its successor starts.

## Evidence and limits

Behavioral coverage exercises Codex `not-applied` promotion, a late `applied` outcome, internal
cancel preservation, and Effect cancellation between two configuration mutations. The change
does not add persistent hold state, pause Goal or Operation work, or define a durable Resume.
