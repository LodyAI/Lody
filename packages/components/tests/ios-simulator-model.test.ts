// @vitest-environment jsdom

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { IosSimulatorDevice, IosSimulatorResponse } from '@lody/shared';
import {
  buildIosSimulatorDiagnostics,
  getIosSimulatorDeviceAction,
  getIosSimulatorPanelAvailability,
  parseIosSimulatorViewerState,
  readIosSimulatorSelectedDevice,
  redactIosSimulatorText,
  resolveIosSimulatorSelection,
  toIosSimulatorCatalog,
  toIosSimulatorDeviceEntry,
  toIosSimulatorPanelStatus,
  writeIosSimulatorSelectedDevice,
} from '../src/lib/ios-simulator/ios-simulator-model';
import type { IosSimulatorPanelStatus } from '../src/lib/ios-simulator/ios-simulator-types';

const IOS_18 = 'com.apple.CoreSimulator.SimRuntime.iOS-18-2';
const IOS_17 = 'com.apple.CoreSimulator.SimRuntime.iOS-17-5';
const WATCH_11 = 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0';

const device = (overrides: Partial<IosSimulatorDevice> & { udid: string }): IosSimulatorDevice => ({
  name: overrides.udid,
  runtime: IOS_18,
  deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  state: 'Shutdown',
  available: true,
  occupancy: 'available',
  ...overrides,
});

const wireDevices: IosSimulatorDevice[] = [
  device({ udid: 'ipad', name: 'iPad Air', deviceType: 'iPad Air (M2)' }),
  device({ udid: 'pro-10', name: 'iPhone 10 Pro' }),
  device({ udid: 'pro-9', name: 'iPhone 9 Pro' }),
  device({ udid: 'old', name: 'iPhone 15', runtime: IOS_17, state: 'Booted' }),
  device({
    udid: 'watch',
    name: 'Apple Watch Ultra',
    runtime: WATCH_11,
    deviceType: 'Apple Watch',
  }),
  device({ udid: 'custom', name: 'iPhone SE', runtime: 'Custom Runtime' }),
];
const catalog = toIosSimulatorCatalog(wireDevices);
const entries = catalog.devices;
const IDLE: IosSimulatorPanelStatus = { phase: 'idle' };
const APP_ORIGIN = 'http://localhost:3000';

describe('iOS Simulator availability', () => {
  it('offers the tab only when the target machine is a Mac', () => {
    expect(getIosSimulatorPanelAvailability(null)).toBe('hidden');
    expect(
      getIosSimulatorPanelAvailability({ os: 'linux', protocolCapabilities: { iosSimulator: 1 } })
    ).toBe('hidden');
  });

  it('keeps the tab on an old Mac so it can ask for an update', () => {
    expect(getIosSimulatorPanelAvailability({ os: 'darwin' })).toBe('upgrade-required');
    expect(
      getIosSimulatorPanelAvailability({ os: 'darwin', protocolCapabilities: { iosSimulator: 1 } })
    ).toBe('available');
  });
});

describe('toIosSimulatorPanelStatus', () => {
  const response = (overrides: Partial<IosSimulatorResponse>): IosSimulatorResponse => ({
    type: 'ios-simulator/control_response',
    sessionId: 's',
    success: true,
    ...overrides,
  });

  it('keeps a ready viewer only on a distinct http(s) origin', () => {
    const ready = (viewerUrl?: string) =>
      toIosSimulatorPanelStatus(
        response({
          preview: { operationId: 'op', udid: 'a', phase: 'ready', transport: 'local', viewerUrl },
        }),
        { appOrigin: APP_ORIGIN }
      );
    expect(ready('http://127.0.0.1:61234/viewer?cap=x')).toMatchObject({
      phase: 'ready',
      viewerOrigin: 'http://127.0.0.1:61234',
      transport: 'local',
    });
    expect(ready(`${APP_ORIGIN}/viewer`)).toMatchObject({ phase: 'failed' });
    expect(ready('javascript:alert(1)')).toMatchObject({ phase: 'failed' });
    expect(ready(undefined)).toMatchObject({ phase: 'failed' });
  });
});

describe('getIosSimulatorDeviceAction', () => {
  const entry = (overrides: Partial<IosSimulatorDevice>) =>
    toIosSimulatorDeviceEntry(device({ udid: 'a', ...overrides }));

  it('never offers a takeover of a device another Session controls', () => {
    expect(
      getIosSimulatorDeviceAction(entry({ state: 'Booted', occupancy: 'other-session' }), IDLE)
    ).toEqual({ kind: 'occupied' });
  });

  it('reports the Session’s own preparing or ready preview as current', () => {
    const own = entry({ state: 'Booted', occupancy: 'this-session' });
    expect(
      getIosSimulatorDeviceAction(own, { phase: 'preparing', udid: 'a', stage: 'connecting' })
    ).toEqual({ kind: 'current' });
    expect(
      getIosSimulatorDeviceAction(own, {
        phase: 'closed',
        udid: 'a',
        operationId: 'op',
        transport: 'remote',
      })
    ).toEqual({ kind: 'preview' });
  });
});

describe('resolveIosSimulatorSelection', () => {
  const ready: IosSimulatorPanelStatus = {
    phase: 'ready',
    udid: 'pro-9',
    operationId: 'op',
    viewerUrl: 'http://x',
    viewerOrigin: 'http://x',
    transport: 'local',
  };

  it('puts a choice made in the panel above the live preview', () => {
    expect(resolveIosSimulatorSelection(entries, { chosenUdid: 'ipad', status: ready })).toBe(
      'ipad'
    );
  });

  it('puts the live preview above the remembered device', () => {
    expect(resolveIosSimulatorSelection(entries, { preferredUdid: 'ipad', status: ready })).toBe(
      'pro-9'
    );
    expect(resolveIosSimulatorSelection(entries, { preferredUdid: 'ipad', status: IDLE })).toBe(
      'ipad'
    );
  });

  it('falls back to a held, then booted, then free device and ignores unknown ids', () => {
    const held = [
      ...entries,
      toIosSimulatorDeviceEntry(device({ udid: 'held', occupancy: 'this-session' })),
    ];
    expect(resolveIosSimulatorSelection(held, { preferredUdid: 'gone', status: IDLE })).toBe(
      'held'
    );
    expect(resolveIosSimulatorSelection(entries, { status: IDLE })).toBe('old');
    expect(resolveIosSimulatorSelection([], { status: IDLE })).toBeNull();
  });
});

describe('viewer handshake', () => {
  it('accepts only a known state for the exact operation', () => {
    const message = { type: 'lody:ios-simulator:state', operationId: 'op', state: 'ready' };
    expect(parseIosSimulatorViewerState(message, 'op')).toBe('ready');
    expect(parseIosSimulatorViewerState(message, 'other-op')).toBeNull();
    expect(parseIosSimulatorViewerState({ ...message, state: 'hacked' }, 'op')).toBeNull();
    expect(parseIosSimulatorViewerState({ ...message, type: 'x' }, 'op')).toBeNull();
    expect(parseIosSimulatorViewerState('ready', 'op')).toBeNull();
  });
});

describe('selected-device preference', () => {
  afterEach(() => window.localStorage.clear());

  it('is scoped to workspace, machine and Session', () => {
    const scope = { workspaceId: 'w1', machineId: 'm1', sessionId: 's1' };
    writeIosSimulatorSelectedDevice(scope, 'pro-9');
    expect(readIosSimulatorSelectedDevice(scope)).toBe('pro-9');
    expect(readIosSimulatorSelectedDevice({ ...scope, workspaceId: 'w2' })).toBeNull();
    expect(readIosSimulatorSelectedDevice({ ...scope, machineId: 'm2' })).toBeNull();
    expect(readIosSimulatorSelectedDevice({ ...scope, sessionId: 's2' })).toBeNull();
  });
});

describe('diagnostics', () => {
  it('redacts URLs, secrets, ids and home directories', () => {
    expect(
      redactIosSimulatorText(
        'GET https://abc.trycloudflare.com/view?token=s3cret failed token=abc123 for 0A1B2C3D-1111-2222-3333-444455556666 at /Users/alice/Library aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).toBe('GET <url> failed token=<redacted> for <id> at /Users/<user>/Library <redacted>');
  });

  it('never carries the viewer URL of a ready preview', () => {
    const text = buildIosSimulatorDiagnostics({
      now: new Date('2026-09-27T00:00:00.000Z'),
      machine: { os: 'darwin', cliVersion: '1.2.3', online: 'online', local: false },
      availability: 'available',
      status: {
        phase: 'ready',
        udid: 'pro-9',
        operationId: 'op',
        viewerUrl: 'https://secret-tunnel.example/viewer?capability=xyz',
        viewerOrigin: 'https://secret-tunnel.example',
        transport: 'remote',
      },
      viewerState: 'disconnected',
      device: entries[2],
      runtime: catalog.runtimes[0],
      catalog: { phase: 'ready', deviceCount: entries.length },
    });
    expect(text).toContain('preview: ready transport=remote viewer=disconnected');
    expect(text).toContain('device: iPhone 9 Pro');
    expect(text).not.toContain('secret-tunnel');
    expect(text).not.toContain('capability');
  });
});
