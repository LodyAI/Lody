# M5 realtime contract revision

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-realtime-contract.zh.md)

## Abstract

Encrypted remote execution needs unambiguous bytes and one durable start boundary
across realtime and persistent delivery. This revision aligns the public draft
with merged purpose-specific crypto, signed machine binding and schema-3 journal
recovery, while pinning RPC body bytes to merged PR-25. It keeps encrypted
history/Meta dispatch as the final fallback and separates persistent request
expiry from memory-only execution freshness. The full Spec remains draft;
the owner approved whole-frame RPC sizing and canonical machine resource encoding
on 2026-10-28. The MVP uses encrypted Streams RPC plus durable fallback, with
iroh deferred to a later accelerator. The owner selected minimal plaintext presence
on the existing 90-second channel, filtered before publication; product execution,
presence filtering and latency remain unverified.

## Decisions and alternatives

The [owning draft](../../../../specs/e2ee-foundations.md#realtime-rpc-and-presence-m5-review-draft)
contains the RPC byte profile. Retain content v0 purposes 8/9 and exact original
ciphertext across realtime retries. The 2026-10-28 owner decision selects encrypted
Streams RPC with encrypted history/Meta durable dispatch as the final fallback
for the MVP, both converging on one actual-start claim. Iroh is outside the MVP
and may be added later as an accelerator. A dispatch ACK is receipt/progress,
not agent completion.
Preserve userTurnId and existing steer/fork evidence; never automatically restart
uncertain work. Execution/request/response evidence has no automatic collection;
capacity exhaustion refuses new work rather than evicting deduplication evidence.

The previous audit and development-compatibility recommendation are superseded
by the merged machine binding format: current-only old developer ledgers must be
recreated, with no old machine-record reader or document-sync exception. Production
has no encrypted workspaces requiring that compatibility. Signed tag4 and machine
possession bind the strict UTF-8 machineId; credential-binding/v1 still binds the
pairing session. Do not invent an extra machine-binding proof or capability code.
`rotationRequired` remains an administrator prompt and alone blocks no seal, send
or execution. Keep current authorization and epoch-key checks.

Execution freshness starts before the machine's own authenticated latest-ledger
read, lasts at most 15 minutes and is cached only in memory. Restart requires an
online authenticated recheck. The journal's separate persistent per-workspace
expiry floor cannot grant that freshness; its authenticated-time skew checks and
evidence-preserving explicit reset retain their own contract. Neither reset nor
refresh renews request expiry or permits uncertain takeover.

The owner approved these two byte choices on **2026-10-28**:

1. Follow PR-25: the whole RPC content frame fits in 1,048,576 bytes including
   143 bytes overhead; the body is at most 1,048,433 bytes. This replaces the old
   plaintext-only 1 MiB interpretation. The reserved presence codec is not an MVP limit.
2. Encode the ledger's exact 1..256 strict UTF-8 machineId bytes as canonical
   unpadded base64url in `rpc:<encodedMachineId>`, with no normalization or alternate
   spellings. The segment is at most 342 ASCII bytes and resource at most 346.
   Rejecting all non-ASCII or >128-byte IDs would exclude valid ledger machines;
   lossy normalization could merge distinct identities. PR-25 does not implement
   this resource codec.

The 2026-10-28 owner decision selects minimal plaintext presence for encrypted
workspaces. Reuse the existing 90-second TTL channel and publish only the IDs,
status enums and timestamps listed in the [Spec allowlist](../../../../specs/e2ee-foundations.md#mvp-presence-minimal-plaintext-owner-approved-2026-10-28).
Construct the allowlisted record before any store/publication; drop `status.detail`
and all other free text, names, paths and content, including nested fields.
The service can infer this metadata from connections, traffic and accounts;
encrypting it offers little benefit with greater complexity and availability risk.
Encrypted presence is outside the MVP: purpose 7 and the merged #1990 presence
body codec remain reserved/unused, including their 64 KiB/60-second limits.
This explicit metadata choice does not relax RPC/content encryption or authority.

For the later, non-MVP iroh layer, EndpointId remains the workspace device signing
public key, supplied only inside trusted hosts. The 2026-10-28 owner decision
records that the domain-separation review found no signing-protocol confusion;
this is not native key-lifetime or installed-platform acceptance. The
send-to-actual-start acceptance target is ≤1 second, not ACK or
business completion; no measurement is claimed and offline durable catch-up has
no one-second delivery guarantee.

## Source audit and integration boundary

Inspected public main `76a4f28e8f22c0b405e57b731fb0a1e49c42d8a3`:

| Public source                                                                                                                     | Available capability and limit                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/e2ee-core/src/internal/content/realtime.ts`                                                                             | Six purpose-specific seal/open APIs for presence/request/response over opaque bytes; no resource/body, freshness or execution authority. Purpose 7 is reserved, not used for MVP presence. `sealDocument` stays document-only.             |
| `packages/e2ee-core/src/internal/ledger/{records,admission,machine-id,policy}.ts`                                                 | Signed machineId/possession, strict UTF-8 1..256 bytes, same-member atomic replacement and active binding index. Supported capability 1 covers independent member removal; machine tag4 adds no capability.                                |
| `packages/e2ee-core/src/internal/ledger/verified-ledger.ts` and CLI `lib/e2ee/runtime.ts`                                         | Verified continuity and retained history/cache/pins, not a machine-initiated latest-read execution freshness cache.                                                                                                                        |
| `apps/cli/src/lib/e2ee/realtime-journal.ts`                                                                                       | Dormant schema-3 storage: exact originals, immutable first outcome, single claim, response originals, workspace clock floors and retired IDs across explicit reset. No sender outbox, authentication, execution wiring or freshness grant. |
| `apps/cli/src/session/session-dispatch-watcher.ts` and `session-dispatch-logic.ts`                                                | RPC offer stash and durable history dispatch, including restart. Actual execution and Meta/history must share the claim; reception-only deduplication is insufficient.                                                                     |
| `packages/loro-streams-rpc/src/machine-rpc-server.ts`, CLI `session-history-rpc-rejections.ts` and `session-execution-service.ts` | Existing memory history-task deduplication, expiring refusals and steer uncertainty evidence are useful business evidence, not the integrated persistent execution gate.                                                                   |

PR-25 is **merged** as `c7b3c71512e2bdf26b14817fc8ff56cbd730f509`, with source pinned at
[`daee5751fde6698e50960ca6a5627191c887e297`](https://github.com/LodyAI/Lody/pull/1990):
its [pure body codec](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/src/e2ee-wire.ts)
and [independent Python vectors](https://github.com/LodyAI/Lody/blob/daee5751fde6698e50960ca6a5627191c887e297/packages/loro-streams-rpc/tests/fixtures/generate-e2ee-wire.py)
supply field order, safe big-endian integers, ASCII method/error text, exact opaque
payloads, nested error validation and bounds. They do not authenticate a caller,
check current time, correlate responses, allocate durable sequences or implement
resource encoding. Its presence codec is reserved, unused by the MVP. This revision changes
documentation only, not RPC or codec bytes.

Related public decisions: [machine binding](2026-10-27-e2ee-machine-ledger-binding.md),
[realtime primitives](2026-10-26-e2ee-realtime-content-primitives.md),
[journal](2026-10-26-e2ee-realtime-journal.md), and
[journal recovery](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md).
The shared presence schema still permits bounded `status.detail`; the encrypted
workspace publish allowlist remains integration work. This revision supersedes the
earlier M5 encrypted-presence proposal and stale audit, not the underlying
primitive/codec availability or ordinary-workspace presence behavior.

## Verification boundary

[PR #1894](https://github.com/LodyAI/Lody/pull/1894) remains draft; all four Spec
files remain draft and both Note languages remain proposed/current. Document checks
validate metadata/links, not final Spec approval or runtime behavior. The two
format approvals do not change Spec status: final approval awaits independent
PR-25/wire consistency review and subsequent explicit owner approval. The bytes
were compared with the pinned PR-25 codec and independently
generated vectors; no copied candidate implementation or new test suite is added.
Authenticated transports/freshness, sender outbox, query authorization, actual
execution and persistent fallback, real gateways, native/platform and latency
acceptance remain integration work. Checks run for this revision are recorded in
the PR description; earlier check/review results are not evidence for this revision.
