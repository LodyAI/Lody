# Mobile new chat shares the conversation page and first-send presentation

Status: implemented
Translation: current

[中文](2026-10-28-mobile-new-chat-page.zh.md)

## Abstract

Mobile new chat now uses the existing conversation header, back control and bottom
composer, with machine and project choices in the page above the input. This
replaces the separate sheet and crowded footer rail, while retaining the shared
run-configuration Sheet for Role, Agent, Model and Mode. Accepted first sends keep
the new-chat page visible until the resolved session surface commits, suppressing
its entrance animation through delayed mounts and URL corrections. The page itself
slides in from the right, and in the native app follows a left-edge drag back. Real-component
browser checks pass and an iOS development build is installed; native keyboard
and perceived transition acceptance remain with the user.

## Decision and scope

This supersedes the layout and machine-locking choices in the
[earlier compose-sheet decision](2026-10-27-mobile-new-chat-compose-sheet.md).
That work adapted [#491](https://github.com/LodyAI/Lody/pull/491) by
[@natsustan](https://github.com/natsustan); its attribution remains applicable.

- Reuse `SessionConversationPage`, `BaseHeader`, `MobileSessionHeaderBackButton`,
  `ConversationColumn` and the ongoing-session composer shell. The shell owns
  keyboard offset, safe-area padding and transition in both surfaces.
- Show machine first, then project, as icon/value rows without separate labels.
  These controls and branch choices expand in place. Local Git worktree and
  branch share one unfilled row; branch is read-only for a direct local session
  because it uses the directory's checked-out branch. GitHub exposes its branch.
- Keep Role, Agent, Model and Mode in `MobileSessionRunConfig` and its existing
  Sheet. The shared trigger uses regular text weight and keeps the beginning of
  long model labels. Changing machine clears an incompatible Role and local
  project, with the Role consequence shown in the machine option; draft survives.
- No project reads “No project selected”. Groups use Folders, local folders use
  FolderOpen, and GitHub rows/selected values reuse the desktop owner avatar.
  A GitHub icon remains visible while loading or on failure. Repository
  descriptions are omitted. All sources share the desktop comparator: most
  recently used first, then name and stable identity. Unused folders do not gain
  priority from creation time. Search filters without re-ranking the list;
  no-project/add/connect actions keep their fixed positions.

## First-send ownership

The landing keeps its controlled draft and attachments until session admission
succeeds, retaining the existing failure restoration and dispatch behavior.
`getSessionCreationNavigation` attaches a session-scoped history request.
`useMobileComposerPresentation` retains the creation entry by session/history
index through same-entry URL replacements. The host passes entrance suppression
to the drawer for as long as that creation surface is open.

`SessionDetail` acknowledges its resolved mobile surface in a layout effect.
Only that acknowledgement consumes the history request and dismisses the retained
new-chat page. A resolved navigation promise alone is insufficient: the portal
or actual session content may appear later. Vaul's `defaultOpen` shortcut also
expires after its first frame, so content and overlay explicitly suppress their
entrance animation. Drag, closing, Back and later ordinary visits retain their
existing transitions.

## Keyboard dismissal after presentation

A device recording exposed a gap in the constant-height browser checks: sending
explicitly blurred the new-chat field and then disabled it, allowing the native
keyboard to close before the destination finished mounting. The delayed composer jump is consistent with the renderer handling the native
inset event after the keyboard hide. These are code-proven causes of the keyboard dismissal; no device
CPU profile establishes the source of all rendering cost.

The shared `ChatComposer` now keeps a transiently pending mobile textarea enabled
and blocks its input, key and paste events while the controlled draft is hidden.
Send-pointer events retain input focus. Existing-session sends also keep the same
input node while pending; archived inputs remain disabled.
For first send, a one-shot navigation request lets the mounted destination take
an existing new-chat focus before the source is removed. Native iOS additionally
requires its keyboard-height signal, since hiding a keyboard can retain DOM focus.
If the user has dismissed it, the request is consumed without focusing. Claiming
focus and presentation clears both history markers in one replacement.

The adopted behavior automatically closes the keyboard after a successful send.
For a new conversation, its destination first takes the existing focus, then a
bounded pair of animation frames lets the committed message surface paint before
blurring. Ongoing sends use the same operation after accepted submission commits.
Rejection keeps editing available. Any new key/input/composition, pointer, focus,
window/visibility change or scope teardown cancels pending dismissal, so it cannot
interrupt the next draft or another session. The shared shell animates safe-area
padding along with keyboard margin to avoid a separate bottom-inset jump.

This preserves the shared renderer and current page ownership instead of adding
a second editor host or moving focused DOM between containers. The destination
still mounts its session UI; native smoothness needs a new device pass.

## Default project on a fresh mobile conversation

Home no longer forces the composer into the no-project context. Successful local
admission records `lastUsedProject` in the existing workspace-scoped, device-local
landing defaults. Normal context/agent persistence preserves this separate field,
so browsing or a canceled/rejected draft cannot replace the last accepted target.
An empty home-launched composer restores it through the existing project handler;
local targets also restore their owning machine and clear an incompatible Role.
Explicit project-page entry and existing drafts retain their current selection.

Restoration waits for relevant catalogs, runs once before paint when ready, and
is canceled if the user changes machine/project or closes the page. Exact visible
identity is required: a deleted or unavailable target becomes no project. An
explicit last-used no-project choice remains none. On older installs without this
field, the existing recent-use ordering supplies an available fallback.

## Page motion and edge back

The page previously appeared and disappeared without motion. It now pushes in
from the right with the drill pages' `.mobile-drill-in` keyframe, and Back slides
it out before notifying the host. The host hiding the page after first-send
presentation still removes it at once, so the session surface is never covered
by a leaving page.

In the native app a rightward drag beginning within `EDGE_ZONE_PX` of the left
edge moves the page with the finger over the still-mounted home or project
screen, committing past the drill-page distance/velocity thresholds or snapping
back. A Vaul drawer was not adopted: the page already shares the session drawer's
first-send handoff, and a second drawer would reopen that ownership. An overlay
strip like `MobileEdgeBackSwipeZone` was rejected because it would swallow taps
on the machine/project rows and composer controls along the left edge; the drag
is bound on the page itself and ignores touches that start in the composer
shell. With `axis` locking, use-gesture reports `first` on the first intentional
move, so the edge test reads the touch-down `initial` position. Web mounts no
gesture, matching other edge-back surfaces.

Evidence is limited to jsdom tests driving touch events through use-gesture
(entrance, Back exit, follow-and-commit, snap-back, composer/mid-screen/web
exclusions, host removal) plus package typecheck. Native feel is unverified.

## Verification and limits

- Focused project/target/workspace/config/submission and desktop comparator suites:
  146 passing tests, including the existing avatar cache, project filtering and
  comparator boundaries.
- Seventeen Chromium scenarios cover both themes, 320–430px phone widths, a fixed
  simulated 300px keyboard, delayed presentation, later URL correction and
  GitHub avatar pending/success/error states; nine WebKit cases cover automatic dismissal,
  resumed input, safe-area interpolation and project restoration. First-send cases observe 45 frames
  with identical composer bounds, model text/weight and no entrance movement.
- Package typecheck, changed-file formatting/lint and artboard layout checks pass.
  Root documentation validation is limited by links into uninitialized ACP
  submodules. Repository-wide checks are reported separately in the PR.
- Stories explicitly force the mobile layout family and use real components
  with synthetic workspace/acceptance data. The gallery includes project types,
  opened pickers, shared run-config Sheet, attachments, long text and short phones.
- iOS Debug `0.107.2 (20261028.6)` was built, signed and installed on
  the physical test device; iOS refused automatic launch because it was locked. The isolated build retains the previous device build
  dependency baseline; all four product files edited in the default-project follow-up match
  the working tree byte-for-byte. Installation and simulated geometry do not establish
  acceptance of native keyboard timing or the felt first-send transition.
