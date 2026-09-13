import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudQuery } from '@lody/platform/react';
import type { PublishedSessionShare } from '@lody/cloud-api';
import type { WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useSessionShareLinkActions } from '@/hooks/use-session-share-management';
import { SessionShareDialog } from '@/components/sharing/session-share-dialog';
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
import { Button } from '@/ui/button';
import { settingContainerClass } from '.';

export function ShareManagementSetting() {
  const supported = useAppCapability('teamSharing');
  const scope = useResolvedWorkspaceScope({ enabled: supported });
  const userId = useAtomValue(userAtom)?.id;
  if (!scope.enabled || !scope.workspaceId || !userId) return null;
  // No pagination, selection, or asynchronous result survives an identity switch.
  return (
    <ShareManagementList
      key={`${userId}:${scope.workspaceId}`}
      workspaceId={scope.workspaceId}
      userId={userId}
    />
  );
}

function ShareManagementList({
  workspaceId,
  userId,
}: {
  workspaceId: WorkspaceId;
  userId: string;
}) {
  const { t } = useTranslation();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const actions = useSessionShareLinkActions(workspaceId);
  const meta = useAtomValue(sessionMetaCacheAtom);
  const [editor, setEditor] = useState<PublishedSessionShare | null>(null);
  const [confirmation, setConfirmation] = useState<{
    kind: 'reset' | 'revoke';
    entry: PublishedSessionShare;
  } | null>(null);
  const source = editor
    ? Object.values(meta).find((session) => session.id === editor.rootSessionId)
    : undefined;
  const result = useCloudQuery(cloudOperations.sessionSharing.list, {
    workspaceId,
    paginationOpts: { numItems: 20, cursor: cursors[cursors.length - 1] ?? null },
  });
  return (
    <div className={settingContainerClass}>
      <p className="text-sm text-muted-foreground">
        {t(
          'settings.shares.description',
          'Published static copies. Administrators see all workspace shares; other members see their own.'
        )}
      </p>
      {actions.notice && (
        <p role="status" className="text-sm">
          {actions.notice}
        </p>
      )}
      {actions.error && (
        <p role="alert" className="text-sm text-destructive">
          {actions.error}
        </p>
      )}
      {result === undefined ? (
        <p role="status">{t('common.loading', 'Loading…')}</p>
      ) : (
        <>
          {result.page.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('settings.shares.empty', 'No published shares.')}
            </p>
          )}
          <ul className="divide-y divide-border">
            {result.page.map((entry) => {
              const hasSecret = !!actions.secretFor(entry);
              const hasSource = Object.values(meta).some(
                (session) => session.id === entry.rootSessionId
              );
              return (
                <li
                  key={entry.shareId}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">
                      {entry.title || t('sessions.untitled', 'Untitled session')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.status === 'active'
                        ? t('settings.shares.active', 'Active')
                        : t('settings.shares.revoked', 'Revoked')}
                      {' · '}
                      {t('settings.shares.conversations', '{{count}} conversations', {
                        count: entry.conversationCount,
                      })}
                      {' · '}
                      <time dateTime={new Date(entry.updatedAt).toISOString()}>
                        {new Date(entry.updatedAt).toLocaleString()}
                      </time>
                    </p>
                    {!hasSecret && entry.status === 'active' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.publisherUserId === userId
                          ? t(
                              'settings.shares.secretMissing',
                              'The link credential is not saved on this device.'
                            )
                          : t(
                              'settings.shares.otherPublisher',
                              'Published by another workspace member. Link credentials are private to the publisher.'
                            )}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {hasSecret && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actions.busy}
                        onClick={() => void actions.copy(entry)}
                      >
                        {t('settings.shares.copy', 'Copy link')}
                      </Button>
                    )}
                    {entry.canManage && hasSource && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actions.busy}
                        onClick={() => setEditor(entry)}
                      >
                        {t('sharing.static.update', 'Update deployment')}
                      </Button>
                    )}
                    {entry.canManage && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actions.busy}
                        onClick={() => setConfirmation({ kind: 'reset', entry })}
                      >
                        {t('sharing.static.reset', 'Reset link')}
                      </Button>
                    )}
                    {entry.canRevoke && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actions.busy}
                        onClick={() => setConfirmation({ kind: 'revoke', entry })}
                      >
                        {t('sharing.static.revoke', 'Revoke')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 1}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              {t('settings.shares.previous', 'Previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={result.isDone}
              onClick={() => setCursors((value) => [...value, result.continueCursor])}
            >
              {t('settings.shares.next', 'Next')}
            </Button>
          </div>
        </>
      )}
      {editor && source && (
        <SessionShareDialog
          workspaceId={workspaceId}
          session={source}
          shareId={editor.shareId}
          onClose={() => setEditor(null)}
        />
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
              disabled={
                actions.busy ||
                !confirmation ||
                !result?.page.some(
                  (entry) =>
                    entry.shareId === confirmation.entry.shareId &&
                    entry.revision === confirmation.entry.revision
                )
              }
              onClick={() => {
                if (confirmation?.kind === 'reset') void actions.reset(confirmation.entry);
                else if (confirmation) void actions.revoke(confirmation.entry);
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
