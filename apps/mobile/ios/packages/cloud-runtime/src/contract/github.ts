import { z } from 'zod/v4';

export const GitHubMentionsParams = z
  .object({
    workspaceId: z.string().min(1),
    repoFullName: z.string().min(1),
  })
  .meta({ id: 'GitHubMentionsParams' });

export const GitHubMentionsResult = z
  .object({
    items: z.array(
      z.object({
        path: z.string().min(1),
        name: z.string(),
        kind: z.enum(['issue', 'pr']),
        subtitle: z.string(),
        insertText: z.string(),
      }),
    ),
    truncated: z.boolean(),
    incomplete: z.boolean(),
  })
  .meta({ id: 'GitHubMentionsResult' });
