import i18next, { type TFunction } from 'i18next';
import {
  workspaceSupports,
  type WorkspaceRestrictedFeature,
  type WorkspaceStreamsMode,
} from '@lody/shared/workspace-streams-content';

/** Shared display vocabulary; the support verdict stays in workspaceSupports. */
export function workspaceFeatureUnavailableMessage(
  feature: WorkspaceRestrictedFeature,
  t: TFunction = i18next.t
): string {
  let message: string;
  switch (feature) {
    case 'schedules':
      message = 'Encrypted workspaces do not yet support scheduled messages.';
      break;
    case 'preview-comments':
      message = 'Encrypted workspaces do not yet support preview comments.';
      break;
    case 'code-collab-index':
      message = 'Encrypted workspaces do not yet support Code Collab.';
      break;
    case 'shortcuts':
      message = 'Encrypted workspaces do not yet support prompt shortcuts.';
      break;
    case 'sharing':
      message = 'Encrypted workspaces do not yet support sharing.';
      break;
    case 'remote-preview':
      message = 'Encrypted workspaces do not yet support remote preview.';
      break;
    case 'export':
      message = 'Encrypted workspaces do not yet support exports.';
      break;
    case 'oss-import':
      message = 'Encrypted workspaces do not yet support imports.';
      break;
    case 'notification-body':
      message = 'Encrypted workspaces do not yet support notification content.';
      break;
    case 'attachments':
      message = 'Encrypted workspaces do not yet support attachments.';
      break;
    case 'rpc':
      message = 'Encrypted workspaces do not yet support remote machine operations.';
      break;
    case 'presence':
      message = 'Encrypted workspaces do not yet provide online status.';
      break;
  }
  return t(`e2ee.unavailable.${feature}`, { defaultValue: message }) || message;
}

/** Display copy for a protected file action the verified ledger role cannot perform. */
export function protectedFileWriteDeniedMessage(t: TFunction = i18next.t): string {
  const message =
    'Guests have read-only file access: saving, comparing changes, loading folders and change history are unavailable.';
  return t('e2ee.unavailable.guest-file-write', { defaultValue: message }) || message;
}

/** Preview controls create/renew/revoke capabilities and require a verified writer. */
export function protectedPreviewControlDeniedMessage(t: TFunction = i18next.t): string {
  const message = 'Your workspace role cannot create, renew or revoke remote previews.';
  return t('e2ee.unavailable.preview-control-write', { defaultValue: message }) || message;
}

export class WorkspaceFeatureUnavailableError extends Error {
  constructor(readonly feature: WorkspaceRestrictedFeature) {
    super(workspaceFeatureUnavailableMessage(feature));
    this.name = 'WorkspaceFeatureUnavailableError';
  }
}

/** Keep operation guards even when an entry is hidden or disabled. */
export function requireWorkspaceFeature(
  content: WorkspaceStreamsMode,
  feature: WorkspaceRestrictedFeature
): void {
  if (!workspaceSupports(content, feature)) throw new WorkspaceFeatureUnavailableError(feature);
}
