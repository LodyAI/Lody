import type { TFunction } from 'i18next';
import { SHARE_LIMITS } from '@lody/shared/session-sharing';

export type ShareActionStage =
  | 'capture'
  | 'prepare'
  | 'upload'
  | 'publish'
  | 'copy'
  | 'reset'
  | 'revoke';

/** Only known codes/messages choose copy. Never display server payloads or bearer URLs. */
export function sessionShareErrorMessage(
  error: unknown,
  stage: ShareActionStage,
  t: TFunction
): string {
  const data = typeof error === 'object' && error !== null && 'data' in error ? error.data : null;
  const code = typeof data === 'object' && data !== null && 'code' in data ? data.code : null;
  const message =
    typeof error === 'object' && error !== null && 'message' in error ? error.message : '';
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  let reason: string = stage;
  switch (code) {
    case 'unauthenticated':
      reason = 'auth';
      break;
    case 'share_forbidden':
      reason = 'permission';
      break;
    case 'share_conflict':
    case 'share_already_exists':
      reason = 'conflict';
      break;
    case 'share_unavailable':
      reason = 'unavailable';
      break;
    case 'share_quota_exceeded':
      reason = 'quota';
      break;
    case 'share_confirmation_required':
    case 'share_confirmation_requires_new_share':
    case 'share_delivery_required':
      reason = 'confirmation';
      break;
    default:
      switch (message) {
        case 'Share confirmation changed':
          reason = 'conflict';
          break;
        case 'Share source unavailable':
        case 'Duplicate share selection':
        case 'Share root not selected':
          reason = 'selection';
          break;
        case 'Share credential unavailable':
          reason = 'credential';
          break;
        case 'Invalid share selection':
          reason = 'conversationLimit';
          break;
        case 'Share object exceeds size limit':
          reason = 'size';
          break;
        case 'Share image exceeds size limit':
          reason = 'imageLimit';
          break;
        case 'Share history exceeds size limit':
          reason = 'historyLimit';
          break;
        case 'Share package exceeds size limit':
          reason = 'packageLimit';
          break;
        case 'Too many share attachments':
          reason = 'attachmentLimit';
          break;
        case 'Share attachment unavailable':
          reason = 'attachment';
          break;
        case 'Invalid share history':
        case 'Invalid share JSON':
        case 'Share JSON exceeds depth limit':
        case 'Invalid share attachment':
        case 'Share attachment checksum mismatch':
          reason = 'content';
          break;
        default:
          if (name === 'ZodError') reason = 'content';
          if (stage === 'capture' && name === 'TimeoutError') reason = 'captureTimeout';
      }
  }
  switch (reason) {
    case 'permission':
      return t(
        'sharing.error.permission',
        'You no longer have permission to change this share. Check your workspace membership and use the account that created the link.'
      );
    case 'auth':
      return t(
        'sharing.error.auth',
        'Your sign-in has expired. Sign in again, then retry sharing.'
      );
    case 'conflict':
      return t(
        'sharing.error.conflict',
        'This share changed while you were editing it. Close and reopen sharing to load the latest version, then try again.'
      );
    case 'unavailable':
      return t(
        'sharing.error.unavailable',
        'This share is no longer available. Close and reopen sharing to check its status or create a new link.'
      );
    case 'quota':
      return t(
        'sharing.error.quota',
        'The workspace has reached a sharing limit: at most 2 unfinished publications, 10 new publication attempts per hour, and 2 GiB of reserved share storage. Wait for unfinished publications to complete and try later, or reduce the shared content.'
      );
    case 'confirmation':
      return t(
        'sharing.error.confirmation',
        'This sharing request has expired or changed. Ask the agent to send a new request, then confirm it again.'
      );
    case 'size':
      return t(
        'sharing.error.size',
        'The selected content exceeds a sharing size limit: each conversation history can be up to {{historyMiB}} MiB, each image {{imageMB}} MB, and the whole share {{packageMiB}} MiB. Try fewer sub-conversations or images.',
        {
          historyMiB: SHARE_LIMITS.historyBytes / 1024 ** 2,
          imageMB: SHARE_LIMITS.imageBytes / 1_000_000,
          packageMiB: SHARE_LIMITS.deploymentBytes / 1024 ** 2,
        }
      );
    case 'conversationLimit':
      return t(
        'sharing.error.conversationLimit',
        'Select between 1 and {{limit}} conversations, including the main conversation. Reduce the selected sub-conversations and try again.',
        { limit: SHARE_LIMITS.conversations }
      );
    case 'attachmentLimit':
      return t(
        'sharing.error.attachmentLimit',
        'Each share can include up to {{limit}} images. Select fewer conversations with images and try again.',
        { limit: SHARE_LIMITS.attachments }
      );
    case 'imageLimit':
      return t(
        'sharing.error.imageLimit',
        'Each image can be up to {{limit}} MB. Use smaller images or select fewer conversations with oversized images, then retry.',
        { limit: SHARE_LIMITS.imageBytes / 1_000_000 }
      );
    case 'historyLimit':
      return t(
        'sharing.error.historyLimit',
        'A single conversation history can be up to {{limit}} MiB. Choose a shorter conversation and try again.',
        { limit: SHARE_LIMITS.historyBytes / 1024 ** 2 }
      );
    case 'packageLimit':
      return t(
        'sharing.error.packageLimit',
        'The whole share can be up to {{limit}} MiB. Reduce the selected sub-conversations or images and try again.',
        { limit: SHARE_LIMITS.deploymentBytes / 1024 ** 2 }
      );
    case 'selection':
      return t(
        'sharing.error.selection',
        'Some selected conversations are unavailable. Close and reopen sharing, check the selected conversations, and try again.'
      );
    case 'credential':
      return t(
        'sharing.error.credential',
        'This device does not have the share link. Reset the link to copy it here; the previous link will stop working.'
      );
    case 'content':
      return t(
        'sharing.error.content',
        'The conversation could not be prepared for sharing. Reload the app and try again. If it keeps failing, report the issue.'
      );
    case 'captureTimeout':
      return t(
        'sharing.error.captureTimeout',
        'Loading the conversations and images took too long. Check your connection and let the conversations finish syncing, then retry or select fewer sub-conversations.'
      );
    case 'attachment':
      return t(
        'sharing.error.attachment',
        'An image could not be loaded for sharing. Check that the images open in the original conversation and that your connection is working, then retry.'
      );
    case 'capture':
      return t(
        'sharing.error.capture',
        'Could not load the conversations for sharing. Check your connection, wait for the conversations to sync, and try again.'
      );
    case 'prepare':
      return t(
        'sharing.error.prepare',
        'Could not start sharing. Check your connection and try again. If it keeps failing, close and reopen sharing.'
      );
    case 'upload':
      return t(
        'sharing.error.upload',
        'The share upload did not finish. Check your connection and retry in this window to continue with the same content.'
      );
    case 'publish':
      return t(
        'sharing.error.publish',
        'Could not confirm whether the share was published. Retry in this window to check and complete publication, or reopen sharing to check its status.'
      );
    case 'copy':
      return t(
        'sharing.error.copy',
        'Could not copy the link to the clipboard. Allow clipboard access and try again, or copy the full link from the published page’s address bar.'
      );
    case 'reset':
      return t(
        'sharing.error.reset',
        'Could not confirm whether the link was reset. Reopen sharing to check its status before trying again.'
      );
    case 'revoke':
      return t(
        'sharing.error.revoke',
        'Could not confirm whether sharing was stopped. Reopen sharing to check its status before trying again.'
      );
    default:
      return t(
        'sharing.manager.failed',
        'Could not update sharing. Check the current settings and try again.'
      );
  }
}
