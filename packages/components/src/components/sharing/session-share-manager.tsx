import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionShareManagement, SessionShareManagementEntry } from '@lody/cloud-api';
import { SESSION_SHARE_MAX_TARGETS } from '@lody/shared/session-sharing';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { cn } from '@/lib/utils';
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
export type SessionShareManagerProps = {
  sessionId: string;
  state: SessionShareManagement | undefined;
  candidates: ShareCandidate[];
  selected: string[];
  copyableShareIds: string[];
  now: number;
  busy: boolean;
  conflict: boolean;
  error: string | null;
  notice: string | null;
  onSelect: (ids: string[]) => void;
  onReload: () => void;
  onCreate: () => void;
  onSave: () => void;
  onReset: () => void;
  onCopy: (entry: SessionShareManagementEntry) => void;
  onRevoke: (entry: SessionShareManagementEntry) => void;
};

/**
 * Controlled, responsive management UI shared by Web, Electron and Mobile.
 *
 * One vertical read: what the link is and does, what it covers, then the
 * actions. Sub-conversations are one switch rather than a checklist, so the
 * author makes a single decision instead of auditing a list. The stored grant is
 * still an explicit id set, so the switch means "the sub-conversations that
 * exist and are ready now" — later ones are never added on their own, and the
 * copy says so. The action row sticks to the bottom of the dialog's scrolling
 * body so the primary action stays reachable on a phone.
 */
export function SessionShareManager(props: SessionShareManagerProps) {
  const { t } = useTranslation();
  const [confirmation, setConfirmation] = useState<
    | { kind: 'reset'; version: string }
    | { kind: 'revoke'; entry: SessionShareManagementEntry }
    | null
  >(null);
  const { state, selected, busy, now } = props;
  const root = state?.root;
  const rootVersion = root
    ? `${root.shareId}:${root.scopeVersion}:${root.credentialVersion}`
    : 'new';
  const canManage = !root || root.canManage;
  const rootLive = root?.status === 'active' && (root.validUntil ?? 0) > now;
  const hasSecret = !!root && props.copyableShareIds.includes(root.shareId);
  const eligible = (id: string) =>
    state?.candidates.some(
      (entry) => entry.sessionId === id && entry.available && (entry.validUntil ?? 0) > now
    ) ?? false;
  const qualified = selected.every(eligible) && selected.includes(props.sessionId);
  const changed =
    !!root &&
    (selected.length !== root.sessionIds.length ||
      selected.some((id, index) => id !== root.sessionIds[index]));
  const mutationDisabled = busy || props.conflict || !qualified;
  const candidateMap = new Map(props.candidates.map((entry) => [entry.sessionId, entry]));
  // Discovery order is deterministic, so the capped set is stable across renders.
  const children = [...new Set([...selected, ...candidateMap.keys()])].filter(
    (id) => id !== props.sessionId
  );
  const readyChildren = children.filter(eligible);
  const shareableChildren = readyChildren.slice(0, SESSION_SHARE_MAX_TARGETS - 1);
  const truncatedChildren = readyChildren.length > shareableChildren.length;
  // An existing grant may still list a target that has since become unavailable;
  // the switch reads as on so turning it off is what repairs the selection.
  const sharesChildren = selected.some((id) => id !== props.sessionId);
  const rootReady = eligible(props.sessionId);
  const status = rootLive
    ? t('sharing.manager.active', 'Link active')
    : root?.status === 'revoked'
      ? t('sharing.manager.revoked', 'Link revoked')
      : root
        ? t('sharing.manager.unavailable', 'Link is currently unavailable')
        : t('sharing.manager.noLink', 'No share link yet');
  const messages = [
    props.error !== null ? { role: 'alert' as const, text: props.error, bad: true } : null,
    props.notice !== null ? { role: 'status' as const, text: props.notice, bad: false } : null,
  ].flatMap((entry) => (entry ? [entry] : []));

  return (
    <div className="text-sm" aria-busy={busy}>
      {props.conflict && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/60 px-4 py-2.5 text-xs sm:px-5"
        >
          <p className="min-w-0 leading-5">
            {t('sharing.manager.conflict', 'Sharing changed on another device.')}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onReload}>
            {t('sharing.manager.reload', 'Reload selection')}
          </Button>
        </div>
      )}
      <div className="space-y-5 px-4 py-4 sm:px-5">
        {!state ? (
          <p role="status" className="text-muted-foreground">
            {t('sharing.manager.loading', 'Loading sharing settings…')}
          </p>
        ) : (
          <>
            <section className="rounded-lg border border-border px-3 py-2.5">
              {/* Wraps rather than truncates: a narrow phone must never shorten
                  the link's state to make room for its own buttons. */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p className="flex min-w-0 items-center gap-2 font-medium">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      rootLive ? 'bg-emerald-500' : 'bg-muted-foreground/50'
                    )}
                  />
                  <span className="truncate">{status}</span>
                </p>
                {root && (rootLive || root.canRevoke) && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {rootLive && hasSecret && (
                      <Button size="sm" disabled={busy} onClick={() => props.onCopy(root)}>
                        {t('sharing.manager.copy', 'Copy share link')}
                      </Button>
                    )}
                    {root.canRevoke && root.status === 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={busy}
                        onClick={() => setConfirmation({ kind: 'revoke', entry: root })}
                      >
                        {t('sharing.manager.revoke', 'Revoke link')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {t(
                  'sharing.manager.disclosure',
                  'Anyone with the link reads the full conversation and its later updates. Links can be forwarded.'
                )}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(
                  'sharing.manager.publicPreview',
                  'Link previews publicly display the conversation title.'
                )}
              </p>
              {root?.status === 'active' && root.canManage && !hasSecret && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {t(
                    'sharing.manager.missingSecret',
                    'No link secret on this device. Reset to copy a new link.'
                  )}
                </p>
              )}
            </section>
            {canManage && children.length > 0 && (
              <section className="rounded-lg border border-border px-3 py-2.5">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="font-medium">
                    {t('sharing.manager.includeChildren', 'Include sub-conversations')}
                  </span>
                  <Switch
                    className="shrink-0"
                    checked={sharesChildren}
                    disabled={busy || props.conflict || shareableChildren.length === 0}
                    onCheckedChange={(value) =>
                      props.onSelect(
                        value ? [props.sessionId, ...shareableChildren] : [props.sessionId]
                      )
                    }
                  />
                </label>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {shareableChildren.length === 0
                    ? t('sharing.manager.childrenNotReady', 'None are synced to the cloud yet.')
                    : t(
                        'sharing.manager.childrenReady',
                        '{{count}} ready now · new ones are not added automatically',
                        { count: shareableChildren.length }
                      )}
                </p>
                {truncatedChildren && (
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {t(
                      'sharing.manager.childrenLimit',
                      'Limited to {{count}} (max {{max}} per link).',
                      { max: SESSION_SHARE_MAX_TARGETS, count: shareableChildren.length }
                    )}
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {/* Results and actions stay pinned to the body's bottom so neither is
          scrolled out of reach on a phone. */}
      {state && (canManage || messages.length > 0) && (
        <div className="sticky bottom-0 space-y-3 border-t border-border bg-background px-4 py-3 sm:px-5">
          {canManage && !rootReady && (
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
                'sharing.manager.rootNotReady',
                'Not synced to the cloud yet, so it cannot be shared.'
              )}
            </p>
          )}
          {messages.map((message) => (
            <p
              key={message.role}
              role={message.role}
              className={cn(
                'text-xs leading-5',
                message.bad ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {message.text}
            </p>
          ))}
          {canManage && (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {!root ? (
                <Button disabled={mutationDisabled} onClick={props.onCreate}>
                  {t('sharing.manager.create', 'Create share link')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={mutationDisabled}
                    onClick={() => setConfirmation({ kind: 'reset', version: rootVersion })}
                  >
                    {t('sharing.manager.reset', 'Reset link')}
                  </Button>
                  {/* Only appears once the switch has actually changed something,
                      so a conversation with nothing to change shows no dead control. */}
                  {root.status === 'active' && changed && (
                    <Button
                      disabled={mutationDisabled || !rootLive || !hasSecret}
                      onClick={props.onSave}
                    >
                      {t('sharing.manager.save', 'Save changes')}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {confirmation && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmation(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmation.kind === 'reset'
                  ? t('sharing.manager.reset', 'Reset link')
                  : t('sharing.manager.revoke', 'Revoke link')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation.kind === 'reset'
                  ? t(
                      'sharing.manager.confirmReset',
                      'The old link stops working and a new one replaces it.'
                    )
                  : t(
                      'sharing.manager.confirmRevoke',
                      'The link stops working. Already downloaded content is unaffected.'
                    )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                {t('sharing.manager.cancel', 'Cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  busy ||
                  props.conflict ||
                  (confirmation.kind === 'reset' &&
                    (mutationDisabled || confirmation.version !== rootVersion))
                }
                onClick={() => {
                  const action = confirmation;
                  setConfirmation(null);
                  if (action.kind === 'reset') props.onReset();
                  else props.onRevoke(action.entry);
                }}
              >
                {t('sharing.manager.confirm', 'Confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
