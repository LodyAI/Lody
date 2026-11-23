// @vitest-environment jsdom
import { act, useState } from 'react';
import { Provider, createStore } from 'jotai';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentAddMenu } from '../src/components/chat/attachment-add-menu';
import { initI18n } from '../src/i18n';
import { commands } from '../src/lib/commands';
import { CommandShortcutHost } from '../src/lib/commands/shortcut-host';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('AttachmentAddMenu', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    commands.resetAllUserKeybindings();
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    for (const command of commands.list()) commands.unregister(command.id);
    commands.resetAllUserKeybindings();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers one attachment action for the unified picker', async () => {
    const onAddAttachment = vi.fn();
    await act(async () => {
      root.render(<AttachmentAddMenu isMobile={false} onAddAttachment={onAddAttachment} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]'
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await vi.advanceTimersByTimeAsync(40);
    });

    const items = document.body.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Add attachment');
    expect(document.body.textContent).not.toContain('Upload image');
    expect(document.body.textContent).not.toContain('Upload file');

    await act(async () => items[0]!.click());
    expect(onAddAttachment).toHaveBeenCalledOnce();
  });

  // iOS dismisses the file picker the moment focus returns to the prompt (the
  // keyboard comes back instead), so choosing the picker must not refocus it.
  it('leaves composer focus alone when the file picker is opened', async () => {
    const onAddAttachment = vi.fn();
    await act(async () => {
      root.render(
        <>
          <textarea data-keyboard-nav="composer" aria-label="Prompt" />
          <AttachmentAddMenu isMobile onAddAttachment={onAddAttachment} />
        </>
      );
    });
    const composer = container.querySelector('textarea')!;
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]'
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'touch' })
      );
      await vi.advanceTimersByTimeAsync(40);
    });
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => {
      item.focus();
      item.click();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(onAddAttachment).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="menuitem"]')).toBeNull();
    expect(document.activeElement).not.toBe(composer);
  });
  it.each([false, true])(
    'permits encrypted attachments and schedule send (mobile %s)',
    async (isMobile) => {
      const store = createStore();
      store.set(workspaceContentModeAtom, {
        accountId: 'user',
        workspaceSlug: 'encrypted',
        workspaceId: 'workspace',
        descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
      } as never);
      function Menu() {
        const [scheduled, setScheduled] = useState(false);
        const [attached, setAttached] = useState(false);
        return (
          <>
            <AttachmentAddMenu
              isMobile={isMobile}
              onAddAttachment={() => setAttached(true)}
              onScheduleSend={() => setScheduled(true)}
            />
            {attached && <output data-testid="attached">Attachment picker opened</output>}
            {scheduled && <output data-testid="scheduled">Schedule time picker opened</output>}
          </>
        );
      }
      await act(async () =>
        root.render(
          <Provider store={store}>
            <Menu />
          </Provider>
        )
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add attachment"]'
      );
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger!.dispatchEvent(
          new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
        );
        await vi.advanceTimersByTimeAsync(40);
      });
      const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items).toHaveLength(2);
      expect(items[0]?.getAttribute('aria-disabled')).not.toBe('true');
      expect(items[1]?.getAttribute('aria-disabled')).not.toBe('true');
      await act(async () => items[0]?.click());
      expect(container.querySelector('[data-testid=attached]')?.textContent).toBe(
        'Attachment picker opened'
      );
      await act(async () => {
        trigger!.dispatchEvent(
          new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
        );
        await vi.advanceTimersByTimeAsync(40);
      });
      await act(async () =>
        document.body.querySelectorAll<HTMLElement>('[role=menuitem]')[1]?.click()
      );
      expect(container.querySelector('[data-testid=scheduled]')?.textContent).toBe(
        'Schedule time picker opened'
      );
    }
  );

  const pressAddMenuChord = (target: Window | Element) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ';',
        code: 'Semicolon',
        ctrlKey: true,
        bubbles: true,
      })
    );

  it('opens on ⌘; while the composer is focused, and stays shut elsewhere', async () => {
    await act(async () => {
      root.render(
        <>
          <CommandShortcutHost />
          <div>
            <textarea data-lody-composer-input="" />
            <AttachmentAddMenu isMobile={false} onAddAttachment={vi.fn()} />
          </div>
        </>
      );
    });

    await act(async () => {
      pressAddMenuChord(window);
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      pressAddMenuChord(container.querySelector('[data-lody-composer-input]')!);
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(document.body.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  it('answers ⌘; only from the composer surface owning the focused field', async () => {
    await act(async () => {
      root.render(
        <>
          <CommandShortcutHost />
          <div data-testid="box-a">
            <textarea data-lody-composer-input="" />
            <AttachmentAddMenu isMobile={false} onAddAttachment={vi.fn()} />
          </div>
          <div data-testid="box-b">
            <textarea data-lody-composer-input="" />
            <AttachmentAddMenu isMobile={false} onAddAttachment={vi.fn()} />
          </div>
        </>
      );
    });

    const boxA = container.querySelector('[data-testid="box-a"]')!;
    const boxB = container.querySelector('[data-testid="box-b"]')!;
    const triggerOf = (box: Element) => box.querySelector('button[aria-label="Add attachment"]');

    await act(async () => {
      pressAddMenuChord(boxB.querySelector('[data-lody-composer-input]')!);
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(triggerOf(boxB)?.getAttribute('aria-expanded')).toBe('true');
    expect(triggerOf(boxA)?.getAttribute('aria-expanded')).not.toBe('true');
  });

  it('does not open on ⌘; while its surface is inactive', async () => {
    await act(async () => {
      root.render(
        <>
          <CommandShortcutHost />
          <div>
            <textarea data-lody-composer-input="" />
            <AttachmentAddMenu isMobile={false} onAddAttachment={vi.fn()} commandsEnabled={false} />
          </div>
        </>
      );
    });

    await act(async () => {
      pressAddMenuChord(container.querySelector('[data-lody-composer-input]')!);
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});
