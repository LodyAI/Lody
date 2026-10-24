# E2EE M2 product integration

Status: proposed
Translation: current
- Date: 2026-10-22
- Chinese: [中文](2026-10-22-e2ee-m2-product-integration.zh.md)

## Abstract

Encrypted workspaces need a complete desktop-to-machine path rather than isolated crypto adapters. The implementation keeps device and document keys in their host owners, opens existing local state without waiting for cloud authentication, and uses device credentials for the optional cloud control plane. Ordinary workspaces retain their existing composition. The owner resolved the integration contracts in the second-round M2 plan. This implementation still requires the end-to-end and real-platform evidence below before M2 acceptance.

## Boundaries

- An encrypted account runtime is lazy. Ordinary workspaces neither open its custody nor construct the E2EE cloud client.
- Offline identity is only a token-hash/account binding in the existing auth store. It selects local data indefinitely, is cleared on definitive rejection/logout, and grants neither cloud access nor ledger permission. Network uncertainty retains it. The platform keeps its ordinary unauthenticated status, with an uncertainty hint consumed only by E2EE to try native identity after the seven-day bootstrap snapshot expires.
- Credentials are independent random 32-byte access secrets, retained under a distinct KEK purpose bound to genesis and signing public key. Their public SHA-256 is immutable across creation retries. Device and epoch-key formats stay unchanged. Old developer creations without credentials must be recreated; there is no migration.
- Main owns signing and content encryption. Renderer IPC exposes room-bound seal/open, never arbitrary signing, device credentials or document keys. Local status exposes credential availability only; missing credentials suppress machine approval and native preparation rejects before touching the CLI. Meta uses the Flock model; only documents and `wf`/`mf:*` Flocks are enabled. Reads are encrypted-only; snapshots remain disabled.
- Each room provider pins its write epoch. An old provider fails closed after a rotation rather than silently switching epochs. Epoch changes or a required-rotation flag latch new sends closed while local edits remain durable and the UI asks for a key update. The complete drain/restart handoff is explicitly deferred to M3 PR-20.
- Native account and host locks cover local/native operations. Cloud token, ledger fetch and mailbox work run after those locks are released. Workspace closure stops admission, aborts only its HTTP requests and waits for its complete key-maintenance round before releasing storage. Draining happens outside both locks; account closure also aborts the shared client. Core owners retain admitted native work through settlement.
- The narrow client exposes only fixed E2EE methods, validates response shapes, suppresses SDK logging, and does not retry unknown writes. Submission owners must retain original signed bytes before cloud calls.
- Key maintenance is finite and coalesced per workspace, triggered by local startup/verified ledger refresh/reconnect. It reuses core journals and workflows; cloud hints never become ledger authority.

## Unencrypted exits

M2 uses Loro history and its durable dispatch pointer. Cloud RPC, presence, snapshots, cloud attachments, schedules, shortcuts, Code Collab indexes, sharing, remote preview, exports and notification bodies remain unavailable in encrypted workspaces. Background PR polling, hosted GitHub credentials and cloud PR association are also disabled to prevent repository and branch metadata escaping through an independent path. Trusted same-user local IPC can carry necessary local control; it must not fall back to a network RPC. Loro permission outcomes already persist in the protected session document. File custody is machine-only and must be disclosed before explicit pairing approval.

## Evidence and limits

The owning tests cover credential persistence and immutable retries, native room-bound encryption/corruption isolation, offline identity, concurrent ledger catch-up, and a slow mailbox that does not block local status. Canary fixtures run real Loro/Flock peers against Riverrun and reject deliberate raw/encoded synthetic leaks. They do not establish whole-product acceptance.

An isolated Electron 44.7.0 trial measured 16 KiB seal/sign/IPC at p95 0.70 ms (300 samples, macOS arm64). A real HTTP/SDK/IPC/Loro/IndexedDB first sync measured plaintext median 44.30 ms versus protected 71.60 ms (1.6163×), below the owner-approved M2 limit of 1.75×. Both arms disable server snapshots. Actual IPC/serialization/queue overhead was 2.221 ms (3.1%), below the roughly 20% batching trigger; CRDT import was 4.90 ms. Representative repeated authentication/strict-signature and AEAD samples use the same captured SDK frame and main-only key; their non-additive timing and limits are detailed in [the benchmark](../../../../apps/electron/scripts/e2ee-ipc-benchmark.md). PR-17 must remeasure against the 1.5× target after encrypted snapshots. These measurements exclude React and workspace-directory composition. Whole-product synchronization and send-to-agent latency remain separate acceptance measurements. Real OS keychain, Windows ACL and packaged-app checks are not established by synthetic host tests.

The real local backend/product fixture now exchanges protected turns through the actual native hosts, renderer/CLI factories and durable SessionDispatchWatcher. Two workspaces reopen offline with an injected eight-day clock and deliver queued turns on reconnect. OS custody, acting identity and model execution remain synthetic; reopening all native owners and stores in one child is not a packaged process restart. This path also reproduced a token reader cancelled before its first instruction: its Effect finalizer never entered, leaving a completed reader registered. Completion observers now retire those readers after the real Exit; producer leases and failed raw cleanup retain their original owners.

CLI packaging builds the runtime/workers and ACP adapter shims in separate Vite processes, retaining maps, native top-level await, externals and the single flat output directory. This bounds transformed-source and map residency per process rather than relying on application chunk cycles; the earlier handler/execution partitions are removed. The adapter pass preserves the runtime output and uses hashed dependency chunks. Default modes, including `build:watch`, retain the combined entry set. A standalone public frozen install on the actual merge with main, Node 22.23.4, passes the complete Electron `build:cli` pipeline at both 1792 MiB and the required 2048 MiB. At 2048 MiB, the runtime pass transforms 3189 modules in 7.44 s and the adapter pass 233 in 2.21 s. Published runtime/worker checks and the built CLI `--help` pass; all twelve entry maps remain and no application sources occur in the 209 vendor maps. E2EE imports remain lazy for ordinary-workspace isolation. These build/startup checks do not establish packaged chat acceptance.

## Owner-confirmed integration contracts

1. Mailbox permissions mirror core eligibility, installation context and local-publication checks without server signature verification. Writers atomically project active membership/devices, current epoch/commitment and every publication including genesis. Distributors can read their sent envelopes and query recipient status.
2. The credential-binding proof uses the fixed domain `lody-e2ee/device-credential-binding/v1\0`, then genesis (32 bytes), pairing session (16), new signing key (32), and credential hash (32). Main generates the local session and verifies core's strict proof before staging public material. The CLI's separate possession proof binds its encryption key and membership. Explicit user approval precedes signing an admission; the original request and signature are durable before HTTP, including across restart. File protection is disclosed in the confirmation. A committed admission remains committed if key delivery or local activation is temporarily unavailable.
3. Prepared CLI bindings cannot construct content transports. Activation verifies the actual ledger and current installed key, releases its temporary native owner, and only then publishes a startup hint and starts the content runtime. The hint never grants ledger permission.
4. JWT device claims are explicitly deferred to PR-16. Content tokens retain exact dedicated-bucket scope, role limits and the 15-minute bound.
5. M2 implements the send-stop fallback above; complete rotation handoff belongs to PR-20. M2 first sync is bounded by 1.75× with measured phase reporting; document keys never enter the renderer.

Backend interfaces must deploy before dependent client merges; public-pointer adoption is a separate private main change. Changed Specs remain draft until owner approval. Availability checks and independent adversarial review are required before submission.

## Review follow-up boundaries

Local terminal entry preserves ordinary running/degraded behavior. During aggregate reconnecting it requires a running local agent with completed native startup and the active workspace in its runtime snapshot; another workspace's retry cannot disable that terminal. Missing target runtimes, unavailable processes and incomplete startup remain blocked. Native session authorization is unchanged. Component tests drive actual CLI-state IPC through the daemon hook and dock to terminal-open IPC, including target recovery without remounting.

CLI discovery opts into encrypted candidates explicitly; released clients retain their plaintext-only catalog contract. Unsigned pairing materials may be replaced. Signed materials remain immutable until verified original history proves their exact commit or a competing child at the signed parent; retained-state reopen uses the persisted verified prefix. A new session invalidates old approval and requires new consent. After machine custody loss, per-device runtime stores retain old evidence without attempting to decrypt it under the replacement KEK. Only verified admission and current-key installation allow replacing a same-genesis activation hint. Waiting for pairing creates no startup issue, global offline status or timed retry; list updates do not retry it. Only ENOENT opening an activation/binding file or approved device original enters that wait: other file-open failures retain the original error and existing Fleet retry, so restored file access can recover without activation or restart. Symlink, malformed-file and genesis checks still reject unsafe state. Tests inject file-open failure with real installed keys, then reopen after recovery; fake-clock Fleet tests verify retry reaches a live runtime. Activation binds the verified approved key, releases a different live device before installing its replacement, and retries a retained failed cleanup through its existing owner before starting new work. These changes do not grant cloud or ledger authority from a local hint.


Machine startup checks the approved device original before opening custody. A missing
original waits for pairing without probing the keystore or scheduling Fleet retries;
corruption and other I/O failures retain their original error. Ordinary catalog rows
remain in the version-1 file; encrypted rows use a separate account/machine-bound
file that released clients cannot read. An encrypted cache failure preserves its
bytes and diagnostic while ordinary discovery, remote authorization and revocation
continue. A persisted cache fence prevents stale encrypted rows from being adopted
offline until a healthy reconciliation repairs the cache.

Desktop token renewal forwards the rejected token to invalidate the corresponding
server cache entry. Pairing readback determines the business result: a verified
commit wins over a lost append acknowledgement. If confirmation also fails, main
retains both original failures locally and exposes only a stable cause-free IPC
error. A bounded local-agent timeout reports pending work, with explicit retry
rather than claiming cancellation or successful activation.

A temporary local ledger storage failure is retried through the existing coalesced
refresh when the SDK retries a pending send; it does not depend on a network
reconnect. Signature, pin and epoch failures keep sends blocked. Local edits remain
durable throughout, and failed cleanup remains owned by the original owner.
