# Loro / Durable Streams ledger adapters

`@lody/e2ee-core/adapters/loro-streams` implements the two backend ledger
ports over one control stream of u32be-framed signed records. Both take the
released streams-client 0.9 shape structurally: the caller owns the SDK
package and client, URL, credentials and timeouts. Nothing here starts a
Runtime, timer or background fiber.

| Export | Port | File |
| --- | --- | --- |
| `streamsLedgerLog(options)` / `makeStreamsLedgerLog` | `LedgerLog` | `ledger-log.ts` |
| `streamsLedgerFeedSource(stream)` / `makeLedgerStreamReader` | `LedgerFeedSource` | `ledger-feed-source.ts` |

## LedgerLog: full audit and CAS

`read` always audits the complete original history from offset `-1`: fixed
genesis, real signatures and continuation of the previous genuine read. It
validates the endpoint, which the caller selects independently through
`checkpoint()`, before keeping the corresponding opaque offset. Remote headers,
last hashes and up-to-date flags never select checkpoint trust. A budget
failure, corrupted history, incomplete or cyclic positions, or closure never
replace that mapping. Empty pages cannot jump position. Budgets allow up to
one million records / 64 MiB; SDK 0.9 buffers responses upstream, so these
bounds do not cap SDK allocations.

The concrete `read` also returns the genuine `view` from the same audit. The
generic `LedgerLog` port exposes only records and checkpoint, and
`LedgerSubmission` verifies them independently.

`appendCas` requires a matching verified mapping, an ordinary signed record
that extends that history, and original u32be framing. There is no retry
producer, unconditional append fallback or offset ordering. A mismatch,
unsupported response or uncertain acknowledgement is a `LedgerLogError`. Even a
successful append leaves the mapping unchanged: `LedgerSubmission` reads back
and decides Committed or Conflict.

## Cancellation

The reader cancels AbortSignal-enabled reads and awaits their settlement. SDK
0.9 `appendCas` has no per-call AbortSignal, so the adapter keeps and awaits the
exact request on interruption or Scope close and rejects late completion.
Bound the SDK's timeouts. Close this Scope before destroying the borrowed SDK.

Tests (`test/submission/streams.test.ts`) use the real registry SDK, a loopback
synthetic HTTP gateway and real SQLite, including another OS process reopening
the journal. They are not deployed-backend acceptance.

## Ephemeral presence

`makePresenceContentBinding` binds purpose 7 to a caller-selected workspace resource.
It checks genuine current membership before and after cryptography, verifies the
signature before reading an epoch key, checks its published commitment, and wipes
owned keys/plaintext. Its open callback borrows plaintext only for that callback.
The caller owns body schemas, machine/viewer identity, replay and TTL. Closing its
Scope retires admission and drains active operations. This uses no document stream.
