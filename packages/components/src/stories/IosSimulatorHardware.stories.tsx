import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { IosSimulatorDeviceFrame } from '@/components/sessions/ios-simulator/ios-simulator-device-frame';
import {
  getIosSimulatorHardware,
  type IosSimulatorQuarterTurns,
} from '@/lib/ios-simulator/ios-simulator-hardware';
import type { IosSimulatorDeviceFamily } from '@/lib/ios-simulator/ios-simulator-types';

/** Stands in for the streamed pixels, which carry their own island and indicator. */
function Screen() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'linear-gradient(160deg,#1c3d7a,#6a2c70)',
      }}
    />
  );
}

type DeviceArgs = {
  family: IosSimulatorDeviceFamily;
  deviceType: string;
  name: string;
  /** Width / height of the stream as shown. */
  screenAspect: number;
  turns: IosSimulatorQuarterTurns;
  bezel: boolean;
};

function Device({ family, deviceType, name, screenAspect, turns, bezel }: DeviceArgs) {
  return (
    <div style={{ height: 560, width: 420, display: 'flex' }}>
      <IosSimulatorDeviceFrame
        hardware={getIosSimulatorHardware(family, deviceType, name)}
        screenAspect={screenAspect}
        turns={turns}
        bezel={bezel}
        onPress={fn()}
        buttonLabel={(button) => button.id}
      >
        <Screen />
      </IosSimulatorDeviceFrame>
    </div>
  );
}

const meta = {
  title: 'Sessions/iOS Simulator/Hardware',
  component: Device,
  args: {
    family: 'iphone',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    name: 'iPhone 16 Pro',
    screenAspect: 1206 / 2622,
    turns: 0,
    bezel: true,
  },
} satisfies Meta<typeof Device>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Action button, volume and side button; the island is the stream's own. */
export const IPhoneWithActionButton: Story = {};

export const IPhoneWithoutActionButton: Story = {
  args: { deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', name: 'iPhone 15' },
};

/** The Home button sits in the glass below the screen and presses Home. */
export const IPhoneWithHomeButton: Story = {
  args: {
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
    name: 'iPhone SE (3rd generation)',
    screenAspect: 750 / 1334,
  },
};

/** Turned left: the stream is landscape, the exterior turns around it. */
export const IPhoneLandscapeLeft: Story = { args: { screenAspect: 2622 / 1206, turns: 3 } };

export const IPhoneLandscapeRight: Story = { args: { screenAspect: 2622 / 1206, turns: 1 } };

export const IPad: Story = {
  args: {
    family: 'ipad',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4',
    name: 'iPad Pro 11-inch (M4)',
    screenAspect: 1668 / 2420,
  },
};

export const IPadWithHomeButton: Story = {
  args: {
    family: 'ipad',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-9th-generation',
    name: 'iPad (9th generation)',
    screenAspect: 1620 / 2160,
  },
};

export const AppleWatchUltra: Story = {
  args: {
    family: 'watch',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm',
    name: 'Apple Watch Ultra 2 (49mm)',
    screenAspect: 410 / 502,
  },
};

export const ScreenOnly: Story = { args: { bezel: false } };
