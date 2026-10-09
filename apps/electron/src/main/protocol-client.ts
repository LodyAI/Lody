import { app } from 'electron'
import { runCommandTextLegacy } from '@lody/shared/node/process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LODY_PROTOCOLS } from '@lody/shared/session-link'

type ProtocolRegistrationLogger = (message: string, meta?: Record<string, unknown>) => void

interface RegisterProtocolClientOptions {
  protocol: string
  productName: string
  desktopFileName: string
  iconPath: string
  log: ProtocolRegistrationLogger
  /** Only an explicit user action may change the common resource handler. */
  makeDefault?: boolean
}

interface DesktopIntegrationCommandResult {
  ok: boolean
  status: number | null
  signal?: NodeJS.Signals | null
  error?: string
  stderr?: string
}

const LINUX_PROTOCOL_LAUNCH_SWITCHES = new Set(['--no-sandbox'])
const LINUX_PROTOCOL_LAUNCH_SWITCH_PREFIXES = ['--password-store=']
const MAX_DESKTOP_COMMAND_STDERR_LENGTH = 4096

function resolveDefaultAppEntryPath(): string | null {
  const appPath = app.getAppPath()
  if (appPath) {
    return path.resolve(appPath)
  }

  const argvEntry = process.argv[1]
  if (argvEntry && !argvEntry.includes('://')) {
    return path.resolve(argvEntry)
  }

  return null
}

function quoteDesktopExecArg(arg: string): string {
  return `"${arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/%/g, '%%')}"`
}

function sanitizeDesktopEntryValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim()
}

function resolveXdgDataHome(): string | null {
  const configuredDataHome = process.env.XDG_DATA_HOME
  if (configuredDataHome) {
    return path.resolve(configuredDataHome)
  }

  const home = os.homedir()
  if (!home) {
    return null
  }

  return path.join(home, '.local', 'share')
}

function resolveAppImagePath(): string | null {
  const appImagePath = process.env.APPIMAGE
  if (!appImagePath || !path.isAbsolute(appImagePath)) {
    return null
  }

  return appImagePath
}

function collectLinuxProtocolLaunchArgs(argv: readonly string[]): string[] {
  return argv.filter(
    (arg) =>
      LINUX_PROTOCOL_LAUNCH_SWITCHES.has(arg) ||
      LINUX_PROTOCOL_LAUNCH_SWITCH_PREFIXES.some((prefix) => arg.startsWith(prefix))
  )
}

function writeFileIfChanged(filePath: string, content: string): boolean {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
      return false
    }
  } catch {
    // If the existing file cannot be read, overwrite it below.
  }

  fs.writeFileSync(filePath, content, { mode: 0o644 })
  return true
}

function copyFileIfChanged(sourcePath: string, destinationPath: string): boolean {
  try {
    if (
      fs.existsSync(destinationPath) &&
      fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath))
    ) {
      return false
    }
  } catch {
    // If either file cannot be read, let copyFileSync report the useful error below.
  }

  fs.copyFileSync(sourcePath, destinationPath)
  return true
}

function runDesktopIntegrationCommand(
  command: string,
  args: string[],
  onComplete: (result: DesktopIntegrationCommandResult) => void
): void {
  void runCommandTextLegacy({ command, args, check: 'none' }).then(
    ({ code, signal, stderr }) => {
      onComplete({
        ok: code === 0,
        status: code,
        signal,
        stderr: stderr.slice(-MAX_DESKTOP_COMMAND_STDERR_LENGTH).trim() || undefined
      })
    },
    (error: unknown) => {
      onComplete({
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  )
}

function registerLinuxAppImageProtocolHandler({
  protocol,
  productName,
  desktopFileName,
  iconPath,
  log,
  makeDefault = false
}: RegisterProtocolClientOptions): void {
  if (process.platform !== 'linux' || !app.isPackaged) {
    return
  }

  const appImagePath = resolveAppImagePath()
  if (!appImagePath) {
    log('linux AppImage protocol registration skipped because APPIMAGE is unavailable', {
      protocol
    })
    return
  }

  const dataHome = resolveXdgDataHome()
  if (!dataHome) {
    log('linux AppImage protocol registration skipped because XDG data home is unavailable', {
      protocol
    })
    return
  }

  const desktopFileId = desktopFileName
  const desktopAppId = desktopFileName.replace(/\.desktop$/, '')
  const applicationsDir = path.join(dataHome, 'applications')
  const desktopFilePath = path.join(applicationsDir, desktopFileId)
  const iconsDir = path.join(dataHome, 'icons')
  const installedIconPath = path.join(iconsDir, `${desktopAppId}.png`)
  const launchArgs = collectLinuxProtocolLaunchArgs(process.argv)
  let didWriteDesktopFile = false
  let didWriteIcon = false
  const desktopFileContent = [
    '[Desktop Entry]',
    `Name=${sanitizeDesktopEntryValue(productName)}`,
    `Exec=${[appImagePath, ...launchArgs].map(quoteDesktopExecArg).join(' ')} %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${sanitizeDesktopEntryValue(installedIconPath)}`,
    `StartupWMClass=${sanitizeDesktopEntryValue(desktopAppId)}`,
    `MimeType=${[...new Set([protocol, 'lody'])].map((scheme) => `x-scheme-handler/${scheme};`).join('')}`,
    'Categories=Utility;',
    ''
  ].join('\n')

  try {
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })
    didWriteIcon = copyFileIfChanged(iconPath, installedIconPath)
    didWriteDesktopFile = writeFileIfChanged(desktopFilePath, desktopFileContent)
    log('linux AppImage protocol desktop entry ensured', {
      protocol,
      desktopFileId,
      desktopFilePath,
      didWriteDesktopFile,
      installedIconPath,
      didWriteIcon,
      preservedLaunchArgs: launchArgs
    })
  } catch (error) {
    log('linux AppImage protocol desktop entry failed', {
      protocol,
      desktopFilePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  for (const scheme of [...new Set(makeDefault ? [protocol, 'lody'] : [protocol])]) {
    if (scheme === 'lody' && !makeDefault) continue
    runDesktopIntegrationCommand(
      'xdg-mime',
      ['default', desktopFileId, `x-scheme-handler/${scheme}`],
      (mimeResult) => {
        log('linux AppImage xdg-mime protocol registration finished', {
          protocol,
          desktopFileId,
          ...mimeResult
        })
      }
    )
  }

  if (!didWriteDesktopFile && !didWriteIcon) {
    return
  }

  runDesktopIntegrationCommand('update-desktop-database', [applicationsDir], (databaseResult) => {
    if (databaseResult.ok) {
      return
    }
    log('linux AppImage desktop database update skipped or failed', {
      protocol,
      applicationsDir,
      ...databaseResult
    })
  })
}

let installationOptions: RegisterProtocolClientOptions | null = null

export function setDefaultLodyProtocolClient(): boolean {
  const appEntry = resolveDefaultAppEntryPath()
  const result =
    !app.isPackaged && appEntry
      ? app.setAsDefaultProtocolClient('lody', process.execPath, [appEntry])
      : app.setAsDefaultProtocolClient('lody')
  if (installationOptions)
    registerLinuxAppImageProtocolHandler({ ...installationOptions, makeDefault: true })
  return result
}

export function isDefaultLodyProtocolClient(): boolean {
  const appEntry = resolveDefaultAppEntryPath()
  return !app.isPackaged && appEntry
    ? app.isDefaultProtocolClient('lody', process.execPath, [appEntry])
    : app.isDefaultProtocolClient('lody')
}

export function registerLodyProtocolClient(options: RegisterProtocolClientOptions): void {
  installationOptions = options
  const { protocol, log } = options
  if (!app.isPackaged && process.env.LODY_E2E === '1') {
    log('registerLodyProtocolClient skipped for E2E', { protocol })
    return
  }
  const appEntry = resolveDefaultAppEntryPath()
  let registrationResult = false

  // NSIS protocol declarations are not a Windows registration guarantee. Repair
  // first-launch registration only when there is no handler; never reclaim one.
  if (process.platform === 'win32' && app.isPackaged) {
    void app
      .whenReady()
      .then(() => {
        if (!app.getApplicationNameForProtocol(`${LODY_PROTOCOLS.resource}://`)) {
          const registered = app.setAsDefaultProtocolClient(LODY_PROTOCOLS.resource)
          log('registered previously unhandled resource scheme', { registered })
        }
      })
      .catch(() => log('unable to check resource scheme registration'))
  }

  if (!app.isPackaged && appEntry) {
    registrationResult = app.setAsDefaultProtocolClient(protocol, process.execPath, [appEntry])
    log('registerLodyProtocolClient finished for dev mode', {
      registrationResult,
      protocol,
      appEntry,
      execPath: process.execPath,
      processPlatform: process.platform
    })
    return
  }

  registrationResult = app.setAsDefaultProtocolClient(protocol)
  log('registerLodyProtocolClient finished', {
    registrationResult,
    protocol,
    appEntry,
    isPackaged: app.isPackaged,
    processPlatform: process.platform
  })

  registerLinuxAppImageProtocolHandler(options)
}
