export const IPC_INVOKE_SERVICE_GROUPS = [
  'app',
  'auth',
  'cli',
  'e2ee',
  'image',
  'localPlatform',
  'localProjects',
  'loro',
  'machineRpc',
  'notifications',
  'publicBrowser',
  'sessionControl',
  'storageGuard',
  'terminal',
  'updater'
] as const

const INVOKE_SERVICE_GROUP_VALUES = new Set<string>(IPC_INVOKE_SERVICE_GROUPS)
const IPC_INVOKE_CHANNEL_PATTERN = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)$/u

export function isIpcInvokeChannel(channel: string): boolean {
  const match = IPC_INVOKE_CHANNEL_PATTERN.exec(channel)
  const group = match?.[1]
  if (group === 'e2ee')
    return new Set([
      'account',
      'createMemberInvitation',
      'pendingMemberJoin',
      'prepareMemberJoin',
      'memberJoinRequests',
      'approveMemberJoin',
      'rejectMemberJoin',
      'revokeMemberInvitation',
      'claimMemberJoin',
      'personalPairingOffer',
      'pendingPersonalJoin',
      'preparePersonalJoin',
      'inspectPersonalJoin',
      'approvePersonalJoin',
      'claimPersonalJoin',
      'cancelPersonalJoin',

      'prepareLocalAgent',
      'admitLocalAgent',
      'beginRemoteMachinePairing',
      'inspectRemoteMachinePairing',
      'approveRemoteMachinePairing',
      'cancelRemoteMachinePairing',
      'seal',
      'openContent',
      'prepareFeatureRpc',
      'acceptFeatureRpcResponse',
      'prepareDispatch',
      'inspectCachedState',
      'readMachineSharing',
      'updateMachineSharing',
      'acceptDispatchResponse',
      'contentStreamsToken',
      'removeMember',
      'setMemberRole',
      'refresh',
      'prepareCreation',
      'recordCreated',
      'open',
      'close',
      'status',
      'readIdentity',
      'resetIdentity',
      'resetLocalAgent',
      'ingestLedgerRecords',
      'ledgerView',
      'managementState',
      'updateKeys',
      'revokeDevice',
      'createRecoveryVault',
      'inspectRecoveryFile'
    ]).has(match![2]!)
  return group !== undefined && INVOKE_SERVICE_GROUP_VALUES.has(group)
}

// Mirrors `E2EE_CLIENT_LOSS_PROBE` in `@lody/shared/electron-ipc` (pinned by the
// IPC registration test); this policy stays dependency-free for its Node loaders.
export const CLIENT_LOSS_PROBE_POLICY = {
  argument: '--lody-e2ee-client-loss-probe',
  channels: ['e2ee.inspectClientLoss', 'e2ee.clientLossEffects']
} as const

/** E2E-only probe channels: admitted only when main passed its registration argument. */
export function isClientLossProbeChannel(
  channel: string,
  argv: readonly string[] = process.argv
): boolean {
  return (
    (CLIENT_LOSS_PROBE_POLICY.channels as readonly string[]).includes(channel) &&
    argv.includes(CLIENT_LOSS_PROBE_POLICY.argument)
  )
}
