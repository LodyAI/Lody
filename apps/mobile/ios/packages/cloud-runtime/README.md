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
Roost inputs. That wait depends on the owner, so it does not hold the session:
Stop, steer and edits stay available, and only later sends of the same session
wait behind it. It ends before the host's send deadline with
`previous_input_pending` and writes nothing; both hosts keep the message pending
and send it again with the same identity, as Web keeps waiting. A queue item remains in the control document until its guide input
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

## Native provider settings

`agentProviders` is the shared native provider-management contract. It takes the
workspace and authenticated user scope and supports `list`, `save`, `delete`,
`refresh`, `retrySetup`, and `deleteSetup`. Results contain machines (ownership,
live presence and setup support), providers, pending setups and the provider
catalog. Mutations access only the selected machine and return its provider/setup
rows as the write receipt. Hosts merge those rows by target machine instead of
replacing the workspace list. An unrelated machine's failed read cannot prevent
or obscure a successful target write. `list` reads all machines unless given an
explicit `machineId`; list errors remain errors, never a partial success snapshot.
Existing `remoteSettings` remains available, including the native hosts' separate
usage/quota presentation.

Fresh machine metadata authorizes every read or operation on private provider
settings; client-supplied read-only flags do not. List projections contain no env
values or authentication output. `agentProviderDetail` reads one persisted config
or pending setup, returns env key/presence metadata and safe endpoints, and gives
an opaque revision. Advanced edits require that revision. `envPatch` omits a key
to preserve its secret, writes a string (including empty) explicitly, and removes
with null. Runtime overrides use merge/remove or clear; title options use set or
clear. Unedited opaque fields survive. Codex profiles require the machine's
advertised capability, keep their account binding immutable, and reject launch or
environment overrides that could bypass their isolation. Native hosts keep new
secret drafts in memory and secure controls, never preference storage or logs.

Presets and credential modes reuse the Web editor's public definitions, including
fixed env, token prefixes, endpoint choices and custom-endpoint support. Runtime
paths are gated by provider type; the internal Codex profile sentinel is never
editable or exposed. ACP-owned session titles disable manual title settings,
except builtin Codex's existing Lody-owned title behavior. Machine results expose
creation-time Codex profile, authentication and Pi capability flags. Detail adds
provider-specific availability and unavailable-action reasons.

Builtin creation uses the capability-gated durable setup queue. DeepSeek Harness,
explicit runtime overrides, older machines without setup support, custom ACP and
known registry entries use the existing direct config path. Explicit custom
Save-and-test persists first, then `agentProviderProbe` invokes the real
`machine/acp-capabilities-refresh`; there is no temporary draft-probe protocol.
Pending setups remain daemon-owned: queued/verification waits, awaiting-auth uses
the persisted setup config ID, and failed setups may retry. `agentProvidersChanged`
notifies the target machine when safe provider/setup rows change. Hosts reload and
merge that target rather than replacing other machines or polling setup state.
Cancelling a setup persists its durable tombstone before cleanup. Removing the
last managed builtin records its opt-out and removes only its own quota rows.

`agentProviderAuth` owns in-memory flows. Start never replays the same flow ID,
including an unknown result. `method-required` with an interaction ID continues
through submit on that flow; without one, start has ended and a new UUID is needed.
Authenticated progress enters nonterminal `verifying`; only the final receipt,
with authentication no longer required and capability verification not failed,
completes sign-in. Codes, form values, method selection and consent use the
public ECDH-P256/AES-GCM secret envelope and exact flow/interaction AAD. Missing
keys never fall back to plaintext. URLs are restricted to HTTP(S); hosts must
submit required encrypted consent before opening the URL. No raw daemon stdout,
public-key material or incidental response fields reach native UI.

Scope changes immediately fence events and new operations, then await parallel,
freshly authorized remote cancellation with one ten-second budget. Unconfirmed
flow cancellations report `provider_auth_cancel_unknown`; they are not replayed.
A recovered metadata replica creates a new service owner even within the same
workspace/user. Transport, bootstrap and authentication lifetimes are bounded.

`agentProviderOperation` uses actual binary-status/install, Pi-extension and
provider-rate-limit RPCs. Binary creation accepts an allowlisted builtin or known
registry identity without a config ID; Pi creation sends an empty scan params
object. Other operations validate the fresh saved target. Catalog selection
never invokes these operations: native buttons initiate them. Progress is not a
completion receipt. Quota refresh requires protocol, query capability and account
eligibility, coalesces concurrent requests, verifies the response identity, then
reads the target MachineFlock into the retained replica and republishes its catalog.
The operation result contains no cached provider/quota snapshot.

Sorbet credential/provider remote management remains explicitly disabled with
`encrypted_feature_transport_unavailable` when advertised. Its Web facade uses
`requestEncryptedFeature` in `workspace-machine-rpc-facade.ts`, whose encrypted
feature transport is not exposed by the standalone native runtime. Ordinary ACP
authentication does not have that limitation. Do not substitute plaintext or
invent RPC methods for the Sorbet-specific feature boundary.

The registry catalog is a credential-free projection of the reviewed public
`packages/shared/src/acp/registry-generated.ts` identity table. Regenerate it with
`node --experimental-strip-types scripts/provider-catalog.mjs <source-file>`.
Regenerate presets with `node scripts/provider-presets.mjs <agent-config-dialog.tsx>`.
Both generated files record their source SHA; native builds use only the local
projections. Provider envelope fixtures live in
`contract/fixtures/provider-to-{runtime,host}.json`. The settings and provider RPC
suites cover real Flock mutations, secret redaction, revision fencing, authentic
cryptographic envelopes, progress/final ordering, cancellation uncertainty and
capability/identity checks with synthetic data and deterministic signals.

After changing this canonical package, Android must review and export a new
whole-package vendor snapshot with updated source provenance and file hashes;
do not patch the Android vendor copy by hand.
