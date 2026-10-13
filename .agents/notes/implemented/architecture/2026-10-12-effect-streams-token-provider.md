# Native Streams token refresh ownership

Status: implemented
Translation: current

[中文](2026-10-12-effect-streams-token-provider.zh.md)

## Abstract

Streams token refresh used a provider-local Promise that fenced publication but
could not cancel or await actual refresh work. One Effect 4.0.2 kernel now owns
credential admission, shared refresh leases and encrypted-cache publication;
Promise callers use one explicitly named Legacy facade. Cancellation of one
waiter preserves other consumers, while replacement/close waits for actual I/O
and retains failed cleanup owners and their complete Causes. Renderer/durable
orchestration and daemon-wide shutdown remain outside this unit.

## Contract and decision

This partially replaces the implementation mechanism in the
[refresh decision](../bug-fix/2026-09-13-streams-token-refresh.md), preserving
its endpoint/workspace isolation, current-credential resolution on memory hits,
terminal 401/403 suppression, last returned token fallback and rejected-token
single slot. A refresh sent before a rejection can make one additional request;
all joined waiters share it. WebCrypto completion checks both the credential
and rejection fences immediately before storage write. Pure schema/encoding and
CRDT work remain ordinary functions. The [existing Spec](../../../../specs/streams-token-refresh.md)
stays draft; no new Spec, protocol, server or deployment is introduced.

The five lifecycle questions are:

- Trigger: a read resolves the current credential, then hits cache or borrows a
  provider-local refresh. Rejection only invalidates the matching served token.
- Owner: provider Scope holds admission/read fibers and an explicit child producer
  Scope; each caller owns its waiter and lease. Raw fetch/body, credentials at the
  registered Legacy boundary, and WebCrypto retain actual settlement receipts.
- Cancellation: waiter timeout/cancellation retires only its read; last-lease release
  aborts and joins the producer. Credential replacement/close cannot replace its
  ownership slot until cleanup is confirmed. Independent admission snapshots are
  fenced by resolution order and remain individually owned until they end.
- Handoff: synchronous generation/credential/rejection fences precede publication;
  close is memoized by Deferred. Failed close retains one receipt and the child
  Scope. Explicit `retryCleanup` joins retained resources before admission resumes.
- Failure/recovery: typed auth, HTTP/credential/response, deadline and interruption
  stay distinct. Native getToken/auth preserve typed auth failure; only the explicit
  Legacy old-protocol callback maps a nonempty all-auth Cause to undefined. Release
  defects retain raw owners; shutdown defects retain the provider and complete
  Cause, including simultaneous timeout/interruption and release failure.

An outer `tryPromise(getToken)` was rejected because it leaves Lody's Promise
coordinator intact. RcMap/FiberMap were considered but do not establish awaited
replacement or failure-preserving cleanup in pinned v4; this finite provider uses
Semaphore, Scope, Fiber and Deferred. Scope.make deliberately retains the child
until explicit successful close, rather than attaching an unbounded auto-close
that would hang after a bounded failed release.

Pinned source evidence: `effect@4.0.2`'s `internal/effect.ts` `raceAllFirst` resumes
with the winning Exit, while its loser-interruption join does not project that
loser's cleanup failure. Deadline therefore belongs on an observation of a read
fiber, followed by a separately owned interrupt-and-Exit join. Raw joins race an
interruptible settlement observer against Clock sleep; the raw operation itself
remains in the I/O registry after the bound. A second Scope.close does not share
its first finalizers, so the provider uses its own receipt.

## Consumers and boundaries

Native API: `LoroStreamsTokens` / `LoroStreamsTokensLive`,
`makeLoroStreamsTokenProvider`, and provider-specific `LoroStreamsTokenPorts`.
The official CLI composition's native token port requires Scope and supplies
native credentials plus signal-aware getCliHttpFetch. Acquisition registers ownership
without credential/cache/HTTP initialization, so its typed acquisition error remains
never; all first-read failures belong to getToken with the acquired provider retained.
Service/Layer/factory compose the same provider kernel/cache. Local ports still expose
no cloud token capability, and telemetry stays disabled.

Remaining consumers are renderer workspace/eager-sync auth, CLI durable
streams-access/streams-transport and Machine RPC. They use the one
`createLoroStreamsTokenProviderLegacy` facade and the visible platform
`createTokenProviderLegacy` port/type. The old unqualified factory and Promise
port entry are deleted. Renderer teardown joins close before dropping the
provider; the official CLI root retains Legacy providers through disposal,
retaining failed providers for recovery. Runtime and provider abort signals
are composed instead of overriding each other.

Delete the Legacy facade, compatibility credential adapter and provider-owner
registry once those callers and their application owners compose native Effects.
No upper caller or end-to-end daemon ownership is claimed native merely by using
this kernel. The root roadmap is maintained separately by the coordinator.

Auth context remains structural `{ reason: string; previousToken?: string }`.
Only unauthorized rejects a JWT. Explicit previousToken wins; each long-lived
callback otherwise remembers its own last successful token. Direct getToken has
no callback fallback. Late callbacks for an old token cannot invalidate a newer
cached token, and joining waiters share one extra request when needed.

Native `health` and `describeLoroStreamsTokenCause` expose only lifecycle, generation,
counts, presence flags, sorted failure kinds and 401/403 statuses. They omit tokens,
credentials, URLs, raw messages/stacks, Causes and owners. Nested retained Causes are
traversed iteratively with identity deduplication; original Causes remain intact for
recovery. A failed close/timeout leaves health observable, and successful cleanup
clears its blocked state. New providers in the same parent Scope have independent
close receipts. A retained release failure fences admission before any new credential
I/O, not only before producer replacement. This changes no P1-owned logger/presence files.

The raw HTTP receipt includes success-body EOF and error-body cancellation. A body
release rejection retains its owner and I/O failure; 401/403 also retain their typed
auth reason and terminal suppression. Cleanup reports an ended failed receipt before
retiring it; a later successful retry permits handoff. In pinned v4 tapCause uses
andThen(f(cause), failCause(cause)), so a failing observer replaces the original
failure. The synchronous event hook therefore uses an explicit Exit and Cause.combine,
verified through the real Legacy facade's auth-plus-observer failure.

## Evidence and limits

PR: [#1506](https://github.com/LodyAI/Lody/pull/1506) (draft).
Tested source revision: `32c5d29dcfdaf9330c36355d285d43e4e74906f9`. Subsequent documentation-only
changes record this revision.

Base: `3ac76bad10f46720517a2ca6929f03de4ef5bb9b`. Effect remains 4.0.2;
no manifest, lockfile or submodule gitlink changes. The existing token suite uses
explicit HTTP/encryption/admission signals and TestClock for native workflow
bounds, retaining real WebCrypto encryption/cache regressions. Two old tests
that admitted new work before old raw cleanup now assert the required handoff;
a callback-resolution-count race was replaced by explicit encryption fencing.
Mock-count-only assertions were removed; concurrent callbacks wait for real
admission before releasing HTTP rather than relying on Promise scheduling.

Validation: existing shared auth suite 53 passed; five CLI token/local-only/document
suites 44 passed; renderer runtime/eager/meta and cloud-policy suites 111 passed.
Final `pnpm check` completed typecheck and lint, then failed with 16 CLI tests
(4025 passed, 1 skipped). Fifteen persistent failures are in the unchanged CLI
child-process suites in `baguette-process`, `guest-buttons`,
`host-controls`, `github-git-transport` and `cloudflared-process`. An independent checkout of the base SHA with the same locked
dependencies and pinned ACP artifacts reproduced the same 15 failures, using
`pnpm --dir apps/cli exec vitest run` on those five files and `--testTimeout=5000`
to bound diagnosis. Failures include the inherited Git shim's `context_unreadable`,
unavailable simulator fixtures and cloudflared exit/cleanup timeouts. These are
baseline/environment failures, not changed token behavior. The remaining failure
is the unchanged roost goal-cache test's 30-second full-suite timeout; its complete
30-test suite passes separately on both this source and the base checkout. An earlier
full run also timed out an unchanged daemon fixture import hook; its isolated base
suite passes all 16 tests. These timing-sensitive suites are left unchanged. Electron
tests after the recursive test step did not execute. The shared suite now also covers lazy acquisition with typed credential failure,
native terminal/mixed Cause failure, safe diagnostics, explicit/callback-fallback
rejection semantics, retained health/recovery and successor cleanup in one Scope.
The native acquisition signature is explicitly constrained in source to never error.

`pnpm format`, `pnpm format:check`, explicit root Oxfmt on changed shared/docs
files, `pnpm run docs status`, `pnpm run docs check`, i18n, Code Collab, platform,
CLI process and public-boundary guards passed. Initial dependency/submodule and
restricted worker failures were resolved in this unit's clone; no global Git
configuration was changed. Verification children alone stripped inherited
`GIT_CONFIG_*` variables.

In a disposable overlay, baseline and restored auth suites passed. Removing
shared lease protection, raw settlement join, rejected-token storage fence,
late unauthorized matching, credential-after-encryption fence or full raw-owner
Cause aggregation each made its behavioral regression fail. The follow-up also
ablates native auth failure preservation, Legacy all-auth projection, diagnostic
redaction, credential admission, observer Cause combination, success/error-body joins
and release-owner registration (14 mutations total). Scripts and logs
remain outside the product/repository.
No live cloud/issuer, production service, npm publication, installed desktop,
Windows/macOS packaging, or whole Session/Turn/durable lifecycle is verified.
