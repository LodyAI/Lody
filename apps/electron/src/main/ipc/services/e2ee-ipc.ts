import {
  id as sharingId,
  generation as sharingGeneration,
  requestId as sharingRequestId,
  sharingChangeSchema
} from '@lody/e2ee-machine-sharing/schemas'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { open as openFile, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app, BrowserWindow, dialog } from 'electron'
import {
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError
} from '../../services/e2ee-cloud-errors.mjs'
import { Effect, Exit } from 'effect'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { E2eeWorkspaceRuntime } from '@lody/platform'
import type { RecoveryVaultStore } from '@lody/e2ee-core/services'
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
  desktopAccountPairingDatabase,
  desktopE2eeHasWorkspaceIdentity,
  desktopE2eeRecoveryJournalPath
} from '../../services/e2ee-account-runtime'
import {
  makeDesktopAccountPairingHost,
  type AccountPairingCloud,
  type AccountPairingWorkspaceHint
} from '../../services/e2ee-account-pairing-host.mjs'
import {
  MAX_RECOVERY_FILE_BYTES,
  abandonAccountVaultReplacement,
  beginAccountVaultReplacement,
  continueAccountVaultReplacement,
  defaultPasskeyLabel,
  enrollRecoveryPasskey,
  listRecoveryPasskeys,
  passkeyLabel,
  removeRecoveryPasskey,
  createAccountRecoveryVault,
  inspectRecoveryFile,
  recoveryReplacementPlan,
  recoveryRestoreTarget,
  recoveryVaultEnabled,
  recoveryVaultFailure,
  restoreAccountWorkspaces,
  saveRecoveryFile,
  setupWorkspaceRecovery,
  type RecoveryUnlock,
  type RecoveryVaultReplacement,
  type RecoveryWorkspaceTarget
} from '../../services/e2ee-recovery-vault.mjs'
import { desktopPasskeyPort } from '../../services/e2ee-passkey-macos.mjs'
import { assertProductWindowSender } from '../assert-sender'
import { observeClientLossOperation } from '../../services/e2ee-client-loss-probe'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { PersonalPairingOfferSchema } from '../../services/e2ee-personal-pairing.mjs'
import { LocalE2eeRecoveryFailureSchema } from '@lody/shared/e2ee-local-pairing'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
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
type Owner = Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]
type RemovalFence = ReturnType<Owner['fenceLoss']>
type LossAccess = {
  accountId: string
  credential: string
  status: import('@lody/platform').E2eeRuntimeStatus
}
/**
 * A sender without a reader is refused with this identity's durable removal reason
 * when one exists. That receipt is written only after a credential-confirmed loss.
 * Without one the refusal stays the untagged, publicly sanitized `e2ee_not_open`.
 */
const refuseUnopened = (owner: Owner, workspaceId: string) =>
  Effect.flatMap(owner.bootstrap.removedReason(workspaceId), (reason) =>
    Effect.fail(
      reason
        ? Object.assign(new Error(`e2ee_${reason}`), { code: reason })
        : new Error('e2ee_not_open')
    )
  )
const observedSenders = new WeakSet<Electron.WebContents>()
/** Windows that may hold readers; they get a re-read hint when main records a loss. */
const readerWindows = new Map<number, Electron.WebContents>()
const readerLifetimes = new WeakMap<Electron.WebContents, object>()
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
    readerWindows.set(id, event.sender)
    const release = () => {
      readerLifetimes.delete(event.sender)
      releaseDesktopE2eeReader(id)
    }
    event.sender.once('destroyed', () => {
      readerWindows.delete(id)
      release()
    })
    event.sender.on('render-process-gone', release)
    event.sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) release()
    })
  }
  if (!readerLifetimes.has(event.sender)) readerLifetimes.set(event.sender, {})
  return event.sender.id
}
/** Main-owned reader for background member key delivery; renderer webContents ids start at 1. */
const KEY_DELIVERY_READER = 0
/** Main-owned reader for a joined member's first full round after its key is installed. */
const MEMBER_SETTLE_READER = -1
const KEY_DELIVERY_RETRY_MS = 10_000
const KEY_DELIVERY_RETRY_MAX_MS = 5 * 60_000
const KEY_DELIVERY_RETAINED = 32
/** Timer-driven retries per slot after its last new request or explicit retry (about
 * 20 min of backoff). Polls and explicit retries still work after the bound. */
const KEY_DELIVERY_AUTO_RETRIES = 8
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
  // Retain every pending raw cleanup. After failure the native fence still
  // owns the identity; settling this task is not proof of safe handoff.
  private readonly dispatchCleanups = new Map<
    RemovalFence,
    { done: Promise<void>; diagnostic?: unknown }
  >()
  private cleanupDiagnostic(code: 'e2ee_cleanup_pending' | 'e2ee_cleanup_failed', cause?: unknown) {
    const diagnostic = cause ?? Object.assign(new Error(code), { code })
    this.pairingFailure = diagnostic
    try {
      console.warn('[E2EE] access-loss-cleanup', { code })
    } catch {
      /* diagnostic sinks cannot break custody */
    }
    return diagnostic
  }
  private retainDispatchCleanup(access: LossAccess, reason: AccessLoss, fence: RemovalFence) {
    if (fence.completed || this.dispatchCleanups.has(fence)) return
    const slot = { done: Promise.resolve(), diagnostic: undefined as unknown }
    const raw = this.removeLocalWorkspace(access, reason, fence)
    slot.done = raw.then(
      () => undefined,
      (error) => {
        if (fence.completed) {
          this.dispatchCleanups.delete(fence)
          if (this.pairingFailure === slot.diagnostic) this.pairingFailure = undefined
        } else {
          slot.diagnostic = this.cleanupDiagnostic('e2ee_cleanup_failed', fence.failure ?? error)
          this.dispatchCleanups.delete(fence)
        }
      }
    )
    this.dispatchCleanups.set(fence, slot)
    // Diagnostic deadline only: never interrupt raw erase or release its fence.
    void runDesktopE2eeOperation(
      access.accountId,
      Effect.raceFirst(
        Effect.as(
          Effect.promise(() => slot.done),
          false
        ),
        Effect.as(Effect.sleep('5 seconds'), true)
      )
    )
      .then((pending) => {
        if (pending && this.dispatchCleanups.get(fence) === slot && !fence.completed)
          slot.diagnostic = this.cleanupDiagnostic('e2ee_cleanup_pending')
      })
      .catch(() => {
        if (this.dispatchCleanups.get(fence) === slot && !fence.completed)
          slot.diagnostic = this.cleanupDiagnostic('e2ee_cleanup_pending')
      })
  }
  private readonly readerOwners = new WeakMap<object, string>()
  private readonly dispatchReaderTokens = new WeakMap<
    Map<number, number>,
    WeakMap<Electron.WebContents, object>
  >()
  // Member and account-pairing key delivery after admission is owned here, not by a
  // renderer request. One in-flight round per account/workspace; failures keep a public
  // code and are retried by a main-owned due timer (bounded) and by due polls (email
  // admission worker or team settings), so no page has to stay open.
  private keyDeliveryNow = () => Date.now()
  /** Replaceable by the owning tests; the handle never keeps the process alive. */
  private keyDeliveryTimers = {
    set: (run: () => void, ms: number): unknown => {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return timer
    },
    clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
  private readonly keyDeliveries = new Map<
    string,
    {
      requests: Map<string, MemberKeyDelivery>
      running?: Promise<void>
      again: boolean
      timer?: unknown
      autoRetries: number
      /** Set when the slot is dropped: an in-flight round must not open or send. */
      aborted?: boolean
    }
  >()
  private keyDeliverySlot(accountId: string, workspaceId: string) {
    const key = `${accountId}\n${workspaceId}`
    let slot = this.keyDeliveries.get(key)
    if (!slot) {
      slot = { requests: new Map(), again: false, autoRetries: 0 }
      this.keyDeliveries.set(key, slot)
    }
    return slot
  }
  /** Drops a slot and its pending due timer: terminal delivery or a changed account. */
  private dropKeyDeliverySlot(accountId: string, workspaceId: string) {
    const key = `${accountId}\n${workspaceId}`
    const slot = this.keyDeliveries.get(key)
    if (!slot) return
    slot.aborted = true
    if (slot.timer !== undefined) this.keyDeliveryTimers.clear(slot.timer)
    slot.timer = undefined
    this.keyDeliveries.delete(key)
  }
  /** The signed-in account, or undefined when it cannot be read. */
  private keyDeliveryAccount() {
    try {
      return getIpcServiceDeps().authService.getCachedSessionIdentity().userId ?? undefined
    } catch {
      return undefined
    }
  }
  /** Drops every slot of a removed or reset workspace (all accounts when `accountId` is
   * absent, every workspace when `workspaceId` is too): nothing reopens it afterwards. */
  private dropKeyDeliveryWorkspace(workspaceId?: string, accountId?: string) {
    for (const key of [...this.keyDeliveries.keys()]) {
      const [account, workspace] = key.split('\n')
      if (
        (accountId === undefined || account === accountId) &&
        (workspaceId === undefined || workspace === workspaceId)
      )
        this.dropKeyDeliverySlot(account!, workspace!)
    }
  }
  /** Schedules the next round at the earliest retryable failure's `retryAt`, or at once for
   * a request admitted after the last pass began. Bounded per slot; the timer re-checks the
   * signed-in account and drops the slot if it changed. A delivery may reopen a workspace
   * no window is reading (main's reader is held only during a round), but never one that
   * was removed or reset: those drop their slot. */
  private scheduleKeyDeliveryRetry(accountId: string, workspaceId: string) {
    const key = `${accountId}\n${workspaceId}`
    const slot = this.keyDeliveries.get(key)
    if (!slot || slot.running) return
    if (slot.timer !== undefined) this.keyDeliveryTimers.clear(slot.timer)
    slot.timer = undefined
    if (slot.autoRetries >= KEY_DELIVERY_AUTO_RETRIES) return
    const due = [...slot.requests.values()]
      .filter(
        (delivery) =>
          delivery.state === 'pending' ||
          (delivery.state === 'failed' && !TERMINAL_KEY_DELIVERY.has(delivery.code ?? ''))
      )
      .map((delivery) => (delivery.state === 'pending' ? 0 : delivery.retryAt))
    if (due.length === 0) return
    let now = 0
    try {
      now = this.keyDeliveryNow()
    } catch {
      /* A broken clock makes the retry due at once rather than never. */
    }
    slot.timer = this.keyDeliveryTimers.set(
      () => {
        if (this.keyDeliveries.get(key) !== slot) return
        slot.timer = undefined
        let current: string | null | undefined
        try {
          current = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
        } catch {
          current = undefined
        }
        if (current !== accountId) {
          this.dropKeyDeliverySlot(accountId, workspaceId)
          return
        }
        slot.autoRetries += 1
        void this.runKeyDelivery(accountId, workspaceId)
      },
      Math.max(0, Math.min(...due) - now)
    )
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
    slot.autoRetries = 0
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
        // Sign-out or an account change ends this account's delivery at once.
        if (!slot.aborted && this.keyDeliveryAccount() !== accountId)
          this.dropKeyDeliverySlot(accountId, workspaceId)
        if (slot.aborted) return
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
            new Set(covered.map((delivery) => delivery.device)),
            () => slot.aborted === true
          )
        } catch (cause) {
          this.pairingFailure = cause
          if (this.keyDeliveryAccount() !== accountId)
            this.dropKeyDeliverySlot(accountId, workspaceId)
          if (slot.aborted) return
          const code = keyDeliveryCode(cause)
          // Terminal: this device can no longer deliver; drop the slot, never retry.
          if (TERMINAL_KEY_DELIVERY.has(code)) {
            for (const delivery of covered)
              logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'ended', code })
            if (this.keyDeliveries.get(`${accountId}\n${workspaceId}`) === slot)
              this.dropKeyDeliverySlot(accountId, workspaceId)
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
        this.scheduleKeyDeliveryRetry(accountId, workspaceId)
      })
    slot.running = running
    return running
  }
  /** One key round under a main-owned reader, so closing every window cannot stop it.
   * Ingests relay history first, runs the round for devices the local verified ledger
   * targets, then returns per-device evidence: 'delivered' or a retryable code. */
  private async deliverMemberKeys(
    accountId: string,
    workspaceId: string,
    devices: Set<string>,
    aborted: () => boolean = () => false
  ) {
    const scope = this.memberScope(workspaceId)
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== accountId) throw new Error('e2ee_account_mismatch')
    // A removed or reset workspace is never reopened by a round that started earlier;
    // the check runs under the account lock, immediately before the open.
    await scope((owner) =>
      owner.accountId !== accountId
        ? Effect.fail(new Error('e2ee_account_mismatch'))
        : aborted()
          ? Effect.fail(new Error('e2ee_key_delivery_aborted'))
          : Effect.gen(function* () {
              yield* owner.host.open(workspaceId)
              const readers = owner.readers.get(workspaceId) ?? new Map<number, number>()
              readers.set(KEY_DELIVERY_READER, (readers.get(KEY_DELIVERY_READER) ?? 0) + 1)
              owner.readers.set(workspaceId, readers)
            })
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
      if (aborted()) return evidence
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
    // Still paging: this ledger is not confirmed current. Not terminal; a later call resumes.
    throw new Error('e2ee_history_not_caught_up')
  }
  /** Terminal access loss ends local custody: from a typed cause, or, with `confirm`,
   * through this device's credential after another failure. Returns if access remains. */
  private async endOnAccessLoss(
    access: Awaited<ReturnType<E2eeIpc['memberAccess']>>,
    cloud: Awaited<ReturnType<typeof desktopE2eeCloudClient>>,
    cause: unknown,
    confirm: boolean
  ) {
    let loss = accessLoss(cause)
    if (!loss && confirm)
      try {
        await Effect.runPromise(
          cloud.client.contentStreamsToken({
            workspaceId: access.workspaceId,
            credential: access.credential
          })
        )
      } catch (checked) {
        loss = accessLoss(checked)
      }
    if (loss) await this.removeLocalWorkspace(access, loss)
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
        : refuseUnopened(owner, workspaceId)
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
          return yield* refuseUnopened(owner, workspaceId)
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
    // Member admissions use 32-hex ids; account pairing keeps its journaled admission id.
    if (
      typeof requestId !== 'string' ||
      !/^(?:[0-9a-f]{32}|account-device-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
        requestId
      )
    )
      throw new Error('e2ee_invalid-input')
    const accountId = await this.readerAccount(workspaceId, sender())
    const delivery = this.keyDeliveries.get(`${accountId}\n${workspaceId}`)?.requests.get(requestId)
    if (!delivery) throw new Error('e2ee_invalid-input')
    // An explicit retry skips the backoff wait, never the terminal access-loss result.
    if (delivery.state === 'failed') delivery.retryAt = 0
    const slot = this.keyDeliveries.get(`${accountId}\n${workspaceId}`)
    if (slot) slot.autoRetries = 0
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
      if (catchUp) {
        let access: Awaited<ReturnType<E2eeIpc['memberAccess']>> | undefined
        try {
          access = await this.memberAccess(workspaceId, reader, scope)
          await this.ingestForKeyDelivery(cloud.accountId, workspaceId, scope, cloud)
        } catch (cause) {
          // A refused catch-up may be removal: confirm with this device's credential.
          if (access) await this.endOnAccessLoss(access, cloud, cause, true)
          if (isAccessLossMessage(cause)) throw cause
          this.pairingFailure = cause
          return false
        }
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
        await runDesktopE2eeOperation(cloud.accountId, work).catch(async (cause) => {
          await this.endOnAccessLoss(access, cloud, cause, false)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
          workspaces: () => holder.hints,
          // The same main-owned delivery as a member approval: distribute-only round,
          // per-device mailbox evidence, backoff retry and `memberKeyDeliveries` status.
          deliverKeys: (workspaceId, requestId, device) => {
            this.trackKeyDelivery(accountId, workspaceId, requestId, device)
          }
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
            return yield* refuseUnopened(owner, workspaceId)
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
    reason: AccessLoss,
    retiring?: RemovalFence
  ): Promise<never> {
    const { workspaceId, genesisHash, signingPublicKey } = access.status
    // A removed workspace ends its key delivery; no later timer may reopen it.
    this.dropKeyDeliveryWorkspace(workspaceId, access.accountId)
    if (!signingPublicKey) throw new Error('e2ee_local_cleanup_pending')
    let cleanup: Effect.Effect<void, unknown> = Effect.void
    const hinted = new Set<number>()
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
            for (const reader of owner.readers.get(workspaceId)?.keys() ?? [])
              if (reader > 0) hinted.add(reader)
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
        false,
        retiring
      )
      // Receipt is durable. Notify now; terminal erase may be indefinitely slow.
      for (const reader of hinted) {
        const window = readerWindows.get(reader)
        if (window && !window.isDestroyed()) {
          try {
            window.send(IPC_PUSH_CHANNELS.e2eeAccessLost, { workspaceId })
          } catch {
            this.cleanupDiagnostic('e2ee_cleanup_pending')
          }
        }
      }
    } finally {
      await Effect.runPromise(cleanup)
    }
    const deleted = await cleanupRemovedDesktopWorkspace({
      accountId: access.accountId,
      workspaceId,
      reason
    }).catch((cause) => {
      this.pairingFailure = cause
      if (retiring) retiring.failure = cause
      if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== access.accountId)
        throw new Error('e2ee_account_mismatch')
      // Receipt survives a busy process lease or interrupted cleanup; the next open retries it.
      return true
    })
    if (deleted) {
      throw new Error(`e2ee_${reason}`)
    }
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
          : refuseUnopened(owner, workspaceId),
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
            : refuseUnopened(owner, workspaceId),
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
            : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, workspaceId),
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
    const window = readerWindows.get(id)!
    const lifetime = readerLifetimes.get(window)
    return observeClientLossOperation('prepareDispatch', workspaceId, id, async () => {
      const identity = getIpcServiceDeps().authService.getCachedSessionIdentity()
      const scope = this.memberScope(workspaceId)
      const cloud = await desktopE2eeCloudClient()
      const readerTokens = this.dispatchReaderTokens
      let cleanup: Effect.Effect<void, unknown> = Effect.void
      const access = await (async () => {
        try {
          return await scope(
            (owner) =>
              owner.accountId === cloud.accountId
                ? Effect.gen(function* () {
                    // Cleanup erases the binding but keeps this receipt; refuse with it.
                    if (yield* owner.bootstrap.removedReason(workspaceId))
                      return yield* refuseUnopened(owner, workspaceId)
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
                      : refuseUnopened(owner, workspaceId)
                    const readers = owner.readers.get(workspaceId)
                    let tokens = readers && readerTokens.get(readers)
                    if (readers && !tokens) {
                      tokens = new WeakMap()
                      readerTokens.set(readers, tokens)
                    }
                    const readerToken = tokens?.get(window) ?? {}
                    if (readers?.has(id)) tokens!.set(window, readerToken)
                    return {
                      readers,
                      hadReader: readers?.has(id) === true,
                      fenceLoss: (reason: AccessLoss) =>
                        owner.fenceLoss(workspaceId, reason, identity.generation),
                      readerToken,
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
            false
          )
        } finally {
          await Effect.runPromise(cleanup)
        }
      })()
      // Preparation is local, so it cannot see a removal or revocation by itself. Like
      // management, ask the server with this device's credential; only its exact answer
      // is loss. Any other check failure establishes nothing and changes no outcome.
      // The check runs beside the local work: the renderer's fast path has a deadline.
      let confirmedLoss: AccessLoss | undefined
      const lossReply = Promise.withResolvers<never>()
      lossReply.promise.catch(() => undefined)
      const refuseLoss = (reason: AccessLoss) => {
        if (confirmedLoss) return new Error(`e2ee_${confirmedLoss}`)
        try {
          const fence = access.fenceLoss(reason)
          confirmedLoss = reason
          this.retainDispatchCleanup(access, reason, fence)
          const error = new Error(`e2ee_${reason}`)
          lossReply.reject(error)
          return error
        } catch (lifecycle) {
          lossReply.reject(lifecycle)
          throw lifecycle
        }
      }
      const confirmed = (async () => {
        try {
          await Effect.runPromise(
            cloud.client.contentStreamsToken({ workspaceId, credential: access.credential })
          )
        } catch (checked) {
          const loss = accessLoss(checked)
          if (loss) {
            // Refusal is a verdict, not the cleanup's completion receipt.
            throw refuseLoss(loss)
          }
        }
      })()
      confirmed.catch(() => undefined)
      // Only the waiter expires. The credential request keeps its original 30s
      // network bound and still records a definitive late loss under the old binding.
      // 50ms leaves 150ms of the renderer's 200ms deadline for local native work,
      // binding rechecks and IPC. Slow confirmation must not force every healthy
      // send into durable fallback; genuinely slow local work still has the late path.
      const confirmation = runDesktopE2eeOperation(
        access.accountId,
        Effect.raceFirst(
          Effect.promise(() =>
            confirmed.then(
              () => undefined,
              (error: unknown) => error
            )
          ),
          Effect.as(Effect.sleep('50 millis'), undefined)
        )
      ).then((error) => {
        if (error !== undefined) throw error
      })
      confirmation.catch(() => undefined)
      const waitForConfirmation = async () => {
        await confirmation
        if (confirmedLoss) throw new Error(`e2ee_${confirmedLoss}`)
      }
      const local = runDesktopE2eeOperation(access.accountId, access.work).catch(async (error) => {
        if (accessLoss(error)) throw refuseLoss(accessLoss(error)!)
        if (!(error instanceof Error && definitiveDispatchRefusals.has(error.message))) {
          // A readerless operation is already refused and can never return a
          // frame. Diagnose its retained credential through the existing bounded
          // request, instead of mistaking the fast-send budget for a verdict.
          // Live-reader sends retain the 50ms budget; this holds no account lock.
          if (!access.hadReader) await confirmed
          else await waitForConfirmation()
        }
        throw error
      })
      // Observe raw local work even if exact loss wins; its native owner drains it.
      local.catch(() => undefined)
      const prepared = await Promise.race([local, lossReply.promise])
      // A definitive confirmation refuses; uncertainty alone does not cancel local work.
      await waitForConfirmation()
      // Network uncertainty is not cancellation. Revalidate the originating owner,
      // auth generation, reader incarnation and exact credential before handing out bytes.
      const handoff = scope(
        (owner) =>
          Effect.gen(function* () {
            if (yield* owner.bootstrap.removedReason(workspaceId))
              return yield* refuseUnopened(owner, workspaceId)
            if (
              window.isDestroyed() ||
              readerLifetimes.get(window) !== lifetime ||
              owner.readers.get(workspaceId) !== access.readers ||
              !access.readers?.has(id) ||
              readerTokens.get(access.readers)?.get(window) !== access.readerToken
            )
              return yield* Effect.fail(new Error('e2ee_closed'))
            const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
            const status = yield* owner.host.status(workspaceId)
            const latest = getIpcServiceDeps().authService.getCachedSessionIdentity()
            if (latest.userId !== identity.userId || latest.generation !== identity.generation)
              return yield* Effect.fail(new Error('e2ee_account_mismatch'))
            if (
              window.isDestroyed() ||
              readerLifetimes.get(window) !== lifetime ||
              owner.readers.get(workspaceId) !== access.readers ||
              !access.readers?.has(id) ||
              readerTokens.get(access.readers)?.get(window) !== access.readerToken ||
              credential !== access.credential ||
              status.genesisHash !== access.status.genesisHash ||
              status.signingPublicKey !== access.status.signingPublicKey
            )
              return yield* Effect.fail(new Error('e2ee_closed'))
            // A late verdict can arrive during these binding reads. Never await
            // its cleanup under the account lock, but do not hand out the frame.
            if (confirmedLoss)
              return yield* Effect.fail(
                confirmedLoss === 'member_removed'
                  ? new E2eeMemberRemovedError()
                  : new E2eeDeviceRevokedError()
              )
            return prepared
          }),
        false
      )
      // The read keeps its native owner even when a verdict refuses its waiter.
      handoff.catch(() => undefined)
      return Promise.race([handoff, lossReply.promise])
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
            : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, input.workspaceId),
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
    // A reset identity cannot deliver; its pending deliveries end and never reopen it.
    this.dropKeyDeliveryWorkspace(input.workspaceId)
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
    // Join at most one drain of a reader this account just released for this
    // workspace (e.g. the workspace runtime closing as its control page opens).
    let drained = false
    const acquire = (proof?: readonly E2eeWorkspaceHistoryPage[]) =>
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
              if (!drained) {
                const closing = yield* owner.host.pendingClose(workspaceId)
                if (closing) return { kind: 'closing', closing } as const
              }
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
              return {
                kind: 'opened',
                opened:
                  expectedAccountId === undefined
                    ? status
                    : { ...status, readerOwner: this.readerOwner(owner) }
              } as const
            }.bind(this)
          ),
        workspaceId,
        false
      )
    // The drain runs outside the account lock, exactly like the releasing close.
    const openLocal = async (proof?: readonly E2eeWorkspaceHistoryPage[]) => {
      const first = await acquire(proof)
      if (first.kind === 'opened') return first.opened
      drained = true
      await Effect.runPromise(first.closing).catch(() => {
        throw new Error(
          'e2ee_restart-required: Restart Lody to finish releasing encrypted resources.'
        )
      })
      const second = await acquire(proof)
      if (second.kind === 'opened') return second.opened
      throw new Error('e2ee_closed')
    }
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
    const readerTokens = this.dispatchReaderTokens
    const window = readerWindows.get(id)
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
          else {
            readers?.delete(id)
            if (readers && window) readerTokens.get(readers)?.delete(window)
          }
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
          : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, workspaceId),
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
          : refuseUnopened(owner, workspaceId),
      workspaceId,
      false
    )
  }
  private recoveryQueue: Promise<unknown> = Promise.resolve()
  /** Gate, serialize and account-fence one recovery-vault operation. Network and
   * file work run outside the account lock; only reason codes leave main. */
  private async recoveryOperation<A>(
    work: (input: {
      accountId: string
      store: RecoveryVaultStore['Service']
      journalPath: string
      client: Awaited<ReturnType<typeof desktopE2eeCloudClient>>['client']
      exists: Effect.Effect<boolean, unknown>
      replacement: RecoveryVaultReplacement
      accountWorkspaces: Effect.Effect<
        readonly {
          readonly id: string
          readonly name: string
          readonly genesisHash: string
        }[],
        unknown
      >
    }) => Effect.Effect<A, unknown>
  ): Promise<A> {
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const run = this.recoveryQueue.then(async () => {
      const { accountId, client } = await desktopE2eeCloudClient()
      const result = await Effect.runPromise(
        work({
          accountId,
          store: client.recoveryVault(),
          journalPath: desktopE2eeRecoveryJournalPath(accountId),
          client,
          exists: client.hasRecoveryVault(),
          replacement: client.recoveryVaultReplacement(),
          accountWorkspaces: client.recoveryVaultAccountWorkspaces()
        })
      ).catch((error) => {
        throw recoveryVaultFailure(error)
      })
      if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== accountId)
        throw new Error('e2ee_account_mismatch')
      return result
    })
    this.recoveryQueue = run.catch(() => undefined)
    return run
  }
  /** Default-off post-MVP recovery vault: create the account vault, save its file
   * where the user chooses and prove that file reopens it. The file never reaches the renderer. */
  @IpcMethod()
  async createRecoveryVault() {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    if (await this.recoveryOperation(({ exists }) => exists))
      throw new Error('e2ee_recovery_exists')
    const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    const options = {
      defaultPath: 'lody-recovery.lodyrecovery',
      filters: [{ name: 'Lody recovery file', extensions: ['lodyrecovery'] }]
    }
    const target = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (target.canceled || !target.filePath) return { outcome: 'cancelled' as const }
    const path = target.filePath
    const created = await this.recoveryOperation(({ store, journalPath, exists }) =>
      createAccountRecoveryVault({
        store,
        journalPath,
        exists,
        locator: import.meta.env.VITE_CONVEX_DEPLOY_URL ?? '',
        persist: (file) =>
          Effect.tryPromise(async () => {
            await saveRecoveryFile(path, file)
            return new Uint8Array(await readFile(path))
          })
      })
    )
    return { outcome: 'created' as const, vaultId: created.vaultId }
  }
  /** Default-off: what replacing the recovery file would cover from this device. */
  @IpcMethod()
  async recoveryReplacementPlan() {
    sender()
    return this.recoveryOperation(
      ({ accountId, store, journalPath, replacement, accountWorkspaces }) =>
        recoveryReplacementPlan({
          store,
          journalPath,
          replacement,
          accountWorkspaces,
          hasIdentity: (workspaceId) =>
            Effect.tryPromise(() => desktopE2eeHasWorkspaceIdentity(accountId, workspaceId))
        })
    )
  }
  /** Default-off: save a new file and reserve its vault. The current vault keeps working. */
  @IpcMethod()
  async beginRecoveryReplacement() {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    const options = {
      defaultPath: 'lody-recovery.lodyrecovery',
      filters: [{ name: 'Lody recovery file', extensions: ['lodyrecovery'] }]
    }
    const target = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (target.canceled || !target.filePath) return { outcome: 'cancelled' as const }
    const path = target.filePath
    const begun = await this.recoveryOperation(({ store, journalPath, replacement }) =>
      beginAccountVaultReplacement({
        store,
        journalPath,
        replacement,
        locator: import.meta.env.VITE_CONVEX_DEPLOY_URL ?? '',
        persist: (file) =>
          Effect.tryPromise(async () => {
            await saveRecoveryFile(path, file)
            return new Uint8Array(await readFile(path))
          })
      })
    )
    return { outcome: 'begun' as const, vaultId: begun.vaultId }
  }
  private passkeyPort() {
    const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    return desktopPasskeyPort({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      window: () => {
        if (!owner) throw new Error('e2ee_recovery_failed')
        return owner.getNativeWindowHandle()
      }
    })
  }
  /** How the user chose to open the vault, or null when they cancel the file dialog. */
  private async recoveryUnlock(method: 'file' | 'passkey'): Promise<RecoveryUnlock | null> {
    if (method === 'passkey')
      return {
        passkey: this.passkeyPort(),
        locator: import.meta.env.VITE_CONVEX_DEPLOY_URL ?? ''
      }
    const file = await this.chooseRecoveryFile()
    return file ? { file } : null
  }
  /** Ask for a recovery file and read it, or null when the user cancels. */
  private async chooseRecoveryFile() {
    const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'Lody recovery file', extensions: ['lodyrecovery'] }]
    }
    const chosen = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = chosen.filePaths[0]
    return chosen.canceled || !path ? null : this.readRecoveryFile(path)
  }
  /** Read a chosen recovery file, bounded before any parsing. */
  private async readRecoveryFile(path: string) {
    const handle = await openFile(path, 'r')
    try {
      const buffer = new Uint8Array(MAX_RECOVERY_FILE_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_RECOVERY_FILE_BYTES) {
        buffer.fill(0)
        throw new Error('e2ee_recovery_invalid-input')
      }
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
  /** This device's recovery targets: the workspaces it holds an identity for. */
  private async recoveryTargets(
    accountId: string,
    client: Awaited<ReturnType<typeof desktopE2eeCloudClient>>['client'],
    workspaces: readonly { readonly id: string; readonly name: string }[]
  ) {
    const targets: RecoveryWorkspaceTarget[] = []
    for (const { id, name } of workspaces) {
      if (!(await desktopE2eeHasWorkspaceIdentity(accountId, id))) continue
      const { host, credential } = await withDesktopE2eeAccount(
        (owner) =>
          Effect.map(owner.bootstrap.deviceCredential(id), (credential) => ({
            host: owner.host,
            credential
          })),
        id,
        false
      )
      targets.push({
        id,
        name,
        append: (request) => client.appendRecord(request),
        refresh: () => host.refreshWorkspaceLedger(id, (request) => client.history(request)),
        mailbox: (recovery) => client.mailbox({ workspaceId: id, credential: recovery }),
        deliver: () =>
          Effect.asVoid(
            host.keyRound(
              id,
              (signal) => client.mailbox({ workspaceId: id, credential }, signal),
              (signal) => client.staging({ workspaceId: id, credential }, signal),
              (signal) => (request) => client.history(request, signal)
            )
          ),
        owner: (ports) => host.workspaceRecovery(id, ports),
        abandonOwner: (ports) => host.workspaceRecoveryAbandon(id, ports)
      })
    }
    return targets
  }
  /** Default-off: from the new file, prove every workspace, revoke old Rs and retire the
   * old vault. A suspected leak revokes first. The file never reaches the renderer. */
  @IpcMethod()
  async continueRecoveryReplacement(input: { compromised: boolean }) {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const compromised = input?.compromised === true
    const file = await this.chooseRecoveryFile()
    if (!file) return { outcome: 'cancelled' as const }
    try {
      return await this.recoveryOperation(
        ({ accountId, client, store, journalPath, replacement, accountWorkspaces }) =>
          Effect.flatMap(accountWorkspaces, (rows) =>
            Effect.flatMap(
              Effect.promise(() => this.recoveryTargets(accountId, client, rows)),
              (workspaces) =>
                continueAccountVaultReplacement({
                  store,
                  journalPath,
                  replacement,
                  workspaces,
                  file,
                  compromised
                })
            )
          )
      )
    } finally {
      file.fill(0)
    }
  }
  /** Default-off: set up recovery for one workspace from the account's recovery file. */
  @IpcMethod()
  async setupWorkspaceRecovery(workspaceId: string, method: 'file' | 'passkey' = 'file') {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const unlock = await this.recoveryUnlock(method)
    if (!unlock) return { outcome: 'cancelled' as const }
    try {
      return await this.recoveryOperation(
        ({ accountId, client, store, journalPath, replacement, accountWorkspaces }) =>
          Effect.flatMap(accountWorkspaces, (rows) =>
            Effect.flatMap(
              Effect.promise(() =>
                this.recoveryTargets(
                  accountId,
                  client,
                  rows.filter((row) => row.id === workspaceId)
                )
              ),
              ([target]) =>
                target
                  ? setupWorkspaceRecovery({ store, journalPath, replacement, target, unlock })
                  : Effect.fail({ code: 'missing' })
            )
          )
      )
    } finally {
      if ('file' in unlock) unlock.file.fill(0)
    }
  }
  /** Default-off: list the vault's passkeys, opening it with the file or a passkey. */
  @IpcMethod()
  async listRecoveryPasskeys(method: 'file' | 'passkey' = 'file') {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const unlock = await this.recoveryUnlock(method)
    if (!unlock) return { outcome: 'cancelled' as const }
    try {
      const passkeys = await this.recoveryOperation(({ store, journalPath }) =>
        listRecoveryPasskeys({ store, journalPath, unlock })
      )
      return { outcome: 'listed' as const, passkeys }
    } finally {
      if ('file' in unlock) unlock.file.fill(0)
    }
  }
  /** Default-off: remove one passkey. Removing changes the index, so V must open again. */
  @IpcMethod()
  async removeRecoveryPasskey(entryId: string, method: 'file' | 'passkey' = 'file') {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    if (typeof entryId !== 'string' || !/^[0-9a-f]{64}$/.test(entryId))
      throw new Error('e2ee_recovery_invalid-input')
    const unlock = await this.recoveryUnlock(method)
    if (!unlock) return { outcome: 'cancelled' as const }
    try {
      const passkeys = await this.recoveryOperation(({ store, journalPath }) =>
        removeRecoveryPasskey({ store, journalPath, unlock, entryId })
      )
      return { outcome: 'removed' as const, passkeys }
    } finally {
      if ('file' in unlock) unlock.file.fill(0)
    }
  }
  /** Default-off: a readable default passkey name for this device. */
  @IpcMethod()
  async recoveryPasskeyDefaultLabel() {
    sender()
    return defaultPasskeyLabel({
      platform: process.platform,
      systemVersion: process.getSystemVersion()
    })
  }
  /** Default-off: whether this device can attempt a passkey ceremony. */
  @IpcMethod()
  async recoveryPasskeyAvailable() {
    sender()
    return recoveryVaultEnabled() && this.passkeyPort().available()
  }
  /** Default-off: add a passkey. Adding one needs V, so the user picks the file first. */
  @IpcMethod()
  async addRecoveryPasskey(label: string) {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const name = passkeyLabel(label)
    const file = await this.chooseRecoveryFile()
    if (!file) return { outcome: 'cancelled' as const }
    const port = this.passkeyPort()
    try {
      const added = await this.recoveryOperation(({ store, journalPath }) =>
        enrollRecoveryPasskey({ store, journalPath, file, port, label: name })
      )
      return { outcome: 'added' as const, passkeys: added.passkeys }
    } finally {
      file.fill(0)
    }
  }
  /** Default-off: restore every workspace a file or passkey covers onto this device. */
  @IpcMethod()
  async restoreFromRecoveryFile(method: 'file' | 'passkey' = 'file') {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const unlock = await this.recoveryUnlock(method)
    if (!unlock) return { outcome: 'cancelled' as const }
    try {
      const results = await this.recoveryOperation(
        ({ accountId, client, store, journalPath, accountWorkspaces }) =>
          Effect.flatMap(
            Effect.flatMap(accountWorkspaces, (rows) =>
              Effect.forEach(rows, (row) =>
                Effect.map(
                  Effect.tryPromise(() => desktopE2eeHasWorkspaceIdentity(accountId, row.id)),
                  (has) => ({ ...row, has })
                )
              )
            ),
            (rows) =>
              restoreAccountWorkspaces({
                store,
                journalPath,
                unlock,
                workspaces: rows.map((row) =>
                  recoveryRestoreTarget<E2eeWorkspaceHistoryPage>({
                    ...row,
                    hasIdentity: () => row.has,
                    append: (request) => client.appendRecord(request),
                    history: (next) => client.history({ workspaceId: row.id, ...next }),
                    mailbox: (credential) => client.mailbox({ workspaceId: row.id, credential }),
                    stagedGroup: (credential, key) =>
                      client.staging({ workspaceId: row.id, credential }).readGroup(key),
                    identity: (pin) =>
                      Effect.tryPromise(() =>
                        withDesktopE2eeAccount(
                          (owner) => owner.bootstrap.recoveryIdentity(pin),
                          row.id
                        )
                      ),
                    adopt: (join) =>
                      Effect.tryPromise(() =>
                        withDesktopE2eeAccount(
                          (owner) =>
                            Effect.gen(function* () {
                              yield* owner.bootstrap.preparePersonalJoin({
                                version: 1,
                                workspaceId: row.id,
                                genesisHash: row.genesisHash,
                                genesisRecordHex: join.genesisRecordHex,
                                endorser: join.endorser,
                                membershipId: join.membershipId,
                                pairingSessionId: join.pairingSessionId
                              })
                              yield* owner.bootstrap.acceptPersonalHistory(row.id, join.pages)
                              yield* owner.host.open(row.id)
                              yield* owner.host.installRecoveredKeys(row.id, join.recovered)
                            }),
                          row.id
                        )
                      )
                  })
                )
              })
          )
      )
      return { outcome: 'restored' as const, results }
    } finally {
      if ('file' in unlock) unlock.file.fill(0)
    }
  }
  /** Default-off: give up an unfinished replacement. Needs no file: this device's journal
   * names each new R. */
  @IpcMethod()
  async abandonRecoveryReplacement() {
    sender()
    return this.recoveryOperation(
      ({ accountId, client, store, journalPath, replacement, accountWorkspaces }) =>
        Effect.flatMap(accountWorkspaces, (rows) =>
          Effect.flatMap(
            Effect.promise(() => this.recoveryTargets(accountId, client, rows)),
            (workspaces) =>
              abandonAccountVaultReplacement({ store, journalPath, replacement, workspaces })
          )
        )
    )
  }
  /** Default-off: open a vault from a chosen recovery file and authenticate its
   * index. This checks the file; it neither restores a workspace nor admits a device. */
  @IpcMethod()
  async inspectRecoveryFile() {
    sender()
    if (!recoveryVaultEnabled()) throw new Error('e2ee_recovery_disabled')
    const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'Lody recovery file', extensions: ['lodyrecovery'] }]
    }
    const chosen = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = chosen.filePaths[0]
    if (chosen.canceled || !path) return { outcome: 'cancelled' as const }
    const file = await this.readRecoveryFile(path)
    try {
      const inspected = await this.recoveryOperation(({ store, journalPath }) =>
        inspectRecoveryFile({ store, journalPath, file })
      )
      return { outcome: 'opened' as const, ...inspected }
    } finally {
      file.fill(0)
    }
  }
}
