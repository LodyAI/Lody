import { describe, expect, it } from 'vitest';
import {
  type MessageContent,
  applyNotificationOnHistory,
  parseSessionNotifications,
  type SessionHistoryParsed,
  type SessionId,
} from '@lody/shared';
import { buildAssistantTurnRenderLayout } from '../src/components/ai-gui/assistant-turn-render-blocks';
import { buildAssistantMessageRenderItems } from '../src/components/ai-gui/assistant-message-render-items';
import {
  collectSessionImageGalleryEntries,
  createSessionImageGalleryEntry,
  findSessionImageGalleryEntryIndex,
} from '../src/lib/session-image-gallery';

describe('assistant-turn-render-blocks', () => {
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
    it('groups alternating thoughts and tools, counting tools across thoughts', () => {
      const items: MessageContent[] = [
        tool('command-1', 'execute'),
        { type: 'thought', text: 'Inspect the command result.' },
        tool('command-2', 'execute'),
        { type: 'thought', text: 'Read the source next.' },
        tool('read-1', 'read', { locations: [{ path: '/project/source.ts' }] }),
        { type: 'thought', text: 'Ready to answer.' },
        { type: 'text', text: 'Answer' },
      ];
      const layout = buildAssistantTurnRenderLayout('mixed', items, false);
      expect(layout.blocks).toHaveLength(2);
      expect(layout.blocks[0]).toMatchObject({
        kind: 'activity_group',
        entries: items.slice(0, 6).map((content, itemIndex) => ({ content, itemIndex })),
        summary: { hasThought: true, commandCount: 2, readFileCount: 1 },
      });
      expect(layout.blocks[1]).toMatchObject({ kind: 'content', entry: { content: items[6] } });
    });

    it('folds earlier text and activity while keeping the final text run visible', () => {
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

    it('folds earlier text when the agent continues working and sends a later answer', () => {
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
        true,
        true,
        false,
      ]);
    });

    it('keeps every adjacent trailing text block regardless of phase', () => {
      const layout = buildAssistantTurnRenderLayout(
        'tail',
        [
          { type: 'text', text: 'Earlier' },
          tool('read', 'read'),
          { type: 'text', text: 'First answer part' },
          { type: 'text', text: 'Second answer part', messagePhase: 'commentary' },
          {
            type: 'image_group',
            images: [{ imageId: 'generated', mimeType: 'image/png', sizeBytes: 123 }],
          },
        ],
        true
      );
      expect(layout.blocks.map((block) => layout.workBlockKeys.has(block.key))).toEqual([
        true,
        true,
        false,
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
});

describe('worked-group-collapse-gate', () => {
  // Guards the load-bearing invariant behind view.tsx `shouldUseWorkedGroup`: a finished
  // turn is folded into a "Worked for …" summary ONLY when it has something visible left
  // outside `workBlockKeys`. Activity groups fold unconditionally, so an interrupted or
  // cancelled turn that ends mid-tool with no prose must have NO visible tail and must
  // stay expanded. See packages/components/src/components/ai-gui/AGENTS.md
  // ("Worked for …" collapse gate).
  const text = (value: string): MessageContent => ({ type: 'text', text: value }) as MessageContent;

  let toolSeq = 0;
  const toolCall = (): MessageContent =>
    ({
      type: 'tool_call',
      toolCallId: `tool-${(toolSeq += 1)}`,
      status: 'completed',
      title: 'ran a tool',
    }) as unknown as MessageContent;

  // Mirror of the gate predicate in view.tsx.
  const hasVisibleFinalContent = (items: MessageContent[], isTurnFinished: boolean): boolean => {
    const { blocks, workBlockKeys } = buildAssistantTurnRenderLayout('m1', items, isTurnFinished);
    return blocks.some((block) => !workBlockKeys.has(block.key));
  };

  describe('Worked for … collapse gate (buildAssistantTurnRenderLayout)', () => {
    it('interrupted turn with only tool work and no final text has no visible tail → do not collapse', () => {
      // e.g. cancelled/agent-disconnected mid-tool: CLI still marks finished=true.
      expect(hasVisibleFinalContent([toolCall(), toolCall()], true)).toBe(false);
    });

    it('normal turn ending with a text answer keeps that answer as a visible tail → collapse', () => {
      expect(hasVisibleFinalContent([toolCall(), toolCall(), text('all done')], true)).toBe(true);
    });

    it('text followed by unfinished tool work has no answer tail → do not collapse', () => {
      expect(hasVisibleFinalContent([text('the answer'), toolCall()], true)).toBe(false);
    });

    it('streaming turn keeps its work region so the reader can fold it, with no visible tail', () => {
      const { workBlockKeys } = buildAssistantTurnRenderLayout(
        'm1',
        [toolCall(), toolCall()],
        false
      );
      expect(workBlockKeys.size).toBe(1);
    });
  });
});

describe('adapter-fold-parity', () => {
  /**
   * Every ACP adapter uses the same completed-turn tail rule. This runs each shape through the real ingest and the real
   * fold so a future folding change cannot regress a provider that looks fine today.
   */
  const visibleTexts = (items: MessageContent[]): string[] => {
    const layout = buildAssistantTurnRenderLayout('message-1', items, true);
    const texts: string[] = [];
    for (const block of layout.blocks) {
      if (layout.workBlockKeys.has(block.key)) continue;
      if (block.kind !== 'content') continue;
      if (block.entry.content.type !== 'text') continue;
      texts.push(block.entry.content.text);
    }
    return texts;
  };

  const ingest = (updates: unknown[]): MessageContent[] => {
    const notifications = parseSessionNotifications(
      updates.map((update) => ({ sessionId: 'session-1', update }))
    );
    const history = applyNotificationOnHistory([], notifications);
    const items = history[0]?.items;
    return Array.isArray(items) ? (items as MessageContent[]) : [];
  };

  const text = (value: string, messagePhase?: 'commentary' | 'final_answer') => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: value },
    ...(messagePhase === undefined ? {} : { _meta: { lody: { messagePhase } } }),
  });

  const toolCall = (id: string) => ({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'Read src/parser.ts',
    kind: 'read',
    status: 'completed',
    locations: [{ path: 'src/parser.ts' }],
  });

  describe('assistant text folding across adapter shapes', () => {
    it('folds earlier prose and keeps the last answer (Claude/Pi/Sorbet deltas)', () => {
      const items = ingest([text('The bug is in the parser.'), toolCall('call-1'), text('Done.')]);

      expect(visibleTexts(items)).toEqual(['Done.']);
    });

    it('folds explicit commentary while keeping the answer visible (Codex)', () => {
      const items = ingest([
        text('Checking the parser.', 'commentary'),
        toolCall('call-1'),
        text('The bug is in the parser.', 'final_answer'),
      ]);

      expect(visibleTexts(items)).toEqual(['The bug is in the parser.']);
    });

    it('still folds the tool work of a finished turn', () => {
      const items = ingest([text('Looking at the parser.'), toolCall('call-1'), text('Fixed.')]);
      const layout = buildAssistantTurnRenderLayout('message-1', items, true);

      expect(layout.blocks.some((block) => block.kind === 'activity_group')).toBe(true);
      expect(layout.workBlockKeys.size).toBeGreaterThan(0);
    });
  });
});

describe('assistant-message-render-items', () => {
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

      expect(buildAssistantMessageRenderItems(attachmentsFirst).map((i) => i.content.type)).toEqual(
        ['proposed_plan', 'image_group', 'file']
      );

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
});
