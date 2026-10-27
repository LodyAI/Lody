import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { makeDesktopPersonalJoins, type PersonalPairingOffer } from './e2ee-personal-pairing.mjs'
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Data, Effect, Layer, Result, Semaphore } from 'effect'
import { InstalledEpochKeys, VerifiedLedger, verifyRetainedWorkspaceGenesis } from '@lody/e2ee-core'
import {
  Bytes,
  decodeRecord,
  hashRecordBytes,
  signGenesisRecord,
  verifyLedgerEffect
} from '@lody/e2ee-core/protocol'
import {
  InstalledKeyStore,
  LedgerPinStore,
  LedgerViewSource,
  LocalStoreError,
  WorkspaceScope
} from '@lody/e2ee-core/services'
import {
  desktopE2eePorts,
  type DesktopE2eeCustody,
  type DesktopE2eeDevice
} from '../e2ee-custody.mjs'

/** Immutable public intent. A retry must supply exactly the original values. */
export interface DesktopE2eeCreationIntent {
  readonly accountId: string
  readonly requestId: string
  readonly name: string
  readonly slug: string
}

/** Public signed material only; safe to send to the authenticated creation endpoint. */
export interface PreparedDesktopE2eeCreation extends DesktopE2eeCreationIntent {
  readonly genesisRecordHex: string
  readonly genesisHashHex: string
  readonly deviceCredentialHash: string
}

export class DesktopE2eeBootstrapError extends Data.TaggedError('DesktopE2eeBootstrapError')<{
  readonly code:
    | 'invalid-input'
    | 'conflict'
    | 'busy'
    | 'incomplete-local'
    | 'corrupt'
    | 'storage'
    | 'closed'
    | 'missing-binding'
    | 'credential-required'
    | 'account-identity-required'
}> {}

const fail = (code: DesktopE2eeBootstrapError['code']) => new DesktopE2eeBootstrapError({ code })
class IdentityReadFailure extends AggregateError {
  constructor(
    readonly primary: unknown,
    cleanup: unknown
  ) {
    super([primary, cleanup], 'account identity read and cleanup failed')
  }
}

const applicationId = 0x4c454243
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
// Only quiesced identity-cache handles enter this process-owned cleanup set.
// Retrying their close never grants authority or blocks unrelated workspace IO.
const pendingIdentityFiles = new Map<Awaited<ReturnType<typeof open>>, string>()
async function retryIdentityFileCloses(directory: string) {
  for (const [file, owner] of pendingIdentityFiles) {
    if (owner !== directory) continue
    try {
      await file.close()
      pendingIdentityFiles.delete(file)
    } catch (cause) {
      if (file.fd === -1) pendingIdentityFiles.delete(file)
      rememberDesktopE2eeFailure('account-identity-cleanup', cause)
    }
  }
}

function sql<A>(work: () => A) {
  return Effect.try({
    try: work,
    catch: (cause) => {
      rememberDesktopE2eeFailure('bootstrap-storage', cause)
      return cause instanceof DesktopE2eeBootstrapError ? cause : fail('storage')
    }
  })
}
function io<A>(work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => {
      rememberDesktopE2eeFailure('bootstrap-storage', cause)
      const primary = cause instanceof IdentityReadFailure ? cause.primary : cause
      return primary instanceof DesktopE2eeBootstrapError ? primary : fail('storage')
    }
  })
}

/** Also validated at IPC; kept here for non-renderer host callers. No normalization on retry. */
export function validateDesktopE2eeCreationIntent(input: DesktopE2eeCreationIntent): void {
  if (
    !input ||
    typeof input.accountId !== 'string' ||
    !input.accountId.length ||
    input.accountId.length > 256 ||
    typeof input.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 200 ||
    typeof input.slug !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(input.slug)
  ) {
    throw fail('invalid-input')
  }
}

async function openOwnedDatabase(path: string) {
  try {
    const file = await open(path, 'wx', 0o600)
    await file.close()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw fail('corrupt')
  } finally {
    await file.close()
  }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL')
  } catch (cause) {
    db.close()
    if ((cause as { errcode?: number }).errcode === 5) throw fail('busy')
    throw cause
  }
  return db
}

type CreationRow = {
  name: string
  slug: string
  record: Uint8Array | null
  epoch_blob: Uint8Array | null
  ready: number
}

/**
 * Account-scoped local creation journal. It owns SQLite handles, borrows custody,
 * and performs no network I/O. The OS SQLite mutex survives neither process exit
 * nor a crash; no PID/age-based lock takeover is used.
 *
 * Original signed bytes are committed before retaining keys. If a crash leaves
 * an incomplete key set, reopening refuses publication and retains every original;
 * it never generates a replacement identity or key for that signed genesis.
 */
export const makeDesktopE2eeBootstrap = Effect.fn('DesktopE2eeBootstrap.open')(function* (options: {
  readonly directory: string
  readonly accountId: string
  readonly custody: DesktopE2eeCustody
  /** Concrete publication boundary; tests inject only filesystem faults. */
  readonly identityFiles?: {
    readonly link: typeof link
    readonly unlink: typeof unlink
    readonly open?: typeof open
  }
}) {
  if (!isAbsolute(options.directory) || !options.accountId) return yield* fail('invalid-input')
  const { directory, accountId, custody } = options
  yield* io(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw fail('corrupt')
  })
  const mutex = yield* Effect.acquireRelease(
    io(() => openOwnedDatabase(join(directory, 'creation-mutex.sqlite'))),
    (resource) => Effect.sync(() => resource.close())
  )
  const db = yield* Effect.acquireRelease(
    io(() => openOwnedDatabase(join(directory, 'creations.sqlite'))),
    (resource) => Effect.sync(() => resource.close())
  )
  const serial = yield* Semaphore.make(1)
  let closed = false
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true
      await retryIdentityFileCloses(directory)
    })
  )

  const lock = sql(() => {
    if (closed) throw fail('closed')
    try {
      mutex.exec('BEGIN EXCLUSIVE')
    } catch {
      throw fail('busy')
    }
  })
  const withLock = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    serial.withPermit(
      Effect.uninterruptible(
        Effect.acquireUseRelease(
          lock,
          () => work,
          () => sql(() => mutex.exec('ROLLBACK')).pipe(Effect.orDie)
        )
      )
    )
  yield* withLock(
    sql(() => {
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      const id = db.prepare('PRAGMA application_id').get()?.application_id
      if (version === 0 && id === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())
          throw fail('corrupt')
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec(`CREATE TABLE metadata(account_id TEXT NOT NULL);
          CREATE TABLE creations(request_id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
          record BLOB, epoch_blob BLOB, ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)));
          PRAGMA application_id=${applicationId}; PRAGMA user_version=1`)
          db.prepare('INSERT INTO metadata(account_id) VALUES(?)').run(accountId)
          db.exec('COMMIT')
        } catch (cause) {
          db.exec('ROLLBACK')
          throw cause
        }
      } else if (version !== 1 || id !== applicationId) throw fail('corrupt')
      db.exec(
        'CREATE TABLE IF NOT EXISTS workspace_bindings(workspace_id TEXT PRIMARY KEY, genesis TEXT UNIQUE NOT NULL, request_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS creation_credentials(request_id TEXT PRIMARY KEY, credential_hash TEXT)'
      )
      if (
        db.prepare('SELECT account_id FROM metadata').all().length !== 1 ||
        db.prepare('SELECT account_id FROM metadata').get()?.account_id !== accountId
      )
        throw fail('corrupt')
    })
  )

  // This unpublished cache is a current-only immutable public file, not SQLite.
  // Never open/migrate the earlier experimental account-identity.sqlite candidate.
  const identityPath = join(directory, 'account-identity.json')
  const identityFiles = options.identityFiles ?? { link, unlink, open }
  const encodeIdentity = (cryptoUserId: string) =>
    Buffer.from(JSON.stringify({ version: 1, accountId, cryptoUserId }) + '\n')
  async function readIdentityFile(path: string): Promise<string | null> {
    await retryIdentityFileCloses(directory)
    let file: Awaited<ReturnType<typeof open>>
    let before: Awaited<ReturnType<typeof lstat>>
    try {
      before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink()) throw fail('corrupt')
      file = await (identityFiles.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
    let primary: unknown
    let result: string | undefined
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size !== before.size ||
        info.size < 1 ||
        info.size > 4096 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw fail('corrupt')
      const raw = Buffer.alloc(info.size + 1)
      let bytesRead = 0
      while (bytesRead < raw.length) {
        const part = await file.read(raw, bytesRead, raw.length - bytesRead, bytesRead)
        if (part.bytesRead === 0) break
        bytesRead += part.bytesRead
      }
      const after = await file.stat()
      const pathAfter = await lstat(path)
      if (
        bytesRead !== info.size ||
        info.dev !== pathAfter.dev ||
        info.ino !== pathAfter.ino ||
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw fail('corrupt')
      let value: unknown
      try {
        value = JSON.parse(raw.subarray(0, bytesRead).toString('utf8'))
      } catch {
        throw fail('corrupt')
      }
      if (
        !value ||
        typeof value !== 'object' ||
        !('cryptoUserId' in value) ||
        typeof value.cryptoUserId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.cryptoUserId) ||
        !raw.subarray(0, bytesRead).equals(encodeIdentity(value.cryptoUserId))
      )
        throw fail('corrupt')
      result = value.cryptoUserId
    } catch (cause) {
      primary = cause
    }
    try {
      await file.close()
    } catch (cause) {
      if (file.fd !== -1) pendingIdentityFiles.set(file, directory)
      if (primary !== undefined) throw new IdentityReadFailure(primary, cause)
      rememberDesktopE2eeFailure('account-identity-cleanup', cause)
    }
    if (primary !== undefined) throw primary
    if (result === undefined) throw fail('storage')
    return result
  }
  const pendingName = /^account-identity\.json\.[0-9a-f]{32}\.pending$/
  // A leftover path is the durable cleanup responsibility. Only a complete,
  // account-bound copy of the published ID may be removed; unknown files stay.
  async function cleanupIdentityCopies(cryptoUserId: string) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (cause) {
      rememberDesktopE2eeFailure('account-identity-cleanup', cause)
      return
    }
    for (const name of files) {
      if (!pendingName.test(name)) continue
      const path = join(directory, name)
      try {
        const id = await readIdentityFile(path)
        if (id === null) continue
        if (id !== cryptoUserId) throw fail('conflict')
        await identityFiles.unlink(path)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
          rememberDesktopE2eeFailure('account-identity-cleanup', cause)
      }
    }
  }
  const cachedIdentity = io(async () => {
    const id = await readIdentityFile(identityPath)
    if (id !== null) await cleanupIdentityCopies(id)
    return id
  })
  const retainIdentity = (value: { accountId: string; cryptoUserId: string }) =>
    io(async () => {
      if (value.accountId !== accountId || !/^[0-9a-f]{64}$/.test(value.cryptoUserId))
        throw fail('invalid-input')
      const previous = await readIdentityFile(identityPath)
      if (previous !== null) {
        if (previous !== value.cryptoUserId) throw fail('conflict')
        await cleanupIdentityCopies(previous)
        return
      }
      const temporary = `${identityPath}.${randomBytes(16).toString('hex')}.pending`
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await (identityFiles.open ?? open)(temporary, 'wx', 0o600)
        await file.writeFile(encodeIdentity(value.cryptoUserId))
        await file.sync()
        await file.close()
        file = undefined
        try {
          await identityFiles.link(temporary, identityPath)
        } catch (cause) {
          // A lost link acknowledgment cannot undo a verified complete original.
          // Preserve its raw cause in main while readback decides the result.
          rememberDesktopE2eeFailure('account-identity-publish', cause)
          const readback = await readIdentityFile(identityPath)
          if (readback === null) throw cause
          if (readback !== value.cryptoUserId) throw fail('conflict')
        }
        if ((await readIdentityFile(identityPath)) !== value.cryptoUserId) throw fail('conflict')
      } finally {
        // Closing/removing a known temporary is auxiliary; retain diagnostics and
        // the path for a future cleanup pass without replacing the primary error.
        try {
          await file?.close()
        } catch (cause) {
          if (file && file.fd !== -1) pendingIdentityFiles.set(file, directory)
          rememberDesktopE2eeFailure('account-identity-cleanup', cause)
        }
        try {
          await identityFiles.unlink(temporary)
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
            rememberDesktopE2eeFailure('account-identity-cleanup', cause)
        }
      }
      await cleanupIdentityCopies(value.cryptoUserId)
    })

  const joins = yield* withLock(sql(() => makeDesktopPersonalJoins({ db, custody })))

  const load = (requestId: string) => {
    const value = db
      .prepare('SELECT name,slug,record,epoch_blob,ready FROM creations WHERE request_id=?')
      .get(requestId)
    if (!value) return null
    if (
      typeof value.name !== 'string' ||
      typeof value.slug !== 'string' ||
      (value.record !== null &&
        (!(value.record instanceof Uint8Array) || value.record.length > 8192)) ||
      (value.epoch_blob !== null &&
        (!(value.epoch_blob instanceof Uint8Array) || value.epoch_blob.length > 8192)) ||
      (value.ready !== 0 && value.ready !== 1) ||
      (value.ready === 1 && (!value.record || !value.epoch_blob))
    )
      throw fail('corrupt')
    return value as CreationRow
  }

  const credentialForCreation = Effect.fnUntraced(function* (
    requestId: string,
    genesis: Bytes.GenesisHash,
    device: DesktopE2eeDevice
  ) {
    const state = yield* sql(() =>
      db
        .prepare('SELECT credential_hash FROM creation_credentials WHERE request_id=?')
        .get(requestId)
    )
    if (!state) return yield* fail('credential-required')
    const credential =
      state.credential_hash === null
        ? (yield* custody.prepareDeviceCredential(genesis, device.publicKey)).credential
        : yield* custody.deviceCredential(genesis, device.publicKey)
    const hash = createHash('sha256').update(Buffer.from(credential, 'hex')).digest('hex')
    if (state.credential_hash !== null && state.credential_hash !== hash)
      return yield* fail('corrupt')
    yield* sql(() =>
      db
        .prepare(
          'UPDATE creation_credentials SET credential_hash=? WHERE request_id=? AND credential_hash IS NULL'
        )
        .run(hash, requestId)
    )
    return hash
  })

  const retained = Effect.fn('DesktopE2eeBootstrap.verifyRetained')(function* (
    requestId: string,
    record: Uint8Array,
    device: DesktopE2eeDevice,
    initialKey?: Bytes.EpochKey
  ) {
    const decoded = yield* Effect.fromResult(decodeRecord(record))
    if (
      decoded.body.type !== 'genesis' ||
      !decoded.body.signer.equals(device.publicKey) ||
      !decoded.body.encryptionPublicKey.equals(device.enc)
    )
      return yield* fail('corrupt')
    const genesis = yield* Effect.fromResult(Bytes.genesisHash(hashRecordBytes(record).toBytes()))
    const view = yield* verifyLedgerEffect({
      anchor: genesis,
      records: [record],
      checkpoint: { head: hashRecordBytes(record), length: 1 }
    })
    function storeSql<A>(work: () => A) {
      return sql(work).pipe(
        Effect.mapError(
          () => new LocalStoreError({ store: 'InstalledKeyStore', reason: 'storage' })
        )
      )
    }
    const ports = Layer.mergeAll(
      desktopE2eePorts(custody, device),
      Layer.succeed(WorkspaceScope, { genesis }),
      Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
      // The immutable retained genesis is also this bootstrap-only store's durable pin.
      Layer.succeed(LedgerPinStore, {
        read: () => Effect.succeed({ head: view.head, length: 1 }),
        write: (pin) =>
          pin.length === 1 && pin.head.equals(view.head)
            ? Effect.void
            : Effect.fail(new LocalStoreError({ store: 'LedgerPinStore', reason: 'corrupt' }))
      }),
      Layer.succeed(InstalledKeyStore, {
        load: (epoch) =>
          storeSql(() => {
            if (epoch !== 0) throw fail('invalid-input')
            return load(requestId)?.epoch_blob ?? null
          }),
        insertIfAbsent: (epoch, blob) =>
          storeSql(() => {
            if (epoch !== 0) throw fail('invalid-input')
            db.prepare(
              'UPDATE creations SET epoch_blob=? WHERE request_id=? AND epoch_blob IS NULL'
            ).run(blob, requestId)
          }),
        // Bootstrap never repairs an unreadable original with a freshly generated key.
        replace: () =>
          Effect.fail(new LocalStoreError({ store: 'InstalledKeyStore', reason: 'corrupt' }))
      })
    )
    const verified = VerifiedLedger.layer.pipe(Layer.provideMerge(ports))
    const installed = InstalledEpochKeys.layer.pipe(Layer.provide(verified))
    yield* Effect.gen(function* () {
      const keys = yield* InstalledEpochKeys
      if (initialKey) yield* keys.saveAndReload(0, initialKey)
      yield* verifyRetainedWorkspaceGenesis({
        genesis,
        record,
        signer: device.publicKey,
        installed: keys
      })
    }).pipe(Effect.provide(installed))
    return genesis
  })

  const prepare = Effect.fn('DesktopE2eeBootstrap.prepareCreation')(function* (
    input: DesktopE2eeCreationIntent
  ) {
    yield* sql(() => {
      validateDesktopE2eeCreationIntent(input)
      if (input.accountId !== accountId) throw fail('invalid-input')
    })
    const intent = Object.freeze({
      accountId,
      requestId: input.requestId,
      name: input.name,
      slug: input.slug
    })
    let row = yield* sql(() => load(intent.requestId))
    if (row && (row.name !== intent.name || row.slug !== intent.slug))
      return yield* fail('conflict')
    if (!row) {
      yield* sql(() => {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('INSERT INTO creations(request_id,name,slug) VALUES(?,?,?)').run(
            intent.requestId,
            intent.name,
            intent.slug
          )
          db.prepare(
            'INSERT INTO creation_credentials(request_id,credential_hash) VALUES(?,NULL)'
          ).run(intent.requestId)
          db.exec('COMMIT')
        } catch (cause) {
          db.exec('ROLLBACK')
          throw cause
        }
      })
      row = yield* sql(() => load(intent.requestId))
    }
    if (
      !(yield* sql(() =>
        db
          .prepare('SELECT request_id FROM creation_credentials WHERE request_id=?')
          .get(intent.requestId)
      ))
    )
      return yield* fail('credential-required')
    let record = row!.record
    if (!record) {
      const cryptoUserId = yield* cachedIdentity
      if (!cryptoUserId) return yield* fail('account-identity-required')
      yield* Effect.acquireUseRelease(
        custody.prepareDevice(),
        (prepared) =>
          Effect.gen(function* () {
            const raw = randomBytes(32)
            const initialKey = Result.getOrThrow(Bytes.epochKey(raw))
            raw.fill(0)
            const signed = yield* signGenesisRecord({
              signer: prepared,
              encryptionPublicKey: prepared.enc,
              initialKey,
              userId: Result.getOrThrow(Bytes.userId(Buffer.from(cryptoUserId, 'hex'))),
              membershipId: Result.getOrThrow(Bytes.membershipId(randomBytes(16)))
            })
            // Write-ahead identity: retries can locate every retained private original.
            yield* sql(() =>
              db
                .prepare('UPDATE creations SET record=? WHERE request_id=? AND record IS NULL')
                .run(signed.record, intent.requestId)
            )
            record = yield* sql(() => load(intent.requestId)!.record!)
            const device = yield* custody.retainDevice(signed.genesis, prepared)
            yield* retained(intent.requestId, record, device, initialKey)
          }),
        (prepared) => custody.discardDevice(prepared)
      )
    }
    const original = record!
    const parsed = yield* Effect.fromResult(decodeRecord(original))
    if (parsed.body.type !== 'genesis') return yield* fail('corrupt')
    const genesis = yield* Effect.fromResult(Bytes.genesisHash(hashRecordBytes(original).toBytes()))
    // Always reopen native private handles and the actual installed key, even for ready retries.
    const deviceCredentialHash = yield* Effect.gen(function* () {
      const device = yield* custody.openDevice(genesis)
      yield* retained(intent.requestId, original, device)
      return yield* credentialForCreation(intent.requestId, genesis, device)
    }).pipe(Effect.mapError(() => fail(row!.ready === 1 ? 'corrupt' : 'incomplete-local')))
    yield* sql(() => {
      db.prepare('UPDATE creations SET ready=1 WHERE request_id=?').run(intent.requestId)
      const actual = load(intent.requestId)
      if (actual?.ready !== 1 || !actual.record || hex(actual.record) !== hex(original))
        throw fail('corrupt')
    })
    return Object.freeze({
      ...intent,
      genesisRecordHex: hex(original),
      genesisHashHex: hex(genesis.toBytes()),
      deviceCredentialHash
    })
  })
  const recordCreated = (input: { workspaceId: string; genesisHash: string; requestId?: string }) =>
    withLock(
      sql(() => {
        if (
          !input ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(input.workspaceId) ||
          !/^[0-9a-f]{64}$/.test(input.genesisHash)
        )
          throw fail('invalid-input')
        const bound = db
          .prepare('SELECT genesis,request_id FROM workspace_bindings WHERE workspace_id=?')
          .get(input.workspaceId)
        if (
          bound &&
          (bound.genesis !== input.genesisHash ||
            (input.requestId !== undefined && bound.request_id !== input.requestId))
        )
          throw fail('conflict')
        const ids = input.requestId
          ? [{ request_id: input.requestId }]
          : db.prepare('SELECT request_id FROM creations WHERE ready=1').all()
        const found = ids.find((item) => {
          const row = load(String(item.request_id))
          return (
            row?.ready === 1 &&
            row.record &&
            hex(hashRecordBytes(row.record).toBytes()) === input.genesisHash
          )
        })
        if (!found) throw fail('missing-binding')
        db.prepare(
          'INSERT OR IGNORE INTO workspace_bindings(workspace_id,genesis,request_id) VALUES(?,?,?)'
        ).run(input.workspaceId, input.genesisHash, String(found.request_id))
        const actual = db
          .prepare('SELECT genesis,request_id FROM workspace_bindings WHERE workspace_id=?')
          .get(input.workspaceId)
        if (actual?.genesis !== input.genesisHash || actual.request_id !== found.request_id)
          throw fail('conflict')
      })
    )
  const creationFor = (workspaceId: string) =>
    withLock(
      Effect.gen(function* () {
        const creation = yield* sql(() => {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw fail('invalid-input')
          const bound = db
            .prepare('SELECT genesis,request_id FROM workspace_bindings WHERE workspace_id=?')
            .get(workspaceId)
          if (!bound) return null
          const row = load(String(bound.request_id))
          if (
            !row?.ready ||
            !row.record ||
            !row.epoch_blob ||
            hex(hashRecordBytes(row.record).toBytes()) !== bound.genesis
          )
            throw fail('corrupt')
          return {
            genesisHash: String(bound.genesis),
            record: new Uint8Array(row.record),
            epochBlob: new Uint8Array(row.epoch_blob),
            invitation: undefined
          }
        })
        return creation ?? (yield* joins.origin(workspaceId))
      })
    )
  return Object.freeze({
    recordAccountIdentity: (value: { accountId: string; cryptoUserId: string }) =>
      withLock(retainIdentity(value)),
    creationNeedsAccountIdentity: (input: DesktopE2eeCreationIntent) =>
      withLock(
        Effect.gen(function* () {
          const signed = yield* sql(() => {
            validateDesktopE2eeCreationIntent(input)
            if (input.accountId !== accountId) throw fail('invalid-input')
            const row = load(input.requestId)
            if (row && (row.name !== input.name || row.slug !== input.slug)) throw fail('conflict')
            return Boolean(row?.record)
          })
          if (signed) return false
          return (yield* cachedIdentity) === null
        })
      ),
    pendingPersonalJoin: (workspaceId: string) => withLock(joins.pending(workspaceId)),
    retirePersonalJoin: (workspaceId: string, pairingSessionId: string) =>
      withLock(joins.retire(workspaceId, pairingSessionId)),
    preparePersonalJoin: (offer: PersonalPairingOffer) => withLock(joins.prepare(offer)),
    acceptPersonalJoin: (workspaceId: string, invitationHex: string) =>
      withLock(joins.accept(workspaceId, invitationHex)),
    prepareCreation: (input: DesktopE2eeCreationIntent) => withLock(prepare(input)),
    recordCreated,
    creationFor,
    deviceCredential: (workspaceId: string) =>
      Effect.gen(function* () {
        const creation = yield* creationFor(workspaceId)
        const genesis = yield* Effect.fromResult(
          Bytes.genesisHash(Buffer.from(creation.genesisHash, 'hex'))
        )
        const device = yield* custody.openDevice(genesis)
        return yield* custody.deviceCredential(genesis, device.publicKey)
      })
  })
})
