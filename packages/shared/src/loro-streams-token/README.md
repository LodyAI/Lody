# Streams token provider

`../loro-streams-auth.ts` retains ordinary Zod schemas, encoding, and the genuine
WebCrypto/fetch boundary. `service.ts` owns native credential admission, refresh,
cache publication, shared leases and cleanup. `io.ts` retains raw Promise receipts
until real settlement. `legacy.ts` is the sole deprecated program executor.

`makeLoroStreamsTokenProvider(options)` requires `LoroStreamsTokenPorts` and Scope;
`LoroStreamsTokensLive(options)` builds the equivalent Service. Supply one ports
instance per provider. `LoroStreamsTokenWebLive` composes native credentials,
signal-aware fetch, Clock with the server offset, and optional encrypted storage.
Tests may inject native ports without replacing the coordinator. `requestTimeoutMs`
bounds a waiter, including credential resolution; `cleanupTimeoutMs` separately
sets the base for bounded cleanup (defaults: 30 seconds and 5 seconds).
Raw joins use the base; producer observers allow twice that base and read observers
three times it so the inner bounded finalizer can report its complete Cause first.
Injected raw ports must use a cleanup bound no larger than that base.

The exported native signatures are:

```ts
interface LoroStreamsAuthContext {
  readonly reason: string;
  readonly previousToken?: string;
}
type LoroStreamsTokenReadFailure = LoroStreamsTokenFailure | Cause.TimeoutError;
type LoroStreamsTokenAuth = (
  context?: LoroStreamsAuthContext
) => Effect.Effect<string, LoroStreamsTokenReadFailure>;
// makeLoroStreamsTokenProvider(options)
//   : Effect.Effect<LoroStreamsTokenProvider, never, LoroStreamsTokenPorts | Scope.Scope>
// LoroStreamsTokensLive(options)
//   : Layer.Layer<LoroStreamsTokens, never, LoroStreamsTokenPorts>
```

`getToken` and `createAuthCallback()` both use `LoroStreamsTokenAuth`: terminal
credential rejection remains a typed failure. Acquisition does not read credentials
or storage, hydrate a cache, or request HTTP; initialization belongs to the first read,
so construction has no typed initialization failure. Service, Layer and factory all
build the same kernel and cache.

Only `reason === 'unauthorized'` rejects a token. Explicit `previousToken` takes
precedence; a long-lived callback otherwise uses its own last successfully returned
JWT. Direct `getToken` has no callback fallback. Unknown/other reasons use ordinary
admission. A late rejection invalidates only the matching cached JWT, preserving a
newer token. Waiters joining an already-sent refresh share its single extra request.

Each get owns an admission/read operation and borrows one lease on the shared
refresh. Cancelling one read does not cancel another lease. Last-lease release,
credential replacement and close stop the producer and inspect its actual Exit.
A raw operation that ignores abort keeps its owner and blocks handoff, even if
its Effect fiber has finished with a release defect. `LoroStreamsTokenReleaseFailed`
retains raw settlement/abort capabilities; `LoroStreamsTokenShutdownFailed` retains
the provider and complete Cause. Call `retryCleanup` to join retained work before
retrying handoff/close. Concurrent close shares one Deferred receipt; failed close
keeps that failure until explicit successful recovery. Parent Scope close reports
the same failure and does not silently release the retained child Scope.
The Promise facade's repeated `invalidate()` after close begins is a no-op,
including after a failed close. It cannot resurrect admission or erase a failure;
callers still await `retryCleanup` and the close receipt before replacing the owner.

The optional cache stays encrypted and partitioned by endpoint/workspace, with
credential and rejected-token publication fences. Its storage/crypto failures remain
cache misses, while interruption and cleanup failure propagate. Only the explicit
Legacy facade's old-protocol callback maps a nonempty Cause consisting entirely of
credential auth failures to undefined. Mixed Causes remain failures without dropping
their non-auth reasons; native callbacks never perform this projection.

`provider.health: Effect.Effect<LoroStreamsTokenHealth>` snapshots lifecycle,
generation, read/lease counts, raw-work/cache presence and terminal auth status.
Failed cleanup remains visible after a waiter timeout; successful `retryCleanup`
clears the blocked state. Each provider has its own close receipt, including successive
providers in the same parent Scope. `describeLoroStreamsTokenCause(cause)` returns
sorted failure kinds and 401/403 statuses, including nested shutdown/release Causes.
Both diagnostic outputs omit credentials, JWTs, URLs, messages, stacks and recovery
owners. Preserve the original Cause separately for recovery; log the safe summary.

Renderer workspace runtime, CLI durable transports and Machine RPC still use
`createLoroStreamsTokenProviderLegacy` / `createTokenProviderLegacy` (the CLI ones borrow
a shared workspace kernel, below). Renderer
teardown awaits this provider's close, retaining it on failure; the CLI official
cloud composition retains Legacy providers until cloud-port disposal. Native
`CloudStreamsTokenPort.createTokenProvider` places ownership in its caller's Scope.
These are token-provider owners, not completion of upper runtime/daemon shutdown.

The HTTP receipt includes success-body JSON/EOF and non-2xx body cancellation.
Close cannot retire it at headers. Error bodies are cancelled without reading their
contents. A rejected body release retains its owner and original I/O failure; a
401/403 also keeps the terminal auth reason/suppression. Cleanup first reports an
ended failed release before retiring that receipt; a later successful retry permits
handoff. Synchronous onEvent observer failures are combined with the original
Cause. Async diagnostics belong in the caller's owned Effects using the safe API.

Decision, alternatives and evidence:
[owning Note](../../../../.agents/notes/implemented/architecture/2026-10-12-effect-streams-token-provider.md).

CLI workspace presence creates one native provider in its workspace Scope. Durable
Streams and machine monitor use `createLoroStreamsTokenProviderLegacy({ provider,
executor })` with that provider and the existing application runtime; this mode
creates no runtime or cache. Its close ends the provider after all cloud sinks
are detached, and never disposes the borrowed executor.

In the official CLI cloud port every such provider, and the Machine RPC Legacy
provider, is a view of one kernel per workspace (`apps/cli/src/lib/loro/streams-token-shares.ts`),
so a cold start or reconnect makes one token request. A view's close fences and
interrupts only its own reads; the last view closes the kernel, whose failed close
still reports the kernel as recovery owner. Release failures and terminal auth of
the shared kernel are visible to every view; a view that joins a terminally rejected
kernel first invalidates it once, so a reattach after access is restored is admitted
as a fresh kernel would be. Every view read first drives the kernel's shared bounded
`retryCleanup` when a release failed (one immediate rerun only after an ended
failure was reported and no raw work remains), and a view's `retryCleanup` finishes
its failed last close without releasing its lease twice. Renderer callers still use the owned
options until their application ownership migrates.
