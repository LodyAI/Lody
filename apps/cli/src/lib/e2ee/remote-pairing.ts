import { setTimeout as pause } from 'node:timers/promises';
import { Result } from 'effect';
import { verifySignature } from '@lody/e2ee-core/protocol';
import {
  RemoteMachineOfferSchema,
  RemoteMachineStatusSchema,
  remoteMachineOfferBytes,
  remoteMachineSummary,
} from '@lody/shared/e2ee-remote-pairing';
import { LocalE2eePrepareResponseSchema } from '@lody/shared/e2ee-local-pairing';
import {
  prepareCliE2eeMachineLegacy,
  activateCliE2eeWorkspaceLegacy,
  retainCliE2eeMachineBootstrapLegacy,
} from './workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import type { MachineKeyring } from './custody';
const raw = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const POLL_MS = 1500;
const KEY_RETRY_MAX_MS = 15_000;
// Admission precedes key delivery: the approving desktop's refresh sends the current
// key afterwards and resumes it on its next refresh. Bound this wait for the terminal user.
const KEY_WAIT_MS = 10 * 60_000;
/** Verify the executable command before any custody access or network operation. */
export function decodeRemoteMachineOffer(encoded: string) {
  if (encoded.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('e2ee_pairing_invalid_command');
  const offer = RemoteMachineOfferSchema.parse(
    JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  );
  if (
    Result.isFailure(
      verifySignature(
        raw(offer.frontendSigningPublicKey),
        remoteMachineOfferBytes(offer),
        raw(offer.signature)
      )
    )
  )
    throw new Error('e2ee_pairing_invalid_command');
  return offer;
}
/** Command-owned facade over the existing custody and activation owners. No account login/key is created. */
export async function pairRemoteMachineLegacy(options: {
  encodedOffer: string;
  machineId: string;
  cloud: CloudE2eePort;
  signal: AbortSignal;
  claim: (originalBody: string, signal: AbortSignal) => Promise<unknown>;
  keyring?: MachineKeyring;
  show: (value: {
    summary: string;
    protection: 'os-keystore' | 'file';
    location?: { country: string | null; city: string | null } | null;
    status: string;
  }) => void;
  wait?: (signal: AbortSignal, delayMs: number) => Promise<void>;
  now?: () => number;
}) {
  const wait = options.wait ?? ((signal, delayMs) => pause(delayMs, undefined, { signal }));
  const now = options.now ?? Date.now;
  let keyWaitStartedAt: number | undefined;
  let keyRetryMs = POLL_MS;
  const offer = decodeRemoteMachineOffer(options.encodedOffer);
  const prepared = await prepareCliE2eeMachineLegacy({
    ...offer,
    machineId: options.machineId,
    keyring: options.keyring,
  });
  if ('superseded' in prepared) throw new Error('e2ee_pairing_superseded_create_new_command');
  const material = LocalE2eePrepareResponseSchema.parse({
    ...prepared,
    machineId: options.machineId,
    ok: true,
    type: 'prepare',
  });
  const summary = await remoteMachineSummary(offer, material);
  options.show({ summary, protection: material.protection, status: 'connecting' });
  const body = JSON.stringify({
    workspaceId: offer.workspaceId,
    pairingSessionId: offer.pairingSessionId,
    token: offer.token,
    material,
  });
  for (;;) {
    options.signal.throwIfAborted();
    const status = RemoteMachineStatusSchema.parse(await options.claim(body, options.signal));
    if (
      status.pairingSessionId !== offer.pairingSessionId ||
      (status.material && JSON.stringify(status.material) !== JSON.stringify(material))
    )
      throw new Error('e2ee_pairing_conflict');
    options.show({
      summary,
      protection: material.protection,
      location: status.location,
      status: status.status,
    });
    if (['cancelled', 'expired', 'conflict'].includes(status.status))
      throw new Error(`e2ee_pairing_${status.status}_create_new_command`);
    if (status.status === 'admitted' || status.status === 'ready') {
      try {
        await activateCliE2eeWorkspaceLegacy({
          accountId: offer.accountId,
          workspaceId: offer.workspaceId,
          genesisHash: offer.genesisHash,
          pairingSessionId: offer.pairingSessionId,
          frontendSigningPublicKey: offer.frontendSigningPublicKey,
          expectedSigningPublicKey: material.signingPublicKey,
          cloud: options.cloud,
          onUnavailable: () => undefined,
          keyring: options.keyring,
        });
      } catch (error) {
        if (!(error instanceof Error && error.message === 'e2ee_waiting_for_key')) throw error;
        keyWaitStartedAt ??= now();
        if (now() - keyWaitStartedAt >= KEY_WAIT_MS) throw error;
        options.show({
          summary,
          protection: material.protection,
          location: status.location,
          status: 'waiting-for-key',
        });
        await wait(options.signal, keyRetryMs);
        keyRetryMs = Math.min(keyRetryMs * 2, KEY_RETRY_MAX_MS);
        continue;
      }
      await retainCliE2eeMachineBootstrapLegacy(
        {
          accountId: offer.accountId,
          workspaceId: offer.workspaceId,
          genesisHash: offer.genesisHash,
          signingPublicKey: material.signingPublicKey,
          machineId: options.machineId,
          deploymentUrl: offer.deploymentUrl,
        },
        options.keyring
      );
      options.signal.throwIfAborted();
      return {
        reference: `${offer.accountId}/${offer.workspaceId}`,
        workspaceId: offer.workspaceId,
        machineId: options.machineId,
        summary,
        ready: true as const,
      };
    }
    await wait(options.signal, POLL_MS);
  }
}
