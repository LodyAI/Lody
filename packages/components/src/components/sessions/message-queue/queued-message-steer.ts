import type { AcpCapabilityAuthority, AcpCapabilityCacheEntry } from '@lody/shared';

export function shouldRequestNativeQueueSteer(
  authority: AcpCapabilityAuthority,
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined
): boolean {
  return authority === 'authoritative' && capability?.acknowledgedSteer === true;
}

/**
 * The first row always offers Steer: without native steering it falls back to
 * interrupt-and-send, which is only meaningful for the item the queue drains
 * next. Later rows offer Steer only when native steering can deliver THAT item;
 * there is no fallback for them.
 */
export function shouldShowQueuedItemSteer(options: {
  showSteerAction: boolean;
  isFirst: boolean;
  nativeSteerAvailable: boolean;
}): boolean {
  return options.showSteerAction && (options.isFirst || options.nativeSteerAvailable);
}
