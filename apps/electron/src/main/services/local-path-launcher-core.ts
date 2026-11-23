import type {
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  LocalPathCommandSpec
} from '@lody/shared/electron-ipc'

type CommandLaunchInput = Extract<LaunchLocalPathInput, { kind: 'command' }>

export async function probePathLauncher(
  input: LaunchLocalPathInput,
  commandAvailable: (command: LocalPathCommandSpec) => Promise<boolean>,
  protocolAvailable: (url: string) => Promise<boolean>
): Promise<boolean> {
  if (input.kind === 'url') {
    return protocolAvailable(input.url)
  }

  const availabilityChecks = [commandAvailable(input.command)]
  if (input.fallbackCommands) {
    for (const command of input.fallbackCommands) {
      availabilityChecks.push(commandAvailable(command))
    }
  }
  const commandAvailability = await Promise.all(availabilityChecks)
  if (commandAvailability.some(Boolean)) return true
  return input.fallbackUrl ? protocolAvailable(input.fallbackUrl) : false
}

export async function launchCommandPathWithFallback(
  input: CommandLaunchInput,
  launchCommand: (command: LocalPathCommandSpec) => Promise<LaunchLocalPathResult>,
  launchUrl: (url: string) => Promise<LaunchLocalPathResult>
): Promise<LaunchLocalPathResult> {
  let lastResult = await launchCommand(input.command)
  if (lastResult.launched) {
    return lastResult
  }

  for (const fallback of input.fallbackCommands ?? []) {
    lastResult = await launchCommand(fallback)
    if (lastResult.launched) {
      return lastResult
    }
  }

  if (input.fallbackUrl) {
    return await launchUrl(input.fallbackUrl)
  }

  return lastResult
}

/** Keep native executable and protocol candidates when cmd.exe cannot safely carry the path. */
export function selectSafePathLauncherInput(
  input: LaunchLocalPathInput,
  platform: string,
  usesShell: (command: string) => boolean
): LaunchLocalPathInput | null {
  if (platform !== 'win32' || input.kind === 'url' || !/[&|<>^%!"\r\n]/u.test(input.targetPath))
    return input
  const candidates = [input.command, ...(input.fallbackCommands ?? [])].filter(
    (candidate) => !usesShell(candidate.command)
  )
  if (candidates.length)
    return { ...input, command: candidates[0]!, fallbackCommands: candidates.slice(1) }
  if (input.fallbackUrl)
    return { kind: 'url', url: input.fallbackUrl, targetPath: input.targetPath, label: input.label }
  return null
}
