import { InferInputType, InferType, schema } from 'loro-mirror';

import type { PreviewVisualCommentStatus } from './preview-comment-types';
import type { SessionId } from './index';

const viewportSchema = schema.LoroMap({
  width: schema.Number(),
  height: schema.Number(),
  scrollX: schema.Number(),
  scrollY: schema.Number(),
  devicePixelRatio: schema.Number(),
});

const pageSchema = schema.LoroMap({
  url: schema.String(),
  pathname: schema.String(),
  viewport: viewportSchema,
});

const clickSchema = schema.LoroMap({
  clientX: schema.Number(),
  clientY: schema.Number(),
  pageX: schema.Number(),
  pageY: schema.Number(),
  viewportXRatio: schema.Number(),
  viewportYRatio: schema.Number(),
});

const rectSchema = schema.LoroMap({
  x: schema.Number(),
  y: schema.Number(),
  width: schema.Number(),
  height: schema.Number(),
});

const anchorAttributesSchema = schema.LoroMapRecord(schema.String());

const anchorTargetSchema = schema.LoroMap({
  tag: schema.String(),
  id: schema.String({ required: false }),
  role: schema.String({ required: false }),
  attributes: anchorAttributesSchema,
  text: schema.String({ required: false }),
  rect: rectSchema,
  rectRatio: rectSchema,
  selector: schema.String(),
  xpath: schema.String({ required: false }),
});

const anchorAncestorSchema = schema.LoroMap({
  tag: schema.String(),
  id: schema.String({ required: false }),
  role: schema.String({ required: false }),
  selector: schema.String({ required: false }),
  text: schema.String({ required: false }),
});

const anchorContextSchema = schema.LoroMap({
  ancestors: schema.LoroList(anchorAncestorSchema),
  nearbyText: schema.LoroList(schema.String(), undefined, { required: false }),
});

export const minimalVisualAnnotationAnchorSchema = schema.LoroMap({
  version: schema.Number(),
  page: pageSchema,
  click: clickSchema,
  target: anchorTargetSchema,
  context: anchorContextSchema,
});

export const previewVisualCommentSchema = schema.LoroMap({
  id: schema.String(),
  turnId: schema.String(),
  status: schema.String<PreviewVisualCommentStatus>(),
  body: schema.String(),
  anchor: minimalVisualAnnotationAnchorSchema,
  authorId: schema.String(),
  authorName: schema.String({ required: false }),
  createdAt: schema.Number(),
  updatedAt: schema.Number(),
  submittedAt: schema.Number({ required: false }),
  submittedMessageId: schema.String({ required: false }),
  resolvedAt: schema.Number({ required: false }),
  resolvedBy: schema.String({ required: false }),
});

export const previewVisualCommentTurnSchema = schema.LoroMap({
  turnId: schema.String(),
  comments: schema.LoroList(previewVisualCommentSchema, (item: { id: string }) => item.id),
});

/** Root schema for a preview visual comment doc; see `sessionDocSchema` on adding root fields. */
export const previewVisualCommentDocSchema = schema({
  meta: schema.LoroMap({
    sessionId: schema.String<SessionId>(),
  }),
  turns: schema.LoroMapRecord(previewVisualCommentTurnSchema),
});

export type PreviewVisualCommentSchemaComment = InferType<typeof previewVisualCommentSchema>;
export type PreviewVisualCommentSchemaTurn = InferType<typeof previewVisualCommentTurnSchema>;
export type PreviewVisualCommentDocState = InferType<typeof previewVisualCommentDocSchema>;
export type PreviewVisualCommentDocInput = InferInputType<typeof previewVisualCommentDocSchema>;
