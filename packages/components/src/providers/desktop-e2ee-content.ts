import { isE2eeMemberRemoved } from '../lib/e2ee-member-removal';
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
  onMemberRemoved?: () => void;
  onSnapshotRecoveryChange?: (pending: boolean) => void;
  onPhase?: (phase: WorkspaceEpochPhase) => void;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash)) throw new Error('e2ee_invalid_genesis');
  let bucketId: string | null = null;
  let memberRemoved = false;
  const observeRemoval = (error: unknown) => {
    if (!isE2eeMemberRemoved(error)) return false;
    if (!memberRemoved) {
      memberRemoved = true;
      try {
        input.onMemberRemoved?.();
      } catch {
        /* Retirement never holds the token request. */
      }
    }
    return true;
  };
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
    void input.runtime.contentStreamsToken(input.workspaceId, undefined, stream).catch((error) => {
      if (observeRemoval(error)) return;
      console.warn('[e2ee] snapshot repair request failed; will retry');
    });
  };
  const tokens = new Set<ReturnType<typeof createLoroStreamsTokenProviderLegacy>>();
  const transition = createWorkspaceEpochTransitionLegacy({
    epoch: input.epoch,
    rotationRequired: input.rotationRequired,
    onPhase: (phase) => {
      if (phase === 'ready') for (const token of tokens) token.invalidate();
      input.onPhase?.(phase);
      if (phase !== 'ready' && phase !== 'closed') input.onKeyUpdateRequired?.();
    },
  });
  const updateStatus = (status: {
    epoch: number;
    rotationRequired: boolean;
    hasCurrentKey?: boolean;
  }) => {
    transition.observe({ ...status, hasCurrentKey: status.hasCurrentKey ?? false });
    if (transition.needsUpdate()) input.onKeyUpdateRequired?.();
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
      canUpload: () => !memberRemoved && transition.phase() !== 'closed',
      debounceMs: 30_000,
      minBytesSinceRemoteSnapshot: 1024 * 1024,
    },
    resolve: encryptedWorkspaceResolver(input.workspaceId, (room) =>
      transition.provider(
        (epoch) =>
          ({
            maxSealOverheadBytes: 4096,
            seal: (request) => {
              if (memberRemoved) return Promise.reject(new Error('e2ee_member_removed'));
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
    needsUpdate: transition.needsUpdate,
    close: transition.close,
    e2ee: {
      attachmentToken: async () => {
        if (memberRemoved || transition.phase() === 'closed') throw new Error('e2ee_closed');
        const result = await input.runtime.contentStreamsToken(input.workspaceId).catch((error) => { observeRemoval(error); throw error; });
        if (!result.attachmentToken) throw new Error('e2ee_attachment_unavailable');
        return result.attachmentToken;
      },
      prepareDispatch: (
        machineId: string,
        args: import('@lody/shared/e2ee-rpc').E2eeDispatchInput
      ) => {
        if (!input.runtime.prepareDispatch)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return input.runtime.prepareDispatch(input.workspaceId, machineId, args);
      },
      acceptDispatchResponse: (
        machineId: string,
        args: import('@lody/shared/e2ee-rpc').E2eeDispatchInput,
        frame: string
      ) => {
        if (!input.runtime.acceptDispatchResponse)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return input.runtime.acceptDispatchResponse(input.workspaceId, machineId, args, frame);
      },
      bucketId: () => bucketId,
      createTokenProvider: (signal: AbortSignal) => {
        const token = createLoroStreamsTokenProviderLegacy({
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
            const response = await input.runtime
              .contentStreamsToken(input.workspaceId, request.rejectedToken)
              .catch((error) => {
                observeRemoval(error);
                throw error;
              });
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
        });
        tokens.add(token);
        return {
          ...token,
          close: async () => {
            await token.close();
            tokens.delete(token);
          },
        };
      },
    },
  };
}
