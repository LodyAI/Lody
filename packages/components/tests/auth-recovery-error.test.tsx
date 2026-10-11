/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('../src/providers/convex-provider', () => ({ useAuthSignOut: () => mocks.signOut }));
import { AuthRecoveryError } from '../src/components/auth-recovery-error';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await initI18n('en');
  mocks.signOut.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('shows the stopped state, allows explicit retry and delegates sign-in to normal sign-out', async () => {
  let retried = false;
  let finishSignOut!: () => void;
  mocks.signOut.mockReturnValue(
    new Promise<void>((resolve) => {
      finishSignOut = resolve;
    })
  );
  await act(async () =>
    root.render(
      <AuthRecoveryError
        onRetry={() => {
          retried = true;
        }}
      />
    )
  );
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain('Automatic retries have stopped');
  expect(mocks.signOut).not.toHaveBeenCalled();
  const retry = [...dialog.querySelectorAll('button')].find(
    (button) => button.textContent === 'Retry connection'
  )!;
  const signIn = [...dialog.querySelectorAll('button')].find(
    (button) => button.textContent === 'Sign in again'
  )!;
  await act(async () => retry.click());
  expect(retried).toBe(true);
  expect(mocks.signOut).not.toHaveBeenCalled();
  await act(async () => signIn.click());
  expect(signIn.disabled).toBe(true);
  expect(retry.disabled).toBe(true);
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await act(async () => finishSignOut());
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
  expect(signIn.disabled).toBe(false);
});
