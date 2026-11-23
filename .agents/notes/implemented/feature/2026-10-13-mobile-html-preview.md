# Mobile HTML file previews

Status: implemented
Translation: current
PR: [#1525](https://github.com/LodyAI/Lody/pull/1525)

[中文](2026-10-13-mobile-html-preview.zh.md)

## Abstract

Mobile HTML files previously opened as source, and WebKit could not offer the
existing script-enabled preview because it lacks credentialless iframes. Mobile
session viewers and the project file browser now open complete HTML in preview
with an eye button to switch to the original source. Engines without credentialless
support use a script-free, navigation-stripped document in an empty sandbox.
This renders inline HTML/CSS and embedded media, but cannot run interactive scripts
or resolve sibling assets.

## Decision and responsibilities

The session viewer keeps its existing managed preview when credentialless frames
are supported; the mobile caller selects the initial preview mode. Desktop opens
retain source-first behavior. `ReadOnlyHtmlPreview` owns the compatibility iframe,
and `buildReadOnlyHtmlPreviewDocument` owns its document policy. The standalone
project browser uses this readonly surface on every engine because it has no
session annotation context.

The readonly document removes scripts, nested documents, templates, refresh tags,
navigation attributes and SVG mutations. CSP blocks scripts and network resources;
the empty iframe sandbox independently denies scripts, forms, same-origin access,
and popup/top navigation. Merely dropping the credentialless check from the
executable path was rejected: an opaque origin alone does not isolate credentials
on arbitrary self-navigation. The existing executable path and its limits remain
as documented in [Browser behavior](../../../docs/sessions-browser.md).

Local project reads previously discarded the transport's text truncation flag.
The provider and viewer conversion now preserve it, so truncated HTML remains
source-only. No transfer limits, file authorization, transport, or native shell
capabilities change. These are plain React/document transformations; no Effect
lifecycle migration is needed.

## Verification

Unit coverage checks source round trips, inactive-frame removal, policy construction,
truncation propagation and exclusion. Browser acceptance covers both mobile entry
points, source toggles, and inert script/navigation behavior. See the PR test plan
for commands. The 52 focused unit tests, two WebKit acceptance tests, typechecks,
formatting, i18n, boundary guards and documentation checks passed. Root `pnpm check`
stopped at the unchanged CLI recursive SSH submodule test with Git credential
`context_unreadable`; the full repository suite is not green. Native-device
acceptance is still separate from the WebKit browser run.

## Attachment-dialog correction (2026-10-14)

PR #1525 did not cover `SessionFilePreviewDialog`, the fallback used when a chat
attachment cannot open a live file or an existing/reported Browser target. That
panel only rendered Markdown, so even after merging, mobile HTML attachments could
still show source with no eye button. The original two browser scenarios did not
exercise this third entry point.

The attachment panel now defaults complete HTML to the same readonly preview and
places its eye toggle in the existing header beside Copy. It retains the dialog,
file metadata, copy/download/close controls and 55vh content cap. Copy returns the
original text; truncated HTML stays source-only. Fetching, authorization and richer
attachment routing are unchanged. No new Effect boundary is introduced.

Browser coverage targets the real attachment panel and modal, including source
round trips, raw clipboard content, mobile bounds, frame cleanup on close and
truncation. Native-device release acceptance remains outstanding.

The correction passed 4 WebKit acceptance tests and 48 focused unit tests, plus
repository typechecking, formatting and documentation checks. Root `pnpm check`
still stops at the unchanged CLI recursive SSH submodule fixture with
`context_unreadable` (4,186 CLI tests passed, one failed). This is not a green
full-suite result. The mobile-size attachment screenshot was inspected separately.

The separately rerun `pnpm check:quick` passed all static, i18n and boundary guards.

## Mobile attachment sheet (2026-10-14)

Following the attachment-dialog correction, the requested mobile presentation is
now a near-full-height bottom Sheet for all files sharing this preview entry
(HTML, Markdown and plain text). It uses the existing `@lody/ui` Drawer, selected
by `useIsMobile`; desktop retains the centered Dialog. The mobile panel occupies
approximately 94dvh while respecting safe areas. Its header stays above a
scrolling body, and HTML fills the remaining height. Drawer-specific Title and
Close primitives preserve labeling and dismissal in the correct modal context.
The existing image gallery and live session/project viewers are separate surfaces.
Browser acceptance covers mobile HTML/source switching, Markdown/text sheet
geometry and dismissal, plus the unchanged desktop dialog.

All seven WebKit acceptance scenarios passed; the 390 × 844 sheet screenshot
was inspected and shared. Native-device acceptance is still outstanding.
