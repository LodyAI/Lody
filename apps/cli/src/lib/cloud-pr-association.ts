import type { CloudPrAssociationPort } from '@lody/platform';
import { getServerNow } from '@lody/shared';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_FAILURES = 256;
const MAX_ATTEMPTS = 6;
const unlinkedResponse = z.object({
  error: z.object({ reason: z.literal('repository_not_linked') }),
});

/** One port per authenticated cloud runtime; never cache successful authorization. */
export function createCloudPrAssociationPort(options: {
  token: string;
  authSiteUrl: string;
  fetch?: typeof fetch;
  nowMs?: () => number;
  logger: Pick<Logger, 'error'>;
}): CloudPrAssociationPort {
  const request = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? getServerNow;
  const failures = new Map<string, { attempts: number; delayMs: number; retryAtMs: number }>();
  let capacityReported = false;
  const pending = new Set<string>();

  return {
    async associatePullRequest(input) {
      // Both turn finalization and the poller share this repository gate. Other
      // sessions must not inherit a successful association from an in-flight call.
      const key = JSON.stringify([input.workspaceId, input.repoFullName.trim().toLowerCase()]);
      const previous = failures.get(key);
      if (
        pending.has(key) ||
        (previous && (previous.attempts >= MAX_ATTEMPTS || nowMs() < previous.retryAtMs))
      )
        return false;
      // Exhausted entries must not be evicted and silently given another budget.
      // Reserve capacity before I/O so concurrent repositories cannot overflow it.
      if (!previous && failures.size >= MAX_FAILURES) {
        if (!capacityReported) {
          capacityReported = true;
          options.logger.error(
            '[PR association] Retry tracking is full. New repository associations are paused. Resolve failed GitHub connections and restart this machine’s Lody background agent.'
          );
        }
        return false;
      }
      const attempts = (previous?.attempts ?? 0) + 1;
      failures.set(key, { attempts, delayMs: previous?.delayMs ?? 0, retryAtMs: 0 });
      pending.add(key);
      let status = 0;
      let repositoryNotLinked = false;
      try {
        const { ownerSessionId, ...association } = input;
        const response = await request(new URL('/api/action', options.authSiteUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'github:associatePullRequestForCli',
            args: { ...association, sessionId: ownerSessionId, cliToken: options.token },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
        if (response.ok) {
          failures.delete(key);
          return true;
        }
        repositoryNotLinked = unlinkedResponse.safeParse(
          await response.json().catch(() => null)
        ).success;
      } catch {
        // Transport failures (including timeout) use the same bounded retry path.
      } finally {
        pending.delete(key);
      }

      // Older servers report this rejection as 500: they still back off. New
      // servers' 401/403 responses take the full cooldown immediately.
      const delayMs =
        status === 401 || status === 403
          ? RETRY_MAX_MS
          : Math.min(RETRY_MAX_MS, previous ? previous.delayMs * 2 : RETRY_BASE_MS);
      failures.delete(key);
      failures.set(key, { attempts, delayMs, retryAtMs: nowMs() + delayMs });
      if (attempts === MAX_ATTEMPTS) {
        const reason = repositoryNotLinked
          ? 'repository_not_linked'
          : status
            ? `HTTP ${status}`
            : 'network failure';
        const recovery =
          repositoryNotLinked || status === 403
            ? 'Ask a workspace administrator to check Settings > GitHub, the active GitHub App installation and repository access.'
            : status === 401
              ? 'Check this machine’s Lody credentials.'
              : 'Check the network and backend availability.';
        options.logger.error(
          `[PR association] ${input.repoFullName} in workspace ${input.workspaceId}: ${reason}. Automatic association retries stopped after ${MAX_ATTEMPTS} failed attempts. ${recovery} Then restart this machine’s Lody background agent to retry. GitHub PR observation continues independently.`
        );
      }
      return false;
    },
  };
}
