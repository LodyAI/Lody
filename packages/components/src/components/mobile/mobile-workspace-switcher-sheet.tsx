import { Fragment, type ReactNode } from 'react';
import { Check, Plus, Users } from 'lucide-react';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { cn } from '@/lib/utils';
import { WorkspaceAvatar } from '@/components/workspace-avatar';

export type MobileWorkspaceSwitcherWorkspace = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isActive?: boolean;
};

export type MobileWorkspaceSwitcherSheetLabels = {
  title?: string;
  description?: string;
  workspacesHeading?: string;
  createWorkspace?: string;
  inviteMembers?: string;
};

export type MobileWorkspaceSwitcherSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional caption rendered above the workspace list — typically the
     signed-in user's email. */
  userEmail?: string | null;
  workspaces: MobileWorkspaceSwitcherWorkspace[];
  onSelect: (workspaceId: string) => void;
  /** Optional create-workspace action. When omitted the row is hidden. */
  onCreateWorkspace?: () => void;
  /** Optional invite-members action. When omitted the row is hidden. */
  onInviteMembers?: () => void;
  labels?: MobileWorkspaceSwitcherSheetLabels;
};

/**
 * Bottom sheet that hosts the workspace switcher on mobile. Mirrors the
 * desktop `OrganizationSwitcher` content shape (user email caption,
 * "Workspaces" section, list, create + invite actions) but lives in a
 * vaul Drawer so it doesn't compete with the home page's z-stack.
 */
export function MobileWorkspaceSwitcherSheet({
  open,
  onOpenChange,
  userEmail,
  workspaces,
  onSelect,
  onCreateWorkspace,
  onInviteMembers,
  labels = {},
}: MobileWorkspaceSwitcherSheetProps) {
  const title = labels.title ?? '工作空间';
  const description = labels.description;
  const workspacesHeading = labels.workspacesHeading ?? 'Workspaces';
  const createWorkspaceLabel = labels.createWorkspace ?? 'Create Workspace';
  const inviteMembersLabel = labels.inviteMembers ?? 'Invite members';

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={cn(
          'mobile-workspace-switcher-sheet',
          'h-auto! max-h-[80dvh]! rounded-t-2xl border-border/60'
        )}
      >
        <div className="flex max-h-full min-h-0 flex-col">
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          <DrawerDescription className="sr-only">{description ?? title}</DrawerDescription>

          <div className="flex-1 overflow-y-auto px-3 pb-[calc(var(--safe-area-bottom,0px)+12px)] pt-3">
            {userEmail ? (
              <div className="px-2 pb-2 pt-1 text-[0.72rem] font-medium text-muted-foreground">
                {userEmail}
              </div>
            ) : null}

            <div className="px-2 pb-1 pt-2 text-[0.72rem] font-semibold tracking-wide text-muted-foreground">
              {workspacesHeading}
            </div>
            <ul className="flex flex-col gap-0.5">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <SheetRow
                    onClick={() => {
                      onOpenChange(false);
                      onSelect(workspace.id);
                    }}
                    active={workspace.isActive}
                    leading={<WorkspaceLeadingAvatar workspace={workspace} />}
                    trailing={
                      workspace.isActive ? (
                        <Check className="h-4 w-4 shrink-0 text-foreground/70" aria-hidden="true" />
                      ) : null
                    }
                  >
                    <span className="truncate text-[0.95rem] font-medium">{workspace.name}</span>
                  </SheetRow>
                </li>
              ))}
            </ul>

            {onCreateWorkspace || onInviteMembers ? (
              <div className="mt-3 border-t border-border/40 pt-2">
                {onCreateWorkspace ? (
                  <Fragment>
                    <SheetRow
                      onClick={() => {
                        onOpenChange(false);
                        onCreateWorkspace();
                      }}
                      leading={
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/80">
                          <Plus className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                        </span>
                      }
                    >
                      <span className="truncate text-[0.95rem] font-medium">
                        {createWorkspaceLabel}
                      </span>
                    </SheetRow>
                  </Fragment>
                ) : null}
                {onInviteMembers ? (
                  <SheetRow
                    onClick={() => {
                      onOpenChange(false);
                      onInviteMembers();
                    }}
                    leading={
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/80">
                        <Users className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                      </span>
                    }
                  >
                    <span className="truncate text-[0.95rem] font-medium">
                      {inviteMembersLabel}
                    </span>
                  </SheetRow>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Trap a hidden close target for keyboard / accessibility — the
             sheet's primary dismissal is the backdrop tap on vaul. */}
          <DrawerClose className="sr-only">Close</DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function WorkspaceLeadingAvatar({
  workspace,
}: {
  workspace: MobileWorkspaceSwitcherWorkspace;
}) {
  /* No selection ring on the avatar — letter tiles use hashed hues
     (green/blue/…) and a primary ring clashes hard. Active state is
     shown by the trailing check + row background instead. */
  return (
    <WorkspaceAvatar
      workspace={{ name: workspace.name, logo: workspace.avatarUrl }}
      size="large"
      className="shrink-0"
    />
  );
}

/* Tappable row shared by the workspace items + the create / invite
   actions. Keeps the padding / hover treatment consistent across both
   sections so the sheet reads as one menu. */
function SheetRow({
  children,
  leading,
  trailing,
  onClick,
  active,
}: {
  children: ReactNode;
  leading: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-foreground',
        'transition-colors hover:bg-muted/60 active:scale-[0.99]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        active && 'bg-muted/50'
      )}
    >
      {leading}
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {trailing}
    </button>
  );
}
