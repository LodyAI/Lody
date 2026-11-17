import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const { resolveSessionWorkspacePath } =
  await import('../../../../packages/cloud-runtime/src/protocol/session-workspace-path.ts');
const { buildConversationMarkdown } =
  await import('../../../../packages/cloud-runtime/src/protocol/conversation-markdown.ts');

test('Copy path names the directory the CLI uses for worktrees, tabs, chats and local projects', () => {
  const dotlodyPath = '/Users/dev/.lody/';
  assert.equal(
    resolveSessionWorkspacePath({
      sessionId: 'tab1',
      ownerSessionId: 'root1',
      isWorktree: true,
      dotlodyPath,
      repoFullName: 'LodyAI/Lody',
    }),
    '/Users/dev/.lody/repos/github---lodyai---lody/worktrees/root1',
  );
  const localId = createHash('sha256')
    .update('/Users/dev/code/app')
    .digest('hex')
    .slice(0, 12);
  assert.equal(
    resolveSessionWorkspacePath({
      sessionId: 's1',
      isWorktree: true,
      dotlodyPath,
      localProjectRootPath: '/Users/dev/code/app/',
    }),
    `/Users/dev/.lody/repos/local---${localId}/worktrees/s1`,
  );
  assert.equal(
    resolveSessionWorkspacePath({
      sessionId: 's1',
      dotlodyPath,
      localProjectRootPath: '/Users/dev/code/app',
    }),
    '/Users/dev/code/app',
  );
  assert.equal(
    resolveSessionWorkspacePath({
      sessionId: 's1',
      dotlodyPath: 'C:\\Users\\dev\\.lody',
    }),
    'C:\\Users\\dev\\.lody\\chats\\s1',
  );
  assert.equal(
    resolveSessionWorkspacePath({
      sessionId: 's1',
      isWorktree: true,
      legacyWorkspacePath: ' /legacy/path ',
    }),
    '/legacy/path',
  );
  assert.equal(
    resolveSessionWorkspacePath({ sessionId: 's1', isWorktree: true }),
    null,
  );
});

test('Copy as Markdown keeps prose, flags an unfinished reply and makes session links portable outside code', () => {
  const history = [
    {
      id: 'u1',
      role: 'user',
      userId: 'alice',
      timestamp: '2026-11-01T10:00:00.000Z',
      items: [
        { type: 'text', text: 'See session://abc and `session://keep` here.' },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      finished: false,
      items: [{ type: 'text', text: '# Heading\nWorking on it.' }],
    },
  ];
  const { markdown, stats } = buildConversationMarkdown({
    workspaceId: 'ws1',
    history,
    title: 'Fix login',
    source: 'lodyai/lody · main',
    participants: { alice: 'Alice' },
    incompleteFinalResponse:
      'The last response was still generating when copied.',
  });
  assert.match(markdown, /^# Fix login\n/);
  assert.match(markdown, /> lodyai\/lody · main/);
  assert.match(
    markdown,
    /\*\*The last response was still generating when copied\.\*\*/,
  );
  assert.match(
    markdown,
    /See lody:\/\/session\/abc\?workspace=ws1 and `session:\/\/keep` here\./,
  );
  assert.match(markdown, /### Heading\nWorking on it\./);
  assert.equal(stats.overBudget, false);
});
