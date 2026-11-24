import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema'
import { MAX_PACKED_CLIENT_BUNDLE_BYTES, unpackClientBundle } from '@lody/shared/plugins/digest'

import {
  workspacePluginEntrySchema,
  type WorkspacePluginEntry
} from '@lody/shared/plugins/workspace-entry'
import { fetchWorkspaceNpmRelease } from '@lody/shared/plugins/workspace-npm'

export const scopeHash = (parts: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export type WorkspaceModuleOperation =
  | { action: 'approve'; npm?: WorkspacePluginEntry }
  | { action: 'forget' }
  | { action: 'open'; bytes: Uint8Array; names: Record<string, string[]> }
type Evidence = { manifest: PluginManifest; digest?: string; dev: boolean }
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)])
        )
      : value
}
/** Store admission evidence, never executable bytes. The caller derives directory from native custody. */
const pending = new Map<string, Promise<unknown>>()
async function confirmNpmRelease(pin: WorkspacePluginEntry) {
  const { dialog } = await import('electron')
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Trust release'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Allow this npm plugin to run in Lody?',
    detail: `${pin.source.package_name}@${pin.source.exact_version} from registry.npmjs.org\nPlugin: ${pin.plugin_id}\nPermissions: ${JSON.stringify(pin.permissions)}\nClient SHA-256: ${pin.client_digest}`
  })
  return result.response === 1
}
export async function workspaceModuleProof(
  directory: string,
  raw: PluginManifest,
  digest: string,
  op: WorkspaceModuleOperation,
  evidence: () => Promise<Evidence>,
  current: () => boolean,
  confirm = confirmNpmRelease
): Promise<string | null> {
  const key = JSON.stringify([directory, raw.id])
  const prior = pending.get(key)
  const work = (prior ?? Promise.resolve())
    .catch(() => {})
    .then(() => applyProof(directory, raw, digest, op, evidence, current, confirm))
  pending.set(key, work)
  try {
    return await work
  } finally {
    if (pending.get(key) === work) pending.delete(key)
  }
}
async function applyProof(
  directory: string,
  raw: PluginManifest,
  digest: string,
  op: WorkspaceModuleOperation,
  evidence: () => Promise<Evidence>,
  current: () => boolean,
  confirm = confirmNpmRelease
): Promise<string | null> {
  const m = pluginManifestSchema.parse(raw)
  if (
    !current() ||
    !m.client ||
    m.machine ||
    [m.skills, m.agentRoles, m.mcpServers, m.acpProviders].some((c) => c?.length) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw Error('Invalid workspace release')
  const path = join(directory, m.id + '.json'),
    proof = JSON.stringify([digest, canonical(m)])
  if (op.action === 'approve') {
    const row =
      op.npm === undefined
        ? await evidence()
        : await (async () => {
            const pin = workspacePluginEntrySchema.parse(op.npm)
            if (!pin.enabled || pin.plugin_id !== m.id || pin.client_digest !== digest)
              throw Error('Invalid workspace npm approval')
            if (!(await confirm(pin)) || !current()) throw Error('Workspace npm approval cancelled')
            const release = await fetchWorkspaceNpmRelease(pin, AbortSignal.timeout(60000))
            return { manifest: release.manifest, digest: release.digest, dev: false }
          })()
    if (
      row.dev ||
      row.digest !== digest ||
      JSON.stringify([digest, canonical(row.manifest)]) !== proof ||
      !current()
    )
      throw Error('Workspace release differs from native catalog')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const tmp = path + '.' + randomUUID()
    try {
      await writeFile(tmp, proof, { mode: 0o600, flag: 'wx' })
      if (!current()) throw Error('Reader retired')
      await rename(tmp, path)
    } finally {
      await rm(tmp, { force: true })
    }
    return null
  }
  let stored: string
  try {
    stored = await readFile(path, 'utf8')
  } catch (e) {
    if (op.action === 'forget' && (e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  if (stored !== proof || !current()) throw Error('Workspace release not approved')
  if (op.action === 'forget') {
    await rm(path, { force: true })
    return null
  }
  if (
    op.action !== 'open' ||
    !(op.bytes instanceof Uint8Array) ||
    op.bytes.length > MAX_PACKED_CLIENT_BUNDLE_BYTES ||
    createHash('sha256').update(op.bytes).digest('hex') !== digest
  )
    throw Error('Workspace bundle integrity failure')
  return new TextDecoder('utf-8', { fatal: true }).decode(unpackClientBundle(op.bytes)(m.client))
}
