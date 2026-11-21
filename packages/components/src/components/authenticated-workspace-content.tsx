import { Outlet } from '@tanstack/react-router';
import { WorkspaceCheckoutPendingDialog } from '@/components/workspace-checkout-pending-dialog';
import { ElectronSessionCompletionNotifier } from '@/components/electron-session-completion-notifier';
import { ElectronDesktopForegroundPresence } from '@/components/electron-desktop-foreground-presence';
import { ElectronMenuHandler } from '@/components/electron-menu-handler';
import { AppCommands } from '@/components/app-commands';
import { CommandPalette } from '@/components/commands/command-palette';
import { SessionSubConversationConfirmationDialog } from '@/components/sessions/session-sub-conversation-confirmation';
import { useObserveWindowReadEngagement } from '@/lib/window-read-engagement';

export function AuthenticatedWorkspaceContent({
  showWorkspaceCheckout = false,
}: {
  showWorkspaceCheckout?: boolean;
}) {
  useObserveWindowReadEngagement();
  return (
    <>
      <Outlet />
      <ElectronSessionCompletionNotifier />
      <ElectronDesktopForegroundPresence />
      <ElectronMenuHandler />
      <AppCommands />
      <CommandPalette />
      <SessionSubConversationConfirmationDialog />
      {showWorkspaceCheckout && <WorkspaceCheckoutPendingDialog />}
    </>
  );
}
