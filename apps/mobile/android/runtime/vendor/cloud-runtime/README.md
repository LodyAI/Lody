# Shared Cloud runtime

Browser-only Lody Cloud protocol used by the iOS and macOS offscreen WebViews.
There is no root export: mobile imports verified pure helpers and types through
explicit public subpaths; native asset builders bundle `src/runtime/index.ts`.
This package imports no application, React Native, Expo or platform bridge code.

`src/models` owns wire shapes; `src/protocol` owns pure projections and capability
rules. Catalog projection accepts fallback labels. The mobile facade supplies its
current locale; the isolated runtime retains its existing English defaults.
Mobile attachment drafts and the durable send scheduler remain mobile-owned.

`scripts/build.mjs` exports `buildDataRuntime(output)`. It builds a local-only
HTML document with the existing CSP and inline WASM and copies dependency license
text alongside it. Platform builders supply their own output directory.

Run `pnpm --filter @lody/cloud-runtime typecheck`. Existing behavioral fixtures
under `apps/ios/tests` now load these shared production sources, retaining
protocol, write ordering, uncertain delivery and recovery checks.

## Roost sessions

The Developer Mode / Roost History beta preference selects Roost for new sessions
only when the owner advertises `sessionHistory` v3, using the pinned upstream
`resolveNewSessionHistoryBackend` policy. The preference is off by default;
unsupported machines create Loro sessions. The resulting backend is written in
session metadata and never changed by this preference. New Tabs use the same
selection policy.

The session's metadata selects its history backend. For Roost, the runtime waits
for the owner and its `sessionHistory` v3 capability, and negotiates incremental
reads, watches and patches separately. An existing nonempty Loro history can open
without metadata after control-stream catchup; an explicitly Roost session or a
retired Roost cursor never takes that fallback. The pinned upstream Roost bridge
and history cache read and observe history, capture sharing snapshots, and submit
permission responses through the encrypted owner RPC. The control document
carries the shared queue and human-input receipts.

The iOS runtime package holds the authoring source in `vendor/upstream-roost`.
The iOS asset build verifies the generated `src/runtime/upstream-roost.js` against
that source. Android's runtime snapshot carries the verified module and licenses.
Ready Roost inputs use the same workspace input coordinator as Lody and its
account/workspace-scoped IndexedDB storage. It persists the exact input before
handoff, orders inputs by session and checks the owner after an uncertain
acceptance. If the owner reports the input unobserved, the coordinator may submit
the same immutable entry again. Guide delivery uses the upstream delivery code
and its durable delivery-started fence; it does not repeat a guide after that
fence. Queued inputs use the shared control-document queue and wait behind earlier
Roost inputs. A queue item remains in the control document until its guide input
is saved. The mobile runtime uploads the human-input receipt before the owner
handoff and retries a failed upload with the same input identity. A user can
retry the original input from the transcript after a failure, or cancel a pending
input while its session is syncing; an owner may already
have accepted it. Archiving or deleting a Roost session cancels its pending inputs through the shared
coordinator before changing metadata. Signing out does not erase pending input data.

The transcript opens with the latest owner page and requests older pages as the
reader scrolls. The full history directory is read in the background for send
configuration and turn counts. The upstream bridge applies negotiated patches,
repairs bodies at the owner checkpoint, and resumes observation from its local
cache. Both mobile runtime WebViews allow persistent browser storage for the
upstream cache and pending-input database. Sharing takes an authoritative owner
snapshot rather than exporting the loaded transcript window.

## Host contract

The host (iOS and Android) talks to the runtime only through
versioned JSON envelopes: `{v, gen, kind, id?, method, payload | error}` with
`kind` one of `request`, `result`, `error`, `event`. Every host↔runtime method
is on the contract; there is no other bridge. The runtime's only global is
`dataRuntime.receive(envelope)`, and it posts `ready` once followed by
`envelope` messages.

`src/contract` is the single source: schemas live in per-domain files
(`core.ts`, `sessions.ts`, …), each named with `.meta({ id })`, and `methods.ts`
only lists host→runtime calls (`runtimeCalls`), runtime→host calls
(`hostCalls`) and runtime events. `src/runtime/channel.ts` validates every
inbound payload and outbound result, enforces call timeouts, and adopts the
host generation from the `hello` handshake. `src/runtime/index.ts` owns the
bootstrap and catalog replicas; `src/runtime/handlers/*.ts` register the
`channel.handle` implementations by domain and receive the shared state as a
`RuntimeContext` argument.

`pnpm contract` writes `contract/runtime-contract.json` (JSON Schema) and the
generated Swift types in `packages/lody-core/Sources/LodyCore/Contract`;
`pnpm contract:check` fails when either is stale. Unions need a string `const`
discriminator; `z.unknown()` becomes `RuntimeContract.JSONValue`.

To add a method: define its schemas in a domain file and its table entry,
register the runtime side in the matching handler module (`channel.handle`) or
call the host with `channel.request` / `channel.emit`, handle it in the host
through `RuntimeChannel` (iOS: `DataRuntime+*.swift`, using `callForRN` when
the result goes to RN), run `pnpm contract`, and add its envelopes to
`contract/fixtures/to-runtime.json` / `to-host.json`. Both
`apps/ios/tests/cloud/contract.test.mjs` and
`swift test --package-path packages/lody-core` check the same fixtures.

## Conversation usage

Session summaries carry an optional `usage` display projection through the existing
session/sessionCache events: `context: {used,size} | null`,
`isContextCompacting`, `quotaEligible`, `quota: AgentQuota | null`, and optional
`modelId` / `modelLabel`. Context uses the session's `contextWindowUsage`; the
latest context-compaction tool determines compaction state, including completion.
The selected quota matches the session's exact Agent Config and model (named tier,
exact ID, Codex Spark, generic), gated by subscription-account eligibility and the
config's advertised rate-limit capability. Catalog changes refresh retained session
summaries, without another subscription, polling, or forecast service. Quota reset
values are epoch seconds, preserved even after expiry; native UI owns relative /
absolute formatting, never estimating a new balance from the clock. A local,
unsent model choice must not relabel a quota selected for another `modelId`.
