import { powerMonitor } from 'electron'
import { IPC_PUSH_CHANNELS, type ElectronPowerState } from '@lody/shared/electron-ipc'
import { productWindows } from './window-state'

export const POWER_WAKE_COALESCE_MS = 2_000

export type PowerLifecycleEvent =
  | { readonly kind: 'sleep'; readonly at: number; readonly raw: 'suspend' | 'lock-screen' }
  | {
      readonly kind: 'wake'
      readonly at: number
      readonly sleptAt?: number
      readonly raw: 'resume' | 'unlock-screen'
    }

const EVENTS: ElectronPowerState[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen']
type PowerLifecycleListener = (event: PowerLifecycleEvent) => void
const lifecycleListeners = new Set<PowerLifecycleListener>()
let lastSleepAt: number | undefined
let lastWakeAt: number | undefined

export function subscribePowerLifecycle(listener: PowerLifecycleListener): () => void {
  lifecycleListeners.add(listener)
  return () => {
    lifecycleListeners.delete(listener)
  }
}

/** Emits a coalesced sleep/wake lifecycle event to main-process subscribers.
 * Back-to-back `resume` -> `unlock-screen` transitions within 2s collapse to one wake. */
export function notifyPowerState(state: ElectronPowerState, now = Date.now()): void {
  let event: PowerLifecycleEvent
  if (state === 'suspend' || state === 'lock-screen') {
    lastSleepAt = now
    event = { kind: 'sleep', at: now, raw: state }
  } else {
    if (lastWakeAt !== undefined && now >= lastWakeAt && now - lastWakeAt < POWER_WAKE_COALESCE_MS)
      return
    lastWakeAt = now
    event = {
      kind: 'wake',
      at: now,
      ...(lastSleepAt !== undefined ? { sleptAt: lastSleepAt } : {}),
      raw: state
    }
  }
  for (const listener of [...lifecycleListeners]) {
    try {
      listener(event)
    } catch {
      // One listener failure must not block other power-state handlers or window broadcasts.
    }
  }
}

export function resetPowerLifecycleForTest(): void {
  lastSleepAt = undefined
  lastWakeAt = undefined
  lifecycleListeners.clear()
}

/**
 * Forwards OS sleep/lock transitions to every product window and main-process
 * lifecycle subscribers. Raw states stay intact on `app.powerState` so renderer
 * presence trackers maintain independent suspended/locked flags.
 */
export function installPowerStateBroadcast(): void {
  for (const state of EVENTS) {
    // Electron's typed overloads do not accept a union event name.
    powerMonitor.on(state as 'suspend', () => {
      notifyPowerState(state)
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
