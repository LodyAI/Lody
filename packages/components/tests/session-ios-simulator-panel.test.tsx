// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  type IosSimulatorCommand,
  type IosSimulatorDevice,
  type IosSimulatorPreview,
  type IosSimulatorResponse,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { runtimeAtom, userAtom, type WorkspaceRuntime } from '../src/atoms';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { lodyPresenceSyncStateAtom } from '../src/atoms/presence';
import { writeTextToClipboard } from '../src/lib/clipboard';
import { downloadBytesAsFile } from '../src/lib/download-file';
import { toast } from '../src/lib/toast';
import {
  IOS_SIMULATOR_PREPARING_MAX_POLLS,
  writeIosSimulatorSelectedDevice,
} from '../src/lib/ios-simulator/ios-simulator-model';
import { SessionIosSimulatorPanel } from '../src/components/sessions/ios-simulator/session-ios-simulator-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) =>
      (fallback ?? _key).replace(
        /\{\{(\w+)\}\}/g,
        (placeholder, key: string) => values?.[key] ?? placeholder
      ),
  }),
}));

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: vi.fn(async () => true),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/lib/download-file', () => ({
  downloadBytesAsFile: vi.fn(),
}));

const MACHINE = 'mac-studio' as MachineId;
const SESSION = { id: 'session-sim' as SessionId, machineId: MACHINE };
const WORKSPACE = 'workspace-sim' as WorkspaceId;
const VIEWER_ORIGIN = 'https://viewer.example';
const VIEWER_URL = `${VIEWER_ORIGIN}/stream?capability=secret-capability`;
const IOS_18 = 'com.apple.CoreSimulator.SimRuntime.iOS-18-2';

const macMeta = (protocolCapabilities?: Record<string, number>): MachineMeta => ({
  id: MACHINE,
  name: 'Studio',
  cliVersion: '9.9.9',
  os: 'darwin',
  sessions: [],
  protocolCapabilities,
});

const device = (overrides: Partial<IosSimulatorDevice> & { udid: string }): IosSimulatorDevice => ({
  name: overrides.udid,
  runtime: IOS_18,
  deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  state: 'Shutdown',
  available: true,
  occupancy: 'available',
  ...overrides,
});

const answer = (fields: Partial<IosSimulatorResponse> = {}): IosSimulatorResponse => ({
  type: 'ios-simulator/control_response',
  sessionId: SESSION.id,
  success: true,
  ...fields,
});

const preview = (fields: Partial<IosSimulatorPreview> & Pick<IosSimulatorPreview, 'phase'>) => ({
  operationId: 'op-1',
  udid: 'phone',
  transport: 'remote' as const,
  ...fields,
});

/**
 * The one `ios-simulator/control` RPC, answered by the test. `list` and
 * `status` answer from the current fields; `start` and `stop` from a queue the
 * test fills, or stay pending until it does.
 */
function createFakeMachine(initial: {
  devices: IosSimulatorDevice[];
  preview?: IosSimulatorPreview;
  list?: IosSimulatorResponse;
}) {
  const commands: IosSimulatorCommand[] = [];
  const state = {
    preview: initial.preview,
    list: initial.list,
  };
  const pending: Array<(response: IosSimulatorResponse) => void> = [];
  const requestIosSimulatorControl = async ({ command }: { command: IosSimulatorCommand }) => {
    commands.push(command);
    switch (command.action) {
      case 'list':
        return state.list ?? answer({ devices: initial.devices });
      case 'status':
        return answer({
          preview:
            !command.operationId || command.operationId === state.preview?.operationId
              ? state.preview
              : undefined,
        });
      default:
        return new Promise<IosSimulatorResponse>((resolve) => pending.push(resolve));
    }
  };
  return {
    commands,
    requestIosSimulatorControl,
    setPreview: (next: IosSimulatorPreview | undefined) => {
      state.preview = next;
    },
    /** Answers the oldest pending start/stop. */
    answerNext: async (response: IosSimulatorResponse) => {
      await act(async () => {
        pending.shift()?.(response);
        await Promise.resolve();
      });
      await flush();
    },
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function renderPanel(options: {
  machine: ReturnType<typeof createFakeMachine>;
  meta?: MachineMeta;
  presence?: 'synced' | 'idle';
  localMachine?: boolean;
  onAttachScreenshot?: (file: File) => boolean;
  controlsLayout?: 'toolbar' | 'menu';
}) {
  const store = createStore();
  store.set(userAtom, { id: 'user-1', name: 'Sim User', email: 'sim@example.com' } as never);
  store.set(runtimeAtom, {
    workspaceId: WORKSPACE,
    workspaceSlug: 'sim',
    requestIosSimulatorControl: options.machine.requestIosSimulatorControl,
  } as unknown as WorkspaceRuntime);
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(MACHINE)]: options.meta ?? macMeta({ iosSimulator: 1 }),
  });
  store.set(lodyPresenceSyncStateAtom, options.presence ?? 'idle');
  if (options.localMachine) store.set(localProbeResultAtom, { machineId: MACHINE } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const render = async (active: boolean) => {
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(SessionIosSimulatorPanel, {
            session: SESSION,
            active,
            onAttachScreenshot: options.onAttachScreenshot,
            controlsLayout: options.controlsLayout,
          })
        )
      );
    });
    await flush();
  };
  await render(true);
  return { render };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const text = () => container?.textContent ?? '';

function button(label: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!match) throw new Error(`No button "${label}" in: ${text()}`);
  return match as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

describe('SessionIosSimulatorPanel', () => {
  it('discovers an agent replacement when reopening instead of querying the cached operation', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone' }), device({ udid: 'tablet', deviceType: 'iPad' })],
    });
    const { render } = await renderPanel({ machine });
    await click('Start and preview');
    await machine.answerNext(
      answer({ preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL }) })
    );
    expect(container?.querySelector('iframe')?.src).toBe(VIEWER_URL);
    await render(false);
    machine.setPreview(
      preview({
        operationId: 'agent-op',
        udid: 'tablet',
        phase: 'ready',
        viewerUrl: `${VIEWER_ORIGIN}/replacement`,
      })
    );
    await render(true);
    expect(container?.querySelector('iframe')?.src).toBe(`${VIEWER_ORIGIN}/replacement`);
    expect(machine.commands.at(-1)).toEqual({ action: 'status', operationId: undefined });
  });

  it('discovers an agent start through Refresh while the panel is already idle', async () => {
    const machine = createFakeMachine({ devices: [device({ udid: 'phone' })] });
    await renderPanel({ machine });
    machine.setPreview(preview({ operationId: 'agent-op', phase: 'ready', viewerUrl: VIEWER_URL }));
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="Simulator"]')?.click();
    });
    await flush();
    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh simulators"]'
    );
    expect(refresh).not.toBeNull();
    await act(async () => {
      refresh?.click();
    });
    await flush();
    expect(container?.querySelector('iframe')?.src).toBe(VIEWER_URL);
  });

  it('asks for an update on a Mac whose Lody predates the protocol, without calling it', async () => {
    const machine = createFakeMachine({ devices: [device({ udid: 'a' })] });
    await renderPanel({ machine, meta: macMeta() });
    expect(text()).toContain('Update Lody on Studio');
    expect(machine.commands).toEqual([]);
  });

  it('says a remote Mac is offline, but keeps talking to this machine directly', async () => {
    const offline = createFakeMachine({ devices: [device({ udid: 'a' })] });
    await renderPanel({ machine: offline, presence: 'synced' });
    expect(text()).toContain('Studio is offline');
    expect(offline.commands).toEqual([]);
    act(() => root?.unmount());
    container?.remove();

    const local = createFakeMachine({
      devices: [device({ udid: 'phone', name: 'iPhone 16', state: 'Booted' })],
    });
    await renderPanel({ machine: local, presence: 'synced', localMachine: true });
    expect(text()).not.toContain('offline');
    expect(text()).toContain('iPhone 16');
    expect(local.commands).toContainEqual({ action: 'list' });
  });

  it('starts a shut-down device and polls the operation until the viewer is ready', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({ devices: [device({ udid: 'phone', name: 'iPhone 16' })] });
    await renderPanel({ machine });
    // On open the panel recovers any preview without naming an operation.
    expect(machine.commands).toContainEqual({ action: 'status', operationId: undefined });

    await click('Start and preview');
    expect(machine.commands).toContainEqual({ action: 'start', udid: 'phone' });
    // Cancel names the operation, so it waits for the machine to name one.
    expect(button('Cancel').disabled).toBe(true);

    await machine.answerNext(answer({ preview: preview({ phase: 'booting' }) }));
    expect(text()).toContain('Starting the simulator');
    expect(button('Cancel').disabled).toBe(false);

    machine.setPreview(preview({ phase: 'ready', viewerUrl: VIEWER_URL }));
    await advance(1_000);
    expect(machine.commands).toContainEqual({ action: 'status', operationId: 'op-1' });
    const frame = container?.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(VIEWER_URL);
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(text()).not.toContain('viewer.example');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'lody:ios-simulator:state',
            operationId: 'op-1',
            state: 'ready',
            width: 100,
            height: 200,
          },
          origin: VIEWER_ORIGIN,
          source: frame?.contentWindow,
        })
      );
    });
    // Ready is not polled: the viewer reports its own stream.
    const reads = machine.commands.length;
    await advance(60_000);
    expect(machine.commands.length).toBe(reads);
  });

  it('greets the viewer at its exact origin and trusts only that frame', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL, transport: 'local' }),
    });
    const { render } = await renderPanel({ machine });
    const frame = container?.querySelector('iframe') as HTMLIFrameElement;
    const posted: Array<[unknown, string]> = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((
      message: unknown,
      origin: string
    ) => posted.push([message, origin])) as never);

    await act(async () => {
      frame.dispatchEvent(new Event('load'));
    });
    expect(posted).toEqual([
      [{ type: 'lody:ios-simulator:init', operationId: 'op-1', visible: true }, VIEWER_ORIGIN],
    ]);

    const dropped = {
      type: 'lody:ios-simulator:state',
      operationId: 'op-1',
      state: 'disconnected',
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: dropped, origin: VIEWER_ORIGIN, source: window })
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: dropped,
          origin: 'https://wrong.example',
          source: frame.contentWindow,
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { ...dropped, operationId: 'stale' },
          origin: VIEWER_ORIGIN,
          source: frame.contentWindow,
        })
      );
    });
    expect(text()).not.toContain('lost its connection');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: dropped,
          origin: VIEWER_ORIGIN,
          source: frame.contentWindow,
        })
      );
    });
    await flush();
    expect(text()).toContain('The viewer lost its connection.');

    // Hiding the panel keeps the frame and tells the viewer instead.
    await render(false);
    expect(container?.querySelector('iframe')).toBe(frame);
    expect(posted.at(-1)).toEqual([
      { type: 'lody:ios-simulator:visibility', operationId: 'op-1', visible: false },
      VIEWER_ORIGIN,
    ]);
  });

  it('offers restore if a visible viewer never reports a first frame', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted' })],
      preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL }),
    });
    await renderPanel({ machine });
    expect(text()).not.toContain('lost its connection');
    await advance(25_000);
    expect(text()).toContain('The viewer hit an error.');
    expect(button('Restore').disabled).toBe(false);
  });

  it('cancels a preparing preview by stopping its exact operation', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', name: 'iPhone 16', state: 'Booted' })],
      preview: preview({ phase: 'connecting', operationId: 'op-9' }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('Connecting the viewer');

    await click('Cancel');
    expect(machine.commands).toContainEqual({ action: 'stop', operationId: 'op-9' });
    await machine.answerNext(
      answer({ preview: preview({ phase: 'closed', operationId: 'op-9' }) })
    );
    expect(button('Preview').disabled).toBe(false);
  });

  it('reports a start that never becomes ready instead of polling forever', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted' })],
      preview: preview({ phase: 'connecting' }),
    });
    await renderPanel({ machine });
    for (let poll = 0; poll <= IOS_SIMULATOR_PREPARING_MAX_POLLS; poll += 1) await advance(1_000);
    expect(text()).toContain('The preview took too long to start');
    const reads = machine.commands.length;
    await advance(10_000);
    expect(machine.commands.length).toBe(reads);
    expect(button('Stop preview').disabled).toBe(false);
  });

  it('offers Restore after the preview closed, as a new start', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: preview({ phase: 'closed' }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('The preview ended.');
    await click('Restore');
    expect(machine.commands).toContainEqual({ action: 'start', udid: 'phone' });
  });

  it('never offers a preview of a device another Session controls', async () => {
    const machine = createFakeMachine({
      devices: [
        device({ udid: 'free', name: 'iPhone 16', state: 'Booted' }),
        device({
          udid: 'taken',
          name: 'iPhone 16 Pro',
          state: 'Booted',
          occupancy: 'other-session',
        }),
      ],
    });
    writeIosSimulatorSelectedDevice(
      { accountId: 'user-1', workspaceId: WORKSPACE, machineId: MACHINE, sessionId: SESSION.id },
      'taken'
    );
    await renderPanel({ machine });
    expect(text()).toContain('Another session is using this simulator');
    expect(() => button('Preview')).toThrow();
    expect(() => button('Start and preview')).toThrow();
  });

  it('explains a Mac without Xcode and copies redacted diagnostics', async () => {
    const machine = createFakeMachine({
      devices: [],
      list: answer({
        success: false,
        error: 'environment',
        message: 'xcrun failed at /Users/alice/Library via https://relay.example/?token=abc',
      }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('Xcode isn’t set up on Studio');
    expect(text()).not.toContain('relay.example');
    expect(text()).not.toContain('alice');

    await click('Copy diagnostics');
    const copied = vi.mocked(writeTextToClipboard).mock.calls.at(-1)?.[0] ?? '';
    expect(copied).toContain('error=environment');
    expect(copied).not.toContain('alice');
    expect(copied).not.toContain('relay.example');
  });
});

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

const CONTROLS_META = macMeta({ iosSimulator: 1, iosSimulatorControls: 1 });
const READY = preview({ phase: 'ready', viewerUrl: VIEWER_URL, transport: 'local' });

const labelled = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

/** The full pointer sequence Base UI listens for, then the frames it defers to. */
async function pointerClick(element: Element) {
  await act(async () => {
    const pointer = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, detail: 1 };
    element.dispatchEvent(new PointerEvent('pointermove', pointer));
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', pointer));
    if (element instanceof HTMLElement) element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', pointer));
    (element as HTMLElement).click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  await flush();
}

async function until<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = find();
    if (found) return found;
    await pointerFrame();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function pointerFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

const menuItem = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label
  );

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function connectControlViewer() {
  const frame = container!.querySelector('iframe')!;
  const requests: Array<{
    type: string;
    operationId: string;
    requestId: string;
    control: unknown;
  }> = [];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(
    (message: (typeof requests)[number]) => {
      if (message.type === 'lody:ios-simulator:control') requests.push(message);
    }
  );
  await act(async () => {
    frame.dispatchEvent(new Event('load'));
  });
  const reply = async (
    fields: Record<string, unknown> = {},
    source: MessageEventSource | null = frame.contentWindow,
    origin = VIEWER_ORIGIN
  ) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          origin,
          data: {
            ...requests.at(-1),
            type: 'lody:ios-simulator:control-result',
            success: true,
            ...fields,
          },
        })
      );
    });
    await flush();
  };
  return { frame, requests, reply };
}

describe('SessionIosSimulatorPanel controls', () => {
  it('sends native controls through the exact ready operation', async () => {
    const machine = createFakeMachine({
      devices: [
        device({
          udid: 'phone',
          name: 'iPhone 16 Pro',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
          state: 'Booted',
          occupancy: 'this-session',
        }),
      ],
      preview: READY,
    });
    await renderPanel({ machine, meta: CONTROLS_META });

    const viewer = await connectControlViewer();
    await act(async () => labelled('Home')?.click());
    await flush();
    await viewer.reply();
    await act(async () => labelled('Shake')?.click());
    await flush();
    await viewer.reply();
    await act(async () => labelled('Lock')?.click());
    await flush();

    expect(viewer.requests.map(({ operationId, control }) => ({ operationId, control }))).toEqual([
      { operationId: 'op-1', control: { kind: 'button', button: 'home' } },
      { operationId: 'op-1', control: { kind: 'shake' } },
      { operationId: 'op-1', control: { kind: 'button', button: 'lock' } },
    ]);
    await viewer.reply();
    expect(
      machine.commands.every((command) => command.action === 'list' || command.action === 'status')
    ).toBe(true);
  });

  it('turns the exterior only after the machine confirms a rotation', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: READY,
    });
    await renderPanel({ machine, meta: CONTROLS_META });
    const turns = () =>
      container?.querySelector('[data-testid="ios-simulator-device"]')?.getAttribute('data-turns');
    expect(turns()).toBe('0');

    const viewer = await connectControlViewer();
    await act(async () => labelled('Rotate left')?.click());
    await flush();
    await viewer.reply({ success: false, error: 'failed' });
    expect(turns()).toBe('0');
    expect(vi.mocked(toast.error)).toHaveBeenCalled();

    await act(async () => labelled('Rotate left')?.click());
    await flush();
    expect(turns()).toBe('0');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: viewer.frame.contentWindow,
          origin: VIEWER_ORIGIN,
          data: {
            type: 'lody:ios-simulator:state',
            operationId: 'op-1',
            state: 'ready',
            width: 2000,
            height: 1200,
            rotation: 270,
          },
        })
      );
    });
    expect(turns()).toBe('3');
    await viewer.reply();
    expect(turns()).toBe('3');
  });

  it('ignores spoofed control replies, serializes presses and times out a lost reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const machine = createFakeMachine({ devices: [device({ udid: 'phone' })], preview: READY });
    await renderPanel({ machine, meta: CONTROLS_META });
    const viewer = await connectControlViewer();
    await act(async () => labelled('Home')?.click());
    expect(labelled('Home')?.disabled).toBe(true);
    await viewer.reply({}, window);
    await viewer.reply({}, viewer.frame.contentWindow, 'https://wrong.example');
    await viewer.reply({ operationId: 'old-operation' });
    await viewer.reply({ requestId: 'other-request' });
    await act(async () => labelled('Shake')?.click());
    expect(viewer.requests).toHaveLength(1);
    expect(labelled('Home')?.disabled).toBe(true);
    await viewer.reply();
    expect(labelled('Home')?.disabled).toBe(false);
    await act(async () => labelled('Home')?.click());
    await advance(15_000);
    expect(labelled('Home')?.disabled).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('The simulator didn’t respond. Try again.');
  });

  it('cancels a control on iframe navigation and discards completions after unmount', async () => {
    const machine = createFakeMachine({ devices: [device({ udid: 'phone' })], preview: READY });
    await renderPanel({ machine, meta: CONTROLS_META });
    const viewer = await connectControlViewer();
    await act(async () => labelled('Home')?.click());
    await act(async () => viewer.frame.dispatchEvent(new Event('load')));
    await flush();
    expect(labelled('Home')?.disabled).toBe(false);
    vi.mocked(toast.error).mockClear();
    await act(async () => labelled('Home')?.click());
    await act(async () => root?.unmount());
    root = undefined;
    await viewer.reply({ success: false, error: 'failed' });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('uses authenticated DeviceKit pixels and releases their object URL on unmount', async () => {
    const create = vi.fn(() => 'blob:devicekit');
    const revoke = vi.fn();
    const OriginalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends OriginalURL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      }
    );
    const machine = createFakeMachine({ devices: [device({ udid: 'phone' })], preview: READY });
    await renderPanel({ machine, meta: CONTROLS_META });
    const viewer = await connectControlViewer();
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12);
    const bytes = new DataView(png.buffer);
    bytes.setUint32(16, 440);
    bytes.setUint32(20, 900);
    const data = {
      type: 'lody:ios-simulator:exterior',
      operationId: 'op-1',
      geometry: {
        width: 440,
        height: 900,
        screen: { x: 20, y: 20, width: 400, height: 860, radius: 40 },
        buttons: [],
      },
      png: png.buffer,
    };
    const receive = async (source: MessageEventSource | null, payload = data) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', { origin: VIEWER_ORIGIN, source, data: payload })
        );
      });
    await receive(window);
    expect(create).not.toHaveBeenCalled();
    await receive(viewer.frame.contentWindow, { ...data, operationId: 'wrong' });
    expect(create).not.toHaveBeenCalled();
    await receive(viewer.frame.contentWindow);
    expect(container?.querySelector('img')?.getAttribute('src')).toBe('blob:devicekit');
    await act(async () => root?.unmount());
    root = undefined;
    expect(revoke).toHaveBeenCalledWith('blob:devicekit');
    vi.unstubAllGlobals();
  });

  it('disables what the device lacks and says once why a Mac cannot take controls', async () => {
    const machine = createFakeMachine({
      devices: [
        device({
          udid: 'phone',
          name: 'iPhone 15',
          deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          state: 'Booted',
          occupancy: 'this-session',
        }),
      ],
      preview: READY,
    });
    await renderPanel({ machine, meta: CONTROLS_META });
    expect(labelled('Action button')?.disabled).toBe(true);
    expect(labelled('Volume up')?.disabled).toBe(false);
    act(() => root?.unmount());
    container?.remove();

    const old = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: READY,
    });
    await renderPanel({ machine: old, meta: macMeta({ iosSimulator: 1 }) });
    expect(text()).toContain('Update Lody on Studio to use simulator controls');
    expect(labelled('Home')).toBeNull();
    expect(container?.querySelector<HTMLButtonElement>('[data-hardware-button="side"]')).toBeNull();
    expect(
      old.commands.every((command) => command.action === 'list' || command.action === 'status')
    ).toBe(true);
  });

  it('opens a deep link only after it is submitted, and never an executable scheme', async () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: READY,
    });
    await renderPanel({ machine, meta: CONTROLS_META });
    const viewer = await connectControlViewer();
    await pointerClick(labelled('Open URL or deep link…')!);
    const input = await until(
      () => document.body.querySelector<HTMLInputElement>('input[inputmode="url"]'),
      'the URL field'
    );
    const submit = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
        (candidate) => candidate.textContent?.trim() === 'Open'
      )!;

    await typeInto(input, 'javascript:alert(1)');
    await act(async () => submit().click());
    await flush();
    expect(document.body.textContent).toContain('That kind of link can’t be opened');
    expect(
      machine.commands.every((command) => command.action === 'list' || command.action === 'status')
    ).toBe(true);

    await typeInto(input, 'myapp://orders/42');
    await act(async () => submit().click());
    await flush();
    expect(viewer.requests).toEqual([
      expect.objectContaining({
        operationId: 'op-1',
        control: { kind: 'open-url', url: 'myapp://orders/42' },
      }),
    ]);
    await viewer.reply();
    vi.unstubAllGlobals();
  });

  it('attaches a screenshot to the composer without sending, trusting only its own reply', async () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const attached: File[] = [];
    const machine = createFakeMachine({
      devices: [
        device({
          udid: 'phone',
          name: 'iPhone 16 Pro',
          state: 'Booted',
          occupancy: 'this-session',
        }),
      ],
      preview: READY,
    });
    await renderPanel({
      machine,
      meta: CONTROLS_META,
      onAttachScreenshot: (file) => {
        attached.push(file);
        return true;
      },
    });
    const frame = container?.querySelector('iframe') as HTMLIFrameElement;
    const posted: Array<{ type: string; requestId?: string }> = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: {
      type: string;
      requestId?: string;
    }) => posted.push(message)) as never);
    await act(async () => {
      frame.dispatchEvent(new Event('load'));
    });

    await pointerClick(labelled('Screenshot')!);
    await pointerClick(await until(() => menuItem('Attach screenshot to message'), 'the menu'));
    const request = posted.find((message) => message.type === 'lody:ios-simulator:capture');
    expect(request).toMatchObject({ operationId: 'op-1' });

    const png = new Uint8Array(16);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const reply = (requestId: string, source: MessageEventSource | null) =>
      new MessageEvent('message', {
        data: {
          type: 'lody:ios-simulator:capture-result',
          operationId: 'op-1',
          requestId,
          mimeType: 'image/png',
          data: png.buffer,
        },
        origin: VIEWER_ORIGIN,
        source,
      });
    await act(async () => {
      window.dispatchEvent(reply('someone-else', frame.contentWindow));
      window.dispatchEvent(reply(request!.requestId!, window));
    });
    await flush();
    expect(attached).toEqual([]);

    await act(async () => {
      window.dispatchEvent(reply(request!.requestId!, frame.contentWindow));
    });
    await flush();
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ type: 'image/png' });
    expect(attached[0]?.name).toMatch(/^iPhone 16 Pro .+\.png$/);
    // Attaching is not sending: nothing else reached the machine.
    expect(
      machine.commands.every((command) => command.action === 'list' || command.action === 'status')
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('reports a screenshot the viewer never answers instead of waiting forever', async () => {
    // Only timers: the menu still needs real animation frames to open.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: READY,
    });
    await renderPanel({ machine, meta: CONTROLS_META, onAttachScreenshot: () => true });
    const frame = container?.querySelector('iframe') as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((() => {}) as never);
    await act(async () => {
      frame.dispatchEvent(new Event('load'));
    });
    await pointerClick(labelled('Screenshot')!);
    await pointerClick(await until(() => menuItem('Save screenshot'), 'the menu'));
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    await advance(10_000);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'The simulator took too long to take a screenshot.'
    );
    expect(vi.mocked(downloadBytesAsFile)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

it('loads real Kit artwork before preview without a start and releases it on unmount', async () => {
  const OriginalURL = URL;
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends OriginalURL {
      static createObjectURL = () => 'blob:idle-devicekit';
      static revokeObjectURL = revoke;
    }
  );
  try {
    const udid = '5519CB11-71C9-46D9-AEFF-73C96F1104E0';
    const machine = createFakeMachine({ devices: [device({ udid, name: 'iPhone 16' })] });
    await renderPanel({
      machine,
      meta: macMeta({ iosSimulator: 1, iosSimulatorExterior: 1 }),
      localMachine: true,
    });
    expect(container?.querySelector('[data-bezel="on"]')).toBeNull();
    expect(machine.commands).toContainEqual({ action: 'exterior', udid });
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 100);
    view.setUint32(20, 200);
    await machine.answerNext(
      answer({
        exterior: {
          geometry: {
            width: 100,
            height: 200,
            screen: { x: 10, y: 10, width: 80, height: 180, radius: 5 },
            buttons: [],
          },
          pngBase64: btoa(String.fromCharCode(...bytes)),
        },
      })
    );
    expect(container?.querySelector('img')?.getAttribute('src')).toBe('blob:idle-devicekit');
    expect(container?.querySelector('iframe')).toBeNull();
    expect(machine.commands.some((c) => c.action === 'start')).toBe(false);
    await act(async () => root?.unmount());
    root = undefined;
    expect(revoke).toHaveBeenCalledWith('blob:idle-devicekit');
  } finally {
    vi.unstubAllGlobals();
  }
});
