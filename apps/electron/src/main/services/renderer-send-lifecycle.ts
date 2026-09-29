import { runRendererSendExit } from './renderer-send-lifecycle-core'
import { translateAppText as t } from '../menu'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { productWindows } from '../window-state'

type Reply = { ready: boolean; pending: boolean; unsaved?: boolean }
const registered = new Set<number>()
const observed = new WeakSet<BrowserWindow['webContents']>()
const requests = new Map<
  string,
  { senderId: number; phase: 'check' | 'commit'; resolve: (reply: Reply) => void }
>()

export function registerRendererSendLifecycle(window: BrowserWindow): void {
  const id = window.webContents.id
  if (registered.has(id)) return
  registered.add(id)
  if (observed.has(window.webContents)) return
  observed.add(window.webContents)
  const retireDocument = () => {
    registered.delete(id)
    for (const [requestId, request] of requests) {
      if (request.senderId === id) {
        requests.delete(requestId)
        request.resolve({ ready: true, pending: false })
      }
    }
  }
  // A crash or committed main-frame navigation ends this document's ownership
  // without destroying WebContents. The recovery page has no send listener.
  // Timeouts never retire a live document; a new product document registers again.
  window.webContents.on('render-process-gone', retireDocument)
  window.webContents.on('did-navigate', retireDocument)
  window.webContents.once('destroyed', retireDocument)
}

export function resolveRendererSendLifecycle(senderId: number, input: unknown): void {
  if (!input || typeof input !== 'object') throw new Error('Invalid lifecycle response')
  const value = input as {
    requestId?: unknown
    ready?: unknown
    pending?: unknown
    unsaved?: unknown
  }
  if (
    typeof value.requestId !== 'string' ||
    typeof value.ready !== 'boolean' ||
    typeof value.pending !== 'boolean' ||
    (value.unsaved !== undefined && typeof value.unsaved !== 'boolean')
  )
    throw new Error('Invalid lifecycle response')
  const request = requests.get(value.requestId)
  // Timed-out or retired requests may still reply; they cannot grant approval
  // or turn an already handled timeout into a permanent renderer error.
  if (!request) return
  if (request.senderId !== senderId) throw new Error('Lifecycle response owner mismatch')
  requests.delete(value.requestId)
  request.resolve({ ready: value.ready, pending: value.pending, unsaved: value.unsaved })
}

function requestLifecycle(
  window: BrowserWindow,
  phase: 'check' | 'commit',
  reason: 'quit' | 'reload' | 'close'
): Promise<Reply> {
  if (!registered.has(window.webContents.id))
    return Promise.resolve({ ready: true, pending: false })
  const requestId = randomUUID()
  return new Promise((resolve) => {
    // A check may time out conservatively. Cleanup itself must join raw IPC,
    // so the commit phase cannot pretend that elapsed time released ownership.
    const timer =
      phase === 'check'
        ? setTimeout(() => {
            requests.delete(requestId)
            resolve({ ready: false, pending: true })
          }, 5000)
        : undefined
    requests.set(requestId, {
      senderId: window.webContents.id,
      phase,
      resolve: (reply) => {
        clearTimeout(timer)
        resolve(reply)
      }
    })
    try {
      window.webContents.send(IPC_PUSH_CHANNELS.appSendLifecycle, { requestId, phase, reason })
    } catch {
      requests.delete(requestId)
      clearTimeout(timer)
      resolve({ ready: false, pending: true })
    }
  })
}

/** Approve first, then drain every renderer before main destroys transports or CLI. */
export async function prepareRendererSendsForExit(
  reason: 'quit' | 'reload' | 'close',
  target?: BrowserWindow
): Promise<boolean> {
  const windows = (target ? [target] : [...productWindows]).filter(
    (window) => !window.isDestroyed()
  )
  return runRendererSendExit(windows, {
    check: (window) => requestLifecycle(window, 'check', reason),
    unavailable: async (unsaved) => {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Lody',
        message: t(
          unsaved ? 'sessions.unsavedEditorExitBlocked' : 'sessions.pendingSendExitUnavailable'
        ),
        buttons: [t('sessions.stayWithPendingSends')],
        defaultId: 0,
        cancelId: 0
      })
    },
    confirm: async () => {
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: 'Lody',
        message: t('sessions.pendingSendExitTitle'),
        detail: t('sessions.pendingSendRetainedExit'),
        buttons: [
          t('sessions.stayWithPendingSends'),
          t(
            reason === 'quit'
              ? 'sessions.pendingSendQuit'
              : reason === 'close'
                ? 'sessions.pendingSendClose'
                : 'sessions.pendingSendReload'
          )
        ],
        defaultId: 0,
        cancelId: 0
      })
      return confirmation.response === 1
    },
    drain: (window) => requestLifecycle(window, 'commit', reason)
  })
}

/** Re-enter native close once after drain; never skip unrelated beforeunload guards. */
export function guardRendererSendClose(window: BrowserWindow, shouldGuard: () => boolean): void {
  let draining = false
  let closing = false
  window.on('close', (event) => {
    if (closing || !shouldGuard()) return
    event.preventDefault()
    if (draining) return
    draining = true
    void prepareRendererSendsForExit('close', window)
      .then((allowed) => {
        if (!allowed || window.isDestroyed()) return
        closing = true
        try {
          window.close()
        } finally {
          closing = false
        }
      })
      .catch((error: unknown) => console.error('[Electron] Window close cleanup failed', error))
      .finally(() => {
        draining = false
      })
  })
}
