import { statfs } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { getDesktopLog } from '../desktop-log'
import { mainPlatformKind } from '../platform'
import { quitAndRelaunch } from '../relaunch-intent'
import { createStorageGuard, type StorageGuard } from './storage-guard'

export function createElectronStorageGuard(): StorageGuard {
  return createStorageGuard({
    // The renderer's IndexedDB lives in the profile; the CLI's repo.sqlite3 in
    // the Lody data dir. They can sit on different volumes.
    dataDirs: [app.getPath('userData'), getLodyDataDir(mainPlatformKind)],
    readVolume: async (dir) => {
      const stats = await statfs(dir)
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
    },
    broadcast: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(IPC_PUSH_CHANNELS.storageGuardState, state)
      }
    },
    quitAndRelaunch,
    quit: () => app.quit(),
    log: (level, message) => getDesktopLog()[level]('storage-guard', message)
  })
}
