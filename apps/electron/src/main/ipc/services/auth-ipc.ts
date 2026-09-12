import { productWindows } from '../../window-state'
import { BrowserWindow, dialog } from 'electron'
import { saveRecoveryFile, readRecoveryFile } from '../../services/e2ee-recovery-file-io'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  ElectronAuthCallbackInputSchema,
  ElectronDevEmailPasswordSignInInputSchema,
  type ElectronAuthCallbackInput,
  type ElectronDevEmailPasswordSignInInput
} from '@lody/shared/electron-ipc'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

function assertAuthSender(): void {
  const { event } = getIpcContext()
  assertProductWindowSender(event)
}

const workspaceSelections = new WeakMap<
  Electron.WebContents,
  { organizationId?: string; organizationSlug?: string }
>()

export class AuthIpc extends IpcService {
  static override readonly groupName = 'auth'

  private recoveryFileSelector() {
    const event = getIpcContext().event
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('e2ee-window-unavailable')
    return async (assertCurrent: () => void) => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Lody recovery file', extensions: ['json'] }]
      })
      assertProductWindowSender(event)
      assertCurrent()
      if (result.canceled) return null
      if (result.filePaths.length !== 1) throw new Error('invalid-recovery-file')
      return await readRecoveryFile(result.filePaths[0], () => {
        assertProductWindowSender(event)
        assertCurrent()
      })
    }
  }

  @IpcMethod()
  async selectRecoveryBackup() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeUserService.selectRecoveryBackup(
      this.recoveryFileSelector()
    )
  }

  @IpcMethod()
  async restoreRecoveryBackup(backup: {
    accountId: string
    backupId: string
    identity: string
    revision: number
    ciphertext: Uint8Array
  }) {
    assertAuthSender()
    if (
      !backup ||
      typeof backup !== 'object' ||
      typeof backup.accountId !== 'string' ||
      typeof backup.backupId !== 'string' ||
      typeof backup.identity !== 'string' ||
      typeof backup.revision !== 'number' ||
      !(backup.ciphertext instanceof Uint8Array)
    )
      throw new Error('invalid-recovery-backup')
    return await getIpcServiceDeps().e2eeUserService.restoreRecoveryBackup(
      backup,
      this.recoveryFileSelector()
    )
  }

  @IpcMethod()
  async verifyRecoveryBackup(revision: unknown, ciphertext: unknown) {
    assertAuthSender()
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid-recovery-revision')
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0 || ciphertext.length > 2346)
      throw new Error('invalid-recovery-backup')
    return await getIpcServiceDeps().e2eeUserService.verifyRecoveryBackup(
      revision,
      ciphertext,
      this.recoveryFileSelector()
    )
  }

  @IpcMethod()
  async exportRecoveryBackup(revision: unknown) {
    assertAuthSender()
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid-recovery-revision')
    const event = getIpcContext().event
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('e2ee-window-unavailable')
    return await getIpcServiceDeps().e2eeUserService.exportRecoveryBackup(
      revision,
      async (file, backupId, assertCurrent) => {
        const result = await dialog.showSaveDialog(window, {
          defaultPath: `lody-recovery-${backupId}.json`,
          filters: [{ name: 'Lody recovery file', extensions: ['json'] }]
        })
        assertProductWindowSender(event)
        assertCurrent()
        if (result.canceled || !result.filePath) return false
        await saveRecoveryFile(result.filePath, file, () => {
          assertProductWindowSender(event)
          assertCurrent()
        })
        return true
      }
    )
  }

  @IpcMethod()
  async createUserIdentity() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeUserService.create()
  }

  @IpcMethod()
  async getUserIdentity() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeUserService.load()
  }

  @IpcMethod()
  async initializeDeviceIdentity() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeDeviceService.initialize()
  }

  @IpcMethod()
  async createDeviceIdentity() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeDeviceService.create()
  }

  @IpcMethod()
  async getDeviceIdentity() {
    assertAuthSender()
    return await getIpcServiceDeps().e2eeDeviceService.load()
  }

  @IpcMethod()
  async completeCallback(payload: ElectronAuthCallbackInput) {
    assertAuthSender()
    const input = ElectronAuthCallbackInputSchema.parse(payload)
    return await getIpcServiceDeps().authService.completeCallback(input)
  }

  @IpcMethod()
  async signInWithDevEmailPassword(payload: ElectronDevEmailPasswordSignInInput) {
    assertAuthSender()
    const input = ElectronDevEmailPasswordSignInInputSchema.parse(payload)
    return await getIpcServiceDeps().authService.signInWithDevEmailPassword(input)
  }

  @IpcMethod()
  async signOut() {
    assertAuthSender()
    const sender = getIpcContext().event.sender
    for (const window of productWindows) {
      if (window.webContents !== sender) window.destroy()
    }
    await getIpcServiceDeps().authService.signOut()
  }

  @IpcMethod()
  async getSession(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.getSession(options)
  }

  @IpcMethod()
  async listOrganizations(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.listOrganizations(options)
  }

  @IpcMethod()
  async getActiveOrganization(options?: unknown) {
    assertAuthSender()
    const sender = getIpcContext().event.sender
    const url = new URL(sender.getURL())
    const path = url.protocol === 'file:' ? url.hash.slice(1) : url.pathname
    const slug = path.split('/')[1]?.split('?')[0]
    const query =
      workspaceSelections.get(sender) ??
      (slug && !['onboarding', 'sign-in', 'login'].includes(slug)
        ? { organizationSlug: slug }
        : undefined)
    return await getIpcServiceDeps().authService.getActiveOrganization(options, query)
  }

  @IpcMethod()
  async changeEmail(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.changeEmail(payload)
  }

  @IpcMethod()
  async listAccounts(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.listAccounts(options)
  }

  @IpcMethod()
  async updateUser(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.updateUser(payload)
  }

  @IpcMethod()
  async changePassword(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.changePassword(payload)
  }

  @IpcMethod()
  async requestPasswordReset(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.requestPasswordReset(payload)
  }

  @IpcMethod()
  async convexToken(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.convexToken(options)
  }

  @IpcMethod()
  async crossDomainVerifyOneTimeToken(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.crossDomainVerifyOneTimeToken(payload)
  }

  @IpcMethod()
  async getInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationGetInvitation(payload)
  }

  @IpcMethod()
  async acceptInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationAcceptInvitation(payload)
  }

  @IpcMethod()
  async listInvitations(payload?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationListInvitations(payload)
  }

  @IpcMethod()
  async inviteMember(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationInviteMember(payload)
  }

  @IpcMethod()
  async cancelInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationCancelInvitation(payload)
  }

  @IpcMethod()
  async removeMember(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationRemoveMember(payload)
  }

  @IpcMethod()
  async updateMemberRole(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationUpdateMemberRole(payload)
  }

  @IpcMethod()
  async setActive(payload: unknown) {
    assertAuthSender()
    const id = (payload as { organizationId?: unknown } | null)?.organizationId
    if (typeof id !== 'string' || !id) throw new Error('Invalid organization id')
    const sender = getIpcContext().event.sender
    const query = { organizationId: id }
    const previous = workspaceSelections.get(sender)
    workspaceSelections.set(sender, query)
    let accepted = false
    try {
      const result = await getIpcServiceDeps().authService.getActiveOrganization(payload, query)
      accepted = Boolean(result.data && !result.error)
      return result
    } finally {
      if (!accepted && workspaceSelections.get(sender) === query) {
        if (previous) workspaceSelections.set(sender, previous)
        else workspaceSelections.delete(sender)
      }
    }
  }

  @IpcMethod()
  async updateOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationUpdate(payload)
  }

  @IpcMethod()
  async createOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationCreate(payload)
  }

  @IpcMethod()
  async deleteOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationDelete(payload)
  }

  @IpcMethod()
  async leaveOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationLeave(payload)
  }
}
