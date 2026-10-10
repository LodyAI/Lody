// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import {
  SearchHighlightedText,
  SessionSearchProvider,
  type SessionSearchBlockMatch,
} from '../src/components/sessions/session-search-context';
import type { MessageContent, SessionHistory } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionSearchResults,
  buildSessionSearchTextParts,
  extractSearchBlocksForMessage,
  extractSessionSearchBlocks,
  getSearchableMarkdownText,
  getProposedPlanSearchBlockId,
  getTextSearchBlockId,
  getThoughtSearchBlockId,
  normalizeSessionSearchQuery,
} from '../src/lib/session-chat-search';

const worktreeId = '01234567-89ab-cdef-0123-456789abcdef';
const worktreeRoot = `/workspaces/github---example---project/worktrees/${worktreeId}`;

const buildMessage = (
  overrides: Partial<SessionHistory> & Pick<SessionHistory, 'id' | 'items'>
): SessionHistory => ({
  id: overrides.id,
  role: overrides.role ?? 'assistant',
  timestamp: overrides.timestamp ?? '2026-04-10T00:00:00.000Z',
  read: overrides.read ?? true,
  userId: overrides.userId,
  userTurnId: overrides.userTurnId,
  items: overrides.items,
  fileDiff: overrides.fileDiff,
  finished: overrides.finished,
  modelInfo: overrides.modelInfo,
  plan: overrides.plan,
  endedAt: overrides.endedAt,
});

describe('extractSessionSearchBlocks', () => {
  it('indexes user text, assistant markdown, thinking, and proposed plans', () => {
    const history: SessionHistory[] = [
      buildMessage({
        id: 'user-1',
        role: 'user',
        items: [{ type: 'text', text: 'Please rg for the config file' }],
      }),
      buildMessage({
        id: 'assistant-1',
        items: [
          {
            type: 'text',
            text: '## Result\nFound [`rg`](https://example.com) docs.',
          },
          {
            type: 'thought',
            text: 'Maybe inspect `packages/components` next.',
          },
          {
            type: 'proposed_plan',
            status: 'completed',
            markdown: '- Update the `rg` invocation',
          } satisfies MessageContent,
        ],
      }),
    ];

    expect(extractSessionSearchBlocks(history)).toEqual([
      expect.objectContaining({
        blockId: getTextSearchBlockId('user-1', 0),
        blockType: 'user_text',
        text: 'Please rg for the config file',
      }),
      expect.objectContaining({
        blockId: getTextSearchBlockId('assistant-1', 0),
        blockType: 'assistant_markdown',
        text: 'Result\nFound rg docs.',
      }),
      expect.objectContaining({
        blockId: getThoughtSearchBlockId('assistant-1', 1),
        blockType: 'thought',
        text: 'Maybe inspect packages/components next.',
      }),
      expect.objectContaining({
        blockId: getProposedPlanSearchBlockId('assistant-1', 2),
        blockType: 'assistant_markdown',
        text: 'Update the rg invocation',
      }),
    ]);
  });

  // Tool calls are agent-API payloads, not conversation prose. Indexing their
  // titles/paths/JSON/terminal output/diffs drowned real matches in noise.
  it('never indexes tool call titles, paths, output, terminals, or diffs', () => {
    const history: SessionHistory[] = [
      buildMessage({
        id: 'assistant-tools',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            status: 'completed',
            kind: 'execute',
            title: 'Run rg config',
            locations: [{ path: `${worktreeRoot}/packages/components/src/index.ts` }],
            rawInput: { command: 'rg config' },
            rawOutput: { summary: 'rg found 2 matches' },
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'rg "config" packages/components' },
              },
              {
                type: 'terminal_command',
                command: `${worktreeRoot}/bin/rg`,
                args: ['config', 'packages/components'],
              },
              {
                type: 'terminal_output',
                output: 'packages/components/src/index.ts: rg match',
              },
            ],
          } satisfies MessageContent,
          {
            type: 'tool_call',
            toolCallId: 'tool-2',
            status: 'completed',
            kind: 'edit',
            content: [
              {
                type: 'diff',
                path: `${worktreeRoot}/packages/components/src/search.ts`,
                oldText: 'const oldValue = 1;',
                newText: 'const newValue = 2;',
              },
            ],
          } satisfies MessageContent,
        ],
      }),
    ];

    expect(extractSessionSearchBlocks(history)).toEqual([]);
  });

  it('ignores plan checklists, goals, and worktree script output', () => {
    const history: SessionHistory[] = [
      buildMessage({
        id: 'assistant-status',
        items: [
          {
            type: 'plan',
            entries: [
              {
                content: 'Open the config and confirm the rg flags',
                status: 'in_progress',
                priority: 'high',
              },
            ],
          },
          {
            type: 'goal',
            threadId: 'thread-1',
            turnId: 'turn-1',
            objective: 'Finish the goal UI integration',
            status: 'active',
            tokenBudget: 50_000,
            tokensUsed: 12_000,
            timeUsedSeconds: 180,
            createdAt: 1_000,
            updatedAt: 2_000,
          },
          {
            type: 'worktree_script',
            status: 'completed',
            steps: [{ command: 'pnpm install', status: 'completed', output: 'rg installed' }],
          } satisfies MessageContent,
        ],
      }),
    ];

    expect(extractSessionSearchBlocks(history)).toEqual([]);
  });

  it('finds paths and code in prose without also matching the same tool payload', () => {
    const path = 'src/search.ts';
    const code = 'const needle = 1;';
    const history = [
      buildMessage({
        id: 'user-prose',
        role: 'user',
        items: [{ type: 'text', text: `Inspect ${path}: ${code}` }],
      }),
      buildMessage({
        id: 'assistant-mixed',
        items: [
          { type: 'text', text: `Found \`${path}\`: \`${code}\`` },
          { type: 'thought', text: `Consider \`${path}\` and \`${code}\`` },
          {
            type: 'proposed_plan',
            status: 'completed',
            markdown: `- Update \`${path}\` with \`${code}\``,
          },
          {
            type: 'tool_call',
            toolCallId: 'tool-mixed',
            status: 'completed',
            kind: 'edit',
            title: `Edit ${path}: ${code}`,
            locations: [{ path }],
            rawInput: { path, text: code },
            rawOutput: { text: `${path}: ${code} tool-only-marker` },
            content: [
              { type: 'content', content: { type: 'text', text: `${path}: ${code}` } },
              { type: 'terminal_command', command: 'echo', args: [path, code] },
              { type: 'terminal_output', output: `${path}: ${code}` },
              { type: 'diff', path, oldText: code, newText: `${code}\n${code}` },
            ],
          },
        ],
      }),
    ];
    const blocks = extractSessionSearchBlocks(history);
    expect(history.flatMap(extractSearchBlocksForMessage)).toEqual(blocks);

    for (const query of [path, code]) {
      const results = buildSessionSearchResults(blocks, query);
      expect(results.map((result) => result.blockId)).toEqual([
        getTextSearchBlockId('user-prose', 0),
        getTextSearchBlockId('assistant-mixed', 0),
        getThoughtSearchBlockId('assistant-mixed', 1),
        getProposedPlanSearchBlockId('assistant-mixed', 2),
      ]);
      expect(
        results.map((result) =>
          blocks
            .find((block) => block.blockId === result.blockId)!
            .text.slice(result.start, result.end)
        )
      ).toEqual([query, query, query, query]);
    }
    expect(buildSessionSearchResults(blocks, 'tool-only-marker')).toEqual([]);
  });
});

describe('buildSessionSearchResults', () => {
  it('returns occurrence-level results in block order', () => {
    const results = buildSessionSearchResults(
      [
        {
          blockId: 'first',
          messageId: 'm-1',
          messageIndex: 0,
          itemIndex: 0,
          blockType: 'user_text',
          text: 'rg once and rg twice',
        },
        {
          blockId: 'second',
          messageId: 'm-2',
          messageIndex: 1,
          itemIndex: 0,
          blockType: 'assistant_markdown',
          text: 'third rg',
        },
      ],
      normalizeSessionSearchQuery('RG')
    );

    expect(results.map((result) => result.resultId)).toEqual([
      'first:match:0',
      'first:match:1',
      'second:match:0',
    ]);
    expect(results.map((result) => result.messageIndex)).toEqual([0, 0, 1]);
  });
});

describe('buildSessionSearchTextParts', () => {
  it('splits text into plain and matched fragments with an active occurrence', () => {
    const parts = buildSessionSearchTextParts({
      text: 'rg and rg again',
      query: 'rg',
      resultIds: ['match-0', 'match-1'],
      activeOccurrenceIndex: 1,
    });

    expect(parts).toEqual([
      { text: 'rg', resultId: 'match-0', isMatch: true, isActive: false },
      { text: ' and ', resultId: null, isMatch: false, isActive: false },
      { text: 'rg', resultId: 'match-1', isMatch: true, isActive: true },
      { text: ' again', resultId: null, isMatch: false, isActive: false },
    ]);
  });
});

describe('literal Markdown punctuation', () => {
  it('finds the same literal identifier in user and assistant prose without phantom matches', () => {
    const blocks = extractSessionSearchBlocks([
      buildMessage({
        id: 'literal-user',
        role: 'user',
        items: [{ type: 'text', text: 'QA_RESUMED_OK' }],
      }),
      buildMessage({ id: 'literal-assistant', items: [{ type: 'text', text: 'QA_RESUMED_OK —' }] }),
    ]);
    expect(buildSessionSearchResults(blocks, 'QA_RESUMED_OK').map((r) => r.messageId)).toEqual([
      'literal-user',
      'literal-assistant',
    ]);
    expect(buildSessionSearchResults(blocks, 'QA_RESUMED_OK —').map((r) => r.messageId)).toEqual([
      'literal-assistant',
    ]);
    expect(buildSessionSearchResults(blocks, 'QARESUMEDOK')).toEqual([]);
  });

  it.each([
    ['QA_RESUMED_OK foo_bar foo__bar__baz a*b a~b', 'QA_RESUMED_OK foo_bar foo__bar__baz a*b a~b'],
    ['`QA_RESUMED_OK **raw** ~~raw~~`', 'QA_RESUMED_OK **raw** ~~raw~~'],
    ['``QA_RESUMED_OK `raw` ``', 'QA_RESUMED_OK `raw`'],
    ['```text\nQA_RESUMED_OK **raw** ~~raw~~\n```', 'QA_RESUMED_OK **raw** ~~raw~~'],
    ['~~~text\nQA_RESUMED_OK _raw_\n~~~', 'QA_RESUMED_OK _raw_'],
    ['```text\nQA_RESUMED_OK _raw_', 'QA_RESUMED_OK _raw_'],
    [
      '**QA_RESUMED_OK** *italic* _emphasis_ __strong__ ~~deleted~~',
      'QA_RESUMED_OK italic emphasis strong deleted',
    ],
    ['QA_**RESUMED**_OK', 'QA_RESUMED_OK'],
    ['**检查完成。**接着执行下一步。', '检查完成。接着执行下一步。'],
    ['前文**“重点”**后文*“提示”*结束', '前文“重点”后文“提示”结束'],
    ['`**检查完成。**接着执行下一步。`', '**检查完成。**接着执行下一步。'],
    ['\\_literal\\_ &amp; \\*literal\\*', '_literal_ & *literal*'],
  ])('extracts rendered text from %s', (source, expected) => {
    expect(getSearchableMarkdownText(source)).toBe(expected);
  });
});

// The provider receives results from the real index, rather than invented IDs.
describe('rendered session search', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderSearch = async (
    source: string,
    query: string,
    activeIndex = 0,
    isOpen = true,
    isStreaming = false
  ) => {
    const history = [
      buildMessage({ id: 'user', role: 'user', items: [{ type: 'text', text: 'QA_RESUMED_OK' }] }),
      buildMessage({ id: 'assistant', items: [{ type: 'text', text: source }] }),
    ];
    const blocks = extractSessionSearchBlocks(history);
    const results = isOpen ? buildSessionSearchResults(blocks, query) : [];
    const active = results[activeIndex];
    const blockMatches = new Map<string, SessionSearchBlockMatch>();
    for (const block of blocks) {
      const matches = results.filter((r) => r.blockId === block.blockId);
      if (!matches.length) continue;
      blockMatches.set(block.blockId, {
        blockId: block.blockId,
        resultIds: matches.map((r) => r.resultId),
        activeResultId: active?.blockId === block.blockId ? active.resultId : null,
        activeOccurrenceIndex: active?.blockId === block.blockId ? active.localIndex : null,
      });
    }
    await act(async () =>
      root.render(
        createElement(
          SessionSearchProvider,
          {
            value: {
              isOpen,
              query,
              blockMatches,
              activeBlockId: active?.blockId ?? null,
              activeResultId: active?.resultId ?? null,
              hasMatchedPrefix: () => false,
              hasActivePrefix: () => false,
            },
          },
          createElement(SearchHighlightedText, {
            blockId: blocks[0]!.blockId,
            text: blocks[0]!.text,
          }),
          createElement(MarkdownRenderer, {
            text: source,
            isStreaming,
            searchBlockId: getTextSearchBlockId('assistant', 0),
          })
        )
      )
    );
    return results;
  };
  const marks = () => [...container.querySelectorAll<HTMLElement>('mark[data-search-result-id]')];
  const assertResults = (results: ReturnType<typeof buildSessionSearchResults>, query: string) => {
    expect([...new Set(marks().map((mark) => mark.dataset.searchResultId))]).toEqual(
      results.map((r) => r.resultId)
    );
    for (const result of results) {
      expect(
        marks()
          .filter((mark) => mark.dataset.searchResultId === result.resultId)
          .map((mark) => mark.textContent)
          .join('')
      ).toBe(query);
    }
  };

  it.each([
    'QA_RESUMED_OK —',
    '`QA_RESUMED_OK`',
    '```text\nQA_RESUMED_OK\n```',
    '~~~text\nQA_RESUMED_OK\n~~~',
    '**QA_RESUMED_OK** _QA_RESUMED_OK_ ~~QA_RESUMED_OK~~',
    'QA_**RESUMED**_OK',
  ])('aligns literal counts and DOM highlights for %s', async (source) => {
    const query = 'QA_RESUMED_OK';
    const results = await renderSearch(source, query, 1);
    expect(results.length).toBe(source.startsWith('**') ? 4 : 2);
    assertResults(results, query);
    expect(
      marks()
        .filter((mark) => mark.className.includes('ring-1'))
        .map((mark) => mark.dataset.searchResultId)
    ).toContain(results[1]!.resultId);
    const phantom = await renderSearch(source, 'QARESUMEDOK');
    expect(phantom).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it('aligns CJK emphasis search offsets with rendered highlights', async () => {
    const source = '**检查完成。**接着执行下一步。';
    const query = '检查完成。接着执行下一步。';
    const results = await renderSearch(source, query);
    expect(results).toHaveLength(1);
    assertResults(results, query);
    expect(container.querySelector('strong')?.textContent).toBe('检查完成。');
    expect(await renderSearch(source, '**')).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it.each(['`__init__ **raw** ~~raw~~`', '```text\n__init__ **raw** ~~raw~~\n```'])(
    'keeps all code punctuation searchable and highlighted: %s',
    async (source) => {
      for (const query of ['__init__', '**raw**', '~~raw~~']) {
        const results = await renderSearch(source, query);
        expect(results).toHaveLength(1);
        assertResults(results, query);
      }
    }
  );

  it('updates literal highlights as a streaming answer grows and hands off to static Markdown', async () => {
    await import('@lobehub/streamdown');
    vi.useFakeTimers();
    try {
      for (const [source, expectedCount] of [
        ['QA_RESUMED', 1],
        ['QA_RESUMED_OK', 2],
        ['QA_RESUMED_OK — QA_RESUMED_OK', 3],
      ] as const) {
        const results = await renderSearch(source, 'QA_RESUMED_OK', 1, true, true);
        expect(results).toHaveLength(expectedCount);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(container.querySelector('.markdown-renderer')?.textContent).toBe(source);
        assertResults(results, 'QA_RESUMED_OK');
      }
      const source = 'QA_RESUMED_OK — QA_RESUMED_OK';
      const results = await renderSearch(source, 'QA_RESUMED_OK', 2);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      assertResults(results, 'QA_RESUMED_OK');
      await renderSearch(source, '');
      expect(marks()).toEqual([]);
      expect(container.querySelector('.markdown-renderer')?.textContent).toContain(source);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches active occurrence and queries, clears and closes without damaging rendered text', async () => {
    const source = 'QA_RESUMED_OK — **QA_RESUMED_OK**';
    const results = await renderSearch(source, 'QA_RESUMED_OK', 1);
    const rendered = container.textContent;
    assertResults(results, 'QA_RESUMED_OK');
    await renderSearch(source, 'QA_RESUMED_OK', 2);
    expect(
      marks()
        .filter((mark) => mark.className.includes('ring-1'))
        .map((mark) => mark.dataset.searchResultId)
    ).toEqual([results[2]!.resultId]);
    assertResults(await renderSearch(source, 'QA_RESUMED_OK —'), 'QA_RESUMED_OK —');
    await renderSearch(source, '');
    expect(marks()).toEqual([]);
    expect(container.textContent).toBe(rendered);
    await renderSearch(source, 'QA_RESUMED_OK');
    await renderSearch(source, 'QA_RESUMED_OK', 0, false);
    expect(marks()).toEqual([]);
    expect(container.textContent).toBe(rendered);
  });
});
