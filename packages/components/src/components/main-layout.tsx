import { useWorkspaceBadge } from '@/hooks/use-workspace-badge';
import { useAgentRoleSchemaReconciliation } from '@/hooks/use-agent-role-schema-reconciliation';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { useWorkspaceWindowOwner, WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useIsMobile } from '../hooks/use-mobile';
import { MobileWorkspaceLayout } from './mobile/mobile-workspace-layout';
import { WebWorkspaceLayout } from './web-workspace-layout';
import { BugReportDialogContainer } from './bug-report/bug-report-dialog-container';
import { JoinCommunityDialogContainer } from './settings/join-community-dialog-container';
import { StuckConnectionBannerContainer } from './stuck-connection-banner';
import { DesktopSettingsModal } from './settings/desktop-settings-modal';
import { PromptShortcutProvider } from '../providers/prompt-shortcut-provider';
export {
  getMobileMainLayoutContentClassName,
  getMobileMainLayoutRootClassName,
} from './workspace-layout-utils';

export function WorkspaceRuntimeShell({
  children,
  workspaceReady = true,
}: {
  children: ReactNode;
  workspaceReady?: boolean;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <MobileWorkspaceLayout workspaceReady={workspaceReady}>{children}</MobileWorkspaceLayout>
    );
  }

  return <WebWorkspaceLayout>{children}</WebWorkspaceLayout>;
}

function WorkspaceBadge() {
  useWorkspaceBadge();
  return null;
}

function AgentRoleSchemaReconciliation() {
  useAgentRoleSchemaReconciliation();
  return null;
}

export function MainLayout({
  children,
  workspaceReady = true,
}: {
  children: ReactNode;
  /**
   * Keeps the navigation shell mounted while a new workspace scope converges,
   * without starting workspace-owned background work or mobile content stacks.
   */
  workspaceReady?: boolean;
}) {
  const workspace = useAtomValue(currentWorkspaceSlugAtom);
  const owner = useWorkspaceWindowOwner(workspaceReady ? workspace : null);

  return (
    <WorkspaceWindowOwnerContext value={owner}>
      <PromptShortcutProvider enabled={workspaceReady}>
        <WorkspaceRuntimeShell workspaceReady={workspaceReady}>
          {children}
          {owner && workspaceReady ? <WorkspaceBadge /> : null}
          {owner && workspaceReady ? <AgentRoleSchemaReconciliation /> : null}
          {workspaceReady ? <BugReportDialogContainer /> : null}
          <JoinCommunityDialogContainer />
          <StuckConnectionBannerContainer />
          {workspaceReady ? <DesktopSettingsModal /> : null}
        </WorkspaceRuntimeShell>
      </PromptShortcutProvider>
    </WorkspaceWindowOwnerContext>
  );
}
