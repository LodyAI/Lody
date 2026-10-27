import { notifyE2eeLedgerChanged } from '../../../providers/e2ee-runtime-notifications';
import { useEffect, useState } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { usePlatformSession, usePlatform } from '@lody/platform/react';
import type { E2eeManagementState } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
const refreshAtom = atom(0);
const styles = stylex.create({
  icon: { position: 'relative', display: 'inline-flex', width: '100%', height: '100%' },
  dot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: '50%',
    top: 0,
    right: 0,
    backgroundColor: colors.destructive,
  },
});

/** Poll only native verified facts, scoped to the routed encrypted workspace/account. */
export function useSecurityState() {
  const mode = useAtomValue(workspaceContentModeAtom);
  const session = usePlatformSession();
  const native = usePlatform().e2eeWorkspaces?.runtime;
  const revision = useAtomValue(refreshAtom),
    bump = useSetAtom(refreshAtom);
  const encrypted =
    !!mode?.descriptor &&
    'contentMode' in mode.descriptor &&
    mode.descriptor.contentMode === 'e2ee';
  const matchesAccount =
    session.status === 'authenticated'
      ? session.user.id === mode?.accountId
      : session.status !== 'unauthenticated' || session.uncertain;
  const workspaceId = encrypted && matchesAccount ? mode!.workspaceId : null;
  const key = JSON.stringify([mode?.accountId, workspaceId]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data?: E2eeManagementState;
    isError: boolean;
  }>();
  useEffect(() => {
    if (!workspaceId || !mode?.accountId || !native?.managementState) return undefined;
    let active = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        // Offline refresh cannot erase verified local facts or pause the workspace.
        try {
          await native.refresh(workspaceId, { installKeys: false });
        } catch {
          /* Retry on the next probe. */
        }
        if (!active) return;
        const data = await native.managementState!(workspaceId);
        if (active && mode.accountId) notifyE2eeLedgerChanged(mode.accountId, workspaceId);
        if (active) setSnapshot({ key, data, isError: false });
      } catch {
        if (active)
          setSnapshot((previous) => ({
            key,
            data: previous?.key === key ? previous.data : undefined,
            isError: true,
          }));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [key, mode?.accountId, workspaceId, native, revision]);
  const state = {
    data: encrypted && snapshot?.key === key ? snapshot.data : undefined,
    isError: encrypted && snapshot?.key === key ? snapshot.isError : false,
    refetch: async () => {
      bump((value) => value + 1);
    },
  };
  return { state, workspaceId, accountId: mode?.accountId, native, encrypted };
}

export function E2eeSettingsIcon() {
  const { state, encrypted } = useSecurityState();
  const attention = !!(
    encrypted &&
    state.data?.mayRotate &&
    (state.data.rotationRequired || state.data.updatePending)
  );
  return <E2eeSettingsGlyph attention={attention} />;
}
export function E2eeSettingsGlyph({ attention }: { attention: boolean }) {
  const { t } = useTranslation();
  return (
    <span {...stylex.props(styles.icon)}>
      <Settings width="100%" height="100%" strokeWidth={1.5} />
      {attention && (
        <span
          role="status"
          aria-label={t('e2ee.security.attention')}
          {...stylex.props(styles.dot)}
        />
      )}
    </span>
  );
}
