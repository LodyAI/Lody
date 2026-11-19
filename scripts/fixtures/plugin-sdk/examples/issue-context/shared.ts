import {
  defineAttachmentSource,
  defineMutation,
  defineObservation,
  defineQuery,
} from '@lody/plugin-sdk';
import { z } from 'zod';

export const issueRowSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  state: z.enum(['todo', 'in_progress', 'done']),
  pinned: z.boolean(),
  url: z.string(),
});

export type IssueRow = z.infer<typeof issueRowSchema>;

export const issueAttachmentSource = defineAttachmentSource('issues', {
  title: 'Attach Issue',
  placeholder: 'Search issues by key or title…',
  metadataSchema: z.object({
    identifier: z.string(),
    state: z.string(),
  }),
});

export const listIssuesQuery = defineQuery('project', 'issues.list', {
  input: z.object({ query: z.string().default('') }),
  output: z.array(issueRowSchema),
});

export const togglePinMutation = defineMutation('project', 'issues.togglePin', {
  input: z.object({ issueId: z.string(), pinned: z.boolean() }),
  output: z.object({ ok: z.literal(true) }),
});

export const issueStateObservation = defineObservation('project', 'issues.state', {
  input: z.object({ identifier: z.string() }),
  output: z.object({
    state: z.enum(['todo', 'in_progress', 'done', 'unknown']),
  }),
});
