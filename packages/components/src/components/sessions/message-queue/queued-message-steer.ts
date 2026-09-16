import type { AcpCapabilityAuthority, AcpCapabilityCacheEntry, SessionHistory } from '@lody/shared';

export function shouldRequestNativeQueueSteer(
  authority: AcpCapabilityAuthority,
  capability: Pick<AcpCapabilityCacheEntry, 'acknowledgedSteer'> | undefined
): boolean {
  return authority === 'authoritative' && capability?.acknowledgedSteer === true;
}

/** Reuse queue admission when native steer promotes that same user turn. */
export async function resolveQueuedUserHistoryEntry(
  journal: { read(id: string): Promise<{ entry: SessionHistory } | undefined> } | null | undefined,
  userTurnId: string,
  create: () => Promise<SessionHistory>
): Promise<SessionHistory> {
  return (await journal?.read(userTurnId))?.entry ?? (await create());
}
