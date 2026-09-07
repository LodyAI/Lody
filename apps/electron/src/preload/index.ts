import { contextBridge } from 'electron'
import { ipcBridge } from './ipc-bridge'
import { electronAPI } from '@electron-toolkit/preload'
import { setupRenderer } from '@better-auth/electron/preload'
import os from 'node:os'
import { readPreferredSystemLanguagesArgument } from '../system-language-argument'

setupRenderer()

const platformInfo = {
  os: process.platform,
  homeDir: os.homedir(),
  machineName: os.hostname(),
  preferredSystemLanguages: readPreferredSystemLanguagesArgument(process.argv)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('__LODY_ELECTRON__', true)
    contextBridge.exposeInMainWorld('__LODY_PLATFORM__', platformInfo)
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('ipc', ipcBridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.__LODY_ELECTRON__ = true
  // @ts-ignore (define in dts)
  window.__LODY_PLATFORM__ = platformInfo
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.ipc = ipcBridge
}
