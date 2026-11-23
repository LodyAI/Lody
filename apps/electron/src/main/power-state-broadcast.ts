import { powerMonitor } from 'electron'
import { IPC_PUSH_CHANNELS, type ElectronPowerState } from '@lody/shared/electron-ipc'
import { productWindows } from './window-state'

const EVENTS: ElectronPowerState[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen']

/**
 * Forwards OS sleep/lock transitions to every product window. The renderer uses
 * them to withdraw its focused-desktop presence at once, so a sleeping or locked
 * computer stops suppressing mobile pushes without waiting for the presence TTL.
 * `lock-screen`/`unlock-screen` are emitted on macOS and Windows only.
 */
export function installPowerStateBroadcast(): void {
  for (const state of EVENTS) {
    // Electron's typed overloads do not accept a union event name.
    powerMonitor.on(state as 'suspend', () => {
      for (const window of productWindows) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        try {
          window.webContents.send(IPC_PUSH_CHANNELS.appPowerState, state)
        } catch {
          // A closing renderer needs no power hint.
        }
      }
    })
  }
}
