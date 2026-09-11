// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type SessionHistoryParsed, type SessionId } from '@lody/shared';

import { setDocMetaByRoomIdAtom } from '../src/atoms/doc-meta';
import { MessageRowView } from '../src/components/ai-gui/view';
import { SessionRelationCard } from '../src/components/shared/session-relation-card';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openerSessionId = 'opener-session' as SessionId;
const createdSessionId = 'created-session' as SessionId;

const completionMessage: SessionHistoryParsed = {
  id: 'create-completion',
  role: 'system',
  timestamp: '2026-08-14T12:00:00.000Z',
  read: true,
  items: [
    {
      type: 'operation_completion',
      deliveryId: 'operation:create-child:completion',
      operationId: 'create-child',
      operationKind: 'session_create',
      completion: {
        type: 'result',
        value: {
          items: [
            {
              status: 'succeeded',
              label: 'Fallback operation label',
              target: { sessionId: createdSessionId, userTurnId: 'user-turn' },
              assistantTurnId: 'assistant-turn',
            },
          ],
        },
      },
    },
  ],
};

describe('Session relation cards', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('navigates back to the precise opener from the provenance card', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <SessionRelationCard
          relation="opened-by"
          label="This session was automatically created by"
          sessionTitle="Child Tab Opener"
          actionLabel="Back to session"
          onAction={() => onOpen(openerSessionId)}
        />
      );
    });

    expect(container.textContent).toContain('Child Tab Opener');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(onOpen).toHaveBeenCalledWith(openerSessionId);
  });

  it('shows dangling provenance without a navigation action', async () => {
    await act(async () => {
      root.render(
        <SessionRelationCard
          relation="opened-by"
          label="This session was automatically created by"
          sessionTitle="Deleted session"
          actionLabel="Back to session"
        />
      );
    });

    expect(container.textContent).toContain('Deleted session');
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });

  it('turns a successful session_create completion into a live Session card', async () => {
    const store = createStore();
    store.set(setDocMetaByRoomIdAtom, getSessionRoomId(createdSessionId), {
      id: createdSessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: '2026-08-14T12:00:00.000Z',
      title: 'Generated child conversation title',
    });
    const onNavigateSession = vi.fn();

    await act(async () => {
      root.render(
        <Provider store={store}>
          <MessageRowView
            message={completionMessage}
            sessionId={openerSessionId}
            onNavigateSession={onNavigateSession}
          />
        </Provider>
      );
    });

    expect(container.querySelector('[data-session-create-completion]')).not.toBeNull();
    expect(container.textContent).toContain('Generated child conversation title');
    expect(container.textContent).not.toContain('Fallback operation label');

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('View session'))
        ?.click();
    });
    expect(onNavigateSession).toHaveBeenCalledWith({ sessionId: createdSessionId });
  });

  it('shows a navigable card before completion and updates the same card through target states', async () => {
    const store = createStore();
    const onNavigateSession = vi.fn();
    let card: Element | null = null;
    for (const status of ['created', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      const message: SessionHistoryParsed = {
        id: 'create-progress',
        role: 'system',
        read: true,
        timestamp: '2026-08-14T12:00:00.000Z',
        items: [
          {
            type: 'operation_progress',
            operationId: 'create-child',
            operationKind: 'session_create',
            items: [
              {
                status,
                label: 'Created child Tab',
                target: { sessionId: createdSessionId, userTurnId: 'user-turn' },
              },
            ],
          },
        ],
      };
      await act(async () => {
        root.render(
          <Provider store={store}>
            <MessageRowView
              message={message}
              sessionId={openerSessionId}
              onNavigateSession={onNavigateSession}
            />
          </Provider>
        );
      });
      const current = container.querySelector('[data-session-relation-card="opened"]');
      expect(current).not.toBeNull();
      if (card) expect(current).toBe(card);
      card = current;
      expect(
        container.querySelector('[role="status"]')?.getAttribute('data-session-creation-status')
      ).toBe(status);
      expect(container.textContent).toContain('Created child Tab');
      const button = container.querySelector<HTMLButtonElement>('button');
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      expect(onNavigateSession).toHaveBeenLastCalledWith({ sessionId: createdSessionId });
    }
  });

  it('renders independent batch target states without waiting for the whole batch', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <MessageRowView
            sessionId={openerSessionId}
            message={{
              id: 'batch-progress',
              role: 'system',
              read: true,
              timestamp: '2026-08-14T12:00:00.000Z',
              items: [
                {
                  type: 'operation_progress',
                  operationId: 'batch',
                  operationKind: 'session_create_many',
                  items: [
                    {
                      status: 'running',
                      label: 'Still working',
                      target: { sessionId: createdSessionId, userTurnId: 'turn-1' },
                    },
                    {
                      status: 'succeeded',
                      label: 'Already finished',
                      target: { sessionId: 'second-child' as SessionId, userTurnId: 'turn-2' },
                    },
                  ],
                },
              ],
            }}
          />
        </Provider>
      )
    );
    expect(container.querySelectorAll('[data-session-relation-card="opened"]')).toHaveLength(2);
    expect(container.querySelector('[data-session-creation-status="running"]')).not.toBeNull();
    expect(container.querySelector('[data-session-creation-status="succeeded"]')).not.toBeNull();
  });

  it('does not duplicate target cards on completion when progress was published', async () => {
    const completion = completionMessage.items[0];
    if (completion.type !== 'operation_completion') throw new Error('Expected completion fixture');
    await act(async () =>
      root.render(
        <MessageRowView
          message={{
            ...completionMessage,
            items: [{ ...completion, progressMessageId: 'create-progress' }],
          }}
          sessionId={openerSessionId}
        />
      )
    );
    expect(container.querySelector('[data-session-relation-card="opened"]')).toBeNull();
    expect(container.textContent).not.toBe('');
  });
});
