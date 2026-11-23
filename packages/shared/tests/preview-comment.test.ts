import { describe, expect, it } from 'vitest';

import {
  applyPreviewVisualCommentMutation,
  createPreviewVisualComment,
  createPreviewVisualCommentDoc,
  PreviewVisualCommentMutationSchema,
  type MinimalVisualAnnotationAnchor,
  type PreviewVisualCommentDocInput,
  type SessionId,
} from '../src';

const createAnchor = (): MinimalVisualAnnotationAnchor => ({
  version: 1,
  page: {
    url: '/settings',
    pathname: '/settings',
    viewport: {
      width: 1000,
      height: 500,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
    },
  },
  click: {
    clientX: 100,
    clientY: 80,
    pageX: 100,
    pageY: 80,
    viewportXRatio: 0.1,
    viewportYRatio: 0.16,
  },
  target: {
    tag: 'button',
    attributes: { 'data-testid': 'save' },
    text: 'Save',
    rect: {
      x: 80,
      y: 64,
      width: 120,
      height: 32,
    },
    rectRatio: {
      x: 0.08,
      y: 0.13,
      width: 0.12,
      height: 0.06,
    },
    selector: 'button[data-testid="save"]',
    xpath: '/html[1]/body[1]/button[1]',
  },
  context: {
    ancestors: [{ tag: 'form', selector: 'form' }],
    nearbyText: ['Save'],
  },
});

describe('preview visual comment document', () => {
  const sessionId = 'session-1' as SessionId;

  it('applies deterministic mutations idempotently and rejects ID conflicts', () => {
    const doc = createPreviewVisualCommentDoc(sessionId) as PreviewVisualCommentDocInput;
    const comment = createPreviewVisualComment({
      id: 'comment-1',
      turnId: 'turn-1',
      body: 'Original body',
      anchor: createAnchor(),
      authorId: 'user-1',
      createdAt: 1_000,
    });
    const mutation = { kind: 'create' as const, comment };

    expect(applyPreviewVisualCommentMutation(doc, mutation)).toBe(1);
    expect(applyPreviewVisualCommentMutation(doc, mutation)).toBe(0);
    expect(() =>
      applyPreviewVisualCommentMutation(doc, {
        kind: 'create',
        comment: { ...comment, body: 'Conflicting body' },
      })
    ).toThrow('preview_comment_id_conflict:comment-1');
    expect(doc.turns['turn-1']).toMatchObject({
      comments: [expect.objectContaining({ body: 'Original body' })],
    });

    expect(
      applyPreviewVisualCommentMutation(doc, {
        kind: 'resolve',
        commentId: 'comment-1',
        resolvedAt: 2_000,
        resolvedBy: 'user-2',
      })
    ).toBe(1);
    expect(doc.turns['turn-1']).toMatchObject({
      comments: [expect.objectContaining({ resolvedAt: 2_000, resolvedBy: 'user-2' })],
    });
    expect(
      applyPreviewVisualCommentMutation(doc, {
        kind: 'unresolve',
        commentId: 'comment-1',
        updatedAt: 3_000,
      })
    ).toBe(1);
    expect(doc.turns['turn-1']).toMatchObject({
      comments: [expect.not.objectContaining({ resolvedAt: expect.anything() })],
    });
  });

  it('validates a submitted batch before changing any comment', () => {
    const doc = createPreviewVisualCommentDoc(sessionId) as PreviewVisualCommentDocInput;
    const comment = createPreviewVisualComment({
      id: 'comment-1',
      turnId: 'turn-1',
      body: 'Submit me',
      anchor: createAnchor(),
      authorId: 'user-1',
      createdAt: 1_000,
    });
    applyPreviewVisualCommentMutation(doc, { kind: 'create', comment });

    expect(() =>
      applyPreviewVisualCommentMutation(doc, {
        kind: 'mark-submitted',
        commentIds: ['comment-1', 'missing'],
        submittedAt: 2_000,
      })
    ).toThrow('preview_comment_not_found:missing');
    expect(doc.turns['turn-1']).toMatchObject({
      comments: [expect.objectContaining({ status: 'completed' })],
    });

    const submit = {
      kind: 'mark-submitted' as const,
      commentIds: ['comment-1'],
      submittedAt: 2_000,
      submittedMessageId: 'message-1',
    };
    expect(applyPreviewVisualCommentMutation(doc, submit)).toBe(1);
    expect(applyPreviewVisualCommentMutation(doc, submit)).toBe(0);
    expect(doc.turns['turn-1']).toMatchObject({
      comments: [
        expect.objectContaining({
          status: 'submitted',
          submittedAt: 2_000,
          submittedMessageId: 'message-1',
        }),
      ],
    });
  });

  it('rejects malformed mutation payloads at the intent boundary', () => {
    const comment = createPreviewVisualComment({
      id: 'comment-1',
      turnId: 'turn-1',
      body: 'Validate me',
      anchor: createAnchor(),
      authorId: 'user-1',
      createdAt: 1_000,
    });
    expect(
      PreviewVisualCommentMutationSchema.safeParse({
        kind: 'mark-submitted',
        commentIds: ['comment-1', 'comment-1'],
        submittedAt: 2_000,
      }).success
    ).toBe(false);
    expect(
      PreviewVisualCommentMutationSchema.safeParse({
        kind: 'create',
        comment: { ...comment, anchor: { ...comment.anchor, version: 2 } },
      }).success
    ).toBe(false);
    expect(
      PreviewVisualCommentMutationSchema.safeParse({
        kind: 'create',
        comment: {
          ...comment,
          anchor: {
            ...comment.anchor,
            target: {
              ...comment.anchor.target,
              attributes: JSON.parse('{"__proto__":"blocked"}') as Record<string, string>,
            },
          },
        },
      }).success
    ).toBe(false);
  });
});
