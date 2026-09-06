# `lib/commands` command and shortcut system

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

This directory is the source of truth for application-level shortcuts, the command
registry, the command palette, and keyboard-shortcut settings. Local interactions such
as dialog Escape, list j/k, or composer Submit stay in their component key handlers.

`KeyScope` lets local and application-level shortcuts negotiate ownership. For example,
when a rich-text editor owns focus, Cmd+B must format text rather than toggle the
sidebar. A scope is not a command: it is not listed, configurable, or executable. It
only tells global dispatch to yield for events originating in its subtree.

## Invariants

- `when()` is the sole command-availability predicate. Both palette visibility and
  dispatch honor it; do not add screen-specific filters elsewhere.
- `built-ins.ts` registers `when: () => false` placeholders so configurable shortcuts
  remain visible when their real component is unmounted. A mounted implementation
  shadows the placeholder and removal restores it.
- The registry is a per-id stack. Multiple `register` calls push implementations and
  the most recently mounted one wins. Hidden retained tabs/toolbars must pass
  `enabled=false` to `useCommand` or they can shadow the active surface.
- Binding-level `when` limits only the default binding. User overrides do not inherit
  it. Command-level `when` limits the command through every execution path.
- `useKeyScope(id, ref)` registers a scope and automatically removes it. Dispatch finds
  scopes containing `event.target`, preferring the innermost. A matched scope yields all
  app shortcuts unless the command has `allowInTextInput: true`; `claims` narrows the
  yielded bindings.
- A scope that yields an event must not call `preventDefault`: the editor/local keymap
  still needs to receive it. This applies after a shortcut is rebound as well.
- `$mod` means Command on macOS and Control elsewhere. Formatting is platform-aware.
- `layout.toggleZenMode` owns `$mod+.` outside editors. Monaco claims that binding
  locally for Quick Fix, so the app command must yield while focus is in its subtree.
- Alt+letter matching and recording must use `event.code`; macOS `event.key` may be a
  generated glyph such as `∫`.
- Shortcut capture pauses dispatch. It finishes after the last modifier is released and
  keeps a one-second settle window because macOS may suppress letter keyup while
  Command remains held.
- User bindings are per-device localStorage state. `[]` explicitly unbinds all defaults;
  `null` restores defaults.

## File responsibilities

- `registry.ts`: registration stack, execution, capture-phase dispatch, pause state,
  user overrides, and conflict lookup.
- `shortcuts.ts`: `COMMAND_SHORTCUTS` defaults plus the renderer display mirror for OS
  global shortcuts. `@lody/shared`'s `GLOBAL_SHORTCUT_DEFAULTS` owns global ids and
  bindings.
- `key-matcher.ts`: binding parsing, keyboard-event matching, and physical-key mapping.
- `key-capture.ts`: interactive recording and registry pausing.
- `built-ins.ts`: palette toggle and placeholder registrations.
- `user-bindings.ts`: validated localStorage persistence.
- `format.ts`: platform-aware binding/part presentation.
- `platform.ts`, `types.ts`, `use-commands.ts`, `palette-state.ts`, and `index.ts` provide
  runtime detection, contracts, React registration helpers, state, and exports.

## UI wiring

- Command palette: `components/commands/command-palette.tsx`,
  `command-palette-view.tsx`, and `fuzzy-match.ts`.
- Settings: `components/settings/keyboard-shortcuts-setting.tsx` lists every command,
  records bindings, detects conflicts, unbinds, and resets.
- Electron menu bridge: `components/electron-menu-handler.tsx` converts
  `lody:menu-action` IPC into `commands.execute()`, except window chords.
- Cmd/Ctrl+W is a native menu accelerator, not a registry command. Do not restore a
  `role: 'close'` accelerator and do not bind `$mod+w` in the renderer. Main
  `closeFocusedTabOrWindow` closes DevTools, then broadcasts
  `close-current-tab-or-window` to the main window. The shell
  (`desktop-tab-or-window-close.ts`) asks the top tab closer; session-detail
  registers one. No closer (Chat Landing and other surfaces) closes the
  BrowserWindow. The main-process `close` handler still hides on macOS instead of
  quitting. The chord is not listed or rebindable in keyboard settings.
- Commands carry `titleKey`; palette/settings resolve it through i18n at render time.
- Desktop native Tab handling is in
  `apps/electron/src/renderer/src/native-tab-behavior.ts`.

OS-level shortcuts are registered by Electron even when the app is unfocused. Their
cross-process path is documented in [global-shortcuts.md](global-shortcuts.md).
