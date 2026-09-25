# Usage snapshots and delivery

Status: draft
Translation: current

[中文](usage-delivery.zh.md)

When multiple requests finish before delivery, the latest accounting snapshot must
contain all their usage. Adapters own native counter semantics; Core owns the
contract; consumers persist cumulative snapshots, not a sum of notifications.
Local composition still disables cloud usage entirely.

## Contract

`modelUsage` is cumulative per model within one ACP accounting lifetime.
`usage` is the latest operation snapshot (legacy providers may differ).
Optional `delta` carries newly accounted aggregate/per-model buckets since the
previous emitted update, already included in `modelUsage`: never add both.
Delta delivery is not an exactly-once ledger. Cache reads/writes, ordinary input/
output and reasoning are disjoint. Unknown costs are omitted, not zero.

For adapter-owned ledgers, replay adds nothing; model changes and compaction preserve counters. A new
accounting lifetime requires a fresh consumer accounting identity or a restored
baseline. Process-local state does not guarantee restart continuity.
An adapter whose counters restart with its process marks each update with a Core
usage scope, `_meta.lody.usageScopeId`: `modelUsage` is then cumulative only within
that never-reused scope, and consumers sum scopes. Reusing one identity across a
restart is wrong, because the hosted per-key maximum hides the restarted, smaller
counters until they pass the old total.
Grok deduplicates prompt contributions across both completion channels and permits
monotonic late corrections. DSH counts committed per-request events using their
actual request route, not the currently selected UI model.

## Delivery and pricing

The CLI coalesces cumulative snapshots, including Grok. Failed payloads retain
their attribution until acknowledged; concurrent flushes share one drain. Delta
is neither added to totals nor forwarded to the legacy persistence endpoint.
Persistence projects only token/cost fields and aggregate contextWindow; search
request counts and model-level contextWindow are not forwarded.
For any provider, a scoped update uses `nativeSessionId:scope:encodedScopeId` as
the existing usage endpoint's accounting identity; unscoped updates keep the ACP
session ID. The actual ACP session ID and session metadata stay unchanged. Repeat
delivery of a scope stays idempotent without modifying hosted persistence.
Codex attributes native root-thread counter increments to the model frozen from
the submitted turn parameters. A native turn is one accounting lifetime and its
scope; for one release the CLI also reads the legacy Codex-only
`_meta.codex.usageTurnId` as that scope. This keeps A's earlier tokens out of B's
new turn.
Claude scopes each SDK result by its uuid, carrying only what that result added
to the query-wide reading; a new query() after restart or clear-context counts
from zero under new scopes.

Only the previous native snapshot and current turn are kept in memory. Restored
snapshots are comparison points; if missing, the first notification is skipped
rather than billing historical usage. There is no sidecar, persisted baseline,
historical model ledger or raw-response bookkeeping. Child usage is not added.
Resets, reroutes and crashes remain best effort, not an exact billing guarantee.
Unmarked adapters keep their old scope; the new adapter requires the matching CLI.

Kimi activation snapshots can provide delta without changing their cumulative
scope. Kimi source changes require a new managed artifact
before they affect the consuming runtime.
Provider costs are preserved; missing cache-write tariffs cannot be replaced with
cache-read prices. An empty aggregate does not imply a known zero cost.

Eligibility follows the builtin agent catalog, including DeepSeek Harness, not
the managed-download catalog. Receiving a provider's delta does not prove its
cumulative counters satisfy the lifetime contract; the
[builtin audit](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.md#builtin-audit-correction-2026-09-13)
records unresolved adapter normalization and resume/reset gaps.

DSH estimates official DeepSeek USD per request at the event's completion time,
using the published UTC weekday peak/off-peak schedule, then accumulates costs.
Unknown routes, custom endpoints or missing timestamps do not receive invented
prices. This dated list-price estimate is not an invoice; requests crossing a
pricing boundary may differ from billing. Unreported runtime activity cannot be counted.

## Evidence and rollout

- [Core contract](../packages/acp-extension-core/src/usage.ts)
- [DSH tests](../packages/acp-extension-dsh/src/usage.test.ts)
- [Grok tests](../packages/acp-extension-grok/test/proxy.test.js)
- [Delivery tests](../apps/cli/src/lib/usage/usage-tracking-service.test.ts)
- [Scope decision](../.agents/notes/proposed/bug-fix/2026-09-25-usage-accounting-scopes.md)
- [Research correction](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.md)

Publish Core 0.1.5 before adapters requiring its accumulator, then rebuild/release
adapters before updating consuming gitlinks/artifacts. Local changes do not
publish packages, repair historical data, or prove deployed hosted behavior.
Old experimental accounting rows and sidecar files are not automatically migrated.
