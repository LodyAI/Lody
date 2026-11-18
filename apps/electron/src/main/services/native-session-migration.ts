import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SessionId, WorkspaceId } from '@lody/shared/ids'
import {
  workspaceMetaCommandSchema,
  WorkspaceMetaIpcError,
  type WorkspaceMetaPublicCommand
} from '@lody/shared/native-workspace-meta-ipc'
import {
  nativeSessionBodyFreezeResponseSchema,
  type NativeSessionBodyFreezeRequest,
  type NativeSessionBodyFreezeResponse
} from '@lody/shared/native-session-body-control'
import {
  readLocalNativeSessionMigration,
  resolveLocalNativeSessionPaths
} from '@lody/shared/node/native-session-routing'
import type { NativeLocalSessionOwnerLegacy } from '@lody/shared/node/native-session-owner'
import type {
  FrozenLoroDocumentSource,
  NativeLoroDocumentMigration
} from '@lody/shared/node/native-loro-document-migration'
import type {
  createNativeWorkspaceMeta,
  NativeWorkspaceMetaSnapshot
} from '@lody/shared/node/native-workspace-meta'
import {
  calculateNativeSessionCreationIntentSha256,
  reserveNativeSessionMetadata,
  assertNativeSessionMetadataReservation
} from '@lody/shared/node/native-session-meta-reservation'
import type {
  RendererSessionBodyMigrationMainLegacy,
  FrozenRendererSessionBodyReceipt
} from './renderer-session-body-migration'

type Metadata = ReturnType<typeof createNativeWorkspaceMeta>
type Command = Extract<WorkspaceMetaPublicCommand, { kind: 'upsert-doc' }>
type Verification = Parameters<
  NonNullable<Parameters<NativeLoroDocumentMigration['migrate']>[1]['verifyState']>
>[0]
export type NativeSessionMigrationScope = {
  accountId: string
  workspaceId: WorkspaceId
  machineId: string
  dataRoot: string
  metadata: Metadata
  owner: NativeLocalSessionOwnerLegacy
  windows: RendererSessionBodyMigrationMainLegacy
  control(
    request: NativeSessionBodyFreezeRequest
  ): Promise<NativeSessionBodyFreezeResponse & { snapshot?: Uint8Array }>
  assertCurrent(): void
}
const intentSchema = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    kind: z.enum(['existing', 'created']),
    completed: z.literal(true).optional(),
    sessionId: z.string().min(1),
    creationIntentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()
type Intent = z.infer<typeof intentSchema>
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
/** Product-local per-Session coordinator. It borrows actual Meta/body/window
 * owners, never opens the classic writer, and never replays an uncertain author.
 * The intent nonce is durable before prepare, while the legacy route stays open;
 * only the kernel may publish a frozen/native body route. */
export class NativeSessionMigrationMainLegacy {
  private retired = false
  private readonly jobs = new Map<string, Promise<unknown>>()
  private readonly databases = new Map<string, DatabaseSync>()
  constructor(
    private readonly options: {
      resolve(windowId: number, registrationId: string): Promise<NativeSessionMigrationScope>
      /** Trusted Node verifier. Must compare lossless values in an independent
       * temporary engine and join its actual cleanup before acknowledging. */
      verifyState(scope: NativeSessionMigrationScope, input: Verification): Promise<void>
    }
  ) {}
  private check(scope: NativeSessionMigrationScope) {
    if (this.retired) throw new Error('Session migration coordinator retired')
    scope.assertCurrent()
    scope.metadata.assertCurrent()
    if (
      scope.metadata.binding.accountId !== scope.accountId ||
      scope.metadata.binding.workspaceId !== scope.workspaceId ||
      scope.owner.factory.binding.accountId !== scope.accountId ||
      scope.owner.factory.binding.workspaceId !== scope.workspaceId ||
      scope.windows.binding.accountId !== scope.accountId ||
      scope.windows.binding.workspaceId !== scope.workspaceId
    )
      throw new Error('Session migration owner binding changed')
  }
  private key(scope: NativeSessionMigrationScope, sessionId: string) {
    return JSON.stringify([scope.accountId, scope.workspaceId, sessionId])
  }
  private database(scope: NativeSessionMigrationScope) {
    const selected = resolveLocalNativeSessionPaths(scope),
      path = join(selected.directory, 'session-migration-intents.sqlite3')
    let db = this.databases.get(path)
    if (!db) {
      db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=WAL')
      db.exec('PRAGMA synchronous=FULL')
      db.exec(
        'CREATE TABLE IF NOT EXISTS session_migration_intents(binding TEXT NOT NULL,session_id TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(binding,session_id)) WITHOUT ROWID'
      )
      this.databases.set(path, db)
    }
    return { db, binding: selected.migrationBinding }
  }
  private intent(
    scope: NativeSessionMigrationScope,
    sessionId: string,
    kind: Intent['kind'],
    creationIntentSha256?: string
  ): Intent {
    const { db, binding } = this.database(scope)
    const row = db
      .prepare('SELECT intent FROM session_migration_intents WHERE binding=? AND session_id=?')
      .get(binding, sessionId) as { intent: string } | undefined
    const frozen = readLocalNativeSessionMigration(scope, `session-${sessionId}`)
    if (frozen?.stage === 'rollback')
      throw new Error('Session rollback requires its original recovery owner')
    if (row) {
      const saved = intentSchema.parse(JSON.parse(row.intent))
      if (
        saved.sessionId !== sessionId ||
        saved.kind !== kind ||
        (creationIntentSha256 !== undefined &&
          saved.creationIntentSha256 !== creationIntentSha256) ||
        (frozen && frozen.manifest.migrationId !== saved.nonce)
      )
        throw new Error('Conflicting Session migration intent')
      return saved
    }
    const saved: Intent = {
      version: 1,
      sessionId,
      kind,
      nonce: frozen?.manifest.migrationId ?? randomUUID(),
      ...(creationIntentSha256
        ? { creationIntentSha256 }
        : frozen?.manifest.creationIntentSha256
          ? { creationIntentSha256: frozen.manifest.creationIntentSha256 }
          : {})
    }
    intentSchema.parse(saved)
    if (frozen && (frozen.manifest.origin === 'created') !== (kind === 'created'))
      throw new Error('Session migration origin changed')
    db.prepare(
      'INSERT INTO session_migration_intents(binding,session_id,intent) VALUES(?,?,?)'
    ).run(binding, sessionId, JSON.stringify(saved))
    return saved
  }
  private async control(
    scope: NativeSessionMigrationScope,
    intent: Intent,
    phase: NativeSessionBodyFreezeRequest['phase']
  ) {
    this.check(scope)
    const input = {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: intent.sessionId,
      nonce: intent.nonce,
      phase
    }
    const actual = await scope.control(input),
      { snapshot, ...body } = actual
    const reply = nativeSessionBodyFreezeResponseSchema.parse(body)
    this.check(scope)
    if (
      !reply.ok ||
      reply.accountId !== input.accountId ||
      reply.workspaceId !== input.workspaceId ||
      reply.sessionId !== input.sessionId ||
      reply.nonce !== input.nonce ||
      reply.phase !== phase
    )
      throw new Error('Exact CLI Session migration authority unavailable')
    return { ...reply, snapshot }
  }
  private async metadata(scope: NativeSessionMigrationScope, sessionId: string) {
    this.check(scope)
    const meta = await scope.metadata.document(`session-${sessionId}`).read()
    this.check(scope)
    if (
      !meta ||
      meta.id !== sessionId ||
      meta.historyBackend === 'roost' ||
      (meta.historyBackend !== undefined && meta.historyBackend !== 'loro')
    )
      throw new Error('Existing Loro Session metadata unavailable')
    return meta
  }
  private async run<T>(
    scope: NativeSessionMigrationScope,
    sessionId: string,
    work: () => Promise<T>
  ): Promise<T> {
    this.check(scope)
    const key = this.key(scope, sessionId),
      existing = this.jobs.get(key)
    if (existing) {
      await existing
      return this.run(scope, sessionId, work)
    }
    const raw = Promise.resolve().then(work)
    this.jobs.set(key, raw)
    try {
      return await raw
    } finally {
      if (this.jobs.get(key) === raw) this.jobs.delete(key)
    }
  }
  private async finalize(
    scope: NativeSessionMigrationScope,
    intent: Intent,
    receipt?: FrozenRendererSessionBodyReceipt
  ) {
    this.check(scope)
    if (intent.completed) return
    if (receipt) await scope.windows.published(receipt)
    else await scope.windows.reconcilePublished(intent.sessionId, intent.nonce)
    this.check(scope)
    await this.control(scope, intent, 'publish')
    this.check(scope)
    const { db, binding } = this.database(scope)
    const row = db
      .prepare('SELECT intent FROM session_migration_intents WHERE binding=? AND session_id=?')
      .get(binding, intent.sessionId) as { intent: string } | undefined
    if (!row || intentSchema.parse(JSON.parse(row.intent)).nonce !== intent.nonce)
      throw new Error('Session completion intent changed')
    const completed = { ...intent, completed: true as const }
    if (
      db
        .prepare(
          'UPDATE session_migration_intents SET intent=? WHERE binding=? AND session_id=? AND intent=?'
        )
        .run(JSON.stringify(completed), binding, intent.sessionId, row.intent).changes !== 1
    )
      throw new Error('Session completion intent raced')
    intent.completed = true
  }
  private async capture(scope: NativeSessionMigrationScope, intent: Intent) {
    const receipt = await scope.windows.freezeAndCapture(intent.sessionId, intent.nonce)
    this.check(scope)
    const cli = await this.control(scope, intent, 'freeze')
    if (
      (cli.phase !== 'freeze' && cli.phase !== 'assert') ||
      !cli.source ||
      !(cli.snapshot instanceof Uint8Array) ||
      cli.source.present !== Boolean(cli.snapshot.byteLength)
    )
      throw new Error('Complete CLI Session binary capture required')
    const expectedId = `cli-sqlite:loro-doc-layout1:${scope.workspaceId}:${intent.sessionId}`
    if (cli.source.sourceId !== expectedId) throw new Error('Foreign CLI Session source')
    const sources: FrozenLoroDocumentSource[] = [
      { sourceId: expectedId, present: cli.source.present, bytes: Uint8Array.from(cli.snapshot) },
      ...receipt.sources.map((source) => ({
        sourceId: source.sourceId,
        present: source.present,
        bytes: Uint8Array.from(source.snapshot)
      }))
    ]
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length)
      throw new Error('Duplicate Session source')
    const assertCurrent = () => {
      this.check(scope)
      scope.windows.assertFrozen(receipt)
    }
    const assertFresh = async () => {
      assertCurrent()
      const latest = await this.control(scope, intent, 'assert')
      assertCurrent()
      if (
        latest.phase !== 'assert' ||
        latest.ownerGeneration !== cli.ownerGeneration ||
        !isDeepStrictEqual(latest.source, cli.source)
      )
        throw new Error('CLI Session frozen source changed')
      await this.metadata(scope, intent.sessionId)
      assertCurrent()
    }
    return { receipt, cli, sources, assertCurrent, assertFresh }
  }
  async ensureMigrated(windowId: number, registrationId: string, sessionId: string): Promise<void> {
    const scope = await this.options.resolve(windowId, registrationId)
    return this.run(scope, sessionId, async () => {
      this.check(scope)
      const initial = await scope.metadata.document(`session-${sessionId}`).read()
      this.check(scope)
      const prior = readLocalNativeSessionMigration(scope, `session-${sessionId}`)
      if (initial?.id === sessionId && initial.historyBackend === 'roost') {
        if (prior && prior.stage !== 'legacy')
          throw new Error('Roost conflicts with a native Loro body journal')
        return
      }
      await this.metadata(scope, sessionId)
      if (prior?.stage === 'native') {
        const { db, binding } = this.database(scope)
        if (
          !db
            .prepare('SELECT 1 FROM session_migration_intents WHERE binding=? AND session_id=?')
            .get(binding, sessionId)
        )
          return
      }
      const kind = prior?.manifest.origin === 'created' ? 'created' : 'existing',
        intent = this.intent(scope, sessionId, kind)
      if (prior?.stage === 'native') {
        if (kind === 'created') await this.assertReservation(scope, intent)
        await this.finalize(scope, intent)
        return
      }
      if (kind === 'created') {
        if (!prior) throw new Error('Original creation required')
        await this.ensureCreated(scope, intent, false)
        return
      }
      // The daemon retains this nonce/admission barrier on uncertain replies.
      // Busy/missing endpoint refuses here while the legacy route is unchanged.
      let enumeration: Awaited<ReturnType<RendererSessionBodyMigrationMainLegacy['enumerate']>>
      try {
        await this.control(scope, intent, 'prepare')
        enumeration = await scope.windows.enumerate(sessionId)
        this.check(scope)
      } catch (error) {
        if (!prior && !readLocalNativeSessionMigration(scope, `session-${sessionId}`)) {
          // Positive legacy route proof, not an acquisition fallback: no body
          // author or route freeze has occurred. Keep its UI and writer usable.
          // Release is an exact nonce operation; unknown release stays owned by
          // the daemon and the durable intent keeps that nonce for a later try.
          try {
            await this.control(scope, intent, 'abort')
          } catch {
            /* original daemon barrier retained */
          }
          return
        }
        throw error
      }
      let captured: Awaited<ReturnType<NativeSessionMigrationMainLegacy['capture']>> | undefined
      const ids = prior?.manifest.sourceIds ?? [
        `cli-sqlite:loro-doc-layout1:${scope.workspaceId}:${sessionId}`,
        ...enumeration.databases.map((value) => value.sourceId)
      ]
      const archived = prior
        ? await scope.owner.readArchivedSources(sessionId as SessionId)
        : undefined
      await scope.owner.migrate(
        {
          sessionId: sessionId as SessionId,
          migrationId: intent.nonce,
          sourceIds: ids,
          historyBackend: 'loro'
        },
        {
          drainLegacy: async () => {
            captured = await this.capture(scope, intent)
            if (!archived) {
              if (
                !isDeepStrictEqual(
                  [...ids].sort(),
                  captured.sources.map((value) => value.sourceId).sort()
                )
              )
                throw new Error('Original Session source inventory unavailable')
              return captured.sources
            }
            const originals = new Map(archived.map((value) => [value.sourceId, value]))
            for (const current of captured.sources) {
              const old = originals.get(current.sourceId)
              if (!old) {
                if (current.present !== false)
                  throw new Error('New Session database contains an unarchived body')
                continue
              }
              if (
                current.present !== false &&
                (old.present === false || digest(current.bytes) !== digest(old.bytes))
              )
                throw new Error('Frozen Session source differs from archive')
            }
            return archived
          },
          verifyState: async (input) => {
            this.check(scope)
            await this.options.verifyState(scope, input)
            this.check(scope)
          },
          beforePublish: async () => {
            if (!captured) throw new Error('Session capture missing')
            await captured.assertFresh()
          }
        }
      )
      if (!captured) throw new Error('Session publication capture missing')
      await this.finalize(scope, intent, captured.receipt)
    })
  }
  private assertReservation(scope: NativeSessionMigrationScope, intent: Intent) {
    if (!intent.creationIntentSha256) throw new Error('Original creation intent hash required')
    return assertNativeSessionMetadataReservation({
      owner: scope.metadata,
      sessionId: intent.sessionId,
      reservationId: intent.nonce,
      creationIntentSha256: intent.creationIntentSha256,
      actorId: scope.accountId,
      machineId: scope.machineId,
      assertCurrent: () => this.check(scope)
    })
  }
  async createSession(
    windowId: number,
    registrationId: string,
    input: Command,
    authorize: (snapshot: NativeWorkspaceMetaSnapshot) => void
  ): Promise<{ outcome: 'committed'; snapshot: NativeWorkspaceMetaSnapshot }> {
    const command = workspaceMetaCommandSchema.parse(input)
    if (command.kind !== 'upsert-doc' || !command.docId.startsWith('session-'))
      throw new WorkspaceMetaIpcError('not_committed')
    const sessionId = command.docId.slice(8),
      scope = await this.options.resolve(windowId, registrationId)
    return this.run(scope, sessionId, async () => {
      if (command.patch.historyBackend === 'roost') {
        const prior = readLocalNativeSessionMigration(scope, command.docId)
        if (prior && prior.stage !== 'legacy') throw new WorkspaceMetaIpcError('not_committed')
        const receipt = await scope.metadata.commitAuthorized(command, authorize)
        this.check(scope)
        return receipt
      }
      const hash = calculateNativeSessionCreationIntentSha256({
        binding: scope.metadata.binding,
        sessionId,
        patch: command.patch
      })
      const prior = readLocalNativeSessionMigration(scope, command.docId),
        intent = this.intent(scope, sessionId, 'created', hash)
      if (prior) {
        // A persisted frozen/native attempt is reconciliation only. The mutable
        // incoming title/config never authorizes replay of its initial metadata.
        await this.ensureCreated(scope, intent, prior.stage === 'native')
        return { outcome: 'committed', snapshot: await scope.metadata.externalMetadata.read() }
      }
      let captured: Awaited<ReturnType<NativeSessionMigrationMainLegacy['capture']>> | undefined
      try {
        await this.control(scope, intent, 'prepare')
        await scope.windows.enumerate(sessionId)
        this.check(scope)
      } catch (error) {
        if (!readLocalNativeSessionMigration(scope, command.docId))
          throw new WorkspaceMetaIpcError('not_committed')
        throw error
      }
      const reservation = reserveNativeSessionMetadata({
        owner: scope.metadata,
        sessionId,
        reservationId: intent.nonce,
        creationIntentSha256: hash,
        patch: command.patch,
        actorId: scope.accountId,
        machineId: scope.machineId,
        assertCurrent: () => this.check(scope),
        absenceWitness: () => {
          if (!captured) throw new Error('Session absence capture missing')
          return {
            sources: captured.sources.map((value) => ({
              sourceId: value.sourceId,
              present: value.present !== false
            })),
            assertCurrent: captured.assertCurrent
          }
        },
        authorize
      })
      let reservationAdmitted = false
      try {
        await scope.owner.createNew(
          {
            sessionId: sessionId as SessionId,
            reservationId: intent.nonce,
            creationIntentSha256: hash
          },
          {
            drainLegacy: async () => {
              captured = await this.capture(scope, intent)
              return this.creationAbsence(captured)
            },
            reserveMetadata: () => {
              reservationAdmitted = true
              return reservation.reserveMetadata()
            },
            assertReservation: async (id) => {
              await reservation.assertReservation(id)
              if (captured) await captured.assertFresh()
            }
          }
        )
      } catch (error) {
        if (!reservationAdmitted) throw new WorkspaceMetaIpcError('not_committed')
        throw error
      }
      if (!captured) throw new Error('Session absence capture missing')
      await captured.assertFresh()
      await this.finalize(scope, intent, captured.receipt)
      this.check(scope)
      return { outcome: 'committed', snapshot: await scope.metadata.externalMetadata.read() }
    })
  }
  private creationAbsence(
    captured: Awaited<ReturnType<NativeSessionMigrationMainLegacy['capture']>>,
    archived?: readonly FrozenLoroDocumentSource[]
  ) {
    if (captured.sources.some((value) => value.present !== false))
      throw new Error('New Session has an existing legacy body')
    if (archived?.some((value) => value.present !== false))
      throw new Error('Invalid original creation absence')
    return {
      sources: (archived ?? captured.sources).map((value) => ({
        sourceId: value.sourceId,
        present: false
      })),
      assertCurrent: captured.assertCurrent
    }
  }
  private async ensureCreated(scope: NativeSessionMigrationScope, intent: Intent, native: boolean) {
    await this.assertReservation(scope, intent)
    if (native) {
      await this.finalize(scope, intent)
      return
    }
    await this.control(scope, intent, 'prepare')
    await scope.windows.enumerate(intent.sessionId)
    const archived = await scope.owner.readArchivedSources(intent.sessionId as SessionId)
    if (!archived) throw new Error('Original creation absence required')
    let captured: Awaited<ReturnType<NativeSessionMigrationMainLegacy['capture']>> | undefined
    await scope.owner.createNew(
      {
        sessionId: intent.sessionId as SessionId,
        reservationId: intent.nonce,
        creationIntentSha256: intent.creationIntentSha256!
      },
      {
        drainLegacy: async () => {
          captured = await this.capture(scope, intent)
          return this.creationAbsence(captured, archived)
        },
        reserveMetadata: async () => {
          await this.assertReservation(scope, intent)
          return { reservationId: intent.nonce }
        },
        assertReservation: async () => {
          await this.assertReservation(scope, intent)
          if (captured) await captured.assertFresh()
        }
      }
    )
    if (!captured) throw new Error('Session creation recovery capture missing')
    await captured.assertFresh()
    await this.finalize(scope, intent, captured.receipt)
  }
  async close() {
    this.retired = true
    await Promise.allSettled([...this.jobs.values()])
    for (const [path, db] of this.databases) {
      if (db.isOpen) db.close()
      this.databases.delete(path)
    }
  }
}
