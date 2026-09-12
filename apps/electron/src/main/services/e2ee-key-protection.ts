import { app, safeStorage } from 'electron'
import {
  createLocalEpochProtection,
  createLocalDeviceProtection,
  createLocalUserProtection
} from './e2ee-key-protection-core'

/** Opt-in only; no IPC exposure or automatic keyring creation. */
function runtime() {
  // Remember the unsafe mode at construction, even if the environment is later cleared.
  const plaintextAtCreation = process.env.LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE === '1'
  return {
    safeStorage,
    platform: process.platform,
    isReady: () => app.isReady(),
    isPlaintextAuthEnabled: () =>
      plaintextAtCreation || process.env.LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE === '1'
  }
}

export function createElectronEpochProtection() {
  return createLocalEpochProtection(runtime())
}
export function createElectronDeviceProtection() {
  return createLocalDeviceProtection(runtime())
}
export function createElectronUserProtection() {
  return createLocalUserProtection(runtime())
}
