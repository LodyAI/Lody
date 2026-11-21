import { Capacitor, registerPlugin } from '@capacitor/core';
import { makeMobilePasskeyPort, type MobilePasskeyBridge } from './passkey';

/** Native iOS plugin availability includes its signing/build opt-in and OS guard. */
export function nativePasskeyPort(input: {
  readonly enabled?: boolean;
  readonly cancelled?: () => Error;
}) {
  if (
    input.enabled !== true ||
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== 'ios' ||
    !Capacitor.isPluginAvailable('LodyPasskey')
  )
    return undefined;
  return makeMobilePasskeyPort({
    ...input,
    bridge: registerPlugin<MobilePasskeyBridge>('LodyPasskey'),
  });
}
