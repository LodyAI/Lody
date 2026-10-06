// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  MachineId,
  MachineViewMeta,
  MemoryProviderResponse,
  MemoryAssociation,
} from '@lody/shared';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { MemorySetting, RoleMemoryPicker } from '../src/components/settings/memory-setting';
import { initI18n } from '../src/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  entries: [] as MemoryAssociation[],
  failSave: false,
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
    update: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
    create: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
  },
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('../src/hooks/use-open-settings', () => ({
  useOpenSettings: () => ({ openSettings: vi.fn() }),
}));
vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: [], synced: true }),
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
vi.mock('../src/hooks/use-memory-associations', () => ({
  useMemoryAssociations: (machineId: string) => ({
    entries: mocks.entries.filter((entry) => entry.machineId === machineId),
    link: async (entry: MemoryAssociation) => {
      if (mocks.failSave) throw new Error('storage unavailable');
      mocks.entries = [...mocks.entries, entry];
    },
    edit: async (entry: MemoryAssociation) => {
      mocks.entries = mocks.entries.map((value) =>
        value.machineId === entry.machineId && value.memoryId === entry.memoryId ? entry : value
      );
    },
    remove: async (entry: MemoryAssociation) => {
      mocks.entries = mocks.entries.filter((value) => value !== entry);
    },
  }),
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
  mocks.entries = [];
  mocks.failSave = false;
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
  const install = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Get Nowledge Mem')
  );
  if (!install) throw new Error('Missing install action');
  await act(async () => install.click());
  expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://mem.nowledge.co/en');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  );
  if (!node) throw new Error(`Missing field ${label}`);
  await act(async () => {
    const prototype =
      node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
}
function ready() {
  mocks.provider.result = {
    type: 'machine/memory',
    status: 'ready',
    memories: [
      { id: 'reviewer', name: 'Reviewer', description: 'Review lessons' },
      { id: 'designer', name: 'Designer', description: 'Design lessons' },
    ],
  };
}
const saved = {
  machineId: 'local',
  providerId: 'nowledge-mem',
  memoryId: 'reviewer',
  name: 'Reviewer',
  description: 'Review lessons',
};

it('keeps Add available for provider selection but disables creation when nmem is missing', async () => {
  await renderSetting();
  await click('Add memory');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Memory providers');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Nowledge Mem CLI is not installed'
  );
  expect(button('Create and import').disabled).toBe(true);
  expect(mocks.entries).toEqual([]);
});

it('shows only saved associations and links exactly one external identity using its name and description', async () => {
  ready();
  await renderSetting();
  expect(container.textContent).not.toContain('Review lessons');
  await click('Add memory');
  await click('Import');
  expect(document.querySelector('[role="dialog"] dl')).toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Designer"]')!.click()
  );
  expect(document.querySelector('[role="dialog"] dl')).toBeNull();
  expect(document.querySelector('[role="dialog"] dl input')).toBeNull();
  await submit();
  expect(mocks.entries).toEqual([
    { ...saved, memoryId: 'designer', name: 'Designer', description: 'Design lessons' },
  ]);
  expect(container.textContent).toContain('Design lessons');
  expect(container.textContent).not.toContain('Review lessons');
  await click('Add memory');
  await click('Import');
  const linked = document.querySelector<HTMLButtonElement>(
    '[role="radio"][aria-label="Designer"]'
  )!;
  expect(linked.disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Designer · Imported');
});

it('creates in nmem then retries only the Lody association if saving fails', async () => {
  ready();
  mocks.failSave = true;
  let enrolled = false;
  mocks.provider.create.mockImplementation(async (input) => {
    if (enrolled) throw new Error('duplicate enrollment');
    enrolled = true;
    return {
      type: 'machine/memory',
      status: 'ready',
      memories: [{ id: input.id, name: input.name, description: input.description }],
    };
  });
  await renderSetting();
  await click('Add memory');
  const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  expect(nameInput.required).toBe(true);
  expect(nameInput.checkValidity()).toBe(false);
  await fill('Name', 'Writer');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Agent ID"]')?.value).toBe(
    'writer'
  );
  expect(document.querySelector('[aria-label="Default Space (optional)"]')).toBeNull();
  await fill('Agent ID', 'custom');
  await fill('Name', 'Writer Updated');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Agent ID"]')?.value).toBe(
    'custom'
  );
  await fill('Agent ID', 'writer');
  await fill('Name', 'Writer');
  await fill('Description (optional)', 'Writing lessons');
  await submit();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Created in the provider'
  );
  expect(mocks.entries).toEqual([]);
  mocks.failSave = false;
  await submit();
  expect(mocks.entries).toEqual([
    { ...saved, memoryId: 'writer', name: 'Writer', description: 'Writing lessons' },
  ]);
  expect(container.textContent).toContain('Writing lessons');
});

it('updates the provider profile and Lody metadata, then removes only the import', async () => {
  ready();
  mocks.entries = [saved];
  await renderSetting();
  mocks.provider.update.mockImplementation(async (input) => {
    mocks.provider.result = { type: 'machine/memory', status: 'ready', memories: [{ ...input }] };
    return mocks.provider.result;
  });
  await click('Edit Reviewer');
  await fill('Name', 'My reviewer');
  await fill('Description (optional)', 'Local description');
  await submit();
  expect(mocks.entries).toEqual([
    { ...saved, name: 'My reviewer', description: 'Local description' },
  ]);
  expect(mocks.provider.result.memories[0]?.name).toBe('My reviewer');
  await click('Remove My reviewer from Lody');
  await renderSetting();
  expect(container.textContent).toContain('No memories imported yet');
  expect(mocks.provider.result.memories.map((value) => value.id)).toContain('reviewer');
});

it('warns after a successful missing-identity probe but not after a transport failure', async () => {
  ready();
  mocks.entries = [saved];
  await renderSetting();
  expect(container.textContent).not.toContain('no longer exists');
  mocks.provider.result = { type: 'machine/memory', status: 'ready', memories: [] };
  await renderSetting();
  expect(container.textContent).toContain('no longer exists');
  mocks.provider.result = { type: 'machine/memory', status: 'error', memories: [] };
  await renderSetting();
  expect(container.textContent).not.toContain('no longer exists');
  expect(container.textContent).toContain('Review lessons');
});

it('uses only associated identities in the Role picker and prevents selecting a deleted provider identity', async () => {
  ready();
  mocks.entries = [saved];
  mocks.provider.result.memories = [];
  const store = createStore();
  await act(async () =>
    root.render(
      <Provider store={store}>
        <RoleMemoryPicker
          machineId={localId}
          onChange={() => {
            throw new Error('Cannot select missing identity');
          }}
        />
      </Provider>
    )
  );
  expect(container.textContent).toContain('Review lessons');
  expect(button('Link').disabled).toBe(true);
});

it('uses the Agents machine pills and pane tabs and omits both on local-only platforms', async () => {
  await renderSetting();
  expect(
    [...container.querySelectorAll('button')].some((node) => node.textContent?.includes('This Mac'))
  ).toBe(true);
  mocks.inPane = true;
  await renderSetting();
  expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  mocks.remote = false;
  await renderSetting();
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).not.toContain('Build box');
});
