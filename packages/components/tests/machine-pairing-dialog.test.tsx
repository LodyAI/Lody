// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const clipboard = vi.hoisted(() => ({ text: '' }));
vi.mock('@/lib/clipboard', () => ({
  writeTextToClipboard: async (text: string) => {
    clipboard.text = text;
    return true;
  },
}));
vi.mock('@/hooks/use-convex-error-message', () => ({
  useConvexErrorMessage: () => (_: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/toast', () => ({ toast: { success: () => {}, error: () => {} } }));
import {
  MachinePairingDialog,
  type MachinePairingDialogProps,
} from '../src/components/chat/machine-pairing-dialog';
import { initI18n } from '../src/i18n';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(async () => {
  await initI18n('en');
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  clipboard.text = '';
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = '';
});
it('copies the explicitly selected target-shell command and removes both credentials after pairing is claimed', async () => {
  const props: MachinePairingDialogProps = {
    open: true,
    onOpenChange: () => {},
    requestId: 'synthetic',
    status: 'pending',
    command: 'curl synthetic-shell --auth unix-secret',
    windowsCommand: 'powershell synthetic --auth windows-secret',
    expiresAt: 60000,
    creating: false,
    createError: null,
    onRetry: () => {},
    onCancelRequest: async () => {},
    onConfigureAgents: () => {},
  };
  await act(async () => root.render(<MachinePairingDialog {...props} />));
  expect(document.body.textContent).toContain('unix-secret');
  expect(document.body.textContent).not.toContain('windows-secret');
  const windows = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Windows (PowerShell)'
  );
  expect(windows).toBeDefined();
  await act(async () => windows?.click());
  expect(document.body.textContent).toContain('windows-secret');
  expect(document.body.textContent).not.toContain('unix-secret');
  const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy command"]');
  await act(async () => copy?.click());
  expect(clipboard.text).toBe(props.windowsCommand);
  await act(async () =>
    root.render(
      <MachinePairingDialog {...props} status="claimed" command={null} windowsCommand={null} />
    )
  );
  expect(document.body.textContent).not.toContain('unix-secret');
  expect(document.body.textContent).not.toContain('windows-secret');
});
