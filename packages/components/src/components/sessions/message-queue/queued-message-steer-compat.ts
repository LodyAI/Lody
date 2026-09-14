import type { AcpCapabilityAuthority, AcpCapabilityCacheEntry } from '@lody/shared';

/**
 * Older daemons have no exact-item queue RPC. Only their acknowledged ACP
 * capability can preserve true in-prompt steering; an absent or provisional
 * cache entry must not be guessed into support.
 */
export function shouldUseLegacyNativeQueueSteer(
  authority: AcpCapabilityAuthority,
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined
): boolean {
  return authority === 'authoritative' && capability?.acknowledgedSteer === true;
}

export type QueuedMessageSteerRoute = 'exact-daemon' | 'legacy-native' | 'legacy-head';

export function resolveQueuedMessageSteerRoute(options: {
  supportsExactDaemonProtocol: boolean;
  authority: AcpCapabilityAuthority;
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined;
}): QueuedMessageSteerRoute {
  if (options.supportsExactDaemonProtocol) return 'exact-daemon';
  return shouldUseLegacyNativeQueueSteer(options.authority, options.capability)
    ? 'legacy-native'
    : 'legacy-head';
}
