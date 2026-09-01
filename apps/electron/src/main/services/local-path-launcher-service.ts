import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import type {
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  LocalPathCommandSpec
} from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { launchCommandPathWithFallback, probePathLauncher } from './local-path-launcher-core'
import { getUserShellEnvCached, shouldUseWindowsShell } from './shell-env'

const PROBE_CACHE_MS = 5 * 60 * 1000
const probeCache = new Map<string, { available: boolean; checkedAt: number }>()

// Editors launch via their CLI first. VS Code falls back to its protocol handler
// when no CLI candidate is available; Warp always launches through its protocol.
const ALLOWED_LOCAL_LAUNCH_PROTOCOLS = new Set(['vscode:', 'warp:'])

function normalizeAllowedLocalLaunchUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!ALLOWED_LOCAL_LAUNCH_PROTOCOLS.has(url.protocol)) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

async function hasPath(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    async (info) => {
      if (!info.isFile()) return false
      return access(
        filePath,
        process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK
      ).then(
        () => true,
        () => false
      )
    },
    () => false
  )
}

async function hasMacApp(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('/usr/bin/open', ['-Ra', name], {
      shell: false,
      stdio: 'ignore'
    })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

async function hasCommand(command: string, args?: readonly string[]): Promise<boolean> {
  const applicationName =
    process.platform === 'darwin' && path.basename(command) === 'open' && args && args[0] === '-a'
      ? args[1]
      : undefined
  const cacheKey = `command:${command}:${applicationName ? applicationName : ''}`
  const cached = probeCache.get(cacheKey)
  if (cached && Date.now() - cached.checkedAt < PROBE_CACHE_MS) {
    return cached.available
  }

  let available = false
  // `/usr/bin/open` exists on every Mac, but `open -a Foo` is launchable only
  // when Foo is installed. This also covers custom launchers using that idiom.
  if (applicationName) {
    available = await hasMacApp(applicationName)
  } else if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    available = await hasPath(command)
  } else {
    const shellEnv = await getUserShellEnvCached()
    const env = shellEnv ? { ...process.env, ...shellEnv } : process.env
    const pathValue = env.PATH ? env.PATH : ''
    const pathEntries = pathValue.split(path.delimiter).filter(Boolean)
    const extensions =
      process.platform === 'win32'
        ? (env.PATHEXT ? env.PATHEXT : '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : ['']
    const commandHasExtension = process.platform === 'win32' && path.extname(command) !== ''
    const candidates = pathEntries.flatMap((entry) =>
      commandHasExtension
        ? [path.join(entry, command)]
        : extensions.map((extension) => path.join(entry, `${command}${extension}`))
    )
    available = (await Promise.all(candidates.map(hasPath))).some(Boolean)
  }

  probeCache.set(cacheKey, { available, checkedAt: Date.now() })
  return available
}

async function hasProtocol(urlValue: string): Promise<boolean> {
  if (!URL.canParse(urlValue)) return false
  const protocol = new URL(urlValue).protocol

  const cacheKey = `protocol:${protocol}`
  const cached = probeCache.get(cacheKey)
  if (cached && Date.now() - cached.checkedAt < PROBE_CACHE_MS) {
    return cached.available
  }

  const available = app.getApplicationNameForProtocol(`${protocol}//`).length > 0
  probeCache.set(cacheKey, { available, checkedAt: Date.now() })
  return available
}

export function hasPathLauncher(input: LaunchLocalPathInput): Promise<boolean> {
  return probePathLauncher(
    input,
    (candidate) => hasCommand(candidate.command, candidate.args),
    hasProtocol
  )
}

async function canResolveWindowsShellCommand(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (process.platform !== 'win32' || !shouldUseWindowsShell(command)) {
    return true
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn('where.exe', [command], {
      env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })

    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

async function spawnDetached(
  spec: LocalPathCommandSpec,
  options?: { verifyWindowsShellCommand?: boolean }
): Promise<LaunchLocalPathResult> {
  // GUI-launched apps inherit a minimal PATH, so a bare command name like `code`
  // (the default a user types into a custom launcher) would never resolve. Spawn
  // with the user's login-shell env so commands resolve the same way they do in a
  // terminal; fall back to process.env when the probe is unavailable.
  const shellEnv = await getUserShellEnvCached()
  const env = shellEnv ? { ...process.env, ...shellEnv } : process.env

  if (
    options?.verifyWindowsShellCommand &&
    !(await canResolveWindowsShellCommand(spec.command, env))
  ) {
    return {
      launched: false,
      method: 'command',
      command: spec.command,
      error: `Command not found: ${spec.command}`
    }
  }

  return await new Promise<LaunchLocalPathResult>((resolve) => {
    let settled = false
    const finish = (result: LaunchLocalPathResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const useWindowsShell = shouldUseWindowsShell(spec.command)
      const child = spawn(spec.command, spec.args ?? [], {
        detached: true,
        // Windows `.cmd`/`.bat` shims (e.g. the `code` shim) can't be spawned
        // with shell:false; everywhere else keep the shell out of the loop.
        shell: useWindowsShell,
        env,
        stdio: 'ignore',
        // Only hide the cmd.exe wrapper window. libuv maps windowsHide to
        // SW_HIDE as well, which would start a directly spawned native editor
        // (sublime_text.exe, idea64.exe, ...) with no visible window; and
        // DETACHED_PROCESS already suppresses console allocation here.
        windowsHide: useWindowsShell
      })

      child.once('spawn', () => {
        child.unref()
        finish({
          launched: true,
          method: 'command',
          command: spec.command
        })
      })

      child.once('error', (error) => {
        finish({
          launched: false,
          method: 'command',
          command: spec.command,
          error: formatUnknownError(error)
        })
      })
    } catch (error) {
      finish({
        launched: false,
        method: 'command',
        command: spec.command,
        error: formatUnknownError(error)
      })
    }
  })
}

async function launchLocalUrl(urlValue: string): Promise<LaunchLocalPathResult> {
  const url = normalizeAllowedLocalLaunchUrl(urlValue)
  if (!url) {
    return {
      launched: false,
      method: 'url',
      url: urlValue,
      error: 'invalid_url'
    }
  }

  try {
    await shell.openExternal(url)
    return {
      launched: true,
      method: 'url',
      url
    }
  } catch (error) {
    return {
      launched: false,
      method: 'url',
      url,
      error: formatUnknownError(error)
    }
  }
}

export async function launchLocalPath(input: LaunchLocalPathInput): Promise<LaunchLocalPathResult> {
  if (input.kind === 'url') {
    return await launchLocalUrl(input.url)
  }

  return await launchCommandPathWithFallback(
    input,
    async (command) =>
      await spawnDetached(command, {
        verifyWindowsShellCommand: Boolean(input.fallbackUrl)
      }),
    launchLocalUrl
  )
}
