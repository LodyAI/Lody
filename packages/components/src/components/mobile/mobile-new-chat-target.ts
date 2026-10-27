import type { SessionContextType } from '@/components/chat/context-switch';

export type MobileNewChatTargetLabels = {
  chat: string;
  project: string;
  repository: string;
};

/**
 * Header title for the blank new-chat compose sheet.
 *
 * The sheet shows ONE target: the selected project / repository name, or the
 * plain Chat label when no project is involved. An empty or whitespace-only
 * selection reads as the localized placeholder rather than an empty title, so
 * the header can never collapse to just the icon + chevron.
 */
export function resolveMobileNewChatTargetLabel({
  contextType,
  repoFullName,
  projectName,
  labels,
}: {
  contextType: SessionContextType;
  repoFullName?: string | null;
  projectName?: string | null;
  labels: MobileNewChatTargetLabels;
}): string {
  if (contextType === 'github') return repoFullName?.trim() || labels.repository;
  if (contextType === 'local') return projectName?.trim() || labels.project;
  return labels.chat;
}
