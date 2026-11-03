// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileCreateWorkspaceSheet } from '../src/components/mobile/mobile-create-workspace-sheet';

const state = vi.hoisted(() => ({
  pending: null as { accountId: string; requestId: string; name: string; slug: string } | null,
  createPrepared: vi.fn(),
}));
const labels: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'e2ee.create.discardPending': 'Discard saved request',
  'e2ee.create.discardConfirmAction': 'Discard request',
  'e2ee.create.resume': 'Continue saved creation',
};

vi.mock('jotai', () => ({ useAtomValue: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => labels[key] ?? fallback ?? key,
  }),
}));
vi.mock('@/atoms/settings', () => ({
  e2eeWorkspaceCreationFeatureEnabledAtom: 'enabled',
}));
vi.mock('@/lib/e2ee-account', () => ({ useE2eeAccountId: () => 'account-A' }));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => ({ canCreateFree: true }),
  usePlatform: () => ({ e2eeWorkspaces: { prepareCreation: async () => ({}) } }),
}));
vi.mock('@/lib/e2ee-workspace-storage', () => ({
  listPendingE2eeWorkspaces: () => (state.pending ? [state.pending] : []),
  savePendingE2eeWorkspace: (_storage: Storage, pending: typeof state.pending) => {
    state.pending = pending;
  },
  clearPendingE2eeWorkspace: (_storage: Storage, pending: typeof state.pending) => {
    if (state.pending?.requestId === pending?.requestId) state.pending = null;
  },
}));
vi.mock('@/lib/create-e2ee-workspace', () => ({
  canResumePendingCreation: (pending: typeof state.pending, accountId: string | null) =>
    Boolean(pending && accountId && pending.accountId === accountId),
  canDiscardPendingCreation: (
    creating: boolean,
    pending: typeof state.pending,
    accountId: string | null
  ) => !creating && Boolean(pending && accountId && pending.accountId === accountId),
  clearConfirmedPendingCreation: (
    _storage: Storage,
    pending: typeof state.pending,
    confirmed: boolean
  ) => {
    if (!confirmed || !pending) return false;
    state.pending = null;
    return true;
  },
  e2eeCreationAvailability: (
    pending: typeof state.pending,
    availability: { canCreateFree?: boolean } | null | undefined
  ) => {
    const resumable = Boolean(pending);
    return {
      resumable,
      canCreate: resumable || availability?.canCreateFree === true,
      blocked: !resumable && availability?.canCreateFree === false,
      slugCheckApplies: !resumable,
    };
  },
  e2eeCreationIntent: (
    accountId: string,
    pending: typeof state.pending,
    name: string,
    slug: string
  ) => pending ?? { accountId, requestId: 'new-request', name: name.trim(), slug },
  createPreparedE2eeWorkspace: state.createPrepared,
  isE2eeCreationNotEnabled: (error: { data?: { code?: string } }) =>
    error?.data?.code === 'e2ee_creation_not_enabled',
  pendingCreationRemoved: () => state.pending === null,
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
  useOrganization: () => ({ createOrganization: vi.fn() }),
}));
vi.mock('../src/hooks/useWorkspaceSlugField', () => ({
  useWorkspaceSlugField: () => ({
    slug: 'saved-slug',
    setSlug: () => {},
    resetSlug: () => {},
    canReset: false,
    isChecking: false,
    isAvailable: false,
    error: 'unavailable',
  }),
}));
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
  state.pending = null;
  state.createPrepared.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const pending = {
  accountId: 'account-A',
  requestId: 'saved-request-01',
  name: 'Saved workspace',
  slug: 'saved-slug',
};
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === label);

async function renderWithPending() {
  state.pending = pending;
  await act(async () => {
    root.render(<MobileCreateWorkspaceSheet open onOpenChange={() => {}} onCreated={() => {}} />);
  });
}

describe('mobile encrypted workspace sheet', () => {
  it('unlocks and returns to Create after the server removed the pending request', async () => {
    state.createPrepared.mockImplementation(async () => {
      state.pending = null;
      throw { data: { code: 'e2ee_creation_not_enabled' } };
    });
    await renderWithPending();
    await act(async () => {
      button('Continue saved creation')!.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLInputElement>('#mobile-create-workspace-name')!.disabled
    ).toBe(false);
    expect(button('Create')).toBeTruthy();
    expect(button('Continue saved creation')).toBeUndefined();
    expect(state.pending).toBeNull();
  });

  it('does not clear the saved request when the discard confirmation is cancelled', async () => {
    await renderWithPending();
    await act(async () => {
      button('Discard saved request')!.click();
    });
    expect(container.querySelector('[data-confirm-discard]')).toBeTruthy();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.click();
    });
    expect(state.pending).toEqual(pending);
  });
});
