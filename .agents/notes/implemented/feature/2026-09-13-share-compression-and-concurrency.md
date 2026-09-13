# Compact and compress static shares with bounded concurrency

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/681

[中文](2026-09-13-share-compression-and-concurrency.zh.md)

## Abstract

Static publication serialized document acquisition, image copying, uploads and
sealing checks, while shipping runtime metadata and uncompressed JSON. Capture
now projects conversation content, omits terminal output and compresses each
history using the existing Zstd worker. Four concurrent tasks overlap independent
I/O without changing identities or permitting partial publication. The manifest
still binds the complete package before upload; this change does not introduce
per-conversation upload admission or multipart state.

This partially supersedes the preserve-all-history decision in the
[static sharing design](../../proposed/architecture/2026-09-12-static-session-sharing.md).
Current omissions, compatibility and disclosure are defined by the
[sharing Spec](../../../../specs/session-sharing.md), which remains draft.

| Phase   | Work and constraint                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Capture | Four source acquisitions, then all selected histories detach synchronously                                                    |
| Prepare | Deterministic attachment IDs before four concurrent copies; four history encoding tasks reuse the existing compression worker |
| Upload  | Four different immutable objects at a time; progress counts encoded bytes                                                     |
| Seal    | Four storage checks at a time; commit only after every object exists                                                          |

Task failure aborts siblings and waits for started tasks to settle before source
leases are released. Every repeated typed attachment is copied once even when
several conversations refer to it. Unknown content and opaque tool payloads are
preserved; runtime handles and send/Role configuration are not usable in a share.
The initial terminal-tail policy was superseded during this change by the user's
command-only sharing decision: typed output blocks (including exit status) are
omitted completely. Commands remain unchanged. Titles exactly equal to the first
terminal command are omitted on the wire and restored by readers; other titles
are preserved. Export validation must not restore titles before encoding. This
does not rewrite persisted history or heuristically strip opaque tool payloads.

Version 2 describes Zstd explicitly instead of HTTP Content-Encoding, avoiding
transparent browser decoding before checksum verification. A small pure-JS
decoder serves the reader and optional service integration; it validates frame
size/window and a single frame before allocating, then bounds output. The app
alone supplies the existing worker-backed compressor. Incompressible objects and
images retain their original bytes. V1 remains readable. Agent URLs continue to
return ordinary JSON; compression does not expand their authority.

Deterministic tests cover real codec round trips, malformed/oversized frames,
stable ordering, shared-image deduplication, sibling cancellation, source
preservation, terminal-output omission, wire-level title deduplication, title
restoration and seal ordering. These checks do not prove deployed service or
native-device performance. Service and reader support must precede V2 publication
in a coordinated rollout. No hosted deployment was created by this change.
