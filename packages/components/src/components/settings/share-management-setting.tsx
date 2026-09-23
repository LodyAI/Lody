import { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useCloudQuery } from '@lody/platform/react';
import type { PublishedSessionShare } from '@lody/cloud-api';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { settingsDialogOpenAtom } from '@/atoms/settings';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useSessionShareLinkActions } from '@/hooks/use-session-share-management';
import { openExternalUrl } from '@/lib/native-browser';
import { SessionShareDialog } from '@/components/sharing/session-share-dialog';
import { UserAvatar } from '@/components/user-avatar';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Skeleton } from '@/ui/skeleton';
import { Switch } from '@/ui/switch';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_CARD_CLASS } from './compact-layout';
import { settingContainerClass } from '.';

const pad = (value: number) => String(value).padStart(2, '0');

const formatYmd = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/**
 * Three tiers, coarsening with age: a share published today is placed by clock
 * time, one from this year by month/day, anything older by full date. `now` is
 * injected so the boundaries are testable and never read the wall clock twice.
 */
export function formatSharePublishedAt(at: Date, now: Date): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getFullYear() === now.getFullYear())
    return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return formatYmd(at);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

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

/**
 * The publisher, as a face rather than a sentence. The name and email stay one
 * click away instead of riding every card, because on most cards the publisher
 * is the reader themselves and the text would be pure repetition.
 */
function SharePublisherAvatar({
  publisherUserId,
  workspaceId,
}: {
  publisherUserId: string;
  workspaceId: WorkspaceId;
}) {
  const { t } = useTranslation();
  const user = useCloudQuery(
    cloudOperations.auth.getUserById,
    publisherUserId ? { userId: publisherUserId, workspaceId } : 'skip'
  );
  const displayName = user?.name?.trim() || user?.email?.trim();
  // No `showIcon`: a publisher we know by name should fall back to initials, not
  // to the anonymous glyph. The generic person icon reads as "nobody", which is
  // wrong for a row that names who published it.
  const avatar = <UserAvatar user={user} className="h-8 w-8" />;
  if (!displayName) return <div className="shrink-0">{avatar}</div>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // The card behind this avatar is itself one big click target, so the
          // profile must not also open the detail dialog.
          onClick={(event) => event.stopPropagation()}
          title={displayName}
          aria-label={t('settings.shares.publisherProfile', 'View profile for {{name}}', {
            name: displayName,
          })}
          className="relative z-10 block shrink-0 rounded-full outline-hidden ring-offset-background transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {avatar}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={10} className="w-64 p-0">
        <div className="flex items-center gap-3 p-3.5">
          <UserAvatar
            user={user}
            className="h-12 w-12 shrink-0 text-lg"
            fallbackClassName="bg-primary/10 text-primary"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
            {user?.email ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground" title={user.email}>
                {user.email}
              </div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ShareCardSkeleton() {
  return (
    <div className={cn(SETTINGS_ROW_CARD_CLASS, 'flex items-start gap-3 px-3 py-2.5')}>
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3.5 w-[70%]" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
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
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [showRevoked, setShowRevoked] = useState(false);
  const actions = useSessionShareLinkActions(workspaceId);
  const meta = useAtomValue(sessionMetaCacheAtom);
  const [detail, setDetail] = useState<PublishedSessionShare | null>(null);
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
  // Desktop renders settings as a modal over the workspace, so the session only
  // becomes visible once that overlay is dismissed; on mobile settings is a route
  // and the navigation replaces it.
  const openSession = useCallback(
    (sessionId: SessionId) => {
      if (!workspaceSlug) return;
      setSettingsDialogOpen(false);
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [navigate, setSettingsDialogOpen, workspaceSlug]
  );
  // The server cannot filter these out: a share also reads as revoked when its
  // publisher's membership no longer matches, which is an async lookup rather
  // than a stored field. So the hidden ones are counted here and reported next
  // to the switch — a page of 20 that shows 12 cards is otherwise unexplained.
  const revokedOnPage = useMemo(
    () => (result?.page ?? []).filter((entry) => entry.status !== 'active').length,
    [result]
  );
  const visible = useMemo(
    () => (result?.page ?? []).filter((entry) => showRevoked || entry.status === 'active'),
    [result, showRevoked]
  );
  const now = new Date();
  return (
    <div className={settingContainerClass}>
      <p className="text-sm text-muted-foreground">
        {t(
          'settings.shares.description',
          'Static copies you have published. Admins see every share in the workspace.'
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
        <div className="@container">
          <div className="grid grid-cols-1 gap-2 @[34rem]:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <ShareCardSkeleton key={index} />
            ))}
          </div>
        </div>
      ) : (
        <>
          {revokedOnPage > 0 && (
            <div className="flex items-center justify-end gap-2">
              <label
                htmlFor="share-show-revoked"
                className="text-xs font-normal text-muted-foreground"
              >
                {t('settings.shares.showRevoked', 'Show revoked ({{count}})', {
                  count: revokedOnPage,
                })}
              </label>
              <Switch
                id="share-show-revoked"
                checked={showRevoked}
                onCheckedChange={setShowRevoked}
              />
            </div>
          )}
          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('settings.shares.empty', 'No published shares.')}
            </p>
          )}
          {/* Container query, never a viewport breakpoint: settings render in a
              panel far narrower than the window. Two columns at most — these are
              conversation titles, and a third column truncates every one of them. */}
          <div className="@container">
            <ul className="grid grid-cols-1 gap-2 @[34rem]:grid-cols-2">
              {visible.map((entry) => {
                const isRevoked = entry.status !== 'active';
                const publishedAt = new Date(entry.createdAt);
                return (
                  <li
                    key={entry.shareId}
                    className={cn(
                      SETTINGS_ROW_CARD_CLASS,
                      'relative flex items-start gap-3 px-3 py-2.5 transition-colors',
                      'focus-within:border-ring/40 hover:bg-foreground/[0.02] dark:hover:bg-foreground/[0.04]'
                    )}
                  >
                    <SharePublisherAvatar
                      publisherUserId={entry.publisherUserId}
                      workspaceId={workspaceId}
                    />
                    <div className="min-w-0 flex-1">
                      {/* `after:inset-0` turns the whole card into this button's
                          hit area while keeping ONE focusable control per card. */}
                      <button
                        type="button"
                        onClick={() => setDetail(entry)}
                        className="block w-full text-left outline-hidden after:absolute after:inset-0 after:rounded-lg after:content-['']"
                      >
                        <span
                          className={cn(
                            'line-clamp-2 text-sm',
                            isRevoked && 'text-muted-foreground'
                          )}
                        >
                          {entry.title || t('sessions.untitled', 'Untitled session')}
                        </span>
                      </button>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <time
                          dateTime={publishedAt.toISOString()}
                          title={publishedAt.toLocaleString()}
                        >
                          {formatSharePublishedAt(publishedAt, now)}
                        </time>
                        {isRevoked && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{t('settings.shares.revoked', 'Revoked')}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          {/* Two permanently disabled buttons under a short list are pure chrome;
              paging only exists once there is somewhere to page to. */}
          {(cursors.length > 1 || !result.isDone) && (
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
          )}
        </>
      )}
      <ShareDetailDialog
        entry={detail}
        userId={userId}
        actions={actions}
        sourceSessionId={
          detail
            ? Object.values(meta).find((session) => session.id === detail.rootSessionId)?.id
            : undefined
        }
        onOpenSession={openSession}
        onUpdate={(entry) => {
          setDetail(null);
          setEditor(entry);
        }}
        onConfirm={(kind, entry) => {
          setDetail(null);
          setConfirmation({ kind, entry });
        }}
        onClose={() => setDetail(null)}
      />
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
                'The previous link will stop working. Downloaded copies cannot be recalled.'
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-xs text-foreground">{children}</span>
    </div>
  );
}

/**
 * Everything the card leaves out, plus the two destinations a share has: the
 * conversation it was made from, and the static copy it published. They are
 * named separately here because a row that offers both without saying so is
 * what made the old list unreadable.
 */
function ShareDetailDialog({
  entry,
  userId,
  actions,
  sourceSessionId,
  onOpenSession,
  onUpdate,
  onConfirm,
  onClose,
}: {
  entry: PublishedSessionShare | null;
  userId: string;
  actions: ReturnType<typeof useSessionShareLinkActions>;
  sourceSessionId?: SessionId;
  onOpenSession: (sessionId: SessionId) => void;
  onUpdate: (entry: PublishedSessionShare) => void;
  onConfirm: (kind: 'reset' | 'revoke', entry: PublishedSessionShare) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!entry) return null;
  const link = actions.linkFor(entry);
  const isRevoked = entry.status !== 'active';
  const publishedAt = new Date(entry.createdAt);
  const updatedAt = new Date(entry.updatedAt);
  const wasUpdated = entry.updatedAt - entry.createdAt > 1000;
  // Exactly two reasons the link is missing, and each has a different remedy,
  // so they are stated where the blocked action is rather than on the card.
  const linkNote = link
    ? null
    : isRevoked
      ? t('settings.shares.linkRevoked', 'This share has been revoked, so it has no live link.')
      : entry.publisherUserId === userId
        ? t(
            'settings.shares.linkOtherDevice',
            'The link was created in another browser and is only stored there. Reset the link to create a new one you can copy here.'
          )
        : t(
            'settings.shares.linkOtherPublisher',
            'Only the member who published this share holds its link.'
          );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 text-left text-base leading-snug">
            {entry.title || t('sessions.untitled', 'Untitled session')}
          </DialogTitle>
        </DialogHeader>
        <div className="divide-y divide-border/60">
          <DetailRow label={t('settings.shares.publishedAt', 'Published')}>
            {/* Y-M-D reads the same in every locale; the exact clock time stays
                reachable through the tooltip rather than cluttering the row. */}
            <time dateTime={publishedAt.toISOString()} title={publishedAt.toLocaleString()}>
              {formatYmd(publishedAt)}
            </time>
          </DetailRow>
          {wasUpdated && (
            <DetailRow label={t('settings.shares.updatedAt', 'Last updated')}>
              <time dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
                {formatYmd(updatedAt)}
              </time>
            </DetailRow>
          )}
          <DetailRow label={t('settings.shares.conversationsLabel', 'Conversations')}>
            {entry.conversationCount}
          </DetailRow>
          <DetailRow label={t('settings.shares.size', 'Size')}>
            {formatBytes(entry.totalBytes)}
          </DetailRow>
          <DetailRow label={t('settings.shares.statusLabel', 'Status')}>
            {isRevoked
              ? t('settings.shares.revoked', 'Revoked')
              : t('settings.shares.active', 'Active')}
          </DetailRow>
        </div>
        {linkNote && <p className="text-xs text-muted-foreground">{linkNote}</p>}
        <div className="flex flex-wrap gap-2">
          {link && (
            <Button size="sm" onClick={() => void openExternalUrl(link)}>
              {t('settings.shares.openPublished', 'Open published page')}
            </Button>
          )}
          {link && (
            <Button
              variant="outline"
              size="sm"
              disabled={actions.busy}
              onClick={() => void actions.copy(entry)}
            >
              {t('settings.shares.copy', 'Copy link')}
            </Button>
          )}
          {sourceSessionId && (
            <Button variant="outline" size="sm" onClick={() => onOpenSession(sourceSessionId)}>
              {t('settings.shares.openConversation', 'Open conversation')}
            </Button>
          )}
        </div>
        {(entry.canManage || entry.canRevoke) && (
          <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
            {entry.canManage && sourceSessionId && (
              <Button
                variant="outline"
                size="sm"
                disabled={actions.busy}
                onClick={() => onUpdate(entry)}
              >
                {t('sharing.static.update', 'Update deployment')}
              </Button>
            )}
            {entry.canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={actions.busy}
                onClick={() => onConfirm('reset', entry)}
              >
                {t('sharing.static.reset', 'Reset link')}
              </Button>
            )}
            {entry.canRevoke && (
              <Button
                variant="outline"
                size="sm"
                disabled={actions.busy}
                className="text-destructive hover:text-destructive"
                onClick={() => onConfirm('revoke', entry)}
              >
                {t('sharing.static.revoke', 'Revoke')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
