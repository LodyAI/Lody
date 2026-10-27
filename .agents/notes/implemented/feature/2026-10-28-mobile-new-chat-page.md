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
its entrance animation through delayed mounts and URL corrections. Real-component
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

## Verification and limits

- Focused project/target/workspace/config/submission and desktop comparator suites:
  110 passing tests, including the existing avatar cache, project filtering and
  comparator boundaries.
- Eight browser scenarios cover both themes, 320–430px phone widths, a fixed
  simulated 300px keyboard, delayed presentation, later URL correction and
  GitHub avatar pending/success/error states. First-send cases observe 45 frames
  with identical composer bounds, model text/weight and no entrance movement.
- Package typecheck, changed-file formatting/lint and artboard layout checks pass.
  Root documentation validation is limited by links into uninitialized ACP
  submodules. Repository-wide checks are reported separately in the PR.
- Stories explicitly force the mobile layout family and use real components
  with synthetic workspace/acceptance data. The gallery includes project types,
  opened pickers, shared run-config Sheet, attachments, long text and short phones.
- iOS Debug `0.107.2 (20261028.3)` was built, signed, installed and launched on
  the physical test device. Installation and simulated geometry do not establish
  acceptance of native keyboard timing or the felt first-send transition.
