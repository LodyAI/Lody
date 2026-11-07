import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
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
import {
  SessionIdSchema,
  LocalProjectHistoryProviderSchema,
  SessionAttachmentRegisterRequestSchema,
  SessionAttachmentResolveRequestSchema
} from '@lody/shared/message-schemas'
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
  return LocalProjectHistoryProviderSchema.safeParse(value).success
}

export class LocalProjectsIpc extends IpcService {
  static override readonly groupName = 'localProjects'

  @IpcMethod()
  async control(request: LocalProjectControlRequest) {
    return await sendLocalProjectControl(request)
  }

  @IpcMethod()
  async resolveLocalAttachment(payload: {
    workspaceId: string
    sessionId: string
    attachment: import('@lody/shared').SessionLocalAttachment
  }) {
    const request = SessionAttachmentResolveRequestSchema.parse({
      ...payload,
      type: 'session/attachment-resolve',
      machineId: payload.attachment.machineId
    })
    const result = await getIpcServiceDeps().cliService.sendLocalSessionControl({
      ...request,
      machineId: request.machineId as import('@lody/shared/ids').MachineId,
      workspaceId: request.workspaceId as WorkspaceId
    })
    if (!result.ok) throw new Error(result.error)
    const response = result.responses.find(
      (item) => item.type === 'session/attachment-resolve_response'
    )
    if (!response?.success || !response.path)
      throw new Error(response?.error ?? 'local_attachment_unavailable')
    return response.path
  }

  @IpcMethod()
  async prepareLocalAttachment(payload: {
    workspaceId: string
    sessionId: string
    machineId: string
    turnId: string
    referenceId: string
    kind: 'file' | 'image'
    fileName: string
    mimeType: string
    source: { path: string } | { bytes: ArrayBuffer }
  }) {
    let staging: string | undefined
    try {
      if (!payload || !payload.source) throw new Error('invalid_request')
      let sourcePath: string
      const managed = 'bytes' in payload.source
      if (managed) {
        const bytes = (payload.source as { bytes: ArrayBuffer }).bytes
        if (
          !(bytes instanceof ArrayBuffer) ||
          bytes.byteLength > SESSION_FILE_SEND_LOCAL_MAX_SIZE_BYTES
        )
          throw new Error('invalid_attachment_bytes')
        staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-local-attachment-'))
        sourcePath = path.join(staging, 'source')
        await fs.writeFile(sourcePath, Buffer.from(bytes), { mode: 0o600 })
      } else {
        sourcePath = (payload.source as { path: string }).path
        if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
          throw new Error('invalid_attachment_path')
      }
      const request = SessionAttachmentRegisterRequestSchema.parse({
        type: 'session/attachment-register',
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        machineId: payload.machineId,
        turnId: payload.turnId,
        referenceId: payload.referenceId,
        kind: payload.kind,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        path: sourcePath,
        managed
      })
      const result = await getIpcServiceDeps().cliService.sendLocalSessionControl({
        ...request,
        machineId: request.machineId as import('@lody/shared/ids').MachineId,
        workspaceId: request.workspaceId as WorkspaceId
      })
      if (!result.ok) return { ok: false as const, error: result.error }
      const response = result.responses.find(
        (item) => item.type === 'session/attachment-register_response'
      )
      if (!response || !response.success || !response.attachment)
        return { ok: false as const, error: response?.error ?? 'local_attachment_not_supported' }
      return { ok: true as const, attachment: response.attachment }
    } catch (error) {
      return { ok: false as const, error: formatUnknownError(error) }
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true })
    }
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
    const mainWindow = BrowserWindow.fromWebContents(getIpcContext().event.sender)
    const options: OpenDialogOptions = {
      defaultPath: app.getPath('home'),
      properties: ['openDirectory']
    }
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
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
