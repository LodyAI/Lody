import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Data, Effect, Exit, Layer, Result, Scope, Semaphore } from 'effect'
import {
  InstalledEpochHistory,
  InstalledEpochKeys,
  InstalledKeyError,
  LedgerFeed,
  VerifiedLedger
} from '@lody/e2ee-core'
import {
  Bytes,
  exportVerifiedState,
  hashRecordBytes,
  hasVerifiedCheckpoint,
  restoreVerifiedState,
  verifyLedgerEffect,
  type RetainedLedgerState
} from '@lody/e2ee-core/protocol'
import {
  InstalledKeyStore,
  LedgerFeedStore,
  LedgerPinStore,
  LedgerViewSource,
  LedgerViewSourceError,
  LocalStoreError,
  WorkspaceScope
} from '@lody/e2ee-core/services'
import {
  sqliteInstalledKeyStore,
  sqliteLedgerFeedStore,
  sqliteLedgerPinStore
} from '@lody/e2ee-core/adapters/node-sqlite'
import type { E2eeWorkspaceRuntime } from '@lody/platform'
type E2eeWorkspaceHistoryPage = Parameters<E2eeWorkspaceRuntime['ingestLedgerRecords']>[1]
import type { E2eeRuntimeLedgerView, E2eeRuntimeStatus } from '@lody/platform'
import { desktopE2eePorts, type DesktopE2eeCustody } from '../e2ee-custody.mjs'
import type { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mjs'

/** Stable host failures: IPC callers never receive native errors or their raw causes. */
export class DesktopE2eeRuntimeError extends Data.TaggedError('DesktopE2eeRuntimeError')<{
  readonly code:
    | 'closed'
    | 'invalid-input'
    | 'corrupt'
    | 'local-evidence-conflict'
    | 'storage'
    | 'invalid-ledger'
    | 'missing-binding'
}> {}
const fail = (code: DesktopE2eeRuntimeError['code']) => new DesktopE2eeRuntimeError({ code })
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const unhex = (value: string) => {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) throw fail('invalid-input')
  return new Uint8Array(Buffer.from(value, 'hex'))
}
function sql<A>(work: () => A) {
  return Effect.try({
    try: work,
    catch: (error) => (error instanceof DesktopE2eeRuntimeError ? error : fail('storage'))
  })
}
const boundary = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.mapError((error) => {
      if (error instanceof DesktopE2eeRuntimeError) return error
      const reason =
        (error as { code?: string; reason?: string })?.code ??
        (error as { reason?: string })?.reason
      if (reason === 'missing-binding') return fail('missing-binding')
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
    readonly custody: DesktopE2eeCustody
    readonly bootstrap: Effect.Success<ReturnType<typeof makeDesktopE2eeBootstrap>>
  }) {
    const serial = yield* Semaphore.make(1)
    let stopping = false
    const entries = new Map<
      string,
      {
        scope: Scope.Closeable
        status: () => Effect.Effect<E2eeRuntimeStatus, unknown>
        ledgerView: () => Effect.Effect<E2eeRuntimeLedgerView, unknown>
        observe: (checkpoint: ObservedCheckpoint) => Effect.Effect<void, unknown>
        ingest: (page: E2eeWorkspaceHistoryPage) => Effect.Effect<E2eeRuntimeStatus, unknown>
      }
    >()
    const openWorkspace = Effect.fnUntraced(function* (
      workspaceId: string,
      observed?: ObservedCheckpoint
    ) {
      if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
        return yield* fail('invalid-input')
      const openedEntry = entries.get(workspaceId)
      if (openedEntry) {
        if (observed) yield* openedEntry.observe(observed)
        return openedEntry
      }
      const creation = yield* options.bootstrap.creationFor(workspaceId)
      const genesis = yield* Effect.fromResult(Bytes.genesisHash(unhex(creation.genesisHash)))
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
            connection.exec(
              'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(position INTEGER PRIMARY KEY, record BLOB NOT NULL, locator TEXT); CREATE TABLE IF NOT EXISTS cache(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,origin TEXT)'
            )
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
        const storeContext = yield* Layer.buildWithScope(stores, scope)
        const pins = Context.get(storeContext, LedgerPinStore)
        const installedStore = Context.get(storeContext, InstalledKeyStore)
        const pin = yield* pins.read()
        let minimumPin = pin
        const rows = () =>
          db
            .prepare('SELECT position,record,locator FROM records ORDER BY position')
            .all() as unknown as HistoryRow[]
        const originals = yield* sql(rows)
        const endpoint = {
          head: hashRecordBytes(originals[originals.length - 1]!.record),
          length: originals.length
        }
        const currentLocator = () => {
          const row = db
            .prepare(
              'SELECT locator FROM records WHERE locator IS NOT NULL ORDER BY position DESC LIMIT 1'
            )
            .get()
          return typeof row?.locator === 'string' ? row.locator : null
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
        let compactedAt = 1
        let cachedScope: Scope.Closeable | undefined
        const cached = yield* Effect.result(
          Effect.gen(function* () {
            const origin = yield* sql(() =>
              typeof cache.origin === 'string'
                ? restoreOrigin(JSON.parse(cache.origin))
                : { kind: 'genesis' as const, record: creation.record }
            )
            compactedAt = origin.kind === 'retained' ? origin.state.length : 1
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
          compactedAt = 1
          // Cache is disposable; prove the original history and pin before replacing it.
          const view = yield* verifyLedgerEffect({
            anchor: genesis,
            records: originals.map((row) => row.record),
            checkpoint: endpoint
          })
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
          const opened = yield* openFeed(
            name,
            { kind: 'genesis', record: creation.record },
            { head: hashRecordBytes(creation.record), length: 1 }
          )
          feed = opened.feed
          let chunk: Uint8Array[] = []
          for (const row of originals) {
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
          if (chunk.length > 0 && originals.length !== 1) return yield* fail('corrupt')
          yield* sql(() => db.prepare('UPDATE cache SET name=?,origin=NULL WHERE id=1').run(name))
          // Only the replaced, verified-disposable feed is collected. Originals and pins remain.
          if (
            typeof cache.name === 'string' &&
            /^ledger-feed(?:-[a-f0-9-]{36})?\.sqlite$/.test(cache.name)
          ) {
            yield* Effect.tryPromise({
              try: async () => {
                for (const suffix of ['', '-wal', '-shm'])
                  await unlink(join(directory, cache.name as string) + suffix).catch((error) => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                  })
              },
              catch: () => fail('storage')
            })
          }
        }
        const observe = Effect.fnUntraced(function* (expected: ObservedCheckpoint) {
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
          if (minimumPin?.length === point.length && !minimumPin.head.equals(point.head))
            return yield* fail('local-evidence-conflict')
          const current = (yield* feed.current()).view
          if (current.length >= point.length) {
            let contains = Result.getOrThrow(hasVerifiedCheckpoint(current, point))
            if (!contains) {
              const proofRecords = yield* sql(rows)
              const replayed = yield* verifyLedgerEffect({
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
            yield* pins.write(point)
            minimumPin = point
          }
          return undefined
        })
        if (observed) yield* observe(observed)
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
        const keysLayer = InstalledEpochKeys.layer.pipe(
          Layer.provideMerge(Layer.succeed(InstalledKeyStore, installedStore)),
          Layer.provideMerge(Layer.succeed(VerifiedLedger, verified)),
          Layer.provideMerge(base)
        )
        const keysContext = yield* Layer.buildWithScope(keysLayer, scope)
        const keys = Context.get(keysContext, InstalledEpochKeys)
        // insertIfAbsent preserves the creation's original protected key; never repair it.
        yield* installedStore.insertIfAbsent(0, creation.epochBlob)
        if (!pending((yield* feed.current()).view)) yield* keys.check(0)
        yield* Layer.buildWithScope(
          InstalledEpochHistory.layer.pipe(
            Layer.provide(Layer.succeed(VerifiedLedger, verified)),
            Layer.provide(Layer.succeed(InstalledEpochKeys, keys))
          ),
          scope
        )
        let upgradeRequiredAt: number | undefined
        const status = Effect.fnUntraced(function* (): Effect.fn.Return<
          E2eeRuntimeStatus,
          unknown
        > {
          const state = yield* feed.current()
          const publicState = state.view.inspectState()
          const saved = yield* Effect.fromResult(exportVerifiedState(state.view))
          const ownDevice = publicState.devices.get(hex(device.publicKey.toBytes()))
          const continuityPending = pending(state.view)
          const checked = continuityPending
            ? Result.fail(new InstalledKeyError({ reason: 'missing-key' }))
            : yield* Effect.result(keys.check(publicState.epoch.number))
          if (
            Result.isFailure(checked) &&
            checked.failure.reason !== 'missing-key' &&
            checked.failure.reason !== 'unauthorized'
          )
            return yield* checked.failure
          return {
            workspaceId,
            genesisHash: creation.genesisHash,
            length: state.view.length,
            headHash: hex(state.view.head.toBytes()),
            stateDigest: hex(saved.stateDigest.toBytes()),
            position: state.bootstrap ? null : state.offset,
            epoch: publicState.epoch.number,
            rotationRequired: publicState.epoch.rotationRequired,
            deviceKind: ownDevice?.kind ?? null,
            hasCurrentKey: Result.isSuccess(checked),
            continuityPending,
            ...(upgradeRequiredAt === undefined ? {} : { upgradeRequiredAt })
          }
        })
        const ledgerView = Effect.fnUntraced(function* () {
          const current = yield* status()
          const state = yield* feed.current()
          const exported = yield* Effect.fromResult(exportVerifiedState(state.view))
          const recordsHex = yield* sql(() => rows().map((row) => hex(row.record)))
          return { status: current, stateHex: hex(exported.bytes), recordsHex }
        })
        const ingest = Effect.fnUntraced(function* (page: E2eeWorkspaceHistoryPage) {
          const state = yield* feed.current()
          const start = state.bootstrap ? 0 : state.view.length
          if (
            !page ||
            page.workspaceId !== workspaceId ||
            page.genesisHash !== creation.genesisHash ||
            !Number.isSafeInteger(page.startIndex) ||
            page.startIndex < 0 ||
            page.startIndex > start ||
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
              !known ||
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
        return { scope, status, ledgerView, ingest, observe }
      }).pipe(Scope.provide(scope))
      const result = yield* Effect.result(make)
      if (Result.isFailure(result)) {
        yield* Scope.close(scope, Exit.void)
        return yield* result.failure
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
    const close = Effect.gen(function* () {
      stopping = true
      yield* serial.withPermit(
        Effect.gen(function* () {
          for (const entry of entries.values()) yield* Scope.close(entry.scope, Exit.void)
          entries.clear()
        })
      )
    })
    yield* Effect.addFinalizer(() => close)
    return {
      open: (workspaceId: string, observed?: ObservedCheckpoint) =>
        run(Effect.flatMap(openWorkspace(workspaceId, observed), (entry) => entry.status())),
      status: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.status())),
      ledgerView: (workspaceId: string) =>
        run(Effect.flatMap(openWorkspace(workspaceId), (entry) => entry.ledgerView())),
      ingestLedgerRecords: (workspaceId: string, page: E2eeWorkspaceHistoryPage) =>
        run(
          Effect.flatMap(openWorkspace(workspaceId), (entry) =>
            entry.ingest(page).pipe(
              Effect.onError((cause) =>
                cause.reasons.every(
                  (reason) =>
                    reason._tag === 'Fail' &&
                    reason.error instanceof DesktopE2eeRuntimeError &&
                    reason.error.code === 'invalid-input'
                )
                  ? Effect.void
                  : Effect.gen(function* () {
                      yield* Scope.close(entry.scope, Exit.void)
                      entries.delete(workspaceId)
                    })
              )
            )
          )
        ),
      closeWorkspace: (workspaceId: string) =>
        run(
          Effect.gen(function* () {
            const entry = entries.get(workspaceId)
            if (entry) {
              yield* Scope.close(entry.scope, Exit.void)
              entries.delete(workspaceId)
            }
          })
        ),
      close
    }
  }
)
