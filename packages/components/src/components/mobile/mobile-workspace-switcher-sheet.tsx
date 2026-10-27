import { Fragment, type ReactNode } from 'react';
import { Check, Plus, Users } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { EncryptedWorkspaceMark } from '@/components/e2ee/encrypted-workspace-mark';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { WorkspaceAvatar } from '@/components/workspace-avatar';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileWorkspaceSwitcherWorkspace = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isActive?: boolean;
  /** Display-only listing metadata; never an admission decision. */
  encrypted?: boolean;
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

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  /** The sheet's scrolling body. */
  body: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[3],
    paddingBottom: 'calc(var(--safe-area-bottom, 0px) + 12px)',
  },
  /** The signed-in user's caption. */
  caption: {
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[2],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  /** The heading above the workspace list. */
  heading: {
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[1],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  /** The list of workspaces. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
  },
  /** The create / invite block, under the list. */
  actions: {
    marginTop: themeSpace[3],
    paddingTop: themeSpace[2],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
  },
  /** A row of the sheet: a workspace, or an action. */
  row: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    textAlign: 'left',
    borderRadius: themeRadius.xl,
    color: themeColors.foreground,
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
    scale: { default: null, ':active': '0.99' },
    // The global "Pro focus style" paints an inset ring on every focused
    // input and button; the picker's own focus-scoped ring never painted
    // (the app zeroes Tailwind's ring on focus), so it must not appear
    // here either.
    boxShadow: { default: null, ':focus-visible': 'none' },
    ...TRANSITION_COLORS,
  },
  /** The row of the workspace that is open. */
  rowActive: {
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.5)',
      ':hover': 'hsl(var(--muted) / 0.6)',
    },
  },
  /** The row's content column. */
  rowBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
  },
  /** The row's name. */
  rowLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
  },
  /** The mark in front of a create / invite action. */
  actionGlyph: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[9],
    height: themeSpace[9],
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.muted,
    color: 'hsl(var(--foreground) / 0.8)',
  },
  /** The check beside the open workspace. */
  checkGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: 'hsl(var(--foreground) / 0.7)',
  },
});

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
      <DrawerContent className="mobile-workspace-switcher-sheet h-auto! max-h-[80dvh]! rounded-t-2xl border-border/60">
        <div {...stylex.props(sheetSurface.columnAuto)}>
          <DrawerTitle {...stylex.props(sheetSurface.srOnly)}>{title}</DrawerTitle>
          <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>
            {description ?? title}
          </DrawerDescription>

          <div {...stylex.props(styles.body)}>
            {userEmail ? <div {...stylex.props(styles.caption)}>{userEmail}</div> : null}

            <div {...stylex.props(styles.heading)}>{workspacesHeading}</div>
            <ul {...stylex.props(styles.list)}>
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
                        <Check {...stylex.props(styles.checkGlyph)} aria-hidden="true" />
                      ) : null
                    }
                  >
                    <span {...stylex.props(styles.rowLabel)}>{workspace.name}</span>
                    {workspace.encrypted ? <EncryptedWorkspaceMark /> : null}
                  </SheetRow>
                </li>
              ))}
            </ul>

            {onCreateWorkspace || onInviteMembers ? (
              <div {...stylex.props(styles.actions)}>
                {onCreateWorkspace ? (
                  <Fragment>
                    <SheetRow
                      onClick={() => {
                        onOpenChange(false);
                        onCreateWorkspace();
                      }}
                      leading={
                        <span {...stylex.props(styles.actionGlyph)}>
                          <Plus
                            {...stylex.props(sheetSurface.glyph16)}
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        </span>
                      }
                    >
                      <span {...stylex.props(styles.rowLabel)}>{createWorkspaceLabel}</span>
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
                      <span {...stylex.props(styles.actionGlyph)}>
                        <Users
                          {...stylex.props(sheetSurface.glyph16)}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </span>
                    }
                  >
                    <span {...stylex.props(styles.rowLabel)}>{inviteMembersLabel}</span>
                  </SheetRow>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Trap a hidden close target for keyboard / accessibility — the
             sheet's primary dismissal is the backdrop tap on vaul. */}
          <DrawerClose {...stylex.props(sheetSurface.srOnly)}>Close</DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function WorkspaceLeadingAvatar({ workspace }: { workspace: MobileWorkspaceSwitcherWorkspace }) {
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
      {...stylex.props(styles.row, active && styles.rowActive)}
    >
      {leading}
      <span {...stylex.props(styles.rowBody)}>{children}</span>
      {trailing}
    </button>
  );
}
