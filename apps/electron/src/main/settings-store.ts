import { app } from 'electron'
import Conf from 'conf'

// `conf` is published as ESM but reaches this CommonJS-shaped main bundle
// either as the constructor itself or wrapped in an interop `default`.
// Resolving it once here keeps every main-process settings store on one
// import shape instead of repeating the interop dance per store.
const normalizedConfModule = Conf as typeof Conf | { default?: typeof Conf }
const resolvedConf =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default

if (typeof resolvedConf !== 'function') {
  throw new TypeError('Unable to initialize settings store: invalid Conf module export shape.')
}

const ConfConstructor: typeof Conf = resolvedConf

export function createMainSettingsStore<Schema extends Record<string, unknown>>(options: {
  configName: string
  defaults: Schema
  schema: NonNullable<ConstructorParameters<typeof Conf<Schema>>[0]>['schema']
}): Conf<Schema> {
  return new ConfConstructor<Schema>({
    cwd: app.getPath('userData'),
    configName: options.configName,
    defaults: options.defaults,
    schema: options.schema
  })
}
