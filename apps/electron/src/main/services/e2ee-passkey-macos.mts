import { createRequire } from 'node:module'
import { join } from 'node:path'
import { E2eePasskeyCancelled, type E2eePasskeyPort } from '@lody/platform/e2ee-passkey'

/** The native AuthenticationServices bridge in `apps/electron/native/passkey`. */
export interface MacosPasskeyBinding {
  available(): boolean
  register?(input: {
    window: Buffer
    rpId: string
    userHandle: Uint8Array
    userName: string
    prfInput: Uint8Array
    excludeCredentialIds: readonly Uint8Array[]
  }): Promise<{ credentialId: Uint8Array; prfSupported: boolean }>
  authenticate?(input: {
    window: Buffer
    rpId: string
    prfInput: Uint8Array
    allowCredentialIds: readonly Uint8Array[]
  }): Promise<{
    credentialId: Uint8Array
    userHandle: Uint8Array | null
    userVerified: boolean
    prfFirst: Uint8Array | null
  }>
}

/** Canonical unpadded base64url, the one spelling every platform shares. */
export const base64url = {
  encode: (value: Uint8Array) => Buffer.from(value).toString('base64url'),
  decode: (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
}

const dismissed = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled'

/** The native addon is optional: without it, or below macOS 15, passkeys are unavailable. */
export function makeMacosPasskeyPort(input: {
  readonly load: () => MacosPasskeyBinding
  readonly window: () => Buffer
}): E2eePasskeyPort {
  let loaded: MacosPasskeyBinding | null | undefined
  const binding = () => {
    if (loaded === undefined) {
      try {
        loaded = input.load()
        if (!loaded.available()) loaded = null
      } catch {
        loaded = null
      }
    }
    if (!loaded) throw new Error('e2ee_passkey_unavailable')
    return loaded
  }
  const ceremony = async <A>(work: () => Promise<A>) => {
    try {
      return await work()
    } catch (error) {
      throw dismissed(error) ? new E2eePasskeyCancelled('e2ee_passkey_cancelled') : error
    }
  }
  return {
    available: async () => {
      try {
        binding()
        return true
      } catch {
        return false
      }
    },
    register: async (request) => {
      const native = binding()
      const created = await ceremony(() =>
        native.register!({
          window: input.window(),
          rpId: request.rpId,
          userHandle: request.userHandle,
          userName: request.userName,
          prfInput: request.prfInput,
          excludeCredentialIds: request.excludeCredentialIds.map(base64url.decode)
        })
      )
      return {
        credentialId: base64url.encode(created.credentialId),
        prfEnabled: created.prfSupported
      }
    },
    authenticate: async (request) => {
      const native = binding()
      const assertion = await ceremony(() =>
        native.authenticate!({
          window: input.window(),
          rpId: request.rpId,
          prfInput: request.prfInput,
          allowCredentialIds: request.allowCredentialIds.map(base64url.decode)
        })
      )
      return { ...assertion, credentialId: base64url.encode(assertion.credentialId) }
    }
  }
}

/** The desktop port. The packaged addon sits in Resources; see the native README. */
export const desktopPasskeyPort = (input: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly window: () => Buffer
}) =>
  makeMacosPasskeyPort({
    load: () => {
      if (process.platform !== 'darwin') throw new Error('e2ee_passkey_unavailable')
      const path = input.packaged
        ? join(input.resourcesPath, 'passkey_bridge.node')
        : join(input.appPath, 'native/passkey/build/Release/passkey_bridge.node')
      return createRequire(import.meta.url)(path) as MacosPasskeyBinding
    },
    window: input.window
  })
