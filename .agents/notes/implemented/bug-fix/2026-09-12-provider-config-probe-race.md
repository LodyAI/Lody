# Resolve provider configs before capability probes

Status: implemented
Translation: current

[中文](2026-09-12-provider-config-probe-race.zh.md)

## Abstract

The new-provider dialog could probe an invalid unnamed draft, while a valid newly
created provider could be probed before the daemon's Machine Flock replica observed
its row. Both paths surfaced the same misleading "Provider config not found"
message. Lody now keeps every probe disabled until the required name is present and,
on a daemon lookup miss, performs one bounded Machine Flock sync before re-reading
the config. A real absence still returns the existing error, so the recovery does
not turn probing into an unbounded wait.

## Problem and ownership

The settings dialog owns draft validity and must not dispatch work that the shared
config parser would reject. The daemon remains authoritative for probe inputs, but
the renderer and daemon observe Machine Flock through separate replicas: committing
the row locally does not prove it is already visible to the daemon.

The issue exposed both conditions during provider creation. An empty name disabled
Create only through a tooltip but left Test actions reachable, and a valid row could
still be absent on the daemon's first read immediately after the renderer commit.

## Decision

- Treat the trimmed provider name as a prerequisite for capability, custom-command,
  and runtime-override probes. The required field exposes an inline accessible error
  instead of relying on the disabled Create tooltip.
- Keep the daemon's persisted-config boundary. On the first miss, request one
  Machine Flock sync with a 1.5-second default timeout and no scheduled retry, then
  re-read the same config. Only the second miss produces the not-found response.

The timeout can be tuned with `LODY_PROVIDER_CONFIG_RESOLVE_SYNC_TIMEOUT_MS`, using
the same bounded timeout mechanism as other daemon synchronization paths.

## Alternatives and limits

Sending the renderer draft directly with the probe would avoid replica timing, but
would bypass the daemon-authoritative config boundary and duplicate validation.
Repeated polling could hide longer synchronization faults, but would delay every
genuine not-found result. One explicit sync and re-read addresses the creation race
without changing the durable error contract.

This change does not alter built-in provider registration. It also does not promise
probe success when Machine Flock synchronization itself cannot make the row visible;
that case continues to return the existing error after the bounded attempt.

## Verification

The dialog test proves an empty name presents the required-field error, disables the
header probe, and dispatches neither a config write nor a probe. The daemon test
starts with an invisible config, exposes it during the sync, and proves the second
read proceeds to capability discovery. The full focused dialog and session execution
test files pass locally.

Issue: [#652](https://github.com/LodyAI/Lody/issues/652).
