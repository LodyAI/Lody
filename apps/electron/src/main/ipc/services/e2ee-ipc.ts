import {
  id as sharingId,
  generation as sharingGeneration,
  requestId as sharingRequestId,
  sharingChangeSchema
} from '@lody/e2ee-machine-sharing/schemas'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError
} from '../../services/e2ee-cloud-errors.mjs'
import { Effect, Exit } from 'effect'
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
  inspectDesktopE2eeCachedState,
  withDesktopE2eeAccount,
  cleanupRemovedDesktopWorkspace,
  publicAccessLoss,
  desktopAccountPairingDatabase
} from '../../services/e2ee-account-runtime'
import {
  makeDesktopAccountPairingHost,
  type AccountPairingCloud,
  type AccountPairingWorkspaceHint
} from '../../services/e2ee-account-pairing-host.mjs'
import { assertProductWindowSender } from '../assert-sender'
import { observeClientLossOperation } from '../../services/e2ee-client-loss-probe'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { PersonalPairingOfferSchema } from '../../services/e2ee-personal-pairing.mjs'
import { LocalE2eeRecoveryFailureSchema } from '@lody/shared/e2ee-local-pairing'
import type { E2eeJoinSession, E2eePersonalPairingOffer } from '@lody/cloud-api'
import type {
  E2eeMemberOffer,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest
} from '@lody/cloud-api'
import { MemberOfferSchema, decodeMemberKeyPackage } from '../../services/e2ee-member-join.mjs'

/** Only the typed, credential-authenticated cloud results are terminal access loss. */
type AccessLoss = 'member_removed' | 'device_revoked'
const accessLoss = (error: unknown): AccessLoss | null =>
  error instanceof E2eeMemberRemovedError
    ? 'member_removed'
    : error instanceof E2eeDeviceRevokedError
      ? 'device_revoked'
      : publicAccessLoss(error)
/** Exact local outcomes the sender gate needs at once; they never need a credential check. */
const definitiveDispatchRefusals = new Set([
  'e2ee_machine_not_shared',
  'e2ee_machine_not_owned',
  'e2ee_invalid-input'
])
const isAccessLossMessage = (error: unknown) =>
  error instanceof Error &&
  (error.message === 'e2ee_member_removed' || error.message === 'e2ee_device_revoked')
const observedSenders = new WeakSet<Electron.WebContents>()
function pairingSession(value: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value))
    throw new Error('e2ee_invalid-input')
}
/** Routing hints from the renderer's workspace list; every genesis is still verified. */
function pairingHints(value: unknown): AccountPairingWorkspaceHint[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('e2ee_invalid-input')
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.workspaceId !== 'string' ||
      item.workspaceId.length === 0 ||
      item.workspaceId.length > 256 ||
      typeof item.name !== 'string' ||
      item.name.length > 256 ||
      typeof item.genesisHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.genesisHash)
    )
      throw new Error('e2ee_invalid-input')
    return { workspaceId: item.workspaceId, name: item.name, genesisHash: item.genesisHash }
  })
}
/** The journal holds no secret, but stays private to this user like the rest of E2EE state. */
function openPairingDatabase(path: string) {
  const db = new DatabaseSync(path)
  chmodSync(path, 0o600)
  return db
}
function liveAccountPairingCloud(accountId: string): AccountPairingCloud {
  const current = Effect.flatMap(
    Effect.tryPromise({ try: () => desktopE2eeCloudClient(), catch: (error) => error }),
    (cloud) =>
      cloud.accountId === accountId
        ? Effect.succeed(cloud.client)
        : Effect.fail(new Error('e2ee_account_mismatch'))
  )
  return {
    accountIdentity: () => Effect.flatMap(current, (client) => client.accountIdentity()),
    history: (request) => Effect.flatMap(current, (client) => client.history(request)),
    appendRecord: (request) => Effect.flatMap(current, (client) => client.appendRecord(request)),
    keyServices: (access) =>
      Effect.map(current, (client) => ({
        mailbox: (signal: AbortSignal) => client.mailbox(access, signal),
        staging: (signal: AbortSignal) => client.staging(access, signal),
        history: (signal: AbortSignal) => (request: E2eeWorkspaceHistoryRequest) =>
          client.history(request, signal)
      })),
    pairingSubmit: (request) => Effect.flatMap(current, (client) => client.pairingSubmit(request)),
    pairingRead: (request) => Effect.flatMap(current, (client) => client.pairingRead(request)),
    pairingDecline: (request) =>
      Effect.flatMap(current, (client) => client.pairingDecline(request)),
    pairingPublish: (request) =>
      Effect.flatMap(current, (client) => client.pairingPublish(request)),
    pairingClaim: (request) => Effect.flatMap(current, (client) => client.pairingClaim(request))
  }
}
const PAIRING_REFUSALS = new Set([
  'pairing-tampered',
  'pairing-expired',
  'pairing-used',
  // Relay refusals the new device explains: switched off on this deployment, or
  // too many new requests this hour.
  'pairing-unavailable',
  'pairing-rate-limited',
  'invalid-input'
])
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
/** Main-owned reader for background member key delivery; renderer webContents ids start at 1. */
const KEY_DELIVERY_READER = 0
/** Main-owned reader for a joined member's first full round after its key is installed. */
const MEMBER_SETTLE_READER = -1
const KEY_DELIVERY_RETRY_MS = 10_000
const KEY_DELIVERY_RETRY_MAX_MS = 5 * 60_000
const KEY_DELIVERY_RETAINED = 32
/** Only permanent causes end delivery from this device: access loss, a missing binding
 * or a restart-required owner. A closed workspace reopens on the next round. */
const TERMINAL_KEY_DELIVERY = new Set([
  'e2ee_member_removed',
  'e2ee_device_revoked',
  'e2ee_missing-binding',
  'e2ee_restart-required'
])
const TERMINAL_KEY_DELIVERY_CODES = new Set(['missing-binding', 'restart-required'])
/** The admission is not in this device's verified ledger yet, so no round targets it. */
const KEY_DELIVERY_NOT_INGESTED = 'e2ee_admission_not_ingested'
/** The delivery round ended by an unexpected exception before recording an outcome. */
const KEY_DELIVERY_INTERRUPTED = 'e2ee_key_delivery_interrupted'
type MemberKeyDelivery = {
  state: 'pending' | 'delivering' | 'delivered' | 'failed'
  /** Signing key from the verified KeyPackage; '' if it could not be decoded. */
  device: string
  code?: string
  attempts: number
  retryAt: number
}
/** Public reason code only: never key bytes, tokens, causes or plaintext. */
const keyDeliveryCode = (cause: unknown) => {
  const loss = accessLoss(cause)
  if (loss) return `e2ee_${loss}`
  const message = cause instanceof Error ? cause.message : ''
  // Some public messages append guidance after the code (`e2ee_restart-required: …`).
  return /^(e2ee_[a-z0-9_-]{1,64})(?=$|:)/.exec(message)?.[1] ?? 'e2ee_key_delivery_failed'
}
/** A key round reports phase failures inside WorkspaceKeyRoundFailure Results, which the
 * account boundary's public projection does not unwrap. Find a terminal cause before it. */
function terminalKeyRoundCause(error: unknown): Error | null {
  const pending: unknown[] = [error]
  for (let visited = 0; pending.length > 0 && visited < 64; visited++) {
    const node = pending.shift()
    if (!node || typeof node !== 'object') continue
    if (node instanceof E2eeMemberRemovedError || node instanceof E2eeDeviceRevokedError)
      return node
    const code = (node as { code?: unknown }).code ?? (node as { reason?: unknown }).reason
    if (typeof code === 'string' && TERMINAL_KEY_DELIVERY_CODES.has(code))
      return Object.assign(new Error(`e2ee_${code}`), { code })
    for (const key of ['cause', 'failure', 'receive', 'distribution', 'reportsAfterSend'])
      pending.push((node as Record<string, unknown>)[key])
  }
  return null
}
const keyDeliveryDevice = (keyPackageHex: string) => {
  try {
    return Buffer.from(
      decodeMemberKeyPackage(keyPackageHex).request.signingPublicKey.toBytes()
    ).toString('hex')
  } catch {
    return ''
  }
}
/** Log correlation only: a short hash of the request id, never the id, keys or tokens. */
const requestTag = (requestId: string) =>
  createHash('sha256').update(requestId).digest('hex').slice(0, 12)
/** Allow-listed delivery/claim diagnostics for the desktop daily log. */
const logMemberKeys = (
  event: 'key-delivery' | 'member-claim',
  requestId: string,
  fields: { state?: string; phase?: string; code?: string }
) => console.info(`[E2EE] ${event}`, { request: requestTag(requestId), ...fields })
const keyDeliveryView = (requestId: string, delivery: MemberKeyDelivery) => ({
  requestId,
  state: delivery.state,
  ...(delivery.state === 'failed' && delivery.code ? { code: delivery.code } : {})
})
/** Explicit operations only: no arbitrary signing, secret export or unbound identity generation. */
export class E2eeIpc extends IpcService {
  static override readonly groupName = 'e2ee'
  // The decorator logs rejected errors. Retain only the latest local diagnostic
  // here, never on the cause-bearing Error passed to that logging/IPC boundary.
  private pairingFailure: unknown
  private readonly readerOwners = new WeakMap<object, string>()
  // Member key delivery after admission is owned here, not by a renderer request.
  // One in-flight round per account/workspace; failures keep a public code and are
  // retried by the next due poll (email admission worker or team settings).
  private keyDeliveryNow = () => Date.now()
  private readonly keyDeliveries = new Map<
    string,
    { requests: Map<string, MemberKeyDelivery>; running?: Promise<void>; again: boolean }
  >()
  private keyDeliverySlot(accountId: string, workspaceId: string) {
    const key = `${accountId}\n${workspaceId}`
    let slot = this.keyDeliveries.get(key)
    if (!slot) {
      slot = { requests: new Map(), again: false }
      this.keyDeliveries.set(key, slot)
    }
    return slot
  }
  /** Synchronization point for the owning tests; production callers never await delivery.
   * Protected, not public: public instance methods are renderer-facing IPC. */
  protected keyDeliveryIdle(accountId: string, workspaceId: string) {
    return this.keyDeliveries.get(`${accountId}\n${workspaceId}`)?.running ?? Promise.resolve()
  }
  private trackKeyDelivery(
    accountId: string,
    workspaceId: string,
    requestId: string,
    device: string
  ) {
    const slot = this.keyDeliverySlot(accountId, workspaceId)
    slot.requests.delete(requestId)
    slot.requests.set(requestId, { state: 'pending', device, attempts: 0, retryAt: 0 })
    logMemberKeys('key-delivery', requestId, { state: 'pending' })
    while (slot.requests.size > KEY_DELIVERY_RETAINED) {
      const settled = [...slot.requests].find(([, delivery]) => delivery.state === 'delivered')
      slot.requests.delete(settled?.[0] ?? slot.requests.keys().next().value!)
    }
    void this.runKeyDelivery(accountId, workspaceId)
    return slot.requests.get(requestId)!.state
  }
  private retryDueKeyDeliveries(accountId: string, workspaceId: string) {
    const slot = this.keyDeliveries.get(`${accountId}\n${workspaceId}`)
    if (!slot || slot.running) return
    const now = this.keyDeliveryNow()
    if (
      [...slot.requests.values()].some(
        (delivery) =>
          delivery.state === 'pending' ||
          (delivery.state === 'failed' &&
            delivery.retryAt <= now &&
            !TERMINAL_KEY_DELIVERY.has(delivery.code ?? ''))
      )
    )
      void this.runKeyDelivery(accountId, workspaceId)
  }
  /** Never rejects: every outcome is recorded on the covered requests. */
  private runKeyDelivery(accountId: string, workspaceId: string): Promise<void> {
    const slot = this.keyDeliverySlot(accountId, workspaceId)
    if (slot.running) {
      slot.again = true
      return slot.running
    }
    const running = (async () => {
      // A request admitted during a round gets one follow-up pass; later ones wait for a poll.
      for (let pass = 0; pass < 2; pass++) {
        slot.again = false
        const coveredEntries = [...slot.requests].filter(
          ([, delivery]) =>
            delivery.state !== 'delivered' && !TERMINAL_KEY_DELIVERY.has(delivery.code ?? '')
        )
        const covered = coveredEntries.map(([, delivery]) => delivery)
        const idOf = new Map(coveredEntries.map(([requestId, delivery]) => [delivery, requestId]))
        if (covered.length === 0) return
        for (const delivery of covered) {
          delivery.state = 'delivering'
          delete delivery.code
          logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'delivering' })
        }
        const retry = (delivery: MemberKeyDelivery, code: string) => {
          delivery.attempts += 1
          delivery.state = 'failed'
          delivery.code = code
          logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'failed', code })
          delivery.retryAt =
            this.keyDeliveryNow() +
            Math.min(
              KEY_DELIVERY_RETRY_MS * 2 ** (delivery.attempts - 1),
              KEY_DELIVERY_RETRY_MAX_MS
            )
        }
        let evidence: Map<string, string>
        try {
          evidence = await this.deliverMemberKeys(
            accountId,
            workspaceId,
            new Set(covered.map((delivery) => delivery.device))
          )
        } catch (cause) {
          this.pairingFailure = cause
          const code = keyDeliveryCode(cause)
          // Terminal: this device can no longer deliver; drop the slot, never retry.
          if (TERMINAL_KEY_DELIVERY.has(code)) {
            for (const delivery of covered)
              logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'ended', code })
            if (this.keyDeliveries.get(`${accountId}\n${workspaceId}`) === slot)
              this.keyDeliveries.delete(`${accountId}\n${workspaceId}`)
            return
          }
          for (const delivery of covered) retry(delivery, code)
          return
        }
        // Delivered only on positive per-device evidence; every other outcome retries.
        for (const delivery of covered) {
          const outcome = evidence.get(delivery.device) ?? KEY_DELIVERY_NOT_INGESTED
          if (outcome !== 'delivered') {
            retry(delivery, outcome)
            continue
          }
          delivery.state = 'delivered'
          delivery.attempts = 0
          logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'delivered' })
        }
        if (!slot.again) return
      }
    })()
      .catch((cause) => {
        this.pairingFailure = cause
      })
      .finally(() => {
        slot.running = undefined
        // An unexpected exception must not leave a request shown as sending forever:
        // anything still delivering becomes retryable on the next due poll.
        let now = 0
        try {
          now = this.keyDeliveryNow()
        } catch {
          /* A broken clock makes the retry due at once rather than never. */
        }
        for (const [requestId, delivery] of slot.requests) {
          if (delivery.state !== 'delivering') continue
          delivery.attempts += 1
          delivery.state = 'failed'
          delivery.code = KEY_DELIVERY_INTERRUPTED
          delivery.retryAt =
            now +
            Math.min(
              KEY_DELIVERY_RETRY_MS * 2 ** (delivery.attempts - 1),
              KEY_DELIVERY_RETRY_MAX_MS
            )
          try {
            logMemberKeys('key-delivery', requestId, {
              state: 'failed',
              code: KEY_DELIVERY_INTERRUPTED
            })
          } catch {
            /* Diagnostics never block the reset. */
          }
        }
      })
    slot.running = running
    return running
  }
  /** One key round under a main-owned reader, so closing every window cannot stop it.
   * Ingests relay history first, runs the round for devices the local verified ledger
   * targets, then returns per-device evidence: 'delivered' or a retryable code. */
  private async deliverMemberKeys(accountId: string, workspaceId: string, devices: Set<string>) {
    const scope = this.memberScope(workspaceId)
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== accountId) throw new Error('e2ee_account_mismatch')
    await scope((owner) =>
      owner.accountId === accountId
        ? Effect.gen(function* () {
            yield* owner.host.open(workspaceId)
            const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
            readers.set(KEY_DELIVERY_READER, (readers.get(KEY_DELIVERY_READER) ?? 0) + 1)
            owner.readers.set(workspaceId, readers)
          })
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    try {
      try {
        await this.ingestForKeyDelivery(accountId, workspaceId, scope, cloud)
      } catch (cause) {
        // A lagging relay leaves targets unconfirmed below; only terminal causes stop here.
        if (TERMINAL_KEY_DELIVERY.has(keyDeliveryCode(cause))) throw cause
        this.pairingFailure = cause
      }
      const evidence = new Map<string, string>()
      const targets: string[] = []
      for (const device of devices)
        if (device && (await scope((owner) => owner.host.keyDeliveryTarget(workspaceId, device))))
          targets.push(device)
        else evidence.set(device, KEY_DELIVERY_NOT_INGESTED)
      if (targets.length === 0) return evidence
      const credential = await scope((owner) => owner.bootstrap.deviceCredential(workspaceId))
      const mailbox = (signal: AbortSignal) =>
        cloud.client.mailbox({ workspaceId, credential }, signal)
      // Distribution only: this device's own receive and repair run in full rounds.
      const work = await scope((owner) =>
        Effect.succeed(
          owner.host
            .distributeKeys(workspaceId, mailbox)
            .pipe(Effect.mapError((error) => terminalKeyRoundCause(error) ?? error))
        )
      )
      await runDesktopE2eeOperation(accountId, work)
      // A successful round is not evidence: an ineligible sender, a blocked target or a
      // joined round all succeed. Ask the mailbox per device, outside the account lock.
      for (const device of targets) {
        const check = await scope((owner) =>
          Effect.succeed(owner.host.keyDeliveryEvidence(workspaceId, device, mailbox))
        )
        evidence.set(device, await runDesktopE2eeOperation(accountId, check))
      }
      return evidence
    } finally {
      try {
        const cleanup = await scope((owner) =>
          Effect.gen(function* () {
            const readers = owner.readers.get(workspaceId)
            const count = readers?.get(KEY_DELIVERY_READER) ?? 0
            if (count > 1) readers!.set(KEY_DELIVERY_READER, count - 1)
            else readers?.delete(KEY_DELIVERY_READER)
            if (readers?.size === 0) {
              const drain = yield* owner.host.beginCloseWorkspace(workspaceId)
              owner.readers.delete(workspaceId)
              return drain
            }
            return Effect.void
          })
        )
        await runDesktopE2eeOperation(accountId, cleanup)
      } catch (cause) {
        this.pairingFailure = cause
      }
    }
  }
  /** Main-owned ledger ingest: the renderer reader that ran the approval may be gone. */
  private async ingestForKeyDelivery(
    accountId: string,
    workspaceId: string,
    scope: ReturnType<E2eeIpc['memberScope']>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>
  ) {
    const status = await scope((owner) => owner.host.status(workspaceId))
    const after = status.position ?? undefined
    let cursor: string | undefined
    let checkpoint: import('@lody/cloud-api').E2eeLedgerCheckpoint | undefined
    for (let index = 0; index < 256; index++) {
      const page = await Effect.runPromise(
        cloud.client.history({
          workspaceId,
          ...(cursor ? { cursor, checkpoint } : after ? { after } : {})
        })
      )
      checkpoint ??= page.checkpoint
      const ingest = await scope((owner) =>
        Effect.succeed(owner.host.ingestLedgerRecords(workspaceId, page))
      )
      await runDesktopE2eeOperation(accountId, ingest)
      if (!page.nextCursor) return
      cursor = page.nextCursor
    }
  }
  private readonly settling = new Map<string, Promise<void>>()
  /** Synchronization point for the owning tests; claims never await settlement. */
  protected memberSettleIdle(accountId: string, workspaceId: string) {
    return this.settling.get(`${accountId}\n${workspaceId}`) ?? Promise.resolve()
  }
  /** After a member's claim installs its key: one full round under a main-owned reader
   * flushes its installation report and runs distribution/repair, off the ready path. */
  private async settleMemberInstall(
    accountId: string,
    workspaceId: string,
    scope: ReturnType<E2eeIpc['memberScope']>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>
  ) {
    const key = `${accountId}\n${workspaceId}`
    if (this.settling.has(key)) return
    this.settling.set(key, Promise.resolve())
    try {
      await scope((owner) =>
        owner.accountId === accountId
          ? Effect.sync(() => {
              const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
              readers.set(MEMBER_SETTLE_READER, (readers.get(MEMBER_SETTLE_READER) ?? 0) + 1)
              owner.readers.set(workspaceId, readers)
            })
          : Effect.fail(new Error('e2ee_account_mismatch'))
      )
    } catch (cause) {
      this.settling.delete(key)
      this.pairingFailure = cause
      return
    }
    const settled = (async () => {
      try {
        const work = await scope((owner) =>
          Effect.map(owner.bootstrap.deviceCredential(workspaceId), (credential) =>
            owner.host.keyRound(
              workspaceId,
              (signal) => cloud.client.mailbox({ workspaceId, credential }, signal),
              (signal) => cloud.client.staging({ workspaceId, credential }, signal),
              (signal) => (request) => cloud.client.history(request, signal)
            )
          )
        )
        await runDesktopE2eeOperation(accountId, work)
      } catch (cause) {
        // The key is installed; a later full round retries the report and distribution.
        this.pairingFailure = cause
      } finally {
        await this.releaseMainReader(accountId, workspaceId, scope, MEMBER_SETTLE_READER)
        this.settling.delete(key)
      }
    })()
    this.settling.set(key, settled)
  }
  /** Drop one main-owned reader; the last reader out drains and closes the workspace. */
  private async releaseMainReader(
    accountId: string,
    workspaceId: string,
    scope: ReturnType<E2eeIpc['memberScope']>,
    reader: number
  ) {
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
      await runDesktopE2eeOperation(accountId, cleanup)
    } catch (cause) {
      this.pairingFailure = cause
    }
  }
  private readerAccount(workspaceId: string, reader: number) {
    return this.memberScope(workspaceId)((owner) =>
      owner.readers.get(workspaceId)?.has(reader)
        ? Effect.succeed(owner.accountId)
        : Effect.fail(new Error('e2ee_not_open'))
    )
  }
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
      if (accessLoss(error)) return this.removeLocalWorkspace(access, accessLoss(error)!)
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
    // The admission worker and team settings poll here; that drives due delivery retries.
    this.retryDueKeyDeliveries(access.accountId, workspaceId)
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
        if (accessLoss(cause)) return this.removeLocalWorkspace(access, accessLoss(cause)!)
        primary = cause
      }
    }
    // A lost ACK is reconciled from genuine ledger history, never by signing again.
    // Ledger ingest only: key delivery must not hold the admission result.
    try {
      await this.refresh(workspaceId, { installKeys: false })
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
    // Delivery continues in main and cannot undo admission; its state is readable below.
    const keyDelivery = this.trackKeyDelivery(
      access.accountId,
      workspaceId,
      requestId,
      keyDeliveryDevice(material.keyPackageHex)
    )
    return { admitted: true, keyPending: true, keyDelivery }
  }
  @IpcMethod()
  async memberKeyDeliveries(workspaceId: string) {
    const accountId = await this.readerAccount(workspaceId, sender())
    this.retryDueKeyDeliveries(accountId, workspaceId)
    const slot = this.keyDeliveries.get(`${accountId}\n${workspaceId}`)
    return {
      items: [...(slot?.requests ?? [])].map(([requestId, delivery]) =>
        keyDeliveryView(requestId, delivery)
      )
    }
  }
  @IpcMethod()
  async retryMemberKeyDelivery(workspaceId: string, requestId: string) {
    if (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId))
      throw new Error('e2ee_invalid-input')
    const accountId = await this.readerAccount(workspaceId, sender())
    const delivery = this.keyDeliveries.get(`${accountId}\n${workspaceId}`)?.requests.get(requestId)
    if (!delivery) throw new Error('e2ee_invalid-input')
    // An explicit retry skips the backoff wait, never the terminal access-loss result.
    if (delivery.state === 'failed') delivery.retryAt = 0
    void this.runKeyDelivery(accountId, workspaceId)
    return keyDeliveryView(requestId, delivery)
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
    // Already committed and accepted here for this exact request: the verified history is
    // local, so a retry only needs this device's key (no relay claim, history or accept).
    const accepted = await scope((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.acceptedMemberJoin(workspaceId)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    if (accepted === requestId)
      return this.readyMemberJoin(workspaceId, requestId, reader, scope, cloud, [], true)
    const result = await Effect.runPromise(cloud.client.memberClaim({ workspaceId, requestId }))
    if (
      result.accountId !== cloud.accountId ||
      result.workspaceId !== workspaceId ||
      result.requestId !== requestId
    )
      throw new Error('e2ee_conflict')
    if (result.state !== 'committed') {
      logMemberKeys('member-claim', requestId, { phase: 'relay', state: result.state })
      return { ready: false, state: result.state }
    }
    const pages = await this.permissionHistory(workspaceId, cloud)
    await scope((owner) =>
      owner.accountId === cloud.accountId
        ? owner.bootstrap.acceptMemberJoin(workspaceId, pages)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
    return this.readyMemberJoin(workspaceId, requestId, reader, scope, cloud, pages, false)
  }
  private async readyMemberJoin(
    workspaceId: string,
    requestId: string,
    reader: number,
    scope: ReturnType<E2eeIpc['memberScope']>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>,
    pages: E2eeWorkspaceHistoryPage[],
    catchUp: boolean
  ) {
    const earlier = this.pairingFailure
    const ready = await this.installMemberJoin(workspaceId, reader, scope, cloud, pages, catchUp)
    // Ready only reports a current epoch key the native host installed itself.
    const failed = this.pairingFailure !== earlier ? this.pairingFailure : undefined
    logMemberKeys('member-claim', requestId, {
      phase: ready ? 'ready' : 'waiting-key',
      state: 'committed',
      ...(!ready && failed ? { code: keyDeliveryCode(failed) } : {})
    })
    return { ready, state: 'committed' as const }
  }
  private async installMemberJoin(
    workspaceId: string,
    reader: number,
    scope: ReturnType<E2eeIpc['memberScope']>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>,
    pages: E2eeWorkspaceHistoryPage[],
    /** The accepted fast path brings no verified pages and must catch up with the relay. */
    catchUp: boolean
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
      // Catch up with the relay first, so ready always means the key of the current
      // epoch. Unconfirmed freshness is not ready.
      if (catchUp)
        try {
          await this.ingestForKeyDelivery(cloud.accountId, workspaceId, scope, cloud)
        } catch (cause) {
          if (isAccessLossMessage(cause)) throw cause
          this.pairingFailure = cause
          return false
        }
      try {
        const access = await this.memberAccess(workspaceId, reader, scope)
        // Receive-only: install this device's key before any distribution or repair,
        // which the full rounds of the opened workspace runtime perform afterwards.
        const work = await scope((owner) =>
          Effect.succeed(
            owner.host.receiveKeys(
              workspaceId,
              (signal) =>
                cloud.client.mailbox({ workspaceId, credential: access.credential }, signal),
              (signal) =>
                cloud.client.staging({ workspaceId, credential: access.credential }, signal)
            )
          )
        )
        await runDesktopE2eeOperation(cloud.accountId, work).catch((cause) => {
          if (accessLoss(cause)) return this.removeLocalWorkspace(access, accessLoss(cause)!)
          throw cause
        })
      } catch (cause) {
        if (isAccessLossMessage(cause)) throw cause
        this.pairingFailure = cause
      }
      const ready = (await scope((owner) => owner.host.status(workspaceId))).hasCurrentKey
      // Hand reports, distribution and repair to main before this reader goes away.
      if (ready) await this.settleMemberInstall(cloud.accountId, workspaceId, scope, cloud)
      return ready
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
  // ----- Account-wide personal device pairing (default off in the renderer) -----

  private accountPairings = new Map<
    string,
    {
      hints: AccountPairingWorkspaceHint[]
      pairing: ReturnType<typeof makeDesktopAccountPairingHost>
    }
  >()
  /** One long-lived workflow per account: it keeps open requests' secrets in memory. */
  private async accountPairing(hints?: AccountPairingWorkspaceHint[]) {
    const cloud = await desktopE2eeCloudClient()
    let current = this.accountPairings.get(cloud.accountId)
    if (!current) {
      const path = desktopAccountPairingDatabase(cloud.accountId)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const holder: { hints: AccountPairingWorkspaceHint[] } = { hints: [] }
      const accountId = cloud.accountId
      current = Object.assign(holder, {
        pairing: makeDesktopAccountPairingHost({
          accountId,
          deviceName: hostname().slice(0, 128) || 'Lody desktop',
          db: openPairingDatabase(path),
          // Resolve the live client per call: a sign-out, switch or reset closes the
          // client this account had, and a cached one would fail every later call.
          cloud: liveAccountPairingCloud(accountId),
          withOwner: (workspaceId, work, create) =>
            withDesktopE2eeAccount((owner) => work(owner), workspaceId, create),
          run: (effect) => runDesktopE2eeOperation(accountId, effect),
          workspaces: () => holder.hints
        })
      })
      this.accountPairings.set(cloud.accountId, current)
    }
    if (hints) current.hints = hints
    return current.pairing
  }
  /** Only the typed refusals the UI explains leave main; causes stay here. */
  private async pairingCall<A>(work: () => Promise<A>): Promise<A> {
    try {
      return await work()
    } catch (error) {
      this.pairingFailure = error
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      // Raw causes stay in main; the IPC decorator logs rejected Errors.
      // eslint-disable-next-line preserve-caught-error
      if (code && PAIRING_REFUSALS.has(code)) throw new Error(`e2ee_${code}`)
      // eslint-disable-next-line preserve-caught-error
      throw new Error('e2ee_host_operation_failed')
    }
  }
  @IpcMethod()
  async requestAccountPairing(input: { pairingString?: string }, workspaces: unknown) {
    sender()
    const hints = pairingHints(workspaces)
    if (input?.pairingString !== undefined && typeof input.pairingString !== 'string')
      throw new Error('e2ee_invalid-input')
    const pairing = await this.accountPairing(hints)
    return this.pairingCall(() =>
      Effect.runPromise(
        pairing.requestAccountPairing(
          input?.pairingString === undefined ? {} : { pairingString: input.pairingString }
        )
      )
    )
  }
  @IpcMethod()
  async accountPairingRequest(workspaces: unknown) {
    sender()
    const pairing = await this.accountPairing(pairingHints(workspaces))
    return this.pairingCall(() => Effect.runPromise(pairing.accountPairingRequest()))
  }
  @IpcMethod()
  async cancelAccountPairing() {
    sender()
    const pairing = await this.accountPairing()
    return this.pairingCall(() => Effect.runPromise(pairing.cancelAccountPairing()))
  }
  @IpcMethod()
  async accountPairingCode() {
    sender()
    const pairing = await this.accountPairing()
    return this.pairingCall(() => Effect.runPromise(pairing.accountPairingCode()))
  }
  @IpcMethod()
  async inspectAccountPairing(pairingString: string, workspaces: unknown) {
    sender()
    if (typeof pairingString !== 'string') throw new Error('e2ee_invalid-input')
    const pairing = await this.accountPairing(pairingHints(workspaces))
    return this.pairingCall(() => Effect.runPromise(pairing.inspectAccountPairing(pairingString)))
  }
  @IpcMethod()
  async approveAccountPairing(
    input: { pairingString: string; requestId: string; workspaceIds: string[] },
    workspaces: unknown
  ) {
    sender()
    if (
      !input ||
      typeof input.pairingString !== 'string' ||
      typeof input.requestId !== 'string' ||
      !Array.isArray(input.workspaceIds) ||
      input.workspaceIds.length > 64 ||
      input.workspaceIds.some((id) => typeof id !== 'string')
    )
      throw new Error('e2ee_invalid-input')
    const pairing = await this.accountPairing(pairingHints(workspaces))
    return this.pairingCall(() =>
      Effect.runPromise(
        pairing.approveAccountPairing({
          pairingString: input.pairingString,
          requestId: input.requestId,
          workspaceIds: [...input.workspaceIds]
        })
      )
    )
  }
  @IpcMethod()
  async declineAccountPairing(
    input: { pairingString: string; requestId: string },
    workspaces: unknown
  ) {
    sender()
    if (!input || typeof input.pairingString !== 'string' || typeof input.requestId !== 'string')
      throw new Error('e2ee_invalid-input')
    const pairing = await this.accountPairing(pairingHints(workspaces))
    return this.pairingCall(() =>
      Effect.runPromise(
        pairing.declineAccountPairing({
          pairingString: input.pairingString,
          requestId: input.requestId
        })
      )
    )
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
    return observeClientLossOperation('refresh', workspaceId, sender(), () =>
      this.refreshLedger(workspaceId, options)
    )
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
          if (accessLoss(checked)) {
            return this.removeLocalWorkspace(access, accessLoss(checked)!)
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
                  cloud.client.staging({ workspaceId, credential: access.credential }, signal),
                (signal) => (request) => cloud.client.history(request, signal)
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
  private async removeLocalWorkspace(
    access: {
      accountId: string
      credential: string
      status: import('@lody/platform').E2eeRuntimeStatus
    },
    reason: AccessLoss
  ): Promise<never> {
    const { workspaceId, genesisHash, signingPublicKey } = access.status
    if (!signingPublicKey) throw new Error('e2ee_local_cleanup_pending')
    let cleanup: Effect.Effect<void, unknown> = Effect.void
    try {
      await withDesktopE2eeAccount(
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
                credential: access.credential,
                reason
              }))
            )
              return yield* Effect.fail(new Error('e2ee_account_mismatch'))
            return undefined
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) || !owner.readers.get(workspaceId)?.size
                ? Effect.map(owner.host.beginCloseWorkspace(workspaceId), (drain) => {
                    cleanup = drain
                  })
                : Effect.void
            )
          ),
        workspaceId,
        false
      )
    } finally {
      await Effect.runPromise(cleanup)
    }
    const deleted = await cleanupRemovedDesktopWorkspace({
      accountId: access.accountId,
      workspaceId,
      reason
    }).catch((cause) => {
      this.pairingFailure = cause
      if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
        throw new Error('e2ee_account_mismatch')
      // Receipt survives a busy process lease or interrupted cleanup; the next open retries it.
      return true
    })
    if (deleted) throw new Error(`e2ee_${reason}`)
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
    requestSnapshotFor?: string,
    rpcOnly?: true
  ) {
    const id = sender()
    return observeClientLossOperation('token', workspaceId, id, () =>
      this.contentStreamsTokenFor(id, workspaceId, rejectedToken, requestSnapshotFor, rpcOnly)
    )
  }
  private async contentStreamsTokenFor(
    id: number,
    workspaceId: string,
    rejectedToken?: string,
    requestSnapshotFor?: string,
    rpcOnly?: true
  ) {
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
        ...(requestSnapshotFor ? { requestSnapshotFor } : {}),
        ...(rpcOnly ? { rpcOnly } : {})
      })
    ).catch((error) => {
      if (accessLoss(error)) return this.removeLocalWorkspace(access, accessLoss(error)!)
      throw error
    })
    if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
      throw new Error('e2ee_account_mismatch')
    return result
  }
  @IpcMethod()
  async seal(workspaceId: string, input: Parameters<E2eeWorkspaceRuntime['seal']>[1]) {
    const id = sender()
    return observeClientLossOperation('seal', workspaceId, id, () =>
      withDesktopE2eeAccount(
        (owner) =>
          owner.readers.get(workspaceId)?.has(id)
            ? owner.host.seal(workspaceId, input)
            : Effect.fail(new Error('e2ee_not_open')),
        workspaceId,
        false
      )
    )
  }
  @IpcMethod()
  async openContent(
    workspaceId: string,
    input: Parameters<E2eeWorkspaceRuntime['openContent']>[1]
  ) {
    const id = sender()
    return observeClientLossOperation('read', workspaceId, id, () =>
      withDesktopE2eeAccount(
        (owner) =>
          owner.readers.get(workspaceId)?.has(id)
            ? owner.host.openContent(workspaceId, input)
            : Effect.fail(new Error('e2ee_not_open')),
        workspaceId,
        false
      )
    )
  }
  /** Passive process-bound evidence; no reader open, cloud access or cache renewal. */
  @IpcMethod()
  async inspectCachedState(workspaceId: string, machineId: string) {
    if (!sharingId.safeParse(workspaceId).success || !sharingId.safeParse(machineId).success)
      throw new Error('e2ee_invalid-input')
    sender()
    const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
    if (!accountId) throw new Error('e2ee_account_unavailable')
    return inspectDesktopE2eeCachedState(accountId, workspaceId, machineId)
  }
  @IpcMethod()
  async readMachineSharing(workspaceId: string, machineId: string) {
    if (!sharingId.safeParse(workspaceId).success || !sharingId.safeParse(machineId).success)
      throw new Error('e2ee_invalid-input')
    const id = sender()
    const cloud = await desktopE2eeCloudClient()
    const access = await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
          ? Effect.succeed({
              accountId: owner.accountId,
              work: owner.host.readMachineSharing(
                workspaceId,
                machineId,
                cloud.client.machineSharing(),
                (request) => cloud.client.history(request)
              )
            })
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
    return runDesktopE2eeOperation(access.accountId, access.work)
  }
  @IpcMethod()
  async updateMachineSharing(
    workspaceId: string,
    machineId: string,
    generation: string,
    requestId: string,
    change: import('@lody/platform').E2eeMachineSharingChange
  ) {
    const parsed = sharingChangeSchema.safeParse(change)
    if (
      !sharingId.safeParse(workspaceId).success ||
      !sharingId.safeParse(machineId).success ||
      !sharingGeneration.safeParse(generation).success ||
      !sharingRequestId.safeParse(requestId).success ||
      !parsed.success
    )
      throw new Error('e2ee_invalid-input')
    const id = sender()
    const cloud = await desktopE2eeCloudClient()
    const access = await withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(id)
          ? Effect.succeed({
              accountId: owner.accountId,
              work: owner.host.updateMachineSharing(
                workspaceId,
                machineId,
                generation,
                requestId,
                parsed.data,
                cloud.client.machineSharing(),
                (request) => cloud.client.history(request)
              )
            })
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
    return runDesktopE2eeOperation(access.accountId, access.work)
  }
  @IpcMethod()
  async prepareFeatureRpc(
    workspaceId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput
  ) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.prepareFeatureRpc(workspaceId, input)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async acceptFeatureRpcResponse(
    workspaceId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput,
    frame: string
  ) {
    const id = sender()
    return withDesktopE2eeAccount(
      (owner) =>
        owner.readers.get(workspaceId)?.has(id)
          ? owner.host.acceptFeatureRpcResponse(workspaceId, input, frame)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  }
  @IpcMethod()
  async prepareDispatch(
    workspaceId: string,
    targetMachineId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeDispatchInput
  ) {
    const id = sender()
    return observeClientLossOperation('prepareDispatch', workspaceId, id, async () => {
      const cloud = await desktopE2eeCloudClient()
      let cleanup: Effect.Effect<void, unknown> = Effect.void
      const access = await (async () => {
        try {
          return await withDesktopE2eeAccount(
            (owner) =>
              owner.accountId === cloud.accountId
                ? Effect.gen(function* () {
                    const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
                    const status = yield* owner.host.status(workspaceId)
                    // A renderer may already have closed after learning ledger loss.
                    // Keep dispatch denied, but let its retained credential confirm why.
                    const work = owner.readers.get(workspaceId)?.has(id)
                      ? owner.host.prepareDispatch(
                          workspaceId,
                          targetMachineId,
                          input,
                          cloud.client.machineSharing(),
                          (request) => cloud.client.history(request)
                        )
                      : Effect.fail(new Error('e2ee_not_open'))
                    return {
                      accountId: owner.accountId,
                      credential,
                      status,
                      work
                    }
                  }).pipe(
                    // Status can open a host even if a later read fails. Capture its
                    // exact drain under the lock; always await it outside the lock.
                    Effect.onExit(() =>
                      owner.readers.get(workspaceId)?.size
                        ? Effect.void
                        : Effect.map(owner.host.beginCloseWorkspace(workspaceId), (drain) => {
                            cleanup = drain
                          })
                    )
                  )
                : Effect.fail(new Error('e2ee_not_open')),
            workspaceId,
            false
          )
        } finally {
          await Effect.runPromise(cleanup)
        }
      })()
      return runDesktopE2eeOperation(access.accountId, access.work).catch(async (error) => {
        if (accessLoss(error)) return this.removeLocalWorkspace(access, accessLoss(error)!)
        // Preparation is local, so it cannot see a removal by itself. Like management,
        // ask the server with this device's credential; only its exact answer is loss.
        if (!(error instanceof Error && definitiveDispatchRefusals.has(error.message))) {
          try {
            await Effect.runPromise(
              cloud.client.contentStreamsToken({ workspaceId, credential: access.credential })
            )
          } catch (checked) {
            if (accessLoss(checked)) return this.removeLocalWorkspace(access, accessLoss(checked)!)
          }
        }
        throw error
      })
    })
  }
  @IpcMethod()
  async acceptDispatchResponse(
    workspaceId: string,
    targetMachineId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeDispatchInput,
    frameHex: string
  ) {
    const id = sender()
    return observeClientLossOperation('dispatchResponse', workspaceId, id, () =>
      withDesktopE2eeAccount(
        (owner) =>
          owner.readers.get(workspaceId)?.has(id)
            ? owner.host.acceptDispatchResponse(workspaceId, targetMachineId, input, frameHex)
            : Effect.fail(new Error('e2ee_not_open')),
        workspaceId,
        false
      )
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
    return observeClientLossOperation('open', workspaceId, id, () =>
      this.openFor(id, workspaceId, observed, expectedAccountId)
    )
  }
  private async openFor(
    id: number,
    workspaceId: string,
    observed?: Parameters<E2eeWorkspaceRuntime['open']>[1],
    expectedAccountId?: string
  ) {
    const identity =
      expectedAccountId === undefined
        ? undefined
        : getIpcServiceDeps().authService.getCachedSessionIdentity()
    if (expectedAccountId !== undefined && identity?.userId !== expectedAccountId)
      throw new Error('e2ee_account_mismatch')
    let accountId: string | undefined
    let proofIdentity: typeof identity
    const openLocal = (proof?: readonly E2eeWorkspaceHistoryPage[]) =>
      withDesktopE2eeAccount(
        (owner) =>
          Effect.gen(
            function* (this: E2eeIpc) {
              if (accountId !== undefined && owner.accountId !== accountId)
                return yield* Effect.fail(new Error('e2ee_account_mismatch'))
              if (proofIdentity) {
                const current = getIpcServiceDeps().authService.getCachedSessionIdentity()
                if (
                  current.userId !== proofIdentity.userId ||
                  current.generation !== proofIdentity.generation
                )
                  return yield* Effect.fail(new Error('e2ee_account_mismatch'))
              }
              accountId = owner.accountId
              const status = yield* owner.host.open(workspaceId, observed, proof)
              const latest =
                expectedAccountId === undefined && !proofIdentity
                  ? undefined
                  : getIpcServiceDeps().authService.getCachedSessionIdentity()
              if (
                expectedAccountId !== undefined &&
                (latest?.userId !== expectedAccountId ||
                  latest?.generation !== identity?.generation)
              )
                return yield* Effect.fail(new Error('e2ee_account_mismatch'))
              if (
                proofIdentity &&
                (latest?.userId !== proofIdentity.userId ||
                  latest?.generation !== proofIdentity.generation)
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
      )
    // Only a missing pre-snapshot proof requests history. A known conflict never retries.
    // Network work stays outside the native account lock and grants no reader on failure.
    return openLocal()
      .catch(async (error) => {
        if (!(error instanceof Error) || error.message !== 'e2ee_snapshot-history-required')
          throw error
        const auth = getIpcServiceDeps().authService
        const before = auth.getCachedSessionIdentity()
        proofIdentity = before
        const cloud = await desktopE2eeCloudClient()
        if (cloud.accountId !== accountId || before.userId !== accountId)
          throw new Error('e2ee_account_mismatch')
        const proof = await this.permissionHistory(workspaceId, cloud)
        const after = auth.getCachedSessionIdentity()
        if (after.userId !== before.userId || after.generation !== before.generation)
          throw new Error('e2ee_account_mismatch')
        return openLocal(proof)
      })
      .catch(async (error) => {
        if (!isAccessLossMessage(error) || !accountId) throw error
        await cleanupRemovedDesktopWorkspace({
          accountId,
          workspaceId,
          reason: (error as Error).message.slice(5) as AccessLoss
        }).catch((cause) => {
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
    return observeClientLossOperation('close', workspaceId, id, () =>
      this.closeFor(id, workspaceId, expectedAccountId, readerOwner)
    )
  }
  private async closeFor(
    id: number,
    workspaceId: string,
    expectedAccountId?: string,
    readerOwner?: string
  ) {
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
          if (accessLoss(checked)) return this.removeLocalWorkspace(access, accessLoss(checked)!)
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
