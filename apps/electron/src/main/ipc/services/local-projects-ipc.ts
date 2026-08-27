import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import type {
  SendSessionFileLocalInput,
  SendSessionFileLocalResult
} from '@lody/shared/electron-ipc'
import type {
  LocalProjectControlRequest,
  LocalSessionControlRequest,
  SessionFileSendLocalResponse
} from '@lody/shared/message'
import type { SessionId, WorkspaceId } from '@lody/shared/ids'
import { SessionIdSchema } from '@lody/shared/message-schemas'
import type { LocalProjectHistoryProvider, LocalProjectId } from '@lody/shared/project'
import { formatUnknownError } from '../../utils'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { sendLocalProjectControl } from '../local-project-dispatch'

const SESSION_FILE_SEND_LOCAL_MAX_COUNT = 8
const SESSION_FILE_SEND_LOCAL_MAX_SIZE_BYTES = 100 * 1024 * 1024

function parseSendSessionFileLocalInput(payload: unknown): SendSessionFileLocalInput | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const { workspaceId, sessionId, machineId, files } = record
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId.trim() ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof machineId !== 'string' ||
    !machineId.trim() ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > SESSION_FILE_SEND_LOCAL_MAX_COUNT
  ) {
    return null
  }
  const parsedFiles: SendSessionFileLocalInput['files'] = []
  for (const file of files) {
    if (!file || typeof file !== 'object') return null
    const fileRecord = file as Record<string, unknown>
    const fileName = fileRecord.fileName
    const bytes = fileRecord.bytes
    if (typeof fileName !== 'string' || !fileName.trim() || !(bytes instanceof ArrayBuffer)) {
      return null
    }
    if (bytes.byteLength <= 0 || bytes.byteLength > SESSION_FILE_SEND_LOCAL_MAX_SIZE_BYTES) {
      return null
    }
    parsedFiles.push({ fileName, bytes })
  }
  return { workspaceId, sessionId, machineId, files: parsedFiles }
}

function isLocalProjectHistoryProvider(value: unknown): value is LocalProjectHistoryProvider {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as { cliType?: unknown }).cliType === 'builtin' ||
      (value as { cliType?: unknown }).cliType === 'registry') &&
    typeof (value as { agentType?: unknown }).agentType === 'string' &&
    (value as { agentType: string }).agentType.trim().length > 0
  )
}

export class LocalProjectsIpc extends IpcService {
  static override readonly groupName = 'localProjects'

  @IpcMethod()
  async control(request: LocalProjectControlRequest) {
    return await sendLocalProjectControl(request)
  }

  @IpcMethod()
  async sendSessionFileLocal(
    payload: SendSessionFileLocalInput
  ): Promise<SendSessionFileLocalResult> {
    const input = parseSendSessionFileLocalInput(payload)
    if (!input) {
      return { ok: false, error: 'invalid_request' }
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-file-send-'))
    const tempPaths: string[] = []
    try {
      for (const [index, file] of input.files.entries()) {
        const base = path
          .basename(file.fileName)
          .split('')
          .map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch))
          .join('')
          .trim()
        const safeName = !base || base === '.' || base === '..' ? 'file' : base.slice(0, 255)
        const tempPath = path.join(tempDir, `${index}-${safeName}`)
        await fs.writeFile(tempPath, Buffer.from(file.bytes))
        tempPaths.push(tempPath)
      }
      if (tempPaths.length !== input.files.length) {
        return { ok: false, error: 'temp_write_incomplete' }
      }
      const result = await getIpcServiceDeps().cliService.sendLocalSessionControl({
        type: 'session/file-send-local',
        machineId: input.machineId,
        sessionId: input.sessionId as SessionId,
        workspaceId: input.workspaceId as WorkspaceId,
        paths: tempPaths
      } as LocalSessionControlRequest)
      if (!result.ok) {
        return { ok: false, error: result.error }
      }
      const response = result.responses.find(
        (item): item is SessionFileSendLocalResponse =>
          item.type === 'session/file-send-local_response'
      )
      if (!response) {
        return { ok: false, error: 'invalid_response' }
      }
      if (!response.success) {
        return { ok: false, error: response.error ?? 'local_handoff_failed' }
      }
      return {
        ok: true,
        files: response.files ?? [],
        ...(response.message ? { message: response.message } : {})
      }
    } catch (error) {
      return { ok: false, error: formatUnknownError(error) }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  @IpcMethod()
  async selectDirectory() {
    const mainWindow = getIpcServiceDeps().getMainWindow()
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled) return null
    const selectedPath = result.filePaths[0]
    if (!selectedPath) return null
    const machineId = await getIpcServiceDeps().cliService.getLocalMachineId()
    if (!machineId) {
      return { error: 'Local CLI daemon is unavailable. Run `npx lody start`.' }
    }
    return { rootPath: selectedPath, machineId }
  }

  @IpcMethod()
  async getGitState(workspaceId: string, localProjectId: string) {
    const response = await sendLocalProjectControl({
      type: 'local-project/git-state',
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId
    })
    if (!response.ok) return { error: response.message }
    if (response.type !== 'local-project/git-state') {
      return { error: `Unexpected response type: ${response.type}` }
    }
    return response.result
  }

  @IpcMethod()
  async listFiles(workspaceId: string, localProjectId: string, optionsArg?: { maxFiles?: number }) {
    const response = await sendLocalProjectControl({
      type: 'local-project/list-files',
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      maxFiles: optionsArg?.maxFiles
    })
    if (!response.ok) {
      if (response.error === 'daemon_unavailable') throw new Error('cli_not_running')
      throw new Error(response.message ?? 'Failed to list project files')
    }
    if (response.type !== 'local-project/list-files') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }
    return response.result
  }

  @IpcMethod()
  async listDir(
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    optionsArg?: { limit?: number }
  ) {
    const response = await sendLocalProjectControl({
      type: 'local-project/list-dir',
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      relativePath,
      limit: optionsArg?.limit
    })
    if (!response.ok) {
      if (response.error === 'daemon_unavailable') throw new Error('cli_not_running')
      throw new Error(response.message ?? 'Failed to list project directory')
    }
    if (response.type !== 'local-project/list-dir') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }
    return response.result
  }

  @IpcMethod()
  async readFile(
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    optionsArg?: { maxBytes?: number }
  ) {
    const response = await sendLocalProjectControl({
      type: 'local-project/read-file',
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      relativePath,
      maxBytes: optionsArg?.maxBytes
    })
    if (!response.ok || response.type !== 'local-project/read-file') return null
    return response.result
  }

  @IpcMethod()
  async listSessionWorktreeFiles(
    repoKey: string,
    sessionId: string,
    optionsArg?: { maxFiles?: number }
  ) {
    const response = await sendLocalProjectControl({
      type: 'worktree/list-files',
      repoFullName: repoKey,
      sessionId: SessionIdSchema.parse(sessionId),
      maxFiles: optionsArg?.maxFiles
    })
    if (!response.ok) {
      if (response.error === 'daemon_unavailable') throw new Error('cli_not_running')
      throw new Error(response.message ?? 'Failed to list worktree files')
    }
    if (response.type !== 'worktree/list-files') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }
    return response.result
  }

  @IpcMethod()
  async readSessionWorktreeFile(
    repoKey: string,
    sessionId: string,
    relativePath: string,
    optionsArg?: { maxBytes?: number }
  ) {
    const response = await sendLocalProjectControl({
      type: 'worktree/read-file',
      repoFullName: repoKey,
      sessionId: SessionIdSchema.parse(sessionId),
      relativePath,
      maxBytes: optionsArg?.maxBytes
    })
    if (!response.ok || response.type !== 'worktree/read-file') return null
    return response.result
  }

  @IpcMethod()
  async checkoutBranch(workspaceId: string, localProjectId: string, branchName: string) {
    const response = await sendLocalProjectControl({
      type: 'local-project/checkout-branch',
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      branchName
    })
    if (!response.ok) return { success: false as const, error: response.message }
    if (response.type !== 'local-project/checkout-branch') {
      return { success: false as const, error: `Unexpected response type: ${response.type}` }
    }
    return response.result
  }

  @IpcMethod()
  async syncHistory(
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string
  ) {
    if (!isLocalProjectHistoryProvider(provider)) {
      return { error: `Invalid history provider: ${String(provider)}` }
    }
    const response = await sendLocalProjectControl({
      type: 'local-project/sync-history',
      provider,
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId
    })
    if (!response.ok) return { error: response.message }
    if (response.type !== 'local-project/sync-history') {
      return { error: `Unexpected response type: ${response.type}` }
    }
    return response.result
  }

  @IpcMethod()
  async importHistory(
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    acpSessionIds: string[]
  ) {
    if (!isLocalProjectHistoryProvider(provider)) {
      return { error: `Invalid history provider: ${String(provider)}` }
    }
    const response = await sendLocalProjectControl({
      type: 'local-project/import-history',
      provider,
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      acpSessionIds
    })
    if (!response.ok) return { error: response.message }
    if (response.type !== 'local-project/import-history') {
      return { error: `Unexpected response type: ${response.type}` }
    }
    return response.result
  }

  @IpcMethod()
  async resolveHistoryConflict(
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    sessionId: SessionId,
    acpSessionId: string
  ) {
    if (!isLocalProjectHistoryProvider(provider)) {
      return { error: `Invalid history provider: ${String(provider)}` }
    }
    const response = await sendLocalProjectControl({
      type: 'local-project/resolve-history-conflict',
      provider,
      workspaceId: workspaceId as WorkspaceId,
      localProjectId: localProjectId as LocalProjectId,
      sessionId,
      acpSessionId
    })
    if (!response.ok) return { error: response.message }
    if (response.type !== 'local-project/resolve-history-conflict') {
      return { error: `Unexpected response type: ${response.type}` }
    }
    return response.result
  }
}
