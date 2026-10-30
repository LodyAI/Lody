import { isE2eeMemberRemoved } from '../lib/e2ee-member-removal';
import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import type { E2eeRuntimeStatus, E2eeWorkspaceRuntime } from '@lody/platform';
import { createLoroStreamsTokenProviderLegacy, LoroStreamsTokenRequestSchema } from '@lody/shared';
import {
  encryptedWorkspaceNamespace,
  encryptedWorkspaceResolver,
  createWorkspaceEpochTransitionLegacy,
  type WorkspaceEpochPhase,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';

const NO_TOKEN_STORAGE = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** Shared purpose-bound providers. Keys and credentials stay inside the injected host runtime. */
export function createE2eeContent(input: {
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
  let memberRemoved = false,
    closed = false;
  const assertOpen = () => {
    if (closed || memberRemoved) throw new Error('e2ee_closed');
  };
  const withinContent = async <A>(work: () => Promise<A>): Promise<A> => {
    assertOpen();
    const value = await work();
    assertOpen();
    return value;
  };
  const observeRemoval = (error: unknown) => {
    if (!isE2eeMemberRemoved(error)) return false;
    if (!memberRemoved) {
      setMemberRole(null);
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
    if (closed) return;
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
  // Display gate only. Missing or unverified roles read as `read`; the receiving
  // machine still applies its own ledger check to every signed request.
  let memberRole: E2eeRuntimeStatus['memberRole'] = null;
  const roleListeners = new Set<() => void>();
  const codeCollabRole = (): 'read' | 'write' =>
    !closed && !memberRemoved && memberRole && memberRole !== 'guest' ? 'write' : 'read';
  const setMemberRole = (next: E2eeRuntimeStatus['memberRole']) => {
    const before = codeCollabRole();
    memberRole = next;
    if (codeCollabRole() === before) return;
    for (const listener of [...roleListeners]) {
      try {
        listener();
      } catch {
        /* Observational only. */
      }
    }
  };
  const updateStatus = (status: {
    epoch: number;
    rotationRequired: boolean;
    hasCurrentKey?: boolean;
    memberRole?: E2eeRuntimeStatus['memberRole'];
  }) => {
    if (closed) return;
    setMemberRole(status.memberRole ?? null);
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
      canUpload: () => !closed && !memberRemoved && transition.phase() !== 'closed',
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
  const makeTokenProvider = (signal: AbortSignal, rpcOnly = false) => {
    assertOpen();
    const token = createLoroStreamsTokenProviderLegacy({
      // All requests terminate in the native capability below. This URL is
      // just the existing token kernel's local route identity.
      endpoint: `https://e2ee.invalid/${rpcOnly ? 'rpc-token' : 'content-token'}/${transition.epoch()}`,
      workspaceId: input.workspaceId,
      authToken: input.authToken,
      // Never hydrate a stored token: each provider must obtain its bucket from
      // the host, and every mint re-checks the host's current admission.
      storage: NO_TOKEN_STORAGE,
      fetchImpl: async (_url, init) => {
        // No native combined-signal API is needed: this adapter only checks
        // cancellation before/after the owned host call, rather than passing it on.
        const assertActive = () => {
          assertOpen();
          signal.throwIfAborted();
          init?.signal?.throwIfAborted();
        };
        assertActive();
        const request = LoroStreamsTokenRequestSchema.parse(JSON.parse(String(init?.body)));
        if (request.workspaceId !== input.workspaceId)
          throw new Error('e2ee_content_configuration');
        const response = await (
          rpcOnly
            ? input.runtime.contentStreamsToken(
                input.workspaceId,
                request.rejectedToken,
                undefined,
                true
              )
            : input.runtime.contentStreamsToken(input.workspaceId, request.rejectedToken)
        ).catch((error) => {
          observeRemoval(error);
          throw error;
        });
        assertActive();
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
      invalidate: (reason?: Parameters<typeof token.invalidate>[0]) => {
        if (!closed) token.invalidate(reason);
      },
      getToken: (...args: Parameters<typeof token.getToken>) =>
        withinContent(() => token.getToken(...args)),
      createAuthCallback: () => {
        const authenticate = token.createAuthCallback();
        return (...args: Parameters<typeof authenticate>) =>
          withinContent(() => authenticate(...args));
      },
      close: async () => {
        await token.close();
        tokens.delete(token);
      },
    };
  };
  return {
    content,
    updateStatus,
    transition: transition.transition,
    phase: transition.phase,
    needsUpdate: transition.needsUpdate,
    close: () => {
      setMemberRole(null);
      closed = true;
      return transition.close();
    },
    e2ee: {
      supportsDispatch: Boolean(
        input.runtime.prepareDispatch && input.runtime.acceptDispatchResponse
      ),
      supportsRpc: Boolean(
        input.runtime.prepareFeatureRpc &&
        input.runtime.acceptFeatureRpcResponse &&
        input.runtime.prepareDispatch &&
        input.runtime.acceptDispatchResponse
      ),
      attachmentToken: () =>
        withinContent(async () => {
          if (memberRemoved || transition.phase() === 'closed') throw new Error('e2ee_closed');
          const result = await input.runtime
            .contentStreamsToken(input.workspaceId)
            .catch((error) => {
              observeRemoval(error);
              throw error;
            });
          if (!result.attachmentToken) throw new Error('e2ee_attachment_unavailable');
          return result.attachmentToken;
        }),
      prepareFeatureRpc: (args: import('@lody/shared/e2ee-rpc').E2eeFeatureInput) => {
        if (!input.runtime.prepareFeatureRpc)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return withinContent(() => input.runtime.prepareFeatureRpc!(input.workspaceId, args));
      },
      acceptFeatureRpcResponse: (
        args: import('@lody/shared/e2ee-rpc').E2eeFeatureInput,
        frame: string
      ) => {
        if (!input.runtime.acceptFeatureRpcResponse)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return withinContent(() =>
          input.runtime.acceptFeatureRpcResponse!(input.workspaceId, args, frame)
        );
      },
      prepareDispatch: (
        machineId: string,
        args: import('@lody/shared/e2ee-rpc').E2eeDispatchInput
      ) => {
        if (!input.runtime.prepareDispatch)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return withinContent(() =>
          input.runtime.prepareDispatch!(input.workspaceId, machineId, args)
        );
      },
      acceptDispatchResponse: (
        machineId: string,
        args: import('@lody/shared/e2ee-rpc').E2eeDispatchInput,
        frame: string
      ) => {
        if (!input.runtime.acceptDispatchResponse)
          return Promise.reject(new Error('e2ee_rpc_unavailable'));
        return withinContent(() =>
          input.runtime.acceptDispatchResponse!(input.workspaceId, machineId, args, frame)
        );
      },
      codeCollabRole: {
        get: codeCollabRole,
        subscribe: (listener: () => void) => {
          roleListeners.add(listener);
          return () => {
            roleListeners.delete(listener);
          };
        },
      },
      bucketId: () => bucketId,
      createTokenProvider: (signal: AbortSignal) => makeTokenProvider(signal),
      createRpcTokenProvider: (signal: AbortSignal) => makeTokenProvider(signal, true),
    },
  };
}

/** Existing desktop import; both platforms use the same content/epoch/token bridge. */
export const createDesktopE2eeContent = createE2eeContent;
