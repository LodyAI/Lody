import { z } from 'zod';

import type { PreviewVisualCommentDocInput } from './preview-comment-schema';

const nonEmptyString = z.string().trim().min(1);
const forbiddenRecordKeys = new Set(['__proto__', 'constructor', 'prototype']);
const safeStringRecordSchema = z.preprocess(
  (value, ctx) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!forbiddenRecordKeys.has(key)) continue;
        ctx.addIssue({ code: 'custom', message: `forbidden record key: ${key}` });
      }
    }
    return value;
  },
  z.record(z.string(), z.string())
);

const rectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

const viewportSchema = z
  .object({
    width: z.number(),
    height: z.number(),
    scrollX: z.number(),
    scrollY: z.number(),
    devicePixelRatio: z.number(),
  })
  .strict();

const minimalVisualAnnotationAnchorPayloadSchema = z
  .object({
    version: z.literal(1),
    page: z
      .object({
        url: nonEmptyString,
        pathname: z.string(),
        viewport: viewportSchema,
      })
      .strict(),
    click: z
      .object({
        clientX: z.number(),
        clientY: z.number(),
        pageX: z.number(),
        pageY: z.number(),
        viewportXRatio: z.number(),
        viewportYRatio: z.number(),
      })
      .strict(),
    target: z
      .object({
        tag: nonEmptyString,
        id: nonEmptyString.optional(),
        role: nonEmptyString.optional(),
        attributes: safeStringRecordSchema,
        text: z.string().optional(),
        rect: rectSchema,
        rectRatio: rectSchema,
        selector: nonEmptyString,
        xpath: nonEmptyString.optional(),
      })
      .strict(),
    context: z
      .object({
        ancestors: z.array(
          z
            .object({
              tag: nonEmptyString,
              id: nonEmptyString.optional(),
              role: nonEmptyString.optional(),
              selector: nonEmptyString.optional(),
              text: z.string().optional(),
            })
            .strict()
        ),
        nearbyText: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

export const previewVisualCommentPayloadSchema = z
  .object({
    id: nonEmptyString,
    turnId: nonEmptyString,
    status: z.enum(['completed', 'submitted', 'cancelled']),
    body: nonEmptyString,
    anchor: minimalVisualAnnotationAnchorPayloadSchema,
    authorId: nonEmptyString,
    authorName: nonEmptyString.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    submittedAt: z.number().optional(),
    submittedMessageId: nonEmptyString.optional(),
    resolvedAt: z.number().optional(),
    resolvedBy: nonEmptyString.optional(),
  })
  .strict();

const previewVisualCommentCreatePayloadSchema = previewVisualCommentPayloadSchema.extend({
  status: z.literal('completed'),
  submittedAt: z.never().optional(),
  submittedMessageId: z.never().optional(),
  resolvedAt: z.never().optional(),
  resolvedBy: z.never().optional(),
});

const previewVisualCommentIdsSchema = z
  .array(nonEmptyString)
  .min(1)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'commentIds must be unique' });
    }
  });

/**
 * Deterministic domain mutations for the dedicated preview-comment document.
 * Callers supply authors and timestamps so retries execute the same operation.
 */
export const PreviewVisualCommentMutationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      comment: previewVisualCommentCreatePayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve'),
      commentId: nonEmptyString,
      resolvedAt: z.number(),
      resolvedBy: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unresolve'),
      commentId: nonEmptyString,
      updatedAt: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mark-submitted'),
      commentIds: previewVisualCommentIdsSchema,
      submittedAt: z.number(),
      submittedMessageId: nonEmptyString.optional(),
    })
    .strict(),
]);

export type PreviewVisualCommentMutation = z.infer<typeof PreviewVisualCommentMutationSchema>;

type MutableComment = PreviewVisualCommentDocInput['turns'][string]['comments'][number];

const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquivalent(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => key !== '$cid' && leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => key !== '$cid' && rightRecord[key] !== undefined)
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEquivalent(leftRecord[key], rightRecord[key])
    )
  );
};

const isCommentTurn = (value: unknown): value is { comments: MutableComment[] } =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { comments?: unknown }).comments);

const allComments = (doc: PreviewVisualCommentDocInput): MutableComment[] =>
  Object.values(doc.turns).flatMap((turn) => (isCommentTurn(turn) ? turn.comments : []));

/**
 * Applies one validated mutation. Missing targets and conflicting duplicate IDs
 * throw before any state is changed; exact redelivery is idempotent.
 */
export const applyPreviewVisualCommentMutation = (
  doc: PreviewVisualCommentDocInput,
  input: PreviewVisualCommentMutation
): number => {
  const mutation = PreviewVisualCommentMutationSchema.parse(input);
  const comments = allComments(doc);

  if (mutation.kind === 'create') {
    const existing = comments.find((comment) => comment.id === mutation.comment.id);
    if (existing) {
      if (jsonEquivalent(existing, mutation.comment)) {
        return 0;
      }
      throw new Error(`preview_comment_id_conflict:${mutation.comment.id}`);
    }
    const turn = doc.turns[mutation.comment.turnId] ?? {
      turnId: mutation.comment.turnId,
      comments: [],
    };
    turn.comments.unshift(mutation.comment as unknown as MutableComment);
    doc.turns[mutation.comment.turnId] = turn;
    return 1;
  }

  if (mutation.kind === 'mark-submitted') {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const missing = mutation.commentIds.find((commentId) => !byId.has(commentId));
    if (missing) {
      throw new Error(`preview_comment_not_found:${missing}`);
    }
    const notSubmittable = mutation.commentIds.find((commentId) => {
      const status = byId.get(commentId)!.status;
      return status !== 'completed' && status !== 'submitted';
    });
    if (notSubmittable) {
      throw new Error(`preview_comment_not_submittable:${notSubmittable}`);
    }
    let changed = 0;
    for (const commentId of mutation.commentIds) {
      const comment = byId.get(commentId)!;
      if (comment.status === 'submitted') {
        continue;
      }
      comment.status = 'submitted';
      comment.submittedAt = mutation.submittedAt;
      comment.updatedAt = mutation.submittedAt;
      if (mutation.submittedMessageId) {
        comment.submittedMessageId = mutation.submittedMessageId;
      }
      changed += 1;
    }
    return changed;
  }

  const comment = comments.find((candidate) => candidate.id === mutation.commentId);
  if (!comment) {
    throw new Error(`preview_comment_not_found:${mutation.commentId}`);
  }
  if (mutation.kind === 'resolve') {
    if (
      comment.resolvedAt === mutation.resolvedAt &&
      comment.resolvedBy === mutation.resolvedBy &&
      comment.updatedAt === mutation.resolvedAt
    ) {
      return 0;
    }
    comment.resolvedAt = mutation.resolvedAt;
    comment.resolvedBy = mutation.resolvedBy;
    comment.updatedAt = mutation.resolvedAt;
    return 1;
  }
  if (
    comment.resolvedAt === undefined &&
    comment.resolvedBy === undefined &&
    comment.updatedAt === mutation.updatedAt
  ) {
    return 0;
  }
  delete comment.resolvedAt;
  delete comment.resolvedBy;
  comment.updatedAt = mutation.updatedAt;
  return 1;
};
