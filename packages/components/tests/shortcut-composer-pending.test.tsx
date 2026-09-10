// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createShortcutInvocation, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import type { Mention } from '../src/ui/mention';
import type { ShortcutDraftStorage } from '../src/lib/shortcut-composer-draft';
const storage = vi.hoisted(() => ({
  read: vi.fn<ShortcutDraftStorage['read']>(),
  write: vi.fn<ShortcutDraftStorage['write']>(),
}));
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
import {
  captureShortcutDraft,
  ShortcutDraftRepository,
  type ShortcutDraftRecord,
} from '../src/lib/shortcut-composer-draft';
import { initI18n } from '../src/i18n';
import { useLandingSubmissionOwner } from '../src/components/chat/use-landing-submission-owner';
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
let captureOwner: () => () => boolean;
function Harness({ draftKey = 'session' }: { draftKey?: string }) {
  const [text, setText] = useState('');
  const [pending, updatePending] = useState(false);
  captureOwner = useLandingSubmissionOwner(draftKey);
  setPending = updatePending;
  setDraftText = setText;
  return (
    <CombinedMentionTextarea
      enablePromptShortcuts
      draftKey={draftKey}
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
  storage.read.mockReset().mockResolvedValue(record);
  storage.write.mockReset().mockResolvedValue(undefined);
  latest = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

it.each([false, true])(
  'restores only unaccepted landing drafts after a suspended composer unmounts (accepted=%s)',
  async (accepted) => {
    await act(async () => root.render(null));
    const identity = { userId: 'user', workspaceId: 'ws', composerId: 'landing' };
    const otherIdentity = { ...identity, composerId: 'other-session' };
    const durable = new Map<string, ShortcutDraftRecord | null>();
    const repo = new ShortcutDraftRepository({
      read: async (key) => durable.get(JSON.stringify(key)) ?? null,
      write: async (key, value) => {
        durable.set(JSON.stringify(key), value);
      },
    });
    await repo.write(identity, record);
    await repo.write(otherIdentity, record);
    storage.read.mockImplementation((key) => repo.read(key));
    storage.write.mockImplementation((key, value) => repo.write(key, value));
    await act(async () => root.render(<Harness draftKey="landing" />));
    expect(container.querySelector('textarea')?.value).toBe(originalText);
    await act(async () => setPending(true));
    // Mirrors acceptance's repository clear before navigation, while the
    // composer is still suspended and cannot write the empty presentation.
    const clear = accepted ? repo.write(identity, null) : Promise.resolve();
    await act(async () => root.render(null));
    await clear;
    latest = [];
    await act(async () => root.render(<Harness draftKey="landing" />));
    expect(container.querySelector('textarea')?.value).toBe(accepted ? '' : originalText);
    expect(latest).toEqual(accepted ? [] : ranges);
    expect(await repo.read(otherIdentity)).toEqual(record);
    expect(durable.get(JSON.stringify(identity))).toEqual(accepted ? null : record);
  }
);
it.each([false, true])(
  'retires only the unchanged departed landing checkpoint (replacement=%s)',
  async (replace) => {
    await act(async () => root.render(null));
    const identity = { userId: 'user', workspaceId: 'ws', composerId: 'landing' };
    const durable = new Map<string, ShortcutDraftRecord | null>();
    const repo = new ShortcutDraftRepository({
      read: async (key) => durable.get(JSON.stringify(key)) ?? null,
      write: async (key, value) => {
        durable.set(JSON.stringify(key), value);
      },
    });
    await repo.write(identity, record);
    storage.read.mockImplementation((key) => repo.read(key));
    storage.write.mockImplementation((key, value) => repo.write(key, value));
    await act(async () => root.render(<Harness draftKey="landing" />));
    const ownsSubmittedDraft = captureOwner();
    const version = repo.captureVersion(identity, record)!;
    let accept!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const navigate = vi.fn();
    const submission = acceptance.then(async () => {
      if (!ownsSubmittedDraft()) {
        await repo.clearIfUnchanged(identity, version);
        return;
      }
      await repo.write(identity, null);
      navigate();
    });
    await act(async () => setPending(true));
    await act(async () => root.render(null));
    const replacement = { ...record };
    if (replace) {
      await repo.write(identity, replacement);
      await act(async () => root.render(<Harness draftKey="landing" />));
    }
    await act(async () => {
      accept();
      await submission;
    });
    expect(await repo.read(identity)).toEqual(replace ? replacement : null);
    expect(durable.get(JSON.stringify(identity))).toEqual(replace ? replacement : null);
    await act(async () => root.render(<Harness draftKey="landing" />));
    expect(container.querySelector('textarea')?.value).toBe(replace ? replacement.text : '');
    expect(navigate).not.toHaveBeenCalled();
  }
);
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
