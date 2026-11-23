# Attachment upload-to-history continuity

Status: implemented
Translation: current

[中文](2026-10-01-attachment-upload-continuity.zh.md)

## Abstract

Finishing an image upload discarded its pending preview before the delivered
message fetched a new thumbnail, producing another loading frame. Pending file
cards also reserved a progress row and used different insets from delivered cards.
Preparation now seeds the existing image cache before releasing the source, and
pending files reuse the delivered layout with progress overlaid at the bottom.
The final attachment layout stays the reference; cache eviction and page restart
still require ordinary loading.

## Decision and ownership

This closes the thumbnail-load limit in the earlier
[sending-in-place decision](../architecture/2026-09-14-deferred-attachment-send.md#sending-in-place-2026-09-29)
and replaces its reserved file-progress row with an overlay. Current intent is in
the [attachment Spec](../../../../specs/session-files.md#8-presentation-and-leave-protection).

`SessionFileCardLayout` owns the frame, icon, name, subtitle, and action slots;
pending files use the same `SessionFileCardList` insets as delivered files.
Upload progress and failure copy change within that layout. The preparation
boundary seeds successful image bytes under their workspace/session/image
identity before the pending queue can clear its sources. Where supported, the
browser decodes the new URL before publication, preventing a local decode flash.
Pending and delivered images read those bytes synchronously; CSS retains the
existing thumbnail fit. Long desktop status labels truncate within one metadata
line so narrow windows do not move the attachments when the status changes.

Reuse the existing 200 MiB image cache rather than introducing another preview
store or keeping pending messages visible after history publication. Native iOS
prepares its share-safe data URL before readiness. Cache generations and abort
signals fence late native conversions; preview-cache failures preserve upload
success. Transfer selection, retry, cancellation, history writing, and optional
cloud routing retain their existing owners.

## Evidence and limits

The preparation, pending-row, delivered-file, image-cache, image-gallery, and
sender-identity suites pass 55 behavioral tests. The first-paint tests render
the actual delivered image without effects at full, large, and compact sizes;
cache tests cover identity isolation, native data URLs, clear, and cancellation.
The interactive `SessionPendingMessages.UploadToHistory` stories expose source
release followed by the actual delivered row, at desktop and narrow widths.

Playwright drives Chrome at 1280px and 390px (forced mobile layout), comparing
the real components from pre-change HEAD `93545f01b` with the changed components
under the same synthetic attachment fixture. Holding the thumbnail response at
publication reproduces the old missing-preview and loading frames; releasing it
shows the unchanged final layout. After the fix, all four phases retain the same
168px image square, 62px file-card height, and attachment positions on both widths.
The prepared and delivered images reuse one decoded URL with zero image requests.
Desktop and narrow before/after captures cover upload, source release, publication,
and final success. Root formatting, scoped Oxlint, and i18n checks pass.
Root `pnpm check` stops at the documentation site's missing `fumadocs-mdx` dependency;
component type checking remains blocked by unavailable office-viewer dependencies
and unrelated dependency API mismatches. Document/public-boundary
checks report missing files and manifests in uninitialized ACP submodules.

Packaged Electron and physical native-device acceptance remain unverified.
Cached source images retain original bytes rather than separately transformed
thumbnails until the existing cache evicts them. The existing image-to-local-file
fallback may still change attachment kind; this work does not change that transport.
