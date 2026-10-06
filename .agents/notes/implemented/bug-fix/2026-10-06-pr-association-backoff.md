# Bound retries for hosted PR association

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1266

[中文](2026-10-06-pr-association-backoff.zh.md)

## Abstract

A machine can read a PR through local GitHub credentials while its hosted workspace
cannot associate that repository. Every failed association left discovery due,
repeating cloud requests at the active polling cadence. The cloud association port
now shares a bounded workspace/repository cooldown across poller and turn-finalization
callers, while verified PR observations still publish. Recovery can wait up to
15 minutes and cooldowns reset when the client is recreated.

## Decision

Keep the boolean port contract: a rejected, pending or cooling-down call returns
false; it never confirms another session's linkage. Permission responses (401/403)
wait 15 minutes. Network failures and other HTTP failures, including older servers'
500 rejection responses, exponentially back off from one minute to 15 minutes.
Successful calls clear failure state but never cache authorization. Each request
has a ten-second abort deadline. No retry timer retains or replays an old input.
The map holds at most 256 failed repository scopes per authenticated runtime;
oldest-entry eviction can shorten cooldown at extreme cardinality.

This belongs in `cloud-pr-association.ts`, injected only by `cloud-cli-port.ts`:
it covers both callers without coupling GitHub observation to hosted availability.
Changing the scheduler's GitHub cooldown instead would delay valid PR/CI updates;
pretending rejection succeeded would suppress needed linkage recovery. Repository
scoping prevents many sessions for one unavailable repository from multiplying
requests; distinct workspaces and repositories retain independent gates.

This extends the [observation/association separation decision](../../proposed/bug-fix/2026-10-01-pr-observation-association.md).
The [observation Spec](../../../../specs/local-github-pr-observation.md) remains draft.

## Verification

Deterministic injected-clock tests cover permission cooldown, transient exponential
backoff and cap, success reset, scope isolation and concurrent-session safety.
Existing poller tests cover continued publication on association failure.
No live GitHub authorization changes or production deployment were performed.

The full CLI suite passed 3482 tests (four skipped), components passed 4782,
and backend passed 627 in the embedding workspace; root typecheck and lint passed.
Cloud CLI bundling at the required 2 GB heap limit exhausted JavaScript heap;
full-workspace build also exhausted heap during mobile bundling. Packaged artifacts
remain unverified; no unrelated build changes were made.
