# Lody Design Language, Round 1: Tokens and Home Design

Canvas: https://claude.ai/artifact/NdX3quAv1Paddf9qeEoTS7. Board **E · Rail** (`Rail.dc.html`) is the target list, and board **H · Inline** (`HeaderInline.dc.html`) is the target header. Boards A–D, F, G and I are rejected explorations, kept as history.

## Intent

Every Lody screen is currently assembled from stock UIKit/HIG parts, which makes the app read as a system utility. The user wants Lody to have its own visual identity that can be recognized at a glance, while still using HIG structure and Liquid Glass for system chrome. The home inbox list goes first. It sets the design language that later screens will adopt.

Over three rounds the user established these principles:

1. **Compact.** Dense rows and no wasted vertical space. Round 1's colorful directions were rejected as "太花了" (too busy).
2. **Neutral.** System backgrounds with grayscale ink. Color appears only where it carries function.
3. **Flat, but not cards.** No inset-grouped cards and no floating card containers. Rows sit directly on the ground.
4. **System elements stay native.** Navigation, toolbar and search use Liquid Glass. Backgrounds are the system ones.

The identity comes from structure and glyphs, not from brand color: a status rail that hangs sub-agents under their parent session (Lody's "one agent runs the others"), a custom status glyph set, and monospaced metadata.

## Goals

- A token layer in LodyKit (text and functional colors, type, spacing, glyphs) that is the single source for the new language.
- Session rows, sub-agent rows, "more" rows, project rows and section headers match board E in every host that renders them (see Hosts).
- The inbox navigation header matches board H.
- **Ink** becomes the global default accent. The existing accent picker stays, with exceptions listed below.
- Light and dark mode, plus the existing dark-background preference (`soft` / `black`), all work.

## Non-goals

- Changing layouts beyond the shared rows and the inbox header. Chat, settings, sheets, the create-session form and the Share Extension keep their layout. They change only where the global accent reaches them (see Accent).
- New behavior. Section grouping, sort, view modes, search, swipe actions, collapse/expand, selection and navigation all keep their current logic.
- Changing what a row says. Row content stays as it is today (see Row content).
- A custom typeface. SF Pro and SF Mono only.
- New background colors.
- Inline approve/deny on the list. The `Review` control routes to the existing permission flow.

## Anti-goals

- Brand color washes, gradients, colored avatars or tinted section bands. These were tried in round 1 and rejected.
- Cards: inset-grouped sections, rounded row containers, or row shadows.
- Simulating Liquid Glass with decorative overlays (AGENTS.md). System glass comes from UIKit bar items and toolbar.
- Green as the accent. Diff additions stay `systemGreen`, paired with `systemRed`.
- Nested ternaries (AGENTS.md).

## Decisions

### Scope (user)

Global tokens, the home screen, and the shared row views wherever they are used. Other screens' layouts are not touched in this round.

### Accent (user)

Keep the accent setting and add **Ink** as a new choice, which becomes the global default.

- `LodyAccentChoice` gains `.ink` (raw value `"ink"`). `current` falls back to `.ink` instead of `.blue` when no value is stored. **No upgrade migration (user):** an existing install that never picked an accent has no stored value, so it moves to Ink. A stored choice, `"blue"` included, is kept.
- Ink resolves to the `ink` token: near-black in light mode, near-white in dark mode. Its foreground (text or icons on an ink fill) is the ground color. This extends today's `foreground` logic, which currently special-cases only custom colors.
- The Appearance picker (`AccentColorPicker`) shows Ink first.
- The Share Extension mirror (`LodyAccentChoice.mirror`) carries `"ink"` like any other value.
- **App-wide, with exceptions (user).** Every current `lodyAccent` use follows the accent, Ink by default, except these three:
  - **Chat links** (`ChatMarkdownTheme` and any other link styling) use `systemBlue`, whatever the accent is, so links stay distinct from body text.
  - **Switches** stop setting `onTintColor` from the accent and use the system default.
  - **The user message bubble** (`lodyUserBubble`) becomes a neutral fill, not an accent tint. My call on the value: `lodyInset`, which is already the recessed-chip color.
- `lodyTint("blue")` and the other legacy names keep resolving. `"blue"` returns the accent, so it becomes Ink by default. The builder audits its call sites, as part of verifying affected screens.
- The builder checks every screen that uses the accent (composer send button, onboarding buttons, `LodyForm`, `LodyGroupedList` system rows, and so on) in light and dark, so that nothing becomes invisible or low-contrast. An example would be an ink fill with an ink label.

### Hosts (user)

The new row style lives in the shared row views (`LodySessionRowView`, `LodyProjectRowView` and their `LodyGroupedList` registration path), so every host gets it:

- the inbox (`InboxController`);
- project detail (`ProjectController`), where "more" rows and project rows lead;
- archived sessions (`ArchivedSessionsController`);
- activity (`ActivityController`);
- the iPad / regular-width inbox column (`LodySidebar` in `SessionListView`). It **keeps its compact density**, but adopts the rail, the glyphs and the tree lines. Compact metrics: rail center x = 10 pt (today's compact mark center), text leading at today's compact leading, and child rows indented by one rail step. The builder sizes the compact metrics to keep today's row heights.

The other `LodyGroupedList` hosts that use system rows (settings pages and the like) keep their inset-grouped look in this round.

### List: board E, Rail (user)

All measurements are for the regular density at the default text size. Keep system text behavior: fonts scale through text styles and `UIFontMetrics`, with no special layouts for accessibility sizes (AGENTS.md).

**Container.** A flat list (`UICollectionLayoutListConfiguration` `.plain`, or the equivalent) on `ground` (the system background; see Tokens). There is no inset card and no cell background fill. Selection and highlight use a neutral fill across the full row width.

**Section header.** Label in `subheadline`-scale semibold (13 pt in the mock) using `secondary`, followed by the row count in mono `caption` using `tertiary`. Total header height is about 30 pt with the text sitting on the bottom (4 pt bottom padding). No uppercase and no hairline.

**Session row, primary (two lines, about 52 pt).**

- **Rail column.** The glyph is centered at x = 24 pt from the leading edge and aligned to the title's first line.
- **Text.** Starts at 46 pt. Trailing margin 16 pt. 8 pt vertical padding.
- **Line 1.** Title in `subheadline` (15 pt): semibold when unread or attention, regular otherwise. One line, truncating at the tail. Trailing relative time in mono 11.5 pt using `tertiary`.
- **Line 2.** See Row content. 12.5 pt using `secondary`.
- **Separator.** A 0.5 pt hairline (`line` token) under the text column only, starting at the text leading edge. It never crosses the rail.
- **Attention rows.** Add a trailing `Review` capsule (26 pt tall, ink fill, ground-colored 13 pt semibold label) aligned to the bottom of the row. Its touch target is at least 44 pt (see Left to the builder).

**Row content (user: keep the current content).** Line 2 shows what `SessionRows.row` produces today: project, then `·`, then branch, then model name (or "Not run"). Project and branch are set in mono 11.5 pt and the model in 12.5 pt. Hosts that show diffs today keep showing them in mono `systemGreen` / `systemRed`. The inbox keeps hiding diffs (`row.diff = [:]` stays). Board E's "agent type" and inbox diffs are not adopted. Truncation order when space runs out: model first, then branch, then project.

**Sub-agent row (child, one line, about 40 pt).**

- Text starts at 62 pt, glyph centered at x = 46 pt.
- Title is 14 pt regular, followed by the trailing time. My call: the model name follows the title after `·`, in `secondary`, when it fits.
- **Tree line.** A 1 pt `rail` vertical line at x = 24 runs from below the parent's glyph down through the children. Each child gets an elbow into its glyph (a 12 pt horizontal run with a 7 pt bottom-leading corner radius). On the last child the vertical line stops at the elbow.
- The parent's collapse/expand behavior stays. When collapsed, the parent shows its existing `collapsedValue` / urgent status, and no tree line is drawn.
- **Collapse trigger (my call).** Keep UIKit's outline-disclosure accessory on parent rows, tinted `tertiary`, so VoiceOver and `home.py` keep working. It sits after the time. On a parent that is also an attention row, the Review capsule sits to the left of the disclosure. Board E omits the chevron only because the mock is static.

**"More" row.** One line, about 40 pt, text at 46 pt, `secondary` color, no glyph.

**Project row.** Two lines, the same geometry as a primary row. A folder outline glyph in the rail using `secondary`. Project name in semibold. Line 2 holds the existing aggregate counts ("2 running · 1 failed"). Outline disclosure behavior is unchanged.

**Pinned.** Today's pin mark stays in front of the line-2 metadata. My call: recolor it from `systemYellow` to `secondary`, for neutrality.

### Status glyphs (my call, accepted in the playback without objection)

A Lody-drawn set that replaces the current dot, ring and badge pill. Each glyph is a 14 pt template drawn in code (Core Graphics or `CAShapeLayer`, not SF Symbols) so the shapes match the canvas exactly.

| State (`SessionState` + unread) | Glyph                                     | Color                    |
| ------------------------------- | ----------------------------------------- | ------------------------ |
| `attention`                     | filled circle with an exclamation cut out | `attention` (amber)      |
| `live`                          | track ring plus a 90° arc                 | track `line2`, arc `ink` |
| done or idle and unread         | solid 9 pt dot                            | `ink`                    |
| `failed`                        | ring plus an ×                            | `failure` (red)          |
| `done` / `idle`, read           | thin ring plus a check                    | `tertiary`               |
| `archived`                      | same as read done                         | `tertiary`               |
| project                         | folder outline                            | `secondary`              |

The `live` arc rotates slowly (about one turn per 1.6 s). It stops under Reduce Motion and while the row is offscreen. VoiceOver reads the state through the row's existing accessibility label. The glyph itself is not an accessibility element.

The text badge pill (`inbox.badge.*`) is no longer drawn in rows. It stays in the accessibility label.

Glyph and functional colors are fixed. They never follow the accent.

### Header: board H, Inline (user)

- **Left.** The existing workspace menu button (`InboxChrome.workspace`, a `LodyMenuButton`) restyled as a plain text button, with no glass of its own:
  - A 32 pt monogram square with a 9 pt continuous corner radius, filled with the **accent** and labeled in the accent foreground (Ink by default). The workspace image replaces the monogram when one is set, as today.
  - The workspace name in 17 pt semibold, followed by a small `tertiary` chevron.
  - Below the name, a mono 11 pt `secondary` status line built from `InboxDevices.summary` plus the running count, e.g. "3 machines · 2 running". When presence is unknown, use the existing `devices.unknown` string.
- **Right.** The filter and settings items as adjacent bar button items, so UIKit groups them into one Liquid Glass capsule. Keep settings' existing long-press → Debug. Keep regular width as it is today: the right items are hidden and search is stacked.
- No large title. The list starts directly under the 44 pt bar.
- **Bottom.** The existing toolbar keeps its search field and new-session button. The new-session button fill follows the accent (Ink by default).

### Tokens (my call: structure and values)

Add `packages/LodyKit/Sources/LodyKit/Appearance/LodyDesign.swift` (name is the builder's call) holding dynamic `UIColor`s, font helpers and metrics. Each dynamic color resolves light, dark and increased-contrast variants.

**Backgrounds stay system (user).** The design language adds no background colors. `ground` is an alias of the existing `UIColor.lodyBackground`: `systemBackground` in light mode, and in dark mode it honors `LodyDarkBackground` (`soft` → `#111113`, `black` → `#000000`). It is not the grouped background, because the list is flat. Text and glyph tokens are tuned against these system grounds. The canvas boards used a warm `#F7F7F6`, which is superseded.

| Token          | Light                                 | Dark                                     | Use                                            |
| -------------- | ------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `ground`       | `lodyBackground` (`systemBackground`) | `lodyBackground` (`#111113` / `#000000`) | list background                                |
| `ink`          | `#18181B`                             | `#F2F2F4`                                | primary text, Ink accent, live arc, unread dot |
| `secondary`    | `#6E6E76`                             | `#9C9CA5`                                | metadata, section labels                       |
| `tertiary`     | `#A1A1A8`                             | `#6A6A73`                                | time, counts, read-done glyph                  |
| `line`         | black 8%                              | white 8%                                 | row hairline                                   |
| `line2`        | black 12%                             | white 16%                                | glyph tracks                                   |
| `rail`         | black 16%                             | white 18%                                | tree lines                                     |
| `attention`    | `#D9820B`                             | `#F2A33A`                                | attention glyph                                |
| `failure`      | `systemRed`                           | `systemRed`                              | failed glyph                                   |
| diff add / del | `systemGreen` / `systemRed`           | same                                     | diff counts                                    |

`tertiary` is used only for non-essential text (time, counts). Under increased contrast, `secondary` and `tertiary` step one level darker in light mode and lighter in dark mode, so all text reaches at least 4.5:1 against `ground`. `attention` reaches at least 3:1 as a non-text glyph. Verify the values and adjust them if the audit fails.

Type helpers return text-style-based fonts: title `subheadline`, child title `subheadline` minus 1 pt via `UIFontMetrics`, meta `footnote` / `caption1`, and mono as `monospacedSystemFont` scaled by `UIFontMetrics` from 11.5 pt.

Metrics: the rail center (24 regular / 10 compact), text leading (46 primary / 62 child, regular), trailing margin (16), row heights (52 / 40, as minimums; content can grow them), and the section header height (30).

### AGENTS.md updates (part of the work)

AGENTS.md currently says "system blue for actions" and "System grouped rows use `LodyGroupedList` / `UICollectionViewListCell`". Update its UI baseline so that:

- Primary actions use the accent, which defaults to Ink. Chat links use `systemBlue`. Switches use the system default. Functional colors are limited to attention amber, failure red and diff green/red.
- Session and project rows use the flat rail style described here, in every host. System rows (settings and the like) remain grouped until they are migrated.
- Backgrounds are system (`lodyBackground` / `lodyGroupedBackground`). New UI uses `LodyDesign` tokens for text, glyph and functional colors.

Keep the existing rules that still hold: no green accent, native navigation and safe areas, 44 pt targets, VoiceOver labels, `UICollectionViewListCell` as the cell type.

## Left to the builder

- How `LodyGroupedList` switches session/project sections to the flat layout while system-row hosts stay inset-grouped. One example is a per-section appearance derived from the row kind. Do not add a second list component (AGENTS.md), and keep `UICollectionViewListCell`.
- How the tree lines are drawn: in the cell's content view from `parentId`, plus a "last child" flag computed when rows are built (`SessionRows.treeRows` knows group membership), or by another approach. `LodySidebar` needs the same data.
- **Review touch target.** The capsule is drawn 26 pt tall but must hit-test at 44 pt or more. Wire it to the same path a notification uses to open the session's pending permission (`SessionNavigation` / `PermissionController`). If no direct path exists, open the session. In compact density (the sidebar), My call: Review is omitted, and the attention glyph is enough.
- Exact glyph drawing code, and the animation mechanism for the live arc.
- Compact-density metrics for the sidebar, within the constraint of keeping today's row heights.

## Verification

- `pnpm check`, `pnpm bundle`, an iOS simulator build.
- Before changing shared code, capture baselines for the inbox, project detail, archived, activity and an iPad sidebar, and for at least one settings page. The settings page must look unchanged afterward.
- Update `apps/ios/verification/ui/inbox.py`, `home.py`, `home-workspace.py`, `appearance.py`, and the archived / activity / project cases, as needed: section order and row identity still hold. Add checks for:
  - the header status line;
  - Ink as the default when no accent is stored;
  - an explicit accent choice that persists;
  - chat links staying blue under Ink;
  - parent/child tree rows (which needs a fixture with sub-agents);
  - the sidebar's rail rows at compact density.
- Screenshots in light, dark, and dark + `black` background, in English only (AGENTS.md).

## Artifacts

- Design canvas "Lody Design Language": https://claude.ai/artifact/NdX3quAv1Paddf9qeEoTS7
  - Round 1 (A Instrument, B Workshop, C Workbench): brand directions, all rejected as too busy.
  - Round 2 (D Ledger, E Rail, F Tags): flat cell styles. **E chosen.**
  - Round 3 (G Large title, H Inline, I Bottom controls): headers on top of E. **H chosen.** H was updated to system backgrounds.
  - Each board has a `dark` tweak that previews dark-mode values. Board line-2 content ("agent type", inbox diffs) is superseded by Row content above.
