import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { rendererWfAckSchema, type RendererWfBinding } from '@lody/shared/renderer-room-migration'
import {
  workspaceCatalogIpcRequestSchema,
  workspaceCatalogIpcUnsubscribeSchema
} from '@lody/shared/workspace-catalog-ipc'
import { z } from 'zod'
import { rendererFlockGroupAckSchema } from '@lody/shared/renderer-flock-room-group'

async function selectedFlockGroup(domain: 'machine' | 'schedule' | 'meta') {
  const binding = await localBinding()
  const deps = getIpcServiceDeps()
  const migration = await (domain === 'machine'
    ? deps.rendererMachineFlockMigration?.()
    : domain === 'schedule'
      ? deps.rendererScheduleRegistryMigration?.()
      : deps.rendererWorkspaceMetaMigration?.())
  if (!migration) return null
  const current = await localBinding()
  if (
    binding.accountId !== current.accountId ||
    binding.workspaceId !== current.workspaceId ||
    migration.group.accountId !== current.accountId ||
    migration.group.workspaceId !== current.workspaceId ||
    migration.group.domain !== domain ||
    migration.group.contentMode !== 'plaintext'
  )
    throw new Error('Local machine catalog identity changed')
  return migration
}
const selectedMachineGroup = () => selectedFlockGroup('machine')
const selectedScheduleGroup = () => selectedFlockGroup('schedule')
const selectedMetaGroup = () => selectedFlockGroup('meta')

const localBinding = async (): Promise<RendererWfBinding> => {
  if (!isLocalPlatform()) throw new Error('Local workspace migration is unavailable')
  const snapshot = await readLocalPlatformSnapshot()
  if (!snapshot) throw new Error('Local workspace identity is not ready')
  return {
    accountId: snapshot.userId,
    workspaceId: snapshot.workspace.workspaceId,
    roomId: `${snapshot.workspace.workspaceId}:wf:workspace`,
    contentMode: 'plaintext'
  }
}

export class LocalPlatformIpc extends ProductWindowIpcService {
  static override readonly groupName = 'localPlatform'

  @IpcMethod()
  async registerWorkspaceMeta() {
    const senderId = getIpcContext().event.sender.id
    const migration = await selectedMetaGroup()
    if (!migration) return null
    const attempt = migration.beginRegistration(senderId)
    await migration.reconcileOwner()
    return migration.register(senderId, attempt)
  }

  @IpcMethod()
  async readyWorkspaceMeta(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    const migration = await selectedMetaGroup()
    if (!migration) throw new Error('Workspace Meta unavailable')
    migration.ready(senderId, registrationId)
    const migrate = getIpcServiceDeps().migrateNativeWorkspaceMeta
    if (!migrate) throw new Error('Workspace Meta unavailable')
    try {
      await migrate(migration.group)
    } catch {
      console.warn('[Native data] Workspace Meta migration is incomplete')
      throw new Error('Workspace Meta migration remains incomplete')
    }
    if (migration !== (await selectedMetaGroup()))
      throw new Error('Workspace Meta identity changed')
    const ready = migration.ready(senderId, registrationId)
    if (ready.owner !== 'native') throw new Error('Workspace Meta migration remains incomplete')
    return { ...ready, registrationId }
  }

  @IpcMethod()
  async acknowledgeWorkspaceMeta(input: unknown) {
    const migration = await selectedMetaGroup()
    if (!migration) throw new Error('Workspace Meta unavailable')
    migration.acceptAck(getIpcContext().event.sender.id, rendererFlockGroupAckSchema.parse(input))
  }

  @IpcMethod()
  async retireWorkspaceMeta(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    const results = await Promise.allSettled([
      selectedMetaGroup().then((group) => group?.retire(senderId, registrationId)),
      Promise.resolve().then(() =>
        getIpcServiceDeps().retireNativeSessionBodyMigration?.(senderId, registrationId)
      ),
      Promise.resolve().then(() =>
        getIpcServiceDeps().nativeWorkspaceMeta?.()?.retire(senderId, registrationId)
      ),
      Promise.resolve().then(() =>
        getIpcServiceDeps().nativeSessionDomain?.()?.retire(senderId, registrationId)
      )
    ])
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Workspace Meta reader release unconfirmed')
  }

  @IpcMethod()
  async registerScheduleRegistry() {
    const senderId = getIpcContext().event.sender.id
    const migration = await selectedScheduleGroup()
    if (!migration) return null
    const attempt = migration.beginRegistration(senderId)
    await migration.reconcileOwner()
    return migration.register(senderId, attempt)
  }

  @IpcMethod()
  async readyScheduleRegistry(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    const migration = await selectedScheduleGroup()
    if (!migration) throw new Error('Local schedule registry unavailable')
    migration.ready(senderId, registrationId)
    try {
      const migrate = getIpcServiceDeps().migrateNativeScheduleRegistry
      if (!migrate) throw new Error('Local schedule registry unavailable')
      await migrate(migration.group)
    } catch {
      console.warn('[Native data] Schedule registry migration is incomplete')
    }
    if (migration !== (await selectedScheduleGroup()))
      throw new Error('Local schedule registry identity changed')
    return { ...migration.ready(senderId, registrationId), registrationId }
  }

  @IpcMethod()
  async acknowledgeScheduleRegistry(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const migration = await selectedScheduleGroup()
    if (!migration) throw new Error('Local schedule registry unavailable')
    migration.acceptAck(senderId, rendererFlockGroupAckSchema.parse(input))
  }

  @IpcMethod()
  async retireScheduleRegistry(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    ;(await selectedScheduleGroup())?.retire(senderId, registrationId)
  }

  @IpcMethod()
  async registerMachineFlock() {
    const senderId = getIpcContext().event.sender.id
    const migration = await selectedMachineGroup()
    if (!migration) return null
    const attempt = migration.beginRegistration(senderId)
    await migration.reconcileOwner()
    return migration.register(senderId, attempt)
  }

  @IpcMethod()
  async readyMachineFlock(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    const migration = await selectedMachineGroup()
    if (!migration) throw new Error('Local machine catalog unavailable')
    migration.ready(senderId, registrationId)
    try {
      const migrate = getIpcServiceDeps().migrateNativeMachineCatalog
      if (!migrate) throw new Error('Local machine catalog unavailable')
      await migrate(migration.group)
    } catch {
      console.warn('[Native data] Machine catalog migration is incomplete')
    }
    if (migration !== (await selectedMachineGroup()))
      throw new Error('Local machine catalog identity changed')
    return { ...migration.ready(senderId, registrationId), registrationId }
  }

  @IpcMethod()
  async acknowledgeMachineFlock(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const migration = await selectedMachineGroup()
    if (!migration) throw new Error('Local machine catalog unavailable')
    migration.acceptAck(senderId, rendererFlockGroupAckSchema.parse(input))
  }

  @IpcMethod()
  async retireMachineFlock(input: unknown) {
    const senderId = getIpcContext().event.sender.id
    const registrationId = z.string().uuid().parse(input)
    const deps = getIpcServiceDeps()
    const results = await Promise.allSettled([
      Promise.resolve().then(async () =>
        (await selectedMachineGroup())?.retire(senderId, registrationId)
      ),
      Promise.resolve().then(() => deps.nativeMachineCatalog?.()?.retire(senderId, registrationId))
    ])
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Local machine catalog cleanup unconfirmed')
  }

  @IpcMethod()
  async getSnapshot() {
    if (!isLocalPlatform()) return null
    const snapshot = await readLocalPlatformSnapshot()
    if (snapshot) {
      // Identity/bootstrap must remain available when one native data owner is
      // unavailable. Dependent catalog methods still await and validate it.
      void getIpcServiceDeps()
        .localNativeRepoLease?.ensure(snapshot)
        .catch(() => {
          console.warn('[Native data] Local data lease is unavailable')
        })
    }
    return snapshot
  }

  @IpcMethod()
  async registerWorkspaceFlock() {
    const senderId = getIpcContext().event.sender.id
    if (!isLocalPlatform()) throw new Error('Local workspace migration is unavailable')
    const migration = getIpcServiceDeps().rendererWorkspaceFlockMigration()
    if (!migration) throw new Error('Local workspace migration is unavailable')
    const attemptId = migration.beginRegistration(senderId)
    const binding = await localBinding()
    await migration.reconcileOwner(binding)
    return migration.register(senderId, binding, attemptId)
  }

  @IpcMethod()
  async readyWorkspaceFlock(registrationId: string) {
    const senderId = getIpcContext().event.sender.id
    const binding = await localBinding()
    const migration = getIpcServiceDeps().rendererWorkspaceFlockMigration()
    if (!migration) throw new Error('Local workspace migration is unavailable')
    await migration.reconcileOwner(binding)
    const owner = migration.ready(senderId, registrationId)
    if (
      owner.binding.accountId !== binding.accountId ||
      owner.binding.workspaceId !== binding.workspaceId
    ) {
      migration.retire(senderId, registrationId)
      throw new Error('Local workspace migration identity changed')
    }
    try {
      await getIpcServiceDeps().migrateNativeWorkspaceCatalog(binding)
    } catch {
      console.warn('[Native data] Workspace catalog migration is incomplete')
    }
    return migration.ready(senderId, registrationId)
  }

  @IpcMethod()
  async acknowledgeWorkspaceFlock(payload: unknown) {
    const senderId = getIpcContext().event.sender.id
    const binding = await localBinding()
    const ack = rendererWfAckSchema.parse(payload)
    if (
      ack.binding.accountId !== binding.accountId ||
      ack.binding.workspaceId !== binding.workspaceId
    )
      throw new Error('Local workspace migration binding mismatch')
    const migration = getIpcServiceDeps().rendererWorkspaceFlockMigration()
    if (!migration) throw new Error('Local workspace migration is unavailable')
    migration.acceptAck(senderId, ack)
  }

  @IpcMethod()
  async retireWorkspaceFlock(registrationId: string) {
    const senderId = getIpcContext().event.sender.id
    if (!isLocalPlatform()) throw new Error('Local workspace migration is unavailable')
    const deps = getIpcServiceDeps()
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        deps.rendererWorkspaceFlockMigration()?.retire(senderId, registrationId)
      ),
      Promise.resolve().then(() => deps.nativeWorkspaceCatalog()?.retire(senderId, registrationId))
    ])
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : []
    )
    if (failures.length)
      throw new AggregateError(failures, 'Workspace catalog registration cleanup failed')
  }
  @IpcMethod()
  async readWorkspaceCatalog(registrationId: string) {
    const senderId = getIpcContext().event.sender.id
    const binding = await localBinding()
    const catalog = getIpcServiceDeps().nativeWorkspaceCatalog()
    if (!catalog) throw new Error('Local catalog unavailable')
    return catalog.read(senderId, z.string().uuid().parse(registrationId), binding)
  }
  @IpcMethod()
  async executeWorkspaceCatalog(registrationId: string, command: unknown) {
    const senderId = getIpcContext().event.sender.id
    const binding = await localBinding()
    const catalog = getIpcServiceDeps().nativeWorkspaceCatalog()
    if (!catalog) throw new Error('Local catalog unavailable')
    return catalog.execute(senderId, z.string().uuid().parse(registrationId), binding, command)
  }
  @IpcMethod()
  async uploadWorkspaceCatalog(registrationId: string) {
    const senderId = getIpcContext().event.sender.id
    const binding = await localBinding()
    const catalog = getIpcServiceDeps().nativeWorkspaceCatalog()
    if (!catalog) throw new Error('Local catalog unavailable')
    await catalog.upload(senderId, z.string().uuid().parse(registrationId), binding)
  }
  @IpcMethod()
  async observeWorkspaceCatalog(payload: unknown) {
    const senderId = getIpcContext().event.sender.id
    const request = workspaceCatalogIpcRequestSchema.parse(payload)
    const binding = await localBinding()
    const catalog = getIpcServiceDeps().nativeWorkspaceCatalog()
    if (!catalog) throw new Error('Local catalog unavailable')
    return catalog.observe(senderId, request.registrationId, binding, request.requestId)
  }
  @IpcMethod()
  async unobserveWorkspaceCatalog(payload: unknown) {
    const senderId = getIpcContext().event.sender.id
    const request = workspaceCatalogIpcUnsubscribeSchema.parse(payload)
    if (!isLocalPlatform()) throw new Error('Local catalog unavailable')
    await getIpcServiceDeps()
      .nativeWorkspaceCatalog()
      ?.unsubscribe(senderId, request.registrationId, request.requestId, request.leaseId)
  }
}
