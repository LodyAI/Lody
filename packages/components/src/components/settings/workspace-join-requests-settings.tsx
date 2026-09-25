import { useState, type ReactNode } from 'react';
import { Check, Copy, Link2, RotateCw, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getAppShareUrl } from '@/lib/app-location';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  /** The link line: the link and when it expires, then what sets and clears it. */
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  link: {
    display: 'flex',
    flexGrow: 1,
    flexBasis: '12rem',
    alignItems: 'baseline',
    gap: space[2],
    minWidth: 0,
  },
  url: {
    minWidth: 0,
    flexGrow: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  expires: {
    display: { default: 'none', [WIDE]: 'inline' },
    flexShrink: 0,
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  controls: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[2] },
  expiry: { width: '6.5rem', flexShrink: 0 },
  actions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1] },
  note: { display: 'flex', alignItems: 'center', gap: space[2] },
  request: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  requestText: { flexGrow: 1, minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  name: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: 1.25,
    color: colors.label,
  },
  meta: { margin: 0, fontSize: '0.8em', lineHeight: 1.375, color: colors.secondaryLabel },
  reason: {
    margin: 0,
    marginTop: space[2],
    whiteSpace: 'pre-wrap',
    fontSize: '0.875em',
    lineHeight: 1.43,
    color: colors.label,
  },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  /** An icon-only button draws the glyph's box; the glyph fills it. */
  glyph: { width: '100%', height: '100%' },
});

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

  const expiryControl = (
    <div {...stylex.props(styles.controls)}>
      {/* The trigger's well is as wide as what holds it, so the holder sets the width. */}
      <div {...stylex.props(styles.expiry)}>
        <Select.Root
          items={[7, 30, 90].map((days) => ({
            value: String(days),
            label: t('joinRequest.admin.days', '{{count}} days', { count: days }),
          }))}
          value={expiresInDays}
          onValueChange={(value) => {
            if (value != null) setExpiresInDays(value);
          }}
        >
          <Select.Trigger
            size="small"
            aria-label={t('joinRequest.admin.expiration', 'Link expiration')}
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {[7, 30, 90].map((days) => (
              <Select.Item key={days} value={String(days)}>
                {t('joinRequest.admin.days', '{{count}} days', { count: days })}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
      <Button
        variant="secondary"
        size="small"
        disabled={busyAction !== null}
        onClick={() =>
          void run('rotate', () =>
            rotateLink({ workspaceId, expiresInDays: Number(expiresInDays) })
          )
        }
      >
        {busyAction === 'rotate' ? (
          <Spinner size="small" />
        ) : activeLink ? (
          <RotateCw {...stylex.props(styles.icon)} />
        ) : (
          <Link2 {...stylex.props(styles.icon)} />
        )}
        {activeLink
          ? t('joinRequest.admin.regenerate', 'Regenerate')
          : t('joinRequest.admin.create', 'Create link')}
      </Button>
    </div>
  );

  // The section rules every child as a line of one card, so each line is its
  // own element here rather than a fragment of several.
  const lines: ReactNode[] = [
    <div key="link" {...stylex.props(styles.row)}>
      {activeLink && joinUrl ? (
        <div {...stylex.props(styles.link)}>
          <code {...stylex.props(styles.url)}>{joinUrl}</code>
          <span {...stylex.props(styles.expires)}>
            {t('joinRequest.admin.expires', 'Expires {{date}}', {
              date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                new Date(activeLink.expiresAt)
              ),
            })}
          </span>
        </div>
      ) : (
        <div {...stylex.props(styles.link)} />
      )}
      {expiryControl}
      {activeLink && joinUrl ? (
        <div {...stylex.props(styles.actions)}>
          <Button
            variant="ghost"
            aria-label={t('joinRequest.admin.copy', 'Copy link')}
            size="small"
            icon
            onClick={() => {
              void navigator.clipboard
                .writeText(joinUrl)
                .then(() => toast.success(t('joinRequest.admin.copied', 'Link copied.')));
            }}
          >
            <Copy {...stylex.props(styles.glyph)} />
          </Button>
          <Button
            variant="ghost"
            size="small"
            tone="destructive"
            disabled={busyAction !== null}
            onClick={() =>
              void run('revoke', () => revokeLink({ workspaceId, linkId: activeLink.id }))
            }
          >
            {t('joinRequest.admin.disable', 'Disable')}
          </Button>
        </div>
      ) : null}
    </div>,
  ];

  if (!state) {
    lines.push(
      <p key="loading" {...stylex.props(surface.cardNote, styles.note)}>
        <Spinner size="small" />
        {t('joinRequest.admin.loading', 'Loading requests…')}
      </p>
    );
  } else if (state.pendingRequests.length === 0) {
    lines.push(
      <p key="empty" {...stylex.props(surface.cardNote)}>
        {t('joinRequest.admin.empty', 'No pending requests.')}
      </p>
    );
  } else {
    for (const request of state.pendingRequests) {
      lines.push(
        <div key={request.id} {...stylex.props(styles.request)}>
          <div {...stylex.props(styles.requestText)}>
            <p {...stylex.props(styles.name)}>{request.applicantName}</p>
            <p {...stylex.props(styles.meta, styles.truncate)}>{request.applicantEmail}</p>
            <p {...stylex.props(styles.meta)}>
              {t('joinRequest.admin.requestedAt', 'Requested {{date}}', {
                date: dateTimeFormatter.format(new Date(request.createdAt)),
              })}
            </p>
            <p {...stylex.props(styles.reason)}>{request.reason}</p>
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button
              variant="ghost"
              aria-label={t('joinRequest.admin.reject', 'Reject')}
              size="small"
              icon
              tone="destructive"
              disabled={busyAction !== null}
              onClick={() =>
                void run(`reject:${request.id}`, () =>
                  reviewRequest({ requestId: request.id, decision: 'rejected' })
                )
              }
            >
              {busyAction === `reject:${request.id}` ? (
                <Spinner size="small" />
              ) : (
                <X {...stylex.props(styles.glyph)} />
              )}
            </Button>
            <Button
              variant="ghost"
              aria-label={t('joinRequest.admin.approve', 'Approve')}
              size="small"
              icon
              disabled={busyAction !== null}
              onClick={() =>
                void run(`approve:${request.id}`, () =>
                  reviewRequest({ requestId: request.id, decision: 'approved' })
                )
              }
            >
              {busyAction === `approve:${request.id}` ? (
                <Spinner size="small" />
              ) : (
                <Check {...stylex.props(styles.glyph)} />
              )}
            </Button>
          </div>
        </div>
      );
    }
    if (state.hasMorePendingRequests) {
      lines.push(
        <p key="more" {...stylex.props(surface.cardNote)}>
          {t(
            'joinRequest.admin.morePending',
            'Showing the oldest 100 requests. Review them to reveal more.'
          )}
        </p>
      );
    }
  }

  return (
    <CompactSection
      title={t('joinRequest.admin.title', 'Open join link')}
      description={t(
        'joinRequest.admin.description',
        'People can request access; only you can approve them.'
      )}
    >
      {lines}
    </CompactSection>
  );
}
