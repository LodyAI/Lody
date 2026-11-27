import { isIOSRuntimeEnvironment, isNativeAppShell } from '@/lib/native-platform';

export type PairingDeviceEnvironment = {
  readonly electron: boolean;
  readonly nativeShell: boolean;
  readonly ios: boolean;
};

/** The requester's own, unverified label an approving device shows for this device. */
export function pairingDeviceName(environment: PairingDeviceEnvironment): string {
  if (environment.electron) return 'Lody desktop';
  if (environment.nativeShell) return environment.ios ? 'Lody iOS' : 'Lody Android';
  return 'Lody Web';
}

export const currentPairingDeviceName = (electron: boolean) =>
  pairingDeviceName({ electron, nativeShell: isNativeAppShell(), ios: isIOSRuntimeEnvironment() });
