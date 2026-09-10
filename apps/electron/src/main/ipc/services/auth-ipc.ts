import { productWindows } from '../../window-state'
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
