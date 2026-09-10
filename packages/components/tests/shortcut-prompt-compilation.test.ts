import { expect, it } from 'vitest';
import {
  createShortcutInvocation,
  type PromptShortcut,
  type PromptShortcutTarget,
} from '@lody/shared/prompt-shortcuts';
import { normalizeSessionInputBlocks, inputBlocksToHistoryItems } from '@lody/shared';
import { compileShortcutPrompt } from '../src/components/mentions/shortcut-prompt-compilation';
const scope = {
  project: { kind: 'github' as const, repository: 'team/repo' },
  machineId: 'machine',
  providerKey: 'builtin:codex',
};
const prompt = '  Start !{topic}\n  $tool @helper @file\nEnd  ';
function semantic(label: string, target: PromptShortcutTarget) {
  const start = prompt.indexOf(label);
  return { start, end: start + label.length, label, target };
}
const body: PromptShortcut = {
  v: 1,
  id: 'review',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt,
  mentions: [
    semantic('$tool', {
      kind: 'skill',
      source: 'project',
      project: scope.project,
      path: '.codex/skills/tool/SKILL.md',
      compatibleProviders: ['builtin:codex'],
    }),
    semantic('@helper', { kind: 'agent_role', agentRoleId: 'stable-role' }),
    semantic('@file', { kind: 'file', project: scope.project, path: 'src/file.ts' }),
  ],
  scope,
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
const context = { userId: 'user', workspaceId: 'ws', scope };
function fixture() {
  const text = 'pré\n/review middle /review @external !{ordinary}';
  const first = createShortcutInvocation('first', body);
  const second = createShortcutInvocation('second', body);
  return {
    text,
    mentions: [
      { start: 4, end: 11, value: first.id, kind: 'prompt_shortcut', data: first },
      { start: 19, end: 26, value: second.id, kind: 'prompt_shortcut', data: second },
    ],
    ordinaryRewrites: [
      {
        start: 27,
        end: 36,
        replacement: 'external-session',
        span: { kind: 'session' as const, label: '@external', target: 'session-id' },
      },
    ],
    context,
    resolveDependency: () => ({ kind: 'available' as const }),
  };
}
it('compiles multiple snapshots and ordinary rewrites in source order with UTF-16 spans', () => {
  const input = fixture();
  const result = compileShortcutPrompt(input);
  // `!{topic}` and `!{ordinary}` are ordinary text on both sides of the chip.
  const expanded =
    '  Start !{topic}\n  use /tool [Skill Path](.codex/skills/tool/SKILL.md) use lody mcp to create a session with agent role[id: stable-role, name: helper] @file\nEnd  ';
  expect(result.text).toBe(`pré\n${expanded} middle ${expanded} external-session !{ordinary}`);
  expect(result.spans?.map((span) => result.text.slice(span.start, span.end))).toEqual([
    'use /tool [Skill Path](.codex/skills/tool/SKILL.md)',
    'use lody mcp to create a session with agent role[id: stable-role, name: helper]',
    '@file',
    'use /tool [Skill Path](.codex/skills/tool/SKILL.md)',
    'use lody mcp to create a session with agent role[id: stable-role, name: helper]',
    '@file',
    'external-session',
  ]);
  const blocks = normalizeSessionInputBlocks([
    { type: 'text', text: result.text, spans: result.spans },
  ]);
  expect(inputBlocksToHistoryItems(blocks)[0]).toMatchObject({ type: 'text', text: result.text });
});
it('fails closed for unknown dependencies, scope changes and overlapping ranges', () => {
  const input = fixture();
  expect(() => compileShortcutPrompt({ ...input, resolveDependency: undefined })).toThrow();
  expect(() => compileShortcutPrompt({ ...input, context: { ...context, scope: {} } })).toThrow();
  expect(() =>
    compileShortcutPrompt({
      ...input,
      mentions: [...input.mentions, { start: 5, end: 8, value: 'bad', kind: 'file' }],
    })
  ).toThrow();
});
it('enforces the final prompt byte budget including semantic rewrites', () => {
  const input = fixture();
  const result = compileShortcutPrompt(input);
  const bytes = new TextEncoder().encode(result.text).length;
  expect(compileShortcutPrompt({ ...input, maxBytes: bytes })).toEqual(result);
  expect(() => compileShortcutPrompt({ ...input, maxBytes: bytes - 1 })).toThrow();
});
