import { describe, expect, it } from 'vitest';
import {
  buildConversationMarkdown,
  collectConversationMessages,
  estimateTokenCount,
  CONVERSATION_MARKDOWN_MAX_CHARS,
  CONVERSATION_MARKDOWN_MAX_TOKENS,
} from '../src/conversation-markdown';
import type { MessageContent } from '../src/ai';
import type { SessionHistoryInput } from '../src/schema';

let nextId = 0;

function entry(
  role: 'user' | 'assistant' | 'system',
  items: MessageContent[]
): SessionHistoryInput {
  nextId += 1;
  return {
    id: `entry-${nextId}`,
    role,
    timestamp: nextId,
    fileDiff: [],
    items: items as SessionHistoryInput['items'],
  } as SessionHistoryInput;
}

function textItem(text: string): MessageContent {
  return { type: 'text', text };
}

function toolCall(title: string, output: string, terminal = false): MessageContent {
  return {
    type: 'tool_call',
    toolCallId: `tool-${(nextId += 1)}`,
    title,
    status: 'completed',
    kind: 'other',
    content: terminal
      ? [
          { type: 'terminal_command', command: 'npm', args: ['install'] },
          { type: 'terminal_output', output },
        ]
      : [{ type: 'content', content: { type: 'text', text: output } }],
  } as MessageContent;
}

/** A conversation whose bulk is tool output, not prose. */
function heavyHistory(turns: number, outputChars: number): SessionHistoryInput[] {
  const history: SessionHistoryInput[] = [];
  for (let i = 0; i < turns; i += 1) {
    history.push(entry('user', [textItem(`Question ${i}`)]));
    history.push(
      entry('assistant', [
        { type: 'thought', text: `deliberating ${i} `.repeat(200) },
        toolCall(`Read src/file-${i}.ts`, `line ${i} `.repeat(outputChars / 8)),
        toolCall(`Bash ${i}`, `stdout ${i} `.repeat(outputChars / 8), true),
        textItem(`Answer ${i}`),
      ])
    );
  }
  return history;
}

describe('estimateTokenCount', () => {
  it('counts latin text at roughly four characters per token', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
  });

  it('counts CJK at roughly one token per character', () => {
    expect(estimateTokenCount('中文测试'.repeat(100))).toBe(400);
  });
});

describe('share message token estimates', () => {
  it('preserves the recorded model instead of substituting another turn configuration', () => {
    const recorded = entry('assistant', [textItem('Answer')]);
    recorded.modelInfo = { modelId: 'recorded-model', name: 'Recorded Model' };
    recorded.inputConfig = { modelId: 'requested-model' };
    const legacy = entry('assistant', [textItem('Legacy answer')]);
    legacy.inputConfig = { modelId: 'legacy-model' };
    const unknown = entry('assistant', [textItem('Unknown model')]);
    expect(
      collectConversationMessages([recorded, legacy, unknown]).map((message) => message.modelName)
    ).toEqual(['Recorded Model', 'legacy-model', undefined]);
  });

  it('keeps the card prose-only while counting folded thinking, plans and tool output', () => {
    const history = [
      entry('assistant', [
        { type: 'thought', text: 't'.repeat(400) },
        {
          type: 'plan',
          entries: [{ content: 'p'.repeat(40), status: 'completed', priority: 'medium' }],
        },
        {
          type: 'proposed_plan',
          turnId: 'turn',
          markdown: 'm'.repeat(40),
          status: 'completed',
          isLatest: true,
        },
        toolCall('Read', 'o'.repeat(4000)),
        textItem('Done'),
      ]),
    ];
    const [message] = collectConversationMessages(history);
    expect(message?.text).toBe('Done');
    expect(message?.estimatedTokens).toBe(1122);
    expect(JSON.stringify(message)).not.toContain('o'.repeat(40));
  });

  it('counts terminal and diff content without counting a duplicate raw output', () => {
    const item: MessageContent = {
      type: 'tool_call',
      toolCallId: 'tool-count',
      title: 'Edit',
      status: 'completed',
      rawInput: { command: 'test' },
      rawOutput: { duplicate: 'x'.repeat(10000) },
      content: [
        { type: 'terminal_command', command: 'test' },
        { type: 'terminal_output', output: 'o'.repeat(400) },
        { type: 'diff', path: 'file', oldText: 'a'.repeat(40), newText: 'b'.repeat(80) },
      ],
    };
    const [message] = collectConversationMessages([entry('assistant', [item, textItem('Done')])]);
    expect(message?.estimatedTokens).toBe(
      133 + estimateTokenCount(JSON.stringify({ command: 'test' }))
    );
  });

  it('keeps estimates on their own messages and counts raw output without display blocks', () => {
    const first = entry('assistant', [{ type: 'thought', text: '中文测试' }, textItem('Done')]);
    const second = entry('assistant', [
      {
        type: 'tool_call',
        toolCallId: 'raw',
        title: 'Tool',
        status: 'completed',
        rawOutput: { result: 'x'.repeat(400) },
      },
      textItem('Next'),
    ]);
    const result = collectConversationMessages([first, second]);
    expect(result[0]?.estimatedTokens).toBe(5);
    expect(result[1]?.estimatedTokens).toBe(
      2 + estimateTokenCount(JSON.stringify({ result: 'x'.repeat(400) }))
    );
  });
});

describe('buildConversationMarkdown', () => {
  it('renders real Markdown headings and a title', () => {
    const result = buildConversationMarkdown({
      title: 'My session',
      history: [entry('user', [textItem('hello')]), entry('assistant', [textItem('hi there')])],
    });

    expect(result.markdown).toContain('# My session');
    expect(result.markdown).toContain('## User');
    expect(result.markdown).toContain('## Assistant');
    expect(result.markdown).toContain('hello');
    expect(result.markdown).toContain('hi there');
    expect(result.stats.entryCount).toBe(2);
    expect(result.stats.overBudget).toBe(false);
  });

  it('keeps everything for a small conversation and reports no trimming', () => {
    const result = buildConversationMarkdown({
      history: [
        entry('user', [textItem('run the tests')]),
        entry('assistant', [
          { type: 'thought', text: 'thinking about it' },
          toolCall('Bash', 'all tests passed', true),
          textItem('Done.'),
        ]),
      ],
    });

    expect(result.markdown).toContain('thinking about it');
    expect(result.markdown).toContain('all tests passed');
    expect(result.stats.thinkingOmitted).toBe(false);
    expect(result.stats.terminalOutputOmitted).toBe(false);
    expect(result.stats.toolCallsCollapsed).toBe(false);
    expect(result.markdown).not.toContain('Trimmed to fit');
  });

  it('trims tool output down to the character and token budget', () => {
    const result = buildConversationMarkdown({ history: heavyHistory(12, 8_000) });

    expect(result.markdown.length).toBeLessThanOrEqual(CONVERSATION_MARKDOWN_MAX_CHARS);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(CONVERSATION_MARKDOWN_MAX_TOKENS);
    expect(result.stats.overBudget).toBe(false);
    expect(result.markdown).toContain('Trimmed to fit');
  });

  it('never drops message text, even when tool output has to go', () => {
    const history = heavyHistory(12, 8_000);
    const result = buildConversationMarkdown({ history });

    for (let i = 0; i < 12; i += 1) {
      expect(result.markdown).toContain(`Question ${i}`);
      expect(result.markdown).toContain(`Answer ${i}`);
    }
  });

  it('degrades older turns before recent ones', () => {
    const result = buildConversationMarkdown({
      history: heavyHistory(12, 8_000),
      recentEntryCount: 4,
    });

    /** The `<details>` body following a tool summary. */
    const toolBody = (summary: string): string => {
      const start = result.markdown.indexOf(summary);
      expect(start).toBeGreaterThan(-1);
      const end = result.markdown.indexOf('</details>', start);
      return result.markdown.slice(start, end === -1 ? undefined : end);
    };

    // The newest turn keeps its tool output whole; the oldest one is elided.
    expect(toolBody('Read src/file-11.ts')).not.toContain('characters elided');
    expect(toolBody('Read src/file-0.ts')).toContain('characters elided');
  });

  it('reports overBudget instead of cutting prose that alone exceeds the budget', () => {
    const prose = 'word '.repeat(30_000); // ~150k chars of pure message text
    const result = buildConversationMarkdown({
      history: [entry('user', [textItem(prose)]), entry('assistant', [textItem(prose)])],
    });

    expect(result.stats.overBudget).toBe(true);
    expect(result.markdown.length).toBeGreaterThan(CONVERSATION_MARKDOWN_MAX_CHARS);
    expect(result.markdown.split(prose).length - 1).toBe(2);
  });

  it('applies the same budget to CJK prose using the token estimate', () => {
    // 30k CJK characters is under the character ceiling but ~30k tokens.
    const prose = '这是一段中文对话内容。'.repeat(3_000);
    const result = buildConversationMarkdown({
      history: [entry('user', [textItem(prose)])],
    });

    expect(result.markdown.length).toBeLessThan(CONVERSATION_MARKDOWN_MAX_CHARS);
    expect(result.stats.estimatedTokens).toBeGreaterThan(CONVERSATION_MARKDOWN_MAX_TOKENS);
    expect(result.stats.overBudget).toBe(true);
  });

  it('redacts secrets that appear in terminal output', () => {
    const result = buildConversationMarkdown({
      history: [entry('assistant', [toolCall('Bash', `token ghp_${'a'.repeat(30)} used`, true)])],
    });

    expect(result.markdown).toContain('ghp_***');
    expect(result.markdown).not.toContain(`ghp_${'a'.repeat(30)}`);
  });

  it('fences tool output that itself contains code fences', () => {
    const result = buildConversationMarkdown({
      history: [entry('assistant', [toolCall('Read', '```ts\nconst a = 1;\n```')])],
    });

    expect(result.markdown).toContain('````');
  });

  it('skips system entries and empty turns', () => {
    const result = buildConversationMarkdown({
      history: [
        entry('system', [textItem('system notice')]),
        entry('assistant', []),
        entry('user', [textItem('only this')]),
      ],
    });

    expect(result.markdown).not.toContain('system notice');
    expect(result.stats.entryCount).toBe(1);
  });

  it('lists referenced files', () => {
    const call = {
      type: 'tool_call',
      toolCallId: 'tool-x',
      title: 'Edit',
      status: 'completed',
      kind: 'edit',
      locations: [{ path: 'src/a.ts' }],
    } as MessageContent;

    const result = buildConversationMarkdown({ history: [entry('assistant', [call])] });

    expect(result.markdown).toContain('## Files referenced');
    expect(result.markdown).toContain('`src/a.ts`');
    expect(result.stats.pathsCount).toBe(1);
  });
});
