import type { MessageContent } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import {
  getUserTextRenderSlice,
  getTextContentFromMessageItems,
  getVisibleAssistantTextContent,
  hasTextContentFromMessageItems,
  USER_TEXT_RENDER_CHAR_LIMIT,
  USER_TEXT_RENDER_LINE_LIMIT,
  shouldCollapseAssistantMessageItem,
} from '../src/components/ai-gui/message-copy';

const text = (value: string): MessageContent => ({ type: 'text', text: value });

describe('getTextContentFromMessageItems', () => {
  it('joins non-empty text items and keeps non-blank text intact', () => {
    expect(
      getTextContentFromMessageItems([text('hidden progress'), text('   '), text('final reply')])
    ).toBe('hidden progress\n\nfinal reply');
  });
});

describe('hasTextContentFromMessageItems', () => {
  it('detects copyable text without joining all text content', () => {
    expect(hasTextContentFromMessageItems([text('   ')])).toBe(false);
    expect(hasTextContentFromMessageItems([text('   '), text('hello')])).toBe(true);
  });
});

describe('getUserTextRenderSlice', () => {
  it('keeps short user text unchanged', () => {
    expect(getUserTextRenderSlice('short prompt')).toEqual({
      text: 'short prompt',
      isTruncated: false,
    });
  });

  it('truncates long user text by character count before rendering', () => {
    const value = 'a'.repeat(USER_TEXT_RENDER_CHAR_LIMIT + 5);

    expect(getUserTextRenderSlice(value)).toEqual({
      text: 'a'.repeat(USER_TEXT_RENDER_CHAR_LIMIT),
      isTruncated: true,
    });
  });

  it('truncates long user text by visible line count before rendering', () => {
    const lines = Array.from({ length: USER_TEXT_RENDER_LINE_LIMIT + 1 }, (_, index) => {
      return `line ${index + 1}`;
    });

    expect(getUserTextRenderSlice(lines.join('\n'))).toEqual({
      text: lines.slice(0, USER_TEXT_RENDER_LINE_LIMIT).join('\n'),
      isTruncated: true,
    });
  });
});

describe('getVisibleAssistantTextContent', () => {
  it('copies all assistant text while the turn is still working', () => {
    const items = [text('progress note'), text('streaming answer')];

    expect(getVisibleAssistantTextContent(items, false)).toBe('progress note\n\nstreaming answer');
  });

  it('copies only text outside the Finished working group for a finished turn', () => {
    const items = [
      text('hidden progress'),
      { type: 'thought', text: 'hidden thought' } satisfies MessageContent,
      text('visible response'),
    ];

    expect(getVisibleAssistantTextContent(items, true)).toBe('visible response');
  });

  it('keeps the last text visible when generated images are appended after it', () => {
    const items = [
      text('hidden progress'),
      text('visible response'),
      {
        type: 'image_group',
        images: [
          {
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 123,
          },
        ],
      },
    ] satisfies MessageContent[];

    expect(getVisibleAssistantTextContent(items, true)).toBe('visible response');
  });

  it('returns no text when a finished turn only has text inside the collapsed work group', () => {
    const items = [
      text('hidden progress'),
      { type: 'tool_call', toolCallId: 'call-1', status: 'completed' } satisfies MessageContent,
    ];

    expect(getVisibleAssistantTextContent(items, true)).toBe('');
  });
});

describe('shouldCollapseAssistantMessageItem', () => {
  it('uses the same finished-turn boundary as the message view', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'image_group',
        images: [
          {
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 123,
          },
        ],
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('keeps the text immediately before trailing image groups outside the work group', () => {
    const items = [
      text('hidden progress'),
      text('visible response'),
      {
        type: 'image_group',
        images: [
          {
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 123,
          },
        ],
      },
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('does not collapse switch_mode tool calls (Exited Plan Mode)', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'tool_call',
        toolCallId: 'call-plan',
        status: 'completed',
        kind: 'switch_mode',
        title: 'Exited Plan Mode',
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('keeps the plan visible when Exited Plan Mode ends the turn', () => {
    // Approving a plan splits the ACP turn (CLI `rollAssistantEntryForPlanExit`),
    // so the plan turn ends on the switch card. The plan is that turn's answer
    // and must not be folded away as progress output.
    const items = [
      text('progress note'),
      text('# Plan\n1. Do the thing'),
      {
        type: 'tool_call',
        toolCallId: 'call-plan',
        status: 'completed',
        kind: 'switch_mode',
        title: 'Exited Plan Mode',
      },
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('does not collapse plan blocks', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'plan',
        entries: [{ title: 'Check the implementation', priority: 'high' }],
      },
      {
        type: 'tool_call',
        toolCallId: 'request-1',
        title: 'Request input',
        status: 'pending',
        kind: 'request_user_input',
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      shouldCollapseAssistantMessageItem({
        content: items[1]!,
        index: 1,
        items,
        isTurnFinished: true,
      })
    ).toBe(false);
  });

  it('does not collapse assistant file blocks', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'file',
        fileId: 'file-1',
        fileName: 'agent-output.patch',
        mimeType: 'text/plain',
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        textPreview: true,
        transport: 'r2',
        uploadedAt: 1_000,
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('does not collapse goal blocks', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'goal',
        threadId: 'thread-1',
        turnId: null,
        objective: 'ship it',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 2,
        createdAt: 100,
        updatedAt: 200,
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });

  it('does not collapse proposed plan blocks', () => {
    const items = [
      text('hidden progress'),
      {
        type: 'proposed_plan',
        turnId: 'turn-plan',
        markdown: '- Inspect code\n- Render the plan card',
        status: 'completed',
        isLatest: true,
      },
      text('visible response'),
    ] satisfies MessageContent[];

    expect(
      items.map((content, index) =>
        shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished: true,
        })
      )
    ).toEqual([true, false, false]);
  });
});
