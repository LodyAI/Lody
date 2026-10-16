import type { PlatformE2eeWorkspaces } from '@lody/platform';
import {
  clearPendingE2eeWorkspace,
  saveE2eeGenesisPin,
  retainWorkspaceModeProof,
  type PendingE2eeWorkspace,
} from './e2ee-workspace-storage';

/** Reconcile the durable intent. Any unknown outcome leaves it available for retry. */
export async function createPreparedE2eeWorkspace(
  port: PlatformE2eeWorkspaces,
  storage: Storage,
  pending: PendingE2eeWorkspace
) {
  if (!port.prepareCreation) throw new Error('Device custody unavailable');
  const prepared = await port.prepareCreation(pending);
  if (
    prepared.accountId !== pending.accountId ||
    prepared.requestId !== pending.requestId ||
    prepared.name !== pending.name ||
    prepared.slug !== pending.slug
  )
    throw new Error('Creation intent changed');
  const result = await port.create({
    accountId: pending.accountId,
    name: pending.name,
    slug: pending.slug,
    requestId: pending.requestId,
    genesisRecordHex: prepared.genesisRecordHex,
    developerMode: true,
  });
  if (
    result.contentMode !== 'e2ee' ||
    result.contentModeVersion !== 1 ||
    result.name !== pending.name ||
    result.slug !== pending.slug ||
    result.genesisHash !== prepared.genesisHashHex ||
    result.cryptoOrgId !== prepared.genesisHashHex ||
    result.activation !== 'control-only'
  )
    throw new Error('Creation response changed');
  saveE2eeGenesisPin(storage, pending.accountId, result.workspaceId, prepared.genesisHashHex);
  retainWorkspaceModeProof(storage, pending.accountId, pending.slug, result);
  clearPendingE2eeWorkspace(storage, pending);
  return result;
}
