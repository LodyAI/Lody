import { z } from 'zod/v4';

export const ShortcutVisibility = z.enum(['private', 'workspace']);

export const ShortcutCloudParams = z
  .discriminatedUnion('operation', [
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('listAccessibleDocuments'),
      args: z.object({}),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('getStreamToken'),
      args: z.object({
        target: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('index'),
            ownerUserId: z.string().min(1),
            visibility: ShortcutVisibility,
          }),
          z.object({
            kind: z.literal('body'),
            bodyDocId: z.string().min(1),
          }),
        ]),
        write: z.boolean(),
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('stageDocument'),
      args: z.object({
        ownerUserId: z.string().min(1),
        shortcutId: z.string().min(1),
        bodyDocId: z.string().min(1),
        visibility: ShortcutVisibility,
      }),
    }),
    z.object({
      workspaceId: z.string().min(1),
      operation: z.literal('activateDocument'),
      args: z.object({
        bodyDocId: z.string().min(1),
        previousBodyDocId: z.string().min(1).nullable(),
        previousRevision: z.string().min(1).nullable(),
        revision: z.string().min(1),
        slug: z.string().min(1),
        indexBytes: z.number().int().nonnegative(),
      }),
    }),
  ])
  .meta({ id: 'ShortcutCloudParams' });
export type ShortcutCloudParams = z.input<typeof ShortcutCloudParams>;

export const ShortcutCloudResult = z
  .object({ value: z.unknown() })
  .meta({ id: 'ShortcutCloudResult' });

const repository = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const shortcutIdentifier = z.string().min(1).max(200);

export const PromptShortcutProject = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('github'), repository }),
    z.object({
      kind: z.literal('local'),
      id: shortcutIdentifier,
      machineId: shortcutIdentifier,
    }),
  ])
  .meta({ id: 'PromptShortcutProject' });

export const PromptShortcutTarget = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('file'),
      project: PromptShortcutProject,
      path: z.string().min(1),
      directory: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('skill'),
      source: z.enum(['project', 'global', 'system']),
      project: PromptShortcutProject.optional(),
      machineId: shortcutIdentifier.optional(),
      path: z.string().min(1),
      compatibleProviders: z.array(shortcutIdentifier).min(1),
    }),
    z.object({
      kind: z.literal('agent_role'),
      agentRoleId: shortcutIdentifier,
    }),
    z.object({
      kind: z.literal('issue'),
      repository,
      number: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('pull_request'),
      repository,
      number: z.number().int().positive(),
    }),
  ])
  .meta({ id: 'PromptShortcutTarget' });

export const PromptShortcutMention = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    label: z.string().min(1),
    target: PromptShortcutTarget,
  })
  .meta({ id: 'PromptShortcutMention' });

export const PromptShortcutScope = z
  .object({
    project: PromptShortcutProject.optional(),
    machineId: shortcutIdentifier.optional(),
    providerKey: shortcutIdentifier.optional(),
  })
  .meta({ id: 'PromptShortcutScope' });

const shortcutSummary = {
  v: z.number().int().min(1).max(1),
  id: shortcutIdentifier,
  workspaceId: shortcutIdentifier,
  ownerUserId: shortcutIdentifier,
  visibility: ShortcutVisibility,
  name: z.string().min(1),
  emoji: z.string().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  description: z.string().optional(),
  scope: PromptShortcutScope,
  revision: shortcutIdentifier,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
};

export const PromptShortcut = z
  .object({
    ...shortcutSummary,
    prompt: z.string(),
    mentions: z.array(PromptShortcutMention),
  })
  .meta({ id: 'PromptShortcut' });

export const PromptShortcutIndexEntry = z
  .object({
    ...shortcutSummary,
    bodyDocId: shortcutIdentifier,
    dependencySummary: z.array(PromptShortcutTarget),
  })
  .meta({ id: 'PromptShortcutIndexEntry' });

const shortcutScope = {
  workspaceId: z.string().min(1),
  userId: z.string(),
};

export const PromptShortcutsParams = z
  .discriminatedUnion('action', [
    z.object({ ...shortcutScope, action: z.literal('list') }),
    z.object({
      ...shortcutScope,
      action: z.literal('read'),
      entry: PromptShortcutIndexEntry,
    }),
    z.object({
      ...shortcutScope,
      action: z.literal('save'),
      entry: PromptShortcutIndexEntry.nullable(),
      value: PromptShortcut,
      bodyDocId: shortcutIdentifier,
    }),
  ])
  .meta({ id: 'PromptShortcutsParams' });

export const PromptShortcutsResult = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('list'),
      entries: z.array(PromptShortcutIndexEntry),
    }),
    z.object({ action: z.literal('read'), shortcut: PromptShortcut }),
    z.object({ action: z.literal('save'), entry: PromptShortcutIndexEntry }),
  ])
  .meta({ id: 'PromptShortcutsResult' });
