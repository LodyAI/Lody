# Wide layout: iPad landscape, iPhone Duo, and the right panel

Status: design approved in conversation 2026-10-17; layout options on the canvas
https://claude.ai/artifact/KB7D2tqJDJmQrRWGaWo4UR (rows "iPad landscape · right panel
options" and "Portrait"). Builder calls are marked **(builder's call)**; everything
else was decided by the user.

## Intent

Lody has a basic iPad split today (list | chat) and nothing for iPhone Duo, Apple's
foldable iPhone. Unfolded, Duo's inner display is regular width but iPhone idiom, so it
currently shows the phone list stretched across 951 pt. The user wants one wide layout,
built and strengthened once on iPad, that Duo gets automatically, and wants to grow it:
content that today pushes from the chat (file diffs, files, item details) should open in
a right side panel beside the chat instead of covering it.

Success: on iPad landscape and on Duo unfolded, reading a diff or a tool call no longer
hides the conversation; folding, unfolding, rotating, or resizing a window never loses
the open session or the open panel content.

## Goals

1. Choose the layout from the window's available space, live, never from device idiom.
2. Right panel for chat-launched content, with its own back stack.
3. Same behavior on iPad and iPhone Duo; Duo needs no device-specific branch.
4. State survives every layout transition: the open session and the panel's content
   (including its back stack).
5. **Presented sheets survive every layout transition** (decided, canvas row "Open sheets
   when the device folds"): folding, unfolding, rotating, or resizing never dismisses an
   open sheet — a pending permission request, a Settings page several levels deep, a
   new-session or edit-message draft all stay where they were. Folding is not a
   dismissal. This rules out swapping root screens between modes: one persistent native
   shell switches modes in place, and presented controllers stay attached to it.

## Non-goals

- Android, tvOS, visionOS.
- Hinge-driven effects (angle animations). Hinge status may be read only if a layout
  decision needs it; layout itself comes from size class and reserved regions.
- Redesigning the list, chat, or the screens that move into the panel. They move as-is.
- Multiple windows / scenes (`UIApplicationSupportsMultipleScenes` stays false).

## Anti-goals (a failure even if it works)

- Any branch meaning "if iPhone Duo" or "if iPad" for layout. `Platform.isPad` must stop
  deciding the layout.
- A phone UI stretched across the inner display.
- Interactive controls or text sitting in the fold when Duo is partially folded.
- Losing the conversation, draft, or panel content because the device was folded,
  rotated, or the window resized.
- A decorative RN overlay faking a native effect (AGENTS.md UI baseline).

## Layout modes (decided)

| Mode        | When (by available space)                                                  | Layout                                                     | Panel                                                                                                                 |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Wide**    | regular width, wider than tall (iPad landscape, Duo unfolded landscape)    | list \| chat                                               | Opening panel content hides the list: **chat \| panel** (canvas option B). Closing the panel returns to list \| chat. |
| **Tall**    | regular width, taller than wide (iPad portrait, Duo unfolded rotated)      | chat full width; the list slides over the chat (canvas P0) | Panel opens as a **sheet over the chat** (canvas P1)                                                                  |
| **Compact** | compact width (Duo closed, iPad narrow Split View / Stage Manager windows) | today's iPhone stack                                       | Panel content is pushed, as today                                                                                     |

Duo unfolded in Wide: list | chat and chat | panel both meet at the fold (each pane ≈ one
half). On iPad the list keeps a sidebar width; chat | panel uses a panel of roughly
45% **(builder's call: exact widths; aligning to the fold should come from the system —
`UISplitViewController` column widths, `reservedRegions(kind: .division)` — never a
hard-coded 475.5 pt)**.

## What opens in the panel (decided)

Everything the chat opens as a push today, plus item details:

- `FileDiffScreen` (turn file rows, `SessionScreen.tsx` `onTurnChangesPress`)
- `FilesScreen` and file previews opened from it
- `WorkspaceChangesScreen` and diffs opened from it
- `TurnChangesScreen`, `PullRequest*` screens reached from the chat
- `ItemDetailScreen` (today a formSheet) — moves into the panel

Transient one-shot forms stay sheets: permission answers (`PermissionScreen`), editing a
message (`EditMessageScreen`), new-session creation, settings.

The panel has its own back stack: e.g. Files → file → diff pushes inside the panel; its
back button steps out one level; closing the panel discards the stack.

**(builder's call) Extending the rule to the rest of the chat-launched pages:** pages
that _view_ something go to the panel; pages that _ask for an action_ stay sheets.

- To the panel as well: `FileContentScreen` (from chat file links, `useOpenFile`, and
  from panel pages), `ProcessScreen`, `SubagentTaskScreen`, `MessageDetailsScreen`.
- Stay as today: `SimulatorScreen` (its own `.zoom` PiP / full-screen transition),
  `AgentErrorScreen` (error with retry actions), the sheets listed above.
- A page opened from inside a sheet that stays a sheet keeps today's behavior within that
  sheet, so nothing lands in a panel hidden behind the sheet.

**(builder's call) Routing:** a tap in the chat _replaces_ the panel's stack with the new
page as its root; tapping the item already shown is a no-op. Taps inside the panel push
onto its stack.

**(builder's call) Out of scope:** the canvas's "Open full screen" panel button and the
Diff / File segmented control are illustration only; `FileDiffScreen` moves as-is.

## Builder's calls (to be evaluated by the user in the simulator)

The user has not used a Duo yet and asked to judge these on the simulator:

1. **List while the panel is open (Wide):** the sidebar button slides the list over the
   chat | panel layout without reflowing it. Choosing another session switches the chat,
   closes the panel (its content belongs to the previous session), and dismisses the
   list. Tapping outside dismisses the list and keeps the panel.
2. **Selecting a different session from anywhere** (list, notification, deep link,
   share) closes the panel.
3. **Transitions carry the panel:** Wide panel ↔ Tall sheet ↔ Compact pushed stack keep
   the same content and back stack. Chat scroll position is best-effort; the open session
   and composer draft are required (the draft already lives natively in
   `ChatComposerView`).
4. **Panel width and fold alignment** as noted above.
5. **Tall sheet:** a modal sheet with medium and large detents; the chat behind it is not
   interactive.
6. **Compact keeps today's iPhone behavior exactly** (pushes stay pushes, formSheets stay
   formSheets). On a transition into Compact, the panel stack is re-presented in its
   compact form: pushed pages push in order; a stack whose root is a formSheet page
   becomes that sheet hosting the stack. Leaving Compact rebuilds the panel the same way.
7. **Fold:** the "nothing in the fold" anti-goal covers fixed chrome only (nav bars,
   composer, sheet header and grabber, the list overlay's edge controls). Scrolling
   content may pass under the fold, per Apple's guidance; system sheets already avoid the
   fold. Tall on a half-folded Duo stays Tall.
8. **A Compact iPad window looks exactly like iPhone.** The idiom checks that pick sheet
   type or background (`PresentedPage.tsx:131` / `sheetContentBackground.ts`,
   `OnboardingScreen.tsx:268`, `LodyChatView.swift:655`, `+Transcript.swift:29`,
   `useBindSessionNav.ts:16-18`) become size-based and are in the migration.

## Constraints

- Follow AGENTS.md: native navigation (UIKit split / stacks) owned natively, RN fills
  content; LodyKit hosts native code, registered through `LodyKitModule`; reuse
  `definePage` / `present` and the `sessionNav` mailbox (features never import screens);
  native headers via `LodyNavigationHeader`; HIG first; system blue actions, no green
  accent.
- **SDK:** Duo APIs (`UIHingeInteraction`, `UIArrangementViewController`,
  `UISplitArrangement`, `UIView.reservedRegions`) exist only in the iOS 27.1+ SDK. The
  default `/Applications/Xcode.app` is 27.0; build Duo work with
  `/Applications/Xcode-beta.app` (27.2, needs the Metal Toolchain component, now
  installed). Guard 27.1-only APIs with availability checks so older SDK builds and
  non-folding devices take the no-hinge / no-region path. Vertical bars on Duo appear only
  when built against 27.1+ and only for container-owned bars.
- `UISplitViewController` has a native **inspector column** since iOS 26
  (`UISplitViewControllerColumnInspector`, `preferredInspectorColumnWidth*`). It is the
  likely home for the panel **(builder's call to confirm its collapse and Tall-mode
  behavior; the Tall mode must present the panel as a sheet regardless)**.
- Signing stays enabled for simulator builds. After adding/removing LodyKit Swift files
  run `pnpm --filter @lody-ios/mobile pods`.

## Current state (what the builder inherits)

- Layout is picked once by `Platform.isPad` at module scope: `src/app/index.tsx:11-12`
  (`InboxScreen` vs `PadHomeScreen`). `_layout.tsx:93` enables the root sessionNav
  binding whenever not iPad; with both shells mounted only `handlers.at(-1)` wins
  (`features/sessions/sessionNav.ts:37`).
- iPad split: `LodySplitView` in `modules/lody-kit/ios/Chrome/LodyFloatingPanel.swift`
  wraps a `.doubleColumn` `UISplitViewController` whose two columns are
  react-native-screens `ScreenStack` navigation controllers (`PadHomeScreen.tsx`
  `PanelStack` / detail stack). It has no `.compact` column and no trait-change handling;
  collapsing would let UIKit merge RN-owned stacks. Session detail has no
  `onDismissed`; `projectColumns` skips zero-size frames.
- Idiom-based styling to revisit: `sheetContentBackground.ts`, `OnboardingScreen.tsx:268`,
  `LodyChatView.swift:655` / `+Transcript.swift:29`, `useBindSessionNav.ts:16-18`.
- iPhone `UISupportedInterfaceOrientations` is portrait-only (`app.config.ts:11`); Duo's
  inner display ignores supported orientations, so Tall/Wide must both work on an iPhone
  idiom device.
- Chat reading column is already width-based (`ChatReadingColumn`, 800 pt max) and
  re-prepares history on width change.

## Verification

- Behavioral UI checks in `apps/mobile/verification/ui` (offline Debug fixtures, English,
  light/dark): Wide open/close panel, panel back stack, Tall sheet, Compact push,
  live transitions between modes keeping session + panel content and an open sheet
  (permission, a Settings sub-page, a new-session draft), sessionNav entry
  points (deep link, notification) landing in the right place in each mode.
- Run on an iPad simulator (landscape + portrait + a narrow multitasking width) and on
  the iPhone Duo simulator (`BCCF9F2A-51F8-4CF7-8E68-79A06782077B`, iOS 27.2) closed,
  open landscape, open portrait, and book-folded; one run on a non-folding iPhone.
  Duo has several displays; `simctl io … screenshot` needs `--display` (the inner
  display was id 3 in testing).
- `pnpm check`, `pnpm test`, `pnpm bundle`, and a signed simulator build with
  Xcode-beta 27.2.

## Left to the builder

The native/RN split of responsibilities, how the persistent shell switches modes in
place (e.g. a `.compact` column hosting the phone stack vs re-parenting RN-owned stacks;
UIKit must not merge react-native-screens stacks on collapse), how panel routes
are represented (`present` with a panel style vs a panel stack driven through a mailbox
like `sessionNav`), exact widths/animations, and the migration of existing iPad
verification cases (`ipad-chrome`, `ipad-sidebar`).
