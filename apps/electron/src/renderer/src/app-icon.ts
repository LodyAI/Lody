import type { AppIconBridge } from '@lody/components/components/mobile/mobile-app-icon-settings'
import { getIpcServices } from '@lody/components/lib/electron-ipc-client'
import defaultPreview from '../../../build/icon-mac.padded.png?url'
import aquaPreview from '../../../resources/app-icons/aqua.png?url'

export function installAppIconBridge(): void {
  if (window.__LODY_PLATFORM__?.os !== 'darwin') return
  const ipc = getIpcServices()
  if (!ipc) return
  const host = window as Window & { __LODY_APP_ICON__?: AppIconBridge }
  host.__LODY_APP_ICON__ = {
    icons: [
      { name: 'default', previewUrl: defaultPreview },
      { name: 'aqua', displayName: 'Aqua', previewUrl: aquaPreview }
    ],
    getState: () => ipc.app.getAppIconState(),
    setIcon: ({ name }) => ipc.app.setAppIcon({ name })
  }
}
