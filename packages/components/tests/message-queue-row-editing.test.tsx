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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('queued message editing commits', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let saved: Array<{ cid: string; task: string }>;
  let cancelled: string[];
  let releaseSave: (() => void) | undefined;

  beforeEach(async () => {
    await initI18n('en');
    saved = [];
    cancelled = [];
    releaseSave = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    releaseSave?.();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  it('keeps mobile steer available for the queue head', async () => {
    const steered: string[] = [];
    await act(async () => {
      root?.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          createElement(MessageQueueDisplay, {
            sessionId: 'session-test' as SessionId,
            items: [makeItem()],
            roomy: true,
            showSteerAction: true,
            onRemove: () => {},
            onReorder: () => {},
            onEditStart: () => {},
            onEditCancel: () => {},
            onEditSave: () => {},
            onSteer: (item: MessageQueueItem) => {
              steered.push(item.$cid);
            },
          })
        )
      );
    });
    const trigger = container!.querySelector<HTMLButtonElement>('.group\\/row button')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
      trigger.click();
    });
    const steer = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Steer'
    );
    expect(steer).toBeDefined();
    await act(async () => {
      steer!.click();
    });
    expect(steered).toEqual(['cid-0']);
  });

  it('renders dedicated scheduled rows in a final section without queue affordances', async () => {
    const opened: string[] = [];
    const items = [makeItem()];
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items,
          scheduledItems: [
            {
              scheduleId: 'later',
              title: 'Later scheduled message',
              at: 30,
              timeZone: 'UTC',
              state: 'pending',
            },
            {
              scheduleId: 'earlier',
              title: 'Earlier scheduled message',
              at: 10,
              timeZone: 'UTC',
              state: 'failed',
            },
          ],
          onOpenScheduled: (item) => opened.push(item.scheduleId),
          onRemove: () => {},
          onReorder: () => {},
          onEditStart: () => {},
          onEditCancel: () => {},
          onEditSave: () => {},
          onSteer: () => {},
        })
      );
    });
    expect(container!.textContent).toContain('Scheduled');
    const scheduledRows = [...container!.querySelectorAll<HTMLButtonElement>('button[title]')];
    expect(scheduledRows.map((row) => row.title)).toEqual([
      'Earlier scheduled message',
      'Later scheduled message',
    ]);
    expect(scheduledRows[0]!.textContent).toContain('Not sent');
    expect(scheduledRows[1]!.textContent).toContain('Pending');
    for (const row of scheduledRows) {
      expect(row.querySelector('[aria-label="Drag to reorder"]')).toBeNull();
    }
    await act(async () => scheduledRows[0]!.click());
    expect(opened).toEqual(['earlier']);
  });

  // The save promise stays pending until the test releases it, so the row is
  // observable in its mid-write state instead of racing a microtask.
  const renderQueue = async (options?: { holdSave?: boolean; failSaveOnce?: boolean }) => {
    const items = [makeItem()];
    await act(async () => {
      root?.render(
        createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items,
          onRemove: () => undefined,
          onReorder: () => undefined,
          onEditStart: () => undefined,
          onEditCancel: (item: MessageQueueItem) => {
            cancelled.push(item.$cid);
          },
          onEditSave: (item: MessageQueueItem, task: string) => {
            saved.push({ cid: item.$cid, task });
            if (options?.failSaveOnce && saved.length === 1)
              return Promise.reject(new Error('Synthetic save failure'));
            if (!options?.holdSave) return undefined;
            return new Promise<void>((resolve) => {
              releaseSave = resolve;
            });
          },
          onSteer: () => undefined,
        })
      );
    });
    return container as HTMLDivElement;
  };

  const startEditing = async (view: HTMLDivElement): Promise<HTMLTextAreaElement> => {
    const editButton = view.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]');
    expect(editButton).toBeTruthy();
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = view.querySelector('textarea');
    expect(textarea).toBeTruthy();
    return textarea as HTMLTextAreaElement;
  };

  const pressEnter = async (
    textarea: HTMLTextAreaElement,
    init: KeyboardEventInit = {}
  ): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      textarea.dispatchEvent(event);
    });
    return event;
  };

  it('folds and reopens without committing or losing an editing draft', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);
    await act(async () => setTextareaValue(textarea, 'Keep this unfinished draft'));
    const toggle = view.querySelector<HTMLButtonElement>('[data-message-queue-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // The focus transition is shared by pointer presses and keyboard navigation.
    await act(async () => toggle.focus());
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Keep this unfinished draft');
    expect(saved).toEqual([]);
    expect(cancelled).toEqual([]);

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.querySelector('textarea')).toBe(textarea);
    await act(async () => textarea.focus());
    await pressEnter(textarea);
    expect(saved).toEqual([{ cid: 'cid-0', task: 'Keep this unfinished draft' }]);
  });

  it('saves the edit when Enter is pressed', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);

    await act(async () => {
      setTextareaValue(textarea, 'Rewrite the queue instead');
    });
    const event = await pressEnter(textarea);

    expect(event.defaultPrevented).toBe(true);
    expect(saved).toEqual([{ cid: 'cid-0', task: 'Rewrite the queue instead' }]);
  });

  it('focuses the editor when the editing flag arrives before the start write completes', async () => {
    let finishStart!: () => void;
    function QueueWithEarlyUpdate() {
      const [items, setItems] = useState([makeItem()]);
      return createElement(MessageQueueDisplay, {
        sessionId: 'session-test' as SessionId,
        items,
        onRemove: () => undefined,
        onReorder: () => undefined,
        onSteer: () => undefined,
        onEditCancel: () => undefined,
        onEditSave: (item, task) => {
          saved.push({ cid: item.$cid, task });
          setItems((current) => current.map((entry) => ({ ...entry, isEditing: false, task })));
        },
        onEditStart: (item) => {
          setItems([{ ...item, isEditing: true }]);
          return new Promise<void>((resolve) => {
            finishStart = resolve;
          });
        },
      });
    }
    await act(async () => root?.render(createElement(QueueWithEarlyUpdate)));
    const textarea = await startEditing(container!);
    expect(textarea.disabled).toBe(true);
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => finishStart());
    expect(textarea.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(ORIGINAL_TASK.length);
    expect(textarea.selectionEnd).toBe(ORIGINAL_TASK.length);
    await act(async () => setTextareaValue(textarea, 'Clarified queued instruction'));
    await pressEnter(textarea);
    expect(saved).toEqual([{ cid: 'cid-0', task: 'Clarified queued instruction' }]);
  });

  for (const nextEditPending of [false, true]) {
    it(`keeps the next editor when an earlier save settles (next pending=${nextEditPending})`, async () => {
      let finishSave!: () => void;
      let finishStart!: () => void;
      function QueueWithOverlappingEdits() {
        const [items, setItems] = useState([
          makeItem(),
          {
            ...makeItem(),
            $cid: 'cid-1',
            userTurnId: 'turn-1',
            task: 'Add regression tests',
            acpSessionConfig: { ...makeItem().acpSessionConfig, prompt: 'Add regression tests' },
          },
        ]);
        return createElement(MessageQueueDisplay, {
          sessionId: 'session-test' as SessionId,
          items,
          onRemove: () => undefined,
          onReorder: () => undefined,
          onSteer: () => undefined,
          onEditStart: (item) => {
            setItems((current) =>
              current.map((row) => (row.$cid === item.$cid ? { ...row, isEditing: true } : row))
            );
            if (nextEditPending && item.$cid === 'cid-1')
              return new Promise<void>((resolve) => {
                finishStart = resolve;
              });
            return undefined;
          },
          onEditCancel: (item) => {
            setItems((current) =>
              current.map((row) => (row.$cid === item.$cid ? { ...row, isEditing: false } : row))
            );
          },
          onEditSave: (item, task) => {
            saved.push({ cid: item.$cid, task });
            setItems((current) =>
              current.map((row) =>
                row.$cid === item.$cid
                  ? {
                      ...row,
                      isEditing: false,
                      task,
                      acpSessionConfig: { ...row.acpSessionConfig, prompt: task },
                    }
                  : row
              )
            );
            if (item.$cid === 'cid-0')
              return new Promise<void>((resolve) => {
                finishSave = resolve;
              });
            return undefined;
          },
        });
      }
      await act(async () => root?.render(createElement(QueueWithOverlappingEdits)));
      const first = await startEditing(container!);
      await act(async () => setTextareaValue(first, 'Preserve queue ordering'));
      await act(async () => first.blur());
      const nextButton = container!.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit queued message"]'
      );
      await act(async () => nextButton!.click());
      let next = container!.querySelector('textarea')!;
      expect(next.value).toBe(nextEditPending ? 'Preserve queue ordering' : 'Add regression tests');
      if (!nextEditPending)
        await act(async () => setTextareaValue(next, 'Cover ordering and cancellation'));
      await act(async () => finishSave());
      expect(container!.querySelector('textarea')).toBe(next);
      expect(next.value).toBe(
        nextEditPending ? 'Preserve queue ordering' : 'Cover ordering and cancellation'
      );
      if (nextEditPending) {
        await act(async () => finishStart());
        next = container!.querySelector('textarea')!;
        expect(next.value).toBe('Add regression tests');
        await act(async () => setTextareaValue(next, 'Cover ordering and cancellation'));
      }
      expect(document.activeElement).toBe(next);
      await pressEnter(next);
      expect(container!.querySelector('textarea')).toBeNull();
      expect(container!.textContent).toContain('Preserve queue ordering');
      expect(container!.textContent).toContain('Cover ordering and cancellation');
      expect(saved).toEqual([
        { cid: 'cid-0', task: 'Preserve queue ordering' },
        { cid: 'cid-1', task: 'Cover ordering and cancellation' },
      ]);
    });
  }

  it('leaves Shift+Enter to the textarea as a newline', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);

    await act(async () => {
      setTextareaValue(textarea, 'First line');
    });
    const event = await pressEnter(textarea, { shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(saved).toEqual([]);
    expect(view.querySelector('textarea')).toBeTruthy();
  });

  it('ignores the Enter that commits an IME candidate', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);

    await act(async () => {
      setTextareaValue(textarea, '排队消息');
    });
    const event = await pressEnter(textarea, { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(saved).toEqual([]);
  });

  it('saves once when the confirm button is clicked, even if a blur follows', async () => {
    const view = await renderQueue({ holdSave: true });
    const textarea = await startEditing(view);

    await act(async () => {
      setTextareaValue(textarea, 'Confirmed by button');
    });

    const confirmButton = view.querySelector<HTMLButtonElement>(
      '[aria-label="Save changes (Enter)"]'
    );
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The pending write disables the textarea, which blurs it in a real browser.
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    });

    expect(saved).toEqual([{ cid: 'cid-0', task: 'Confirmed by button' }]);
    expect(cancelled).toEqual([]);
  });

  it('preserves a rejected draft and lets the user save it again', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = await renderQueue({ failSaveOnce: true });
      const textarea = await startEditing(view);
      await act(async () => setTextareaValue(textarea, 'Keep this clarification'));
      await pressEnter(textarea);
      expect(view.querySelector('textarea')).toBe(textarea);
      expect(textarea.disabled).toBe(false);
      expect(textarea.value).toBe('Keep this clarification');
      expect(document.activeElement).toBe(textarea);
      await pressEnter(textarea);
      expect(view.querySelector('textarea')).toBeNull();
      expect(saved.at(-1)).toEqual({ cid: 'cid-0', task: 'Keep this clarification' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reverts instead of writing when the text is unchanged', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);

    await pressEnter(textarea);

    expect(saved).toEqual([]);
    expect(cancelled).toEqual(['cid-0']);
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
            onEditCancel: () => undefined,
            onEditSave: () => undefined,
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
            onEditCancel: () => undefined,
            onEditSave: () => undefined,
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
});
