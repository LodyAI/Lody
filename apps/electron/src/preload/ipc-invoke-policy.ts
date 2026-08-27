export const IPC_INVOKE_SERVICE_GROUPS = [
  'app',
  'auth',
  'cli',
  'image',
  'localPlatform',
  'localProjects',
  'loro',
  'machineRpc',
  'notifications',
  'publicBrowser',
  'sessionControl',
  'terminal',
  'updater'
] as const

const INVOKE_SERVICE_GROUP_VALUES = new Set<string>(IPC_INVOKE_SERVICE_GROUPS)
const IPC_INVOKE_CHANNEL_PATTERN = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)$/u

export function isIpcInvokeChannel(channel: string): boolean {
  const match = IPC_INVOKE_CHANNEL_PATTERN.exec(channel)
  const group = match?.[1]
  return group !== undefined && INVOKE_SERVICE_GROUP_VALUES.has(group)
}
