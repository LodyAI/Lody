import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BlockingWaitPlaceholder } from '@/components/blocking-wait-placeholder';
import { preloadMainLayout } from '@/components/preloaded-main-layout';

/**
 * The workspace whose data scope was last ready under the mounted authed
 * layout, and the account it was ready for. Module-level on purpose: the wait
 * renders before the layout's own state survives a switch. Forgotten when that
 * layout unmounts (sign-out, leaving the workspace routes): there is then no
 * layout to keep, and the next wait is a cold one.
 */
let lastReady: { slug: string; accountId: string | null } | null = null;

export type WorkspaceDataWaitKind = 'cold-start' | 'reload' | 'switch';

export function resolveWorkspaceDataWaitKind(
  targetSlug: string,
  accountId: string | null
): WorkspaceDataWaitKind {
  if (lastReady === null || lastReady.accountId !== accountId) return 'cold-start';
  return lastReady.slug === targetSlug ? 'reload' : 'switch';
}

/** Record the workspace whose data scope just became ready, for this account. */
export function useRecordWorkspaceDataReady(
  readySlug: string | null,
  accountId: string | null
): void {
  useEffect(() => {
    if (readySlug) lastReady = { slug: readySlug, accountId };
  }, [accountId, readySlug]);
  useEffect(
    () => () => {
      lastReady = null;
    },
    []
  );
}

export function resetWorkspaceDataReadyForTests(): void {
  lastReady = null;
}

/**
 * The wait while a workspace's data scope is not ready. A cold start (an app
 * launch, or a WebView the OS reloaded) continues the boot shell: nothing was
 * open, so there is no workspace to switch from and no layout to keep. Only a
 * real switch says "Switching workspace"; the caller keeps the layout mounted
 * around the pane variants.
 */
export function WorkspaceDataWait({ kind }: { kind: WorkspaceDataWaitKind }) {
  const { t } = useTranslation();

  useEffect(() => {
    if (kind !== 'cold-start') return;
    // The layout mounts only once data is ready; fetch its chunk meanwhile.
    void preloadMainLayout().catch(() => undefined);
  }, [kind]);

  if (kind === 'switch') {
    return (
      <BlockingWaitPlaceholder
        gate="workspace_data"
        variant="content"
        title={t('workspace.route.switchingTitle')}
        description={t('workspace.route.switchingDescription')}
      />
    );
  }
  return (
    <BlockingWaitPlaceholder
      gate="workspace_data"
      variant={kind === 'cold-start' ? 'boot' : 'content'}
      title={t('workspace.route.loadingTitle')}
    />
  );
}
