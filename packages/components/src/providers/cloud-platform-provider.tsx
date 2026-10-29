import { E2eeTeamInboxHost } from '@/components/e2ee/email-admission-worker';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useAtomValue, useStore } from 'jotai';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import {
  getTelemetryRouteTarget,
  installWorkspaceTelemetryScope,
  postHogPrivacy,
  suspendWorkspaceTelemetry,
} from '@/lib/posthog-privacy';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStore,
  type PlatformProvider,
  type MutableStore,
  type E2eeWorkspaceRuntime,
  type PlatformSessionState,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { useOrganization } from '@/hooks/useOrganization';
import { useOptionalAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useStableSession } from '@/hooks/useStableSession';
import { useAuthSignOut } from './convex-provider';
import { isElectronRenderer } from '@/lib/electron';
import { cloudPlatformApi, useCloudPlatformClient } from './cloud-platform-api';
import { createCloudE2eeWorkspaces } from './cloud-e2ee-workspaces';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { installGitHubTokenPort } from '@/lib/github-token-port';
import { cloudGitHubTokenPort } from './cloud-github-token-port';
import { installAttachmentWorkspaceAccess } from '@/lib/attachment-workspace-access';
import { installCloudHttpPort } from '@/lib/cloud-http-port';
import { localAgentEnabledAtom } from '@/atoms/local-probe';
import { resolveCloudPlatformRuntimePolicy } from './cloud-platform-runtime-policy';

const CLOUD_HTTP_PORT = {
  authBaseUrl: import.meta.env.VITE_CONVEX_SITE_URL || null,
  serverBaseUrl: import.meta.env.VITE_API_BASE_URL || null,
} as const;

function toWorkspaceSummary(
  organization: {
    id: string;
    name: string;
    slug?: string | null;
    contentMode?: string;
    contentModeVersion?: number;
    cryptoOrgId?: string;
    genesisHash?: string;
  },
  role: string | undefined
): WorkspaceSummary {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug ?? null,
    role: role ?? 'member',
    ...(organization.contentMode === undefined ? {} : { contentMode: organization.contentMode }),
    ...(organization.contentModeVersion === undefined
      ? {}
      : { contentModeVersion: organization.contentModeVersion }),
    ...(organization.cryptoOrgId === undefined ? {} : { cryptoOrgId: organization.cryptoOrgId }),
    ...(organization.genesisHash === undefined ? {} : { genesisHash: organization.genesisHash }),
  };
}

/**
 * Cloud assembly for the shared frontend platform contract. Better Auth and
 * Convex remain behind this component in Phase 0; Phase 1 moves this file to
 * the closed `platform-cloud` package without changing open UI consumers.
 */
export function CloudPlatformProvider({ children }: { children: ReactNode }) {
  const electron = isElectronRenderer();
  const cloudClient = useCloudPlatformClient();
  const localAgentEnabled = useAtomValue(localAgentEnabledAtom);
  const { syncMode: localAgentSyncMode } = resolveCloudPlatformRuntimePolicy({
    electron,
    localAgentEnabled,
  });
  const session = useStableSession();
  const hasAuthenticatedConvex = useOptionalAuthenticatedConvex() !== null;
  const signOut = useAuthSignOut();
  const [sessionStore] = useState(() => createStore<PlatformSessionState>({ status: 'loading' }));
  const [workspacesStore] = useState(() => createStore<WorkspacesState>({ status: 'loading' }));
  // Session refetches replace organization callbacks. Publish the committed
  // child's latest actions without replacing the platform object or its consumers.
  const organizationRef = useRef<ReturnType<typeof useOrganization> | null>(null);
  const atomStore = useStore();
  const telemetryLive = useRef({ session, hasAuthenticatedConvex });
  telemetryLive.current = { session, hasAuthenticatedConvex };
  useLayoutEffect(() => postHogPrivacy.sync());
  useEffect(() => {
    const uninstall = installWorkspaceTelemetryScope(() => {
      const live = telemetryLive.current;
      const organization = organizationRef.current;
      if (
        !live.hasAuthenticatedConvex ||
        live.session.isPending ||
        live.session.isRetrying ||
        live.session.isOptimistic ||
        !organization ||
        organization.error ||
        !organization.activeOrganization
      )
        return null;
      const identity = sessionStore.get();
      const mode = atomStore.get(workspaceContentModeAtom);
      const target = getTelemetryRouteTarget();
      if (
        identity.status !== 'authenticated' ||
        live.session.data?.user.id !== identity.user.id ||
        organization.activeOrganization.id !== mode?.workspaceId ||
        ('contentMode' in organization.activeOrganization &&
          organization.activeOrganization.contentMode !== undefined &&
          String(organization.activeOrganization.contentMode) !== 'plaintext') ||
        atomStore.get(userAtom)?.id !== identity.user.id ||
        !target ||
        mode?.accountId !== identity.user.id ||
        mode.workspaceSlug !== target ||
        atomStore.get(currentWorkspaceSlugAtom) !== target ||
        atomStore.get(currentWorkspaceIdAtom) !== mode.workspaceId ||
        !mode.descriptor ||
        !('contentMode' in mode.descriptor) ||
        mode.descriptor.contentMode !== 'plaintext'
      )
        return null;
      const listed = workspacesStore.get();
      if (
        listed.status !== 'ready' ||
        listed.activeWorkspaceId !== mode.workspaceId ||
        listed.workspaces.some(
          (item) => item.id === mode.workspaceId && item.contentMode === 'e2ee'
        )
      )
        return null;
      return JSON.stringify([identity.user.id, mode.workspaceId, target]);
    });
    const refresh = () => postHogPrivacy.sync();
    const unsubscribes = [
      sessionStore.subscribe(refresh),
      workspacesStore.subscribe(refresh),
      atomStore.sub(userAtom, refresh),
      atomStore.sub(workspaceContentModeAtom, refresh),
      atomStore.sub(currentWorkspaceIdAtom, refresh),
      atomStore.sub(currentWorkspaceSlugAtom, refresh),
    ];
    return () => {
      uninstall();
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [atomStore, sessionStore, workspacesStore]);
  const [uninstallGitHubTokenPort] = useState(() => installGitHubTokenPort(cloudGitHubTokenPort));
  const [uninstallCloudHttpPort] = useState(() => installCloudHttpPort(CLOUD_HTTP_PORT));

  useEffect(() => uninstallGitHubTokenPort, [uninstallGitHubTokenPort]);
  useEffect(() => uninstallCloudHttpPort, [uninstallCloudHttpPort]);

  useEffect(() => {
    if (session.isPending || session.isRetrying || session.isOptimistic) {
      sessionStore.set({ status: 'loading' });
      return;
    }
    const user = session.data?.user;
    if (!user) {
      sessionStore.set({
        status: 'unauthenticated',
        ...(session.error && !session.confirmedUnauthenticated ? { uncertain: true as const } : {}),
      });
      return;
    }
    sessionStore.set({
      status: 'authenticated',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
    });
  }, [
    session.data?.user,
    session.error,
    session.confirmedUnauthenticated,
    session.isOptimistic,
    session.isPending,
    session.isRetrying,
    sessionStore,
  ]);

  const readOrganization = useCallback(() => {
    if (!organizationRef.current) {
      throw new Error('Cloud workspace operations require AuthenticatedConvexProvider');
    }
    return organizationRef.current;
  }, []);
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  const e2eeWorkspaces = useMemo(() => {
    const native = electron ? getIpcServices()?.e2ee : undefined;
    return createCloudE2eeWorkspaces({
      session: () => sessionStore.get(),
      ...(native
        ? {
            prepareCreation: (request) => native.prepareCreation(request),
            runtime: {
              createMemberInvitation: (input) => native.createMemberInvitation(input),
              prepareMemberJoin: (offer) => native.prepareMemberJoin(offer),
              pendingMemberJoin: (workspaceId) => native.pendingMemberJoin(workspaceId),
              memberJoinRequests: (workspaceId) => native.memberJoinRequests(workspaceId),
              approveMemberJoin: (workspaceId, requestId, mode) =>
                native.approveMemberJoin(workspaceId, requestId, mode),
              rejectMemberJoin: (workspaceId, requestId) =>
                native.rejectMemberJoin(workspaceId, requestId),
              revokeMemberInvitation: (workspaceId, token) =>
                native.revokeMemberInvitation(workspaceId, token),
              claimMemberJoin: (workspaceId, requestId) =>
                native.claimMemberJoin(workspaceId, requestId),
              personalPairingOffer: (workspaceId) => native.personalPairingOffer(workspaceId),
              preparePersonalJoin: (offer) => native.preparePersonalJoin(offer),
              pendingPersonalJoin: (workspaceId) => native.pendingPersonalJoin(workspaceId),
              inspectPersonalJoin: (workspaceId, pairingSessionId) =>
                native.inspectPersonalJoin(workspaceId, pairingSessionId),
              approvePersonalJoin: (workspaceId, pairingSessionId) =>
                native.approvePersonalJoin(workspaceId, pairingSessionId),
              claimPersonalJoin: (workspaceId, pairingSessionId) =>
                native.claimPersonalJoin(workspaceId, pairingSessionId),
              cancelPersonalJoin: (workspaceId, pairingSessionId) =>
                native.cancelPersonalJoin(workspaceId, pairingSessionId),
              removeMember: (workspaceId, membershipId) =>
                native.removeMember(workspaceId, membershipId),
              setMemberRole: (workspaceId, membershipId, role) =>
                native.setMemberRole(workspaceId, membershipId, role),

              beginRemoteMachinePairing: (workspaceId) =>
                native.beginRemoteMachinePairing(workspaceId),
              inspectRemoteMachinePairing: (workspaceId, pairingSessionId) =>
                native.inspectRemoteMachinePairing(workspaceId, pairingSessionId),
              approveRemoteMachinePairing: (workspaceId, pairingSessionId, summary) =>
                native.approveRemoteMachinePairing(workspaceId, pairingSessionId, summary),
              cancelRemoteMachinePairing: (workspaceId, pairingSessionId) =>
                native.cancelRemoteMachinePairing(workspaceId, pairingSessionId),
              prepareLocalAgent: (workspaceId) => native.prepareLocalAgent(workspaceId),
              admitLocalAgent: (workspaceId, pairingSessionId) =>
                native.admitLocalAgent(workspaceId, pairingSessionId),
              managementState: (workspaceId) => native.managementState(workspaceId),
              updateKeys: (workspaceId) => native.updateKeys(workspaceId),
              revokeDevice: (workspaceId, signingPublicKey) =>
                native.revokeDevice(workspaceId, signingPublicKey),
              refresh: (workspaceId, options) => native.refresh(workspaceId, options),
              contentStreamsToken: (workspaceId, rejectedToken, requestSnapshotFor, rpcOnly) =>
                native.contentStreamsToken(workspaceId, rejectedToken, requestSnapshotFor, rpcOnly),
              prepareFeatureRpc: (workspaceId, input) =>
                native.prepareFeatureRpc(workspaceId, input),
              acceptFeatureRpcResponse: (workspaceId, input, frame) =>
                native.acceptFeatureRpcResponse(workspaceId, input, frame),
              readMachineSharing: (workspaceId, machineId) =>
                native.readMachineSharing(workspaceId, machineId),
              updateMachineSharing: (workspaceId, machineId, generation, requestId, change) =>
                native.updateMachineSharing(workspaceId, machineId, generation, requestId, change),
              prepareDispatch: (workspaceId, machineId, input) =>
                native.prepareDispatch(workspaceId, machineId, input),
              acceptDispatchResponse: (workspaceId, machineId, input, frame) =>
                native.acceptDispatchResponse(workspaceId, machineId, input, frame),
              seal: (workspaceId, input) => native.seal(workspaceId, input),
              openContent: (workspaceId, input) => native.openContent(workspaceId, input),
              account: (options) => native.account(options),
              resetIdentity: (request) => native.resetIdentity(request),
              resetLocalAgent: (request) => native.resetLocalAgent(request),
              recordCreated: (request) => native.recordCreated(request),
              open: (workspaceId, observed, expectedAccountId) =>
                native.open(workspaceId, observed, expectedAccountId),
              close: (workspaceId, expectedAccountId, readerOwner) =>
                native.close(workspaceId, expectedAccountId, readerOwner),
              readIdentity: (input) => native.readIdentity(input),
              status: (workspaceId) => native.status(workspaceId),
              ingestLedgerRecords: (workspaceId, page) =>
                native.ingestLedgerRecords(workspaceId, page),
              ledgerView: (workspaceId) => native.ledgerView(workspaceId),
            },
          }
        : {}),
      remote: {
        memberProfiles: (request) =>
          cloudClient.query(cloudOperations.e2eeWorkspaces.memberProfiles, request),
        create: (request) => cloudClient.action(cloudOperations.e2eeWorkspaces.create, request),
        describe: (request) => cloudClient.query(cloudOperations.e2eeWorkspaces.describe, request),
        history: (request) => cloudClient.action(cloudOperations.e2eeWorkspaces.history, request),
      },
      refreshWorkspaces: async () => {
        await readOrganization().refetchOrganizations();
      },
    });
  }, [cloudClient, electron, readOrganization, sessionStore]);

  const provider = useMemo<PlatformProvider>(
    () => ({
      kind: 'cloud',
      identity: {
        session: sessionStore,
        signOut: () => signOutRef.current(),
      },
      e2eeWorkspaces,
      workspaces: {
        state: workspacesStore,
        retry: async () => {
          await Promise.all([
            readOrganization().refetchOrganizations(),
            readOrganization().refetchActiveOrganization(),
          ]);
        },
        setActive: async (workspaceId) => {
          const current = workspacesStore.get();
          if (current.status === 'ready' && current.activeWorkspaceId === workspaceId) {
            await readOrganization().activateOrganization(workspaceId);
            return;
          }
          const resume = suspendWorkspaceTelemetry();
          try {
            await readOrganization().activateOrganization(workspaceId);
          } catch (error) {
            resume();
            throw error;
          }
        },
        updateSlug: async (workspaceId, slug) => {
          const updated = await readOrganization().updateOrganization(workspaceId, { slug });
          if (!updated) {
            throw new Error('Cloud workspace update returned no workspace');
          }
          const { activeOrganization, role } = readOrganization();
          return toWorkspaceSummary(
            updated,
            updated.id === activeOrganization?.id ? role : undefined
          );
        },
        create: async (input) => {
          const created = await readOrganization().createOrganization(input.name, input.slug);
          if (!created) {
            throw new Error('Cloud workspace creation returned no workspace');
          }
          return toWorkspaceSummary(created, 'owner');
        },
      },
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
      cloudApi: cloudPlatformApi,
      sync: {
        mode: localAgentSyncMode,
      },
    }),
    [e2eeWorkspaces, localAgentSyncMode, readOrganization, sessionStore, workspacesStore]
  );

  useEffect(() => installAttachmentWorkspaceAccess(provider), [provider]);

  return (
    <PlatformContext.Provider value={provider}>
      <CloudWorkspaceBridge
        organizationRef={organizationRef}
        workspacesStore={workspacesStore}
        runtime={e2eeWorkspaces.runtime}
        accountId={session.data?.user.id}
      />
      {children}
    </PlatformContext.Provider>
  );
}

type CloudWorkspaceBridgeProps = {
  organizationRef: RefObject<ReturnType<typeof useOrganization> | null>;
  workspacesStore: MutableStore<WorkspacesState>;
  runtime: E2eeWorkspaceRuntime | undefined;
  accountId: string | undefined;
};

// Standalone login has session/Convex contexts but no authenticated-query context.
// Keep the optional boundary outside the component that invokes protected hooks.
function CloudWorkspaceBridge(props: CloudWorkspaceBridgeProps) {
  const auth = useOptionalAuthenticatedConvex();
  return auth ? <AuthenticatedCloudWorkspaceBridge {...props} /> : null;
}

function AuthenticatedCloudWorkspaceBridge({
  organizationRef,
  workspacesStore,
  runtime,
  accountId,
}: CloudWorkspaceBridgeProps) {
  const organization = useOrganization();
  useLayoutEffect(() => {
    organizationRef.current = organization;
  });
  useEffect(
    () => () => {
      organizationRef.current = null;
      workspacesStore.set({ status: 'loading' });
    },
    [organizationRef, workspacesStore]
  );

  useEffect(() => {
    if (organization.error) {
      workspacesStore.set({
        status: 'error',
        message:
          organization.error instanceof Error
            ? organization.error.message
            : 'Failed to load workspaces',
      });
      return;
    }
    if (!organization.organizations) {
      workspacesStore.set({ status: 'loading' });
      return;
    }
    workspacesStore.set({
      status: 'ready',
      workspaces: organization.organizations.map((item) =>
        toWorkspaceSummary(
          item,
          item.id === organization.activeOrganization?.id ? organization.role : undefined
        )
      ),
      activeWorkspaceId: organization.activeOrganization?.id ?? null,
    });
  }, [
    organization.activeOrganization?.id,
    organization.error,
    organization.organizations,
    organization.role,
    workspacesStore,
  ]);

  return accountId && runtime
    ? organization.organizations?.map((workspace) =>
        'contentMode' in workspace &&
        workspace.contentMode === 'e2ee' &&
        'role' in workspace &&
        ['owner', 'admin'].includes(String(workspace.role)) ? (
          <E2eeTeamInboxHost
            key={`${accountId}:${workspace.id}`}
            runtime={runtime}
            workspaceId={workspace.id}
            accountId={accountId}
          />
        ) : null
      )
    : null;
}
