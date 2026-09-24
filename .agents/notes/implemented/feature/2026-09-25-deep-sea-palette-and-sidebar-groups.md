# Deep-sea palette, raised popovers and sidebar group labels

Status: implemented
Translation: current

[中文](2026-09-25-deep-sea-palette-and-sidebar-groups.zh.md)

## Abstract

The warm Vesper palette read as brown: a warm cast darkened is coffee, and it covered every
surface. Lody's Vesper is now a quiet graphite with only a faint cool cast, and the brand's
jellyfish cyan (#7CC4E8) is the one glowing accent: links, selection, focus and primary
actions. Dropdowns and popovers sit on the composer's raised surface instead of the canvas.
In the sidebar, machine, GitHub Worktrees and Chats groups share one label style (small,
bold, faint, no icon) above 14px project, repo and conversation rows. Machines are
identified by an Offline pill and a hover card instead of an icon. The brightness ceiling
itself is in [reading contrast](2026-09-24-reading-contrast.md).

## Decision

- Palette (`bundled/vesper-deep-sea-palette.ts`), applied once when the bundled theme
  resolves, so app tokens, terminal, code highlighting and `--vscode-*` agree:
  - Surfaces are hand-tuned graphite: canvas #131416, sidebar #191A1D, cards and inputs
    #1E2023, selection and hover #25272B, borders #2B2D31 (about 7% saturation).
  - Every other neutral gray keeps its lightness and takes a cool cast of a few channel
    units that fades toward white, so text stays near-neutral.
  - The orange accent (#FFC799, #FFCFA8) becomes jellyfish cyan (#7CC4E8, #9AD3EF),
    except where it means warning or modified (`editorWarning.foreground`,
    `editorGutter.modifiedBackground`), which stay amber.
- Reading colors (`READING_THEME_OVERRIDES`): prose, the selected row and the active tab
  #E4E5E7 (HSL lightness 90%, 14.6:1), sidebar titles #BCBEC2 (9.9:1), the selected
  row on a 12% cyan tint (#252E35). Dark caps: interface 13:1, prose 14.6:1, headings
  16.3:1, sidebar rows 9.9:1. The Electron window and title bar use the canvas color.
- Popovers: in dark themes `--popover` is the composer's surface (`--input` at 90% over
  the canvas). Vesper's widget background equals the editor color, which sank every
  dropdown into the page.
- Links are cyan with the underline on hover only. `.markdown-renderer a` sets the color:
  the renderer's `[&_a]:text-markdown-link` never applied (Tailwind v4 generates no
  variants for a hand-written class), so links used to inherit the prose color and were
  told apart only by their underline. GitHub reference chips use the same hue.
- List items are 4px apart (were 8px). The composer placeholder is at 85% of its token
  (about 4.9:1; was 40%, about 2.1:1).
- Sidebar groups (`SIDEBAR_GROUP_LABEL_CLASS` in `sidebar-row-shared.tsx`):
  - Labels: `0.82 × --ui-font-size` (11.5px), bold, 70% of the muted sidebar color, a
    26px row, no icon and no hover fill. Every group label uses this one class, so size
    and color cannot drift between machines, GitHub Worktrees and Chats.
  - Rows: projects, repos and conversations are 14px (1em) regular; project folders and
    repo avatars are 16px. Groups and their rows share a left edge; conversations are the
    only indented level. 16px between open groups, 2px from a label to its first row.
  - Machine and Chats labels stick to the top while their rows scroll.
  - Machines: this device first, then the user's other machines, then teammates'
    machines, which start collapsed (a manual toggle is remembered). `.local` is dropped
    from the label. An Offline pill follows an offline machine's name; online and unknown
    show nothing, so a machine never flashes offline while presence connects. Hovering
    the label opens a card (`sidebar-machine-card.tsx`): full name, online state, owner,
    OS and project count. It shares `SidebarHoverCard` with the conversation info card,
    so only one card opens at a time.

## Alternatives

- A warm white point: read as reddish brown on dark surfaces.
- Blue ink surfaces (#12151A, about 18% saturation): too blue and too large a change.
- Icons on group labels: a monitor or GitHub mark sits in the same column as project
  folders and repo avatars, so labels and rows read as one level.
- A status dot before machine names: it marks machines as a different kind of section
  from GitHub Worktrees and Chats.
- Indenting projects under their machine: a third indentation level for conversations
  costs too much width.
- Uppercase overline labels: hostnames become hard to read.
- A "Team devices" parent group: adds a level and touches keyboard navigation.
- "Last online" time in the machine card: the sidebar has presence, not a last-seen
  time (the legacy `lastSeen` field must not be used).

## Verification and limits

- `tests/vscode-theme-css.test.ts` and `tests/vscode-theme.test.ts` check the resolved
  palette, the cyan accent, the amber warning and the raised popover.
  `tests/sidebar-machine-card.test.tsx` checks that only a known-offline machine gets the
  pill and what the hover card says. Components suite passes.
- Checked on a local web build: group labels measure 11.48px/700 in one color; rows 14px.
- Not done: an activity dot on collapsed groups, owner avatars in the list, a sticky
  GitHub Worktrees label (its repos render outside its container). Light themes are
  unchanged.
