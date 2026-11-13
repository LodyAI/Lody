import { notifyE2eeLedgerChanged } from '../../../providers/e2ee-runtime-notifications';
import { useEffect, useRef, useState } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { usePlatformSession, usePlatform } from '@lody/platform/react';
import type { E2eeManagementState, E2eeWorkspaceRuntime } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { E2eeDeviceProfile, E2eeWorkspaceMemberProfiles } from '@lody/cloud-api';
import { collectE2eeDeviceProfile } from '@/lib/e2ee-device-profile';
import { LODY_APP_INFO_UPDATED_EVENT } from '@/lib/native-app-info';
import { recordClientError } from '@/lib/client-log';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
const refreshAtom = atom(0);
let localOnlyRevision = -1;
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
  const port = usePlatform().e2eeWorkspaces;
  const native = port?.runtime;
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
    const load = async (forceRefresh = false) => {
      if (pending) return;
      pending = true;
      try {
        // Offline refresh cannot erase verified local facts or pause the workspace.
        if (forceRefresh || revision !== localOnlyRevision) {
          try {
            await native.refresh(workspaceId, { installKeys: false });
          } catch {
            /* Retry on the next probe. */
          }
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
      void load(true);
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
      bump((value) => {
        localOnlyRevision = value + 1;
        return value + 1;
      });
    },
  };
  const localProfile = useLocalDeviceProfile();
  const directory = useDeviceDirectory(port, session, workspaceId, mode?.accountId, state.data);
  return {
    state,
    directory,
    localProfile,
    workspaceId,
    accountId: mode?.accountId,
    native,
    encrypted,
  };
}

export function E2eeSettingsIcon() {
  const { state, encrypted, native, workspaceId, accountId } = useSecurityState();
  const admissionAttention = useMemberJoinAttention(
    native,
    workspaceId,
    accountId,
    !!state.data?.mayRotate
  );
  const attention = !!(
    encrypted &&
    ((state.data?.mayRotate && (state.data.rotationRequired || state.data.updatePending)) ||
      admissionAttention)
  );
  return <E2eeSettingsGlyph attention={attention} />;
}

/** True while a link join request waits for this manager; polled every 15 s. */
export function useMemberJoinAttention(
  native: E2eeWorkspaceRuntime | undefined,
  workspaceId: string | null,
  accountId: string | null | undefined,
  mayManage: boolean
) {
  const key = JSON.stringify([accountId, workspaceId]);
  const [snapshot, setSnapshot] = useState<{ key: string; attention: boolean }>();
  useEffect(() => {
    if (!workspaceId || !accountId || !mayManage || !native?.memberJoinRequests) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const requests = await native.memberJoinRequests!(workspaceId);
        if (active)
          setSnapshot({
            key,
            attention: requests.items.some(
              (request) =>
                request.source === 'link' && ['pending', 'admitting'].includes(request.state)
            ),
          });
      } catch {
        // An unavailable invitation queue does not hide key-update attention or pause work.
      } finally {
        if (active) timer = setTimeout(() => void load(), 15_000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [native, workspaceId, accountId, mayManage, key]);
  return mayManage && snapshot?.key === key && snapshot.attention;
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

/** This host's own display profile; native shells may finish collecting it after mount. */
export function useLocalDeviceProfile(): E2eeDeviceProfile {
  const [profile, setProfile] = useState(collectE2eeDeviceProfile);
  useEffect(() => {
    const update = () => setProfile(collectE2eeDeviceProfile());
    window.addEventListener(LODY_APP_INFO_UPDATED_EVENT, update);
    return () => window.removeEventListener(LODY_APP_INFO_UPDATED_EVENT, update);
  }, []);
  return profile;
}

// A server without the display-profile mutation refuses every report identically.
const unsupportedReport = (error: unknown) =>
  /Could not find public function/i.test(error instanceof Error ? error.message : String(error));

/** Optional display reads never delay or erase management/ledger facts. */
export function useDeviceDirectory(
  port: ReturnType<typeof usePlatform>['e2eeWorkspaces'],
  session: ReturnType<typeof usePlatformSession>,
  workspaceId: string | null,
  accountId: string | null | undefined,
  state: E2eeManagementState | undefined
) {
  const localProfile = useLocalDeviceProfile();
  const scope = JSON.stringify([accountId, workspaceId]);
  const [directory, setDirectory] = useState<{
    scope: string;
    value: E2eeWorkspaceMemberProfiles;
  }>();
  const reported = useRef<string | undefined>(undefined);
  const logged = useRef<string | undefined>(undefined);
  const authenticated = session.status === 'authenticated' && session.user.id === accountId;
  useEffect(() => {
    reported.current = undefined;
    setDirectory(undefined);
  }, [scope, authenticated, port]);
  useEffect(() => {
    let active = true;
    if (!authenticated || !workspaceId || !state) return;
    const self = state.devices.find((device) => device.self && device.kind === 'personal');
    const load = async () => {
      if (self && port?.reportDeviceProfile) {
        const profile = localProfile;
        const fingerprint = JSON.stringify([scope, self.key, profile]);
        if (reported.current !== fingerprint) {
          try {
            await port.reportDeviceProfile({ workspaceId, signingPublicKey: self.key, profile });
            if (!active) return;
            reported.current = fingerprint;
            return true;
          } catch (error) {
            // Old servers and offline clients keep all management controls. A server
            // without the mutation is not retried until the profile or scope changes;
            // other failures retry on the next verified refresh. Log each cause once.
            const unsupported = unsupportedReport(error);
            if (unsupported) reported.current = fingerprint;
            if (logged.current !== `${fingerprint}:${unsupported}`) {
              logged.current = `${fingerprint}:${unsupported}`;
              recordClientError(
                'e2ee/device_profile_report_failed',
                error,
                { unsupported },
                'warn'
              );
            }
          }
        }
      }
    };
    let readRevision = 0;
    const read = () => {
      const revision = ++readRevision;
      if (!port?.memberProfiles) return;
      void port.memberProfiles({ workspaceId }).then(
        (value) => {
          if (active && revision === readRevision && value.workspaceId === workspaceId)
            setDirectory({ scope, value });
        },
        () => {
          /* Optional labels never gate ledger availability. */
        }
      );
    };
    // Read independently: even an unresponsive profile update cannot hide labels.
    read();
    void load().then((changed) => {
      if (active && changed) read();
    });
    return () => {
      active = false;
    };
  }, [scope, authenticated, workspaceId, port, state, localProfile]);
  return authenticated && directory?.scope === scope ? directory.value : undefined;
}
