import Conf from 'conf'
import type { AppIconName } from './app-icon-core'

/** Cosmetic preferences must never perform IO during application construction. */
export function createAppIconPreferences(directory: string) {
  let store: Conf<{ name: AppIconName }> | undefined
  function getStore() {
    if (store) return store
    const normalized = Conf as typeof Conf | { default?: typeof Conf }
    const Constructor = typeof normalized === 'function' ? normalized : normalized.default
    if (!Constructor) throw new Error('Unable to initialize app icon settings')
    store = new Constructor<{ name: AppIconName }>({
      cwd: directory,
      configName: 'app-icon',
      clearInvalidConfig: true,
      defaults: { name: 'default' },
      schema: { name: { type: 'string', enum: ['default', 'aqua'] } }
    })
    return store
  }
  return {
    read: () => getStore().get('name'),
    write: (name: AppIconName) => getStore().set('name', name)
  }
}
