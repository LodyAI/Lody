# Settings pages speak the Preferences row grammar

Status: implemented
Translation: current

[中文版](2026-09-26-settings-row-grammar.zh.md)

## Abstract

After the flat settings pane shipped, the owner rated each tab: Preferences
good, About fine; Account, General and Billing "very bad"; Appearance and Agent
Roles "odd"; Agents "not great". Read against the code, the good tabs share one
grammar: every group is titled by meaning, and every line is a `CompactRow` with
one answer on the right, built from the shared surface with about six bespoke
styles. The bad tabs each invent their own rows (multi-control record cards,
avatars, badges, trash icons, meters, a fourth type size) and put boxed record
cards next to flat preference rows on one page. Account and General now use the
Preferences grammar throughout. Records become rows too: a name, one line of
state, and one answer (a value, a menu, or one button), with other actions moved
into that menu or the record's own detail. The other tabs are unconverted.

## Diagnosis

Measured in `packages/components/src/components/settings` on `main` (8f4b9f49):

| Tab | Owner | Bespoke StyleX keys | What breaks the grammar |
| --- | --- | --- | --- |
| Preferences | good | 6 | none: titled groups, `CompactRow`s answered by Switches or one Select |
| About | fine | 9 | none |
| Account | very bad | 31 | email as a header aside; machine rows with a badge, an Agent icon stack, "Configure", a folder menu and an icon button; Sign Out mid-page |
| General | very bad | (same file) | members with avatars, a ghost role menu and red trash icons; invitations with mail tiles and two actions; boxed next to flat |
| Billing | very bad | 52 | ten groups with two titles; a 1.125em plan name; meters, perks with accent checks, six badges, text-link actions, a nested scroller |
| Appearance | odd | 12 | untitled first group holding Theme and Language; font size twice with two controls; a terminal preview block |
| Agent Roles | odd | catalog | catalog rows: 12px names under a glyph tile, two badges each |
| Agents | not great | 46 + 22 | provider rows with inline meters and hover-only actions |

Flat versus card was not the cause: Preferences is flat, and the owner rejected
a "remove flat" attempt ("不是这个的问题"). The superseded attempt, PR #997,
polished Account's bespoke layout (a subgrid of machine columns, then a
connected-accounts card) and was closed.

## Decision

- A settings line is a `CompactRow`: a label, an optional helper that says what the
  label cannot, and one answer.
- A record is a row too. Machines: the name, "This machine · Online · darwin ·
  Private · 6 Agents · 10 directories", and **Manage**, which opens its settings.
  Agents, sharing and directories live on that page, so the row's Agent stack,
  Configure button and directory menu are gone. Tokens: the note, then preview ·
  source · created · last used, then **Revoke**. Members: the name, their email,
  and their role as a menu that also removes them. Invitations: the email, the
  role, and the status as a menu that copies the link or withdraws the invitation.
- Connected accounts stay as on `main`: one Profile row answered by the row of
  provider logos. A per-provider group was tried and rejected by the owner.
- Account's order: Profile (email, name, avatar, connected accounts), My machines,
  CLI Token, and Sign-in (password, then Sign out) last.
- On the flat pane, no group on these pages is boxed. A header action that does
  something is text ("Create Token", "Invite members"), not a bare glyph.
- Token dates follow the product language (`toIntlLocaleOrEn`), not the host locale.

## The pane's white page (regression fix)

`surface.canvas` is `colors.elevatedBackground`, meant to be the panel's own fill:
white in light mode, because `[data-settings-surface]` remaps `--card` to
`--popover`. Since #961 the product palette declares `elevatedBackground:
hsl(var(--card))` on the root. A custom property is computed where it is
declared and inherited as that value, so the pane's remap never reached the
token. Measured in the `Settings/DesktopSettingsModal` story, the page was
`rgb(239,239,241)` (the root card) next to a nav at about 94.7%: the nav's step
had vanished and the whole dialog read gray. `productSettingsSurfacePalette`
(`lody-ui-palette.stylex.ts`) re-declares `elevatedBackground` and
`secondaryBackground` on the pane, so they resolve against the pane's own
`--card`. The page measures `rgb(255,255,255)` again, the nav keeps its step, and
dark mode is unchanged because the remap applies only in light mode.

## Limits and next steps

Billing, Appearance, Agent Roles, Agents and the other catalogs (MCP, Shares,
Prompt Shortcuts) still box their records; they come next, one PR each, against
the same table. Removing a member and withdrawing an invitation now take two
clicks (menu, then item) instead of one icon.

## Verification

- `Settings/AccountSettings/DesktopPaneAccount` and `DesktopPaneWorkspace` render
  both pages in the pane scope and material. Screenshots were taken before (the
  three components swapped back to `main`) and after, in Chinese, in both palettes.
- `tests/account-machines-overview.test.tsx` covers the status line, the local
  machine and the single Manage button.
- The pane's fill was measured with `getComputedStyle` in Chromium in both palettes;
  jsdom computes no StyleX styles, so no unit test covers it.
- Not verified in the packaged Electron app.

Related: [Settings rhythm and material](2026-09-25-settings-rhythm-and-image-peek.md).
