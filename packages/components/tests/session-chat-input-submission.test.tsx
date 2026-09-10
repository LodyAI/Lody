// @vitest-environment jsdom

import { act, createElement, createRef, type RefObject } from 'react';
import { getDefaultStore } from 'jotai';
import { currentWorkspaceIdAtom, userAtom } from '../src/atoms';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShortcutInvocation, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import type { Mention } from '../src/ui/mention/index';
import {
  captureShortcutDraft,
  indexedShortcutDraftStorage,
  shortcutDraftRepository,
} from '../src/lib/shortcut-composer-draft';
import type { AgentRole, AgentRoleId, SessionMeta, SessionInputBlock } from '@lody/shared';

const composerRanges = vi.hoisted(() => ({
  change: undefined as ((ranges: Mention[]) => void) | undefined,
  promptChange: undefined as ((text: string) => void) | undefined,
}));
const shortcutProvider = vi.hoisted(() => ({
  runtime: { userId: 'user-1', workspaceId: 'ws' },
  entries: [],
  loading: false,
}));
vi.mock('../src/providers/prompt-shortcut-provider', () => ({
  usePromptShortcuts: () => shortcutProvider,
}));

const sessionAgentRoleState = vi.hoisted(() => ({
  control: {
    items: [],
    selectedRoleId: null,
    onSelect: () => undefined,
  } as {
    items: Array<{ role: AgentRole; availability: { kind: 'available' } }>;
    selectedRoleId: AgentRoleId | null;
    onSelect: (roleId: AgentRoleId | null) => void;
  },
}));

vi.mock('@posthog/react', () => ({ usePostHog: () => null }));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal()),
  useSessionMentionItems: () => [],
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

vi.mock('../src/components/chat/chat-composer', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('../src/components/chat/chat-composer')>();
  return {
    ...actual,
    ChatComposer: (props: React.ComponentProps<typeof actual.ChatComposer>) => {
      composerRanges.change = props.onMentionRangesChange;
      composerRanges.promptChange = props.onPromptChange;
      return React.createElement(actual.ChatComposer, props);
    },
  };
});

vi.mock('../src/components/sessions/desktop-run-config-menu', async () => {
  const React = await import('react');
  return {
    DesktopPermissionModeButton: () =>
      React.createElement('div', { 'data-testid': 'desktop-permission-mode-button' }),
    DesktopRunConfigMenu: () => null,
  };
});
vi.mock('../src/hooks/use-session-agent-role', () => ({
  useSessionAgentRole: () => sessionAgentRoleState.control,
}));
vi.mock('../src/components/mobile/mobile-session-run-config', () => ({
  MobileSessionRunConfig: () => null,
}));
vi.mock('../src/components/sessions/session-usage-popover', () => ({
  SessionUsagePopover: () => null,
}));
vi.mock('../src/hooks/use-code-collab-requested-role', () => ({
  useCodeCollabRequestedRole: () => null,
}));
vi.mock('../src/hooks/use-code-collab-session-file-provider', () => ({
  useCodeCollabSessionFileProvider: () => ({
    status: 'idle',
    provider: null,
    message: null,
  }),
}));

import {
  SessionChatInputArea,
  setSessionChatInputTextDraft,
  type SessionChatInputAreaHandle,
} from '../src/components/sessions/session-chat-input-area';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferredBoolean() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('SessionChatInputArea submission feedback', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    vi.spyOn(indexedShortcutDraftStorage, 'read').mockResolvedValue(null);
    vi.spyOn(indexedShortcutDraftStorage, 'write').mockResolvedValue();
    sessionAgentRoleState.control = {
      items: [],
      selectedRoleId: null,
      onSelect: () => undefined,
    };
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  const renderPermissionModeCase = async (runConfig: AgentRole['runConfig']) => {
    const selectedRoleId = 'role-1' as AgentRoleId;
    sessionAgentRoleState.control = {
      items: [
        {
          role: {
            v: 1,
            id: selectedRoleId,
            revision: 1,
            name: 'Reviewer',
            visibility: 'private',
            ownerUserId: 'user-1',
            machineId: 'machine-1',
            agentConfigId: 'agent-1',
            runConfig,
            createdAt: 1,
            updatedAt: 1,
          } as AgentRole,
          availability: { kind: 'available' },
        },
      ],
      selectedRoleId,
      onSelect: () => undefined,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-role-permission',
            userId: 'user-1',
            machineId: 'machine-1',
            agentConfigId: 'agent-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-08-26T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          selectedModeId: 'ask',
          selectedModelId: null,
          modeOptions: [{ value: 'ask', label: 'Ask' }],
          modelOptions: [],
          onModeChange: () => undefined,
          onModelChange: () => undefined,
          onSendMessage: async () => true,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
        })
      );
    });
  };

  it('hides the desktop permission button when the selected Role pins permission', async () => {
    await renderPermissionModeCase({ modeId: 'ask' });
    expect(container.querySelector('[data-testid="desktop-permission-mode-button"]')).toBeNull();
  });

  it.each(['account', 'workspace'] as const)(
    'does not expose Shortcut-bearing cached text after an in-place %s switch',
    async (axis) => {
      const store = getDefaultStore();
      const previousUser = store.get(userAtom);
      const previousWorkspace = store.get(currentWorkspaceIdAtom);
      await renderPermissionModeCase({});
      act(() => {
        composerRanges.promptChange?.('Private /review');
        composerRanges.change?.([
          {
            start: 8,
            end: 15,
            value: 'private-invocation',
            kind: 'prompt_shortcut',
            data: createShortcutInvocation('private-invocation', {
              v: 1,
              id: 'review',
              workspaceId: 'ws',
              ownerUserId: 'user-1',
              visibility: 'private',
              name: 'Review',
              slug: 'review',
              prompt: 'Private prompt',
              mentions: [],
              scope: {},
              revision: 'r1',
              createdAt: 1,
              updatedAt: 1,
            }),
          },
        ]);
      });
      expect(container?.querySelector('textarea')?.value).toBe('Private /review');
      try {
        act(() => {
          if (axis === 'account') {
            store.set(userAtom, { id: 'other', name: 'Other', email: 'other@example.test' });
          } else {
            store.set(
              currentWorkspaceIdAtom,
              'other-workspace' as NonNullable<typeof previousWorkspace>
            );
          }
        });
        expect(container?.querySelector('textarea')?.value).toBe('');
        act(() => composerRanges.promptChange?.('New identity draft'));
        expect(container?.querySelector('textarea')?.value).toBe('New identity draft');
        act(() => {
          store.set(userAtom, previousUser);
          store.set(currentWorkspaceIdAtom, previousWorkspace);
        });
        expect(container?.querySelector('textarea')?.value).toBe('');
      } finally {
        act(() => {
          store.set(userAtom, previousUser);
          store.set(currentWorkspaceIdAtom, previousWorkspace);
        });
      }
    }
  );

  it('keeps the desktop permission button when the selected Role does not pin it', async () => {
    await renderPermissionModeCase({});
    expect(
      container.querySelector('[data-testid="desktop-permission-mode-button"]')
    ).not.toBeNull();
  });

  it('does not submit against transient run-config defaults while the Session doc hydrates', async () => {
    const onSendMessage = vi.fn(async () => true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-hydrating',
            userId: 'user-1',
            machineId: 'machine-1',
            agentConfigId: 'agent-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-08-26T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          durableAgentRoleReady: false,
          selectedModeId: null,
          selectedModelId: 'provider-default',
          modeOptions: [],
          modelOptions: [],
          onModeChange: () => undefined,
          onModelChange: () => undefined,
          onSendMessage,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
          initialInputText: 'wait for the durable config',
        })
      );
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
      true
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click()
    );
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    root = null;
    container?.remove();
    container = null;
  });

  it('clears immediately and restores the preserved draft when acceptance fails', async () => {
    const acceptance = deferredBoolean();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-feedback',
            userId: 'user-1',
            machineId: 'machine-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-07-19T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          selectedModeId: null,
          selectedModelId: null,
          modeOptions: [],
          modelOptions: [],
          onModeChange: () => undefined,
          onModelChange: () => undefined,
          onSendMessage: () => acceptance.promise,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
          initialInputText: 'preserved draft',
        })
      );
    });

    expect(container.querySelector('textarea')?.value).toBe('preserved draft');

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('textarea')?.value).toBe('');
    expect(container.querySelector('textarea')?.disabled).toBe(true);

    await act(async () => {
      acceptance.resolve(false);
      await acceptance.promise;
    });

    expect(container.querySelector('textarea')?.value).toBe('preserved draft');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });

  it('shows a turn limit without an upgrade action when none is provided', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-limit',
            userId: 'user-1',
            machineId: 'machine-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-07-19T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          selectedModeId: null,
          selectedModelId: null,
          modeOptions: [],
          modelOptions: [],
          onModeChange: () => undefined,
          onModelChange: () => undefined,
          onSendMessage: async () => true,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
          freeTurnLimitNotice: { current: 20, limit: 20 },
        })
      );
    });

    expect(container.textContent).toContain('limited to 20 turns');
    expect(container.textContent).not.toContain('Upgrade to Plus');
  });

  let nextSession = 0;
  async function renderComposer({
    sessionId = `focus-${++nextSession}`,
    onSendMessage,
    isArchived = false,
    composerRef,
    claimNavigationFocus,
  }: {
    sessionId?: string;
    onSendMessage: (blocks: SessionInputBlock[]) => Promise<boolean>;
    isArchived?: boolean;
    composerRef?: RefObject<SessionChatInputAreaHandle | null>;
    claimNavigationFocus?: () => boolean;
  }) {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        createElement(SessionChatInputArea, {
          ref: composerRef,
          claimNavigationFocus,
          session: {
            id: sessionId,
            userId: 'user-1',
            machineId: 'machine-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived,
            createdAt: '2026-09-05T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          selectedModeId: null,
          selectedModelId: null,
          modeOptions: [],
          modelOptions: [],
          onModeChange: () => undefined,
          onModelChange: () => undefined,
          onSendMessage,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
          initialInputText: 'focus regression draft',
        })
      );
    });
    return container!.querySelector('textarea')!;
  }

  async function submit(source: 'keyboard' | 'button') {
    await act(async () => {
      if (source === 'keyboard') {
        container!
          .querySelector('textarea')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          );
      } else {
        container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
      }
    });
  }

  it.each([
    ['keyboard', true],
    ['keyboard', false],
    ['button', true],
    ['button', false],
  ] as const)(
    'restores desktop focus after deferred %s acceptance=%s using the real composer',
    async (source, accepted) => {
      const acceptance = deferredBoolean();
      const textarea = await renderComposer({ onSendMessage: () => acceptance.promise });
      textarea.focus();
      await submit(source);
      expect(container!.querySelector('textarea')).toBe(textarea);
      expect(textarea.disabled).toBe(true);
      // jsdom leaves disabled controls focused; browsers blur them at this commit.
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      await act(async () => acceptance.resolve(accepted));
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe(accepted ? '' : 'focus regression draft');
      expect(document.activeElement).toBe(textarea);
    }
  );

  it.each([false, true])(
    'handles immediately settled button sends on mobile=%s',
    async (mobile) => {
      if (mobile)
        Object.defineProperty(window, '__LODY_NATIVE__', { configurable: true, value: true });
      const textarea = await renderComposer({ onSendMessage: async () => false });
      textarea.focus();
      await submit('button');
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe('focus regression draft');
      expect(document.activeElement === textarea).toBe(!mobile);
    }
  );

  for (const mobilePlatform of ['narrow-browser', 'wide-native'] as const) {
    function setMobilePlatform() {
      if (mobilePlatform === 'wide-native') {
        Object.defineProperty(window, '__LODY_NATIVE__', { configurable: true, value: true });
      } else {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      }
    }
    it.each(['keyboard', 'button'] as const)(
      `never refocuses ${mobilePlatform} after %s submission succeeds or fails`,
      async (source) => {
        setMobilePlatform();
        for (const accepted of [false, true]) {
          const acceptance = deferredBoolean();
          const textarea = await renderComposer({ onSendMessage: () => acceptance.promise });
          textarea.focus();
          await submit(source);
          expect(document.activeElement).not.toBe(textarea);
          await act(async () => acceptance.resolve(accepted));
          expect(textarea.disabled).toBe(false);
          expect(textarea.value).toBe(accepted ? '' : 'focus regression draft');
          expect(document.activeElement).not.toBe(textarea);
        }
      }
    );
    it(`consumes a navigation request without focusing on ${mobilePlatform}`, async () => {
      setMobilePlatform();
      let pending = true;
      const textarea = await renderComposer({
        onSendMessage: async () => true,
        claimNavigationFocus: () => {
          const claimed = pending;
          pending = false;
          return claimed;
        },
      });
      expect(pending).toBe(false);
      expect(document.activeElement).not.toBe(textarea);
    });
  }

  it.each(['focus', 'focus-stopped', 'focus-then-blur', 'pointer', 'window-blur'] as const)(
    'respects focus relinquished via %s while sending',
    async (gesture) => {
      const acceptance = deferredBoolean();
      const textarea = await renderComposer({ onSendMessage: () => acceptance.promise });
      textarea.focus();
      await submit('keyboard');
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      const other = document.createElement('button');
      container!.appendChild(other);
      if (gesture === 'focus-stopped') {
        other.addEventListener('focusin', (event) => event.stopPropagation());
      }
      if (gesture.startsWith('focus')) {
        other.focus();
        if (gesture === 'focus-then-blur') other.blur();
      } else if (gesture === 'pointer') {
        other.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      } else {
        window.dispatchEvent(new Event('blur'));
      }
      await act(async () => acceptance.resolve(true));
      expect(document.activeElement).not.toBe(textarea);
    }
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'ignores an old completion after a session switch (return=%s, accepted=%s)',
    async (returnToA, accepted) => {
      const oldAcceptance = deferredBoolean();
      const newAcceptance = deferredBoolean();
      const sessionA = `switch-a-${++nextSession}`;
      let textarea = await renderComposer({
        sessionId: sessionA,
        onSendMessage: () => oldAcceptance.promise,
      });
      textarea.focus();
      await submit('keyboard');
      textarea = await renderComposer({
        sessionId: `switch-b-${nextSession}`,
        onSendMessage: () => newAcceptance.promise,
      });
      if (returnToA)
        textarea = await renderComposer({
          sessionId: sessionA,
          onSendMessage: () => newAcceptance.promise,
        });
      expect(textarea.disabled).toBe(false);
      const newDraft = textarea.value;
      await act(async () => oldAcceptance.resolve(accepted));
      expect(textarea.value).toBe(newDraft);
      expect(document.activeElement).not.toBe(textarea);
      textarea.focus();
      await submit('keyboard');
      expect(textarea.disabled).toBe(true);
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      await act(async () => newAcceptance.resolve(false));
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe(newDraft);
      expect(document.activeElement).toBe(textarea);
    }
  );

  it('does not let an old completion enable another session pending submission', async () => {
    const first = deferredBoolean();
    const second = deferredBoolean();
    await renderComposer({ onSendMessage: () => first.promise });
    await submit('keyboard');
    const textarea = await renderComposer({ onSendMessage: () => second.promise });
    await submit('keyboard');
    await act(async () => first.resolve(false));
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('');
    await act(async () => second.resolve(false));
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('focus regression draft');
  });

  it('does not focus an archived composer or replay focus after restoring it', async () => {
    const acceptance = deferredBoolean();
    const props = {
      sessionId: `archived-${++nextSession}`,
      onSendMessage: () => acceptance.promise,
    };
    const textarea = await renderComposer(props);
    textarea.focus();
    await submit('keyboard');
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
    await renderComposer({ ...props, isArchived: true });
    await act(async () => acceptance.resolve(false));
    expect(document.activeElement).not.toBe(textarea);
    await renderComposer(props);
    expect(document.activeElement).not.toBe(textarea);
  });
  it('accepts an attachment-only draft once when Enter repeats before React commits', async () => {
    const acceptance = deferredBoolean();
    const submitted: SessionInputBlock[][] = [];
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const textarea = await renderComposer({
      composerRef,
      onSendMessage: (blocks) => {
        submitted.push(blocks);
        return acceptance.promise;
      },
    });
    const comment = {
      source: 'lody' as const,
      path: 'src/example.ts',
      lineNumber: 1,
      side: 'additions' as const,
      commentBody: 'Synthetic review comment',
      authorName: 'Reviewer',
    };
    await act(async () => {
      composerRef.current!.setInputText('');
      composerRef.current!.addCommentReference(comment);
    });
    await act(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      }
    });
    expect(submitted).toEqual([[{ type: 'comment_reference', ...comment }]]);
    await act(async () => acceptance.resolve(false));
    expect(container!.textContent).toContain('Synthetic review comment');
  });

  it('retires focus ownership when a pending composer unmounts', async () => {
    const acceptance = deferredBoolean();
    const textarea = await renderComposer({ onSendMessage: () => acceptance.promise });
    textarea.focus();
    await submit('keyboard');
    await act(async () => root!.unmount());
    root = null;
    const other = document.createElement('input');
    container!.appendChild(other);
    other.focus();
    await act(async () => acceptance.resolve(true));
    expect(document.activeElement).toBe(other);
    expect(textarea.isConnected).toBe(false);
  });
  it('retains a newer cached draft when an old send completes after leaving again', async () => {
    const acceptance = deferredBoolean();
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionA = `draft-owner-${++nextSession}`;
    setSessionChatInputTextDraft(sessionA as SessionMeta['id'], 'original draft');
    const props = { sessionId: sessionA, composerRef, onSendMessage: () => acceptance.promise };
    await renderComposer(props);
    await submit('keyboard');
    await renderComposer({ onSendMessage: async () => true });
    await renderComposer(props);
    await act(async () => composerRef.current!.setInputText('newer unsent draft'));
    await renderComposer({ onSendMessage: async () => true });
    await act(async () => acceptance.resolve(true));
    const textarea = await renderComposer(props);
    expect(textarea.value).toBe('newer unsent draft');
  });

  it.each([false, true])(
    'retires a departed Shortcut draft only without a newer same-text invocation (replacement=%s)',
    async (replacement) => {
      const store = getDefaultStore();
      const previousUser = store.get(userAtom);
      const previousWorkspace = store.get(currentWorkspaceIdAtom);
      const write = vi.spyOn(indexedShortcutDraftStorage, 'write').mockResolvedValue();
      const read = vi.spyOn(indexedShortcutDraftStorage, 'read').mockResolvedValue(null);
      const sessionId = `shortcut-retired-${++nextSession}`;
      const identity = { userId: 'user-1', workspaceId: 'ws', composerId: sessionId };
      const body: PromptShortcut = {
        v: 1,
        id: 'review',
        workspaceId: 'ws',
        ownerUserId: 'user-1',
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
      const recordFor = (id: string) =>
        captureShortcutDraft('/review', [
          {
            start: 0,
            end: 7,
            value: id,
            kind: 'prompt_shortcut',
            data: createShortcutInvocation(id, body),
          },
        ])!;
      const original = recordFor('submitted');
      const newer = recordFor('replacement');
      const acceptance = deferredBoolean();
      try {
        act(() => {
          store.set(userAtom, { id: 'user-1', name: 'User', email: 'user@example.test' });
          store.set(currentWorkspaceIdAtom, 'ws' as NonNullable<typeof previousWorkspace>);
        });
        await shortcutDraftRepository.write(identity, original);
        setSessionChatInputTextDraft(sessionId as SessionMeta['id'], '/review');
        await renderComposer({ sessionId, onSendMessage: () => acceptance.promise });
        await submit('button');
        await renderComposer({ onSendMessage: async () => true });
        if (replacement) await shortcutDraftRepository.write(identity, newer);
        await act(async () => acceptance.resolve(true));
        expect(await shortcutDraftRepository.read(identity)).toEqual(replacement ? newer : null);
        const restored = await renderComposer({ sessionId, onSendMessage: async () => true });
        expect(restored.value).toBe(replacement ? '/review' : 'focus regression draft');
      } finally {
        await act(async () => root?.unmount());
        root = null;
        container?.remove();
        container = null;
        act(() => {
          store.set(userAtom, previousUser);
          store.set(currentWorkspaceIdAtom, previousWorkspace);
        });
        write.mockRestore();
        read.mockRestore();
      }
    }
  );

  it('sends canonical Shortcut expansion and retains the same invocation on rejection', async () => {
    const body: PromptShortcut = {
      v: 1,
      id: 'review',
      workspaceId: 'ws',
      ownerUserId: 'user-1',
      visibility: 'private',
      name: 'Review',
      slug: 'review',
      prompt: '  $literal !{unchanged}\n  end  ',
      mentions: [],
      scope: {},
      revision: 'r1',
      createdAt: 1,
      updatedAt: 1,
    };
    const invocation = createShortcutInvocation('invocation', body);
    await shortcutDraftRepository.write(
      { userId: 'user-1', workspaceId: 'ws', composerId: 'shortcut-send' },
      captureShortcutDraft('Before /review after', [
        { start: 7, end: 14, value: invocation.id, kind: 'prompt_shortcut', data: invocation },
      ])
    );
    const onSendMessage = vi.fn(async () => false);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'shortcut-send',
            userId: 'user-1',
            machineId: 'machine-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            createdAt: '2026-07-19T00:00:00.000Z',
          } as SessionMeta,
          sessionLocalProjectRootPath: null,
          isMachineRemoved: false,
          isAgentBusy: false,
          isDark: false,
          isEmptyConversation: false,
          selectedModeId: null,
          selectedModelId: null,
          modeOptions: [],
          modelOptions: [],
          onModeChange: () => {},
          onModelChange: () => {},
          onSendMessage,
          onStop: () => {},
          onRemoveQueueItem: async () => {},
          initialInputText: 'Before /review after',
        })
      )
    );
    await act(async () =>
      container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click()
    );
    expect(onSendMessage).toHaveBeenCalledWith(
      [{ type: 'text', text: 'Before   $literal !{unchanged}\n  end   after' }],
      undefined
    );
    expect(container.querySelector('textarea')?.value).toBe('Before /review after');
    await act(async () =>
      container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click()
    );
    expect(onSendMessage).toHaveBeenCalledTimes(2);
    expect(onSendMessage.mock.calls[1]).toEqual(onSendMessage.mock.calls[0]);
  });
});
