# Let only the authoritative workspace list refuse local machine pairing

Status: implemented
Translation: current

[中文](2026-10-30-e2ee-pairing-first-workspace-list.zh.md)

## Abstract

A desktop that creates an encrypted workspace while **Run local agent** is off, then turns it on and selects **Enable local agent**, was refused with `e2ee_local_agent_unavailable`. The new CLI daemon boots from its local workspace catalog, which has never seen that workspace, reports `ready`, and answers local pairing before the first authenticated workspace list is applied. Fleet's account/workspace/genesis check treated that cache miss as `e2ee_binding_conflict`. Pairing now waits for the first authoritative list outcome only when the cached entry is missing or names another genesis, then applies the unchanged check; a cached match still proceeds without network.

## Decision

`LodyFleet.dispatchLocalE2eePairing` keeps its precondition: the Fleet account, an `e2ee` workspace in `desiredWorkspaces` and an equal genesis hash. When that precondition fails, it awaits one per-process signal settled by the first applied remote list (success or failure), a token or identity rejection, a subscription error, or shutdown. It then rechecks stop, reset and the same precondition; any mismatch still fails with the original error. Prepare and activate share the gate because both cross the same check.

Machine registration is not involved. The server's CLI list includes encrypted workspaces by account membership, and an unpaired encrypted workspace intentionally stays out of `connectedWorkspaces` while waiting for pairing. This was a readiness race, not a circular dependency. It exists since [#1814](https://github.com/LodyAI/Lody/pull/1814) added the Fleet guard on top of the earlier local-first bootstrap, which sets `startupStage=ready` before the subscription.

## Alternatives

- **Report daemon readiness only after the remote list.** This delays every desktop startup and offline use for one pairing path, and the local-first bootstrap exists to avoid that.
- **Retry in Electron or the renderer.** The CLI owns the authoritative list and can wait for it locally; a caller retry loop guesses timing and turns a real binding conflict into repeated requests.
- **Accept the catalog or the request's genesis.** Either weakens the binding check that pairing relies on.

## Failure containment

- **Trigger:** every cold daemon start with an encrypted workspace that its catalog lacks, until the first list arrives.
- **Spread:** only local prepare/activate requests whose precondition fails wait. Cached matches, other control routes and workspace startup are unchanged.
- **Deadline:** the signal settles on every first-list outcome and on shutdown. If none arrives, Electron's 30-second local-control timeout reports `e2ee_local_agent_pending`, which the UI already treats as retryable.
- **Results:** a waited request only proceeds after the authoritative list matches. Nothing is cached, and no binding is accepted from the waiting state.

## Verification

`apps/cli/tests/lody-fleet-local-catalog.test.ts` (`LodyFleet local E2EE pairing during startup`) starts a Fleet with an empty catalog and a held subscription. It shows the request waits and then prepares after the list arrives, and that an omitted workspace, another genesis or a rejected token still refuses it. The native preparation is stubbed there because its custody behavior is covered by `apps/cli/tests/e2ee-runtime.test.ts`. The packaged two-desktop journey with a real Secret Service has not been rerun with this change.
