import { createHash } from 'node:crypto'
import { Cause, Deferred, Effect } from 'effect'
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
 * registers a delivery and returns; it never awaits a round. An account pairing approval
 * may wait, bounded, on `firstPass`: it settles when the first pass covering the request
 * ends (or the slot is dropped), never after a backoff timer.
 */

type Owner = Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]
type Cloud = Awaited<ReturnType<typeof desktopE2eeCloudClient>>
/** An account-bound owner turn for one workspace (`E2eeIpc.memberScope`). */
export type KeyDeliveryScope = <A extends unknown>(
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
  /** Settles when the first pass covering the request ends, or the slot is dropped. */
  firstPasses: Map<string, Deferred.Deferred<void>>
  generation: number | undefined
  /** Settles when the slot's fiber ends; `idle` and reentry use it. */
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
  /** A broken clock makes a retry due at once rather than never. */
  const nowOrZero = () => {
    try {
      return ports.now()
    } catch {
      return 0
    }
  }
  const retryAt = (now: number, attempts: number) => now + keyDeliveryRetryDelay(attempts)
  /** One promise-returning port call as an Effect; its rejection is the raw cause. */
  const promised = <A extends unknown>(work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: (cause) => cause })
  const remembering = (cause: unknown) => Effect.sync(() => ports.remember(cause))
  const settleFirstPass = (slot: KeyDeliverySlot, requestId: string) => {
    const pass = slot.firstPasses.get(requestId)
    if (!pass) return
    slot.firstPasses.delete(requestId)
    Deferred.doneUnsafe(pass, Effect.void)
  }

  function slotFor(accountId: string, workspaceId: string) {
    const key = keyOf(accountId, workspaceId)
    let slot = slots.get(key)
    const generation = identity()?.generation
    if (slot && slot.generation !== generation) {
      drop(accountId, workspaceId)
      slot = undefined
    }
    if (!slot) {
      slot = {
        requests: new Map(),
        firstPasses: new Map(),
        generation,
        again: false,
        autoRetries: 0
      }
      slots.set(key, slot)
    }
    return slot
  }
  /** Drops a slot and its pending due timer: terminal delivery or a changed account. An
   * in-flight round sees `aborted` at its next step; its first-pass waiters end now. */
  function drop(accountId: string, workspaceId: string) {
    const key = keyOf(accountId, workspaceId)
    const slot = slots.get(key)
    if (!slot) return
    slot.aborted = true
    if (slot.timer !== undefined) ports.timers().clear(slot.timer)
    slot.timer = undefined
    slots.delete(key)
    for (const requestId of [...slot.firstPasses.keys()]) settleFirstPass(slot, requestId)
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
    const now = nowOrZero()
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
    if (!slot.firstPasses.has(requestId)) slot.firstPasses.set(requestId, Deferred.makeUnsafe())
    logMemberKeys('key-delivery', requestId, { state: 'pending' })
    while (slot.requests.size > KEY_DELIVERY_RETAINED) {
      const settled = [...slot.requests].find(([, delivery]) => delivery.state === 'delivered')
      const evicted = settled?.[0] ?? slot.requests.keys().next().value!
      slot.requests.delete(evicted)
      settleFirstPass(slot, evicted)
    }
    void run(accountId, workspaceId)
    return slot.requests.get(requestId)!.state
  }
  /** Completes when the first pass covering this tracked request ends, however it ends
   * (delivered, retryable failure before any backoff, terminal, dropped slot). Never
   * fails; an unknown request completes at once. Waiting never affects the delivery. */
  function firstPass(
    accountId: string,
    workspaceId: string,
    requestId: string
  ): Effect.Effect<void, never> {
    return Effect.suspend(() => {
      const pass = slots.get(keyOf(accountId, workspaceId))?.firstPasses.get(requestId)
      return pass ? Deferred.await(pass) : Effect.void
    })
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
  /** Records one pass's outcome on the requests it covered. `true` ends the slot run. */
  function recordPass(
    accountId: string,
    workspaceId: string,
    slot: KeyDeliverySlot,
    covered: readonly MemberKeyDelivery[],
    idOf: ReadonlyMap<MemberKeyDelivery, string>,
    outcome: { ok: true; evidence: Map<string, string> } | { ok: false; cause: unknown }
  ): boolean {
    const owned = () => slots.get(keyOf(accountId, workspaceId)) === slot
    const retry = (delivery: MemberKeyDelivery, code: string) => {
      delivery.attempts += 1
      delivery.state = 'failed'
      delivery.code = code
      logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'failed', code })
      delivery.retryAt = retryAt(ports.now(), delivery.attempts)
    }
    if (!outcome.ok) {
      ports.remember(outcome.cause)
      if (!current(accountId, slot) && owned()) drop(accountId, workspaceId)
      if (slot.aborted) return true
      const code = ports.code(outcome.cause)
      // Terminal: this device can no longer deliver; drop the slot, never retry.
      if (TERMINAL_KEY_DELIVERY.has(code)) {
        for (const delivery of covered)
          logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'ended', code })
        if (owned()) drop(accountId, workspaceId)
        return true
      }
      for (const delivery of covered) retry(delivery, code)
      return true
    }
    if (!current(accountId, slot)) {
      if (owned()) drop(accountId, workspaceId)
      return true
    }
    if (slot.aborted) return true
    // Delivered only on positive per-device evidence; every other outcome retries.
    for (const delivery of covered) {
      const result = outcome.evidence.get(delivery.device) ?? KEY_DELIVERY_NOT_INGESTED
      if (result !== 'delivered') {
        retry(delivery, result)
        continue
      }
      delivery.state = 'delivered'
      delivery.attempts = 0
      logMemberKeys('key-delivery', idOf.get(delivery)!, { state: 'delivered' })
    }
    return !slot.again
  }
  /** A request admitted during a round gets one follow-up pass; later ones wait for a poll. */
  const passes = (accountId: string, workspaceId: string, slot: KeyDeliverySlot) =>
    Effect.gen(function* () {
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
        const delivered = yield* Effect.result(
          deliver(
            accountId,
            workspaceId,
            new Set(covered.map((delivery) => delivery.device)),
            () => slot.aborted === true || !current(accountId, slot),
            covered.every((delivery) => delivery.attempts === 0)
          )
        )
        const done = recordPass(
          accountId,
          workspaceId,
          slot,
          covered,
          idOf,
          delivered._tag === 'Success'
            ? { ok: true, evidence: delivered.success }
            : { ok: false, cause: delivered.failure }
        )
        for (const [requestId] of coveredEntries) settleFirstPass(slot, requestId)
        if (done) return
      }
    })
  /** After the slot's fiber ends, however it ends. */
  function finish(accountId: string, workspaceId: string, slot: KeyDeliverySlot) {
    slot.running = undefined
    // An unexpected exception must not leave a request shown as sending forever:
    // anything still delivering becomes retryable on the next due poll.
    const now = nowOrZero()
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
    for (const requestId of [...slot.firstPasses.keys()]) {
      const delivery = slot.requests.get(requestId)
      if (!delivery || delivery.state !== 'pending') settleFirstPass(slot, requestId)
    }
    schedule(accountId, workspaceId)
  }
  /** Never rejects: every outcome is recorded on the covered requests. One fiber per slot;
   * a call while it runs asks for the follow-up pass and shares its completion. */
  function run(accountId: string, workspaceId: string): Promise<void> {
    const slot = slotFor(accountId, workspaceId)
    if (slot.running) {
      slot.again = true
      return slot.running
    }
    let settle!: () => void
    const running = new Promise<void>((resolve) => (settle = resolve))
    slot.running = running
    Effect.runFork(
      passes(accountId, workspaceId, slot).pipe(
        Effect.catchCause((cause) => remembering(Cause.squash(cause))),
        Effect.ensuring(
          Effect.sync(() => {
            try {
              finish(accountId, workspaceId, slot)
            } finally {
              settle()
            }
          })
        )
      )
    )
    return running
  }
  /** One key round under a main-owned reader, so closing every window cannot stop it.
   * Ingests relay history first, runs the round for devices the local verified ledger
   * targets, then returns per-device evidence: 'delivered' or a retryable code. */
  const deliver = (
    accountId: string,
    workspaceId: string,
    devices: Set<string>,
    aborted: () => boolean = () => false,
    skipIngestIfAdmitted = false
  ) =>
    Effect.gen(function* () {
      const scope = ports.scope(workspaceId)
      const turn = <A extends unknown>(work: (owner: Owner) => Effect.Effect<A, unknown>) =>
        promised(() => scope(work))
      /** Runs an effect a turn returned, outside the account lock. */
      const outside = <A extends unknown>(effect: Effect.Effect<A, unknown>) =>
        promised(() => ports.run(accountId, effect))
      const cloud = yield* promised(() => ports.cloud())
      if (cloud.accountId !== accountId)
        return yield* Effect.fail(new Error('e2ee_account_mismatch'))
      // A removed or reset workspace is never reopened by a round that started earlier;
      // the check runs under the account lock, immediately before the open. The reader
      // is released however the round ends, so a close drain never waits on it.
      const acquireReader = turn((owner) =>
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
      const releaseReader = turn((owner) =>
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
      ).pipe(Effect.flatMap(outside), Effect.catch(remembering))
      const isTarget = (device: string) =>
        device
          ? turn((owner) => owner.host.keyDeliveryTarget(workspaceId, device))
          : Effect.succeed(false)
      const round = Effect.gen(function* () {
        // Right after local admission + refresh, every target device is already in the
        // verified local ledger; skip the redundant history round-trip on the initial pass.
        // Any retry pass re-ingests first in case epoch/membership advanced in the meantime.
        let needsIngest = !skipIngestIfAdmitted
        if (!needsIngest)
          for (const device of devices)
            if (!(yield* isTarget(device))) {
              needsIngest = true
              break
            }
        if (needsIngest) {
          const ingested = yield* Effect.result(ingestEffect(accountId, workspaceId, scope, cloud))
          // A lagging relay leaves targets unconfirmed below; only terminal causes stop here.
          if (ingested._tag === 'Failure') {
            if (TERMINAL_KEY_DELIVERY.has(ports.code(ingested.failure)))
              return yield* Effect.fail(ingested.failure)
            ports.remember(ingested.failure)
          }
        }
        const evidence = new Map<string, string>()
        const targets: string[] = []
        for (const device of devices)
          if (yield* isTarget(device)) targets.push(device)
          else evidence.set(device, KEY_DELIVERY_NOT_INGESTED)
        if (targets.length === 0 || aborted()) return evidence
        const credential = yield* turn((owner) => owner.bootstrap.deviceCredential(workspaceId))
        const mailbox = (signal: AbortSignal) =>
          cloud.client.mailbox({ workspaceId, credential }, signal)
        // #2459: the control-only approver may not hold the current key yet.
        // Receive on this main-owned reader, without putting it back on the approval wait.
        if (!(yield* turn((owner) => owner.host.status(workspaceId))).hasCurrentKey) {
          if (aborted()) return evidence
          const receive = yield* turn((owner) =>
            Effect.succeed(
              owner.host
                .receiveKeys(workspaceId, mailbox, (signal) =>
                  cloud.client.staging({ workspaceId, credential }, signal)
                )
                .pipe(Effect.mapError((error) => terminalKeyRoundCause(error) ?? error))
            )
          )
          yield* outside(receive)
        }
        if (aborted()) return evidence
        // Distribution: report flush and repair remain owned by full rounds.
        const work = yield* turn((owner) =>
          Effect.succeed(
            owner.host
              .distributeKeys(workspaceId, mailbox)
              .pipe(Effect.mapError((error) => terminalKeyRoundCause(error) ?? error))
          )
        )
        yield* outside(work)
        // A successful round is not evidence: an ineligible sender, a blocked target or a
        // joined round all succeed. Ask the mailbox per device, outside the account lock.
        for (const device of targets) {
          const check = yield* turn((owner) =>
            Effect.succeed(owner.host.keyDeliveryEvidence(workspaceId, device, mailbox))
          )
          evidence.set(device, yield* outside(check))
        }
        return evidence
      })
      return yield* Effect.acquireUseRelease(
        acquireReader,
        () => round,
        () => releaseReader
      )
    })
  /** Main-owned ledger ingest: the renderer reader that ran the approval may be gone. */
  const ingestEffect = (
    accountId: string,
    workspaceId: string,
    scope: KeyDeliveryScope,
    cloud: Cloud
  ) =>
    Effect.gen(function* () {
      const status = yield* promised(() => scope((owner) => owner.host.status(workspaceId)))
      const after = status.position ?? undefined
      let cursor: string | undefined
      let checkpoint: import('@lody/cloud-api').E2eeLedgerCheckpoint | undefined
      for (let index = 0; index < 256; index++) {
        const page = yield* cloud.client.history({
          workspaceId,
          ...(cursor ? { cursor, checkpoint } : after ? { after } : {})
        })
        checkpoint ??= page.checkpoint
        const ingested = yield* promised(() =>
          scope((owner) => Effect.succeed(owner.host.ingestLedgerRecords(workspaceId, page)))
        )
        yield* promised(() => ports.run(accountId, ingested))
        if (!page.nextCursor) return
        cursor = page.nextCursor
      }
      // Still paging: this ledger is not confirmed current. Not terminal; a later call resumes.
      return yield* Effect.fail(new Error('e2ee_history_not_caught_up'))
    })
  /** Promise boundary for the admission worker's catch-up; rejects with the raw cause. */
  function ingest(accountId: string, workspaceId: string, scope: KeyDeliveryScope, cloud: Cloud) {
    return Effect.runPromise(
      Effect.result(ingestEffect(accountId, workspaceId, scope, cloud))
    ).then((ingested) => {
      if (ingested._tag === 'Failure') throw ingested.failure
    })
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
  return { slots, track, firstPass, retryDue, list, retryNow, dropWorkspace, ingest, idle }
}
export type DesktopKeyDelivery = ReturnType<typeof makeDesktopKeyDelivery>
