import { Effect, Exit } from 'effect'
import { LoginShellCache, LoginShellCacheClosed } from '@lody/shared/node/login-shell-env'
import type { ApplicationRuntime } from '@lody/shared/node/application-runtime'
import { squashProcessFailure } from '@lody/shared/node/process'

let application: ApplicationRuntime<LoginShellCache, never> | undefined

/** @deprecated Application-entry binding for remaining Promise launchers. */
export function bindUserShellEnvCacheLegacy(
  owner: ApplicationRuntime<LoginShellCache, never>
): void {
  if (application && !application.isReleased())
    throw new Error('Login-shell application owner already bound')
  application = owner
}

/** @deprecated Promise boundary over the application-owned native cache. */
export async function getUserShellEnvCachedLegacy(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32' || process.env.LODY_ELECTRON_DISABLE_SHELL_ENV === '1')
    return null
  if (!application || application.isClosing()) throw new LoginShellCacheClosed()
  const exit = await application.runtime.runPromiseExit(
    Effect.flatMap(LoginShellCache, (cache) => cache.get())
  )
  if (Exit.isFailure(exit)) throw squashProcessFailure(exit.cause)
  return exit.value
}

/**
 * Windows `.cmd`/`.bat` shims (and bare command names that resolve to them)
 * cannot be spawned with `shell:false`. Returns true when the spawn must go
 * through the shell so the shim is found and executed.
 */
export function shouldUseWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  const normalized = command.trim().toLowerCase()
  if (normalized.endsWith('.cmd') || normalized.endsWith('.bat')) {
    return true
  }
  return (
    !normalized.includes('\\') &&
    !normalized.includes('/') &&
    !normalized.endsWith('.exe') &&
    !normalized.endsWith('.com')
  )
}
