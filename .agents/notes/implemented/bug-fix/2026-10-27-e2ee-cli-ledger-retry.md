# Bounded CLI ledger recovery

Status: implemented
Translation: current

[中文](2026-10-27-e2ee-cli-ledger-retry.zh.md)

## Abstract

A single validation, conflict or unclassified ingest error left every new seal blocked until an unrelated explicit refresh. The CLI now re-fetches the rejected suffix up to three times, retaining its last verified view and refusing new seals until normal verification succeeds. Explicit refresh/reconnect starts a new bounded episode. Persistent invalid history never becomes accepted and closure cancels pending retries.

## Decision and lifecycle

The existing workspace Legacy facade owns one refresh flight and one retry timer. Failed ingest schedules delays of 250 ms, 1 s and 4 s. A queued SDK seal can request an earlier remaining attempt without waiting for it; it still returns `e2ee_invalid_ledger`. Concurrent triggers join the existing refresh. Explicit `refresh()` clears the timer and resets the budget. Successful verified progress resets it; no failed page is skipped, pin reset or unverified state published. Existing readers and durable local edits stay attached. An exhausted budget requires an explicit refresh/reconnect.

The workspace closes admission and clears the timer synchronously, then drains its existing epoch transition and admitted refresh before closing Scope/custody. A timer is unreferenced and cannot keep the CLI alive. The diagnostic sink remains observed and cannot reject background work. There is no new account/global fence or separate resource owner. Network deadlines remain with the cloud adapter; the attempt bound is not a claim of raw network cancellation.

Retrying only storage errors was rejected because a later independently verified source can repair a transient invalid/conflicting response without weakening verification. Retrying forever was rejected because persistent bad history must not produce unlimited requests. The facade still depends on Promise cloud/application orchestration, so this small fix does not claim a native migration or add a wrapper runtime; the existing registered Legacy boundary remains.

This changes the earlier M2 policy that validation/conflict required only manual refresh. Existing normal refresh and identity binding still determine acceptance.

## Evidence and limits

Real crypto/SQLite tests with fake clocks cover signature rejection, conflicting originals and an injected unclassified ingest defect. They assert exactly three automatic reads, no advancement of the verified head/count, continued seal refusal, successful explicit retry, successful background recovery and no reads after close. The original signature/conflict cases fail because no retry occurs. Existing real SDK save-queue cases remain, including revocation and epoch changes. Counts and checks are recorded in the PR.

No live cloud, real OS keystore, installed desktop, CLI bundle or production acceptance is claimed. Persistent corrupt local originals/pins require the separate recovery/identity-reset workflow; retries cannot manufacture trusted evidence.
