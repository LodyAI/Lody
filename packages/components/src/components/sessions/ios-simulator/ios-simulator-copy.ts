import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getIosSimulatorDeviceAction } from '@/lib/ios-simulator/ios-simulator-model';
import type { IosSimulatorHardwareButton } from '@/lib/ios-simulator/ios-simulator-hardware';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorError,
  IosSimulatorPanelStatus,
  IosSimulatorPreparingStage,
} from '@/lib/ios-simulator/ios-simulator-types';

export type IosSimulatorStateLabel = {
  label: string;
  /** `live`: this Session's preview. `blocked`: nothing can be started on it here. */
  tone: 'rest' | 'live' | 'blocked';
};

/** One word for a device's condition, as the picker row and the stage both say it. */
export function useIosSimulatorDeviceStateLabel() {
  const { t } = useTranslation();
  return useCallback(
    (device: IosSimulatorDeviceEntry, status: IosSimulatorPanelStatus): IosSimulatorStateLabel => {
      const action = getIosSimulatorDeviceAction(device, status);
      switch (action.kind) {
        case 'current':
          return {
            label: t('sessions.iosSimulator.state.previewing', 'Previewing'),
            tone: 'live',
          };
        case 'occupied':
          return { label: t('sessions.iosSimulator.state.inUse', 'In use'), tone: 'blocked' };
        case 'unavailable':
          return {
            label: t('sessions.iosSimulator.state.unavailable', 'Unavailable'),
            tone: 'blocked',
          };
        case 'settling':
          return {
            label: t('sessions.iosSimulator.state.shuttingDown', 'Shutting down…'),
            tone: 'rest',
          };
        default:
          break;
      }
      if (device.state === 'booted') {
        return { label: t('sessions.iosSimulator.state.booted', 'Booted'), tone: 'rest' };
      }
      if (device.state === 'booting') {
        return { label: t('sessions.iosSimulator.state.booting', 'Booting…'), tone: 'rest' };
      }
      return { label: t('sessions.iosSimulator.state.shutdown', 'Shut down'), tone: 'rest' };
    },
    [t]
  );
}

/** The machine reports these in order; booting is skipped for a device already booted. */
export const IOS_SIMULATOR_PREPARING_STAGES: readonly IosSimulatorPreparingStage[] = [
  'preparing',
  'booting',
  'connecting',
];

export function useIosSimulatorStageLabel() {
  const { t } = useTranslation();
  return useCallback(
    (stage: IosSimulatorPreparingStage): string => {
      switch (stage) {
        case 'booting':
          return t('sessions.iosSimulator.stage.bootingDevice', 'Starting the simulator');
        case 'connecting':
          return t('sessions.iosSimulator.stage.connecting', 'Connecting the viewer');
        default:
          return t('sessions.iosSimulator.stage.preparing', 'Preparing the preview');
      }
    },
    [t]
  );
}

export type IosSimulatorErrorCopy = { title: string; detail: string };

/** What went wrong, and what the person can do about it. The raw message stays below. */
export function useIosSimulatorErrorCopy() {
  const { t } = useTranslation();
  return useCallback(
    (error: IosSimulatorError, machineName: string): IosSimulatorErrorCopy => {
      switch (error.code) {
        case 'environment':
          return {
            title: t(
              'sessions.iosSimulator.error.xcodeMissing',
              'Xcode isn’t set up on {{machine}}',
              { machine: machineName }
            ),
            detail: t(
              'sessions.iosSimulator.error.xcodeMissingDetail',
              'Install Xcode and an iOS Simulator runtime on that Mac, open Xcode once to finish setup, then refresh.'
            ),
          };
        case 'occupied':
          return {
            title: t('sessions.iosSimulator.error.occupied', 'Another session took this simulator'),
            detail: t(
              'sessions.iosSimulator.error.occupiedDetail',
              'One session controls a simulator at a time. Choose another simulator, or stop the preview in the session using it.'
            ),
          };
        case 'unavailable':
          return {
            title: t('sessions.iosSimulator.error.unavailable', 'This simulator isn’t available'),
            detail: t(
              'sessions.iosSimulator.error.unavailableDetail',
              'It may have been deleted, or its runtime is missing. Refresh the list or choose another simulator.'
            ),
          };
        case 'timeout':
          return {
            title: t('sessions.iosSimulator.error.timeout', 'The preview took too long to start'),
            detail: t(
              'sessions.iosSimulator.error.timeoutDetail',
              'The Mac may still be starting the simulator. Try again, or stop the preview.'
            ),
          };
        case 'unsupported':
          return {
            title: t('sessions.iosSimulator.error.unsupported', 'Update Lody on {{machine}}', {
              machine: machineName,
            }),
            detail: t(
              'sessions.iosSimulator.error.unsupportedDetail',
              'This version of Lody on that Mac can’t stream simulators yet.'
            ),
          };
        case 'denied':
          return {
            title: t(
              'sessions.iosSimulator.error.unauthorized',
              'You can’t control simulators here'
            ),
            detail: t(
              'sessions.iosSimulator.error.unauthorizedDetail',
              'Only people allowed to run this session can preview its Mac’s simulators.'
            ),
          };
        default:
          return {
            title: t('sessions.iosSimulator.error.generic', 'The preview stopped with an error'),
            detail: t(
              'sessions.iosSimulator.error.genericDetail',
              'Try again, or copy the diagnostics for a bug report.'
            ),
          };
      }
    },
    [t]
  );
}

/** What a button on the device's exterior is, and what pressing it does. */
export function useIosSimulatorButtonLabel() {
  const { t } = useTranslation();
  return useCallback(
    (button: IosSimulatorHardwareButton): string => {
      switch (button.id) {
        case 'home':
          return t('sessions.iosSimulator.hardware.home', 'Home button');
        case 'crown':
          return t('sessions.iosSimulator.hardware.crown', 'Digital Crown — Home');
        case 'action':
          return t('sessions.iosSimulator.hardware.action', 'Action button');
        case 'volume-up':
          return t('sessions.iosSimulator.hardware.volumeUp', 'Volume up');
        case 'volume-down':
          return t('sessions.iosSimulator.hardware.volumeDown', 'Volume down');
        case 'top':
          return t('sessions.iosSimulator.hardware.top', 'Top button — Lock');
        default:
          return t('sessions.iosSimulator.hardware.side', 'Side button — Lock');
      }
    },
    [t]
  );
}
