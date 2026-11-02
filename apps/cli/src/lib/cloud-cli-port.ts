import { sharingReplySchemas } from '@lody/e2ee-machine-sharing/schemas';
import { StreamsClient } from '@loro-dev/streams-client';
import { CloudE2eeMemberRemoved, CloudE2eeDeviceRevoked } from './cloud-e2ee-errors';
import { Effect } from 'effect';
import { SessionAttachmentTransfer } from './session-attachment-transfer';
import { getCliPlatformKind } from './cli-platform';
import { LODY_SERVER_URL } from '@/utils/const';
import { SimulatorIceServersSchema } from '@/ios-simulator/webrtc-protocol';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@lody/cloud-api';
import { e2eeHistoryPageSchema, e2eeMailboxReplySchemas } from './cloud-e2ee-replies';
import { ShareDeliveryEnvelopeSchema } from '@lody/shared/session-share-delivery';
import {
  buildLoroStreamsTokenEndpoint,
  getLoroStreamIdForDocId,
  getLoroStreamsBaseUrl,
  type WorkspaceId,
  PreviewControlVerificationSchema,
  createLoroStreamsTokenProviderLegacy,
  describeLoroStreamsTokenCause,
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  LoroStreamsTokenPorts,
  deriveConvexSiteUrl,
  normalizeBaseUrl,
} from '@lody/shared';
import {
  resolveRuntimeArtifactsBaseUrl,
  createLocalCloudPort,
  type CloudE2eePort,
  type CloudAccessSnapshot,
  type CloudBillingPort,
  type CloudPort,
  type CloudSessionSharingPort,
  type CloudStreamsTokenPort,
  type CloudUsageUpdateInput,
  type WorkspaceSummary,
} from '@lody/platform';
import type { SessionUsageUpdate } from 'acp-extension-core';
import type { Logger } from '@/utils/logger';
import { getCliHttpFetch } from '@/utils/http-transport';
import {
  canUseMachineForCliToken,
  getWorkspaceBillingEntitlementForCliToken,
  parseMachineWorkspaceEntitlement,
  registerMachineAccessForCliToken,
} from './workspace';
import { NotificationService } from './notifications';
import { UsageTrackingService, type RecordSessionUsageInput } from './usage/usage-tracking-service';
import { GitHubTokenManager, createSharedGitHubTokenManagers } from './github-token-manager';
import { makeStreamsTokenShares } from './loro/streams-token-shares';
import { submitBugReportFromMachine } from './bug-report';
import { createCloudPrAssociationPort } from './cloud-pr-association';

type WorkspaceListResult =
  | { valid: false; userId: null; workspaces: WorkspaceSummary[] }
  | { valid: true; userId: string; workspaces: WorkspaceSummary[] };

export interface CloudCliPortOptions {
  identity: CloudPort['identity'];
  token: string;
  authBaseUrl: string;
  authSiteUrl?: string;
  serverBaseUrl: string;
  /** Optional operator mirror; the public artifact channel is the default. */
  runtimeArtifactsBaseUrl?: string;
  logger: Logger;
}

export function createCloudSessionSharingPort(options: {
  token: string;
  authBaseUrl: string;
}): CloudSessionSharingPort {
  const client = new ConvexHttpClient(normalizeBaseUrl(options.authBaseUrl));
  const result = z
    .object({
      requestId: z.string().min(1),
      shareRequestId: z.string().min(1),
      status: z.enum(['pending', 'confirmed', 'cancelled', 'expired', 'published']),
      shareId: z.string().optional(),
      delivery: ShareDeliveryEnvelopeSchema.optional(),
    })
    .strict();
  return {
    getResult: async (input) =>
      result.parse(
        await client.query(api.sessionSharing.getRequestResultFromCli, {
          ...input,
          cliToken: options.token,
        })
      ),
    request: async (input) =>
      result.parse(
        await client.mutation(api.sessionSharing.requestFromCli, {
          ...input,
          cliToken: options.token,
        })
      ),
  };
}

export function createCloudBillingPort(options: { token: string }): CloudBillingPort {
  return {
    getWorkspaceEntitlement: async (workspaceId) =>
      await getWorkspaceBillingEntitlementForCliToken({
        token: options.token,
        workspaceId,
      }),
  };
}

export function createCloudStreamsTokenPort(options: {
  token: string;
  authBaseUrl: string;
  authSiteUrl?: string;
  logger: Logger;
}): CloudStreamsTokenPort & { closeLegacy(): Promise<void> } {
  const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
  const authSiteUrl = normalizeBaseUrl(
    options.authSiteUrl?.trim() || deriveConvexSiteUrl(authBaseUrl)
  );
  const fetchImpl = getCliHttpFetch({ logger: options.logger });
  let retiring = false;
  const legacyOwners = new Map<ReturnType<typeof createLoroStreamsTokenProviderLegacy>, boolean>();
  // Durable sync, presence and Machine RPC of one workspace borrow one kernel.
  const shares = makeStreamsTokenShares(
    (workspaceId) =>
      makeLoroStreamsTokenProvider({
        endpoint: buildLoroStreamsTokenEndpoint(authSiteUrl),
        workspaceId,
      }).pipe(
        Effect.provideService(
          LoroStreamsTokenPorts,
          makeLoroStreamsTokenWebPorts({
            credential: Effect.succeed(options.token),
            fetchImpl,
          })
        )
      ),
    {
      onCleanupReported: (cause) =>
        options.logger.debug(
          `[streams-token] Recovered ended release failure ${JSON.stringify(describeLoroStreamsTokenCause(cause))}`
        ),
    }
  );
  return {
    createTokenProvider: ({ workspaceId }) =>
      Effect.suspend(() => {
        if (retiring) return Effect.die(new Error('Streams token port closed'));
        return shares.acquire(workspaceId);
      }),
    createTokenProviderLegacy: ({ workspaceId }) => {
      if (retiring) throw new Error('Streams token port closed');
      // Legacy entry: borrowing is synchronous, and its view closes with the facade.
      const provider = createLoroStreamsTokenProviderLegacy({
        provider: Effect.runSync(shares.borrow(workspaceId)),
        executor: Effect,
      });
      legacyOwners.set(provider, false);
      return provider;
    },
    closeLegacy: async () => {
      retiring = true;
      const results = await Promise.allSettled(
        [...legacyOwners].map(async ([provider, failed]) => {
          if (failed) await provider.retryCleanup();
          try {
            await provider.close();
            legacyOwners.delete(provider);
          } catch (error) {
            legacyOwners.set(provider, true);
            throw error;
          }
        })
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Streams token provider cleanup failed');
    },
  };
}

/** Device routes are lazy: constructing the ordinary cloud port never opens
 * custody, obtains a device token, or touches the operating system keyring. */
export function createCloudE2eePort(
  options: Pick<CloudCliPortOptions, 'authBaseUrl' | 'logger'> & { token?: string }
): CloudE2eePort {
  const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
  const fetchImpl = getCliHttpFetch({ logger: options.logger });
  const client = (signal: AbortSignal) =>
    new ConvexHttpClient(authBaseUrl, {
      logger: false,
      fetch: (input, init) => fetchImpl(input, { ...init, signal }),
    });
  const tokenSchema = z.object({
    token: z.string().min(1),
    attachmentToken: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    bucketId: z.string().min(1),
    gatewayBaseUrl: z.string().url(),
    expiresIn: z.number().int().positive().max(900),
    expiresAt: z.number().int().positive(),
  });
  const getContentToken = async (
    input: Parameters<CloudE2eePort['getContentToken']>[0],
    signal: AbortSignal
  ) => {
    try {
      return tokenSchema.parse(
        await client(signal).action(api.e2eeContent.contentStreamsToken, {
          ...input,
          ...(options.token === undefined ? {} : { cliToken: options.token }),
        })
      );
    } catch (cause) {
      const rejected = z.object({ data: z.object({ code: z.string() }) }).safeParse(cause);
      if (rejected.success && rejected.data.data.code === 'e2ee_member_removed')
        throw new CloudE2eeMemberRemoved();
      if (rejected.success && rejected.data.data.code === 'e2ee_device_revoked')
        throw new CloudE2eeDeviceRevoked();
      throw cause;
    }
  };
  return {
    machineSharing: {
      readHead: async (input) =>
        sharingReplySchemas.readHead.parse(
          await client(AbortSignal.timeout(30_000)).action(api.e2eeMachineSharing.readHead, {
            ...input,
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          })
        ),
      readVersion: async (input) =>
        sharingReplySchemas.readVersion.parse(
          await client(AbortSignal.timeout(30_000)).action(api.e2eeMachineSharing.readVersion, {
            ...input,
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          })
        ),
      readRequest: async (input) =>
        sharingReplySchemas.readRequest.parse(
          await client(AbortSignal.timeout(30_000)).action(api.e2eeMachineSharing.readRequest, {
            ...input,
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          })
        ),
      commit: async (input) =>
        sharingReplySchemas.commit.parse(
          await client(AbortSignal.timeout(30_000)).action(api.e2eeMachineSharing.commit, {
            ...input,
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          })
        ),
    },
    ...(options.token === undefined
      ? {
          completeMachinePairing: async (input: {
            workspaceId: string;
            credential: string;
            pairingSessionId: string;
          }) => {
            await client(AbortSignal.timeout(30_000)).mutation(
              api.e2eeMachinePairing.complete,
              input
            );
          },
        }
      : {}),
    readExecutionOriginPage: async (input, signal) => {
      const token = await getContentToken(
        { workspaceId: input.workspaceId, credential: input.credential },
        signal
      );
      const streamId = getLoroStreamIdForDocId(input.workspaceId as WorkspaceId, input.docId);
      const streams = new StreamsClient({
        url: `${getLoroStreamsBaseUrl(token.gatewayBaseUrl)}/ds/${encodeURIComponent(token.bucketId)}/${encodeURIComponent(streamId)}`,
        fetch: fetchImpl,
        auth: token.token,
      });
      const result = await streams.readBackwardMessages({
        before: input.before,
        pageBytes: 256 * 1024,
        maxMessageBytes: 64 * 1024 * 1024,
        signal,
      });
      if (!result.ok) throw result.result;
      return {
        messages: result.result.messages,
        before: result.result.startOffset,
        atStart: result.result.atRetainedStart,
      };
    },
    getHistory: async (input) =>
      e2eeHistoryPageSchema.parse(
        await client(AbortSignal.timeout(30_000)).action(api.e2eeWorkspaces.history, {
          ...input,
          ...(options.token === undefined ? {} : { cliToken: options.token }),
        })
      ),
    getContentToken: (input) => getContentToken(input, AbortSignal.timeout(30_000)),
    readEpochGroup: (input) =>
      client(AbortSignal.timeout(30_000)).query(api.e2eeEpochStaging.readGroup, {
        workspaceId: input.workspaceId,
        credential: input.credential,
        // Native discovery also retains the publication signer. The wire key
        // has exactly four fields; the receiver authenticates the originals.
        key: {
          genesis: input.key.genesis,
          epoch: input.key.epoch,
          commitment: input.key.commitment,
          recordHash: input.key.recordHash,
        },
        ...(options.token === undefined ? {} : { cliToken: options.token }),
      }),
    mailboxCall: async (method, input) => {
      const connection = client(AbortSignal.timeout(30_000));
      const common = z.object({ workspaceId: z.string(), credential: z.string() });
      const slot = z.object({
        genesis: z.string(),
        epoch: z.number().int().nonnegative(),
        recipient: z.string(),
      });
      let reply: unknown;
      switch (method) {
        case 'put':
          reply = await connection.mutation(api.e2eeMailbox.put, {
            ...common.extend({ id: z.string(), frameHex: z.string() }).parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        case 'report':
          reply = await connection.mutation(api.e2eeMailbox.report, {
            ...common
              .extend({ reportHex: z.string(), publicationHex: z.string().optional() })
              .parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        case 'repair':
          reply = await connection.mutation(api.e2eeMailbox.repair, {
            ...common
              .extend({ slot, id: z.string(), rejectedDigest: z.string().optional() })
              .parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        case 'read':
          reply = await connection.query(api.e2eeMailbox.read, {
            ...common.extend({ id: z.string() }).parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        case 'fetch':
          reply = await connection.query(api.e2eeMailbox.fetch, {
            ...common
              .extend({
                epoch: z.number().int().nonnegative(),
                cursor: z.string().nullable(),
                limit: z.number().int().min(1).max(100),
              })
              .parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        case 'status':
          reply = await connection.query(api.e2eeMailbox.status, {
            ...common.extend({ slot }).parse(input),
            ...(options.token === undefined ? {} : { cliToken: options.token }),
          });
          break;
        default:
          throw new Error('e2ee_unknown_method');
      }
      return e2eeMailboxReplySchemas[method].parse(reply);
    },
    createContentTokenProvider: (input) =>
      Effect.gen(function* () {
        let bucketId: string | undefined;
        const ports = makeLoroStreamsTokenWebPorts({
          credential: Effect.succeed(input.credential),
          fetchImpl: async (_endpoint, init) => {
            const request = z
              .object({ workspaceId: z.string(), rejectedToken: z.string().optional() })
              .strict()
              .parse(JSON.parse(String(init?.body)));
            if (request.workspaceId !== input.workspaceId)
              throw new Error('e2ee_content_context_mismatch');
            const token = await getContentToken(
              { ...input, rejectedToken: request.rejectedToken },
              init?.signal ?? AbortSignal.timeout(30_000)
            );
            bucketId = token.bucketId;
            return Response.json(token);
          },
        });
        const provider = yield* makeLoroStreamsTokenProvider({
          endpoint: authBaseUrl,
          workspaceId: input.workspaceId,
        }).pipe(Effect.provideService(LoroStreamsTokenPorts, ports));
        return { ...provider, getBucketId: () => bucketId };
      }),
  };
}

/** Official-build assembly point. No cloud client may be constructed by Fleet. */
export function createCloudCliPort(options: CloudCliPortOptions): CloudPort {
  const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
  const authSiteUrl = normalizeBaseUrl(
    options.authSiteUrl?.trim() || deriveConvexSiteUrl(authBaseUrl)
  );
  const serverBaseUrl = normalizeBaseUrl(options.serverBaseUrl);
  const subscriptionClient = new ConvexClient(authBaseUrl);
  const notificationService = new NotificationService({
    convexUrl: authBaseUrl,
    cliToken: options.token,
    logger: options.logger,
  });
  const usageService = new UsageTrackingService({
    convexUrl: authBaseUrl,
    cliToken: options.token,
    logger: options.logger,
  });
  const githubTokenManagers = createSharedGitHubTokenManagers(
    (workspaceId) =>
      new GitHubTokenManager({
        serverUrl: authBaseUrl,
        cliToken: options.token,
        workspaceId,
        logger: options.logger,
      })
  );
  const streamsTokens = createCloudStreamsTokenPort({
    token: options.token,
    authBaseUrl,
    authSiteUrl: options.authSiteUrl,
    logger: options.logger,
  });
  const billing = createCloudBillingPort({ token: options.token });

  return {
    kind: 'cloud',
    e2ee: createCloudE2eePort(options),
    sessionSharing: createCloudSessionSharingPort(options),
    identity: options.identity,
    access: {
      watchWorkspaceAccess: (listener, onError) =>
        subscriptionClient.onUpdate(
          api.deviceAuth.listMyWorkspacesForCliToken,
          { token: options.token, includeEncrypted: true },
          (result: WorkspaceListResult) => {
            const snapshot: CloudAccessSnapshot = result.valid
              ? {
                  status: 'authorized',
                  userId: result.userId,
                  workspaces: result.workspaces,
                }
              : { status: 'unauthorized', reason: 'CLI token is invalid or expired.' };
            listener(snapshot);
          },
          onError
        ),
      verifyMachineAccess: async (request) => {
        if (!request.machineId) {
          throw new Error('Cloud machine access verification requires machineId');
        }
        return await canUseMachineForCliToken({
          token: options.token,
          workspaceId: request.workspaceId,
          machineId: request.machineId,
          requesterUserId: request.requesterUserId,
          localProjectId: request.localProjectId,
        });
      },
      registerMachineAccess: async (request) => {
        await registerMachineAccessForCliToken({
          token: options.token,
          workspaceId: request.workspaceId,
          machineId: request.machineId,
        });
      },
      resolveWorkspaceUser: async (request) =>
        await subscriptionClient.query(api.auth.getWorkspaceUserProfileForCliToken, {
          cliToken: options.token,
          workspaceId: request.workspaceId,
          userId: request.userId,
        }),
    },
    streamsTokens,
    notifications: {
      notifySessionCompleted: async (input) =>
        await notificationService.notifySessionCompleted(
          input as Parameters<NotificationService['notifySessionCompleted']>[0]
        ),
      notifyPermissionRequested: async (input) =>
        await notificationService.notifyPermissionRequested(
          input as Parameters<NotificationService['notifyPermissionRequested']>[0]
        ),
      recordPermissionRequested: async (input) =>
        await notificationService.recordPermissionRequested(
          input as Parameters<NotificationService['recordPermissionRequested']>[0]
        ),
      resolvePermissionRequested: async (input) =>
        await notificationService.resolvePermissionRequested(
          input as Parameters<NotificationService['resolvePermissionRequested']>[0]
        ),
      syncLiveActivitySummary: async (input) =>
        await notificationService.syncLiveActivitySummary(
          input as Parameters<NotificationService['syncLiveActivitySummary']>[0]
        ),
    },
    usage: {
      recordSessionUsageUpdate: (input: CloudUsageUpdateInput) =>
        usageService.recordSessionUsageUpdate({
          ...input,
          cliType: input.cliType as RecordSessionUsageInput['cliType'],
          update: input.update as SessionUsageUpdate,
        }),
      flushSessionUsage: async (sessionId) => await usageService.flushSessionUsage(sessionId),
    },
    billing,
    githubTokens: {
      createTokenManager: (workspaceId) => githubTokenManagers.acquire(workspaceId),
    },
    bugReports: {
      submit: async (report) =>
        await submitBugReportFromMachine({
          ...report,
          token: options.token,
          siteUrl: authSiteUrl,
          logger: options.logger,
          checkMachineAccess: async (request) =>
            await canUseMachineForCliToken({
              token: options.token,
              workspaceId: request.workspaceId,
              machineId: request.machineId,
              requesterUserId: request.requesterUserId,
            }),
        }),
    },
    prAssociation: createCloudPrAssociationPort({
      token: options.token,
      authSiteUrl,
      logger: options.logger,
    }),
    attachmentUpload: { serverBaseUrl },
    remoteAutomation: {
      verifyControl: async (input) => {
        const response = await getCliHttpFetch({ logger: options.logger })(
          new URL('/api/session-automation/verify', authSiteUrl),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.token}`,
            },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!response.ok) throw new Error(`Automation authorization failed (${response.status}).`);
        return PreviewControlVerificationSchema.parse(await response.json());
      },
    },
    remotePreview: {
      simulatorIceServers: async (input) => {
        const response = await getCliHttpFetch({ logger: options.logger })(
          new URL('/api/ios-simulator/ice-servers', authSiteUrl),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.token}`,
            },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          }
        );
        if (!response.ok) throw new Error('Simulator relay configuration is unavailable.');
        return z
          .object({ iceServers: SimulatorIceServersSchema, expiresAt: z.number().finite() })
          .parse(await response.json());
      },
      verifyControl: async (input) => {
        const response = await getCliHttpFetch({ logger: options.logger })(
          new URL('/api/session-preview/verify', authSiteUrl),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.token}`,
            },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!response.ok) throw new Error(`Preview authorization failed (${response.status}).`);
        return PreviewControlVerificationSchema.parse(await response.json());
      },
    },
    runtimeArtifacts: {
      baseUrl: resolveRuntimeArtifactsBaseUrl(options.runtimeArtifactsBaseUrl),
    },
    dispose: async () => {
      await githubTokenManagers.shutdownAll();
      await streamsTokens.closeLegacy();
      await subscriptionClient.close();
    },
  };
}

/** One-shot command composition; local builds never construct a cloud transfer. */
export function createCommandAttachmentTransfer(
  token: string,
  localWorkspace = false,
  encrypted?: { token(): Promise<string> }
): SessionAttachmentTransfer | undefined {
  if (localWorkspace || getCliPlatformKind() === 'local') return undefined;
  if (!LODY_SERVER_URL?.trim()) throw new Error('cloud_attachment_upload_unavailable');
  return new SessionAttachmentTransfer(token, LODY_SERVER_URL, encrypted);
}

/** A cloud machine authenticated only to one admitted encrypted workspace. No account APIs. */
/** Bounds the cooperative quota's plan read; a slower answer is treated as unavailable. */
const MACHINE_ENTITLEMENT_TIMEOUT_MS = 10_000;

export function createCloudE2eeMachinePort(options: {
  accountId: string;
  workspaceId: string;
  genesisHash: string;
  machineId: string;
  credential: string;
  authBaseUrl: string;
  serverBaseUrl: string;
  logger: Logger;
  client?: Pick<ConvexClient, 'onUpdate' | 'query' | 'close'>;
}): CloudPort {
  if (getCliPlatformKind() !== 'cloud') throw new Error('e2ee_unavailable');
  const serverBaseUrl = options.serverBaseUrl.trim();
  if (!serverBaseUrl) throw new Error('cloud_attachment_upload_unavailable');
  const base = createLocalCloudPort({ identity: { userId: options.accountId }, workspaces: [] });
  const client = options.client ?? new ConvexClient(options.authBaseUrl, { logger: false });
  const access = {
    workspaceId: options.workspaceId,
    credential: options.credential,
    machineId: options.machineId,
  };
  const snapshot = z.union([
    z.object({ status: z.literal('unauthorized'), reason: z.string() }),
    z.object({
      status: z.literal('authorized'),
      userId: z.literal(options.accountId),
      workspaces: z
        .array(
          z.object({
            id: z.literal(options.workspaceId),
            name: z.string(),
            slug: z.string().nullable(),
            role: z.string(),
            contentMode: z.literal('e2ee'),
            genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
          })
        )
        .length(1),
    }),
  ]);
  const e2ee = createCloudE2eePort({ authBaseUrl: options.authBaseUrl, logger: options.logger });
  const machineSharing = e2ee.machineSharing;
  const readEpochGroup = e2ee.readEpochGroup;
  const readExecutionOriginPage = e2ee.readExecutionOriginPage;
  const completeMachinePairing = e2ee.completeMachinePairing;
  const bound = (value: { workspaceId: string; credential: string }) => {
    if (value.workspaceId !== options.workspaceId || value.credential !== options.credential)
      throw new Error('e2ee_binding_conflict');
  };
  return {
    ...base,
    kind: 'cloud',
    e2eeMachineScope: { workspaceId: options.workspaceId, genesisHash: options.genesisHash },
    attachmentUpload: { serverBaseUrl },
    // Cooperative session/turn quotas select this workspace's plan with the machine's
    // own device credential; the account API key path is never used here.
    billing: {
      getWorkspaceEntitlement: async (workspaceId) => {
        if (workspaceId !== options.workspaceId) throw new Error('e2ee_binding_conflict');
        // `query()` waits for a reconnect without bound while disconnected, which would
        // keep the cooperative quota from ever failing open. Subscribe once with a
        // deadline and release only this read's subscription, never the shared client.
        const value = await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          let unsubscribe: (() => void) | undefined;
          const finish = (settle: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            settle();
          };
          const timer = setTimeout(
            () => finish(() => reject(new Error('e2ee_billing_entitlement_timeout'))),
            MACHINE_ENTITLEMENT_TIMEOUT_MS
          );
          unsubscribe = client.onUpdate(
            api.e2eeMachinePairing.workspaceEntitlement,
            access,
            (result) => finish(() => resolve(result)),
            (error) => finish(() => reject(error))
          );
          // A synchronous answer settles before the handle exists; release it now.
          if (settled) unsubscribe();
        });
        return parseMachineWorkspaceEntitlement(value);
      },
    },
    e2ee: {
      ...e2ee,
      ...(machineSharing
        ? {
            machineSharing: {
              readHead: (input) => {
                bound(input);
                return machineSharing.readHead(input);
              },
              readVersion: (input) => {
                bound(input);
                return machineSharing.readVersion(input);
              },
              readRequest: (input) => {
                bound(input);
                return machineSharing.readRequest(input);
              },
              commit: (input) => {
                bound(input);
                return machineSharing.commit(input);
              },
            },
          }
        : {}),
      ...(readExecutionOriginPage
        ? {
            readExecutionOriginPage: (input, signal) => {
              bound(input);
              return readExecutionOriginPage(input, signal);
            },
          }
        : {}),
      getHistory: (input) => {
        bound(input);
        return e2ee.getHistory(input);
      },
      getContentToken: (input) => {
        bound(input);
        return e2ee.getContentToken(input);
      },
      ...(readEpochGroup
        ? {
            readEpochGroup: (input) => {
              bound(input);
              return readEpochGroup(input);
            },
          }
        : {}),
      ...(completeMachinePairing
        ? {
            completeMachinePairing: async (input) => {
              bound(input);
              await completeMachinePairing(input);
            },
          }
        : {}),
      mailboxCall: (method, input) => {
        bound(input);
        return e2ee.mailboxCall(method, input);
      },
    },
    access: {
      watchWorkspaceAccess: (listener, onError) =>
        client.onUpdate(
          api.e2eeMachinePairing.bootstrap,
          access,
          (value) => {
            const parsed = snapshot.safeParse(value);
            if (parsed.success) listener(parsed.data);
            else onError(new Error('e2ee_machine_service_invalid_response'));
          },
          () => onError(new Error('e2ee_machine_service_unavailable_retry'))
        ),
      verifyMachineAccess: async () => ({ allowed: false, reason: 'not_visible' }),
      registerMachineAccess: async (input) => {
        if (input.workspaceId !== options.workspaceId || input.machineId !== options.machineId)
          throw new Error('e2ee_binding_conflict');
        const value = snapshot.parse(await client.query(api.e2eeMachinePairing.bootstrap, access));
        if (value.status !== 'authorized')
          throw new Error('e2ee_machine_service_revoked_pair_again');
      },
      resolveWorkspaceUser: async () => null,
    },
    dispose: () => client.close(),
  };
}

/** Fixed pairing ingress only; command pins are validated before constructing this adapter. */
export function createCloudRemoteMachinePairingClaim(options: {
  ingressUrl: string;
  logger: Logger;
}) {
  if (getCliPlatformKind() !== 'cloud') throw new Error('e2ee_unavailable');
  const endpoint = new URL('/api/e2ee/machine-pairing/claim', options.ingressUrl);
  const transport = getCliHttpFetch({ logger: options.logger });
  return async (originalBody: string, signal: AbortSignal): Promise<unknown> => {
    const response = await transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: originalBody,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error('e2ee_pairing_unavailable_retry_same_command');
    return response.json();
  };
}
