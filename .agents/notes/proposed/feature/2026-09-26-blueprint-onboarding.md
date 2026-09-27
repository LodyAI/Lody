# Blueprint onboarding: setup as inking a drawing of the real window

Status: proposed
Translation: current

[中文](2026-09-26-blueprint-onboarding.zh.md)

## Abstract

The current desktop onboarding shows a form floating over a faded, blurred product window that already contains an invented,
half-finished conversation, while the agent step's camera aims at an anchor that does not exist. The result feels like
two separate things, a form and a ghost of the product. This proposal does all of setup on ONE object instead. The
real `TourApp` window opens as a pencil drawing traced live from its own layout. Each answer inks the part of the window it
configures: the agent inks the run-config chip, the project inks the sidebar, the first task is typed into the real
composer and sent with its real send button. The window is laid out to fit the screen, whole, with the answers written
in its title bar; at the end it grows into the screen and is the app. A Storybook prototype (`Onboarding/Blueprint`) runs the local flow end to end on fixture data. It is
not wired into `OnboardingOverlay`, and it replaces the approved illustrated Intro, which is an owner decision.

## Problem (evidence)

- `STEP_FRAME.providers` names `composer.run-config`; no node carried it, so `measureAnchor` fell back to the whole
  window at `maxScale 1.8` and the window was cropped at the stage's right edge.
- The preview ran `STILL_TRACKS` (`reveal: 9`, `tasks: 4`): a mid-run fixture conversation, fixture sessions and the
  sidebar's default "Temperature of the sun" chats, shown while the person has no agent and no project.
- The camera layer sat at 48–65% opacity under a 40px backdrop blur and a grid, so the product read as a ghost, not a
  place. The collapsed side panel also drew a 1px border that notched the window's right edge.

## Proposal

- **Tracing, not illustrating.** `blueprint/sketch.ts` walks each region's live DOM and records lines of text, controls,
  filled or shadowed surfaces and single-side dividers; it draws them as graphite strokes, with words as uneven runs,
  boxes drawn twice (second pass faint) and a constant screen-space weight. Every region shares one paper; a tinted
  region (the sidebar) gets its tint with the ink, not as hatching. The drawing follows the product's layout because it is measured from it.
- **Ink is progress.** Paper plus pencil covers every unconfigured region; answering opens a circular hole in the paper
  from the control involved (`SketchLayer`, one SVG mask). The current question's target region is drawn in accent
  strokes, with no wash.
- **Questions are drawn, not listed** (round 2, after the owner found popovers of rows "not wow"). A question is
  editorial type on the canvas; its options are drawn where they will live, in the state they are in: pencil for
  what is not on this Mac, ink for what is. Agents are a deck of cards above the composer; a runtime Lody is still
  fetching is a card filling with ink from the bottom, so the fill IS the download. Local folders are ink cards (they
  are on this Mac), with "Choose a folder…" as a pencil card. Suggestions are pencil bubbles where the first message
  will sit. Every question is asked in the same place, the empty conversation above the composer; only the answer
  travels, to the control it sets. The
  composer is the input (`FieldOverlay` mirrors text through the product's `setInputText`) and its real send arrow
  is Run (`PressOverlay`).
- **Choosing is answering.** The choice lifts out as a V2 raised chip and flies on an arc into its control
  (`AnswerFlight`); the ink starts where it lands, with a feathered front and one accent wet-edge ring; the flow
  advances by itself after the ink. The rail is how to go back.
- **The pencil speaks V2 materials**: raised surfaces get a contact line under them, wells a shade inside the top
  edge; the opening lays accent construction lines first, then the detail.
- **One object, whole.** During setup `TourStill`'s `windowSize` lays the window out to fit the screen less a desk
  margin (clamped to 1024×640–1700×1080), so it is always seen entire at 1:1: title bar, edges and shadow, never a
  cropped strip. The opening stands back slightly; the camera does not pan between questions. At the handoff the whole window inks from the composer with the person's own prompt as the first
  message and tab title, then `TourStill`'s new `windowSize` re-lays the window out at the screen size, drawn title bar
  above the frame, so the last frame is the product's own layout.
- **The rail is the window's title**: written in its title bar, it states each answer:
  `Agent Claude Code · Project lody · First task …`.

## Product changes made for the prototype

- `DesktopRunConfigMenu` marks its trigger `data-run-config-trigger`; `resolveAnchor` derives `composer.run-config`,
  `composer.input`, `composer.card`, `composer.send` and `sidebar.workspace`. This also fixes the existing providers
  shot.
- `TourApp` in a setup preview: empty chats, branch `main`, an empty conversation (no fixture bubble, no running label,
  no "No messages" line) until a prompt is sent, and the sent prompt as first message, tab title and the project's
  first sidebar row. The collapsed side panel no longer draws its border.
- `LoroSidebar`'s demo `repoSections` path (only the tour uses it) omits the glass tray of a project with no sessions,
  which rendered as an empty rounded box.
- `TourStill`: `overlay`, `windowShadow` and `windowSize` props, and its own stacking context around `TourApp` so a raised
  product node cannot climb over the overlay. Its camera also observes the window's own size, so a `windowSize`
  change re-aims it instead of leaving it parked on the old frame.

## Design-critic rounds (Technique 3)

Three fresh critics saw screenshots only, with one identical prompt. They scored the prototype 5, 5 and 4 out of 10 and
contradicted each other: rounds 1–2 asked for a leader line tethering panel to control and round 3 asked to remove it;
round 1 asked for uniform hairlines and round 2 called those a skeleton loader. Only points all rounds shared were
adopted: pencil contrast, stray seams, a single camera rule, no progress on an unchosen agent, and plainer copy. Suggestions to
drop the panels' shadow and radius were rejected because they break the `@lody/ui` floating rung. The loop was stopped
for non-convergence; the owner's review is the real gate.

## Owner review, round 3

On the round-2 prototype the owner flagged four things, and all four are addressed above: the rail in a separate top
band did not belong to the window below it (the window was cropped at 1:1, so its top edge was cut under the band);
the sidebar carried too many lines (hatching, accent strokes, pencil project rows and an empty tray); the project
question should use the empty conversation instead of the sidebar; and after the handoff the project showed an empty
box where the new session row should be. The cost is the camera pans and velocity lean between questions, which only
existed because a 1700×1080 window was shown at 1:1 on a smaller screen. The owner also floated a Balatro-like pixel
style as an alternative direction; that is undecided.

## Not done / open

- Not wired into `OnboardingOverlay`: real `AgentConfig`/`ProviderSetupTask` rows, auth panels, failure mapping, the
  native folder picker, analytics, completion and resume still belong to the existing screens.
- Cloud chapters (Sign in, Workspace) have anchors (`sidebar.workspace`) but no panels yet; compact windows (<1080px),
  reduced-motion beyond the draw and ink transitions, and `zh_CN` copy are not handled.
- Replacing the four-beat illustrated Intro contradicts `onboarding/AGENTS.md`, so it needs the owner's approval first.
- Verified only in Storybook (Chromium, 1440×900) through a scripted walkthrough; no Electron run. The Electron E2E
  build was killed twice by SIGTERM under shared-host memory pressure. No new automated tests; existing tour and
  onboarding suites pass.
