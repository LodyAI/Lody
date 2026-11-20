import type { NativeEncryptedWorkspace } from '@lody/shared/node/native-encrypted-workspace'

/**
 * Encrypted workspaces main has attached to the native engine
 * (specs/native-engine-cloud-e2ee.md, phase 1): one per workspace, for the
 * account whose reader lease admitted it. The E2EE host notifies verified changes
 * here; the native IPC owns attaching, admission and removal.
 */
const attached = new Map<string, { accountId: string; handle: Promise<NativeEncryptedWorkspace> }>()
const accessLost = new Set<(workspaceId: string) => void>()

export function attachedNativeWorkspace(workspaceId: string, accountId: string) {
  const entry = attached.get(workspaceId)
  return entry?.accountId === accountId ? entry.handle : undefined
}

export function rememberNativeWorkspace(
  workspaceId: string,
  accountId: string,
  handle: Promise<NativeEncryptedWorkspace>
) {
  const entry = { accountId, handle }
  attached.set(workspaceId, entry)
  handle.catch(() => {
    if (attached.get(workspaceId) === entry) attached.delete(workspaceId)
  })
}

/** A key round or ledger ingest succeeded: reinstall (idempotent; failures retry on the next one). */
export function refreshNativeWorkspace(workspaceId: string) {
  void attached
    .get(workspaceId)
    ?.handle.then((handle) => handle.refresh())
    .catch(() => {})
}

/** The last reader left: stop reinstalling. Keys stay for other processes on the namespace. */
export function detachNativeWorkspace(workspaceId: string) {
  const entry = attached.get(workspaceId)
  if (!entry) return
  attached.delete(workspaceId)
  void entry.handle.then((handle) => handle.close()).catch(() => {})
}

/** Removes the attachment for removal; views of the workspace close first. */
export async function takeNativeWorkspace(workspaceId: string) {
  for (const listener of [...accessLost]) listener(workspaceId)
  const entry = attached.get(workspaceId)
  attached.delete(workspaceId)
  return entry?.handle.catch(() => undefined)
}

export function onNativeAccessLost(listener: (workspaceId: string) => void) {
  accessLost.add(listener)
  return () => accessLost.delete(listener)
}
