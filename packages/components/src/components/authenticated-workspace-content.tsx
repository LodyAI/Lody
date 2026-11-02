import { Outlet } from '@tanstack/react-router';
import { WorkspaceCheckoutPendingDialog } from '@/components/workspace-checkout-pending-dialog';
import { ElectronSessionCompletionNotifier } from '@/components/electron-session-completion-notifier';
import { ElectronMenuHandler } from '@/components/electron-menu-handler';
import { AppCommands } from '@/components/app-commands';
import { CommandPalette } from '@/components/commands/command-palette';
import { SessionArchiveConfirmationDialog } from '@/components/sessions/session-archive-confirmation';

export function AuthenticatedWorkspaceContent({
  showWorkspaceCheckout = false,
}: {
  showWorkspaceCheckout?: boolean;
}) {
  return (
    <>
      <Outlet />
      <ElectronSessionCompletionNotifier />
      <ElectronMenuHandler />
      <AppCommands />
      <CommandPalette />
      <SessionArchiveConfirmationDialog />
      {showWorkspaceCheckout && <WorkspaceCheckoutPendingDialog />}
    </>
  );
}
