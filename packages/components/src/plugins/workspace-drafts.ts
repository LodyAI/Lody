import { atom } from 'jotai';
import type { LodyClient } from '@lody/plugin-sdk/client';
export const pluginLandingDraftAtom = atom<{
  target: Parameters<LodyClient['drafts']['open']>[0];
  draft: Parameters<LodyClient['drafts']['open']>[1];
} | null>(null);

export function pluginAttachmentFile(snapshot: import('@lody/plugin-sdk').AttachmentSnapshot) {
  const title = snapshot.title.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100) || 'attachment';
  return new File([snapshot.markdown], `${title}.md`, { type: 'text/markdown' });
}
