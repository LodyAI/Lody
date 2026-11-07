import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNativeOAuthSignIn, waitForNativeOAuthReturn } from '../src/lib/native-oauth';

class MockDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

class MockWindow extends EventTarget {
  document = new MockDocument();
}

const returnGraceMs = 50;

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForNativeOAuthReturn', () => {
  it('waits until the app loses focus and returns', async () => {
    const appWindow = new MockWindow();
    let returned = false;
    const returnedPromise = waitForNativeOAuthReturn(appWindow).then(() => {
      returned = true;
    });

    appWindow.dispatchEvent(new Event('focus'));
    await Promise.resolve();

    expect(returned).toBe(false);

    appWindow.dispatchEvent(new Event('blur'));
    appWindow.dispatchEvent(new Event('focus'));
    await returnedPromise;

    expect(returned).toBe(true);
  });

  it('treats visibility becoming visible after hidden as a return', async () => {
    const appWindow = new MockWindow();
    const returnedPromise = waitForNativeOAuthReturn(appWindow);

    appWindow.document.visibilityState = 'hidden';
    appWindow.document.dispatchEvent(new Event('visibilitychange'));
    appWindow.document.visibilityState = 'visible';
    appWindow.document.dispatchEvent(new Event('visibilitychange'));

    await expect(returnedPromise).resolves.toBeUndefined();
  });
});

describe('runNativeOAuthSignIn', () => {
  it('returns without session when the native browser returns and the sign-in promise hangs', async () => {
    vi.useFakeTimers();
    const appWindow = new MockWindow();
    const resultPromise = runNativeOAuthSignIn(() => new Promise(() => undefined), {
      appWindow,
      returnGraceMs,
    });

    appWindow.dispatchEvent(new Event('blur'));
    appWindow.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(returnGraceMs);

    await expect(resultPromise).resolves.toBe('returned_without_session');
  });

  it('does not report interruption when a session update arrives during the return grace period', async () => {
    vi.useFakeTimers();
    const appWindow = new MockWindow();
    const resultPromise = runNativeOAuthSignIn(() => new Promise(() => undefined), {
      appWindow,
      returnGraceMs,
    });

    appWindow.dispatchEvent(new Event('blur'));
    appWindow.dispatchEvent(new Event('focus'));
    appWindow.dispatchEvent(new Event('better-auth:session-update'));
    await vi.advanceTimersByTimeAsync(returnGraceMs);

    await expect(resultPromise).resolves.toBe('completed');
  });
});
