// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@lody/shared';

const sessionAgentRoleState = vi.hoisted(() => ({
  control: {
    items: [],
    selectedRoleId: null,
    onSelect: () => undefined,
  },
}));

vi.mock('@posthog/react', () => ({ usePostHog: () => null }));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({}),
}));

vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: new Map(),
    isLoading: false,
    accessByMachineId: new Map(),
  }),
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal()),
  useSessionMentionItems: () => [],
}));

vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
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
import { useChatLandingImageDraft } from '../src/hooks/use-chat-landing-image-draft';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionChatInputArea clipboard paste handling', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
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
    if (typeof URL.createObjectURL === 'undefined') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn().mockReturnValue('blob:mock-image-url'),
      });
    }
    if (typeof URL.revokeObjectURL === 'undefined') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  const renderComposer = async () => {
    await act(async () => {
      root?.render(
        createElement(SessionChatInputArea, {
          session: {
            id: 'session-paste-test',
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

    const textarea = container!.querySelector('textarea');
    if (!textarea) {
      throw new Error('Expected textarea in SessionChatInputArea');
    }
    return textarea;
  };

  it('preserves native plain-text paste and avoids image upload when copying from Microsoft Word', async () => {
    const textarea = await renderComposer();
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    const imageFile = new File(['fake-png-data'], 'image.png', { type: 'image/png' });

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) =>
          format === 'text/plain' ? 'Paragraph copied from Microsoft Word' : '',
        items: [
          { kind: 'string', type: 'text/plain' },
          { kind: 'string', type: 'text/html' },
          { kind: 'string', type: 'text/rtf' },
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    await act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    // Native text paste must not be canceled so the browser can insert text into textarea
    expect(pasteEvent.defaultPrevented).toBe(false);
  });

  it('intercepts paste and handles files when clipboard contains no plain text', async () => {
    const textarea = await renderComposer();
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    const imageFile = new File(['fake-png-data'], 'screenshot.png', { type: 'image/png' });

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    await act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    // Pure image paste should be intercepted
    expect(pasteEvent.defaultPrevented).toBe(true);
  });

  it('captures large text as PastedTextDraft even when synthetic image file is present on clipboard', async () => {
    const textarea = await renderComposer();
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    const largeText = 'a'.repeat(2000);
    const imageFile = new File(['fake-png-data'], 'image.png', { type: 'image/png' });

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? largeText : ''),
        items: [
          { kind: 'string', type: 'text/plain' },
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    await act(async () => {
      textarea.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    // Verified that large text captured PastedTextDraft chip
    expect(container!.textContent).toContain('Pasted 2,000 chars');
  });
});

describe('useChatLandingImageDraft clipboard paste handling', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    if (typeof URL.createObjectURL === 'undefined') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn().mockReturnValue('blob:mock-image-url'),
      });
    }
    if (typeof URL.revokeObjectURL === 'undefined') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  it('does not intercept paste when plain text is present on clipboard', async () => {
    let hookResult!: ReturnType<typeof useChatLandingImageDraft>;

    function Probe() {
      hookResult = useChatLandingImageDraft({
        workspaceId: null,
        authToken: null,
        isMobile: false,
        projectKind: null,
        sessionId: 'test-session',
        ensureSessionId: async () => 'test-session',
      });
      return null;
    }

    await act(async () => {
      root?.render(createElement(Probe));
    });

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    const imageFile = new File(['fake-png-data'], 'image.png', { type: 'image/png' });

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format: string) => (format === 'text/plain' ? 'Word text content' : ''),
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    await act(async () => {
      hookResult.handlePromptPaste(
        pasteEvent as unknown as React.ClipboardEvent<HTMLTextAreaElement>
      );
    });

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(hookResult.imageItems.length).toBe(0);
  });
});
