import type { MessageContent, SessionHistory } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import {
  buildSessionSearchResults,
  buildSessionSearchTextParts,
  extractSearchBlocksForMessage,
  extractSessionSearchBlocks,
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
