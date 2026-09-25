// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BugReportDialog } from '../src/components/bug-report/bug-report-dialog';
import { initI18n } from '../src/i18n';

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
