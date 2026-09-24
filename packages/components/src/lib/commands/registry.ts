import { canonicalizeBinding } from './key-matcher';
import { getPlatform, getRuntime } from './platform';
import {
  createShortcutUsagePayload,
  type ShortcutUsageAnalyticsHandler,
} from './shortcut-analytics';
import { keybindingAppliesToEnvironment, UNINTERCEPTABLE_WEB_KEYS } from './shortcuts';
import type { Command, KeyBinding, KeyScope } from './types';
import { loadUserBindings, saveUserBindings, type UserBindingsMap } from './user-bindings';

type ResolvedBinding = {
  raw: string;
  canonical: string;
  preventDefault: boolean;
  when?: KeyBinding['when'];
  commandId: string;
};

type CommandRegistration = {
  command: Command;
  order: number;
};

type ScopeRegistration = {
  scope: KeyScope;
  /** Canonicalized once at registration; `undefined` means "claims everything". */
  canonicalClaims: Set<string> | undefined;
};

/**
 * Central command + key-binding registry.
 *
 * Design tradeoffs:
 *   - DOM listener ownership stays in `CommandShortcutHost`, which uses TanStack Hotkeys for
 *     parsing and matching behind one capture-phase listener. The registry only decides which
 *     matching command may run.
 *   - Stack duplicate ids so stable built-in definitions stay visible/customizable while
 *     route-scoped components temporarily provide the live handler. Rejected replace-only:
 *     unmounting a session page would remove its shortcut from Settings entirely.
 *   - Duplicate KEYS across different ids only emit a dev warning. Rejected hard-throw:
 *     context-sensitive bindings remount frequently and would constantly trip it.
 *   - User overrides FULLY REPLACE the command's declared `keybindings` when present
 *     (empty array = explicitly unbound). Rejected merge-with-defaults: there'd be no
 *     way to express "remove the default" without a sentinel leaking storage detail.
 *   - User-override storage is localStorage (per-device). Rejected Loro sync: a keymap
 *     is tied to the physical keyboard, not the workspace.
 *   - Local key handlers (Esc to close a dialog, j/k inside a list) are NOT migrated
 *     here — they stay inline next to the component that owns them. This registry is
 *     for app-level commands worth surfacing in the palette/cheatsheet/settings.
 */
class CommandRegistry {
  private commandStacks = new Map<string, CommandRegistration[]>();
  private activeCommands = new Map<string, CommandRegistration>();
  private nextRegistrationOrder = 0;
  private userOverrides: UserBindingsMap = {};
  private userOverridesLoaded = false;
  private bindings: ResolvedBinding[] = [];
  // Derived indexes rebuilt alongside `bindings`. Keep them in sync via `rebuildBindings`.
  private bindingsByCommand = new Map<string, string[]>();
  private commandByCanonical = new Map<string, string>();
  private snapshot: Command[] = [];
  private listeners = new Set<() => void>();
  private paused = false;
  // Innermost-last, like the command stacks: a scope registered later wins.
  private scopes: ScopeRegistration[] = [];
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private shortcutAnalyticsHandler: ShortcutUsageAnalyticsHandler | null = null;

  /**
   * Suspend dispatch without unbinding anything. Used by the rebinding UI so the
   * live binding doesn't fire while the user is pressing the same keys to rebind it.
   * Cancels any in-flight `pauseFor` timer — explicit wins over timed.
   */
  setPaused(paused: boolean): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.paused = paused;
  }

  /** Pause then auto-resume after `ms`. See `useKeyCapture` for the settle-window rationale. */
  pauseFor(ms: number): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.paused = true;
    this.pauseTimer = setTimeout(() => {
      this.paused = false;
      this.pauseTimer = null;
    }, ms);
  }

  isPaused(): boolean {
    return this.paused;
  }

  setShortcutAnalyticsHandler(handler: ShortcutUsageAnalyticsHandler | null): void {
    this.shortcutAnalyticsHandler = handler;
  }

  /**
   * Register a command. Returns a dispose function that unregisters this exact registration.
   * If the same id is already registered, the new registration becomes active until disposed.
   */
  register(command: Command): () => void {
    const registration: CommandRegistration = {
      command,
      order: ++this.nextRegistrationOrder,
    };
    const stack = this.commandStacks.get(command.id);
    if (stack) {
      stack.push(registration);
    } else {
      this.commandStacks.set(command.id, [registration]);
    }
    this.activeCommands.set(command.id, registration);
    this.rebuildBindings();
    this.publishSnapshot();
    return () => this.disposeRegistration(command.id, registration);
  }

  unregister(id: string): void {
    if (!this.commandStacks.delete(id)) return;
    this.activeCommands.delete(id);
    this.rebuildBindings();
    this.publishSnapshot();
  }

  /**
   * Register a focus scope. Returns a dispose function.
   *
   * Deliberately does NOT touch `commandStacks`, `bindings`, or the snapshot: a
   * scope is not a command, so it never reaches the palette, the shortcut
   * settings, or `execute()`. Nothing else in the registry needs rebuilding
   * when one mounts.
   */
  registerKeyScope(scope: KeyScope): () => void {
    const registration: ScopeRegistration = {
      scope,
      canonicalClaims: scope.claims
        ? new Set(scope.claims.map(canonicalizeBinding).filter((claim) => claim !== null))
        : undefined,
    };
    this.scopes.push(registration);
    return () => {
      const index = this.scopes.indexOf(registration);
      if (index !== -1) this.scopes.splice(index, 1);
    };
  }

  /**
   * The innermost active scope for this event, or undefined.
   *
   * Activity is decided by where the event actually happened, not by a focus
   * flag the scope maintains: that makes it correct for keys dispatched into
   * shadow/portal content, and it cannot go stale if a component forgets to
   * clear its own flag on blur.
   */
  private activeScopeFor(event: KeyboardEvent): ScopeRegistration | undefined {
    if (this.scopes.length === 0) return undefined;
    // Not `instanceof Node`: this module is imported by tests that run without
    // a DOM, where the global would be undefined and the check would throw.
    const target = event.target as Node | null;
    if (!target) return undefined;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const registration = this.scopes[i]!;
      const element = registration.scope.element();
      if (element && (element === target || element.contains?.(target))) {
        return registration;
      }
    }
    return undefined;
  }

  /** Programmatically run a command (used by command palette + Electron menu IPC bridge). */
  execute(id: string): boolean {
    const cmd = this.activeCommands.get(id)?.command;
    if (!cmd) return false;
    if (cmd.when && !cmd.when()) return false;
    try {
      void cmd.run();
    } catch (error) {
      console.error(`[commands] failed to execute "${id}"`, error);
      return false;
    }
    return true;
  }

  get(id: string): Command | undefined {
    return this.activeCommands.get(id)?.command;
  }

  list(): readonly Command[] {
    return this.snapshot;
  }

  /** Subscribe to registry changes. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Currently active bindings for a command (post-platform/runtime filter, after applying
   * any user override). Returns the raw binding strings.
   */
  getKeybindingsFor(id: string): string[] {
    return this.bindingsByCommand.get(id) ?? [];
  }

  /**
   * Dispatch a keybinding already matched by the renderer shortcut host. The hotkey engine
   * owns DOM matching; this method owns command precedence, scopes, guards, and analytics.
   */
  dispatchKeybinding(binding: string, event: KeyboardEvent): void {
    const canonical = canonicalizeBinding(binding);
    if (canonical) this.handleKeyDown(canonical, event);
  }

  /** Refresh persisted overrides after this renderer mounts or another window changes them. */
  reloadUserKeybindings(): void {
    this.userOverrides = loadUserBindings();
    this.userOverridesLoaded = true;
    this.rebuildBindings();
    this.publishSnapshot();
  }

  /**
   * The command's declared defaults — what user overrides REPLACE. Returns the raw binding
   * strings, ignoring overrides while respecting platform/runtime filters for this device.
   */
  getDefaultKeybindingsFor(id: string): string[] {
    const cmd = this.activeCommands.get(id)?.command;
    if (!cmd?.keybindings) return [];
    const runtime = getRuntime();
    const platform = getPlatform();
    return cmd.keybindings
      .map((entry) => (typeof entry === 'string' ? { key: entry } : entry))
      .filter((binding) => keybindingAppliesToEnvironment(binding, platform, runtime))
      .map((binding) => binding.key);
  }

  /** True iff the user has provided an override for this command (including unbind). */
  hasUserOverride(id: string): boolean {
    this.ensureUserOverridesLoaded();
    return Object.prototype.hasOwnProperty.call(this.userOverrides, id);
  }

  /**
   * Set the user's binding(s) for a command, persist, and rebind. Passing `null` removes
   * the override (back to declared defaults). Passing `[]` explicitly unbinds.
   */
  setUserKeybindings(id: string, bindings: string[] | null): void {
    this.ensureUserOverridesLoaded();
    if (bindings === null) {
      if (!(id in this.userOverrides)) return;
      delete this.userOverrides[id];
    } else {
      this.userOverrides[id] = [...bindings];
    }
    saveUserBindings(this.userOverrides);
    this.rebuildBindings();
    this.publishSnapshot();
  }

  /** Remove ALL user overrides. Useful for a "reset all" button. */
  resetAllUserKeybindings(): void {
    this.ensureUserOverridesLoaded();
    if (Object.keys(this.userOverrides).length === 0) return;
    this.userOverrides = {};
    saveUserBindings(this.userOverrides);
    this.rebuildBindings();
    this.publishSnapshot();
  }

  /** Find the command id currently bound to a given binding string, if any. */
  findCommandBoundTo(binding: string, excludeId?: string): string | null {
    const canonical = canonicalizeBinding(binding);
    if (!canonical) return null;
    const hit = this.commandByCanonical.get(canonical);
    if (!hit || hit === excludeId) return null;
    return hit;
  }

  // --- internals ---------------------------------------------------------

  private ensureUserOverridesLoaded(): void {
    if (this.userOverridesLoaded) return;
    this.userOverrides = loadUserBindings();
    this.userOverridesLoaded = true;
  }

  private disposeRegistration(id: string, registration: CommandRegistration): void {
    const stack = this.commandStacks.get(id);
    if (!stack) return;
    const index = stack.indexOf(registration);
    if (index === -1) return;
    stack.splice(index, 1);
    if (stack.length === 0) {
      this.commandStacks.delete(id);
      this.activeCommands.delete(id);
    } else {
      this.activeCommands.set(id, stack[stack.length - 1]!);
    }
    this.rebuildBindings();
    this.publishSnapshot();
  }

  private rebuildBindings(): void {
    this.ensureUserOverridesLoaded();
    const runtime = getRuntime();
    const platform = getPlatform();
    const next: ResolvedBinding[] = [];
    const byCommand = new Map<string, string[]>();
    const byCanonical = new Map<string, string>();
    const activeRegistrations = [...this.activeCommands.values()].sort((a, b) => a.order - b.order);

    for (const { command: cmd } of activeRegistrations) {
      const override = this.userOverrides[cmd.id];
      // User overrides drop the platform/runtime filter — they were chosen on THIS device.
      const entries: (string | KeyBinding)[] =
        override !== undefined ? override : (cmd.keybindings ?? []);
      const isOverride = override !== undefined;

      for (const entry of entries) {
        const binding: KeyBinding = typeof entry === 'string' ? { key: entry } : entry;
        if (!isOverride && !keybindingAppliesToEnvironment(binding, platform, runtime)) continue;

        if (
          import.meta.env?.DEV &&
          runtime === 'web' &&
          UNINTERCEPTABLE_WEB_KEYS.has(binding.key.toLowerCase())
        ) {
          console.warn(
            `[commands] "${cmd.id}" binds "${binding.key}" but the browser claims this combo at OS level — register a web-only alternative via { runtimes: ['electron'] } and a separate web binding.`
          );
        }

        const canonical = canonicalizeBinding(binding.key);
        if (!canonical) {
          console.error(`[commands] invalid binding for "${cmd.id}": "${binding.key}"`);
          continue;
        }
        const prior = byCanonical.get(canonical);
        if (prior && prior !== cmd.id && import.meta.env?.DEV) {
          console.warn(
            `[commands] key "${binding.key}" is bound by both "${prior}" and "${cmd.id}"; later wins.`
          );
        }
        byCanonical.set(canonical, cmd.id);

        next.push({
          raw: binding.key,
          canonical,
          preventDefault: binding.preventDefault ?? true,
          when: binding.when,
          commandId: cmd.id,
        });

        const list = byCommand.get(cmd.id);
        if (list) list.push(binding.key);
        else byCommand.set(cmd.id, [binding.key]);
      }
    }
    this.bindings = next;
    this.bindingsByCommand = byCommand;
    this.commandByCanonical = byCanonical;
  }

  private handleKeyDown(canonical: string, event: KeyboardEvent): void {
    if (this.paused) return;
    if (this.bindings.length === 0) return;
    if (event.defaultPrevented) return;
    // A focused text-editing surface gets the key first. Checked per event
    // rather than per binding, so it holds for user-rebound keys too — the
    // whole reason this is not a `when` on the default binding.
    const scope = this.activeScopeFor(event);

    // Iterate in reverse so most-recently-registered wins on collisions.
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i]!;
      if (b.canonical !== canonical) continue;
      if (b.when && !b.when(event)) continue;
      const cmd = this.activeCommands.get(b.commandId)?.command;
      if (!cmd) continue;
      if (scope && !cmd.allowInTextInput) {
        // Claimed keys (or every key, when the scope claims broadly) belong to
        // the editor. Leave the event alone — no preventDefault — so its own
        // keymap still sees it.
        const claims = scope.canonicalClaims;
        if (!claims || claims.has(canonical)) {
          return;
        }
      }
      if (cmd.when && !cmd.when()) continue;
      if (b.preventDefault) event.preventDefault();
      try {
        this.captureShortcutUsage(b);
        void cmd.run();
      } catch (error) {
        console.error(`[commands] failed to execute "${cmd.id}"`, error);
      }
      return;
    }
  }

  private captureShortcutUsage(binding: ResolvedBinding): void {
    if (!this.shortcutAnalyticsHandler) return;
    try {
      this.shortcutAnalyticsHandler(
        createShortcutUsagePayload({
          commandId: binding.commandId,
          binding: binding.raw,
          source: 'keyboard',
          isUserOverride: this.hasUserOverride(binding.commandId),
        })
      );
    } catch (error) {
      console.error(
        `[commands] failed to capture shortcut usage for "${binding.commandId}"`,
        error
      );
    }
  }

  private publishSnapshot(): void {
    this.snapshot = [...this.activeCommands.values()]
      .sort((a, b) => a.order - b.order)
      .map((registration) => registration.command);
    for (const listener of this.listeners) listener();
  }
}

export const commands = new CommandRegistry();
export type { CommandRegistry };
