// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentAddMenu } from '../src/components/chat/attachment-add-menu';
import { initI18n } from '../src/i18n';

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
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
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
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const items = document.body.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Add attachment');
    expect(document.body.textContent).not.toContain('Upload image');
    expect(document.body.textContent).not.toContain('Upload file');

    await act(async () => items[0]!.click());
    expect(onAddAttachment).toHaveBeenCalledOnce();
  });

  it('explains a disabled schedule send on hover', async () => {
    const reason = 'Update the target machine CLI to schedule messages.';
    await act(async () => {
      root.render(
        <AttachmentAddMenu
          isMobile={false}
          onScheduleSend={() => {}}
          scheduleDisabledReason={reason}
        />
      );
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
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain('Schedule send');
    expect(document.body.textContent).not.toContain(reason);

    // The row itself is disabled and rejects pointer events; the wrapper is the
    // hover target that carries the explanation.
    const wrapper = item!.parentElement;
    expect(wrapper).not.toBeNull();
    await act(async () => {
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
        wrapper!.dispatchEvent(
          new TestPointerEvent(type, {
            bubbles: type.endsWith('over'),
            pointerType: 'mouse',
          })
        );
      }
    });

    expect(document.body.textContent).toContain(reason);
  });
});
