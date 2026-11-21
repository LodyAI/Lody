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
import { MemoryAgentConnectList } from '../src/components/settings/memory-agent-connect';
import { MemoryInstallCard } from '../src/components/settings/memory-install';
import { initI18n } from '../src/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  entries: [] as MemoryAssociation[],
  failSave: false,
  beforeLink: async (_entry: MemoryAssociation) => {},
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
    signIn: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
    signInPoll: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
    update: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
    create: vi.fn(async () => undefined as MemoryProviderResponse | undefined),
  },
  /** Per-provider hook state; providers absent here share `provider`. */
  byProvider: {} as Record<string, unknown>,
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
  useMemoryProvider: (_machineId: string, providerId: string) =>
    mocks.byProvider[providerId] ?? mocks.provider,
}));
vi.mock('../src/hooks/use-memory-associations', () => ({
  useMemoryAssociations: (machineId: string) => ({
    entries: mocks.entries.filter((entry) => entry.machineId === machineId),
    link: async (entry: MemoryAssociation) => {
      await mocks.beforeLink(entry);
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
    protocolCapabilities: supported ? { memoryProviders: 2 } : {},
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
  mocks.beforeLink = async () => {};
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
  mocks.byProvider = {};
  mocks.provider.create.mockReset();
  mocks.provider.signIn.mockReset();
  mocks.provider.signInPoll.mockReset();
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
  vi.useRealTimers();
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

it('offers no way to add a memory to a provider this machine cannot reach', async () => {
  // The step belongs to the provider's own block, so it only exists once that
  // provider can answer. A page-level Add opened an editor with nothing in it.
  await renderSetting();
  expect([...container.querySelectorAll('button')].map((node) => node.textContent)).not.toContain(
    'Add memory'
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.entries).toEqual([]);
});

it('holds each provider block to its heading until its own machine answers', async () => {
  const labels = () => [...container.querySelectorAll('button')].map((node) => node.textContent);
  mocks.provider.result = undefined as unknown as MemoryProviderResponse;
  await renderSetting();
  // Both providers are named at once, and neither says anything it may take back.
  expect(container.textContent).toContain('Memory per role');
  expect(container.textContent).toContain('One memory per account');
  expect(labels()).not.toContain('Get Nowledge Mem');
  expect(labels()).not.toContain('One-click download');
  expect(labels()).not.toContain('Install manually');
  mocks.provider.result = { type: 'machine/memory', status: 'not_installed', memories: [] };
  await renderSetting();
  expect(labels()).toContain('Get Nowledge Mem');
  // EverMe offers its in-place download beside the manual route to its own page.
  expect(labels()).toContain('One-click download');
  expect(labels()).toContain('Install manually');
});

it('shows an answered provider at once while another is still asking', async () => {
  // Waiting for the slowest provider hid memories the user could already
  // edit for up to four seconds.
  mocks.entries = [saved];
  mocks.byProvider['nowledge-mem'] = {
    ...mocks.provider,
    result: {
      type: 'machine/memory',
      status: 'ready',
      memories: [{ id: 'reviewer', name: 'Reviewer', description: 'Review lessons' }],
    },
  };
  mocks.byProvider.everme = { ...mocks.provider, result: undefined };
  await renderSetting();
  expect(container.textContent).toContain('Review lessons');
  // EverMe has said nothing yet, so its block still offers nothing.
  const labels = [...container.querySelectorAll('button')].map((node) => node.textContent);
  expect(labels).not.toContain('One-click download');
});

it('waits for the install receipt before asking after the job', async () => {
  // A first reply slower than one poll interval used to be overtaken by the
  // poll and read as a failed install while the machine was still installing.
  vi.useFakeTimers();
  let answerInstall!: (value: MemoryProviderResponse) => void;
  let landed = false;
  let installed = false;
  const reply = (overrides: Partial<MemoryProviderResponse>): MemoryProviderResponse => ({
    type: 'machine/memory',
    status: 'not_installed',
    memories: [],
    ...overrides,
  });
  const state = {
    ...mocks.provider,
    install: () =>
      new Promise<MemoryProviderResponse>((resolve) => {
        answerInstall = resolve;
      }),
    installPoll: async () =>
      landed
        ? reply({ status: 'not_running', install: { status: 'done' } })
        : // A poll before the receipt finds no job yet.
          reply({ install: { status: 'failed' } }),
  } as unknown as Parameters<typeof MemoryInstallCard>[0]['state'];
  await act(async () =>
    root.render(
      <MemoryInstallCard
        name="EverMe"
        providerKey="everme"
        installUrl="https://evermind.ai/everme"
        reason="missing"
        onInstalled={() => {
          installed = true;
        }}
        state={state}
      />
    )
  );
  await click('One-click download');
  await act(async () => vi.advanceTimersByTime(12_000));
  expect(container.textContent).not.toContain('could not install');
  expect(button('One-click download').disabled).toBe(true);
  await act(async () => answerInstall(reply({ install: { status: 'running', step: 'provider' } })));
  landed = true;
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(installed).toBe(true);
  expect(button('One-click download').disabled).toBe(false);
});

it('keeps a connect pending until the job on the machine reports back', async () => {
  vi.useFakeTimers();
  const agent = (id: string, displayName: string, connected: boolean) => ({
    id,
    displayName,
    integration: 'hook' as const,
    supported: true,
    connectable: true,
    connected,
  });
  const before = [agent('claude', 'Claude Code', true), agent('codex', 'Codex', false)];
  const after = [agent('claude', 'Claude Code', true), agent('codex', 'Codex', true)];
  let job: 'running' | 'done' = 'running';
  const state = {
    ...mocks.provider,
    result: { type: 'machine/memory' as const, status: 'ready' as const, memories: [], agents: before },
    connect: vi.fn(async () => ({
      type: 'machine/memory' as const,
      status: 'ready' as const,
      memories: [],
      agentsJob: { status: 'running' as const },
    })),
    connectPoll: async () => ({
      type: 'machine/memory' as const,
      status: 'ready' as const,
      memories: [],
      agentsJob: { status: job },
      ...(job === 'done' ? { agents: after } : {}),
    }),
  } as unknown as Parameters<typeof MemoryAgentConnectList>[0]['state'];
  await act(async () =>
    root.render(
      <MemoryAgentConnectList
        name="EverMe"
        providerKey="everme"
        configs={[
          { agentType: 'claude', name: 'Claude Code' },
          { agentType: 'codex', name: 'Codex' },
        ]}
        agents={before}
        state={state}
        disabled={false}
      />
    )
  );
  await click('Connect Codex');
  const codex = () => button('Connect Codex');
  expect(codex().getAttribute('aria-busy')).toBe('true');
  // The request came back long ago; the machine is still running the job.
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(codex().getAttribute('aria-busy')).toBe('true');
  job = 'done';
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(codex().getAttribute('aria-busy')).toBe('false');
});

it('keeps a stopped provider named and says to start it when asked to add a memory', async () => {
  mocks.provider.result = { type: 'machine/memory', status: 'not_running', memories: [] };
  await renderSetting();
  const page = container.textContent ?? '';
  const heading = page.indexOf('Memory per role');
  const status = page.indexOf('Start Nowledge Mem on this machine');
  expect(heading).toBeGreaterThan(-1);
  expect(status).toBeGreaterThan(heading);
  // Add stays available, as it was before the block existed; the editor is
  // where a stopped provider is explained, and it offers nothing to submit.
  await click('Add memory');
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('Start Nowledge Mem on this machine');
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
    document.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Designer"]')!.click()
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
    '[role="checkbox"][aria-label="Designer"]'
  )!;
  expect(linked.disabled).toBe(true);
  // Already imported is a fact beside the name, not part of what it is called.
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Designer');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Imported');
});

function checkbox(name: string) {
  return document.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="${name}"]`)!;
}
function importButton() {
  return document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

it('retains successful imports and retries only the remaining selections after a failure', async () => {
  ready();
  mocks.beforeLink = async (entry) => {
    if (entry.memoryId === 'designer') throw new Error('storage unavailable');
  };
  await renderSetting();
  await click('Add memory');
  await click('Import');
  await click('Reviewer');
  await click('Designer');
  await submit();
  expect(mocks.entries).toEqual([saved]);
  await renderSetting();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(checkbox('Reviewer').disabled).toBe(true);
  expect(checkbox('Reviewer').getAttribute('aria-checked')).toBe('false');
  expect(checkbox('Designer').getAttribute('aria-checked')).toBe('true');
  mocks.beforeLink = async () => {};
  await submit();
  expect(mocks.entries.map((entry) => entry.memoryId)).toEqual(['reviewer', 'designer']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('locks selection and navigation until the batch finishes saving', async () => {
  ready();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.beforeLink = async () => pending;
  await renderSetting();
  await click('Add memory');
  await click('Import');
  await click('Reviewer');
  await click('Designer');
  await submit();
  expect(checkbox('Reviewer').disabled).toBe(true);
  expect(checkbox('Designer').disabled).toBe(true);
  expect(importButton().disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(true);
  await click('Create');
  expect(checkbox('Designer')).not.toBeNull();
  expect(document.querySelector('[aria-label="Agent ID"]')).toBeNull();
  await act(async () => release());
  expect(mocks.entries.map((entry) => entry.memoryId)).toEqual(['reviewer', 'designer']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
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
  // Emptied, the block offers the step rather than describing the absence —
  // the same full-width control the other provider offers in its own empty
  // state, so the two read as one page.
  expect(button('Add memory')).toBeTruthy();
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

it('keeps saved memories listed after their provider is removed from the machine', async () => {
  mocks.entries = [saved];
  await renderSetting();
  // The default reply is `not_installed`. What Lody saved outlives the
  // provider, and the list is the only place it can be edited or removed.
  expect(container.textContent).toContain('Review lessons');
  expect(container.textContent).toContain('Nowledge Mem is not installed on this machine');
  expect(button('Get Nowledge Mem')).toBeTruthy();
  expect(button(`Remove ${saved.name} from Lody`)).toBeTruthy();
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

it.each(['approved', 'expired'] as const)(
  'keeps polling through transient errors until sign-in is %s',
  async (outcome) => {
    mocks.provider.result = { type: 'machine/memory', status: 'not_running', memories: [] };
    mocks.provider.signIn.mockResolvedValue({
      type: 'machine/memory',
      status: 'not_running',
      memories: [],
      signIn: {
        status: 'pending',
        verificationUrl: 'https://example.com/approve',
        expiresInSec: 60,
      },
    });
    mocks.provider.signInPoll.mockImplementation(async () => {
      const result: MemoryProviderResponse = {
        type: 'machine/memory',
        status: outcome === 'approved' ? 'ready' : 'not_running',
        memories: [],
        signIn: { status: outcome },
        agents: [],
      };
      mocks.provider.result = result;
      return result;
    });
    await renderSetting();
    vi.useFakeTimers();
    await click('Sign in to EverMe');
    expect(container.textContent).toContain('Waiting for your browser');
    for (let i = 0; i < 3; i++) {
      mocks.provider.result = { type: 'machine/memory', status: 'error', memories: [] };
      await renderSetting();
      expect(container.textContent).toContain('Waiting for your browser');
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await renderSetting();
    expect(mocks.provider.result.signIn?.status).toBe(outcome);
    expect(container.textContent).not.toContain('Waiting for your browser');
    if (outcome === 'expired') expect(container.textContent).toContain('This sign-in expired');
  }
);

it('shows the provider’s current name and description after the identity is edited in nmem', async () => {
  ready();
  mocks.entries = [saved];
  mocks.provider.result.memories = [
    { id: 'reviewer', name: 'Gate reviewer', description: 'Read-only review of diffs' },
  ];
  await renderSetting();
  expect(container.textContent).toContain('Gate reviewer');
  expect(container.textContent).toContain('Read-only review of diffs');
  expect(container.textContent).not.toContain('Review lessons');
  mocks.provider.result = { type: 'machine/memory', status: 'error', memories: [] };
  await renderSetting();
  expect(container.textContent).toContain('Review lessons');
});

async function renderPicker(initial?: { providerId: string; memoryId: string }) {
  let value = initial;
  const changes: unknown[] = [];
  const draw = () =>
    root.render(
      <Provider store={createStore()}>
        <RoleMemoryPicker
          machineId={localId}
          value={value}
          onChange={(next) => {
            changes.push(next);
            value = next;
            draw();
          }}
        />
      </Provider>
    );
  await act(async () => draw());
  return { changes, current: () => value };
}
function rowNames() {
  return [...container.querySelectorAll('[aria-pressed]')]
    .filter((node) => node.tagName === 'BUTTON' && !node.textContent?.match(/^(Link|Linked)$/))
    .map((node) => node.textContent);
}
function manyMemories(count: number) {
  const memories = Array.from({ length: count }, (_, index) => ({
    id: `role-${index}`,
    name: `Role ${index}`,
    description: index === 3 ? 'Finds root causes' : undefined,
  }));
  mocks.provider.result = { type: 'machine/memory', status: 'ready', memories };
  mocks.entries = memories.map((memory) => ({
    ...saved,
    memoryId: memory.id,
    name: memory.name,
    description: memory.description,
  }));
}

it('unlinks a Role memory by pressing its Linked button again', async () => {
  ready();
  mocks.entries = [saved];
  const picker = await renderPicker({ providerId: 'nowledge-mem', memoryId: 'reviewer' });
  await click('Linked');
  expect(picker.current()).toBeUndefined();
  await click('Link');
  expect(picker.current()).toEqual({ providerId: 'nowledge-mem', memoryId: 'reviewer' });
});

it('lets a Role unlink a memory whose provider identity was deleted', async () => {
  ready();
  mocks.entries = [saved];
  mocks.provider.result.memories = [];
  const picker = await renderPicker({ providerId: 'nowledge-mem', memoryId: 'reviewer' });
  await click('Linked');
  expect(picker.current()).toBeUndefined();
  expect(button('Link').disabled).toBe(true);
});

it('filters a long Role memory list by name or description and lists the linked memory first', async () => {
  manyMemories(10);
  const picker = await renderPicker({ providerId: 'nowledge-mem', memoryId: 'role-8' });
  expect(rowNames()[0]).toContain('Role 8');
  await fill('Search memories', 'root cause');
  expect(rowNames()).toHaveLength(1);
  expect(rowNames()[0]).toContain('Role 3');
  await click('Link');
  expect(picker.current()).toEqual({ providerId: 'nowledge-mem', memoryId: 'role-3' });
  await fill('Search memories', 'nothing like this');
  expect(container.textContent).toContain('No memories match');
});

it('omits search for a short Role memory list', async () => {
  ready();
  mocks.entries = [saved];
  await renderPicker();
  expect(document.querySelector('[aria-label="Search memories"]')).toBeNull();
});

it('adds search to the Memory page only above seven imported memories on the machine', async () => {
  manyMemories(7);
  await renderSetting();
  expect(document.querySelector('[aria-label="Search memories"]')).toBeNull();
  manyMemories(8);
  await renderSetting();
  await fill('Search memories', 'ROOT CAUSE');
  expect(container.textContent).toContain('Role 3');
  expect(container.textContent).not.toContain('Role 7');
  await fill('Search memories', 'role-7');
  expect(container.textContent).toContain('Role 7');
  expect(container.textContent).not.toContain('Role 3');
  await fill('Search memories', 'nothing like this');
  expect(container.textContent).toContain('No memories match');
});
