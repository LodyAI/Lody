import { ReferralDetailsDialog, ReferralSettingsView } from './referral-settings-pure';
import { useEffect, useRef, useState } from 'react';
import { usePostHog } from '@posthog/react';
import { hashAnalyticsId } from '@lody/shared';
import { useAppCapability } from '@/lib/app-platform';
import { captureReferralEvent } from '@/lib/referral-analytics';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { ErrorBoundary } from '@/components/error-boundary';

const PAGE_SIZE = 10;
const COPIED_MS = 2000;

export function ReferralSettings(props: { workspaceId: string; canManage: boolean }) {
  return (
    <ErrorBoundary name="ReferralSettings" variant="inline">
      <ReferralSettingsContainer {...props} />
    </ErrorBoundary>
  );
}

/** A native share sheet is offered only where sharing is the platform's habit. */
function canNativeShare() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(pointer: coarse)').matches === true
  );
}

function ReferralSettingsContainer({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const telemetry = useAppCapability('telemetry');
  const viewedWorkspace = useRef<string | null>(null);
  const overview = useCloudQuery(cloudOperations.referrals.getOverview, { workspaceId });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  // History is read only while its dialog is open.
  const ledger = useCloudQuery(
    cloudOperations.referrals.listLedger,
    detailsOpen
      ? { workspaceId, paginationOpts: { numItems: PAGE_SIZE, cursor: cursors.at(-1) ?? null } }
      : 'skip'
  );
  const createLink = useCloudMutation(cloudOperations.referrals.createLink);
  const [linkPending, setLinkPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const visible =
    !!overview &&
    (overview.eligible ||
      overview.code !== null ||
      overview.issued > 0 ||
      overview.spent > 0 ||
      overview.adjustment > 0);
  useEffect(() => {
    if (!telemetry || !visible || viewedWorkspace.current === workspaceId) return;
    viewedWorkspace.current = workspaceId;
    captureReferralEvent(postHog, 'viewed', { workspace_id: workspaceId, can_manage: canManage });
  }, [telemetry, visible, workspaceId, canManage, postHog]);
  const capture = (
    event: 'link_copied' | 'link_shared' | 'details_viewed',
    code = overview?.code
  ) => {
    if (telemetry)
      captureReferralEvent(postHog, event, {
        workspace_id: workspaceId,
        ...(code ? { referral_code_hash: hashAnalyticsId(code) } : {}),
      });
  };

  // `null` = the workspace cannot be read: nothing to show.
  if (overview === null) return null;
  const view = overview;
  const url = view?.url ?? null;
  const copy = (value: string) =>
    // Started inside the click, before any await, so browsers keep the gesture.
    writeTextToClipboard(value).then((ok) => {
      if (ok) {
        setCopied(true);
        capture('link_copied');
      } else toast.error(t('referral.copyFailed'));
      return ok;
    });

  return (
    <>
      <ReferralSettingsView
        overview={view}
        onOpenDetails={() => {
          setDetailsOpen(true);
          capture('details_viewed');
        }}
        canManage={canManage}
        linkPending={linkPending}
        copied={copied}
        onCopy={() => {
          if (url) {
            void copy(url);
            return;
          }
          setLinkPending(true);
          void (async () => {
            try {
              const created = await createLink({ workspaceId });
              // The link now shows in its field; copying after a round trip may be refused.
              if (await writeTextToClipboard(created.url)) {
                setCopied(true);
                capture('link_copied', created.code);
                toast.success(t('referral.createdCopied'));
              }
            } catch {
              toast.error(t('referral.createFailed'));
            } finally {
              setLinkPending(false);
            }
          })();
        }}
        onShare={
          url && canNativeShare()
            ? () => {
                void navigator
                  .share({ title: t('referral.shareTitle'), url })
                  .then(() => capture('link_shared'))
                  .catch(() => {
                    /* Dismissing the share sheet is not an error. */
                  });
              }
            : undefined
        }
      />
      {detailsOpen && view ? (
        <ReferralDetailsDialog
          overview={view}
          entries={ledger?.page}
          onClose={() => {
            setDetailsOpen(false);
            setCursors([null]);
          }}
          onNewer={cursors.length > 1 ? () => setCursors((value) => value.slice(0, -1)) : undefined}
          onOlder={
            ledger && !ledger.isDone
              ? () => setCursors((value) => [...value, ledger.continueCursor])
              : undefined
          }
        />
      ) : null}
    </>
  );
}
