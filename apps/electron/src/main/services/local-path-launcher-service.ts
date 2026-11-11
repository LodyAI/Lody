import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, shell, dialog, type BrowserWindow } from 'electron'
import { createMainSettingsStore } from '../settings-store'
import { translateMenu } from '../menu'
import {
  buildPathLauncherLaunchInput,
  validateCustomPathLauncherCommandTemplate,
  type BuiltinPathLauncherId
} from '@lody/shared/path-launchers'
import {
  CustomPathLauncherApprovalSchema,
  type CustomPathLauncherApproval,
  type PathLauncherRequest
} from '@lody/shared/electron-ipc'
import { runCommandTextLegacy, startProcessLegacy } from '@lody/shared/node/process'
import type {
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  LocalPathCommandSpec
} from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { launchCommandPathWithFallback, probePathLauncher } from './local-path-launcher-core'
import { getUserShellEnvCachedLegacy, shouldUseWindowsShell } from './shell-env'

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

/** Whether a probe command exits 0; a command that cannot start counts as no. */
async function commandSucceeds(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  return await runCommandTextLegacy({ command, args, env, check: 'none' }).then(
    ({ code }) => code === 0,
    () => false
  )
}

async function hasMacApp(name: string): Promise<boolean> {
  return await commandSucceeds('/usr/bin/open', ['-Ra', name])
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
    const shellEnv = await getUserShellEnvCachedLegacy()
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

  return await commandSucceeds('where.exe', [command], env)
}

async function spawnDetached(
  spec: LocalPathCommandSpec,
  options?: { verifyWindowsShellCommand?: boolean }
): Promise<LaunchLocalPathResult> {
  // GUI-launched apps inherit a minimal PATH, so a bare command name like `code`
  // (the default a user types into a custom launcher) would never resolve. Spawn
  // with the user's login-shell env so commands resolve the same way they do in a
  // terminal; fall back to process.env when the probe is unavailable.
  const shellEnv = await getUserShellEnvCachedLegacy()
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
      // The launched editor outlives this app: nothing here ever terminates it.
      const { child } = startProcessLegacy({
        command: spec.command,
        args: spec.args ?? [],
        options: {
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
        },
        // `detached: true` on every platform: its own session on POSIX, its
        // own console-less process on Windows.
        processGroup: true,
        windowsDetached: true
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

const launcherStore = createMainSettingsStore<{ launchers: CustomPathLauncherApproval[] }>({
  configName: 'path-launchers',
  defaults: { launchers: [] },
  schema: {
    launchers: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['id', 'label', 'commandTemplate'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 80 },
          label: { type: 'string', maxLength: 48 },
          commandTemplate: { type: 'string', maxLength: 1000 }
        }
      }
    }
  }
})
const builtinIds = new Set([
  'vscode',
  'cursor',
  'antigravity',
  'windsurf',
  'zed',
  'sublime',
  'warp',
  'delta',
  'xcode'
])

export function resolvePathLauncher(request: PathLauncherRequest): LaunchLocalPathInput | null {
  if (!path.isAbsolute(request.targetPath)) return null
  const targetPath = path.normalize(request.targetPath)
  // cmd.exe interprets metacharacters even in argv when launching .cmd shims.
  if (process.platform === 'win32' && /[&|<>^%!"\r\n]/u.test(targetPath)) return null
  if (builtinIds.has(request.launcherId)) {
    if (request.launcherId === 'xcode' && process.platform !== 'darwin') return null
    return buildPathLauncherLaunchInput(
      {
        kind: 'builtin',
        id: request.launcherId as BuiltinPathLauncherId,
        label: request.launcherId
      },
      targetPath,
      process.platform,
      request.targetKind
    )
  }
  const id = request.launcherId.startsWith('custom:') ? request.launcherId.slice(7) : null
  const stored = launcherStore.get('launchers').find((item) => item.id === id)
  const parsed = CustomPathLauncherApprovalSchema.safeParse(stored)
  if (!parsed.success || !validateCustomPathLauncherCommandTemplate(parsed.data.commandTemplate).ok)
    return null
  return buildPathLauncherLaunchInput(
    { ...parsed.data, kind: 'custom', launcherId: request.launcherId },
    targetPath,
    process.platform,
    request.targetKind
  )
}

export async function approvePathLauncher(
  raw: unknown,
  owner: BrowserWindow
): Promise<{ approved: boolean }> {
  const parsed = CustomPathLauncherApprovalSchema.safeParse(raw)
  if (!parsed.success || !validateCustomPathLauncherCommandTemplate(parsed.data.commandTemplate).ok)
    return { approved: false }
  const candidate = parsed.data
  if (
    launcherStore
      .get('launchers')
      .some(
        (item) => item.id === candidate.id && item.commandTemplate === candidate.commandTemplate
      )
  )
    return { approved: true }
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    message: translateMenu(
      'desktop.pathLauncher.approve',
      'Allow this custom launcher to run commands?'
    ),
    detail: `${candidate.label}\n\n${candidate.commandTemplate}`,
    buttons: [
      translateMenu('common.cancel', 'Cancel'),
      translateMenu('desktop.pathLauncher.allow', 'Allow launcher')
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (result.response !== 1 || owner.isDestroyed()) return { approved: false }
  const launchers = launcherStore.get('launchers').filter((item) => item.id !== candidate.id)
  if (launchers.length >= 20) return { approved: false }
  launcherStore.set('launchers', [...launchers, candidate])
  return { approved: true }
}
