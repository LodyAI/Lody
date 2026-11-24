// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { createStaticStore, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

import {
  getSessionRoomId,
  type SessionHistory,
  type SessionHistoryParsed,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '../src/atoms';
import { setDocMetaByRoomIdAtom } from '../src/atoms/doc-meta';
import { runtimeAtom } from '../src/atoms/runtime';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { MessageRowView } from '../src/components/ai-gui/view';
import { ForceDesktopLayoutProvider } from '../src/hooks/use-mobile';
import { useWorkspaceMembers } from '../src/hooks/use-workspace-members';
import { useWorkspaceSenderProfile } from '../src/hooks/use-workspace-sender-profile';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { markPersistentWorkspaceSenderCloudApi } from '../src/lib/workspace-sender-identity';
import { LocalPlatformConvexProvider } from '../src/providers/convex-provider';
import { TEST_CLOUD_PLATFORM } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'session-sender-identity' as SessionId;
const message = {
  id: 'message-from-maya',
  role: 'user',
  userId: 'user-maya',
  timestamp: '2026-09-08T10:30:00.000Z',
  read: true,
  status: 'applied',
  items: [{ type: 'text', text: 'Please show who sent this message.' }],
} as unknown as SessionHistoryParsed;
const user = { name: 'Maya Chen', email: 'maya.chen@example.com', image: null };

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('user message sender identity', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message,
              sessionId,
              user,
              showSenderIdentity: true,
            })
          )
        )
      );
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    localStorage.clear();
  });

  it('opens the desktop sender card from the avatar', async () => {
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="View profile for Maya Chen"]'
    );
    expect(trigger).toBeTruthy();
    expect(document.body.textContent).not.toContain('maya.chen@example.com');

    await click(trigger!);

    expect(document.body.textContent).toContain('Maya Chen');
    expect(document.body.textContent).toContain('maya.chen@example.com');
  });

  it('shows a Role author in a solo workspace without the human profile and exposes source model details', async () => {
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'source-session',
      turnId: 'source-turn',
      name: 'Agent A',
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
      model: { id: 'model-a', source: 'runtime' as const },
    };
    const history = [
      { ...message, author, inputConfig: { modelId: 'model-b' } },
    ] as unknown as SessionHistory[];
    const projected = buildChatStreamItems(
      createConversationViewFromHistory({
        sessionId,
        getHistory: () => history,
        subscribe: () => () => {},
      }),
      sessionId
    ).items[0];
    if (projected?.type !== 'message') throw new Error('Expected hydrated message');
    await act(async () =>
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message: projected.message,
              sessionId,
              user,
              showSenderIdentity: false,
            })
          )
        )
      )
    );
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Reviewer');
    expect(container?.querySelector('[data-testid="user-message-source-session-link"]')).toBeNull();
    expect(container?.textContent).toContain('🔎');
    expect(container?.querySelector('button[aria-label="View profile for Maya Chen"]')).toBeNull();
    const trigger = container?.querySelector('button[aria-label="View sender: Reviewer"]');
    expect(trigger).toBeTruthy();
    await click(trigger!);
    expect(document.body.textContent).toContain('Model: model-a');
    expect(document.body.textContent).not.toContain('maya.chen@example.com');
    expect(document.body.textContent).not.toContain('Model: model-b');
  });

  it('renders an inline source conversation link in the metadata row and navigates back to the source session', async () => {
    const onNavigateSession = vi.fn();
    const store = createStore();
    const author = {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'source-session',
      turnId: 'source-turn',
      name: 'Agent A',
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
    };
    const delegatedMessage = { ...message, author } as unknown as SessionHistoryParsed;

    await act(async () =>
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message: delegatedMessage,
              sessionId,
              user,
              showSenderIdentity: false,
              onNavigateSession,
            })
          )
        )
      )
    );

    const sourceButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="user-message-source-session-link"]'
    );
    expect(sourceButton).toBeTruthy();
    expect(sourceButton?.textContent).toBe('Open source conversation');
    expect(sourceButton?.getAttribute('aria-label')).toBe('Open source conversation');

    await click(sourceButton!);
    expect(onNavigateSession).toHaveBeenCalledTimes(1);
    expect(onNavigateSession).toHaveBeenCalledWith({ sessionId: 'source-session' });

    await act(async () => {
      store.set(setDocMetaByRoomIdAtom, getSessionRoomId('source-session' as SessionId), {
        id: 'source-session',
        title: 'Coordinate PR #789 fix',
      });
    });

    const updatedButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="user-message-source-session-link"]'
    );
    expect(updatedButton?.textContent).toBe('Coordinate PR #789 fix');
    expect(updatedButton?.getAttribute('aria-label')).toBe(
      'Open source conversation: Coordinate PR #789 fix'
    );
  });

  it('keeps sender identity hidden when the workspace has one member', async () => {
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message,
              sessionId,
              user,
              showSenderIdentity: false,
            })
          )
        )
      );
    });

    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).not.toContain('Maya Chen');
    expect(container?.querySelector('button[aria-label="View profile for Maya Chen"]')).toBeNull();
  });

  it('uses email fallback consistently in metadata when the sender account has no display name', async () => {
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          null,
          createElement(
            ForceDesktopLayoutProvider,
            null,
            createElement(MessageRowView, {
              message,
              sessionId,
              user: { name: '   ', email: 'alex@example.com', image: null },
              showSenderIdentity: true,
            })
          )
        )
      );
    });

    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('alex@example.com');
    expect(
      container?.querySelector('button[aria-label="View profile for alex@example.com"]')
    ).toBeTruthy();
  });

  it('keeps multi-member sender names stable before getUserById resolves, across row remounts, and isolated per account/workspace', async () => {
    const workspaceId = 'workspace-team-alpha' as WorkspaceId;
    const otherWorkspaceId = 'workspace-team-beta' as WorkspaceId;
    let directoryRows:
      | Array<{ userId: string; name: string | null; image: string | null }>
      | undefined = [
      { userId: 'user-self', name: 'Alex Self', image: null },
      { userId: 'user-maya', name: 'Maya Chen', image: null },
    ];
    let userByIdResult:
      | { id: string; name?: string; email?: string; image?: string | null }
      | null
      | undefined = undefined;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };

    const makePlatform = (accountId: string, activeWsId: WorkspaceId): PlatformProvider => ({
      ...TEST_CLOUD_PLATFORM,
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore({ status: 'authenticated', user: { id: accountId } }),
      },
      workspaces: {
        ...TEST_CLOUD_PLATFORM.workspaces,
        state: createStaticStore({
          status: 'ready',
          workspaces: [
            {
              id: activeWsId,
              name: 'Team',
              slug: activeWsId,
              role: 'member',
              contentMode: 'plaintext',
            },
          ],
          activeWorkspaceId: activeWsId,
        }),
      },
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useOptionalAuthenticatedQuery: (_op, args) => {
          const rows = useSyncExternalStore(subscribe, () => directoryRows);
          return (
            args === 'skip'
              ? { data: undefined, error: null, retry: () => {} }
              : { data: rows, error: null, retry: () => {} }
          ) as never;
        },
        useQuery: (op, args) => {
          const profile = useSyncExternalStore(subscribe, () => userByIdResult);
          if (args === 'skip' || op.name !== 'auth:getUserById') return undefined as never;
          return profile as never;
        },
      },
    });

    const platform = makePlatform('user-self', workspaceId);
    markPersistentWorkspaceSenderCloudApi(platform.cloudApi!);
    const makeStore = (accountId: string, activeWsId: WorkspaceId) => {
      const store = createStore();
      store.set(userAtom, {
        id: accountId,
        name: accountId === 'user-self' ? 'Alex Self' : 'Other User',
        email: `${accountId}@example.com`,
      } as never);
      store.set(currentWorkspaceIdAtom, activeWsId);
      store.set(currentWorkspaceSlugAtom, activeWsId);
      store.set(runtimeAtom, {
        workspaceId: activeWsId,
        workspaceSlug: activeWsId,
        accountId,
        contentMode: 'plaintext',
      } as never);
      store.set(workspaceContentModeAtom, {
        accountId,
        workspaceId: activeWsId,
        workspaceSlug: activeWsId,
        descriptor: { workspaceId: activeWsId, contentMode: 'plaintext', contentModeVersion: 1 },
      } as never);
      return store;
    };

    function ConnectedSurface({
      activeWsId,
      renderRow = true,
    }: {
      activeWsId: WorkspaceId;
      renderRow?: boolean;
    }) {
      const { isMultiMember } = useWorkspaceMembers();
      const resolvedUser = useWorkspaceSenderProfile({
        userId: message.userId,
        workspaceId: activeWsId,
      });
      return renderRow ? (
        <ForceDesktopLayoutProvider>
          <MessageRowView
            message={message}
            sessionId={sessionId}
            user={resolvedUser}
            showSenderIdentity={isMultiMember}
          />
        </ForceDesktopLayoutProvider>
      ) : (
        <output data-multi-member={String(isMultiMember)} />
      );
    }

    const authClient = {
      useActiveOrganization: () => ({ data: null, isPending: false }),
    } as never;

    const renderSurface = (
      activeStore: ReturnType<typeof createStore>,
      activeWsId: WorkspaceId,
      renderRow = true
    ) => (
      <LocalPlatformConvexProvider authClient={authClient}>
        <PlatformContext.Provider value={platform}>
          <JotaiProvider store={activeStore}>
            <ConnectedSurface activeWsId={activeWsId} renderRow={renderRow} />
          </JotaiProvider>
        </PlatformContext.Provider>
      </LocalPlatformConvexProvider>
    );

    const store = makeStore('user-self', workspaceId);

    await act(async () => {
      root?.render(renderSurface(store, workspaceId));
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Maya Chen');

    await act(async () => {
      userByIdResult = {
        id: 'user-maya',
        name: 'Maya Chen',
        email: 'maya.chen@example.com',
        image: null,
      };
      notify();
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Maya Chen');

    await act(async () => {
      directoryRows = undefined;
      userByIdResult = undefined;
      root?.render(renderSurface(store, workspaceId, false));
    });
    expect(container?.querySelector('output')?.getAttribute('data-multi-member')).toBe('true');

    await act(async () => {
      root?.render(renderSurface(store, workspaceId));
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Maya Chen');
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="View profile for Maya Chen"]'
    );
    expect(trigger).toBeTruthy();
    await click(trigger!);
    expect(document.body.textContent).toContain('maya.chen@example.com');

    const reloadedPlatform = makePlatform('user-self', workspaceId);
    markPersistentWorkspaceSenderCloudApi(reloadedPlatform.cloudApi!);
    await act(async () => {
      root?.render(
        <LocalPlatformConvexProvider authClient={authClient}>
          <PlatformContext.Provider value={reloadedPlatform}>
            <JotaiProvider store={store}>
              <ConnectedSurface activeWsId={workspaceId} />
            </JotaiProvider>
          </PlatformContext.Provider>
        </LocalPlatformConvexProvider>
      );
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).toContain('Maya Chen');

    await act(async () => {
      userByIdResult = null;
      notify();
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).not.toContain('Maya Chen');

    const otherStore = makeStore('user-other', otherWorkspaceId);
    await act(async () => {
      root?.render(renderSurface(otherStore, otherWorkspaceId));
    });
    expect(
      container?.querySelector('[data-testid="user-message-metadata"]')?.textContent
    ).not.toContain('Maya Chen');
  });
});
