import { E2eeTeamInboxHost } from '@/components/e2ee/email-admission-worker';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStore,
  type PlatformProvider,
  type PlatformSessionState,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { useOrganization } from '@/hooks/useOrganization';
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
  const organization = useOrganization();
  const {
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
  } = organization;
  const signOut = useAuthSignOut();
  const [sessionStore] = useState(() => createStore<PlatformSessionState>({ status: 'loading' }));
  const [workspacesStore] = useState(() => createStore<WorkspacesState>({ status: 'loading' }));
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

  // What the provider's methods call, read when they run. These callbacks change
  // identity on every session refetch (window focus, the keepalive) —
  // `createOrganization` closes over the refetched `user` object — and a
  // consumer that owns resources per platform object, like the Prompt Shortcut
  // runtime, tore them down and reopened them each time: an open Shortcut editor
  // lost its draft and closed. The platform object changes only with what it
  // states, not with a refetch that changed nothing.
  const actions = useRef({
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
    signOut,
    activeOrganizationId: organization.activeOrganization?.id,
    role: organization.role,
  });
  actions.current = {
    activateOrganization,
    createOrganization,
    refetchActiveOrganization,
    refetchOrganizations,
    updateOrganization,
    signOut,
    activeOrganizationId: organization.activeOrganization?.id,
    role: organization.role,
  };

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
        await actions.current.refetchOrganizations();
      },
    });
  }, [cloudClient, electron, sessionStore]);

  const provider = useMemo<PlatformProvider>(
    () => ({
      kind: 'cloud',
      identity: {
        session: sessionStore,
        signOut: () => actions.current.signOut(),
      },
      e2eeWorkspaces,
      workspaces: {
        state: workspacesStore,
        retry: async () => {
          await Promise.all([
            actions.current.refetchOrganizations(),
            actions.current.refetchActiveOrganization(),
          ]);
        },
        setActive: async (workspaceId) => {
          await actions.current.activateOrganization(workspaceId);
        },
        updateSlug: async (workspaceId, slug) => {
          const updated = await actions.current.updateOrganization(workspaceId, { slug });
          if (!updated) {
            throw new Error('Cloud workspace update returned no workspace');
          }
          const { activeOrganizationId, role } = actions.current;
          return toWorkspaceSummary(
            updated,
            updated.id === activeOrganizationId ? role : undefined
          );
        },
        create: async (input) => {
          const created = await actions.current.createOrganization(input.name, input.slug);
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
    [e2eeWorkspaces, localAgentSyncMode, sessionStore, workspacesStore]
  );

  useEffect(() => installAttachmentWorkspaceAccess(provider), [provider]);

  const memberAccountId = session.data?.user.id;
  return (
    <PlatformContext.Provider value={provider}>
      {memberAccountId &&
        e2eeWorkspaces.runtime &&
        organization.organizations?.map((workspace) =>
          'contentMode' in workspace &&
          workspace.contentMode === 'e2ee' &&
          'role' in workspace &&
          ['owner', 'admin'].includes(String(workspace.role)) ? (
            <E2eeTeamInboxHost
              key={`${memberAccountId}:${workspace.id}`}
              runtime={e2eeWorkspaces.runtime!}
              workspaceId={workspace.id}
              accountId={memberAccountId}
            />
          ) : null
        )}
      {children}
    </PlatformContext.Provider>
  );
}
