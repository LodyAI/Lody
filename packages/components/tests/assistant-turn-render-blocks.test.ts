import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import {
  buildAssistantTurnRenderBlocks,
  buildAssistantTurnRenderLayout,
} from '../src/components/ai-gui/assistant-turn-render-blocks';

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

describe('buildAssistantTurnRenderBlocks', () => {
  it('groups adjacent thoughts and tool calls while keeping text in chronological order', () => {
    const items: MessageContent[] = [
      { type: 'thought', text: 'Inspect the current renderer.' },
      tool('command-1', 'execute'),
      tool('command-2', 'execute'),
      { type: 'text', text: 'I found the rendering boundary.' },
      tool('read-1', 'read', { locations: [{ path: 'src/view.tsx' }] }),
      tool('edit-1', 'edit', {
        locations: [{ path: 'src/view.tsx' }],
        content: [{ type: 'diff', path: 'src/view.tsx', oldText: 'a', newText: 'b' }],
      }),
      { type: 'text', text: 'Done.' },
    ];

    const blocks = buildAssistantTurnRenderBlocks('assistant-1', items);

    expect(blocks.map((block) => block.kind)).toEqual([
      'activity_group',
      'content',
      'activity_group',
      'content',
    ]);
    const firstActivity = blocks[0];
    expect(firstActivity?.kind).toBe('activity_group');
    if (firstActivity?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(firstActivity.entries).toHaveLength(3);
    expect(firstActivity.summary.hasThought).toBe(true);
    expect(firstActivity.summary.commandCount).toBe(2);

    const secondActivity = blocks[2];
    expect(secondActivity?.kind).toBe('activity_group');
    if (secondActivity?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(secondActivity.summary.readFileCount).toBe(1);
    expect(secondActivity.summary.editFileCount).toBe(1);
  });

  it('keeps group keys stable while adjacent thoughts and tool calls stream in', () => {
    const initial = buildAssistantTurnRenderBlocks('assistant-1', [
      { type: 'thought', text: 'Inspect first.' },
    ]);
    const updated = buildAssistantTurnRenderBlocks('assistant-1', [
      { type: 'thought', text: 'Inspect first.' },
      tool('command-1', 'execute'),
      tool('command-2', 'execute'),
    ]);

    expect(initial[0]?.key).toBe(updated[0]?.key);
  });

  it('treats invisible command metadata as transparent and provider thinking tools as thought', () => {
    const blocks = buildAssistantTurnRenderBlocks('assistant-1', [
      tool('command-1', 'execute'),
      { type: 'available_commands', commands: [{ name: 'review' }] },
      tool('command-2', 'execute'),
      tool('think-1', 'think'),
      { type: 'thought', text: 'Continue reasoning.' },
      tool('switch-1', 'switch_mode'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['activity_group', 'content']);
    const activityGroup = blocks[0];
    expect(activityGroup?.kind).toBe('activity_group');
    if (activityGroup?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(activityGroup.entries).toHaveLength(4);
    expect(activityGroup.summary).toMatchObject({ hasThought: true, commandCount: 2 });
  });

  it('counts unique file paths and tool categories', () => {
    const blocks = buildAssistantTurnRenderBlocks('assistant-1', [
      tool('read-1', 'read', { locations: [{ path: 'src/view.tsx' }] }),
      tool('read-2', 'read', { locations: [{ path: 'src/view.tsx' }] }),
      tool('edit-1', 'edit', {
        status: 'in_progress',
        content: [
          { type: 'diff', path: 'src/view.tsx', newText: 'next' },
          { type: 'diff', path: 'src/index.ts', newText: 'next' },
        ],
      }),
      tool('search-1', 'search', { status: 'failed' }),
    ]);

    const block = blocks[0];
    expect(block?.kind).toBe('activity_group');
    if (block?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(block.summary).toMatchObject({
      readFileCount: 1,
      editFileCount: 2,
      searchCount: 1,
    });
  });
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

  it('does not create completed-work boundaries while a turn is streaming', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [{ type: 'thought', text: 'Still inspecting.' }, tool('command-1', 'execute')],
      false
    );

    expect(layout.workBlockKeys.size).toBe(0);
    expect(layout.firstWorkBlockIndex).toBe(-1);
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

describe('buildAssistantTurnRenderLayout plan segments', () => {
  // Plan mode is a permission MODE, so the same ACP turn proposes the plan and
  // then implements it. One foldable region would bury the whole implementation
  // in the plan's "Worked for …" row.
  const planTurnItems: MessageContent[] = [
    tool('read-1', 'read', { locations: [{ path: 'src/a.ts' }] }),
    tool('grep-1', 'search'),
    { type: 'text', text: '# Plan\n1. Do the thing' },
    tool('switch-1', 'switch_mode', { title: 'Exited Plan Mode' }),
    { type: 'thought', text: 'Start with the parser.' },
    tool('edit-1', 'edit', { locations: [{ path: 'src/a.ts' }] }),
    { type: 'text', text: 'Done, changed 1 file.' },
  ];

  it('cuts a segment after the plan-exit card so approved work folds on its own', () => {
    const layout = buildAssistantTurnRenderLayout('assistant-1', planTurnItems, true);

    // [pre-plan activity] [plan text] [Exited Plan Mode] | [execution activity] [answer]
    expect(layout.blocks.map((block) => block.kind)).toEqual([
      'activity_group',
      'content',
      'content',
      'activity_group',
      'content',
    ]);
    expect(layout.segments.map((segment) => segment.blockRange)).toEqual([
      [0, 3],
      [3, 5],
    ]);

    const [planSegment, executionSegment] = layout.segments;
    if (!planSegment || !executionSegment) throw new Error('Expected two segments');

    // Plan segment: the pre-plan exploration folds, the plan and its card stay.
    expect(layout.blocks.map((block) => planSegment.workBlockKeys.has(block.key))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    // Execution segment: its own work folds, its own answer stays visible.
    expect(layout.blocks.map((block) => executionSegment.workBlockKeys.has(block.key))).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it('keeps one segment for an ordinary turn', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [tool('read-1', 'read'), { type: 'text', text: 'Done.' }],
      true
    );

    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]?.blockRange).toEqual([0, 2]);
  });

  it('does not open an empty trailing segment when the turn ends on the plan card', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        { type: 'text', text: '# Plan' },
        tool('switch-1', 'switch_mode', { title: 'Exited Plan Mode' }),
      ],
      true
    );

    expect(layout.segments.map((segment) => segment.blockRange)).toEqual([[0, 2]]);
  });

  it('keeps the segment shape while the turn is still streaming, folding nothing', () => {
    const layout = buildAssistantTurnRenderLayout('assistant-1', planTurnItems, false);

    expect(layout.segments.map((segment) => segment.blockRange)).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(layout.workBlockKeys.size).toBe(0);
  });
});
