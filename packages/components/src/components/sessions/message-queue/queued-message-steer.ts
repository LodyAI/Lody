import type { AcpCapabilityAuthority, AcpCapabilityCacheEntry } from '@lody/shared';

export type FallbackQueueSteerPreparation =
  | { type: 'ready' }
  | { type: 'reorder'; activeCid: string; overCid: string }
  | { type: 'missing' };

export function resolveFallbackQueueSteerPreparation(
  queueItemCids: readonly string[],
  selectedCid: string
): FallbackQueueSteerPreparation {
  const selectedIndex = queueItemCids.indexOf(selectedCid);
  if (selectedIndex < 0) return { type: 'missing' };
  if (selectedIndex === 0) return { type: 'ready' };
  return {
    type: 'reorder',
    activeCid: selectedCid,
    overCid: queueItemCids[0]!,
  };
}

export async function steerQueuedMessageWithFallback({
  queueItemCids,
  selectedCid,
  reorder,
  interrupt,
}: {
  queueItemCids: readonly string[];
  selectedCid: string;
  reorder: (activeCid: string, overCid: string) => Promise<void>;
  interrupt: () => Promise<void>;
}): Promise<'steered' | 'missing' | 'reorder_failed'> {
  const preparation = resolveFallbackQueueSteerPreparation(queueItemCids, selectedCid);
  if (preparation.type === 'missing') return 'missing';
  if (preparation.type === 'reorder') {
    try {
      await reorder(preparation.activeCid, preparation.overCid);
    } catch {
      return 'reorder_failed';
    }
  }
  await interrupt();
  return 'steered';
}

export function shouldRequestNativeQueueSteer(
  authority: AcpCapabilityAuthority,
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined
): boolean {
  return authority === 'authoritative' && capability?.acknowledgedSteer === true;
}
