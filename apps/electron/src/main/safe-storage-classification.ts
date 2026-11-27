/**
 * Pure, zero-Electron classification for OS `safeStorage` failures shared by
 * auth credential recovery (`auth-storage.ts`) and E2EE key custody (`e2ee-custody.mts`).
 */
export type SafeStorageFailureKind =
  | 'locked'
  | 'permissions'
  | 'permission-text'
  | 'busy'
  | 'corrupt'
  | 'storage'

const SAFE_STORAGE_LOCKED =
  /keychain.{0,32}lock|lock.{0,32}keychain|\block(?:ed)?\b|unlock|cancel|interaction not allowed|auth(?:entication)? failed|errsec|secret service|kwallet|temporarily unavailable|not available|unavailable/i

const DEFINITE_CIPHERTEXT_CORRUPTION =
  /error while decrypting the ciphertext|decryption failed|invalid ciphertext|corrupt|bad decrypt|unsupported state or unable to authenticate data/i

export function classifySafeStorageFailure(input: {
  readonly error: unknown
  readonly available?: () => boolean
  readonly value?: string
}): SafeStorageFailureKind {
  const errCode =
    input.error &&
    typeof input.error === 'object' &&
    'code' in input.error &&
    typeof input.error.code === 'string'
      ? input.error.code
      : ''
  if (errCode === 'EACCES' || errCode === 'EPERM') return 'permissions'
  if (errCode === 'EBUSY') return 'busy'

  const message = input.error instanceof Error ? input.error.message : String(input.error ?? '')
  if (/permission denied/i.test(message)) return 'permission-text'

  if (input.available) {
    try {
      if (!input.available()) return 'locked'
    } catch {
      return 'locked'
    }
  }

  if (SAFE_STORAGE_LOCKED.test(message)) return 'locked'

  if (input.value !== undefined) {
    const trimmed = input.value.trim()
    if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed))
      return 'corrupt'
  }

  if (DEFINITE_CIPHERTEXT_CORRUPTION.test(message)) return 'corrupt'
  return 'storage'
}
