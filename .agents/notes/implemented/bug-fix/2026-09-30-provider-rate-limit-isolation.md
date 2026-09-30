# Provider-scoped rate-limit snapshots

Status: implemented
Translation: current

[中文](2026-09-30-provider-rate-limit-isolation.zh.md)

## Abstract

Multiple Codex Providers on one machine displayed one shared quota because the
rate-limit path identified only the agent type and limit tier. Rate-limit events,
Machine Flock rows, and UI selection now retain the owning Provider configuration
id. Legacy unscoped rows remain readable only for legacy sessions without a
Provider binding, which favors missing data over false account attribution during
mixed-version operation.

## Problem and ownership

The account-profile implementation isolated credentials, Codex homes, and launches,
but retained the earlier Machine Flock key `rateLimit / cliType / limitId`. Every
built-in Codex Provider has `agentType: codex`, so its latest update replaced the
same row. Settings and composer consumers then selected that row by agent type and
rendered it beside every Codex account.

The host Provider configuration is the durable identity for this product surface.
The optional upstream `scope.accountId` is retained as provider data but does not
replace the host binding: it is not required on every snapshot and is not the
catalog identity used to launch a Session.

## Decision

Session rate-limit callbacks carry the frozen `agentConfigId` through the daemon
write path. New Machine Flock rows use
`['rateLimit', agentConfigId, cliType, limitId]`; the renderer's flattened key also
retains the configuration id. Provider rows, new-session composers, and existing
bound Sessions select only an exact configuration match. Deleting or cancelling a
published Provider removes only that Provider's scoped rate-limit rows.

Readers still accept the old three-part row. A Session without an `agentConfigId`
may read that legacy row, but a bound Provider never falls back to it. Older peers
ignore the additive four-part key; newer peers connected to an older daemon may
temporarily show no quota for a bound Provider instead of showing another account's
quota. No credential, upstream account id, or secret enters the key.

## Verification and limits

Shared tests cover scoped-key round trips, legacy parsing, two independent Provider
snapshots, and deletion cleanup. Component tests render two Codex Provider rows with
different quotas and prove that the legacy shared value appears in neither row.
Shared, Components, and CLI typechecks pass, together with the targeted behavioral
suites. This does not synthesize account ownership for previously written legacy
rows; they age out of bound Provider surfaces when the new build is used.

Current behavior is specified in
[Codex account profiles](../../../../specs/codex-account-profiles.md).
