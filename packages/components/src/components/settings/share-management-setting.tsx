import { useCallback, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
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
import { AlertDialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Popover } from '@lody/ui/popover';
import { Skeleton } from '@lody/ui/skeleton';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

const styles = stylex.create({
  lead: { margin: 0, fontSize: type.caption, color: colors.secondaryLabel },
  notice: { margin: 0, fontSize: type.caption, color: colors.label },
  error: { margin: 0, fontSize: type.caption, color: colors.destructive },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: space[2] },
  toggleLabel: { fontSize: type.caption, color: colors.secondaryLabel },
  /**
   * One share: the publisher's face, the title and when it was published. The
   * row is the hit area of its title button, through the button's `::after`.
   */
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '8px',
  },
  body: { flexGrow: 1, minWidth: 0 },
  /** The title button: one focusable control per row, its hit area the whole row. */
  open: {
    display: 'block',
    width: '100%',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outline: 'none',
    borderRadius: radius.mini,
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    '::after': { content: '""', position: 'absolute', inset: 0 },
  },
  title: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    fontSize: type.caption,
    color: colors.label,
  },
  titleRevoked: { color: colors.secondaryLabel },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    margin: 0,
    marginTop: '2px',
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  /** Above the row's hit area, so the face opens its own popover. */
  avatarTrigger: {
    position: 'relative',
    zIndex: 1,
    display: 'block',
    flexShrink: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    borderRadius: radius.full,
    cursor: 'pointer',
    outline: 'none',
    opacity: { default: 1, ':hover': 0.85 },
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
  },
  avatarStatic: { flexShrink: 0 },
  profile: { display: 'flex', alignItems: 'center', gap: space[3], width: '232px' },
  profileText: { minWidth: 0 },
  profileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    fontWeight: type.headingWeight,
    color: colors.label,
  },
  profileEmail: {
    marginTop: '2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    color: colors.secondaryLabel,
  },
  skeletonBody: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: space[2],
    minWidth: 0,
    paddingBlock: '2px',
  },
  /** The dialog's facts: label on the left, value on the right, ruled between. */
  detailRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
    paddingBlock: space[1.5],
    fontSize: '12px',
  },
  detailLabel: { flexShrink: 0, color: colors.secondaryLabel },
  detailValue: { minWidth: 0, textAlign: 'end', color: colors.label },
  linkNote: { margin: 0, fontSize: '12px', color: colors.secondaryLabel },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  list: { margin: 0, padding: 0, listStyleType: 'none' },
});

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
  const avatar = <UserAvatar user={user} size="large" />;
  if (!displayName) return <div {...stylex.props(styles.avatarStatic)}>{avatar}</div>;
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <button
            type="button"
            // The row behind this avatar is itself one big click target, so the
            // profile must not also open the detail dialog.
            onClick={(event) => event.stopPropagation()}
            title={displayName}
            aria-label={t('settings.shares.publisherProfile', 'View profile for {{name}}', {
              name: displayName,
            })}
            {...stylex.props(styles.avatarTrigger)}
          >
            {avatar}
          </button>
        }
      />
      <Popover.Content side="right" align="start" sideOffset={10}>
        <div {...stylex.props(styles.profile)}>
          <UserAvatar user={user} size="xlarge" />
          <div {...stylex.props(styles.profileText)}>
            <div {...stylex.props(styles.profileName)}>{displayName}</div>
            {user?.email ? (
              <div {...stylex.props(styles.profileEmail)} title={user.email}>
                {user.email}
              </div>
            ) : null}
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

function ShareRowSkeleton() {
  return (
    <div {...stylex.props(styles.row)}>
      <Skeleton shape="circle" width={32} height={32} />
      <div {...stylex.props(styles.skeletonBody)}>
        <Skeleton width="70%" height={14} />
        <Skeleton width={64} height={12} />
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
    <div {...stylex.props(surface.container)}>
      <p {...stylex.props(styles.lead)}>
        {t(
          'settings.shares.description',
          'Static copies you have published. Admins see every share in the workspace.'
        )}
      </p>
      {actions.notice && (
        <p role="status" {...stylex.props(styles.notice)}>
          {actions.notice}
        </p>
      )}
      {actions.error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {actions.error}
        </p>
      )}
      {result === undefined ? (
        <div {...stylex.props(surface.card)}>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
              <ShareRowSkeleton />
            </div>
          ))}
        </div>
      ) : (
        <>
          {revokedOnPage > 0 && (
            <div {...stylex.props(styles.toolbar)}>
              <label htmlFor="share-show-revoked" {...stylex.props(styles.toggleLabel)}>
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
            <div {...stylex.props(catalog.empty)}>
              <p {...stylex.props(catalog.emptyText)}>
                {t('settings.shares.empty', 'No published shares.')}
              </p>
            </div>
          )}
          {/* One card of ruled rows: a list of records is one surface, and a
              title keeps the card's whole width instead of a column of it. */}
          {visible.length > 0 && (
            <ul {...stylex.props(surface.card, styles.list)}>
              {visible.map((entry, index) => {
                const isRevoked = entry.status !== 'active';
                const publishedAt = new Date(entry.createdAt);
                return (
                  <li
                    key={entry.shareId}
                    {...stylex.props(
                      surface.line,
                      index > 0 && surface.lineRuled,
                      surface.pressableLine,
                      styles.row
                    )}
                  >
                    <SharePublisherAvatar
                      publisherUserId={entry.publisherUserId}
                      workspaceId={workspaceId}
                    />
                    <div {...stylex.props(styles.body)}>
                      {/* The button's `::after` turns the whole row into its hit
                          area while keeping ONE focusable control per row. */}
                      <button
                        type="button"
                        onClick={() => setDetail(entry)}
                        {...stylex.props(styles.open)}
                      >
                        <span {...stylex.props(styles.title, isRevoked && styles.titleRevoked)}>
                          {entry.title || t('sessions.untitled', 'Untitled session')}
                        </span>
                      </button>
                      <p {...stylex.props(styles.meta)}>
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
          )}
          {/* Two permanently disabled buttons under a short list are pure chrome;
              paging only exists once there is somewhere to page to. */}
          {(cursors.length > 1 || !result.isDone) && (
            <div {...stylex.props(styles.toolbar)}>
              <Button
                variant="secondary"
                size="small"
                disabled={cursors.length === 1}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                {t('settings.shares.previous', 'Previous')}
              </Button>
              <Button
                variant="secondary"
                size="small"
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
      <AlertDialog.Root
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {confirmation?.kind === 'reset'
                ? t('sharing.static.reset', 'Reset link')
                : t('sharing.static.revoke', 'Revoke')}
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
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

function DetailRow({
  label,
  ruled,
  children,
}: {
  label: string;
  /** Every row but the first is ruled from the one above. */
  ruled: boolean;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.detailRow, ruled && surface.lineRuled)}>
      <span {...stylex.props(styles.detailLabel)}>{label}</span>
      <span {...stylex.props(styles.detailValue)}>{children}</span>
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
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{entry.title || t('sessions.untitled', 'Untitled session')}</Dialog.Title>
        </Dialog.Header>
        <div>
          <DetailRow ruled={false} label={t('settings.shares.publishedAt', 'Published')}>
            {/* Y-M-D reads the same in every locale; the exact clock time stays
                reachable through the tooltip rather than cluttering the row. */}
            <time dateTime={publishedAt.toISOString()} title={publishedAt.toLocaleString()}>
              {formatYmd(publishedAt)}
            </time>
          </DetailRow>
          {wasUpdated && (
            <DetailRow ruled label={t('settings.shares.updatedAt', 'Last updated')}>
              <time dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
                {formatYmd(updatedAt)}
              </time>
            </DetailRow>
          )}
          <DetailRow ruled label={t('settings.shares.conversationsLabel', 'Conversations')}>
            {entry.conversationCount}
          </DetailRow>
          <DetailRow ruled label={t('settings.shares.size', 'Size')}>
            {formatBytes(entry.totalBytes)}
          </DetailRow>
          <DetailRow ruled label={t('settings.shares.statusLabel', 'Status')}>
            {isRevoked
              ? t('settings.shares.revoked', 'Revoked')
              : t('settings.shares.active', 'Active')}
          </DetailRow>
        </div>
        {linkNote && <p {...stylex.props(styles.linkNote)}>{linkNote}</p>}
        <div {...stylex.props(styles.actions)}>
          {link && (
            <Button size="small" onClick={() => void openExternalUrl(link)}>
              {t('settings.shares.openPublished', 'Open published page')}
            </Button>
          )}
          {link && (
            <Button
              variant="secondary"
              size="small"
              disabled={actions.busy}
              onClick={() => void actions.copy(entry)}
            >
              {t('settings.shares.copy', 'Copy link')}
            </Button>
          )}
          {sourceSessionId && (
            <Button variant="secondary" size="small" onClick={() => onOpenSession(sourceSessionId)}>
              {t('settings.shares.openConversation', 'Open conversation')}
            </Button>
          )}
        </div>
        {(entry.canManage || entry.canRevoke) && (
          <div {...stylex.props(styles.actions)}>
            {entry.canManage && sourceSessionId && (
              <Button
                variant="secondary"
                size="small"
                disabled={actions.busy}
                onClick={() => onUpdate(entry)}
              >
                {t('sharing.static.update', 'Update deployment')}
              </Button>
            )}
            {entry.canManage && (
              <Button
                variant="secondary"
                size="small"
                disabled={actions.busy}
                onClick={() => onConfirm('reset', entry)}
              >
                {t('sharing.static.reset', 'Reset link')}
              </Button>
            )}
            {entry.canRevoke && (
              <Button
                variant="secondary"
                size="small"
                tone="destructive"
                disabled={actions.busy}
                onClick={() => onConfirm('revoke', entry)}
              >
                {t('sharing.static.revoke', 'Revoke')}
              </Button>
            )}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
