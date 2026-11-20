import { Effect } from 'effect'
import { EngineKeyringSinkError } from '@lody/e2ee-core/services'
import type { NativeEncryptedAccess } from './native-session-read'
import {
  attachNativeEncryptedWorkspace,
  nativePendingWipeMarker,
  wipeNativeNamespace
} from '@lody/shared/node/native-encrypted-workspace'
import type { NativeRepoConnection } from '@lody/shared/node/native-repo'
import {
  desktopE2eeCloudClient,
  runDesktopE2eeOperation,
  withDesktopE2eeAccount
} from './e2ee-account-runtime'
import type { DesktopEngineKeyringSink } from './e2ee-runtime.mjs'
import {
  attachedNativeWorkspace,
  rememberNativeWorkspace,
  takeNativeWorkspace
} from './native-encrypted-workspaces'

type RepoClient = NativeRepoConnection['client']

const denied = () => new Error('native_meta_scope_denied')

export type { NativeEncryptedAccess }

/**
 * Main's side of an encrypted workspace on the native engine
 * (specs/native-engine-cloud-e2ee.md, phase 1). A renderer request is admitted
 * only while that window holds the workspace's E2EE reader lease for the signed-in
 * account; the first admitted request attaches the namespace once.
 */
export async function admitNativeEncryptedReader(
  senderId: number,
  workspaceId: string,
  connection: { client: RepoClient; dataDir: string }
): Promise<NativeEncryptedAccess> {
  const cloud = await desktopE2eeCloudClient()
  const status = await withDesktopE2eeAccount(
    (owner) =>
      owner.accountId === cloud.accountId && owner.readers.get(workspaceId)?.has(senderId)
        ? owner.host.status(workspaceId)
        : Effect.fail(denied()),
    workspaceId,
    false
  )
  const accountId = cloud.accountId
  if (!status.signingPublicKey) throw denied()
  let handle = attachedNativeWorkspace(workspaceId, accountId)
  if (!handle) {
    handle = attach(accountId, workspaceId, status, connection)
    rememberNativeWorkspace(workspaceId, accountId, handle)
  }
  await handle
  return {
    accountId,
    readMachineSharing: async (machineId) => {
      const work = await withDesktopE2eeAccount(
        (owner) =>
          owner.accountId === accountId && owner.readers.get(workspaceId)?.size
            ? Effect.succeed(
                owner.host.readMachineSharing(
                  workspaceId,
                  machineId,
                  cloud.client.machineSharing(),
                  (request) => cloud.client.history(request)
                )
              )
            : Effect.fail(denied()),
        workspaceId,
        false
      )
      return runDesktopE2eeOperation(accountId, work)
    }
  }
}

function attach(
  accountId: string,
  workspaceId: string,
  status: { genesisHash: string; signingPublicKey?: string },
  { client, dataDir }: { client: RepoClient; dataDir: string }
) {
  const writer = `personal:${status.signingPublicKey}`
  const call = (operation: string, request: () => Promise<unknown>) =>
    Effect.tryPromise({
      try: request,
      catch: (cause) => new EngineKeyringSinkError({ operation, cause })
    }).pipe(Effect.asVoid)
  const sink: DesktopEngineKeyringSink = {
    configure: (genesis) => call('configure', () => client.keyringConfigure(workspaceId, genesis)),
    admit: (keys) => call('admit', () => client.keyringAdmit(workspaceId, keys)),
    installEpoch: (epoch, key) =>
      call('installEpoch', () => client.keyringInstallEpoch(workspaceId, epoch, key)),
    setSealEpoch: (epoch) =>
      call('setSealEpoch', () => client.keyringSetSealEpoch(workspaceId, epoch)),
    holdSealing: () => call('holdSealing', () => client.keyringHoldSealing(workspaceId, writer)),
    releaseSealing: () =>
      call('releaseSealing', () => client.keyringReleaseSealing(workspaceId, writer)),
    installSeed: (seed) => client.keyringSetSigner(workspaceId, writer, seed)
  }
  /** Main-owned operations need a live reader of this account, not a particular window. */
  const leased = <A>(
    work: (
      owner: Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]
    ) => Effect.Effect<A, unknown>
  ) =>
    withDesktopE2eeAccount(
      (owner) =>
        owner.accountId === accountId && owner.readers.get(workspaceId)?.size
          ? work(owner)
          : Effect.fail(new Error('e2ee_not_open')),
      workspaceId,
      false
    )
  return attachNativeEncryptedWorkspace({
    client,
    workspaceId,
    genesisHash: status.genesisHash,
    writer,
    contentToken: async (rejectedToken) => {
      const credential = await leased((owner) => owner.bootstrap.deviceCredential(workspaceId))
      const cloud = await desktopE2eeCloudClient()
      if (cloud.accountId !== accountId) throw new Error('e2ee_account_mismatch')
      return Effect.runPromise(
        cloud.client.contentStreamsToken({
          workspaceId,
          credential,
          ...(rejectedToken ? { rejectedToken } : {})
        })
      )
    },
    syncKeyring: async () =>
      runDesktopE2eeOperation(
        accountId,
        await leased((owner) => Effect.succeed(owner.host.syncEngineKeyring(workspaceId, sink)))
      ),
    pendingWipe: nativePendingWipeMarker(dataDir, workspaceId)
  })
}

/**
 * Durable access loss (after the removal receipt): views close, then device
 * revocation retires main's writer and member removal drops the namespace. An
 * interrupted drop keeps its marker; the next connection finishes it.
 */
export async function removeNativeEncryptedWorkspace(
  workspaceId: string,
  reason: 'member_removed' | 'device_revoked',
  connect: () => Promise<{ client: RepoClient; dataDir: string }>
) {
  const handle = await takeNativeWorkspace(workspaceId)
  if (reason === 'device_revoked') {
    await handle?.retireWriter()
    handle?.close()
    return
  }
  if (handle) return handle.wipe()
  const { client, dataDir } = await connect()
  await wipeNativeNamespace({
    client,
    workspaceId,
    pendingWipe: nativePendingWipeMarker(dataDir, workspaceId)
  })
}
