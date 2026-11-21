import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AppIconBridge } from '@lody/components/components/mobile/mobile-app-icon-settings';
import defaultPreview from './assets/app-icon-default.png';
import bluePreview from './assets/app-icon-blue.png';

const appIcon = registerPlugin<Pick<AppIconBridge, 'getState' | 'setIcon'>>('LodyAppIcon');

export function initAppIconBridge(): void {
  if (Capacitor.getPlatform() !== 'ios') return;
  window.__LODY_APP_ICON__ = {
    icons: [
      { name: 'default', previewUrl: defaultPreview },
      { name: 'AppIconBlue', displayName: 'Aqua', previewUrl: bluePreview },
    ],
    getState: () => appIcon.getState(),
    setIcon: (options) => appIcon.setIcon(options),
  };
}
