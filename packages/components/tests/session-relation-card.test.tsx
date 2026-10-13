// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type SessionHistoryParsed, type SessionId } from '@lody/shared';

import { setDocMetaByRoomIdAtom } from '../src/atoms/doc-meta';
import {
  MessageRowView,
  buildChatVirtualRows,
  type ChatStreamItem,
} from '../src/components/ai-gui/view';
import { SessionRelationCard } from '../src/components/shared/session-relation-card';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';
import { CurrentSessionRelationsChip } from '../src/components/sessions/session-relations-chip';

// This suite exercises relation rendering and navigation; collaboration controls
// and their workspace-backed actions have their own behavioral suites.
vi.mock('../src/hooks/use-session-actions', () => ({
  useSessionActions: () => ({
    setTreeCollaborationStopped: async () => {
      throw new Error('Collaboration actions are outside this navigation fixture');
    },
  }),
}));

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

    expect(container.textContent).toContain('Generated child conversation title');
    expect(container.textContent).not.toContain('Fallback operation label');

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.getAttribute('aria-label')?.startsWith('View session:'))
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

  it('groups separate creation records, retains their turn range, and keeps navigation live when toggled', async () => {
    const items: ChatStreamItem[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'message',
      sessionId: openerSessionId,
      turnIndex: index + 3,
      message: {
        id: `progress-${index}`,
        role: 'system',
        read: true,
        timestamp: '2026-10-11T00:00:00Z',
        items: [
          {
            type: 'operation_progress',
            operationId: `operation-${index}`,
            operationKind: 'session_create',
            items: [
              {
                status: 'running',
                label: `Child ${index + 1}`,
                target: { sessionId: `child-${index}` as SessionId, userTurnId: `turn-${index}` },
              },
            ],
          },
        ],
      },
    }));
    const rows = buildChatVirtualRows({ items, lastAssistantMessageId: null, expansionVersion: 0 });
    expect(rows).toHaveLength(1);
    expect(
      buildChatVirtualRows({
        items,
        lastAssistantMessageId: null,
        expansionVersion: 0,
        groupCreatedSessions: false,
      })
    ).toHaveLength(8);
    const row = rows[0]!;
    if (row.type !== 'standard' || row.item.type !== 'message')
      throw new Error('Expected creation row');
    expect(row.messageIndex).toBe(3);
    const onNavigateSession = vi.fn();
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <MessageRowView
            message={row.item.type === 'message' ? row.item.message : completionMessage}
            sessionId={openerSessionId}
            onNavigateSession={onNavigateSession}
          />
        </Provider>
      )
    );
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-session-relation-card="opened"]')).toHaveLength(8);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[title="Child 8"]')!.click()
    );
    expect(onNavigateSession.mock.calls.at(-1)?.[0]).toEqual({ sessionId: 'child-7' });
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    const boundary: ChatStreamItem = {
      type: 'message',
      sessionId: openerSessionId,
      turnIndex: 7,
      message: {
        ...completionMessage,
        id: 'boundary',
        role: 'user',
        items: [{ type: 'text', text: 'Continue' }],
      },
    };
    const split = buildChatVirtualRows({
      items: [...items.slice(0, 4), boundary, ...items.slice(4)],
      lastAssistantMessageId: null,
      expansionVersion: 0,
    });
    expect(split).toHaveLength(3);
  });

  it('does not show a disclosure for five creation cards', async () => {
    const item = completionMessage.items[0]!;
    if (item.type !== 'operation_completion' || item.completion.type !== 'result')
      throw new Error('fixture');
    const target = item.completion.value.items[0]!;
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <MessageRowView
            sessionId={openerSessionId}
            message={{
              ...completionMessage,
              items: [
                {
                  ...item,
                  completion: {
                    type: 'result',
                    value: {
                      items: Array.from({ length: 5 }, (_, index) => ({
                        ...target,
                        target: {
                          sessionId: `five-${index}` as SessionId,
                          userTurnId: `turn-${index}`,
                        },
                      })),
                    },
                  },
                },
              ],
            }}
          />
        </Provider>
      )
    );
    expect(container.querySelectorAll('[data-session-relation-card="opened"]')).toHaveLength(5);
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('keeps legacy failure summaries outside grouped successful creations', async () => {
    const completion = completionMessage.items[0]!;
    if (completion.type !== 'operation_completion' || completion.completion.type !== 'result')
      throw new Error('fixture');
    const success = completion.completion.value.items[0]!;
    const failed: SessionHistoryParsed = {
      ...completionMessage,
      id: 'failed',
      items: [
        {
          ...completion,
          completion: {
            type: 'result',
            value: {
              items: [
                success,
                {
                  status: 'failed',
                  label: 'Unavailable child',
                  error: { code: 'UNAVAILABLE', message: 'Target offline', retryable: true },
                },
              ],
            },
          },
        },
      ],
    };
    const rows = buildChatVirtualRows({
      lastAssistantMessageId: null,
      expansionVersion: 0,
      items: [completionMessage, { ...completionMessage, id: 'second-success' }, failed].map(
        (message, turnIndex) => ({
          type: 'message',
          sessionId: openerSessionId,
          turnIndex,
          message,
        })
      ),
    });
    expect(rows).toHaveLength(2);
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          {rows.map((row) =>
            row.type === 'standard' && row.item.type === 'message' ? (
              <MessageRowView
                key={row.key}
                message={row.item.message}
                sessionId={openerSessionId}
              />
            ) : null
          )}
        </Provider>
      )
    );
    expect(container.querySelectorAll('[data-session-relation-card="opened"]')).toHaveLength(3);
    expect(container.textContent).toContain('Target offline');
    expect(container.querySelector('[data-created-session-list]')?.textContent).not.toContain(
      'Target offline'
    );
  });

  it('retains an empty completion summary beside creation records', async () => {
    const completion = completionMessage.items[0]!;
    if (completion.type !== 'operation_completion') throw new Error('fixture');
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <MessageRowView
            sessionId={openerSessionId}
            message={{
              ...completionMessage,
              items: [
                completion,
                {
                  ...completion,
                  operationId: 'empty-result',
                  deliveryId: 'empty-result-delivery',
                  completion: { type: 'result', value: { items: [] } },
                },
              ],
            }}
          />
        </Provider>
      )
    );
    expect(container.querySelectorAll('[data-session-relation-card="opened"]')).toHaveLength(1);
    expect(container.textContent).toContain('orchestration.operationCompleted');
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

  it('opens the whole related-Sessions tree from the info-bar chip and routes Tabs by root', async () => {
    const store = createStore();
    const meta = (id: string, title: string, extra: Record<string, unknown> = {}) =>
      store.set(setDocMetaByRoomIdAtom, getSessionRoomId(id as SessionId), {
        id,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: '2026-08-14T12:00:00.000Z',
        cliType: 'builtin',
        agentType: 'codex',
        title,
        ...extra,
      });
    // top ─ opener[tab] ─ created (current)
    meta('top', 'Top');
    meta(openerSessionId, 'Opener', { openedBySessionId: 'top' });
    meta('opener-tab', 'Opener tab', {
      parentSessionId: openerSessionId,
      openedBySessionId: openerSessionId,
      createdAt: '2026-08-14T12:01:00.000Z',
    });
    meta(createdSessionId, 'Created', {
      openedBySessionId: 'opener-tab',
      openedByRootSessionId: openerSessionId,
    });
    const opened: unknown[] = [];

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SessionInfoBar
            status={null}
            relations={
              <CurrentSessionRelationsChip
                sessionId={createdSessionId}
                onOpenSession={(target) => opened.push(target)}
              />
            }
          />
        </Provider>
      );
    });

    const chip = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(chip?.textContent).toBe('3');
    await act(async () => chip?.click());

    const rows = Array.from(document.querySelectorAll('[data-session-relation-row]'));
    expect(rows.map((row) => row.textContent)).toEqual(['Top', 'Opener', 'Opener tab', 'Created']);
    expect(
      document
        .querySelector(`[data-session-relation-row="${createdSessionId}"]`)
        ?.getAttribute('aria-current')
    ).toBe('page');

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-session-relation-row="opener-tab"]')?.click()
    );
    expect(opened).toEqual([{ sessionId: openerSessionId, tabSessionId: 'opener-tab' }]);
  });
});
