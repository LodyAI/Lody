import type { AcpCapabilityAuthority, AcpCapabilityCacheEntry } from '@lody/shared';

export function shouldRequestNativeQueueSteer(
  authority: AcpCapabilityAuthority,
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined
): boolean {
  return authority === 'authoritative' && capability?.acknowledgedSteer === true;
}
