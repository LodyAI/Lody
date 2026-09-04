import { ConvexClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import {
  buildLoroStreamsTokenEndpoint,
  createLoroStreamsTokenProvider,
  deriveConvexSiteUrl,
  normalizeBaseUrl,
} from '@lody/shared';
import {
  resolveRuntimeArtifactsBaseUrl,
  type CloudAccessSnapshot,
  type CloudBillingPort,
  type CloudPort,
  type CloudPrAssociationInput,
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
  registerMachineAccessForCliToken,
} from './workspace';
import { NotificationService } from './notifications';
import { UsageTrackingService, type RecordSessionUsageInput } from './usage/usage-tracking-service';
import { GitHubTokenManager } from './github-token-manager';
import { submitBugReportFromMachine } from './bug-report';
import { verifyPreviewRequestWithCloud } from './preview-authorization';

type WorkspaceListResult =
  | { valid: false; userId: null; workspaces: WorkspaceSummary[] }
  | { valid: true; userId: string; workspaces: WorkspaceSummary[] };

export interface CloudCliPortOptions {
  identity: CloudPort['identity'];
  token: string;
  authBaseUrl: string;
  authSiteUrl?: string;
  serverBaseUrl: string;
  previewGatewayUrl?: string;
  /** Optional operator mirror; the public artifact channel is the default. */
  runtimeArtifactsBaseUrl?: string;
  logger: Logger;
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
}): CloudStreamsTokenPort {
  const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
  const authSiteUrl = normalizeBaseUrl(
    options.authSiteUrl?.trim() || deriveConvexSiteUrl(authBaseUrl)
  );
  const fetchImpl = getCliHttpFetch({ logger: options.logger });
  return {
    createTokenProvider: ({ workspaceId }) =>
      createLoroStreamsTokenProvider({
        endpoint: buildLoroStreamsTokenEndpoint(authSiteUrl),
        workspaceId,
        authToken: () => options.token,
        fetchImpl,
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
  const tokenManagers = new Set<GitHubTokenManager>();
  const streamsTokens = createCloudStreamsTokenPort({
    token: options.token,
    authBaseUrl,
    authSiteUrl: options.authSiteUrl,
    logger: options.logger,
  });
  const billing = createCloudBillingPort({ token: options.token });
  const fetchImpl = getCliHttpFetch({ logger: options.logger });

  return {
    kind: 'cloud',
    identity: options.identity,
    access: {
      watchWorkspaceAccess: (listener, onError) =>
        subscriptionClient.onUpdate(
          api.deviceAuth.listMyWorkspacesForCliToken,
          { token: options.token },
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
      verifyPreviewRequest: async (request) =>
        await verifyPreviewRequestWithCloud({
          siteUrl: authSiteUrl,
          cliToken: options.token,
          request,
          fetchImpl,
        }),
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
      createTokenManager: (workspaceId) => {
        const manager = new GitHubTokenManager({
          serverUrl: authBaseUrl,
          cliToken: options.token,
          workspaceId,
          logger: options.logger,
        });
        tokenManagers.add(manager);
        return manager;
      },
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
    prAssociation: {
      associatePullRequest: async (input: CloudPrAssociationInput) => {
        const { ownerSessionId, ...association } = input;
        const response = await fetch(new URL('/api/action', authBaseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'github:associatePullRequestForCli',
            args: {
              ...association,
              sessionId: ownerSessionId,
              cliToken: options.token,
            },
          }),
        });
        return response.ok;
      },
    },
    attachmentUpload: { serverBaseUrl },
    remotePreview: {
      gatewayBaseUrl: normalizeBaseUrl(options.previewGatewayUrl?.trim() || serverBaseUrl),
    },
    runtimeArtifacts: {
      baseUrl: resolveRuntimeArtifactsBaseUrl(options.runtimeArtifactsBaseUrl),
    },
    dispose: async () => {
      await Promise.allSettled([...tokenManagers].map(async (manager) => await manager.shutdown()));
      tokenManagers.clear();
      await subscriptionClient.close();
    },
  };
}
