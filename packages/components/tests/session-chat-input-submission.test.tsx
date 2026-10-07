// @vitest-environment jsdom

import {
  act,
  cloneElement,
  createElement,
  createRef,
  useLayoutEffect,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { getDefaultStore } from 'jotai';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import { authTokenAtom, runtimeAtom } from '../src/atoms/runtime';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from '../src/lib/electron-session-file-sender';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { queuedMessageBehaviorAtom } from '../src/atoms/settings';
import { computeSha256Hex, uploadSessionFile } from '../src/lib/session-file-upload';
import { uploadSessionImage } from '../src/lib/session-image-upload';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRole, AgentRoleId, SessionMeta, SessionInputBlock } from '@lody/shared';

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
vi.mock('../src/lib/electron-session-file-sender', () => ({
  canUseElectronLocalFileSend: vi.fn(() => false),
  sendSessionFileToLocalRuntime: vi.fn(async () => null),
}));
vi.mock('../src/lib/session-file-upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeSha256Hex: vi.fn(),
  computeTextPreviewable: vi.fn(async () => true),
  uploadSessionFile: vi.fn(),
}));
vi.mock('../src/lib/session-image-upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadSessionImage: vi.fn(),
}));

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
  type SessionChatInputAreaProps,
} from '../src/components/sessions/session-chat-input-area';
import { initI18n } from '../src/i18n';
import { MAX_PASTED_TEXT_BYTE_SIZE } from '../src/lib/pasted-text-draft';
import { toast } from '@/lib/toast';
import { commands } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import { CommandShortcutHost } from '../src/lib/commands/shortcut-host';

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

function ScopeSwitchOnCommit({
  child,
  retire,
}: {
  child: ReactElement<SessionChatInputAreaProps>;
  retire: boolean;
}) {
  const [retired, setRetired] = useState(false);
  useLayoutEffect(() => {
    if (retire) setRetired(true);
  }, [retire]);
  return retired
    ? cloneElement(child, {
        session: { ...child.props.session, id: `${child.props.session.id}-retired` as never },
      })
    : child;
}

describe('SessionChatInputArea submission feedback', () => {
  let resources: ReturnType<typeof createSessionSendResources>;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    resources = createSessionSendResources({
      acquire: async () => {
        throw new Error('Unexpected store borrow');
      },
      releaseRef: () => {},
    });
    getDefaultStore().set(runtimeAtom, {
      workspaceId: 'workspace-upload',
      sendResources: resources,
    } as never);
    vi.mocked(uploadSessionImage).mockReset();
    vi.mocked(computeSha256Hex).mockReset();
    vi.mocked(uploadSessionFile).mockReset();
    vi.mocked(canUseElectronLocalFileSend).mockReturnValue(false);
    vi.mocked(sendSessionFileToLocalRuntime).mockReset();
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
    await resources.dispose();
    getDefaultStore().set(runtimeAtom, null);
    getDefaultStore().set(localProbeResultAtom, null);
    getDefaultStore().set(authTokenAtom, null);
    getDefaultStore().set(currentWorkspaceIdAtom, null);
    getDefaultStore().set(queuedMessageBehaviorAtom, 'queue');
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
    Reflect.deleteProperty(window.navigator, 'userAgent');
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
    isVisible = true,
    overrides = {},
    retireOnCommit = false,
  }: {
    sessionId?: string;
    onSendMessage: SessionChatInputAreaProps['onSendMessage'];
    isArchived?: boolean;
    isVisible?: boolean;
    overrides?: Partial<SessionChatInputAreaProps>;
    retireOnCommit?: boolean;
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
        createElement(ScopeSwitchOnCommit, {
          retire: retireOnCommit,
          child: createElement(SessionChatInputArea, {
            ref: composerRef,
            isVisible,
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
            ...overrides,
          }),
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

  async function attachDrafts(composerRef: RefObject<SessionChatInputAreaHandle | null>) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:draft',
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    await act(async () =>
      composerRef.current!.handleImageDrop([
        new File(['synthetic-image'], 'sample.png', { type: 'image/png' }),
        new File(['synthetic-file'], 'notes.txt', { type: 'text/plain' }),
      ])
    );
  }

  it.each(['keyboard', 'button'] as const)(
    'hands off complete drafts through %s without starting uploads in the composer',
    async (source) => {
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const acceptance = deferredBoolean();
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const textarea = await renderComposer({
        composerRef,
        onSendMessage: (...args) => {
          submissions.push(args);
          return acceptance.promise;
        },
      });
      await attachDrafts(composerRef);
      expect(container!.textContent).toContain('notes.txt');
      expect(submissions).toEqual([]);
      await submit(source);
      await submit('keyboard');
      expect(submissions).toHaveLength(1);
      expect(submissions[0][0]).toEqual([{ type: 'text', text: 'focus regression draft' }]);
      expect(
        submissions[0][2]?.attachments?.map(({ kind, name, source: bytes }) => ({
          kind,
          name,
          size: bytes.size,
        }))
      ).toEqual([
        { kind: 'image', name: 'sample.png', size: 15 },
        { kind: 'file', name: 'notes.txt', size: 14 },
      ]);
      expect(uploadSessionImage).not.toHaveBeenCalled();
      expect(uploadSessionFile).not.toHaveBeenCalled();
      expect(textarea.disabled).toBe(true);
      await act(async () => acceptance.resolve(true));
      expect(textarea.value).toBe('');
      expect(container!.textContent).not.toContain('notes.txt');
    }
  );

  it('retains all drafts after failed admission and retries the same bytes', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
    const textarea = await renderComposer({
      composerRef,
      onSendMessage: async (...args) => {
        submissions.push(args);
        return false;
      },
    });
    await attachDrafts(composerRef);
    await submit('keyboard');
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('focus regression draft');
    expect(container!.textContent).toContain('notes.txt');
    await submit('keyboard');
    expect(submissions).toHaveLength(2);
    expect(submissions[1][2]?.attachments).toEqual(submissions[0][2]?.attachments);
  });

  it.each([
    ['queue', 'guide'],
    ['guide', 'queue'],
  ] as const)(
    'inverts a %s default to %s for attachment-only draft handoff',
    async (configured, expected) => {
      getDefaultStore().set(queuedMessageBehaviorAtom, configured);
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const textarea = await renderComposer({
        composerRef,
        onSendMessage: async (...args) => {
          submissions.push(args);
          return true;
        },
      });
      await attachDrafts(composerRef);
      await act(async () => composerRef.current!.setInputText(''));
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          })
        )
      );
      expect(submissions).toHaveLength(1);
      expect(submissions[0][0]).toEqual([]);
      expect(submissions[0][2]?.submitBehavior).toBe(expected);
      expect(submissions[0][2]?.attachments).toHaveLength(2);
    }
  );

  it.each([
    { isMachineRemoved: true },
    { isExternalHistoryRefreshing: true },
    { durableAgentRoleReady: false },
    { freeTurnLimitNotice: { current: 20, limit: 20 } },
    { isArchived: true },
    { isVisible: false },
  ])('does not hand off drafts when blocked: %j', async (overrides) => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionId = `blocked-draft-${++nextSession}`;
    const submissions: SessionInputBlock[][] = [];
    const onSendMessage = async (blocks: SessionInputBlock[]) => {
      submissions.push(blocks);
      return true;
    };
    await renderComposer({ composerRef, sessionId, onSendMessage });
    await attachDrafts(composerRef);
    await renderComposer({
      composerRef,
      sessionId,
      onSendMessage,
      isArchived: 'isArchived' in overrides ? overrides.isArchived : false,
      overrides,
    });
    await submit('keyboard');
    expect(submissions).toEqual([]);
    expect(container!.textContent).toContain('notes.txt');
  });

  it('a late draft acceptance preserves an external replacement prompt', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const acceptance = deferredBoolean();
    const textarea = await renderComposer({ composerRef, onSendMessage: () => acceptance.promise });
    await attachDrafts(composerRef);
    await submit('keyboard');
    await act(async () => composerRef.current!.setInputText('next message'));
    await act(async () => acceptance.resolve(true));
    expect(textarea.value).toBe('next message');
  });

  it('boundary: hidden composer rejects synthetic Enter even without uploads', async () => {
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      isVisible: false,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    await submit('keyboard');
    expect(delivered).toEqual([]);
  });

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

  for (const mobilePlatform of ['mobile-browser', 'wide-native'] as const) {
    function setMobilePlatform() {
      if (mobilePlatform === 'wide-native') {
        Object.defineProperty(window, '__LODY_NATIVE__', { configurable: true, value: true });
      } else {
        // A narrow desktop-class window stays in the desktop family now, so a
        // mobile browser is simulated by the phone identity, not width alone.
        Object.defineProperty(window.navigator, 'userAgent', {
          configurable: true,
          value:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        });
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

  /** jsdom has no ClipboardEvent, and React only reads `clipboardData`. */
  function createPasteEvent(text: string, files: File[] = []) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? text : ''),
        items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        files,
      },
    });
    return event;
  }

  function readBlobAsText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read blob'));
      reader.readAsText(blob);
    });
  }

  it('leaves a rich-text paste to the browser instead of attaching its bitmap', async () => {
    const textarea = await renderComposer({ onSendMessage: async () => true });
    // A Word or PowerPoint copy carries a picture of the selection beside the
    // text; consuming the paste for that picture dropped the text entirely.
    const event = createPasteEvent('Quarterly plan', [
      new File(['png'], 'image.png', { type: 'image/png' }),
    ]);

    await act(async () => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('focus regression draft');
  });

  describe('oversize pastes', () => {
    let errorToast: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorToast = vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    });

    afterEach(() => {
      errorToast.mockRestore();
    });

    it('turns a paste past the byte ceiling into a text attachment', async () => {
      const pastedText = 'a'.repeat(MAX_PASTED_TEXT_BYTE_SIZE + 1);
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const textarea = await renderComposer({
        onSendMessage: async (...args) => {
          submissions.push(args);
          return true;
        },
      });
      const event = createPasteEvent(pastedText);

      await act(async () => {
        textarea.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(textarea.value).toBe('focus regression draft');
      expect(container!.textContent).toContain('pasted-text.txt');
      expect(errorToast).not.toHaveBeenCalled();

      await submit('keyboard');

      const attachment = submissions[0]?.[2]?.attachments?.[0];
      expect(attachment).toMatchObject({
        kind: 'file',
        name: 'pasted-text.txt',
        mimeType: 'text/plain',
      });
      expect(attachment?.source?.size).toBe(new TextEncoder().encode(pastedText).length);
      expect(attachment?.source ? await readBlobAsText(attachment.source) : undefined).toBe(
        pastedText
      );
    });

    it('merges the generated file with real clipboard files', async () => {
      const pastedText = 'a'.repeat(MAX_PASTED_TEXT_BYTE_SIZE + 1);
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const textarea = await renderComposer({
        onSendMessage: async (...args) => {
          submissions.push(args);
          return true;
        },
      });
      const event = createPasteEvent(pastedText, [
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        new File(['rendered image'], 'image.png', { type: 'image/png' }),
      ]);

      await act(async () => {
        textarea.dispatchEvent(event);
      });
      await submit('keyboard');

      expect(submissions[0]?.[2]?.attachments?.map(({ name }) => name)).toEqual([
        'pasted-text.txt',
        'notes.txt',
      ]);
      expect(errorToast).not.toHaveBeenCalled();
    });

    it('still collapses a paste that sits at the ceiling', async () => {
      const textarea = await renderComposer({ onSendMessage: async () => true });
      const event = createPasteEvent('a'.repeat(MAX_PASTED_TEXT_BYTE_SIZE));

      await act(async () => {
        textarea.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(errorToast).not.toHaveBeenCalled();
      expect(textarea.value).toContain('Pasted');
      expect(textarea.value).toContain('focus regression draft');
      expect(textarea.value).not.toContain('aaaa');
    });
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

  describe('Send and Steer shortcut', () => {
    let hostRoot: Root | null = null;
    let hostContainer: HTMLDivElement | null = null;

    beforeEach(async () => {
      Object.assign(window, { __LODY_ELECTRON__: true, __LODY_PLATFORM__: { os: 'linux' } });
      __resetPlatformCacheForTests();
      hostContainer = document.createElement('div');
      document.body.appendChild(hostContainer);
      hostRoot = createRoot(hostContainer);
      await act(async () => hostRoot!.render(createElement(CommandShortcutHost)));
    });

    afterEach(async () => {
      await act(async () => hostRoot?.unmount());
      hostContainer?.remove();
      hostRoot = null;
      hostContainer = null;
      commands.resetAllUserKeybindings();
      Reflect.deleteProperty(window, '__LODY_ELECTRON__');
      Reflect.deleteProperty(window, '__LODY_PLATFORM__');
      __resetPlatformCacheForTests();
    });

    const pressCtrlEnter = async (target: EventTarget) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => target.dispatchEvent(event));
      return event;
    };

    const recordSubmissions = () => {
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const onSendMessage: SessionChatInputAreaProps['onSendMessage'] = async (...args) => {
        submissions.push(args);
        return true;
      };
      return { submissions, onSendMessage };
    };

    it('lists the command unbound by default so plain Mod+Enter keeps sending normally', async () => {
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage });
      expect(commands.getKeybindingsFor('session.sendSteer')).toEqual([]);
      textarea.focus();
      await pressCtrlEnter(textarea);
      expect(submissions).toHaveLength(1);
      expect(submissions[0][2]?.submitBehavior).toBeUndefined();
    });

    it('sends the focused draft once as a forced steer through the user binding', async () => {
      commands.setUserKeybindings('session.sendSteer', ['Mod+Enter']);
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage });
      textarea.focus();
      const event = await pressCtrlEnter(textarea);
      expect(event.defaultPrevented).toBe(true);
      expect(submissions).toHaveLength(1);
      expect(submissions[0][0]).toEqual([{ type: 'text', text: 'focus regression draft' }]);
      expect(submissions[0][2]?.submitBehavior).toBe('guide');
      expect(textarea.value).toBe('');
    });

    it('wins over the built-in inversion when rebound to Mod+Shift+Enter', async () => {
      commands.setUserKeybindings('session.sendSteer', ['Mod+Shift+Enter']);
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage });
      textarea.focus();
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          })
        )
      );
      expect(submissions).toHaveLength(1);
      expect(submissions[0][2]?.submitBehavior).toBe('guide');
    });

    it('ignores the binding while focus is outside the composer', async () => {
      commands.setUserKeybindings('session.sendSteer', ['Mod+Enter']);
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage });
      const other = document.createElement('textarea');
      document.body.appendChild(other);
      other.focus();
      const event = await pressCtrlEnter(other);
      other.remove();
      expect(event.defaultPrevented).toBe(false);
      expect(submissions).toEqual([]);
      expect(textarea.value).toBe('focus regression draft');
    });

    it('ignores the binding for a hidden composer', async () => {
      commands.setUserKeybindings('session.sendSteer', ['Mod+Enter']);
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage, isVisible: false });
      textarea.focus();
      await pressCtrlEnter(textarea);
      expect(submissions).toEqual([]);
    });

    it('leaves a key still composing in an IME to the input method', async () => {
      commands.setUserKeybindings('session.sendSteer', ['Mod+Enter']);
      const { submissions, onSendMessage } = recordSubmissions();
      const textarea = await renderComposer({ onSendMessage });
      textarea.focus();
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            ctrlKey: true,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          })
        )
      );
      expect(submissions).toEqual([]);
      expect(textarea.value).toBe('focus regression draft');
    });
  });
});
