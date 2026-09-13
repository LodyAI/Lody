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

Replay adds nothing; model changes and compaction preserve counters. A new
accounting lifetime requires a fresh consumer accounting identity or a restored
baseline. Process-local state does not guarantee restart continuity.
Grok deduplicates prompt contributions across both completion channels and permits
monotonic late corrections. DSH counts committed per-request events using their
actual request route, not the currently selected UI model.

## Delivery and pricing

The CLI coalesces cumulative snapshots, including Grok. Failed payloads retain
their attribution until acknowledged; concurrent flushes share one drain. Delta
is neither added to totals nor forwarded to the legacy persistence endpoint.
Codex's legacy compaction handling stays separate.

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
- [Research correction](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.md)

Publish Core 0.1.5 before adapters requiring its accumulator, then rebuild/release
adapters before updating consuming gitlinks/artifacts. Local changes do not
publish packages, repair historical data, or prove deployed hosted behavior.
