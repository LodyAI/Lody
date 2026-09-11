import { globalShortcut } from 'electron'
import Conf from 'conf'
import {
  GLOBAL_SHORTCUT_DEFAULTS,
  bindingToElectronAccelerator,
  migrateLegacyShortcutBinding,
  type GlobalShortcutBinding,
  type GlobalShortcutId,
  type GlobalShortcutTriggeredPayload,
  type SetGlobalShortcutInput,
  type SetGlobalShortcutResult
} from '@lody/shared/electron-ipc'

/**
 * One global shortcut the app owns. The handler is injected by `index.ts` (it needs
 * window-toggle access), while the id + default binding live in the shared
 * `GLOBAL_SHORTCUT_DEFAULTS` so the renderer settings UI and this service agree.
 */
export type GlobalShortcutDefinition = {
  id: GlobalShortcutId
  handler: () => void
}

type GlobalShortcutsServiceOptions = {
  onTriggered?: (payload: GlobalShortcutTriggeredPayload) => void
}

type GlobalShortcutsSchema = {
  /** id -> user binding (binding-string syntax), or null to explicitly unbind. */
  overrides: Record<string, string | null>
}

// Conf ships as both a CJS default-export and an ESM named export depending on the
// bundler; normalize like window-persistence.ts does.
const normalizedConfModule = Conf as
  | typeof Conf
  | {
      default?: typeof Conf
    }
const resolvedConf =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default
if (typeof resolvedConf !== 'function') {
  throw new TypeError('Unable to initialize config store: invalid Conf module export shape.')
}
// Capture the narrowed constructor so the class field initializer below (a nested scope
// that the module-level narrowing doesn't reach) sees a non-optional type.
const ConfConstructor: typeof Conf = resolvedConf

/**
 * Owns OS-level global shortcuts (`globalShortcut.register`): registers them at boot,
 * persists per-user overrides, and serves the settings UI over IPC. Built to scale to
 * more shortcuts — add a `GlobalShortcutDefinition` and a shared default; everything
 * else (persistence, listing, rebinding, conflict handling) is generic here.
 */
export class GlobalShortcutsService {
  private readonly store = new ConfConstructor<GlobalShortcutsSchema>({
    projectName: 'lody-desktop',
    configName: 'global-shortcuts',
    defaults: { overrides: {} },
    schema: {
      overrides: {
        type: 'object',
        additionalProperties: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }
    }
  })

  private readonly handlers = new Map<GlobalShortcutId, () => void>()
  /** id -> the Electron accelerator currently registered for it. */
  private readonly registered = new Map<GlobalShortcutId, string>()
  /** While true the OS accelerators are unregistered (used during shortcut recording). */
  private suspended = false

  constructor(
    private readonly definitions: GlobalShortcutDefinition[],
    private readonly options: GlobalShortcutsServiceOptions = {}
  ) {
    for (const def of definitions) {
      this.handlers.set(def.id, def.handler)
    }
  }

  /** Register every shortcut at its effective binding. Call once after `app.whenReady`. */
  registerAll(): void {
    for (const def of this.definitions) {
      const binding = this.effectiveBinding(def.id)
      if (binding === null) continue
      const accelerator = bindingToElectronAccelerator(binding)
      if (!accelerator) {
        console.warn('[Electron] Skipping invalid global shortcut binding for', def.id)
        continue
      }
      this.safeRegister(def.id, accelerator)
    }
  }

  /** Current + default binding for each shortcut (for the settings UI). */
  list(): GlobalShortcutBinding[] {
    return this.definitions.map((def) => ({
      id: def.id,
      binding: this.effectiveBinding(def.id),
      defaultBinding: GLOBAL_SHORTCUT_DEFAULTS[def.id]
    }))
  }

  /**
   * Rebind a shortcut (or unset it with `binding: null`). Re-registers
   * atomically: on failure the previous binding is restored and an error returned so
   * the renderer can surface it without leaving the shortcut unregistered.
   */
  setBinding(input: SetGlobalShortcutInput): SetGlobalShortcutResult {
    if (!this.handlers.has(input.id)) return { ok: false, error: 'invalid' }

    const nextBinding = input.binding
    const previousAccelerator = this.registered.get(input.id)

    if (nextBinding === null) {
      if (previousAccelerator) {
        globalShortcut.unregister(previousAccelerator)
        this.registered.delete(input.id)
      }
      this.persistOverride(input.id, input.binding)
      return { ok: true, binding: null }
    }

    const accelerator = bindingToElectronAccelerator(nextBinding)
    if (!accelerator) return { ok: false, error: 'invalid' }

    if (previousAccelerator) {
      globalShortcut.unregister(previousAccelerator)
      this.registered.delete(input.id)
    }

    if (!this.safeRegister(input.id, accelerator)) {
      // Restore the prior binding so the shortcut keeps working.
      if (previousAccelerator) this.safeRegister(input.id, previousAccelerator)
      return { ok: false, error: 'conflict' }
    }

    this.persistOverride(input.id, input.binding)
    return { ok: true, binding: nextBinding }
  }

  /**
   * Temporarily unregister all OS accelerators so they neither fire nor swallow the
   * keypress while the renderer is recording a shortcut — the combo then reaches the
   * renderer, which can flag it as occupied. Idempotent; pair with `setSuspended(false)`.
   * The `registered` map is kept so resuming can restore exactly what was active.
   */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return
    this.suspended = suspended
    if (suspended) {
      for (const accelerator of this.registered.values()) {
        globalShortcut.unregister(accelerator)
      }
      return
    }
    for (const [id, accelerator] of this.registered) {
      // A rebind during suspension may already have re-registered one of these.
      if (globalShortcut.isRegistered(accelerator)) continue
      if (!this.safeRegister(id, accelerator)) {
        console.warn('[Electron] Error resuming global shortcut', id, accelerator)
      }
    }
  }

  /** Unregister everything. Call on `will-quit`. */
  dispose(): void {
    for (const accelerator of this.registered.values()) {
      globalShortcut.unregister(accelerator)
    }
    this.registered.clear()
  }

  private effectiveBinding(id: GlobalShortcutId): string | null {
    const overrides = this.store.get('overrides')
    const binding = Object.prototype.hasOwnProperty.call(overrides, id)
      ? (overrides[id] ?? null)
      : GLOBAL_SHORTCUT_DEFAULTS[id]
    return binding === null ? null : migrateLegacyShortcutBinding(binding)
  }

  private persistOverride(id: GlobalShortcutId, binding: string | null): void {
    const overrides = { ...this.store.get('overrides') }
    // A value equal to the default clears the override; null is an explicit unbind.
    if (binding === GLOBAL_SHORTCUT_DEFAULTS[id]) {
      delete overrides[id]
    } else {
      overrides[id] = binding
    }
    this.store.set('overrides', overrides)
  }

  private safeRegister(id: GlobalShortcutId, accelerator: string): boolean {
    const handler = this.handlers.get(id)
    if (!handler) return false
    try {
      const ok = globalShortcut.register(accelerator, () => {
        this.notifyTriggered(id)
        handler()
      })
      if (ok) {
        this.registered.set(id, accelerator)
        return true
      }
      console.warn('[Electron] Failed to register global shortcut', id, accelerator)
      return false
    } catch (error) {
      console.warn('[Electron] Error registering global shortcut', id, accelerator, error)
      return false
    }
  }

  private notifyTriggered(id: GlobalShortcutId): void {
    this.options.onTriggered?.({
      id,
      binding: this.effectiveBinding(id),
      defaultBinding: GLOBAL_SHORTCUT_DEFAULTS[id]
    })
  }
}
