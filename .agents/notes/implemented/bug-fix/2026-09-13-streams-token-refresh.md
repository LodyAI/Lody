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
