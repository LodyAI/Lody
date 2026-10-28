# Encrypted machine read queries

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-read-queries.zh.md)

## Abstract

Encrypted workspaces previously stopped machine reads at the ordinary RPC gate, so remote files, diffs and history were unavailable. Reads now reuse the signed Streams frames and shared response reader, with native read authorization and the existing method handlers. They never claim the execution journal. Large JSON outcomes use signed pages, and a separate RPC-only token lets Guests send queries without receiving document write permissions. Packaged two-device acceptance and backend deployment remain separate from these local checks.

## Decision and boundaries

This extends the [dispatch channel](2026-10-28-e2ee-streams-dispatch.md), preserving its execution claim and durable fallback. It does not supersede that decision: read results have no business execution to claim or replay. A separate encrypted transport implementation would duplicate target binding, framing, correlation and cleanup; the existing channel instead accepts typed inputs/results and keeps one response reader for both operations.

On the baseline, `getMachineRpcClient` rejects protected workspaces through the common `rpc` feature gate; `e2ee_rpc_unavailable` also guards missing host preparation capabilities. The production chain is cloud provider → inferred IPC proxy → preload allowlist → account/window-bound host → native preparation/response verification. Both host operations and `rpcOnly` token selection pass through that chain. No signing key crosses it.

The allowlist covers machine status/ping/binary status/Pi extension listing, memory **list**, local-project Git state/probing, session live status/history read/watch, file preview/download, text open/refresh, three diff reads and the two existing LSP queries. Mixed-action memory create/update is rejected independently by client, native preparation and server. `init-directory` publishes index state and stays disabled, as do saves, history writes, preview leases, installation/authentication, process control and dispatch through the read entry. Encrypted text/diff reads keep disposable local caches but do not start watchers, reconcile file-index publications or publish Git observations. File and history handlers retain path, owner-session, owning-machine and storage checks.

Read authorization reuses the host's authenticated latest-ledger refresh and its bounded in-memory freshness lifetime, then checks active non-recovery membership and the target machine's same-member binding. Guest is a valid reader; execution still separately requires write authority. The realtime crypto binding admits active readers, while the host's closed method/action entry decides what they may request. Read queries enter neither receipt nor actual-start execution journals. Their incoming signed originals are retained in the ciphertext originals store, rejecting different bytes under the same signer/request ID. New coordination stays native Effect; existing method handlers and Repo remain Promise adapters, without claiming a migration of those services.

## JSON paging and original retention

Purpose 8 retains the existing request body and method. Params are explicit UTF-8 JSON `{queryId, params}`, with the existing method params codec inside; owner-session encrypted envelopes and validation remain unchanged. The host generates the secure 16-byte request ID and a 60-second deadline. The exact signed request is saved before transmission; changed intent under a retained query ID is refused.

Successful method outcomes are UTF-8 JSON `{result}`. Each purpose-9 payload is JSON `{version:0,totalPages,totalBytes,data}`, with canonical padded base64 `data` containing at most 512 KiB of those original JSON bytes. The body sequence is the zero-based page index; only the last page has kind `success`, earlier pages are `progress`. Counts, byte lengths, signer, epoch, ID and full-request digest are verified. A missing page keeps the result incomplete, even if the last page arrived first; conflicting sequence bytes cannot replace saved pages. Reassembly decodes JSON only after all pages exist. Errors use the approved nested error body with an explicit safe method DTO.

A result is bounded to 32 pages / 16 MiB before base64. Larger outcomes return `e2ee_query_too_large` with `truncated:true`, total bytes and the limit; no partial payload masquerades as success. Existing history pagination, bounded file chunks and deferred diff entries remain the application recovery path. The native response owner seals all pages and saves them atomically before publishing the first. An uncertain local write retains those sealed pages for retry; reopened committed outcomes reuse identical frames. No automatic collection or execution-result migration is introduced.

## Ownership and containment

A signed query starts a workspace-scoped read task, capped at 32 independently of dispatch intake. Identical active requests share the first response; retained responses replay without rerunning the handler. Reads have a 45-second work budget intersected with request expiry. Timeout/close aborts the raw handler and drains its actual settlement before releasing custody; a raw operation that ignores cancellation retains only its own slot. History watch receives the combined per-query/workspace stop signal. Authorization is checked again before publication, and incompatible epochs or revocation refuse affected sends.

Network failures, a bad response, an outbox fault or an expired read fail that query, leaving document sync, other requests and workspace startup available. Scope close drains the shared reader and admitted read tasks before releasing RPC token ownership. Retained ciphertext and public routing live in the existing originals store; the execution journal is unrelated.

RPC tokens use the existing credential-authenticated content-token operation with `rpcOnly:true`, isolated in cache identity by their restricted scope. They allow read/create/append only under the encrypted bucket's `<workspace>:e2ee-rpc:` prefix. Document tokens retain their previous Guest read-only behavior, and neither token grants snapshot writes to Guests. Current credential/role/epoch checks and the 15-minute absolute token bound remain backend responsibilities. The matching private change is independently reviewable and never changes the public gitlink.

## Verification limits

The [host tests](../../../../packages/loro-streams-rpc/tests/e2ee-native.test.ts) pin request retention, paged exact response reuse and incomplete out-of-order delivery. The [query integration](../../../../apps/cli/src/lib/e2ee/realtime-rpc.test.ts) traverses real method serialization, encrypted Streams correlation, target signature checks and the real server read entry. [Production provider/preload coverage](../../../../packages/components/tests/cloud-platform-provider.test.tsx) pins both query operations and token purpose forwarding; [runtime authorization](../../../../apps/cli/tests/e2ee-runtime.test.ts) checks a demoted Guest on its admitted machine against execution and foreign-machine denial. The file service regression pins content reads without background publication. These synthetic, deterministic boundaries do not establish WAN latency, a deployed backend or packaged two-device behavior.
