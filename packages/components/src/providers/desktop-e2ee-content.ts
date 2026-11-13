import { e2eeAccessLoss, type E2eeAccessLoss } from '../lib/e2ee-member-removal';
import { clientLossEffects } from '../lib/e2ee-client-loss-effects';
import { personalHostFailureCode } from '../lib/e2ee-control-failure';
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

/**
 * Settles with `work`, or rejects with the first abort reason. The caller abandons
 * an uncancellable host call; its late result or rejection is handled and dropped.
 */
function untilAborted<A>(
  work: Promise<A>,
  signals: ReadonlyArray<AbortSignal | null | undefined>
): Promise<A> {
  const owned = signals.filter((signal): signal is AbortSignal => signal != null);
  return new Promise<A>((resolve, reject) => {
    const detach = () => {
      for (const signal of owned) signal.removeEventListener('abort', onAbort);
    };
    function onAbort(this: AbortSignal) {
      detach();
      reject(this.reason);
    }
    const aborted = owned.find((signal) => signal.aborted);
    if (aborted) {
      work.catch(() => {});
      reject(aborted.reason);
      return;
    }
    for (const signal of owned) signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      }
    );
  });
}

/**
 * Upper bound on waiting for this device's key to an epoch its verified ledger already
 * holds (a rotation not received yet). One reception, then one retry of the open.
 */
export const KEY_PENDING_WAIT_MS = 30_000;
const keyPending = (error: unknown) =>
  // A portable host reports its typed failure; the desktop its exact IPC result.
  personalHostFailureCode(error) === 'key-pending' ||
  (error instanceof Error &&
    /^(?:Error invoking remote method 'e2ee[.:]openContent': Error: )?e2ee_key-pending$/.test(
      error.message
    ));

/** Shared purpose-bound providers. Keys and credentials stay inside the injected host runtime. */
export function createE2eeContent(input: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  genesisHash: string;
  epoch: number;
  authToken: () => string | null | undefined;
  rotationRequired?: boolean;
  /** `seal` marks an explicit exhausted/unavailable-grace failure with verified missing-current-key status. */
  onKeyUpdateRequired?: (source?: 'seal' | 'seal-complete') => void;
  /** Credential-authenticated member removal or revocation of this device. */
  onMemberRemoved?: (reason: E2eeAccessLoss) => void;
  onPhase?: (phase: WorkspaceEpochPhase) => void;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash)) throw new Error('e2ee_invalid_genesis');
  let bucketId: string | null = null;
  let statusEpoch = input.epoch;
  let currentKeyMissing = false;
  let lost: E2eeAccessLoss | null = null,
    closed = false;
  // Close and access loss abort a pending key wait; the room never outlives its owner.
  const stopped = new AbortController();
  const assertOpen = () => {
    if (closed || lost) throw new Error('e2ee_closed');
  };
  const withinContent = async <A>(work: () => Promise<A>): Promise<A> => {
    assertOpen();
    const value = await work();
    assertOpen();
    return value;
  };
  const observeRemoval = (error: unknown) => {
    const reason = e2eeAccessLoss(error);
    if (!reason) return false;
    if (!lost) {
      setMemberRole(null);
      lost = reason;
      stopped.abort(new Error('e2ee_closed'));
      try {
        input.onMemberRemoved?.(reason);
      } catch {
        /* Retirement never holds the token request. */
      }
    }
    return true;
  };
  // E2E-only: absent outside an automation window whose main registered the probe.
  const effects = clientLossEffects(input.workspaceId);
  // One shared reception for every open waiting on a not-yet-received key.
  let reception: Promise<void> | undefined;
  const receiveKey = () =>
    (reception ??= (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new Error('e2ee_key_pending_timeout')),
        KEY_PENDING_WAIT_MS
      );
      try {
        // Both hosts receive and install only this device's key; omitted options would
        // skip the key round on a portable host.
        await untilAborted(
          input.runtime.refresh(input.workspaceId, { installKeys: true, keyMode: 'receive' }),
          [stopped.signal, deadline.signal]
        );
      } catch (error) {
        if (observeRemoval(error) || stopped.signal.aborted || deadline.signal.aborted) throw error;
        // A failed round can still have installed the key (e.g. from a staged
        // group); the single retry below decides.
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      reception = undefined;
    }));
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
    !closed && !lost && memberRole && memberRole !== 'guest' ? 'write' : 'read';
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
    if (status.epoch >= statusEpoch) {
      statusEpoch = status.epoch;
      currentKeyMissing = status.hasCurrentKey === false;
    }
    setMemberRole(status.memberRole ?? null);
    transition.observe({ ...status, hasCurrentKey: status.hasCurrentKey ?? false });
    if (transition.needsUpdate()) input.onKeyUpdateRequired?.();
  };
  const content: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: encryptedWorkspaceNamespace(input.genesisHash),
    snapshotUpload: {
      // SDK schedules only after local writes, suppresses a competing writer
      // until maxBytesSinceRemoteSnapshot, and checks the remote snapshot before exporting a new one.
      canUpload: () => !closed && !lost && transition.phase() !== 'closed',
      debounceMs: 30_000,
      minBytesSinceRemoteSnapshot: 1024 * 1024,
      maxBytesSinceRemoteSnapshot: 4 * 1024 * 1024,
    },
    resolve: encryptedWorkspaceResolver(input.workspaceId, (room) =>
      transition.provider(
        (epoch) =>
          ({
            maxSealOverheadBytes: 4096,
            seal: async (request) => {
              if (lost) return Promise.reject(new Error(lost));
              const header = new Uint8Array([request.context.kind === 'snapshot' ? 4 : 3]);
              const additionalData = request.additionalData(header);
              const seal = () =>
                input.runtime.seal(input.workspaceId, {
                  epoch,
                  room,
                  context: request.context,
                  plaintext: request.plaintext,
                  additionalData,
                });
              try {
                const value = await (effects ? effects.track('write', seal) : seal());
                if (currentKeyMissing) {
                  try {
                    input.onKeyUpdateRequired?.('seal-complete');
                  } catch {
                    /* A notice cannot turn a completed save into a failure. */
                  }
                }
                return value;
              } catch (error) {
                if (
                  !closed &&
                  !lost &&
                  !e2eeAccessLoss(error) &&
                  ((error instanceof Error &&
                    /^(?:Error invoking remote method 'e2ee[.:]seal': Error: )?e2ee_key-update-required$/.test(
                      error.message
                    )) ||
                    (typeof error === 'object' &&
                      error !== null &&
                      'code' in error &&
                      error.code === 'key-update-required')) &&
                  currentKeyMissing &&
                  transition.needsUpdate()
                ) {
                  try {
                    input.onKeyUpdateRequired?.('seal');
                  } catch {
                    /* Observation must not replace the failed save or alter its retry. */
                  }
                }
                throw error;
              }
            },
            open: async (request) => {
              const open = () => input.runtime.openContent(input.workspaceId, { room, ...request });
              const read = () => (effects ? effects.track('read', open) : open());
              try {
                return await read();
              } catch (error) {
                // Only the host's verified missing-key answer waits; every other
                // failure, including access loss, keeps its terminal meaning.
                if (closed || lost || !keyPending(error)) throw error;
                await receiveKey();
                assertOpen();
                return read();
              }
            },
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
        // No native combined-signal API is needed (AbortSignal.any is optional).
        // The host call is an Electron IPC invoke with no cancellation channel and
        // can queue behind other account work longer than the token kernel's
        // release bound. On abort this adapter therefore settles at once and
        // abandons the host answer: no token, bucket or storage write leaves it.
        const assertActive = () => {
          assertOpen();
          signal.throwIfAborted();
          init?.signal?.throwIfAborted();
        };
        assertActive();
        const request = LoroStreamsTokenRequestSchema.parse(JSON.parse(String(init?.body)));
        if (request.workspaceId !== input.workspaceId)
          throw new Error('e2ee_content_configuration');
        const response = await untilAborted(
          (rpcOnly
            ? input.runtime.contentStreamsToken(
                input.workspaceId,
                request.rejectedToken,
                undefined,
                true
              )
            : input.runtime.contentStreamsToken(input.workspaceId, request.rejectedToken)
          ).catch((error) => {
            // Access loss stays observed even when this request was abandoned.
            observeRemoval(error);
            throw error;
          }),
          [signal, init?.signal]
        );
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
      stopped.abort(new Error('e2ee_closed'));
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
          if (lost || transition.phase() === 'closed') throw new Error('e2ee_closed');
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
      signScheduleDeclaration: (
        document: Pick<
          import('@lody/shared').ScheduleDocument,
          'definition' | 'prompt' | 'message'
        >,
        manualRunKey?: string
      ) => {
        if (!input.runtime.signScheduleDeclaration)
          return Promise.reject(new Error('e2ee_signature_unavailable'));
        return withinContent(() =>
          input.runtime.signScheduleDeclaration!(input.workspaceId, document, manualRunKey)
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
      ...(input.runtime.irohReady && input.runtime.irohCall
        ? {
            irohPath: (machineId: string) =>
              withinContent(
                () =>
                  input.runtime.irohPath?.(input.workspaceId, machineId) ??
                  Promise.resolve('none' as const)
              ),
            irohReady: (machineId: string) =>
              withinContent(() => input.runtime.irohReady!(input.workspaceId, machineId)),
            irohCall: (
              machineId: string,
              envelope: { id: string; frame: string },
              timeoutMs: number
            ) =>
              withinContent(() =>
                input.runtime.irohCall!(input.workspaceId, machineId, envelope, timeoutMs)
              ),
          }
        : {}),
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
