# Missing-history acknowledgements retain input identity

Status: implemented
Translation: current

[中文](2026-11-10-missing-history-acknowledgements.zh.md)

## Abstract

A single missing-history marker can forget a failed input when another timeout replaces it or a producer clears it. Late history or RPC then makes the failed identity eligible again. Session metadata now retains an append-only, host-owned `missingHistoryUserMsgIds` map alongside the legacy scalar. Only a fresh input identity resumes failed delivery; unrelated messages remain eligible.

## Decision and ownership

The serialized dispatch watcher is the only writer of this map. Its next timeout carries the legacy scalar into the map and adds the newly failed identity. The existing host-lease/process-exit contract excludes concurrent execution hosts; this is not a proof of concurrent whole-map LWW writes by different hosts. Producers publish their new activation without clearing recovery acknowledgements. A timeout captured for one activation cannot accuse a newer activation that arrives during recovery.

`isMissingHistoryUserTurn` reads both representations. Pending activation, history/RPC selection, preferred-input retirement, durable human admission, Roost activation and the renderer use that exact-ID predicate. The renderer can still offer a fresh send for each late non-terminal row. Advancing `lastHandledUserMsgId` was rejected because payload absence proves neither execution nor handling. Retaining only the newest failure was rejected because late inputs remain possible.

These are identity receipts, not diagnostic history. They contain only failed IDs and `true`; their storage grows with failed identities, without copying payloads. Arbitrary count/age eviction would authorize an old failed input again. They follow Session metadata retention/deletion, and are never readiness gates for other IDs or Sessions.

Inbox retry receipts remain private to the existing Effect scope. Each attempt retains its failed record, attempts independent siblings and returns the combined Cause. Background scanning reports that failure and continues; batch preparation is isolated per item. Interruption still ends scope-owned work. No new runtime owner or migration chain is introduced.

## Evidence and limits

The verification skill replays the unchanged recovery and selection methods with synthetic document ports: two failures retain both identities, late history/RPC stay excluded, clearing the legacy scalar does not revive either identity, and a fresh ID remains dispatchable. An old timeout does not mark a new activation. The same check fails when the map write is removed. Native Effect/SQLite fixtures cover independent retries, failed preparation/diagnostics, unknown non-replay and future Inbox inputs. These fixtures do not execute actual multi-device replication, cryptographic authorization, the host-lease producer, a native Provider or the complete UI.
