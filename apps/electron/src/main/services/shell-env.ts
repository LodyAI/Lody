import { probeLoginShellEnv } from '@lody/shared/node/login-shell-env'

// GUI-launched apps (macOS launchd, Linux .desktop) inherit a minimal PATH that
// usually omits /usr/local/bin, Homebrew, and editor CLIs (`code`, `cursor`,
// ...). We probe the user's login shell once to recover their real environment
// (most importantly PATH) and reuse it whenever we spawn user-facing commands —
// the embedded CLI as well as "Open in" path launchers — so bare command names
// resolve the same way they do in a terminal.

// Interactive rc files (nvm, conda, oh-my-zsh) can take several seconds on a
// cold login. The bound only stops a shell that never returns: the timeout
// ends the shell's whole process tree.
const SHELL_ENV_TIMEOUT_MS = 15_000

let cachedShellEnvPromise: Promise<NodeJS.ProcessEnv | null> | null = null

async function loadUserShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return null
  if (process.env.LODY_ELECTRON_DISABLE_SHELL_ENV === '1') return null
  const env = await probeLoginShellEnv({ env: process.env, timeout: SHELL_ENV_TIMEOUT_MS })
  if (!env) console.warn('Login shell environment unavailable; using the inherited environment')
  return env
}

/**
 * Resolve (and cache for the process lifetime) the user's login-shell
 * environment. Returns null on Windows, when disabled, or when the probe fails;
 * callers should fall back to `process.env` in that case. A failure is cached
 * too: the 15 s bound already covers a slow cold login, and a shell that
 * outlives it would otherwise stall every CLI launch and launcher probe again.
 */
export async function getUserShellEnvCached(): Promise<NodeJS.ProcessEnv | null> {
  if (!cachedShellEnvPromise) {
    cachedShellEnvPromise = loadUserShellEnv()
  }
  return await cachedShellEnvPromise
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
