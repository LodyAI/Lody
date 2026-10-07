# Keyboard shortcut settings search

Status: implemented
Translation: current

[中文](2026-10-07-keyboard-shortcut-search.zh.md)

## Abstract

The Keyboard Shortcuts settings page listed every command with no way to find one,
and no way to ask "what is bound to this key?". A search bar above the list now
filters rows by name and by a recorded keystroke; the two filters combine with AND.
A keystroke matches a row when any of its current bindings has the same canonical
form, so aliases, modifier order and secondary bindings all count. The keystroke is
recorded with the same capture hook the rows use; tests were written alongside the
change but had not run at the time of writing.

## Decision

- **Name filter.** Case-insensitive substring of the displayed (translated) label,
  the untranslated `title`, or the command id, so an English name or an id still
  finds a row while the interface is in Chinese. The query is trimmed; whitespace
  alone filters nothing. Escape in the field clears a non-empty query.
- **Keystroke filter.** A keyboard button to the right of the field starts
  `useKeyCapture`, the hook rows use to rebind. It already pauses command dispatch
  and OS global shortcuts and cancels any other recording, so a search keystroke
  never fires a command and the two recorders cannot both listen. The captured
  combo shows as a key chip with a clear button.
- **Matching.** Both sides go through `canonicalizeBinding`; every binding from
  `commands.getKeybindingsFor` is compared, not only the primary one shown in the
  row. Global shortcut rows match on their live binding. An unbound row never
  matches a keystroke.
- **Layout.** Categories with no matching rows, and the global section when empty,
  are hidden; when nothing matches the page shows one "No matching shortcuts" note.
- The matcher is a pure function in
  `packages/components/src/components/settings/keyboard-shortcuts-filter.ts` so its
  rules are tested without rendering.

## Alternatives

- Fuzzy matching like the command palette: rejected for this page, where the list
  is short and a substring keeps the result predictable.
- A dedicated capture path for search: unnecessary. The existing hook already
  accepts a bare key such as Enter (it finalizes once no modifier is held), so it
  was reused unchanged. Escape stays reserved for cancelling a recording, so a bare
  Escape cannot be searched by keystroke; search for it by name instead.

## Limits

- Rebinding a row while a keystroke filter is active may make that row disappear,
  because it no longer matches. This is accepted.
- Unit tests (`packages/components/tests/keyboard-shortcuts-filter.test.ts`) and a
  jsdom render test (`packages/components/tests/keyboard-shortcuts-setting-search.test.tsx`)
  were written with the change; they, type checks, and Storybook were not run in
  the authoring environment.
