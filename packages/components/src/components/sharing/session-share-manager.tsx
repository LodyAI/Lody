import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARE_LIMITS } from '@lody/shared/session-sharing';
import type { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
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
};
/** Pure controls: only a human's final confirmation uploads the frozen package. */
export function SessionShareManager(props: SessionShareManagerProps) {
  const { t } = useTranslation();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    kind: 'reset' | 'revoke';
    revision: number;
  } | null>(null);
  const { entry, pending, busy } = props;
  const children = props.candidates.filter((c) => c.sessionId !== props.sessionId);
  const canPublish = entry === null || entry?.canManage || entry?.status === 'revoked';
  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      <p className="text-sm text-muted-foreground">
        {t(
          'sharing.static.notice',
          'Publish a static copy of all selected history, including thinking and tool inputs and outputs. Review sensitive content before publishing. Future messages are not included automatically.'
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'sharing.static.previewNotice',
          'The title is public for link previews. The conversation and copied attachments require the full share link.'
        )}
      </p>
      {entry === undefined ? (
        <p role="status">{t('common.loading', 'Loading…')}</p>
      ) : (
        <>
          {entry && (
            <p className="text-sm">
              {entry.status === 'active'
                ? t('settings.shares.active', 'Active')
                : entry.status === 'draft'
                  ? t('sharing.static.draft', 'Upload not yet published')
                  : t('settings.shares.revoked', 'Revoked')}
            </p>
          )}
          {children.length > 0 && canPublish && !props.selectionLocked && (
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                {t(
                  'sharing.static.includeChildren',
                  'Include current sub-conversations and child Tabs'
                )}
              </span>
              <Switch
                checked={props.selected.some((id) => id !== props.sessionId)}
                disabled={busy}
                onCheckedChange={(checked) =>
                  props.onSelect(
                    checked
                      ? [
                          props.sessionId,
                          ...children
                            .slice(0, SHARE_LIMITS.conversations - 1)
                            .map((c) => c.sessionId),
                        ]
                      : [props.sessionId]
                  )
                }
              />
            </label>
          )}
          {children.length >= SHARE_LIMITS.conversations && (
            <p className="text-xs text-muted-foreground">
              {t('sharing.static.limit', 'A share can contain at most {{count}} conversations.', {
                count: SHARE_LIMITS.conversations,
              })}
            </p>
          )}
          {pending && (
            <section className="rounded-md border p-3">
              <h3 className="text-sm font-medium">
                {t('sharing.static.confirmTitle', 'Confirm this static copy')}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((value) => !value)}
              >
                {t('sharing.static.preview', 'Preview frozen copy')}
              </Button>
              {previewOpen && <SessionSharePreview key={pending.manifestHash} prepared={pending} />}
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {pending.manifest.conversations.map((c) => (
                  <li key={c.id}>{c.title || t('sessions.untitled', 'Untitled session')}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  'sharing.static.summary',
                  '{{conversations}} conversations · {{attachments}} copied attachments',
                  {
                    conversations: pending.manifest.conversations.length,
                    attachments: pending.manifest.attachments.length,
                  }
                )}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  'sharing.static.confirmNotice',
                  'Publishing uploads the readable history to share storage. Anyone with the full link can read and copy it.'
                )}
              </p>
              {pending.uncopiedResourceCount > 0 && (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {t(
                    'sharing.static.uncopiedResources',
                    '{{count}} embedded resource links are not copied. Their text is preserved, but the share cannot load resources from the original workspace or remote image URLs.',
                    { count: pending.uncopiedResourceCount }
                  )}
                </p>
              )}
            </section>
          )}
          {!props.canCapture && canPublish && (
            <p className="text-sm text-muted-foreground">
              {t(
                'sharing.static.sourceUnavailable',
                'The selected source conversations are unavailable. The published copy is unchanged.'
              )}
            </p>
          )}
          {entry?.status === 'active' && entry.canManage && !props.hasSecret && (
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.shares.secretMissing',
                'The link credential is not saved on this device.'
              )}
            </p>
          )}
          {props.conflict && (
            <p role="alert" className="text-sm">
              {t(
                'sharing.static.conflict',
                'This share changed elsewhere. Discard this preview and prepare it again.'
              )}
            </p>
          )}
          {props.error && (
            <p role="alert" className="text-sm text-destructive">
              {props.error}
            </p>
          )}
          {props.notice && (
            <p role="status" className="text-sm">
              {props.notice}
            </p>
          )}
          {busy && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('sharing.static.progress', 'Preparing / publishing… {{progress}}%', {
                progress: props.progress,
              })}
            </p>
          )}
          <div className="sticky bottom-0 -mx-4 flex flex-wrap gap-2 border-t bg-background px-4 pt-3 sm:-mx-5 sm:px-5">
            {pending ? (
              <>
                <Button
                  size="sm"
                  disabled={busy || props.conflict}
                  onClick={() => void props.onConfirm()}
                >
                  {t('sharing.static.publish', 'Confirm publication')}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={props.onDiscard}>
                  {t('sharing.static.discard', 'Discard preview')}
                </Button>
              </>
            ) : (
              canPublish && (
                <Button
                  size="sm"
                  disabled={busy || !props.canCapture || entry?.status === 'draft'}
                  onClick={() => void props.onPrepare()}
                >
                  {entry?.status === 'active'
                    ? t('sharing.static.update', 'Update deployment')
                    : t('sharing.static.prepare', 'Prepare share')}
                </Button>
              )
            )}
            {props.hasSecret && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void props.onCopy()}
              >
                {t('settings.shares.copy', 'Copy link')}
              </Button>
            )}
            {entry?.canManage && entry.status === 'active' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmation({ kind: 'reset', revision: entry.revision })}
              >
                {t('sharing.static.reset', 'Reset link')}
              </Button>
            )}
            {entry?.canRevoke && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmation({ kind: 'revoke', revision: entry.revision })}
              >
                {t('sharing.static.revoke', 'Revoke')}
              </Button>
            )}
          </div>
        </>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === 'reset'
                ? t('sharing.static.reset', 'Reset link')
                : t('sharing.static.revoke', 'Revoke')}
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
              disabled={busy || confirmation?.revision !== entry?.revision}
              onClick={() => {
                if (confirmation?.revision !== entry?.revision) return;
                if (confirmation?.kind === 'reset') void props.onReset();
                else void props.onRevoke();
                setConfirmation(null);
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
