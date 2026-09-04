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
 * `conf` reads and validates inside its CONSTRUCTOR and, with
 * `clearInvalidConfig` at its default `false` (checked on conf 15.1.0),
 * rethrows — `SyntaxError` for a truncated file, `Config schema violation:` for
 * a value outside the enum, plus whatever the filesystem raises. Every store
 * here is built at module scope, so an unguarded throw lands during import and
 * the app stops launching because a preference file is malformed.
 *
 * In-memory rather than `clearInvalidConfig: true`, so the launch proceeds as
 * though nothing had been persisted and the unreadable file stays on disk to be
 * recovered instead of being silently emptied.
 *
 * `get`/`set` are NOT wrapped: `conf` re-reads on every `get`, so a file damaged
 * later still throws, and whether that is worth surviving is per-store.
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
