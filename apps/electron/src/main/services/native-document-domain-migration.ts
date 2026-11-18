import { z } from 'zod'
import { nativeLoroDocumentManifestSchema } from '@lody/shared/node/native-loro-document-manifest'
import {
  reserveNativeDocumentDomainMetadata,
  nativeDocumentDomainCreationIntentSha256,
  type NativeDocumentDomainCreationIntent
} from '@lody/shared/node/native-document-domain-meta-reservation'
import type {
  createNativeWorkspaceMeta,
  NativeWorkspaceMetaSnapshot
} from '@lody/shared/node/native-workspace-meta'
import type { ScheduleSaveInput } from '@lody/shared'
import type { SessionId } from '@lody/shared/ids'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RepoRpcError, type RepoClient } from '@loro-dev/loro-repo-client'
import {
  NativeLoroDocumentMigration,
  type NativeLoroDocumentManifest,
  type FrozenLoroDocumentSource
} from '@lody/shared/node/native-loro-document-migration'
import { NativeLoroDocumentVerifierLegacy } from '@lody/shared/node/native-document-verification'
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths'
import { readFrozenLegacyLoroDocumentSqlite } from '@lody/shared/node/legacy-loro-document-source'
import type { NativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility'
import {
  nativeDocumentDomainFreezeResponseSchema,
  type NativeDocumentDomainFreezeRequest
} from '@lody/shared/native-document-domain-control'
import {
  documentDomainMigrationScope,
  rendererDocumentDomainScopeSchema,
  DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES,
  type RendererDocumentDomainBinding,
  type RendererDocumentDomainScope
} from '@lody/shared/renderer-document-domain-migration'
import type { NativeDocumentDomainTarget } from '@lody/shared/native-document-domain-ipc'
import {
  prepareScheduleSave,
  scheduleDocumentFromMirrorState,
  buildScheduleRegistryRow
} from '@lody/shared/node/native-schedule-definition'
import { readNativeDocumentDomainRoute } from '@lody/shared/node/native-document-domains'
import type {
  RendererDocumentDomainMigrationMainLegacy,
  FrozenRendererDocumentDomainReceipt
} from './renderer-document-domain-migration'

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
type Intent = {
  version: 1
  scope: RendererDocumentDomainScope
  manifest: NativeLoroDocumentManifest
  rendererSources: { sourceId: string; dbName: string }[]
  creation?: NativeDocumentDomainCreationIntent
}
type ArchivedSource = { sourceId: string; present: boolean; sha256: string; filename: string }
type Archive = {
  version: 1
  scope: RendererDocumentDomainScope
  manifest: NativeLoroDocumentManifest
  sources: ArchivedSource[]
  witnessSha256: string
}
type MigrationPhase =
  | 'metadata_authority'
  | 'renderer_inventory'
  | 'prepare'
  | 'native_owner'
  | 'renderer_capture'
  | 'cli_freeze'
  | 'source_proof'
  | 'meta_reserve'
  | 'meta_assert'
  | 'body_init'
  | 'before_publish'
  | 'cli_assert'
  | 'sr_publish'
  | 'binary_verification'
  | 'renderer_publish'
  | 'cli_publish'
const staticFailureCodes = new Map<string, string>([
  ['New leaf requires complete legacy absence', 'legacy_body_present'],
  ['CLI source changed after physical drain', 'source_changed'],
  ['Leaf metadata requires complete pristine absence', 'metadata_not_pristine'],
  ['Leaf metadata reservation conflict', 'metadata_conflict'],
  ['New leaf target has authored history', 'body_already_authored'],
  ['New leaf target contains unrelated data', 'body_not_pristine'],
  ['Original document authority witnesses missing', 'witness_missing'],
  ['Document renderer drain_failed', 'renderer_drain_failed'],
  ['Document renderer capture_failed', 'renderer_capture_failed']
])
function migrationFailureCode(error: unknown): string {
  if (
    error instanceof RepoRpcError &&
    [
      'room_not_found',
      'encryption_policy_mismatch',
      'protection_blocked',
      'crypto_auth_failed',
      'invalid_patch',
      'invalid_query',
      'precondition_failed',
      'storage',
      'protocol',
      'unsupported',
      'budget_exceeded'
    ].includes(error.code)
  )
    return `sdk_${error.code}`
  if (error instanceof Error) {
    const known = staticFailureCodes.get(error.message)
    if (known) return known
    if (error.name === 'ZodError') return 'invalid_receipt'
    if (
      [
        'CLI document freeze rejected: invalid_request',
        'CLI document freeze rejected: scope_unavailable',
        'CLI document freeze rejected: freeze_unconfirmed'
      ].includes(error.message)
    )
      return error.message.split(': ')[1]!
  }
  return 'unavailable'
}
/** Already-existing local plaintext documents only. Each owner freezes its exact
 * room; original binary sources are immutable before the first native import. */
export class NativeDocumentDomainMigrationLegacy {
  private readonly selected
  private readonly journalPath: string
  private readonly intents: DatabaseSync
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly controllers = new Set<NativeLoroDocumentMigration>()
  private readonly staging = new Set<NativeLoroDocumentVerifierLegacy>()
  private closed = false
  constructor(
    private readonly options: {
      binding: RendererDocumentDomainBinding
      dataRoot: string
      compatibility: NativeRepoSdkCompatibility
      launch: { executable: string; entry: string }
      renderer: RendererDocumentDomainMigrationMainLegacy
      getClient(): Promise<{ client: RepoClient; generation: string; sdkArtifactId: string }>
      control(request: NativeDocumentDomainFreezeRequest): Promise<unknown>
      authorize(scope: RendererDocumentDomainScope): Promise<void>
      assertCurrent(scope: RendererDocumentDomainScope): void
      creation?: {
        metadata: ReturnType<typeof createNativeWorkspaceMeta>
        actorId: string
        machineId: string
        registry: import('@lody/shared/node/native-schedule-definition').NativeScheduleDefinitionRegistry
        authorize(scope: RendererDocumentDomainScope, snapshot: NativeWorkspaceMetaSnapshot): void
      }
    }
  ) {
    if (!options.compatibility.setValue || !options.compatibility.losslessWireI64)
      throw new Error('Verified native document SDK required')
    this.selected = resolveLocalIndependentRepo({
      platform: 'local',
      ...options.binding,
      dataRoot: options.dataRoot
    })
    this.journalPath = join(this.selected.directory, 'document-routes.sqlite3')
    // The composition creates its private independent directory before this
    // explicit migration action. Construction itself never selects a room.
    this.intents = new DatabaseSync(
      join(this.selected.directory, 'document-migration-intents.sqlite3')
    )
    this.intents.exec('PRAGMA journal_mode=WAL')
    this.intents.exec('PRAGMA synchronous=FULL')
    this.intents.exec(
      'CREATE TABLE IF NOT EXISTS document_domain_intents(binding TEXT NOT NULL,room_id TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(binding,room_id)) WITHOUT ROWID'
    )
  }
  private check(scope: RendererDocumentDomainScope) {
    if (this.closed) throw new Error('Document migration retired')
    this.options.assertCurrent(scope)
  }
  private binding() {
    return JSON.stringify([this.options.binding.accountId, this.options.binding.workspaceId])
  }
  private async control(
    scope: RendererDocumentDomainScope,
    nonce: string,
    phase: NativeDocumentDomainFreezeRequest['phase'],
    purpose?: 'create'
  ) {
    this.check(scope)
    const request = {
      accountId: this.options.binding.accountId,
      workspaceId: this.options.binding.workspaceId,
      scope,
      nonce,
      phase,
      ...(purpose ? { purpose } : {})
    }
    const reply = nativeDocumentDomainFreezeResponseSchema.parse(
      await this.options.control(request)
    )
    this.check(scope)
    if (!reply.ok) throw new Error(`CLI document freeze rejected: ${reply.error}`)
    if (
      !reply.ok ||
      reply.accountId !== request.accountId ||
      reply.workspaceId !== request.workspaceId ||
      reply.nonce !== nonce ||
      reply.purpose !== purpose ||
      reply.phase !== phase ||
      !isDeepStrictEqual(reply.scope, scope)
    )
      throw new Error('Exact CLI document authority unavailable')
    return reply
  }
  private readIntent(scope: RendererDocumentDomainScope): Intent | undefined {
    const row = this.intents
      .prepare('SELECT intent FROM document_domain_intents WHERE binding=? AND room_id=?')
      .get(this.binding(), scope.roomId) as { intent: string } | undefined
    if (!row) return undefined
    const value = z
      .object({
        version: z.literal(1),
        scope: rendererDocumentDomainScopeSchema,
        manifest: nativeLoroDocumentManifestSchema,
        rendererSources: z
          .array(z.object({ sourceId: z.string().min(1), dbName: z.string().min(1) }).strict())
          .max(128),
        creation: z
          .object({
            scope: rendererDocumentDomainScopeSchema,
            actorId: z.string().min(1),
            machineId: z.string().min(1),
            createdAt: z.string().min(1),
            initial: z.record(z.string(), z.json())
          })
          .strict()
          .optional()
      })
      .strict()
      .parse(JSON.parse(row.intent)) as Intent
    if (
      !z.uuid().safeParse(value.manifest.migrationId).success ||
      new Set(value.rendererSources.map((source) => source.sourceId)).size !==
        value.rendererSources.length
    )
      throw new Error('Invalid document migration archive identity')
    if (
      value.version !== 1 ||
      !isDeepStrictEqual(value.scope, scope) ||
      value.manifest.binding !== this.binding() ||
      value.manifest.namespace !== this.options.binding.workspaceId ||
      value.manifest.roomId !== scope.roomId ||
      value.manifest.family !== scope.domain
    )
      throw new Error('Document migration intent binding changed')
    if (
      !!value.creation !== (value.manifest.origin === 'created') ||
      (value.creation &&
        (!isDeepStrictEqual(value.creation.scope, scope) ||
          !this.options.creation ||
          nativeDocumentDomainCreationIntentSha256(
            this.options.creation.metadata.binding,
            value.creation
          ) !== value.manifest.creationIntentSha256))
    )
      throw new Error('Persisted leaf creation intent changed')
    return value
  }
  private source(scope: RendererDocumentDomainScope) {
    return readFrozenLegacyLoroDocumentSqlite({
      path: join(
        this.options.dataRoot,
        'loro-repo',
        this.options.binding.workspaceId,
        'repo.sqlite3'
      ),
      roomId: scope.roomId,
      sourceId: `cli-sqlite:loro-doc-layout1:${this.options.binding.workspaceId}:${scope.roomId}`,
      maxBytes: DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES
    })
  }
  private archiveDirectory(intent: Intent) {
    return join(this.selected.directory, 'document-archives', intent.manifest.migrationId)
  }
  private async writeImmutable(path: string, bytes: Uint8Array) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error
      if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes)))
        throw new Error('Immutable document archive changed')
    }
  }
  private async archived(
    intent: Intent,
    witness: FrozenRendererDocumentDomainReceipt,
    source: ReturnType<NativeDocumentDomainMigrationLegacy['source']>
  ) {
    const directory = this.archiveDirectory(intent)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const indexPath = join(directory, 'archive.json')
    const current: { sourceId: string; present: boolean; snapshot: Uint8Array }[] = [
      ...witness.sources,
      source
    ]
    if (existsSync(indexPath)) {
      const archive = JSON.parse(await readFile(indexPath, 'utf8')) as Archive
      if (
        archive.version !== 1 ||
        !isDeepStrictEqual(archive.scope, intent.scope) ||
        !isDeepStrictEqual(archive.manifest, intent.manifest) ||
        archive.sources.length !== intent.manifest.sourceIds.length ||
        new Set(archive.sources.map((entry) => entry.sourceId)).size !== archive.sources.length ||
        archive.sources.some((entry) => !intent.manifest.sourceIds.includes(entry.sourceId))
      )
        throw new Error('Document archive inventory changed')
      const restored: FrozenLoroDocumentSource[] = []
      for (const entry of archive.sources) {
        if (
          entry.filename !== `${digest(entry.sourceId)}.loro` ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
          throw new Error('Invalid document archive identity')
        const bytes = new Uint8Array(await readFile(join(directory, entry.filename)))
        if (digest(bytes) !== entry.sha256) throw new Error('Document archive binary changed')
        const live = current.find((value) => value.sourceId === entry.sourceId)
        if (live?.present && digest(live.snapshot) !== entry.sha256)
          throw new Error('Frozen document source changed after archive')
        restored.push({ sourceId: entry.sourceId, bytes, present: entry.present })
      }
      if (
        current.some(
          (entry) =>
            entry.present &&
            !archive.sources.some((original) => original.sourceId === entry.sourceId)
        )
      )
        throw new Error('Unplanned document source authored after freeze')
      return restored
    }
    const map = new Map(current.map((entry) => [entry.sourceId, entry]))
    if (
      current.some(
        (entry) => entry.present && !intent.manifest.sourceIds.includes(entry.sourceId)
      ) ||
      !current.some((entry) => entry.present)
    )
      throw new Error('Existing complete document sources required')
    const entries: ArchivedSource[] = []
    for (const sourceId of intent.manifest.sourceIds) {
      const entry = map.get(sourceId)
      if (!entry) throw new Error('Initial document source inventory disappeared before archive')
      const bytes = entry.snapshot,
        filename = `${digest(sourceId)}.loro`
      await this.writeImmutable(join(directory, filename), bytes)
      entries.push({ sourceId, present: entry.present, sha256: digest(bytes), filename })
    }
    const archive: Archive = {
      version: 1,
      scope: intent.scope,
      manifest: intent.manifest,
      sources: entries,
      witnessSha256: digest(
        JSON.stringify({
          ...witness,
          sources: witness.sources.map(({ snapshot, ...entry }) => ({
            ...entry,
            sha256: digest(snapshot)
          })),
          cli: { ...source, snapshot: undefined }
        })
      )
    }
    await this.writeImmutable(indexPath, Buffer.from(JSON.stringify(archive)))
    if (process.platform !== 'win32')
      for (const path of [
        directory,
        join(this.selected.directory, 'document-archives'),
        this.selected.directory
      ]) {
        const parent = await open(path, 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      }
    return intent.manifest.sourceIds.map((sourceId) => ({
      sourceId,
      bytes: map.get(sourceId)!.snapshot,
      present: map.get(sourceId)!.present
    }))
  }
  private async verify(
    scope: RendererDocumentDomainScope,
    _migrationId: string,
    input: Parameters<
      NonNullable<Parameters<NativeLoroDocumentMigration['migrate']>[1]['verifyState']>
    >[0]
  ) {
    this.check(scope)
    const verifier = new NativeLoroDocumentVerifierLegacy({
      directory: join(this.selected.directory, 'document-staging'),
      launch: this.options.launch,
      compatibility: this.options.compatibility,
      assertCurrent: () => this.check(scope)
    })
    this.staging.add(verifier)
    try {
      const value = await verifier.verify(input)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid existing document root')
      if (scope.domain === 'preview_comments') {
        const meta = Reflect.get(value, 'meta')
        if (!meta || typeof meta !== 'object' || Reflect.get(meta, 'sessionId') !== scope.id)
          throw new Error('Existing preview document binding is invalid')
      } else {
        const document = scheduleDocumentFromMirrorState(
          {
            definition: Reflect.get(value, 'definition'),
            prompt:
              typeof Reflect.get(value, 'prompt') === 'string'
                ? (Reflect.get(value, 'prompt') as string)
                : '',
            message: Reflect.get(value, 'message') as { payload?: unknown } | undefined,
            timeline: Array.isArray(Reflect.get(value, 'timeline'))
              ? (Reflect.get(value, 'timeline') as [])
              : []
          },
          scope.id
        )
        if (!document) throw new Error('Existing Schedule definition is invalid')
        buildScheduleRegistryRow(document)
      }
    } finally {
      await verifier.close()
      this.staging.delete(verifier)
    }
  }
  migrate(target: NativeDocumentDomainTarget): Promise<void> {
    const scope = rendererDocumentDomainScopeSchema.parse(documentDomainMigrationScope(target))
    this.check(scope)
    const existing = this.jobs.get(scope.roomId)
    if (existing) return existing
    const raw = this.run(scope).finally(() => {
      if (this.jobs.get(scope.roomId) === raw) this.jobs.delete(scope.roomId)
    })
    this.jobs.set(scope.roomId, raw)
    return raw
  }
  async ensurePreview(sessionId: SessionId): Promise<void> {
    const scope = documentDomainMigrationScope({ domain: 'preview_comments', id: sessionId }),
      owner = this.options.creation
    if (!owner) throw new Error('Trusted leaf creation unavailable')
    this.check(scope)
    const route = readNativeDocumentDomainRoute(
      {
        accountId: this.options.binding.accountId,
        workspaceId: this.options.binding.workspaceId as import('@lody/shared').WorkspaceId,
        journalPath: this.journalPath,
        dataDir: this.selected.dataDir
      },
      scope.domain,
      scope.id
    )
    if (route !== 'legacy') return this.migrate({ domain: scope.domain, id: scope.id })
    const state = await owner.metadata.readDocumentCreationState(scope.metadataDocId)
    owner.authorize(scope, state.snapshot)
    this.check(scope)
    if (state.pristine) return this.createPreview(sessionId, new Date().toISOString())
    const row = state.snapshot.docs.find((row) => row.docId === scope.metadataDocId)
    if (!row || row.deleted) throw new Error('Existing Preview metadata is unavailable')
    return this.migrate({ domain: scope.domain, id: scope.id })
  }
  createPreview(sessionId: SessionId, createdAt: string): Promise<void> {
    const owner = this.options.creation
    if (!owner) return Promise.reject(new Error('Trusted leaf creation unavailable'))
    const scope = documentDomainMigrationScope({ domain: 'preview_comments', id: sessionId })
    return this.create({
      scope,
      actorId: owner.actorId,
      machineId: owner.machineId,
      createdAt,
      initial: { meta: { sessionId }, turns: {} }
    })
  }
  createSchedule(input: Omit<ScheduleSaveInput, 'actorId' | 'create'>): Promise<void> {
    const owner = this.options.creation
    if (!owner || input.draft.machineId !== owner.machineId)
      return Promise.reject(new Error('Trusted schedule creation authority unavailable'))
    const document = prepareScheduleSave({ ...input, actorId: owner.actorId, create: true }, null)
    buildScheduleRegistryRow(document)
    const initial = JSON.parse(
      JSON.stringify({
        definition: document.definition,
        prompt: document.prompt,
        message: document.message ? { payload: document.message } : {},
        timeline: document.timeline
      })
    ) as NativeDocumentDomainCreationIntent['initial']
    return this.create({
      scope: documentDomainMigrationScope({ domain: 'schedule_definition', id: input.scheduleId }),
      actorId: owner.actorId,
      machineId: owner.machineId,
      createdAt: new Date(input.now).toISOString(),
      initial
    })
  }
  private create(creation: NativeDocumentDomainCreationIntent): Promise<void> {
    const owner = this.options.creation
    if (!owner) return Promise.reject(new Error('Trusted leaf creation unavailable'))
    nativeDocumentDomainCreationIntentSha256(owner.metadata.binding, creation)
    const scope = rendererDocumentDomainScopeSchema.parse(creation.scope)
    this.check(scope)
    if (this.jobs.has(scope.roomId))
      return Promise.reject(new Error('Document operation already in progress'))
    const raw = this.run(scope, creation).finally(() => {
      if (this.jobs.get(scope.roomId) === raw) this.jobs.delete(scope.roomId)
    })
    this.jobs.set(scope.roomId, raw)
    return raw
  }
  private async run(
    scope: RendererDocumentDomainScope,
    requestedCreation?: NativeDocumentDomainCreationIntent
  ) {
    let phase: MigrationPhase = 'metadata_authority'
    try {
      return await this.runCommand(scope, requestedCreation, (value) => {
        phase = value
      })
    } catch (error) {
      if (process.env.LODY_E2E === '1')
        console.warn(
          `[native-document-domain-migration] phase=${phase} code=${migrationFailureCode(error)}`
        )
      throw error
    }
  }
  private async runCommand(
    scope: RendererDocumentDomainScope,
    requestedCreation: NativeDocumentDomainCreationIntent | undefined,
    mark: (phase: MigrationPhase) => void
  ) {
    let intent = this.readIntent(scope)
    if (
      intent?.creation &&
      requestedCreation &&
      !isDeepStrictEqual(intent.creation, requestedCreation)
    )
      throw new Error('Leaf creation intent changed')
    const creation = intent?.creation ?? requestedCreation
    const purpose = creation ? ('create' as const) : undefined
    const authority = async () => {
      if (creation) {
        const owner = this.options.creation
        if (!owner || creation.actorId !== owner.actorId || creation.machineId !== owner.machineId)
          throw new Error('Leaf creation authority changed')
        const state = await owner.metadata.readDocumentCreationState(scope.metadataDocId)
        owner.authorize(scope, state.snapshot)
      } else await this.options.authorize(scope)
      this.check(scope)
    }
    await authority()
    mark('renderer_inventory')
    const enumeration = await this.options.renderer.enumerate(scope)
    const route = readNativeDocumentDomainRoute(
      {
        accountId: this.options.binding.accountId,
        workspaceId: this.options.binding.workspaceId as import('@lody/shared').WorkspaceId,
        journalPath: this.journalPath,
        dataDir: this.selected.dataDir
      },
      scope.domain,
      scope.id
    )
    if (route === 'native') {
      if (!intent) throw new Error('Published document migration intent missing')
      await this.options.renderer.resumeNative(scope, intent.manifest.migrationId)
      await this.control(scope, intent.manifest.migrationId, 'publish', purpose)
      return
    }
    if (route === 'legacy' && intent) {
      await this.control(scope, intent.manifest.migrationId, 'abort', purpose)
      intent = undefined
    }
    const nonce = intent?.manifest.migrationId ?? randomUUID()
    mark('prepare')
    const prepared = await this.control(scope, nonce, 'prepare', purpose)
    if (prepared.phase !== 'prepare') throw new Error('CLI prepare proof required')
    let controller: NativeLoroDocumentMigration | undefined
    let detach: (() => void) | undefined
    try {
      mark('native_owner')
      const current = await this.options.getClient()
      this.check(scope)
      if (current.sdkArtifactId !== this.options.compatibility.artifactId || !current.generation)
        throw new Error('Document host SDK generation changed')
      let connected = current.client.connectionState === 'connected'
      detach = current.client.onConnectionStateChange((state) => {
        if (state !== 'connected') connected = false
      })
      controller = new NativeLoroDocumentMigration(this.journalPath, {
        client: current.client,
        assertAccess: (manifest) => {
          this.check(scope)
          if (
            !connected ||
            current.client.connectionState !== 'connected' ||
            manifest.binding !== this.binding() ||
            manifest.namespace !== this.options.binding.workspaceId ||
            manifest.roomId !== scope.roomId
          )
            throw new Error('Document migration generation changed')
        }
      })
      this.controllers.add(controller)
      if (!intent) {
        const manifest: NativeLoroDocumentManifest = {
          migrationId: nonce,
          binding: this.binding(),
          namespace: this.options.binding.workspaceId,
          roomId: scope.roomId,
          family: scope.domain,
          targetGeneration: `document-v1:${this.options.compatibility.artifactId}`,
          sourceIds: creation
            ? []
            : [
                ...enumeration.databases.map((entry) => entry.sourceId),
                `cli-sqlite:loro-doc-layout1:${this.options.binding.workspaceId}:${scope.roomId}`
              ].sort(),
          ...(creation
            ? {
                origin: 'created' as const,
                creationIntentSha256: nativeDocumentDomainCreationIntentSha256(
                  this.options.creation!.metadata.binding,
                  creation
                )
              }
            : {})
        }
        intent = {
          version: 1,
          scope,
          manifest,
          rendererSources: [...enumeration.databases],
          ...(creation ? { creation } : {})
        }
        this.intents
          .prepare(
            'INSERT INTO document_domain_intents(binding,room_id,intent) VALUES(?,?,?) ON CONFLICT(binding,room_id) DO UPDATE SET intent=excluded.intent'
          )
          .run(this.binding(), scope.roomId, JSON.stringify(intent))
      }
      const selected = intent
      let witness: FrozenRendererDocumentDomainReceipt | undefined
      let cli: Awaited<ReturnType<NativeDocumentDomainMigrationLegacy['control']>> | undefined
      if (controller.route(this.binding(), scope.roomId) !== 'native') {
        const ports = {
          drainLegacy: async () => {
            mark('renderer_capture')
            witness = await this.options.renderer.freezeAndCapture(scope, nonce)
            mark('cli_freeze')
            cli = await this.control(scope, nonce, 'freeze', purpose)
            if (cli.phase !== 'freeze') throw new Error('CLI physical document freeze required')
            mark('source_proof')
            const source = this.source(scope)
            if (
              !isDeepStrictEqual(cli.source, {
                sourceId: source.sourceId,
                present: source.present,
                sha256: source.sha256,
                byteLength: source.byteLength
              })
            )
              throw new Error('CLI source changed after physical drain')
            this.options.renderer.assertFrozen(witness)
            return creation
              ? [...witness.sources, source].map((source) => ({
                  sourceId: source.sourceId,
                  present: source.present,
                  bytes: source.snapshot
                }))
              : this.archived(selected, witness, source)
          },
          verifyState: (input: Parameters<NativeDocumentDomainMigrationLegacy['verify']>[2]) =>
            this.verify(scope, nonce, input),
          beforePublish: async () => {
            if (!witness || !cli || cli.phase !== 'freeze')
              throw new Error('Original document authority witnesses missing')
            this.options.renderer.assertFrozen(witness)
            mark('cli_assert')
            const asserted = await this.control(scope, nonce, 'assert', purpose)
            if (
              asserted.phase !== 'assert' ||
              asserted.ownerGeneration !== cli.ownerGeneration ||
              asserted.metadataGeneration !== cli.metadataGeneration ||
              !isDeepStrictEqual(asserted.source, cli.source)
            )
              throw new Error('CLI document witness changed')
            await authority()
            if (creation && scope.domain === 'schedule_definition') {
              const document = scheduleDocumentFromMirrorState(
                {
                  definition: creation.initial.definition,
                  prompt:
                    typeof creation.initial.prompt === 'string' ? creation.initial.prompt : '',
                  message: creation.initial.message as { payload?: unknown },
                  timeline: creation.initial.timeline as []
                },
                scope.id
              )
              if (!document) throw new Error('Invalid reserved schedule definition')
              mark('sr_publish')
              const row = buildScheduleRegistryRow(document),
                registry = this.options.creation!.registry
              const current = await registry.read(scope.id)
              if (current.deleted) throw new Error('New schedule was deleted')
              if (!isDeepStrictEqual(current.row, row)) await registry.publish(row)
              await registry.flush()
            }
            this.check(scope)
            this.options.renderer.assertFrozen(witness)
          }
        }
        if (creation) {
          let absence: Awaited<ReturnType<typeof ports.drainLegacy>> | undefined
          const reservation = reserveNativeDocumentDomainMetadata({
            owner: this.options.creation!.metadata,
            intent: creation,
            reservationId: nonce,
            assertCurrent: () => this.check(scope),
            absenceWitness: () => {
              if (!absence || !witness) throw new Error('Complete leaf absence witness required')
              return {
                sources: absence.map((source) => ({
                  sourceId: source.sourceId,
                  present: source.present !== false
                })),
                assertCurrent: () => this.options.renderer.assertFrozen(witness!)
              }
            },
            authorize: (snapshot) => this.options.creation!.authorize(scope, snapshot)
          })
          await controller.createLeaf(
            {
              ...selected.manifest,
              family: scope.domain,
              creationIntentSha256: reservation.creationIntentSha256
            },
            {
              initial: creation.initial,
              onPhase: mark,
              drainLegacy: async () => {
                absence = await ports.drainLegacy()
                return {
                  sources: absence.map((source) => ({
                    sourceId: source.sourceId,
                    present: source.present !== false
                  })),
                  assertCurrent: () => {
                    this.check(scope)
                    this.options.renderer.assertFrozen(witness!)
                  }
                }
              },
              reserveMetadata: reservation.reserveMetadata,
              assertReservation: reservation.assertReservation,
              beforePublish: ports.beforePublish
            }
          )
        } else await controller.migrate(selected.manifest, ports)
      }
      mark('renderer_publish')
      if (witness) await this.options.renderer.published(witness)
      else await this.options.renderer.resumeNative(scope, nonce)
      mark('cli_publish')
      await this.control(scope, nonce, 'publish', purpose)
    } catch (error) {
      if (!controller || controller.route(this.binding(), scope.roomId) === 'legacy') {
        try {
          await this.control(scope, nonce, 'abort', purpose)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Document preparation release unconfirmed')
        }
      }
      throw error
    } finally {
      detach?.()
      if (controller) {
        controller.close()
        this.controllers.delete(controller)
      }
    }
  }
  async close() {
    this.closed = true
    const release = await Promise.allSettled(
      [...this.staging].map(async (entry) => {
        await entry.close()
        this.staging.delete(entry)
      })
    )
    const failures = release.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.jobs.values()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Document migration remains pending')), 15000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    const late = await Promise.allSettled(
      [...this.staging].map(async (entry) => {
        await entry.close()
        this.staging.delete(entry)
      })
    )
    failures.push(
      ...late.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    )
    for (const controller of this.controllers) {
      try {
        controller.close()
        this.controllers.delete(controller)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Document migration process cleanup unconfirmed')
    if (this.intents.isOpen) this.intents.close()
  }
  retryCleanup() {
    return this.close()
  }
}
