import {
  applyPreviewVisualCommentMutation,
  PreviewVisualCommentMutationSchema,
  type PreviewVisualCommentMutation,
} from '../preview-comment-mutation';
import { getPreviewCommentRoomId } from '../preview-comment-types';
import type { PreviewVisualCommentDocInput } from '../preview-comment-schema';
import type { SessionId } from '../ids';
import { LODY_PREVIEW_COMMENT_DOC_SCHEMA } from '@loro-dev/loro-repo-client';
import {
  mutateNativeLoroDocument,
  queryNativeLoroDocument,
  planNativeDocumentFields,
  observeNativeLoroDocument,
  type NativeLoroDocumentOptions,
} from './native-loro-document';

/** The existing workspace-writer command, bound to one preview room by its owner.
 * Session admission, author identity and cloud/protected policy remain outside. */
export function createNativePreviewComments(
  options: Omit<NativeLoroDocumentOptions, 'roomId' | 'schema'> & { readonly sessionId: SessionId }
) {
  const bound = {
    ...options,
    roomId: getPreviewCommentRoomId(options.sessionId),
    schema: LODY_PREVIEW_COMMENT_DOC_SCHEMA,
  };
  const document = (value: unknown): PreviewVisualCommentDocInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid preview comment document');
    const raw = value as PreviewVisualCommentDocInput;
    if (raw.meta?.sessionId !== undefined && raw.meta.sessionId !== options.sessionId)
      throw new Error('Preview comment session binding mismatch');
    if (
      raw.turns !== undefined &&
      (!raw.turns || typeof raw.turns !== 'object' || Array.isArray(raw.turns))
    )
      throw new Error('Invalid preview comment turns');
    return { ...raw, meta: { ...raw.meta, sessionId: options.sessionId }, turns: raw.turns ?? {} };
  };
  return {
    async read() {
      return (await queryNativeLoroDocument(bound, (value) => document(value))).result;
    },
    async mutatePreviewVisualComments(sessionId: SessionId, input: PreviewVisualCommentMutation) {
      if (sessionId !== options.sessionId)
        throw new Error('Preview comment session binding mismatch');
      const mutation = PreviewVisualCommentMutationSchema.parse(input);
      return mutateNativeLoroDocument(bound, (raw, plan) => {
        const before = document(raw);
        const next = structuredClone(before);
        const changed = applyPreviewVisualCommentMutation(next, mutation);
        if (changed) planNativeDocumentFields(plan, raw, next as Record<string, unknown>);
        return changed;
      });
    },
    observe(
      listener: (value: PreviewVisualCommentDocInput) => void,
      onError: (error: unknown) => void
    ) {
      return observeNativeLoroDocument(bound, document, listener, onError);
    },
  };
}
