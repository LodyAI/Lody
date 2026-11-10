# Lody Design Language, Round 2: Forms and Chat

Canvas: https://claude.ai/artifact/NdX3quAv1Paddf9qeEoTS7, Rounds 6–8, below the Round 1 boards. Chosen boards:

- **M · 平铺 Rail** (`FormsFlat.dc.html`): settings-style list pages.
- **R · 行内标签** (`FieldInline.dc.html`): editor forms.
- **S · 轨道** (`ChatRail.dc.html`): the chat transcript. Its file-change block was replaced with U's grouped block after review.
- **Y · 浅底块** (`CodeFill.dc.html`): code blocks in replies.

Boards N, O, P, Q, T, U, V, W, X and Z are rejected explorations, kept as history. The composer boards V/W/X were all rejected. The composer does not change.

## Intent

Round 1 ([2026-10-29-design-language-home-design.md](2026-10-29-design-language-home-design.md)) gave Home and the iPad sidebar a Lody identity: compact, neutral, flat but not cards, system chrome native. Every other screen still uses stock inset-grouped UIKit, so opening Settings or a session from Home feels like entering a different app. This round carries the same language into the two most-used kinds of secondary screens, forms and chat. The user decided on the boards. The choices below are theirs unless marked as my call.

The principles from Round 1 still apply. In addition, this round established:

1. **One list language.** A settings page is a list, so it uses the Home rail geometry: icons in the 24 pt rail column, text from 46 pt, and hairlines under the text column only.
2. **Forms read as rows, not cards.** Labels sit inline on the left and values on the right, on the flat ground. The user chose this over recessed fields, so no field fills.
3. **The rail continues into chat.** Process and sub-agent rows hang on the same rail, with the same glyphs and tree lines as Home. Answer text leaves the rail and uses the full width.
4. **Grouped blocks are fine where content is a set of items.** The user rejected a rail tree for file changes and asked for U's grouped block. Code blocks also get a fill.

## Goals

- Settings-style `LodyGroupedList` system-row pages match board M (see Hosts).
- `LodyFormController` editors match board R.
- The chat transcript's process rows, sub-agent rows, file-change block and code blocks match boards S (with the U file block) and Y.
- Light mode, dark mode, the `soft` / `black` dark backgrounds and increased contrast all work, through the `LodyDesign` tokens from Round 1.

## Non-goals

- **The composer.** `ChatComposerView`, quick replies, the model panel, attachments and mentions stay exactly as they are (the user's call: "input compose 别改").
- The chat navigation title (`ChatNavigationTitle`) and the chat's bar items.
- The new-session form (`CreateSession/CreateSessionController`) and the Share Extension. They need their own round with `create-parity` baselines.
- Chat row kinds that were not drawn: user bubble, delivery, meta, thought, plan (`ChatPlanCell`), errors (`ChatErrorCell`), images and attachments. They keep their current layout. Their colors change only where they already use shared tokens.
- New behavior. Navigation, taps, swipe actions, validation, read-only states, error handling and accessibility labels keep their current logic.
- New copy. All text comes from the existing `Localizable.xcstrings` keys.

## Anti-goals

- Inset-grouped white cards on a gray ground, uppercase section headers, or colored icon tiles on these pages.
- Fills behind form fields (board Q was rejected).
- A second list component or a second form component (AGENTS.md). Change `LodyGroupedList` and `LodyForm*` in place.
- Forking or patching MarkdownView. Style code blocks only through its public theme and configuration.
- Green as an accent. Diff counts stay `systemGreen` / `systemRed`, through the existing diff tokens.
- Nested ternaries (AGENTS.md).

## Decisions

### Settings-style lists: board M (user)

The measurements below are at the default text size. Fonts scale through text styles (`LodyDesign.font` / `LodyDesign.mono`).

- **Container.** A flat list on `lodyGround`. No inset cards and no cell background fill. Selection and highlight use the Round 1 neutral full-width fill (`lodySelection` / `lodyPress`).
- **Section header.** Home-style: 13 pt semibold `lodySecondary`, not uppercase, about 30 pt tall with the text sitting on the bottom. The gap above it is the Home section gap (my call: `LodyDesign.Rail.groupGap`, 28 pt, between settings sections).
- **Row.**
  - The leading SF Symbol keeps its current name. It is drawn at 18 pt and tinted `lodySecondary`, centered on the rail (x = 24).
  - Title 15 pt `lodyInk`, starting at x = 46. Optional subtitle 12.5 pt `lodySecondary` on line 2.
  - A trailing value (for example Language → English) is 15 pt `lodySecondary`. The disclosure chevron is small and `lodyTertiary`.
  - Minimum heights are 44 pt for one line and 52 pt for two. Content can grow them.
- **Separator.** A 0.5 pt `lodyLine` hairline under the text column only, starting at x = 46. The last row of a section has none.
- **Footer.** 12.5 pt `lodySecondary`, starting at x = 46 (my call: aligned to the text column, as on the board).
- **Account row** (Settings root). A 40 pt round avatar (the image, or initials on `lodyInk`). Name 17 pt semibold. Email in mono 12 pt `lodySecondary`.
- **Rows without an icon** (my call). Decide per section. If any row in a section has an icon, the whole section uses the rail geometry: text at 46, and rows without an icon leave the rail empty. If no row in the section has an icon, text and hairline start at 16.
- **Custom-content rows** (my call). This covers AI Usage charts, the Appearance accent picker and the icon grid. Draw them directly on `lodyGround` with 16 pt side margins, with no inset card.
- **Switches** use the system default (Round 1). **Option menus** (for example "Queued message behavior") keep their current menu behavior and show the selected value as the trailing value.
- **Destructive and action rows** keep their current colors (`systemRed`, accent) on the flat style.

### Editor forms: board R (user)

Applies to every `LodyFormController` subclass.

- **Ground.** `lodyGround`, not `lodyGroupedBackground`. `LodyFormGroup` stops drawing its 26 pt card.
- **Grouping** (from board R).
  - Consecutive single-line fields, pickers and toggles form one block of rows, separated by hairlines. Today each one is its own `LodyFormGroup` with its own footer.
  - Their hints are combined in order into one footer under the block, as R shows for configurationHint and visibilityHint.
  - Editors may regroup their fields to get this. That per-controller change is expected. Layout itself still lives in the shared `LodyForm*` types.
  - The label column width is shared across one block.
- **Single-line field row** (`LodyFormField`).
  - Minimum height 48 pt. The row starts at x = 16 and its hairline runs from x = 16 to the trailing edge.
  - The label is 15 pt `lodySecondary` in a leading column. The editable value is 15 pt `lodyInk`, right-aligned, and fills the rest. Placeholders keep their current text.
- **Label column width** (my call). Size it to the widest label in the form, at least 96 pt and at most 40% of the row. A longer label wraps. Board R shortened "Machine and Agent" to "Target", which was a mock shortcut. Keep the real localized labels.
- **Picker / target row** (`LodyFormButton` used as a picker). Label on the left. Value on the right, with an up/down chevron in `lodyTertiary`.
- **Toggle row** (`LodyFormToggle`). The title is 15 pt `lodyInk` and the switch uses the system default. Minimum height 52 pt.
- **Hints and footers** (`LodyFormGroup.footer`). 12.5 pt `lodySecondary`, starting at x = 16, below the group they describe.
- **Group headers.** Home-style 13 pt semibold `lodySecondary`, not uppercase. Groups that contain only single-line rows drop their header, because the inline label replaces it. Multi-line groups keep theirs.
- **Multi-line field** (`LodyFormTextView`, for example Instructions, Prompt or Message).
  - A section header, then the text directly on the ground between a top and a bottom `lodyLine` hairline, inset 16 pt on both sides.
  - Minimum height stays whatever the editor passes today (120 pt for role instructions). Text is 15/21 pt.
- **Error label.** Stays `systemRed` and moves to the new margins.
- **Destructive button** (for example "Delete Role"). My call: a 48 pt row with a `systemRed` 15 pt title at x = 16 and hairlines, with no fill.
- **Workspace editor.** The icon picker keeps its control. My call: place it in a row like the other fields (label left, current icon and "Change Icon" right).

### Chat transcript: board S (user)

Geometry comes from the Round 1 rail tokens: center 24, text 46, child center 46, child text 62, trailing 16.

- **Process row.** The `duration` row and the turn's first `summary` row merge into one rail row, about 52 pt.
  - **Glyph** at x = 24, from `LodyStatusGlyph`:
    - done → read-done check ring (`lodyTertiary`);
    - running → live arc;
    - failed → failure glyph;
    - waiting for approval → attention glyph.
  - **Line 1.** "Processed for" / "Processing for" in 14.5 pt semibold `lodyInk`, followed by the duration in mono 12 pt `lodySecondary`. The two pieces come from the existing `native.chat.transcript.status.workedFor` / `workingFor` strings.
  - **Line 2.** `ChatProcessSummary.title`, for example "Thought · Ran 4 commands · Read 3 files · Edited 2 files", in 12.5 pt `lodySecondary`, truncated at the tail.
  - **Trailing.** A chevron in `lodyTertiary`. Tapping opens the activity, as today.
- **Running turns** (my call).
  - The duration row always becomes the process row.
  - When the first summary group comes right after it, that summary's title is line 2 and the row is tappable, as in finished turns.
  - Otherwise the process row has no line 2 and is not tappable. Nothing moves above the text.
  - A `holdOpen` turn without a duration row has no process row.
- **Additional summary rows** (my call).
  - Every summary group not merged into the process row is a one-line rail row: a small glyph at x = 24 and the summary text in 12.5 pt `lodySecondary`, with a chevron, keeping today's tap behavior.
  - The execution-group row ("Execution process · N guidance messages") uses the same style.
- **Sub-agent rows** (`subagent_task`, replacing the `ChatSubagentCell` card). These are child rail rows, 40 pt, using the Home tree line: a vertical rail line from below the process glyph and an elbow into each child. The vertical stops at the last child's elbow.
  - Glyph at x = 46, from the task state.
  - Title is the task description in 14 pt `lodyInk`, followed by "· actor" in `lodySecondary`.
  - Trailing status in mono 11.5 pt `lodyTertiary`: "Using bash", Running, Done or Failed, from the existing `native.chat.subagent.*` strings. Failed uses `lodyFailure`.
  - The Background tag becomes " · Background" in the trailing status (my call).
  - The detail text (completion summary, or the failure message) stays as a second line (my call). It is one line in 12.5 pt `lodySecondary`, truncated at the tail, and the row grows to about 52 pt. The tree elbow stays at line 1.
  - When there is no process row to hang from, sub-agent rows become top-level rail rows (glyph at 24, text at 46) with no tree line (my call).
  - Tapping opens the existing sub-agent page.
- **Sub-agent placement** (user).
  - In finished turns, every `subagent_task` row moves directly under the entry's process row, above the answer text, in item order. Today they sit in item order, often after the text.
  - In running turns, they move under the process row as soon as one exists.
- **Answer text.** Full width, with 16 pt margins. The Markdown theme keeps its current body size (17 pt).
- **File changes: U's grouped block** (user, from the canvas comment). `changesHeader` and its `changes` rows form one block. The current grouping in `ChatFileCell` already provides first/middle/last chrome; the header becomes the block's first row.
  - The block fill is `lodyInset` with a 12 pt continuous radius and 16 pt side margins.
  - **Header row.** 44 pt. "N files" (the existing `native.chat.transcript.fileCount`) in 14.5 pt semibold `lodyInk`, then +add / −del in mono 12 pt. The header can't be tapped today, so there is no chevron (my call: board U drew one, but new behavior is a non-goal).
  - **File rows.** 40 pt. The path in mono 12.5 pt `lodyInk`, then +add / −del in mono 12 pt, with 0.5 pt `lodyLine` hairlines inset 14 pt.
  - The leading `doc.text` icon is dropped, to match U (my call).
- **User bubble.** Unchanged. Round 1 already made it neutral (`lodyUserBubble` = `lodyInset`).

### Code blocks: board Y (user)

Code blocks are drawn by MarkdownView's `CodeView`, configured through `ChatMarkdownTheme` and the library's `CodeViewConfiguration`.

- The block fill is `lodyInset`, the same as inline code. The corner radius is 10 pt.
- The top bar shows the language label in mono 11.5 pt `lodySecondary` and the copy button tinted `lodySecondary`. Code text is mono 13 pt `lodyInk`.
- Horizontal scrolling and the existing expand / preview actions are unchanged.
- If the library exposes no setting for one of these values (for example the radius or the label font), keep the library default for that value and note it in the PR. Do not fork the library.

### Hosts for board M

Every `LodyGroupedList` host that shows system rows adopts board M in this round (user). This covers:

- `SettingsController` and every page it pushes: Preferences, Appearance, Notification settings, Account, About, Licenses and license detail, Diagnostics, GitHub, AI Usage, Memory and memory detail, Agent Roles, Prompt Shortcuts, Quick Replies, Project Visibility, Published Shares and share detail, Remote settings.
- Permission and the permission question view, Mention picker, Message details, Message share, Pull request, Directory, Files lists, File content and diff previews, Workspace changes, Activity, Simulator, Sub-agent task, HTML preview issues, Session share preview, and `LodyPagedList` system rows.

The exceptions are:

- **CreateSession and its pickers** (non-goal), so `create-parity` stays unchanged.
- **Archived Sessions, Project History and the session list**, which already use session rows.

Add baselines from the list above to the before-and-after captures where `verification/ui` has a case for them.

## Left to the builder

- How `LodyGroupedList` switches system-row hosts to the flat style. `contentStyle` is list-wide today, and settings lists need flat system rows rather than session rows. One example is a separate flat-system mode. Keep one component and `UICollectionViewListCell`.
- How `LodyForm*` gets the inline layout. Restyle `LodyFormGroup`, `LodyFormField`, `LodyFormToggle`, `LodyFormButton` and `LodyFormTextView` in place, so every editor follows without per-controller layout code where possible.
- How the duration and summary rows merge: in `ChatTranscript` row building, or in the cell. Keep the existing row IDs stable enough that scrolling and the duration timer don't jump.
- Drawing the chat tree lines: reuse the Round 1 tree-line drawing from the session rows where possible.
- The `CodeView` configuration details.

## Verification

- `pnpm check`, `pnpm bundle`, and an iOS simulator build.
- **Before** changing shared code, capture baselines for these cases:
  - `settings`, `appearance`, `queued-message-behavior`, `agent-roles`, `github-settings`, `ai-usage`;
  - one `LodyFormController` editor (Agent Role);
  - the chat cases `duration`, `process-counts`, `process-failed`, `changes`, `markdown`, and a sub-agent case;
  - `composer` and `create-parity`. These two must be unchanged afterward.
- Update the affected checks in `apps/ios/verification/ui`, and add behavior checks for:
  - flat settings rows: no cards, the hairline starts at the text column;
  - an inline-label form row where the value stays editable and right-aligned;
  - the merged process row: one row, and tapping it opens the activity;
  - sub-agent rows hanging under the process row with tree lines;
  - the grouped file-change block;
  - the code block fill and the copy button.
- Screenshots in light, dark, and dark with the `black` background, in English only (AGENTS.md).

## Artifacts

- Design canvas "Lody Design Language": https://claude.ai/artifact/NdX3quAv1Paddf9qeEoTS7
  - **Round 6 q1, settings lists.** M Flat rail (**chosen**), N Tinted groups, O System inset grouped (status quo).
  - **Round 6 q2, editor fields.** P Underline, Q Recessed fields, R Inline labels (**chosen**).
  - **Round 7, chat skeleton.** S Rail (**chosen**), T Terminal, U Current structure restyled. The S board's file block was changed to U's grouped block after two canvas comments: "这个 diff 的 section 层次感太弱了", then "diff 用 U 的 ui 方案".
  - **Round 8 q8, composer.** V Glass card, W Capsule and meta line, X Model in header. **None chosen: the composer stays as it is.**
  - **Round 8 q9, code blocks.** Y Filled (**chosen**), Z Hairline.
  - Boards use mock copy (for example "Opus 4.1 · High", "innei@example.com"). Real strings come from the catalog.
