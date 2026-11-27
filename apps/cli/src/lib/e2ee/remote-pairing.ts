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
const CLAIM_RETRY_BASE_MS = 1500;
const CLAIM_RETRY_MAX_MS = 15_000;
const CLAIM_RETRY_BUDGET_MS = 60_000;
const CLAIM_RETRY_MAX_ATTEMPTS = 8;

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

function isTransientClaimError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return TRANSIENT_HTTP_STATUSES.has(status);
  }
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError) return true;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return /(?:^|\b)(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network)/i.test(
    error.message
  );
}
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
  let keyRetryMs = POLL_MS;
  let claimRetryStartedAt: number | undefined;
  let claimRetryAttempts = 0;
  let claimRetryMs = CLAIM_RETRY_BASE_MS;
  const offer = decodeRemoteMachineOffer(options.encodedOffer);
  const prepared = await prepareCliE2eeMachineLegacy({
    ...offer,
    machineId: options.machineId,
    keyring: options.keyring,
    cloud: options.cloud,
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
    let rawStatus: unknown;
    try {
      rawStatus = await options.claim(body, options.signal);
    } catch (error) {
      if (!isTransientClaimError(error, options.signal)) throw error;
      claimRetryStartedAt ??= now();
      claimRetryAttempts += 1;
      if (
        claimRetryAttempts >= CLAIM_RETRY_MAX_ATTEMPTS ||
        now() - claimRetryStartedAt >= CLAIM_RETRY_BUDGET_MS
      )
        throw error;
      await wait(options.signal, claimRetryMs);
      claimRetryMs = Math.min(claimRetryMs * 2, CLAIM_RETRY_MAX_MS);
      continue;
    }
    claimRetryStartedAt = undefined;
    claimRetryAttempts = 0;
    claimRetryMs = CLAIM_RETRY_BASE_MS;
    const status = RemoteMachineStatusSchema.parse(rawStatus);
    if (status.pairingSessionId !== offer.pairingSessionId)
      throw new Error('e2ee_pairing_conflict');
    // Another machine's claim on the same command, before or after ours; never admit it.
    if (
      (status.material && JSON.stringify(status.material) !== JSON.stringify(material)) ||
      (status.status === 'conflict' && status.noAdmissionReserved === true)
    )
      throw new Error('e2ee_pairing_claimed_by_another_machine');
    options.show({
      summary,
      protection: material.protection,
      location: status.location,
      status: status.status,
    });
    if (['cancelled', 'expired', 'conflict'].includes(status.status))
      throw new Error(`e2ee_pairing_${status.status}_create_new_command`);
    if (status.status === 'admitted' || status.status === 'ready') {
      const keyWaitDeadline = now() + KEY_WAIT_MS;
      for (;;) {
        options.signal.throwIfAborted();
        const remainingMs = keyWaitDeadline - now();
        if (remainingMs <= 0) throw new Error('e2ee_waiting_for_key');
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
            signal: options.signal,
            timeoutMs: remainingMs,
          });
          break;
        } catch (error) {
          options.signal.throwIfAborted();
          if (!(error instanceof Error && error.message === 'e2ee_waiting_for_key')) throw error;
          if (now() >= keyWaitDeadline) throw error;
          options.show({
            summary,
            protection: material.protection,
            location: status.location,
            status: 'waiting-for-key',
          });
          await wait(options.signal, Math.min(keyRetryMs, Math.max(1, keyWaitDeadline - now())));
          keyRetryMs = Math.min(keyRetryMs * 2, KEY_RETRY_MAX_MS);
        }
      }
      options.signal.throwIfAborted();
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
