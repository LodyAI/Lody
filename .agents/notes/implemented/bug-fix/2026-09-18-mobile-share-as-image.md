# Share as image reaches the handset surfaces

Status: implemented
Translation: current

[中文](2026-09-18-mobile-share-as-image.zh.md)

## Abstract

Share-as-image shipped verified on desktop only: on a handset the session menu
had no entry for it and the mobile `SessionDetail` branch never mounted the
preview, so the feature was unreachable even though `ChatShareImageDialog`
already carried a bottom-drawer branch that matched the spec. The fix was
composition, not a new component — one flat action in the mobile menu and one
mount in the mobile return path. Wiring it up exposed a real handset constraint
the desktop build never met: the conversation's left edge is the session
drawer's back-swipe strip (`EDGE_ZONE_PX`), where the selection checkbox sat as
a tap target. On mobile the box is now an inset, passive state badge and the row
itself keeps the tap — the same split the mobile list's own multi-select rows
use — and the selection toolbar keeps default-size buttons instead of `sm`.

## Discovery

The gap was not in the preview component. `ChatShareImageDialog` had already
been written with a `Drawer` branch (`h-[92dvh]`, grabber, centred title, close
affordance, flex preview, safe-area footer) behind `useIsMobile()`, matching the
spec's "dialog on desktop, bottom drawer on a handset". What was missing was
everything around it: the mobile `mobileMenuActions` list in
`session-detail.tsx` stopped at Copy URL, and the mobile return path mounted
every session dialog except this one. Selection itself was already shared —
`SessionChatInterface` exposes `startShareImageSelection` and renders
`MessageSelectionToolbar` in place of the composer on both surfaces.

## Decision

The mobile menu gains one flat `share-image` action after Copy URL, gated on the
chat surface actually being on screen (`!activeDraftTab && !hasActiveViewerTab`)
— the same condition the desktop header menu relies on implicitly, since the
action arms selection inside the mounted conversation. The handler reuses
`handleShareAsImage` unchanged; the preview mount reuses `shareImageTarget` and
`handleShareImageCompleted` unchanged, so desktop and mobile share one state
machine and one completion path (confirm → copy/export → cancel selection →
toast).

The checkbox could not stay where it was. `EDGE_ZONE_PX` reserves the left edge
for the back swipe, so a `left-0` interactive checkbox on a handset is both
untappable and visually clipped — and the `VList`'s `contain: strict` means a
row cannot lift itself above the strip the way the composer does. The mobile
multi-select rows in `mobile-project-screen` already solve this exact problem:
the box becomes a non-interactive badge showing state while the whole row
carries the tap. The selection row adopts the same split — `left-3`,
`pointer-events-none`, `aria-hidden`, `tabIndex=-1` on mobile only — and the
toolbar buttons take the default size, the same call the drawer's own action
row makes for primary touch targets. The badge itself stays inside the strip
zone, which is legal only because it is passive: the rule that left-edge
controls must inset past `EDGE_ZONE_PX` binds tap targets, and the tap target
here is the row.

## Trade-offs and limits

The passive badge means mobile users cannot tap the checkbox itself; the row is
the only target, which is the established handset convention here but a
deliberate difference from desktop. The menu action hides (rather than disables)
when a viewer tab or draft is active, matching how the surrounding actions
behave — an empty tab still surfaces the "no conversation" toast, same as
desktop. Verified by typecheck and the existing message-selection/export suites;
no behavioural test exists for the drawer-vs-dialog branch, which remains a
Storybook-verified state.
