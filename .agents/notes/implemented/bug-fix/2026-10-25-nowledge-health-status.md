# Nowledge Mem health status compatibility

Status: implemented
Translation: current

[中文](2026-10-25-nowledge-health-status.zh.md)

## Abstract

Lody rejected successful Nowledge Mem health responses with top-level `healthy`,
blocking identity listing, creation and updates. The adapter now accepts `ok` and
`healthy` only after a successful command exit. Empty successful inventories remain
`ready`; failed probes cannot authorize identity mutations. Remote service behavior
is supported by the report in [#1871](https://github.com/LodyAI/Lody/issues/1871),
not an end-to-end remote verification in this checkout.

## Decision and evidence

The [original provider boundary](../feature/2026-10-04-agent-role-memory.md) stays
in place. Only the health value comparison changes; missing executables, invalid
JSON and nonzero exits retain their existing classification. The draft
[Spec](../../../../specs/agent-role-memory.md) corrects its overly narrow `ok` wording.
Local nmem 0.10.107 returned top-level `ok`; its nested graph-store `healthy` is
not a provider health input. Plugin installation inspection is a separate concern.

This fix changes pure response classification, not process ownership or cancellation.
Native Effect migration was assessed and deferred: migrating the Promise adapter
and its consumers would not improve this compatibility fix. Existing process and
login-shell Legacy boundaries remain unchanged.

## Validation

The owning adapter suite covers both health values for empty listing, enrollment
and updates, plus rejection of nonzero exits without identity mutation.
All 11 cases pass with Vitest 5.0.2 and Zod 4.3.6 in an isolated temporary harness:
the real adapter, request schemas and owning suite run with unused process imports
replaced by throwing guards. The same suite against the pre-fix adapter fails the
three `healthy` listing/create/update cases. No remote credentials or real identities
are modified. Oxfmt passes for both changed TypeScript files; docs check retains
84 baseline errors with no additions. Full workspace type/build checks were not run
because this checkout has no installed dependencies.
