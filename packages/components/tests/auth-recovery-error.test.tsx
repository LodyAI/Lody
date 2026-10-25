/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('../src/providers/convex-provider', () => ({ useAuthSignOut: () => mocks.signOut }));
import { AuthRecoveryError } from '../src/components/auth-recovery-error';
import { AuthRecoveryEntryProvider } from '../src/components/auth-recovery-entry';
import { AuthRecoveryEntrySlot } from '../src/components/auth-recovery-entry';

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

function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label
  );
  expect(result).toBeDefined();
  return result!;
}

it('hosts recovery beside existing controls and preserves the page when it clears', async () => {
  function Workspace({ failed }: { failed: boolean }) {
    return (
      <AuthRecoveryEntryProvider notice={failed ? <AuthRecoveryError onRetry={() => {}} /> : null}>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <footer>
          <span>Workspace</span>
          <AuthRecoveryEntrySlot />
          <button>Settings</button>
        </footer>
      </AuthRecoveryEntryProvider>
    );
  }
  await act(async () => root.render(<Workspace failed={false} />));
  const draft = container.querySelector('textarea')!;
  draft.focus();
  draft.value = 'Still editing';
  await act(async () => root.render(<Workspace failed />));
  const status = button('Connection needs attention');
  expect(status.closest('footer')).toBe(container.querySelector('footer'));
  expect(button('Settings').disabled).toBe(false);
  expect(document.activeElement).toBe(draft);
  expect(draft.value).toBe('Still editing');
  await act(async () => root.render(<Workspace failed={false} />));
  expect(container.querySelector('[data-auth-recovery-entry]')?.childElementCount).toBe(0);
  expect(container.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('Still editing');
});

it('preserves draft focus when recovery fails and leaves the page interactive', async () => {
  const draft = document.createElement('textarea');
  container.appendChild(draft);
  draft.value = 'Keep this draft';
  draft.focus();
  const host = document.createElement('div');
  container.appendChild(host);
  const statusRoot = createRoot(host);
  try {
    await act(async () => statusRoot.render(<AuthRecoveryError onRetry={() => {}} />));
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe('Keep this draft');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.closest('[inert]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Connection needs attention'
    );
  } finally {
    await act(async () => statusRoot.unmount());
    draft.remove();
    host.remove();
  }
});

it('opens details only on demand, retries explicitly and preserves a collapsed recovery entry', async () => {
  let state = 'paused';
  await act(async () =>
    root.render(
      <AuthRecoveryError
        onRetry={() => {
          state = 'retry requested';
        }}
      />
    )
  );
  await act(async () => button('Connection needs attention').click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Automatic retries have paused'
  );
  await act(async () => button('Retry connection').click());
  expect(state).toBe('retry requested');
  const close = document.querySelector<HTMLButtonElement>(
    '[aria-label="Close connection details"]'
  )!;
  await act(async () => close.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('Connection needs attention')).toBeDefined();
});

it('shows pending sign-in and contains rejection with an actionable error', async () => {
  let rejectSignOut!: (error: Error) => void;
  mocks.signOut.mockReturnValue(
    new Promise<void>((_, reject) => {
      rejectSignOut = reject;
    })
  );
  await act(async () => root.render(<AuthRecoveryError onRetry={() => {}} />));
  await act(async () => button('Connection needs attention').click());
  await act(async () => button('Sign in again').click());
  expect(button('Opening sign-in…').disabled).toBe(true);
  expect(button('Retry connection').disabled).toBe(true);
  await act(async () => rejectSignOut(new Error('synthetic sign-out failure')));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'Unable to open sign-in. Please try again.'
  );
  expect(button('Sign in again').disabled).toBe(false);
  expect(button('Retry connection').disabled).toBe(false);
});

it('distinguishes reconnecting, offline and paused states without offering duplicate retries', async () => {
  const onRetry = () => {};
  await act(async () => root.render(<AuthRecoveryError onRetry={onRetry} isRecovering />));
  await act(async () => button('Reconnecting').click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Trying to restore your connection'
  );
  expect(button('Reconnecting').disabled).toBe(false);
  expect(
    [...document.querySelectorAll('button')].filter(
      (item) => item.textContent === 'Reconnecting' && item.disabled
    )
  ).toHaveLength(1);
  await act(async () =>
    root.render(<AuthRecoveryError onRetry={onRetry} isRecovering isOffline />)
  );
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Offline');
  expect(button('Retry connection').disabled).toBe(true);
  await act(async () => root.render(<AuthRecoveryError onRetry={onRetry} />));
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Connection needs attention');
  expect(button('Retry connection').disabled).toBe(false);
});
