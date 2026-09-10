// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createShortcutInvocation, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import type { Mention } from '../src/ui/mention';
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(async () => {}) }));
const provider = vi.hoisted(() => ({
  runtime: { userId: 'user', workspaceId: 'ws' },
  entries: [],
  loading: false,
}));
vi.mock('../src/providers/prompt-shortcut-provider', () => ({
  usePromptShortcuts: () => provider,
}));
vi.mock('../src/lib/shortcut-composer-draft', async (original) => ({
  ...(await original<object>()),
  shortcutDraftRepository: storage,
}));
let knownFileTokens = new Set<string>();
let knownSkillTokens = new Set<string>();
let sessionItems: Array<{ sessionId: string; title: string; slug: string }> = [];

vi.mock('../src/components/mentions/mention-project-file-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectFiles: () => ({
    fileData: { entry: null, status: 'ready' as const },
    initializeLazyDirectory: async () => undefined,
    getKnownFileTokens: () => knownFileTokens,
  }),
}));

vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectSkills: () => ({
    skillState: { status: 'ready' as const },
    skillItems: [],
    knownSkillTokens,
  }),
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => sessionItems,
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { CombinedMentionTextarea } from '../src/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '../src/components/mentions/mention-chips';
import { captureShortcutDraft } from '../src/lib/shortcut-composer-draft';
import { initI18n } from '../src/i18n';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const body: PromptShortcut = {
  v: 1,
  id: 'review',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review the change',
  mentions: [],
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
const invocation = createShortcutInvocation('invocation', body);
const originalText = 'Before /review after';
const ranges: Mention[] = [
  { start: 7, end: 14, value: invocation.id, kind: 'prompt_shortcut', data: invocation },
];
const record = captureShortcutDraft(originalText, ranges)!;
let latest: Mention[] = [];
let setPending: (pending: boolean) => void;
let setDraftText: (text: string) => void;
function Harness() {
  const [text, setText] = useState('');
  const [pending, updatePending] = useState(false);
  setPending = updatePending;
  setDraftText = setText;
  return (
    <CombinedMentionTextarea
      enablePromptShortcuts
      draftKey="session"
      value={pending ? '' : text}
      disabled={pending}
      draftSuspended={pending}
      onValueChange={setText}
      onMentionRangesChange={(next) => {
        latest = next;
      }}
      getMentionChip={getComposerMentionChip}
    />
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await initI18n('en');
  storage.read.mockResolvedValue(record);
  storage.write.mockClear();
  latest = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('preserves real composer ranges and durable snapshot while hidden, restores on rejection, clears on acceptance', async () => {
  expect(container.querySelector('textarea')?.value).toBe(originalText);
  expect(latest).toEqual(ranges);
  storage.write.mockClear();
  await act(async () => setPending(true));
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(latest).toEqual(ranges);
  expect(storage.write).not.toHaveBeenCalled();
  await act(async () => setPending(false));
  expect(container.querySelector('textarea')?.value).toBe(originalText);
  expect(latest).toEqual(ranges);
  expect(latest[0]?.data).toEqual(invocation);
  await act(async () => setPending(true));
  // An accepted write clears the repository before promoting a child tab.
  storage.read.mockResolvedValue(null);
  await act(async () => {
    setDraftText('');
    setPending(false);
  });
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(latest).toEqual([]);
  expect(storage.write).toHaveBeenLastCalledWith(
    { userId: 'user', workspaceId: 'ws', composerId: 'session' },
    null
  );
});
