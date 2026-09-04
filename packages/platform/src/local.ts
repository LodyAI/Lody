import { LOCAL_PLATFORM_CAPABILITIES } from './capabilities';
import type { CloudPort, CloudPortIdentity, RuntimeArtifactsPort } from './cloud-port';
import type {
  PlatformIdentity,
  PlatformProvider,
  PlatformSessionState,
  PlatformWorkspaces,
  WorkspacesState,
  WorkspaceSummary,
} from './provider';
import type { ReadonlyStore } from './store';
import { resolveRuntimeArtifactsBaseUrl } from './runtime-artifacts';

export {
  LOCAL_USER_ID_PREFIX,
  LOCAL_WORKSPACE_ID_PREFIX,
  isLocalUserId,
  isLocalWorkspaceId,
} from '@lody/shared/platform-kind';

/**
 * Local id namespaces. Both prefixes are load-bearing isolation boundaries:
 * - `lw_` workspace ids never collide with cloud (Convex-minted) workspace ids,
 *   which keeps local and cloud data physically separate on disk and marks
 *   data eligible for full migration (D-O13/D-O14).
 * - `local:` user ids never collide with cloud user ids, so a cloud-mode CLI
 *   refuses a local-identity catalog and vice versa.
 */
export function createLocalRuntimeArtifactsPort(baseUrl?: string): RuntimeArtifactsPort {
  return {
    baseUrl: resolveRuntimeArtifactsBaseUrl(baseUrl),
  };
}

export function createLocalIdentity(
  session: ReadonlyStore<PlatformSessionState>
): PlatformIdentity {
  return {
    session,
    signOut: () => Promise.resolve(),
  };
}

export function createLocalWorkspaces(state: ReadonlyStore<WorkspacesState>): PlatformWorkspaces {
  return {
    state,
    setActive: (workspaceId) => {
      const current = state.get();
      if (current.status === 'ready' && current.activeWorkspaceId === workspaceId) {
        return Promise.resolve();
      }
      return Promise.reject(
        new Error(`Local platform has a single implicit workspace; cannot activate ${workspaceId}`)
      );
    },
    // No `create`: the implicit workspace is provisioned by the CLI (D-O14).
  };
}

export interface LocalPlatformProviderOptions {
  /** loading → authenticated once the CLI catalog snapshot is available. */
  session: ReadonlyStore<PlatformSessionState>;
  /** Fed by the renderer's local-CLI connection: loading → ready(single implicit workspace). */
  workspaces: ReadonlyStore<WorkspacesState>;
}

export function createLocalPlatformProvider(
  options: LocalPlatformProviderOptions
): PlatformProvider {
  return {
    kind: 'local',
    identity: createLocalIdentity(options.session),
    workspaces: createLocalWorkspaces(options.workspaces),
    capabilities: LOCAL_PLATFORM_CAPABILITIES,
    cloudApi: null,
    sync: { mode: 'local' },
  };
}

export interface LocalCloudPortOptions {
  identity: CloudPortIdentity;
  /** The implicit local workspace set from the local catalog. */
  workspaces: readonly WorkspaceSummary[];
  /** Optional operator mirror; the public artifact channel is the default. */
  runtimeArtifactsBaseUrl?: string;
}

/**
 * The open-source CLI platform: every optional port is `null`, the access
 * oracle answers from the injected catalog snapshot, and only the daemon
 * owner is ever allowed. Guarantees zero cloud I/O by construction.
 */
export function createLocalCloudPort(options: LocalCloudPortOptions): CloudPort {
  const { identity, workspaces } = options;
  return {
    kind: 'local',
    identity,
    access: {
      watchWorkspaceAccess: (listener) => {
        listener({ status: 'authorized', userId: identity.userId, workspaces });
        return () => {};
      },
      verifyMachineAccess: (request) =>
        Promise.resolve(
          request.requesterUserId === identity.userId
            ? { allowed: true }
            : { allowed: false, reason: 'requester_not_member' }
        ),
      verifyPreviewRequest: () =>
        Promise.resolve({ outcome: 'denied', reason: 'not_visible' as const }),
      registerMachineAccess: () => Promise.resolve(),
      resolveWorkspaceUser: (request) =>
        Promise.resolve(request.userId === identity.userId ? { id: identity.userId } : null),
    },
    streamsTokens: null,
    notifications: null,
    usage: null,
    billing: null,
    githubTokens: null,
    bugReports: null,
    prAssociation: null,
    attachmentUpload: null,
    remotePreview: null,
    runtimeArtifacts: createLocalRuntimeArtifactsPort(options.runtimeArtifactsBaseUrl),
    dispose: () => Promise.resolve(),
  };
}
