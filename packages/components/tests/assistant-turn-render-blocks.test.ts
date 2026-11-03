import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import { buildAssistantTurnRenderLayout } from '../src/components/ai-gui/assistant-turn-render-blocks';

const tool = (
  toolCallId: string,
  kind: Extract<MessageContent, { type: 'tool_call' }>['kind'],
  overrides: Partial<Extract<MessageContent, { type: 'tool_call' }>> = {}
): Extract<MessageContent, { type: 'tool_call' }> => ({
  type: 'tool_call',
  toolCallId,
  kind,
  status: 'completed',
  ...overrides,
});

describe('buildAssistantTurnRenderLayout', () => {
  it('folds finished activity into work while keeping every text block visible', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'thought', text: 'Inspect the renderer.' },
        tool('command-1', 'execute'),
        { type: 'text', text: 'I found the relevant component.' },
        tool('edit-1', 'edit'),
        { type: 'text', text: 'The renderer now collapses completed work.' },
      ],
      true
    );

    expect(layout.blocks.map((block) => block.kind)).toEqual([
      'activity_group',
      'content',
      'activity_group',
      'content',
    ]);
    expect(layout.firstWorkBlockIndex).toBe(0);
    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('keeps the final text and trailing generated images outside the work group', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'thought', text: 'Generate the requested image.' },
        { type: 'text', text: 'Here is the finished image.' },
        {
          type: 'image_group',
          images: [{ imageId: 'image-1', mimeType: 'image/png', sizeBytes: 123 }],
        },
      ],
      true
    );

    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('keeps an answer visible even when more work follows it', () => {
    // A run that answers first and keeps verifying used to have that answer
    // folded away: only the final text run counted as the reply.
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'text', text: 'The bug is in the parser.' },
        tool('command-1', 'execute'),
        { type: 'text', text: 'Confirmed by the reproduction.' },
      ],
      true
    );

    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('treats a finished activity-only turn as work even without a final text reply', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [tool('command-1', 'execute')],
      true
    );

    expect(layout.workBlockKeys.size).toBe(1);
    expect(layout.firstWorkBlockIndex).toBe(0);
  });
});
