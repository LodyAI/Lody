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

  it('shows the reply a message Operation received, instead of its id and counts', async () => {
    const store = createStore();
    store.set(setDocMetaByRoomIdAtom, getSessionRoomId(createdSessionId), {
      id: createdSessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      createdAt: '2026-08-14T12:00:00.000Z',
      title: 'Portal selection regression',
    });
    const onNavigateSession = vi.fn();
    const chatCompletion: SessionHistoryParsed = {
      ...completionMessage,
      items: [
        {
          type: 'operation_completion',
          deliveryId: 'operation:pr789:completion',
          operationId: 'pr789-fix-regression-test-portal-selection-20260917',
          operationKind: 'session_chat',
          completion: {
            type: 'result',
            value: {
              items: [
                {
                  status: 'succeeded',
                  target: { sessionId: createdSessionId, userTurnId: 'user-turn' },
                  assistantTurnId: 'assistant-turn',
                  output: { text: 'Fixed the portal\n\nselection test; CI is green.' },
                },
              ],
            },
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        <Provider store={store}>
          <MessageRowView
            message={chatCompletion}
            sessionId={openerSessionId}
            onNavigateSession={onNavigateSession}
          />
        </Provider>
      );
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Reply received');
    expect(text).toContain('Portal selection regression');
    // The card carries the reply's opening only; the rest lives in the dialog.
    expect(text).toContain('Fixed the portal');
    expect(text).not.toContain('CI is green');
    expect(text).not.toContain('pr789-fix-regression-test-portal-selection-20260917');
    expect(text).not.toMatch(/items ·/);
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

  it('keeps a long reply to its opening line and shows all of it in a dialog', async () => {
    const opening =
      'I will first read the failing Tests log and re-check the portal selection logic.';
    const middle = Array.from({ length: 6 }, (_, i) => `Detail paragraph ${i + 1}.`).join('\n\n');
    const conclusion = 'Conclusion: the portal test now waits for mount, and CI is green.';
    const reply = `${opening}\n\n${middle}\n\n${conclusion}`;
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <MessageRowView
            message={{
              ...completionMessage,
              items: [
                {
                  type: 'operation_completion',
                  deliveryId: 'operation:long:completion',
                  operationId: 'long-reply',
                  operationKind: 'session_chat',
                  completion: {
                    type: 'result',
                    value: {
                      items: [
                        {
                          status: 'succeeded',
                          target: { sessionId: createdSessionId, userTurnId: 'user-turn' },
                          assistantTurnId: 'assistant-turn',
                          output: { text: reply },
                        },
                      ],
                    },
                  },
                },
              ],
            }}
            sessionId={openerSessionId}
          />
        </Provider>
      );
    });

    const card = container.querySelector('[data-operation-reply-card="succeeded"]');
    expect(card?.textContent).toContain(opening);
    expect(card?.textContent).not.toContain('Detail paragraph');
    expect(card?.textContent).not.toContain(conclusion);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () =>
      Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent === opening)
        ?.click()
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Detail paragraph 6.');
    expect(dialog?.textContent).toContain(conclusion);
  });
});
