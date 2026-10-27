# Mobile new chat rests as a blank compose page

Status: implemented
Translation: current

[中文](2026-10-27-mobile-new-chat-compose-sheet.zh.md)

## Abstract

Opening a new chat on mobile used to reveal a short bottom sheet whose top half
was a labelled form (machine, type, project, branch, workdir) and whose composer
was a small card under it, so the first thing a user met was configuration
rather than somewhere to write. The sheet now opens nearly full height with a
back button, one header target that opens the project sheet (machine + one search
across local folders and GitHub repos), a full-bleed prompt that fills the page,
and one scrolling footer rail carrying run config, machine, branch and worktree.
Attachment and send stay outside the rail. The trade-off is that
machine/branch/worktree sit one horizontal scroll to the right on narrow phones;
the header project sheet and the machine chip open the same picker. Verified through Storybook screenshots at phone
width, component tests, and a unit test for the target label; not yet run on a
physical device.

## Attribution

This work is based on the community contribution
[#491 — feat: simplify mobile new chat and project selection](https://github.com/LodyAI/Lody/pull/491)
by [@natsustan](https://github.com/natsustan). The unified native target picker,
`MobileNativeSelect` (retained for branch), the footer-rail composition, the
full-height sheet header, and the native-select regression test are adapted from
that branch. The
landing commit must carry the co-author trailer
`Co-authored-by: spike <zvq@live.com>` (the author identity on #491, linked to
@natsustan), and the PR body lists @natsustan under Contributors. The branch was
closed unmerged; this version reconciles it with the current workspace code.

## Problem

- The previous `MobileNewChatSheet` stacked four to five labelled rows above a
  `promptRows={4}` composer inside a `max-h-[92dvh]` sheet that collapsed to its
  content. In the common Chat context that meant a small card floating on an
  empty backdrop, while project contexts grew into a form.
- The rows repeated information that already has a summary face elsewhere: the
  machine chip, the run-config face and the workdir pills. Nothing on the
  resting sheet answered "where do I type?" first.
- `ChatComposer` only knew `landing`, `session` and `dialog`. `session` is a
  rounded card with a fixed-height prompt, so it could not fill a page, and its
  compact-placeholder rule (`< 440px` → "Ask anything") hid the `/`, `@`, `$`
  discovery hints on exactly the blank surface where they matter.

## Decision

- `MobileNewChatSheet` is a full-height (`92dvh`, keyboard-subtracted) sheet. Its
  header is one back control and one target trigger; the body is the composer,
  and the composer's footer is the only control rail.
- `MobileNativeSelect` renders a branded trigger over an invisible real
  `<select>`. Touch platforms therefore show their own option picker instead of
  an app-owned menu, and the control remains keyboard-accessible on web. It is
  retained for the branch control.
- `MobileNewChatProjectSheet` owns the project target: a machine row, one search
  across local folders and GitHub repos, grouped results, a Chat row and
  add/connect actions. Local results are scoped to the selected machine; GitHub
  is machine-independent. Changing the machine that owns the selected local
  project clears the target to Chat. Selecting reuses
  `handleDesktopProjectChange`, so draft text, attachments and run configuration
  survive a context switch. An empty target falls back to "Chat".
- The footer rail is one horizontally scrolling row: the run-config/usage pill,
  then machine, worktree and branch. Worktree precedes branch so a local target
  exposes the more consequential control before the overflow. Attachment (`+`)
  and send are siblings outside the rail, so a long target label can never hide
  either action.
- `ChatComposer variant="sheet"` is the page: no card, no border, prompt
  `flex-1`, footer separated by a hairline. `fillHeight` threads through
  `CombinedMentionTextarea` so the mention root, its input container and the
  textarea all fill the flex column. The sheet disables the compact placeholder
  so the full command/mention/skill hint survives on narrow phones. The prompt
  focuses on open (`promptAutoFocus`), so the keyboard is ready to write.
- `MobileFooterRail` wraps the footer controls: it fades the right edge only
  while there is more to scroll and removes the fade at the end, so the
  machine/worktree/branch controls have a visible cue without hiding the send
  action.
- Full-height composers pass `mobilePanelPlacement="bottom"` to the mention
  menu: slash commands and `@` categories dock above the footer. The default
  above-composer strip is kept for bottom-docked session composers; at the top
  of a full-height sheet it used to collapse to one row over the header.
- `resolveMobileNewChatTargetLabel` centralizes the header title rule: selected
  repo / project name, else the localized placeholder, or plain Chat; blank
  selections never produce an empty title.
- Role-bound machines stay fixed: machine options other than the active Role's
  machine are disabled with `roleMachineLocked`, and a project on another
  machine is not applied from the project sheet.

## Alternatives

- **Keep the rows and only enlarge the sheet**: rejected. It preserves the form
  as the first impression and leaves the empty-height problem in Chat context.
- **An app-owned inline panel behind the header** (the first draft of this
  change): rejected after reviewing #491, then revisited. The inline panel is
  still not suitable in the footer, but the native select alone lost search and
  machine context; the project sheet is the compromise that won review.
- **One footer chip per control with no scrolling**: rejected. Model, machine,
  branch and worktree cannot all fit a 390px phone, and the rail would become
  the form again. Scrolling keeps attachment and send fixed.
- **A native project select**: rejected after review. It had no search, no
  machine context, and local folders are machine-bound. The project sheet keeps
  one search across both sources and a visible machine row. A desktop
  `UnifiedProjectSelectorView` popover was also rejected; its search semantics
  informed the sheet, not its desktop surface.

## Verification

- Storybook `Mobile/MobileNewChatSheet` (Chat, Local, GitHub, long model name,
  attachments, closed, menus) and `MobileNewChatProjectSheet` captured at 390×844:
  project sheet, full-height prompt, and footer rail render as described; the rail
  fades at its right edge, before the send control.
- `tests/mobile-new-chat-project-options.test.ts` covers machine scoping and one
  query across folder names/paths and repository names/descriptions.
- `tests/mobile-native-select.test.tsx` covers native change events, grouping,
  the single-option disabled state, and the optional indicator.
- `tests/mobile-new-chat-target.test.ts` covers chat / local / github labels and
  empty-selection fallbacks.
- `@lody/components` typecheck reports no errors in the changed files; the
  package still has unrelated pre-existing errors in providers/routes.
- Related composer / mention / landing/project tests pass (38 tests); one pre-existing
  suite fails on the repository's `effect` `Context.Tag` version mismatch.
- Limits: not exercised in the Capacitor iOS/Android shell, so the project sheet's
  nested drawer, machine list, search keyboard, keyboard height subtraction and
  Vaul no-drag behavior are unverified on device. The real run-config sheet was not opened from
  the new sheet in Storybook; the footer pill there is a visual stand-in. On a
  390px phone the rail requires a horizontal scroll to reach branch/worktree.
