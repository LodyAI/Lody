// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MachineId, MachineViewMeta, MemoryProviderResponse } from '@lody/shared';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { MemorySetting, RoleMemoryPicker } from '../src/components/settings/memory-setting';
import { initI18n } from '../src/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  remote: true,
  inPane: false,
  online: 'online' as 'online' | 'offline' | 'unknown',
  machines: new Map<MachineId, MachineViewMeta>(),
  accessByMachineId: new Map<
    MachineId,
    { machineId: string; ownerUserId: string; sharedWithTeam: boolean; updatedAt: number }
  >(),
  onlineIds: new Set<MachineId>(),
  provider: {
    result: {
      type: 'machine/memory',
      status: 'not_installed',
      memories: [],
    } as MemoryProviderResponse,
    busy: false,
    refresh: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
    create: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
  },
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('../src/lib/app-platform', () => ({
  useAppCapability: () => mocks.remote,
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: mocks.machines,
    accessByMachineId: mocks.accessByMachineId,
  }),
}));
vi.mock('../src/hooks/use-machine-online-status', () => ({
  useMachineOnlineStatus: () => mocks.online,
  useOnlineMachineIds: () => mocks.onlineIds,
}));
vi.mock('../src/hooks/use-memory-provider', () => ({
  useMemoryProvider: () => mocks.provider,
}));
vi.mock('../src/lib/native-browser', () => ({
  openExternalUrl: (url: string) => mocks.openExternalUrl(url),
}));
vi.mock('../src/components/settings/settings-page-header', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/components/settings/settings-page-header')>();
  return {
    ...actual,
    useInSettingsPane: () => mocks.inPane,
    useSettingsPane: () => null,
  };
});

const localId = 'local' as MachineId;
const remoteId = 'remote' as MachineId;

function machine(id: MachineId, name: string, supported = true): MachineViewMeta {
  return {
    id,
    name,
    cliVersion: '0.80.0',
    os: 'macOS',
    sessions: [],
    raceLimits: {},
    protocolCapabilities: supported ? { memoryProviders: 1 } : {},
  };
}

function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await initI18n('en');
  mocks.remote = true;
  mocks.inPane = false;
  mocks.online = 'online';
  mocks.machines = new Map([
    [localId, machine(localId, 'This Mac')],
    [remoteId, machine(remoteId, 'Build box')],
  ]);
  mocks.accessByMachineId = new Map();
  mocks.onlineIds = new Set([localId]);
  mocks.provider.result = {
    type: 'machine/memory',
    status: 'not_installed',
    memories: [],
  };
  mocks.provider.busy = false;
  mocks.provider.refresh.mockReset().mockResolvedValue(mocks.provider.result);
  mocks.provider.create.mockReset();
  mocks.openExternalUrl.mockClear();
  stubResizeObserver();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSetting() {
  const store = createStore();
  store.set(localProbeResultAtom, { ok: true, machineId: localId });
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MemorySetting />
      </Provider>
    )
  );
}

it('keeps missing nmem on the page with an install link and does not open a dialog', async () => {
  await renderSetting();
  expect(container.textContent).toContain('Nowledge Mem CLI is not installed');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const install = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Get Nowledge Mem')
  );
  if (!install) throw new Error('Missing install action');
  await act(async () => install.click());
  expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://mem.nowledge.co/en');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('does not open the create dialog while nmem is missing', async () => {
  await renderSetting();
  const create = [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Create memory'
  );
  if (!create) throw new Error('Missing create control');
  expect(create).toHaveProperty('disabled', true);
  await act(async () => create.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('opens the create form dialog when the provider is ready', async () => {
  mocks.provider.result = {
    type: 'machine/memory',
    status: 'ready',
    memories: [{ id: 'reviewer', name: 'Reviewer' }],
  };
  await renderSetting();
  expect(container.textContent).toContain('Reviewer');
  const create = [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Create memory'
  );
  if (!create) throw new Error('Missing create control');
  await act(async () => create.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Agent ID');
});

it('omits the machine selector on local-only platforms', async () => {
  mocks.remote = false;
  await renderSetting();
  expect(container.textContent).toContain('Nowledge Mem');
  expect(
    [...container.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('Build box')
    )
  ).toBe(false);
});

it('uses machine pills outside the settings pane and line tabs inside it', async () => {
  await renderSetting();
  expect(
    [...container.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('This Mac')
    )
  ).toBe(true);
  mocks.inPane = true;
  await renderSetting();
  expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Refresh'
    )
  ).toBe(false);
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Create memory'
    )
  ).toBe(false);
});

it('shows the same in-page missing-install copy in the Role picker', async () => {
  const store = createStore();
  await act(async () =>
    root.render(
      <Provider store={store}>
        <RoleMemoryPicker machineId={localId} onChange={() => undefined} />
      </Provider>
    )
  );
  expect(container.textContent).toContain('Nowledge Mem CLI is not installed');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const install = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Get Nowledge Mem')
  );
  if (!install) throw new Error('Missing Role picker install action');
  await act(async () => install.click());
  expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://mem.nowledge.co/en');
});
