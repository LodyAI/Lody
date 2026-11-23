// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatLandingKeyboardNav } from '../src/hooks/use-chat-landing-keyboard-nav';
import { BugReportDialog } from '../src/components/bug-report/bug-report-dialog';
import { initI18n } from '../src/i18n';

describe('chat-landing-keyboard-nav-ime', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  function KeyboardNavHarness() {
    const rootRef = useRef<HTMLDivElement>(null);
    useChatLandingKeyboardNav(rootRef, { enabled: true });

    return (
      <div ref={rootRef}>
        <textarea aria-label="Prompt" />
      </div>
    );
  }

  function BoundaryHarness() {
    const rootRef = useRef<HTMLDivElement>(null);
    useChatLandingKeyboardNav(rootRef, { enabled: true });
    return (
      <div ref={rootRef}>
        <button type="button">Option</button>
      </div>
    );
  }

  describe('chat landing keyboard navigation IME handling', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(async () => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<KeyboardNavHarness />));
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    });

    it('does not blur the composer when Escape cancels IME composition', async () => {
      const textarea = container.querySelector('textarea');
      expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
      textarea?.focus();

      await act(async () => {
        textarea?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
            isComposing: true,
          })
        );
      });

      expect(document.activeElement).toBe(textarea);

      await act(async () => {
        textarea?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          })
        );
      });

      expect(document.activeElement).not.toBe(textarea);
    });

    it('lets an open modal receive Escape while the composer still has focus', async () => {
      const textarea = container.querySelector('textarea')!;
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('data-open', '');
      document.body.appendChild(dialog);
      textarea.focus();
      let reachedTarget = false;
      textarea.addEventListener('keydown', () => {
        reachedTarget = true;
      });
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });

      await act(async () => textarea.dispatchEvent(event));

      expect(reachedTarget).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(textarea);
      dialog.remove();
    });

    it('yields an unhandled horizontal boundary to the scope switcher', async () => {
      await act(async () => root.render(<BoundaryHarness />));
      const button = container.querySelector('button')!;
      vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
        bottom: 40,
        height: 20,
        left: 20,
        right: 80,
        top: 20,
        width: 60,
        x: 20,
        y: 20,
        toJSON: () => ({}),
      });
      button.focus();
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowLeft',
      });

      await act(async () => button.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(button);
    });
  });
});

describe('bug-report-dialog-ime', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  describe('BugReportDialog IME handling', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(async () => {
      await initI18n('en');
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    });

    it('keeps the draft focused when Escape cancels IME composition', async () => {
      const onClose = vi.fn();

      await act(async () => {
        root.render(
          <BugReportDialog
            open
            machines={[]}
            state={{ status: 'idle' }}
            onSubmit={vi.fn()}
            onClose={onClose}
          />
        );
      });

      const textarea = document.body.querySelector<HTMLTextAreaElement>('#bug-report-description');
      expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
      textarea?.focus();

      await act(async () => {
        // Base UI tracks composition through the document's compositionstart/end
        // listeners rather than `KeyboardEvent.isComposing`.
        textarea?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
            isComposing: true,
          })
        );
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(textarea);

      await act(async () => {
        // The cancelled composition ends before the next keydown, as a real IME
        // session does.
        textarea?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        // Base UI clears its composing flag a tick after compositionend (Safari
        // orders it before the keydown), so let that settle first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        textarea?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          })
        );
      });
    });
  });
});
