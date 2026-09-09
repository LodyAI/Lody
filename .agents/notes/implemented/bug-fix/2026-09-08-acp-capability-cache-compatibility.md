# Preserve ACP capabilities across cache versions

Status: implemented
Translation: pending

## Abstract

A newer renderer discarded a successful GPT-6 capability probe from an older local daemon because
their cache versions differed, then silently showed a static model list. Capability readability is
now independent from refresh freshness: parsed entries keep serving understood data while version
or source checks may still schedule a replacement probe. Runtime-override source matching remains
strict, and structurally invalid data remains rejected by the existing parsing boundary.

## Decision

- `cacheVersion` remains an exact-match freshness signal so startup and explicit refresh paths can
  converge old entries to the current representation.
- UI selectors, available commands, and runtime-probe authority consume any successfully parsed
  entry, including entries with missing, older, or newer cache versions.
- Version-specific readers adapt known incompatible fields instead of rejecting the entry. The v7
  reader omits the pre-v7 non-Codex reasoning map whose bracket suffixes could describe context
  windows rather than effort, while retaining that entry's models and other capabilities.
- Runtime override matching remains an applicability gate independent of cache freshness.
- Updating static model tables was rejected as the fix because it would only mask the same failure
  for the currently known models and leave all other probed capabilities vulnerable to version skew.

## Evidence and limits

Local logs showed the Codex adapter returning GPT-6 and syncing the Machine Flock row successfully;
the stored config-scoped row carried cache version 6 while the renderer expected version 7. Unit
coverage separates readability from freshness and exercises missing, older, and newer version
markers. This does not make unknown future fields readable: entries must still pass the client's
wire or storage schema. See the [draft compatibility contract](../../../../specs/acp-capability-cache-compatibility.md).

## Cursor picker integration

PR [#344](https://github.com/LodyAI/Lody/pull/344) adds a protocol-specific exception: an
upgraded registry Cursor daemon launches clean model IDs, so its pre-picker rows are incompatible.
The shared readable entry helper takes the owning Machine and rejects those rows, while retaining
marked rows across cache versions. A legacy daemon still accepts its unmarked rows. Selectors,
commands, Role availability, and CLI dispatch share this rule. CLI refreshes the incompatible row
and waits for the complete Flock publication before accepting its catalog.

Renderer refresh catch-up uses that same owning-Machine boundary. A successfully read legacy
Machine without the picker capability may immediately overlay Cursor's complete RPC response when
its Flock replica is still behind. A picker-aware Machine keeps the complete Flock row instead,
because the compatibility RPC response omits the per-model catalog; missing or unreadable Machine
metadata also preserves that row without turning an already successful refresh into an error.

Keeping exact cache-version checks in those readers would restore the original version-skew
failure; accepting all Cursor rows would instead dispatch legacy variant IDs to the new picker.
Regression tests cover both boundaries with synthetic cache rows, stale replicas, metadata failure,
and explicit publication signals.
These tests do not establish compatibility with a live Cursor service or Windows desktop runtime.
