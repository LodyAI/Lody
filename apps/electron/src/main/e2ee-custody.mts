import { Effect } from 'effect'
import { makeNodeE2eeCustody, NodeE2eeCustodyError } from '@lody/e2ee-core/adapters/node-custody'
export {
  NodeE2eeCustodyError as DesktopE2eeCustodyError,
  nodeE2eePorts as desktopE2eePorts,
  type NodeE2eeCustody as DesktopE2eeCustody,
  type NodeE2eeDevice as DesktopE2eeDevice,
  type PreparedNodeE2eeDevice as PreparedDesktopE2eeDevice
} from '@lody/e2ee-core/adapters/node-custody'

/** Electron's native async interface; never the auth cookie plaintext override. */
export interface DesktopSafeStorage {
  isEncryptionAvailable(): boolean
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?: () => string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

const SAFE_STORAGE_UNAVAILABLE =
  /keychain|lock|unlock|cancel|denied|deny|permission|interaction not allowed|auth(?:entication)? failed|errsec|secret service|kwallet|safe storage|not available|unavailable/i

const custodyLockedErrors = new WeakSet<object>()

export function isDesktopE2eeCustodyLocked(error: unknown): boolean {
  return typeof error === 'object' && error !== null && custodyLockedErrors.has(error)
}

function custodyLockedError(): NodeE2eeCustodyError {
  const error = new NodeE2eeCustodyError({ code: 'unavailable' })
  custodyLockedErrors.add(error)
  return error
}

function classifySafeStorageError(
  error: unknown,
  storage: DesktopSafeStorage
): NodeE2eeCustodyError {
  if (error instanceof NodeE2eeCustodyError) return error
  try {
    if (!storage.isEncryptionAvailable()) return custodyLockedError()
  } catch {
    return custodyLockedError()
  }
  const errCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  if (errCode === 'EACCES' || errCode === 'EPERM') return custodyLockedError()
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (SAFE_STORAGE_UNAVAILABLE.test(message)) return custodyLockedError()
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
