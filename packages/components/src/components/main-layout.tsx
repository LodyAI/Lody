import { type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { tasksFeatureEnabledAtom } from '@/atoms/settings';
import { useIsMobile } from '../hooks/use-mobile';
import { useTaskIndexSync } from '../hooks/use-task-index';
import { MobileWorkspaceLayout } from './mobile/mobile-workspace-layout';
import { WebWorkspaceLayout } from './web-workspace-layout';
import { BugReportDialogContainer } from './bug-report/bug-report-dialog-container';
import { StuckConnectionBannerContainer } from './stuck-connection-banner';
import { DesktopSettingsModal } from './settings/desktop-settings-modal';
import { TaskQuickAddDialogContainer } from './tasks/task-quick-add-dialog-container';
import { TaskStatusWatcher } from './tasks/task-status-watcher';
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

/** Keeps the workspace task index live for the sidebar count and the Tasks page. */
function TaskIndexSync() {
  useTaskIndexSync();
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
  // Behind the beta gate none of this mounts: no index subscription, no status
  // watcher, no quick-add dialog listening for its open atom.
  const tasksEnabled = useAtomValue(tasksFeatureEnabledAtom);

  return (
    <WorkspaceRuntimeShell workspaceReady={workspaceReady}>
      {children}
      {tasksEnabled && workspaceReady ? (
        <>
          <TaskIndexSync />
          <TaskStatusWatcher />
          <TaskQuickAddDialogContainer />
        </>
      ) : null}
      {workspaceReady ? <BugReportDialogContainer /> : null}
      <StuckConnectionBannerContainer />
      {workspaceReady ? <DesktopSettingsModal /> : null}
    </WorkspaceRuntimeShell>
  );
}
