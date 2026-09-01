import type { PlatformCapabilities } from './capabilities';
import type { CloudApi } from './cloud-api';
import type { ReadonlyStore } from './store';
import type { PlatformKind } from '@lody/shared/platform-kind';

export {
  PLATFORM_ENV_VAR,
  PLATFORM_VITE_ENV_VAR,
  resolvePlatformKind,
  type PlatformKind,
} from '@lody/shared/platform-kind';

/**
 * Which platform implementation a build is wired with. Selected at build time
 * (D-O1: the cloud build must not expose a runtime switch into local mode).
 */
export interface PlatformUser {
  id: string;
  email?: string;
  name?: string | null;
  image?: string | null;
}

export type PlatformSessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: PlatformUser };

export interface PlatformIdentity {
  session: ReadonlyStore<PlatformSessionState>;
  /**
   * Local platform: no account exists, so this resolves without effect (the
   * `cloudAccount` capability hides the affordance).
   */
  signOut(): Promise<void>;
}

/** Mirrors the workspace list item shape used by both the cloud org list and the CLI local catalog. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string | null;
  role: string;
}

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      workspaces: readonly WorkspaceSummary[];
      activeWorkspaceId: string | null;
    };

export interface WorkspaceCreateInput {
  name: string;
  slug?: string;
}

export interface PlatformWorkspaces {
  state: ReadonlyStore<WorkspacesState>;
  /** Re-fetch workspace state after a recoverable read failure. */
  retry?(): Promise<void>;
  /**
   * Local platform: exactly one implicit workspace exists (D-O14); calling
   * this with its id is a no-op and any other id rejects.
   */
  setActive(workspaceId: string): Promise<void>;
  /** Present only when the `multiWorkspace` capability is available. */
  create?(input: WorkspaceCreateInput): Promise<WorkspaceSummary>;
}

/**
 * How the workspace runtime attaches sync transports per room:
 * - `local`: every room mounts only the local data plane; zero cloud I/O.
 * - `cloud`: Streams only (web/mobile today).
 * - `dual`: local-primary dual-homing for local rooms (Electron today).
 *
 * Cloud-only fields (e.g. the Streams token provider factory) are added here
 * by WS-B when the workspace runtime starts consuming this seam.
 */
export type PlatformSyncMode = 'local' | 'cloud' | 'dual';

export interface PlatformSync {
  mode: PlatformSyncMode;
}

/**
 * The frontend seam between the open-source local build and the cloud build.
 * One instance is assembled per app entry (thin cloud entries import the cloud
 * implementation; open-source entries import the local one) and injected above
 * the workspace runtime. UI must consume these contracts instead of Convex /
 * Better Auth APIs.
 */
export interface PlatformProvider {
  readonly kind: PlatformKind;
  identity: PlatformIdentity;
  workspaces: PlatformWorkspaces;
  capabilities: PlatformCapabilities;
  /**
   * Present only on a cloud implementation. A capability claiming availability
   * while this adapter is absent is an invalid assembly and consumers fail fast.
   */
  cloudApi: CloudApi | null;
  sync: PlatformSync;
}
