import type { MachineId, MessageContent, ToolCallRef } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import {
  isMessageContent,
  normalizeMessageContent,
} from '../src/components/ai-gui/message-content-guards';
import {
  buildAssistantTurnRenderBlocks,
  buildAssistantTurnRenderLayout,
} from '../src/components/ai-gui/assistant-turn-render-blocks';
import {
  getCopyTextFromMessageItems,
  getVisibleAssistantTextContent,
  hasTextContentFromMessageItems,
} from '../src/components/ai-gui/message-copy';
import { getToolCallStableId, isToolCallRef, isToolCallSkeleton } from '../src/components/ai-gui/tool-call-skeleton';

const ref = (overrides: Partial<ToolCallRef> = {}): ToolCallRef => ({
  machineId: 'machine-1' as MachineId,
  turnId: 'turn-1',
  index: 0,
  ...overrides,
});

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

/**
 * A sealed skeleton as writers persist it: no `toolCallId`, no `content`, no
 * `rawInput`/`rawOutput` — the type still declares `toolCallId` required, so
 * the fixture crosses `unknown` exactly like parsed history does.
 */
const skeletonTool = (
  kind: ToolCallMessage['kind'],
  overrides: Record<string, unknown> = {}
): MessageContent =>
  ({
    type: 'tool_call',
    kind,
    status: 'completed',
    ref: ref(),
    ...overrides,
  }) as unknown as MessageContent;

describe('sealed tool_call skeletons in message content guards', () => {
  it('accepts a skeleton with a valid ref and no toolCallId or content', () => {
    expect(isMessageContent(skeletonTool('execute', { title: 'pnpm test' }))).toBe(true);
    expect(normalizeMessageContent(skeletonTool('read'))).not.toBeNull();
  });

  it('still accepts a full tool_call with toolCallId and content', () => {
    expect(
      isMessageContent({
        type: 'tool_call',
        toolCallId: 'call-1',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: 'src/view.tsx', newText: 'next' }],
      })
    ).toBe(true);
  });

  it('accepts a full tool_call that also carries a ref', () => {
    expect(
      isMessageContent({
        type: 'tool_call',
        toolCallId: 'call-1',
        status: 'completed',
        ref: ref(),
      })
    ).toBe(true);
  });

  it('rejects tool_call garbage: no identity, no status, or a malformed ref', () => {
    expect(isMessageContent({ type: 'tool_call', status: 'completed' })).toBe(false);
    expect(isMessageContent({ type: 'tool_call', ref: ref() })).toBe(false);
    expect(
      isMessageContent({
        type: 'tool_call',
        status: 'completed',
        ref: { machineId: 'machine-1', turnId: 'turn-1' },
      })
    ).toBe(false);
    expect(
      isMessageContent({ type: 'tool_call', status: 'completed', toolCallId: 42 })
    ).toBe(false);
  });
});

describe('sealed tool_call skeletons in activity counting', () => {
  it('counts activity from kind/status and locations without reading content', () => {
    const blocks = buildAssistantTurnRenderBlocks('assistant-1', [
      skeletonTool('execute'),
      skeletonTool('read', { ref: ref({ index: 1 }), locations: [{ path: 'src/view.tsx' }] }),
      skeletonTool('edit', { ref: ref({ index: 2 }), locations: [{ path: 'src/view.tsx' }] }),
      skeletonTool('search', { ref: ref({ index: 3 }), status: 'failed' }),
    ]);

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.kind).toBe('activity_group');
    if (block?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(block.summary).toMatchObject({
      commandCount: 1,
      readFileCount: 1,
      editFileCount: 1,
      searchCount: 1,
      otherCount: 0,
    });
  });

  it('keeps group keys stable for skeletons that have no toolCallId', () => {
    const initial = buildAssistantTurnRenderBlocks('assistant-1', [skeletonTool('execute')]);
    const updated = buildAssistantTurnRenderBlocks('assistant-1', [
      skeletonTool('execute'),
      skeletonTool('read', { ref: ref({ index: 1 }) }),
    ]);

    expect(initial[0]?.key).toBe(updated[0]?.key);
    expect(initial[0]?.key).not.toContain('undefined');
  });

  it('derives edited paths from locations when content is absent', () => {
    const layout = buildAssistantTurnRenderLayout(
      'assistant-1',
      [
        skeletonTool('edit', { locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }),
        { type: 'text', text: 'Done.' },
      ],
      true
    );

    const group = layout.blocks.find((block) => block.kind === 'activity_group');
    if (group?.kind !== 'activity_group') throw new Error('Expected activity group');
    expect(group.summary.editFileCount).toBe(2);
  });
});

describe('sealed tool_call skeletons in message copy', () => {
  it('copies only the text items of a turn that contains skeletons', () => {
    const items: MessageContent[] = [skeletonTool('execute'), { type: 'text', text: 'All done.' }];

    expect(getCopyTextFromMessageItems(items)).toBe('All done.');
    expect(getVisibleAssistantTextContent(items, true)).toBe('All done.');
    expect(hasTextContentFromMessageItems([skeletonTool('execute')])).toBe(false);
  });
});

describe('tool-call skeleton helpers', () => {
  it('recognizes refs and skeletons at runtime', () => {
    expect(isToolCallRef(ref())).toBe(true);
    expect(isToolCallRef({ machineId: 'm', turnId: 't' })).toBe(false);
    expect(isToolCallRef(null)).toBe(false);

    const skeleton = skeletonTool('execute');
    if (skeleton.type !== 'tool_call') throw new Error('Expected tool_call');
    expect(isToolCallSkeleton(skeleton)).toBe(true);
    expect(
      isToolCallSkeleton({
        type: 'tool_call',
        toolCallId: 'call-1',
        status: 'completed',
      })
    ).toBe(false);
  });

  it('falls back to the ref when a skeleton has no toolCallId', () => {
    const skeleton = skeletonTool('execute');
    if (skeleton.type !== 'tool_call') throw new Error('Expected tool_call');
    expect(getToolCallStableId(skeleton)).toBe('ref:machine-1:turn-1:0');
    expect(
      getToolCallStableId({ type: 'tool_call', toolCallId: 'call-1', status: 'completed' })
    ).toBe('call-1');
  });
});
