import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { E2EE_CLIENT_LOSS_PROBE } from '@lody/shared/electron-ipc'
import { assertProductWindowSender } from '../ipc/assert-sender'
import { getIpcServiceDeps } from '../ipc/ipc-service-deps'
import { countDesktopE2eeReaders } from './e2ee-account-runtime'
import { createClientLossObserver, type ClientLossOperation } from './e2ee-client-loss'
import { clientLossProbeEnabled } from './e2ee-client-loss-gate'

export const clientLossObserver = createClientLossObserver({
  enabled: clientLossProbeEnabled(),
  processId: process.pid
})

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Count one E2EE IPC handler call against the live sender and cached account. */
export function observeClientLossOperation<A>(
  kind: ClientLossOperation,
  workspaceId: string,
  senderId: number,
  work: () => Promise<A>
): Promise<A> {
  if (!clientLossObserver.enabled) return work()
  const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId ?? ''
  return clientLossObserver.observe(kind, { accountId, workspaceId, senderId }, work)
}

const scopeFor = (event: IpcMainInvokeEvent | IpcMainEvent, workspaceId: unknown) => {
  assertProductWindowSender(event as IpcMainInvokeEvent)
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId))
    throw new Error('e2ee_invalid-input')
  // Cached identity only: never auth.getSession, token refresh or a reader open.
  const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
  if (!accountId) throw new Error('e2ee_account_unavailable')
  return { accountId, workspaceId, senderId: event.sender.id }
}

/** Registers nothing unless the unpackaged E2E observer is enabled. */
export function registerClientLossProbe(): void {
  if (!clientLossObserver.enabled) return
  ipcMain.handle(E2EE_CLIENT_LOSS_PROBE.inspect, (event, workspaceId: unknown) => {
    try {
      const scope = scopeFor(event, workspaceId)
      return clientLossObserver.inspect(
        scope,
        countDesktopE2eeReaders(scope.accountId, scope.workspaceId, scope.senderId)
      )
    } catch {
      // A fixed failure: no producer exception or cause reaches the IPC logger.
      throw new Error('e2ee_client_loss_unavailable')
    }
  })
  ipcMain.on(E2EE_CLIENT_LOSS_PROBE.effects, (event, payload: unknown) => {
    try {
      if (!payload || typeof payload !== 'object') return
      const { workspaceId, effects } = payload as { workspaceId?: unknown; effects?: unknown }
      clientLossObserver.recordEffects(scopeFor(event, workspaceId), effects)
    } catch {
      // Untrusted or malformed reports are dropped without diagnostics.
    }
  })
}
