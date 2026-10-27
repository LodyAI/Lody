import { randomUUID } from 'node:crypto'
import { E2eeMemberRemovedError } from '../../services/e2ee-cloud-errors.mjs'
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
  resetDesktopE2eeIdentity,
  recordDesktopE2eeCreated,
  prepareDesktopE2eeCreation,
  desktopE2eeCloudClient,
  runDesktopE2eeOperation,
  withDesktopE2eeAccount,
  cleanupRemovedDesktopWorkspace
} from '../../services/e2ee-account-runtime'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { PersonalPairingOfferSchema } from '../../services/e2ee-personal-pairing.mjs'
import { LocalE2eeRecoveryFailureSchema } from '@lody/shared/e2ee-local-pairing'
import type { E2eeJoinSession, E2eePersonalPairingOffer } from '@lody/cloud-api'
import type { E2eeMemberOffer, E2eeWorkspaceHistoryPage } from '@lody/cloud-api'
import { MemberOfferSchema, decodeMemberKeyPackage } from '../../services/e2ee-member-join.mjs'

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
  private readonly readerOwners = new WeakMap<object, string>()
  private readerOwner(owner: object) {
    let id = this.readerOwners.get(owner)
    if (!id) {
      id = randomUUID()
      this.readerOwners.set(owner, id)
    }
    return id
  }
  private memberScope(workspaceId: string) {
    const auth = getIpcServiceDeps().authService
    const identity = auth.getCachedSessionIdentity()
    type Owner = Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]
    let original: Owner | undefined
    return <A>(work: (owner: Owner) => Effect.Effect<A, unknown>, create = false) =>
      withDesktopE2eeAccount(
        (owner) => {
          const latest = auth.getCachedSessionIdentity()
          if (
            !identity.userId ||
            owner.accountId !== identity.userId ||
            latest.userId !== identity.userId ||
            latest.generation !== identity.generation ||
            (original && original !== owner)
          )
            return Effect.fail(new Error('e2ee_account_mismatch'))
          original ??= owner
          return work(owner)
        },
        workspaceId,
        create
      )
  }
  private async memberAccess(
    workspaceId: string,
    reader: number,
    scope = this.memberScope(workspaceId)
  ) {
    return scope((owner) =>
      Effect.gen(function* () {
        if (!owner.readers.get(workspaceId)?.has(reader))
          return yield* Effect.fail(new Error('e2ee_not_open'))
        return {
          accountId: owner.accountId,
          workspaceId,
          credential: yield* owner.bootstrap.deviceCredential(workspaceId),
          status: yield* owner.host.status(workspaceId)
        }
      })
    )
  }
  private memberResult<A>(
    access: Awaited<ReturnType<E2eeIpc['memberAccess']>>,
    request: Effect.Effect<A, unknown>
  ) {
    return Effect.runPromise(request).catch((error) => {
      if (error instanceof E2eeMemberRemovedError) return this.removeLocalWorkspace(access)
      throw error
    })
  }
  private async permissionHistory(
    workspaceId: string,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>
  ) {
    const pages: E2eeWorkspaceHistoryPage[] = []
    let cursor: string | undefined
    for (let index = 0; index < 256; index++) {
      const page = await Effect.runPromise(
        cloud.client.history({
          workspaceId,
          ...(cursor ? { cursor } : {}),
          ...(pages[0] ? { checkpoint: pages[0].checkpoint } : {})
        })
      )
      pages.push(page)
      if (page.nextCursor === null) return pages
      cursor = page.nextCursor
    }
    throw new Error('e2ee_ledger_budget_exceeded')
  }
  @IpcMethod()
  async createMemberInvitation(input: {
    workspaceId: string
    mode: 'email' | 'link'
    email?: string
  }) {
    const id = sender()
    const scope = this.memberScope(input.workspaceId)
    if (input.mode !== 'email' && input.mode !== 'link') throw new Error('e2ee_invalid-input')
    const access = await this.memberAccess(input.workspaceId, id, scope)
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const offer = await scope((owner) =>
      owner.accountId === access.accountId && owner.readers.get(input.workspaceId)?.has(id)
        ? owner.host.memberOffer(input.workspaceId, input.mode, Date.now() + 48 * 60 * 60 * 1000)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    const result = await this.memberResult(
      access,
      cloud.client.memberCreateInvitation({
        ...access,
        offer,
        ...(input.email === undefined ? {} : { email: input.email })
      })
    )
    if (
      result.offer.workspaceId !== offer.workspaceId ||
      result.offer.genesisHash !== offer.genesisHash
    )
      throw new Error('e2ee_conflict')
    return result.offer
  }
  @IpcMethod()
  async pendingMemberJoin(workspaceId: string) {
    sender()
    const scope = this.memberScope(workspaceId)
    return scope((owner) =>
      Effect.map(owner.bootstrap.pendingMemberJoin(workspaceId), (pending) =>
        pending
          ? {
              offer: pending.offer,
              requestId: pending.keyPackageHex
                ? Buffer.from(
                    decodeMemberKeyPackage(pending.keyPackageHex).request.requestId.toBytes()
                  ).toString('hex')
                : null
            }
          : null
      )
    ).catch((error) => {
      if (error instanceof Error && error.message === 'e2ee_missing-binding') return null
      throw error
    })
  }
  @IpcMethod()
  async prepareMemberJoin(source: E2eeMemberOffer) {
    sender()
    const offer = MemberOfferSchema.parse(source)
    const scope = this.memberScope(offer.workspaceId)
    const cloud = await desktopE2eeCloudClient()
    const pending = await scope(
      (owner) =>
        owner.accountId === cloud.accountId
          ? owner.bootstrap.pendingMemberJoin(offer.workspaceId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      true
    )
    if (pending && JSON.stringify(pending.offer) !== JSON.stringify(offer)) {
      const retired = pending.keyPackageHex
        ? await Effect.runPromise(
            cloud.client.memberRetire({
              token: pending.offer.token,
              keyPackageHex: pending.keyPackageHex
            })
          )
        : { state: 'cancelled' }
      if (retired.state !== 'cancelled') throw new Error('e2ee_original_join_pending')
      await scope((owner) =>
        owner.accountId === cloud.accountId
          ? owner.bootstrap.retireMemberJoin(pending)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
    }
    const needsIdentity = await scope((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.memberJoinNeedsAccountIdentity()
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    if (needsIdentity) {
      const identity = await Effect.runPromise(cloud.client.accountIdentity())
      await scope((owner) =>
        owner.accountId === cloud.accountId
          ? owner.bootstrap.recordAccountIdentity({
              accountId: cloud.accountId,
              cryptoUserId: identity.cryptoUserId
            })
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
    }
    const original = await scope((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.prepareMemberJoin(offer)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    const result = await Effect.runPromise(
      cloud.client.memberSubmit({ token: offer.token, keyPackageHex: original.keyPackageHex })
    )
    if (
      result.accountId !== cloud.accountId ||
      result.workspaceId !== offer.workspaceId ||
      result.keyPackageHex !== original.keyPackageHex
    )
      throw new Error('e2ee_conflict')
    return result
  }
  @IpcMethod()
  async memberJoinRequests(workspaceId: string) {
    const id = sender()
    const scope = this.memberScope(workspaceId)
    const access = await this.memberAccess(workspaceId, id, scope)
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const result = await this.memberResult(access, cloud.client.memberPending(access))
    const items: typeof result.items = []
    for (const item of result.items) {
      if (item.workspaceId !== workspaceId) throw new Error('e2ee_conflict')
      try {
        await scope((owner) =>
          owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.inspectMemberAdmission(workspaceId, item.keyPackageHex)
            : Effect.fail(new Error('e2ee_account_mismatch'))
        )
        items.push(item)
      } catch (cause) {
        // One malformed or stale applicant never suppresses other requests.
        this.pairingFailure = cause
      }
    }
    return { ...result, items }
  }
  @IpcMethod()
  async approveMemberJoin(workspaceId: string, requestId: string, mode: 'automatic' | 'explicit') {
    const id = sender()
    const scope = this.memberScope(workspaceId)
    if (mode !== 'automatic' && mode !== 'explicit') throw new Error('e2ee_invalid-input')
    const access = await this.memberAccess(workspaceId, id, scope)
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const material = await this.memberResult(
      access,
      cloud.client.memberRead({ ...access, requestId })
    )
    if (
      material.workspaceId !== workspaceId ||
      material.requestId !== requestId ||
      (mode === 'automatic' && material.source !== 'email')
    )
      throw new Error('e2ee_conflict')
    const pending = await scope((owner) =>
      owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
        ? owner.host.prepareMemberAdmission(workspaceId, material.keyPackageHex)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    let primary: unknown
    if (pending) {
      try {
        await Effect.runPromise(cloud.client.appendRecord(pending))
      } catch (cause) {
        if (cause instanceof E2eeMemberRemovedError) return this.removeLocalWorkspace(access)
        primary = cause
      }
    }
    // A lost ACK is reconciled from genuine ledger history, never by signing again.
    try {
      await this.refresh(workspaceId)
    } catch (cause) {
      this.pairingFailure = cause
    }
    const result = await this.memberResult(
      access,
      cloud.client.memberRead({ ...access, requestId })
    )
    if (result.state !== 'committed') {
      this.pairingFailure = primary
      return { admitted: false, keyPending: true }
    }
    // refresh drives existing all-device mailbox delivery. Its failure cannot undo admission.
    return { admitted: true, keyPending: true }
  }
  @IpcMethod()
  async rejectMemberJoin(workspaceId: string, requestId: string) {
    const access = await this.memberAccess(workspaceId, sender())
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    return this.memberResult(access, cloud.client.memberReject({ ...access, requestId }))
  }
  @IpcMethod()
  async revokeMemberInvitation(workspaceId: string, token: string) {
    const access = await this.memberAccess(workspaceId, sender())
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    return this.memberResult(access, cloud.client.memberRevoke({ ...access, token }))
  }
  @IpcMethod()
  async claimMemberJoin(workspaceId: string, requestId: string) {
    const reader = sender()
    const scope = this.memberScope(workspaceId)
    await scope(() => Effect.void)
    const cloud = await desktopE2eeCloudClient()
    const result = await Effect.runPromise(cloud.client.memberClaim({ workspaceId, requestId }))
    if (
      result.accountId !== cloud.accountId ||
      result.workspaceId !== workspaceId ||
      result.requestId !== requestId
    )
      throw new Error('e2ee_conflict')
    if (result.state !== 'committed') return { ready: false, state: result.state }
    const pages = await this.permissionHistory(workspaceId, cloud)
    await scope((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.acceptMemberJoin(workspaceId, pages)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    const ready = await this.installMemberJoin(workspaceId, reader, scope, cloud, pages)
    return { ready, state: 'committed' }
  }
  private async installMemberJoin(
    workspaceId: string,
    reader: number,
    scope: ReturnType<E2eeIpc['memberScope']>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>,
    pages: E2eeWorkspaceHistoryPage[]
  ) {
    await scope((owner) =>
      Effect.gen(function* () {
        yield* owner.host.open(workspaceId)
        const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
        readers.set(reader, (readers.get(reader) ?? 0) + 1)
        owner.readers.set(workspaceId, readers)
      })
    )
    try {
      for (const page of pages)
        await scope((owner) => owner.host.ingestLedgerRecords(workspaceId, page))
      try {
        const access = await this.memberAccess(workspaceId, reader, scope)
        const work = await scope((owner) =>
          Effect.succeed(
            owner.host.keyRound(
              workspaceId,
              (signal) =>
                cloud.client.mailbox({ workspaceId, credential: access.credential }, signal),
              (signal) =>
                cloud.client.staging({ workspaceId, credential: access.credential }, signal)
            )
          )
        )
        await runDesktopE2eeOperation(cloud.accountId, work).catch((cause) => {
          if (cause instanceof E2eeMemberRemovedError) return this.removeLocalWorkspace(access)
          throw cause
        })
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'e2ee_member_removed') throw cause
        this.pairingFailure = cause
      }
      return (await scope((owner) => owner.host.status(workspaceId))).hasCurrentKey
    } finally {
      try {
        const cleanup = await scope((owner) =>
          Effect.gen(function* () {
            const readers = owner.readers.get(workspaceId)
            const count = readers?.get(reader) ?? 0
            if (count > 1) readers!.set(reader, count - 1)
            else readers?.delete(reader)
            if (readers?.size === 0) {
              const drain = yield* owner.host.beginCloseWorkspace(workspaceId)
              owner.readers.delete(workspaceId)
              return drain
            }
            return Effect.void
          })
        )
        await runDesktopE2eeOperation(cloud.accountId, cleanup)
      } catch (cause) {
        this.pairingFailure = cause
      }
    }
  }
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
        await withDesktopE2eeAccount(work, workspaceId, false)
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
    return withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (owner.accountId !== accountId)
            return yield* Effect.fail(new Error('e2ee_account_mismatch'))
          const pending = yield* owner.bootstrap.pendingPersonalJoin(result.workspaceId)
          if (!pending || pending.pairingSessionId !== result.pairingSessionId) return false
          if (pending.offer.genesisHash !== result.genesisHash)
            return yield* Effect.fail(new Error('e2ee_conflict'))
          // This host persists its request before joinBegin can publish it. A
          // complete relay request cannot be ours while only our pin is saved.
          if (!pending.requestHex) return true
          return (
            pending.signingPublicKey !== result.signingPublicKey ||
            pending.credentialHash !== result.credentialHash ||
            pending.requestHex !== result.requestHex
          )
        }),
      result.workspaceId,
      false
    )
  }
  @IpcMethod()
  async personalPairingOffer(workspaceId: string) {
    const id = sender()
    const saved = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            accountId: owner.accountId,
            offer: yield* owner.host.personalPairingOffer(workspaceId)
          }
        }),
      workspaceId,
      false
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
    return withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === saved.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.personalPairingOffer(workspaceId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async pendingPersonalJoin(workspaceId: string) {
    sender()
    return withDesktopE2eeAccount(
      (owner) => owner.bootstrap.pendingPersonalJoin(workspaceId),
      workspaceId,
      false
    ).catch((error) => {
      if (error instanceof Error && error.message === 'e2ee_missing-binding') return null
      throw error
    })
  }
  private async reconcilePendingPersonalJoin(workspaceId: string) {
    const saved = await withDesktopE2eeAccount(
      (owner) =>
        Effect.map(owner.bootstrap.pendingPersonalJoin(workspaceId), (pending) => ({
          accountId: owner.accountId,
          pending
        })),
      workspaceId,
      false
    ).catch((error) => {
      if (error instanceof Error && error.message === 'e2ee_missing-binding')
        return { accountId: '', pending: null }
      throw error
    })
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
    return withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === saved.accountId
          ? owner.bootstrap.pendingPersonalJoin(workspaceId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async preparePersonalJoin(input: E2eePersonalPairingOffer) {
    sender()
    const parsed = PersonalPairingOfferSchema.safeParse(input)
    if (!parsed.success) throw new Error('e2ee_invalid-input')
    const offer = parsed.data
    await this.reconcilePendingPersonalJoin(offer.workspaceId)
    const prepared = await withDesktopE2eeAccount(
      (owner) =>
        Effect.map(owner.bootstrap.preparePersonalJoin(offer), (request) => ({
          accountId: owner.accountId,
          request
        })),
      offer.workspaceId
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
        await withDesktopE2eeAccount(
          (owner) =>
            owner.accountId === prepared.accountId
              ? owner.bootstrap.retirePersonalJoin(offer.workspaceId, offer.pairingSessionId)
              : Effect.fail(new Error('e2ee_account_mismatch')),
          offer.workspaceId
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
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            accountId: owner.accountId,
            credential: yield* owner.bootstrap.deviceCredential(workspaceId)
          }
        }),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const request = await Effect.runPromise(
      cloud.client.joinReadRequest({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (request.status === 'cancelled') {
      await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.cancelPersonalPairing(workspaceId, pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
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
      await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.retirePersonalPairing(workspaceId, pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
      )
      throw new Error('e2ee_join_conflict')
    }
    return withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.previewPersonalAdmission(workspaceId, request.requestHex)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
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
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (owner.accountId !== cloud.accountId || !owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return { credential: yield* owner.bootstrap.deviceCredential(workspaceId) }
        }),
      workspaceId,
      false
    )
    const material = await Effect.runPromise(
      cloud.client.joinReadRequest({ workspaceId, pairingSessionId, credential: access.credential })
    )
    const pending = await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.preparePersonalAdmission(workspaceId, material.requestHex)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
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
      invitation = await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.personalInvitation(workspaceId, pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
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
    if (invitation === null) return { admitted: true as const, invitationPublished: false }
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
    if (!result.invitationHex && result.status !== 'admitted')
      return { ready: false, status: result.status }
    const history = result.invitationHex
      ? undefined
      : await this.permissionHistory(workspaceId, cloud)
    await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === cloud.accountId
          ? result.invitationHex
            ? owner.bootstrap.acceptPersonalJoin(workspaceId, result.invitationHex)
            : owner.bootstrap.acceptPersonalHistory(workspaceId, history!)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
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
  async refresh(workspaceId: string, options?: { installKeys?: boolean }) {
    return this.refreshLedger(workspaceId, options)
  }
  private async refreshLedger(workspaceId: string, options?: { installKeys?: boolean }) {
    if (
      options !== undefined &&
      (typeof options !== 'object' ||
        options === null ||
        (options.installKeys !== undefined && typeof options.installKeys !== 'boolean'))
    )
      throw new Error('e2ee_invalid-input')
    const id = sender()
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            accountId: owner.accountId,
            credential: yield* owner.bootstrap.deviceCredential(workspaceId),
            status: yield* owner.host.status(workspaceId)
          }
        }),
      workspaceId,
      false
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
      ).catch(async (error) => {
        try {
          await Effect.runPromise(
            cloud.client.contentStreamsToken({ workspaceId, credential: access.credential })
          )
        } catch (checked) {
          if (checked instanceof E2eeMemberRemovedError) {
            return this.removeLocalWorkspace(access)
          }
        }
        throw error
      })
      checkpoint ??= page.checkpoint
      const ingest = await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
            ? Effect.succeed(owner.host.ingestLedgerRecords(workspaceId, page))
            : Effect.fail(new Error('e2ee_not_open')),
        workspaceId,
        false
      )
      await runDesktopE2eeOperation(access.accountId, ingest)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    if (options?.installKeys === false) return this.status(workspaceId)
    const work = await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? Effect.succeed(
              owner.host.keyRound(
                workspaceId,
                (signal) =>
                  cloud.client.mailbox({ workspaceId, credential: access.credential }, signal),
                (signal) =>
                  cloud.client.staging({ workspaceId, credential: access.credential }, signal)
              )
            )
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
    await runDesktopE2eeOperation(access.accountId, work)
    return this.status(workspaceId)
  }
  @IpcMethod()
  async beginRemoteMachinePairing(workspaceId: string) {
    const id = sender()
    const state = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
          const offer = yield* owner.host.remoteMachineOffer(workspaceId, {
            accountId: owner.accountId,
            deploymentUrl: new URL(import.meta.env.VITE_CONVEX_DEPLOY_URL ?? '').origin,
            ingressUrl: new URL(import.meta.env.VITE_SERVER_URL ?? '').origin
          })
          return { credential, offer, accountId: owner.accountId }
        }),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== state.accountId) throw new Error('e2ee_account_mismatch')
    const status = await Effect.runPromise(
      cloud.client.machineBegin({ workspaceId, credential: state.credential, offer: state.offer })
    )
    return {
      ...status,
      command: `lody machine pair --offer ${Buffer.from(JSON.stringify(state.offer)).toString('base64url')}`
    }
  }
  @IpcMethod()
  async inspectRemoteMachinePairing(workspaceId: string, pairingSessionId: string) {
    const id = sender()
    pairingSession(pairingSessionId)
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            credential: yield* owner.bootstrap.deviceCredential(workspaceId),
            accountId: owner.accountId
          }
        }),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const status = await Effect.runPromise(
      cloud.client.machineInspect({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (status.pairingSessionId !== pairingSessionId) throw new Error('e2ee_conflict')
    const material = status.material
    const summary =
      material && ['claimed', 'admitting', 'admitted', 'ready'].includes(status.status)
        ? await withDesktopE2eeAccount(
            (owner) =>
              owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
                ? owner.host.stageRemoteMachine(workspaceId, pairingSessionId, material)
                : Effect.fail(new Error('e2ee_account_mismatch')),
            workspaceId,
            false
          )
        : null
    return { ...status, summary }
  }
  @IpcMethod()
  async approveRemoteMachinePairing(
    workspaceId: string,
    pairingSessionId: string,
    summary: string
  ) {
    const id = sender()
    pairingSession(pairingSessionId)
    if (typeof summary !== 'string' || !/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/.test(summary))
      throw new Error('e2ee_invalid-input')
    const current = await this.inspectRemoteMachinePairing(workspaceId, pairingSessionId)
    if (
      current.summary !== summary ||
      !['claimed', 'admitting', 'admitted', 'ready'].includes(current.status)
    )
      throw new Error('e2ee_conflict')
    const pending = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            accountId: owner.accountId,
            request: yield* owner.host.approveRemoteMachine(workspaceId, pairingSessionId, summary)
          }
        }),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== pending.accountId) throw new Error('e2ee_account_mismatch')
    if (pending.request) {
      try {
        await Effect.runPromise(cloud.client.appendRecord(pending.request))
      } catch (error) {
        this.pairingFailure = error
      }
    } else {
      const credential = await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.bootstrap.deviceCredential(workspaceId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
      )
      await Effect.runPromise(
        cloud.client.machineAuthorizeExisting({ workspaceId, pairingSessionId, credential })
      )
    }
    // Refresh reads back the original and drives resumable key distribution.
    await this.refresh(workspaceId)
    await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.confirmRemoteMachine(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
    const status = await this.inspectRemoteMachinePairing(workspaceId, pairingSessionId)
    return {
      admitted: status.status === 'admitted' || status.status === 'ready',
      ready: status.status === 'ready'
    }
  }
  @IpcMethod()
  async cancelRemoteMachinePairing(workspaceId: string, pairingSessionId: string) {
    const id = sender()
    pairingSession(pairingSessionId)
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            credential: yield* owner.bootstrap.deviceCredential(workspaceId),
            accountId: owner.accountId
          }
        }),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const result = await Effect.runPromise(
      cloud.client.machineCancel({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (!['cancelled', 'expired', 'conflict', 'ready'].includes(result.status))
      throw new Error('e2ee_conflict')
    if (!result.noAdmissionReserved) await this.refresh(workspaceId)
    await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.retireRemoteMachine(
              workspaceId,
              pairingSessionId,
              result.noAdmissionReserved === true
            )
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
    return result
  }

  @IpcMethod()
  async prepareLocalAgent(workspaceId: string) {
    this.pairingFailure = undefined
    const id = sender()
    const context = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          yield* owner.bootstrap.deviceCredential(workspaceId)
          return {
            accountId: owner.accountId,
            ...(yield* owner.host.localPairingContext(workspaceId))
          }
        }),
      workspaceId,
      false
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
        LocalE2eeRecoveryFailureSchema.safeParse({
          ok: false,
          error: error instanceof Error ? error.message : ''
        }).success
          ? `e2ee_machine_${(error as Error).message.slice(5)}`
          : error instanceof Error && error.message === 'e2ee_local_agent_pending'
            ? 'e2ee_local_agent_pending'
            : 'e2ee_local_agent_unavailable'
      )
    }
    if (material.machineId !== machineId || material.pairingSessionId !== context.pairingSessionId)
      throw new Error('e2ee_conflict')
    if (material.type === 'prepare-superseded') {
      let retirementFailure: unknown
      try {
        await withDesktopE2eeAccount(
          (owner) =>
            owner.accountId === context.accountId && owner.readers.get(workspaceId)?.has(id)
              ? owner.host.retireSupersededLocalPairing(
                  workspaceId,
                  context.pairingSessionId,
                  (error) => {
                    retirementFailure = error
                  }
                )
              : Effect.fail(new Error('e2ee_account_mismatch')),
          workspaceId,
          false
        )
      } catch (error) {
        const superseded = new Error('e2ee_pairing_superseded')
        this.pairingFailure = new AggregateError(
          [superseded, ...(retirementFailure === undefined ? [] : [retirementFailure]), error],
          'e2ee_pairing_retirement_failed',
          { cause: superseded }
        )
        // Original receipt and retirement failure stay in main.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('e2ee_local_agent_unavailable')
      }
      throw new Error('e2ee_local_agent_pending')
    }
    return withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === context.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.stageLocalPairing(workspaceId, material)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async admitLocalAgent(workspaceId: string, pairingSessionId: string) {
    this.pairingFailure = undefined
    const id = sender()
    if (typeof pairingSessionId !== 'string' || !/^[0-9a-f]{32}$/.test(pairingSessionId))
      throw new Error('e2ee_invalid-input')
    const pending = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          return {
            accountId: owner.accountId,
            request: yield* owner.host.approveLocalPairing(workspaceId, pairingSessionId)
          }
        }),
      workspaceId,
      false
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
      confirmed = await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.confirmLocalPairing(workspaceId, pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
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
  private async removeLocalWorkspace(access: {
    accountId: string
    credential: string
    status: import('@lody/platform').E2eeRuntimeStatus
  }): Promise<never> {
    const { workspaceId, genesisHash, signingPublicKey } = access.status
    if (!signingPublicKey) throw new Error('e2ee_local_cleanup_pending')
    const drain = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (owner.accountId !== access.accountId)
            return yield* Effect.fail(new Error('e2ee_account_mismatch'))
          const current = yield* owner.host.status(workspaceId)
          const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
          if (
            current.genesisHash !== genesisHash ||
            current.signingPublicKey !== signingPublicKey ||
            credential !== access.credential
          )
            return yield* Effect.fail(new Error('e2ee_account_mismatch'))
          if (
            !(yield* owner.bootstrap.recordRemovedWorkspace({
              workspaceId,
              genesisHash,
              signingPublicKey,
              credential: access.credential
            }))
          )
            return yield* Effect.fail(new Error('e2ee_account_mismatch'))
          return yield* owner.host.beginCloseWorkspace(workspaceId)
        }),
      workspaceId,
      false
    )
    await Effect.runPromise(drain)
    const deleted = await cleanupRemovedDesktopWorkspace({
      accountId: access.accountId,
      workspaceId
    }).catch((cause) => {
      this.pairingFailure = cause
      if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
        throw new Error('e2ee_account_mismatch')
      // Receipt survives a busy process lease or interrupted cleanup; the next open retries it.
      return true
    })
    if (deleted) throw new Error('e2ee_member_removed')
    // A newer local incarnation superseded the old credential's late response.
    throw new Error('e2ee_account_mismatch')
  }
  @IpcMethod()
  async removeMember(workspaceId: string, membershipId: string) {
    if (typeof membershipId !== 'string' || !/^[0-9a-f]{32}$/.test(membershipId))
      throw new Error('e2ee_invalid-input')
    await this.manage(workspaceId, { type: 'removeMember', membershipId })
  }
  @IpcMethod()
  async setMemberRole(workspaceId: string, membershipId: string, role: 'admin' | 'member') {
    if (
      typeof membershipId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(membershipId) ||
      (role !== 'admin' && role !== 'member')
    )
      throw new Error('e2ee_invalid-input')
    await this.manage(workspaceId, { type: 'setRole', membershipId, role })
  }
  @IpcMethod()
  async contentStreamsToken(
    workspaceId: string,
    rejectedToken?: string,
    requestSnapshotFor?: string
  ) {
    const id = sender()
    const access = await withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? Effect.gen(function* () {
              return {
                accountId: owner.accountId,
                credential: yield* owner.bootstrap.deviceCredential(workspaceId),
                status: yield* owner.host.status(workspaceId)
              }
            })
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const result = await Effect.runPromise(
      cloud.client.contentStreamsToken({
        workspaceId,
        credential: access.credential,
        ...(rejectedToken ? { rejectedToken } : {}),
        ...(requestSnapshotFor ? { requestSnapshotFor } : {})
      })
    ).catch((error) => {
      if (error instanceof E2eeMemberRemovedError) return this.removeLocalWorkspace(access)
      throw error
    })
    if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
      throw new Error('e2ee_account_mismatch')
    return result
  }
  @IpcMethod()
  async seal(workspaceId: string, input: Parameters<E2eeWorkspaceRuntime['seal']>[1]) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.seal(workspaceId, input)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async openContent(
    workspaceId: string,
    input: Parameters<E2eeWorkspaceRuntime['openContent']>[1]
  ) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.openContent(workspaceId, input)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async resetLocalAgent(input: { workspaceId: string; resetId: string; confirm: true }) {
    const id = sender()
    if (
      !input ||
      input.confirm !== true ||
      !/^[a-f0-9-]{36}$/.test(input.resetId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId)
    )
      throw new Error('e2ee_invalid-input')
    const accountId = await withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(input.workspaceId)?.has(id)
          ? Effect.as(owner.bootstrap.deviceCredential(input.workspaceId), owner.accountId)
          : Effect.fail(new Error('e2ee_not_open')),
      input.workspaceId,
      false
    )
    const cli = getIpcServiceDeps().cliService
    const machineId = await cli.getLocalMachineId()
    if (!machineId) throw new Error('e2ee_local_agent_unavailable')
    await cli.resetLocalE2eeIdentity({
      accountId,
      machineId,
      workspaceId: input.workspaceId,
      resetId: input.resetId
    })
    await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === accountId && owner.readers.get(input.workspaceId)?.has(id)
          ? owner.host.resetLocalPairing(input.workspaceId, input.resetId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      input.workspaceId,
      false
    )
  }
  @IpcMethod()
  async resetIdentity(input: { workspaceId?: string; resetId: string; confirm: true }) {
    sender()
    if (
      !input ||
      input.confirm !== true ||
      !/^[a-f0-9-]{36}$/.test(input.resetId) ||
      (input.workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId))
    )
      throw new Error('e2ee_invalid-input')
    return resetDesktopE2eeIdentity({ workspaceId: input.workspaceId, resetId: input.resetId })
  }
  @IpcMethod()
  async prepareCreation(payload: DesktopE2eeCreationIntent) {
    sender()
    validateDesktopE2eeCreationIntent(payload)
    const input = { ...payload }
    return prepareDesktopE2eeCreation(input)
  }
  @IpcMethod()
  async recordCreated(input: Parameters<E2eeWorkspaceRuntime['recordCreated']>[0]) {
    sender()
    const captured = { ...input }
    return recordDesktopE2eeCreated(captured)
  }
  @IpcMethod()
  async open(
    workspaceId: string,
    observed?: Parameters<E2eeWorkspaceRuntime['open']>[1],
    expectedAccountId?: string
  ) {
    const id = sender()
    const identity =
      expectedAccountId === undefined
        ? undefined
        : getIpcServiceDeps().authService.getCachedSessionIdentity()
    if (expectedAccountId !== undefined && identity?.userId !== expectedAccountId)
      throw new Error('e2ee_account_mismatch')
    let accountId: string | undefined
    return withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(
          function* (this: E2eeIpc) {
            accountId = owner.accountId
            const status = yield* owner.host.open(workspaceId, observed)
            const latest =
              expectedAccountId === undefined
                ? undefined
                : getIpcServiceDeps().authService.getCachedSessionIdentity()
            if (
              expectedAccountId !== undefined &&
              (latest?.userId !== expectedAccountId || latest?.generation !== identity?.generation)
            )
              return yield* Effect.fail(new Error('e2ee_account_mismatch'))
            const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
            readers.set(id, (readers.get(id) ?? 0) + 1)
            owner.readers.set(workspaceId, readers)
            return expectedAccountId === undefined
              ? status
              : { ...status, readerOwner: this.readerOwner(owner) }
          }.bind(this)
        ),
      workspaceId,
      false
    ).catch(async (error) => {
      if (!(error instanceof Error) || error.message !== 'e2ee_member_removed' || !accountId)
        throw error
      await cleanupRemovedDesktopWorkspace({ accountId, workspaceId }).catch((cause) => {
        this.pairingFailure = cause
        if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== accountId)
          throw new Error('e2ee_account_mismatch')
      })
      throw error
    })
  }
  @IpcMethod()
  async close(workspaceId: string, expectedAccountId?: string, readerOwner?: string) {
    const id = sender()
    if (
      expectedAccountId !== undefined &&
      getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== expectedAccountId
    )
      return
    const ownsReader = (owner: object) =>
      readerOwner === undefined || this.readerOwner(owner) === readerOwner
    const cleanup = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (expectedAccountId !== undefined && owner.accountId !== expectedAccountId)
            return Effect.void
          if (!ownsReader(owner)) return Effect.void
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
        }),
      workspaceId,
      false
    )
    await Effect.runPromise(cleanup).catch(() => {
      throw new Error(
        'e2ee_restart-required: Restart Lody to finish releasing encrypted resources.'
      )
    })
  }
  /** Account-bound local identity read; never grants renderer status/content access. */
  @IpcMethod()
  async readIdentity(input: { accountId: string; workspaceId: string }) {
    sender()
    if (!input || typeof input.accountId !== 'string' || typeof input.workspaceId !== 'string')
      throw new Error('e2ee_invalid-input')
    const { accountId, workspaceId } = input
    const captured = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (owner.accountId !== accountId)
            return yield* Effect.fail(new Error('e2ee_account_mismatch'))
          const status = yield* owner.host.open(workspaceId)
          // The account lock protects this temporary read. Existing window readers
          // keep their host; otherwise detach here and drain outside that lock.
          const cleanup = owner.readers.get(workspaceId)?.size
            ? Effect.void
            : yield* owner.host.beginCloseWorkspace(workspaceId)
          return {
            identity: { workspaceId: status.workspaceId, genesisHash: status.genesisHash },
            cleanup
          }
        }),
      workspaceId,
      false
    )
    await Effect.runPromise(captured.cleanup).catch(() => {
      throw new Error('e2ee_cleanup_failed')
    })
    return captured.identity
  }
  @IpcMethod()
  async managementState(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.managementState(workspaceId)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  private async manage(
    workspaceId: string,
    command: import('../../services/e2ee-management.mjs').DesktopE2eeManagementCommand
  ) {
    const id = sender()
    const cloud = await desktopE2eeCloudClient()
    const access = await withDesktopE2eeAccount(
      (owner) =>
        Effect.gen(function* () {
          if (owner.accountId !== cloud.accountId || !owner.readers.get(workspaceId)?.has(id))
            return yield* Effect.fail(new Error('e2ee_not_open'))
          const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
          return {
            accountId: owner.accountId,
            credential,
            status: yield* owner.host.status(workspaceId),
            work: owner.host.manage(workspaceId, command, (signal) => ({
              log: cloud.client.ledgerLog(workspaceId, signal),
              staging: (round) => cloud.client.staging({ workspaceId, credential }, signal, round),
              history: (request) => cloud.client.history(request, signal),
              mailbox: () => cloud.client.mailbox({ workspaceId, credential }, signal)
            }))
          }
        }),
      workspaceId,
      false
    )
    const result = await runDesktopE2eeOperation(access.accountId, access.work).catch(
      async (error) => {
        this.pairingFailure = error
        // Native work has settled. Credential diagnosis and terminal cleanup may
        // now re-enter the account coordinator without waiting on their own owner.
        try {
          await Effect.runPromise(
            cloud.client.contentStreamsToken({ workspaceId, credential: access.credential })
          )
        } catch (checked) {
          if (checked instanceof E2eeMemberRemovedError) return this.removeLocalWorkspace(access)
        }
        throw error
      }
    )
    if (result === 'Conflict')
      throw new Error(
        command.type === 'removeMember' || command.type === 'setRole'
          ? 'e2ee_member_management_conflict'
          : 'e2ee_management_conflict'
      )
  }
  @IpcMethod()
  async updateKeys(workspaceId: string) {
    await this.manage(workspaceId, { type: 'rotate' })
  }
  @IpcMethod()
  async revokeDevice(workspaceId: string, signingPublicKey: string) {
    if (typeof signingPublicKey !== 'string' || !/^[0-9a-f]{64}$/.test(signingPublicKey))
      throw new Error('e2ee_invalid-input')
    await this.manage(workspaceId, { type: 'revoke', target: signingPublicKey })
  }
  @IpcMethod()
  async status(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.status(workspaceId)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async ingestLedgerRecords(
    workspaceId: string,
    page: Parameters<E2eeWorkspaceRuntime['ingestLedgerRecords']>[1]
  ) {
    const id = sender()
    const captured = await withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? Effect.succeed({
              accountId: owner.accountId,
              work: owner.host.ingestLedgerRecords(workspaceId, page)
            })
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
    return runDesktopE2eeOperation(captured.accountId, captured.work)
  }
  @IpcMethod()
  async ledgerView(workspaceId: string) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.ledgerView(workspaceId)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
}
