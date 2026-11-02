# Keyboard shortcut settings search

Status: implemented
Translation: current

[中文](2026-10-07-keyboard-shortcut-search.zh.md)

## Abstract

The Keyboard Shortcuts settings page listed every command with no way to find one,
and no way to ask "what is bound to this key?". A search field above the list now
filters rows by name, or — with the keyboard toggle at the field's end switched on —
by keystroke. The two modes are mutually exclusive. A keystroke matches a row when
any of its current bindings has the same canonical form, so aliases, modifier order
and secondary bindings all count. Tests were written alongside the change but had
not run at the time of writing.

## Decision

- **One field, two modes.** The toggle is an icon button in the field's trailing
  slot (`aria-pressed`, tertiary when off, accent when on). Turning it on clears
  the text query; turning it off clears the key filter. Only one filter is ever
  active, though the pure matcher still accepts both.
- **Name mode.** Case-insensitive substring of the displayed (translated) label,
  the untranslated `title`, or the command id, so an English name or an id still
  finds a row while the interface is in Chinese. The query is trimmed; whitespace
  alone filters nothing. Escape in the field clears a non-empty query.
- **Keystroke mode.** The field becomes a read-only display in the same well
  (`InputShell` from `@lody/ui/input`): a placeholder, the live preview while keys
  are held, then the captured combo as key caps. It records with `useKeyCapture`,
  the hook rows use to rebind, so command dispatch and OS global shortcuts stay
  paused and only one recorder listens. Each combo replaces the last without
  leaving the mode: `onCapture` returns `false`, which keeps the capture (and the
  pause) alive.
- **Leaving keystroke mode.** A bare Escape exits, like the toggle. Other cancels —
  a row starting its own recording, or the window losing focus — keep the mode and
  the filter, because the user may be rebinding a row the filter shows; clicking or
  focusing the field resumes listening. `useKeyCapture`'s `onCancel` now receives
  the reason (`escape`, `blur`, `superseded`, `manual`) to tell these apart;
  existing callers ignore it.
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

- A key chip with a clear button and a separate record button beside the field:
  replaced by the in-field toggle, which keeps one control with one edge.
- Fuzzy matching like the command palette: rejected for this page, where the list
  is short and a substring keeps the result predictable.
- A dedicated capture path for search: unnecessary. The existing hook already
  accepts a bare key such as Enter. Escape stays reserved for leaving the mode, so
  a bare Escape cannot be searched by keystroke; search for it by name instead.

## Limits

- Rebinding a row while a keystroke filter is active may make that row disappear,
  because it no longer matches. This is accepted.
- While keystroke mode listens, every key goes to the capture, so Tab does not move
  focus out of the field; Escape is the keyboard way out.
- Unit tests (`packages/components/tests/keyboard-shortcuts-filter.test.ts`), a
  jsdom render test (`packages/components/tests/keyboard-shortcuts-setting-search.test.tsx`)
  and the `@lody/ui` field tests were written with the change; they, type checks,
  and Storybook were not run in the authoring environment.
