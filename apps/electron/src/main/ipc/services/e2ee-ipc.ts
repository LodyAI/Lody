import { Effect } from 'effect'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { E2eeWorkspaceRuntime } from '@lody/platform'
import { isLocalPlatform } from '../../platform'
import {
  validateDesktopE2eeCreationIntent,
  type DesktopE2eeCreationIntent
} from '../../services/e2ee-bootstrap.mjs'
import {
  releaseDesktopE2eeReader,
  withDesktopE2eeAccount
} from '../../services/e2ee-account-runtime'
import { assertProductWindowSender } from '../assert-sender'

const observedSenders = new WeakSet<Electron.WebContents>()
function sender() {
  const { event } = getIpcContext()
  assertProductWindowSender(event)
  if (isLocalPlatform()) throw new Error('e2ee_unavailable')
  if (!observedSenders.has(event.sender)) {
    observedSenders.add(event.sender)
    const id = event.sender.id
    event.sender.once('destroyed', () => releaseDesktopE2eeReader(id))
    event.sender.on('render-process-gone', () => releaseDesktopE2eeReader(id))
    event.sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) releaseDesktopE2eeReader(id)
    })
  }
  return event.sender.id
}
/** Explicit operations only: no arbitrary signing, secret export or unbound identity generation. */
export class E2eeIpc extends IpcService {
  static override readonly groupName = 'e2ee'
  @IpcMethod()
  async prepareCreation(payload: DesktopE2eeCreationIntent) {
    sender()
    validateDesktopE2eeCreationIntent(payload)
    const input = { ...payload }
    return withDesktopE2eeAccount((owner) =>
      owner.accountId === input.accountId
        ? owner.bootstrap.prepareCreation(input)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  }
  @IpcMethod()
  async recordCreated(input: Parameters<E2eeWorkspaceRuntime['recordCreated']>[0]) {
    sender()
    const captured = { ...input }
    return withDesktopE2eeAccount((owner) => owner.bootstrap.recordCreated(captured))
  }
  @IpcMethod()
  async open(workspaceId: string, observed?: Parameters<E2eeWorkspaceRuntime['open']>[1]) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        const status = yield* owner.host.open(workspaceId, observed)
        const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
        readers.set(id, (readers.get(id) ?? 0) + 1)
        owner.readers.set(workspaceId, readers)
        return status
      })
    )
  }
  @IpcMethod()
  async close(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        const readers = owner.readers.get(workspaceId)
        const count = readers?.get(id) ?? 0
        if (count > 1) readers!.set(id, count - 1)
        else readers?.delete(id)
        if (readers?.size === 0) {
          yield* owner.host.closeWorkspace(workspaceId)
          owner.readers.delete(workspaceId)
        }
      })
    )
  }
  @IpcMethod()
  async status(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? owner.host.status(workspaceId)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
  @IpcMethod()
  async ingestLedgerRecords(
    workspaceId: string,
    page: Parameters<E2eeWorkspaceRuntime['ingestLedgerRecords']>[1]
  ) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? owner.host.ingestLedgerRecords(workspaceId, page)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
  @IpcMethod()
  async ledgerView(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? owner.host.ledgerView(workspaceId)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
}
