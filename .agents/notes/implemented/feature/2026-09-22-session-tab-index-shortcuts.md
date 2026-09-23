# Direct session-tab switching with ⌘1–⌘9

Status: implemented
Translation: current

[中文](2026-09-22-session-tab-index-shortcuts.zh.md)

## Abstract

The desktop session tab bar only offered relative switching (⌘⇧, / ⌘⇧.) — reaching
a specific tab meant stepping through its neighbours. Nine new registry commands now
bind the browser convention: `Mod+1`–`Mod+8` select that conversation tab and `Mod+9`
selects the last one. Each is a separate command (`session.switchToTab1`…
`session.switchToTab8`, `session.switchToLastTab`) because the registry maps one
command to one `run` and the keyboard-shortcut settings row edits a command's first
binding only; a single nine-binding command could not be rebound per position. The
bindings are electron-only like the existing tab-stepping chords — a browser owns
⌘\<digit\> for its own tab strip.

## Problem and decision

Indexed jumps index into `orderedSessionTabIds` — the same list `session.nextTab` /
`session.previousTab` cycles through — so digit positions match the visible
`variant="session"` strip exactly (parent tab first, then child and draft tabs in
persisted order). `switchToTabN` is available only while more than N−1 tabs exist;
`switchToLastTab` while any tab exists. Both resolve through
`handleSessionTabSelect`, so a digit press pushes history like a click.

Alternatives considered: a single command with nine keybindings was rejected because
`run()` receives no event context (the command could not tell which digit fired) and
settings renders only `currentBindings[0]`, making positions 2–9 uneditable. Fewer
positions (e.g. 1–4) were rejected for no benefit — the registry already tolerates
a nine-row addition to the Navigation category.

`session.newTabOrTerminal` also gained the browser-convention `Mod+t` as a second
electron-only default — ⌘T opens a new conversation tab on desktop. It stays a
secondary binding rather than replacing `Alt+n`, which remains the first (and
therefore settings-editable) binding; on web the browser claims ⌘T for its own
tab strip, so only `Alt+n` applies there.

## Right-aside isolation

Digit jumps are structurally incapable of touching the right aside. Viewer tabs
(`file:`/`diff:`) and side-panel tabs (PR, Files, Side Chat) are never members of
`orderedSessionTabIds`, so no index can address them. `handleSessionTabSelect`
only moves the desktop focus-region ref (Cmd+W targeting) and writes `?tab=`;
`writeSessionUrlTab` merges the tab param into the existing search, so `?pr=` /
`?browser=` survive a conversation switch, and `isSidebarOpen` /
`activeViewerTabId` / `activeSidebarTab` reset only on a `sessionId` route change,
never on an in-session `?tab` switch. The one registered `KeyScope` (Monaco Quick
Fix) claims `Mod+.` only, so digit chords dispatch globally — including while the
composer or a right-aside editor owns focus, matching browser ⌘\<digit\>
semantics. One inherited quirk: an archived-but-not-closed child session occupies
a position in `orderedSessionTabIds` without a visible pill in the `variant="session"`
strip; that is the shared ordered-list semantics `nextTab`/`previousTab` already
use, not a new divergence.

## Verification limits

`commands-built-ins.test.ts` asserts the defaults: empty on web, `Mod+1`–`Mod+8` /
`Mod+9` under the electron runtime. Desktop journey `LODY-SHORTCUT-002`
(`e2e/src/features/shortcuts.feature`, `@P1 @runtime-simulator`) drives a real
Electron keypress path end to end: scripted-ACP session, `Mod+t` opening two
draft tabs, then `Mod+1` to the parent tab, an out-of-range digit leaving
selection unchanged, `Mod+2` to the second tab, and `Mod+9` to the last tab,
asserted through the `Session tabs` tablist's `aria-selected` state.

Related: command/shortcut system rules in
`packages/components/src/lib/commands/AGENTS.md`.
