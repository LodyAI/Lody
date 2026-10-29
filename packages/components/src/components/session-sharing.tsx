import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Globe,
  Link2,
  LockKeyhole,
  Share2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  shouldShowPrivateSharingStatus,
  type SessionPublicShareStatus,
  type SessionSharingState,
} from '@/lib/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';
import { Popover } from '@lody/ui/popover';
import { Separator } from '@lody/ui/separator';
import { Tabs } from '@lody/ui/tabs';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { ease, space, text } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { shareSurface } from './sharing/surface';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

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
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <span
            tabIndex={0}
            aria-label={`${label}: ${description}`}
            className={clsx(stylex.props(styles.lockMark).className, className)}
          >
            <LockKeyhole {...stylex.props(styles.glyph)} strokeWidth={2} aria-hidden="true" />
          </span>
        }
      />
      <Tooltip.Content side="right" className="max-w-72 px-2.5 py-2">
        <div {...stylex.props(styles.tooltipTitle)}>{label}</div>
        <div {...stylex.props(styles.tooltipDescription)}>{description}</div>
      </Tooltip.Content>
    </Tooltip.Root>
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

const styles = stylex.create({
  /** The lock mark in the header: a small box the pointer can find. */
  lockMark: {
    margin: 'calc(var(--spacing) * -1)',
    boxSizing: 'content-box',
    display: 'inline-flex',
    height: themeSpace[4],
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xs,
    padding: themeSpace[1],
    color: themeColors.sidebarForegroundMuted,
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the mark showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  glyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  chevron: {
    width: themeSpace[3],
    height: themeSpace[3],
    opacity: 0.45,
  },
  /** The title in a tooltip: the name of the state. */
  tooltipTitle: { fontWeight: themeFontWeight.medium },
  /** The second line in a tooltip: what the state means. */
  tooltipDescription: {
    marginTop: themeSpace[0.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  /**
   * The status pill in the header. The line height is `normal`, not `leading-none`:
   * `items-center` centres the label's LINE BOX, and a line box shorter than
   * the font's own leaves the glyphs sitting ~1px above the icon beside them.
   *
   * The outline is a foreground tint, not `border-border`: the theme border is
   * tuned for dividers and nearly vanishes as a transparent button's only edge
   * on the dark canvas.
   */
  statusPill: {
    display: 'inline-flex',
    height: themeSpace[7],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--foreground) / 0.05)',
    },
    paddingInline: themeSpace[2],
    fontSize: '0.7rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 'normal',
    color: {
      default: 'hsl(var(--foreground) / 0.8)',
      ':hover': themeColors.foreground,
    },
    // Same as the lock mark above: the old Tailwind `focus-visible:ring-*`
    // declared a shadow that erased the base layer's inset focus ring while
    // painting nothing of its own, so the pill showed NO focus indicator.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The pill while its popover is open: it keeps the open fill. */
  statusPillOpen: {
    backgroundColor: 'hsl(var(--foreground) / 0.07)',
    color: themeColors.foreground,
  },
});

export const SESSION_HEADER_STATUS_PILL_CLASS = stylex.props(styles.statusPill).className ?? '';

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
            className={clsx(SESSION_HEADER_STATUS_PILL_CLASS, className)}
          >
            <Archive {...stylex.props(styles.glyph)} aria-hidden="true" />
            <span>{label}</span>
          </span>
        }
      />
      <Tooltip.Content side="bottom" align="end" className="max-w-72 px-2.5 py-2">
        <div {...stylex.props(styles.tooltipTitle)}>{label}</div>
        <div {...stylex.props(styles.tooltipDescription)}>{description}</div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** The watermark arrives from the corner it is cropped by, turning a little as it lands.
 * It ends on the opacity it rests at (0.07, below): a keyframe that ended on 1 would
 * flash the mark dark until the animation finished. */
const markIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translate(8px, 6px) rotate(-8deg) scale(0.92)' },
  to: { opacity: 0.07, transform: 'none' },
});

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
   * margin: the clip then lands on the popup's own edge, so the watermark is still
   * cropped by the panel and a focus ring at the content's edge is not.
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

  /** The panel's own box: the watermark is placed against it and cropped by the popup. */
  root: { position: 'relative', display: 'flex', flexDirection: 'column' },
  /** A faint mark of how far the conversation reaches. Decoration, so it takes no pointer. */
  watermark: {
    position: 'absolute',
    top: '-2px',
    right: '-6px',
    width: '52px',
    height: '52px',
    color: colors.label,
    opacity: 0.07,
    pointerEvents: 'none',
    animationName: { default: markIn, [REDUCED_MOTION]: 'none' },
    animationDuration: '550ms',
    animationTimingFunction: ease.standard,
  },
  /** Sits above the watermark; the right gutter keeps text off it. */
  head: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingInline: space[1],
    paddingRight: space[8],
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

type AccessStop = 'you' | 'team' | 'web';
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

/** The one conversation-access control in the desktop toolbar.
 *
 * A reader asks a header a single question — who can open this conversation —
 * so the panel leads with the answer, in a title and a faint watermark that name
 * how far it reaches, and makes the answer the control: a sliding strip of
 * audiences (you, team, web). The strip shows what IS; it never previews what
 * will be, because widening the audience is a decision the page confirms in its
 * own dialog, and a thumb that moved before that answer would lie. Audiences
 * that cannot be reached from here — narrowing, or a device the person does not
 * own — are disabled with the reason in the caption. Copy link and the copies
 * that leave the conversation (Markdown, image) sit below.
 *
 * Team visibility and a published link both pick the stop: published is "web",
 * otherwise a private conversation is "you" and anything else is "team". The
 * trigger's label follows the same rule, a published link being the wider
 * disclosure.
 *
 * `publicShare` is omitted when the build or workspace cannot publish, which is
 * also why a team-visible conversation can still render nothing at all. */
export function SessionAccessControl({
  state,
  onShareWithTeam,
  publicShare,
  onCopyLink,
  exportActions,
  className,
}: {
  state?: SessionSharingState | null;
  onShareWithTeam?: () => void | Promise<void>;
  publicShare?: SessionPublicShareControl;
  onCopyLink?: () => void | Promise<void>;
  exportActions?: SessionAccessAction[];
  className?: string;
}) {
  const sharingAllowed = useWorkspaceFeature('sharing');
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AccessView>('home');
  // True once the person has moved between views, so the first opening is not animated.
  const [moved, setMoved] = useState(false);
  // A publication is under way: the panel stays open until it finishes.
  const [busy, setBusy] = useState(false);

  if (!sharingAllowed) return null;
  const isPrivate = shouldShowPrivateSharingStatus(state);
  if (!isPrivate && !publicShare) {
    return null;
  }

  // `unknown` reads as not-yet-shared: the label upgrades in place once the
  // control plane answers, rather than a badge appearing and disappearing.
  const isShared = publicShare?.status === 'shared';
  const sharedLabel = t('sharing.header.shared', 'Shared');
  const sharedDescription = t(
    'sharing.header.sharedDescription',
    'Anyone with the link can read a published copy of this conversation.'
  );
  const shareLabel = t('sharing.manager.title', 'Share');
  const hasTeamScope = state?.visibility === 'private' || state?.visibility === 'team';
  // Without a sharing state (a solo workspace) nobody else can open it, so "only
  // you" is true; while the state is still being resolved it is not yet known, so
  // that stop is withheld instead of claiming privacy the control plane has not
  // confirmed.
  const canSayOnlyYou = !state || hasTeamScope;

  const current: AccessStop = isShared ? 'web' : state?.visibility === 'team' ? 'team' : 'you';
  const privateTitle = t('sessions.sharing.privateToYou', 'Private to you');
  const scopeTitle = !state
    ? privateTitle
    : isPrivate
      ? privateTitle
      : state.visibility === 'team'
        ? t('sessions.sharing.sharedWithTeam', 'Shared with team')
        : getSessionSharingLabel(t, state);
  const scopeDescription = state
    ? getSessionSharingDescription(t, state)
    : t(
        'sharing.header.shareDescription',
        'Publish a read-only copy of this conversation as a link.'
      );
  const ariaLabel = isShared
    ? `${sharedLabel}: ${sharedDescription}`
    : isPrivate
      ? `${scopeTitle}: ${scopeDescription}`
      : shareLabel;

  const notRegistered = isPrivate && state.privateReason === 'machine-not-registered';
  const teamReachable = isPrivate && !!onShareWithTeam && !notRegistered && state.canManage;
  const teamBlocked = isPrivate
    ? !state.canManage
      ? t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share')
      : notRegistered
        ? t('sessions.sharing.registerDeviceToShare', 'Register this device before sharing')
        : null
    : null;
  const teamActionLabel = isPrivate ? getSessionShareActionLabel(t, state) : undefined;

  const heading = isShared
    ? t('sharing.header.anyoneWithLink', 'Anyone with the link')
    : scopeTitle;
  const caption = isShared ? sharedDescription : (teamBlocked ?? scopeDescription);
  const WatermarkIcon = { you: LockKeyhole, team: Users, web: Globe }[current];

  const stops: Array<{ id: AccessStop; label: string; icon: LucideIcon; disabled: boolean }> = [
    ...(canSayOnlyYou
      ? [
          {
            id: 'you' as const,
            label: t('sharing.header.audienceYou', 'Only you'),
            icon: LockKeyhole,
            // Narrowing is not offered from here; the current stop is never disabled.
            disabled: current !== 'you',
          },
        ]
      : []),
    ...(hasTeamScope
      ? [
          {
            id: 'team' as const,
            label: t('sharing.header.audienceTeam', 'Team'),
            icon: Users,
            disabled: current !== 'team' && !teamReachable,
          },
        ]
      : []),
    ...(publicShare
      ? [
          {
            id: 'web' as const,
            label: t('sharing.header.audienceWeb', 'Web'),
            icon: Globe,
            disabled: false,
          },
        ]
      : []),
  ];

  const act = (run: () => void | Promise<void>) => {
    setOpen(false);
    void run();
  };

  const goTo = (next: AccessView) => {
    setMoved(true);
    setView(next);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return;
    setOpen(next);
    if (!next) {
      setView('home');
      setMoved(false);
    }
  };

  const choose = (next: AccessStop) => {
    if (next === current) return;
    if (next === 'team') act(() => onShareWithTeam?.());
    else if (next === 'web') goTo('publish');
  };

  const rows: SessionAccessAction[] = [
    ...(isShared && publicShare
      ? [
          {
            id: 'manage-link',
            label: t('sharing.header.manageLink', 'Manage link'),
            icon: Globe,
            keepOpen: true,
            onSelect: () => goTo('publish'),
          },
        ]
      : []),
    ...(onCopyLink
      ? [
          {
            id: 'copy-url',
            label: t('sessions.copyUrl', 'Copy URL'),
            icon: Link2,
            onSelect: onCopyLink,
          },
        ]
      : []),
    ...(exportActions ?? []),
  ];

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className={clsx(
              SESSION_HEADER_STATUS_PILL_CLASS,
              open && stylex.props(styles.statusPillOpen).className,
              className
            )}
          >
            {isPrivate && !isShared ? (
              <LockKeyhole {...stylex.props(styles.glyph)} aria-hidden="true" />
            ) : (
              <Share2 {...stylex.props(styles.glyph)} aria-hidden="true" />
            )}
            <span>{isShared ? sharedLabel : shareLabel}</span>
            <ChevronDown {...stylex.props(styles.chevron)} aria-hidden="true" />
          </button>
        }
      />
      <Popover.Content align="end" sideOffset={6} gap="none" width="18.5rem" className="p-2">
        <Popover.Title {...stylex.props(shareSurface.visuallyHidden)}>
          {t('sessions.sharing.panelTitle', 'Share this conversation')}
        </Popover.Title>
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
                    aria-label={t('common.back', 'Back')}
                    onClick={() => goTo('home')}
                  >
                    <ChevronLeft {...stylex.props(shareSurface.glyph)} aria-hidden="true" />
                  </Button>
                  <p {...stylex.props(accessPanel.title)}>
                    {t('sharing.header.publishTitle', 'Publish to the web')}
                  </p>
                </div>
                {publicShare.renderEditor({
                  onClose: () => goTo('home'),
                  onBusyChange: setBusy,
                })}
              </>
            ) : (
              <div {...stylex.props(accessPanel.root)}>
                <WatermarkIcon
                  key={current}
                  {...stylex.props(accessPanel.watermark)}
                  aria-hidden="true"
                />
                <div {...stylex.props(accessPanel.head)}>
                  <p {...stylex.props(accessPanel.title)}>{heading}</p>
                  <p {...stylex.props(accessPanel.description)}>{caption}</p>
                </div>
                {stops.length > 1 ? (
                  <div {...stylex.props(accessPanel.stops)}>
                    <Tabs.Root value={current} onValueChange={(next) => choose(next as AccessStop)}>
                      <Tabs.List
                        size="small"
                        stretch
                        aria-label={t('sharing.header.whoCanOpen', 'Who can open this')}
                      >
                        {stops.map((stop) => (
                          <Tabs.Tab
                            key={stop.id}
                            value={stop.id}
                            disabled={stop.disabled}
                            title={
                              stop.id === 'team' && teamReachable ? teamActionLabel : undefined
                            }
                          >
                            <stop.icon
                              {...stylex.props(shareSurface.glyphSmall)}
                              aria-hidden="true"
                            />
                            {stop.label}
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.Root>
                  </div>
                ) : null}
                {rows.length > 0 ? (
                  <div {...stylex.props(accessPanel.rule)}>
                    <Separator />
                  </div>
                ) : null}
                {rows.length > 0 ? (
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
                ) : null}
              </div>
            )}
          </div>
        </ElasticHeight>
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
            {isSharing ? <Spinner diameter="calc(var(--spacing) * 4)" className="mr-1.5" /> : null}
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
