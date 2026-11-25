import { useMemo, useRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  MessageCircle,
  Moon,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Separator } from '@lody/ui/separator';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { formatLocalizedRelativeTime } from '@/lib/format-relative-time';
import {
  describeSessionContinuation,
  type SessionContinuationDetail,
  type SessionContinuationNextCheck,
  type SessionContinuationTone,
  type SessionContinuationView,
} from './session-continuation';

export type SessionContinuationNoteProps = {
  view: SessionContinuationView;
  /** Stable product clock; pass a shared `useStableNow()` value in production. */
  now: number;
  /** The one-line phone form: title + countdown, detail stays in the popover. */
  compact?: boolean;
  /** The last known state could not be refreshed. */
  statusUnavailable?: boolean;
  onCancel: (id: string) => void;
  onResume?: (id: string) => void;
  onAskAgent?: (view: SessionContinuationView) => void;
  onOpenTweaks?: () => void;
};

const DETAIL_COPY: Record<SessionContinuationDetail, { key: string; fallback: string }> = {
  waiting: { key: 'sessions.continuation.detail.waiting', fallback: '等待条件满足' },
  waitingOffline: {
    key: 'sessions.continuation.detail.waitingOffline',
    fallback: '机器离线，暂停检查',
  },
  queued: { key: 'sessions.continuation.detail.queued', fallback: '条件已满足，等待执行' },
  running: { key: 'sessions.continuation.detail.running', fallback: '条件已满足，正在执行' },
  blockedStopped: {
    key: 'sessions.continuation.detail.blockedStopped',
    fallback: '条件已满足，会话已停止',
  },
  blockedPermission: {
    key: 'sessions.continuation.detail.blockedPermission',
    fallback: '需要确认权限',
  },
  blockedOffline: {
    key: 'sessions.continuation.detail.blockedOffline',
    fallback: '机器离线，暂时无法继续',
  },
  blockedUnavailable: {
    key: 'sessions.continuation.detail.blockedUnavailable',
    fallback: '暂时无法继续',
  },
  deliveryUnknown: {
    key: 'sessions.continuation.detail.deliveryUnknown',
    fallback: '正在确认是否送达',
  },
  failed: { key: 'sessions.continuation.detail.failed', fallback: '自动化执行失败' },
  sourceUnknown: {
    key: 'sessions.continuation.detail.sourceUnknown',
    fallback: '无法确认等待状态',
  },
};

const styles = stylex.create({
  popoverWidth: { width: '288px' },
  note: {
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    // The note is a chip, not a band: without an explicit fit-content width a
    // block parent stretches it to the whole conversation column.
    width: 'fit-content',
    gap: space[1.5],
    maxWidth: '100%',
    minHeight: 26,
    paddingBlock: 4,
    paddingInline: 8,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, ${colors.label}, transparent 94%)`,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  noteActive: {
    backgroundColor: `color-mix(in oklab, ${colors.accent}, transparent 92%)`,
  },
  noteAttention: {
    backgroundColor: `color-mix(in oklab, ${colors.warning}, transparent 90%)`,
  },
  noteCompact: {
    width: '100%',
    justifyContent: 'flex-start',
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `0 0 0 2px ${colors.accent}`,
    },
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 13,
    height: 13,
    flexShrink: 0,
    color: colors.accent,
  },
  iconActive: { color: colors.accent },
  iconAttention: { color: colors.warning },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    fontWeight: 600,
    maxWidth: 280,
  },
  detail: {
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  time: {
    whiteSpace: 'nowrap',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  separator: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },
  divider: {
    flexShrink: 0,
    width: 1,
    height: 12,
    marginInline: space[1],
    backgroundColor: colors.separator,
  },
  inlineAction: {
    flexShrink: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    color: colors.tertiaryLabel,
    fontFamily: 'inherit',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `0 0 0 2px ${colors.accent}`,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'default',
    },
  },
  nudge: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    paddingBlock: 7,
    paddingInline: 10,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, ${colors.warning}, transparent 90%)`,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  nudgeCopy: {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  nudgeTitle: {
    color: colors.label,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nudgeReason: {
    color: colors.tertiaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nudgeActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    flexShrink: 0,
  },
  popoverBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
  },
  popoverHeading: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr)',
    columnGap: space[2],
    rowGap: space[1],
    alignItems: 'start',
    minWidth: 0,
  },
  popoverIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    flexShrink: 0,
    color: colors.accent,
  },
  popoverIconActive: { color: colors.accent },
  popoverIconAttention: { color: colors.warning },
  popoverDescription: { gridColumn: '2', minWidth: 0 },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: space[2],
    minHeight: 24,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  rowIcon: {
    width: 16,
    height: 16,
    flexShrink: 0,
    color: colors.tertiaryLabel,
  },
  rowLabel: { minWidth: 0 },
  rowValue: {
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    flexWrap: 'wrap',
    marginInlineStart: space[4],
    marginInlineEnd: `calc(-1 * ${space[2]})`,
  },
  footerSpacer: { flex: 1 },
  tweakRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1.5],
  },
  tweakIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    flexShrink: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
  },
  tweakCopy: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  tweakTitle: {
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
  },
  tweakDescription: {
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    marginTop: 1,
  },
  tweakUnsupported: {
    color: colors.warning,
  },
});

function iconFor(
  detail: SessionContinuationDetail,
  tone: 'calm' | 'active' | 'attention'
): LucideIcon {
  if (detail === 'deliveryUnknown') return Clock;
  if (tone === 'attention') return AlertTriangle;
  if (tone === 'active') return Sun;
  return Moon;
}

function nextCheckLabel(
  nextCheck: SessionContinuationNextCheck | undefined,
  t: (key: string, fallback: string) => string,
  locale: string
): string | undefined {
  if (!nextCheck) return undefined;
  if (nextCheck.kind === 'soon') return t('sessions.continuation.soon', '马上');
  if (nextCheck.kind === 'absolute')
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(nextCheck.at);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(
    nextCheck.count,
    nextCheck.unit
  );
}

function absoluteLabel(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

export type SessionAutomationNoteRowProps = {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
};

/** One metadata row inside an automation note popover. */
export function SessionAutomationNoteRow({
  icon: Icon,
  label,
  value,
}: SessionAutomationNoteRowProps) {
  return (
    <div {...stylex.props(styles.row)}>
      <Icon {...stylex.props(styles.rowIcon)} />
      <span {...stylex.props(styles.rowLabel)}>{label}</span>
      <span {...stylex.props(styles.rowValue)}>{value}</span>
    </div>
  );
}

export type SessionAutomationNoteNudgeProps = {
  icon?: LucideIcon;
  title: string;
  reason: string;
  actions: ReactNode;
  dataAttributes?: Record<string, string | undefined>;
};

/** Full-width attention banner shared by automation notes when the Session is stopped. */
export function SessionAutomationNoteNudge({
  icon: Icon = Sun,
  title,
  reason,
  actions,
  dataAttributes,
}: SessionAutomationNoteNudgeProps) {
  return (
    <div
      {...dataAttributes}
      {...stylex.props(styles.nudge)}
      role="status"
      aria-live="polite"
    >
      <span {...stylex.props(styles.icon, styles.iconAttention)} aria-hidden="true">
        <Icon size={13} strokeWidth={2} />
      </span>
      <div {...stylex.props(styles.nudgeCopy)}>
        <span {...stylex.props(styles.nudgeTitle)}>{title}</span>
        <span {...stylex.props(styles.nudgeReason)}>{reason}</span>
      </div>
      <div {...stylex.props(styles.nudgeActions)}>{actions}</div>
    </div>
  );
}

export type SessionAutomationNoteShellProps = {
  tone: SessionContinuationTone;
  icon: LucideIcon;
  title: string;
  detail: string;
  time?: string;
  compact?: boolean;
  showDetailInCompact?: boolean;
  inlineAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  } | null;
  popoverDescription?: string;
  popoverBody?: ReactNode;
  popoverFooter?: ReactNode;
  dataAttributes?: Record<string, string | undefined>;
  triggerDataAttributes?: Record<string, string | undefined>;
  role?: string;
};

/**
 * Shared one-line automation chip + inspection popover used by both Session
 * continuations and Auto delivery so every automation status speaks one visual language.
 */
export function SessionAutomationNoteShell({
  tone,
  icon: Icon,
  title,
  detail,
  time,
  compact = false,
  showDetailInCompact = false,
  inlineAction,
  popoverDescription,
  popoverBody,
  popoverFooter,
  dataAttributes,
  triggerDataAttributes,
  role,
}: SessionAutomationNoteShellProps) {
  const noteRef = useRef<HTMLDivElement>(null);
  const toneStyle =
    tone === 'attention' ? styles.noteAttention : tone === 'active' ? styles.noteActive : undefined;
  const iconToneStyle =
    tone === 'attention' ? styles.iconAttention : tone === 'active' ? styles.iconActive : undefined;
  const popoverIconToneStyle =
    tone === 'attention'
      ? styles.popoverIconAttention
      : tone === 'active'
        ? styles.popoverIconActive
        : undefined;

  const trigger = (
    <button
      type="button"
      {...triggerDataAttributes}
      {...stylex.props(styles.trigger)}
      aria-label={`${title} · ${detail}${time ? ` · ${time}` : ''}`}
    >
      <span {...stylex.props(styles.icon, iconToneStyle)} aria-hidden="true">
        <Icon size={13} strokeWidth={2} />
      </span>
      <span {...stylex.props(styles.title)}>{title}</span>
      {!compact || showDetailInCompact ? (
        <>
          <span {...stylex.props(styles.separator)} aria-hidden="true">
            ·
          </span>
          <span {...stylex.props(styles.detail)}>{detail}</span>
        </>
      ) : null}
      {time ? (
        <>
          <span {...stylex.props(styles.separator)} aria-hidden="true">
            ·
          </span>
          <span {...stylex.props(styles.time)}>{time}</span>
        </>
      ) : null}
    </button>
  );

  return (
    <div
      ref={noteRef}
      {...dataAttributes}
      {...stylex.props(styles.note, toneStyle, compact && styles.noteCompact)}
      role={role}
    >
      <Popover.Root>
        <Popover.Trigger render={trigger} />
        <Popover.Content
          anchor={noteRef}
          side="top"
          align="start"
          sideOffset={8}
          xstyle={styles.popoverWidth}
        >
          <div {...stylex.props(styles.popoverBody)}>
            <div {...stylex.props(styles.popoverHeading)}>
              <span {...stylex.props(styles.popoverIcon, popoverIconToneStyle)} aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <Popover.Title>{title}</Popover.Title>
              <Popover.Description {...stylex.props(styles.popoverDescription)}>
                {popoverDescription ?? detail}
              </Popover.Description>
            </div>

            {popoverBody}

            {popoverFooter ? (
              <>
                <Separator />
                <div {...stylex.props(styles.footer)}>{popoverFooter}</div>
              </>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Root>

      {inlineAction && !compact ? (
        <>
          <span {...stylex.props(styles.divider)} aria-hidden="true" />
          <button
            type="button"
            disabled={inlineAction.disabled}
            {...stylex.props(styles.inlineAction)}
            onClick={inlineAction.onClick}
          >
            {inlineAction.label}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Spacer aligning trailing actions in a `SessionAutomationNoteShell` popover footer. */
export function SessionAutomationNoteFooterSpacer() {
  return <span {...stylex.props(styles.footerSpacer)} />;
}

export type SessionAutomationTweakRowProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  unsupported?: boolean;
  onCheckedChange: (checked: boolean) => void;
  dataAttributes?: Record<string, string | undefined>;
};

/** Shared automation switch row (icon well + title/description + Switch). */
export function SessionAutomationTweakRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  unsupported,
  onCheckedChange,
  dataAttributes,
}: SessionAutomationTweakRowProps) {
  return (
    <div {...dataAttributes} {...stylex.props(styles.tweakRow)}>
      <span {...stylex.props(styles.tweakIcon)} aria-hidden="true">
        <Icon size={14} strokeWidth={1.8} />
      </span>
      <span {...stylex.props(styles.tweakCopy)}>
        <span {...stylex.props(styles.tweakTitle)}>{title}</span>
        {description ? (
          <span {...stylex.props(styles.tweakDescription, unsupported && styles.tweakUnsupported)}>
            {description}
          </span>
        ) : null}
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={title}
      />
    </div>
  );
}

/**
 * The one-line promise the Agent leaves in a conversation. It is deliberately
 * not a panel: a moon, the Agent's own sentence, a countdown, and a way out.
 * The popover is the only place with inspection detail.
 */
export function SessionContinuationNote({
  view,
  now,
  compact = false,
  statusUnavailable = false,
  onCancel,
  onResume,
  onAskAgent,
  onOpenTweaks,
}: SessionContinuationNoteProps) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.language);
  const descriptor = useMemo(() => describeSessionContinuation(view, now), [view, now]);

  if (!descriptor.visible) return null;

  const title = descriptor.title ?? t('sessions.continuation.fallbackTitle', '会话自动继续');
  const detail = statusUnavailable
    ? t('sessions.continuation.statusUnavailable', 'Status temporarily unavailable. Retrying…')
    : t(DETAIL_COPY[descriptor.detail].key, DETAIL_COPY[descriptor.detail].fallback);
  const nextCheck = nextCheckLabel(descriptor.nextCheck, t, locale);
  const tone = descriptor.tone;
  const Icon = iconFor(descriptor.detail, tone);

  if (descriptor.detail === 'blockedStopped') {
    return (
      <SessionAutomationNoteNudge
        title={t('sessions.continuation.stopped.title', '条件已满足，会话已停止。')}
        reason={title}
        dataAttributes={{
          'data-session-continuation-note': 'blocked',
          'data-session-continuation-id': view.id,
        }}
        actions={
          <>
            {descriptor.actions.resume && onResume ? (
              <Button type="button" variant="primary" size="mini" onClick={() => onResume(view.id)}>
                {t('sessions.continuation.resume', '恢复会话')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="mini" onClick={() => onCancel(view.id)}>
              {t('sessions.continuation.cancel', '取消等待')}
            </Button>
          </>
        }
      />
    );
  }

  const canAskAgent = descriptor.actions.askAgent && Boolean(onAskAgent);
  const action =
    descriptor.actions.resume && onResume
      ? ('resume' as const)
      : canAskAgent
        ? ('askAgent' as const)
        : descriptor.actions.cancel
          ? ('cancel' as const)
          : null;

  const inlineAction = action
    ? {
        label:
          action === 'resume'
            ? t('sessions.continuation.resume', '恢复会话')
            : action === 'askAgent'
              ? t('sessions.continuation.askAgentShort', '请 Agent 检查')
              : t('sessions.continuation.cancel', '取消等待'),
        onClick: () => {
          if (action === 'resume') onResume?.(view.id);
          else if (action === 'askAgent') onAskAgent?.(view);
          else onCancel(view.id);
        },
      }
    : null;

  return (
    <SessionAutomationNoteShell
      tone={tone}
      icon={Icon}
      title={title}
      detail={detail}
      time={nextCheck}
      compact={compact}
      showDetailInCompact={statusUnavailable}
      inlineAction={inlineAction}
      dataAttributes={{
        'data-session-continuation-note': 'note',
        'data-session-continuation-id': view.id,
        'data-session-continuation-tone': tone,
      }}
      triggerDataAttributes={{ 'data-session-continuation-trigger': '' }}
      popoverBody={
        nextCheck || view.checkedAt !== undefined || view.expiresAt !== undefined ? (
          <div {...stylex.props(styles.rows)}>
            {nextCheck ? (
              <SessionAutomationNoteRow
                icon={Clock}
                label={t('sessions.continuation.nextCheck', '下次检查')}
                value={nextCheck}
              />
            ) : null}
            {view.checkedAt !== undefined ? (
              <SessionAutomationNoteRow
                icon={Check}
                label={t('sessions.continuation.lastChecked', '上次检查')}
                value={formatLocalizedRelativeTime(view.checkedAt, t, new Date(now))}
              />
            ) : null}
            {view.expiresAt !== undefined ? (
              <SessionAutomationNoteRow
                icon={CalendarClock}
                label={t('sessions.continuation.expires', '截止时间')}
                value={absoluteLabel(view.expiresAt, locale)}
              />
            ) : null}
          </div>
        ) : null
      }
      popoverFooter={
        <>
          {canAskAgent ? (
            <Button
              type="button"
              variant="ghost"
              size="mini"
              onClick={() => onAskAgent?.(view)}
            >
              <MessageCircle size={14} strokeWidth={1.8} />
              {t('sessions.continuation.askAgent', '请 Agent 检查')}
            </Button>
          ) : null}
          {descriptor.actions.cancel ? (
            <Button type="button" variant="ghost" size="mini" onClick={() => onCancel(view.id)}>
              {t('sessions.continuation.cancel', '取消等待')}
            </Button>
          ) : null}
          <SessionAutomationNoteFooterSpacer />
          {onOpenTweaks ? (
            <Button type="button" variant="ghost" size="mini" onClick={onOpenTweaks}>
              {t('sessions.continuation.moreTweaks', '自动化设置')}
              <ChevronRight size={14} strokeWidth={1.8} />
            </Button>
          ) : null}
        </>
      }
    />
  );
}
