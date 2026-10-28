# Encrypted Streams dispatch with durable fallback

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-streams-dispatch.zh.md)

## Abstract

Encrypted remote turns previously waited for history and Meta synchronization.
This implementation adds a bounded encrypted Streams receipt channel while
retaining the durable delivery path. Trusted hosts retain original signed frames;
both arrivals reuse the same execution claim and current ledger authorization.
Receipt ACKs never count as successful execution. Local behavioral checks pass;
a loopback comparison is measured, while packaged two-device acceptance remains unverified.

## Decision and ownership

The approved [foundations](../../../../specs/e2ee-foundations.md) define purpose
8/9, strict machine resource encoding and the complete 1 MiB frame limit. The
[pure body codecs](../../proposed/architecture/2026-10-28-e2ee-realtime-body-codecs.md)
are integrated here; their pending wire-approval prerequisite is superseded by
the approved foundations. No iroh channel is introduced.

The native host seals one dispatch request and saves its ID, signer, target and
exact ciphertext in an immutable SQLite store before returning it. Browser code
persists that original in the encrypted session document before sending. Durable
history/Meta activation remains enabled even when native preparation or transport
fails. A retry reuses the stored original and rejects conflicting turn reuse.
The renderer gets no signing key or generic signing operation.

The target authenticates and binds the request to its machine and current member
signer. Its receipt journal retains the original ACK before publication and can
replay it after restart. Receipt and actual execution use separate journals: the
existing `agent-start:<userTurnId>` gate from #1992 checks the verified original
and authorizes through the host before starting. A receipt does not complete that
execution claim. Ambiguous execution remains uncertain instead of executing twice.

Native Effect scopes own crypto leases, bounded queues and shared stream readers.
Timeout returns to durable delivery after 800 ms without regenerating a request.
One request's verification, storage or delivery failure remains local. Reader
close aborts and awaits the underlying SDK operation before credential release;
failed native store cleanup retains its handle for retry. Evidence is not garbage
collected in this implementation.

## Evidence and limits

Synthetic real-key/SQLite tests cover retained requests, target/signer/digest
binding, exact ACK replay, conflicting intents, authorization failure, shared
actual-start claims, timeout/resend and scope closure. The new shared-channel
close assertion failed with two active raw reads before the cleanup fix and
passes after it. UI tests preserve encrypted document originals and durable
activation on success and failures. Existing runtime/registration checks and
affected package typechecks were run locally; hosted CI has not been awaited.

## Controlled latency comparison

The [manual benchmark](../../../../apps/cli/scripts/benchmark-e2ee-rpc.ts) ran
100 alternating samples per mode after ten warmups on Node 24.22.1, against the
pinned local `loro dev` gateway with SQLite WAL and HTTP/1. All 200 measured
requests reached their synthetic handler and returned accepted ACKs. The sender,
receiver and gateway use loopback; real encryption, signature verification,
original persistence and the production `agent-start` claim remain in the path.
The authorization callback returns a warm synthetic Authorized result.

| Milliseconds                             |   p50 |    p95 |    p99 |
| ---------------------------------------- | ----: | -----: | -----: |
| Ordinary send → synthetic handler        | 0.729 |  1.134 |  3.572 |
| Encrypted send → synthetic handler       | 8.832 | 11.182 | 11.692 |
| Encrypted prepare + original save        | 2.545 |  2.978 |  3.289 |
| Encrypted send → append start            | 2.569 |  3.010 |  3.329 |
| Append start → target receive            | 0.535 |  0.824 |  2.851 |
| Target receive → verified                | 0.899 |  1.044 |  1.086 |
| Verified → receipt journal               | 2.165 |  2.675 |  2.849 |
| Receipt journal → actual-start journal   | 2.712 |  3.408 |  3.520 |
| Actual-start journal → synthetic handler | 0.007 |  0.015 |  0.017 |

Percentiles use nearest rank; segment percentiles are not additive. Each sample
also records append completion. The send timestamp precedes native preparation,
not just the network append. Ordinary dispatch uses the existing machine RPC
client/server and the same valid synthetic input. Plain workspace envelopes are
unchanged by the implementation.

This is a component comparison, not the one-second product acceptance. UI,
encrypted-document commit, watcher scheduling, Electron IPC, authenticated cold
ledger refresh, WAN conditions and actual ACP/model startup are absent. No paired
packaged Electron/CLI agent environment was exercised; therefore real
send-to-agent-start p50/p95/p99 remains unmeasured. The fixture handler is entered
after the production claim, without representing a running agent.
