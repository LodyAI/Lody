import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  WorkspaceBundleExportSummarySchema,
  WorkspaceBundleImportOutcomeSchema,
  type WorkspaceBundleControlRequest,
  type WorkspaceBundleControlResponse
} from '@lody/shared/workspace-bundle-control'
import { formatUnknownError } from '../utils'

/** The renderer never sees the import path, only a token bound to its window. */
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
  // Each window holds at most one chosen file; a new choice replaces it.
  const chosen = new Map<number, { token: string; file: string }>()
  const now = deps.now ?? (() => new Date())

  const call = async <T>(
    request: (machineId: string) => WorkspaceBundleControlRequest,
    parse: (result: unknown) => T
  ): Promise<{ status: 'ok'; result: T } | WorkspaceBundleError> => {
    const machineId = await deps.machineId()
    if (!machineId) return { status: 'error', message: 'local_agent_unavailable' }
    try {
      const response = await deps.send(request(machineId))
      return response.ok
        ? { status: 'ok', result: parse(response.result) }
        : { status: 'error', message: response.error }
    } catch (error) {
      return { status: 'error', message: formatUnknownError(error) }
    }
  }

  const chosenFile = (senderId: number, token: string): string | undefined => {
    const entry = chosen.get(senderId)
    return entry?.token === token ? entry.file : undefined
  }

  return {
    async exportWorkspace(input: { workspaceId: string; workspaceName: string }) {
      const out = await deps.chooseSavePath(defaultBundleName(input.workspaceName, now()))
      if (!out) return { status: 'canceled' as const }
      const result = await call(
        (machineId) => ({ operation: 'export', machineId, workspaceId: input.workspaceId, out }),
        (value) => WorkspaceBundleExportSummarySchema.parse(value)
      )
      return result.status === 'ok' ? { status: 'done' as const, summary: result.result } : result
    },

    async chooseImportFile(senderId: number) {
      const file = await deps.chooseOpenPath()
      if (!file) return { status: 'canceled' as const }
      const token = randomUUID()
      chosen.set(senderId, { token, file })
      return { status: 'chosen' as const, token, fileName: path.basename(file) }
    },

    async previewImport(input: { senderId: number; workspaceId: string; token: string }) {
      const file = chosenFile(input.senderId, input.token)
      if (!file) return { status: 'error' as const, message: 'import_file_expired' }
      const result = await call(
        (machineId) => ({
          operation: 'import',
          machineId,
          workspaceId: input.workspaceId,
          file,
          dryRun: true
        }),
        (value) => WorkspaceBundleImportOutcomeSchema.parse(value)
      )
      return result.status === 'ok'
        ? { status: 'planned' as const, plan: result.result.plan }
        : result
    },

    async importWorkspace(input: { senderId: number; workspaceId: string; token: string }) {
      const file = chosenFile(input.senderId, input.token)
      if (!file) return { status: 'error' as const, message: 'import_file_expired' }
      const result = await call(
        (machineId) => ({ operation: 'import', machineId, workspaceId: input.workspaceId, file }),
        (value) => WorkspaceBundleImportOutcomeSchema.parse(value)
      )
      if (result.status !== 'ok') return result
      chosen.delete(input.senderId)
      return { status: 'done' as const, outcome: result.result }
    },

    /** Drops a window's chosen file when the window goes away. */
    forgetSender(senderId: number) {
      chosen.delete(senderId)
    }
  }
}

export type WorkspaceBundleService = ReturnType<typeof createWorkspaceBundleService>
