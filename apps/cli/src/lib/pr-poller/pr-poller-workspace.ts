import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionDocRoomId,
  SESSION_DOC_PREFIX,
  type LodyPresenceStateMap,
  type MachineId,
  type PrStatus,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestMeta,
  type SessionPullRequestStateMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  GitHubCredentialResolver,
  type ResolvedGitHubCredential,
} from './github-credential-resolver';
import type { AliveSessionMeta } from './pr-poll-targets';
import type { CloudGithubTokenPort, CloudPrAssociationPort } from '@lody/platform';

/**
 * Per-workspace adapter between the poller scheduler and a live workspace
 * runtime (Loro repo + presence + credentials + the association endpoint).
 * The fleet builds one handle per running workspace; the scheduler only ever
 * talks to this interface, so tests inject fakes.
 */

export type AssociatePullRequestArgs = {
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  status: PrStatus;
  ownerSessionId: SessionId;
};

export type PrPollMetaPatch = {
  pullRequests?: SessionPullRequestMeta[];
  pullRequestState?: Record<string, SessionPullRequestStateMeta>;
};

export interface PrPollerWorkspaceHandle {
  readonly workspaceId: string;
  /** Local machine identity — the pre-write ownership revalidation predicate. */
  readonly machineId: MachineId;
  listAliveSessionMetas(): Promise<AliveSessionMeta[]>;
  /** Fresh owner meta — the write predicate (plan §6). Never cached. */
  readOwnerMeta(ownerSessionId: SessionId): Promise<SessionMeta | undefined>;
  writeOwnerMeta(ownerSessionId: SessionId, patch: PrPollMetaPatch): Promise<void>;
  /** Fires with the changed session id (coalesced and re-read downstream). */
  watchSessionMetadata(listener: (sessionId: SessionId) => void): (() => void) | null;
  subscribePresence(listener: (states: LodyPresenceStateMap) => void): (() => void) | null;
  getPresenceStates(): LodyPresenceStateMap | null;
  waitForInitialSync(timeoutMs?: number): Promise<boolean>;
  resolveCredential(repoFullName: string): Promise<ResolvedGitHubCredential | null>;
  invalidateCredential(repoFullName: string, credential: ResolvedGitHubCredential): void;
  /** `github:associatePullRequestForCli` — the poller's only backend write (plan §4). */
  associatePullRequest(args: AssociatePullRequestArgs): Promise<boolean>;
  /** Release owned resources (token manager). Idempotent. */
  dispose(): Promise<void>;
}

const ASSOCIATE_TIMEOUT_MS = 15_000;

export function createLodyPrPollerWorkspace(options: {
  documentManager: LoroDocumentManager;
  workspaceId: string;
  userId: string;
  machineId: MachineId;
  githubTokens: CloudGithubTokenPort | null;
  prAssociation: CloudPrAssociationPort;
  logger: Logger;
}): PrPollerWorkspaceHandle {
  const { documentManager, workspaceId, userId, machineId, githubTokens, prAssociation, logger } =
    options;

  const tokenManager = githubTokens?.createTokenManager(workspaceId) ?? null;
  const credentialResolver = new GitHubCredentialResolver({
    tokenManager,
    writeTokenContext: { requesterUserId: userId, machineId },
    workspaceId,
    logger,
  });

  let disposed = false;

  return {
    workspaceId,
    machineId,

    async listAliveSessionMetas(): Promise<AliveSessionMeta[]> {
      const rows = await listAliveSessionMetas(documentManager);
      return rows
        .filter(({ meta }) => meta.machineId === machineId)
        .map(({ roomId, meta }) => ({
          sessionId: roomId.slice(SESSION_DOC_PREFIX.length) as SessionId,
          meta,
        }));
    },

    async readOwnerMeta(ownerSessionId: SessionId): Promise<SessionMeta | undefined> {
      const record = await documentManager.repo.getDocMeta(getSessionRoomId(ownerSessionId));
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return undefined;
      }
      return record.meta as SessionMeta;
    },

    async writeOwnerMeta(ownerSessionId: SessionId, patch: PrPollMetaPatch): Promise<void> {
      await documentManager.repo.upsertDocMeta(getSessionRoomId(ownerSessionId), patch);
    },

    watchSessionMetadata(listener: (sessionId: SessionId) => void): (() => void) | null {
      const handle = documentManager.repo.watch(
        (event) => {
          const candidate = event as { kind: string; docId?: unknown };
          if (
            (candidate.kind !== 'doc-metadata' && candidate.kind !== 'doc-existence-changed') ||
            typeof candidate.docId !== 'string' ||
            !isSessionDocRoomId(candidate.docId)
          ) {
            return;
          }
          listener(candidate.docId.slice(SESSION_DOC_PREFIX.length) as SessionId);
        },
        { kinds: ['doc-metadata', 'doc-existence-changed'] as string[] as never }
      );
      return () => handle.unsubscribe();
    },

    subscribePresence(listener: (states: LodyPresenceStateMap) => void): (() => void) | null {
      return documentManager.subscribePresenceStates(listener);
    },

    getPresenceStates(): LodyPresenceStateMap | null {
      return documentManager.getPresenceStates();
    },

    async waitForInitialSync(timeoutMs?: number): Promise<boolean> {
      return await documentManager.waitForInitialMetaSync(
        timeoutMs === undefined ? {} : { timeoutMs }
      );
    },

    resolveCredential(repoFullName: string) {
      return credentialResolver.resolve(repoFullName);
    },

    invalidateCredential(repoFullName: string, credential: ResolvedGitHubCredential): void {
      credentialResolver.invalidate(repoFullName, credential);
    },

    async associatePullRequest(args: AssociatePullRequestArgs): Promise<boolean> {
      // Reference caller: turn-post-processing-service.ts detectAndAssociatePR.
      // Idempotent — an existing link row keeps its status.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ASSOCIATE_TIMEOUT_MS);
      try {
        const associated = await Promise.race([
          prAssociation.associatePullRequest({
            ...args,
            workspaceId: workspaceId as WorkspaceId,
          }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('timed out')), {
              once: true,
            });
          }),
        ]);
        if (!associated) {
          logger.debug(`[pr-poller] PR association was rejected for ${args.prUrl}`);
          return false;
        }
        return true;
      } catch (error) {
        logger.debug(
          `[pr-poller] PR association failed for ${args.prUrl}: ${formatErrorMessage(error)}`
        );
        return false;
      } finally {
        clearTimeout(timeout);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await tokenManager?.shutdown();
    },
  };
}
