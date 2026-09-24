import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Copy, Globe } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { SHARE_LIMITS } from '@lody/shared/session-sharing';
import type { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Input } from '@lody/ui/input';
import { Progress } from '@lody/ui/progress';
import { Skeleton } from '@lody/ui/skeleton';
import { AlertDialog } from '@/ui/dialog';
import { shareSurface } from './surface';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** A step arrives from a hair to the right, the way the next screen of a flow does. */
const stepIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(4px)' },
  to: { opacity: 1, transform: 'none' },
});

const styles = stylex.create({
  frame: { display: 'flex', flexDirection: 'column', minHeight: '100%' },
  transition: {
    position: 'relative',
    overflow: 'hidden',
    transitionProperty: { default: 'height', [REDUCED_MOTION]: 'none' },
    transitionDuration: '300ms',
    transitionTimingFunction: 'ease-out',
  },
  step: {
    animationName: { default: stepIn, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.regular,
    animationTimingFunction: ease.standard,
  },
  /** One screen: its lines stacked, set apart by space. */
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    paddingBottom: space[4],
  },
  loading: { display: 'flex', flexDirection: 'column', gap: space[3], paddingBottom: space[4] },
  status: { margin: 0, fontSize: text.bodySize, lineHeight: text.bodyLeading, color: colors.label },
  prose: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  lead: { display: 'flex', alignItems: 'center', gap: space[2] },
  leadIcon: { flexShrink: 0, width: '16px', height: '16px', color: colors.secondaryLabel },
  successIcon: { flexShrink: 0, width: '16px', height: '16px', color: colors.success },
  published: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  note: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  linkRow: { display: 'flex', alignItems: 'center', gap: space[1] },
  secretMissing: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
  },
  /** The checkbox and its sentence are one pressable line. */
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    marginInline: `calc(-1 * ${space[2]})`,
    paddingInline: space[2],
    paddingBlock: space[1.5],
    borderRadius: radius.small,
    cornerShape: corner.shape,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  optionDisabled: {
    cursor: 'not-allowed',
    backgroundColor: { default: 'transparent', ':hover': 'transparent' },
  },
  optionLabelDisabled: { opacity: 0.45 },
  /**
   * The answers stick to the bottom of the dialog's scroll body. The panel is
   * what separates them from the content scrolling under, so the row takes the
   * panel's own fill and no rule above it.
   */
  footer: {
    position: 'sticky',
    insetBlockEnd: 0,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    marginTop: 'auto',
    paddingTop: space[3],
    backgroundColor: colors.elevatedBackground,
  },
  spacer: { flexGrow: 1 },
});

export type ShareCandidate = { sessionId: string; title: string };
export type SessionShareManagerProps = ReturnType<typeof useSessionShareManagement> & {
  sessionId: string;
  candidates: ShareCandidate[];
  selectionLocked?: boolean;
  onClose?: () => void;
};

/** Which panel the dialog shows. One screen at a time, one primary action each. */
type ShareStep = 'loading' | 'setup' | 'publishing' | 'published';

/**
 * Animates the dialog's height between steps so the panel grows into the next
 * screen instead of snapping. The measured child is the only source of height:
 * a step whose own content changes (an error appearing)
 * resizes with the same transition.
 */
function StepTransition({ step, children }: { step: ShareStep; children: ReactNode }) {
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
    <div {...stylex.props(styles.transition)} style={{ height }}>
      <div ref={inner}>
        <div key={step} {...stylex.props(styles.step)}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The bearer link, always selectable so a failed clipboard write is recoverable. */
function ShareLinkField({ url, onCopy, busy }: { url: string; onCopy: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.linkRow)}>
      <Input
        readOnly
        size="small"
        value={url}
        aria-label={t('sharing.static.linkLabel', 'Share link')}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        type="button"
        variant="ghost"
        size="small"
        icon
        disabled={busy}
        onClick={onCopy}
        aria-label={t('settings.shares.copy', 'Copy link')}
      >
        <Copy {...stylex.props(shareSurface.glyph)} />
      </Button>
    </div>
  );
}

/** A hint is secondary copy; a failure is a tint and a mark, never a bordered box. */
function Note({ tone = 'muted', children }: { tone?: 'muted' | 'alert'; children: ReactNode }) {
  if (tone === 'alert')
    return (
      <div role="alert" {...stylex.props(shareSurface.message, shareSurface.messageDestructive)}>
        <AlertCircle
          aria-hidden
          {...stylex.props(shareSurface.mark, shareSurface.markDestructive)}
        />
        <p {...stylex.props(styles.note, shareSurface.messageBody)}>{children}</p>
      </div>
    );
  return <p {...stylex.props(styles.note)}>{children}</p>;
}

/** Pure controls: only a human's action uploads and publishes the frozen package. */
export function SessionShareManager(props: SessionShareManagerProps) {
  const { t } = useTranslation();
  const { entry, hasPending, busy, phase, result, conflict, selectionLocked } = props;
  const [confirming, setConfirming] = useState<{
    kind: 'reset' | 'revoke';
    revision: number;
  } | null>(null);
  const children = props.candidates.filter((c) => c.sessionId !== props.sessionId);
  // One switch, but never a lie about scope: a share that carries only some of
  // the current children reads as indeterminate until the user commits to all.
  const shareableChildren = children.slice(0, SHARE_LIMITS.conversations - 1);
  const selectedChildren = shareableChildren.filter((c) =>
    props.selected.includes(c.sessionId)
  ).length;
  const includeChildren: boolean | 'indeterminate' =
    selectedChildren === 0
      ? false
      : selectedChildren >= shareableChildren.length
        ? true
        : 'indeterminate';
  const active = entry?.status === 'active';
  const canPublish = entry === null || !!entry?.canManage || entry?.status === 'revoked';
  const publishing = phase === 'capturing' || phase === 'uploading' || phase === 'publishing';
  const step: ShareStep = (() => {
    if (entry === undefined) return 'loading';
    if (publishing) return 'publishing';
    if (result) return 'published';
    return 'setup';
  })();

  const toggleChildren = (checked: boolean) =>
    props.onSelect(
      checked ? [props.sessionId, ...shareableChildren.map((c) => c.sessionId)] : [props.sessionId]
    );

  const publishLabel = active
    ? t('sharing.static.update', 'Update share')
    : t('sharing.static.share', 'Share conversation');
  const retrying = !!props.error && hasPending;

  const body = (() => {
    if (step === 'loading')
      return (
        <div {...stylex.props(styles.loading)} aria-busy="true">
          <Skeleton width="75%" height={16} />
          <Skeleton width="100%" height={12} />
          <Skeleton width="66%" height={12} />
          <span {...stylex.props(shareSurface.visuallyHidden)}>
            {t('common.loading', 'Loading…')}
          </span>
        </div>
      );
    if (step === 'publishing') {
      const label =
        phase === 'uploading'
          ? t('sharing.static.phaseUploading', 'Uploading the copy… {{progress}}%', {
              progress: props.progress,
            })
          : phase === 'publishing'
            ? t('sharing.static.phasePublishing', 'Publishing…')
            : t('sharing.static.phaseCapturing', 'Freezing this conversation…');
      return (
        <div {...stylex.props(styles.body)}>
          <p role="status" {...stylex.props(styles.status)}>
            {label}
          </p>
          <Progress value={phase === 'uploading' ? props.progress : null} />
          <Note>{t('sharing.static.phaseHint', 'Keep this dialog open until it finishes.')}</Note>
        </div>
      );
    }
    if (step === 'published')
      return (
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.lead)}>
            <Check {...stylex.props(styles.successIcon)} aria-hidden />
            <p {...stylex.props(styles.published)}>
              {result?.copied
                ? t('sharing.static.publishedCopied', 'Shared. Link copied to your clipboard.')
                : t('sharing.static.published', 'Shared.')}
            </p>
          </div>
          {result?.url ? (
            <>
              <ShareLinkField url={result.url} busy={busy} onCopy={() => void props.onCopy()} />
              {!result.copied && (
                <Note>
                  {t(
                    'sharing.static.copyFallback',
                    'Automatic copying was blocked. Copy the link above.'
                  )}
                </Note>
              )}
            </>
          ) : (
            <Note>
              {t(
                'settings.shares.secretMissing',
                'The link credential is not saved on this device.'
              )}
            </Note>
          )}
          {props.error && <Note tone="alert">{props.error}</Note>}
        </div>
      );
    return (
      <div {...stylex.props(styles.body)}>
        {active ? (
          <div {...stylex.props(styles.lead, styles.prose)}>
            <Globe {...stylex.props(styles.leadIcon)} aria-hidden />
            <span>
              {t('sharing.static.publicNotice', 'Anyone with the link can view this conversation.')}
            </span>
          </div>
        ) : (
          <p {...stylex.props(styles.prose)}>
            {t('sharing.static.publicNotice', 'Anyone with the link can view this conversation.')}
          </p>
        )}
        {active && props.shareLink && (
          <ShareLinkField url={props.shareLink} busy={busy} onCopy={() => void props.onCopy()} />
        )}
        {entry?.status === 'revoked' && (
          <Note>
            {t(
              'sharing.static.revokedNotice',
              'The previous link was revoked. Sharing again creates a new link.'
            )}
          </Note>
        )}
        {!canPublish && (
          <Note>
            {t(
              'settings.shares.otherPublisher',
              'Published by another workspace member. Link credentials are private to the publisher.'
            )}
          </Note>
        )}
        {active && canPublish && (
          <Note>
            {t(
              'sharing.static.updateNotice',
              'Updating replaces the published copy with the current history and its public title. The link stays the same.'
            )}
          </Note>
        )}
        {children.length > 0 && canPublish && !selectionLocked && (
          <label {...stylex.props(styles.option, busy && styles.optionDisabled)}>
            <Checkbox
              checked={includeChildren === true}
              indeterminate={includeChildren === 'indeterminate'}
              disabled={busy}
              onCheckedChange={(checked) => toggleChildren(checked !== false)}
            />
            <span {...stylex.props(busy && styles.optionLabelDisabled)}>
              {includeChildren === 'indeterminate'
                ? t(
                    'sharing.static.includeChildrenPartial',
                    'Also share sub-conversations ({{selected}} of {{count}})',
                    { selected: selectedChildren, count: shareableChildren.length }
                  )
                : t('sharing.static.includeChildren', 'Also share {{count}} sub-conversations', {
                    count: shareableChildren.length,
                  })}
            </span>
          </label>
        )}
        {children.length >= SHARE_LIMITS.conversations && (
          <Note>
            {t('sharing.static.limit', 'A share can contain at most {{count}} conversations.', {
              count: SHARE_LIMITS.conversations,
            })}
          </Note>
        )}
        <Note>
          {t(
            'sharing.static.attachmentNotice',
            'Images are also shared. File attachments are not included.'
          )}
        </Note>
        {!props.canCapture && canPublish && (
          <Note>
            {t(
              'sharing.static.sourceUnavailable',
              'The selected source conversations are unavailable. The published copy is unchanged.'
            )}
          </Note>
        )}
        {active && entry?.canManage && !props.hasSecret && (
          <div {...stylex.props(styles.secretMissing)}>
            <Note>
              {t(
                'settings.shares.secretMissing',
                'The link credential is not saved on this device.'
              )}
            </Note>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => setConfirming({ kind: 'reset', revision: entry.revision })}
            >
              {t('sharing.static.reset', 'Reset link')}
            </Button>
          </div>
        )}
        {conflict && (
          <Note tone="alert">
            {t(
              'sharing.static.conflict',
              'This share changed somewhere else. Start over to publish the current content.'
            )}
          </Note>
        )}
        {props.error && <Note tone="alert">{props.error}</Note>}
        {props.notice && (
          <p role="status" {...stylex.props(styles.note)}>
            {props.notice}
          </p>
        )}
      </div>
    );
  })();

  const footer = (() => {
    if (step === 'loading' || step === 'publishing') return null;
    if (step === 'published')
      return (
        <>
          {entry?.canRevoke && (
            <Button
              variant="ghost"
              tone="destructive"
              size="small"
              disabled={busy}
              onClick={() => setConfirming({ kind: 'revoke', revision: entry.revision })}
            >
              {t('sharing.static.revoke', 'Revoke share')}
            </Button>
          )}
          <div {...stylex.props(styles.spacer)} />
          <Button size="small" disabled={busy || !result?.url} onClick={() => void props.onCopy()}>
            {t('settings.shares.copy', 'Copy link')}
          </Button>
        </>
      );
    return (
      <>
        {entry?.canRevoke && (
          <Button
            variant="ghost"
            tone="destructive"
            size="small"
            disabled={busy}
            onClick={() => setConfirming({ kind: 'revoke', revision: entry.revision })}
          >
            {t('sharing.static.revoke', 'Revoke share')}
          </Button>
        )}
        <div {...stylex.props(styles.spacer)} />
        {active && props.shareLink && (
          <Button
            variant="secondary"
            size="small"
            disabled={busy}
            onClick={() => void props.onCopy()}
          >
            {t('settings.shares.copy', 'Copy link')}
          </Button>
        )}
        {!canPublish ? (
          <Button variant="secondary" size="small" onClick={props.onClose}>
            {t('common.close', 'Close')}
          </Button>
        ) : (
          <>
            {!active && (
              <Button variant="ghost" size="small" disabled={busy} onClick={props.onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
            )}
            <Button
              size="small"
              disabled={busy || (!props.canCapture && !conflict)}
              onClick={() => (conflict ? props.onDiscard() : void props.onPublish())}
            >
              {conflict
                ? t('sharing.static.startOver', 'Start over')
                : retrying
                  ? t('common.retry', 'Retry')
                  : publishLabel}
            </Button>
          </>
        )}
      </>
    );
  })();

  return (
    <div {...stylex.props(styles.frame)}>
      <StepTransition step={step}>{body}</StepTransition>
      {footer && <div {...stylex.props(styles.footer)}>{footer}</div>}
      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {confirming?.kind === 'reset'
                ? t('sharing.static.reset', 'Reset link')
                : t('sharing.static.revoke', 'Revoke share')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'sharing.static.invalidateNotice',
                'The previous link will stop working. Downloaded copies cannot be recalled.'
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              variant="destructive"
              disabled={busy || confirming?.revision !== entry?.revision}
              onClick={() => {
                if (!confirming || confirming.revision !== entry?.revision) return;
                if (confirming.kind === 'reset') void props.onReset();
                else void props.onRevoke();
                setConfirming(null);
              }}
            >
              {t('common.confirm', 'Confirm')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}
