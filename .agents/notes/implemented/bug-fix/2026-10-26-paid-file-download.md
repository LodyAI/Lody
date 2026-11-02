# Paid remote downloads up to 100 MiB

Status: implemented
Translation: current

[中文](2026-10-26-paid-file-download.zh.md)

## Abstract

Remote file downloads reused the preview response, limiting binary files to
5 MiB and text to 10 MiB (also subject to compressed size). A separate negotiated
chunk method now allows paid workspaces to download original files up to 100 MiB
without increasing preview limits. It retains owner and path authorization and
rejects files that change between ranges. This uses more small RPC requests and
retains up to 100 MiB in the viewer; deployed-client acceptance remains unverified.

## Decision and ownership

`fileDownload: 1` advertises `file/download-chunk`. The existing machine handler
owns its service and injects the cloud billing port. Every range requires an
explicit paid entitlement; an unavailable query cannot grant the larger budget.
Existing cooperative session quotas retain their fail-open policy. The response
uses the existing owner-scoped content envelope and at most 512 KiB of raw bytes.
No attachment or history record is created. The provider preserves member-root
routing, and the viewer never seeds its editor cache with these bytes.

Raising the preview constant was rejected because it would put a 100 MiB body
into one RPC response and increase editor/preview memory costs. Stateless range
reads instead bind inode/device/path, size and nanosecond modification/change
times. Reopening rechecks containment and identity; short reads or changed
metadata abort. This detects ordinary concurrent filesystem changes; it is not
a cryptographic snapshot against a malicious writer controlling host metadata.

The action owns cancellation, one large transfer per mounted action hook, and
its byte array. Session change/unmount stops future ranges and discards the
pending response. The machine closes each file descriptor in `finally`; there
are no server-held transfer handles to expire. Existing small browser downloads
remain concurrent, and native sharing retains its serialization.

## Verification and limits

The multi-megabyte reconstruction assertion uses `Buffer.equals` to compare every
byte and the length without a JavaScript deep walk of millions of indexed
properties. The previous `toEqual` assertion exceeded the CLI test timeout in
[PR #1914](https://github.com/LodyAI/Lody/pull/1914); the fixture size and timeout
remain unchanged.

Behavioral tests cover 100 MiB admission and one-byte-over rejection, original
binary reconstruction, unpaid/unavailable billing, changes between ranges,
symlink escapes, owner-envelope rejection, capability negotiation, cancellation,
and the actual Download action's exported bytes. Full workspace typechecking,
standard lint and the production CLI build pass with the locked dependencies.
Real gateway throughput, packaged desktop and physical mobile behavior have not
been tested. Frontend and owning CLI both need the new version; older daemons
retain the previous size explanation. No deployment is part of this change.
