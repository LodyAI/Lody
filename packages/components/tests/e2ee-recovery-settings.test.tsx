// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { E2eeRecoverySettings } from '../src/components/settings/e2ee-recovery-settings';
import { cloudOperations } from '../src/lib/cloud-api-operations';
import { initI18n } from '../src/i18n';

const ports = vi.hoisted(() => ({
  query: vi.fn(),
  put: vi.fn(),
  export: vi.fn(),
  verify: vi.fn(),
  select: vi.fn(),
  restore: vi.fn(),
  cloud: true,
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: (...args: unknown[]) => ports.query(...args),
  useCloudMutation: () => ports.put,
}));
vi.mock('@/lib/app-platform', () => ({ useAppCapability: () => ports.cloud }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    auth: {
      exportRecoveryBackup: ports.export,
      verifyRecoveryBackup: ports.verify,
      selectRecoveryBackup: ports.select,
      restoreRecoveryBackup: ports.restore,
    },
  }),
}));

let root: Root;
let container: HTMLDivElement;
const draft = {
  accountId: 'alice',
  backupId: 'backup',
  identity: 'identity',
  revision: 0,
  ciphertext: new Uint8Array([1, 2, 3]),
};
let remote: null | (Omit<typeof draft, 'ciphertext'> & { ciphertext: ArrayBuffer });
const render = async (accountId = 'alice') => {
  await act(async () => root.render(<E2eeRecoverySettings accountId={accountId} />));
};
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(
    (value) => value.textContent === text
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}

beforeEach(async () => {
  await initI18n('en');
  vi.resetAllMocks();
  ports.cloud = true;
  remote = null;
  ports.query.mockImplementation((operation) =>
    operation === cloudOperations.e2eeRecovery.availability ? { enabled: true } : remote
  );
  ports.export.mockResolvedValue(draft);
  ports.verify.mockResolvedValue({
    backupId: draft.backupId,
    identity: draft.identity,
    revision: 0,
  });
  ports.select.mockResolvedValue({ accountId: draft.accountId, backupId: draft.backupId });
  ports.restore.mockResolvedValue({ accountId: draft.accountId, fingerprint: draft.identity });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('retries the same ciphertext and requires matching readback, file verification and storage confirmation', async () => {
  const stored: unknown[] = [];
  ports.put.mockRejectedValueOnce(new Error('offline')).mockImplementation(async (value) => {
    stored.push(value);
  });
  await render();
  await click('Save file');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button('Select saved file').disabled).toBe(true);
  await click('Retry upload');
  expect(stored).toEqual([{ ...draft, ciphertext: draft.ciphertext.buffer }]);
  expect(button('Save file').disabled).toBe(true);
  remote = { ...draft, ciphertext: new Uint8Array([9, 2, 3]).buffer };
  await render();
  expect(button('Select saved file').disabled).toBe(true);
  remote = { ...draft, ciphertext: new Uint8Array(draft.ciphertext).buffer };
  await render();
  ports.verify.mockResolvedValueOnce(null);
  await click('Select saved file');
  expect(container.querySelector('input')).toBeNull();
  await click('Select saved file');
  expect(button('Confirm storage').disabled).toBe(true);
  await act(async () => container.querySelector('input')!.click());
  await click('Confirm storage');
  expect(container.textContent).toContain('This backup was verified.');
});

it('drops an old-account export that completes after switching accounts', async () => {
  let finish!: (value: typeof draft) => void;
  ports.export.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await render();
  await click('Save file');
  await render('bob');
  await act(async () => finish(draft));
  expect(button('Save file').disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(ports.put).not.toHaveBeenCalled();
});

it('does not start hosted work in the local-only composition', async () => {
  ports.cloud = false;
  await render();
  expect(container.childElementCount).toBe(0);
  expect(ports.query).not.toHaveBeenCalled();
  expect(ports.export).not.toHaveBeenCalled();
});

it('restores only a matching account backup after explicit confirmation, with cancellation and retry', async () => {
  await render();
  await click('Find backup from file');
  expect(button('Select file and restore').disabled).toBe(true);
  expect(container.textContent).toContain('No backup was found');
  remote = { ...draft, accountId: 'bob', ciphertext: draft.ciphertext.buffer };
  await render();
  expect(button('Select file and restore').disabled).toBe(true);
  remote = { ...draft, ciphertext: draft.ciphertext.buffer };
  await render();
  expect(button('Select file and restore').disabled).toBe(false);
  ports.restore.mockResolvedValueOnce(null);
  await click('Select file and restore');
  expect(container.textContent).not.toContain('Your encryption identity is saved');
  ports.restore.mockRejectedValueOnce(new Error('keychain-locked'));
  await click('Select file and restore');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await click('Select file and restore');
  expect(container.textContent).toContain('Your encryption identity is saved');
  expect(container.textContent).toContain(
    'device authorization still need to be verified separately'
  );
  expect(button('Select file and restore').disabled).toBe(true);
});

it('does not show an old-account restoration result in a new account', async () => {
  await render();
  await click('Find backup from file');
  remote = { ...draft, ciphertext: draft.ciphertext.buffer };
  await render();
  let finish!: (value: { accountId: string; fingerprint: string }) => void;
  ports.restore.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await click('Select file and restore');
  await render('bob');
  await act(async () => finish({ accountId: 'alice', fingerprint: draft.identity }));
  expect(container.textContent).not.toContain('Your encryption identity is saved');
  expect(button('Find backup from file').disabled).toBe(false);
});
