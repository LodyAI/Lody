import { LegacyWorkspaceAdmissionError } from '@/lib/legacy-workspace-admission';
import { api } from '@lody/cloud-api';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference, OptionalRestArgs } from 'convex/server';
import type { GitHubTokenPort, GitHubTokenErrorResult } from '@/lib/github-token-port';
import { getRegisteredAuthClient } from '@/lib/auth-client-singleton';
import { requestCurrentConvexJwt } from '@/lib/convex-jwt';
import { convexClient } from './convex-provider';

async function mintFreshConvexJwt(): Promise<string | null> {
  const authClient = getRegisteredAuthClient();
  return authClient ? await requestCurrentConvexJwt(authClient) : null;
}

async function runActionWithUnauthorizedRetry<
  Action extends FunctionReference<'action'> & {
    _returnType: { success: true } | GitHubTokenErrorResult;
  },
>(
  assertAccess: () => string,
  action: Action,
  ...args: OptionalRestArgs<Action>
): Promise<Action['_returnType']> {
  const admission = assertAccess();
  const check = () => {
    if (assertAccess() !== admission) throw new LegacyWorkspaceAdmissionError('changed');
  };
  const result = (await convexClient.action(action, ...args)) as Action['_returnType'];
  check();
  if (result.success || result.errorCode !== 'unauthorized') {
    return result;
  }
  const fresh = await mintFreshConvexJwt();
  check();
  if (!fresh) return result;
  const deploymentUrl = convexClient.url || import.meta.env.VITE_CONVEX_DEPLOY_URL;
  if (!deploymentUrl) return result;
  const httpClient = new ConvexHttpClient(deploymentUrl);
  httpClient.setAuth(fresh);
  check();
  let retried: Action['_returnType'];
  try {
    retried = (await httpClient.action(action, ...args)) as Action['_returnType'];
  } catch {
    check();
    return result;
  }
  check();
  return retried;
}

export function createCloudGitHubTokenPort(
  assertAccess: (workspaceId: string) => string
): GitHubTokenPort {
  return {
    getRepoToken: (input) =>
      runActionWithUnauthorizedRetry(
        () => assertAccess(input.workspaceId),
        api.github.getAccessTokenByRepoNameForClient,
        input
      ),
    getOperationToken: (input) =>
      runActionWithUnauthorizedRetry(
        () => assertAccess(input.workspaceId),
        api.github.getOperationAccessTokenByRepoNameForClient,
        input
      ),
  };
}
