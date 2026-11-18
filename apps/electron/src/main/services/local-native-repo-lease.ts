import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc'
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths'
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy'
import type { ProcessFacadeOptions } from '@lody/shared/node/process'
import type { RepoClient } from '@loro-dev/loro-repo-client'
import {
  assertPublishedNativeWorkspaceFlockStorage,
  readNativeWorkspaceFlockOwner
} from './native-workspace-routing'

/**
 * Main's data-only lease survives execution being disabled. No SDK handle crosses IPC.
 * @deprecated Promise application composition; remove when main receives the native Layer.
 */
export class LocalNativeRepoLeaseServiceLegacy {
  private owner: IndependentNativeRepoHostLegacy | undefined
  private binding: string | undefined
  private closed = false

  constructor(
    private readonly options: {
      dataRoot: string
      requested: boolean
      requiredSdkArtifactId?: string
      launch(): { executable: string; entry: string }
      process?: ProcessFacadeOptions
    }
  ) {}

  async ensure(snapshot: ElectronLocalPlatformSnapshot): Promise<void> {
    await this.ensureBinding(snapshot.userId, snapshot.workspace.workspaceId)
  }
  private async ensureBinding(accountId: string, workspaceId: string): Promise<void> {
    if (this.closed) throw new Error('Desktop data lease is closed')
    const selected = resolveLocalIndependentRepo({
      platform: 'local',
      dataRoot: this.options.dataRoot,
      accountId,
      workspaceId
    })
    if (
      !this.options.requested &&
      !existsSync(join(selected.directory, 'routes.sqlite3')) &&
      !existsSync(join(selected.dataDir, 'independent-mode.json'))
    )
      return
    if (existsSync(join(selected.classicDirectory, 'routes.sqlite3')))
      throw new Error(
        'Classic native rooms require an explicit ownership migration before independent mode'
      )
    assertPublishedNativeWorkspaceFlockStorage(this.options.dataRoot, {
      accountId,
      workspaceId,
      roomId: `${workspaceId}:wf:workspace`,
      contentMode: 'plaintext'
    })
    if (
      existsSync(join(selected.directory, 'routes.sqlite3')) &&
      readNativeWorkspaceFlockOwner(this.options.dataRoot, {
        accountId,
        workspaceId,
        roomId: `${workspaceId}:wf:workspace`,
        contentMode: 'plaintext'
      }) === 'frozen' &&
      !existsSync(join(selected.dataDir, 'independent-mode.json'))
    )
      throw new Error('Native workspace catalog recovery required: frozen owner mode is missing')
    if (this.binding && this.binding !== selected.binding)
      throw new Error('Desktop data lease identity changed; restart is required')
    if (!this.owner) {
      this.binding = selected.binding
      this.owner = new IndependentNativeRepoHostLegacy(
        {
          dataDir: selected.dataDir,
          binding: selected.binding,
          ...this.options.launch(),
          requiredSdkArtifactId: this.options.requiredSdkArtifactId
        },
        this.options.process
      )
    }
    await this.owner.client()
    if (this.closed) throw new Error('Desktop data lease closed during acquisition')
  }
  /** Trusted main Node composition only; never returned by an IPC method. */
  async client(binding: { accountId: string; workspaceId: string }): Promise<RepoClient> {
    await this.ensureBinding(binding.accountId, binding.workspaceId)
    if (!this.owner || this.closed) throw new Error('Desktop independent data host is unavailable')
    return this.owner.client()
  }

  /** Trusted Node proof only. The running host, not the installed package, supplies this identity. */
  async leaseInfo(expectedClient?: RepoClient) {
    if (!this.owner || this.closed) throw new Error('Desktop independent data host is unavailable')
    return this.owner.leaseInfo(expectedClient)
  }

  async close(): Promise<void> {
    this.closed = true
    // Retain the owner on failure. Quit recovery retries this exact lease.
    await this.owner?.close()
  }
}
