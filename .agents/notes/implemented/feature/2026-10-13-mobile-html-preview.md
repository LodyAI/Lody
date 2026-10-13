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
