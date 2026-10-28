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
packaged two-device acceptance and latency comparison remain unverified.

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

These tests do not establish packaged Electron/CLI two-device behavior or the
one-second latency target. Trace markers identify send, append, target receive,
verification, receipt journal, actual-start journal and handler start. A local
loopback gateway has been started for a separate controlled comparison; no
latency result is claimed by this commit. Plain workspace envelopes are unchanged.
