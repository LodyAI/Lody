import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { KEY_DELIVERY_RETRY_DELAYS } from '@lody/e2ee-client/account-requester'
import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mjs'
import type {
  desktopE2eeCloudClient,
  runDesktopE2eeOperation,
  withDesktopE2eeAccount
} from './e2ee-account-runtime'

/**
 * Desktop member and account-pairing key delivery after an admission commits. Delivery
 * is owned by main, not by a renderer request: one in-flight round per account and
 * workspace, under a main-owned reader; failures keep a public code and are retried by a
 * main-owned due timer (bounded) and by due polls, so no page has to stay open. Approval
 * registers a delivery and returns; it never awaits a round.
 */

type Owner = Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]
type Cloud = Awaited<ReturnType<typeof desktopE2eeCloudClient>>
/** An account-bound owner turn for one workspace (`E2eeIpc.memberScope`). */
export type KeyDeliveryScope = <A>(
  work: (owner: Owner) => Effect.Effect<A, unknown>,
  create?: boolean
) => Promise<A>

/** Main-owned reader for background member key delivery; renderer webContents ids start at 1. */
export const KEY_DELIVERY_READER = 0
const KEY_DELIVERY_RETAINED = 32
/** Timer-driven retries per slot after its last new request or explicit retry: one per
 * entry of the shared backoff schedule (about 14 min). Polls and explicit retries still
 * work after the bound. */
const KEY_DELIVERY_AUTO_RETRIES = KEY_DELIVERY_RETRY_DELAYS.length
/** The shared backoff: the first retries are short, so a requester waiting for its key is
 * not held back by a transient refusal right after approval; the tail stays at 5 min. */
export const keyDeliveryRetryDelay = (attempts: number) =>
  KEY_DELIVERY_RETRY_DELAYS[Math.min(Math.max(attempts, 1), KEY_DELIVERY_RETRY_DELAYS.length) - 1]!
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
export type MemberKeyDelivery = {
  state: 'pending' | 'delivering' | 'delivered' | 'failed'
  /** Signing key from the verified KeyPackage; '' if it could not be decoded. */
  device: string
  code?: string
  attempts: number
  retryAt: number
}
type KeyDeliverySlot = {
  requests: Map<string, MemberKeyDelivery>
  generation: number | undefined
  running?: Promise<void>
  again: boolean
  timer?: unknown
  autoRetries: number
  /** Set when the slot is dropped: an in-flight round must not open or send. */
  aborted?: boolean
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
/** Log correlation only: a short hash of the request id, never the id, keys or tokens. */
const requestTag = (requestId: string) =>
  createHash('sha256').update(requestId).digest('hex').slice(0, 12)
/** Allow-listed delivery/claim diagnostics for the desktop daily log. */
export const logMemberKeys = (
  event: 'key-delivery' | 'member-claim',
  requestId: string,
  fields: { state?: string; phase?: string; code?: string }
) => console.info(`[E2EE] ${event}`, { request: requestTag(requestId), ...fields })
/** The public view of one delivery: state, and a public code only when it failed. */
export const keyDeliveryView = (requestId: string, delivery: MemberKeyDelivery) => ({
  requestId,
  state: delivery.state,
  ...(delivery.state === 'failed' && delivery.code ? { code: delivery.code } : {})
})

export interface DesktopKeyDeliveryPorts {
  /** The signed-in account and its login generation; `undefined` when unavailable. */
  identity(): { userId?: string | null; generation: number } | undefined
  now(): number
  timers(): { set(run: () => void, ms: number): unknown; clear(timer: unknown): void }
  /** Retains the latest local diagnostic in main; never crosses IPC. */
  remember(cause: unknown): void
  /** Public reason code of a cause: `e2ee_*` code, terminal access loss, or a fallback. */
  code(cause: unknown): string
  scope(workspaceId: string): KeyDeliveryScope
  cloud: typeof desktopE2eeCloudClient
  run: typeof runDesktopE2eeOperation
}

export function makeDesktopKeyDelivery(ports: DesktopKeyDeliveryPorts) {
  const slots = new Map<string, KeyDeliverySlot>()
  const keyOf = (accountId: string, workspaceId: string) => `${accountId}\n${workspaceId}`
  const identity = () => {
    try {
      return ports.identity()
    } catch {
      return undefined
    }
  }
  const retryAt = (now: number, attempts: number) => now + keyDeliveryRetryDelay(attempts)

  function slotFor(accountId: string, workspaceId: string) {
    const key = keyOf(accountId, workspaceId)
    let slot = slots.get(key)
    const generation = identity()?.generation
    if (slot && slot.generation !== generation) {
      drop(accountId, workspaceId)
      slot = undefined
    }
    if (!slot) {
      slot = { requests: new Map(), generation, again: false, autoRetries: 0 }
      slots.set(key, slot)
    }
    return slot
  }
  /** Drops a slot and its pending due timer: terminal delivery or a changed account. */
  function drop(accountId: string, workspaceId: string) {
    const key = keyOf(accountId, workspaceId)
    const slot = slots.get(key)
    if (!slot) return
    slot.aborted = true
    if (slot.timer !== undefined) ports.timers().clear(slot.timer)
    slot.timer = undefined
    slots.delete(key)
  }
  /** Old delivery work never borrows a later login, even for the same account. */
  function current(accountId: string, slot: { generation: number | undefined }) {
    const signedIn = identity()
    return signedIn?.userId === accountId && signedIn.generation === slot.generation
  }
  /** Drops every slot of a removed or reset workspace (all accounts when `accountId` is
   * absent, every workspace when `workspaceId` is too): nothing reopens it afterwards. */
  function dropWorkspace(workspaceId?: string, accountId?: string) {
    for (const key of [...slots.keys()]) {
      const [account, workspace] = key.split('\n')
      if (
        (accountId === undefined || account === accountId) &&
        (workspaceId === undefined || workspace === workspaceId)
      )
        drop(account!, workspace!)
    }
  }
  /** Schedules the next round at the earliest retryable failure's `retryAt`, or at once for
   * a request admitted after the last pass began. Bounded per slot; the timer re-checks the
   * signed-in account and drops the slot if it changed. A delivery may reopen a workspace
   * no window is reading (main's reader is held only during a round), but never one that
   * was removed or reset: those drop their slot. */
  function schedule(accountId: string, workspaceId: string) {
    const key = keyOf(accountId, workspaceId)
    const slot = slots.get(key)
    if (!slot || slot.running) return
    if (slot.timer !== undefined) ports.timers().clear(slot.timer)
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
      now = ports.now()
    } catch {
      /* A broken clock makes the retry due at once rather than never. */
    }
    slot.timer = ports.timers().set(
      () => {
        if (slots.get(key) !== slot) return
        slot.timer = undefined
        if (!current(accountId, slot)) {
          drop(accountId, workspaceId)
          return
        }
        slot.autoRetries += 1
        void run(accountId, workspaceId)
      },
      Math.max(0, Math.min(...due) - now)
    )
  }
  /** Registers one admitted device and starts its round at once; never awaited. */
  function track(accountId: string, workspaceId: string, requestId: string, device: string) {
    const slot = slotFor(accountId, workspaceId)
    slot.autoRetries = 0
    slot.requests.delete(requestId)
    slot.requests.set(requestId, { state: 'pending', device, attempts: 0, retryAt: 0 })
    logMemberKeys('key-delivery', requestId, { state: 'pending' })
    while (slot.requests.size > KEY_DELIVERY_RETAINED) {
      const settled = [...slot.requests].find(([, delivery]) => delivery.state === 'delivered')
      slot.requests.delete(settled?.[0] ?? slot.requests.keys().next().value!)
    }
    void run(accountId, workspaceId)
    return slot.requests.get(requestId)!.state
  }
  /** Due polls (admission worker, team settings) start a round for due requests. */
  function retryDue(accountId: string, workspaceId: string) {
    const slot = slots.get(keyOf(accountId, workspaceId))
    if (slot && !current(accountId, slot)) {
      drop(accountId, workspaceId)
      return
    }
    if (!slot || slot.running) return
    const now = ports.now()
    if (
      [...slot.requests.values()].some(
        (delivery) =>
          delivery.state === 'pending' ||
          (delivery.state === 'failed' &&
            delivery.retryAt <= now &&
            !TERMINAL_KEY_DELIVERY.has(delivery.code ?? ''))
      )
    )
      void run(accountId, workspaceId)
  }
  /** Never rejects: every outcome is recorded on the covered requests. */
  function run(accountId: string, workspaceId: string): Promise<void> {
    const slot = slotFor(accountId, workspaceId)
    if (slot.running) {
      slot.again = true
      return slot.running
    }
    const running = (async () => {
      // A request admitted during a round gets one follow-up pass; later ones wait for a poll.
      for (let pass = 0; pass < 2; pass++) {
        // Sign-out or an account change ends this account's delivery at once.
        if (!slot.aborted && !current(accountId, slot)) drop(accountId, workspaceId)
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
          delivery.retryAt = retryAt(ports.now(), delivery.attempts)
        }
        let evidence: Map<string, string>
        try {
          evidence = await deliver(
            accountId,
            workspaceId,
            new Set(covered.map((delivery) => delivery.device)),
            () => slot.aborted === true || !current(accountId, slot),
            covered.every((delivery) => delivery.attempts === 0)
          )
        } catch (cause) {
          ports.remember(cause)
          if (!current(accountId, slot) && slots.get(keyOf(accountId, workspaceId)) === slot)
            drop(accountId, workspaceId)
          if (slot.aborted) return
          const code = ports.code(cause)
          // Terminal: this device can no longer deliver; drop the slot, never retry.
          if (TERMINAL_KEY_DELIVERY.has(code)) {
            for (const delivery of covered)
              logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'ended', code })
            if (slots.get(keyOf(accountId, workspaceId)) === slot) drop(accountId, workspaceId)
            return
          }
          for (const delivery of covered) retry(delivery, code)
          return
        }
        if (!current(accountId, slot)) {
          if (slots.get(keyOf(accountId, workspaceId)) === slot) drop(accountId, workspaceId)
          return
        }
        if (slot.aborted) return
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
        ports.remember(cause)
      })
      .finally(() => {
        slot.running = undefined
        // An unexpected exception must not leave a request shown as sending forever:
        // anything still delivering becomes retryable on the next due poll.
        let now = 0
        try {
          now = ports.now()
        } catch {
          /* A broken clock makes the retry due at once rather than never. */
        }
        for (const [requestId, delivery] of slot.requests) {
          if (delivery.state !== 'delivering') continue
          delivery.attempts += 1
          delivery.state = 'failed'
          delivery.code = KEY_DELIVERY_INTERRUPTED
          delivery.retryAt = retryAt(now, delivery.attempts)
          try {
            logMemberKeys('key-delivery', requestId, {
              state: 'failed',
              code: KEY_DELIVERY_INTERRUPTED
            })
          } catch {
            /* Diagnostics never block the reset. */
          }
        }
        schedule(accountId, workspaceId)
      })
    slot.running = running
    return running
  }
  /** One key round under a main-owned reader, so closing every window cannot stop it.
   * Ingests relay history first, runs the round for devices the local verified ledger
   * targets, then returns per-device evidence: 'delivered' or a retryable code. */
  async function deliver(
    accountId: string,
    workspaceId: string,
    devices: Set<string>,
    aborted: () => boolean = () => false,
    skipIngestIfAdmitted = false
  ) {
    const scope = ports.scope(workspaceId)
    const cloud = await ports.cloud()
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
      // Right after local admission + refresh, every target device is already in the
      // verified local ledger; skip the redundant history round-trip on the initial pass.
      // Any retry pass re-ingests first in case epoch/membership advanced in the meantime.
      let needsIngest = !skipIngestIfAdmitted
      if (!needsIngest) {
        for (const device of devices) {
          if (
            !device ||
            !(await scope((owner) => owner.host.keyDeliveryTarget(workspaceId, device)))
          ) {
            needsIngest = true
            break
          }
        }
      }
      if (needsIngest) {
        try {
          await ingest(accountId, workspaceId, scope, cloud)
        } catch (cause) {
          // A lagging relay leaves targets unconfirmed below; only terminal causes stop here.
          if (TERMINAL_KEY_DELIVERY.has(ports.code(cause))) throw cause
          ports.remember(cause)
        }
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
      // #2459: the control-only approver may not hold the current key yet.
      // Receive on this main-owned reader, without putting it back on the approval wait.
      if (!(await scope((owner) => owner.host.status(workspaceId))).hasCurrentKey) {
        if (aborted()) return evidence
        const receive = await scope((owner) =>
          Effect.succeed(
            owner.host
              .receiveKeys(workspaceId, mailbox, (signal) =>
                cloud.client.staging({ workspaceId, credential }, signal)
              )
              .pipe(Effect.mapError((error) => terminalKeyRoundCause(error) ?? error))
          )
        )
        await ports.run(accountId, receive)
      }
      if (aborted()) return evidence
      // Distribution: report flush and repair remain owned by full rounds.
      const work = await scope((owner) =>
        Effect.succeed(
          owner.host
            .distributeKeys(workspaceId, mailbox)
            .pipe(Effect.mapError((error) => terminalKeyRoundCause(error) ?? error))
        )
      )
      await ports.run(accountId, work)
      // A successful round is not evidence: an ineligible sender, a blocked target or a
      // joined round all succeed. Ask the mailbox per device, outside the account lock.
      for (const device of targets) {
        const check = await scope((owner) =>
          Effect.succeed(owner.host.keyDeliveryEvidence(workspaceId, device, mailbox))
        )
        evidence.set(device, await ports.run(accountId, check))
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
        await ports.run(accountId, cleanup)
      } catch (cause) {
        ports.remember(cause)
      }
    }
  }
  /** Main-owned ledger ingest: the renderer reader that ran the approval may be gone. */
  async function ingest(
    accountId: string,
    workspaceId: string,
    scope: KeyDeliveryScope,
    cloud: Cloud
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
      const ingested = await scope((owner) =>
        Effect.succeed(owner.host.ingestLedgerRecords(workspaceId, page))
      )
      await ports.run(accountId, ingested)
      if (!page.nextCursor) return
      cursor = page.nextCursor
    }
    // Still paging: this ledger is not confirmed current. Not terminal; a later call resumes.
    throw new Error('e2ee_history_not_caught_up')
  }
  /** Public views of this account's deliveries in one workspace, after a due poll. */
  function list(accountId: string, workspaceId: string) {
    retryDue(accountId, workspaceId)
    const slot = slots.get(keyOf(accountId, workspaceId))
    return [...(slot?.requests ?? [])].map(([requestId, delivery]) =>
      keyDeliveryView(requestId, delivery)
    )
  }
  /** An explicit retry skips the backoff wait, never the terminal access-loss result.
   * `null` when the request is unknown to this account's current login. */
  function retryNow(accountId: string, workspaceId: string, requestId: string) {
    const slot = slots.get(keyOf(accountId, workspaceId))
    if (slot && !current(accountId, slot)) {
      drop(accountId, workspaceId)
      return null
    }
    const delivery = slot?.requests.get(requestId)
    if (!slot || !delivery) return null
    if (delivery.state === 'failed') delivery.retryAt = 0
    slot.autoRetries = 0
    void run(accountId, workspaceId)
    return keyDeliveryView(requestId, delivery)
  }
  /** Synchronization point for the owning tests; production callers never await delivery. */
  function idle(accountId: string, workspaceId: string) {
    return slots.get(keyOf(accountId, workspaceId))?.running ?? Promise.resolve()
  }
  return { slots, track, retryDue, list, retryNow, dropWorkspace, ingest, idle }
}
export type DesktopKeyDelivery = ReturnType<typeof makeDesktopKeyDelivery>
