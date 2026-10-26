# M5 realtime contract review

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-realtime-contract.zh.md)

## Abstract

Encrypted RPC needs an authenticated target and a persistent boundary that stops
retries from executing twice. The owner selected signed ledger machineId binding,
machine-initiated in-memory execution freshness and workspace-device Ed25519
identity reuse for iroh, with encrypted Streams RPC as fallback. The foundations
revision records those behavior choices while keeping its existing candidate
frame encoding and limits unchanged. It remains draft and opens no product
channel; record-format work, domain-separation audit and platform/runtime
acceptance are separate gates.

## Selected direction and alternatives

Keep the existing content v0 algorithms and purposes 7/8/9, with both transports
carrying the same original frame. The [owning draft](../../../../specs/e2ee-foundations.md#realtime-rpc-and-presence-m5-review-draft)
contains the existing candidate encoding and limits rather than duplicating them
here. This update changes no candidate realtime-frame fields and prescribes no
new ledger byte encoding.

Machine `AdmitDevice` records bind machineId and public key under the approving
personal device's signature. A locally verified ledger supplies machineId-to-key
resolution; directory metadata and credential-binding/v1 do not. At most one
active device may use a machineId within a workspace; replacement revokes the old
key in the same record. This replaces the earlier recommendation for an independent
machine-binding proof. The ledger-key-only routing alternative is not selected.
Encoding and vector updates belong to separate machine admission work. Old
development machine records without machineId keep authorized document sync but
cannot authorize realtime; do not migrate or re-sign them.

The execution machine itself authenticates and reads the latest ledger. Its
15-minute maximum starts before that read, and only the remaining window may be
cached in memory. Restart requires online revalidation before new remote
execution, without blocking offline document use or reviving uncertain work.
Forwarded pages and retained journal timestamps never renew the grant. Concrete
clock/stop-margin/suspend handling still requires host tests; this is not a change
to the journal's separately accepted persistent expiry floor.

Iroh uses the workspace device signing public key as EndpointId. The private key
is supplied only inside the trusted host, with no renderer export or arbitrary
signing IPC. Before enabling this reuse, audit concrete TLS/discovery signing
domains against ledger/content domains. SDK, discovery/relay configuration and
platform acceptance are not selected by the identity decision. A slow/unavailable
iroh path cannot block encrypted Streams, which retains the same original request
ID/frame and shared execution journal.

Do not collect execution evidence at request expiry. Initially retain it; a later
bounded-retention design needs durable retired IDs and uncertainty handling.
The cost is disk growth and explicit admission refusal when capacity is exhausted.

## Source audit and integration boundary

Inspected public main `274d74a724de7bfb42c6ff0685c52c0abce7d487`:

- `packages/e2ee-core/src/internal/foundation/content-format.ts` and
  `crypto/content.ts` already separate the non-document key leaves and keep
  content v0's 143-byte overhead. `internal/content/index.ts` deliberately
  restricts `sealDocument` to document purposes; retain that restriction.
- `foundation/device-credential-binding.ts` signs genesis/session/key/credential
  hash, without machineId. `apps/electron/src/main/services/e2ee-local-pairing.mts`
  retains the machine response, but the credential proof does not authenticate
  that field for other devices. Ledger `AdmitDevice` has no machineId.
- `internal/ledger/verified-ledger.ts` proves continuity against observed history.
  CLI `lib/e2ee/runtime.ts` saves history/cache/pins, without a freshness clock.
- `apps/cli/src/session/session-dispatch-watcher.ts` stashes RPC turns by userTurnId;
  `session-dispatch-logic.ts` intentionally resumes processing turns after restart.
  A journal only around RPC reception cannot fence that durable dispatch route.
- `packages/loro-streams-rpc/src/machine-rpc-server.ts` deduplicates concurrent
  history tasks in memory; it removes them on completion. CLI
  `session-history-rpc-rejections.ts` persists selected refusals only until expiry.
  Neither is a complete execution journal.
- `session-execution-service.ts` already retains steer submission uncertainty;
  reuse that business evidence instead of replaying a submitted action. Its
  bounded in-memory terminal turn map is insufficient for persistent deduplication.

## Verification boundary

The source audit above is a baseline observation, not a claim that the selected
ledger extension, freshness gate or iroh composition is implemented, nor a shipped
vulnerability in ordinary RPC. Documentation checks validate metadata and links
only. Fixed vectors, crash/I/O tests, actual authorized product execution, canary
and ordinary/encrypted latency comparisons remain separate evidence requirements.
The Spec remains draft: selected behavior directions do not approve the complete
revision, the separate machine record encoding or an unaudited cross-protocol key
reuse. This documentation PR changes no ordinary workspace path or product gate.
