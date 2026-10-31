import { useMemo, useRef } from 'react';
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
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { formatLocalizedRelativeTime } from '@/lib/format-relative-time';
import {
  describeSessionContinuation,
  type SessionContinuationDetail,
  type SessionContinuationNextCheck,
  type SessionContinuationView,
} from './session-continuation';

export type SessionContinuationNoteProps = {
  view: SessionContinuationView;
  /** Stable product clock; pass a shared `useStableNow()` value in production. */
  now: number;
  /** The one-line phone form: title + countdown, detail stays in the popover. */
  compact?: boolean;
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
  note: {
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
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

/**
 * The one-line promise the Agent leaves in a conversation. It is deliberately
 * not a panel: a moon, the Agent's own sentence, a countdown, and a way out.
 * The popover is the only place with inspection detail.
 */
export function SessionContinuationNote({
  view,
  now,
  compact = false,
  onCancel,
  onResume,
  onAskAgent,
  onOpenTweaks,
}: SessionContinuationNoteProps) {
  const { t, i18n } = useTranslation();
  const noteRef = useRef<HTMLDivElement>(null);
  const locale = toIntlLocaleOrEn(i18n.language);
  const descriptor = useMemo(() => describeSessionContinuation(view, now), [view, now]);

  if (!descriptor.visible) return null;

  const title = descriptor.title ?? t('sessions.continuation.fallbackTitle', '会话自动继续');
  const detail = t(DETAIL_COPY[descriptor.detail].key, DETAIL_COPY[descriptor.detail].fallback);
  const nextCheck = nextCheckLabel(descriptor.nextCheck, t, locale);
  const tone = descriptor.tone;
  const Icon = iconFor(descriptor.detail, tone);
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

  if (descriptor.detail === 'blockedStopped') {
    return (
      <div
        {...stylex.props(styles.nudge)}
        data-session-continuation-note="blocked"
        data-session-continuation-id={view.id}
        role="status"
        aria-live="polite"
      >
        <span {...stylex.props(styles.icon, styles.iconAttention)} aria-hidden="true">
          <Sun size={13} strokeWidth={2} />
        </span>
        <div {...stylex.props(styles.nudgeCopy)}>
          <span {...stylex.props(styles.nudgeTitle)}>
            {t('sessions.continuation.stopped.title', '条件已满足，会话已停止。')}
          </span>
          <span {...stylex.props(styles.nudgeReason)}>{title}</span>
        </div>
        <div {...stylex.props(styles.nudgeActions)}>
          {descriptor.actions.resume && onResume ? (
            <Button type="button" variant="primary" size="mini" onClick={() => onResume(view.id)}>
              {t('sessions.continuation.resume', '恢复会话')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="mini" onClick={() => onCancel(view.id)}>
            {t('sessions.continuation.cancel', '取消等待')}
          </Button>
        </div>
      </div>
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

  const trigger = (
    <button
      type="button"
      {...stylex.props(styles.trigger)}
      data-session-continuation-trigger=""
      aria-label={`${title} · ${detail}${nextCheck ? ` · ${nextCheck}` : ''}`}
    >
      <span {...stylex.props(styles.icon, iconToneStyle)} aria-hidden="true">
        <Icon size={13} strokeWidth={2} />
      </span>
      <span {...stylex.props(styles.title)}>{title}</span>
      {compact ? null : (
        <>
          <span {...stylex.props(styles.separator)} aria-hidden="true">
            ·
          </span>
          <span {...stylex.props(styles.detail)}>{detail}</span>
        </>
      )}
      {nextCheck ? (
        <>
          <span {...stylex.props(styles.separator)} aria-hidden="true">
            ·
          </span>
          <span {...stylex.props(styles.time)}>{nextCheck}</span>
        </>
      ) : null}
    </button>
  );

  return (
    <div
      ref={noteRef}
      {...stylex.props(styles.note, toneStyle, compact && styles.noteCompact)}
      data-session-continuation-note="note"
      data-session-continuation-id={view.id}
      data-session-continuation-tone={tone}
    >
      <Popover.Root>
        <Popover.Trigger render={trigger} />
        <Popover.Content anchor={noteRef} side="top" align="start" sideOffset={8} className="w-72">
          <div {...stylex.props(styles.popoverBody)}>
            <div {...stylex.props(styles.popoverHeading)}>
              <span {...stylex.props(styles.popoverIcon, popoverIconToneStyle)} aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <Popover.Title>{title}</Popover.Title>
              <Popover.Description {...stylex.props(styles.popoverDescription)}>
                {detail}
              </Popover.Description>
            </div>

            {(nextCheck || view.checkedAt !== undefined || view.expiresAt !== undefined) && (
              <div {...stylex.props(styles.rows)}>
                {nextCheck ? (
                  <div {...stylex.props(styles.row)}>
                    <Clock {...stylex.props(styles.rowIcon)} />
                    <span {...stylex.props(styles.rowLabel)}>
                      {t('sessions.continuation.nextCheck', '下次检查')}
                    </span>
                    <span {...stylex.props(styles.rowValue)}>{nextCheck}</span>
                  </div>
                ) : null}
                {view.checkedAt !== undefined ? (
                  <div {...stylex.props(styles.row)}>
                    <Check {...stylex.props(styles.rowIcon)} />
                    <span {...stylex.props(styles.rowLabel)}>
                      {t('sessions.continuation.lastChecked', '上次检查')}
                    </span>
                    <span {...stylex.props(styles.rowValue)}>
                      {formatLocalizedRelativeTime(view.checkedAt, t, new Date(now))}
                    </span>
                  </div>
                ) : null}
                {view.expiresAt !== undefined ? (
                  <div {...stylex.props(styles.row)}>
                    <CalendarClock {...stylex.props(styles.rowIcon)} />
                    <span {...stylex.props(styles.rowLabel)}>
                      {t('sessions.continuation.expires', '截止时间')}
                    </span>
                    <span {...stylex.props(styles.rowValue)}>
                      {absoluteLabel(view.expiresAt, locale)}
                    </span>
                  </div>
                ) : null}
              </div>
            )}

            <Separator />

            <div {...stylex.props(styles.footer)}>
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
              <span {...stylex.props(styles.footerSpacer)} />
              {onOpenTweaks ? (
                <Button type="button" variant="ghost" size="mini" onClick={onOpenTweaks}>
                  {t('sessions.continuation.moreTweaks', '自动化设置')}
                  <ChevronRight size={14} strokeWidth={1.8} />
                </Button>
              ) : null}
            </div>
          </div>
        </Popover.Content>
      </Popover.Root>

      {action && !compact ? (
        <>
          <span {...stylex.props(styles.divider)} aria-hidden="true" />
          <button
            type="button"
            {...stylex.props(styles.inlineAction)}
            onClick={() => {
              if (action === 'resume') onResume?.(view.id);
              else if (action === 'askAgent') onAskAgent?.(view);
              else onCancel(view.id);
            }}
          >
            {action === 'resume'
              ? t('sessions.continuation.resume', '恢复会话')
              : action === 'askAgent'
                ? t('sessions.continuation.askAgentShort', '请 Agent 检查')
                : t('sessions.continuation.cancel', '取消等待')}
          </button>
        </>
      ) : null}
    </div>
  );
}
