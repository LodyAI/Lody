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
      { type: 'proposed_plan', itemIndex: 2, displayIndex: 1 },
      { type: 'image_group', itemIndex: 3, displayIndex: 2 },
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
  it('sorts agent attachments below the plan, and leaves plan-less turns alone', () => {
    // A plan runs long; an attachment above it is stranded mid-markdown.
    const withPlan = [
      { type: 'text', text: 'Answer' },
      { type: 'file', fileId: 'f1' },
      {
        type: 'proposed_plan',
        turnId: 't',
        markdown: '# Plan',
        status: 'completed',
        isLatest: true,
      },
      { type: 'image_group', images: [{ imageId: 'i1', mimeType: 'image/png', sizeBytes: 1 }] },
    ] as unknown as MessageContent[];

    expect(buildAssistantMessageRenderItems(withPlan).map((i) => i.content.type)).toEqual([
      'text',
      'proposed_plan',
      'file',
      'image_group',
    ]);

    // Files and images stay together rather than straddling the plan.
    const attachmentsFirst = [
      { type: 'image_group', images: [{ imageId: 'i1', mimeType: 'image/png', sizeBytes: 1 }] },
      {
        type: 'proposed_plan',
        turnId: 't',
        markdown: '# Plan',
        status: 'completed',
        isLatest: true,
      },
      { type: 'file', fileId: 'f1' },
    ] as unknown as MessageContent[];

    expect(buildAssistantMessageRenderItems(attachmentsFirst).map((i) => i.content.type)).toEqual([
      'proposed_plan',
      'image_group',
      'file',
    ]);

    // No plan: the turn's own order is authoritative.
    const withoutPlan = [
      { type: 'file', fileId: 'f1' },
      { type: 'text', text: 'Answer' },
    ] as unknown as MessageContent[];

    expect(buildAssistantMessageRenderItems(withoutPlan).map((i) => i.content.type)).toEqual([
      'file',
      'text',
    ]);
  });
});
