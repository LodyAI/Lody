import { ScheduledMessageInfoBar } from '../src/components/schedules/scheduled-message-info-bar';
// @vitest-environment jsdom
import { LoroDoc } from 'loro-crdt';
import { ScheduleRepository, type MachineMeta, type ScheduleRepositoryPort } from '@lody/shared';
import { userAtom } from '../src/atoms';

import {
  act,
  Fragment,
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
import { computeSha256Hex, uploadSessionFile } from '../src/lib/session-file-upload';
import { uploadSessionImage } from '../src/lib/session-image-upload';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRole,
  AgentRoleId,
  McpServerId,
  SessionMeta,
  SessionInputBlock,
  WorkspaceMcpServerMeta,
} from '@lody/shared';

const scheduleMachine = vi.hoisted(() => ({ value: null as MachineMeta | null }));
vi.mock('../src/hooks/use-resolved-machine-meta', () => ({
  useResolvedMachineMeta: () => ({ machine: scheduleMachine.value, machineFlockRows: {} }),
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
vi.mock('../src/components/sessions/pending-image-markup-dialog', async () => {
  const { createElement: renderElement } = await import('react');
  return {
    PendingImageMarkupDialog: ({
      file,
      onAdd,
      onClose,
    }: {
      file: File;
      onAdd: (selection: import('../src/lib/document-selection').DocumentSelection) => boolean;
      onClose: () => void;
    }) =>
      renderElement(
        'div',
        {},
        renderElement(
          'button',
          {
            onClick: () =>
              onAdd({
                path: file.name,
                location: 'Image',
                comment: 'Fix the header',
                image: new File(['marked-pixels'], 'screenshot-selection.png', {
                  type: 'image/png',
                }),
              }),
          },
          'Apply image markup'
        ),
        renderElement('button', { onClick: onClose }, 'Cancel image markup')
      ),
  };
});

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
import { PASTED_TEXT_FILE_MIN_CHAR_COUNT } from '../src/lib/pasted-text-draft';
import { toast } from '@/lib/toast';

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
    scheduleMachine.value = null;
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
    withScheduleInfoBar = false,
  }: {
    sessionId?: string;
    onSendMessage: SessionChatInputAreaProps['onSendMessage'];
    isArchived?: boolean;
    isVisible?: boolean;
    overrides?: Partial<SessionChatInputAreaProps>;
    retireOnCommit?: boolean;
    withScheduleInfoBar?: boolean;
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
        createElement(
          Fragment,
          null,
          withScheduleInfoBar && overrides.session
            ? createElement(ScheduledMessageInfoBar, {
                session: overrides.session,
                machineMeta: scheduleMachine.value,
                status: null,
              })
            : null,
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
        )
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

  async function scheduledComposer(fail: boolean) {
    const store = getDefaultStore();
    store.set(userAtom, { id: 'user-1' } as never);
    store.set(currentWorkspaceIdAtom, 'workspace-upload' as never);
    scheduleMachine.value = {
      id: 'machine-1',
      ownerUserId: 'user-1',
      timeZone: 'Asia/Shanghai',
      protocolCapabilities: { schedules: 3 },
    } as MachineMeta;
    const docs = new Map<string, LoroDoc>();
    const rows = new Map<string, unknown>();
    const port: ScheduleRepositoryPort = {
      openPersistedDoc: async (id) => {
        if (!docs.has(id)) docs.set(id, new LoroDoc());
        return { doc: docs.get(id)! };
      },
      openFlockDoc: async () => ({
        flock: {
          scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
          get: (key) => rows.get(JSON.stringify(key)),
          set: (key, value) => rows.set(JSON.stringify(key), value),
        },
      }),
      flush: async () => {
        if (fail) throw new Error('Synthetic durable write failure');
      },
    };
    store.set(runtimeAtom, {
      workspaceId: 'workspace-upload',
      repo: port,
      sendResources: resources,
      withScheduleStore: async (_id: string, write: () => Promise<unknown>) => write(),
    } as never);
    const sessionId = `scheduled-${++nextSession}`;
    localStorage.setItem(
      `lody:scheduledMessageDraft:user-1:workspace-upload:${sessionId}`,
      JSON.stringify({
        at: '2099-01-01T00:00:00.000Z',
        scheduleId: 'scheduled-test',
        activationId: 'activation',
        activityId: 'create',
      })
    );
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const ordinary: SessionInputBlock[][] = [];
    await renderComposer({
      withScheduleInfoBar: true,
      sessionId,
      composerRef,
      onSendMessage: async (blocks) => {
        ordinary.push(blocks);
        return true;
      },
      overrides: {
        session: {
          id: sessionId,
          userId: 'user-1',
          machineId: 'machine-1',
          agentConfigId: 'agent-1',
          cliType: 'builtin',
          agentType: 'codex',
          createdAt: '2026-01-01T00:00:00Z',
        } as SessionMeta,
      },
    });
    return {
      composerRef,
      ordinary,
      repository: new ScheduleRepository(port, 'workspace-upload' as never),
    };
  }

  it('schedules complete content without sending now and clears only after durable acceptance', async () => {
    const h = await scheduledComposer(false);
    await act(async () => {
      h.composerRef.current!.addCommentReference({
        source: 'lody',
        path: 'notes.ts',
        lineNumber: 1,
        side: 'additions',
        commentBody: 'Review this',
        authorName: 'Reviewer',
      });
    });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="Schedule send"]')!.click();
    });
    const saved = await h.repository.read('scheduled-test');
    expect(
      saved?.message?.inputBlocks.some(
        (block) => block.type === 'text' && block.text === 'focus regression draft'
      )
    ).toBe(true);
    expect(saved?.message?.inputBlocks.some((block) => block.type === 'comment_reference')).toBe(
      true
    );
    expect(h.ordinary).toEqual([]);
    expect((await h.repository.list())[0]?.destination).toEqual({
      kind: 'existing_session',
      sessionId:
        saved?.definition.destination.kind === 'existing_session'
          ? saved.definition.destination.sessionId
          : '',
    });
    expect(container!.querySelector('textarea')?.value).toBe('');
    expect(container!.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });

  it('persists prepared image references in the reservation before releasing the original draft', async () => {
    const h = await scheduledComposer(false);
    getDefaultStore().set(authTokenAtom, 'synthetic-token');
    vi.mocked(uploadSessionImage).mockImplementation(async () => ({
      imageId: 'scheduled-image',
      mimeType: 'image/png',
      fileName: 'sample.png',
      sizeBytes: 15,
      width: 1,
      height: 1,
    }));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:scheduled-image',
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    await act(async () => {
      h.composerRef.current!.handleImageDrop([
        new File(['synthetic-image'], 'sample.png', { type: 'image/png' }),
      ]);
    });
    expect(container!.querySelector('img[alt="sample.png"]')).not.toBeNull();
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="Schedule send"]')!.click();
    });
    const saved = await h.repository.read('scheduled-test');
    expect(saved?.message?.inputBlocks).toContainEqual(
      expect.objectContaining({ type: 'image', imageId: 'scheduled-image' })
    );
    expect(h.ordinary).toEqual([]);
    expect(container!.querySelector('img[alt="sample.png"]')).toBeNull();
  });

  it('keeps the original text and time after a schedule write fails', async () => {
    const h = await scheduledComposer(true);
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="Schedule send"]')!.click();
    });
    expect(h.ordinary).toEqual([]);
    expect(await h.repository.list()).toEqual([]);
    expect(container!.querySelector('textarea')?.value).toBe('focus regression draft');
    expect(container!.querySelector('button[aria-label="Schedule send"]')).not.toBeNull();
  });

  const clickText = async (text: string) => {
    await act(async () => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.textContent === text
      )!;
      button.click();
    });
  };
  const openScheduleEdit = async () => {
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Scheduled message"]')!.click()
    );
    await clickText('Edit');
  };

  it('edits the info-bar schedule and sends using the shared updated time', async () => {
    const h = await scheduledComposer(false);
    expect(
      container!.querySelector('[data-info-bar-surface] button[aria-label="Scheduled message"]')
    ).not.toBeNull();
    expect(container!.textContent).not.toContain('Scheduled message will be sent');
    await openScheduleEdit();
    const field = document.querySelector<HTMLInputElement>('input[type=datetime-local]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        field,
        '2099-01-02T09:30'
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickText('Apply');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('button[aria-label="Schedule send"]')!.click()
    );
    expect((await h.repository.read('scheduled-test'))?.definition.trigger).toEqual({
      kind: 'once',
      at: '2099-01-02T01:30:00.000Z',
    });
    expect(container!.querySelector('button[aria-label="Scheduled message"]')).toBeNull();
  });

  it('cancels scheduling from the info bar while retaining the message draft', async () => {
    await scheduledComposer(false);
    await openScheduleEdit();
    await clickText('Remove time');
    expect(container!.querySelector('textarea')?.value).toBe('focus regression draft');
    expect(container!.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(container!.querySelector('button[aria-label="Scheduled message"]')).toBeNull();
  });

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

  it('stages a document selection beside the existing prompt and preserves it after rejected send', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const submissions: SessionInputBlock[][] = [];
    const textarea = await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        submissions.push(blocks);
        return false;
      },
    });
    await act(async () => {
      composerRef.current!.setInputText('Keep this prompt');
    });
    textarea.setSelectionRange(0, 4);
    await act(async () => {
      expect(
        composerRef.current!.addDocumentSelection({
          path: 'reports/annual.pdf',
          location: 'Page 3',
          text: 'Revenue increased.',
          comment: 'Explain why',
        })
      ).toBe(true);
    });
    expect(textarea.value).toContain('Keep this prompt');
    expect(textarea.value).toContain('annual.pdf');
    await submit('keyboard');
    expect(submissions[0]).toMatchObject([
      { type: 'text', text: expect.stringContaining('Keep this prompt\n\nDocument selection') },
    ]);
    expect((submissions[0][0] as { text: string }).text).toContain(
      'File: reports/annual.pdf\nLocation: Page 3\nSelected content:\nRevenue increased.\nComment:\nExplain why'
    );
    expect(textarea.value).toContain('annual.pdf');
    await submit('keyboard');
    expect(submissions[1]).toEqual(submissions[0]);
  });

  it('rejects image annotations atomically when image input is disabled or the session is archived', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const textarea = await renderComposer({
      composerRef,
      onSendMessage: async () => true,
      overrides: { disableImageUpload: true },
    });
    const original = textarea.value;
    await act(async () => {
      expect(
        composerRef.current!.addDocumentSelection({
          path: 'report.pdf',
          location: 'Page 1',
          image: new File(['png'], 'selection.png', { type: 'image/png' }),
        })
      ).toBe(false);
    });
    expect(textarea.value).toBe(original);
    await renderComposer({ composerRef, isArchived: true, onSendMessage: async () => true });
    await act(async () => {
      expect(
        composerRef.current!.addDocumentSelection({
          path: 'report.pdf',
          location: 'Page 1',
          text: 'excerpt',
        })
      ).toBe(false);
    });
    expect(container!.textContent).not.toContain('report.pdf');
  });

  it('hands annotated pixels and source context to the same send without starting uploads', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (...args) => {
        submissions.push(args);
        return false;
      },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:selection',
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const image = new File(['annotated-pixels'], 'report-selection.png', { type: 'image/png' });
    await act(async () => {
      expect(
        composerRef.current!.addDocumentSelection({
          path: 'report.pdf',
          location: 'Page 1',
          comment: 'Review layout',
          image,
        })
      ).toBe(true);
    });
    await submit('keyboard');
    expect(submissions[0][0]).toMatchObject([
      {
        type: 'text',
        text: expect.stringContaining(
          'Annotated image: report-selection.png\nComment:\nReview layout'
        ),
      },
    ]);
    expect(submissions[0][2]?.attachments).toMatchObject([
      { kind: 'image', name: 'report-selection.png', source: image },
    ]);
    await submit('keyboard');
    expect(submissions[1][2]?.attachments).toMatchObject([
      { kind: 'image', name: 'report-selection.png', source: image },
    ]);
  });

  it.each([true, false])(
    'preserves the original screenshot unless markup is accepted: %s',
    async (accept) => {
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      await renderComposer({
        composerRef,
        onSendMessage: async (...args) => {
          submissions.push(args);
          return false;
        },
      });
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:screenshot',
      });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
      const original = new File(['original-pixels'], 'screenshot.png', { type: 'image/png' });
      await act(async () => composerRef.current!.handleImageDrop([original]));
      await act(async () =>
        container!
          .querySelector<HTMLButtonElement>('button[aria-label="Mark up screenshot.png"]')!
          .click()
      );
      const label = accept ? 'Apply image markup' : 'Cancel image markup';
      await act(async () =>
        Array.from(container!.querySelectorAll('button'))
          .find((button) => button.textContent === label)!
          .click()
      );
      await submit('keyboard');
      const attachments = submissions[0][2]?.attachments;
      expect(attachments).toHaveLength(1);
      if (accept) {
        expect(attachments).toMatchObject([
          { kind: 'image', name: 'screenshot-selection.png', source: { size: 13 } },
        ]);
        expect(submissions[0][0]).toMatchObject([
          { type: 'text', text: expect.stringContaining('Comment:\nFix the header') },
        ]);
      } else {
        expect(attachments).toMatchObject([{ kind: 'image', name: 'screenshot.png' }]);
        const content = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsText(attachments![0].source);
        });
        expect(content).toBe('original-pixels');
      }
    }
  );

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

  describe('MCP selection', () => {
    const servers: WorkspaceMcpServerMeta[] = ['files', 'search'].map((id) => ({
      id: id as McpServerId,
      name: id,
      transport: 'stdio',
      createdAt: 1,
      updatedAt: 1,
    }));
    const mcp = (selectedIds: string[]) => ({
      servers,
      selectedIds: selectedIds as McpServerId[],
      onSelectedIdsChange: () => undefined,
    });

    it('cannot send while the selection waits on unread project defaults', async () => {
      const onSendMessage = vi.fn(async () => true);
      await renderComposer({
        onSendMessage,
        overrides: { mcp: mcp([]), mcpSelectionReady: false },
      });
      expect(
        container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled
      ).toBe(true);
      await submit('keyboard');
      expect(onSendMessage).not.toHaveBeenCalled();
    });

    it('dispatches the selection shown at the click, not one that changed before acceptance', async () => {
      const acceptance = deferredBoolean();
      const submissions: Parameters<SessionChatInputAreaProps['onSendMessage']>[] = [];
      const onSendMessage: SessionChatInputAreaProps['onSendMessage'] = (...args) => {
        submissions.push(args);
        return acceptance.promise;
      };
      const sessionId = `mcp-snapshot-${++nextSession}`;
      await renderComposer({ sessionId, onSendMessage, overrides: { mcp: mcp(['files']) } });
      await submit('button');
      // The project's defaults change while the send is still pending.
      await renderComposer({ sessionId, onSendMessage, overrides: { mcp: mcp(['search']) } });
      await act(async () => acceptance.resolve(true));
      expect(submissions).toHaveLength(1);
      expect(submissions[0][2]?.mcpServerIds).toEqual(['files']);
    });
  });

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

  it('retains queue inversion for attachment-only draft handoff', async () => {
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
    expect(submissions[0][2]?.invertSubmitBehavior).toBe(true);
    expect(submissions[0][2]?.attachments).toHaveLength(2);
  });

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

    it.each(['a', '日'])('turns 50,000 %s characters into a text attachment', async (character) => {
      const pastedText = character.repeat(50_000);
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
      const pastedText = 'a'.repeat(PASTED_TEXT_FILE_MIN_CHAR_COUNT + 1);
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

    it('still collapses a paste below 50,000 characters', async () => {
      const textarea = await renderComposer({ onSendMessage: async () => true });
      const event = createPasteEvent('a'.repeat(49_999));

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
});
