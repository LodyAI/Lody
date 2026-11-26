import { CloudCapabilityUnavailableError } from '@lody/platform';

export type GitHubTokenErrorResult = {
  success: false;
  errorCode: string;
  errorMessage: string;
};

export type GitHubRepoTokenResult =
  | { success: true; token: string; expiresAt: string }
  | GitHubTokenErrorResult;

export type GitHubOperationTokenResult =
  | {
      success: true;
      token: string;
      expiresAt?: string;
      tokenSource: 'personal' | 'app';
    }
  | GitHubTokenErrorResult;

export interface GitHubTokenPort {
  /** Revalidate live membership even when the client reuses a cached token. */
  assertAccess?(workspaceId: string): string;
  getRepoToken(input: {
    workspaceId: string;
    repoFullName: string;
  }): Promise<GitHubRepoTokenResult>;
  getOperationToken(input: {
    workspaceId: string;
    repoFullName: string;
    operation: 'read' | 'write';
    invalidatedPersonalToken?: string;
  }): Promise<GitHubOperationTokenResult>;
}

let installedPort: GitHubTokenPort | null = null;

/** Install once at the cloud app assembly boundary; runtime platform switching is forbidden. */
export function installGitHubTokenPort(port: GitHubTokenPort): () => void {
  if (installedPort && installedPort !== port) {
    throw new Error('A different GitHubTokenPort is already installed');
  }
  installedPort = port;
  return () => {
    if (installedPort === port) installedPort = null;
  };
}

export function requireGitHubTokenPort(): GitHubTokenPort {
  if (!installedPort) {
    throw new CloudCapabilityUnavailableError('githubIntegration');
  }
  return installedPort;
}
