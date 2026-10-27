import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { createLoroStreamsTokenProviderLegacy, LoroStreamsTokenRequestSchema } from '@lody/shared';
import {
  encryptedWorkspaceNamespace,
  encryptedWorkspaceResolver,
  createWorkspaceEpochTransitionLegacy,
  type WorkspaceEpochPhase,
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
  onPhase?: (phase: WorkspaceEpochPhase) => void;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash)) throw new Error('e2ee_invalid_genesis');
  let bucketId: string | null = null;
  const transition = createWorkspaceEpochTransitionLegacy({
    epoch: input.epoch,
    rotationRequired: input.rotationRequired,
    onPhase: (phase) => {
      input.onPhase?.(phase);
      if (phase !== 'ready' && phase !== 'closed') input.onKeyUpdateRequired?.();
    },
  });
  const updateStatus = (status: {
    epoch: number;
    rotationRequired: boolean;
    hasCurrentKey?: boolean;
  }) => transition.observe({ ...status, hasCurrentKey: status.hasCurrentKey ?? false });
  const content: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: encryptedWorkspaceNamespace(input.genesisHash),
    snapshotUpload: { canUpload: async () => false },
    resolve: encryptedWorkspaceResolver(input.workspaceId, (room) =>
      transition.provider(
        (epoch) =>
          ({
            maxSealOverheadBytes: 4096,
            seal: (request) => {
              const header = new Uint8Array([request.context.kind === 'snapshot' ? 4 : 3]);
              const additionalData = request.additionalData(header);
              return input.runtime.seal(input.workspaceId, {
                epoch,
                room,
                context: request.context,
                plaintext: request.plaintext,
                additionalData,
              });
            },
            open: (request) => input.runtime.openContent(input.workspaceId, { room, ...request }),
          }) satisfies PayloadProtectionProvider
      )
    ),
  };
  return {
    content,
    updateStatus,
    transition: transition.transition,
    phase: transition.phase,
    close: transition.close,
    e2ee: {
      bucketId: () => bucketId,
      createTokenProvider: (signal: AbortSignal) =>
        createLoroStreamsTokenProviderLegacy({
          // All requests terminate in the native capability below. This URL is
          // just the existing token kernel's local route identity.
          endpoint: `https://e2ee.invalid/content-token/${transition.epoch()}`,
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
