import type { NotificationPresentation } from '@lody/shared/notifications';
import type { TerminalOutcome } from '@lody/shared/notifications';
import {
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  type PermissionRequestKind,
  SessionId,
  type SessionPullRequestMeta,
  WorkspaceId,
} from '@lody/shared';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import { Logger } from '@/utils/logger';

export type TurnOutcomeNotificationInput = {
  sessionId: SessionId;
  occurrenceId: string;
  outcome?: TerminalOutcome;
  presentation?: NotificationPresentation;
  sessionTitle: string | null | undefined;
  pullRequests?: SessionPullRequestMeta[];
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  userId: string;
};

export type PermissionRequestNotificationInput = {
  sessionId: SessionId;
  sessionTitle: string | null | undefined;
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  userId: string;
  requestId: string;
  toolCallId: string;
  toolTitle: string | null | undefined;
  toolKind: string | null | undefined;
  requestKind?: PermissionRequestKind;
  presentation?: NotificationPresentation;
};

export type LiveActivitySummaryNotificationInput = {
  activityId: string;
  workspaceId: WorkspaceId;
  userId: string;
  totalCount: number;
  statusCounts: LiveActivityStatusCounts;
  items: LiveActivityConversationItem[];
  updatedAt: number;
  permissionAlert?: LiveActivityPermissionAlert;
};

export type LiveActivitySummarySyncResult =
  | { sent: true; ended: boolean }
  | { sent: false; reason?: string };

export type NotificationServiceConfig = {
  convexUrl: string;
  cliToken: string;
  logger: Logger;
};

export class NotificationService {
  private client: ConvexHttpClient;
  private cliToken: string;
  private logger: Logger;

  constructor(config: NotificationServiceConfig) {
    this.client = new ConvexHttpClient(config.convexUrl, {
      fetch: (input, init) =>
        globalThis.fetch(input, {
          ...init,
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(30_000),
          ]),
        }),
    });
    this.cliToken = config.cliToken;
    this.logger = config.logger;
  }

  get enabled(): boolean {
    return true;
  }

  // The deployed action name remains a transport boundary; this producer uses V1.
  async notifySessionCompleted(input: TurnOutcomeNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.notifySessionCompleted, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        occurrenceId: input.occurrenceId,
        outcome: input.outcome ?? 'succeeded',
        ...(input.presentation ? { presentation: input.presentation } : {}),
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to send turn outcome notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async notifyPermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.notifyPermissionRequested, {
        cliToken: this.cliToken,
        deliveryVersion: 1,
        ...(input.presentation ? { presentation: input.presentation } : {}),
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        requestKind: input.requestKind,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to send permission request notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async recordPermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.recordPermissionRequested, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        toolTitle: input.toolTitle ?? undefined,
        toolKind: input.toolKind ?? undefined,
        requestKind: input.requestKind,
        sessionTitle: input.sessionTitle ?? undefined,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to record permission request for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async resolvePermissionRequested(input: PermissionRequestNotificationInput): Promise<void> {
    try {
      await this.client.action(api.notifications.resolvePermissionRequested, {
        cliToken: this.cliToken,
        sessionId: input.sessionId,
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to resolve permission notification for ${input.sessionId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  async syncLiveActivitySummary(
    input: LiveActivitySummaryNotificationInput
  ): Promise<LiveActivitySummarySyncResult> {
    try {
      const response = await this.client.action(api.notifications.syncLiveActivitySummary, {
        cliToken: this.cliToken,
        workspaceId: input.workspaceId,
        userId: input.userId,
        activityId: input.activityId,
        totalCount: input.totalCount,
        statusCounts: input.statusCounts,
        items: input.items,
        updatedAt: input.updatedAt,
        ...(input.permissionAlert ? { permissionAlert: input.permissionAlert } : {}),
      });
      return response.sent
        ? { sent: true, ended: response.ended === true }
        : { sent: false, reason: response.reason };
    } catch (error) {
      this.logger.debug(
        `[notifications] Failed to sync live activity summary for ${input.activityId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return { sent: false, reason: 'request_failed' };
    }
  }
}
