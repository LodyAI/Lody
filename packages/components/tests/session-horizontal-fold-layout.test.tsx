// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useHorizontalFoldLayout } from '../src/components/mobile/use-horizontal-fold-layout';

function Conversation() {
  const [messages, setMessages] = useState<HTMLDivElement | null>(null);
  const fold = useHorizontalFoldLayout(messages, true);
  return (
    <div data-page>
      <div ref={setMessages} data-messages style={{ maxHeight: fold?.messageHeight }}>
        Messages
      </div>
      <div
        data-composer
        style={fold ? { position: 'absolute', top: fold.lowerTop } : { display: 'contents' }}
      >
        <input defaultValue="unsent draft" />
      </div>
    </div>
  );
}

afterEach(() => {
  delete window.__LODY_HORIZONTAL_DIVISION__;
  document.documentElement.style.removeProperty('--native-keyboard-height');
  vi.restoreAllMocks();
});

it('keeps messages and composer on either side, restores keyboard layout, and retains drafts', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const top = this.hasAttribute('data-messages') ? 50 : 0;
      return {
        top,
        bottom: 951,
        left: 0,
        right: 669,
        width: 669,
        height: 951 - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    }
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Conversation />));
  const messages = container.querySelector<HTMLElement>('[data-messages]')!;
  const composer = container.querySelector<HTMLElement>('[data-composer]')!;
  const draft = composer.querySelector('input')!;
  await act(async () => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
    window.dispatchEvent(new Event('lody:division-change'));
  });
  expect(messages.style.maxHeight).toBe('405.5px');
  expect(composer.style.top).toBe('495.5px');
  draft.value = 'kept draft';
  await act(async () => {
    document.documentElement.style.setProperty('--native-keyboard-height', '380px');
    window.dispatchEvent(new Event('lody:keyboard-resize'));
  });
  expect(messages.style.maxHeight).toBe('');
  expect(composer.style.display).toBe('contents');
  expect(composer.querySelector('input')).toBe(draft);
  expect(draft.value).toBe('kept draft');
  await act(async () => {
    document.documentElement.style.setProperty('--native-keyboard-height', '0px');
    window.dispatchEvent(new Event('lody:keyboard-resize'));
  });
  expect(composer.style.top).toBe('495.5px');
  await act(async () => {
    window.__LODY_HORIZONTAL_DIVISION__ = null;
    window.dispatchEvent(new Event('lody:division-change'));
  });
  expect(messages.style.maxHeight).toBe('');
  expect(composer.style.display).toBe('contents');
  await act(async () => root.unmount());
  container.remove();
});
