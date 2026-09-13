import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Copy, Globe, Loader2 } from 'lucide-react';
import { SHARE_LIMITS } from '@lody/shared/session-sharing';
import type { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { SessionSharePreview } from './session-share-preview';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/ui/alert-dialog';

export type ShareCandidate = { sessionId: string; title: string };
export type SessionShareManagerProps = ReturnType<typeof useSessionShareManagement> & {
  sessionId: string;
  candidates: ShareCandidate[];
  selectionLocked?: boolean;
  onClose?: () => void;
  /** Lets the frame widen while the frozen-copy preview is expanded. */
  onPreviewOpenChange?: (open: boolean) => void;
};

/** Which panel the dialog shows. One screen at a time, one primary action each. */
type ShareStep = 'loading' | 'setup' | 'publishing' | 'published' | 'stale-draft';

/**
 * Animates the dialog's height between steps so the panel grows into the next
 * screen instead of snapping. The measured child is the only source of height:
 * a step whose own content changes (a preview opening, an error appearing)
 * resizes with the same transition.
 */
function StepTransition({ step, children }: { step: ShareStep; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="relative overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
      style={{ height }}
    >
      <div ref={inner}>
        <div
          key={step}
          className="duration-200 animate-in fade-in-0 slide-in-from-right-1 motion-reduce:animate-none"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Determinate only while bytes are moving; otherwise an honest indeterminate sweep. */
function SharePublishProgress({ indeterminate, value }: { indeterminate: boolean; value: number }) {
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : value}
    >
      {indeterminate ? (
        <div className="h-full w-1/3 rounded-full bg-primary animate-share-progress-sweep" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
}

/** The bearer link, always selectable so a failed clipboard write is recoverable. */
function ShareLinkField({ url, onCopy, busy }: { url: string; onCopy: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 rounded-md border border-input-border bg-input-field py-1 pl-2.5 pr-1">
      <input
        readOnly
        value={url}
        aria-label={t('sharing.static.linkLabel', 'Share link')}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 truncate bg-transparent font-mono text-xs text-muted-foreground outline-hidden"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onCopy}
        aria-label={t('settings.shares.copy', 'Copy link')}
        className="h-6 w-6 shrink-0 p-0"
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function Note({ tone = 'muted', children }: { tone?: 'muted' | 'alert'; children: ReactNode }) {
  return (
    <p
      role={tone === 'alert' ? 'alert' : undefined}
      className={cn(
        'text-xs leading-5',
        tone === 'alert' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  );
}

/** Pure controls: only a human's action uploads and publishes the frozen package. */
export function SessionShareManager(props: SessionShareManagerProps) {
  const { t } = useTranslation();
  const { entry, pending, busy, phase, result, conflict, selectionLocked } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
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
  const staleDraft = entry?.status === 'draft' && !!entry.canManage && !pending;
  const step: ShareStep =
    entry === undefined
      ? 'loading'
      : publishing
        ? 'publishing'
        : result
          ? 'published'
          : staleDraft
            ? 'stale-draft'
            : 'setup';

  const { onPreviewOpenChange } = props;
  useEffect(() => {
    onPreviewOpenChange?.(previewOpen && step === 'setup');
  }, [onPreviewOpenChange, previewOpen, step]);
  // A confirmation opened from an agent request must show the frozen copy it is
  // about to publish, so freeze it as soon as the locked editor is usable.
  const requestedPreview = useRef(false);
  useEffect(() => {
    if (!selectionLocked || requestedPreview.current) return;
    if (entry === undefined || pending || busy || !props.canCapture || !canPublish) return;
    requestedPreview.current = true;
    setPreviewOpen(true);
    void props.onPrepare();
  }, [selectionLocked, entry, pending, busy, props, canPublish]);

  const toggleChildren = (checked: boolean) =>
    props.onSelect(
      checked ? [props.sessionId, ...shareableChildren.map((c) => c.sessionId)] : [props.sessionId]
    );

  const publishLabel = active
    ? t('sharing.static.update', 'Update share')
    : t('sharing.static.share', 'Share conversation');
  const retrying = !!props.error && !!pending;

  const body = (() => {
    if (step === 'loading')
      return (
        <div className="space-y-3 px-5 pb-5" aria-busy="true">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <span className="sr-only">{t('common.loading', 'Loading…')}</span>
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
        <div className="space-y-3 px-5 pb-6 pt-1">
          <p role="status" className="text-sm text-foreground">
            {label}
          </p>
          <SharePublishProgress indeterminate={phase !== 'uploading'} value={props.progress} />
          <Note>{t('sharing.static.phaseHint', 'Keep this dialog open until it finishes.')}</Note>
        </div>
      );
    }
    if (step === 'published')
      return (
        <div className="space-y-3 px-5 pb-5 pt-1">
          <div className="flex items-center gap-2">
            <Check className="size-4 text-emerald-500" aria-hidden />
            <p className="text-sm font-medium text-foreground">
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
    if (step === 'stale-draft')
      return (
        <div className="space-y-3 px-5 pb-5 pt-1">
          <p className="text-sm leading-6 text-foreground">
            {t('sharing.static.draft', 'This share was never finished.')}
          </p>
          <Note>
            {t(
              'sharing.static.draftRecovery',
              'Its upload credentials were discarded when the editor closed. Discard it to share this conversation again; nothing was published.'
            )}
          </Note>
          {props.error && <Note tone="alert">{props.error}</Note>}
        </div>
      );
    return (
      <div className="space-y-3 px-5 pb-5 pt-1">
        {active ? (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              {t('sharing.static.publicNotice', 'Anyone with the link can view this conversation.')}
            </span>
          </div>
        ) : (
          <p className="text-sm leading-6 text-foreground">
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
        <Note>
          {!canPublish
            ? t(
                'settings.shares.otherPublisher',
                'Published by another workspace member. Link credentials are private to the publisher.'
              )
            : active
              ? t(
                  'sharing.static.updateNotice',
                  'Updating replaces the published copy with the current history and its public title. The link stays the same.'
                )
              : t(
                  'sharing.static.contentNotice',
                  'A static copy of the current history is published, including thinking and tool records. The title is public in link previews. Later messages are not added.'
                )}
        </Note>
        {children.length > 0 && canPublish && !selectionLocked && (
          <label className="-mx-2 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <Checkbox
              checked={includeChildren}
              disabled={busy}
              onCheckedChange={(checked) => toggleChildren(checked !== false)}
            />
            <span>
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
        {canPublish && props.canCapture && (
          <div>
            <button
              type="button"
              aria-expanded={previewOpen}
              disabled={busy}
              onClick={() => {
                const next = !previewOpen;
                setPreviewOpen(next);
                if (next && !pending) void props.onPrepare();
              }}
              className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {phase === 'previewing' ? (
                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3 transition-transform duration-200 motion-reduce:transition-none',
                    previewOpen && 'rotate-90'
                  )}
                />
              )}
              {t('sharing.static.preview', 'Preview what will be published')}
            </button>
            {previewOpen && pending && (
              <div className="mt-2 space-y-2">
                <Note>
                  {t(
                    'sharing.static.summary',
                    '{{conversations}} conversations · {{attachments}} copied attachments',
                    {
                      conversations: pending.manifest.conversations.length,
                      attachments: pending.manifest.attachments.length,
                    }
                  )}
                </Note>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {pending.manifest.conversations.map((conversation) => (
                    <li key={conversation.id} className="truncate">
                      {conversation.title || t('sessions.untitled', 'Untitled session')}
                    </li>
                  ))}
                </ul>
                {pending.uncopiedResourceCount > 0 && (
                  <Note>
                    {t(
                      'sharing.static.uncopiedResources',
                      '{{count}} embedded resource links are not copied. Their text is preserved, but the share cannot load resources from the original workspace or remote image URLs.',
                      { count: pending.uncopiedResourceCount }
                    )}
                  </Note>
                )}
                <SessionSharePreview key={pending.manifestHash} prepared={pending} />
              </div>
            )}
          </div>
        )}
        {!props.canCapture && canPublish && (
          <Note>
            {t(
              'sharing.static.sourceUnavailable',
              'The selected source conversations are unavailable. The published copy is unchanged.'
            )}
          </Note>
        )}
        {active && entry?.canManage && !props.hasSecret && (
          <div className="space-y-2">
            <Note>
              {t(
                'settings.shares.secretMissing',
                'The link credential is not saved on this device.'
              )}
            </Note>
            <Button
              type="button"
              variant="outline"
              size="sm"
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
          <p role="status" className="text-xs text-muted-foreground">
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
              size="sm"
              disabled={busy}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirming({ kind: 'revoke', revision: entry.revision })}
            >
              {t('sharing.static.revoke', 'Revoke share')}
            </Button>
          )}
          <div className="flex-1" />
          <Button size="sm" disabled={busy || !result?.url} onClick={() => void props.onCopy()}>
            {t('settings.shares.copy', 'Copy link')}
          </Button>
        </>
      );
    if (step === 'stale-draft')
      return (
        <>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void props.onRevoke()}>
            {t('sharing.static.discardDraft', 'Discard and start over')}
          </Button>
        </>
      );
    return (
      <>
        {entry?.canRevoke && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirming({ kind: 'revoke', revision: entry.revision })}
          >
            {t('sharing.static.revoke', 'Revoke share')}
          </Button>
        )}
        <div className="flex-1" />
        {active && props.shareLink && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void props.onCopy()}>
            {t('settings.shares.copy', 'Copy link')}
          </Button>
        )}
        {!canPublish ? (
          <Button variant="outline" size="sm" onClick={props.onClose}>
            {t('common.close', 'Close')}
          </Button>
        ) : (
          <>
            {!active && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
                {t('common.cancel', 'Cancel')}
              </Button>
            )}
            <Button
              size="sm"
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
    <div className="flex min-h-full flex-col">
      <StepTransition step={step}>{body}</StepTransition>
      {footer && (
        <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 bg-background px-5 py-3">
          {footer}
        </div>
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === 'reset'
                ? t('sharing.static.reset', 'Reset link')
                : t('sharing.static.revoke', 'Revoke share')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'sharing.static.invalidateNotice',
                'The previous link will stop working. Already downloaded copies cannot be recalled.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || confirming?.revision !== entry?.revision}
              onClick={() => {
                if (!confirming || confirming.revision !== entry?.revision) return;
                if (confirming.kind === 'reset') void props.onReset();
                else void props.onRevoke();
                setConfirming(null);
              }}
            >
              {t('common.confirm', 'Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
