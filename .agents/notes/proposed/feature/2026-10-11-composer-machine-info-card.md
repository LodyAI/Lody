# Execution-machine name with an on-demand details card

Status: proposed
Translation: current

[中文](2026-10-11-composer-machine-info-card.zh.md)

## Abstract

A persistent owner avatar and name made the composer busy, while menu-only machine
information makes the execution target harder to recognize. This proposal keeps a
monitor and machine name on desktop, with ownership in a hover/click card; mobile
uses an icon-only button opening the same details on tap. Existing metadata, member
resolution, presence and cluster/stage behavior are reused. Desktop names consume
space and mobile identification needs a tap; visual approval and live team-session
verification remain pending.

## Decision and boundaries

The alternatives are menu-only presentation and the
[withdrawn persistent-owner proposal](2026-10-07-composer-machine-owner.md).
The machine-only row is transparent; combined bars retain their existing surface.
Long names truncate; the card shows full name, owner, connection and this/another
device when known. Mobile adds no identity row and retains the Session-menu entry.

Use machine `ownerUserId`, never transferable Session ownership. Missing metadata
removes the control; changing machine IDs closes the old card. Unresolved presence
stays neutral and unknown local identity omits the device row. The shared parent
reuses already-read data, with no new network requests, lifecycle services or
platform capabilities; this presentation change needs no Effect migration.
At mobile container widths up to 420px, the private badge hides its label but keeps
its lock, accessible description and sharing action, leaving room for repository actions.
The existing [Spec](../../../../specs/composer-machine-owner.md) returns to draft for
visual review; the [revert decision](../../implemented/simplification/2026-10-11-revert-composer-machine-owner.md)
retains why the earlier implementation was removed.

## Evidence and verification

`session-chat-interface.tsx` supplies the selected machine to `session-info-bar.tsx`
and `session-machine-info.tsx`. SessionConversationPage stories use the real composer;
SessionInfoBar stories cover machine-only, combined, narrow, private/repository-action,
offline and unresolved-presence scenes with synthetic data.
The owning suite passes 17 tests for visibility, stage promotion, ownership fallbacks,
target changes, metadata removal, unknown device identity and independent actions.
Component types, i18n checks, scoped lint and diff checks pass. Chromium desktop checks
cover English/Chinese, light/dark, hover, Enter, Escape, focus restoration, long names
and the 420px combined bar without overflow.

Chromium/WebKit at 375/390/430px keep controls inside the 32px bar before/after Goal
promotion, with hit testing, touch, outside dismissal and Escape verified. Cards fit
long names, offline/unknown status and Chinese/light scenes. Create PR and its menu
remain accessible alongside Goal/schedule controls. Independent private-session checks
pass both engines at all three widths; desktop keeps the privacy text. WebKit working
fixtures emit ResizeObserver delivery warnings, with layout/touch checks passing;
no other page exceptions were observed.

Root `pnpm check` passes typechecking but lint stops on unrelated untracked
`lody-roost-native/`; lint passes when excluding that standalone checkout. Remaining
static/boundary checks, `pnpm format` and the Storybook production build pass.
The initial full-test run hits an unchanged CLI assertion comparing macOS `/var`
and `/private/var`; `TMPDIR=/private/tmp pnpm test:ci` passes the full suite,
including 5,095 component tests.
`pnpm run docs check` retains the same six links into uninitialized Kimi/Pi submodules,
with no new errors or SHA-protected topics. Fixtures do not establish live member
resolution, deployed-build/physical-device behavior or user approval.
