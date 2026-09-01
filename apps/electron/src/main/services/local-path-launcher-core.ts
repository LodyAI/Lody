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
