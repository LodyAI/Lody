import { unpackClientBundle } from '@lody/shared/plugins/digest'
import { publishPluginModule, releasePluginGraph } from '../../services/plugin-module-store'
import { receiveClientBundle } from '@lody/shared/plugins/digest'
import { pluginRpcResultSchema } from '@lody/shared/plugins/machine-rpc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { join } from 'node:path'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { workspaceModuleProof, scopeHash, type WorkspaceModuleOperation } from '../../services/workspace-plugin-proof'
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema'
import { mainPlatformKind, isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import {
  LocalFilePreviewRequestSchema,
  previewLocalFile,
  readFileMachineId,
  type LocalFilePreviewRequest
} from '../../services/local-file-preview'
import {
  getResourceOwner,
  isCurrentResourceOwner,
  localFileResources,
  localHtmlPreviewSites
} from '../../services/document-resource-owner'
import {
  LocalHtmlPreviewRequestSchema,
  openLocalHtmlPreview,
  type LocalHtmlPreviewRequest
} from '../../services/local-html-preview'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { assertProductWindowSender } from '../assert-sender'

export class MachineRpcIpc extends ProductWindowIpcService {
  static override readonly groupName = 'machineRpc'

  @IpcMethod()
  async isLocalFileMachine(machineId: string) {
    assertProductWindowSender(getIpcContext().event)
    if (typeof machineId !== 'string' || !machineId) return false
    return (
      machineId ===
      (await readFileMachineId(join(getLodyDataDir(mainPlatformKind), 'credentials.json')))
    )
  }

  @IpcMethod()
  async previewFile(message: LocalFilePreviewRequest) {
    const parsed = LocalFilePreviewRequestSchema.parse(message)
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    const owner = event.sender
    const generation = getResourceOwner(owner)
    const machineId = await readFileMachineId(
      join(getLodyDataDir(mainPlatformKind), 'credentials.json')
    )
    if (!isCurrentResourceOwner(owner, generation)) throw new Error('Preview window closed.')
    const response = await previewLocalFile(localFileResources, generation, parsed, machineId)
    if (!isCurrentResourceOwner(owner, generation)) {
      localFileResources.releaseOwner(generation)
      throw new Error('Preview window closed.')
    }
    return response
  }

  /** Null means the file is not on this desktop; the caller keeps its inline preview. */
  @IpcMethod()
  async openHtmlPreview(message: LocalHtmlPreviewRequest) {
    const parsed = LocalHtmlPreviewRequestSchema.parse(message)
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    const owner = event.sender
    const generation = getResourceOwner(owner)
    const machineId = await readFileMachineId(
      join(getLodyDataDir(mainPlatformKind), 'credentials.json')
    )
    if (!isCurrentResourceOwner(owner, generation)) throw new Error('Preview window closed.')
    return openLocalHtmlPreview(localHtmlPreviewSites, generation, parsed, machineId)
  }

  @IpcMethod()
  async workspacePluginModule(workspaceId:string,machineId:string,manifest:PluginManifest,digest:string,op:WorkspaceModuleOperation){
    const {event}=getIpcContext();assertProductWindowSender(event);const generation=getResourceOwner(event.sender)
    if(process.argv.includes('--safe-mode')||new URL(event.senderFrame!.url).searchParams.getAll('safeMode').includes('1'))throw Error('Plugins disabled in safe mode')
    // Only the native implicit local workspace can use the unencrypted proof store.
    const local=isLocalPlatform()?await readLocalPlatformSnapshot():null
    if(!local||local.workspace.workspaceId!==workspaceId)throw Error('Local workspace unavailable')
    const directory=join(getLodyDataDir(mainPlatformKind),'plugins','workspace-releases',scopeHash([local.userId,workspaceId]));const current=()=>isCurrentResourceOwner(event.sender,generation)
    const source=await workspaceModuleProof(directory,manifest,digest,op,async()=>{const reply=await getIpcServiceDeps().cliService.sendLocalMachineRpc({workspaceId,machineId,method:'plugin/catalog',params:{}});if(!reply.ok)throw Error('Local catalog unavailable');const result=pluginRpcResultSchema.parse(reply.result);const row=result.type==='plugin/catalog'&&result.installations.find(i=>i.enabled&&i.manifest.id===manifest.id);if(!row)throw Error('Workspace release unavailable');return {manifest:row.manifest,digest:row.clientDigest,dev:!!row.devSessionNonce}},current)
    if(source===null||op.action!=='open')return null;const url=await publishPluginModule(generation,source,op.names);if(!current()){releasePluginGraph(generation,url);throw Error('Plugin document retired')}return url
  }
  @IpcMethod()
  async openPluginModule(
    machineId: string,
    workspaceId: string,
    pluginId: string,
    digest: string,
    names: Record<string, string[]>
  ) {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    if (
      process.argv.includes('--safe-mode') ||
      new URL(event.senderFrame!.url).searchParams.getAll('safeMode').includes('1')
    )
      throw Error('Plugins disabled in safe mode')
    const owner = getResourceOwner(event.sender)
    const cli = getIpcServiceDeps().cliService
    const request = async (message: LocalMachineRpcRequest) => {
      const reply = await cli.sendLocalMachineRpc(message)
      if (!reply.ok) throw Error(reply.error)
      return pluginRpcResultSchema.parse(reply.result)
    }
    const catalog = await request({ method: 'plugin/catalog', workspaceId, machineId, params: {} })
    if (catalog.type !== 'plugin/catalog') throw Error('Plugin catalog unavailable')
    const row = catalog.installations.find(
      (i) => i.enabled && i.manifest.id === pluginId && i.clientDigest === digest
    )
    if (!row?.manifest.client) throw Error('No enabled plugin module')
    const bundle = await receiveClientBundle(digest, async (offset) => {
      const reply = await request({
        method: 'plugin/bundle-chunk',
        workspaceId,
        machineId,
        params: { pluginId, clientDigest: digest, offset }
      })
      if (reply.type !== 'plugin/bundle-chunk') throw Error('Plugin bundle unavailable')
      return { bytes: Buffer.from(reply.base64, 'base64'), totalBytes: reply.totalBytes }
    })
    const file = unpackClientBundle(bundle)(row.manifest.client)
    const url = await publishPluginModule(
      owner,
      new TextDecoder('utf-8', { fatal: true }).decode(file),
      names
    )
    if (!isCurrentResourceOwner(event.sender, owner)) {
      releasePluginGraph(owner, url)
      throw Error('Plugin document closed')
    }
    return url
  }
  @IpcMethod()
  async releasePluginModule(url: string) {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    releasePluginGraph(getResourceOwner(event.sender), url)
  }

  @IpcMethod()
  async send(message: LocalMachineRpcRequest) {
    return await getIpcServiceDeps().cliService.sendLocalMachineRpc(message)
  }
}
