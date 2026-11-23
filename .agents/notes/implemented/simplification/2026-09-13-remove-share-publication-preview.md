# Remove publication preview

Status: implemented
Translation: current

[中文](2026-09-13-remove-share-publication-preview.zh.md)

## Abstract

Publication no longer has a preview step, including agent-requested shares.
The human approves the explicit scope and disclosure, then the client freezes,
uploads and publishes. Removing the separate preview avoids an extra state and
its failure/retry path. Human confirmation and credential durability remain required.

This supersedes the preview requirement in the
[static sharing proposal](../../proposed/architecture/2026-09-12-static-session-sharing.md).
The preview component, embedded reader mode, prepare-only hook action, phase,
expansion callbacks and public unpublished-history decoder are removed. The
manager receives only `hasPending`, not the frozen package; internal retry identity
and conflict handling stay intact. Images/file omissions remain disclosed without
rendering the unpublished transcript. Attachment viewing and OG previews are unrelated.

Tests cover explicit MCP approval, capture failure without upload, user-triggered
retry, frozen deployment reuse and credential recovery after dismissal. The tradeoff
is intentional: users no longer inspect the exact frozen bytes before publication.
No hosted deployment or visual acceptance is claimed by this note.
