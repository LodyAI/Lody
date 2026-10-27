import type { E2eeWorkspaceHistoryPage, E2eeWorkspaceHistoryRequest } from '@lody/cloud-api'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer, Result } from 'effect'
import {
  EpochPublisher,
  InstalledEpochKeys,
  LedgerSubmission,
  VerifiedLedger,
  WorkspaceControl
} from '@lody/e2ee-core'
import { Bytes, decodeRecord } from '@lody/e2ee-core/protocol'
import {
  BackendError,
  EpochCandidateStore,
  SubmissionJournal,
  EpochStagingStore,
  LedgerLog,
  LedgerLogError,
  KeyMailbox,
  LedgerSync,
  LocalStoreError
} from '@lody/e2ee-core/services'
import {
  sqliteEpochCandidateStore,
  sqliteSubmissionJournal
} from '@lody/e2ee-core/adapters/node-sqlite'
import {
  desktopE2eePorts,
  type DesktopE2eeCustody,
  type DesktopE2eeDevice
} from '../e2ee-custody.mjs'
import { WorkspaceScope } from '@lody/e2ee-core/services'
import { E2eeStagingCapacityError } from './e2ee-cloud-client.mjs'

/** Native commands share one durable submission owner; renderer ports stay purpose-bound. */
export type DesktopE2eeManagementCommand =
  | { type: 'rotate' }
  | { type: 'revoke'; target: string }
  | { type: 'removeMember'; membershipId: string }

export type DesktopE2eeManagementRemote = {
  log: LedgerLog['Service']
  staging: (round?: string) => EpochStagingStore['Service']
  mailbox: () => KeyMailbox['Service']
  history: (
    request: E2eeWorkspaceHistoryRequest
  ) => Effect.Effect<E2eeWorkspaceHistoryPage, unknown>
}

export type DesktopE2eeManagementPorts = {
  log: LedgerLog['Service']
  staging: (round?: string) => EpochStagingStore['Service']
  refresh: () => Effect.Effect<void, unknown>
  receive: () => Effect.Effect<void, unknown>
}

/** Accounting only. An uncertain request always keeps its original round and bytes. */
export const makeRoundStaging = (
  db: DatabaseSync,
  remote: DesktopE2eeManagementPorts['staging'],
  nextRound = randomUUID
): EpochStagingStore['Service'] => {
  function sql<A>(work: () => A) {
    return Effect.try({
      try: work,
      catch: (cause) =>
        new BackendError({ service: 'EpochStagingRound', reason: 'unavailable', cause })
    })
  }
  const round = (id: string) =>
    sql(() => {
      db.exec(
        'CREATE TABLE IF NOT EXISTS epoch_staging_rounds(record_hash TEXT PRIMARY KEY, round TEXT NOT NULL)'
      )
      db.prepare('INSERT OR IGNORE INTO epoch_staging_rounds VALUES(?,?)').run(id, nextRound())
      return (
        db.prepare('SELECT round FROM epoch_staging_rounds WHERE record_hash=?').get(id) as {
          round: string
        }
      ).round
    })
  const staged = remote()
  return EpochStagingStore.of({
    ...staged,
    stageGroup: (group) =>
      Effect.gen(function* () {
        let selected = yield* round(group.recordHash)
        const first = yield* Effect.result(remote(selected).stageGroup(group))
        if (Result.isSuccess(first)) return undefined
        if (
          !(first.failure instanceof E2eeStagingCapacityError) ||
          first.failure.round !== selected
        )
          return yield* Effect.fail(first.failure)
        // Definite capacity refusal is the sole reason to advance accounting. No re-signing.
        selected = yield* sql(() => {
          db.prepare('UPDATE epoch_staging_rounds SET round=? WHERE record_hash=? AND round=?').run(
            nextRound(),
            group.recordHash,
            selected
          )
          return (
            db
              .prepare('SELECT round FROM epoch_staging_rounds WHERE record_hash=?')
              .get(group.recordHash) as { round: string }
          ).round
        })
        yield* remote(selected).stageGroup(group)
        return undefined
      }).pipe(
        Effect.mapError((error) =>
          error instanceof LocalStoreError
            ? new BackendError({ service: 'EpochStagingRound', reason: 'unavailable' })
            : error
        )
      )
  })
}

export const desktopManagementStores = (directory: string, device: DesktopE2eeDevice) => {
  const key = Buffer.from(device.publicKey.toBytes()).toString('hex')
  return Layer.mergeAll(
    sqliteEpochCandidateStore({
      path: join(directory, `epoch-candidates-${key}.sqlite`),
      mode: 'create-or-open'
    }),
    sqliteSubmissionJournal({ path: join(directory, `management-submission-${key}.sqlite`) })
  )
}

export const makeDesktopE2eeManagement = Effect.fnUntraced(function* (input: {
  directory: string
  stores: Context.Context<EpochCandidateStore | SubmissionJournal>
  db: DatabaseSync
  genesis: Bytes.GenesisHash
  device: DesktopE2eeDevice
  custody: DesktopE2eeCustody
  verified: VerifiedLedger['Service']
  installed: InstalledEpochKeys['Service']
  current: LedgerSync['Service']['current']
  ports: DesktopE2eeManagementPorts
}) {
  const identity = desktopE2eePorts(input.custody, input.device).pipe(
    Layer.provideMerge(Layer.succeed(WorkspaceScope, { genesis: input.genesis }))
  )
  const ports = Layer.mergeAll(
    identity,
    Layer.succeed(VerifiedLedger, input.verified),
    Layer.succeed(InstalledEpochKeys, input.installed),
    Layer.succeed(LedgerLog, input.ports.log),
    Layer.succeed(EpochStagingStore, makeRoundStaging(input.db, input.ports.staging)),
    Layer.succeed(LedgerSync, {
      current: input.current,
      refresh: () => input.ports.refresh().pipe(Effect.andThen(input.current()))
    }),
    Layer.succeed(EpochCandidateStore, Context.get(input.stores, EpochCandidateStore)),
    Layer.succeed(SubmissionJournal, Context.get(input.stores, SubmissionJournal))
  ).pipe(Layer.provideMerge(identity))
  const syncedLog = Layer.succeed(LedgerLog, {
    ...input.ports.log,
    read: (anchor) =>
      input.ports.log.read(anchor).pipe(
        Effect.tap(() => input.ports.refresh()),
        Effect.mapError((cause) =>
          cause instanceof LedgerLogError ? cause : new LedgerLogError({ cause })
        )
      )
  })
  const submission = LedgerSubmission.layer.pipe(Layer.provideMerge(Layer.merge(ports, syncedLog)))
  const services = yield* Layer.build(
    Layer.mergeAll(EpochPublisher.layer, WorkspaceControl.layer).pipe(
      Layer.provideMerge(submission)
    )
  )
  const publisher = Context.get(services, EpochPublisher),
    control = Context.get(services, WorkspaceControl)
  const journal = Context.get(services, LedgerSubmission)
  const finishRotation = Effect.fnUntraced(function* (start: boolean) {
    // Reception can repair a previously committed candidate before installation/ACK retry.
    yield* input.ports.refresh()
    yield* Effect.result(input.ports.receive())
    let result = yield* start ? publisher.publish() : publisher.resume()
    if (!result) return null
    yield* input.ports.refresh()
    yield* publisher.acknowledge(result)
    return result.outcome
  })
  return Effect.fnUntraced(function* (command: DesktopE2eeManagementCommand) {
    yield* input.ports.refresh()
    const entry = yield* journal.pending()
    if (entry.record) {
      const parsed = yield* Effect.fromResult(decodeRecord(entry.record))
      if (
        parsed.body.type === 'ordinary' &&
        (parsed.body.operation.type === 'publishEpoch' ||
          parsed.body.operation.type === 'removeMemberAndPublishEpoch')
      ) {
        const outcome = yield* finishRotation(false)
        if (command.type === 'rotate' || outcome === 'Conflict') return outcome
      } else {
        const result = yield* control.resume()
        if (result) {
          yield* control.acknowledge(result)
          if (
            result.outcome === 'Conflict' ||
            (command.type === 'revoke' &&
              parsed.body.type === 'ordinary' &&
              parsed.body.operation.type === 'revokeDevice' &&
              Buffer.from(parsed.body.operation.target.toBytes()).toString('hex') ===
                command.target) ||
            (command.type === 'removeMember' &&
              parsed.body.type === 'ordinary' &&
              parsed.body.operation.type === 'removeMember' &&
              Buffer.from(parsed.body.operation.membershipId.toBytes()).toString('hex') ===
                command.membershipId)
          )
            return result.outcome
        }
      }
    }
    if (command.type === 'rotate') {
      const candidate = yield* Context.get(input.stores, EpochCandidateStore).active()
      if (candidate) {
        const outcome = yield* finishRotation(false)
        if (outcome !== 'Conflict') return outcome
        // No publication CAS was pending at entry. This explicit click may replace
        // a candidate proven obsolete by the genuine ledger, after its ACK.
      }
      const current = yield* input.verified.current()
      if (!current.inspectState().epoch.rotationRequired) return 'Committed'
      return yield* finishRotation(true)
    }
    // Unsubmitted candidates are independent of ordinary management commands.
    if (command.type === 'revoke') {
      const target = yield* Effect.fromResult(
        Bytes.signingPublicKey(new Uint8Array(Buffer.from(command.target, 'hex')))
      )
      const view = yield* input.verified.current()
      if (!view.inspectState().devices.has(command.target)) return 'Committed'
      const result = yield* control.execute({ _tag: 'RevokeDevice', target })
      yield* control.acknowledge(result)
      return result.outcome
    }
    const membershipId = yield* Effect.fromResult(
      Bytes.membershipId(Buffer.from(command.membershipId, 'hex'))
    )
    const state = (yield* input.verified.current()).inspectState()
    const actorDevice = state.devices.get(
      Buffer.from(input.device.publicKey.toBytes()).toString('hex')
    )
    const actor =
      actorDevice &&
      state.members.get(Buffer.from(actorDevice.membershipId.toBytes()).toString('hex'))
    const target = state.members.get(command.membershipId)
    if (
      actorDevice?.kind !== 'personal' ||
      !actor ||
      (actor.role !== 'owner' && actor.role !== 'admin') ||
      target?.role === 'owner' ||
      (actor.role === 'admin' && target?.role === 'admin')
    )
      return yield* Effect.fail(new Error('e2ee_member_management_forbidden'))
    if (!target) return 'Committed'
    if (!state.capabilities.includes(1)) {
      const declaration = yield* control.execute({ _tag: 'DeclareCapabilities', capabilities: [1] })
      yield* control.acknowledge(declaration)
      if (declaration.outcome === 'Conflict') return declaration.outcome
    }
    const result = yield* control.execute({ _tag: 'RemoveMember', membershipId })
    yield* control.acknowledge(result)
    return result.outcome
  })
})
