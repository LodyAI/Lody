import { app, safeStorage } from 'electron'
import { Effect } from 'effect'
import { DesktopE2eeCustodyError, makeDesktopE2eeCustody } from './e2ee-custody.mjs'

/** Explicit main composition. No product startup call, feature activation or IPC. */
export const makeElectronE2eeCustody = (directory: string) =>
  Effect.suspend(() => {
    if (!app.isReady()) return Effect.fail(new DesktopE2eeCustodyError({ code: 'unavailable' }))
    return makeDesktopE2eeCustody({ directory, platform: process.platform, safeStorage })
  })
