import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import { buildAssistantMessageRenderItems } from '../src/components/ai-gui/assistant-message-render-items';
import {
  collectSessionImageGalleryEntries,
  createSessionImageGalleryEntry,
  findSessionImageGalleryEntryIndex,
} from '../src/lib/session-image-gallery';

const sessionId = 'session-1' as SessionId;

const buildAssistantMessage = (items: MessageContent[]): SessionHistoryParsed => ({
  id: 'assistant-1',
  role: 'assistant',
  timestamp: '2026-07-03T00:00:00.000Z',
  read: true,
  finished: true,
  items,
});

describe('buildAssistantMessageRenderItems', () => {
  it('hides completed retry activities but keeps active retries and compaction results', () => {
    const items = [
      {
        type: 'tool_call',
        toolCallId: 'retry-active',
        title: 'Codex retrying',
        status: 'in_progress',
        activityKind: 'codex_retry',
      },
      {
        type: 'tool_call',
        toolCallId: 'retry-completed',
        title: 'Codex retrying',
        status: 'completed',
        activityKind: 'codex_retry',
      },
      {
        type: 'tool_call',
        toolCallId: 'compaction-completed',
        title: 'Context compacted',
        status: 'completed',
        activityKind: 'context_compaction',
      },
    ] satisfies MessageContent[];

    expect(
      buildAssistantMessageRenderItems(items).map((item) =>
        item.content.type === 'tool_call' ? item.content.toolCallId : item.content.type
      )
    ).toEqual(['retry-active', 'compaction-completed']);
  });

  it('keeps original history indexes for image preview keys after filtering and reordering', () => {
    const items = [
      {
        type: 'subagent_task',
        taskId: 'task-1',
        status: 'completed',
      },
      {
        type: 'text',
        text: 'Rendered answer',
      },
      {
        type: 'proposed_plan',
        turnId: 'turn-plan',
        markdown: '- Inspect\n- Fix',
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'image_group',
        images: [
          {
            imageId: 'img-agent',
            mimeType: 'image/png',
            sizeBytes: 123,
          },
        ],
      },
    ] satisfies MessageContent[];

    const renderItems = buildAssistantMessageRenderItems(items);

    expect(
      renderItems.map((item) => ({
        type: item.content.type,
        itemIndex: item.itemIndex,
        displayIndex: item.displayIndex,
      }))
    ).toEqual([
      { type: 'text', itemIndex: 1, displayIndex: 0 },
      { type: 'image_group', itemIndex: 3, displayIndex: 1 },
      { type: 'proposed_plan', itemIndex: 2, displayIndex: 2 },
    ]);

    const imageRenderItem = renderItems.find((item) => item.content.type === 'image_group');
    expect(imageRenderItem?.content.type).toBe('image_group');
    if (!imageRenderItem || imageRenderItem.content.type !== 'image_group') {
      throw new Error('Expected an image_group render item');
    }

    const galleryEntries = collectSessionImageGalleryEntries(
      [buildAssistantMessage(items)],
      sessionId
    );
    const renderedEntry = createSessionImageGalleryEntry({
      sessionId,
      messageId: 'assistant-1',
      itemIndex: imageRenderItem.itemIndex,
      imageIndex: 0,
      image: imageRenderItem.content.images[0]!,
    });

    expect(renderedEntry.key).toBe('assistant-1:3:0:img-agent');
    expect(findSessionImageGalleryEntryIndex(galleryEntries, renderedEntry.key)).toBe(0);
  });

  it('keeps a Codex proposed plan before its approval card and implementation', () => {
    const items = [
      { type: 'thought', text: 'Inspect the current behavior.' },
      {
        type: 'proposed_plan',
        turnId: 'plan-1',
        markdown: '- Update the renderer',
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-review-1',
        title: 'Implement this plan?',
        kind: 'switch_mode',
        status: 'completed',
      },
      { type: 'thought', text: 'Implement the renderer change.' },
      {
        type: 'tool_call',
        toolCallId: 'edit-1',
        kind: 'edit',
        status: 'completed',
      },
      { type: 'text', text: 'Done.' },
    ] satisfies MessageContent[];

    expect(
      buildAssistantMessageRenderItems(items).map(({ content, itemIndex }) => ({
        type: content.type,
        kind: content.type === 'tool_call' ? content.kind : undefined,
        itemIndex,
      }))
    ).toEqual([
      { type: 'thought', kind: undefined, itemIndex: 0 },
      { type: 'proposed_plan', kind: undefined, itemIndex: 1 },
      { type: 'tool_call', kind: 'switch_mode', itemIndex: 2 },
      { type: 'thought', kind: undefined, itemIndex: 3 },
      { type: 'tool_call', kind: 'edit', itemIndex: 4 },
      { type: 'text', kind: undefined, itemIndex: 5 },
    ]);
  });

  it('orders each proposed plan within its own switch-mode segment', () => {
    const items = [
      {
        type: 'proposed_plan',
        turnId: 'plan-1',
        markdown: '- First plan',
        status: 'completed',
        isLatest: false,
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-review-1',
        kind: 'switch_mode',
        status: 'completed',
      },
      { type: 'thought', text: 'Implement the first plan.' },
      {
        type: 'proposed_plan',
        turnId: 'plan-2',
        markdown: '- Revised plan',
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-review-2',
        kind: 'switch_mode',
        status: 'completed',
      },
      { type: 'text', text: 'Implemented the revised plan.' },
    ] satisfies MessageContent[];

    expect(
      buildAssistantMessageRenderItems(items).map(({ content }) =>
        content.type === 'proposed_plan'
          ? `plan:${content.turnId}`
          : content.type === 'tool_call'
            ? `tool:${content.toolCallId}`
            : content.type
      )
    ).toEqual([
      'plan:plan-1',
      'tool:plan-review-1',
      'thought',
      'plan:plan-2',
      'tool:plan-review-2',
      'text',
    ]);
  });
});
