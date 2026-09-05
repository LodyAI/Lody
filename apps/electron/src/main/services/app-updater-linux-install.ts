import type { ChildProcess } from 'node:child_process'

/**
 * Privileged install of a downloaded `.deb`, run by this process instead of
 * electron-updater.
 *
 * `DebUpdater.doInstall` shells out through `BaseUpdater.spawnSyncLog`, and
 * `spawnSync` blocks the whole main process — including the event loop — for as
 * long as polkit keeps its password prompt open. On a machine where the prompt
 * is not answered (a hidden dialog, an SSH session, no graphical agent) the app
 * freezes with no window updates and no way to cancel. Nothing on the JS side
 * can interrupt a `spawnSync` that has already started, so the only fix is to
 * never enter it: run the installer asynchronously here and let
 * electron-updater keep every other platform.
 */
export type LinuxDebInstallPlan = {
  command: string
  args: string[]
}

export type LinuxDebInstallResult = { ok: true } | { ok: false; error: string }

export type SpawnLinuxDebInstall = (command: string, args: string[]) => ChildProcess

/** pkexec: authorization could not be obtained. */
const PKEXEC_NOT_AUTHORIZED = 126
/** pkexec: the program could not be executed. */
const PKEXEC_NOT_EXECUTABLE = 127
const MAX_STDERR_CHARS = 2000

/**
 * The privileged command for a downloaded update, or `null` when this update
 * must keep electron-updater's own install path.
 */
export function resolveLinuxDebInstallPlan(input: {
  platform: string
  downloadedFile: string | undefined
  appImagePath: string | undefined
}): LinuxDebInstallPlan | null {
  if (input.platform !== 'linux') return null
  // An AppImage rewrites its own file as the current user and never needs a
  // privileged helper, so it never reaches the blocking path.
  if (input.appImagePath) return null

  const packagePath = input.downloadedFile?.trim()
  if (!packagePath || !packagePath.endsWith('.deb')) return null

  return {
    command: 'pkexec',
    // Arguments are passed as argv, not through a shell, so a package path
    // containing spaces needs no quoting or escaping.
    //
    // `--disable-internal-agent` keeps pkexec from falling back to a terminal
    // prompt that a desktop session has no tty for; without a graphical polkit
    // agent it fails fast instead of waiting on input nobody can give.
    args: ['--disable-internal-agent', 'dpkg', '-i', packagePath]
  }
}

/**
 * Run the plan and resolve once the installer has exited. Never rejects: a
 * failure is a value the caller reports to the renderer.
 */
export function runLinuxDebInstall(
  plan: LinuxDebInstallPlan,
  spawnProcess: SpawnLinuxDebInstall
): Promise<LinuxDebInstallResult> {
  return new Promise((resolve) => {
    // `error` and `exit` can both fire for one failed spawn, and Node does not
    // guarantee which arrives (or that both do), so the first one settles.
    let settled = false
    const settle = (result: LinuxDebInstallResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawnProcess(plan.command, plan.args)
    } catch (error) {
      settle({ ok: false, error: describeSpawnFailure(plan.command, error) })
      return
    }

    let stderr = ''
    child.stderr?.on('data', (chunk: unknown) => {
      if (stderr.length >= MAX_STDERR_CHARS) return
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      settle({ ok: false, error: describeSpawnFailure(plan.command, error) })
    })
    child.on('exit', (code, signal) => {
      const failure = describeExit(code, signal, stderr)
      settle(failure ? { ok: false, error: failure } : { ok: true })
    })
  })
}

function describeSpawnFailure(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not start ${command} to install the update: ${message}`
}

/** A human-readable failure, or `null` when the installer succeeded. */
function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): string | null {
  const detail = stderr.trim().slice(0, MAX_STDERR_CHARS)
  const suffix = detail ? ` ${detail}` : ''

  if (signal) return `The update installer was stopped by signal ${signal}.${suffix}`
  if (code === 0) return null
  if (code === PKEXEC_NOT_AUTHORIZED) {
    return `The update install was not authorized: the system password prompt was dismissed, authentication failed, or no polkit agent was available.${suffix}`
  }
  if (code === PKEXEC_NOT_EXECUTABLE) {
    return `The update install could not run a privileged helper (pkexec exited ${PKEXEC_NOT_EXECUTABLE}).${suffix}`
  }
  return `The update install failed: dpkg exited with code ${code}.${suffix}`
}
