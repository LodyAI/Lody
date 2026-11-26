// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileCreateWorkspaceSheet } from '../src/components/mobile/mobile-create-workspace-sheet';
import {
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';

const state = vi.hoisted(() => ({
  createPrepared: vi.fn(),
  reconcilePending: vi.fn(),
  serverCreate: vi.fn(),
  onCreated: vi.fn(),
  onOpenChange: vi.fn(),
}));
const labels: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.create': 'Create',
};

vi.mock('jotai', () => ({ useAtomValue: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      labels[key] ?? (typeof fallback === 'string' ? fallback : key),
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
vi.mock('@/lib/create-e2ee-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/create-e2ee-workspace')>();
  return {
    ...actual,
    createPreparedE2eeWorkspace: (...args: unknown[]) => state.createPrepared(...args),
    reconcilePendingE2eeWorkspaces: (...args: unknown[]) => state.reconcilePending(...args),
  };
});
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
  }),
}));
vi.mock('../src/hooks/useWorkspaceSlugField', async () => {
  const { useCallback, useState } = await import('react');
  return {
    useWorkspaceSlugField: () => {
      const [slug, setSlug] = useState('');
      const resetSlug = useCallback(() => setSlug(''), []);
      const taken = slug === 'taken-slug';
      return {
        slug,
        setSlug,
        resetSlug,
        canReset: false,
        isChecking: false,
        isAvailable: !taken,
        error: taken ? 'unavailable' : slug ? null : 'required',
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
vi.mock('@lody/ui/alert', () => ({
  Alert: {
    Root: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
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
  state.reconcilePending.mockReset();
  state.reconcilePending.mockResolvedValue(null);
  state.serverCreate.mockReset();
  state.onCreated.mockReset();
  state.onOpenChange.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === label);
const nameField = () => container.querySelector<HTMLInputElement>('#mobile-create-workspace-name')!;
const slugField = () => container.querySelector<HTMLInputElement>('#mobile-create-workspace-slug')!;
const typeInto = (field: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

async function renderSheet() {
  await act(async () => {
    root.render(
      <MobileCreateWorkspaceSheet
        open
        onOpenChange={state.onOpenChange}
        onCreated={state.onCreated}
      />
    );
  });
}

describe('mobile encrypted workspace sheet', () => {
  it('discloses the encrypted mode costs like desktop and holds "required" until a name is typed', async () => {
    await renderSheet();
    const encryptedChoice = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-create-workspace-encrypted"]'
    )!;
    expect(container.textContent).toContain('e2ee.create.encryptedPoint1');
    expect(container.textContent).not.toContain('e2ee.create.lossWarning');
    expect(container.textContent).not.toContain('organization.workspaceSlugError.required');

    await act(async () => encryptedChoice.click());
    expect(encryptedChoice.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('e2ee.create.lossWarning');

    await typeInto(nameField(), '工作区');
    expect(container.textContent).toContain('organization.workspaceSlugError.required');
  });

  it('discards pending intent immediately on failure and keeps the form editable with no draft UI', async () => {
    state.createPrepared.mockRejectedValue(new Error('reply lost'));
    await renderSheet();
    await typeInto(nameField(), 'Private');
    await typeInto(slugField(), 'private');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mobile-create-workspace-encrypted"]')!
        .click();
    });
    await act(async () => {
      button('Create')!.click();
      await Promise.resolve();
    });
    expect(listPendingE2eeWorkspaces(localStorage, 'account-A')).toEqual([]);
    expect(nameField().disabled).toBe(false);
    expect(container.textContent).toContain('e2ee.create.failed');
    expect(container.querySelector('[data-testid="e2ee-creation-requests"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-create-workspace-resume"]')).toBeNull();
  });

  it('silently reconciles a leftover pending request on open and enters the workspace', async () => {
    savePendingE2eeWorkspace(localStorage, {
      accountId: 'account-A',
      requestId: 'leftover-1',
      name: 'Recovered',
      slug: 'recovered',
    });
    state.reconcilePending.mockResolvedValue({
      workspaceId: 'ws-recovered',
      slug: 'recovered',
    });
    await renderSheet();
    expect(state.reconcilePending).toHaveBeenCalledTimes(1);
    expect(state.onOpenChange).toHaveBeenCalledWith(false);
    expect(state.onCreated).toHaveBeenCalledWith('recovered', 'ws-recovered');
  });
});
