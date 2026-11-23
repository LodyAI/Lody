import { useMemo, type ReactNode } from 'react';
import {
  createStaticStore,
  type CloudApi,
  type CloudQuery,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext, usePlatform } from '@lody/platform/react';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  TOUR_LOCAL_PROJECT_ID,
  TOUR_MACHINE_ID,
  TOUR_USER_ID,
  TOUR_WORKSPACE_ID,
  TOUR_WORKSPACE_SLUG,
  type TourIdentity,
} from './tour-fixtures';

const TOUR_MACHINE_ACCESS_ROWS = [
  {
    machineId: TOUR_MACHINE_ID,
    ownerUserId: TOUR_USER_ID,
    sharedWithTeam: false,
    updatedAt: 0,
  },
] as const;

const TOUR_LOCAL_PROJECT_ACCESS_ROWS = [
  {
    machineId: TOUR_MACHINE_ID,
    localProjectId: TOUR_LOCAL_PROJECT_ID,
    ownerUserId: TOUR_USER_ID,
    sharedWithTeam: false,
    updatedAt: 0,
  },
] as const;

function readTourQuery<Result>(operation: CloudQuery<unknown, Result>): Result | undefined {
  if (operation.name === cloudOperations.machines.listVisibleMachines.name) {
    return TOUR_MACHINE_ACCESS_ROWS as Result;
  }
  if (operation.name === cloudOperations.localProjects.listVisibleLocalProjects.name) {
    return TOUR_LOCAL_PROJECT_ACCESS_ROWS as Result;
  }
  return undefined;
}

function rejectTourCloudOperation<Args, Result>(): (args: Args) => Promise<Result> {
  return async () => {
    throw new Error('The onboarding tour does not call cloud operations');
  };
}

const TOUR_CLOUD_API: CloudApi = {
  useQuery: <Args, Result>(operation: CloudQuery<Args, Result>, args: Args | 'skip') =>
    args === 'skip'
      ? undefined
      : readTourQuery(operation as unknown as CloudQuery<unknown, Result>),
  useMutation: <Args, Result>() => rejectTourCloudOperation<Args, Result>(),
  useAction: <Args, Result>() => rejectTourCloudOperation<Args, Result>(),
};

const TOUR_AUTHENTICATED_CONVEX_VALUE: AuthenticatedConvexContextValue = {
  authSessionId: 'onboarding-tour-auth',
  isAuthenticated: true,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: false,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

/**
 * The tour mounts real product components against fixture state. Replace every
 * cloud-facing provider they can observe so adding a query to a reused child
 * cannot silently send the fixture workspace id to production again.
 */
export function TourCloudBoundary({
  children,
  identity,
}: {
  children: ReactNode;
  identity: TourIdentity;
}) {
  const outerPlatform = usePlatform();
  const tourPlatform = useMemo<PlatformProvider>(() => {
    const tourIdentity: PlatformProvider['identity'] = {
      session: createStaticStore({
        status: 'authenticated',
        user: {
          id: TOUR_USER_ID,
          name: identity.userName,
          email: identity.userEmail,
        },
      }),
      signOut: rejectTourCloudOperation<void, void>(),
    };
    const tourWorkspaces: PlatformProvider['workspaces'] = {
      state: createStaticStore({
        status: 'ready',
        workspaces: [
          {
            id: TOUR_WORKSPACE_ID,
            name: identity.workspaceName,
            slug: TOUR_WORKSPACE_SLUG,
            role: 'owner',
          },
        ],
        activeWorkspaceId: TOUR_WORKSPACE_ID,
      }),
      setActive: rejectTourCloudOperation<string, void>(),
      create: rejectTourCloudOperation(),
    };

    return {
      ...outerPlatform,
      identity: tourIdentity,
      workspaces: tourWorkspaces,
      cloudApi: TOUR_CLOUD_API,
    };
  }, [identity.userEmail, identity.userName, identity.workspaceName, outerPlatform]);

  return (
    <PlatformContext.Provider value={tourPlatform}>
      <AuthenticatedConvexContext.Provider value={TOUR_AUTHENTICATED_CONVEX_VALUE}>
        {children}
      </AuthenticatedConvexContext.Provider>
    </PlatformContext.Provider>
  );
}
