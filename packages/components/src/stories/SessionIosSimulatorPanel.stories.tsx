import type { Meta, StoryObj } from '@storybook/react-vite';
import type { IosSimulatorDevice } from '@lody/shared';
import { fn } from 'storybook/test';
import {
  IosSimulatorPanelView,
  type IosSimulatorPanelViewProps,
} from '@/components/sessions/ios-simulator/ios-simulator-panel-view';
import { toIosSimulatorCatalog } from '@/lib/ios-simulator/ios-simulator-model';
import {
  getIosSimulatorControlAvailability,
  getIosSimulatorHardware,
} from '@/lib/ios-simulator/ios-simulator-hardware';

const IOS_18 = 'com.apple.CoreSimulator.SimRuntime.iOS-18-2';
const IOS_17 = 'com.apple.CoreSimulator.SimRuntime.iOS-17-5';
const WATCH_11 = 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2';

const devices: IosSimulatorDevice[] = [
  {
    udid: 'iphone-16-pro',
    name: 'iPhone 16 Pro',
    runtime: IOS_18,
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    state: 'Booted',
    available: true,
    occupancy: 'available',
  },
  {
    udid: 'iphone-16',
    name: 'iPhone 16',
    runtime: IOS_18,
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    state: 'Shutdown',
    available: true,
    occupancy: 'available',
  },
  {
    udid: 'ipad-pro',
    name: 'iPad Pro 13-inch (M4)',
    runtime: IOS_18,
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4',
    state: 'Booted',
    available: true,
    occupancy: 'other-session',
  },
  {
    udid: 'iphone-15',
    name: 'iPhone 15',
    runtime: IOS_17,
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
    state: 'Shutdown',
    available: false,
    unavailableReason: 'The iOS 17.5 runtime is not installed.',
    occupancy: 'available',
  },
  {
    udid: 'watch-ultra',
    name: 'Apple Watch Ultra 2 (49mm)',
    runtime: WATCH_11,
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm',
    state: 'Shutdown',
    available: true,
    occupancy: 'available',
  },
];

/** A stand-in for the machine's viewer page: the real one streams the screen. */
const SAMPLE_VIEWER_URL = `data:text/html,${encodeURIComponent(
  '<body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(160deg,#1c3d7a,#6a2c70);color:#fff;font:600 17px -apple-system,system-ui">9:41</body>'
)}`;

const ready = (transport: 'local' | 'remote') =>
  ({
    phase: 'ready',
    udid: 'iphone-16-pro',
    operationId: 'op-1',
    viewerUrl: SAMPLE_VIEWER_URL,
    // A `data:` stand-in has an opaque origin, so the story greets it with '*'.
    viewerOrigin: '*',
    transport,
  }) as const;

const controls: NonNullable<IosSimulatorPanelViewProps['controls']> = {
  controlsSupported: true,
  unsupportedHint: 'Update Lody on Studio to use simulator controls',
  availability: getIosSimulatorControlAvailability(
    getIosSimulatorHardware('iphone', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', '')
  ),
  canAttach: true,
  viewMode: 'device',
  fullscreen: false,
  canFullscreen: true,
  onControl: fn(),
  onTypeText: fn(),
  onOpenUrl: fn(),
  onScreenshot: fn(),
  onViewModeChange: fn(),
  onToggleFullscreen: fn(),
};

const baseArgs: IosSimulatorPanelViewProps = {
  machineName: 'Studio',
  blocker: null,
  catalog: { phase: 'ready', ...toIosSimulatorCatalog(devices) },
  selectedUdid: 'iphone-16-pro',
  status: { phase: 'idle' },
  onSelectDevice: fn(),
  onPickerOpenChange: fn(),
  onRefresh: fn(),
  onStart: fn(),
  onCancel: fn(),
  onStop: fn(),
  onRestore: fn(),
  onRetry: fn(),
  onCopyDiagnostics: fn(),
  onViewerStateChange: fn(),
};

const meta = {
  title: 'Sessions/iOS Simulator/Panel',
  component: IosSimulatorPanelView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[460px] border-l border-border bg-background">
        <Story />
      </div>
    ),
  ],
  args: baseArgs,
} satisfies Meta<typeof IosSimulatorPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyToPreview: Story = {};

export const StartAndPreview: Story = { args: { selectedUdid: 'iphone-16' } };

export const Preparing: Story = {
  args: {
    selectedUdid: 'iphone-16',
    bootExpected: true,
    status: { phase: 'preparing', udid: 'iphone-16', operationId: 'op-2', stage: 'booting' },
  },
};

export const PreviewingLocal: Story = {
  args: { status: ready('local'), viewerState: 'ready', controls },
};

export const PreviewingRemote: Story = {
  args: { status: ready('remote'), viewerState: 'ready', controls },
};

/** A wide panel keeps every control on the second row. */
export const WideControls: Story = {
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[680px] border-l border-border bg-background">
        <Story />
      </div>
    ),
  ],
  args: { status: ready('local'), viewerState: 'ready', controls },
};

/** The bare screen, as large as the panel allows. */
export const ScreenOnly: Story = {
  args: {
    status: ready('local'),
    viewerState: 'ready',
    controls: { ...controls, viewMode: 'screen' },
  },
};

/** A Mac whose Lody predates native controls still previews; the row says why it is quiet. */
export const ControlsNeedUpdate: Story = {
  args: {
    status: ready('local'),
    viewerState: 'ready',
    controls: { ...controls, controlsSupported: false },
  },
};

/** Mobile: every control lives in one More menu beside the status. */
export const MobileControlsMenu: Story = {
  args: { status: ready('remote'), viewerState: 'ready', controls, controlsLayout: 'menu' },
};

export const ViewerDisconnected: Story = {
  args: { status: ready('remote'), viewerState: 'disconnected' },
};

/** Another device is chosen while this Session previews one: switching ends that preview. */
export const SwitchingDevices: Story = {
  args: { selectedUdid: 'iphone-16', status: ready('remote') },
};

export const OccupiedByAnotherSession: Story = { args: { selectedUdid: 'ipad-pro' } };

export const UnavailableDevice: Story = { args: { selectedUdid: 'iphone-15' } };

export const Closed: Story = {
  args: {
    status: { phase: 'closed', udid: 'iphone-16-pro', operationId: 'op-1', transport: 'remote' },
  },
};

export const Failed: Story = {
  args: {
    status: {
      phase: 'failed',
      udid: 'iphone-16-pro',
      operationId: 'op-1',
      error: { code: 'failed', message: 'simctl io exited with status 1' },
    },
  },
};

export const TimedOut: Story = {
  args: {
    status: {
      phase: 'failed',
      udid: 'iphone-16-pro',
      operationId: 'op-1',
      error: { code: 'timeout' },
    },
  },
};

export const LoadingCatalog: Story = {
  args: { catalog: { phase: 'loading' }, selectedUdid: null },
};

export const XcodeMissing: Story = {
  args: {
    selectedUdid: null,
    catalog: {
      phase: 'error',
      error: { code: 'environment', message: 'xcrun: error: unable to find utility "simctl"' },
    },
  },
};

export const NoSimulators: Story = {
  args: { selectedUdid: null, catalog: { phase: 'ready', runtimes: [], devices: [] } },
};

export const MachineOffline: Story = {
  args: { blocker: 'offline', catalog: { phase: 'loading' }, selectedUdid: null },
};

export const UpdateLodyOnMac: Story = {
  args: { blocker: 'upgrade-required', catalog: { phase: 'loading' }, selectedUdid: null },
};

/** The narrowest side panel: the status word gives way, the device name truncates. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[300px] border-l border-border bg-background">
        <Story />
      </div>
    ),
  ],
  args: { status: ready('local'), viewerState: 'ready', controls },
};

export const PerformanceDiagnostics: Story = {
  args: {
    status: ready('remote'),
    viewerState: 'ready',
    controls,
    readPerformance: () => ({
      ageMs: 50,
      samples: [],
      latest: {
        connected: true,
        remote: true,
        width: 589,
        height: 1278,
        paintedFps: 29.4,
        receivedMbps: 4.2,
        rttMs: 120,
        ackMs: 145,
        inFlightFrames: 4,
      },
    }),
  },
};
