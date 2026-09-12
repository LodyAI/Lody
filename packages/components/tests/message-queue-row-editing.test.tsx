// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageQueueItem, SessionId } from '@lody/shared';

import { MessageQueueDisplay } from '../src/components/sessions/message-queue';
import { initI18n } from '../src/i18n';

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

  // The save promise stays pending until the test releases it, so the row is
  // observable in its mid-write state instead of racing a microtask.
  const renderQueue = async (options?: { holdSave?: boolean }) => {
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

  it('reverts instead of writing when the text is unchanged', async () => {
    const view = await renderQueue();
    const textarea = await startEditing(view);

    await pressEnter(textarea);

    expect(saved).toEqual([]);
    expect(cancelled).toEqual(['cid-0']);
  });
});
