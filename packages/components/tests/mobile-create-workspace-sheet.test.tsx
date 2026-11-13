// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileCreateWorkspaceSheet } from '../src/components/mobile/mobile-create-workspace-sheet';
import {
  clearPendingE2eeWorkspace,
  listPendingE2eeWorkspacesByArchive,
  savePendingE2eeWorkspace,
  setPendingE2eeWorkspaceArchived,
} from '../src/lib/e2ee-workspace-storage';

const state = vi.hoisted(() => ({
  createPrepared: vi.fn(),
  // Synthetic server: the reservation outcome and the workspaces it holds.
  serverCreate: vi.fn(),
  serverWorkspaces: new Set<string>(),
}));
const labels: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'e2ee.create.deleteRequest': 'Delete',
  'e2ee.create.deleteConfirmAction': 'Delete request',
  'e2ee.create.deleteFailed': 'Delete not confirmed',
  'e2ee.create.resume': 'Continue saved creation',
  'e2ee.create.archiveRequest': 'Archive',
  'e2ee.create.restoreRequest': 'Restore',
  'e2ee.create.archiveFailed': 'Archive change failed',
};

vi.mock('jotai', () => ({ useAtomValue: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      key === 'e2ee.create.archivedRequests'
        ? `Archived (${(fallback as { count: number }).count})`
        : (labels[key] ?? (typeof fallback === 'string' ? fallback : key)),
  }),
}));
vi.mock('@/atoms/settings', () => ({
  e2eeWorkspaceCreationFeatureEnabledAtom: 'enabled',
}));
const account = vi.hoisted(() => ({ id: 'account-A' }));
vi.mock('@/lib/e2ee-account', () => ({ useE2eeAccountId: () => account.id }));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => ({ canCreateFree: true }),
  usePlatform: () => ({
    e2eeWorkspaces: {
      prepareCreation: async (input: object) => ({
        ...input,
        genesisRecordHex: 'aa',
        genesisHashHex: 'bb'.repeat(32),
      }),
      create: (...args: unknown[]) => state.serverCreate(...args),
    },
  }),
}));
// Real storage and request logic; only the host/cloud round trip is replaced.
vi.mock('@/lib/create-e2ee-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/create-e2ee-workspace')>()),
  createPreparedE2eeWorkspace: (...args: unknown[]) => state.createPrepared(...args),
}));
vi.mock('@/hooks/use-keyboard-aware-scroll-into-view', () => ({
  useKeyboardAwareSheet: () => ({
    contentClassName: '',
    scrollRef: { current: null },
    scrollStyle: {},
  }),
}));
vi.mock('../src/components/mobile/use-vertical-division', () => ({
  useFoldAwareSheetHeight: () => 90,
}));
vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    createOrganization: vi.fn(),
    deleteOrganization: async (id: string) => {
      if (!state.serverWorkspaces.delete(id)) throw new Error('no such workspace');
    },
  }),
}));
vi.mock('../src/hooks/useWorkspaceSlugField', async () => {
  const { useCallback, useState } = await import('react');
  return {
    useWorkspaceSlugField: () => {
      const [slug, setSlug] = useState('');
      const resetSlug = useCallback(() => setSlug(''), []);
      // The saved slug is taken on the server: only a resumed request may submit it.
      const taken = slug === 'saved-slug' || slug === 'second-slug';
      return {
        slug,
        setSlug,
        resetSlug,
        canReset: false,
        isChecking: false,
        isAvailable: !taken,
        error: taken ? 'unavailable' : null,
      };
    },
  };
});
vi.mock('@/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/ui/dialog', () => ({
  AlertDialog: {
    Root: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Header: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
    Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Cancel: ({ children }: { children: React.ReactNode }) => (
      <button type="button" data-confirm-cancel>
        {children}
      </button>
    ),
    Action: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
      <button type="button" data-confirm-discard onClick={onClick}>
        {children}
      </button>
    ),
  },
}));
vi.mock('@lody/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock('@lody/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock('@lody/ui/field', () => ({
  Field: {
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
      <label {...props}>{children}</label>
    ),
  },
}));
vi.mock('@lody/ui/switch', () => ({
  Switch: () => <input type="checkbox" readOnly checked />,
}));
vi.mock('@lody/ui/alert', () => ({
  Alert: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Description: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Actions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  account.id = 'account-A';
  state.createPrepared.mockReset();
  state.serverCreate.mockReset();
  state.serverWorkspaces = new Set();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const pending = {
  accountId: 'account-A',
  requestId: 'saved-request-01',
  name: 'Saved workspace',
  slug: 'saved-slug',
};
const second = {
  accountId: 'account-A',
  requestId: 'saved-request-02',
  name: 'Second workspace',
  slug: 'second-slug',
};
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === label);
const rowButton = (requestId: string, label: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(`[data-request-id="${requestId}"] button`),
  ].find((item) => item.textContent === label);
const nameField = () => container.querySelector<HTMLInputElement>('#mobile-create-workspace-name')!;
const lists = (accountId = 'account-A') =>
  listPendingE2eeWorkspacesByArchive(localStorage, accountId);

async function renderSheet() {
  await act(async () => {
    root.render(<MobileCreateWorkspaceSheet open onOpenChange={() => {}} onCreated={() => {}} />);
  });
}
async function renderWithPending() {
  savePendingE2eeWorkspace(localStorage, pending);
  await renderSheet();
}

describe('mobile encrypted workspace sheet', () => {
  it('unlocks and returns to Create after the server removed the pending request', async () => {
    state.createPrepared.mockImplementation(async () => {
      clearPendingE2eeWorkspace(localStorage, pending);
      throw { data: { code: 'e2ee_creation_not_enabled' } };
    });
    await renderWithPending();
    await act(async () => {
      button('Continue saved creation')!.click();
      await Promise.resolve();
    });
    expect(nameField().disabled).toBe(false);
    expect(button('Create')).toBeTruthy();
    expect(button('Continue saved creation')).toBeUndefined();
    expect(lists()).toEqual({ active: [], archived: [] });
  });

  it('does not delete the saved request when the delete confirmation is cancelled', async () => {
    await renderWithPending();
    await act(async () => rowButton(pending.requestId, 'Delete')!.click());
    expect(container.querySelector('[data-confirm-discard]')).toBeTruthy();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.click();
    });
    expect(lists().active).toEqual([pending]);
  });

  it('deletes the resumed request with the workspace it created and frees the form', async () => {
    const hash = 'bb'.repeat(32);
    state.serverWorkspaces.add('workspace-1');
    state.serverCreate.mockImplementation(async (request: typeof pending) => ({
      workspaceId: 'workspace-1',
      name: request.name,
      slug: request.slug,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash: hash,
      cryptoOrgId: hash,
      activation: 'control-only',
    }));
    await renderWithPending();
    await act(async () => rowButton(pending.requestId, 'Delete')!.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-discard]')!.click();
    });
    expect(state.serverWorkspaces.size).toBe(0);
    expect(lists()).toEqual({ active: [], archived: [] });
    expect(nameField().disabled).toBe(false);
    expect(nameField().value).toBe('');
    expect(button('Continue saved creation')).toBeUndefined();
  });

  it('keeps the request and reports it when the server result cannot be confirmed', async () => {
    state.serverWorkspaces.add('workspace-1');
    state.serverCreate.mockRejectedValue(new Error('reply lost'));
    await renderWithPending();
    await act(async () => rowButton(pending.requestId, 'Delete')!.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-discard]')!.click();
    });
    expect(container.textContent).toContain('Delete not confirmed');
    expect(state.serverWorkspaces.has('workspace-1')).toBe(true);
    expect(lists().active).toEqual([pending]);
    expect(nameField().value).toBe('Saved workspace');
  });

  it('archives the resumed request, frees the form, and restores the same request after reopening', async () => {
    savePendingE2eeWorkspace(localStorage, second);
    await renderWithPending();
    expect(nameField().value).toBe('Saved workspace');
    await act(async () => rowButton(pending.requestId, 'Archive')!.click());
    // The form leaves the archived request for an independent new intent.
    expect(nameField().disabled).toBe(false);
    expect(nameField().value).toBe('');
    expect(button('Continue saved creation')).toBeUndefined();
    expect(lists()).toEqual({ active: [second], archived: [pending] });
    // Reopening resumes only the default list; the archive stays archived.
    act(() => root.unmount());
    root = createRoot(container);
    await renderSheet();
    expect(nameField().value).toBe('Second workspace');
    await act(async () => button('Archived (1)')!.click());
    await act(async () => rowButton(pending.requestId, 'Restore')!.click());
    expect(lists()).toEqual({ active: [pending, second], archived: [] });
    // Selecting it resumes the exact original request ID, name and slug.
    await act(async () =>
      rowButton(pending.requestId, pending.name + ' · ' + pending.slug)!.click()
    );
    state.createPrepared.mockRejectedValue(new Error('reply lost'));
    await act(async () => {
      button('Continue saved creation')!.click();
      await Promise.resolve();
    });
    expect(state.createPrepared).toHaveBeenCalledTimes(1);
    expect(state.createPrepared.mock.calls[0]![2]).toEqual(pending);
    expect(lists().active).toEqual([pending, second]);
  });

  it('keeps an archived request archived when its submit fails late after another window archived it', async () => {
    let fail!: (error: unknown) => void;
    state.createPrepared.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );
    await renderWithPending();
    await act(async () => {
      button('Continue saved creation')!.click();
    });
    // While this sheet submits, its own archive control is unavailable.
    expect(rowButton(pending.requestId, 'Archive')!.disabled).toBe(true);
    // Another window archives the same request; the in-flight submit is not detached.
    setPendingE2eeWorkspaceArchived(localStorage, pending, true);
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(nameField().value).toBe('Saved workspace');
    await act(async () => {
      fail(new Error('reply lost'));
    });
    expect(lists()).toEqual({ active: [], archived: [pending] });
    expect(nameField().disabled).toBe(false);
    expect(nameField().value).toBe('');
    expect(container.querySelector(`[data-request-id="${pending.requestId}"]`)).toBeNull();
  });

  it('shows a real failure and keeps the request when the archive marker cannot be written', async () => {
    await renderWithPending();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await act(async () => rowButton(pending.requestId, 'Archive')!.click());
    setItem.mockRestore();
    expect(container.textContent).toContain('Archive change failed');
    expect(lists()).toEqual({ active: [pending], archived: [] });
    expect(nameField().value).toBe('Saved workspace');
  });
});
