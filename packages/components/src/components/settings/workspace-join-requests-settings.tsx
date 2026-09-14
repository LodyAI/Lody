import { useState } from 'react';
import { Check, Copy, Link2, RotateCw, X } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getAppShareUrl } from '@/lib/app-location';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

export function WorkspaceJoinRequestsSettings({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const state = useCloudQuery(cloudOperations.workspaceJoinRequests.getOwnerState, {
    workspaceId,
  });
  const rotateLink = useCloudMutation(cloudOperations.workspaceJoinRequests.rotateLink);
  const revokeLink = useCloudMutation(cloudOperations.workspaceJoinRequests.revokeLink);
  const reviewRequest = useCloudMutation(cloudOperations.workspaceJoinRequests.reviewRequest);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expiresInDays, setExpiresInDays] = useState('30');
  const activeLink = state?.activeLink ?? null;
  const joinUrl = activeLink ? getAppShareUrl(`/join/${activeLink.token}`) : null;
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusyAction(key);
    try {
      await action();
    } catch (error) {
      console.error('Workspace join request action failed:', error);
      toast.error(t('joinRequest.admin.actionFailed', 'Could not update join requests.'));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border/50 px-3 py-3">
        <div>
          <h3 className="text-sm font-medium">{t('joinRequest.admin.title', 'Open join link')}</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(
              'joinRequest.admin.description',
              'People can request access; only you can approve them.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={expiresInDays} onValueChange={setExpiresInDays}>
            <SelectTrigger
              className="h-8 w-[5.5rem] text-xs"
              aria-label={t('joinRequest.admin.expiration', 'Link expiration')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[7, 30, 90].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t('joinRequest.admin.days', '{{count}} days', { count: days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={activeLink ? 'ghost' : 'default'}
            disabled={busyAction !== null}
            onClick={() =>
              void run('rotate', () =>
                rotateLink({ workspaceId, expiresInDays: Number(expiresInDays) })
              )
            }
          >
            {busyAction === 'rotate' ? (
              <Spinner className="mr-1.5 h-3.5 w-3.5" />
            ) : activeLink ? (
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {activeLink
              ? t('joinRequest.admin.regenerate', 'Regenerate')
              : t('joinRequest.admin.create', 'Create link')}
          </Button>
        </div>
      </div>

      {activeLink && joinUrl ? (
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{joinUrl}</code>
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
            {t('joinRequest.admin.expires', 'Expires {{date}}', {
              date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                new Date(activeLink.expiresAt)
              ),
            })}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t('joinRequest.admin.copy', 'Copy link')}
            onClick={() => {
              void navigator.clipboard
                .writeText(joinUrl)
                .then(() => toast.success(t('joinRequest.admin.copied', 'Link copied.')));
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={busyAction !== null}
            onClick={() =>
              void run('revoke', () => revokeLink({ workspaceId, linkId: activeLink.id }))
            }
          >
            {t('joinRequest.admin.disable', 'Disable')}
          </Button>
        </div>
      ) : null}

      {!state ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" />
          {t('joinRequest.admin.loading', 'Loading requests…')}
        </div>
      ) : state.pendingRequests.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          {t('joinRequest.admin.empty', 'No pending requests.')}
        </div>
      ) : (
        <>
          {state.pendingRequests.map((request) => (
            <div key={request.id} className="border-t border-border/50 px-3 py-3 first:border-t-0">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{request.applicantName}</p>
                  <p className="truncate text-xs text-muted-foreground">{request.applicantEmail}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('joinRequest.admin.requestedAt', 'Requested {{date}}', {
                      date: dateTimeFormatter.format(new Date(request.createdAt)),
                    })}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-foreground/85">
                    {request.reason}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    aria-label={t('joinRequest.admin.reject', 'Reject')}
                    disabled={busyAction !== null}
                    onClick={() =>
                      void run(`reject:${request.id}`, () =>
                        reviewRequest({ requestId: request.id, decision: 'rejected' })
                      )
                    }
                  >
                    {busyAction === `reject:${request.id}` ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t('joinRequest.admin.approve', 'Approve')}
                    disabled={busyAction !== null}
                    onClick={() =>
                      void run(`approve:${request.id}`, () =>
                        reviewRequest({ requestId: request.id, decision: 'approved' })
                      )
                    }
                  >
                    {busyAction === `approve:${request.id}` ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {state.hasMorePendingRequests ? (
            <p className="border-t border-border/50 px-3 py-2.5 text-xs text-muted-foreground">
              {t(
                'joinRequest.admin.morePending',
                'Showing the oldest 100 requests. Review them to reveal more.'
              )}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
