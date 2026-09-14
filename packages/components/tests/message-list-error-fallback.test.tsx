/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/error-boundary';
import { MessageListErrorFallback } from '../src/components/sessions/message-list-error-fallback';
import { initI18n } from '../src/i18n';

let root: Root;
let container: HTMLDivElement;
let writeText: ReturnType<typeof vi.fn>;
let crash = true;
function BrokenMessages() {
  if (crash) {
    const error = new TypeError('Failed to measure message');
    error.stack = 'TypeError: Failed to measure message\n    at measureRow (view.tsx:42:7)';
    throw error;
  }
  return <span>Messages recovered</span>;
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.toLowerCase().includes(text.toLowerCase())
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
beforeEach(async () => {
  await initI18n('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  crash = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <ErrorBoundary
          name="SessionChatStream"
          fallbackRender={(props) => <MessageListErrorFallback {...props} />}
        >
          <BrokenMessages />
        </ErrorBoundary>
        <textarea defaultValue="unsent draft" />
      </>
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('copies the original exception and caught React stack without resetting the draft', async () => {
  expect(writeText).not.toHaveBeenCalled();
  await click('Copy error details');
  const report = writeText.mock.calls[0]?.[0];
  expect(report).toContain('TypeError: Failed to measure message');
  expect(report).toContain('at measureRow (view.tsx:42:7)');
  expect(report).toContain('Boundary: SessionChatStream');
  expect(report).toContain('Component stack:');
  expect(report).toContain('BrokenMessages');
  expect(container.textContent).toContain('Copied');
  expect(container.querySelector('textarea')?.value).toBe('unsent draft');
  crash = false;
  await click('Try again');
  expect(container.textContent).toContain('Messages recovered');
  expect(container.querySelector('textarea')?.value).toBe('unsent draft');
});
it('opens selectable details when copying fails, without claiming success', async () => {
  writeText.mockRejectedValue(new Error('clipboard blocked'));
  await click('Copy error details');
  expect(container.textContent).toContain('Copying was blocked');
  expect(button('Copy error details')).toBeDefined();
  expect(container.querySelector('details')?.open).toBe(true);
  expect(container.querySelector('pre')?.textContent).toContain('at measureRow');
});
