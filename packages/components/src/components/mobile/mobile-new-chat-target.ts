import type { SessionContextType } from '@/components/chat/context-switch';
import { getLocalProjectBranchLabel } from '@/lib/chat-landing-git-state';

/** Direct local sessions use the checked-out ref; worktrees use the selected ref.
 * Both are opaque selectors on the wire and must be formatted only for display. */
export function resolveMobileNewChatBranchLabel({
  contextType,
  currentBranch,
  selectedBranch,
  useWorktree,
  labels,
}: {
  contextType: SessionContextType;
  currentBranch?: string | null;
  selectedBranch?: string | null;
  useWorktree: boolean;
  labels: { local: string; remote: string; placeholder: string };
}): string {
  const branch = contextType === 'local' && !useWorktree ? currentBranch : selectedBranch;
  if (!branch) return labels.placeholder;
  return contextType === 'local' ? getLocalProjectBranchLabel(branch, labels) : branch;
}

export type MobileNewChatTargetLabels = {
  noProject: string;
  project: string;
  repository: string;
};

/**
 * Header title for the blank new-chat compose sheet.
 *
 * The sheet shows ONE target: the selected project / repository name, or the
 * no-project label when no project is involved. An empty or whitespace-only
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
  return labels.noProject;
}
