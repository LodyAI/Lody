import { z } from 'zod/v4';

const ShareManagementTarget = {
  workspaceId: z.string().min(1),
  shareId: z.string().min(1),
  rootSessionId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative().optional(),
};

export const ShareRequestParams = z
  .discriminatedUnion('operation', [
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('api'),
      args: z.discriminatedUnion('method', [
        z.object({
          method: z.literal('getManagement'),
          args: z.object({
            workspaceId: z.string().min(1),
            rootSessionId: z.string().min(1),
          }),
        }),
        z.object({
          method: z.literal('beginDeployment'),
          args: z.object({
            workspaceId: z.string().min(1),
            rootSessionId: z.string().min(1),
            shareId: z.string().min(1).optional(),
            expectedRevision: z.number().int().nonnegative().optional(),
            credentialHash: z.string().min(1).optional(),
            uploadCredentialHash: z.string().min(1),
            requestId: z.string().min(1),
            manifest: z.unknown(),
            sourceIds: z.array(
              z.object({
                sourceId: z.string().min(1),
                conversationId: z.string().min(1),
              }),
            ),
          }),
        }),
        z.object({
          method: z.literal('publishDeployment'),
          args: z.object({ deploymentId: z.string().min(1) }),
        }),
        z.object({
          method: z.literal('resetCredential'),
          args: z.object({
            shareId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            credentialHash: z.string().min(1),
          }),
        }),
        z.object({
          method: z.literal('revoke'),
          args: z.object({
            shareId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
          }),
        }),
      ]),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('saveSecret'),
      args: z.object({
        shareId: z.string().min(1),
        version: z.number().int().positive(),
        secret: z.string().min(1),
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('readSecret'),
      args: z.object({
        shareId: z.string().min(1),
        version: z.number().int().positive(),
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('image'),
      args: z.object({
        sessionId: z.string().min(1),
        imageId: z.string().min(1),
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('previewToken'),
      args: z.object({
        intent: z.object({
          workspaceId: z.string().min(1),
          machineId: z.string().min(1),
          sessionId: z.string().min(1),
          runtimeNonce: z.string(),
          requestId: z.string().min(1),
          operation: z.record(z.string(), z.unknown()),
        }),
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('management'),
      args: z.discriminatedUnion('action', [
        z.object({
          workspaceId: z.string().min(1),
          action: z.literal('list'),
          cursor: z.string().nullable(),
        }),
        z.object({ ...ShareManagementTarget, action: z.literal('detail') }),
        z.object({ ...ShareManagementTarget, action: z.literal('copy') }),
        z.object({ ...ShareManagementTarget, action: z.literal('open') }),
        z.object({ ...ShareManagementTarget, action: z.literal('revoke') }),
      ]),
    }),
  ])
  .meta({ id: 'ShareRequestParams' });
export type ShareRequestParams = z.input<typeof ShareRequestParams>;

export const ShareRequestResult = z
  .object({ value: z.unknown() })
  .meta({ id: 'ShareRequestResult' });

export const ShareProgressEvent = z
  .object({
    editorId: z.string().min(1),
    phase: z.enum(['capturing', 'uploading', 'publishing']),
    percent: z.number().int().min(0).max(100).optional(),
  })
  .meta({ id: 'ShareProgressEvent' });

export const PublishedSharesParams = z
  .discriminatedUnion('action', [
    z.object({
      workspaceId: z.string().min(1),
      userId: z.string(),
      action: z.literal('list'),
      cursor: z.string().optional(),
    }),
    z.object({
      ...ShareManagementTarget,
      userId: z.string(),
      action: z.literal('detail'),
    }),
    z.object({
      ...ShareManagementTarget,
      userId: z.string(),
      action: z.literal('copy'),
    }),
    z.object({
      ...ShareManagementTarget,
      userId: z.string(),
      action: z.literal('open'),
    }),
    z.object({
      ...ShareManagementTarget,
      userId: z.string(),
      action: z.literal('revoke'),
    }),
  ])
  .meta({ id: 'PublishedSharesParams' });

const shareCount = z.number().int().nonnegative();

export const PublishedSharesResult = z
  .discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('page'),
      workspaceId: z.string().min(1),
      userId: z.string().min(1),
      page: z.array(
        z.object({
          shareId: z.string().min(1),
          rootSessionId: z.string().min(1),
          publisherUserId: z.string().min(1),
          status: z.enum(['active', 'revoked']),
          title: z.string(),
          revision: shareCount,
          credentialVersion: shareCount,
          createdAt: shareCount,
          updatedAt: shareCount,
          totalBytes: shareCount.optional(),
          conversationCount: shareCount.optional(),
          canManage: z.boolean(),
          canRevoke: z.boolean(),
          hasLocalLink: z.boolean(),
        }),
      ),
      isDone: z.boolean(),
      continueCursor: z.string(),
    }),
    z.object({ outcome: z.literal('failed'), error: z.string().min(1) }),
  ])
  .meta({ id: 'PublishedSharesResult' });

export const SessionSharingParams = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    editorId: z.string().min(1),
    action: z.enum(['read', 'publish', 'reset', 'revoke', 'discard', 'close']),
    selected: z.array(z.string().min(1)).optional(),
    omissionText: z.string().optional(),
  })
  .meta({ id: 'SessionSharingParams' });

export const ShareEntry = z
  .object({
    shareId: z.string().min(1),
    rootSessionId: z.string().min(1),
    publisherUserId: z.string().min(1),
    status: z.enum(['draft', 'active', 'revoked']),
    revision: shareCount,
    credentialVersion: shareCount,
    currentDeploymentId: z.string().min(1).optional(),
    sourceIds: z
      .array(
        z.object({
          sourceId: z.string().min(1),
          conversationId: z.string().min(1),
        }),
      )
      .optional(),
    selectedSourceIds: z.array(z.string().min(1)).optional(),
    canManage: z.boolean().optional(),
    canRevoke: z.boolean().optional(),
  })
  .meta({ id: 'ShareEntry' });

export const SessionSharingResult = z
  .discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('closed') }),
    z.object({
      outcome: z.literal('state'),
      entry: ShareEntry.nullable(),
      url: z.string().min(1).nullable(),
      candidates: z.array(
        z.object({ id: z.string().min(1), title: z.string() }),
      ),
      selected: z.array(z.string().min(1)),
      pending: z.boolean(),
    }),
  ])
  .meta({ id: 'SessionSharingResult' });
