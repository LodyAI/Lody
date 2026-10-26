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
  desktopE2eeCloudClient,
  runDesktopE2eeOperation,
  withDesktopE2eeAccount
} from '../../services/e2ee-account-runtime'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

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
  // The decorator logs rejected errors. Retain only the latest local diagnostic
  // here, never on the cause-bearing Error passed to that logging/IPC boundary.
  private pairingFailure: unknown
  @IpcMethod()
  async account(options?: { token?: string }) {
    sender()
    const identity = getIpcServiceDeps().authService.getCachedSessionIdentity(
      options?.token
        ? { fetchOptions: { headers: { Authorization: `Bearer ${options.token}` } } }
        : undefined
    )
    return identity.userId && identity.source
      ? { userId: identity.userId, source: identity.source }
      : null
  }
  @IpcMethod()
  async refresh(workspaceId: string) {
    const id = sender()
    const access = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return {
          accountId: owner.accountId,
          credential: yield* owner.bootstrap.deviceCredential(workspaceId),
          status: yield* owner.host.status(workspaceId)
        }
      })
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    let after = access.status.position ?? undefined
    let cursor: string | undefined
    let checkpoint: import('@lody/cloud-api').E2eeLedgerCheckpoint | undefined
    do {
      const page = await Effect.runPromise(
        cloud.client.history({
          workspaceId,
          ...(cursor ? { cursor, checkpoint } : after ? { after } : {})
        })
      )
      checkpoint ??= page.checkpoint
      const ingest = await withDesktopE2eeAccount((owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? Effect.succeed(owner.host.ingestLedgerRecords(workspaceId, page))
          : Effect.fail(new Error('e2ee_not_open'))
      )
      await runDesktopE2eeOperation(access.accountId, ingest)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    const work = await withDesktopE2eeAccount((owner) =>
      owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
        ? Effect.succeed(
            owner.host.keyRound(workspaceId, (signal) =>
              cloud.client.mailbox({ workspaceId, credential: access.credential }, signal)
            )
          )
        : Effect.fail(new Error('e2ee_not_open'))
    )
    await runDesktopE2eeOperation(access.accountId, work)
    return this.status(workspaceId)
  }
  @IpcMethod()
  async prepareLocalAgent(workspaceId: string) {
    this.pairingFailure = undefined
    const id = sender()
    const context = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        yield* owner.bootstrap.deviceCredential(workspaceId)
        return {
          accountId: owner.accountId,
          ...(yield* owner.host.localPairingContext(workspaceId))
        }
      })
    )
    const cli = getIpcServiceDeps().cliService
    const machineId = await cli.getLocalMachineId()
    if (!machineId) throw new Error('e2ee_local_agent_unavailable')
    let material
    try {
      material = await cli.prepareLocalE2eeDevice({ type: 'prepare', machineId, ...context })
    } catch (error) {
      this.pairingFailure = error
      // Original retained above; attaching it would leak raw causes through the IPC logger.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        error instanceof Error && error.message === 'e2ee_local_agent_pending'
          ? 'e2ee_local_agent_pending'
          : 'e2ee_local_agent_unavailable'
      )
    }
    if (material.machineId !== machineId || material.pairingSessionId !== context.pairingSessionId)
      throw new Error('e2ee_conflict')
    return withDesktopE2eeAccount((owner) =>
      owner.accountId === context.accountId && owner.readers.get(workspaceId)?.has(id)
        ? owner.host.stageLocalPairing(workspaceId, material)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  }
  @IpcMethod()
  async admitLocalAgent(workspaceId: string, pairingSessionId: string) {
    this.pairingFailure = undefined
    const id = sender()
    if (typeof pairingSessionId !== 'string' || !/^[0-9a-f]{32}$/.test(pairingSessionId))
      throw new Error('e2ee_invalid-input')
    const pending = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return {
          accountId: owner.accountId,
          request: yield* owner.host.approveLocalPairing(workspaceId, pairingSessionId)
        }
      })
    )
    let appendFailure: unknown
    if (pending.request) {
      const cloud = await desktopE2eeCloudClient()
      if (cloud.accountId !== pending.accountId) throw new Error('e2ee_account_mismatch')
      // Even an uncertain append is reconciled through verified readback below.
      // Its journal retains the same request and signature for the next attempt.
      try {
        await Effect.runPromise(cloud.client.appendRecord(pending.request))
      } catch (error) {
        appendFailure = error
      }
    }
    let distributed = true
    try {
      await this.refresh(workspaceId)
    } catch (error) {
      this.pairingFailure = error
      distributed = false
    }
    let confirmed
    try {
      confirmed = await withDesktopE2eeAccount((owner) =>
        owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.confirmLocalPairing(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
    } catch (error) {
      // Keep both failures in main for diagnosis. Only a stable message crosses
      // IPC; never log SDK/raw causes or let an old error undo verified success.
      if (appendFailure !== undefined) {
        this.pairingFailure = new AggregateError(
          [
            appendFailure,
            ...(this.pairingFailure === undefined ? [] : [this.pairingFailure]),
            error
          ],
          'e2ee_append_unconfirmed',
          {
            cause: appendFailure
          }
        )
        // Original retained above; the IPC decorator logs rejected Error causes.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('e2ee_append_unconfirmed')
      }
      throw error
    }
    if (!distributed) return { admitted: true as const, ready: false }
    try {
      await getIpcServiceDeps().cliService.activateLocalE2eeDevice({
        type: 'activate',
        accountId: pending.accountId,
        workspaceId,
        ...confirmed
      })
      return { admitted: true as const, ready: true }
    } catch (error) {
      this.pairingFailure = error
      // Approval is already committed. A delayed mailbox or CLI must not undo it.
      return { admitted: true as const, ready: false }
    }
  }
  @IpcMethod()
  async contentStreamsToken(workspaceId: string, rejectedToken?: string) {
    const id = sender()
    const access = await withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? Effect.map(owner.bootstrap.deviceCredential(workspaceId), (credential) => ({
            accountId: owner.accountId,
            credential
          }))
        : Effect.fail(new Error('e2ee_not_open'))
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const result = await Effect.runPromise(
      cloud.client.contentStreamsToken({
        workspaceId,
        credential: access.credential,
        ...(rejectedToken ? { rejectedToken } : {})
      })
    )
    if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
      throw new Error('e2ee_account_mismatch')
    return result
  }
  @IpcMethod()
  async seal(workspaceId: string, input: Parameters<E2eeWorkspaceRuntime['seal']>[1]) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? owner.host.seal(workspaceId, input)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
  @IpcMethod()
  async openContent(
    workspaceId: string,
    input: Parameters<E2eeWorkspaceRuntime['openContent']>[1]
  ) {
    const id = sender()
    return withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? owner.host.openContent(workspaceId, input)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
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
    const cleanup = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        const readers = owner.readers.get(workspaceId)
        const count = readers?.get(id) ?? 0
        if (count > 1) readers!.set(id, count - 1)
        else readers?.delete(id)
        if (readers?.size === 0) {
          const drain = yield* owner.host.beginCloseWorkspace(workspaceId)
          owner.readers.delete(workspaceId)
          return drain
        }
        return Effect.void
      })
    )
    await Effect.runPromise(cleanup).catch(() => {
      throw new Error('e2ee_cleanup_failed')
    })
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
    const captured = await withDesktopE2eeAccount((owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? Effect.succeed({
            accountId: owner.accountId,
            work: owner.host.ingestLedgerRecords(workspaceId, page)
          })
        : Effect.fail(new Error('e2ee_not_open'))
    )
    return runDesktopE2eeOperation(captured.accountId, captured.work)
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
