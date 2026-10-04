// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';

import SessionChatStream from '../src/components/ai-gui';
import { ForceDesktopLayoutProvider } from '../src/hooks/use-mobile';
import { initI18n } from '../src/i18n';
import {
  createConversationViewFromHistory,
  type ConversationView,
} from '../src/lib/conversation-view';
import type { CloudApi } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';

// Rows issue cloud queries (sender identity); the platform boundary stays real,
// only the network SDK is stubbed.
const STUB_CLOUD_API: CloudApi = {
  useQuery: () => undefined,
  useMutation: () => () => Promise.resolve(undefined as never),
  useAction: () => () => Promise.resolve(undefined as never),
};
const TEST_PLATFORM = { ...TEST_CLOUD_PLATFORM, cloudApi: STUB_CLOUD_API };

// The windowing hook waits on viewport reports that never arrive under jsdom;
// the full materialized window keeps the row-wiring behavior under test real.
vi.mock('@/hooks/use-conversation-stream-items', async () => {
  const { buildChatStreamItems } = await import('@/components/ai-gui/build-chat-stream-items');
  return {
    useConversationStreamItems: (view: ConversationView | null, sessionId: SessionId) => {
      const built = view
        ? buildChatStreamItems(view, sessionId)
        : { items: [], lastAssistantMessageId: null, lastCompletedAssistantMessageId: null };
      return {
        initialWindowReady: true,
        items: built.items,
        lastAssistantMessageId: built.lastAssistantMessageId,
        lastCompletedAssistantMessageId: built.lastCompletedAssistantMessageId,
        onVisibleTurnRangeChange: () => {},
        onOutlinePreviewRound: () => {},
        onRetainedTurnIdsChange: () => {},
      };
    },
  };
});

// Mention expansion pulls in the authenticated workspace scope; it is
// orthogonal to the affordance gating under test.
vi.mock('@/components/mentions/mention-expansion', () => ({
  useMentionPromptExpansion: () => ({
    expand: ({ text }: { text: string }) => ({ text, spans: undefined }),
  }),
}));

// The editor's mention textarea mounts the full mention catalog (workspace
// scope, session search); a plain textarea keeps the open-and-prefill behavior
// under test without that machinery.
vi.mock('@/components/mentions/combined-mention-textarea', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    CombinedMentionTextarea: ({
      value,
      onValueChange,
    }: {
      value: string;
      onValueChange?: (next: string) => void;
    }) =>
      createMockElement('textarea', {
        value,
        onChange: (event: { target: { value: string } }) => onValueChange?.(event.target.value),
      }),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'edit-affordance' as SessionId;

const history = [
  {
    id: 'user-1',
    role: 'user',
    timestamp: '2026-10-02T00:00:00Z',
    items: [{ type: 'text', text: 'First question' }],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '2026-10-02T00:00:01Z',
    items: [{ type: 'text', text: 'First answer' }],
    fileDiff: [],
    finished: true,
  },
  {
    id: 'user-2',
    role: 'user',
    timestamp: '2026-10-02T00:00:02Z',
    items: [{ type: 'text', text: 'Second question' }],
  },
];

const editButtonSelector = 'button[aria-label="Edit message"]';

describe('last user message edit affordance', () => {
  let root: Root;
  let container: HTMLDivElement;
  let view: ConversationView | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    view?.dispose();
    view = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderStream(withEditHandler: boolean) {
    view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history as never,
      subscribe: () => () => {},
    });
    await act(async () =>
      root.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            PlatformContext.Provider,
            { value: TEST_PLATFORM },
            createElement(
              ForceDesktopLayoutProvider,
              null,
              createElement(SessionChatStream, {
                sessionId,
                view: view!,
                ...(withEditHandler ? { onEditLastUser: async () => true } : {}),
              })
            )
          )
        )
      )
    );
  }

  it('renders no edit button when the surface does not support edit-and-resend', async () => {
    await renderStream(false);
    expect(container.querySelectorAll(editButtonSelector)).toHaveLength(0);
  });

  it('renders the edit button only on the last user message when supported', async () => {
    await renderStream(true);
    const buttons = container.querySelectorAll<HTMLButtonElement>(editButtonSelector);
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0]!.click();
    });
    const editors = [...container.querySelectorAll('textarea')].map((el) => el.value);
    expect(editors).toEqual(['Second question']);
  });
});
