import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { resolveFilePreviewPath } from '@lody/shared/node/file-preview-path-policy'
import type { LocalFileResources } from './local-file-resource'

export const LocalFilePreviewRequestSchema = z
  .object({
    machineId: z.string().min(1),
    path: z.string().min(1),
    workspaceRoot: z.string().nullable().optional()
  })
  .strict()

export type LocalFilePreviewRequest = z.infer<typeof LocalFilePreviewRequestSchema>

/** Disk identity, not daemon liveness. Never expose the other credential fields. */
export async function readFileMachineId(credentialsPath: string): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(credentialsPath, 'utf8'))
    const parsed = z
      .object({ machine: z.object({ machineId: z.string().trim().min(1) }) })
      .safeParse(raw)
    return parsed.success ? parsed.data.machine.machineId : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Null means this desktop cannot serve the target; no path has been inspected. */
export async function previewLocalFile(
  resources: LocalFileResources,
  owner: number,
  request: LocalFilePreviewRequest,
  localMachineId: string | null
) {
  if (!localMachineId || request.machineId !== localMachineId) return null
  if (request.workspaceRoot != null && !isAbsolute(request.workspaceRoot))
    return {
      status: 'error' as const,
      v: 3 as const,
      code: 'invalid_path' as const,
      message: 'The session workspace must be an absolute path.',
      path: request.path
    }
  const resolution = resolveFilePreviewPath({
    requestedPath: request.path,
    workspaceRoot: request.workspaceRoot ?? null,
    options: { allowArbitraryPaths: true }
  })
  console.debug(
    '[file-preview]',
    JSON.stringify({
      stage: 'resolve-path',
      transport: 'local',
      machineId: request.machineId,
      requestedPath: request.path,
      workspaceRoot: request.workspaceRoot ?? null,
      ...(resolution.ok
        ? { status: 'ok', absolutePath: resolution.resolved.absolutePath }
        : { status: 'error', code: resolution.rejection.code })
    })
  )
  if (!resolution.ok)
    return {
      status: 'error' as const,
      v: 3 as const,
      ...resolution.rejection,
      path: request.path,
      retryable: resolution.rejection.code === 'transient_io'
    }
  const startedAt = Date.now()
  const file = {
    status: 'local-file' as const,
    path: resolution.resolved.reportedPath,
    absolutePath: resolution.resolved.absolutePath,
    external: resolution.resolved.external
  }
  try {
    const result = await resources.preview(owner, file)
    console.debug(
      '[file-preview]',
      JSON.stringify({
        stage: 'read',
        transport: 'local',
        requestedPath: request.path,
        absolutePath: file.absolutePath,
        status: result.status,
        durationMs: Date.now() - startedAt,
        ...('code' in result ? { code: result.code } : {})
      })
    )
    return result
  } catch (error) {
    console.warn(
      '[file-preview]',
      JSON.stringify({
        stage: 'read',
        transport: 'local',
        requestedPath: request.path,
        absolutePath: file.absolutePath,
        status: 'error',
        durationMs: Date.now() - startedAt,
        code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      })
    )
    throw error
  }
}
