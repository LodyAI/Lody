# On-demand Provider quota refresh

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1535

[中文](2026-10-13-provider-quota-refresh.zh.md)

## Abstract

Composer and Agent settings previously displayed quota without asking for a current reading. Lody now projects Core's existing `rateLimits` capability into its Provider cache and requests an independent quota read when eligible UI becomes visible. A daemon-owned, short-lived ACP process initializes and queries without creating a conversation. Failed or ambiguous empty responses preserve cached quota; authoritative snapshot replacement and freshness timestamps remain deferred.

## Contract and ownership

Core already defines `_lody/rate_limits/get` and `{version: 1, query?: true}`. No Core, adapter, managed artifact, or dependency pin changes are required. Display requires the declaration; refresh additionally requires `query: true` and Machine protocol `providerRateLimitsRefresh: 1`. Push-only providers can display existing quota. Builtin environment/brand overrides and Codex API-key profiles remain ineligible; custom ACP providers own their declared account semantics.

The UI hook refreshes on visible composer/provider activation, foreground return, and popover opening. The workspace runtime coalesces requests and uses its existing local-control or Machine RPC route, then reconciles existing Flock handles. There is no polling, new subscription, guessed percentage, or loading overlay.

The RPC accepts only a persisted config ID plus routing identifiers. The daemon freezes that config, resolves the same launch/profile credentials, and runs initialize followed by the Core query. Terminal, filesystem, permission grants, and session creation are disabled. Installed builtin runtime checks avoid automatic builtin installation; custom/registry commands retain their existing launcher behavior. The owned process is terminated before success. An unconfirmed cleanup quarantines that Provider until daemon restart rather than launching replacement processes.

Requests share a Provider/config-fingerprint owner: 15-second successful TTL, 5-second failure backoff, and bounded settled metadata. Existing ACP startup admission controls launch concurrency. A changed config waits for the previous raw operation to settle. UI unmount does not terminate shared work. Query timeout is 20 seconds after process startup, within a 45-second overall signal.

## Persistence and ordering

Both push and pull use the existing Provider-scoped quota writer. A push revision fences late query results; config identity is rechecked before publication and inside the serialized Flock writer. Custom agent identifiers now round-trip in Provider-scoped keys, while legacy keys keep their builtin validation. This preserves the [Provider isolation decision](../bug-fix/2026-09-30-provider-rate-limit-isolation.md).

Claude/Kimi v1 adapters can encode upstream failures as empty snapshots. Consequently an empty query returns unsuccessful and preserves existing rows. Nonempty replies upsert reported buckets; absent buckets are not deleted. No new freshness timestamp is persisted or displayed. Strong empty/error semantics and full snapshot replacement require a separate adapter contract change.

## Alternatives and lifecycle assessment

A live conversation connection could avoid cold startup, but would couple cancellation and credential identity to conversation ownership. This implementation always owns a separate read-only connection. Core retains shared protocol definitions and adapters retain vendor requests; Lody does not read vendor credentials in the UI.

The Effect feature/fix assessment found ACP launch, startup gate/transport, and Loro coordination still expose Promise lifecycle boundaries. A native migration would require those unfinished dependencies and exceed this unit. The cache remains a small explicit Promise owner; this is not claimed as a native Effect migration. Broader lifecycle work stays in the [migration roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md).

## Verification limits

Deterministic tests cover initialize/query without a session, capability negotiation, request coalescing/backoff, configuration and push races, cleanup quarantine, strict local routing, Machine RPC responses, custom Provider keys, and UI capability gating. No live credentials, quota endpoints, or model prompts were used.

The checkout has existing runtime metadata mismatches (Codex 0.159.2 versus 0.160.1, Claude SDK 0.3.284 versus 0.3.293, Grok 1.0.40 versus 1.0.46). CLI behavior suites were also run with temporary metadata-only test fixtures; production checks and shipped pins remain unchanged. The PR records normal checks separately from fixture-assisted tests.
