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
import { PersonalPairingOfferSchema } from '../../services/e2ee-personal-pairing.mjs'
import type { E2eeJoinSession, E2eePersonalPairingOffer } from '@lody/cloud-api'

const observedSenders = new WeakSet<Electron.WebContents>()
function pairingSession(value: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value))
    throw new Error('e2ee_invalid-input')
}
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
  /** Terminal remote state is the cleanup authority, not a generic request error.
   * Each original remains in its journal until its own archival succeeds. */
  private async settlePersonalJoin(
    accountId: string,
    workspaceId: string,
    pairingSessionId: string,
    status: 'cancelled' | 'conflict',
    options?: { primary?: unknown; recipientOnly?: boolean }
  ) {
    const errors: unknown[] = []
    const attempt = async (work: Parameters<typeof withDesktopE2eeAccount>[0]) => {
      try {
        await withDesktopE2eeAccount(work)
      } catch (error) {
        errors.push(error)
      }
    }
    await attempt((owner) =>
      Effect.gen(function* () {
        if (owner.accountId !== accountId)
          return yield* Effect.fail(new Error('e2ee_account_mismatch'))
        const pending = yield* owner.bootstrap.pendingPersonalJoin(workspaceId)
        // A snapshot-origin approver retains its own accepted join. Cancelling
        // somebody else's session cannot retire that origin or a newer request.
        if (pending?.pairingSessionId === pairingSessionId)
          yield* owner.bootstrap.retirePersonalJoin(workspaceId, pairingSessionId)
        return undefined
      })
    )
    if (!options?.recipientOnly)
      await attempt((owner) => {
        if (owner.accountId !== accountId) return Effect.fail(new Error('e2ee_account_mismatch'))
        if (!owner.readers.has(workspaceId)) return Effect.void
        return status === 'cancelled'
          ? owner.host.cancelPersonalPairing(workspaceId, pairingSessionId)
          : owner.host.retirePersonalPairing(workspaceId, pairingSessionId)
      })
    if (errors.length)
      this.pairingFailure = new AggregateError(
        [...(options?.primary === undefined ? [] : [options.primary]), ...errors],
        'e2ee_join_cleanup_pending'
      )
    return errors.length > 0
  }
  /** A relay slot is immutable. Different complete material cannot admit this
   * host's saved request; archive only that local attempt, retaining all originals. */
  private async foreignPersonalJoin(accountId: string, result: E2eeJoinSession) {
    return withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (owner.accountId !== accountId)
          return yield* Effect.fail(new Error('e2ee_account_mismatch'))
        const pending = yield* owner.bootstrap.pendingPersonalJoin(result.workspaceId)
        if (!pending || pending.pairingSessionId !== result.pairingSessionId) return false
        if (pending.offer.genesisHash !== result.genesisHash)
          return yield* Effect.fail(new Error('e2ee_conflict'))
        if (!pending.requestHex) return false
        return (
          pending.signingPublicKey !== result.signingPublicKey ||
          pending.credentialHash !== result.credentialHash ||
          pending.requestHex !== result.requestHex
        )
      })
    )
  }
  @IpcMethod()
  async personalPairingOffer(workspaceId: string) {
    const id = sender()
    const saved = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return {
          accountId: owner.accountId,
          offer: yield* owner.host.personalPairingOffer(workspaceId)
        }
      })
    )
    const cloud = await desktopE2eeCloudClient().catch((error) => {
      this.pairingFailure = error
      return null
    })
    if (cloud && cloud.accountId !== saved.accountId) throw new Error('e2ee_account_mismatch')
    let result
    try {
      if (cloud)
        result = await Effect.runPromise(
          cloud.client.joinStatus({ workspaceId, pairingSessionId: saved.offer.pairingSessionId })
        )
    } catch (error) {
      // New offers need not have reached the relay. Unavailability never retires
      // the original or prevents its transfer; it is not admission authority.
      this.pairingFailure = error
    }
    if (result) {
      if (
        result.accountId !== saved.accountId ||
        result.workspaceId !== workspaceId ||
        result.pairingSessionId !== saved.offer.pairingSessionId ||
        result.genesisHash !== saved.offer.genesisHash
      )
        throw new Error('e2ee_conflict')
      if (result.status === 'cancelled' || result.status === 'conflict') {
        let primary: unknown
        if (result.status === 'conflict') {
          try {
            await this.refresh(workspaceId)
          } catch (error) {
            this.pairingFailure = error
            primary = error
          }
        }
        await this.settlePersonalJoin(
          saved.accountId,
          workspaceId,
          result.pairingSessionId,
          result.status,
          { primary }
        )
      }
    }
    return withDesktopE2eeAccount((owner) =>
      owner.accountId === saved.accountId && owner.readers.get(workspaceId)?.has(id)
        ? owner.host.personalPairingOffer(workspaceId)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  }
  @IpcMethod()
  async pendingPersonalJoin(workspaceId: string) {
    sender()
    return withDesktopE2eeAccount((owner) => owner.bootstrap.pendingPersonalJoin(workspaceId))
  }
  private async reconcilePendingPersonalJoin(workspaceId: string) {
    const saved = await withDesktopE2eeAccount((owner) =>
      Effect.map(owner.bootstrap.pendingPersonalJoin(workspaceId), (pending) => ({
        accountId: owner.accountId,
        pending
      }))
    )
    if (!saved.pending) return null
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== saved.accountId) throw new Error('e2ee_account_mismatch')
    let result
    try {
      result = await Effect.runPromise(
        cloud.client.joinStatus({ workspaceId, pairingSessionId: saved.pending.pairingSessionId })
      )
    } catch (error) {
      this.pairingFailure = error
    }
    if (result) {
      if (
        result.accountId !== saved.accountId ||
        result.workspaceId !== workspaceId ||
        result.pairingSessionId !== saved.pending.pairingSessionId ||
        result.genesisHash !== saved.pending.offer.genesisHash
      )
        throw new Error('e2ee_conflict')
      if (await this.foreignPersonalJoin(saved.accountId, result))
        await this.settlePersonalJoin(
          saved.accountId,
          workspaceId,
          result.pairingSessionId,
          'conflict',
          { recipientOnly: true }
        )
      else if (result.status === 'cancelled' || result.status === 'conflict')
        await this.settlePersonalJoin(
          saved.accountId,
          workspaceId,
          result.pairingSessionId,
          result.status
        )
    }
    return withDesktopE2eeAccount((owner) =>
      owner.accountId === saved.accountId
        ? owner.bootstrap.pendingPersonalJoin(workspaceId)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  }
  @IpcMethod()
  async preparePersonalJoin(input: E2eePersonalPairingOffer) {
    sender()
    const parsed = PersonalPairingOfferSchema.safeParse(input)
    if (!parsed.success) throw new Error('e2ee_invalid-input')
    const offer = parsed.data
    await this.reconcilePendingPersonalJoin(offer.workspaceId)
    const prepared = await withDesktopE2eeAccount((owner) =>
      Effect.map(owner.bootstrap.preparePersonalJoin(offer), (request) => ({
        accountId: owner.accountId,
        request
      }))
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== prepared.accountId) throw new Error('e2ee_account_mismatch')
    const result = await Effect.runPromise(
      cloud.client.joinBegin({ ...prepared.request, genesisHash: offer.genesisHash })
    )
    if (
      result.requestHex !== prepared.request.requestHex ||
      result.accountId !== prepared.accountId ||
      result.workspaceId !== offer.workspaceId ||
      result.genesisHash !== offer.genesisHash ||
      result.pairingSessionId !== offer.pairingSessionId ||
      result.signingPublicKey !== prepared.request.signingPublicKey ||
      result.credentialHash !== prepared.request.credentialHash
    )
      throw new Error('e2ee_conflict')
    if (result.status === 'cancelled' || result.status === 'conflict') {
      try {
        await withDesktopE2eeAccount((owner) =>
          owner.accountId === prepared.accountId
            ? owner.bootstrap.retirePersonalJoin(offer.workspaceId, offer.pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch'))
        )
      } catch (error) {
        this.pairingFailure = error
      }
    }
    return {
      pairingSessionId: result.pairingSessionId,
      signingPublicKey: result.signingPublicKey,
      status: result.status
    }
  }
  @IpcMethod()
  async inspectPersonalJoin(workspaceId: string, pairingSessionId: string) {
    const id = sender()
    pairingSession(pairingSessionId)
    const access = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return {
          accountId: owner.accountId,
          credential: yield* owner.bootstrap.deviceCredential(workspaceId)
        }
      })
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const request = await Effect.runPromise(
      cloud.client.joinReadRequest({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (request.status === 'cancelled') {
      await withDesktopE2eeAccount((owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.cancelPersonalPairing(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
      throw new Error('e2ee_join_cancelled')
    }
    if (request.status === 'conflict') {
      // The service result is a hint. Only verified original history may prove
      // a signed CAS loser; key-delivery failure does not undo that proof.
      try {
        await this.refresh(workspaceId)
      } catch (error) {
        this.pairingFailure = error
      }
      await withDesktopE2eeAccount((owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.retirePersonalPairing(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
      throw new Error('e2ee_join_conflict')
    }
    return withDesktopE2eeAccount((owner) =>
      owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
        ? owner.host.previewPersonalAdmission(workspaceId, request.requestHex)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  }
  @IpcMethod()
  async approvePersonalJoin(workspaceId: string, pairingSessionId: string) {
    const id = sender()
    pairingSession(pairingSessionId)
    // The separate inspection call displays verified public evidence. This
    // explicit operation is the only one permitted to sign an admission.
    const preview = await this.inspectPersonalJoin(workspaceId, pairingSessionId)
    if (preview.pairingSessionId !== pairingSessionId) throw new Error('e2ee_conflict')
    const cloud = await desktopE2eeCloudClient()
    const access = await withDesktopE2eeAccount((owner) =>
      Effect.gen(function* () {
        if (owner.accountId !== cloud.accountId || !owner.readers.get(workspaceId)?.has(id))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return { credential: yield* owner.bootstrap.deviceCredential(workspaceId) }
      })
    )
    const material = await Effect.runPromise(
      cloud.client.joinReadRequest({ workspaceId, pairingSessionId, credential: access.credential })
    )
    const pending = await withDesktopE2eeAccount((owner) =>
      owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
        ? owner.host.preparePersonalAdmission(workspaceId, material.requestHex)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    let appendFailure: unknown
    try {
      await Effect.runPromise(cloud.client.appendRecord(pending))
    } catch (error) {
      appendFailure = error
    }
    try {
      await this.refresh(workspaceId)
    } catch (error) {
      this.pairingFailure = error
    }
    let invitation
    try {
      invitation = await withDesktopE2eeAccount((owner) =>
        owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.personalInvitation(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
    } catch (error) {
      this.pairingFailure = new AggregateError(
        [...(appendFailure === undefined ? [] : [appendFailure]), error],
        'e2ee_append_unconfirmed'
      )
      // Raw causes stay in main; the IPC decorator logs rejected Errors.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('e2ee_append_unconfirmed')
    }
    try {
      await Effect.runPromise(
        cloud.client.joinPublish({
          workspaceId,
          pairingSessionId,
          credential: access.credential,
          ...invitation
        })
      )
      return { admitted: true as const, invitationPublished: true }
    } catch (error) {
      this.pairingFailure = error
      return { admitted: true as const, invitationPublished: false }
    }
  }
  @IpcMethod()
  async claimPersonalJoin(workspaceId: string, pairingSessionId: string) {
    sender()
    pairingSession(pairingSessionId)
    const cloud = await desktopE2eeCloudClient()
    const result = await Effect.runPromise(
      cloud.client.joinClaim({ workspaceId, pairingSessionId })
    )
    if (
      result.accountId !== cloud.accountId ||
      result.workspaceId !== workspaceId ||
      result.pairingSessionId !== pairingSessionId
    )
      throw new Error('e2ee_conflict')
    if (result.status === 'cancelled' || result.status === 'conflict') {
      await this.settlePersonalJoin(cloud.accountId, workspaceId, pairingSessionId, result.status)
      return { ready: false, status: result.status }
    }
    if (await this.foreignPersonalJoin(cloud.accountId, result)) {
      await this.settlePersonalJoin(cloud.accountId, workspaceId, pairingSessionId, 'conflict', {
        recipientOnly: true
      })
      return { ready: false, status: 'conflict' }
    }
    if (!result.invitationHex) return { ready: false, status: result.status }
    await withDesktopE2eeAccount((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.acceptPersonalJoin(workspaceId, result.invitationHex!)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    await this.open(workspaceId)
    try {
      try {
        await this.refresh(workspaceId)
      } catch (error) {
        this.pairingFailure = error
      }
      const status = await this.status(workspaceId)
      return { ready: status.hasCurrentKey, status: result.status }
    } finally {
      try {
        await this.close(workspaceId)
      } catch (error) {
        this.pairingFailure = error
      }
    }
  }
  @IpcMethod()
  async cancelPersonalJoin(workspaceId: string, pairingSessionId: string) {
    sender()
    pairingSession(pairingSessionId)
    const cloud = await desktopE2eeCloudClient()
    const result = await Effect.runPromise(
      cloud.client.joinCancel({ workspaceId, pairingSessionId })
    )
    const cleanupPending = await this.settlePersonalJoin(
      cloud.accountId,
      workspaceId,
      pairingSessionId,
      'cancelled'
    )
    // A confirmed cancellation remains successful even if archival needs retry.
    return { ...result, cleanupPending }
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
