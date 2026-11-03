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
  it('puts finished activity and progress text into work while leaving the final reply visible', () => {
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
      true,
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

  it('keeps every text block in the final contiguous run outside the work group', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'text', text: 'Progress update.' },
        tool('command-1', 'execute'),
        { type: 'text', text: 'First part of the final response.' },
        { type: 'text', text: 'Second part of the final response.' },
      ],
      true
    );

    expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
      true,
      true,
      false,
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
