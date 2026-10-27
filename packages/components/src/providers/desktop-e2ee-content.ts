import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { createLoroStreamsTokenProviderLegacy, LoroStreamsTokenRequestSchema } from '@lody/shared';
import {
  encryptedWorkspaceNamespace,
  encryptedWorkspaceResolver,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';

/** Native purpose-bound providers: keys and signatures always remain in main. */
export function createDesktopE2eeContent(input: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  genesisHash: string;
  epoch: number;
  authToken: () => string | null | undefined;
  rotationRequired?: boolean;
  onKeyUpdateRequired?: () => void;
  onSnapshotRecoveryChange?: (pending: boolean) => void;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash)) throw new Error('e2ee_invalid_genesis');
  let bucketId: string | null = null;
  const recovering = new Set<string>();
  const requested = new Map<string, number>();
  const recovery = (stream: string, pending: boolean) => {
    if (pending) recovering.add(stream);
    else recovering.delete(stream);
    try {
      input.onSnapshotRecoveryChange?.(recovering.size > 0);
    } catch {
      /* Observational only. */
    }
  };
  const snapshotRecovery = (stream: string, pending: boolean) => {
    recovery(stream, pending);
    if (!pending) return;
    const now = Date.now();
    if (now - (requested.get(stream) ?? -Infinity) < 30_000) return;
    requested.set(stream, now);
    // The existing host action relays fixed hints for read-only devices too.
    void input.runtime.contentStreamsToken(input.workspaceId, undefined, stream).catch(() => {
      console.warn('[e2ee] snapshot repair request failed; will retry');
    });
  };
  let keyUpdateRequired = input.rotationRequired === true;
  const updateStatus = (status: { epoch: number; rotationRequired: boolean }) => {
    if (keyUpdateRequired || (status.epoch === input.epoch && !status.rotationRequired)) return;
    keyUpdateRequired = true;
    input.onKeyUpdateRequired?.();
  };
  const content: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: encryptedWorkspaceNamespace(input.genesisHash),
    snapshotUpload: {
      // SDK rejection also covers absent/malformed envelopes before provider.open.
      onSnapshotRecovery: (streamUrl, pending) =>
        snapshotRecovery(
          decodeURIComponent(new URL(streamUrl).pathname.split('/').at(-1)!),
          pending
        ),
      // SDK schedules only after local writes, suppresses a competing writer,
      // and checks the remote snapshot before exporting a new one.
      canUpload: () => !keyUpdateRequired,
      debounceMs: 30_000,
      minBytesSinceRemoteSnapshot: 1024 * 1024,
    },
    resolve: encryptedWorkspaceResolver(
      input.workspaceId,
      (room) =>
        ({
          maxSealOverheadBytes: 4096,
          seal: (request) => {
            if (keyUpdateRequired) return Promise.reject(new Error('e2ee_key_update_required'));
            const header = new Uint8Array([request.context.kind === 'snapshot' ? 4 : 3]);
            const additionalData = request.additionalData(header);
            return input.runtime.seal(input.workspaceId, {
              epoch: input.epoch,
              room,
              context: request.context,
              plaintext: request.plaintext,
              additionalData,
            });
          },
          open: (request) => input.runtime.openContent(input.workspaceId, { room, ...request }),
        }) satisfies PayloadProtectionProvider
    ),
  };
  return {
    content,
    updateStatus,
    e2ee: {
      bucketId: () => bucketId,
      createTokenProvider: (signal: AbortSignal) =>
        createLoroStreamsTokenProviderLegacy({
          // All requests terminate in the native capability below. This URL is
          // just the existing token kernel's local route identity.
          endpoint: 'https://e2ee.invalid/content-token',
          workspaceId: input.workspaceId,
          authToken: input.authToken,
          fetchImpl: async (_url, init) => {
            const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
            requestSignal.throwIfAborted();
            const request = LoroStreamsTokenRequestSchema.parse(JSON.parse(String(init?.body)));
            if (request.workspaceId !== input.workspaceId)
              throw new Error('e2ee_content_configuration');
            const response = await input.runtime.contentStreamsToken(
              input.workspaceId,
              request.rejectedToken
            );
            requestSignal.throwIfAborted();
            if (
              !response.bucketId ||
              response.bucketId === 'lody' ||
              !response.gatewayBaseUrl ||
              response.expiresIn > 900
            )
              throw new Error('e2ee_content_configuration');
            if (bucketId && bucketId !== response.bucketId)
              throw new Error('e2ee_content_configuration');
            bucketId = response.bucketId;
            return new Response(JSON.stringify(response), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        }),
    },
  };
}
