import { Archive, ChevronDown, Loader2, LockKeyhole, Monitor, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  shouldShowPrivateSharingStatus,
  type SessionSharingState,
} from '@/lib/session-sharing';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';

export type SessionSharingTranslator = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>
) => string;

export function getSessionSharingLabel(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  if (state.visibility === 'team') {
    return t('sessions.sharing.team', 'Team');
  }
  if (state.visibility === 'private') {
    return t('sessions.sharing.private', 'Private');
  }
  return t('sessions.sharing.checking', 'Checking visibility…');
}

export function getSessionSharingDescription(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  const machine = state.machineName ?? t('sessions.sharing.thisDevice', 'this device');
  const project = state.projectName ?? t('sessions.sharing.thisProject', 'this project');

  if (state.visibility === 'unknown') {
    return t('sessions.sharing.checkingDescription', 'Checking who can open this conversation.');
  }
  if (state.visibility === 'team') {
    return t(
      'sessions.sharing.teamDescription',
      'Everyone in this workspace can open this conversation.'
    );
  }

  switch (state.privateReason) {
    case 'machine':
      return t('sessions.sharing.privateMachine', '{{machine}} is not shared with the team.', {
        machine,
      });
    case 'project':
      return t('sessions.sharing.privateProject', '{{project}} is not shared with the team.', {
        project,
      });
    case 'machine-and-project':
      return t(
        'sessions.sharing.privateMachineAndProject',
        'Neither {{machine}} nor {{project}} is shared with the team.',
        { machine, project }
      );
    case 'machine-not-registered':
      return t(
        'sessions.sharing.machineNotRegistered',
        'This device is not registered for team access.'
      );
    default:
      return t('sessions.sharing.privateDescription', 'Only you can open this conversation.');
  }
}

export function getSessionShareDialogDescription(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  const machine = state.machineName ?? t('sessions.sharing.thisDevice', 'this device');
  const project = state.projectName ?? t('sessions.sharing.thisProject', 'this project');

  switch (state.privateReason) {
    case 'project':
      return t(
        'sessions.sharing.confirmProject',
        'This shares {{project}} with everyone in the workspace so they can open and continue its conversations.',
        { project }
      );
    case 'machine-and-project':
      return t(
        'sessions.sharing.confirmMachineAndProject',
        'This shares {{project}} and {{machine}} with everyone in the workspace. Other conversations on this device may also become visible.',
        { machine, project }
      );
    case 'machine':
      return t(
        'sessions.sharing.confirmMachine',
        'This shares {{machine}} with everyone in the workspace. Other conversations on this device may also become visible.',
        { machine }
      );
    default:
      return t(
        'sessions.sharing.confirmGeneric',
        'Everyone in this workspace will be able to open this conversation.'
      );
  }
}

export function SessionSharingIndicator({
  state,
  className,
}: {
  state: SessionSharingState;
  className?: string;
}) {
  const { t } = useTranslation();

  if (!shouldShowPrivateSharingStatus(state)) {
    return null;
  }

  const label = getSessionSharingLabel(t, state);
  const description = getSessionSharingDescription(t, state);

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`${label}: ${description}`}
          className={cn(
            '-m-1 box-content inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs p-1',
            'text-sidebar-foreground-muted outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50',
            className
          )}
        >
          <LockKeyhole className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72 px-2.5 py-2">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function getSessionShareActionLabel(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  switch (state.privateReason) {
    case 'project':
      return t('sessions.sharing.shareProjectWithTeam', 'Share project with team…');
    case 'machine-and-project':
      return t('sessions.sharing.shareProjectAndDevice', 'Share project and device…');
    case 'machine':
      return t('sessions.sharing.shareDeviceWithTeam', 'Share device with team…');
    case 'machine-not-registered':
      return t('sessions.sharing.registerDeviceToShare', 'Register this device before sharing');
    default:
      return t('sessions.sharing.shareWithTeam', 'Share with team…');
  }
}

/** Shared chrome for status pills in the session conversation header (Private, Archived). */
const SESSION_HEADER_STATUS_PILL_CLASS =
  'inline-flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md border border-border/70 bg-transparent px-2 ' +
  'text-[0.7rem] font-medium leading-none text-muted-foreground transition-colors ' +
  'hover:border-border hover:text-foreground ' +
  'outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 ' +
  'text-foreground/80';

/** Read-only status pill for archived conversations in the desktop toolbar. */
export function SessionArchivedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  const label = t('sessions.archived', 'Archived');
  const description = t(
    'sessions.archivedDescription',
    'This conversation is archived. Restore it to continue chatting.'
  );

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`${label}: ${description}`}
          className={cn(SESSION_HEADER_STATUS_PILL_CLASS, className)}
        >
          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-72 px-2.5 py-2">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Persistent access control for private conversations in the desktop toolbar.
 * Its menu explains the inherited machine/project scope before offering the
 * existing confirmation flow. Team and unresolved states stay out of the way. */
export function SessionAccessControl({
  state,
  onShareWithTeam,
  className,
}: {
  state: SessionSharingState;
  onShareWithTeam?: () => void | Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();

  if (!shouldShowPrivateSharingStatus(state)) {
    return null;
  }

  const triggerLabel = t('sessions.sharing.private', 'Private');
  const title = t('sessions.sharing.privateToYou', 'Private to you');
  const description = getSessionSharingDescription(t, state);
  const shareDisabled =
    !onShareWithTeam ||
    state.privateReason === 'machine-not-registered' ||
    !state.canManage;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${title}: ${description}`}
          className={cn(SESSION_HEADER_STATUS_PILL_CLASS, 'data-[state=open]:border-border data-[state=open]:text-foreground', className)}
        >
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-45" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-1.5">
        <div className="flex items-start gap-2.5 px-2 py-2">
          <LockKeyhole
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{title}</div>
            <div className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={shareDisabled}
          onSelect={() => {
            void onShareWithTeam?.();
          }}
        >
          {state.privateReason === 'machine-not-registered' ? (
            <Monitor className="h-3.5 w-3.5 shrink-0" />
          ) : state.canManage ? (
            <Users className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
          )}
          {state.canManage
            ? getSessionShareActionLabel(t, state)
            : t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShareConfirmationDialog({
  open,
  title,
  description,
  actionLabel,
  isSharing,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  actionLabel: string;
  isSharing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="line-clamp-2 break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSharing}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isSharing}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isSharing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SessionShareDialog({
  open,
  sessionTitle,
  state,
  isSharing,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  sessionTitle: string;
  state: SessionSharingState | null;
  isSharing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!state) return null;

  return (
    <ShareConfirmationDialog
      open={open}
      title={t('sessions.sharing.confirmTitle', 'Share “{{title}}” with the team?', {
        title: sessionTitle,
      })}
      description={getSessionShareDialogDescription(t, state)}
      actionLabel={t('sessions.sharing.shareAndCopy', 'Share and copy link')}
      isSharing={isSharing}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}

function getProjectShareDialogDescription(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  const machine = state.machineName ?? t('sessions.sharing.thisDevice', 'this device');
  const project = state.projectName ?? t('sessions.sharing.thisProject', 'this project');

  if (state.privateReason === 'project') {
    return t(
      'workspace.projects.confirmShareProject',
      'Teammates will be able to open and continue every conversation in {{project}}.',
      { project }
    );
  }

  return t(
    'workspace.projects.confirmShareProjectAndMachine',
    'This also shares {{machine}}, which teammates need to open and continue every conversation in {{project}}.',
    { machine, project }
  );
}

export function ProjectShareDialog({
  open,
  state,
  isSharing,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  state: SessionSharingState | null;
  isSharing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!state) return null;

  const project = state.projectName ?? t('sessions.sharing.thisProject', 'this project');

  return (
    <ShareConfirmationDialog
      open={open}
      title={t('workspace.projects.confirmShareTitle', 'Share “{{project}}” with the team?', {
        project,
      })}
      description={getProjectShareDialogDescription(t, state)}
      actionLabel={t('workspace.projects.shareProjectAction', 'Share project')}
      isSharing={isSharing}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}
