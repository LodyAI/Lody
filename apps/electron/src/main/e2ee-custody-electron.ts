import { app, safeStorage } from 'electron'
import { Effect } from 'effect'
import { DesktopE2eeCustodyError, makeDesktopE2eeCustody } from './e2ee-custody.mjs'

/** Readiness-gated native composition; only the narrow bootstrap IPC opens it on demand. */
export const makeElectronE2eeCustody = (directory: string) =>
  Effect.suspend(() => {
    if (!app.isReady()) return Effect.fail(new DesktopE2eeCustodyError({ code: 'unavailable' }))
    return makeDesktopE2eeCustody({ directory, platform: process.platform, safeStorage })
  })
