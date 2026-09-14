# One conversation-access control in the session header

Status: implemented
Translation: current

[中文](2026-09-14-session-header-share-control.zh.md)

## Abstract

Publishing a conversation as a public link was reachable only from the session
header's "…" menu, and nothing anywhere said a conversation was already
published — so the one fact with an outside-the-workspace consequence was the
one fact the header never showed. The private/team pill in that header
(`SessionAccessControl`) now carries both access axes: team visibility picks the
shape, a published static link picks the label, and the conversation page owns
the single editor both the pill and the menu open. Reading "already shared"
costs one extra control-plane subscription per open conversation, which is the
deliberate trade for a header that can state it; that read is capability-gated,
so the local open-source build makes no request and renders no share
affordance at all. What is still not answered is the pre-existing gap that a
conversation can be readable through a share rooted at a *different*
conversation, and this control says nothing about that either.

## Decision

### One control, two axes

A reader asks a header one question — who can see this conversation — so both
answers belong in one control rather than in two pills competing for the same
corner.

Team visibility picks the **shape**. A private conversation keeps the existing
dropdown, because its private state is inherited from a machine and a project
and needs explaining before either sharing action is offered. Anything else —
team-visible, or a solo workspace that resolves no visibility at all — has
nothing to explain and becomes a plain button.

A published static link picks the **label**, in both shapes. A link anyone can
forward is a wider disclosure than "this stays inside your workspace", so it is
the status worth reading at a glance, and "Shared" replaces "Private" on the
pill. It does not replace the fact: the private scope remains the first block
inside the menu, with the link's own disclosure directly beneath it. A
team-visible conversation's button reads "Share conversation" and becomes
"Shared" in place — same pill, same icon, only the word changes — so nothing
appears or disappears as the status resolves.

`SessionAccessControl` therefore takes an optional `state` (a solo workspace has
none) and an optional `publicShare` (a build without a cloud has none), and
renders nothing only when both are absent. That last case is the local
open-source desktop, which is unchanged.

### Reading "already shared"

`useSessionShareStatus` is a read-only companion to
`useSessionShareManagement`: the same `sessionSharing:getManagement` row, with
no candidate discovery and no mutations. It answers `unknown` for both "the
control plane has not replied yet" and "this build has no cloud", and the header
treats `unknown` as not-yet-shared, so the label only ever upgrades in place.

This is a real cost: a subscription per mounted conversation where previously
there was none, and the sharing subsystem's own rule is that a closed editor
runs no cloud query. That rule is about the editor, which is still mounted only
while open; the header is a second, deliberate reader, and the invariant that
keeps the two apart — the management row, never a source document — is recorded
in [`components/AGENTS.md`](../../../../packages/components/src/components/AGENTS.md).

The status is scoped to a share **rooted at this conversation**, which is what
the editor manages. A conversation published as a sub-conversation of another
share reads as unshared here. That is the same gap Q12 already records against
the dialog's removed other-grants list; this control neither widens nor repairs
it.

### The page owns the editor

`SessionHeaderMenu` used to own the `SessionShareDialog` and its open state.
With two entry points that no longer works, so the dialog moved up to
`SessionChatInterface` and the menu takes an `onOpenPublicShare` callback whose
presence is what renders the item. The state stays keyed by session id rather
than a boolean: a tab that switches underneath an open editor must not retarget
it at the newly shown conversation.

The "…" menu keeps its entry. The request was for the header *in addition to*
the menu, and the menu is still the only desktop surface that lists every
session action in one place.

### Centring the pill's label

Adding a word beside the icon exposed a defect the icon-only states had hidden:
the shared pill chrome set `leading-none`, and `items-center` centres a label's
line box, not its glyphs. A line box shorter than the font's own puts the ink
about 1.2px above the icon beside it — measured from rendered pixels at 8×
device scale, the label's ink centre sat 1.25px above the button's centre while
the icon's sat on it. The chrome now uses `line-height: normal`, where the
half-leading is zero and the ink lands where the font intends; the same
measurement then reads 0.13–0.25px, inside a device pixel. `normal` rather than
a fixed line height because the interface font is user-selectable, so the
correction has to follow whatever font is in use. The fix is in the shared
constant, so the Archived pill gets it too.

## Alternatives considered

**Two pills — keep "Private", add "Shared" beside it.** It loses no information,
and it was rejected on the header's budget rather than on correctness: the
desktop toolbar already carries the launcher split button, the PR badge, an
archived pill and the "…" menu, and a second status pill pushes the title into
an ellipsis on a narrow window. Collapsing to one label costs the at-a-glance
private signal for published private conversations, which is why the menu's
first block still states it.

**Keep "Private" as the label and mark "Shared" only on the menu item.** This
keeps the private signal, but it puts the disclosure behind a click on exactly
the conversations where the disclosure matters most — the request was explicitly
that a shared conversation says so regardless of its team visibility.

**Derive the status from `sessionSharing:list` once per workspace instead of
per conversation.** One subscription rather than N, but the list is paginated
and scoped by role (members see their own shares, administrators see the
workspace inventory), so a header would have to page through an inventory to
answer a question about one conversation, and would answer it wrongly for a
share it cannot see. Rejected as a correctness problem wearing a performance
argument.

**Open the editor to find out.** Rejected outright: it makes the answer cost a
capture-capable surface, and the disclosure is exactly what should not require
opening the publication flow.

## Evidence and limits

`session-access-control.test.tsx` covers the control's real obligations: a
private conversation still shows its pill and menu; a non-private one gets a
direct button with no `aria-haspopup` that calls the editor; the button renders
before any team visibility resolves; `shared` reports "Shared" and `unknown`
does not; a private conversation's menu carries both sharing actions; and a
published private conversation reads "Shared" while its menu still names the
private scope and the link disclosure. `use-session-share-management.test.tsx`
gains the status hook: active reads `shared`, absent and `draft`/`revoked` read
`none`, an unanswered query stays `unknown`, and no workspace reports `none`
whatever the control plane holds. Both files, plus the existing header-menu,
share-manager and mobile-menu suites, pass.

Layout was reviewed from rendered Storybook screenshots of
`Sessions/SessionAccessControl` in both themes, covering the plain share button,
the shared label, and the private menu with and without a published link.

Limits: no hosted backend was exercised, so `getManagement` is verified only
through its mocked contract — the per-conversation subscription cost is reasoned
about, not measured against a deployment. The control is desktop-only; mobile
keeps its existing private chip in `SessionInfoBar` and its separate share entry
in `SessionShareMobileMenu`, and this change does not unify them. The
publication flow itself, its confirmation and its credential handling are
untouched; see
[the dialog and reader layout note](2026-09-09-session-share-dialog-and-reader-layout.md)
and [static session sharing](2026-09-09-session-sharing.md).
