import { SESSION_IMAGE_MAX_COUNT, type CommentReferencePayload } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import {
  shouldRenderSystemRowItem,
  isMessageContent,
  normalizeMessageContent,
} from '../src/components/ai-gui/message-content-guards';

const commentReference: CommentReferencePayload = {
  source: 'lody',
  path: 'packages/shared/src/schema.ts',
  lineNumber: 42,
  side: 'additions',
  commentBody: 'Please handle this comment.',
  authorName: 'Leon',
};

describe('isMessageContent', () => {
  it('keeps comment references when parsing session history items', () => {
    const rawItems: unknown[] = [
      {
        type: 'comment_reference',
        ...commentReference,
      },
    ];

    expect(rawItems.filter(isMessageContent)).toEqual(rawItems);
  });

  it('rejects malformed comment references', () => {
    expect(
      isMessageContent({
        type: 'comment_reference',
        path: 'packages/shared/src/schema.ts',
        lineNumber: 42,
        side: 'additions',
        commentBody: 'Please handle this comment.',
        authorName: 'Leon',
      })
    ).toBe(false);
  });

  it('keeps current sparse Codex goal content when parsing session history items', () => {
    expect(
      isMessageContent({
        type: 'goal',
        threadId: 'thread-1',
        objective: 'ship the release',
        status: 'active',
        tokenBudget: null,
      })
    ).toBe(true);
  });

  it('keeps legacy full goal content when parsing session history items', () => {
    expect(
      isMessageContent({
        type: 'goal',
        threadId: 'thread-1',
        objective: 'ship the release',
        status: 'complete',
        tokenBudget: 1000,
        tokensUsed: 123,
        timeUsedSeconds: 9,
        createdAt: 100,
        updatedAt: 200,
      })
    ).toBe(true);
  });

  it('keeps Codex proposed plan content when parsing session history items', () => {
    expect(
      isMessageContent({
        type: 'proposed_plan',
        turnId: 'turn-plan',
        markdown: '- Inspect the ACP event path',
        status: 'completed',
        isLatest: true,
      })
    ).toBe(true);
  });

  it('keeps structured Operation completions and rejects incomplete envelopes', () => {
    expect(
      isMessageContent({
        type: 'operation_completion',
        deliveryId: 'operation:review:completion',
        operationId: 'review',
        operationKind: 'session_chat_many',
        completion: {
          type: 'result',
          value: {
            items: [
              {
                status: 'succeeded',
                target: { sessionId: 'target-1', userTurnId: 'turn-1' },
                assistantTurnId: 'assistant:turn-1',
              },
            ],
          },
        },
      })
    ).toBe(true);
    expect(
      isMessageContent({
        type: 'operation_completion',
        deliveryId: 'operation:review:completion',
        operationId: 'review',
        operationKind: 'session_chat_many',
        completion: { type: 'result' },
      })
    ).toBe(false);
  });

  it('keeps image groups up to the shared per-message image limit', () => {
    expect(
      isMessageContent({
        type: 'image_group',
        images: Array.from({ length: SESSION_IMAGE_MAX_COUNT }, (_, index) => ({
          imageId: `img-${index}`,
          mimeType: 'image/png',
          sizeBytes: 1024,
        })),
      })
    ).toBe(true);

    expect(
      isMessageContent({
        type: 'image_group',
        images: Array.from({ length: SESSION_IMAGE_MAX_COUNT + 1 }, (_, index) => ({
          imageId: `img-${index}`,
          mimeType: 'image/png',
          sizeBytes: 1024,
        })),
      })
    ).toBe(false);
  });

  it('normalizes Codex proposed plan content with LoroText-like markdown', () => {
    const content = normalizeMessageContent({
      type: 'proposed_plan',
      turnId: 'turn-plan',
      markdown: { toString: () => '- Inspect the ACP event path' },
      status: 'completed',
      isLatest: true,
    });

    expect(content).toEqual({
      type: 'proposed_plan',
      turnId: 'turn-plan',
      markdown: '- Inspect the ACP event path',
      status: 'completed',
      isLatest: true,
    });
  });
});

describe('shouldRenderSystemRowItem', () => {
  const enabled = true;
  const disabled = false;

  it('renders the four system row types regardless of the Tasks beta', () => {
    for (const tasksEnabled of [enabled, disabled]) {
      expect(shouldRenderSystemRowItem({ type: 'system_notice' }, tasksEnabled)).toBe(true);
      expect(shouldRenderSystemRowItem({ type: 'worktree_script' }, tasksEnabled)).toBe(true);
      expect(shouldRenderSystemRowItem({ type: 'operation_completion' }, tasksEnabled)).toBe(true);
      expect(shouldRenderSystemRowItem({ type: 'operation_progress' }, tasksEnabled)).toBe(true);
    }
  });

  it('never renders item types that are not system rows', () => {
    for (const tasksEnabled of [enabled, disabled]) {
      expect(shouldRenderSystemRowItem({ type: 'text' }, tasksEnabled)).toBe(false);
      expect(shouldRenderSystemRowItem({ type: 'tool_call' }, tasksEnabled)).toBe(false);
      expect(shouldRenderSystemRowItem({ type: 'image_group' }, tasksEnabled)).toBe(false);
    }
  });

  it('drops an agent task proposal only while the Tasks beta is off', () => {
    const proposal = { type: 'system_notice', name: 'task_proposal' };
    expect(shouldRenderSystemRowItem(proposal, enabled)).toBe(true);
    expect(shouldRenderSystemRowItem(proposal, disabled)).toBe(false);
  });

  it('keeps other named system notices when the Tasks beta is off', () => {
    // The gate must remove the task proposal and nothing else — this is the
    // case that would silently swallow unrelated notices if the condition were
    // mis-inverted.
    expect(
      shouldRenderSystemRowItem(
        { type: 'system_notice', name: 'resume_from_external_chat_history' },
        disabled
      )
    ).toBe(true);
    expect(shouldRenderSystemRowItem({ type: 'system_notice', name: undefined }, disabled)).toBe(
      true
    );
  });
});

describe('operation progress content guard', () => {
  const item = { status: 'created', target: { sessionId: 'child', userTurnId: 'turn' } };
  const progress = {
    type: 'operation_progress',
    operationId: 'create',
    operationKind: 'session_create',
    items: [item],
  };
  it('accepts every supported target state', () => {
    for (const status of ['created', 'running', 'succeeded', 'failed', 'cancelled']) {
      expect(isMessageContent({ ...progress, items: [{ ...item, status }] })).toBe(true);
    }
  });
  it('rejects malformed targets and unknown statuses', () => {
    expect(isMessageContent({ ...progress, items: [{ ...item, status: 'active' }] })).toBe(false);
    expect(isMessageContent({ ...progress, items: [{ status: 'created' }] })).toBe(false);
    expect(isMessageContent({ ...progress, operationKind: 'session_chat' })).toBe(false);
  });
});
