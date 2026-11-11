import { Menu } from '@lody/ui/menu';
import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Globe,
  Eye,
  Link2,
  LockKeyhole,
  Users,
  Settings,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  shouldShowPrivateSharingStatus,
  type SessionPublicShareStatus,
  type SessionSharingState,
} from '@/lib/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';
import { Popover } from '@lody/ui/popover';
import { Separator } from '@lody/ui/separator';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { ease, space, text } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { toast } from '@/lib/toast';
import { Tabs } from '@lody/ui/tabs';
import { shareSurface } from './sharing/surface';
import { UserAvatar } from './user-avatar';

export type SessionSharingTranslator = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>
) => string;

export function getSessionSharingLabel(
  t: SessionSharingTranslator,
  state: SessionSharingState
): string {
  if (state.access === 'read' && state.visibility === 'team')
    return t('sessions.access.read', 'Team read-only');
  if (state.visibility === 'team') return t('sessions.access.edit', 'Team can edit');
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
  _state: SessionSharingState
): string {
  return t(
    'sessions.access.confirmRead',
    'Teammates can read this conversation and reference it in their own sessions.'
  );
}

export function SessionSharingIndicator({
  state,
  className,
}: {
  state: SessionSharingState;
  className?: string;
}) {
  const { t } = useTranslation();

  if (!shouldShowPrivateSharingStatus(state) && state.access !== 'read') {
    return null;
  }

  const label = getSessionSharingLabel(t, state);
  const description = getSessionSharingDescription(t, state);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <span
            tabIndex={0}
            aria-label={`${label}: ${description}`}
            className={cn(
              '-m-1 box-content inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs p-1',
              'text-sidebar-foreground-muted outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50',
              className
            )}
          >
            {state.access === 'read' ? (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <LockKeyhole className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            )}
          </span>
        }
      />
      <Tooltip.Content side="right" className="max-w-72 px-2.5 py-2">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/** Shared chrome for status pills in the session conversation header (Private, Archived).
 *
 * The line height is `normal`, not `leading-none`. `items-center` centres the
 * label's LINE BOX, and a line box shorter than the font's own leaves the
 * glyphs sitting ~1px above the icon beside them; at `normal` the half-leading
 * is zero and the ink lands where the font intends, for whatever interface
 * font is selected.
 *
 * The outline is a foreground tint, not `border-border`: the theme border is
 * tuned for dividers and nearly vanishes as a transparent button's only edge
 * on the dark canvas. */
export const SESSION_HEADER_STATUS_PILL_CLASS =
  'inline-flex h-7 shrink-0 select-none items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 ' +
  'text-[0.7rem] font-medium leading-[normal] text-muted-foreground transition-colors ' +
  'hover:bg-foreground/[0.05] hover:text-foreground ' +
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
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <span
            tabIndex={0}
            aria-label={`${label}: ${description}`}
            className={cn(SESSION_HEADER_STATUS_PILL_CLASS, className)}
          >
            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{label}</span>
          </span>
        }
      />
      <Tooltip.Content side="bottom" align="end" className="max-w-72 px-2.5 py-2">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** The next view arrives from the side it lives on, and the way back reverses it. */
const enterFromRight = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(14px)' },
  to: { opacity: 1, transform: 'none' },
});
const enterFromLeft = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(-14px)' },
  to: { opacity: 1, transform: 'none' },
});

const accessPanel = stylex.create({
  /**
   * Height follows the content with a small overshoot, so the panel settles into
   * each view instead of snapping. The wrapper's inset is given back by a negative
   * margin: the clip then lands on the popup's own edge, so a focus ring at the
   * content's edge is not cropped.
   */
  elastic: {
    margin: `calc(-1 * ${space[2]})`,
    padding: space[2],
    // The measured height is the content's, so the inset must sit outside it: under
    // the app's global `border-box` the same number would swallow the padding and
    // clip the last row.
    boxSizing: 'content-box',
    overflow: 'hidden',
    transitionProperty: { default: 'height', [REDUCED_MOTION]: 'none' },
    transitionDuration: '460ms',
    transitionTimingFunction: 'cubic-bezier(0.3, 1.2, 0.5, 1)',
  },
  enterRight: {
    animationName: { default: enterFromRight, [REDUCED_MOTION]: 'none' },
    animationDuration: '260ms',
    animationTimingFunction: ease.standard,
  },
  enterLeft: {
    animationName: { default: enterFromLeft, [REDUCED_MOTION]: 'none' },
    animationDuration: '260ms',
    animationTimingFunction: ease.standard,
  },
  /** The publish view's header: the way back, and what this view is. */
  publishHead: { display: 'flex', alignItems: 'center', gap: space[1], paddingBottom: space[3] },

  root: { position: 'relative', display: 'flex', flexDirection: 'column' },
  head: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingInline: space[1],
  },
  title: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  description: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  ownerReason: { paddingInline: space[1], marginTop: space[2] },
  stops: { position: 'relative', marginTop: space[2] },
  /** The one rule: who can open it above, what to do with it below. */
  rule: { position: 'relative', marginBlock: space[2], marginInline: space[1] },
  /** Plain rows in the density of the app's menus: ghost, left-aligned, one per action. */
  actions: { position: 'relative', display: 'flex', flexDirection: 'column' },
});

/** Static publication offered by the header control, when this build has a cloud. */
export type SessionPublicShareControl = {
  status: SessionPublicShareStatus;
  /**
   * The publication editor, drawn inside the panel's publish view. It is called
   * only while that view is open, so a closed header loads nothing. The editor
   * reports `onBusyChange(true)` for as long as a publication is under way, and the
   * panel will not be dismissed meanwhile; `onClose` returns to the panel's front.
   */
  renderEditor: (context: SessionShareEditorContext) => ReactNode;
};

export type SessionShareEditorContext = {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
};

/** One row of the access panel: Manage link, Copy URL, or a copy that leaves this conversation. */
export type SessionAccessAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  /** Why it is unavailable. */
  title?: string;
  /** Leaves the panel open: the action carries on inside it. */
  keepOpen?: boolean;
};

type AccessView = 'home' | 'publish';

/** Lets the panel's height follow whatever view or step is showing. */
function ElasticHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, []);
  return (
    <div {...stylex.props(accessPanel.elastic)} style={{ height }}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** Machine-owner team access and independent public-link publication share one panel. */
function SessionAccessMembers({
  state,
  busy,
  setBusy,
}: {
  state: SessionSharingState;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const directory = new Map(
    (state.availableMembers ?? []).map((member) => [member.userId, member])
  );
  const memberName = (userId: string) =>
    directory.get(userId)?.name?.trim() ||
    t(state.membersLoading ? 'common.loading' : 'sessions.access.unknownMember');
  const ids = [
    ...new Set([...(state.ownerUserId ? [state.ownerUserId] : []), ...(state.memberUserIds ?? [])]),
  ];
  const change = async (userId: string, shared: boolean) => {
    if (!state.canManage || !state.setMemberReadAccess || busy || userId === state.ownerUserId)
      return;
    setBusy(true);
    try {
      await state.setMemberReadAccess(userId, shared);
    } catch {
      toast.error(t('sessions.access.failed'));
    } finally {
      setBusy(false);
    }
  };
  const available = [...directory.values()].filter((member) => !ids.includes(member.userId));
  return (
    <section {...stylex.props(memberStyles.section)}>
      <Separator />
      <p {...stylex.props(memberStyles.heading)}>{t('sessions.access.members')}</p>
      {state.membersError && (
        <div role="status" {...stylex.props(memberStyles.notice)}>
          <span>{t('sessions.access.directoryFailed')}</span>
          {state.retryMembers && (
            <Button variant="ghost" size="small" onClick={state.retryMembers}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}
      {ids.map((userId) => (
        <div key={userId} {...stylex.props(memberStyles.row)}>
          <UserAvatar user={{ id: userId, ...directory.get(userId) }} size="small" />
          <span
            {...stylex.props(memberStyles.name)}
            aria-busy={!!state.membersLoading && !directory.has(userId)}
          >
            {memberName(userId)}
          </span>
          <span {...stylex.props(memberStyles.role)}>
            {t(
              userId === state.ownerUserId ? 'sessions.access.owner' : 'sessions.access.memberRead'
            )}
          </span>
          {state.canManage &&
            userId === state.ownerUserId && (
              // Holds the remove button's width so every role label lines up.
              <span aria-hidden="true" {...stylex.props(memberStyles.placeholder)}>
                <Button variant="ghost" icon size="small" disabled tabIndex={-1}>
                  <X {...stylex.props(shareSurface.glyphSmall)} />
                </Button>
              </span>
            )}
          {state.canManage && userId !== state.ownerUserId && (
            <Button
              variant="ghost"
              icon
              size="small"
              disabled={busy}
              aria-label={t('sessions.access.removeMember', {
                name: memberName(userId),
              })}
              onClick={() => {
                void change(userId, false);
              }}
            >
              <X {...stylex.props(shareSurface.glyphSmall)} aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      {state.canManage && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                size="small"
                className="justify-start"
                disabled={busy || !state.setMemberReadAccess || !available.length}
              >
                <UserPlus {...stylex.props(shareSurface.glyphSmall)} aria-hidden="true" />
                {t('sessions.access.addMember')}
              </Button>
            }
          />
          <Menu.Content>
            {available.map((member) => (
              <Menu.Item
                key={member.userId}
                onClick={() => {
                  void change(member.userId, true);
                }}
              >
                {member.name}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Root>
      )}
    </section>
  );
}
const memberStyles = stylex.create({
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space[1], marginTop: space[2] },
  heading: {
    margin: 0,
    marginTop: space[2],
    paddingInline: space[1],
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    minHeight: space[8],
    paddingInline: space[1],
  },
  placeholder: { visibility: 'hidden', pointerEvents: 'none' },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  role: { fontSize: text.captionSize, color: colors.secondaryLabel },
});

export function SessionAccessControl({
  state,
  onShareWithTeam,
  publicShare,
  onCopyLink,
  exportActions,
  className,
  presentation = 'popover',
  onClose,
}: {
  state?: SessionSharingState | null;
  onShareWithTeam?: () => void | Promise<void>;
  publicShare?: SessionPublicShareControl;
  onCopyLink?: () => void | Promise<void>;
  exportActions?: SessionAccessAction[];
  className?: string;
  presentation?: 'popover' | 'dialog';
  onClose?: () => void;
}) {
  const sharingAllowed = useWorkspaceFeature('sharing');
  const { t } = useTranslation();
  const [open, setOpen] = useState(presentation === 'dialog');
  const [view, setView] = useState<AccessView>('home');
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!state && (!sharingAllowed || !publicShare)) return null;
  const level =
    state?.visibility === 'private'
      ? 'private'
      : (state?.access ?? (state?.visibility === 'team' ? 'edit' : 'private'));
  const individualCount = new Set(state?.memberUserIds ?? []).size;
  const label =
    level === 'private' && individualCount > 0
      ? t('sessions.access.sharedMembers', { count: individualCount })
      : state?.visibility === 'unknown'
        ? t('sessions.sharing.checking')
        : t(`sessions.access.${level}`);
  const Icon =
    level === 'edit' || individualCount > 0 ? Users : level === 'read' ? Eye : LockKeyhole;
  const setLevel = async (next: 'read' | null) => {
    if (!state?.canManage || level === 'edit' || busy) return;
    if (!state.setReadAccess) {
      if (next === 'read') await onShareWithTeam?.();
      return;
    }
    setBusy(true);
    try {
      await state.setReadAccess(next);
    } catch {
      toast.error(t('sessions.access.failed'));
    } finally {
      setBusy(false);
    }
  };
  const goTo = (next: AccessView) => {
    setMoved(true);
    setView(next);
  };
  const act = (run: () => void | Promise<void>) => {
    setOpen(false);
    setView('home');
    setMoved(false);
    void run();
  };
  const caption =
    state?.visibility === 'unknown'
      ? t('sessions.sharing.checkingDescription')
      : level === 'edit'
        ? t('sessions.access.machineShared')
        : level === 'read'
          ? t('sessions.access.confirmRead')
          : t('sessions.sharing.privateDescription');
  const rows: SessionAccessAction[] = [
    ...(publicShare
      ? [
          {
            id: 'public-link',
            label: t(
              publicShare.status === 'shared'
                ? 'sharing.header.manageLink'
                : 'sharing.header.publishTitle'
            ),
            icon: Globe,
            onSelect: () => goTo('publish'),
            keepOpen: true,
          },
        ]
      : []),
    ...(onCopyLink
      ? [{ id: 'copy-url', label: t('sessions.copyUrl'), icon: Link2, onSelect: onCopyLink }]
      : []),
    ...(exportActions ?? []),
  ];
  const content = (
    <ElasticHeight>
      <div
        key={view}
        {...stylex.props(
          moved && (view === 'publish' ? accessPanel.enterRight : accessPanel.enterLeft)
        )}
      >
        {view === 'publish' && publicShare ? (
          <>
            <div {...stylex.props(accessPanel.publishHead)}>
              <Button
                variant="ghost"
                size="small"
                icon
                disabled={busy}
                aria-label={t('common.back')}
                onClick={() => goTo('home')}
              >
                <ChevronLeft />
              </Button>
              <p {...stylex.props(accessPanel.title)}>{t('sharing.header.publishTitle')}</p>
            </div>
            {publicShare.renderEditor({ onClose: () => goTo('home'), onBusyChange: setBusy })}
          </>
        ) : (
          <div {...stylex.props(accessPanel.root)}>
            <div {...stylex.props(accessPanel.head)}>
              <p {...stylex.props(accessPanel.title)}>{t('sessions.access.teamAccess')}</p>
              <p {...stylex.props(accessPanel.description)}>{caption}</p>
              {level === 'edit' && state?.openMachineSettings && (
                <Button
                  variant="ghost"
                  size="small"
                  className="justify-start"
                  onClick={() => act(() => state.openMachineSettings?.())}
                >
                  <Settings {...stylex.props(shareSurface.glyphSmall)} aria-hidden="true" />
                  {t('sessions.access.machineSettings')}
                </Button>
              )}
            </div>
            {state && level !== 'edit' && (
              <>
                <div {...stylex.props(accessPanel.stops)}>
                  <Tabs.Root
                    value={level}
                    onValueChange={(next) => {
                      void setLevel(next === 'read' ? 'read' : null);
                    }}
                  >
                    <Tabs.List size="small" stretch aria-label={t('sessions.access.teamAccess')}>
                      <Tabs.Tab
                        value="private"
                        disabled={!state.canManage || busy || state.visibility === 'unknown'}
                      >
                        <LockKeyhole
                          {...stylex.props(shareSurface.glyphSmall)}
                          aria-hidden="true"
                        />
                        {t('sessions.access.private')}
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="read"
                        disabled={!state.canManage || busy || state.visibility === 'unknown'}
                      >
                        <Eye {...stylex.props(shareSurface.glyphSmall)} aria-hidden="true" />
                        {t('sessions.access.read')}
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.Root>
                </div>
                {!state.canManage && (
                  <p {...stylex.props(accessPanel.description, accessPanel.ownerReason)}>
                    {t('sessions.sharing.onlyOwnerCanShare')}
                  </p>
                )}
              </>
            )}
            {state &&
              (state.ownerUserId || state.memberUserIds?.length || state.setMemberReadAccess) && (
                <SessionAccessMembers state={state} busy={busy} setBusy={setBusy} />
              )}
            {rows.length > 0 && (
              <>
                <div {...stylex.props(accessPanel.rule)}>
                  <Separator />
                </div>
                <div {...stylex.props(accessPanel.actions)}>
                  {rows.map((row) => (
                    <Button
                      key={row.id}
                      variant="ghost"
                      size="small"
                      className="justify-start"
                      disabled={row.disabled}
                      title={row.title}
                      onClick={() => (row.keepOpen ? void row.onSelect() : act(row.onSelect))}
                    >
                      <row.icon {...stylex.props(shareSurface.glyphSmall)} aria-hidden="true" />
                      {row.label}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </ElasticHeight>
  );
  if (presentation === 'dialog')
    return (
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            if (!next) onClose?.();
          }
        }}
      >
        <Dialog.Content>
          <Dialog.Title>{t('sessions.sharing.panelTitle')}</Dialog.Title>
          {content}
        </Dialog.Content>
      </Dialog.Root>
    );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          if (!next) {
            setView('home');
            setMoved(false);
          }
        }
      }}
    >
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              SESSION_HEADER_STATUS_PILL_CLASS,
              'data-[popup-open]:bg-foreground/[0.07] data-[popup-open]:text-foreground',
              className
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{label}</span>
            <ChevronDown className="h-3 w-3 opacity-45" aria-hidden="true" />
          </button>
        }
      />
      <Popover.Content align="end" sideOffset={6} className="w-[18.5rem] gap-0 p-2">
        <Popover.Title {...stylex.props(shareSurface.visuallyHidden)}>
          {t('sessions.sharing.panelTitle')}
        </Popover.Title>
        {content}
      </Popover.Content>
    </Popover.Root>
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
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title className="line-clamp-2 break-words">{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel disabled={isSharing}>
            {t('common.cancel', 'Cancel')}
          </AlertDialog.Cancel>
          <Button
            disabled={isSharing}
            onClick={() => {
              onConfirm();
            }}
          >
            {isSharing ? <Spinner className="mr-1.5 h-4 w-4" /> : null}
            {actionLabel}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
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
