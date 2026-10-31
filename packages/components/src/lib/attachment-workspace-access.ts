import type { PlatformProvider } from '@lody/platform';
import { readWorkspaceModeEvidence, retainWorkspaceModeProof } from './e2ee-workspace-storage';
import { describeAuthenticatedWorkspace } from '../providers/workspace-mode-admission';

// Direct HTTP uploads do not pass through the Streams token gate. The cloud
// composition supplies the same account-bound admission authority explicitly.
type Access = Pick<PlatformProvider, 'identity' | 'workspaces' | 'e2eeWorkspaces'>;
let installed: Access | undefined;
const modeListeners = new Set<(accountId: string, workspaceId: string) => void>();
/** Same-window proof writes have no browser storage event. Listeners re-read
 * the retained evidence; the notification itself grants no mode authority. */
export function subscribeAttachmentWorkspaceMode(
  changed: (accountId: string, workspaceId: string) => void
) {
  modeListeners.add(changed);
  return () => {
    modeListeners.delete(changed);
  };
}
export function installAttachmentWorkspaceAccess(access: Access): () => void {
  if (installed && installed !== access)
    throw new Error('Attachment workspace access already installed');
  installed = access;
  return () => {
    if (installed === access) installed = undefined;
  };
}

/** Local-only IPC needs no cloud admission. Cloud preparation must verify mode
 * before either HTTP or its ordinary local fallback can see source bytes. */
export async function authorizePlaintextAttachmentPreparation(
  workspaceId: string,
  signal?: AbortSignal,
  accountId?: string
) {
  if (installed) await authorizePlaintextAttachmentUpload(workspaceId, signal, accountId);
}

/** No caller-provided `plaintext` flag authorizes sending a request body. */
export async function authorizePlaintextAttachmentUpload(
  workspaceId: string,
  signal?: AbortSignal,
  expectedAccountId?: string
) {
  const access = installed;
  if (!access?.e2eeWorkspaces) throw new Error('attachment_workspace_mode_unverified');
  const initial = access.identity.session.get();
  if (initial.status !== 'authenticated') throw new Error('attachment_workspace_mode_unverified');
  const accountId = initial.user.id;
  if (expectedAccountId && accountId !== expectedAccountId)
    throw new Error('attachment_account_changed');
  const assertOwner = () => {
    signal?.throwIfAborted();
    const current = access.identity.session.get();
    if (installed !== access || current.status !== 'authenticated' || current.user.id !== accountId)
      throw new Error('attachment_account_changed');
  };
  const evidence = () => {
    assertOwner();
    const saved = readWorkspaceModeEvidence(localStorage, accountId, workspaceId);
    const listing = access.workspaces.state.get();
    const listed =
      listing.status === 'ready'
        ? listing.workspaces.find((item) => item.id === workspaceId)
        : undefined;
    if (
      saved.encrypted ||
      saved.rejected ||
      (listed &&
        ((listed.contentMode !== undefined && listed.contentMode !== 'plaintext') ||
          (listed.contentModeVersion !== undefined && listed.contentModeVersion !== 1) ||
          listed.genesisHash ||
          listed.cryptoOrgId))
    )
      throw new Error('e2ee_attachment_unprotected');
    return { saved, listed };
  };
  const { saved } = evidence();
  if (!saved.descriptor) {
    const descriptor = await describeAuthenticatedWorkspace({
      session: access.identity.session,
      workspaces: access.e2eeWorkspaces,
      accountId,
      workspaceId,
      signal: signal ?? new AbortController().signal,
    });
    const { listed } = evidence();
    if (descriptor.workspaceId !== workspaceId)
      throw new Error('attachment_workspace_mode_unverified');
    // Retention validates the descriptor and rejects a downgrade against sticky
    // encryption evidence. It also lets runtime admission adopt the same result.
    retainWorkspaceModeProof(localStorage, accountId, listed?.slug ?? workspaceId, descriptor);
    for (const changed of modeListeners) changed(accountId, workspaceId);
    if ('contentMode' in descriptor && descriptor.contentMode === 'e2ee')
      throw new Error('e2ee_attachment_unprotected');
  }
  evidence();
}
