# Daemon-owned guide rejections are settled by history

Status: implemented
Translation: current

[中文](2026-09-28-daemon-owned-guide-outcome.zh.md)

Verdict (2026-09-29): implemented in [#1095](https://github.com/LodyAI/Lody/pull/1095) and moved from `proposed/`. Superseded by [removing the session send journal](../simplification/2026-09-29-remove-session-send-journal.md): after a daemon-owned (`recoveryOwned`) rejection the renderer no longer reads history, records a guide outcome or retries; the daemon owns the turn. Uncertain outcomes are left as written and are not reported as send failures. The cause analysis below still holds.

## Abstract

Users often saw "Guide outcome is uncertain; the original turn is retained" after steering a working conversation, most often with attachments. In most cases the message was not lost: the daemon had proven the steer undelivered and requeued the turn as an ordinary follow-up. The renderer did not recognize that answer and reported it as uncertain. The send journal now reads the turn's history after a daemon-owned rejection and treats a requeued or settled turn as handled.

## Cause

`SessionExecutionService.steerSessionLocked` marks every rejection `recoveryOwned: true`. For rejections proven to happen before provider submission (`no-active-turn`, `stale-turn`, `busy`, `unsupported`), `rejectAndPromote` first runs `requeueUndeliveredSteer`. That flips the history row from `pending_apply` to `pending` and sets `steerTurnStatuses[id] = 'pending'`, which `getPendingUserTurnActivationId` treats as an activation. The daemon then runs the turn itself.

The journal's guide delivery (`workspace-session-send-journal.ts`) accepted only `applied` or `no-active-turn` and threw for everything else. `stale-turn` is common when attachments upload first: the targeted assistant turn has often been replaced by the time the steer is sent. The error surfaced as a "failed to send" toast (and, before this PR, in the pending-send panel). "Continue sending" then succeeded, because the retry path reads history and finds `pending`.

The steer path used when no journal record exists (`session-submission.ts`) had the same gap for everything except daemon-owned `no-active-turn`.

## Decision

- **History decides, not the disposition.** A `stale-turn` response has the same shape whether the daemon requeued the turn or deliberately kept it (cancellation without promotion, such as Edit & Resend). After a daemon-owned rejection, the renderer waits for target sync and reads the turn with `readGuideTurnOutcome`:
  - `pending`, `seen` or any settled status means the daemon handled it. The journal records `guideOffer: 'recovered'` and marks the record delivered.
  - `pending_apply`, `delivery_unknown` or a missing row stay uncertain, and the error remains.
- **The renderer never dispatches a recovered guide.** `recoveryOwned` means the daemon owns recovery. Republishing a dispatch pointer could overwrite a newer activation. `'recovered'` is persisted, so a retry after a crash does not dispatch either.
- **`promotion-failed` is retried through the daemon once**, as the no-record path already did.
- **`delivery_unknown` is uncertain on the lost-answer retry path too.** The previous classifier treated any status except `pending_apply` as proof, so a `delivery_unknown` turn could have been dispatched again.

## Verification

- `tests/session-send-journal.test.ts`: a real workspace journal and session document. `stale-turn`, `busy` and `unsupported` with a requeued turn become delivered with `recovered`, no dispatch and no activation write. `stale-turn` with a kept turn, and `delivery-unknown`, stay committed with the uncertain error.
- `tests/use-session-actions.test.ts`: the no-record path resolves a daemon-owned, requeued `stale-turn` as not applied without dispatching. Legacy (non-daemon-owned) and kept turns still reject.

## Limits

- The requeue is observed through target sync. If sync cannot catch up, the turn still reads `pending_apply` and the error remains; retry reconciles it.
- Legacy daemons that answer without `recoveryOwned` keep the previous behavior.

Related: [Sidebar send status](../feature/2026-09-28-sidebar-send-status.md), [Session files Spec §6.3](../../../../specs/session-files.md#63-direct-queue-and-guide).
