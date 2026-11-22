import { Capacitor, registerPlugin } from '@capacitor/core';
import type { NativeKekBridge } from './native-custody';

/** Registers a narrow proxy only. Native v1 replies are checked by nativeCustody. */
export function nativeKekBridge(): NativeKekBridge | undefined {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LodyKek')) return undefined;
  return registerPlugin<NativeKekBridge>('LodyKek');
}
