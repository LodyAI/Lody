# Rebuild the session sharing dialog and reader layout

Status: implemented
Translation: current

[中文](2026-09-09-session-share-dialog-and-reader-layout.zh.md)

## Abstract

The sharing dialog asked the author to audit a checklist of candidate conversations
and then tick a consent box that restated the disclosure directly above it, all in
one scrolling column whose action buttons could be pushed off a phone screen. The
dialog is now a fixed header over one scrolling body with a pinned action row,
sub-conversations collapse to a single switch, and the separate acknowledgement is
gone — the disclosure on the link card is the notice. Because the stored grant is
still an explicit id set, the switch can only mean "the sub-conversations that exist
and are ready now", and the copy says exactly that rather than implying later ones
join by themselves; the cost is that a partial subset can no longer be expressed. The
anonymous reader drops its permanent "Read only · Updates live" line in favour of an
appearance control that reuses the app's own `ThemeProvider`, default and storage key,
with the limit that `localStorage` is per-origin, so the hosted share domain cannot
inherit a choice made on the app domain and remembers its own.

## Decision

### Dialog

`SessionShareDialogFrame` no longer scrolls as a single box. It renders a fixed
header and one scrolling body, and `useKeyboardAwareScrollIntoView` now observes
that body — the element that actually scrolls — which is what the hook documents
as its contract. `SessionShareManager` puts its action row in a `sticky bottom-0`
container inside that body.

The composition control is one switch, "Include sub-conversations", replacing the
per-candidate checklist. The author makes a single decision instead of auditing a
list, and the common case — a conversation with no descendants — renders no switch
at all, leaving a dialog that is just the link, one disclosure sentence and the
actions. The candidate search field went away with the list it filtered.

The switch is a projection over the same explicit id set the server verifies target
by target; the wire contract did not change. Turning it on selects the root plus
every descendant that is currently eligible, capped at `SESSION_SHARE_MAX_TARGETS`
with a line stating the cap when it bites. Ineligible descendants are simply not
selected, and the helper line — "Shares the N sub-conversations that are ready now.
Later ones are not added automatically." — carries the two facts a bare boolean
cannot: not-ready targets are excluded, and the grant does not grow on its own. A
grant that still lists a since-unavailable target reads as on, so turning the switch
off is what repairs it.

The separate acknowledgement checkbox is gone and no longer gates the mutations. The
disclosure on the link card is the notice; it states the four things a user cannot
infer — original documents, history and attachments, later updates, and that links
are forwardable and not end-to-end encrypted.

The dialog also stopped listing other grants that include this conversation. That
section answered a question ("which other links can still read this?") that readers
did not recognise as being about _other_ conversations' links, and it cost a heading,
an explanatory line and a row per grant in a dialog whose point is one decision. The
`sources` data is still fetched — `copyableShareIds` needs it — only the section is
gone.

Two things that were only "disabled" now explain themselves: a root that has not
finished syncing says so above the actions instead of leaving Create inert with no
reason, and Save renders only once something actually changed rather than sitting
permanently greyed out.

### Reader

The header is one container: workspace name, visitor label and appearance control
on the first line, then the conversation title on a full-width line, then the
target navigation. Putting the visitor label on the workspace line is what makes a
390px-wide phone show a usable title instead of an ellipsis. The permanent
"Read only · Updates live" status is gone — the surface offers no composer, editing,
retry or approval affordance, so it is read-only by construction — and the status
region now renders only interruptions (paused, loading), collapsing when empty.

`ShareThemeToggle` reuses `nextCycledTheme` and `useTheme` from the app's
`theme-provider`, giving the reader the same light → dark → system cycle, the same
`system` default and the same VS Code theme application as the product. The private
host stopped overriding `storageKey`, so it uses the app's key: serving `/s` from the
app's origin now carries a visitor's existing choice over.

## Alternatives considered

Hiding the `h1` when several targets are shared would have removed the echo between
the title and the selected navigation entry, but it makes the existing heading
assertion in the built-page suite pass against a 1px element rather than something a
reader can see. The tabs were capped instead so a second target always peeks in and
the row reads as navigation.

A reader-only light/dark switch was rejected: it would have introduced a second
default and a second cached key competing with the app's, which is the problem the
previous `lody-share-theme` override already created.

The single switch supersedes the per-item selection this note first recorded, and with
it the phase-one guidance that the author picks each target individually; those
documents were updated in the same change. The authorization model is untouched — the
grant is still an explicit id list, each target is still verified separately, and later
conversations still never join on their own. What was given up is the ability to express
a partial subset: an author who wants some but not all descendants can no longer say so,
and toggling off then on widens a legacy partial grant to everything currently ready.
That trade was accepted deliberately in favour of one decision instead of a checklist.

Hiding the other-grants list is a second deliberate gap, and a sharper one. Q12 in
`docs/session-sharing.md` requires the management surface to show every still-valid
sharing source precisely so that revoking one link is not mistaken for "this
conversation is no longer shared anywhere". With the section gone, an author who
revokes the link shown here can still be readable through a grant rooted at another
conversation, and nothing in the dialog says so. The requirement was not reinterpreted
away: it is recorded as an open gap in that document, and the section is expected to
return in a clearer form rather than stay absent.

## Evidence and limits

`session-share-manager.test.tsx` covers the switch's real obligations: a new link is
created without extra confirmation and does not widen itself, turning the switch on
adds every ready descendant and excludes the unavailable one, turning it off returns
to the root alone, the switch is absent when there is nothing to include and frozen
during a mutation, and an unshareable root is explained rather than only disabled.
The administrator and expired-grant cases keep their existing assertions.
The built-page suite in the private Web host adds two tests against the real
`dist-share` artifact — the reader resolves an unset preference through `system` and
stores a chosen mode under the app's `vite-ui-theme` key, and a value cached on that
origin overrides the system preference. All twelve built-page tests pass.

Layout was reviewed from rendered screenshots rather than by reading CSS: the manager
stories at 1200px and 390px in both themes and in Chinese, and the built reader at
1280px and 390px in both themes. That review is what caught the status text being
truncated to "Link …" by its own buttons on a narrow phone, and the reader title
being crushed by the visitor label. After the switch replaced the checklist, the whole
dialog fits a 390px viewport without scrolling.

Limits: this entry is a client-rendered SPA, so a cached theme is applied when the
reader mounts, not before first paint. Cross-origin theme sharing is not possible and
was not attempted — `localStorage` is per-origin, so `share.lody.ai` keeps a separate
selection from the app domain, which is why the in-page control exists. The screenshots
used synthetic fixtures; no deployed backend was exercised.
