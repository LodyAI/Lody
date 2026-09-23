export type Platform = 'mac' | 'win' | 'linux' | 'ios' | 'android' | 'unknown';
export type Runtime = 'web' | 'electron' | 'mobile';

/**
 * A key binding spec.
 *
 * Key string syntax follows `@tanstack/hotkeys` single-chord syntax:
 *   - Modifiers separated by `+`. Recognized modifiers: `Mod`, `Shift`, `Alt`, `Control`,
 *     `Meta` (case-insensitive). `CommandOrControl` aliases `Mod`; `cmd` / `command` alias
 *     `Meta`; `option` aliases `Alt`; `ctrl` aliases `Control`.
 *   - `Mod` resolves to ⌘ on macOS and Ctrl elsewhere — the cross-platform "primary" modifier.
 *   - The non-modifier token at the end is the key. Letters are case-insensitive.
 *     For named keys, use the standard `KeyboardEvent.key` value (e.g. `Enter`, `Escape`, `ArrowUp`,
 *     `Slash`, `?`).
 *   - Examples: `Mod+b`, `Mod+Shift+p`, `Escape`, `?`.
 *
 * Sequences are intentionally outside the command registry contract.
 */
export type KeyBinding = {
  key: string;
  /** Restrict this binding to specific platforms. Undefined = all platforms. */
  platforms?: Platform[];
  /** Restrict this binding to specific runtimes. Undefined = all runtimes. */
  runtimes?: Runtime[];
  /**
   * Optional keyboard-only predicate. Programmatic command execution and user overrides do not
   * inherit this guard, so a restrictive default binding can coexist with a globally available
   * command.
   */
  when?: (event: KeyboardEvent) => boolean;
  /**
   * Whether to call `event.preventDefault()` on match. Default: true.
   * Set false if the binding intentionally cooperates with native behavior.
   */
  preventDefault?: boolean;
};

export type CommandCategory =
  | 'Navigation'
  | 'Session'
  | 'Editor'
  | 'View'
  | 'Workspace'
  | 'Help'
  | 'Other';

export type Command = {
  /** Unique stable identifier. Convention: dot-separated, e.g. `sidebar.toggle`. */
  id: string;
  /** Human-readable label shown in palette / cheatsheet. Treated as the English fallback
   *  when `titleKey` is set. */
  title: string;
  /**
   * Optional i18n key for the title. When present, display surfaces (command palette,
   * keyboard-shortcut settings) resolve the label via `t(titleKey, { defaultValue: title })`
   * at render time, so it stays correct across language changes. Use this for commands
   * registered imperatively outside React (e.g. built-in placeholders) that can't call
   * `t()` themselves; React registrations can just pass an already-translated `title`.
   */
  titleKey?: string;
  category?: CommandCategory;
  /**
   * Optional default key bindings. Strings are shorthand for `{ key }` with default options.
   * Multiple bindings invoke the same command (useful for platform alternatives).
   */
  keybindings?: (string | KeyBinding)[];
  /**
   * Optional context predicate evaluated at execution time. If it returns false, the binding
   * does not fire and `execute()` returns false. Use `when` for static commands whose
   * applicability is conditional. For lifecycle-bound commands prefer mounting/unmounting.
   */
  when?: () => boolean;
  /** Hide from command palette. Still bound and still invokable via `execute()`. */
  hidden?: boolean;
  /**
   * Let this command's keybinding fire even while a text-editing scope is active
   * (see `registerKeyScope`). Off by default so a new app command can never
   * silently steal a key from an editor: ⌘B belongs to bold while you are
   * writing, whatever else it is bound to elsewhere.
   *
   * Only for commands that genuinely must work mid-typing — opening the command
   * palette, sending a message, dismissing. Everything else should stay out of
   * the way.
   */
  allowInTextInput?: boolean;
  /** The action. */
  run: () => void | Promise<void>;
};

/**
 * A focus-scoped claim on keyboard input, registered by a component that owns a
 * text-editing surface (the task body editor, a composer).
 *
 * Scopes are NOT commands: they never appear in the palette or the shortcut
 * settings, and they are not rebindable. They exist so a local surface can say
 * "while focus is inside me, these keys are mine" without every local shortcut
 * having to become an app-level command.
 */
export type KeyScope = {
  /** Stable identity, for debugging and for replacing a scope in place. */
  id: string;
  /** Active when focus is inside this element. */
  element: () => HTMLElement | null;
  /**
   * Keys this scope claims, as binding strings (`Mod+b`). Omit to claim
   * EVERYTHING except commands marked `allowInTextInput` — the right default
   * for a rich text editor, which owns far more keys than it is practical to
   * enumerate.
   */
  claims?: string[];
};
