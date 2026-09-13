# Isolate and coalesce Streams token refresh

Status: implemented
Translation: current

[中文](2026-09-13-streams-token-refresh.zh.md)

## Abstract

Unauthorized callbacks previously discarded an existing refresh, amplifying token
requests across streams. The provider now shares pending work and uses the SDK's
actual rejected token to avoid invalidating a replacement. Credential changes fence
both network results and asynchronous cache publication. This is provider-local
coordination; the hosted issuer remains responsible for authorization and cache isolation.

## Decision and evidence

The owning [draft spec](../../../../specs/streams-token-refresh.md) describes the
contract. The installed Streams SDK supplies `previousToken`, so no timer-based
heuristic or transport rewrite is required. Global provider pooling was avoided
because its identity/lifetime boundary is larger than the existing provider.

Persistent cache namespaces now include the endpoint; ciphertext remains bound to
the issuing credential. Login resolution failures fail closed, including memory hits.
A synchronous generation check must follow asynchronous validation immediately
before publication: a login switch can otherwise run between those microtasks.

The existing auth test suite covers shared callback fan-out, late rejection,
credential switches, stale completion, microtask publication races and endpoint/
workspace isolation. Hosted cache implementation and deployment are outside this
public repository; the optional rejected-token field is backwards compatible.

## Follow-up: the rejection signal has to survive every hop

Adversarial review found two ways the signal was still lost, both now fixed and
covered by tests that fail without the fix.

The eager-sync Worker bridge reduced the transport's auth context to `reason`, and
the runtime built a fresh `createAuthCallback()` per invocation. With no
`previousToken` and no last-token memory the provider could not match the rejection
against its cache, so it returned the rejected JWT unchanged and the Worker's rooms
could only recover once the foreground transport happened to refresh, or the token
aged out. The reason and rejected-token fields now cross the Worker protocol and the runtime holds one
callback per provider, dropped wherever the provider is dropped.

Coalescing had the same effect in time rather than in space: a refresh already in
flight when a rejection arrives was sent without `rejectedToken`, and on success it
published its result and cleared the marker. An issuer returning its cached version
therefore reinstated the rejected JWT and the signal never reached the server. A
refresh now compares what it actually sent against the current marker, spends at most
one further request that carries the rejection — inside the same promise, so a
twenty-callback fan-out still costs one extra round trip — and never clears the marker
or persists a JWT while it is still the rejected one.

A second adversarial pass found the storage write still unfenced against the
marker. The decision to persist was taken before several async WebCrypto calls,
while the gate that runs immediately before `setItem` re-checked only the
generation — and `reset('unauthorized')` deliberately keeps the generation. A 401
landing inside that window cleared storage and the pending write then put the
rejected JWT back, so the next process hydrated it with no marker left to suppress
it. The gate now re-reads the marker too. The marker check is a single slot, so an
issuer that cycles between two tokens can still re-persist the older rejected one;
that self-heals on the next 401 and is not worth unbounded per-token state.

Credential isolation was deliberately left alone. Treating a rotated credential as
possibly-unchanged would need identity the provider does not have, so a rotation still
resets like a login change: it discards a live Streams token and fails in-flight
requests with a retryable error. That cost is accepted rather than traded for a weaker
fence.
