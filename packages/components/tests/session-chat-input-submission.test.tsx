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
import { authTokenAtom } from '../src/atoms/runtime';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from '../src/lib/electron-session-file-sender';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { computeSha256Hex, uploadSessionFile } from '../src/lib/session-file-upload';
import { uploadSessionImage } from '../src/lib/session-image-upload';
import { resolveSessionMessageSubmitRoute } from '../src/components/sessions/session-message-submit-route';
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
  clearSessionChatInputDrafts,
  type SessionChatInputAreaHandle,
  type SessionChatInputAreaProps,
} from '../src/components/sessions/session-chat-input-area';
import { initI18n } from '../src/i18n';
import { MAX_PASTED_TEXT_BYTE_SIZE } from '../src/lib/pasted-text-draft';
import { toast } from 'sonner';

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
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
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
    getDefaultStore().set(localProbeResultAtom, null);
    getDefaultStore().set(authTokenAtom, null);
    getDefaultStore().set(currentWorkspaceIdAtom, null);
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

  async function attachPendingImage(composerRef: RefObject<SessionChatInputAreaHandle | null>) {
    await act(async () => {
      getDefaultStore().set(authTokenAtom, 'synthetic-upload-token');
      getDefaultStore().set(currentWorkspaceIdAtom, 'workspace-upload' as never);
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:synthetic-image',
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    let resolve!: (value: Awaited<ReturnType<typeof uploadSessionImage>>) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<Awaited<ReturnType<typeof uploadSessionImage>>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    vi.mocked(uploadSessionImage).mockReturnValueOnce(promise);
    await act(async () => {
      composerRef.current!.handleImageDrop([
        new File(['synthetic-image'], 'sample.png', { type: 'image/png' }),
      ]);
    });
    return { resolve, reject };
  }

  const uploadedImage = {
    imageId: 'synthetic-image-id',
    mimeType: 'image/png',
    fileName: 'sample.png',
    sizeBytes: 15,
    width: 1,
    height: 1,
  } as Awaited<ReturnType<typeof uploadSessionImage>>;

  it.each(['direct_dispatch', 'guide', 'queue'] as const)(
    'waits once and uses the latest routing callback for %s',
    async (expectedRoute) => {
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const sessionId = `upload-route-${++nextSession}`;
      const delivered: Array<{ route: string; blocks: SessionInputBlock[] }> = [];
      await renderComposer({
        sessionId,
        composerRef,
        onSendMessage: async (blocks) => {
          delivered.push({ route: 'stale', blocks });
          return true;
        },
      });
      const upload = await attachPendingImage(composerRef);
      const textarea = container!.querySelector('textarea')!;
      expect(
        container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled
      ).toBe(false);
      await act(async () => {
        for (let i = 0; i < 2; i++)
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(textarea.disabled).toBe(true);
      expect(delivered).toEqual([]);
      await renderComposer({
        sessionId,
        composerRef,
        onSendMessage: async (blocks) => {
          const route = resolveSessionMessageSubmitRoute({
            forceDirect: false,
            forceQueue: false,
            invertBehavior: false,
            isPromptBusy: expectedRoute !== 'direct_dispatch',
            hasUnfinishedAssistantTurn: expectedRoute !== 'direct_dispatch',
            nativeSteerAvailable: true,
            queuedMessageBehavior: expectedRoute === 'guide' ? 'guide' : 'queue',
          });
          delivered.push({ route: route.type, blocks });
          return true;
        },
      });
      await act(async () => upload.resolve(uploadedImage));
      expect(delivered).toEqual([
        {
          route: expectedRoute,
          blocks: [
            { type: 'image', ...uploadedImage },
            { type: 'text', text: 'focus regression draft' },
          ],
        },
      ]);
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe('');
    }
  );

  it('waits for every image and retains the inverted-send shortcut', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: Array<{ blocks: SessionInputBlock[]; inverted: boolean }> = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks, _role, options) => {
        delivered.push({ blocks, inverted: options?.invertSubmitBehavior === true });
        return true;
      },
    });
    await act(async () => composerRef.current!.setInputText(''));
    const first = await attachPendingImage(composerRef);
    const second = await attachPendingImage(composerRef);
    await act(async () =>
      container!.querySelector('textarea')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
      )
    );
    await act(async () => second.resolve({ ...uploadedImage, imageId: 'second-image' }));
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => first.resolve(uploadedImage));
    expect(delivered).toEqual([
      {
        inverted: true,
        blocks: [
          { type: 'image', ...uploadedImage },
          { type: 'image', ...uploadedImage, imageId: 'second-image' },
        ],
      },
    ]);
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
  });

  it('includes an image converted to a local file before automatically sending', async () => {
    getDefaultStore().set(localProbeResultAtom, { ok: true, machineId: 'machine-1' });
    vi.mocked(canUseElectronLocalFileSend).mockReturnValue(true);
    const localFile = {
      fileId: 'local-image',
      fileName: 'sample.png',
      mimeType: 'image/png',
      sizeBytes: 15,
      sha256: 'a'.repeat(64),
      transport: 'local' as const,
      machineId: 'machine-1',
      uploadedAt: 1,
    };
    vi.mocked(sendSessionFileToLocalRuntime).mockResolvedValue({ ok: true, files: [localFile] });
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => upload.reject(new Error('Synthetic offline upload')));
    expect(delivered).toEqual([
      [
        { type: 'file', ...localFile },
        { type: 'text', text: 'focus regression draft' },
      ],
    ]);
    expect(container!.querySelector('textarea')!.value).toBe('');
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
  });

  it('restores uploaded attachments when downstream acceptance rejects the send', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const acceptance = deferredBoolean();
    await renderComposer({ composerRef, onSendMessage: () => acceptance.promise });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => upload.resolve(uploadedImage));
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
    expect(container!.querySelector('button[aria-label="Cancel send"]')).toBeNull();
    expect(container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
      true
    );
    await act(async () => acceptance.resolve(false));
    expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
    expect(container!.querySelector('img')).not.toBeNull();
    expect(container!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(
      false
    );
  });

  it('keeps an existing upload intent across hidden tabs and locks config through acceptance', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionId = `background-upload-${++nextSession}`;
    const acceptance = deferredBoolean();
    const delivered: SessionInputBlock[][] = [];
    const onSendMessage = (blocks: SessionInputBlock[]) => {
      delivered.push(blocks);
      return acceptance.promise;
    };
    await renderComposer({ sessionId, composerRef, onSendMessage });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    const lockedConfig = () =>
      container!.querySelector<HTMLButtonElement>('button[aria-label="Run configuration"]');
    expect(lockedConfig()?.disabled).toBe(true);
    expect(container!.querySelector('[data-testid="desktop-permission-mode-button"]')).toBeNull();
    await renderComposer({ sessionId, composerRef, onSendMessage, isVisible: false });
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => upload.resolve(uploadedImage));
    expect(delivered).toEqual([
      [
        { type: 'image', ...uploadedImage },
        { type: 'text', text: 'focus regression draft' },
      ],
    ]);
    expect(container!.querySelector('button[aria-label="Cancel send"]')).toBeNull();
    expect(lockedConfig()?.disabled).toBe(true);
    await act(async () => acceptance.resolve(true));
    await renderComposer({ sessionId, composerRef, onSendMessage });
    expect(container!.querySelector('textarea')!.value).toBe('');
    expect(
      container!.querySelector('[data-testid="desktop-permission-mode-button"]')
    ).not.toBeNull();
    expect(delivered).toHaveLength(1);
  });

  it.each(['failure', 'cancel', 'switch', 'unmount', 'archived'] as const)(
    'preserves the draft and prevents automatic delivery after %s',
    async (reason) => {
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const sessionId = `upload-retire-${++nextSession}`;
      const delivered: SessionInputBlock[][] = [];
      const onSendMessage = async (blocks: SessionInputBlock[]) => {
        delivered.push(blocks);
        return true;
      };
      await renderComposer({ sessionId, composerRef, onSendMessage });
      const upload = await attachPendingImage(composerRef);
      await submit('button');
      if (reason === 'cancel')
        await act(async () =>
          container!.querySelector<HTMLButtonElement>('button[aria-label="Cancel send"]')!.click()
        );
      if (reason === 'archived')
        await renderComposer({ sessionId, composerRef, onSendMessage, isArchived: true });
      if (reason === 'switch')
        await renderComposer({ sessionId: `other-${nextSession}`, composerRef, onSendMessage });
      if (reason === 'unmount') {
        await act(async () => root!.unmount());
        root = createRoot(container!);
      }
      await act(async () => {
        if (reason === 'failure') upload.reject(new Error('Synthetic upload failure'));
        else upload.resolve(uploadedImage);
      });
      await renderComposer({ sessionId, composerRef, onSendMessage });
      expect(delivered).toEqual([]);
      expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
      expect(container!.querySelector('textarea')!.disabled).toBe(false);
      expect(container!.querySelector('img')).not.toBeNull();
    }
  );

  async function attachPendingFile(composerRef: RefObject<SessionChatInputAreaHandle | null>) {
    await act(async () => {
      getDefaultStore().set(authTokenAtom, 'synthetic-upload-token');
      getDefaultStore().set(currentWorkspaceIdAtom, 'workspace-upload' as never);
    });
    let hashed!: (value: string) => void;
    let resolve!: (value: Awaited<ReturnType<typeof uploadSessionFile>>) => void;
    let reject!: (reason: Error) => void;
    let progress: Parameters<typeof uploadSessionFile>[0]['onProgress'];
    vi.mocked(computeSha256Hex).mockReturnValueOnce(
      new Promise((done) => {
        hashed = done;
      })
    );
    const promise = new Promise<Awaited<ReturnType<typeof uploadSessionFile>>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    vi.mocked(uploadSessionFile).mockImplementationOnce((args) => {
      progress = args.onProgress;
      return promise;
    });
    await act(async () =>
      composerRef.current!.handleImageDrop([
        new File(['hello'], 'sample.txt', { type: 'text/plain' }),
      ])
    );
    return {
      hashed,
      resolve,
      reject,
      progress: (phase: 'uploading' | 'verifying') =>
        progress?.({ phase, percent: 100, loadedBytes: 5, totalBytes: 5 }),
    };
  }
  const uploadedFile = {
    fileId: 'synthetic-file',
    fileName: 'sample.txt',
    mimeType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    transport: 'cloud' as const,
    textPreview: true,
    uploadedAt: 1,
  };

  it('boundary: file preparation and verification both block automatic dispatch', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const upload = await attachPendingFile(composerRef);
    await submit('button');
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
    expect(delivered).toEqual([]);
    await act(async () => upload.hashed('a'.repeat(64)));
    await act(async () => upload.progress('uploading'));
    expect(delivered).toEqual([]);
    await act(async () => upload.progress('verifying'));
    expect(delivered).toEqual([]);
    await act(async () => upload.resolve(uploadedFile));
    expect(delivered).toEqual([
      [
        { type: 'file', ...uploadedFile },
        { type: 'text', text: 'focus regression draft' },
      ],
    ]);
  });

  it('boundary: an already failed file does not cancel waiting for a newly selected image', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const failedFile = await attachPendingFile(composerRef);
    await act(async () => failedFile.hashed('a'.repeat(64)));
    await act(async () => failedFile.reject(new Error('Old file failed')));
    const image = await attachPendingImage(composerRef);
    await submit('keyboard');
    expect(container!.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => image.resolve(uploadedImage));
    expect(delivered).toEqual([
      [
        { type: 'image', ...uploadedImage },
        { type: 'text', text: 'focus regression draft' },
      ],
    ]);
  });

  it('boundary: a file failure during waiting restores the draft without sending text alone', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const upload = await attachPendingFile(composerRef);
    await submit('keyboard');
    await act(async () => upload.hashed('a'.repeat(64)));
    await act(async () => upload.reject(new Error('Selected file failed')));
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
    expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
  });

  it('boundary: retiring the scope during the ready commit prevents the queued continuation', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionId = `commit-race-${++nextSession}`;
    const delivered: SessionInputBlock[][] = [];
    const onSendMessage = async (blocks: SessionInputBlock[]) => {
      delivered.push(blocks);
      return true;
    };
    await renderComposer({ sessionId, composerRef, onSendMessage });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => {
      upload.resolve(uploadedImage);
      // Let the upload handler publish its state before the joint commit.
      await Promise.resolve();
      await renderComposer({ sessionId, composerRef, onSendMessage, retireOnCommit: true });
    });
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
    expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
  });

  it('boundary: same-batch Enter sends one accepted message', async () => {
    const delivered: SessionInputBlock[][] = [];
    const acceptance = deferredBoolean();
    const textarea = await renderComposer({
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return acceptance.promise;
      },
    });
    await act(async () => {
      for (let i = 0; i < 3; i++)
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(delivered).toEqual([[{ type: 'text', text: 'focus regression draft' }]]);
    await act(async () => acceptance.resolve(true));
    expect(textarea.value).toBe('');
  });

  it('boundary: a failed image ends waiting before the other image settles', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const first = await attachPendingImage(composerRef);
    const second = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => first.reject(new Error('First image failed')));
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
    expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
    await act(async () => second.resolve(uploadedImage));
    expect(delivered).toEqual([]);
  });

  it.each([
    ['removed machine', { isMachineRemoved: true }],
    ['history refresh', { isExternalHistoryRefreshing: true }],
    ['role hydration', { durableAgentRoleReady: false }],
    ['turn limit', { freeTurnLimitNotice: { current: 20, limit: 20 } }],
  ] as const)('boundary: cancels waiting when blocked by %s', async (_name, overrides) => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionId = `blocked-upload-${++nextSession}`;
    const delivered: SessionInputBlock[][] = [];
    const onSendMessage = async (blocks: SessionInputBlock[]) => {
      delivered.push(blocks);
      return true;
    };
    await renderComposer({ sessionId, composerRef, onSendMessage });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await renderComposer({ sessionId, composerRef, onSendMessage, overrides });
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
    await act(async () => upload.resolve(uploadedImage));
    await renderComposer({ sessionId, composerRef, onSendMessage });
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.value).toBe('focus regression draft');
  });

  it.each(['cancel', 'switch-back'] as const)(
    'boundary: a new submission survives old %s completion',
    async (reason) => {
      const composerRef = createRef<SessionChatInputAreaHandle>();
      const sessionId = `resubmit-${++nextSession}`;
      const delivered: SessionInputBlock[][] = [];
      const onSendMessage = async (blocks: SessionInputBlock[]) => {
        delivered.push(blocks);
        return true;
      };
      await renderComposer({ sessionId, composerRef, onSendMessage });
      const upload = await attachPendingImage(composerRef);
      await submit('keyboard');
      if (reason === 'cancel')
        await act(async () =>
          container!.querySelector<HTMLButtonElement>('button[aria-label="Cancel send"]')!.click()
        );
      else {
        await renderComposer({ sessionId: `away-${nextSession}`, composerRef, onSendMessage });
        await renderComposer({ sessionId, composerRef, onSendMessage });
      }
      await act(async () => composerRef.current!.setInputText('replacement intent'));
      await submit('keyboard');
      await act(async () => upload.resolve(uploadedImage));
      expect(delivered).toEqual([
        [
          { type: 'image', ...uploadedImage },
          { type: 'text', text: 'replacement intent' },
        ],
      ]);
      expect(container!.querySelector('textarea')!.disabled).toBe(false);
    }
  );

  it('boundary: an external text edit cancels the waiting payload without losing the edit', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => composerRef.current!.setInputText('new draft from an external action'));
    await act(async () => upload.resolve(uploadedImage));
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.value).toBe('new draft from an external action');
  });

  it('boundary: removing an attachment never silently sends a partial payload', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const sessionId = `removed-upload-${++nextSession}`;
    const delivered: SessionInputBlock[][] = [];
    await renderComposer({
      sessionId,
      composerRef,
      onSendMessage: async (blocks) => {
        delivered.push(blocks);
        return true;
      },
    });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    clearSessionChatInputDrafts(sessionId);
    await act(async () => upload.resolve(uploadedImage));
    expect(delivered).toEqual([]);
    expect(container!.querySelector('textarea')!.disabled).toBe(false);
  });

  it('boundary: a late acceptance preserves an external replacement draft', async () => {
    const composerRef = createRef<SessionChatInputAreaHandle>();
    const acceptance = deferredBoolean();
    await renderComposer({ composerRef, onSendMessage: () => acceptance.promise });
    const upload = await attachPendingImage(composerRef);
    await submit('keyboard');
    await act(async () => upload.resolve(uploadedImage));
    await act(async () => composerRef.current!.setInputText('next message'));
    await act(async () => acceptance.resolve(true));
    expect(container!.querySelector('textarea')!.value).toBe('next message');
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
    let errors: string[] = [];

    beforeEach(() => {
      errors = [];
      vi.spyOn(toast, 'error').mockImplementation((message) => {
        errors.push(String(message));
        return 'toast';
      });
    });

    afterEach(() => {
      vi.mocked(toast.error).mockRestore();
    });

    it('refuses a paste past the byte ceiling and leaves the draft untouched', async () => {
      const textarea = await renderComposer({ onSendMessage: async () => true });
      const event = createPasteEvent('a'.repeat(MAX_PASTED_TEXT_BYTE_SIZE + 1));

      await act(async () => {
        textarea.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(textarea.value).toBe('focus regression draft');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('too large');
    });

    it('still collapses a paste that sits at the ceiling', async () => {
      const textarea = await renderComposer({ onSendMessage: async () => true });
      const event = createPasteEvent('a'.repeat(MAX_PASTED_TEXT_BYTE_SIZE));

      await act(async () => {
        textarea.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(errors).toEqual([]);
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
