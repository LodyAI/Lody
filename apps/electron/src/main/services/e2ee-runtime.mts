import {
  makeLazyMachineSharingHost,
  MachineSharingError,
  type SharingRemote
} from '@lody/e2ee-machine-sharing'
import { makeDesktopRemotePairing } from './e2ee-remote-pairing.mjs'
import { EpochCandidateStore, SubmissionJournal } from '@lody/e2ee-core/services'
import {
  desktopManagementStores,
  makeDesktopE2eeManagement,
  type DesktopE2eeManagementCommand,
  type DesktopE2eeManagementRemote
} from './e2ee-management.mjs'
import { makeDesktopKeyMaintenance } from './e2ee-key-maintenance.mjs'
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import { randomUUID } from 'node:crypto'
import { makeDesktopPersonalPairing } from './e2ee-personal-pairing.mjs'
import { makeDesktopMemberApprovals, verifyMemberHistory } from './e2ee-member-join.mjs'
import { makeDesktopLocalPairing } from './e2ee-local-pairing.mjs'
import type { LocalE2eePrepareResponse } from '@lody/shared/e2ee-local-pairing'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Data, Deferred, Effect, Exit, Layer, Result, Scope, Semaphore } from 'effect'
import {
  KeyDistributor,
  KeyReceiver,
  KeyRepair,
  InstalledEpochHistory,
  InstalledEpochKeys,
  InstalledKeyError,
  LedgerFeed,
  VerifiedLedger
} from '@lody/e2ee-core'
import {
  Bytes,
  LedgerError,
  decodeRecord,
  exportVerifiedState,
  hashRecordBytes,
  ledgerStateDigest,
  prepareLedgerCommand,
  hasVerifiedCheckpoint,
  restoreVerifiedState,
  getCommittedEpochStagingKey,
  verifyLedgerEffect,
  extendLedgerEffect,
  type RetainedLedgerState
} from '@lody/e2ee-core/protocol'
import {
  EpochPublicationSource,
  EpochStagingStore,
  KeyMailbox,
  InstalledKeyStore,
  LedgerFeedStore,
  LedgerPinStore,
  LedgerViewSource,
  LedgerViewSourceError,
  LocalStoreError,
  WorkspaceScope
} from '@lody/e2ee-core/services'
import {
  sqliteDeliveryOutbox,
  sqliteDistributionJournal,
  sqliteReceiveJournal,
  sqliteRepairJournal,
  sqliteInstalledKeyStore,
  sqliteLedgerFeedStore,
  sqliteLedgerPinStore
} from '@lody/e2ee-core/adapters/node-sqlite'
import type { E2eeWorkspaceRuntime, E2eeContentSeal, E2eeContentOpen } from '@lody/platform'
import {
  makeStreamsUpdateBinding,
  makeRealtimeContentBinding
} from '@lody/e2ee-core/adapters/loro-streams'
import { makeE2eeRpcNative, E2eeRpcOriginals } from '@lody/loro-streams-rpc/e2ee-native'
import type { E2eeDispatchInput } from '@lody/shared/e2ee-rpc'
import { encryptedWorkspaceRoom } from '@lody/shared/workspace-streams-content'
type E2eeWorkspaceHistoryPage = Parameters<E2eeWorkspaceRuntime['ingestLedgerRecords']>[1]
import type { E2eeRuntimeLedgerView, E2eeRuntimeStatus } from '@lody/platform'
import { desktopE2eePorts, type DesktopE2eeCustody } from '../e2ee-custody.mjs'
import type { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mjs'

/** Stable host failures: IPC callers never receive native errors or their raw causes. */
export class DesktopE2eeRuntimeError extends Data.TaggedError('DesktopE2eeRuntimeError')<{
  readonly code:
    | 'restart-required'
    | 'local-history-recovery-required'
    | 'trusted-pin-unavailable'
    | 'closed'
    | 'invalid-input'
    | 'corrupt'
    | 'snapshot-history-required'
    | 'key-update-required'
    | 'local-evidence-conflict'
    | 'storage'
    | 'rotation_candidate_unavailable'
    | 'management_unauthorized'
    | 'management_operator_required'
    | 'management_retry'
    | 'machine_not_owned'
    | 'machine_not_shared'
    | 'sharing_conflict'
    | 'sharing_unavailable'
    | 'sharing_invalid'
    | 'sharing_storage'
    | 'invalid-ledger'
    | 'member_removed'
    | 'device_revoked'
    | 'missing-binding'
    | 'conflict'
}> {}
const fail = (code: DesktopE2eeRuntimeError['code']) => new DesktopE2eeRuntimeError({ code })
const pinFailure = (error: LocalStoreError) =>
  error.store === 'LedgerPinStore' && error.reason === 'corrupt'
    ? fail('trusted-pin-unavailable')
    : error
const historyFailure = (error: unknown) =>
  error instanceof LedgerError &&
  !['native-unavailable', 'upgrade-required', 'unknown-version', 'unknown-operation'].includes(
    error.code
  )
    ? fail('local-history-recovery-required')
    : error
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const unhex = (value: string) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) throw fail('invalid-input')
  return new Uint8Array(Buffer.from(value, 'hex'))
}
function sql<A>(work: () => A) {
  return Effect.try({
    try: work,
    catch: (error) => {
      rememberDesktopE2eeFailure('runtime-sql', error)
      return error instanceof DesktopE2eeRuntimeError
        ? error
        : fail(
            error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string' &&
              (/^(?:SQLITE_CORRUPT(?:_.*)?|SQLITE_NOTADB)$/.test(error.code) ||
                (error.code === 'ERR_SQLITE_ERROR' &&
                  'errcode' in error &&
                  typeof error.errcode === 'number' &&
                  [11, 26].includes(error.errcode & 0xff)))
              ? 'local-history-recovery-required'
              : 'storage'
          )
    }
  })
}
const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.mapError((error) => {
      if (error instanceof DesktopE2eeRuntimeError) return error
      if (error instanceof MachineSharingError) return fail(error.code)
      if (
        error instanceof Error &&
        ['e2ee_machine_not_owned', 'e2ee_machine_not_shared'].includes(error.message)
      )
        return fail(
          error.message === 'e2ee_machine_not_owned' ? 'machine_not_owned' : 'machine_not_shared'
        )
      // An unverifiable sharing policy is not a ledger failure.
      if (error instanceof Error && error.message === 'e2ee_machine_sharing_unavailable')
        return fail('sharing_unavailable')
      const reason =
        (error as { code?: string; reason?: string })?.code ??
        (error as { reason?: string })?.reason
      if (reason === 'key-update-required') return fail('key-update-required')
      if (reason === 'missing-binding') return fail('missing-binding')
      if (reason === 'conflict') return fail('conflict')
      if (reason === 'invalid-input') return fail('invalid-input')
      return fail(
        reason === 'local-evidence-conflict' || reason === 'rollback'
          ? 'local-evidence-conflict'
          : 'invalid-ledger'
      )
    })
  )
type SavedOrigin = {
  stateHex: string
  genesis: string
  head: string
  length: number
  digest: string
  offset: string
}
const savedOrigin = (state: RetainedLedgerState, offset: string): SavedOrigin => ({
  stateHex: hex(state.bytes),
  genesis: hex(state.genesis.toBytes()),
  head: hex(state.head.toBytes()),
  length: state.length,
  digest: hex(state.stateDigest.toBytes()),
  offset
})
function restoreOrigin(value: SavedOrigin) {
  const state = {
    bytes: unhex(value.stateHex),
    genesis: Result.getOrThrow(Bytes.genesisHash(unhex(value.genesis))),
    head: Result.getOrThrow(Bytes.recordHash(unhex(value.head))),
    length: value.length,
    stateDigest: Result.getOrThrow(Bytes.recordHash(unhex(value.digest)))
  }
  if (Result.isFailure(restoreVerifiedState(state))) throw fail('corrupt')
  return { kind: 'retained' as const, state, offset: value.offset }
}
type ObservedCheckpoint = NonNullable<Parameters<E2eeWorkspaceRuntime['open']>[1]>
type HistoryRow = { position: number; record: Uint8Array; locator: string | null }

/** One account's lazy workspace runtimes. The caller Scope owns custody/bootstrap;
 * close this host first. Every admitted native operation settles before stores close.
 */
export const makeDesktopE2eeRuntimeHost = Effect.fn('DesktopE2eeRuntimeHost.open')(
  function* (options: {
    readonly directory: string
    readonly removeObsoleteCache?: typeof unlink
    readonly custody: DesktopE2eeCustody
    readonly bootstrap: Effect.Success<ReturnType<typeof makeDesktopE2eeBootstrap>>
  }) {
    const serial = yield* Semaphore.make(1)
    let stopping = false
    const entries = new Map<
      string,
      {
        manage: (
          command: DesktopE2eeManagementCommand,
          ports: (signal: AbortSignal) => DesktopE2eeManagementRemote
        ) => Effect.Effect<unknown, unknown>
        managementState: () => Effect.Effect<import('@lody/platform').E2eeManagementState, unknown>
        scope: Scope.Closeable
        pairing: ReturnType<typeof makeDesktopLocalPairing>
        remotePairing: ReturnType<typeof makeDesktopRemotePairing>
        personalPairing: ReturnType<typeof makeDesktopPersonalPairing>
        memberApprovals: ReturnType<typeof makeDesktopMemberApprovals>
        status: () => Effect.Effect<E2eeRuntimeStatus, unknown>
        ledgerView: () => Effect.Effect<E2eeRuntimeLedgerView, unknown>
        observe: (
          checkpoint: ObservedCheckpoint,
          proof?: readonly E2eeWorkspaceHistoryPage[]
        ) => Effect.Effect<void, unknown>
        stop: () => void
        isClosing: () => boolean
        close: Effect.Effect<void, DesktopE2eeRuntimeError>
        restartRequired: () => boolean
        keyRound: (
          mailbox: (signal: AbortSignal) => KeyMailbox['Service'],
          staging?: (signal: AbortSignal) => EpochStagingStore['Service'],
          refreshLedger?: (signal: AbortSignal) => DesktopE2eeManagementRemote['history']
        ) => Effect.Effect<void, unknown>
        seal: (
          input: E2eeContentSeal
        ) => Effect.Effect<{ header: Uint8Array; sealed: Uint8Array }, unknown>
        openContent: (input: E2eeContentOpen) => Effect.Effect<Uint8Array, unknown>
        refreshSharingLedger: (
          readHistory: DesktopE2eeManagementRemote['history']
        ) => Effect.Effect<void, unknown>
        sharing: Effect.Success<ReturnType<typeof makeLazyMachineSharingHost>>
        rpc: ReturnType<typeof makeE2eeRpcNative>
        ingest: (page: E2eeWorkspaceHistoryPage) => Effect.Effect<E2eeRuntimeStatus, unknown>
      }
    >()
    const openWorkspace = Effect.fnUntraced(function* (
      workspaceId: string,
      observed?: ObservedCheckpoint,
      proof?: readonly E2eeWorkspaceHistoryPage[]
    ) {
      if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
        return yield* fail('invalid-input')
      const openedEntry = entries.get(workspaceId)
      if (openedEntry) {
        if (openedEntry.isClosing())
          return yield* fail(openedEntry.restartRequired() ? 'restart-required' : 'closed')
        if (observed) yield* openedEntry.observe(observed, proof)
        return openedEntry
      }
      const removed = yield* options.bootstrap.removedReason(workspaceId)
      if (removed) return yield* fail(removed)
      const creation = yield* options.bootstrap.creationFor(workspaceId)
      const genesis = yield* Effect.fromResult(Bytes.genesisHash(unhex(creation.genesisHash)))
      const readObservation = Effect.fnUntraced(function* (expected: ObservedCheckpoint) {
        if (
          !expected ||
          expected.genesisHash !== creation.genesisHash ||
          !Number.isSafeInteger(expected.length) ||
          expected.length < 1 ||
          !/^[0-9a-f]{64}$/.test(expected.headHash)
        )
          return yield* fail('local-evidence-conflict')
        const point = {
          head: Result.getOrThrow(Bytes.recordHash(unhex(expected.headHash))),
          length: expected.length
        }
        return point
      })
      const openingObservation = observed ? yield* readObservation(observed) : undefined
      const invitation = creation.invitation
      const initialOrigin: Parameters<typeof LedgerFeed.layer>[0]['origin'] = invitation
        ? { kind: 'snapshot', snapshot: invitation.snapshot }
        : { kind: 'genesis', record: creation.record }
      const initialPoint = invitation
        ? { head: invitation.view.head, length: invitation.view.length }
        : { head: hashRecordBytes(creation.record), length: 1 }
      const initialCount = initialPoint.length
      const directory = join(options.directory, 'workspaces', workspaceId)
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
        catch: () => fail('storage')
      })
      const scope = yield* Scope.make()
      const make = Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          sql(() => {
            const connection = new DatabaseSync(join(directory, 'history.sqlite'))
            try {
              connection.exec(
                'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(position INTEGER PRIMARY KEY, record BLOB NOT NULL, locator TEXT); CREATE TABLE IF NOT EXISTS cache(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,origin TEXT)'
              )
            } catch (error) {
              connection.close()
              throw error
            }
            connection
              .prepare('INSERT OR IGNORE INTO records(position,record) VALUES(0,?)')
              .run(creation.record)
            const first = connection.prepare('SELECT record FROM records WHERE position=0').get()
            if (
              !(first?.record instanceof Uint8Array) ||
              hex(first.record) !== hex(creation.record)
            ) {
              connection.close()
              throw fail('local-evidence-conflict')
            }
            // Bootstrap verified these complete pages before retaining them. Reopening still
            // replays their originals below; only exact overlaps can enter this database.
            if ('historyPages' in creation && creation.historyPages) {
              connection.exec('BEGIN IMMEDIATE')
              try {
                for (const page of creation.historyPages) {
                  page.recordsHex.forEach((record, index) => {
                    const position = page.startIndex + index
                    const prior = connection
                      .prepare('SELECT record FROM records WHERE position=?')
                      .get(position)
                    if (
                      prior &&
                      (!(prior.record instanceof Uint8Array) || hex(prior.record) !== record)
                    )
                      throw fail('local-evidence-conflict')
                    connection
                      .prepare('INSERT OR IGNORE INTO records(position,record) VALUES(?,?)')
                      .run(position, unhex(record))
                  })
                  if (page.recordsHex.length)
                    connection
                      .prepare('UPDATE records SET locator=COALESCE(locator,?) WHERE position=?')
                      .run(page.position, page.startIndex + page.recordsHex.length - 1)
                }
                connection.exec('COMMIT')
              } catch (cause) {
                connection.exec('ROLLBACK')
                connection.close()
                throw cause
              }
            }
            connection
              .prepare('INSERT OR IGNORE INTO cache(id,name) VALUES(1,?)')
              .run('ledger-feed.sqlite')
            return connection
          }),
          (connection) => Effect.sync(() => connection.close())
        )
        const device = yield* options.custody.openDevice(genesis)
        const base = Layer.mergeAll(
          desktopE2eePorts(options.custody, device),
          Layer.succeed(WorkspaceScope, { genesis })
        )
        const stores = Layer.mergeAll(
          sqliteLedgerPinStore({
            path: join(directory, 'ledger-pin.sqlite'),
            mode: 'create-or-open'
          }),
          sqliteInstalledKeyStore({
            path: join(directory, 'installed-keys.sqlite'),
            mode: 'create-or-open'
          })
        ).pipe(Layer.provideMerge(base))
        const storeContext = yield* Layer.buildWithScope(stores, scope).pipe(
          Effect.mapError(pinFailure)
        )
        const pins = Context.get(storeContext, LedgerPinStore)
        const installedStore = Context.get(storeContext, InstalledKeyStore)
        let pin = yield* pins.read().pipe(Effect.mapError(pinFailure))
        let minimumPin = pin
        // Reject contradictions already known locally before requesting any prefix proof.
        if (
          openingObservation &&
          [pin, initialPoint].some(
            (known) =>
              known?.length === openingObservation.length &&
              !known.head.equals(openingObservation.head)
          )
        )
          return yield* fail('local-evidence-conflict')
        const rows = () =>
          db
            .prepare('SELECT position,record,locator FROM records ORDER BY position')
            .all() as unknown as HistoryRow[]
        const originals = yield* sql(rows)
        const suffix = originals.filter((row) => row.position >= initialCount)
        if (suffix.some((row, index) => row.position !== initialCount + index))
          return yield* fail('local-history-recovery-required')
        const endpoint = suffix.length
          ? { head: hashRecordBytes(suffix.at(-1)!.record), length: suffix.at(-1)!.position + 1 }
          : initialPoint
        // A compact invitation cannot prove any checkpoint before its origin. Fetching
        // history belongs to IPC outside the account lock; authenticate and retain it here.
        let prefixProof: import('@lody/e2ee-core/protocol').LedgerView | undefined
        const proveSnapshotPrefix = Effect.fnUntraced(function* (
          point: { head: ReturnType<typeof hashRecordBytes>; length: number },
          pages?: readonly E2eeWorkspaceHistoryPage[],
          additionalPoint?: typeof point
        ) {
          if (!invitation) return yield* fail('local-evidence-conflict')
          if (!prefixProof) {
            let prefix = (yield* sql(rows)).filter((row) => row.position < initialCount)
            if (prefix.length !== initialCount || prefix.some((row, i) => row.position !== i)) {
              if (!pages) return yield* fail('snapshot-history-required')
              // Validate the entire paginated response, including any newer suffix.
              yield* verifyMemberHistory(
                {
                  workspaceId,
                  genesisHash: creation.genesisHash,
                  genesisRecordHex: hex(creation.record)
                },
                pages
              )
              prefix = pages
                .flatMap((page) =>
                  page.recordsHex.map((record, i) => ({
                    position: page.startIndex + i,
                    record: unhex(record),
                    locator: null
                  }))
                )
                .slice(0, initialCount)
            }
            const replayed = yield* verifyLedgerEffect({
              anchor: genesis,
              records: prefix.map((row) => row.record),
              checkpoint: initialPoint
            }).pipe(
              Effect.mapError((error) =>
                error.code === 'checkpoint-mismatch' ? fail('local-evidence-conflict') : error
              )
            )
            if (
              !Result.getOrThrow(ledgerStateDigest(replayed)).equals(
                Result.getOrThrow(ledgerStateDigest(invitation.view))
              )
            )
              return yield* fail('local-evidence-conflict')
            if (!Result.getOrThrow(hasVerifiedCheckpoint(replayed, point)))
              return yield* fail('local-evidence-conflict')
            // Validate the caller's observation as well as the original native pin before
            // committing anything. A newer observation beyond local history remains a
            // pending restriction, as in observe(); it grants no current authority.
            if (additionalPoint && additionalPoint.length <= endpoint.length) {
              const evidence =
                additionalPoint.length <= replayed.length
                  ? replayed
                  : yield* extendLedgerEffect(
                      replayed,
                      suffix.map((row) => row.record),
                      endpoint
                    )
              if (!Result.getOrThrow(hasVerifiedCheckpoint(evidence, additionalPoint)))
                return yield* fail('local-evidence-conflict')
            }
            // No proof or conflicting evidence may mutate originals or the durable pin.
            yield* sql(() => {
              db.exec('BEGIN IMMEDIATE')
              try {
                for (const row of prefix) {
                  const prior = db
                    .prepare('SELECT record FROM records WHERE position=?')
                    .get(row.position)
                  if (
                    prior &&
                    (!(prior.record instanceof Uint8Array) ||
                      !Buffer.from(prior.record).equals(row.record))
                  )
                    throw fail('local-evidence-conflict')
                  db.prepare('INSERT OR IGNORE INTO records(position,record) VALUES(?,?)').run(
                    row.position,
                    row.record
                  )
                }
                db.exec('COMMIT')
              } catch (error) {
                db.exec('ROLLBACK')
                throw error
              }
            })
            prefixProof = replayed
          }
          if (!Result.getOrThrow(hasVerifiedCheckpoint(prefixProof, point)))
            return yield* fail('local-evidence-conflict')
          return undefined
        })
        if (pin && pin.length < initialCount) {
          yield* proveSnapshotPrefix(pin, proof, openingObservation)
          // Originals are durable before the guard advances across the proved prefix.
          yield* pins.write(initialPoint)
          pin = minimumPin = initialPoint
        }
        const replayOriginals = (): Effect.Effect<
          import('@lody/e2ee-core/protocol').LedgerView,
          unknown
        > =>
          invitation
            ? extendLedgerEffect(
                invitation.view,
                rows()
                  .filter((row) => row.position >= initialCount)
                  .map((row) => row.record),
                endpoint
              )
            : verifyLedgerEffect({
                anchor: genesis,
                records: rows().map((row) => row.record),
                checkpoint: endpoint
              })
        const currentLocator = () => {
          const row = db
            .prepare(
              'SELECT locator FROM records WHERE locator IS NOT NULL ORDER BY position DESC LIMIT 1'
            )
            .get()
          return typeof row?.locator === 'string'
            ? row.locator
            : (invitation?.snapshot.offset ?? null)
        }
        // Core calls append only after authenticating the complete page. Persist
        // its originals first so a crash can never leave the pin ahead of them.
        const journaledFeedStore = (name: string) =>
          Layer.effect(
            LedgerFeedStore,
            Effect.gen(function* () {
              const store = yield* LedgerFeedStore
              return LedgerFeedStore.of({
                ...store,
                append: (expected, records, tail) =>
                  Effect.gen(function* () {
                    yield* sql(() => {
                      db.exec('BEGIN IMMEDIATE')
                      try {
                        for (let index = 0; index < records.length; index++) {
                          const position = expected.count + index
                          const record = records[index]!
                          const existing = db
                            .prepare('SELECT record FROM records WHERE position=?')
                            .get(position)
                          if (
                            existing &&
                            (!(existing.record instanceof Uint8Array) ||
                              hex(existing.record) !== hex(record))
                          )
                            throw fail('local-evidence-conflict')
                          db.prepare(
                            'INSERT OR IGNORE INTO records(position,record) VALUES(?,?)'
                          ).run(position, record)
                        }
                        db.prepare('UPDATE records SET locator=? WHERE position=?').run(
                          tail.offset,
                          tail.count - 1
                        )
                        db.exec('COMMIT')
                      } catch (error) {
                        db.exec('ROLLBACK')
                        throw error
                      }
                    }).pipe(
                      Effect.mapError(
                        () => new LocalStoreError({ store: 'LedgerFeedStore', reason: 'storage' })
                      )
                    )
                    yield* store.append(expected, records, tail)
                  })
              })
            })
          ).pipe(
            Layer.provide(
              sqliteLedgerFeedStore({ path: join(directory, name), mode: 'create-or-open' })
            )
          )
        const openFeed = (
          name: string,
          origin: Parameters<typeof LedgerFeed.layer>[0]['origin'],
          expected: typeof endpoint
        ) =>
          Effect.gen(function* () {
            if (!/^[a-z0-9-]+\.sqlite$/.test(name)) return yield* fail('corrupt')
            const feedScope = yield* Scope.make()
            const layer = LedgerFeed.layer({
              origin,
              expected,
              budget: { maxRecords: 1_000_000, maxBytes: 64 * 1024 * 1024 }
            }).pipe(Layer.provideMerge(journaledFeedStore(name)), Layer.provideMerge(base))
            const result = yield* Effect.result(Layer.buildWithScope(layer, feedScope))
            if (Result.isFailure(result)) {
              yield* Scope.close(feedScope, Exit.void)
              return yield* result.failure
            }
            yield* Effect.addFinalizer(() => Scope.close(feedScope, Exit.void))
            return { feed: Context.get(result.success, LedgerFeed), feedScope }
          })
        const cache = yield* sql(() =>
          db.prepare('SELECT name,origin FROM cache WHERE id=1').get()!
        )
        let compactedAt = initialCount
        let cachedScope: Scope.Closeable | undefined
        const cached = yield* Effect.result(
          Effect.gen(function* () {
            const origin = yield* sql(() =>
              typeof cache.origin === 'string'
                ? restoreOrigin(JSON.parse(cache.origin))
                : initialOrigin
            )
            compactedAt = origin.kind === 'retained' ? origin.state.length : initialCount
            // A retained cache ahead of the independent pin is invalid, never new authority.
            if (origin.kind === 'retained' && (!pin || pin.length < origin.state.length))
              return yield* fail('corrupt')
            const opened = yield* openFeed(
              String(cache.name),
              origin,
              origin.kind === 'retained' ? (pin ?? endpoint) : endpoint
            )
            cachedScope = opened.feedScope
            const state = yield* opened.feed.current()
            if (
              state.view.length !== endpoint.length ||
              !state.view.head.equals(endpoint.head) ||
              (state.bootstrap ? null : state.offset) !== currentLocator()
            ) {
              return yield* fail('corrupt')
            }
            return opened.feed
          })
        )
        let feed: LedgerFeed['Service']
        if (Result.isSuccess(cached)) feed = cached.success
        else {
          if (cachedScope) yield* Scope.close(cachedScope, Exit.void)
          compactedAt = initialCount
          // Cache is disposable; prove the original history and pin before replacing it.
          const view = yield* replayOriginals().pipe(Effect.mapError(historyFailure))
          if (pin && view.length >= pin.length) {
            const contains = yield* Effect.fromResult(hasVerifiedCheckpoint(view, pin))
            if (!contains) return yield* fail('local-evidence-conflict')
          }
          if (typeof cache.origin === 'string') {
            const restored = yield* Effect.result(
              sql(() => restoreOrigin(JSON.parse(cache.origin as string)))
            )
            if (Result.isSuccess(restored)) {
              const containsOrigin = yield* Effect.fromResult(
                hasVerifiedCheckpoint(view, {
                  head: restored.success.state.head,
                  length: restored.success.state.length
                })
              )
              if (!containsOrigin) return yield* fail('local-evidence-conflict')
            }
          }
          const name = `ledger-feed-${randomUUID()}.sqlite`
          const opened = yield* openFeed(name, initialOrigin, initialPoint)
          feed = opened.feed
          let chunk: Uint8Array[] = []
          for (const row of invitation ? suffix : originals) {
            chunk.push(row.record)
            if (row.locator !== null) {
              const before = yield* feed.current()
              yield* feed.accept(
                {
                  requestOffset: before.offset,
                  nextOffset: row.locator,
                  records: chunk,
                  upToDate: true
                },
                { head: hashRecordBytes(row.record), length: row.position + 1 }
              )
              chunk = []
            }
          }
          if (chunk.length > 0 && (invitation || originals.length !== 1))
            return yield* fail('corrupt')
          yield* sql(() => db.prepare('UPDATE cache SET name=?,origin=NULL WHERE id=1').run(name))
          // Only the replaced, verified-disposable feed is collected. Originals and pins remain.
          if (
            typeof cache.name === 'string' &&
            /^ledger-feed(?:-[a-f0-9-]{36})?\.sqlite$/.test(cache.name)
          ) {
            yield* Effect.tryPromise({
              try: async () => {
                for (const sidecar of ['', '-wal', '-shm'])
                  await (options.removeObsoleteCache ?? unlink)(
                    join(directory, cache.name as string) + sidecar
                  ).catch((error) => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                      console.warn('[E2EE] Cache cleanup pending', {
                        code: 'e2ee_cache_cleanup_pending'
                      })
                  })
              },
              catch: () => fail('storage')
            })
          }
        }
        const observe = Effect.fnUntraced(function* (
          expected: ObservedCheckpoint,
          pages?: readonly E2eeWorkspaceHistoryPage[]
        ) {
          const point = yield* readObservation(expected)
          if (minimumPin?.length === point.length && !minimumPin.head.equals(point.head))
            return yield* fail('local-evidence-conflict')
          const current = (yield* feed.current()).view
          if (current.length >= point.length) {
            let contains = Result.getOrThrow(hasVerifiedCheckpoint(current, point))
            if (!contains && invitation && point.length < initialCount) {
              yield* proveSnapshotPrefix(point, pages)
              contains = true
            }
            if (!contains) {
              const proofRecords = yield* sql(rows)
              const replayed = yield* invitation
                ? extendLedgerEffect(
                    invitation.view,
                    proofRecords
                      .filter((row) => row.position >= initialCount)
                      .map((row) => row.record),
                    { head: current.head, length: current.length }
                  )
                : verifyLedgerEffect({
                    anchor: genesis,
                    records: proofRecords.map((row) => row.record),
                    checkpoint: { head: current.head, length: current.length }
                  })
              contains = Result.getOrThrow(hasVerifiedCheckpoint(replayed, point))
            }
            if (!contains) return yield* fail('local-evidence-conflict')
          }
          // This is a prior local verifier's restriction, never a source of permission.
          if (!minimumPin || minimumPin.length < point.length) {
            const nextPin = invitation && point.length < initialCount ? initialPoint : point
            yield* pins.write(nextPin)
            minimumPin = nextPin
          }
          return undefined
        })
        if (observed) yield* observe(observed, proof)
        const pending = (view: { length: number }) =>
          Boolean(minimumPin && view.length < minimumPin.length)
        const verifiedLayer = VerifiedLedger.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(LedgerViewSource, {
              current: () =>
                Effect.gen(function* () {
                  const view = (yield* feed.current()).view
                  if (pending(view)) return yield* fail('local-evidence-conflict')
                  return view
                }).pipe(Effect.mapError((cause) => new LedgerViewSourceError({ cause })))
            })
          ),
          Layer.provideMerge(Layer.succeed(LedgerPinStore, pins)),
          Layer.provideMerge(base)
        )
        const verifiedContext = yield* Layer.buildWithScope(verifiedLayer, scope)
        const verified = Context.get(verifiedContext, VerifiedLedger)
        if (!pending((yield* feed.current()).view)) {
          const view = yield* verified.current()
          minimumPin = { head: view.head, length: view.length }
        }
        const pairing = yield* sql(() =>
          makeDesktopLocalPairing({
            db,
            workspaceId,
            genesis,
            genesisRecord: creation.record,
            signer: device,
            current: () => verified.current()
          })
        )
        const remotePairing = yield* sql(() =>
          makeDesktopRemotePairing({
            db,
            workspaceId,
            genesis,
            genesisRecord: creation.record,
            signer: device,
            current: () => verified.current()
          })
        )
        const personalPairing = yield* sql(() =>
          makeDesktopPersonalPairing({
            db,
            workspaceId,
            genesis,
            genesisRecord: creation.record,
            signer: device,
            current: () => verified.current(),
            offset: () => Effect.map(feed.current(), (state) => state.offset)
          })
        )
        const memberApprovals = yield* sql(() =>
          makeDesktopMemberApprovals({
            db,
            workspaceId,
            genesis,
            genesisRecord: creation.record,
            signer: device,
            current: () => verified.current()
          })
        )
        const keysLayer = InstalledEpochKeys.layer.pipe(
          Layer.provideMerge(Layer.succeed(InstalledKeyStore, installedStore)),
          Layer.provideMerge(Layer.succeed(VerifiedLedger, verified)),
          Layer.provideMerge(base)
        )
        const keysContext = yield* Layer.buildWithScope(keysLayer, scope)
        const keys = Context.get(keysContext, InstalledEpochKeys)
        // insertIfAbsent preserves the creation's original protected key; never repair it.
        if (creation.epochBlob) {
          yield* installedStore.insertIfAbsent(0, creation.epochBlob)
          // Key health cannot prevent opening the independently verified ledger.
        }
        const historyContext = yield* Layer.buildWithScope(
          InstalledEpochHistory.layer.pipe(
            Layer.provide(Layer.succeed(VerifiedLedger, verified)),
            Layer.provide(Layer.succeed(InstalledEpochKeys, keys))
          ),
          scope
        )
        let maintenance: Context.Context<KeyDistributor | KeyReceiver | KeyRepair> | undefined
        let maintainKeys: Effect.Success<ReturnType<typeof makeDesktopKeyMaintenance>> | undefined
        let round: Deferred.Deferred<void, unknown> | undefined
        let managing: Deferred.Deferred<void, unknown> | undefined
        let managementStores: Context.Context<EpochCandidateStore | SubmissionJournal> | undefined
        const localManagement = Effect.fnUntraced(function* () {
          if (!managementStores)
            managementStores = yield* Layer.buildWithScope(
              desktopManagementStores(directory, device).pipe(Layer.provide(base)),
              scope
            )
          return managementStores
        })
        let manager: Effect.Success<ReturnType<typeof makeDesktopE2eeManagement>> | undefined
        let roundAgain = false
        let closing = false
        let sharingOwner: Effect.Success<ReturnType<typeof makeLazyMachineSharingHost>> | undefined
        const networkAbort = new AbortController()
        const stop = () => {
          closing = true
          sharingOwner?.stop()
          roundAgain = false
          networkAbort.abort()
        }
        let closeFailed = false
        let closeDone: Deferred.Deferred<void, DesktopE2eeRuntimeError> | undefined
        const closeEntry = Effect.suspend(() => {
          if (closeDone) return Deferred.await(closeDone)
          closeDone = Deferred.makeUnsafe<void, DesktopE2eeRuntimeError>()
          const done = closeDone
          stop()
          return Effect.uninterruptible(
            Effect.gen(function* () {
              if (round) yield* Effect.exit(Deferred.await(round))
              if (managing) yield* Effect.exit(Deferred.await(managing))
              const result = yield* Effect.exit(Scope.close(scope, Exit.void))
              if (Exit.isFailure(result)) {
                closeFailed = true
                rememberDesktopE2eeFailure('runtime-close', result.cause)
              }
              const receipt = Exit.isFailure(result)
                ? Exit.fail(fail('restart-required'))
                : Exit.void
              yield* Deferred.done(done, receipt)
              return yield* receipt
            })
          )
        })
        const isClosing = () => closing
        const keyRound = Effect.fnUntraced(function* (
          mailbox: (signal: AbortSignal) => KeyMailbox['Service'],
          staging?: (signal: AbortSignal) => EpochStagingStore['Service'],
          refreshLedger?: (signal: AbortSignal) => DesktopE2eeManagementRemote['history']
        ) {
          if (closing) return yield* fail('closed')
          roundAgain = true
          if (round) return yield* Deferred.await(round)
          const done = Deferred.makeUnsafe<void, unknown>()
          round = done
          const result = yield* Effect.exit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (!maintenance) {
                  const journals = Layer.mergeAll(
                    sqliteDeliveryOutbox({
                      path: join(directory, 'outbox.sqlite'),
                      mode: 'create-or-open'
                    }),
                    sqliteDistributionJournal({
                      path: join(directory, 'distribution.sqlite'),
                      mode: 'create-or-open'
                    }),
                    sqliteReceiveJournal({
                      path: join(directory, 'receive.sqlite'),
                      mode: 'create-or-open'
                    }),
                    sqliteRepairJournal({
                      path: join(directory, 'repair.sqlite'),
                      mode: 'create-or-open'
                    })
                  ).pipe(Layer.provideMerge(base))
                  const ports = Layer.mergeAll(
                    journals,
                    Layer.succeed(KeyMailbox, mailbox(networkAbort.signal)),
                    Layer.succeed(VerifiedLedger, verified),
                    Layer.succeed(InstalledEpochKeys, keys),
                    Layer.succeed(EpochPublicationSource, {
                      current: (view) =>
                        sql(() => {
                          const epoch = view.inspectState().epoch.number
                          if (epoch === 0) return creation.record
                          for (const row of rows()
                            .filter((candidate) => candidate.position < view.length)
                            .reverse()) {
                            const parsed = Result.getOrThrow(decodeRecord(row.record)).body
                            if (
                              parsed.type === 'ordinary' &&
                              (parsed.operation.type === 'publishEpoch' ||
                                parsed.operation.type === 'removeMemberAndPublishEpoch') &&
                              parsed.operation.epoch === epoch
                            )
                              return row.record
                          }
                          return null
                        }).pipe(
                          Effect.mapError(
                            () =>
                              new LocalStoreError({
                                store: 'EpochPublicationSource',
                                reason: 'corrupt'
                              })
                          )
                        )
                    }),
                    base
                  )
                  maintenance = yield* Layer.buildWithScope(
                    Layer.mergeAll(KeyDistributor.layer, KeyRepair.layer).pipe(
                      Layer.provideMerge(KeyReceiver.layer),
                      Layer.provide(ports)
                    ),
                    scope
                  )
                }
                let passes = 0
                let refreshedUnknown = false
                do {
                  roundAgain = false
                  const view = yield* verified.current()
                  const epoch = view.inspectState().epoch.number
                  const currentReceiver = Context.get(maintenance, KeyReceiver)
                  const beforeReceive = Effect.gen(function* () {
                    const checked = yield* Effect.result(keys.check(epoch))
                    if (staging && epoch > 0 && Result.isFailure(checked)) {
                      const located = getCommittedEpochStagingKey(view, epoch)
                      // A snapshot-joined device without this publication original uses mailbox/history.
                      if (Result.isSuccess(located)) {
                        // Staging denial or I/O failure must not gate verified mailbox receipt.
                        const group = yield* staging(networkAbort.signal)
                          .readGroup(located.success)
                          .pipe(Effect.catch(() => Effect.succeed(null)))
                        if (
                          group?.envelopes.some(
                            (row) => row.recipient === hex(device.publicKey.toBytes())
                          )
                        )
                          yield* currentReceiver.receiveStagedGroup(group)
                      } else if (view.verification !== 'endorsed-snapshot')
                        return yield* located.failure
                    }
                    return undefined
                  })
                  maintainKeys ??= yield* makeDesktopKeyMaintenance().pipe(
                    Effect.provide(maintenance)
                  )
                  const needsRefresh = yield* maintainKeys(epoch, beforeReceive)
                  if (needsRefresh && refreshLedger && !refreshedUnknown) {
                    refreshedUnknown = true
                    // Delivery already ran. Refresh only this workspace through the
                    // existing verified ingest, outside native/account locks.
                    yield* refreshManagementHistory(refreshLedger(networkAbort.signal))
                    roundAgain = true
                  }
                } while (roundAgain && ++passes < 4 && !isClosing())
                return undefined
              })
            )
          )
          round = undefined
          yield* Deferred.done(done, result)
          return yield* result
        }, Effect.uninterruptible)
        const history = Context.get(historyContext, InstalledEpochHistory)
        const sharing = yield* makeLazyMachineSharingHost({
          filename: join(directory, 'machine-sharing.sqlite'),
          admissionHistory: (view) =>
            sql(() =>
              rows()
                .filter((row) => row.position < view.length)
                .map((row) => ({ length: row.position + 1, record: new Uint8Array(row.record) }))
            ),
          workspaceId,
          genesisHash: hex(genesis.toBytes()),
          signer: device,
          ledger: () => verified.current(),
          readEpochKey: (epoch) => history.read(epoch),
          credential: () => options.bootstrap.deviceCredential(workspaceId),
          // Public methods refresh through their captured device-authenticated history before calling this host.
          refreshLedger: () => Effect.void
        })
        sharingOwner = sharing
        const rpc = makeE2eeRpcNative({
          workspaceId,
          requesterDevice: hex(device.publicKey.toBytes()),
          originals: new E2eeRpcOriginals(join(directory, 'rpc-originals.sqlite')),
          ledger: () => verified.current(),
          binding: (resource) =>
            makeRealtimeContentBinding({
              genesis,
              resource,
              signer: device,
              ledger: () => verified.current(),
              readEpochKey: (epoch) => history.read(epoch)
            })
        })
        yield* Effect.addFinalizer(() => rpc.close().pipe(Effect.orDie))
        const bindings = new Map<
          string,
          Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>
        >()
        const binding = Effect.fnUntraced(function* (room: E2eeContentSeal['room']) {
          const descriptor = yield* Effect.try({
            try: () => encryptedWorkspaceRoom(workspaceId, room),
            catch: () => fail('invalid-input')
          })
          let value = bindings.get(descriptor.resource)
          if (!value) {
            value = yield* makeStreamsUpdateBinding({
              ...descriptor,
              genesis,
              // Renderer epochs are stale hints, never encryption authority.
              // Core captures the verified current epoch when each seal starts.
              writeEpoch: 'current',
              signer: device,
              ledger: () => verified.current(),
              readEpochKey: (epoch) => history.read(epoch)
            }).pipe(Effect.provideService(VerifiedLedger, verified), Scope.provide(scope))
            bindings.set(descriptor.resource, value)
          }
          return value
        })
        const checkBytes = (value: Uint8Array, max: number) =>
          value instanceof Uint8Array && value.byteLength <= max
        const seal = Effect.fnUntraced(function* (input: E2eeContentSeal) {
          if (
            !input ||
            !Number.isSafeInteger(input.epoch) ||
            input.epoch < 0 ||
            !['update_batch', 'snapshot'].includes(input.context?.kind) ||
            !checkBytes(input.plaintext, 16 * 1024 * 1024) ||
            !checkBytes(input.additionalData, 65536)
          )
            return yield* fail('invalid-input')
          // A future hint must fail for catch-up, never silently downgrade.
          const view = yield* verified.current()
          if (input.epoch > view.inspectState().epoch.number) return yield* fail('invalid-ledger')
          const provider = yield* binding(input.room)
          return yield* provider.seal({ ...input, additionalData: () => input.additionalData })
        })
        const openContent = Effect.fnUntraced(function* (input: E2eeContentOpen) {
          if (
            !input ||
            !checkBytes(input.sealed, 16 * 1024 * 1024 + 4096) ||
            !checkBytes(input.header, 512) ||
            !checkBytes(input.additionalData, 65536)
          )
            return yield* fail('invalid-input')
          const provider = yield* binding(input.room)
          return yield* provider.open(input)
        })
        let upgradeRequiredAt: number | undefined
        let retainedWriteEpoch: number | undefined
        const status = Effect.fnUntraced(function* (): Effect.fn.Return<
          E2eeRuntimeStatus,
          unknown
        > {
          const state = yield* feed.current()
          const publicState = state.view.inspectState()
          const saved = yield* Effect.fromResult(exportVerifiedState(state.view))
          const ownDevice = publicState.devices.get(hex(device.publicKey.toBytes()))
          const continuityPending = pending(state.view)
          if (!continuityPending) yield* verified.current()
          const checked = continuityPending
            ? Result.fail(new InstalledKeyError({ reason: 'missing-key' }))
            : yield* Effect.result(keys.check(publicState.epoch.number))
          if (
            Result.isFailure(checked) &&
            checked.failure.reason !== 'missing-key' &&
            checked.failure.reason !== 'unauthorized' &&
            ![
              'corrupt',
              'native-failed',
              'binding-mismatch',
              'commitment-mismatch',
              'storage'
            ].includes(checked.failure.reason)
          )
            return yield* checked.failure
          let writeEpoch: number | null = Result.isSuccess(checked)
            ? publicState.epoch.number
            : null
          if (
            !continuityPending &&
            Result.isFailure(checked) &&
            checked.failure.reason !== 'unauthorized'
          ) {
            for (
              let candidate = retainedWriteEpoch ?? publicState.epoch.number - 1;
              candidate >= 0;
              candidate -= 1
            ) {
              const older = yield* Effect.result(keys.check(candidate))
              if (Result.isSuccess(older)) {
                writeEpoch = candidate
                break
              }
              if (older.failure.reason === 'unauthorized') break
              if (older.failure.reason === 'closed' || older.failure.reason === 'rollback')
                return yield* older.failure
            }
          }
          if (writeEpoch !== null) retainedWriteEpoch = writeEpoch
          return {
            writeEpoch,
            workspaceId,
            genesisHash: creation.genesisHash,
            length: state.view.length,
            headHash: hex(state.view.head.toBytes()),
            stateDigest: hex(saved.stateDigest.toBytes()),
            position: state.bootstrap ? null : state.offset,
            epoch: publicState.epoch.number,
            rotationRequired: publicState.epoch.rotationRequired,
            signingPublicKey: hex(device.publicKey.toBytes()),
            membershipId: ownDevice ? hex(ownDevice.membershipId.toBytes()) : null,
            memberRole: ownDevice
              ? (publicState.members.get(hex(ownDevice.membershipId.toBytes()))?.role ?? null)
              : null,
            deviceKind: ownDevice?.kind ?? null,
            hasCurrentKey: Result.isSuccess(checked),
            hasDeviceCredential: Result.isSuccess(
              yield* Effect.result(options.bootstrap.deviceCredential(workspaceId))
            ),
            continuityPending,
            ...(upgradeRequiredAt === undefined ? {} : { upgradeRequiredAt })
          }
        })
        const ledgerView = Effect.fnUntraced(function* () {
          const current = yield* status()
          const state = yield* feed.current()
          const exported = yield* Effect.fromResult(exportVerifiedState(state.view))
          const recordsHex = yield* sql(() => rows().map((row) => hex(row.record)))
          return {
            status: current,
            stateHex: hex(exported.bytes),
            recordsHex,
            recordPositions: yield* sql(() => rows().map((row) => row.position))
          }
        })
        const ingest = Effect.fnUntraced(function* (page: E2eeWorkspaceHistoryPage) {
          sharing.invalidate()
          const state = yield* feed.current()
          const start = state.bootstrap ? 0 : state.view.length
          if (
            !page ||
            page.workspaceId !== workspaceId ||
            page.genesisHash !== creation.genesisHash ||
            !Number.isSafeInteger(page.startIndex) ||
            page.startIndex < 0 ||
            page.startIndex > start ||
            (invitation !== undefined && page.startIndex < initialCount) ||
            !Array.isArray(page.recordsHex) ||
            page.recordsHex.length > 64 ||
            !Number.isSafeInteger(page.checkpoint?.length) ||
            page.checkpoint.length < page.startIndex ||
            !/^[0-9a-f]{64}$/.test(page.checkpoint.headHash)
          )
            return yield* fail('invalid-input')
          const records = yield* sql(() =>
            page.recordsHex.map((value) => {
              if (typeof value !== 'string' || value.length > 16384) throw fail('invalid-input')
              return unhex(value)
            })
          )
          const length = page.startIndex + records.length
          if (
            length > page.checkpoint.length ||
            (page.nextCursor === null) !== (length === page.checkpoint.length)
          )
            return yield* fail('invalid-input')
          const lastKnown =
            records.length === 0 && length < start
              ? yield* sql(() =>
                  db.prepare('SELECT record FROM records WHERE position=?').get(length - 1)
                )
              : undefined
          const head = records.length
            ? hashRecordBytes(records[records.length - 1]!)
            : lastKnown
              ? hashRecordBytes(lastKnown.record as Uint8Array)
              : state.view.head
          if (length === page.checkpoint.length && hex(head.toBytes()) !== page.checkpoint.headHash)
            return yield* fail('invalid-ledger')
          // Validate locator binding without treating it as cryptographic authority.
          if (
            typeof page.position !== 'string' ||
            !page.position.startsWith(`p1:${workspaceId}:${length}:`)
          )
            return yield* fail('invalid-input')
          // A second window may have already verified this page. Only compare
          // against the verified prefix, never against unverified journal suffixes.
          const overlap = Math.max(0, Math.min(length, start) - page.startIndex)
          if (overlap > 0) {
            const known = yield* sql(
              () =>
                db
                  .prepare(
                    'SELECT position,record,locator FROM records WHERE position>=? AND position<? ORDER BY position'
                  )
                  .all(page.startIndex, page.startIndex + overlap) as unknown as HistoryRow[]
            )
            if (
              known.length !== overlap ||
              known.some((row, index) => !Buffer.from(row.record).equals(records[index]!))
            )
              return yield* fail('local-evidence-conflict')
          }
          if (page.checkpoint.length <= start) {
            const known = yield* sql(() =>
              db
                .prepare('SELECT record FROM records WHERE position=?')
                .get(page.checkpoint.length - 1)
            )
            if (
              page.checkpoint.length === initialCount
                ? hex(initialPoint.head.toBytes()) !== page.checkpoint.headHash
                : !known ||
                  hex(hashRecordBytes(known.record as Uint8Array).toBytes()) !==
                    page.checkpoint.headHash
            )
              return yield* fail('local-evidence-conflict')
          }
          if (page.startIndex < start && length <= start) return yield* status()
          if (minimumPin && page.checkpoint.length < minimumPin.length)
            return yield* fail('local-evidence-conflict')
          const accepted = yield* Effect.result(
            feed.accept(
              {
                requestOffset: state.offset,
                nextOffset: page.position,
                records: records.slice(overlap),
                upToDate: page.nextCursor === null
              },
              { head, length }
            )
          )
          if (Result.isFailure(accepted)) {
            if (
              accepted.failure.code === 'upgrade-required' &&
              accepted.failure.position !== undefined
            ) {
              upgradeRequiredAt = accepted.failure.position
              return yield* status()
            }
            return yield* accepted.failure
          }
          if (!pending((yield* feed.current()).view)) {
            const view = yield* verified.current()
            minimumPin = { head: view.head, length: view.length }
          }
          if (!pending((yield* feed.current()).view) && length - compactedAt >= 64) {
            const origin = yield* feed
              .rebase()
              .pipe(Effect.provideService(VerifiedLedger, verified))
            yield* sql(() =>
              db
                .prepare('UPDATE cache SET origin=? WHERE id=1')
                .run(JSON.stringify(savedOrigin(origin.state, origin.offset)))
            )
            compactedAt = length
          }
          return yield* status()
        })
        const managementState = Effect.fnUntraced(function* () {
          const view = yield* verified.current()
          const state = view.inspectState(),
            ownKey = hex(device.publicKey.toBytes())
          const self = state.devices.get(ownKey),
            member = self && state.members.get(hex(self.membershipId.toBytes()))
          const continuation = yield* Effect.result(
            Effect.gen(function* () {
              const local = yield* localManagement()
              const active = yield* Context.get(local, EpochCandidateStore).active()
              const pendingSubmission = yield* Context.get(local, SubmissionJournal).load(genesis)
              return !!active || !!pendingSubmission.record
            })
          )
          const mayRotate =
            self?.kind === 'personal' && (member?.role === 'owner' || member?.role === 'admin')
          return {
            epoch: state.epoch.number,
            rotationRequired: state.epoch.rotationRequired,
            updatePending: Result.isFailure(continuation) || continuation.success,
            ...(Result.isFailure(continuation)
              ? { recoveryIssue: 'candidate-unavailable' as const }
              : {}),
            mayRotate,
            devices: [...state.devices].map(([key, entry]) => ({
              key,
              kind: entry.kind,
              machineId: entry.machineId ?? null,
              self: key === ownKey,
              mayRevoke: Result.isSuccess(
                prepareLedgerCommand(view, device.publicKey, {
                  _tag: 'RevokeDevice',
                  target: Result.getOrThrow(Bytes.signingPublicKey(unhex(key)))
                })
              )
            }))
          }
        })
        const refreshManagementHistory = (readHistory: DesktopE2eeManagementRemote['history']) =>
          Effect.gen(function* () {
            const after = (yield* status()).position ?? undefined
            let cursor: string | undefined
            let checkpoint: E2eeWorkspaceHistoryPage['checkpoint'] | undefined
            for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
              if (closing) return yield* fail('closed')
              const page = yield* readHistory({
                workspaceId,
                ...(cursor ? { cursor, checkpoint } : after ? { after } : {})
              })
              checkpoint ??= page.checkpoint
              yield* serial.withPermit(
                Effect.suspend(() => (closing ? Effect.fail(fail('closed')) : ingest(page)))
              )
              if (!page.nextCursor) return undefined
              cursor = page.nextCursor
            }
            return yield* fail('invalid-ledger')
          })
        const manage = Effect.fnUntraced(function* (
          command: DesktopE2eeManagementCommand,
          remote: (signal: AbortSignal) => DesktopE2eeManagementRemote
        ) {
          if (closing) return yield* fail('closed')
          if (managing) return yield* Effect.fail(new Error('e2ee_management_pending'))
          const done = Deferred.makeUnsafe<void, unknown>()
          managing = done
          const result = yield* Effect.exit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (!manager)
                  manager = yield* makeDesktopE2eeManagement({
                    directory,
                    stores: yield* localManagement(),
                    db,
                    genesis,
                    device,
                    custody: options.custody,
                    verified,
                    installed: keys,
                    current: () => feed.current(),
                    ports: (() => {
                      const upstream = remote(networkAbort.signal)
                      return {
                        ...upstream,
                        // Admitted work never re-enters the account lock. Local ingest
                        // failures retain this owner instead of awaiting its own close.
                        refresh: () =>
                          refreshManagementHistory((request) => upstream.history(request)),
                        receive: () =>
                          Effect.gen(function* () {
                            const latest = (yield* verified.current()).inspectState().epoch.number
                            const installedCurrent = yield* Effect.result(keys.check(latest))
                            if (Result.isFailure(installedCurrent))
                              yield* keyRound(
                                () => upstream.mailbox(),
                                () => upstream.staging(),
                                () => upstream.history
                              )
                            // A later installed epoch can restore an older pending publication key.
                            yield* Context.get(historyContext, InstalledEpochHistory).recover()
                          }).pipe(Effect.asVoid)
                      }
                    })()
                  }).pipe(Scope.provide(scope))
                return yield* manager(command)
              })
            )
          )
          managing = undefined
          yield* Deferred.done(
            done,
            Exit.isSuccess(result) ? Exit.succeed(undefined) : Exit.failCause(result.cause)
          )
          return yield* result
        })
        return {
          manage,
          managementState,
          scope,
          pairing,
          remotePairing,
          personalPairing,
          memberApprovals,
          status,
          ledgerView,
          ingest,
          observe,
          seal,
          openContent,
          rpc,
          sharing,
          refreshSharingLedger: refreshManagementHistory,
          keyRound,
          stop,
          isClosing: () => closing,
          close: closeEntry,
          restartRequired: () => closeFailed
        }
      }).pipe(Scope.provide(scope))
      const result = yield* Effect.result(make)
      if (Result.isFailure(result)) {
        yield* Scope.close(scope, Exit.void)
        return yield* Effect.fail(result.failure)
      }
      entries.set(workspaceId, result.success)
      return result.success
    })
    const run = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      Effect.uninterruptible(
        serial.withPermit(
          Effect.suspend(() => (stopping ? Effect.fail(fail('closed')) : boundary(work)))
        )
      )
    const beginCloseWorkspace = (workspaceId: string) =>
      run(
        Effect.sync(() => {
          const entry = entries.get(workspaceId)
          if (!entry) return Effect.void
          entry.stop()
          return Effect.gen(function* () {
            yield* entry.close
            yield* serial.withPermit(
              Effect.sync(() => {
                if (entries.get(workspaceId) === entry) entries.delete(workspaceId)
              })
            )
          })
        })
      )
    const closeWorkspace = (workspaceId: string) =>
      Effect.flatMap(beginCloseWorkspace(workspaceId), (work) => work)
    const close = Effect.gen(function* () {
      stopping = true
      const owners = yield* serial.withPermit(
        Effect.sync(() => {
          const active = [...entries.values()]
          for (const entry of active) entry.stop()
          return active
        })
      )
      const results = yield* Effect.forEach(owners, (entry) => Effect.exit(entry.close), {
        concurrency: 'unbounded'
      })
      const failed = results.find(Exit.isFailure)
      if (failed && Exit.isFailure(failed)) return yield* Effect.failCause(failed.cause)
      return entries.clear()
    })
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie))
    function withPairing<A>(
      workspaceId: string,
      work: (pairing: ReturnType<typeof makeDesktopLocalPairing>) => Effect.Effect<A, unknown>
    ) {
      return run(
        Effect.suspend(() => {
          const entry = entries.get(workspaceId)
          if (!entry || entry.isClosing()) return Effect.fail(fail('closed'))
          return work(entry.pairing).pipe(
            Effect.mapError((error) => {
              const code = (error as { code?: string })?.code
              return fail(
                code === 'conflict' ||
                  code === 'corrupt' ||
                  code === 'storage' ||
                  code === 'local-evidence-conflict'
                  ? code
                  : 'invalid-input'
              )
            })
          )
        })
      )
    }
    const withSharingHistory = (
      entry: {
        refreshSharingLedger: (
          read: DesktopE2eeManagementRemote['history']
        ) => Effect.Effect<void, unknown>
      },
      workspaceId: string,
      remote: SharingRemote,
      readHistory?: DesktopE2eeManagementRemote['history']
    ): SharingRemote => ({
      ...remote,
      ...(readHistory
        ? {
            refreshLedger: () =>
              entry.refreshSharingLedger((request) =>
                Effect.flatMap(options.bootstrap.deviceCredential(workspaceId), (credential) =>
                  readHistory({ ...request, credential })
                )
              )
          }
        : {})
    })
    return {
      remoteMachineOffer: (
        workspaceId: string,
        args: { accountId: string; deploymentUrl: string; ingressUrl: string }
      ) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.remotePairing.offer(args))),
      stageRemoteMachine: (
        workspaceId: string,
        session: string,
        material: LocalE2eePrepareResponse
      ) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.remotePairing.stage(session, material)
          )
        ),
      approveRemoteMachine: (workspaceId: string, session: string, summary: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.remotePairing.approve(session, summary)
          )
        ),
      confirmRemoteMachine: (workspaceId: string, session: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.remotePairing.confirmed(session)
          )
        ),
      retireRemoteMachine: (workspaceId: string, session: string, noAdmissionReserved: boolean) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.remotePairing.retire(session, noAdmissionReserved)
          )
        ),
      managementState: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.managementState())),
      manage: (
        workspaceId: string,
        command: DesktopE2eeManagementCommand,
        ports: (signal: AbortSignal) => DesktopE2eeManagementRemote
      ) =>
        Effect.flatMap(run(openWorkspace(workspaceId)), (entry) =>
          entry.manage(command, ports)
        ).pipe(
          Effect.mapError((error) => {
            rememberDesktopE2eeFailure('workspace-management', error)
            if (error instanceof DesktopE2eeRuntimeError) return error
            if (error instanceof MachineSharingError) return fail(error.code)
            if (
              error instanceof Error &&
              ['e2ee_machine_not_owned', 'e2ee_machine_not_shared'].includes(error.message)
            )
              return fail(
                error.message === 'e2ee_machine_not_owned'
                  ? 'machine_not_owned'
                  : 'machine_not_shared'
              )
            const cause = (error as { cause?: unknown })?.cause ?? error
            const code = (cause as { code?: string })?.code
            if (
              typeof code === 'string' &&
              /e2ee_(?:staging_configuration|projection_corrupt|workspace_rebuild_required|ledger_budget_exceeded|ledger_configuration)/.test(
                code
              )
            )
              return fail('management_operator_required')
            const reason = (error as { reason?: string })?.reason
            return fail(
              reason === 'candidate-missing' || reason === 'corrupt' || reason === 'native-failed'
                ? 'rotation_candidate_unavailable'
                : reason === 'unauthorized'
                  ? 'management_unauthorized'
                  : 'management_retry'
            )
          })
        ),
      memberOffer: (workspaceId: string, mode: 'email' | 'link', expiresAt: number) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.memberApprovals.offer(mode, expiresAt)
          )
        ),
      prepareMemberAdmission: (workspaceId: string, keyPackageHex: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.memberApprovals.prepare(keyPackageHex)
          )
        ),
      inspectMemberAdmission: (workspaceId: string, keyPackageHex: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.memberApprovals.inspect(keyPackageHex)
          )
        ),
      personalPairingOffer: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.personalPairing.offer())),
      cancelPersonalPairing: (workspaceId: string, session: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.personalPairing.cancel(session)
          )
        ),
      retirePersonalPairing: (workspaceId: string, session: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.personalPairing.retire(session)
          )
        ),
      previewPersonalAdmission: (workspaceId: string, requestHex: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.personalPairing.preview(requestHex)
          )
        ),
      preparePersonalAdmission: (workspaceId: string, requestHex: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.personalPairing.approve(requestHex)
          )
        ),
      personalInvitation: (workspaceId: string, session: string) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.personalPairing.invitation(session)
          )
        ),
      resetLocalPairing: (workspaceId: string, resetId: string) =>
        withPairing(workspaceId, (pairing) => pairing.reset(resetId)),
      localPairingContext: (workspaceId: string) =>
        withPairing(workspaceId, (pairing) => pairing.context()),
      retireSupersededLocalPairing: (
        workspaceId: string,
        session: string,
        retainFailure: (error: unknown) => void
      ) =>
        withPairing(workspaceId, (pairing) =>
          pairing
            .retireSuperseded(session)
            .pipe(Effect.tapError((error) => Effect.sync(() => retainFailure(error))))
        ),
      stageLocalPairing: (workspaceId: string, material: LocalE2eePrepareResponse) =>
        withPairing(workspaceId, (pairing) => pairing.stage(material)),
      approveLocalPairing: (workspaceId: string, session: string) =>
        withPairing(workspaceId, (pairing) => pairing.approve(session)),
      confirmLocalPairing: (workspaceId: string, session: string) =>
        withPairing(workspaceId, (pairing) => pairing.confirmed(session)),
      open: (
        workspaceId: string,
        observed?: ObservedCheckpoint,
        proof?: readonly E2eeWorkspaceHistoryPage[]
      ) =>
        run(Effect.flatMap(openWorkspace(workspaceId, observed, proof), (entry) => entry.status())),
      status: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.status())),
      // The lookup is serialized locally; mailbox/network work deliberately
      // runs after releasing the host's resource lock.
      keyRound: (
        workspaceId: string,
        mailbox: (signal: AbortSignal) => KeyMailbox['Service'],
        staging?: (signal: AbortSignal) => EpochStagingStore['Service'],
        refreshLedger?: (signal: AbortSignal) => DesktopE2eeManagementRemote['history']
      ) =>
        Effect.flatMap(
          run(
            Effect.suspend(() =>
              entries.has(workspaceId)
                ? Effect.succeed(entries.get(workspaceId)!)
                : Effect.fail(fail('closed'))
            )
          ),
          (entry) => entry.keyRound(mailbox, staging, refreshLedger)
        ),
      seal: (workspaceId: string, input: E2eeContentSeal) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.seal(input))),
      openContent: (workspaceId: string, input: E2eeContentOpen) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.openContent(input))),
      // Read only an existing entry. Unlike status/readMachineSharing this never
      // calls openWorkspace, opens storage, refreshes grants or discovers a target.
      inspectCachedState: (workspaceId: string, machineId: string) =>
        run(
          Effect.sync(() => {
            const entry = entries.get(workspaceId)
            return {
              workspaceId,
              machineId,
              entryPresent: Boolean(entry),
              ...(entry?.sharing.inspectCache(machineId) ?? {
                cachedPolicies: 0,
                cachedExecutionGrants: 0
              })
            }
          })
        ),
      readMachineSharing: (
        workspaceId: string,
        machineId: string,
        remote: SharingRemote,
        readHistory?: DesktopE2eeManagementRemote['history']
      ) =>
        Effect.flatMap(run(openWorkspace(workspaceId)), (entry) =>
          entry.sharing.read(machineId, withSharingHistory(entry, workspaceId, remote, readHistory))
        ).pipe(boundary),
      updateMachineSharing: (
        workspaceId: string,
        machineId: string,
        generation: string,
        requestId: string,
        change: import('@lody/platform').E2eeMachineSharingChange,
        remote: SharingRemote,
        readHistory?: DesktopE2eeManagementRemote['history']
      ) =>
        Effect.flatMap(run(openWorkspace(workspaceId)), (entry) =>
          entry.sharing.write(
            machineId,
            generation,
            requestId,
            change,
            withSharingHistory(entry, workspaceId, remote, readHistory)
          )
        ).pipe(boundary),
      prepareDispatch: (
        workspaceId: string,
        targetMachineId: string,
        input: E2eeDispatchInput,
        remote?: SharingRemote,
        readHistory?: DesktopE2eeManagementRemote['history']
      ) =>
        Effect.flatMap(run(openWorkspace(workspaceId)), (entry) =>
          entry.rpc.prepareDispatch(
            targetMachineId,
            input,
            remote
              ? (machineId) =>
                  Effect.gen(function* () {
                    const status = yield* entry.status()
                    // A retained verified withdrawal answers locally; only a newer
                    // verified read (machine-sharing views) can release it.
                    if (
                      yield* entry.sharing.knownDenial(
                        machineId,
                        status.signingPublicKey ?? '',
                        undefined
                      )
                    )
                      return false
                    const decision = yield* entry.sharing.authorize(
                      machineId,
                      status.signingPublicKey ?? '',
                      undefined,
                      withSharingHistory(entry, workspaceId, remote, readHistory)
                    )
                    // An unverifiable policy is not a known withdrawal.
                    if (!decision.allowed && decision.reason === 'policy-unavailable')
                      return yield* Effect.fail(new Error('e2ee_machine_sharing_unavailable'))
                    return decision.allowed
                  })
              : undefined
          )
        ).pipe(boundary),
      prepareFeatureRpc: (
        workspaceId: string,
        input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput
      ) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.rpc.prepareFeature(input))),
      acceptFeatureRpcResponse: (
        workspaceId: string,
        input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput,
        frame: string
      ) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.rpc.acceptFeatureResponse(input, frame)
          )
        ),
      acceptDispatchResponse: (
        workspaceId: string,
        targetMachineId: string,
        input: E2eeDispatchInput,
        frameHex: string
      ) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.rpc.acceptResponse(targetMachineId, input, frameHex)
          )
        ),
      ledgerView: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.ledgerView())),
      ingestLedgerRecords: (workspaceId: string, page: E2eeWorkspaceHistoryPage) =>
        run(
          Effect.suspend(() => {
            const entry = entries.get(workspaceId)
            return entry && !entry.isClosing() ? entry.ingest(page) : Effect.fail(fail('closed'))
          })
        ).pipe(
          Effect.onError((cause) =>
            cause.reasons.every(
              (reason) =>
                reason._tag === 'Fail' &&
                reason.error instanceof DesktopE2eeRuntimeError &&
                reason.error.code === 'invalid-input'
            )
              ? Effect.void
              : closeWorkspace(workspaceId).pipe(Effect.orDie)
          )
        ),
      beginCloseWorkspace,
      closeWorkspace,
      close
    }
  }
)
