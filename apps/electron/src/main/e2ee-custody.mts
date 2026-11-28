import { Effect } from 'effect'
import { makeNodeE2eeCustody, NodeE2eeCustodyError } from '@lody/e2ee-core/adapters/node-custody'
import { classifySafeStorageFailure } from './safe-storage-classification'
export {
  NodeE2eeCustodyError as DesktopE2eeCustodyError,
  nodeE2eePorts as desktopE2eePorts,
  type NodeE2eeCustody as DesktopE2eeCustody,
  type NodeE2eeDevice as DesktopE2eeDevice,
  type PreparedNodeE2eeDevice as PreparedDesktopE2eeDevice
} from '@lody/e2ee-core/adapters/node-custody'

/** Typed subclass for temporarily locked/unavailable OS safeStorage (distinct from missing backend). */
export class DesktopSafeStorageLockedError extends NodeE2eeCustodyError {
  constructor() {
    super({ code: 'unavailable' })
  }
}

/** Electron's native async interface; never the auth cookie plaintext override. */
export interface DesktopSafeStorage {
  isEncryptionAvailable(): boolean
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?: () => string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

function classifySafeStorageError(
  error: unknown,
  storage: DesktopSafeStorage
): NodeE2eeCustodyError {
  if (error instanceof NodeE2eeCustodyError) return error
  const kind = classifySafeStorageFailure({
    error,
    available: () => storage.isEncryptionAvailable()
  })
  if (kind === 'permissions') return new NodeE2eeCustodyError({ code: 'permissions' })
  if (kind === 'locked') return new DesktopSafeStorageLockedError()
  return new NodeE2eeCustodyError({ code: 'storage' })
}

/** Electron backend qualification stays here; the shared algorithm never guesses host backend names. */
export const makeDesktopE2eeCustody = Effect.fnUntraced(function* (input: {
  readonly directory: string
  readonly platform: NodeJS.Platform
  readonly safeStorage: DesktopSafeStorage
}) {
  const storage = input.safeStorage
  function native<A>(work: () => Promise<A>) {
    return Effect.uninterruptible(
      Effect.tryPromise({
        try: work,
        catch: () => new NodeE2eeCustodyError({ code: 'unavailable' })
      })
    )
  }
  const available = yield* Effect.try({
    try: () => storage.isEncryptionAvailable(),
    catch: () => new NodeE2eeCustodyError({ code: 'unavailable' })
  })
  if (!available || !(yield* native(() => storage.isAsyncEncryptionAvailable())))
    return yield* new NodeE2eeCustodyError({ code: 'unavailable' })
  if (input.platform === 'linux') {
    const backend = yield* Effect.try({
      try: () => storage.getSelectedStorageBackend?.(),
      catch: () => new NodeE2eeCustodyError({ code: 'unavailable' })
    })
    if (backend === 'basic_text') return yield* new NodeE2eeCustodyError({ code: 'basic-text' })
    if (!backend || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend))
      return yield* new NodeE2eeCustodyError({ code: 'unavailable' })
  }
  return yield* makeNodeE2eeCustody({
    directory: input.directory,
    wrapper: {
      protection: 'os-keystore',
      wrap: async (value) => {
        try {
          return await storage.encryptStringAsync(value)
        } catch (error) {
          throw classifySafeStorageError(error, storage)
        }
      },
      unwrap: async (value) => {
        try {
          return await storage.decryptStringAsync(Buffer.from(value))
        } catch (error) {
          throw classifySafeStorageError(error, storage)
        }
      }
    }
  })
})
