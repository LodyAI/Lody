import { z } from 'zod/v4';

const sessionId = z.string().min(1);
export const DiffBase = z.enum(['turn', 'current']).meta({ id: 'DiffBase' });

export const TurnDiffParams = z
  .object({ sessionId, entryId: z.string().min(1), path: z.string() })
  .meta({ id: 'TurnDiffParams' });

export const FileDiffParams = z
  .object({ sessionId, path: z.string() })
  .meta({ id: 'FileDiffParams' });

export const WorkspaceChangesParams = z
  .object({ sessionId })
  .meta({ id: 'WorkspaceChangesParams' });

export const ReadFileParams = z
  .object({ sessionId, path: z.string() })
  .meta({ id: 'ReadFileParams' });

export const ListDirParams = z
  .object({
    workspaceId: z.string().min(1),
    sessionId,
    relativePath: z.string(),
    userId: z.string(),
  })
  .meta({ id: 'ListDirParams' });

export const DiffSide = z
  .object({
    kind: z.enum(['text', 'missing', 'binary', 'too_large']),
    text: z.string().optional(),
  })
  .meta({ id: 'DiffSide' });

export const DiffResult = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      base: DiffBase,
      path: z.string(),
      old: DiffSide,
      new: DiffSide,
      add: z.number().int().optional(),
      del: z.number().int().optional(),
    }),
    z.object({
      status: z.literal('unavailable'),
      base: DiffBase,
      path: z.string(),
      reason: z.string(),
      message: z.string().optional(),
    }),
  ])
  .meta({ id: 'DiffResult' });

export const WorkspaceChanges = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      base: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          add: z.number().int().optional(),
          del: z.number().int().optional(),
          kind: z.enum(['added', 'deleted', 'modified']).optional(),
        }),
      ),
    }),
    z.object({
      status: z.literal('unavailable'),
      reason: z.string(),
      message: z.string().optional(),
    }),
  ])
  .meta({ id: 'WorkspaceChanges' });

export const FileContent = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      path: z.string(),
      kind: z.enum(['text', 'binary']),
      text: z.string().optional(),
      base64: z.string().optional(),
      mimeType: z.string().optional(),
      bytes: z.number().int().nonnegative(),
    }),
    z.object({
      status: z.literal('error'),
      path: z.string(),
      code: z.string(),
      message: z.string().optional(),
    }),
  ])
  .meta({ id: 'FileContent' });

export const DirectoryListing = z
  .object({
    entries: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['file', 'directory']),
      }),
    ),
    truncated: z.boolean(),
  })
  .meta({ id: 'DirectoryListing' });
