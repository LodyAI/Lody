import type {
  ConnectorAuthStatus,
  ConnectorPluginId,
  ConnectorTriggerConfig,
  NormalizedTriggerEvent,
} from '@lody/shared';
import type { ResolvedGitHubCredential } from '@/lib/pr-poller/github-credential-resolver';

export interface ConnectorHostContext {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly userId: string;
  resolveGitHubCredential(repoFullName: string): Promise<ResolvedGitHubCredential | null>;
  invalidateGitHubCredential(repoFullName: string, credential: ResolvedGitHubCredential): void;
  readonly fetchImpl?: typeof fetch;
}

export interface ConnectorPollResult<TCursor = Record<string, unknown>> {
  readonly events: NormalizedTriggerEvent[];
  readonly nextCursor: TCursor;
}

export interface ConnectorPluginRuntime<
  TConfig extends ConnectorTriggerConfig = ConnectorTriggerConfig,
  TCursor = Record<string, unknown>,
> {
  readonly pluginId: ConnectorPluginId;
  checkAuth(
    ctx: ConnectorHostContext,
    repoHint?: string
  ): Promise<{ status: ConnectorAuthStatus; source?: 'managed' | 'gh' }>;
  seedCursor(config: TConfig, now: number): TCursor;
  pollDelta(
    ctx: ConnectorHostContext,
    config: TConfig,
    cursor: TCursor | null,
    now: number
  ): Promise<ConnectorPollResult<TCursor>>;
}
