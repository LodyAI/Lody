/**
 * The `electron`-free half of the main-process settings stores, so the launch
 * behavior below runs under `node --test` without the Electron runtime.
 */

/**
 * The slice of `Conf` a main-process settings store is allowed to use.
 *
 * Narrow on purpose: it is the whole surface both stores need, and it is what
 * lets a fallback stand in for a real `Conf` without faking the rest of it.
 */
export type MainSettingsStore<Schema extends Record<string, unknown>> = {
  get<Key extends keyof Schema>(key: Key): Schema[Key]
  set<Key extends keyof Schema>(key: Key, value: Schema[Key]): void
}

function createInMemorySettingsStore<Schema extends Record<string, unknown>>(
  defaults: Schema
): MainSettingsStore<Schema> {
  const values: Schema = { ...defaults }
  return {
    get: (key) => values[key],
    set: (key, value) => {
      values[key] = value
    }
  }
}

/**
 * Builds a store, or a defaults-only stand-in when the file cannot be opened.
 *
 * `conf` reads and validates the config file inside its CONSTRUCTOR, and with
 * `clearInvalidConfig` left at its default `false` (verified on conf 15.1.0) it
 * rethrows what it finds: `SyntaxError` for a truncated file, `Config schema
 * violation:` for a value outside the schema's enum, plus whatever the
 * filesystem raises for an unreadable path. Every main-process store is
 * constructed at module scope, so an unguarded throw happens during import and
 * takes down the whole main process — the app stops launching because a
 * preference file is malformed.
 *
 * The fallback is deliberately in-memory rather than `clearInvalidConfig: true`:
 * this launch simply proceeds as though nothing had been persisted, and the
 * unreadable file is left on disk to be inspected or recovered instead of being
 * silently emptied. Callers get the schema defaults, which is exactly the
 * behavior they had before they persisted anything.
 *
 * Reads and writes on a healthy store are NOT wrapped here. `conf` re-reads the
 * file on every `get`, so a file that is damaged later still throws; whether
 * that is worth surviving is per-store, and each store decides for itself.
 */
export function createSettingsStoreWithFallback<Schema extends Record<string, unknown>>(
  construct: () => MainSettingsStore<Schema>,
  { configName, defaults }: { configName: string; defaults: Schema }
): MainSettingsStore<Schema> {
  try {
    return construct()
  } catch (error) {
    console.warn(
      `[Electron] Could not open the ${configName} settings file; continuing with defaults for this launch`,
      error
    )
    return createInMemorySettingsStore(defaults)
  }
}
