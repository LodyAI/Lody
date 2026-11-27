// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import type { MessageQueueItem, SessionId, WorkspaceId } from '@lody/shared';

import { MessageQueueDisplay } from '../src/components/sessions/message-queue';
import { currentWorkspaceIdAtom } from '../src/atoms';
import { authTokenAtom, runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import type { PendingSessionSend } from '../src/lib/session-pending-sends';
import { initI18n } from '../src/i18n';
import { ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
import { useQueuedMessageComposerEdit } from '../src/components/sessions/message-queue/use-queued-message-composer-edit';
import {
  QUEUED_EDIT_RENEW_INTERVAL_MS,
  queuedRunConfigOf,
} from '../src/components/sessions/message-queue/queued-message-edit';

// Each variant resolves to a distinct URL so the test can tell the row's
// thumbnail from the full-size image the preview loads.
vi.mock('../src/lib/session-image-cache', () => ({
  getSessionImageBlobUrl: async ({ imageId, variant }: { imageId: string; variant: string }) =>
    `blob:${variant}/${imageId}`,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL_TASK = 'Refactor the message queue';

function makeItem(): MessageQueueItem {
  return {
    $cid: 'cid-0',
    task: ORIGINAL_TASK,
    userId: 'user-1',
    userTurnId: 'turn-0',
    timestamp: '2026-01-01T00:00:00.000Z',
    acpSessionConfig: {
      prompt: ORIGINAL_TASK,
      cliType: 'claude-code',
      agentType: 'claude-code',
    },
  } as unknown as MessageQueueItem;
}

describe('queued message editing commits', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let started: string[];

  beforeEach(async () => {
    await initI18n('en');
    started = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  it('offers Send for each retained row while idle and sends only the selected row', async () => {
    const sent: string[] = [];
    const items = ['B', 'C', 'D', 'E', 'F'].map((name) => ({
      ...makeItem(),
      $cid: `cid-${name}`,
      task: name,
      userTurnId: name,
      paused: true,
    }));
    function StoppedQueue() {
      const [queued, setQueued] = useState(items);
      return createElement(MessageQueueDisplay, {
        sessionId: 'session-test' as SessionId,
        items: queued,
        showSteerAction: true,
        sendWhileIdle: true,
        onRemove: () => {},
        onReorder: () => {},
        onEditStart: () => {},
        onSteer: (item) => {
          sent.push(item.task);
          setQueued((rows) => rows.filter((row) => row.$cid !== item.$cid));
        },
      });
    }
    await act(async () => root?.render(createElement(StoppedQueue)));
    const sends = container!.querySelectorAll<HTMLButtonElement>('[aria-label="Send"]');
    expect(sends).toHaveLength(5);
    expect(sent).toEqual([]);
    await act(async () => sends[1]!.click());
    expect(sent).toEqual(['C']);
    expect(container!.querySelectorAll('[aria-label="Send"]')).toHaveLength(4);
    for (const name of ['B', 'D', 'E', 'F']) expect(container!.textContent).toContain(name);
  });

  it('renders dedicated scheduled rows in a final section without queue affordances', async () => {
    const opened: string[] = [];
    const cancelledRows: string[] = [];
    const items = [makeItem()];
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items,
          scheduledItems: [
            {
              scheduleId: 'later',
              content: 'Later scheduled message',
              at: 30,
              timeZone: 'UTC',
              state: 'pending',
            },
            {
              scheduleId: 'earlier',
              content: 'Earlier scheduled message',
              at: 10,
              timeZone: 'UTC',
              state: 'failed',
            },
          ],
          onOpenScheduled: (item) => opened.push(item.scheduleId),
          onCancelScheduled: (item) => cancelledRows.push(item.scheduleId),
          onRemove: () => {},
          onReorder: () => {},
          onEditStart: () => {},
          onSteer: () => {},
        })
      );
    });
    expect(container!.textContent).toContain('Scheduled');
    const scheduledRows = [...container!.querySelectorAll<HTMLElement>('[data-scheduled-row]')];
    expect(scheduledRows.map((row) => row.title)).toEqual([
      'Earlier scheduled message',
      'Later scheduled message',
    ]);
    // Failure is marked on the time itself, never as a separate status column.
    expect(container!.textContent).not.toContain('Not sent');
    expect(container!.textContent).not.toContain('Pending');
    const timeButton = (row: HTMLElement) =>
      row.querySelector<HTMLButtonElement>('button[aria-label*="Edit scheduled time"]')!;
    expect(timeButton(scheduledRows[0]!).getAttribute('aria-label')).toContain('Not sent');
    expect(timeButton(scheduledRows[1]!).getAttribute('aria-label')).not.toContain('Not sent');
    for (const row of scheduledRows) {
      expect(row.querySelector('[aria-label="Drag to reorder"]')).toBeNull();
      expect(row.querySelector('[aria-label*="Steer"]')).toBeNull();
      expect(timeButton(row)).not.toBeNull();
    }
    await act(async () =>
      scheduledRows[0]!.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click()
    );
    await act(async () =>
      scheduledRows[1]!
        .querySelector<HTMLButtonElement>('button[aria-label="Cancel scheduled message"]')!
        .click()
    );
    expect(opened).toEqual(['earlier']);
    expect(cancelledRows).toEqual(['later']);
  });

  it('routes the scheduled time to the time editor rather than details', async () => {
    const edited: string[] = [];
    const opened: string[] = [];
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items: [],
          scheduledItems: [
            {
              scheduleId: 'scheduled-only',
              content: 'Send the weekly summary',
              at: Date.parse('2026-10-27T09:00:00Z'),
              timeZone: 'UTC',
              state: 'pending',
            },
          ],
          onOpenScheduled: (item) => opened.push(item.scheduleId),
          onEditScheduledTime: (item) => edited.push(item.scheduleId),
          onRemove: () => {},
          onReorder: () => {},
          onEditStart: () => {},
          onSteer: () => {},
        })
      );
    });
    const row = container!.querySelector<HTMLElement>('[data-scheduled-row]')!;
    const time = row.querySelector<HTMLButtonElement>('button[aria-label*="Edit scheduled time"]')!;
    expect(time.textContent).toContain('9:00');
    await act(async () => time.click());
    expect(edited).toEqual(['scheduled-only']);
    expect(opened).toEqual([]);
  });

  const renderQueue = async (props: Partial<Parameters<typeof MessageQueueDisplay>[0]> = {}) => {
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items: [makeItem()],
          onRemove: () => undefined,
          onReorder: () => undefined,
          onEditStart: (item: MessageQueueItem) => {
            started.push(item.$cid);
          },
          onSteer: () => undefined,
          showSteerAction: true,
          ...props,
        })
      );
    });
    return container as HTMLDivElement;
  };

  it('starts a composer edit from the row without opening an inline editor', async () => {
    const view = await renderQueue();
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click();
    });
    expect(started).toEqual(['cid-0']);
    expect(view.querySelector('textarea')).toBeNull();
  });

  it('holds the edited row in place: dimmed, labelled, and without drag, steer or delete', async () => {
    const second = { ...makeItem(), $cid: 'cid-1', userTurnId: 'turn-1', task: 'Second' };
    const focused: string[] = [];
    const view = await renderQueue({
      items: [makeItem(), second],
      editingCid: 'cid-0',
      onFocusEdit: (item) => focused.push(item.$cid),
    });
    const [held, other] = view.querySelectorAll<HTMLElement>('[data-message-queue-row]');
    expect(held!.dataset.queueRowState).toBe('editing');
    expect(held!.textContent).toContain(ORIGINAL_TASK);
    expect(held!.querySelector('[aria-label="Drag to reorder"]')).toBeNull();
    expect(held!.querySelector('[aria-label="Remove from queue"]')).toBeNull();
    expect(held!.querySelector('[aria-label*="Steer"]')).toBeNull();
    await act(async () => {
      held!.querySelector<HTMLButtonElement>('[aria-label="Editing in the composer"]')!.click();
    });
    expect(focused).toEqual(['cid-0']);
    // One edit at a time: the other row cannot start a second one.
    const otherEdit = other!.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]');
    expect(otherEdit!.disabled).toBe(true);
    expect(other!.querySelector('[aria-label="Remove from queue"]')).toBeTruthy();
  });

  it('fits the held state into the single touch action box', async () => {
    const focused: string[] = [];
    await act(async () => {
      root?.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          createElement(MessageQueueDisplay, {
            sessionId: 'session-test' as SessionId,
            items: [makeItem()],
            editingCid: 'cid-0',
            onFocusEdit: (item: MessageQueueItem) => focused.push(item.$cid),
            onRemove: () => undefined,
            onReorder: () => undefined,
            onEditStart: () => undefined,
            onSteer: () => undefined,
            roomy: true,
          })
        )
      );
    });
    const row = container!.querySelector<HTMLElement>('[data-message-queue-row]')!;
    const held = row.querySelector<HTMLButtonElement>('[aria-label="Editing in the composer"]')!;
    // The glyph takes the More box's place; no text label competes for the 40 px column.
    expect(held.textContent).toBe('');
    expect(row.querySelector('[aria-label="More"]')).toBeNull();
    await act(async () => held.click());
    expect(focused).toEqual(['cid-0']);
  });

  it('shows the full message and how it will run in the details', async () => {
    const long = `${ORIGINAL_TASK} — and keep the cancellation tokens in the second pass.`;
    const item = {
      ...makeItem(),
      userName: 'Ada',
      task: long,
      acpSessionConfig: { ...makeItem().acpSessionConfig!, prompt: long, modelId: 'opus' },
    } as MessageQueueItem;
    const view = await renderQueue({
      items: [item],
      describeRunConfig: () => ({
        agentLabel: 'Claude Code',
        modelLabel: 'Opus',
        modeLabel: 'Plan',
        reasoningLabel: 'High',
      }),
    });
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click();
    });
    const details = document.querySelector<HTMLElement>('[data-queued-message-details]');
    expect(details).toBeTruthy();
    expect(details!.querySelector('[data-text-selectable]')!.textContent).toBe(long);
    for (const text of ['Ada', 'Claude Code', 'Opus', 'Plan', 'High'])
      expect(details!.textContent).toContain(text);
    await act(async () => {
      [...details!.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Edit in composer'))!
        .click();
    });
    expect(started).toEqual(['cid-0']);
  });

  it('marks a row that runs differently, and leaves the hint out on phones', async () => {
    const describeRunConfig = () => ({ modelLabel: 'Opus', differenceTag: 'Opus · Plan' });
    let view = await renderQueue({ describeRunConfig });
    expect(view.querySelector('[data-queue-config-tag]')?.textContent).toBe('Opus · Plan');
    await act(async () => {
      root?.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          createElement(MessageQueueDisplay, {
            sessionId: 'session-test' as SessionId,
            items: [makeItem()],
            onRemove: () => undefined,
            onReorder: () => undefined,
            onEditStart: () => undefined,
            onSteer: () => undefined,
            describeRunConfig,
            roomy: true,
          })
        )
      );
    });
    view = container as HTMLDivElement;
    expect(view.querySelector('[data-queue-config-tag]')).toBeNull();
  });
});

describe('queued message images', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let editsStarted: string[];

  beforeEach(async () => {
    await initI18n('en');
    editsStarted = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  it('keeps live pending and failed-send counts visible while folded', async () => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-test' as WorkspaceId);
    const record = (id: string, error?: string) =>
      ({
        id,
        error,
        sessionId: 'session-test',
        workspaceId: 'workspace-test',
        sequence: 1,
        attachments: [],
        delivery: { kind: 'queue' },
        queue: { task: id },
        entry: { id, role: 'user', items: [] },
      }) as PendingSessionSend;
    let records = [record('uploading'), record('failed', 'offline')];
    const listeners = new Set<() => void>();
    store.set(runtimeAtom, {
      workspaceId: 'workspace-test',
      pendingSends: {
        getSnapshot: () => records,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as WorkspaceRuntime);
    await act(async () =>
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MessageQueueDisplay, {
            sessionId: 'session-test' as SessionId,
            items: [makeItem()],
            onRemove: () => undefined,
            onReorder: () => undefined,
            onEditStart: () => undefined,
            onSteer: () => undefined,
          })
        )
      )
    );
    const toggle = container!.querySelector<HTMLButtonElement>('[data-message-queue-toggle]')!;
    await act(async () => toggle.click());
    expect(toggle.textContent).toContain('3 queued');
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('1 not sent1 preparing');

    await act(async () => {
      records = [...records, record('new-upload')];
      listeners.forEach((listener) => listener());
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('4 queued');
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('1 not sent2 preparing');
    await act(async () => toggle.click());
    expect(container!.querySelectorAll('[data-pending-queue-row]').length).toBe(3);
    expect(container!.querySelector('[aria-label="Continue sending"]')).toBeTruthy();
  });

  it('shows why a queued send failed and gives visible feedback while it is retried', async () => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-test' as WorkspaceId);
    const reason = "Lody on this computer couldn't prepare this attachment (request_timeout).";
    let records = [
      {
        id: 'held',
        error: reason,
        sessionId: 'session-test',
        workspaceId: 'workspace-test',
        sequence: 1,
        attachments: [],
        delivery: { kind: 'queue' },
        queue: { task: 'Remove these three metrics' },
        entry: { id: 'held', role: 'user', items: [] },
      } as unknown as PendingSessionSend,
    ];
    const listeners = new Set<() => void>();
    const publish = (error: string | undefined) => {
      records = records.map((send) => ({ ...send, error }));
      listeners.forEach((listener) => listener());
    };
    let attempts = 0;
    store.set(runtimeAtom, {
      workspaceId: 'workspace-test',
      pendingSends: {
        getSnapshot: () => records,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        // The cause persists: the retried attempt fails again at once.
        retry: () => {
          attempts += 1;
          publish(undefined);
          publish(reason);
        },
      },
    } as unknown as WorkspaceRuntime);
    vi.useFakeTimers();
    try {
      await act(async () =>
        root?.render(
          createElement(
            Provider,
            { store },
            createElement(MessageQueueDisplay, {
              sessionId: 'session-test' as SessionId,
              items: [],
              onRemove: () => undefined,
              onReorder: () => undefined,
              onEditStart: () => undefined,
              onSteer: () => undefined,
            })
          )
        )
      );
      const row = () => container!.querySelector<HTMLElement>('[data-pending-queue-row="held"]')!;
      const retryButton = () =>
        row().querySelector<HTMLButtonElement>('[aria-label="Continue sending"]');
      expect(row().querySelector('[role="alert"]')?.textContent).toBe(reason);

      await act(async () => retryButton()!.click());
      expect(attempts).toBe(1);
      // The click is acknowledged even though the attempt already failed again.
      expect(retryButton()).toBeNull();
      expect(row().querySelector('[role="alert"]')).toBeNull();
      expect(row().querySelector('[role="status"]')?.textContent).toBe('Sending');

      await act(async () => vi.advanceTimersByTime(600));
      expect(row().querySelector('[role="alert"]')?.textContent).toBe(reason);
      await act(async () => retryButton()!.click());
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the full-size image in the viewer without editing the row', async () => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-test' as WorkspaceId);
    store.set(authTokenAtom, 'token');
    const item = {
      ...makeItem(),
      acpSessionConfig: {
        ...makeItem().acpSessionConfig,
        inputBlocks: [
          { type: 'text', text: ORIGINAL_TASK },
          {
            type: 'image',
            imageId: 'image-1',
            mimeType: 'image/png',
            sizeBytes: 1024,
            fileName: 'screenshot.png',
          },
        ],
      },
    } as unknown as MessageQueueItem;
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MessageQueueDisplay, {
            sessionId: 'session-test' as SessionId,
            items: [item],
            onRemove: () => undefined,
            onReorder: () => undefined,
            onEditStart: (started: MessageQueueItem) => {
              editsStarted.push(started.$cid);
            },
            onSteer: () => undefined,
          })
        )
      );
    });

    const thumbnail = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Preview screenshot.png"]'
    );
    expect(thumbnail?.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail/image-1');
    await act(async () => thumbnail?.click());

    const images = [...document.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(images).toContain('blob:original/image-1');
    expect(editsStarted).toEqual([]);
    expect(container!.querySelector('textarea')).toBeNull();
  });

  it('keeps the scroll fade off the scroller and clamps a phone row to one line', async () => {
    const long =
      '暂时只写代码，不需要改任何的约定或者是 agent 的提示，后面还有很多不会发出去的说明。';
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items: [{ ...makeItem(), $cid: 'cid-long', task: long }],
          onRemove: () => undefined,
          onReorder: () => undefined,
          onEditStart: () => undefined,
          onSteer: () => undefined,
          roomy: true,
          footerPosition: 'inline',
        })
      );
    });

    const scroller = container!.querySelector<HTMLElement>('[data-message-queue-scroll-region]');
    expect(scroller).toBeTruthy();
    expect(scroller!.style.maxHeight).toBe('min(25vh, 240px)');
    // Unset mask properties are '' in some jsdom builds and undefined in others.
    expect(scroller!.style.getPropertyValue('mask-image')).toBe('');
    expect(scroller!.style.getPropertyValue('-webkit-mask-image')).toBe('');
    expect(scroller!.parentElement?.style.overflow).toBe('hidden');
    expect(scroller!.parentElement?.style.maxHeight).toBe('min(25vh, 240px)');

    // The row wrapper has the same text. The clamp lives on the preview itself.
    const preview = [...container!.querySelectorAll('div')].find(
      (node) => node.textContent === long && node.style.whiteSpace === 'nowrap'
    );
    expect(preview).toBeTruthy();
    expect(preview?.style.display).not.toBe('-webkit-box');
  });
});

describe('composer edit of a queued message', () => {
  type Harness = ReturnType<typeof useQueuedMessageComposerEdit>;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let current: Harness | undefined;
  let writes: Array<{ cid: string; next: MessageQueueItem }>;
  let saves: Array<{ cid: string; patch: Record<string, unknown> }>;
  let finished: string[];
  let now: number;

  const composer = {
    beginQueueEdit: () => {},
    finishQueueEdit: (mode: 'restore' | 'keep') => {
      finished.push(mode);
    },
  };

  function Probe(props: { items: MessageQueueItem[]; visible: boolean }) {
    current = useQueuedMessageComposerEdit({
      sessionId: 'session-edit' as SessionId,
      items: props.items,
      ready: true,
      visible: props.visible,
      composerRef: { current: composer },
      updateMessageQueueItem: async (cid, updater) => {
        const item = props.items.find((row) => row.$cid === cid);
        if (item) writes.push({ cid, next: updater(item) });
      },
      saveMessageQueueEdit: async (cid, patch) => {
        saves.push({ cid, patch: patch as Record<string, unknown> });
      },
      editor: { userId: 'editor', userName: 'Editor' },
      finishDraftWithoutComposer: () => {},
    });
    return null;
  }

  const render = async (items: MessageQueueItem[], visible = true) => {
    await act(async () => {
      root?.render(createElement(Provider, { store }, createElement(Probe, { items, visible })));
    });
  };
  let store: ReturnType<typeof createStore>;

  beforeEach(async () => {
    await initI18n('en');
    store = createStore();
    writes = [];
    saves = [];
    finished = [];
    now = Date.parse('2026-11-27T10:00:00Z');
    vi.useFakeTimers({ now, toFake: ['setInterval', 'clearInterval', 'Date'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.useRealTimers();
  });

  const locked = (item: MessageQueueItem) =>
    ({ ...item, isEditing: true, editingStartedAt: Date.now() }) as MessageQueueItem;

  it('writes only the lock on start, and renews it only while the editor is visible', async () => {
    const item = makeItem();
    await render([item]);
    await act(async () => current!.start(item));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.next).toMatchObject({ isEditing: true, task: ORIGINAL_TASK });
    expect(writes[0]!.next.acpSessionConfig).toEqual(item.acpSessionConfig);
    await render([locked(item)]);
    writes = [];

    await act(async () => vi.advanceTimersByTime(QUEUED_EDIT_RENEW_INTERVAL_MS));
    expect(writes.map((write) => write.next.isEditing)).toEqual([true]);

    // Hidden (left the Session, minimized): renewal stops and the lease lapses.
    await render([locked(item)], false);
    writes = [];
    await act(async () => vi.advanceTimersByTime(QUEUED_EDIT_RENEW_INTERVAL_MS * 6));
    expect(writes).toEqual([]);
  });

  it('treats an untouched save as a cancel and keeps the author', async () => {
    const item = makeItem();
    await render([item]);
    await act(async () => current!.start(item));
    await render([locked(item)]);
    let accepted = false;
    await act(async () => {
      accepted = await current!.save({
        composerBlocks: [{ type: 'text', text: ORIGINAL_TASK }],
        attachments: [],
        runConfig: queuedRunConfigOf(item),
        buildConfig: () => {
          throw new Error('unchanged edits keep the frozen config');
        },
      });
    });
    expect(accepted).toBe(true);
    expect(saves).toEqual([]);
    expect(writes.at(-1)!.next).toMatchObject({ isEditing: false, userId: 'user-1' });
    expect(current!.edit).toBeUndefined();
  });

  it('saves a real change under the editor and keeps the frozen Role revision', async () => {
    const item = {
      ...makeItem(),
      acpSessionConfig: {
        ...makeItem().acpSessionConfig!,
        agentRoleId: 'role-reviewer',
        agentRoleRevision: 3,
      },
    } as MessageQueueItem;
    await render([item]);
    await act(async () => current!.start(item));
    await render([locked(item)]);
    await act(async () => {
      await current!.save({
        composerBlocks: [{ type: 'text', text: 'Refactor the queue, keep the order' }],
        attachments: [],
        runConfig: queuedRunConfigOf(item),
        buildConfig: () => {
          throw new Error('an unchanged run config keeps its frozen fields');
        },
      });
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.patch).toMatchObject({
      task: 'Refactor the queue, keep the order',
      userId: 'editor',
      userName: 'Editor',
      isEditing: false,
      acpSessionConfig: {
        prompt: 'Refactor the queue, keep the order',
        agentRoleId: 'role-reviewer',
        agentRoleRevision: 3,
      },
    });
  });

  it('rebuilds the config when the edit picks another model', async () => {
    const item = makeItem();
    await render([item]);
    await act(async () => current!.start(item));
    await render([locked(item)]);
    await act(async () => {
      await current!.save({
        composerBlocks: [{ type: 'text', text: ORIGINAL_TASK }],
        attachments: [],
        runConfig: { ...queuedRunConfigOf(item), modelId: 'opus' },
        buildConfig: (inputBlocks) => ({
          prompt: ORIGINAL_TASK,
          inputBlocks,
          cliType: 'claude-code',
          agentType: 'claude-code',
          modelId: 'opus',
        }),
      });
    });
    expect(saves[0]!.patch).toMatchObject({
      userId: 'editor',
      acpSessionConfig: { modelId: 'opus' },
    });
  });

  it('keeps the edit as a draft when its row ran or was removed meanwhile', async () => {
    const item = makeItem();
    await render([item]);
    await act(async () => current!.start(item));
    await render([locked(item)]);
    await render([]);
    expect(finished).toEqual(['keep']);
    expect(current!.edit).toBeUndefined();
  });
});
