# Encrypted workspace file and preview availability

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-file-preview-availability.zh.md)

## Abstract

Encrypted workspaces can use Code Collab and remote preview through the existing workspace keys, signatures and same-member machine authority. Code Collab v2 synchronizes file-index and signal Flocks; its file text, saves, diffs and LSP results travel over RPC rather than synced text documents. Those Flocks now use the normal protected document provider, including snapshots. The file and preview RPC methods use the existing encrypted request/response wire and journal. Public-link sharing publishes a server-readable static copy outside workspace membership after the [explicit encrypted-workspace confirmation](2026-10-28-e2ee-share-plaintext-consent.md).

## Decisions

The owner approved reuse of the existing remote-preview behavior and device-local export rather than a new ledger or permission model. Feature RPC admits only the existing Code Collab methods, restricted `file/preview`, and preview create/status/revoke. It cannot invoke `file/resolve-local`, local endpoint controls or unrelated machine operations. The native sender resolves the target machine signer from the verified ledger; the receiver reuses fresh same-member machine authorization and checks workspace/machine and claimed human identity before the existing handlers. Missing native capabilities never select ordinary RPC.

An ordinary workspace retains its existing RPC, owner-session envelopes, Flock rooms and preview proofs. Encrypted previews reuse the capability-checked Quick Tunnel and loopback proxy. Page bytes stream through that tunnel with `no-store`; no application server content store is added. This does not describe the preview tunnel as end-to-end encrypted: the tunnel service terminates its transport. Preview control results and visual comments remain in the protected RPC/document paths.

Feature requests and results keep each existing signed content frame below 1 MiB. A feature request splits its canonical JSON into 256 KiB chunks, with big-endian uint32 index/count before each chunk in the existing method-body params. Each frame carries the same request ID, method and expiry. The host retains the complete ordered original as length-prefixed ciphertext frames before transmission; response digests bind that exact aggregate. Result chunks use the existing response sequence and progress/success kinds. Reassembly checks signer, routing, method, count, request digest and sequence. It has a 32 MiB message bound; incomplete request retention has a shared 32 MiB/32-request bound and expires on later intake or owner close. This covers the existing file-content budgets without widening a frame's wire limit.

The channel extends [encrypted dispatch](../architecture/2026-10-28-e2ee-streams-dispatch.md); its dispatch originals and execution claims remain unchanged. The renderer shares one response reader with encrypted dispatch. Its runtime close aborts transport and joins that reader before token disposal. The CLI listener retains its four bounded handlers and joins admitted raw handler work before releasing its owner. Its journal claims a feature request before a save, retains every encrypted response before publication, and replays only those originals after publication failure. An uncertain started request cannot execute its save again. Storage failure affects that request, with a bounded retained response owner; it cannot switch a sibling to plaintext. No ledger, key format, or schema migration changes.

## Evidence and limits

Synthetic real-key and SQLite tests exercise large request/result chunks, out-of-order request assembly, wrong-request responses, immutable originals across reopen, publication-failure replay, and revocation. Production provider/preload tests cover host forwarding; runtime tests open the actual Repo-backed file-index and comment stores; host tests cover protected updates and snapshots for those rooms. These checks do not establish installed desktop, live-cloud, native keystore, or all-platform acceptance. Device-local export is a separate independent change in [PR #2011](https://github.com/LodyAI/Lody/pull/2011).
