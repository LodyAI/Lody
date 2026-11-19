import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  WorkspaceBundleControlRequest,
  WorkspaceBundleControlResponse
} from '@lody/shared/workspace-bundle-control'

/**
 * Desktop entry for workspace bundles (specs/workspace-export-import.md). Main owns
 * the native file dialogs and the daemon call; the renderer never sees the import
 * path, only an opaque token bound to the window that chose the file.
 */
export type WorkspaceBundleServiceDeps = {
  machineId: () => Promise<string | null>
  chooseSavePath: (defaultName: string) => Promise<string | null>
  chooseOpenPath: () => Promise<string | null>
  send: (message: WorkspaceBundleControlRequest) => Promise<WorkspaceBundleControlResponse>
  now?: () => Date
}

export type WorkspaceBundleError = { status: 'error'; message: string }

const DISPLAY_NAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001f]+/gu

function defaultBundleName(workspaceName: string, now: Date): string {
  const base = workspaceName.replace(DISPLAY_NAME_UNSAFE, '-').trim().slice(0, 80) || 'workspace'
  return `${base}-${now.toISOString().slice(0, 10)}.lodybundle`
}

export function createWorkspaceBundleService(deps: WorkspaceBundleServiceDeps) {
  const chosen = new Map<string, string>()
  const now = deps.now ?? (() => new Date())

  const call = async (
    build: (machineId: string) => WorkspaceBundleControlRequest
  ): Promise<{ status: 'ok'; result: unknown } | WorkspaceBundleError> => {
    const machineId = await deps.machineId()
    if (!machineId) return { status: 'error', message: 'local_agent_unavailable' }
    try {
      const response = await deps.send(build(machineId))
      return response.ok
        ? { status: 'ok', result: response.result }
        : { status: 'error', message: response.error }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  const chosenPath = (senderId: number, token: string): string | undefined =>
    chosen.get(`${senderId}:${token}`)

  return {
    async exportWorkspace(input: { workspaceId: string; workspaceName: string }) {
      const out = await deps.chooseSavePath(defaultBundleName(input.workspaceName, now()))
      if (!out) return { status: 'canceled' as const }
      const result = await call((machineId) => ({
        operation: 'export',
        machineId,
        workspaceId: input.workspaceId,
        out
      }))
      return result.status === 'ok' ? { status: 'done' as const, summary: result.result } : result
    },

    async chooseImportFile(senderId: number) {
      const file = await deps.chooseOpenPath()
      if (!file) return { status: 'canceled' as const }
      for (const key of [...chosen.keys()]) if (key.startsWith(`${senderId}:`)) chosen.delete(key)
      const token = randomUUID()
      chosen.set(`${senderId}:${token}`, file)
      return { status: 'chosen' as const, token, fileName: path.basename(file) }
    },

    async previewImport(input: { senderId: number; workspaceId: string; token: string }) {
      const file = chosenPath(input.senderId, input.token)
      if (!file) return { status: 'error' as const, message: 'import_file_expired' }
      const result = await call((machineId) => ({
        operation: 'import',
        machineId,
        workspaceId: input.workspaceId,
        file,
        dryRun: true
      }))
      return result.status === 'ok'
        ? { status: 'planned' as const, plan: (result.result as { plan: unknown }).plan }
        : result
    },

    async importWorkspace(input: { senderId: number; workspaceId: string; token: string }) {
      const file = chosenPath(input.senderId, input.token)
      if (!file) return { status: 'error' as const, message: 'import_file_expired' }
      const result = await call((machineId) => ({
        operation: 'import',
        machineId,
        workspaceId: input.workspaceId,
        file
      }))
      if (result.status !== 'ok') return result
      chosen.delete(`${input.senderId}:${input.token}`)
      return { status: 'done' as const, outcome: result.result }
    },

    /** Drops a window's chosen file when the window goes away. */
    forgetSender(senderId: number) {
      for (const key of [...chosen.keys()]) if (key.startsWith(`${senderId}:`)) chosen.delete(key)
    }
  }
}

export type WorkspaceBundleService = ReturnType<typeof createWorkspaceBundleService>
