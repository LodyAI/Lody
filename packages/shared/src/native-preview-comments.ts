import { z } from 'zod';
import { PreviewVisualCommentMutationSchema } from './preview-comment-mutation';
import type { PreviewVisualComment } from './preview-comment-types';
import type { ObservationEvent } from './room-observation';

export const NativePreviewScopeSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
  })
  .strict();
export const NativePreviewOpenSchema = NativePreviewScopeSchema.extend({
  observationId: z.string().uuid(),
}).strict();
export const NativePreviewMutationSchema = NativePreviewScopeSchema.extend({
  mutation: PreviewVisualCommentMutationSchema,
}).strict();
export const NativePreviewReleaseSchema = z.object({ observationId: z.string().uuid() }).strict();
export type NativeCommentRow = { id: string; comment: PreviewVisualComment | null };
export type NativePreviewEvent = {
  observationId: string;
  event: ObservationEvent<NativeCommentRow>;
};
export const NATIVE_PREVIEW_CHANNEL = 'loro.previewComments' as const;
