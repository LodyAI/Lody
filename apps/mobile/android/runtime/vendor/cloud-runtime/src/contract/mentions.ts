import { z } from 'zod/v4';

export const MentionCatalogParams = z
  .object({
    workspaceId: z.string().min(1),
    userId: z.string(),
    category: z.enum([
      'file',
      'skill',
      'session',
      'role',
      'issue',
      'pr',
      'cmd',
    ]),
    sessionId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    machineId: z.string().min(1).optional(),
    agentConfigId: z.string().min(1).optional(),
    cliType: z.string().optional(),
    agentType: z.string().optional(),
  })
  .meta({ id: 'MentionCatalogParams' });

export const MentionCatalog = z
  .object({
    items: z.array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum([
          'file',
          'skill',
          'session',
          'role',
          'issue',
          'pr',
          'cmd',
          'directory',
        ]),
        subtitle: z.string(),
        insertText: z.string().optional(),
        roleName: z.string().optional(),
        /** A Role's emoji, shown before its name (as the run-config Role row). */
        emoji: z.string().optional(),
      }),
    ),
    truncated: z.boolean(),
    incomplete: z.boolean(),
  })
  .meta({ id: 'MentionCatalog' });
