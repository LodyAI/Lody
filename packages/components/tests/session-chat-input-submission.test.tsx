// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRole, AgentRoleId, SessionMeta } from '@lody/shared';

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

const desktopRunConfigState = vi.hoisted(() => ({
  agentRoles: undefined as
    | {
        onSendInstruction?: (role: AgentRole) => Promise<boolean>;
      }
    | undefined,
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

vi.mock('../src/components/chat/chat-composer', async () => {
  const React = await import('react');
  return {
    ChatComposer: (props: {
      promptRef?: React.Ref<HTMLTextAreaElement>;
      promptValue: string;
      promptDisabled?: boolean;
      onPromptChange: (value: string) => void;
      onPromptKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
      primaryAction?: React.ReactNode;
      footerSelector?: React.ReactNode;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement('textarea', {
          ref: props.promptRef,
          value: props.promptValue,
          disabled: props.promptDisabled,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            props.onPromptChange(event.target.value),
          onKeyDown: props.onPromptKeyDown,
        }),
        props.primaryAction,
        props.footerSelector
      ),
  };
});

vi.mock('../src/components/sessions/desktop-run-config-menu', async () => {
  const React = await import('react');
  return {
    DesktopPermissionModeButton: () =>
      React.createElement('div', { 'data-testid': 'desktop-permission-mode-button' }),
    DesktopRunConfigMenu: (props: {
      agentRoles?: { onSendInstruction?: (role: AgentRole) => Promise<boolean> };
    }) => {
      desktopRunConfigState.agentRoles = props.agentRoles;
      return null;
    },
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

import { SessionChatInputArea } from '../src/components/sessions/session-chat-input-area';
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
    sessionAgentRoleState.control = {
      items: [],
      selectedRoleId: null,
      onSelect: () => undefined,
    };
    desktopRunConfigState.agentRoles = undefined;
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

  it('keeps the composer draft when a Role instruction is sent separately', async () => {
    const instructionRole = {
      v: 1,
      id: 'role-instruction' as AgentRoleId,
      revision: 1,
      name: 'Reviewer',
      visibility: 'private',
      ownerUserId: 'user-1',
      machineId: 'machine-1',
      agentConfigId: 'agent-1',
      promptPrefix: 'Review only the current change.',
      runConfig: {},
      createdAt: 1,
      updatedAt: 1,
    } as AgentRole;
    sessionAgentRoleState.control = {
      items: [{ role: instructionRole, availability: { kind: 'available' } }],
      selectedRoleId: null,
      onSelect: () => undefined,
    };
    const onSendAgentRoleInstruction = vi.fn(async () => true);
    const onSendMessage = vi.fn(async () => true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-role-instruction',
            userId: 'user-1',
            machineId: 'machine-1',
            agentConfigId: 'agent-1',
            cliType: 'builtin',
            agentType: 'codex',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-09-03T00:00:00.000Z',
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
          onSendAgentRoleInstruction,
          onStop: () => undefined,
          onRemoveQueueItem: async () => undefined,
          initialInputText: 'Keep this draft exactly as-is.',
        })
      );
    });

    await act(async () => {
      await desktopRunConfigState.agentRoles?.onSendInstruction?.(instructionRole);
    });

    expect(onSendAgentRoleInstruction).toHaveBeenCalledWith(instructionRole);
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Keep this draft exactly as-is.');
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

    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => container.querySelector('button')?.click());
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
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
      container?.querySelector('button')?.click();
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

  it('dismisses the mobile keyboard for keyboard and button sends', async () => {
    let acceptance = deferredBoolean();
    Object.defineProperty(window, '__LODY_NATIVE__', {
      configurable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-mobile-keyboard-send',
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
          initialInputText: 'send from keyboard',
        })
      );
    });

    const textarea = container.querySelector('textarea');
    const blurSpy = vi.spyOn(textarea!, 'blur');
    textarea?.focus();
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
      await Promise.resolve();
    });

    expect(blurSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(textarea);
    expect(textarea?.value).toBe('');
    expect(textarea?.disabled).toBe(true);

    await act(async () => {
      acceptance.resolve(false);
      await acceptance.promise;
    });

    expect(textarea?.value).toBe('send from keyboard');
    expect(textarea?.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);

    acceptance = deferredBoolean();

    await act(async () => {
      container?.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(blurSpy).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(textarea);
    expect(textarea?.value).toBe('');
    expect(textarea?.disabled).toBe(true);

    await act(async () => {
      acceptance.resolve(true);
      await acceptance.promise;
    });

    expect(textarea?.disabled).toBe(false);
    expect(document.activeElement).not.toBe(textarea);
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

  it('does not restore focus when the session changes during a pending send', async () => {
    const acceptance = deferredBoolean();
    const sessionA: SessionMeta = {
      id: 'session-switch-a',
      userId: 'user-1',
      machineId: 'machine-1',
      cliType: 'builtin',
      agentType: 'codex',
      status: { type: 'idle' },
      isArchived: false,
      createdAt: '2026-07-19T00:00:00.000Z',
    } as SessionMeta;
    const sessionB: SessionMeta = {
      ...sessionA,
      id: 'session-switch-b',
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const baseProps = (session: SessionMeta) => ({
      session,
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
      initialInputText: 'draft before switch',
    });

    await act(async () => {
      root?.render(createElement(SessionChatInputArea, baseProps(sessionA)));
    });

    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('draft before switch');

    // Start the send — the textarea becomes disabled and the session id is
    // snapshotted inside sendMessage BEFORE the await.
    await act(async () => {
      container?.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(textarea?.disabled).toBe(true);

    // Switch the session prop in-place while the send is still pending.
    await act(async () => {
      root?.render(createElement(SessionChatInputArea, baseProps(sessionB)));
    });

    // The session switch resets submissionPending and loads session B's draft.
    // Now resolve the original send. The desktop focus-restore effect must see
    // that the stored session id (A) no longer matches the current session (B)
    // and skip the focus restore.
    await act(async () => {
      acceptance.resolve(false);
      await acceptance.promise;
    });

    const textareaAfterSwitch = container.querySelector('textarea');
    // Focus must NOT have been restored to the new session's textarea.
    expect(document.activeElement).not.toBe(textareaAfterSwitch);
  });
});
