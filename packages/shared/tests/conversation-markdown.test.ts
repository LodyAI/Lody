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

function toolCall(
  title: string,
  output: string,
  terminal = false,
  toolName?: string
): MessageContent {
  return {
    type: 'tool_call',
    toolCallId: `tool-${(nextId += 1)}`,
    title,
    toolName,
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
        toolCall(`Read src/file-${i}.ts`, `line ${i} `.repeat(outputChars / 8), false, 'Read'),
        toolCall(`Bash ${i}`, `stdout ${i} `.repeat(outputChars / 8), true, 'Bash'),
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
    expect(result.markdown).toMatch(/^## 1 · User · /m);
    expect(result.markdown).toMatch(/^## 1 · Assistant · /m);
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
    expect(result.stats.thinkingTruncated).toBe(false);
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
    // 66k CJK characters is under the character ceiling but ~66k tokens.
    const prose = '这是一段中文对话内容。'.repeat(6_000);
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

  it('pushes prose headings below the turn heading without touching fenced content', () => {
    const body = [
      '# Summary',
      '',
      '```bash',
      '# not a heading',
      '```',
      '',
      '###### already deepest',
    ].join('\n');

    const result = buildConversationMarkdown({ history: [entry('assistant', [textItem(body)])] });

    // `# Summary` would otherwise outrank `## Assistant` and destroy the outline.
    expect(result.markdown).toMatch(/^### Summary$/m);
    expect(result.markdown).not.toMatch(/^# Summary$/m);
    expect(result.markdown).toMatch(/^# not a heading$/m);
    expect(result.markdown).toMatch(/^###### already deepest$/m);
  });

  it('separates rounds and stamps assistant turns with model and working time', () => {
    const firstUser = entry('user', [textItem('first ask')]);
    firstUser.timestamp = '2026-09-08T14:32:00.000Z';
    const reply = entry('assistant', [textItem('first answer')]);
    reply.timestamp = '2026-09-08T14:32:10.000Z';
    reply.endedAt = Date.parse('2026-09-08T14:37:22.000Z');
    reply.permissionWaitMs = 60_000;
    reply.modelInfo = { modelId: 'opus-5', name: 'Opus 5' };
    const secondUser = entry('user', [textItem('second ask')]);
    secondUser.timestamp = '2026-09-08T15:00:00.000Z';

    const result = buildConversationMarkdown({
      history: [firstUser, reply, secondUser],
      source: 'LodyAI/Lody · feat/markdown',
    });

    expect(result.markdown).toMatch(/^## 1 · User · /m);
    // endedAt - timestamp - permissionWaitMs = 312s - 60s
    expect(result.markdown).toMatch(/^## 1 · Assistant · [^\n]*Opus 5 · 4m12s$/m);
    expect(result.markdown).toMatch(/^## 2 · User · /m);
    // One rule closes the header, one opens the second round — and no more.
    expect(result.markdown.match(/^---$/gm)).toHaveLength(2);
    expect(result.markdown).toMatch(/## 1 · Assistant[\s\S]*\n---\n\n## 2 · User/);
    expect(result.markdown).toContain('> LodyAI/Lody · feat/markdown');
    expect(result.markdown).toContain('> Models: Opus 5');
  });

  it('names speakers only when more than one human is in the conversation', () => {
    const solo = entry('user', [textItem('solo ask')]);
    solo.userId = 'user-ada';
    const participants = { 'user-ada': 'Ada', 'user-bo': 'Bo' };

    const soloResult = buildConversationMarkdown({ history: [solo], participants });
    expect(soloResult.markdown).not.toContain('Ada');
    expect(soloResult.markdown).not.toContain('Participants:');

    const ada = entry('user', [textItem('ada ask')]);
    ada.userId = 'user-ada';
    const bo = entry('user', [textItem('bo ask')]);
    bo.userId = 'user-bo';
    const sharedResult = buildConversationMarkdown({ history: [ada, bo], participants });

    expect(sharedResult.markdown).toMatch(/^## 1 · User · Ada · /m);
    expect(sharedResult.markdown).toMatch(/^## 2 · User · Bo · /m);
    expect(sharedResult.markdown).toContain('> Participants: Ada, Bo');
  });

  it('collapses tool calls into one counted per-turn summary before capping thinking', () => {
    const history: SessionHistoryInput[] = [];
    for (let i = 0; i < 20; i += 1) {
      history.push(entry('user', [textItem(`Question ${i}`)]));
      history.push(
        entry('assistant', [
          { type: 'thought', text: `reasoning ${i} `.repeat(12) },
          toolCall(`Read src/file-${i}.ts`, 'x'.repeat(20_000), false, 'Read'),
          toolCall(`Bash ${i}`, 'y'.repeat(20_000), true, 'Bash'),
          textItem(`Answer ${i}`),
        ])
      );
    }

    // Squeezed budget: enough for prose + thinking + a summary, not for tool bodies.
    const result = buildConversationMarkdown({ history, maxChars: 11_000, maxTokens: 100_000 });

    expect(result.stats.toolCallsCollapsed).toBe(true);
    expect(result.stats.thinkingTruncated).toBe(false);
    expect(result.markdown).toContain('2 tool calls (details omitted)');
    expect(result.markdown).toContain('`Bash` ×1 · `Read` ×1');
    // Every turn's reasoning survives the collapse untouched.
    for (let i = 0; i < 20; i += 1) {
      expect(result.markdown).toContain(`reasoning ${i} reasoning ${i}`);
    }
    // The old floor wrote one bold line per call; nothing should reintroduce it.
    expect(result.markdown).not.toContain('- **Read src/file-0.ts**');
  });

  it('caps thinking instead of dropping it when collapsed tool calls still do not fit', () => {
    const history: SessionHistoryInput[] = [];
    for (let i = 0; i < 12; i += 1) {
      history.push(entry('user', [textItem(`Q${i}`)]));
      history.push(
        entry('assistant', [
          { type: 'thought', text: `deliberating ${i} `.repeat(600) },
          toolCall(`Read ${i}`, 'x'.repeat(5_000), false, 'Read'),
          textItem(`A${i}`),
        ])
      );
    }

    const result = buildConversationMarkdown({ history, maxChars: 30_000, maxTokens: 100_000 });

    expect(result.stats.thinkingTruncated).toBe(true);
    // Capped, never gone: the receiving conversation still inherits the reasoning.
    expect(result.markdown).toContain('Thinking (from the original session)');
    expect(result.markdown).toContain('characters elided');
    expect(result.markdown).toContain('deliberating 0 deliberating');
    expect(result.markdown).toContain('deliberating 11 deliberating');
  });

  it('puts the trim notice in the header, before anything it describes', () => {
    const result = buildConversationMarkdown({ history: heavyHistory(30, 8_000) });

    const notice = result.markdown.indexOf('Trimmed to fit the copy budget');
    const firstTurn = result.markdown.indexOf('## 1 · User');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(firstTurn);
  });

  it('says results are gone when tool calls collapse, not just that they collapsed', () => {
    const result = buildConversationMarkdown({
      history: heavyHistory(20, 8_000),
      maxChars: 9_000,
      maxTokens: 100_000,
    });

    expect(result.stats.toolCallsCollapsed).toBe(true);
    // A collapsed call never reaches the block renderer, so the per-block tallies
    // stay at zero; the notice has to state the loss itself.
    expect(result.markdown).toContain('results and terminal output omitted');
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

    expect(result.markdown).toContain('## Files referenced (from tool call locations)');
    expect(result.markdown).toContain('`src/a.ts`');
    expect(result.stats.pathsCount).toBe(1);
  });
});
